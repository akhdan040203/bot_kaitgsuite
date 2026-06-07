require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MongoStore, connectMongo } = require("./lib/mongo-store");
const { parseGsuiteInput } = require("./lib/gsuite-format");
const { createQrisInvoice, checkPaymentStatus } = require("./services/orderkuota");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_IDS = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || process.env.WHITELIST_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const ADMIN_MIN_ACCOUNTS = Number(process.env.ADMIN_MIN_ACCOUNTS || 2);

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN or BOT_TOKEN in .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_DIR = path.join(__dirname, "data", "bot");
const ORDER_DIR = path.join(__dirname, "data", "orders");
const START_LOGO_PATH =
  process.env.START_LOGO_PATH ||
  "D:\\Asset Shope\\Premkuy Store\\Blue Minimalist Application Initial Letter P logo (1).png";
const DEFAULT_PRICE_TIERS = [
  { minAccounts: 20, pricePerAccount: 210 },
  { minAccounts: 100, pricePerAccount: 200 },
  { minAccounts: 600, pricePerAccount: 190 },
];

const usersStore = new MongoStore("users", {});
const ordersStore = new MongoStore("orders", []);
const settingsStore = new MongoStore("settings", {
  pricePerAccount: Number(process.env.DEFAULT_PRICE_PER_ACCOUNT || 2000),
  priceTiers: DEFAULT_PRICE_TIERS,
  minAccounts: Number(process.env.MIN_KAIT_ACCOUNTS || 1),
  support: process.env.SUPPORT_USERNAME || "@admin",
  uniquePaymentCode: process.env.UNIQUE_PAYMENT_CODE !== "false",
  uniquePaymentCodeMin: Number(process.env.UNIQUE_PAYMENT_CODE_MIN || 500),
  uniquePaymentCodeMax: Number(process.env.UNIQUE_PAYMENT_CODE_MAX || 999),
  paused: false,
});
const vouchersStore = new MongoStore("vouchers", {});

const BONUS_PER_MILESTONE = Number(process.env.BONUS_FREE_PER_1000 || 50);
const BONUS_MILESTONE_STEP = Number(process.env.BONUS_MILESTONE_STEP || 1000);

const sessions = new Map();
let updateOffset = 0;
let isCheckingPayments = false;

function log(message) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] [bot] ${message}`);
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

function getPriceTiers(settings) {
  const tiers =
    Array.isArray(settings.priceTiers) && settings.priceTiers.length
      ? settings.priceTiers
      : [{ minAccounts: settings.minAccounts || 1, pricePerAccount: settings.pricePerAccount || 2000 }];
  return tiers
    .map((t) => ({ minAccounts: Number(t.minAccounts), pricePerAccount: Number(t.pricePerAccount) }))
    .filter((t) => Number.isFinite(t.minAccounts) && Number.isFinite(t.pricePerAccount))
    .sort((a, b) => a.minAccounts - b.minAccounts);
}

// Harga per akun = tier tertinggi yang jumlah akunnya sudah tercapai.
function getPricePerAccount(count, settings) {
  const tiers = getPriceTiers(settings);
  if (!tiers.length) return Number(settings.pricePerAccount || 2000);
  let price = tiers[0].pricePerAccount;
  for (const tier of tiers) {
    if (count >= tier.minAccounts) price = tier.pricePerAccount;
  }
  return price;
}

function getMinOrderAccounts(settings) {
  const tiers = getPriceTiers(settings);
  return tiers.length ? tiers[0].minAccounts : Number(settings.minAccounts || 1);
}

// Admin boleh order dengan minimal lebih kecil daripada user biasa.
function getMinOrderForChat(chatId, settings) {
  if (isAdmin(chatId)) return ADMIN_MIN_ACCOUNTS;
  return getMinOrderAccounts(settings);
}

// Ambil voucher aktif & masih bisa dipakai.
async function getActiveVoucher(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) return null;
  const vouchers = await vouchersStore.read();
  const v = vouchers[key];
  if (!v || v.active === false) return null;
  if (Number(v.maxUses || 0) > 0 && Number(v.usedCount || 0) >= Number(v.maxUses)) return null;
  return v;
}

// Hitung rincian harga: free bonus (akun gratis) + voucher (diskon persen).
function computeOrderPricing(validCount, settings, user, voucher) {
  const freeAvailable = Number((user && user.freeAccountBalance) || 0);
  const freeUsed = Math.min(freeAvailable, validCount);
  const chargeableCount = Math.max(0, validCount - freeUsed);
  const pricePerAccount = getPricePerAccount(validCount, settings);
  const subtotal = chargeableCount * pricePerAccount;
  const voucherPercent = voucher && voucher.percent ? Number(voucher.percent) : 0;
  const voucherDiscount = voucherPercent ? Math.floor((subtotal * voucherPercent) / 100) : 0;
  const afterDiscount = Math.max(0, subtotal - voucherDiscount);
  return {
    validCount,
    freeUsed,
    chargeableCount,
    pricePerAccount,
    subtotal,
    voucherCode: voucher ? voucher.code : null,
    voucherPercent,
    voucherDiscount,
    afterDiscount,
  };
}

// Potong saldo free & naikkan pemakaian voucher saat order benar-benar diproses (paid/gratis).
// Idempotent lewat flag order.benefitsConsumed.
async function consumeOrderBenefits(orderId) {
  let target = null;
  await ordersStore.update((orders) =>
    orders.map((o) => {
      if (String(o.id) !== String(orderId) || o.benefitsConsumed) return o;
      target = o;
      return { ...o, benefitsConsumed: true };
    })
  );
  if (!target) return;
  if (Number(target.freeUsed || 0) > 0) {
    await usersStore.update((users) => {
      const u = users[target.telegramId];
      if (u) u.freeAccountBalance = Math.max(0, Number(u.freeAccountBalance || 0) - Number(target.freeUsed));
      return users;
    });
  }
  if (target.voucherCode) {
    await vouchersStore.update((vs) => {
      if (vs[target.voucherCode]) vs[target.voucherCode].usedCount = Number(vs[target.voucherCode].usedCount || 0) + 1;
      return vs;
    });
  }
}

function renderPriceTiers(settings) {
  return getPriceTiers(settings)
    .map((t) => `• Min ${t.minAccounts} Akun: <b>${formatRupiah(t.pricePerAccount)}</b> /akun`)
    .join("\n");
}

function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.ceil(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours} jam ${minutes} menit`;
  if (hours) return `${hours} jam`;
  return `${minutes} menit`;
}

function formatTelegramSupport(value) {
  const raw = String(value || "@admin").trim();
  // ID numerik Telegram -> link buka profil via tg://user?id=
  if (/^\d+$/.test(raw)) {
    return `<a href="tg://user?id=${raw}">Admin</a>`;
  }
  const username = raw.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!username) return "@admin";
  return `<a href="https://t.me/${username}">@${username}</a>`;
}

function getQueueInfo(orderId, allOrders) {
  const orders = allOrders || [];
  const activeOrders = orders.filter((order) => ["RUNNING", "QUEUED"].includes(order.status));
  const index = activeOrders.findIndex((order) => String(order.id) === String(orderId));
  if (index === -1) return null;

  const totalActiveAccounts = activeOrders.reduce(
    (sum, order) => sum + Number(order.remainingCount || order.totalAccounts || 0),
    0
  );
  const accountsBefore = activeOrders
    .slice(0, index)
    .reduce((sum, order) => sum + Number(order.remainingCount || order.totalAccounts || 0), 0);
  const secondsPerAccount = Number(process.env.ESTIMATE_SECONDS_PER_ACCOUNT || 120);
  return {
    position: index + 1,
    totalQueue: activeOrders.length,
    totalActiveAccounts,
    accountsBefore,
    etaMs: accountsBefore * secondsPerAccount * 1000,
  };
}

function isAdmin(chatId) {
  return ADMIN_IDS.has(String(chatId));
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔗 Kait PSC", callback_data: "kait_psc" }],
      [
        { text: "📋 Antrian", callback_data: "queue" },
        { text: "🏷️ Info & Harga", callback_data: "price_info" },
      ],
      [
        { text: "🔄 Convert Format", callback_data: "convert_format" },
        { text: "💬 Bantuan", callback_data: "help" },
      ],
    ],
  };
}

function toolbarKeyboard() {
  return {
    keyboard: [[{ text: "📊 Status" }, { text: "🚀 Menu" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function tg(method, payload = {}) {
  const { data } = await axios.post(`${API}/${method}`, payload, { timeout: 30000 });
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function registerBotCommands() {
  await tg("setMyCommands", {
    commands: [{ command: "start", description: "Start the bot" }],
    scope: { type: "default" },
  });

  for (const adminId of ADMIN_IDS) {
    await tg("setMyCommands", {
      commands: [
        { command: "start", description: "Start the bot" },
        { command: "admin", description: "Open admin panel" },
        { command: "voucher", description: "Kelola voucher (Admin only)" },
      ],
      scope: { type: "chat", chat_id: adminId },
    });
  }
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function notifyAdmins(text, exceptChatId) {
  for (const adminId of ADMIN_IDS) {
    if (exceptChatId && String(adminId) === String(exceptChatId)) continue;
    try {
      await sendMessage(adminId, text);
    } catch (_) {}
  }
}

function statusIcon(status) {
  return (
    {
      DONE: "✅",
      RUNNING: "🟢",
      QUEUED: "🕒",
      WAITING_PAYMENT: "💳",
      CANCELLED: "❌",
      FAILED: "⚠️",
    }[status] || "•"
  );
}

// Bar mini dari jumlah akun yang sukses ngait.
function miniBar(done, total) {
  const t = Math.max(1, Number(total || 0));
  const d = Math.min(t, Math.max(0, Number(done || 0)));
  const percent = Math.floor((d / t) * 100);
  const seg = 10;
  const filled = Math.round((percent / 100) * seg);
  return `[${"▰".repeat(filled)}${"▱".repeat(seg - filled)}] ${percent}%`;
}

async function deleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (_) {}
}

async function sendPhoto(chatId, photo, caption, extra = {}) {
  return tg("sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendPhotoFile(chatId, filePath, caption, extra = {}) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", fs.createReadStream(filePath));
  if (caption) form.append("caption", caption);
  form.append("parse_mode", "HTML");
  for (const [key, value] of Object.entries(extra)) {
    form.append(key, typeof value === "object" ? JSON.stringify(value) : value);
  }

  const { data } = await axios.post(`${API}/sendPhoto`, form, {
    headers: form.getHeaders(),
    timeout: 120000,
  });
  if (!data.ok) throw new Error(data.description || "sendPhoto failed");
  return data.result;
}

async function sendDocument(chatId, filePath, caption) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption);
  form.append("document", fs.createReadStream(filePath));
  const { data } = await axios.post(`${API}/sendDocument`, form, {
    headers: form.getHeaders(),
    timeout: 120000,
  });
  if (!data.ok) throw new Error(data.description || "sendDocument failed");
}

async function upsertUser(from) {
  const id = String(from.id);
  const users = await usersStore.update((users) => {
    if (!users[id]) {
      users[id] = {
        telegramId: id,
        username: from.username || "",
        firstName: from.first_name || "",
        totalKait: 0,
        totalSpend: 0,
        createdAt: new Date().toISOString(),
      };
    } else {
      users[id].username = from.username || users[id].username;
      users[id].firstName = from.first_name || users[id].firstName;
    }
    return users;
  });
  return users[id];
}

async function botStats() {
  const users = await usersStore.read();
  const orders = await ordersStore.read();
  const totalKait = orders
    .filter((order) => order.status === "DONE")
    .reduce((sum, order) => sum + Number(order.successCount || 0), 0);
  return { totalUsers: Object.keys(users).length, totalKait };
}

async function showHome(chatId, from) {
  const user = await upsertUser(from);
  const settings = await settingsStore.read();
  const username = user.username ? `@${user.username}` : "-";
  const homeText = [
    `Halo ${user.firstName || "User"}`,
    "",
    "<b>User Info</b>",
    `L ID: <code>${user.telegramId}</code>`,
    `L Username: ${username}`,
    `L Total Kait: ${user.totalKait || 0}`,
    `L Bonus Free Ngait: ${user.freeAccountBalance || 0} akun`,
    `L Total Pengeluaran: ${formatRupiah(user.totalSpend || 0)}`,
    "",
    "<b>Configuration</b>",
    "L Payment: QRIS",
    `L Harga: mulai ${formatRupiah(Math.min(...getPriceTiers(settings).map((t) => t.pricePerAccount)))} / akun`,
    `L Support: ${formatTelegramSupport(settings.support)}`,
  ].join("\n");

  if (fs.existsSync(START_LOGO_PATH)) {
    await sendPhotoFile(chatId, START_LOGO_PATH, homeText, { reply_markup: mainKeyboard() });
    return;
  }

  await sendMessage(chatId, homeText, { reply_markup: mainKeyboard() });
}

async function showStatus(chatId, from) {
  const user = await upsertUser(from);
  const orders = (await ordersStore.read()).filter((order) => order.telegramId === String(from.id));
  const active = orders.filter((order) => ["QUEUED", "RUNNING"].includes(order.status));
  const done = orders.filter((order) => order.status === "DONE");
  const waitingPayment = orders.filter((order) => order.status === "WAITING_PAYMENT");

  await sendMessage(
    chatId,
    [
      "<b>Status Akun</b>",
      "",
      `Total Kait: ${user.totalKait || 0}`,
      `Total Pengeluaran: ${formatRupiah(user.totalSpend || 0)}`,
      `Order Aktif: ${active.length}`,
      `Menunggu Pembayaran: ${waitingPayment.length}`,
      `Order Selesai: ${done.length}`,
    ].join("\n"),
    { reply_markup: toolbarKeyboard() }
  );
}

async function downloadTelegramFile(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const { data } = await axios.get(url, { responseType: "text", timeout: 60000 });
  return data;
}

function buildOrderSummary(parsed, settings, user, voucher) {
  const p = computeOrderPricing(parsed.valid.length, settings, user, voucher);
  const lines = [
    "<b>Order Kait PSC</b>",
    "",
    `Total input: ${parsed.totalInput}`,
    `Valid Gsuite: ${parsed.valid.length}`,
    `Invalid: ${parsed.invalid.length}`,
    `Duplicate: ${parsed.duplicate}`,
    "",
    `Harga: ${formatRupiah(p.pricePerAccount)} / akun (sesuai jumlah akun)`,
  ];
  if (p.freeUsed > 0) lines.push(`🎁 Bonus free ngait: ${p.freeUsed} akun`);
  lines.push(`Akun kena biaya: ${p.chargeableCount}`);
  lines.push(`Subtotal: ${formatRupiah(p.subtotal)}`);
  if (p.voucherCode) lines.push(`🎟️ Voucher ${p.voucherCode} (-${p.voucherPercent}%): -${formatRupiah(p.voucherDiscount)}`);
  lines.push(`Total: <b>${formatRupiah(p.afterDiscount)}</b>${p.afterDiscount === 0 ? " (GRATIS)" : ""}`);
  if (p.afterDiscount > 0) lines.push("Total final dibuat setelah QRIS agar bisa diberi kode unik.");
  return lines.join("\n");
}

function getUniquePaymentCode(orderId, settings) {
  if (!settings.uniquePaymentCode) return 0;
  const min = Number(settings.uniquePaymentCodeMin || 1);
  const max = Number(settings.uniquePaymentCodeMax || 999);
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const range = safeMax - safeMin + 1;
  return safeMin + (Number(orderId) % range);
}

async function handleParsedKait(chatId, parsed, voucher) {
  const settings = await settingsStore.read();
  if (settings.paused) {
    await sendMessage(chatId, "Bot sedang pause. Coba lagi nanti.");
    return;
  }
  const minOrder = getMinOrderForChat(chatId, settings);
  if (parsed.valid.length < minOrder) {
    await sendMessage(chatId, `Minimal ${minOrder} akun valid. Akun valid kamu: ${parsed.valid.length}.`);
    return;
  }

  const users = await usersStore.read();
  const user = users[String(chatId)];

  sessions.set(String(chatId), { mode: "confirm_kait", parsed, voucher: voucher || null });
  const draftMessage = await sendMessage(chatId, buildOrderSummary(parsed, settings, user, voucher), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Buat QRIS", callback_data: "confirm_kait" }],
        [{ text: "🎟️ Pakai Voucher", callback_data: "apply_voucher" }],
        [{ text: "Batal", callback_data: "cancel_session" }],
      ],
    },
  });
  sessions.set(String(chatId), {
    mode: "confirm_kait",
    parsed,
    voucher: voucher || null,
    draftMessageId: draftMessage.message_id,
  });
}

async function createOrderFromSession(chatId, from, callbackMessageId) {
  const session = sessions.get(String(chatId));
  if (!session || session.mode !== "confirm_kait") {
    await sendMessage(chatId, "Tidak ada draft order aktif.");
    return;
  }

  const settings = await settingsStore.read();
  const parsed = session.parsed;
  const orderId = Date.now();
  const orderPath = path.join(ORDER_DIR, String(orderId));
  fs.mkdirSync(orderPath, { recursive: true });
  fs.writeFileSync(path.join(orderPath, "input.txt"), parsed.convertedText);
  fs.writeFileSync(
    path.join(orderPath, "invalid.txt"),
    parsed.invalid.map((item) => `${item.raw} # ${item.reason}`).join("\n")
  );

  const users = await usersStore.read();
  const user = users[String(from.id)];
  const voucher = session.voucher ? await getActiveVoucher(session.voucher.code) : null;
  const pricing = computeOrderPricing(parsed.valid.length, settings, user, voucher);

  const now = new Date().toISOString();
  const isFree = pricing.afterDiscount <= 0;
  const uniqueCode = isFree ? 0 : getUniquePaymentCode(orderId, settings);
  const totalPrice = pricing.afterDiscount + uniqueCode;

  const baseOrder = {
    id: orderId,
    telegramId: String(from.id),
    username: from.username || "",
    totalInput: parsed.totalInput,
    totalAccounts: parsed.valid.length,
    invalidAccounts: parsed.invalid.length,
    duplicateAccounts: parsed.duplicate,
    pricePerAccount: pricing.pricePerAccount,
    chargeableCount: pricing.chargeableCount,
    freeUsed: pricing.freeUsed,
    voucherCode: pricing.voucherCode,
    voucherPercent: pricing.voucherPercent,
    voucherDiscount: pricing.voucherDiscount,
    basePrice: pricing.subtotal,
    uniqueCode,
    totalPrice,
    successCount: 0,
    failedCount: 0,
    benefitsConsumed: false,
    orderPath,
    createdAt: now,
    updatedAt: now,
  };

  // ===== Order GRATIS (bonus free / voucher menutup semua biaya) =====
  if (isFree) {
    const order = { ...baseOrder, status: "QUEUED", payment: { provider: "free", status: "PAID" }, paidAt: now };
    await ordersStore.update((orders) => {
      orders.push(order);
      return orders;
    });
    await consumeOrderBenefits(orderId);
    log(`created FREE order #${orderId} user=@${order.username || "-"} accounts=${order.totalAccounts}`);
    sessions.delete(String(chatId));
    await sendMessage(
      chatId,
      [
        `🎉 <b>Order #${orderId} GRATIS!</b>`,
        "",
        `Total akun: ${order.totalAccounts}`,
        pricing.freeUsed ? `🎁 Bonus free dipakai: ${pricing.freeUsed} akun` : "",
        pricing.voucherCode ? `🎟️ Voucher ${pricing.voucherCode} (-${pricing.voucherPercent}%)` : "",
        "Langsung masuk antrian, tidak perlu bayar.",
      ].filter(Boolean).join("\n")
    );
    await notifyAdmins(
      [
        "🔔 <b>Order Baru (GRATIS)</b>",
        "",
        `🆔 Order: <code>${orderId}</code>`,
        `👤 User: ${order.username ? "@" + order.username : order.telegramId}`,
        `📧 Jumlah akun: <b>${order.totalAccounts}</b>`,
        pricing.freeUsed ? `🎁 Free: ${pricing.freeUsed} akun` : "",
        pricing.voucherCode ? `🎟️ Voucher: ${pricing.voucherCode} -${pricing.voucherPercent}%` : "",
        "💰 Total: GRATIS",
      ].filter(Boolean).join("\n"),
      String(from.id)
    );
    await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
    return;
  }

  // ===== Order berbayar (QRIS) =====
  let invoice;
  try {
    invoice = await createQrisInvoice({ orderId, amount: totalPrice });
  } catch (error) {
    await sendMessage(chatId, `Gagal membuat QRIS: ${error.message}`);
    return;
  }
  const order = {
    ...baseOrder,
    status: "WAITING_PAYMENT",
    payment: { ...invoice, orderId, amount: totalPrice, status: "PENDING" },
  };

  await ordersStore.update((orders) => {
    orders.push(order);
    return orders;
  });
  log(`created order #${order.id} user=@${order.username || "-"} accounts=${order.totalAccounts} total=${order.totalPrice}`);
  sessions.delete(String(chatId));

  await notifyAdmins(
    [
      "🔔 <b>Order Baru Masuk</b>",
      "",
      `🆔 Order: <code>${orderId}</code>`,
      `👤 User: ${order.username ? "@" + order.username : order.telegramId}`,
      `📧 Jumlah akun: <b>${order.totalAccounts}</b>`,
      pricing.freeUsed ? `🎁 Free dipakai: ${pricing.freeUsed} akun` : "",
      pricing.voucherCode ? `🎟️ Voucher: ${pricing.voucherCode} -${pricing.voucherPercent}%` : "",
      `💰 Total bayar: <b>${formatRupiah(totalPrice)}</b>`,
      "💳 Status: Menunggu pembayaran",
    ].filter(Boolean).join("\n"),
    String(from.id)
  );

  const lines = [
    `<b>QRIS Order #${orderId}</b>`,
    "",
    `Total akun: ${order.totalAccounts}`,
    pricing.freeUsed ? `🎁 Free: ${pricing.freeUsed} | Kena biaya: ${pricing.chargeableCount}` : "",
    `Subtotal: ${formatRupiah(pricing.subtotal)}`,
    pricing.voucherCode ? `🎟️ Voucher ${pricing.voucherCode}: -${formatRupiah(pricing.voucherDiscount)}` : "",
    uniqueCode ? `Kode unik: ${formatRupiah(uniqueCode)}` : "",
    `Total bayar: <b>${formatRupiah(totalPrice)}</b>`,
    "",
    invoice.provider === "manual"
      ? invoice.qrText
      : "Scan QRIS untuk menyelesaikan pembayaran.",
  ].filter(Boolean);

  const replyMarkup = {
    inline_keyboard: [
      [{ text: "Cek Pembayaran", callback_data: `checkpay_${orderId}` }],
      [{ text: "Batalkan", callback_data: `cancel_order_${orderId}` }],
    ],
  };

  if (invoice.provider !== "manual" && invoice.qrText) {
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=700x700&data=${encodeURIComponent(invoice.qrText)}`;
    try {
      const sent = await sendPhoto(chatId, qrImageUrl, lines.join("\n"), { reply_markup: replyMarkup });
      await ordersStore.update((orders) =>
        orders.map((item) =>
          item.id === orderId
            ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
            : item
        )
      );
      await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
      return;
    } catch (error) {
      const sent = await sendMessage(chatId, `${lines.join("\n")}\n\nQR image gagal dibuat, QRIS payload:\n<code>${invoice.qrText}</code>`, {
        reply_markup: replyMarkup,
      });
      await ordersStore.update((orders) =>
        orders.map((item) =>
          item.id === orderId
            ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
            : item
        )
      );
      await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
      return;
    }
  }

  const sent = await sendMessage(chatId, lines.join("\n"), { reply_markup: replyMarkup });
  await ordersStore.update((orders) =>
    orders.map((item) =>
      item.id === orderId
        ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
        : item
    )
  );
  await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
}

async function handleConvert(chatId, text) {
  const parsed = parseGsuiteInput(text);
  const outDir = path.join(ORDER_DIR, "convert");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `converted-${chatId}-${Date.now()}.txt`);
  fs.writeFileSync(outPath, parsed.convertedText);

  await sendMessage(
    chatId,
    [
      "<b>Convert selesai</b>",
      "",
      `Total input: ${parsed.totalInput}`,
      `Berhasil convert: ${parsed.valid.length}`,
      `Invalid: ${parsed.invalid.length}`,
      `Duplicate: ${parsed.duplicate}`,
    ].join("\n")
  );
  if (parsed.valid.length) await sendDocument(chatId, outPath, "converted-gsuite.txt");
}

async function showQueue(chatId, telegramId) {
  const allOrders = await ordersStore.read();
  const activeOrders = allOrders.filter((order) => ["RUNNING", "QUEUED"].includes(order.status));
  const totalQueueAccounts = activeOrders.reduce(
    (sum, order) => sum + Number(order.remainingCount || order.totalAccounts || 0),
    0
  );
  const totalQueueOrders = activeOrders.length;
  const orders = allOrders
    .filter((order) =>
      order.telegramId === String(telegramId) &&
      ["QUEUED", "RUNNING"].includes(order.status)
    )
    .slice(-10)
    .reverse();

  const peopleInQueue = new Set(activeOrders.map((order) => String(order.telegramId))).size;

  await sendMessage(
    chatId,
    [
      "📋 <b>Antrian Ngait</b>",
      "",
      `👥 Orang di antrian: <b>${peopleInQueue}</b>`,
      `📦 Order aktif: <b>${totalQueueOrders}</b>`,
      `📧 Total gsuite ngait: <b>${totalQueueAccounts}</b>`,
      "",
      "📜 <b>Antrian Kamu</b>",
      orders.length
        ? orders
            .map((order, index) => {
              const processedCount = order.status === "DONE"
                ? Number(order.successCount || 0)
                : Number(order.verifiedCount || order.successCount || 0);
              const statusIcon = order.status === "RUNNING" ? "🟢" : "🕒";
              return [
                `${index + 1}. ${statusIcon} <b>${order.status}</b>`,
                `   📧 ${processedCount}/${order.totalAccounts} gsuite`,
                `   <code>${miniBar(processedCount, order.totalAccounts)}</code>`,
                `   🆔 <code>${order.id}</code>`,
              ].join("\n");
            })
            .join("\n\n")
        : "Belum ada order paid/proses.",
    ].join("\n")
  );
}

async function markOrderPaid(orderId) {
  let updatedOrder = null;
  await ordersStore.update((current) =>
    current.map((order) => {
      if (
        String(order.id) !== String(orderId) ||
        !["WAITING_PAYMENT", "CANCELLED"].includes(order.status)
      ) {
        return order;
      }
      updatedOrder = {
        ...order,
        status: "QUEUED",
        payment: { ...order.payment, status: "PAID" },
        paidAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      };
      log(`payment paid for order #${order.id}; status QUEUED`);
      return updatedOrder;
    })
  );
  if (updatedOrder) await consumeOrderBenefits(orderId);
  if (updatedOrder && updatedOrder.paymentChatId && updatedOrder.paymentMessageId) {
    try {
      await tg("deleteMessage", {
        chat_id: updatedOrder.paymentChatId,
        message_id: updatedOrder.paymentMessageId,
      });
    } catch (error) {
      console.error(`[payment] failed to delete QRIS message #${orderId}: ${error.message}`);
    }
  }
  return updatedOrder;
}

async function checkAndUpdatePayment(chatId, orderId) {
  let target;
  const orders = await ordersStore.read();
  target = orders.find((order) => String(order.id) === String(orderId));
  if (!target) {
    await sendMessage(chatId, "Order tidak ditemukan.");
    return;
  }

  const status = await checkPaymentStatus(target.payment);
  if (status === "PAID") {
    const paidOrder = await markOrderPaid(orderId);
    if (paidOrder) {
      await deleteMessage(chatId, target.messageId);
    }
  } else if (target.status === "CANCELLED") {
    await sendMessage(chatId, `Order #${orderId} sudah dibatalkan dan pembayaran belum terdeteksi.`);
  } else {
    await sendMessage(chatId, `Status pembayaran order #${orderId}: ${status}.`);
  }
}

async function cancelOrder(chatId, orderId) {
  const target = (await ordersStore.read()).find((order) => String(order.id) === String(orderId));
  if (!target) {
    await sendMessage(chatId, "Order tidak ditemukan.");
    return;
  }

  if (target.status === "WAITING_PAYMENT") {
    const status = await checkPaymentStatus(target.payment);
    if (status === "PAID") {
      const paidOrder = await markOrderPaid(orderId);
      if (paidOrder) {
        await sendMessage(chatId, `Pembayaran order #${orderId} sudah terdeteksi. Order masuk antrian, tidak dibatalkan.`);
        return;
      }
    }
  }

  let cancelledOrder = null;
  await ordersStore.update((orders) =>
    orders.map((order) => {
      if (String(order.id) !== String(orderId) || order.status !== "WAITING_PAYMENT") return order;
      cancelledOrder = {
        ...order,
        status: "CANCELLED",
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return cancelledOrder;
    })
  );

  if (!cancelledOrder) {
    await sendMessage(chatId, `Order #${orderId} tidak bisa dibatalkan. Mungkin sudah paid/proses.`);
    return;
  }

  await sendMessage(chatId, `Order #${orderId} dibatalkan.`);
}

async function autoCheckPayments() {
  if (isCheckingPayments) return;
  isCheckingPayments = true;
  try {
    const orders = (await ordersStore.read())
      .filter((order) => {
        if (order.status === "WAITING_PAYMENT") return true;
        if (order.status !== "CANCELLED") return false;
        if (!order.cancelledAt) return false;
        const cancelledAgeMs = Date.now() - new Date(order.cancelledAt).getTime();
        return Number.isFinite(cancelledAgeMs) && cancelledAgeMs < 10 * 60 * 1000;
      })
      .slice(0, 10);

    for (const order of orders) {
      try {
        const status = await checkPaymentStatus(order.payment);
        if (status !== "PAID") continue;

        const paidOrder = await markOrderPaid(order.id);
        if (paidOrder) {
          log(`payment auto accepted for order #${paidOrder.id}; progress message will be sent by worker`);
        }
      } catch (error) {
        console.error(`[payment] order #${order.id}: ${error.message}`);
      }
    }
  } finally {
    isCheckingPayments = false;
  }
}

async function handleAdminCommand(chatId, text) {
  const [command, ...args] = text.trim().split(" ");
  if (command === "/admin") {
    const settings = await settingsStore.read();
    const stats = await botStats();
    await sendMessage(
      chatId,
      [
        "<b>Admin Panel</b>",
        "",
        "<b>BOT Stats</b>",
        `L Total Kait: ${stats.totalKait}`,
        `L Total User: ${stats.totalUsers}`,
        "",
        `/setharga ${settings.pricePerAccount}`,
        `/setmin ${settings.minAccounts}`,
        `/setsupport @username`,
        "/settier 20:210 100:200 600:190",
        "/voucher  (kelola voucher diskon)",
        "/orders",
        "/paid ORDER_ID",
        "/batalproses ORDER_ID",
        "/addsaldo USER_ID JUMLAH",
        "/broadcast pesan",
        "/pause",
        "/resume",
      ].join("\n")
    );
    return true;
  }

  if (command === "/voucher") {
    const sub = (args[0] || "").toLowerCase();

    if (sub === "add") {
      const code = String(args[1] || "").trim().toUpperCase();
      const percent = Number(args[2]);
      const maxUses = args[3] !== undefined ? Number(args[3]) : 0;
      if (!code || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
        await sendMessage(chatId, "Format: /voucher add KODE PERSEN [maxPakai]\nContoh: /voucher add HEMAT10 10 100");
        return true;
      }
      await vouchersStore.update((vs) => {
        vs[code] = {
          code,
          percent,
          maxUses: Number.isFinite(maxUses) && maxUses > 0 ? maxUses : 0,
          usedCount: vs[code] ? Number(vs[code].usedCount || 0) : 0,
          active: true,
          createdAt: new Date().toISOString(),
        };
        return vs;
      });
      await sendMessage(chatId, `✅ Voucher ${code} dibuat: diskon ${percent}%${maxUses ? `, maks ${maxUses}x` : " (unlimited)"}.`);
      return true;
    }

    if (sub === "del" || sub === "delete" || sub === "hapus") {
      const code = String(args[1] || "").trim().toUpperCase();
      if (!code) {
        await sendMessage(chatId, "Format: /voucher del KODE");
        return true;
      }
      let existed = false;
      await vouchersStore.update((vs) => {
        existed = Boolean(vs[code]);
        delete vs[code];
        return vs;
      });
      await sendMessage(chatId, existed ? `🗑️ Voucher ${code} dihapus.` : `Voucher ${code} tidak ditemukan.`);
      return true;
    }

    const vouchers = await vouchersStore.read();
    const codes = Object.keys(vouchers);
    const body = codes.length
      ? codes
          .map((c) => {
            const v = vouchers[c];
            const uses = `${v.usedCount || 0}${v.maxUses ? "/" + v.maxUses : ""}`;
            return `🎟️ <code>${v.code}</code> — ${v.percent}% — dipakai ${uses}${v.active === false ? " (nonaktif)" : ""}`;
          })
          .join("\n")
      : "Belum ada voucher.";
    await sendMessage(
      chatId,
      [
        "🎟️ <b>Voucher</b>",
        "",
        body,
        "",
        "<b>Kelola:</b>",
        "/voucher add KODE PERSEN [maxPakai]",
        "/voucher del KODE",
      ].join("\n")
    );
    return true;
  }

  if (command === "/setharga") {
    const price = Number(args[0]);
    if (!Number.isFinite(price) || price <= 0) {
      await sendMessage(chatId, "Format: /setharga 2000");
      return true;
    }
    await settingsStore.update((settings) => ({ ...settings, pricePerAccount: price }));
    await sendMessage(chatId, `Harga diubah menjadi ${formatRupiah(price)} / akun.`);
    return true;
  }

  if (command === "/setmin") {
    const minAccounts = Number(args[0]);
    if (!Number.isInteger(minAccounts) || minAccounts <= 0) {
      await sendMessage(chatId, "Format: /setmin 1");
      return true;
    }
    await settingsStore.update((settings) => ({ ...settings, minAccounts }));
    await sendMessage(chatId, `Minimal order diubah menjadi ${minAccounts} akun.`);
    return true;
  }

  if (command === "/setsupport") {
    const value = (args[0] || "").trim();
    if (!value) {
      await sendMessage(chatId, "Format: /setsupport @username  (atau ID Telegram). Username lebih disarankan biar link bisa diklik.");
      return true;
    }
    const clean = value.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
    await settingsStore.update((settings) => ({ ...settings, support: clean }));
    await sendMessage(chatId, `Support diubah ke: ${formatTelegramSupport(clean)}`);
    return true;
  }

  if (command === "/addsaldo" || command === "/setsaldo") {
    const targetId = String(args[0] || "").trim();
    const amount = Number(args[1]);
    if (!targetId || !Number.isFinite(amount)) {
      await sendMessage(
        chatId,
        [
          "Format:",
          "/addsaldo USER_ID JUMLAH   (tambah/kurang saldo, mis. 50 atau -10)",
          "/setsaldo USER_ID JUMLAH   (set saldo jadi nilai pasti)",
          "Contoh: /addsaldo 7455452803 50",
        ].join("\n")
      );
      return true;
    }
    let found = false;
    let newBalance = 0;
    await usersStore.update((users) => {
      if (users[targetId]) {
        found = true;
        const current = Number(users[targetId].freeAccountBalance || 0);
        newBalance = Math.max(0, command === "/setsaldo" ? amount : current + amount);
        users[targetId].freeAccountBalance = newBalance;
      }
      return users;
    });
    if (!found) {
      await sendMessage(chatId, `User ${targetId} belum terdaftar (user harus pernah /start dulu).`);
      return true;
    }
    await sendMessage(
      chatId,
      `✅ Saldo free ngait user <code>${targetId}</code> sekarang: <b>${newBalance} akun</b>.`
    );
    try {
      await sendMessage(targetId, `🎁 Saldo free ngait kamu diperbarui admin. Sekarang: <b>${newBalance} akun</b> (bisa dipakai gratis untuk ngait).`);
    } catch (_) {}
    return true;
  }

  if (command === "/settier") {
    if (!args.length) {
      await sendMessage(
        chatId,
        [
          "Format: /settier 20:210 100:200 600:190",
          "(jumlahAkun:hargaPerAkun, dipisah spasi). Tier terendah = minimal order.",
        ].join("\n")
      );
      return true;
    }
    const tiers = [];
    for (const part of args) {
      const [minStr, priceStr] = part.split(":");
      const min = Number(minStr);
      const price = Number(priceStr);
      if (!Number.isInteger(min) || min <= 0 || !Number.isFinite(price) || price <= 0) {
        await sendMessage(chatId, `Format salah di "${part}". Contoh: /settier 20:210 100:200 600:190`);
        return true;
      }
      tiers.push({ minAccounts: min, pricePerAccount: price });
    }
    tiers.sort((a, b) => a.minAccounts - b.minAccounts);
    const newSettings = await settingsStore.update((settings) => ({
      ...settings,
      priceTiers: tiers,
      minAccounts: tiers[0].minAccounts,
    }));
    await sendMessage(chatId, "✅ Tier harga diperbarui:\n\n" + renderPriceTiers(newSettings));
    return true;
  }

  if (command === "/orders") {
    const allOrders = await ordersStore.read();
    const orders = allOrders.slice(-20).reverse();
    const body = orders.length
      ? orders
          .map((order) => {
            const queueInfo = getQueueInfo(order.id, allOrders);
            const queueText = queueInfo
              ? `\n   ⏳ Antri: depan ${queueInfo.accountsBefore} • aktif ${queueInfo.totalActiveAccounts} • est ${formatDuration(queueInfo.etaMs)}`
              : "";
            return [
              `🆔 <code>${order.id}</code>`,
              `   👤 ${order.username ? "@" + order.username : order.telegramId}`,
              `   📦 Order: ${order.totalAccounts} akun  |  ✅ Done: ${order.successCount || 0}/${order.totalAccounts}`,
              `   <code>${miniBar(order.successCount || 0, order.totalAccounts)}</code>`,
              `   💰 ${formatRupiah(order.totalPrice)}  |  ${statusIcon(order.status)} ${order.status}${queueText}`,
            ].join("\n");
          })
          .join("\n\n")
      : "Belum ada order.";
    await sendMessage(chatId, [`📒 <b>Daftar Order</b> (20 terakhir)`, "", body].join("\n"));
    return true;
  }

  if (command === "/paid") {
    const orderId = args[0];
    await ordersStore.update((orders) =>
      orders.map((order) =>
        String(order.id) === String(orderId)
          ? {
              ...order,
              status: "QUEUED",
              payment: { ...order.payment, status: "PAID" },
              paidAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : order
      )
    );
    await consumeOrderBenefits(orderId);
    await sendMessage(chatId, `Order #${orderId} ditandai paid dan masuk antrian.`);
    return true;
  }

  if (command === "/batalproses" || command === "/stopproses" || command === "/stop") {
    const orderId = args[0];
    if (!orderId) {
      await sendMessage(chatId, "Format: /batalproses ORDER_ID");
      return true;
    }
    let target = null;
    await ordersStore.update((orders) =>
      orders.map((order) => {
        if (String(order.id) === String(orderId) && ["QUEUED", "RUNNING", "PAID"].includes(order.status)) {
          target = order;
          return { ...order, status: "CANCELLED", cancelledByAdmin: true, cancelledAt: new Date().toISOString() };
        }
        return order;
      })
    );
    if (!target) {
      await sendMessage(chatId, `Order #${orderId} tidak bisa dibatalkan (tidak sedang antri/proses).`);
      return true;
    }
    await sendMessage(chatId, `🛑 Order #${orderId} dibatalkan. Worker akan menghentikan prosesnya sebentar lagi.`);
    try {
      await sendMessage(target.telegramId, `Order #${orderId} dibatalkan oleh admin.`);
    } catch (_) {}
    return true;
  }

  if (command === "/broadcast") {
    const message = args.join(" ").trim();
    if (!message) {
      await sendMessage(chatId, "Format: /broadcast pesan");
      return true;
    }
    const users = await usersStore.read();
    let sent = 0;
    for (const id of Object.keys(users)) {
      try {
        await sendMessage(id, message);
        sent++;
      } catch (_) {}
    }
    await sendMessage(chatId, `Broadcast terkirim ke ${sent} user.`);
    return true;
  }

  if (command === "/pause" || command === "/resume") {
    const paused = command === "/pause";
    await settingsStore.update((settings) => ({ ...settings, paused }));
    await sendMessage(chatId, paused ? "Bot dipause." : "Bot aktif kembali.");
    return true;
  }

  return false;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || message.chat;
  await upsertUser(from);

  const text = message.text || "";
  if (text.startsWith("/") && isAdmin(chatId) && (await handleAdminCommand(chatId, text))) return;
  if (text === "/start") return showHome(chatId, from);
  if (text === "🚀 Menu" || text.toLowerCase() === "menu") return showHome(chatId, from);
  if (text === "📊 Status" || text.toLowerCase() === "status") return showStatus(chatId, from);

  const session = sessions.get(String(chatId));

  let content = text;
  if (message.document) {
    const name = message.document.file_name || "";
    if (!name.toLowerCase().endsWith(".txt")) {
      await sendMessage(chatId, "File wajib format .txt.");
      return;
    }
    content = await downloadTelegramFile(message.document.file_id);
  }

  if (session && session.mode === "awaiting_voucher") {
    const code = (text || "").trim().toUpperCase();
    const voucher = await getActiveVoucher(code);
    if (!voucher) {
      await sendMessage(chatId, `Voucher "${code}" tidak valid / sudah habis.`);
      await handleParsedKait(chatId, session.parsed, session.voucher || null);
      return;
    }
    await sendMessage(chatId, `🎟️ Voucher ${voucher.code} (-${voucher.percent}%) diterapkan.`);
    await handleParsedKait(chatId, session.parsed, voucher);
    return;
  }

  if (session && session.mode === "awaiting_kait") {
    if (!message.document && content.split(/\r?\n/).filter(Boolean).length > 50) {
      await sendMessage(chatId, "Lebih dari 50 akun wajib kirim file .txt.");
      return;
    }
    await handleParsedKait(chatId, parseGsuiteInput(content));
    return;
  }

  if (session && session.mode === "awaiting_convert") {
    await handleConvert(chatId, content);
    sessions.delete(String(chatId));
    return;
  }

  await sendMessage(chatId, "Pilih menu dari /start.");
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const from = query.from;
  const data = query.data;
  await tg("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});

  if (data === "kait_psc") {
    sessions.set(String(chatId), { mode: "awaiting_kait" });
    const settings = await settingsStore.read();
    await sendMessage(
      chatId,
      [
        "<b>Format: email|password</b>",
        `Min: ${getMinOrderForChat(chatId, settings)} akun`,
        "",
        "Format lain seperti email:pass, email;pass, email pass akan otomatis di-convert.",
        "Hanya email GSuite/Google Workspace. Email gratis akan ditolak.",
        "Lebih dari 50 akun wajib kirim file .txt.",
      ].join("\n")
    );
    return;
  }

  if (data === "convert_format") {
    sessions.set(String(chatId), { mode: "awaiting_convert" });
    await sendMessage(chatId, "Kirim list akun atau upload file .txt untuk convert format.");
    return;
  }

  if (data === "confirm_kait") return createOrderFromSession(chatId, from, query.message?.message_id);
  if (data === "apply_voucher") {
    const session = sessions.get(String(chatId));
    if (!session || !session.parsed) {
      await sendMessage(chatId, "Tidak ada draft order aktif. Mulai lagi dari /start.");
      return;
    }
    sessions.set(String(chatId), { ...session, mode: "awaiting_voucher" });
    await sendMessage(chatId, "🎟️ Ketik kode voucher kamu:");
    return;
  }
  if (data === "cancel_session") {
    sessions.delete(String(chatId));
    await deleteMessage(chatId, query.message?.message_id);
    await sendMessage(chatId, "Dibatalkan.");
    return;
  }
  if (data === "queue") return showQueue(chatId, from.id);
  if (data === "price_info") {
    const settings = await settingsStore.read();
    await sendMessage(
      chatId,
      [
        "🏷️ <b>DAFTAR HARGA LAYANAN</b> 🏷️",
        "",
        "Harga otomatis menyesuaikan jumlah akun yang Anda kirim:",
        "",
        renderPriceTiers(settings),
        "",
        `📌 Minimal order: <b>${getMinOrderAccounts(settings)} akun</b>`,
      ].join("\n")
    );
    return;
  }
  if (data === "help") {
    const settings = await settingsStore.read();
    await sendMessage(chatId, `Support: ${formatTelegramSupport(settings.support)}`);
    return;
  }
  if (data.startsWith("checkpay_")) return checkAndUpdatePayment(chatId, data.replace("checkpay_", ""));
  if (data.startsWith("cancel_order_")) return cancelOrder(chatId, data.replace("cancel_order_", ""));
}

async function poll() {
  while (true) {
    try {
      const { data } = await axios.get(`${API}/getUpdates`, {
        params: { offset: updateOffset, timeout: 25 },
        timeout: 30000,
      });
      if (!data.ok) throw new Error(data.description || "getUpdates failed");
      for (const update of data.result) {
        updateOffset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error(`[bot] ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  await connectMongo();
  log("MongoDB connected.");

  registerBotCommands()
    .then(() => log("bot commands registered"))
    .catch((error) => console.error(`[bot] failed to register commands: ${error.message}`));

  console.log("Telegram bot started.");
  setInterval(autoCheckPayments, Number(process.env.PAYMENT_CHECK_INTERVAL_MS || 15000));
  poll();
}

main().catch((error) => {
  console.error(`[bot] fatal: ${error.message}`);
  process.exit(1);
});

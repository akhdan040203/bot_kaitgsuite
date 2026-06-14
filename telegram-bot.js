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

// Hitung rincian harga: credit (akun gratis) + voucher (diskon persen).
// credit = jumlah akun yang bisa dikait gratis (1 credit = 1 akun).
function computeOrderPricing(validCount, settings, user, voucher) {
  const creditAvailable = Number((user && user.credit) || 0);
  const freeUsed = Math.min(creditAvailable, validCount);
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
      if (u) u.credit = Math.max(0, Number(u.credit || 0) - Number(target.freeUsed));
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
      [{ text: "🌍 Pilih Region", callback_data: "region_menu" }],
    ],
  };
}

function regionMenuKeyboard(currentRegion, settings) {
  const cur = String(currentRegion || "UK").toUpperCase();
  const enabled = enabledRegions(settings);
  const mark = (r) => (cur === r ? " ✅" : "");
  const rows = enabled.map((r) => [{ text: `${REGION_LABELS[r] || r}${mark(r)}`, callback_data: `region_set_${r}` }]);
  rows.push([{ text: "⬅️ Kembali ke Menu", callback_data: "back_menu" }]);
  return { inline_keyboard: rows };
}

function toolbarKeyboard() {
  return {
    keyboard: [[{ text: "📊 Status" }, { text: "🚀 Menu" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function backButton() {
  return { inline_keyboard: [[{ text: "⬅️ Kembali ke Menu", callback_data: "back_menu" }]] };
}

async function tg(method, payload = {}) {
  const { data } = await axios.post(`${API}/${method}`, payload, { timeout: 30000 });
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function registerBotCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Start the bot" },
      { command: "hitung", description: "Kalkulasi harga (mis. /hitung 250)" },
      { command: "saldo", description: "Cek credit ngait kamu" },
    ],
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
        region: "UK",
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

  // Bot Info: total ngait global + milestone bonus (tiap {step} ngait -> +{per} credit).
  const stats = await botStats();
  const milestoneStep = Number(process.env.BONUS_MILESTONE_STEP || 1000);
  const milestonePer = Number(process.env.BONUS_CREDIT_PER_1000 || 50);
  const userKait = Number(user.totalKait || 0);
  const nextMilestone = (Math.floor(userKait / milestoneStep) + 1) * milestoneStep;
  const toNext = Math.max(0, nextMilestone - userKait);

  const homeText = [
    `Halo ${user.firstName || "User"}`,
    "",
    "<b>User Info</b>",
    `L ID: <code>${user.telegramId}</code>`,
    `L Username: ${username}`,
    `L Total Kait: ${user.totalKait || 0}`,
    `L Credit Ngait: ${user.credit || 0} akun`,
    `L Total Pengeluaran: ${formatRupiah(user.totalSpend || 0)}`,
    "",
    "<b>Bot Info</b>",
    `L Total Ngait (semua user): ${stats.totalKait}`,
    `L Milestone: tiap ${milestoneStep} ngait → +${milestonePer} credit`,
    `L Progress kamu: ${userKait}/${nextMilestone} (kurang ${toNext} ngait lagi → +${milestonePer} credit)`,
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

// Tambah region baru cukup di sini (key UPPERCASE + label berbendera).
const REGION_LABELS = { UK: "🇬🇧 UK", FRANCE: "🇫🇷 France", GERMANY: "🇩🇪 Germany", SPAIN: "🇪🇸 Spain", NETHERLANDS: "🇳🇱 Netherlands" };
const REGION_OPTIONS = Object.keys(REGION_LABELS);
function regionLabel(region) {
  const r = String(region || "UK").toUpperCase();
  return REGION_LABELS[r] || REGION_LABELS.UK;
}
function disabledRegionsOf(settings) {
  const d = settings && Array.isArray(settings.disabledRegions) ? settings.disabledRegions : [];
  return d.map((r) => String(r).toUpperCase());
}
function enabledRegions(settings) {
  const disabled = disabledRegionsOf(settings);
  const list = REGION_OPTIONS.filter((r) => !disabled.includes(r));
  return list.length ? list : ["UK"]; // jangan sampai kosong
}
function normalizeRegion(region, settings) {
  const enabled = enabledRegions(settings);
  const r = String(region || "").toUpperCase();
  return enabled.includes(r) ? r : enabled[0];
}
function nextRegion(region, settings) {
  const enabled = enabledRegions(settings);
  const r = String(region || enabled[0]).toUpperCase();
  const idx = enabled.indexOf(r);
  return enabled[(idx + 1) % enabled.length];
}
function adminRegionKeyboard(settings) {
  const disabled = disabledRegionsOf(settings);
  const rows = REGION_OPTIONS.map((r) => [{
    text: `${REGION_LABELS[r] || r} — ${disabled.includes(r) ? "🚫 OFF" : "✅ ON"}`,
    callback_data: `admin_region_toggle_${r}`,
  }]);
  rows.push([{ text: "⬅️ Tutup", callback_data: "back_menu" }]);
  return { inline_keyboard: rows };
}
function kaitDraftKeyboard(session, opts = {}) {
  const credit = Math.max(0, Number(opts.credit || 0));
  const accounts = Math.max(0, Number(opts.accounts || 0));
  const rows = [
    [{ text: `🌍 Region: ${regionLabel(session && session.region)}`, callback_data: "toggle_region" }],
  ];
  if (accounts > 0 && credit >= accounts) {
    // Credit cukup -> bayar penuh pakai credit (gratis).
    rows.push([{ text: `💳 Bayar pakai Credit (${accounts} akun • GRATIS)`, callback_data: "confirm_kait" }]);
  } else if (credit > 0) {
    // Ada credit tapi kurang -> 2 pilihan: pakai credit + QRIS sisa, atau topup credit dulu.
    const kurang = accounts - credit;
    rows.push([{ text: `💳 ${credit} credit + QRIS ${kurang} akun`, callback_data: "confirm_kait" }]);
    rows.push([{ text: `➕ Topup Credit (${kurang} akun)`, callback_data: "topup_credit" }]);
  } else {
    // Tidak ada credit -> QRIS saja.
    rows.push([{ text: "🧾 Bayar QRIS", callback_data: "confirm_kait" }]);
  }
  rows.push([{ text: "🎟️ Pakai Voucher", callback_data: "apply_voucher" }]);
  rows.push([{ text: "Batal", callback_data: "cancel_session" }]);
  return { inline_keyboard: rows };
}

// Ambil credit user + jumlah akun draft -> dipakai utk nentuin tombol bayar di draft keyboard.
function draftKeyboardOpts(user, parsed) {
  return {
    credit: Number((user && user.credit) || 0),
    accounts: parsed && parsed.valid ? parsed.valid.length : 0,
  };
}

function buildOrderSummary(parsed, settings, user, voucher, region) {
  const p = computeOrderPricing(parsed.valid.length, settings, user, voucher);
  const lines = [
    "<b>Order Kait PSC</b>",
    "",
    `🌍 Region: <b>${regionLabel(region)}</b>`,
    `Total input: ${parsed.totalInput}`,
    `Valid Gsuite: ${parsed.valid.length}`,
    `Invalid: ${parsed.invalid.length}`,
    `Duplicate: ${parsed.duplicate}`,
    "",
    `Harga: ${formatRupiah(p.pricePerAccount)} / akun (sesuai jumlah akun)`,
  ];
  if (p.freeUsed > 0) lines.push(`🎁 Credit dipakai: ${p.freeUsed} akun (gratis)`);
  lines.push(`Akun kena biaya: ${p.chargeableCount}`);
  lines.push(`Subtotal: ${formatRupiah(p.subtotal)}`);
  if (p.voucherCode) lines.push(`🎟️ Voucher ${p.voucherCode} (-${p.voucherPercent}%): -${formatRupiah(p.voucherDiscount)}`);
  lines.push(`Total: <b>${formatRupiah(p.afterDiscount)}</b>${p.afterDiscount === 0 ? " (GRATIS pakai credit)" : ""}`);
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

  const defaultRegion = normalizeRegion(user && user.region, settings);
  const draftSession = { mode: "confirm_kait", parsed, voucher: voucher || null, region: defaultRegion };
  sessions.set(String(chatId), draftSession);
  const draftMessage = await sendMessage(chatId, buildOrderSummary(parsed, settings, user, voucher, draftSession.region), {
    reply_markup: kaitDraftKeyboard(draftSession, draftKeyboardOpts(user, parsed)),
  });
  draftSession.draftMessageId = draftMessage.message_id;
  sessions.set(String(chatId), draftSession);
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
    region: normalizeRegion(session.region, settings),
    totalInput: parsed.totalInput,
    totalAccounts: parsed.valid.length,
    invalidAccounts: parsed.invalid.length,
    duplicateAccounts: parsed.duplicate,
    pricePerAccount: pricing.pricePerAccount,
    freeUsed: pricing.freeUsed,
    chargeableCount: pricing.chargeableCount,
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

  // ===== Order GRATIS (credit + voucher menutup semua biaya) =====
  if (isFree) {
    const order = { ...baseOrder, status: "QUEUED", payment: { provider: "credit", status: "PAID" }, paidAt: now };
    await ordersStore.update((orders) => {
      orders.push(order);
      return orders;
    });
    await consumeOrderBenefits(orderId);
    log(`created order #${orderId} GRATIS pakai credit user=@${order.username || "-"} accounts=${order.totalAccounts} creditUsed=${pricing.freeUsed}`);
    sessions.delete(String(chatId));
    await sendMessage(
      chatId,
      [
        `🎉 <b>Order #${orderId} GRATIS!</b>`,
        "",
        `Total akun: ${order.totalAccounts}`,
        `🎁 Credit dipakai: ${pricing.freeUsed} akun`,
        pricing.voucherCode ? `🎟️ Voucher ${pricing.voucherCode} (-${pricing.voucherPercent}%)` : "",
        "Langsung masuk antrian, tidak perlu bayar.",
      ].filter(Boolean).join("\n")
    );
    await notifyAdmins(
      [
        "🔔 <b>Order Baru (GRATIS pakai credit)</b>",
        "",
        `🆔 Order: <code>${orderId}</code>`,
        `👤 User: ${order.username ? "@" + order.username : order.telegramId}`,
        `📧 Jumlah akun: <b>${order.totalAccounts}</b>`,
        `🎁 Credit dipakai: ${pricing.freeUsed} akun`,
        pricing.voucherCode ? `🎟️ Voucher: ${pricing.voucherCode} -${pricing.voucherPercent}%` : "",
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
      pricing.freeUsed ? `🎁 Credit dipakai: ${pricing.freeUsed} akun` : "",
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
    pricing.freeUsed ? `🎁 Credit dipakai: ${pricing.freeUsed} | Kena biaya: ${pricing.chargeableCount}` : "",
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

// Topup Credit: beli credit sejumlah kekurangan (accounts - credit) via QRIS.
// Setelah dibayar, credit user bertambah (lihat markOrderPaid -> cabang kind "topup").
async function createCreditTopup(chatId, from, callbackMessageId) {
  const session = sessions.get(String(chatId));
  if (!session || session.mode !== "confirm_kait" || !session.parsed) {
    await sendMessage(chatId, "Tidak ada draft order aktif.");
    return;
  }
  const settings = await settingsStore.read();
  const users = await usersStore.read();
  const user = users[String(from.id)];
  const accounts = session.parsed.valid.length;
  const credit = Number((user && user.credit) || 0);
  const kurang = accounts - credit;
  if (kurang <= 0) {
    await sendMessage(chatId, "Credit kamu sudah cukup. Pilih 'Bayar pakai Credit'.");
    return;
  }
  const topupId = Date.now();
  const pricePerAccount = getPricePerAccount(accounts, settings);
  const subtotal = kurang * pricePerAccount;
  const uniqueCode = getUniquePaymentCode(topupId, settings);
  const totalPrice = subtotal + uniqueCode;

  let invoice;
  try {
    invoice = await createQrisInvoice({ orderId: topupId, amount: totalPrice });
  } catch (error) {
    await sendMessage(chatId, `Gagal membuat QRIS topup: ${error.message}`);
    return;
  }

  const now = new Date().toISOString();
  const topup = {
    id: topupId,
    kind: "topup",
    telegramId: String(from.id),
    username: from.username || "",
    topupCredit: kurang,
    pricePerAccount,
    totalPrice,
    uniqueCode,
    status: "WAITING_PAYMENT",
    payment: { ...invoice, orderId: topupId, amount: totalPrice, status: "PENDING" },
    createdAt: now,
    updatedAt: now,
  };
  await ordersStore.update((orders) => {
    orders.push(topup);
    return orders;
  });
  log(`created TOPUP #${topupId} user=@${topup.username || "-"} credit=${kurang} total=${totalPrice}`);

  await notifyAdmins(
    [
      "🔔 <b>Topup Credit Baru</b>",
      "",
      `🆔 Topup: <code>${topupId}</code>`,
      `👤 User: ${topup.username ? "@" + topup.username : topup.telegramId}`,
      `🎁 Credit dibeli: <b>${kurang} akun</b>`,
      `💰 Total bayar: <b>${formatRupiah(totalPrice)}</b>`,
    ].join("\n"),
    String(from.id)
  );

  const lines = [
    `<b>QRIS Topup Credit #${topupId}</b>`,
    "",
    `🎁 Credit dibeli: <b>${kurang} akun</b>`,
    `Harga: ${formatRupiah(pricePerAccount)} / akun`,
    `Subtotal: ${formatRupiah(subtotal)}`,
    uniqueCode ? `Kode unik: ${formatRupiah(uniqueCode)}` : "",
    `Total bayar: <b>${formatRupiah(totalPrice)}</b>`,
    "",
    "Setelah dibayar, credit otomatis masuk. Lalu order lagi & pilih <b>Bayar pakai Credit</b>.",
    "",
    invoice.provider === "manual" ? invoice.qrText : "Scan QRIS untuk menyelesaikan pembayaran.",
  ].filter(Boolean);
  const replyMarkup = {
    inline_keyboard: [
      [{ text: "Cek Pembayaran", callback_data: `checkpay_${topupId}` }],
      [{ text: "Batalkan", callback_data: `cancel_order_${topupId}` }],
    ],
  };

  const recordMsg = async (msgId) => {
    await ordersStore.update((orders) =>
      orders.map((item) => (item.id === topupId ? { ...item, paymentMessageId: msgId, paymentChatId: String(chatId) } : item))
    );
  };

  sessions.delete(String(chatId));
  if (invoice.provider !== "manual" && invoice.qrText) {
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=700x700&data=${encodeURIComponent(invoice.qrText)}`;
    try {
      const sent = await sendPhoto(chatId, qrImageUrl, lines.join("\n"), { reply_markup: replyMarkup });
      await recordMsg(sent.message_id);
      await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
      return;
    } catch (error) {
      const sent = await sendMessage(chatId, `${lines.join("\n")}\n\nQR image gagal, payload:\n<code>${invoice.qrText}</code>`, { reply_markup: replyMarkup });
      await recordMsg(sent.message_id);
      await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
      return;
    }
  }
  const sent = await sendMessage(chatId, lines.join("\n"), { reply_markup: replyMarkup });
  await recordMsg(sent.message_id);
  await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
}

async function retryFailedOrder(chatId, from, sourceOrderId, callbackMessageId) {
  const orders = await ordersStore.read();
  const src = orders.find((o) => String(o.id) === String(sourceOrderId));
  if (!src) {
    await sendMessage(chatId, "Order sumber tidak ditemukan.");
    return;
  }
  if (String(src.telegramId) !== String(from.id) && !isAdmin(chatId)) {
    await sendMessage(chatId, "Order ini bukan punyamu.");
    return;
  }
  // Order yang DIBATALKAN tidak bisa di-retry — sisa akun sudah dikembalikan sbg credit, harus order ulang.
  if (src.status === "CANCELLED" || src.cancelledByAdmin) {
    await sendMessage(chatId, "Order ini sudah dibatalkan dan tidak bisa di-retry. Akun sisa sudah dikembalikan sebagai credit — silakan buat order baru.");
    return;
  }
  let content = "";
  try {
    content = fs.readFileSync(path.join(src.orderPath, "remaining-unverified.txt"), "utf-8");
  } catch (_) {}
  const parsed = parseGsuiteInput(content);
  if (!parsed.valid.length) {
    await sendMessage(chatId, "Tidak ada akun gagal untuk di-retry (mungkin sudah di-retry).");
    return;
  }
  // Pakai flow order yang sama: set session sementara, saldo otomatis dipotong di sana.
  sessions.set(String(chatId), { mode: "confirm_kait", parsed, voucher: null });
  await sendMessage(chatId, `🔁 Membuat order retry untuk ${parsed.valid.length} akun gagal (pakai saldo)...`);
  await deleteMessage(chatId, callbackMessageId);
  await createOrderFromSession(chatId, from, callbackMessageId);
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

// Pesan antrian yang sedang "live" -> di-edit otomatis berkala (tanpa perlu Refresh).
// key `${chatId}:${messageId}` -> { chatId, messageId, telegramId, until, lastText }
const liveQueueMessages = new Map();

async function buildQueueView(telegramId) {
  const allOrders = await ordersStore.read();
  const activeOrders = allOrders.filter((order) => ["RUNNING", "QUEUED"].includes(order.status));
  const totalQueueAccounts = activeOrders.reduce(
    (sum, order) => sum + Number(order.remainingCount || order.totalAccounts || 0),
    0
  );
  const totalQueueOrders = activeOrders.length;
  const totalAllAccounts = activeOrders.reduce((sum, order) => sum + Number(order.totalAccounts || 0), 0);
  const totalDone = activeOrders.reduce((sum, order) => sum + Number(order.successCount || 0), 0);
  const orders = allOrders
    .filter((order) =>
      order.telegramId === String(telegramId) &&
      ["QUEUED", "RUNNING"].includes(order.status)
    )
    .slice(-10)
    .reverse();

  const peopleInQueue = new Set(activeOrders.map((order) => String(order.telegramId))).size;

  const text = [
    "📋 <b>Antrian Ngait</b>",
    "",
    `👥 Orang di antrian: <b>${peopleInQueue}</b>`,
    `📦 Order aktif: <b>${totalQueueOrders}</b>`,
    `📧 Total gsuite ngait: <b>${totalQueueAccounts}</b>`,
    "",
    "📊 <b>Progress Total (semua order)</b>",
    `<code>${miniBar(totalDone, totalAllAccounts || 1)}</code>`,
    `${totalDone}/${totalAllAccounts} akun selesai`,
    "",
    "📜 <b>Antrian Kamu</b>",
    orders.length
      ? orders
          .map((order, index) => {
            const statusIcon = order.status === "RUNNING" ? "🟢" : "🕒";
            const head = `${index + 1}. ${statusIcon} <b>${order.status}</b> — ${order.totalAccounts} akun  🆔 <code>${order.id}</code>`;
            const batches = Array.isArray(order.batches) ? order.batches : [];
            if (!batches.length) {
              return `${head}\n   🕒 Menunggu diproses...`;
            }
            const batchLines = batches.map((b) => {
              const total = Number(b.total || 0);
              const success = Number(b.success || 0);
              const done = b.status === "DONE";
              const pct = done ? 100 : Math.floor((success / Math.max(1, total)) * 100);
              const label = b.round === 1 ? `Batch ${b.round}` : `Batch ${b.round} (sisa ${total} gsuite)`;
              return [
                `   📦 ${label} — ✅ ${success}/${total} berhasil`,
                `   <code>${miniBar(pct, 100)}</code>`,
              ].join("\n");
            });
            return [head, ...batchLines].join("\n");
          })
          .join("\n\n")
      : "Belum ada order paid/proses.",
  ].join("\n");

  const reply_markup = {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: "refresh_queue" }],
      [{ text: "⬅️ Kembali ke Menu", callback_data: "back_menu" }],
    ],
  };
  return { text, reply_markup };
}

async function showQueue(chatId, telegramId) {
  const view = await buildQueueView(telegramId);
  const sent = await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
  // Daftarkan pesan ini supaya di-update OTOMATIS (tanpa Refresh) selama beberapa menit.
  if (sent && sent.message_id) {
    const durationMs = Number(process.env.QUEUE_AUTOREFRESH_MINUTES || 5) * 60 * 1000;
    liveQueueMessages.set(`${chatId}:${sent.message_id}`, {
      chatId,
      messageId: sent.message_id,
      telegramId: String(telegramId),
      until: Date.now() + durationMs,
      lastText: view.text,
    });
  }
}

// Ticker: edit semua pesan antrian "live" dengan data terbaru. Skip kalau konten sama
// (hindari error 'message is not modified' & hemat rate-limit). Auto-stop saat expired/dihapus.
let isTickingQueues = false;
async function tickLiveQueues() {
  if (isTickingQueues || liveQueueMessages.size === 0) return;
  isTickingQueues = true;
  try {
    const now = Date.now();
    for (const [key, q] of liveQueueMessages) {
      if (now > q.until) {
        liveQueueMessages.delete(key);
        continue;
      }
      try {
        const view = await buildQueueView(q.telegramId);
        if (view.text === q.lastText) continue; // tidak berubah -> jangan edit
        await tg("editMessageText", {
          chat_id: q.chatId,
          message_id: q.messageId,
          text: view.text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: view.reply_markup,
        });
        q.lastText = view.text;
      } catch (error) {
        const m = String(error.message || "");
        if (m.includes("not modified")) continue;
        // pesan dihapus / tidak ketemu / diedit -> berhenti melacak.
        liveQueueMessages.delete(key);
      }
    }
  } finally {
    isTickingQueues = false;
  }
}

async function markOrderPaid(orderId) {
  const orders = await ordersStore.read();
  const order = orders.find((o) => String(o.id) === String(orderId));
  if (!order) return null;

  // ===== TOPUP CREDIT =====: bukan order ngait. Saat dibayar -> tambah credit user, JANGAN QUEUE.
  if (order.kind === "topup") {
    if (order.status !== "WAITING_PAYMENT") {
      log(`topup #${orderId} diabaikan (status=${order.status})`);
      return null;
    }
    const num0 = Number(orderId);
    const idValues0 = [...new Set([orderId, String(orderId), ...(Number.isFinite(num0) ? [num0] : [])])];
    const okTopup = await ordersStore.patchItem(
      "id",
      idValues0,
      { status: "TOPUP_DONE", "payment.status": "PAID", paidAt: new Date().toISOString() },
      { whereField: "status", whereIn: ["WAITING_PAYMENT"] }
    );
    if (!okTopup) return null;
    const addCredit = Number(order.topupCredit || 0);
    if (addCredit > 0) {
      await usersStore.update((users) => {
        const u = users[order.telegramId];
        if (u) u.credit = Number(u.credit || 0) + addCredit;
        return users;
      });
    }
    log(`topup #${orderId} PAID -> +${addCredit} credit user=${order.telegramId}`);
    if (order.paymentChatId && order.paymentMessageId) {
      try {
        await tg("deleteMessage", { chat_id: order.paymentChatId, message_id: order.paymentMessageId });
      } catch (_) {}
    }
    await sendMessage(
      order.telegramId,
      `🎁 <b>Topup berhasil!</b>\nCredit +${addCredit} akun sudah masuk.\nSilakan order lagi & pilih <b>Bayar pakai Credit</b>.`
    ).catch(() => {});
    return { ...order, status: "TOPUP_DONE", topupPaid: true };
  }

  // PENTING: order yang DIBATALKAN ADMIN (/batalproses) tidak boleh dihidupkan lagi
  // oleh pembayaran yang masuk belakangan. Hanya WAITING_PAYMENT atau cancel non-admin
  // (mis. cancel user/timeout) yang boleh dibayar telat -> masuk antrian.
  const revivable =
    order.status === "WAITING_PAYMENT" ||
    (order.status === "CANCELLED" && !order.cancelledByAdmin);
  if (!revivable) {
    log(`payment #${orderId} diabaikan (status=${order.status}, cancelledByAdmin=${!!order.cancelledByAdmin})`);
    return null;
  }
  const num = Number(orderId);
  const idValues = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
  // Atomic + guard status (hanya dari status yang barusan diverifikasi) -> tidak menimpa
  // pembatalan admin yang mungkin terjadi tepat sebelum update ini.
  const ok = await ordersStore.patchItem(
    "id",
    idValues,
    { status: "QUEUED", "payment.status": "PAID", paidAt: new Date().toISOString() },
    { whereField: "status", whereIn: [order.status] }
  );
  if (!ok) {
    log(`payment #${orderId} batal di-apply (status berubah sebelum update)`);
    return null;
  }
  const updatedOrder = {
    ...order,
    status: "QUEUED",
    payment: { ...order.payment, status: "PAID" },
    paidAt: new Date().toISOString(),
  };
  log(`payment paid for order #${orderId}; status QUEUED`);
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
    const now = Date.now();
    const expireMs = Number(process.env.PAYMENT_EXPIRE_MINUTES || 15) * 60 * 1000;
    const isExpired = (order) => {
      const created = new Date(order.createdAt || 0).getTime();
      return Number.isFinite(created) && now - created >= expireMs;
    };

    // 1) Poll order aktif utk deteksi pembayaran. JANGAN poll WAITING_PAYMENT yang sudah
    //    kadaluarsa (akan di-expire di langkah 2) -> ini yang bikin spam timeout OrderKuota.
    const orders = (await ordersStore.read())
      .filter((order) => {
        if (order.status === "WAITING_PAYMENT") return !isExpired(order);
        if (order.status !== "CANCELLED") return false;
        if (order.cancelledByAdmin || order.autoExpired) return false; // FINAL -> jangan poll
        if (!order.cancelledAt) return false;
        const cancelledAgeMs = now - new Date(order.cancelledAt).getTime();
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

    // 2) Auto-expire: order WAITING_PAYMENT yang sudah lewat batas & belum dibayar -> CANCELLED.
    //    Ini menghentikan polling (no more timeout spam) & membuat order "hilang" otomatis.
    const expireList = (await ordersStore.read()).filter(
      (o) => o.status === "WAITING_PAYMENT" && isExpired(o)
    );
    for (const order of expireList) {
      const num = Number(order.id);
      const idValues = [...new Set([order.id, String(order.id), ...(Number.isFinite(num) ? [num] : [])])];
      const ok = await ordersStore.patchItem(
        "id",
        idValues,
        { status: "CANCELLED", autoExpired: true, cancelledAt: new Date().toISOString() },
        { whereField: "status", whereIn: ["WAITING_PAYMENT"] }
      );
      if (!ok) continue;
      const mins = Math.round(expireMs / 60000);
      log(`order #${order.id} auto-expired (tidak dibayar > ${mins} menit) -> CANCELLED`);
      if (order.paymentChatId && order.paymentMessageId) {
        try {
          await tg("deleteMessage", { chat_id: order.paymentChatId, message_id: order.paymentMessageId });
        } catch (_) {}
      }
      // Notif user hanya kalau ordernya masih "baru-baru" (hindari spam ke order yang sudah lama banget).
      const created = new Date(order.createdAt || 0).getTime();
      if (Number.isFinite(created) && now - created < 2 * 60 * 60 * 1000) {
        try {
          await sendMessage(
            order.telegramId,
            `⏱️ Order #${order.id} dibatalkan otomatis karena tidak dibayar dalam ${mins} menit. Silakan buat order baru jika masih mau lanjut.`
          );
        } catch (_) {}
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
        "/users  (daftar user + ID + saldo)",
        "/saldo USER_ID|@username  (cek credit user)",
        "/addsaldo USER_ID|@username JUMLAH  (credit = jumlah akun)",
        "/broadcast pesan",
        "/pause",
        "/resume",
      ].join("\n"),
      { reply_markup: { inline_keyboard: [[{ text: "🌍 Atur Region (ON/OFF)", callback_data: "admin_region" }]] } }
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
    let targetId = String(args[0] || "").trim().replace(/^@/, "");
    const amount = Number(args[1]);
    if (!targetId || !Number.isFinite(amount)) {
      await sendMessage(
        chatId,
        [
          "Format (credit = jumlah akun gratis):",
          "/addsaldo USER_ID|@username JUMLAH   (tambah/kurang, mis. 9 atau -3)",
          "/setsaldo USER_ID|@username JUMLAH   (set nilai pasti)",
          "Contoh: /addsaldo @bgzess 9  (= 9 akun gratis)",
          "Lihat daftar user & ID: /users",
        ].join("\n")
      );
      return true;
    }
    // Kalau pakai @username, resolve jadi telegramId.
    if (!/^\d+$/.test(targetId)) {
      const allUsers = await usersStore.read();
      const uname = targetId.toLowerCase();
      const match = Object.values(allUsers).find(
        (u) => String(u.username || "").toLowerCase() === uname
      );
      if (!match) {
        await sendMessage(chatId, `Username @${targetId} tidak ditemukan. Cek /users untuk daftar & ID.`);
        return true;
      }
      targetId = String(match.telegramId);
    }
    let found = false;
    let newCredit = 0;
    await usersStore.update((users) => {
      if (users[targetId]) {
        found = true;
        const current = Number(users[targetId].credit || 0);
        newCredit = Math.max(0, command === "/setsaldo" ? amount : current + amount);
        users[targetId].credit = newCredit;
      }
      return users;
    });
    if (!found) {
      await sendMessage(chatId, `User ${targetId} belum terdaftar (user harus pernah /start dulu).`);
      return true;
    }
    await sendMessage(
      chatId,
      `✅ Credit user <code>${targetId}</code> sekarang: <b>${newCredit} akun</b>.`
    );
    try {
      await sendMessage(targetId, `🎁 Credit ngait kamu diperbarui admin. Sekarang: <b>${newCredit} akun</b> (bisa dipakai gratis untuk ngait).`);
    } catch (_) {}
    return true;
  }

  if (command === "/users") {
    const query = (args[0] || "").toLowerCase().replace(/^@/, "");
    const users = await usersStore.read();
    let list = Object.values(users);
    if (query) {
      list = list.filter(
        (u) =>
          String(u.username || "").toLowerCase().includes(query) ||
          String(u.telegramId || "").includes(query)
      );
    }
    list = list
      .sort((a, b) => Number(b.totalKait || 0) - Number(a.totalKait || 0))
      .slice(0, 30);
    const body = list.length
      ? list
          .map((u) =>
            [
              `👤 ${u.username ? "@" + u.username : "(tanpa username)"}`,
              `   🆔 <code>${u.telegramId}</code>`,
              `   Kait: ${u.totalKait || 0} | Credit: ${u.credit || 0} akun`,
            ].join("\n")
          )
          .join("\n\n")
      : "Tidak ada user.";
    await sendMessage(
      chatId,
      [
        `👥 <b>Daftar User</b>${query ? ` (cari: ${query})` : " (top 30 by kait)"}`,
        "",
        body,
        "",
        "Tambah credit: /addsaldo USER_ID|@username JUMLAH",
      ].join("\n")
    );
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
    const orders = allOrders.slice(-10).reverse();
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
    const orderId = String(args[0] || "").replace(/^#+/, "").trim();
    if (!orderId) {
      await sendMessage(chatId, "Format: /batalproses ORDER_ID");
      return true;
    }
    const allOrders = await ordersStore.read();
    const target = allOrders.find((o) => String(o.id) === String(orderId));
    const num = Number(orderId);
    const idValues = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
    // Set CANCELLED secara ATOMIC + hanya jika status masih QUEUED/RUNNING/PAID.
    // Atomic = tidak bisa ketimpa balik oleh tulisan worker (mencegah order "hidup lagi").
    const cancelled = await ordersStore.patchItem(
      "id",
      idValues,
      { status: "CANCELLED", cancelledByAdmin: true, cancelledAt: new Date().toISOString() },
      { whereField: "status", whereIn: ["QUEUED", "RUNNING", "PAID"] }
    );
    if (!cancelled) {
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

  if (text.startsWith("/saldo")) {
    const arg = text.trim().split(/\s+/)[1];
    const users = await usersStore.read();
    if (arg && isAdmin(chatId)) {
      let targetId = arg.replace(/^@/, "");
      if (!/^\d+$/.test(targetId)) {
        const match = Object.values(users).find(
          (u) => String(u.username || "").toLowerCase() === targetId.toLowerCase()
        );
        if (!match) {
          await sendMessage(chatId, `User @${targetId} tidak ditemukan. Cek /users.`);
          return;
        }
        targetId = String(match.telegramId);
      }
      const u = users[targetId];
      if (!u) {
        await sendMessage(chatId, `User ${targetId} tidak ditemukan.`);
        return;
      }
      await sendMessage(
        chatId,
        [
          "🎁 <b>Credit User</b>",
          `👤 ${u.username ? "@" + u.username : u.telegramId}`,
          `🆔 <code>${u.telegramId}</code>`,
          `Credit ngait: <b>${u.credit || 0} akun</b>`,
          `Total Kait: ${u.totalKait || 0}`,
        ].join("\n")
      );
      return;
    }
    const me = users[String(chatId)] || {};
    await sendMessage(chatId, `🎁 Credit ngait kamu: <b>${me.credit || 0} akun</b>`);
    return;
  }

  if (text.startsWith("/hitung") || text.startsWith("/calc")) {
    const parts = text.trim().split(/\s+/);
    const jumlah = Number(parts[1]);
    const voucherCode = parts[2];
    if (!Number.isInteger(jumlah) || jumlah <= 0) {
      await sendMessage(chatId, "Format: /hitung JUMLAH [KODE_VOUCHER]\nContoh: /hitung 250  atau  /hitung 250 HEMAT10");
      return;
    }
    const settings = await settingsStore.read();
    const voucher = voucherCode ? await getActiveVoucher(voucherCode) : null;
    const ppa = getPricePerAccount(jumlah, settings);
    const subtotal = jumlah * ppa;
    const vPct = voucher ? Number(voucher.percent) : 0;
    const vDisc = vPct ? Math.floor((subtotal * vPct) / 100) : 0;
    const total = subtotal - vDisc;
    const lines = [
      "🧮 <b>Kalkulasi Harga</b>",
      "",
      `Jumlah akun: <b>${jumlah}</b>`,
      `Harga per akun: ${formatRupiah(ppa)} (tier ${jumlah} akun)`,
      `Subtotal: ${formatRupiah(subtotal)}`,
    ];
    if (voucher) lines.push(`🎟️ Voucher ${voucher.code} (-${vPct}%): -${formatRupiah(vDisc)}`);
    else if (voucherCode) lines.push(`⚠️ Voucher "${voucherCode}" tidak valid/habis`);
    lines.push(`<b>Total: ${formatRupiah(total)}</b>`);
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

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
    // User sudah kirim akun -> hapus pesan instruksi "Format: email|password..." biar bersih, lalu lanjut proses.
    if (session.promptMessageId) await deleteMessage(chatId, session.promptMessageId);
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

  if (data === "back_menu") {
    sessions.delete(String(chatId));
    await deleteMessage(chatId, query.message?.message_id);
    return showHome(chatId, from);
  }

  if (data === "region_menu") {
    const users = await usersStore.read();
    const settings = await settingsStore.read();
    const cur = normalizeRegion((users[String(from.id)] || {}).region, settings);
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: query.message?.message_id,
      text: [
        "🌍 <b>Pilih Region</b>",
        "",
        `Region aktif: <b>${regionLabel(cur)}</b>`,
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: regionMenuKeyboard(cur, settings),
    }).catch(async () => {
      await sendMessage(chatId, "🌍 Pilih Region:", { reply_markup: regionMenuKeyboard(cur, settings) });
    });
    return;
  }

  if (data.startsWith("region_set_")) {
    const settings = await settingsStore.read();
    const requested = data.replace("region_set_", "").toUpperCase();
    if (!REGION_OPTIONS.includes(requested)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Region tidak dikenal." }).catch(() => {});
      return;
    }
    if (!enabledRegions(settings).includes(requested)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: `Region ${regionLabel(requested)} sedang dinonaktifkan admin.` }).catch(() => {});
      return;
    }
    await usersStore.update((users) => {
      const id = String(from.id);
      if (!users[id]) {
        users[id] = { telegramId: id, username: from.username || "", totalKait: 0, totalSpend: 0, createdAt: new Date().toISOString() };
      }
      users[id].region = requested;
      return users;
    });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: query.message?.message_id,
      text: [
        "🌍 <b>Region disimpan!</b>",
        "",
        `Region aktif: <b>${regionLabel(requested)}</b>`,
        "",
        "Order Kait PSC berikutnya otomatis pakai region ini. (Masih bisa diganti di draft order sebelum bayar.)",
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: regionMenuKeyboard(requested, settings),
    }).catch(() => {});
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: `Region: ${regionLabel(requested)}` }).catch(() => {});
    return;
  }

  if (data === "admin_region") {
    if (!isAdmin(chatId)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Khusus admin." }).catch(() => {});
      return;
    }
    const settings = await settingsStore.read();
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: query.message?.message_id,
      text: [
        "🌍 <b>Atur Region (admin)</b>",
        "",
        "Tap untuk ON/OFF. Region OFF tidak bisa dipilih user saat order.",
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: adminRegionKeyboard(settings),
    }).catch(async () => {
      await sendMessage(chatId, "🌍 Atur Region (admin):", { reply_markup: adminRegionKeyboard(settings) });
    });
    return;
  }

  if (data.startsWith("admin_region_toggle_")) {
    if (!isAdmin(chatId)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Khusus admin." }).catch(() => {});
      return;
    }
    const region = data.replace("admin_region_toggle_", "").toUpperCase();
    if (!REGION_OPTIONS.includes(region)) {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Region tidak dikenal." }).catch(() => {});
      return;
    }
    const newSettings = await settingsStore.update((s) => {
      const disabled = disabledRegionsOf(s);
      let next;
      if (disabled.includes(region)) {
        next = disabled.filter((r) => r !== region); // aktifkan
      } else {
        next = [...disabled, region]; // nonaktifkan
        // Jangan sampai semua region OFF.
        if (next.length >= REGION_OPTIONS.length) {
          next = next.filter((r) => r !== region);
        }
      }
      s.disabledRegions = next;
      return s;
    });
    const off = disabledRegionsOf(newSettings).includes(region);
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: query.message?.message_id,
      reply_markup: adminRegionKeyboard(newSettings),
    }).catch(() => {});
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: `${regionLabel(region)}: ${off ? "🚫 OFF" : "✅ ON"}` }).catch(() => {});
    return;
  }

  if (data === "kait_psc") {
    const settings = await settingsStore.read();
    const promptMsg = await sendMessage(
      chatId,
      [
        "<b>Format: email|password</b>",
        `Min: ${getMinOrderForChat(chatId, settings)} akun`,
        "",
        "Format lain seperti email:pass, email;pass, email pass akan otomatis di-convert.",
        "Hanya email GSuite/Google Workspace. Email gratis akan ditolak.",
        "Lebih dari 50 akun wajib kirim file .txt.",
      ].join("\n"),
      { reply_markup: backButton() }
    );
    // Simpan id pesan instruksi ini -> dihapus begitu user kirim akun (biar chat bersih, lanjut proses).
    sessions.set(String(chatId), { mode: "awaiting_kait", promptMessageId: promptMsg?.message_id });
    return;
  }

  if (data === "convert_format") {
    sessions.set(String(chatId), { mode: "awaiting_convert" });
    await sendMessage(chatId, "Kirim list akun atau upload file .txt untuk convert format.", {
      reply_markup: backButton(),
    });
    return;
  }

  if (data === "toggle_region") {
    const session = sessions.get(String(chatId));
    if (!session || session.mode !== "confirm_kait") {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Draft order tidak aktif." }).catch(() => {});
      return;
    }
    const settings = await settingsStore.read();
    session.region = nextRegion(session.region, settings);
    sessions.set(String(chatId), session);
    const users = await usersStore.read();
    const user = users[String(from.id)];
    const voucher = session.voucher ? await getActiveVoucher(session.voucher.code) : null;
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: session.draftMessageId || query.message?.message_id,
      text: buildOrderSummary(session.parsed, settings, user, voucher, session.region),
      parse_mode: "HTML",
      reply_markup: kaitDraftKeyboard(session, draftKeyboardOpts(user, session.parsed)),
    });
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: `Region: ${regionLabel(session.region)}` }).catch(() => {});
    return;
  }

  if (data === "confirm_kait") return createOrderFromSession(chatId, from, query.message?.message_id);
  if (data === "topup_credit") return createCreditTopup(chatId, from, query.message?.message_id);
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
  if (data === "refresh_queue") {
    await deleteMessage(chatId, query.message?.message_id);
    return showQueue(chatId, from.id);
  }
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
      ].join("\n"),
      { reply_markup: backButton() }
    );
    return;
  }
  if (data === "help") {
    const settings = await settingsStore.read();
    await sendMessage(chatId, `Support: ${formatTelegramSupport(settings.support)}`, {
      reply_markup: backButton(),
    });
    return;
  }
  if (data.startsWith("checkpay_")) return checkAndUpdatePayment(chatId, data.replace("checkpay_", ""));
  if (data.startsWith("cancel_order_")) return cancelOrder(chatId, data.replace("cancel_order_", ""));
  if (data.startsWith("retry_")) return retryFailedOrder(chatId, from, data.replace("retry_", ""), query.message?.message_id);
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
  setInterval(tickLiveQueues, Number(process.env.QUEUE_AUTOREFRESH_MS || 5000));
  poll();
}

main().catch((error) => {
  console.error(`[bot] fatal: ${error.message}`);
  process.exit(1);
});

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
const orderCreationLocks = new Set();
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

function orderService(order) {
  return String((order && order.service) || "PSC").toUpperCase() === "GOPAY" ? "GOPAY" : "PSC";
}

function serviceLabel(service) {
  return String(service || "PSC").toUpperCase() === "GOPAY" ? "GoPay" : "PSC";
}

function getQueueInfo(orderId, allOrders) {
  const orders = allOrders || [];
  const target = orders.find((order) => String(order.id) === String(orderId));
  const service = orderService(target);
  const activeOrders = orders.filter(
    (order) => orderService(order) === service && ["RUNNING", "QUEUED"].includes(order.status)
  );
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
      [{ text: "🛒 Kait PSC", callback_data: "kait_psc" }],
      [{ text: "🌐 Kait GoPay", callback_data: "kait_gopay" }],
      [
        { text: "📋 Antrian", callback_data: "queue" },
        { text: "🌍 Region", callback_data: "region_menu" },
      ],
      [
        { text: "🏷️ Info & Harga", callback_data: "price_info" },
        { text: "🔄 Convert Format", callback_data: "convert_format" },
      ],
      [{ text: "💬 Bantuan & Support", callback_data: "help" }],
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
  const rawDone = Math.min(t, Math.max(0, Number(done || 0)));
  const d = rawDone >= t ? t : Math.min(t - 1, Math.ceil(rawDone));
  const percent = Math.round((d / t) * 100);
  const seg = 16;
  const filled = Math.round((percent / 100) * seg);
  return `[${"█".repeat(filled)}${"▒".repeat(seg - filled)}] ${percent}%`;
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
  // Baca 1 user saja (ringan), bukan seluruh dokumen users.
  const existing = await usersStore.readOne(id);
  if (existing) {
    const newUsername = from.username || existing.username;
    const newFirst = from.first_name || existing.firstName;
    // Tulis HANYA kalau ada perubahan -> hindari write dokumen tiap pesan (sumber delay).
    if (newUsername !== existing.username || newFirst !== existing.firstName) {
      existing.username = newUsername;
      existing.firstName = newFirst;
      await usersStore.setOne(id, existing);
    }
    return existing;
  }
  // User baru -> buat (tulis 1 key saja).
  const created = {
    telegramId: id,
    username: from.username || "",
    firstName: from.first_name || "",
    totalKait: 0,
    totalSpend: 0,
    region: "UK",
    createdAt: new Date().toISOString(),
  };
  await usersStore.setOne(id, created);
  return created;
}

let _botStatsCache = null;
let _botStatsAt = 0;
let _startLogoFileId = process.env.START_LOGO_FILE_ID || "";
async function botStats() {
  // Cache statistik (baca seluruh orders+users itu berat) -> /start & /admin jadi cepat.
  const ttl = Number(process.env.BOT_STATS_CACHE_MS || 30000);
  if (_botStatsCache && Date.now() - _botStatsAt < ttl) return _botStatsCache;
  const [users, orders] = await Promise.all([usersStore.read(), ordersStore.read()]);
  const totalKait = orders
    .filter((order) => order.status === "DONE")
    .reduce((sum, order) => sum + Number(order.successCount || 0), 0);
  _botStatsCache = { totalUsers: Object.keys(users).length, totalKait };
  _botStatsAt = Date.now();
  return _botStatsCache;
}

async function showHome(chatId, from, knownUser = null) {
  const user = knownUser || await upsertUser(from);
  const [settings, stats] = await Promise.all([settingsStore.read(), botStats()]);
  const username = user.username ? `@${user.username}` : "-";

  // Bot Info: total ngait global + milestone bonus (tiap {step} ngait -> +{per} credit).
  const milestoneStep = Number(process.env.BONUS_MILESTONE_STEP || 1000);
  const milestonePer = Number(process.env.BONUS_CREDIT_PER_1000 || 50);
  const userKait = Number(user.totalKait || 0);
  const nextMilestone = (Math.floor(userKait / milestoneStep) + 1) * milestoneStep;
  const toNext = Math.max(0, nextMilestone - userKait);

  const fmt = (n) => Number(n || 0).toLocaleString("id-ID");
  const line = "━━━━━━━━━━━━━━━";

  const homeText = [
    `Halo, <b>${user.firstName || "User"}</b>!`,
    "Selamat datang di <b>Premkuy Store</b>",
    "",
    line,
    "<b>Akun Kamu</b>",
    `ID: <code>${user.telegramId}</code>`,
    `Username: ${username}`,
    `Total Kait: <b>${fmt(user.totalKait)}</b>`,
    `Credit: <b>${fmt(user.credit)}</b> akun`,
    `Pengeluaran: <b>${formatRupiah(user.totalSpend || 0)}</b>`,
    "",
    line,
    "<b>Info Bot</b>",
    `Total Terkait: <b>${fmt(stats.totalKait)}</b>`,
    `Milestone: <b>${fmt(milestoneStep)}</b> terkait (bonus +${milestonePer} credit)`,
    `Progress: <b>${fmt(userKait)}</b> / ${fmt(nextMilestone)}`,
    `kurang <b>${fmt(toNext)}</b> ngait lagi → +${milestonePer} credit`,
    "",
    line,
    `Support: ${formatTelegramSupport(settings.support)}`,
  ].join("\n");

  if (fs.existsSync(START_LOGO_PATH)) {
    if (_startLogoFileId) {
      await sendPhoto(chatId, _startLogoFileId, homeText, { reply_markup: mainKeyboard() });
      return;
    }
    const sent = await sendPhotoFile(chatId, START_LOGO_PATH, homeText, { reply_markup: mainKeyboard() });
    const photos = sent && Array.isArray(sent.photo) ? sent.photo : [];
    if (photos.length && photos[photos.length - 1].file_id) {
      _startLogoFileId = photos[photos.length - 1].file_id;
    }
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
function paymentButtonLabel(label) {
  // Telegram tidak punya fixed-width inline button; em-space menjaga lebar visual
  // setelah keterangan panjang dalam kurung dihapus dari label.
  return `\u2003\u2003\u2003${label}\u2003\u2003\u2003`;
}
function kaitDraftKeyboard(session, opts = {}) {
  const credit = Math.max(0, Number(opts.credit || 0));
  const accounts = Math.max(0, Number(opts.accounts || 0));
  const rows = [];
  if (String((session && session.service) || "PSC").toUpperCase() !== "GOPAY") {
    rows.push([{ text: `🌍 Region: ${regionLabel(session && session.region)}`, callback_data: "toggle_region" }]);
  }
  if (accounts > 0 && credit >= accounts) {
    // Credit cukup -> PILIHAN: bayar pakai credit (gratis) ATAU QRIS penuh (simpan credit).
    rows.push([{ text: paymentButtonLabel(`💳 Bayar pakai Credit`), callback_data: "pay_credit" }]);
    rows.push([{ text: paymentButtonLabel(`🧾 Bayar QRIS penuh`), callback_data: "pay_qris" }]);
  } else if (credit > 0) {
    // Ada credit tapi kurang -> PILIHAN: kombinasi credit+QRIS, topup credit, atau QRIS penuh.
    const kurang = accounts - credit;
    rows.push([{ text: paymentButtonLabel(`💳 ${credit} credit + QRIS ${kurang} akun`), callback_data: "pay_credit" }]);
    rows.push([{ text: paymentButtonLabel(`➕ Topup Credit`), callback_data: "topup_credit" }]);
    rows.push([{ text: paymentButtonLabel(`🧾 Bayar QRIS penuh`), callback_data: "pay_qris" }]);
  } else {
    // Tidak ada credit -> QRIS saja.
    rows.push([{ text: paymentButtonLabel("🧾 Bayar QRIS"), callback_data: "pay_qris" }]);
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

function buildOrderSummary(parsed, settings, user, voucher, region, service = "PSC") {
  const p = computeOrderPricing(parsed.valid.length, settings, user, voucher);
  const isGopay = String(service).toUpperCase() === "GOPAY";
  const lines = [
    `<b>Order Kait ${isGopay ? "GoPay" : "PSC"}</b>`,
    "",
    isGopay ? "🌐 Proses: Browser • 2 paralel" : `🌍 Region: <b>${regionLabel(region)}</b>`,
    `Total input: ${parsed.totalInput}`,
    `Valid Gsuite: ${parsed.valid.length}`,
    `Invalid: ${parsed.invalid.length}`,
    `Duplicate: ${parsed.duplicate}`,
    "",
    `Harga per akun: ${formatRupiah(p.pricePerAccount)}`,
  ];
  if (p.freeUsed > 0) lines.push(`🎁 Credit dipakai: ${p.freeUsed} akun`);
  lines.push(`Akun kena biaya: ${p.chargeableCount}`);
  lines.push(`Subtotal: ${formatRupiah(p.subtotal)}`);
  if (p.voucherCode) lines.push(`🎟️ Voucher ${p.voucherCode} -${p.voucherPercent}%: -${formatRupiah(p.voucherDiscount)}`);
  lines.push(`Total: <b>${formatRupiah(p.afterDiscount)}</b>`);
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

async function handleParsedKait(chatId, parsed, voucher, service = "PSC") {
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
  const normalizedService = String(service).toUpperCase() === "GOPAY" ? "GOPAY" : "PSC";
  const draftSession = {
    mode: "confirm_kait",
    parsed,
    voucher: voucher || null,
    region: defaultRegion,
    service: normalizedService,
    orderId: Date.now(),
  };
  sessions.set(String(chatId), draftSession);
  const draftMessage = await sendMessage(chatId, buildOrderSummary(parsed, settings, user, voucher, draftSession.region, normalizedService), {
    reply_markup: kaitDraftKeyboard(draftSession, draftKeyboardOpts(user, parsed)),
  });
  draftSession.draftMessageId = draftMessage.message_id;
  sessions.set(String(chatId), draftSession);
}

async function createOrderFromSession(chatId, from, callbackMessageId) {
  const lockKey = String(chatId);
  if (orderCreationLocks.has(lockKey)) return;
  orderCreationLocks.add(lockKey);
  try {
    return await createOrderFromSessionUnlocked(chatId, from, callbackMessageId);
  } finally {
    orderCreationLocks.delete(lockKey);
  }
}

async function createOrderFromSessionUnlocked(chatId, from, callbackMessageId) {
  const session = sessions.get(String(chatId));
  if (!session || session.mode !== "confirm_kait") {
    await sendMessage(chatId, "Tidak ada draft order aktif.");
    return;
  }

  const settings = await settingsStore.read();
  const parsed = session.parsed;
  // ID ditetapkan saat draft dibuat agar klik callback berulang tetap merujuk order sama.
  const orderId = Number(session.orderId || Date.now());
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
  // Kalau user pilih "Bayar QRIS penuh (simpan credit)" -> jangan pakai credit (credit = 0).
  const pricingUser = session.useCredit === false ? { ...user, credit: 0 } : user;
  const pricing = computeOrderPricing(parsed.valid.length, settings, pricingUser, voucher);

  const now = new Date().toISOString();
  const isFree = pricing.afterDiscount <= 0;
  // Gateway aktif kalau ORKUT_GATEWAY_URL di-set. Cara lama: kode unik buatan bot.
  // Gateway: fee + total ditentukan gateway (di-set ulang setelah invoice).
  const useGateway = !isFree && !!process.env.ORKUT_GATEWAY_URL;
  let uniqueCode = isFree || useGateway ? 0 : getUniquePaymentCode(orderId, settings);
  let totalPrice = pricing.afterDiscount + uniqueCode;

  const baseOrder = {
    id: orderId,
    service: String(session.service || "PSC").toUpperCase() === "GOPAY" ? "GOPAY" : "PSC",
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
    let inserted = false;
    await ordersStore.update((orders) => {
      if (orders.some((item) => String(item.id) === String(orderId))) return orders;
      orders.push(order);
      inserted = true;
      return orders;
    });
    if (!inserted) {
      sessions.delete(String(chatId));
      await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
      return;
    }
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
    if (useGateway) {
      // Gateway nentuin fee + total. Kirim base amount (afterDiscount), pakai amount balikan.
      invoice = await createQrisInvoice({ orderId, amount: pricing.afterDiscount });
      totalPrice = Number(invoice.amount) || pricing.afterDiscount;
      uniqueCode = Number(invoice.fee) || 0;
    } else {
      invoice = await createQrisInvoice({ orderId, amount: totalPrice });
    }
  } catch (error) {
    if (error.code === "GATEWAY_WAITING") {
      await sendMessage(chatId, `⏳ ${error.message}\nSilakan coba lagi beberapa saat (mungkin lagi sibuk/maintenance).`);
      return;
    }
    await sendMessage(chatId, `Gagal membuat QRIS: ${error.message}`);
    return;
  }
  const order = {
    ...baseOrder,
    uniqueCode,
    totalPrice,
    status: "WAITING_PAYMENT",
    payment: { ...invoice, orderId, amount: totalPrice, status: "PENDING" },
  };

  let inserted = false;
  await ordersStore.update((orders) => {
    if (orders.some((item) => String(item.id) === String(orderId))) return orders;
    orders.push(order);
    inserted = true;
    return orders;
  });
  if (!inserted) {
    sessions.delete(String(chatId));
    await deleteMessage(chatId, session.draftMessageId || callbackMessageId);
    return;
  }
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
  const lockKey = String(chatId);
  if (orderCreationLocks.has(lockKey)) return;
  orderCreationLocks.add(lockKey);
  try {
    return await createCreditTopupUnlocked(chatId, from, callbackMessageId);
  } finally {
    orderCreationLocks.delete(lockKey);
  }
}

async function createCreditTopupUnlocked(chatId, from, callbackMessageId) {
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
  sessions.set(String(chatId), {
    mode: "confirm_kait",
    parsed,
    voucher: null,
    service: orderService(src),
  });
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
  const myOrders = allOrders.filter(
    (order) => order.telegramId === String(telegramId) && ["QUEUED", "RUNNING"].includes(order.status)
  );

  function renderServiceQueue(service) {
    const global = activeOrders.filter((order) => orderService(order) === service);
    const mine = myOrders.filter((order) => orderService(order) === service);
    const totalAccounts = global.reduce((sum, order) => sum + Number(order.totalAccounts || 0), 0);
    const totalDone = global.reduce((sum, order) => sum + Number(order.successCount || 0), 0);
    const label = serviceLabel(service);
    const lines = [
      `${service === "GOPAY" ? "🌐" : "🖥"} <b>Antrian ${label}</b>`,
      `Order aktif: <b>${global.length}</b> • Progress: ${totalDone}/${totalAccounts}`,
      `<code>${miniBar(totalDone, totalAccounts || 1)}</code>`,
    ];
    if (!mine.length) {
      lines.push("Kamu belum punya order di antrean ini.");
      return lines.join("\n");
    }
    for (const order of mine.slice(-5).reverse()) {
      const position = global.findIndex((item) => String(item.id) === String(order.id)) + 1;
      const icon = order.status === "RUNNING" ? "🟢" : "🕒";
      lines.push(`${icon} #<code>${order.id}</code> • ${order.status} • ${order.successCount || 0}/${order.totalAccounts} akun${position > 0 ? ` • posisi ${position}` : ""}`);
      const batches = Array.isArray(order.batches) ? order.batches : [];
      for (const batch of batches) {
        lines.push(`   Batch ${batch.round}: ${batch.success || 0}/${batch.total || 0} berhasil • ${batch.status || "QUEUED"}`);
      }
    }
    return lines.join("\n");
  }

  const text = [
    "📋 <b>Antrian Ngait</b>",
    "",
    renderServiceQueue("PSC"),
    "",
    renderServiceQueue("GOPAY"),
  ].join("\n");

  const reply_markup = {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: "refresh_queue" }],
      [{ text: "⬅️ Kembali ke Menu", callback_data: "back_menu" }],
    ],
  };
  return { text, reply_markup };
}

async function showQueue(chatId, telegramId, existingMessageId = null) {
  let messageId = existingMessageId;
  let staleMessageId = null;
  if (messageId) {
    liveQueueMessages.delete(`${chatId}:${messageId}`);
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "⏳ Memuat data antrean...",
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      if (!String(error.message || "").toLowerCase().includes("not modified")) {
        staleMessageId = messageId;
        messageId = null;
      }
    }
  }
  if (!messageId) {
    const loading = await sendMessage(chatId, "⏳ Memuat data antrean...");
    messageId = loading?.message_id || null;
    if (staleMessageId && String(staleMessageId) !== String(messageId)) {
      await deleteMessage(chatId, staleMessageId);
    }
  }

  const view = await buildQueueView(telegramId);
  if (messageId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: view.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: view.reply_markup,
    });
  } else {
    const sent = await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
    messageId = sent?.message_id || null;
  }
  // Daftarkan pesan ini supaya di-update OTOMATIS (tanpa Refresh) selama beberapa menit.
  if (messageId) {
    // Satu chat hanya boleh punya satu pesan antrean live. Hapus bar lama agar
    // refresh/fallback edit tidak meninggalkan beberapa antrean sekaligus.
    for (const [key, queueMessage] of liveQueueMessages) {
      if (String(queueMessage.chatId) !== String(chatId)) continue;
      if (String(queueMessage.messageId) === String(messageId)) continue;
      liveQueueMessages.delete(key);
      await deleteMessage(queueMessage.chatId, queueMessage.messageId);
    }
    const durationMs = Number(process.env.QUEUE_AUTOREFRESH_MINUTES || 5) * 60 * 1000;
    liveQueueMessages.set(`${chatId}:${messageId}`, {
      chatId,
      messageId,
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

  // Notif PEMBAYARAN BERHASIL -> ke USER (buyer) & ADMIN (sebelumnya cuma notif "menunggu pembayaran").
  const notifyId = order.notifyTo || order.telegramId;
  const sentPaid = await sendMessage(
    notifyId,
    [
      "✅ <b>Pembayaran berhasil!</b>",
      "",
      `🆔 Order: <code>${orderId}</code>`,
      `📧 Jumlah akun: <b>${order.totalAccounts || 0}</b>`,
      "📋 Order kamu sudah <b>masuk antrian</b> & akan segera diproses.",
      "Pantau progresnya ya. 🙏",
    ].join("\n")
  ).catch(() => null);
  // Simpan id pesan ini -> nanti worker UBAH pesan ini jadi bar "sedang diproses" (1 pesan berkembang).
  if (sentPaid && sentPaid.message_id) {
    await ordersStore
      .patchItem("id", idValues, { progressMsgId: sentPaid.message_id, progressChatId: String(notifyId) })
      .catch(() => {});
  }
  await notifyAdmins(
    [
      `✅ <b>Order #${orderId} LUNAS (dibayar)</b>`,
      `👤 ${order.username ? "@" + order.username : order.telegramId}`,
      `📧 ${order.totalAccounts || 0} akun • 💰 ${formatRupiah(order.totalPrice || 0)}`,
      "📋 Masuk antrian.",
    ].join("\n"),
    String(order.telegramId)
  ).catch(() => {});

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

async function cancelOrder(chatId, orderId, from, callbackMessageId) {
  const target = (await ordersStore.read()).find((order) => String(order.id) === String(orderId));
  if (!target) {
    await sendMessage(chatId, "Order tidak ditemukan.");
    return;
  }
  if (!isAdmin(chatId) && String(target.telegramId) !== String(chatId)) {
    await sendMessage(chatId, "Order ini bukan milikmu.");
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

  sessions.delete(String(chatId));
  const messageIds = new Set(
    [callbackMessageId, target.paymentMessageId].filter(Boolean).map(String)
  );
  for (const messageId of messageIds) {
    await deleteMessage(target.paymentChatId || chatId, Number(messageId));
  }
  await showHome(chatId, from || { id: chatId });
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
        "/sisa ORDER_ID  (ambil file akun yang belum berhasil/diproses)",
        "/dahulukan ORDER_ID  (jalankan duluan + pause yang sedang jalan)",
        "/pauseorder ORDER_ID  (pause order yang sedang jalan)",
        "/lanjutkan ORDER_ID  (lanjutkan order yang di-pause)",
        "/buyer ORDER_ID @username  (arahkan progres+hasil order ke buyer)",
        "/progres ORDER_ID PERSEN  (update bar progres ke customer)",
        "/kirimhasil ORDER_ID  (kirim file .txt + caption -> hasil ke customer)",
        "/users  (daftar user + ID + saldo)",
        "/saldo USER_ID|@username  (cek credit user)",
        "/addsaldo USER_ID|@username JUMLAH  (credit = jumlah akun)",
        "/broadcast pesan  (atau kirim FOTO + caption /broadcast pesan)",
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
              `   🧩 Layanan: ${serviceLabel(orderService(order))}`,
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
    // Notif ke user (buyer) juga.
    const paidOrder = (await ordersStore.read()).find((o) => String(o.id) === String(orderId));
    if (paidOrder) {
      const notifyId = paidOrder.notifyTo || paidOrder.telegramId;
      await sendMessage(
        notifyId,
        [
          "✅ <b>Pembayaran berhasil!</b>",
          "",
          `🆔 Order: <code>${orderId}</code>`,
          `📧 Jumlah akun: <b>${paidOrder.totalAccounts || 0}</b>`,
          "📋 Order kamu sudah <b>masuk antrian</b> & akan segera diproses. 🙏",
        ].join("\n")
      ).catch(() => {});
      await notifyAdmins(
        [
          `✅ <b>Order #${orderId} LUNAS (manual)</b>`,
          `🧩 Layanan: ${serviceLabel(orderService(paidOrder))}`,
          `👤 ${paidOrder.username ? "@" + paidOrder.username : paidOrder.telegramId}`,
          `📧 ${paidOrder.totalAccounts || 0} akun • 💰 ${formatRupiah(paidOrder.totalPrice || 0)}`,
          "📋 Masuk antrian.",
        ].join("\n")
      ).catch(() => {});
    }
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
      await sendMessage(chatId, "Format: /broadcast pesan\n\n📷 Mau pakai FOTO? Kirim foto dengan caption: /broadcast pesan");
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

  if (command === "/pauseorder" || command === "/dahulukan" || command === "/prioritas" || command === "/lanjutkan" || command === "/resumeorder") {
    const orderId = String(args[0] || "").replace(/^#+/, "").trim();
    if (!orderId) {
      await sendMessage(chatId, "Format: " + command + " ORDER_ID");
      return true;
    }
    const orders = await ordersStore.read();
    const order = orders.find((o) => String(o.id) === String(orderId));
    if (!order) {
      await sendMessage(chatId, `Order #${orderId} tidak ditemukan.`);
      return true;
    }
    const num = Number(orderId);
    const idv = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];

    // PAUSE: hentikan sementara order yang sedang RUNNING (progres disimpan).
    if (command === "/pauseorder") {
      if (orderService(order) === "GOPAY") {
        await sendMessage(chatId, "Pause sementara belum dipakai untuk order GoPay. Gunakan /batalproses jika memang harus dihentikan.");
        return true;
      }
      if (order.status !== "RUNNING") {
        await sendMessage(chatId, `Order #${orderId} tidak sedang jalan (status ${order.status}). Pause hanya untuk order RUNNING.`);
        return true;
      }
      await ordersStore.patchItem("id", idv, { pauseRequested: true });
      await sendMessage(chatId, `⏸️ Order #${orderId} akan di-pause (worker berhenti sebentar lagi, progres disimpan).\nLanjutkan nanti: /lanjutkan ${orderId}`);
      return true;
    }

    // LANJUTKAN: order yang PAUSED -> QUEUED (lanjut dari progres terakhir).
    if (command === "/lanjutkan" || command === "/resumeorder") {
      if (orderService(order) === "GOPAY") {
        await sendMessage(chatId, "Order GoPay berjalan otomatis per batch dan tidak memakai status PAUSED.");
        return true;
      }
      if (order.status !== "PAUSED") {
        await sendMessage(chatId, `Order #${orderId} tidak sedang di-pause (status ${order.status}).`);
        return true;
      }
      await ordersStore.patchItem("id", idv, { status: "QUEUED", pauseRequested: false });
      await sendMessage(chatId, `▶️ Order #${orderId} dilanjutkan (masuk antrian lagi, lanjut dari progres terakhir).`);
      return true;
    }

    // DAHULUKAN: prioritaskan order ini + pause order yang sedang RUNNING (biar ini jalan duluan).
    if (command === "/dahulukan" || command === "/prioritas") {
      if (!["QUEUED", "PAID", "PAUSED"].includes(order.status)) {
        await sendMessage(chatId, `Order #${orderId} status ${order.status} — cuma bisa dahulukan order yang antri/pause.`);
        return true;
      }
      await ordersStore.patchItem("id", idv, { priority: Date.now(), status: order.status === "PAUSED" ? "QUEUED" : order.status });
      const pausedRunning = [];
      for (const o of orders) {
        if (
          orderService(order) === "PSC" &&
          orderService(o) === orderService(order) &&
          o.status === "RUNNING" &&
          String(o.id) !== String(orderId)
        ) {
          const n2 = Number(o.id);
          const idv2 = [...new Set([o.id, String(o.id), ...(Number.isFinite(n2) ? [n2] : [])])];
          await ordersStore.patchItem("id", idv2, { pauseRequested: true });
          pausedRunning.push(o.id);
        }
      }
      await sendMessage(
        chatId,
        `✅ Order #${orderId} diprioritaskan (jalan duluan).` +
          (pausedRunning.length ? `\n⏸️ Order yang sedang jalan di-pause: #${pausedRunning.join(", #")} (lanjut nanti: /lanjutkan).` : "")
      );
      return true;
    }
  }

  if (command === "/sisa") {
    const orderId = String(args[0] || "").replace(/^#+/, "").trim();
    if (!orderId) {
      await sendMessage(chatId, "Format: /sisa ORDER_ID\n(Ambil daftar akun gsuite yang BELUM berhasil/diproses dari sebuah order.)");
      return true;
    }
    const orders = await ordersStore.read();
    const order = orders.find((o) => String(o.id) === String(orderId));
    if (!order || !order.orderPath) {
      await sendMessage(chatId, `Order #${orderId} tidak ditemukan / tidak ada file-nya.`);
      return true;
    }
    const dir = order.orderPath;
    const rd = (f) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      } catch (_) {
        return [];
      }
    };
    let orig = rd("original-input.txt");
    if (!orig.length) orig = rd("input.txt");
    const okSet = new Set(rd("success.txt").map((x) => x.split("|")[0].trim().toLowerCase()));
    const nrSet = new Set(rd("not-registered.txt").map((x) => x.split("|")[0].trim().toLowerCase()));
    const sisa = orig.filter((x) => {
      const e = x.split("|")[0].trim().toLowerCase();
      return !okSet.has(e) && !nrSet.has(e);
    });
    if (!orig.length) {
      await sendMessage(chatId, `Order #${orderId}: file akun tidak ditemukan di ${dir}.`);
      return true;
    }
    if (!sisa.length) {
      await sendMessage(chatId, `Order #${orderId}: tidak ada akun sisa (semua sudah berhasil/diproses).`);
      return true;
    }
    const sisaPath = path.join(dir, "sisa.txt");
    try {
      fs.writeFileSync(sisaPath, sisa.join("\n"));
      await sendDocument(chatId, sisaPath, `📄 Akun sisa order #${orderId} — ${sisa.length} akun (total ${orig.length}, sukses ${okSet.size})`);
    } catch (e) {
      await sendMessage(chatId, `Gagal buat/kirim file sisa: ${e.message}`);
    }
    return true;
  }

  if (command === "/buyer") {
    const orderId = String(args[0] || "").replace(/^#+/, "").trim();
    const target = String(args[1] || "").trim();
    if (!orderId || !target) {
      await sendMessage(chatId, "Format: /buyer ORDER_ID ID_atau_@username\nContoh: /buyer 1781527204962 @namabuyer");
      return true;
    }
    const orders = await ordersStore.read();
    const order = orders.find((o) => String(o.id) === String(orderId));
    if (!order) {
      await sendMessage(chatId, `Order #${orderId} tidak ditemukan.`);
      return true;
    }
    let buyerId = target.replace(/^@/, "");
    if (!/^\d+$/.test(buyerId)) {
      const users = await usersStore.read();
      const match = Object.values(users).find((u) => String(u.username || "").toLowerCase() === buyerId.toLowerCase());
      if (!match) {
        await sendMessage(chatId, `User @${buyerId} tidak ditemukan (buyer harus pernah /start ke bot dulu).`);
        return true;
      }
      buyerId = String(match.telegramId);
    }
    const num = Number(orderId);
    const idValues = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
    await ordersStore.patchItem("id", idValues, { notifyTo: buyerId });
    // Test DM ke buyer -> bot TIDAK bisa kirim ke user yang belum pernah /start.
    try {
      await sendMessage(buyerId, `🔔 Kamu akan menerima update progres order #${orderId} di sini.`);
    } catch (e) {
      await sendMessage(
        chatId,
        [
          `⚠️ notifyTo order #${orderId} = ${buyerId} (tersimpan), TAPI bot GAGAL DM buyer: ${e.message}`,
          "",
          "👉 Suruh BUYER kirim /start ke bot ini dulu. Bot tidak bisa mengirim ke user yang belum pernah memulai chat.",
        ].join("\n")
      );
      return true;
    }
    await sendMessage(chatId, `✅ Order #${orderId}: progres & hasil (real-time dari worker) dikirim ke BUYER <code>${buyerId}</code>. (Test DM berhasil.)`);
    return true;
  }

  if (command === "/progres" || command === "/progress") {
    const orderId = String(args[0] || "").replace(/^#+/, "").trim();
    const percent = Math.max(0, Math.min(100, Number(args[1])));
    if (!orderId || !Number.isFinite(percent)) {
      await sendMessage(chatId, "Format: /progres ORDER_ID PERSEN\nContoh: /progres 1781525787476 50");
      return true;
    }
    const orders = await ordersStore.read();
    const order = orders.find((o) => String(o.id) === String(orderId));
    if (!order) {
      await sendMessage(chatId, `Order #${orderId} tidak ditemukan.`);
      return true;
    }
    const total = Math.max(1, Number(order.totalAccounts || 0));
    const done = Math.round((total * percent) / 100);
    const customerId = order.notifyTo || order.telegramId;
    const text = renderCustomerProgress(orderId, order.region, done, total);
    // Edit pesan progres yang SAMA kalau sudah ada (biar bar update di tempat), else kirim baru.
    let msgId = order.adminProgressMessageId || null;
    if (msgId) {
      try {
        await tg("editMessageText", { chat_id: customerId, message_id: msgId, text, parse_mode: "HTML", disable_web_page_preview: true });
      } catch (e) {
        if (!String(e.message || "").includes("not modified")) msgId = null; // pesan hilang -> kirim baru
      }
    }
    if (!msgId) {
      try {
        const sent = await sendMessage(customerId, text);
        msgId = sent && sent.message_id;
      } catch (e) {
        // Gagal kirim ke buyer (paling sering: buyer belum /start bot).
        await sendMessage(
          chatId,
          [
            `⚠️ GAGAL kirim progres ke ${customerId}: ${e.message}`,
            "",
            order.notifyTo ? `Tujuan: BUYER (notifyTo=${order.notifyTo})` : `Tujuan: pemilik order (telegramId=${order.telegramId})`,
            "",
            "Penyebab umum: BUYER belum pernah /start bot ini (bot tidak bisa DM user yang belum start),",
            "atau ID/username salah. Suruh buyer kirim /start ke bot, lalu coba lagi.",
          ].join("\n")
        );
        return true;
      }
    }
    const num = Number(orderId);
    const idValues = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
    await ordersStore.patchItem("id", idValues, { adminProgressMessageId: msgId, adminProgressChatId: String(customerId), adminProgressDone: done });
    await sendMessage(chatId, `📊 Progres order #${orderId} → ${percent}% (${done}/${total}) terkirim ke ${order.notifyTo ? "BUYER " + order.notifyTo : "pemilik order " + order.telegramId}.`);
    return true;
  }

  if (command === "/kirimhasil" || command === "/hasil") {
    await sendMessage(
      chatId,
      [
        "📤 <b>Kirim Hasil ke Customer</b>",
        "",
        "Caranya: <b>kirim file .txt hasil ngait</b> (yang kamu proses manual),",
        "lalu beri <b>caption</b>:",
        "<code>/kirimhasil ORDER_ID</code>",
        "",
        "Bot akan kirim file + notif selesai ke customer & tandai order DONE.",
      ].join("\n")
    );
    return true;
  }

  return false;
}

// Bar progres untuk customer (format mirip saat ngait normal).
function renderCustomerProgress(orderId, region, done, total) {
  const safeTotal = Math.max(1, Number(total || 0));
  const d = Math.min(safeTotal, Math.max(0, Number(done || 0)));
  return [
    `🔗 <b>Ngait Order #${orderId}</b>`,
    `🌍 ${regionLabel(region)}`,
    `<code>${miniBar(d, safeTotal)}</code>`,
    `${d}/${safeTotal} gsuite`,
  ].join("\n");
}

// ADMIN: kirim file hasil ngait (yang diproses admin manual) ke CUSTOMER + notif + tandai DONE.
// Cara pakai: admin kirim file .txt hasil ngait dengan CAPTION: /kirimhasil ORDER_ID
async function sendOrderResultToCustomer(adminChatId, message) {
  const caption = String(message.caption || "").trim();
  const orderId = String(caption.split(/\s+/)[1] || "").replace(/^#+/, "").trim();
  if (!orderId) {
    await sendMessage(adminChatId, "Format: kirim file .txt hasil ngait dengan caption:\n/kirimhasil ORDER_ID");
    return;
  }
  const orders = await ordersStore.read();
  const order = orders.find((o) => String(o.id) === String(orderId));
  if (!order) {
    await sendMessage(adminChatId, `Order #${orderId} tidak ditemukan.`);
    return;
  }
  const fileId = message.document.file_id;
  let count = 0;
  try {
    const content = await downloadTelegramFile(fileId);
    count = content.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch (_) {}

  const customerId = order.notifyTo || order.telegramId;
  const total = Math.max(1, Number(order.totalAccounts || count));

  // 0) Animasi bar progres ke customer. LANJUT dari posisi terakhir (dari /progres) -> jalan
  //    real-time naik sampai selesai, TIDAK mundur ke 0. Pakai pesan bar yang sama kalau ada.
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const startDone = Math.min(count, Math.max(0, Number(order.adminProgressDone || 0)));
    const stepsN = 4;
    const frames = [];
    for (let i = 1; i <= stepsN; i++) {
      frames.push(Math.round(startDone + ((count - startDone) * i) / stepsN));
    }
    let progMsgId = order.adminProgressMessageId || null;
    if (!progMsgId) {
      const prog = await sendMessage(customerId, renderCustomerProgress(orderId, order.region, startDone, total));
      progMsgId = prog && prog.message_id;
    }
    for (const f of frames) {
      await sleep(900);
      if (progMsgId) {
        await tg("editMessageText", {
          chat_id: customerId,
          message_id: progMsgId,
          text: renderCustomerProgress(orderId, order.region, f, total),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }).catch(() => {});
      }
    }
  } catch (_) {}

  // 1) Notif progres/selesai ke customer.
  try {
    await sendMessage(
      customerId,
      [
        `✅ <b>Order #${orderId} selesai!</b>`,
        "",
        `🌍 Region: ${regionLabel(order.region)}`,
        `Total akun: ${order.totalAccounts || count}`,
        `Berhasil ngait: <b>${count}</b> akun`,
        "",
        "Hasil ngait ada di file berikut 👇 Terima kasih sudah order! 🙏",
      ].join("\n")
    );
  } catch (e) {
    await sendMessage(adminChatId, `⚠️ Gagal kirim notif ke customer (${customerId}): ${e.message}`);
  }
  // 2) Kirim file hasil ke customer (resend by file_id, tanpa re-upload).
  try {
    await tg("sendDocument", {
      chat_id: customerId,
      document: fileId,
      caption: `✅ Hasil ngait order #${orderId} — ${count} akun`,
    });
  } catch (e) {
    await sendMessage(adminChatId, `⚠️ Gagal kirim file ke customer: ${e.message}`);
    return;
  }
  // 3) Tandai order DONE (diproses admin). Tambah totalKait customer (sekali saja).
  if (!order.processedByAdmin) {
    await usersStore.update((users) => {
      const u = users[String(customerId)];
      if (u) u.totalKait = Number(u.totalKait || 0) + count;
      return users;
    });
  }
  const num = Number(orderId);
  const idValues = [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
  await ordersStore.patchItem("id", idValues, {
    status: "DONE",
    successCount: count,
    processedByAdmin: true,
    finishedAt: new Date().toISOString(),
  });
  await sendMessage(
    adminChatId,
    `✅ Hasil order #${orderId} (${count} akun) terkirim ke customer ${order.username ? "@" + order.username : customerId} & order ditandai DONE.`
  );
}

// ADMIN: broadcast FOTO + caption ke semua user. Foto dikirim by file_id (tanpa upload ulang).
async function broadcastPhoto(adminChatId, message) {
  const caption = String(message.caption || "").replace(/^\/broadcast\s*/i, "").trim();
  const photos = message.photo || [];
  const fileId = photos.length ? photos[photos.length - 1].file_id : null; // ambil resolusi terbesar
  if (!fileId) {
    await sendMessage(adminChatId, "Foto tidak terbaca. Kirim foto dengan caption /broadcast pesan.");
    return;
  }
  const users = await usersStore.read();
  let sent = 0;
  for (const id of Object.keys(users)) {
    try {
      await tg("sendPhoto", {
        chat_id: id,
        photo: fileId,
        caption: caption || undefined,
        parse_mode: "HTML",
      });
      sent++;
    } catch (_) {}
  }
  await sendMessage(adminChatId, `📢 Broadcast foto terkirim ke ${sent} user.`);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || message.chat;
  const text = message.text || "";

  // /start harus langsung terasa merespons meski pembacaan user/statistik atau upload
  // logo sedang lambat. Loading dan database dijalankan paralel, lalu loading dihapus.
  if (/^\/start(?:\s|$)/i.test(text)) {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const [currentUser, loading] = await Promise.all([
      upsertUser(from),
      sendMessage(chatId, "⏳ Memuat menu...").catch(() => null),
    ]);
    try {
      await showHome(chatId, from, currentUser);
    } finally {
      if (loading?.message_id) await deleteMessage(chatId, loading.message_id);
    }
    return;
  }

  const currentUser = await upsertUser(from);

  // ADMIN: kirim hasil ngait manual ke customer -> file .txt dengan caption "/kirimhasil ORDER_ID".
  if (isAdmin(chatId) && message.document && /^\/(kirimhasil|hasil)\b/i.test(message.caption || "")) {
    await sendOrderResultToCustomer(chatId, message);
    return;
  }

  // ADMIN: broadcast dengan FOTO -> kirim foto + caption "/broadcast pesan".
  if (isAdmin(chatId) && message.photo && /^\/broadcast\b/i.test(message.caption || "")) {
    await broadcastPhoto(chatId, message);
    return;
  }

  if (text.startsWith("/") && isAdmin(chatId) && (await handleAdminCommand(chatId, text))) return;
  if (text === "🚀 Menu" || text.toLowerCase() === "menu") return showHome(chatId, from, currentUser);
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
      await handleParsedKait(chatId, session.parsed, session.voucher || null, session.service);
      return;
    }
    await sendMessage(chatId, `🎟️ Voucher ${voucher.code} (-${voucher.percent}%) diterapkan.`);
    await handleParsedKait(chatId, session.parsed, voucher, session.service);
    return;
  }

  if (session && session.mode === "awaiting_kait") {
    if (!message.document && content.split(/\r?\n/).filter(Boolean).length > 50) {
      await sendMessage(chatId, "Lebih dari 50 akun wajib kirim file .txt.");
      return;
    }
    // User sudah kirim akun -> hapus pesan instruksi "Format: email|password..." biar bersih, lalu lanjut proses.
    if (session.promptMessageId) await deleteMessage(chatId, session.promptMessageId);
    await handleParsedKait(chatId, parseGsuiteInput(content), null, session.service);
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
    liveQueueMessages.delete(`${chatId}:${query.message?.message_id}`);
    await deleteMessage(chatId, query.message?.message_id);
    return showHome(chatId, from);
  }

  if (data === "region_menu") {
    const users = await usersStore.read();
    const settings = await settingsStore.read();
    const cur = normalizeRegion((users[String(from.id)] || {}).region, settings);
    await deleteMessage(chatId, query.message?.message_id); // hapus menu home -> tampil region saja
    await sendMessage(
      chatId,
      ["🌍 <b>Pilih Region</b>", "", `Region aktif: <b>${regionLabel(cur)}</b>`].join("\n"),
      { reply_markup: regionMenuKeyboard(cur, settings) }
    );
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

  if (data === "kait_psc" || data === "kait_gopay") {
    const service = data === "kait_gopay" ? "GOPAY" : "PSC";
    const settings = await settingsStore.read();
    await deleteMessage(chatId, query.message?.message_id); // hapus menu home
    const promptMsg = await sendMessage(
      chatId,
      [
        `${service === "GOPAY" ? "🌐" : "🛒"} <b>Kait ${serviceLabel(service)}</b>`,
        "",
        "Kirim daftar akun GSuite dengan format:",
        "<code>email|password</code>",
        "",
        `Minimal order: <b>${getMinOrderForChat(chatId, settings)} akun</b>`,
        "• Maksimal 50 akun jika dikirim langsung melalui chat.",
        "• Lebih dari 50 akun, kirim menggunakan file <b>.txt</b>.",
        service === "GOPAY" ? "\n⚠️ <b>Note:</b> Tidak garansi jika terkena country detect." : "",
      ].filter(Boolean).join("\n"),
      { reply_markup: backButton() }
    );
    // Simpan id pesan instruksi ini -> dihapus begitu user kirim akun (biar chat bersih, lanjut proses).
    sessions.set(String(chatId), { mode: "awaiting_kait", promptMessageId: promptMsg?.message_id, service });
    return;
  }

  if (data === "convert_format") {
    sessions.set(String(chatId), { mode: "awaiting_convert" });
    await deleteMessage(chatId, query.message?.message_id); // hapus menu home
    await sendMessage(chatId, "🔄 <b>Convert Format</b>\n\nKirim list akun atau upload file .txt untuk convert format.", {
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
    if (String(session.service || "PSC").toUpperCase() === "GOPAY") {
      await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Order GoPay tidak memakai region PSC." }).catch(() => {});
      return;
    }
    session.region = nextRegion(session.region, settings);
    sessions.set(String(chatId), session);
    const users = await usersStore.read();
    const user = users[String(from.id)];
    const voucher = session.voucher ? await getActiveVoucher(session.voucher.code) : null;
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: session.draftMessageId || query.message?.message_id,
      text: buildOrderSummary(session.parsed, settings, user, voucher, session.region, session.service),
      parse_mode: "HTML",
      reply_markup: kaitDraftKeyboard(session, draftKeyboardOpts(user, session.parsed)),
    });
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: `Region: ${regionLabel(session.region)}` }).catch(() => {});
    return;
  }

  if (data === "confirm_kait" || data === "pay_credit" || data === "pay_qris") {
    const session = sessions.get(String(chatId));
    if (session) {
      // pay_qris = bayar QRIS penuh TANPA pakai credit (credit disimpan). Selain itu pakai credit.
      session.useCredit = data !== "pay_qris";
      sessions.set(String(chatId), session);
    }
    return createOrderFromSession(chatId, from, query.message?.message_id);
  }
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
  if (data === "queue") {
    // Tampilkan loading dan hapus menu secara paralel agar klik terasa langsung merespons.
    const [loading] = await Promise.all([
      sendMessage(chatId, "⏳ Memuat data antrean..."),
      deleteMessage(chatId, query.message?.message_id),
    ]);
    return showQueue(chatId, from.id, loading?.message_id);
  }
  if (data === "refresh_queue") {
    return showQueue(chatId, from.id, query.message?.message_id);
  }
  if (data === "price_info") {
    const settings = await settingsStore.read();
    await deleteMessage(chatId, query.message?.message_id); // hapus menu home
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
    await deleteMessage(chatId, query.message?.message_id); // hapus menu home
    await sendMessage(chatId, `🆘 <b>Bantuan & Support</b>\n\nSupport: ${formatTelegramSupport(settings.support)}`, {
      reply_markup: backButton(),
    });
    return;
  }
  if (data.startsWith("checkpay_")) return checkAndUpdatePayment(chatId, data.replace("checkpay_", ""));
  if (data.startsWith("cancel_order_")) {
    return cancelOrder(chatId, data.replace("cancel_order_", ""), from, query.message?.message_id);
  }
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
        // JANGAN await handler -> poll lanjut ambil update berikutnya (anti head-of-line block,
        // bot lebih responsif walau satu handler lambat). Error per-handler di-catch sendiri.
        if (update.message) {
          handleMessage(update.message).catch((e) => console.error(`[bot] handleMessage: ${e.message}`));
        }
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((e) => console.error(`[bot] handleCallback: ${e.message}`));
        }
      }
    } catch (error) {
      const code = error.response && error.response.status;
      if (code === 409) {
        // 409 Conflict = ADA INSTANCE BOT LAIN yang polling token sama.
        console.error("[bot] 409 Conflict: ADA bot lain jalan dengan token sama! Pastikan HANYA 1 instance bot. Menunggu...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
      } else {
        console.error(`[bot] ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}

async function main() {
  await connectMongo();
  log("MongoDB connected.");

  // Warm-up: isi cache statistik + hangatkan koneksi DB SEBELUM terima pesan,
  // biar /start pertama gak lambat (cache botStats kosong = baca seluruh orders).
  await botStats().catch((e) => console.error(`[warmup] botStats: ${e.message}`));

  // Hapus webhook (kalau pernah ke-set) supaya getUpdates polling tidak bentrok -> hindari 409.
  try {
    await tg("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    console.error(`[bot] deleteWebhook: ${error.message}`);
  }

  registerBotCommands()
    .then(() => log("bot commands registered"))
    .catch((error) => console.error(`[bot] failed to register commands: ${error.message}`));

  console.log("Telegram bot started.");
  // Bungkus .catch supaya rejection dari interval TIDAK jadi unhandledRejection (yang bikin bot exit).
  setInterval(() => {
    autoCheckPayments().catch((e) => console.error(`[payment] tick error: ${e.message}`));
  }, Number(process.env.PAYMENT_CHECK_INTERVAL_MS || 15000));
  setInterval(() => {
    tickLiveQueues().catch((e) => console.error(`[queue] tick error: ${e.message}`));
  }, Number(process.env.QUEUE_AUTOREFRESH_MS || 5000));
  poll();
}

// Jaring pengaman: error jaringan transient (ECONNRESET, socket hang up, timeout, dll) JANGAN
// mematikan bot. Cukup di-log, proses tetap hidup -> bot tidak "off sendiri".
process.on("unhandledRejection", (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error(`[bot] unhandledRejection (diabaikan, bot tetap jalan): ${msg}`);
});
process.on("uncaughtException", (error) => {
  console.error(`[bot] uncaughtException (diabaikan, bot tetap jalan): ${error && error.message ? error.message : error}`);
});

main().catch((error) => {
  console.error(`[bot] fatal: ${error.message}`);
  process.exit(1);
});

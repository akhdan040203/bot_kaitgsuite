require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { JsonStore } = require("./lib/json-store");
const { parseGsuiteInput } = require("./lib/gsuite-format");
const { createQrisInvoice, checkPaymentStatus } = require("./services/orderkuota");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_IDS = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || process.env.WHITELIST_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

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
const usersStore = new JsonStore(path.join(DATA_DIR, "users.json"), {});
const ordersStore = new JsonStore(path.join(DATA_DIR, "orders.json"), []);
const settingsStore = new JsonStore(path.join(DATA_DIR, "settings.json"), {
  pricePerAccount: Number(process.env.DEFAULT_PRICE_PER_ACCOUNT || 2000),
  minAccounts: Number(process.env.MIN_KAIT_ACCOUNTS || 10),
  support: process.env.SUPPORT_USERNAME || "@admin",
  uniquePaymentCode: process.env.UNIQUE_PAYMENT_CODE !== "false",
  uniquePaymentCodeMin: Number(process.env.UNIQUE_PAYMENT_CODE_MIN || 500),
  uniquePaymentCodeMax: Number(process.env.UNIQUE_PAYMENT_CODE_MAX || 999),
  paused: false,
});

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
  const username = raw.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!username) return "@admin";
  return `<a href="https://t.me/${username}">@${username}</a>`;
}

function getQueueInfo(orderId) {
  const orders = ordersStore.read();
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
      [{ text: "Kait PSC", callback_data: "kait_psc" }],
      [
        { text: "Antrian", callback_data: "queue" },
        { text: "Info & Harga", callback_data: "price_info" },
      ],
      [
        { text: "Convert Format", callback_data: "convert_format" },
        { text: "Bantuan", callback_data: "help" },
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

function upsertUser(from) {
  const id = String(from.id);
  usersStore.update((users) => {
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
  return usersStore.read()[id];
}

function botStats() {
  const users = usersStore.read();
  const orders = ordersStore.read();
  const totalKait = orders
    .filter((order) => order.status === "DONE")
    .reduce((sum, order) => sum + Number(order.successCount || 0), 0);
  return { totalUsers: Object.keys(users).length, totalKait };
}

async function showHome(chatId, from) {
  const user = upsertUser(from);
  const settings = settingsStore.read();
  const username = user.username ? `@${user.username}` : "-";
  const homeText = [
    `Halo ${user.firstName || "User"}`,
    "",
    "<b>User Info</b>",
    `L ID: <code>${user.telegramId}</code>`,
    `L Username: ${username}`,
    `L Total Kait: ${user.totalKait || 0}`,
    `L Total Pengeluaran: ${formatRupiah(user.totalSpend || 0)}`,
    "",
    "<b>Configuration</b>",
    "L Payment: QRIS",
    `L Harga: ${formatRupiah(settings.pricePerAccount)} / akun`,
    `L Support: ${formatTelegramSupport(settings.support)}`,
  ].join("\n");

  if (fs.existsSync(START_LOGO_PATH)) {
    await sendPhotoFile(chatId, START_LOGO_PATH, homeText, { reply_markup: mainKeyboard() });
    return;
  }

  await sendMessage(chatId, homeText, { reply_markup: mainKeyboard() });
}

async function showStatus(chatId, from) {
  const user = upsertUser(from);
  const orders = ordersStore.read().filter((order) => order.telegramId === String(from.id));
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

function buildOrderSummary(parsed, settings) {
  const basePrice = parsed.valid.length * settings.pricePerAccount;
  return [
    "<b>Order Kait PSC</b>",
    "",
    `Total input: ${parsed.totalInput}`,
    `Valid Gsuite: ${parsed.valid.length}`,
    `Invalid: ${parsed.invalid.length}`,
    `Duplicate: ${parsed.duplicate}`,
    "",
    `Harga: ${formatRupiah(settings.pricePerAccount)} / akun`,
    `Subtotal: <b>${formatRupiah(basePrice)}</b>`,
    "Total final dibuat setelah QRIS agar bisa diberi kode unik.",
  ].join("\n");
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

async function handleParsedKait(chatId, parsed) {
  const settings = settingsStore.read();
  if (settings.paused) {
    await sendMessage(chatId, "Bot sedang pause. Coba lagi nanti.");
    return;
  }
  if (parsed.valid.length < settings.minAccounts) {
    await sendMessage(chatId, `Minimal ${settings.minAccounts} akun valid. Akun valid kamu: ${parsed.valid.length}.`);
    return;
  }

  sessions.set(String(chatId), { mode: "confirm_kait", parsed });
  await sendMessage(chatId, buildOrderSummary(parsed, settings), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Buat QRIS", callback_data: "confirm_kait" }],
        [{ text: "Batal", callback_data: "cancel_session" }],
      ],
    },
  });
}

async function createOrderFromSession(chatId, from) {
  const session = sessions.get(String(chatId));
  if (!session || session.mode !== "confirm_kait") {
    await sendMessage(chatId, "Tidak ada draft order aktif.");
    return;
  }

  const settings = settingsStore.read();
  const parsed = session.parsed;
  const orderId = Date.now();
  const orderPath = path.join(ORDER_DIR, String(orderId));
  fs.mkdirSync(orderPath, { recursive: true });
  fs.writeFileSync(path.join(orderPath, "input.txt"), parsed.convertedText);
  fs.writeFileSync(
    path.join(orderPath, "invalid.txt"),
    parsed.invalid.map((item) => `${item.raw} # ${item.reason}`).join("\n")
  );

  const basePrice = parsed.valid.length * settings.pricePerAccount;
  const uniqueCode = getUniquePaymentCode(orderId, settings);
  const totalPrice = basePrice + uniqueCode;
  let invoice;
  try {
    invoice = await createQrisInvoice({ orderId, amount: totalPrice });
  } catch (error) {
    await sendMessage(chatId, `Gagal membuat QRIS: ${error.message}`);
    return;
  }
  const now = new Date().toISOString();
  const order = {
    id: orderId,
    telegramId: String(from.id),
    username: from.username || "",
    status: "WAITING_PAYMENT",
    totalInput: parsed.totalInput,
    totalAccounts: parsed.valid.length,
    invalidAccounts: parsed.invalid.length,
    duplicateAccounts: parsed.duplicate,
    pricePerAccount: settings.pricePerAccount,
    basePrice,
    uniqueCode,
    totalPrice,
    successCount: 0,
    failedCount: 0,
    payment: { ...invoice, orderId, amount: totalPrice, status: "PENDING" },
    orderPath,
    createdAt: now,
    updatedAt: now,
  };

  ordersStore.update((orders) => {
    orders.push(order);
    return orders;
  });
  log(`created order #${order.id} user=@${order.username || "-"} accounts=${order.totalAccounts} total=${order.totalPrice}`);
  sessions.delete(String(chatId));

  const lines = [
    `<b>QRIS Order #${orderId}</b>`,
    "",
    `Total akun: ${order.totalAccounts}`,
    `Subtotal: ${formatRupiah(basePrice)}`,
    uniqueCode ? `Kode unik: ${formatRupiah(uniqueCode)}` : "",
    `Total bayar: <b>${formatRupiah(totalPrice)}</b>`,
    "",
    invoice.provider === "manual"
      ? invoice.qrText
      : "Scan QRIS untuk menyelesaikan pembayaran.",
  ];

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
      ordersStore.update((orders) =>
        orders.map((item) =>
          item.id === orderId
            ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
            : item
        )
      );
      return;
    } catch (error) {
      const sent = await sendMessage(chatId, `${lines.join("\n")}\n\nQR image gagal dibuat, QRIS payload:\n<code>${invoice.qrText}</code>`, {
        reply_markup: replyMarkup,
      });
      ordersStore.update((orders) =>
        orders.map((item) =>
          item.id === orderId
            ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
            : item
        )
      );
      return;
    }
  }

  const sent = await sendMessage(chatId, lines.join("\n"), { reply_markup: replyMarkup });
  ordersStore.update((orders) =>
    orders.map((item) =>
      item.id === orderId
        ? { ...item, paymentMessageId: sent.message_id, paymentChatId: String(chatId) }
        : item
    )
  );
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
  const allOrders = ordersStore.read();
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

  await sendMessage(
    chatId,
    [
      "<b>Total Antrian</b>",
      `Total akun ngait: <b>${totalQueueAccounts}</b>`,
      `Total order aktif: ${totalQueueOrders}`,
      "",
      "<b>Antrian Kamu</b>",
      orders.length
        ? orders
            .map((order, index) => {
              const processedCount = order.status === "DONE"
                ? Number(order.successCount || 0)
                : Number(order.verifiedCount || order.successCount || 0);
              return `${index + 1}. ${order.status} ${processedCount}/${order.totalAccounts}\nID: <code>${order.id}</code>`;
            })
            .join("\n\n")
        : "Belum ada order paid/proses.",
    ].join("\n")
  );
}

async function markOrderPaid(orderId) {
  let updatedOrder = null;
  ordersStore.update((current) =>
    current.map((order) => {
      if (String(order.id) !== String(orderId) || order.status !== "WAITING_PAYMENT") return order;
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
  const orders = ordersStore.read();
  target = orders.find((order) => String(order.id) === String(orderId));
  if (!target) {
    await sendMessage(chatId, "Order tidak ditemukan.");
    return;
  }

  const status = await checkPaymentStatus(target.payment);
  if (status === "PAID") {
    const paidOrder = await markOrderPaid(orderId);
    const queueInfo = paidOrder ? getQueueInfo(paidOrder.id) : null;
    const queueText = queueInfo
      ? `\nAkun di depan: ${queueInfo.accountsBefore}\nTotal akun aktif: ${queueInfo.totalActiveAccounts}\nEstimasi mulai: ${formatDuration(queueInfo.etaMs)}`
      : "";
    await sendMessage(chatId, `Pembayaran order #${orderId} diterima. Order masuk antrian.${queueText}`);
  } else {
    await sendMessage(chatId, `Status pembayaran order #${orderId}: ${status}.`);
  }
}

async function cancelOrder(chatId, orderId) {
  let cancelledOrder = null;
  ordersStore.update((orders) =>
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
    const orders = ordersStore
      .read()
      .filter((order) => order.status === "WAITING_PAYMENT")
      .slice(0, 10);

    for (const order of orders) {
      try {
        const status = await checkPaymentStatus(order.payment);
        if (status !== "PAID") continue;

        const paidOrder = await markOrderPaid(order.id);
        if (paidOrder) {
          const queueInfo = getQueueInfo(paidOrder.id);
          const queueText = queueInfo
            ? `\nAkun di depan: ${queueInfo.accountsBefore}\nTotal akun aktif: ${queueInfo.totalActiveAccounts}\nEstimasi mulai: ${formatDuration(queueInfo.etaMs)}`
            : "";
          await sendMessage(
            paidOrder.telegramId,
            `Pembayaran order #${paidOrder.id} diterima otomatis. Order masuk antrian.${queueText}`
          );
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
    const settings = settingsStore.read();
    const stats = botStats();
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
        "/orders",
        "/paid ORDER_ID",
        "/broadcast pesan",
        "/pause",
        "/resume",
      ].join("\n")
    );
    return true;
  }

  if (command === "/voucher") {
    await sendMessage(chatId, "Voucher belum diaktifkan untuk bot PSC ini.");
    return true;
  }

  if (command === "/setharga") {
    const price = Number(args[0]);
    if (!Number.isFinite(price) || price <= 0) {
      await sendMessage(chatId, "Format: /setharga 2000");
      return true;
    }
    settingsStore.update((settings) => ({ ...settings, pricePerAccount: price }));
    await sendMessage(chatId, `Harga diubah menjadi ${formatRupiah(price)} / akun.`);
    return true;
  }

  if (command === "/setmin") {
    const minAccounts = Number(args[0]);
    if (!Number.isInteger(minAccounts) || minAccounts <= 0) {
      await sendMessage(chatId, "Format: /setmin 10");
      return true;
    }
    settingsStore.update((settings) => ({ ...settings, minAccounts }));
    await sendMessage(chatId, `Minimal order diubah menjadi ${minAccounts} akun.`);
    return true;
  }

  if (command === "/orders") {
    const orders = ordersStore.read().slice(-20).reverse();
    await sendMessage(
      chatId,
      orders.length
        ? orders.map((order) => {
            const queueInfo = getQueueInfo(order.id);
            const queueText = queueInfo ? ` depan ${queueInfo.accountsBefore} aktif ${queueInfo.totalActiveAccounts} est ${formatDuration(queueInfo.etaMs)}` : "";
            return `#${order.id} @${order.username || "-"} ${order.status} ${order.successCount || 0}/${order.totalAccounts} ${formatRupiah(order.totalPrice)}${queueText}`;
          }).join("\n")
        : "Belum ada order."
    );
    return true;
  }

  if (command === "/paid") {
    const orderId = args[0];
    ordersStore.update((orders) =>
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
    await sendMessage(chatId, `Order #${orderId} ditandai paid dan masuk antrian.`);
    return true;
  }

  if (command === "/broadcast") {
    const message = args.join(" ").trim();
    if (!message) {
      await sendMessage(chatId, "Format: /broadcast pesan");
      return true;
    }
    const users = usersStore.read();
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
    settingsStore.update((settings) => ({ ...settings, paused }));
    await sendMessage(chatId, paused ? "Bot dipause." : "Bot aktif kembali.");
    return true;
  }

  return false;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || message.chat;
  upsertUser(from);

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
    await sendMessage(
      chatId,
      [
        "<b>Format: email|password</b>",
        `Min: ${settingsStore.read().minAccounts} akun`,
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

  if (data === "confirm_kait") return createOrderFromSession(chatId, from);
  if (data === "cancel_session") {
    sessions.delete(String(chatId));
    await sendMessage(chatId, "Dibatalkan.");
    return;
  }
  if (data === "queue") return showQueue(chatId, from.id);
  if (data === "price_info") {
    const settings = settingsStore.read();
    await sendMessage(chatId, `Harga Kait PSC: ${formatRupiah(settings.pricePerAccount)} / akun.`);
    return;
  }
  if (data === "help") {
    await sendMessage(chatId, `Support: ${formatTelegramSupport(settingsStore.read().support)}`);
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

registerBotCommands()
  .then(() => log("bot commands registered"))
  .catch((error) => console.error(`[bot] failed to register commands: ${error.message}`));

console.log("Telegram bot started.");
setInterval(autoCheckPayments, Number(process.env.PAYMENT_CHECK_INTERVAL_MS || 15000));
poll();

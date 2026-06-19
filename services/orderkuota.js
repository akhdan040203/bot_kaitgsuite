const axios = require("axios");
const { getMutasiQris } = require("./orkut-mutasi");
let mutasiCache = null;
let mutasiCacheAt = 0;

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tag(id, value) {
  const text = String(value);
  return `${id}${text.length.toString().padStart(2, "0")}${text}`;
}

function parseTlv(payload) {
  const tags = [];
  let index = 0;

  while (index + 4 <= payload.length) {
    const id = payload.slice(index, index + 2);
    const lengthText = payload.slice(index + 2, index + 4);
    const length = Number(lengthText);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lengthText) || !Number.isFinite(length)) {
      throw new Error("Format TLV QRIS tidak valid");
    }

    const valueStart = index + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > payload.length) {
      throw new Error("Panjang tag QRIS tidak valid");
    }

    tags.push({ id, value: payload.slice(valueStart, valueEnd) });
    index = valueEnd;
  }

  if (index !== payload.length) {
    throw new Error("Payload QRIS memiliki sisa data tidak valid");
  }

  return tags;
}

function buildTlv(tags) {
  return tags.map((item) => tag(item.id, item.value)).join("");
}

function generateDynamicQris(staticQris, amount) {
  if (!staticQris) return "";

  const qris = String(staticQris).trim();
  if (!qris.startsWith("000201") || !qris.includes("5802ID")) {
    throw new Error("QRCODE_TEXT tidak terlihat seperti payload QRIS valid");
  }

  const amountValue = String(Math.round(Number(amount)));
  if (!amountValue || amountValue === "NaN") {
    throw new Error("Nominal QRIS tidak valid");
  }

  const qrisWithoutCrcValue = qris.slice(0, -4);
  const dynamicQris = qrisWithoutCrcValue.replace("010211", "010212");
  const parts = dynamicQris.split("5802ID");
  if (parts.length < 2) {
    throw new Error("QRCODE_TEXT tidak memiliki tag negara QRIS 5802ID");
  }

  const amountTag = `54${(`0${amountValue.length}`).slice(-2)}${amountValue}5802ID`;
  const withoutCrc = `${parts[0]}${amountTag}${parts.slice(1).join("5802ID")}`;
  return `${withoutCrc}${crc16(withoutCrc)}`;
}

function readPath(obj, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), obj);
}

function normalizeMutasiResponse(data) {
  const rows =
    readPath(data, "data") ||
    readPath(data, "result") ||
    readPath(data, "mutasi") ||
    readPath(data, "transactions") ||
    [];

  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((item) => {
      const amount = item.amount || item.nominal || item.kredit || item.total || item.value;
      const date = item.date || item.tanggal || item.created_at || item.datetime || item.waktu;
      return {
        amount: Number(String(amount || "").replace(/[^\d]/g, "")),
        date: date ? String(date) : "",
        raw: item,
      };
    })
    .filter((item) => Number.isFinite(item.amount) && item.amount > 0);
}

async function getOrkutMutasi() {
  const cacheTtl = Number(process.env.ORKUT_MUTASI_CACHE_MS || 5000);
  if (mutasiCache && Date.now() - mutasiCacheAt < cacheTtl) return mutasiCache;

  const username = process.env.USERNAME_ORKUT;
  const token = process.env.AUTH_TOKEN;

  if (!username || !token) {
    return { status: false, data: [], error: "Missing USERNAME_ORKUT/AUTH_TOKEN" };
  }

  // Cek beberapa page mutasi (default 2) -> lebih tahan kalau transaksi pembayaran sudah
  // tergeser keluar page 1 (akun ramai / deteksi telat saat jaringan ngadat).
  const pages = Math.max(1, Number(process.env.ORKUT_MUTASI_PAGES || 2));
  let anyStatus = false;
  let lastRaw = null;
  const merged = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page++) {
    let response;
    try {
      response = await getMutasiQris({ username, authToken: token, type: "", page });
    } catch (_) {
      break; // jaringan error -> pakai apa yang sudah didapat
    }
    lastRaw = response;
    if (response && response.status) {
      anyStatus = true;
      for (const item of normalizeMutasiResponse(response)) {
        const key = `${item.raw?.issuer_reff || ""}|${item.amount}|${item.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    } else {
      break; // page gagal -> berhenti (jangan buang waktu)
    }
  }

  mutasiCache = {
    status: anyStatus,
    data: merged,
    raw: lastRaw,
  };
  mutasiCacheAt = Date.now();
  return mutasiCache;
}

// ===== Integrasi api-orkut-gateway (aktif kalau ORKUT_GATEWAY_URL di-set) =====
function gatewayBaseUrl() {
  return String(process.env.ORKUT_GATEWAY_URL || "").replace(/\/+$/, "");
}

async function createViaGateway({ amount }) {
  const base = gatewayBaseUrl();
  const key = process.env.ORKUT_GATEWAY_API_KEY || "";
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-KEY"] = key;
  const resp = await axios.post(
    `${base}/api/transactions`,
    { amount: Number(amount) },
    { headers, timeout: 30000, validateStatus: () => true }
  );
  const data = resp.data || {};
  // 202 = WAITING (downtime harian / pool fee penuh) -> minta retry.
  if (resp.status === 202 || data.state === "WAITING") {
    const err = new Error(data.message || "Payment gateway sedang sibuk/maintenance, coba lagi sebentar.");
    err.code = "GATEWAY_WAITING";
    err.retryAfterMs = Number(data.retry_after_ms) || 2000;
    throw err;
  }
  if (resp.status !== 200 || !data.status || !data.data) {
    throw new Error(data.message || `Gateway error (HTTP ${resp.status})`);
  }
  const t = data.data;
  return {
    provider: "orkut-gateway",
    reference: t.id, // TRX-xxxx -> kunci cek status
    amount: t.amount, // base + fee (total yang dibayar user)
    fee: t.fee,
    qrText: t.qr_string,
    qrImage: t.qr_image,
    raw: t,
  };
}

async function createQrisInvoice({ orderId, amount }) {
  // Pakai gateway kalau di-set (cara baru, cek pembayaran by-ID).
  if (gatewayBaseUrl()) {
    return createViaGateway({ amount });
  }

  const url = process.env.ORDERKUOTA_CREATE_URL;
  const token = process.env.ORDERKUOTA_API_TOKEN || process.env.APIKEY_ORKUT || process.env.ORKUT_KEY || process.env.AUTH_TOKEN;
  const legacyQrisText =
    process.env.CODE_TEXT ||
    process.env.QRCODE_TEXT ||
    process.env.QRIS_CODE_TEXT ||
    process.env.ORDERKUOTA_CODE_TEXT;

  if (!url && legacyQrisText) {
    return {
      provider: "orderkuota-qris-dynamic",
      reference: `ORKUT-${orderId}`,
      qrText: generateDynamicQris(legacyQrisText, amount),
      raw: {
        source: "CODE_TEXT",
        merchantKeyConfigured: Boolean(process.env.MERCHANT_KEY),
        orkutKeyConfigured: Boolean(process.env.ORKUT_KEY || process.env.APIKEY_ORKUT),
        usernameConfigured: Boolean(process.env.USERNAME_ORKUT),
        authTokenConfigured: Boolean(process.env.AUTH_TOKEN),
      },
    };
  }

  if (!url) {
    return {
      provider: "manual",
      reference: `MANUAL-${orderId}`,
      qrText: `Manual payment mode. Admin bisa pakai /paid ${orderId} setelah pembayaran diterima.`,
      raw: null,
    };
  }

  const payload = {
    order_id: String(orderId),
    amount,
    note: `Kait PSC #${orderId}`,
  };

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const { data } = await axios.post(url, payload, { headers, timeout: 30000 });

  return {
    provider: "orderkuota",
    reference: readPath(data, process.env.ORDERKUOTA_REF_PATH || "data.reference") || String(orderId),
    qrText: readPath(data, process.env.ORDERKUOTA_QRIS_PATH || "data.qris") || readPath(data, "qris") || "",
    qrImage: readPath(data, process.env.ORDERKUOTA_QRIS_IMAGE_PATH || "data.qr_image") || "",
    raw: data,
  };
}

async function checkPaymentStatus(payment) {
  // Order yang dibuat lewat gateway -> cek by TRX-id (GET, tanpa API key).
  if (payment && payment.provider === "orkut-gateway") {
    const base = gatewayBaseUrl();
    if (!base || !payment.reference) return "PENDING";
    const resp = await axios.get(
      `${base}/api/transactions/${encodeURIComponent(payment.reference)}`,
      { timeout: 30000, validateStatus: () => true }
    );
    const data = resp.data || {};
    if (resp.status !== 200 || !data.data) return "PENDING";
    const st = String(data.data.status || "").toUpperCase();
    if (st === "PAID") return "PAID";
    if (st === "EXPIRED" || st === "CANCELLED") return "EXPIRED";
    return "PENDING";
  }

  const url = process.env.ORDERKUOTA_STATUS_URL;
  const token = process.env.ORDERKUOTA_API_TOKEN || process.env.APIKEY_ORKUT || process.env.ORKUT_KEY || process.env.AUTH_TOKEN;

  if (!url && payment.provider !== "manual") {
    const response = await getOrkutMutasi();
    if (!response.status) return "PENDING";

    const targetAmount = Number(payment.amount);
    const paid = response.data.some((item) => item.amount === targetAmount);
    return paid ? "PAID" : "PENDING";
  }

  if (!url || payment.provider === "manual") return "PENDING";

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const { data } = await axios.get(url, {
    headers,
    params: { reference: payment.reference, order_id: payment.orderId },
    timeout: 30000,
  });

  const status = String(readPath(data, process.env.ORDERKUOTA_STATUS_PATH || "data.status") || "").toUpperCase();
  if (["PAID", "SUCCESS", "SETTLED", "LUNAS"].includes(status)) return "PAID";
  if (["EXPIRED", "CANCELLED", "CANCELED"].includes(status)) return "EXPIRED";
  return "PENDING";
}

module.exports = { createQrisInvoice, checkPaymentStatus, getOrkutMutasi };

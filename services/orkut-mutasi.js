const axios = require("axios");
const crypto = require("crypto");

function formatDate(date) {
  if (!date) return "";
  const [tgl, jam = "00:00"] = String(date).split(" ");
  const [d, m, y] = (tgl || "").split("/");
  return y && m && d ? `${y}-${m}-${d} ${jam}:00` : String(date);
}

function stringifyPayload(payload, encode = true) {
  return Object.entries(payload)
    .map(([key, value]) => {
      const left = encode ? encodeURIComponent(key) : key;
      const right = encode ? encodeURIComponent(value ?? "") : String(value ?? "");
      return `${left}=${right}`;
    })
    .join("&");
}

function sha512Hex(str) {
  return crypto.createHash("sha512").update(str, "utf8").digest("hex");
}

function hmac512Hex(key, str) {
  return crypto.createHmac("sha512", key).update(str, "utf8").digest("hex");
}

async function getMutasiQris({ username, authToken, type = "", page = 1 }) {
  const apiUrl = "https://app.orderkuota.com/api/v2/qris/mutasi";
  const accountId = String(authToken || "").split(":")[0] || "";
  const appRegId = process.env.ORDERKUOTA_APP_REG_ID;
  const phoneUuid = process.env.ORDERKUOTA_PHONE_UUID;
  const phoneModel = process.env.ORDERKUOTA_PHONE_MODEL;
  const androidVersion = process.env.ORDERKUOTA_ANDROID_VERSION;
  const appVersionCode = process.env.ORDERKUOTA_APP_VERSION_CODE;
  const appVersionName = process.env.ORDERKUOTA_APP_VERSION_NAME;
  const uiMode = process.env.ORDERKUOTA_UI_MODE;

  const payloadObject = {
    app_reg_id: appRegId,
    phone_uuid: phoneUuid,
    phone_model: phoneModel,
    "requests[qris_history][keterangan]": "",
    "requests[qris_history][jumlah]": "",
    request_time: Date.now(),
    phone_android_version: androidVersion,
    app_version_code: appVersionCode,
    auth_username: username,
    "requests[qris_history][page]": page,
    auth_token: authToken,
    app_version_name: appVersionName,
    ui_mode: uiMode,
    "requests[qris_history][dari_tanggal]": "",
    "requests[0]": "account",
    "requests[qris_history][ke_tanggal]": "",
  };

  if (type) payloadObject["requests[qris_history][jenis]"] = type;

  const payload = stringifyPayload(payloadObject, true);
  const payloadUnencoded = stringifyPayload(payloadObject, false);
  const timestamp = String(payloadObject.request_time);
  const method = "POST";
  const pathOnly = `/api/v2/qris/mutasi/${accountId}`;
  const fullUrl = `${apiUrl}/${accountId}`;
  const signingSecret = process.env.ORDERKUOTA_SIGNING_SECRET || "";
  const strategies = process.env.ORDERKUOTA_SIGNATURE_MODE
    ? [process.env.ORDERKUOTA_SIGNATURE_MODE]
    : [
        "token_ts_body",
        "ts_body",
        "body_ts",
        "acct_ts_body",
        "appReg_ts_body",
        "token_ts_path_body",
        "token_ts_url_body",
        "hmac_token_ts_body",
        "hmac_ts_body_token",
        "hmac_acct_ts_body",
        "hmac_appReg_ts_body",
        "hmac_token_path_ts_body",
        "hmac_token_url_ts_body",
      ];

  function computeSignature(mode, secret = signingSecret) {
    switch (mode) {
      case "body_ts": return sha512Hex(`${payload}${timestamp}`);
      case "ts_body": return sha512Hex(`${timestamp}${payload}`);
      case "token_ts_body": return sha512Hex(`${authToken}${timestamp}${payload}`);
      case "acct_ts_body": return sha512Hex(`${accountId}${timestamp}${payload}`);
      case "appReg_ts_body": return sha512Hex(`${appRegId}${timestamp}${payload}`);
      case "token_ts_path_body": return sha512Hex(`${authToken}${timestamp}${pathOnly}${payload}`);
      case "token_ts_url_body": return sha512Hex(`${authToken}${timestamp}${fullUrl}${payload}`);
      case "token_ts_bodyUn": return sha512Hex(`${authToken}${timestamp}${payloadUnencoded}`);
      case "token_ts_method_path_body": return sha512Hex(`${authToken}${timestamp}${method}${pathOnly}${payload}`);
      case "hmac_token_ts_body": return hmac512Hex(authToken, `${timestamp}${payload}`);
      case "hmac_ts_body_token": return hmac512Hex(authToken, `${timestamp}${payload}${authToken}`);
      case "hmac_acct_ts_body": return hmac512Hex(accountId, `${timestamp}${payload}`);
      case "hmac_appReg_ts_body": return hmac512Hex(appRegId, `${timestamp}${payload}`);
      case "hmac_token_path_ts_body": return hmac512Hex(authToken, `${pathOnly}${timestamp}${payload}`);
      case "hmac_token_url_ts_body": return hmac512Hex(authToken, `${fullUrl}${timestamp}${payload}`);
      case "secret_ts_body": return sha512Hex(`${secret}${timestamp}${payload}`);
      case "hmac_secret_ts_body": return hmac512Hex(secret, `${timestamp}${payload}`);
      default: return sha512Hex(`${authToken}${timestamp}${payload}`);
    }
  }

  const headers = {
    Host: "app.orderkuota.com",
    "User-Agent": "okhttp/4.12.0",
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept-Encoding": "gzip",
    Connection: "Keep-Alive",
  };

  let lastData = null;
  let lastStatus = 0;

  for (const mode of strategies) {
    const signature = computeSignature(mode);
    const { data, status } = await axios.post(fullUrl, payload, {
      headers: { ...headers, signature, timestamp },
      timeout: 15000,
      validateStatus: () => true,
    });

    lastData = data;
    lastStatus = status;

    const success = Boolean(data && (data.qris_history?.success === true || data.success === true || data.status === true));
    const results = data?.qris_history?.results
      ?? data?.results
      ?? data?.data?.results
      ?? data?.qris_history?.data?.results
      ?? [];

    if (success && Array.isArray(results)) {
      const mapped = results
        .filter((item) => item && item.status === "IN")
        .map((item) => ({
          date: formatDate(item.tanggal),
          amount: String(item.kredit || "0").replace(/\./g, ""),
          brand_name: item.brand?.name || "",
          issuer_reff: String(item.id ?? item.issuer_reff ?? ""),
          buyer_reff: String(item.keterangan || item.buyer_reff || "").trim(),
          balance: item.saldo_akhir ? String(item.saldo_akhir).replace(/\./g, "") : "",
        }));

      return { status: true, message: "Berhasil menampilkan mutasi masuk", data: mapped };
    }
  }

  return {
    status: false,
    message: lastData?.qris_history?.message || lastData?.message || `Gagal ambil mutasi QRIS (${lastStatus})`,
    data: [],
  };
}

module.exports = { getMutasiQris };

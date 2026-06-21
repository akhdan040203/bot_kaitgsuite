require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const { MongoStore, connectMongo } = require("./lib/mongo-store");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ADMIN_IDS = String(process.env.TELEGRAM_ADMIN_IDS || process.env.WHITELIST_ID || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PYTHON_BIN = process.env.GOPAY_PYTHON_BIN || process.env.PYTHON_BIN || "python";
const GOPAY_DIR = path.join(__dirname, "autokaitgopay");
const APP_SCRIPT = path.join(GOPAY_DIR, "APP", "app.py");
const CHECKER_SCRIPT = path.join(GOPAY_DIR, "APP", "checker.py");
const BROWSERS = Math.max(1, Math.min(3, Number(process.env.GOPAY_BROWSERS || 2)));
const MAX_BATCHES = Math.max(1, Number(process.env.GOPAY_MAX_BATCHES || 3));
const POLL_MS = Number(process.env.GOPAY_WORKER_POLL_MS || 5000);
const ordersStore = new MongoStore("orders", []);
const usersStore = new MongoStore("users", {});
let lastIdleLogAt = 0;

function log(message) {
  console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] [gopay] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function orderIdValues(orderId) {
  const num = Number(orderId);
  return [...new Set([orderId, String(orderId), ...(Number.isFinite(num) ? [num] : [])])];
}

async function updateOrder(orderId, patch, statuses) {
  return ordersStore.patchItem(
    "id",
    orderIdValues(orderId),
    { ...patch, updatedAt: new Date().toISOString() },
    statuses ? { whereField: "status", whereIn: statuses } : {}
  );
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function accountKey(line) {
  return String(line || "").split("|", 1)[0].trim().toLowerCase();
}

function uniqueAccounts(lines) {
  const found = new Map();
  for (const line of lines) {
    const value = String(line || "").trim();
    const key = accountKey(value);
    if (key && !found.has(key)) found.set(key, value);
  }
  return [...found.values()];
}

function subtractAccounts(source, removed) {
  const removedKeys = new Set(removed.map(accountKey));
  return uniqueAccounts(source).filter((line) => !removedKeys.has(accountKey(line)));
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const values = uniqueAccounts(lines);
  fs.writeFileSync(filePath, values.length ? `${values.join("\n")}\n` : "");
}

async function notify(chatId, text) {
  if (!API || !chatId) return null;
  try {
    const { data } = await axios.post(`${API}/sendMessage`, { chat_id: chatId, text, parse_mode: "HTML" }, { timeout: 30000 });
    return data.result;
  } catch (error) {
    log(`notify gagal: ${error.message}`);
    return null;
  }
}

async function editNotify(chatId, messageId, text) {
  if (!API || !chatId || !messageId) return;
  try {
    await axios.post(`${API}/editMessageText`, { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }, { timeout: 30000 });
  } catch (_) {}
}

async function sendDocument(chatId, filePath, caption) {
  if (!API || !chatId || !fs.existsSync(filePath) || !readLines(filePath).length) return;
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("document", fs.createReadStream(filePath));
  try {
    await axios.post(`${API}/sendDocument`, form, { headers: form.getHeaders(), timeout: 120000 });
  } catch (error) {
    log(`kirim dokumen gagal: ${error.message}`);
  }
}

function killChildTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      require("child_process").exec(`taskkill /pid ${child.pid} /T /F`);
    } else {
      child.kill("SIGTERM");
    }
  } catch (_) {}
}

function runPython(order, label, script, args, logFile, accountCount) {
  return new Promise((resolve, reject) => {
    const fullArgs = [script, ...args];
    if (String(process.env.GOPAY_HEADLESS || "false").toLowerCase() === "true") fullArgs.push("--headless");
    fs.appendFileSync(logFile, `\n===== ${label} ${new Date().toISOString()} =====\n`);
    log(`#${order.id} ${label}: ${PYTHON_BIN} ${path.basename(script)}`);
    const child = spawn(PYTHON_BIN, fullArgs, {
      cwd: GOPAY_DIR,
      windowsHide: true,
      // Paksa UTF-8 di Windows/RDP agar logger Python yang berisi emoji tidak crash
      // dengan UnicodeEncodeError dari code page cp1252.
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    let stopped = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelPoll);
      clearTimeout(killTimer);
      callback();
    };
    const cancelPoll = setInterval(() => {
      ordersStore.read().then((orders) => {
        const current = orders.find((item) => String(item.id) === String(order.id));
        if (!current || current.status === "CANCELLED" || current.stopRequested) {
          stopped = true;
          killChildTree(child);
        }
      }).catch(() => {});
    }, Number(process.env.CANCEL_POLL_MS || 4000));
    const perAccountMs = Number(process.env.GOPAY_TIMEOUT_PER_ACCOUNT_MS || 300000);
    const timeoutMs = Math.max(Number(process.env.GOPAY_WORKER_MIN_TIMEOUT_MS || 600000), accountCount * perAccountMs);
    const killTimer = setTimeout(() => killChildTree(child), timeoutMs);
    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (stopped) return resolve({ stopped: true });
      if (code !== 0) return reject(new Error(`${path.basename(script)} exited with code ${code}`));
      resolve({ stopped: false });
    }));
  });
}

function progressText(order, round, success, total, remaining, phase) {
  const percent = Math.floor((Number(success || 0) / Math.max(1, Number(total || 0))) * 100);
  const filled = Math.floor(percent / 10);
  return [
    `🌐 <b>GoPay Order #${order.id}</b>`,
    `<code>[${"#".repeat(filled)}${"-".repeat(10 - filled)}]</code> <b>${percent}%</b>`,
    `${success}/${total} gsuite terverifikasi`,
    `Batch ${round}/${MAX_BATCHES} • ${phase} • sisa ${remaining}`,
  ].join("\n");
}

async function finalizeCancelled(order, notifyId, original, successFile, failureFile) {
  const success = readLines(successFile);
  const failed = subtractAccounts(original, success);
  writeLines(failureFile, failed);
  const applied = await updateOrder(order.id, {
    phase: "CANCELLED",
    successCount: success.length,
    failedCount: failed.length,
    remainingCount: failed.length,
    resultFile: successFile,
    gopayCancelFinalized: true,
    finishedAt: new Date().toISOString(),
  }, ["CANCELLED"]);
  if (!applied) return;
  await usersStore.update((users) => {
    const user = users[order.telegramId];
    if (user) {
      user.totalKait = Number(user.totalKait || 0) + success.length;
      if (failed.length) user.credit = Number(user.credit || 0) + failed.length;
    }
    return users;
  });
  await notify(notifyId, [
    `🛑 <b>Order GoPay #${order.id} dibatalkan</b>`,
    `Berhasil sebelum dibatalkan: ${success.length}/${original.length}`,
    `Belum berhasil: ${failed.length}`,
    failed.length ? `🎁 Refund: +${failed.length} credit akun` : "",
  ].filter(Boolean).join("\n"));
  await sendDocument(notifyId, successFile, `✅ Hasil GoPay sebelum pembatalan #${order.id}`);
  await sendDocument(notifyId, failureFile, `❌ Sisa akun GoPay dibatalkan #${order.id}`);
}

async function processOrder(order) {
  const claimed = await updateOrder(
    order.id,
    { status: "RUNNING", phase: "GOPAY_STARTING", startedAt: new Date().toISOString() },
    ["QUEUED", "PAID"]
  );
  if (!claimed) return;

  const notifyId = order.notifyTo || order.telegramId;
  const orderPath = order.orderPath;
  const originalFile = path.join(orderPath, "original-input.txt");
  const initialFile = path.join(orderPath, "input.txt");
  const successFile = path.join(orderPath, "success.txt");
  const failureFile = path.join(orderPath, "remaining-unverified.txt");
  const logFile = path.join(orderPath, "gopay-worker.log");
  fs.mkdirSync(orderPath, { recursive: true });
  if (!fs.existsSync(originalFile)) writeLines(originalFile, readLines(initialFile));
  const original = readLines(originalFile);
  let remaining = subtractAccounts(original, readLines(successFile));
  let batches = Array.isArray(order.batches) ? order.batches : [];
  const progressMessage = await notify(notifyId, progressText(order, 1, readLines(successFile).length, original.length, remaining.length, "mulai"));

  try {
    for (let round = 1; round <= MAX_BATCHES && remaining.length; round++) {
      const roundInput = path.join(orderPath, `gopay-input-batch-${round}.txt`);
      const linkedFile = path.join(orderPath, `gopay-linked-batch-${round}.txt`);
      const emptyFile = path.join(orderPath, `gopay-empty-batch-${round}.txt`);
      const appFailureFile = path.join(orderPath, `gopay-app-failed-batch-${round}.txt`);
      writeLines(roundInput, remaining);
      writeLines(linkedFile, []);
      writeLines(emptyFile, []);
      writeLines(appFailureFile, []);
      const beforeSuccess = readLines(successFile).length;
      batches = [...batches.filter((item) => Number(item.round) !== round), { round, total: remaining.length, success: 0, status: "LINKING" }];
      await updateOrder(order.id, { phase: "GOPAY_LINKING", retryRound: round, remainingCount: remaining.length, batches });
      await editNotify(notifyId, progressMessage?.message_id, progressText(order, round, beforeSuccess, original.length, remaining.length, "mengaitkan"));

      const linked = await runPython(order, `BATCH ${round} LINK`, APP_SCRIPT, [
        "--input-file", roundInput,
        "--success-file", linkedFile,
        "--failure-file", appFailureFile,
        "--browsers", String(BROWSERS),
      ], logFile, remaining.length);
      if (linked.stopped) {
        await finalizeCancelled(order, notifyId, original, successFile, failureFile);
        return;
      }

      const candidates = readLines(linkedFile);
      if (candidates.length) {
        await updateOrder(order.id, { phase: "GOPAY_CHECKING" });
        await editNotify(notifyId, progressMessage?.message_id, progressText(order, round, beforeSuccess, original.length, remaining.length, "checker"));
        const checked = await runPython(order, `BATCH ${round} CHECK`, CHECKER_SCRIPT, [
          "--input-file", linkedFile,
          "--checked-file", successFile,
          "--empty-file", emptyFile,
          "--browsers", String(BROWSERS),
        ], logFile, candidates.length);
        if (checked.stopped) {
          await finalizeCancelled(order, notifyId, original, successFile, failureFile);
          return;
        }
      }

      const allSuccess = readLines(successFile);
      remaining = subtractAccounts([
        ...readLines(roundInput),
        ...readLines(emptyFile),
        ...readLines(linkedFile),
      ], allSuccess);
      const gained = Math.max(0, allSuccess.length - beforeSuccess);
      batches = batches.map((item) => Number(item.round) === round ? { ...item, success: gained, status: "DONE" } : item);
      await updateOrder(order.id, {
        phase: round < MAX_BATCHES && remaining.length ? "GOPAY_RETRY" : "GOPAY_FINALIZING",
        successCount: allSuccess.length,
        remainingCount: remaining.length,
        batches,
      });
      await editNotify(notifyId, progressMessage?.message_id, progressText(order, round, allSuccess.length, original.length, remaining.length, remaining.length ? "siap retry" : "selesai"));
    }

    writeLines(failureFile, remaining);
    const successCount = readLines(successFile).length;
    const failedCount = remaining.length;
    const finalized = await updateOrder(order.id, {
      status: "DONE",
      phase: "DONE",
      successCount,
      failedCount,
      remainingCount: failedCount,
      resultFile: successFile,
      finishedAt: new Date().toISOString(),
      gopayFinalized: true,
    }, ["RUNNING"]);
    if (!finalized) return;

    await usersStore.update((users) => {
      const user = users[order.telegramId];
      if (user) {
        user.totalKait = Number(user.totalKait || 0) + successCount;
        user.totalSpend = Number(user.totalSpend || 0) + Number(order.totalPrice || 0);
        if (failedCount > 0) user.credit = Number(user.credit || 0) + failedCount;
      }
      return users;
    });

    await editNotify(notifyId, progressMessage?.message_id, [
      `✅ <b>Order GoPay #${order.id} selesai</b>`,
      `Berhasil terverifikasi: ${successCount}/${original.length}`,
      `Gagal setelah ${MAX_BATCHES} batch: ${failedCount}`,
      failedCount ? `🎁 Refund: +${failedCount} credit akun` : "Semua akun berhasil.",
    ].join("\n"));
    await sendDocument(notifyId, successFile, `✅ Hasil GoPay berhasil order #${order.id}`);
    await sendDocument(notifyId, failureFile, `❌ GSuite gagal GoPay order #${order.id}`);
    for (const adminId of ADMIN_IDS) {
      if (String(adminId) === String(notifyId)) continue;
      await notify(adminId, `[ADMIN] GoPay #${order.id} selesai • berhasil ${successCount}/${original.length} • gagal ${failedCount}`);
      await sendDocument(adminId, successFile, `[ADMIN] Hasil GoPay #${order.id}`);
      await sendDocument(adminId, failureFile, `[ADMIN] Gagal GoPay #${order.id}`);
    }
    log(`#${order.id} DONE success=${successCount} failed=${failedCount}`);
  } catch (error) {
    log(`#${order.id} FAILED: ${error.message}`);
    await updateOrder(order.id, { status: "FAILED", error: error.message, finishedAt: new Date().toISOString() });
    await notify(notifyId, `⚠️ Order GoPay #${order.id} gagal: ${error.message}`);
  }
}

async function loop() {
  if (!fs.existsSync(APP_SCRIPT) || !fs.existsSync(CHECKER_SCRIPT)) {
    throw new Error("Script GoPay app.py/checker.py tidak ditemukan");
  }
  await connectMongo();
  let recovered = 0;
  await ordersStore.update((orders) => orders.map((order) => {
    if (order.service === "GOPAY" && order.status === "RUNNING") {
      recovered++;
      return { ...order, status: "QUEUED" };
    }
    return order;
  }));
  if (recovered) log(`recovery ${recovered} order GoPay ke QUEUED`);
  log(`worker started: ${BROWSERS} browser, ${MAX_BATCHES} batch`);
  while (true) {
    try {
      const orders = await ordersStore.read();
      const candidates = orders
        .filter((order) => order.service === "GOPAY" && ["QUEUED", "PAID"].includes(order.status))
        .sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || Number(a.id) - Number(b.id));
      if (candidates.length) {
        await processOrder(candidates[0]);
      } else {
        if (Date.now() - lastIdleLogAt > 30000) {
          log("idle, waiting for GoPay orders...");
          lastIdleLogAt = Date.now();
        }
        await sleep(POLL_MS);
      }
    } catch (error) {
      log(`loop error: ${error.message}`);
      await sleep(POLL_MS);
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});

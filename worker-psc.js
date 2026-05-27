require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const { JsonStore } = require("./lib/json-store");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const DATA_DIR = path.join(__dirname, "data", "bot");
const ordersStore = new JsonStore(path.join(DATA_DIR, "orders.json"), []);
const usersStore = new JsonStore(path.join(DATA_DIR, "users.json"), {});
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);
let lastIdleLogAt = 0;

function log(message) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] [worker] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notify(chatId, text) {
  if (!API || !chatId) return;
  try {
    const { data } = await axios.post(
      `${API}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML" },
      { timeout: 30000 }
    );
    return data.result;
  } catch (error) {
    console.error(`[notify] ${error.message}`);
  }
}

async function editNotify(chatId, messageId, text) {
  if (!API || !chatId || !messageId) return;
  try {
    const { data } = await axios.post(
      `${API}/editMessageText`,
      { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" },
      { timeout: 30000 }
    );
    return data.result;
  } catch (error) {
    if (!String(error.message).includes("400")) {
      console.error(`[editNotify] ${error.message}`);
    }
  }
}

async function sendDocument(chatId, filePath, caption) {
  if (!API || !chatId || !fs.existsSync(filePath)) return;
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption);
  form.append("document", fs.createReadStream(filePath));
  try {
    await axios.post(`${API}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: 120000,
    });
  } catch (error) {
    console.error(`[document] ${error.message}`);
  }
}

function updateOrder(orderId, patch) {
  ordersStore.update((orders) =>
    orders.map((order) =>
      String(order.id) === String(orderId)
        ? { ...order, ...patch, updatedAt: new Date().toISOString() }
        : order
    )
  );
}

function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueLines(lines) {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const cleaned = uniqueLines(lines);
  fs.writeFileSync(filePath, cleaned.length ? `${cleaned.join("\n")}\n` : "");
}

function subtractLines(sourceLines, removeLines) {
  const removeSet = new Set(removeLines.map((line) => line.trim().toLowerCase()));
  return uniqueLines(sourceLines).filter((line) => !removeSet.has(line.toLowerCase()));
}

function progressBar(done, total) {
  const safeTotal = Math.max(1, Number(total || 0));
  const safeDone = Math.min(safeTotal, Math.max(0, Number(done || 0)));
  const percent = Math.floor((safeDone / safeTotal) * 100);
  const filled = Math.floor(percent / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${percent}%`;
}

function renderProgress(order, phase, done, total, detail = "") {
  return [
    `<b>Progress Order #${order.id}</b>`,
    "",
    progressBar(done, total),
    `${phase}: ${done}/${total}`,
    detail,
  ].filter(Boolean).join("\n");
}

function runPscWorker(order, attempt) {
  return new Promise((resolve, reject) => {
    const inputFile = path.join(order.orderPath, "input.txt");
    const resultFile = path.join(order.orderPath, "success.txt");
    const logFile = path.join(order.orderPath, "worker.log");
    fs.mkdirSync(order.orderPath, { recursive: true });
    fs.appendFileSync(logFile, `\n===== ATTEMPT ${attempt} ${new Date().toISOString()} =====\n`);

    const args = [
      "mumu-psc.py",
      "--input-file",
      inputFile,
      "--result-file",
      resultFile,
    ];

    if (process.env.PSC_EMAIL) args.push("--psc-email", process.env.PSC_EMAIL);
    if (process.env.PSC_PASS) args.push("--psc-pass", process.env.PSC_PASS);

    log(`attempt ${attempt}: spawning: ${PYTHON_BIN} ${args.join(" ")}`);
    const child = spawn(PYTHON_BIN, args, { cwd: __dirname, windowsHide: true });

    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      log(`spawn error: ${error.message}`);
      reject(error);
    });
    child.on("close", (code) => {
      log(`attempt ${attempt}: mumu-psc.py exited with code ${code}`);
      if (code !== 0) {
        reject(new Error(`mumu-psc.py exited with code ${code}`));
        return;
      }
      resolve({ resultFile, logFile });
    });
  });
}

async function processOrder(order) {
  log(`picked order #${order.id} user=@${order.username || "-"} accounts=${order.totalAccounts}`);
  updateOrder(order.id, { status: "RUNNING", startedAt: new Date().toISOString() });
  log(`order #${order.id} status RUNNING`);
  const initialProgress = await notify(
    order.telegramId,
    renderProgress(order, "Menunggu worker", 0, order.totalAccounts, "Order mulai diproses.")
  );
  const progressMessageId = initialProgress?.message_id;

  try {
    const maxAttempts = Math.max(1, Number(process.env.PSC_MAX_RETRY_PASSES || 3));
    const maxRetryRounds = Math.max(1, Number(process.env.PSC_VERIFY_MAX_ROUNDS || 3));
    const remainingInputFile = path.join(order.orderPath, "input.txt");
    const originalInputFile = path.join(order.orderPath, "original-input.txt");
    let resultFile = path.join(order.orderPath, "success.txt");
    let logFile = path.join(order.orderPath, "worker.log");

    if (!fs.existsSync(originalInputFile)) {
      writeLines(originalInputFile, readLines(remainingInputFile));
    }

    const originalAccounts = readLines(originalInputFile);
    const totalAccounts = originalAccounts.length || Number(order.totalAccounts || 0);

    for (let round = 1; round <= maxRetryRounds; round++) {
      const successBeforeRound = countLines(resultFile);
      const accountsToLink = subtractLines(originalAccounts, readLines(resultFile));

      if (accountsToLink.length === 0) break;

      writeLines(remainingInputFile, accountsToLink);
      updateOrder(order.id, {
        phase: round === 1 ? "LINKING" : "RETRY_LINKING",
        retryRound: round,
        remainingCount: accountsToLink.length,
      });
      log(
        `order #${order.id} retry round ${round}/${maxRetryRounds}: linking ${accountsToLink.length} account(s), success=${successBeforeRound}/${totalAccounts}`
      );
      await editNotify(
        order.telegramId,
        progressMessageId,
        renderProgress(
          order,
          round === 1 ? "Ngait akun" : "Retry ngait akun",
          successBeforeRound,
          totalAccounts,
          `Ronde ${round}/${maxRetryRounds}. Sisa akun: ${accountsToLink.length}`
        )
      );

      let lastRemainingCount = countLines(remainingInputFile);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (lastRemainingCount === 0) break;

        ({ resultFile, logFile } = await runPscWorker(order, `${round}.${attempt}`));

        const successCountAfterAttempt = countLines(resultFile);
        const remainingCountAfterAttempt = countLines(remainingInputFile);
        log(
          `order #${order.id} round ${round} attempt ${attempt}/${maxAttempts} linked=${successCountAfterAttempt} remaining=${remainingCountAfterAttempt}`
        );
        const linkedThisRound = Math.max(0, accountsToLink.length - remainingCountAfterAttempt);
        const ngaitProgress = Math.min(totalAccounts, successBeforeRound + linkedThisRound);
        await editNotify(
          order.telegramId,
          progressMessageId,
          renderProgress(
            order,
            "Ngait akun",
            ngaitProgress,
            totalAccounts,
            `Ronde ${round}/${maxRetryRounds}, attempt ${attempt}/${maxAttempts}. Validasi langsung dari layar Play Store.`
          )
        );

        if (remainingCountAfterAttempt === 0) break;
        if (remainingCountAfterAttempt >= lastRemainingCount) {
          log(`order #${order.id} no linking progress on round ${round} attempt ${attempt}, retry round will continue if available`);
          break;
        }

        lastRemainingCount = remainingCountAfterAttempt;
        updateOrder(order.id, {
          retryAttempt: attempt,
          linkedCount: successCountAfterAttempt,
          remainingCount: remainingCountAfterAttempt,
        });
      }

      const successAfterRound = countLines(resultFile);
      const unverifiedCount = Math.max(0, totalAccounts - successAfterRound);
      updateOrder(order.id, {
        successCount: successAfterRound,
        remainingCount: unverifiedCount,
      });

      log(`order #${order.id} round ${round} result success=${successAfterRound}/${totalAccounts}`);
      await editNotify(
        order.telegramId,
        progressMessageId,
        renderProgress(
          order,
          "Validasi Play Store",
          successAfterRound,
          totalAccounts,
          unverifiedCount ? `Belum berhasil: ${unverifiedCount}. Akan retry jika ronde masih ada.` : "Semua akun sudah terlihat PaysafeCard di Play Store."
        )
      );
      if (successAfterRound >= totalAccounts) break;
      if (successAfterRound <= successBeforeRound) {
        log(`order #${order.id} no success progress on round ${round}, retrying remaining accounts if retry rounds are left`);
      }
    }

    const successCount = countLines(resultFile);
    const remainingUnverified = subtractLines(originalAccounts, readLines(resultFile));
    const remainingCount = remainingUnverified.length;
    const failedCount = remainingCount;
    const remainingUnverifiedFile = path.join(order.orderPath, "remaining-unverified.txt");
    writeLines(remainingUnverifiedFile, remainingUnverified);

    updateOrder(order.id, {
      status: "DONE",
      phase: "DONE",
      successCount,
      failedCount,
      remainingCount,
      retryAttempts: maxAttempts,
      retryRounds: maxRetryRounds,
      resultFile,
      logFile,
      finishedAt: new Date().toISOString(),
    });
    log(`order #${order.id} DONE success=${successCount} failed=${failedCount} remaining=${remainingCount}`);
    await editNotify(
      order.telegramId,
      progressMessageId,
      renderProgress(
        order,
        "Selesai",
        successCount,
        totalAccounts,
        remainingCount ? `Berhasil: ${successCount}. Gagal/belum berhasil: ${remainingCount}.` : "Semua akun berhasil."
      )
    );

    usersStore.update((users) => {
      const user = users[order.telegramId];
      if (user) {
        user.totalKait = Number(user.totalKait || 0) + successCount;
        user.totalSpend = Number(user.totalSpend || 0) + Number(order.totalPrice || 0);
      }
      return users;
    });

    await notify(
      order.telegramId,
      [
        `Order #${order.id} selesai.`,
        "",
        `Total: ${order.totalAccounts}`,
      `Berhasil: ${successCount}`,
      `Gagal/belum berhasil: ${remainingCount}`,
    ].join("\n")
    );
    if (successCount > 0) {
      await sendDocument(order.telegramId, resultFile, `Hasil akun berhasil ngait order #${order.id}`);
    }
    if (remainingCount > 0) {
      await sendDocument(order.telegramId, remainingUnverifiedFile, `Sisa akun gagal/belum berhasil order #${order.id}`);
    }
  } catch (error) {
    log(`order #${order.id} FAILED ${error.message}`);
    updateOrder(order.id, {
      status: "FAILED",
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
    await notify(order.telegramId, `Order #${order.id} gagal: ${error.message}`);
  }
}

async function loop() {
  log("PSC worker started.");
  while (true) {
    const orders = ordersStore.read();
    const order = orders.find((item) => item.status === "QUEUED" || item.status === "PAID");
    if (!order) {
      const now = Date.now();
      if (now - lastIdleLogAt > 30000) {
        log("idle, waiting for queued orders...");
        lastIdleLogAt = now;
      }
      await sleep(POLL_MS);
      continue;
    }
    await processOrder(order);
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});

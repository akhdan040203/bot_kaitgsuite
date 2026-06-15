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
  .map((s) => s.trim())
  .filter(Boolean);
const DATA_DIR = path.join(__dirname, "data", "bot");
const ordersStore = new MongoStore("orders", []);
const usersStore = new MongoStore("users", {});
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

function rp(value) {
  return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

async function notify(chatId, text, replyMarkup) {
  if (!API || !chatId) return;
  try {
    const payload = { chat_id: chatId, text, parse_mode: "HTML" };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const { data } = await axios.post(`${API}/sendMessage`, payload, { timeout: 30000 });
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

async function deleteNotify(chatId, messageId) {
  if (!API || !chatId || !messageId) return;
  try {
    await axios.post(
      `${API}/deleteMessage`,
      { chat_id: chatId, message_id: messageId },
      { timeout: 30000 }
    );
  } catch (_) {}
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

function orderIdValues(orderId) {
  const num = Number(orderId);
  const values = [orderId, String(orderId)];
  if (Number.isFinite(num)) values.push(num);
  return [...new Set(values)];
}

// Update field order secara ATOMIC (positional $set), tidak menimpa seluruh array.
// opts.whereIn (mis. ["QUEUED","PAID"]) -> update hanya jika status order saat ini cocok.
// Return true kalau benar2 ke-update.
async function updateOrder(orderId, patch, opts = {}) {
  return ordersStore.patchItem(
    "id",
    orderIdValues(orderId),
    { ...patch, updatedAt: new Date().toISOString() },
    opts.whereIn ? { whereField: "status", whereIn: opts.whereIn } : {}
  );
}

// True kalau order sudah dibatalkan admin (atau hilang dari DB).
async function isOrderCancelled(orderId) {
  const orders = await ordersStore.read();
  const o = orders.find((x) => String(x.id) === String(orderId));
  return !o || o.status === "CANCELLED" || o.stopRequested === true;
}

function killChildTree(child) {
  try {
    if (process.platform === "win32") {
      require("child_process").exec(`taskkill /pid ${child.pid} /T /F`);
    } else {
      child.kill("SIGTERM");
    }
  } catch (_) {}
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

function progressBarAscii(done, total) {
  const safeTotal = Math.max(1, Number(total || 0));
  const safeDone = Math.min(safeTotal, Math.max(0, Number(done || 0)));
  const percent = Math.floor((safeDone / safeTotal) * 100);
  const filled = Math.floor(percent / 10);
  return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${percent}%`;
}

function renderProgress(order, phase, done, total, detail = "") {
  const safeTotal = Math.max(1, Number(total || 0));
  const doneNum = Math.min(safeTotal, Math.max(0, Number(done || 0)));
  const percent = Math.floor((doneNum / safeTotal) * 100);
  const segments = 20;
  const filled = Math.round((percent / 100) * segments);
  const bar = "█".repeat(filled) + "░".repeat(segments - filled);
  const displayDone = Number.isInteger(done) ? done : doneNum.toFixed(1);
  // Realtime ringkas: bar + persen + jumlah gsuite saja.
  return [
    `🔗 <b>Ngait Order #${order.id}</b>`,
    `<code>${bar}</code> <b>${percent}%</b>`,
    `${displayDone}/${safeTotal} gsuite`,
  ].join("\n");
}

function runPscWorker(order, attempt, onProgress) {
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

    const orderRegion = String(order.region || "UK").toUpperCase();
    log(`attempt ${attempt}: spawning: ${PYTHON_BIN} ${args.join(" ")} (region=${orderRegion})`);
    const child = spawn(PYTHON_BIN, args, {
      cwd: __dirname,
      windowsHide: true,
      env: { ...process.env, REGION: orderRegion },
    });
    let stdoutBuffer = "";
    let stopped = false;

    // Cek berkala: kalau admin membatalkan order, hentikan proses python.
    const cancelPoll = setInterval(() => {
      isOrderCancelled(order.id)
        .then((cancelled) => {
          if (cancelled && !stopped) {
            stopped = true;
            log(`order #${order.id} dibatalkan admin -> hentikan proses ngait`);
            killChildTree(child);
          }
        })
        .catch(() => {});
    }, Number(process.env.CANCEL_POLL_MS || 4000));

    // Timeout: kalau python hang terlalu lama (emulator stuck), kill biar order tidak nyangkut.
    // Round berikutnya akan resume akun sisa otomatis.
    const accountCount = readLines(inputFile).length;
    const perAccountMs = Number(process.env.PSC_TIMEOUT_PER_ACCOUNT_MS || 120000);
    const minTimeoutMs = Number(process.env.PSC_WORKER_MIN_TIMEOUT_MS || 600000);
    const timeoutMs = Math.max(minTimeoutMs, accountCount * perAccountMs);
    const killTimer = setTimeout(() => {
      log(`order #${order.id} attempt ${attempt}: TIMEOUT ${Math.round(timeoutMs / 60000)} menit (kemungkinan emulator stuck) -> kill python`);
      killChildTree(child);
    }, timeoutMs);

    function handleProgressChunk(chunk) {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const match = line.match(/^PSC_PROGRESS\|([^|]+)\|(\d+)\|(.+)$/);
        if (!match || typeof onProgress !== "function") continue;
        onProgress({
          email: match[1].trim().toLowerCase(),
          percent: Math.max(0, Math.min(100, Number(match[2]))),
          label: match[3].trim(),
        });
      }
    }

    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stdout.write(chunk);
      handleProgressChunk(chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      clearInterval(cancelPoll);
      clearTimeout(killTimer);
      log(`spawn error: ${error.message}`);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(cancelPoll);
      clearTimeout(killTimer);
      log(`attempt ${attempt}: mumu-psc.py exited with code ${code}`);
      if (stopped) {
        resolve({ resultFile, logFile, stopped: true });
        return;
      }
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
  // Klaim ATOMIC: hanya QUEUED/PAID -> RUNNING. Kalau order sudah CANCELLED (dibatalkan admin)
  // atau sudah diambil proses lain, transisi gagal -> JANGAN proses & JANGAN kirim "Mulai ngait".
  const claimed = await updateOrder(
    order.id,
    { status: "RUNNING", startedAt: new Date().toISOString() },
    { whereIn: ["QUEUED", "PAID"] }
  );
  if (!claimed) {
    log(`order #${order.id} batal diproses (status bukan QUEUED/PAID — kemungkinan sudah dibatalkan/diambil). skip.`);
    return;
  }
  log(`order #${order.id} status RUNNING`);
  const initialProgress = await notify(
    order.telegramId,
    renderProgress(order, "Menunggu worker", 0, order.totalAccounts, "Order mulai diproses.")
  );
  const progressMessageId = initialProgress?.message_id;

  // Kirim file akun yang akan dikait ke admin saat mulai proses.
  // Saat resume, input.txt = akun SISA (bukan original), jadi caption disesuaikan.
  const startInputFile = path.join(order.orderPath, "input.txt");
  const startCount = countLines(startInputFile);
  const isResume = startCount > 0 && startCount < Number(order.totalAccounts || 0);
  for (const adminId of ADMIN_IDS) {
    if (String(adminId) === String(order.telegramId)) continue;
    await sendDocument(
      adminId,
      startInputFile,
      isResume
        ? `[ADMIN] Lanjut (resume) order #${order.id} • 🌍 ${String(order.region || "UK").toUpperCase()} • sisa ${startCount} akun • user @${order.username || "-"}`
        : `[ADMIN] Mulai ngait order #${order.id} • 🌍 ${String(order.region || "UK").toUpperCase()} • ${startCount} akun • user @${order.username || "-"}`
    );
  }

  try {
    const maxAttempts = Math.max(1, Number(process.env.PSC_MAX_RETRY_PASSES || 3));
    const maxRetryRounds = Math.max(1, Number(process.env.PSC_VERIFY_MAX_ROUNDS || 3));
    const remainingInputFile = path.join(order.orderPath, "input.txt");
    const originalInputFile = path.join(order.orderPath, "original-input.txt");
    const notRegisteredFile = path.join(order.orderPath, "not-registered.txt");
    let resultFile = path.join(order.orderPath, "success.txt");
    let logFile = path.join(order.orderPath, "worker.log");

    if (!fs.existsSync(originalInputFile)) {
      writeLines(originalInputFile, readLines(remainingInputFile));
    }

    const originalAccounts = readLines(originalInputFile);
    const totalAccounts = originalAccounts.length || Number(order.totalAccounts || 0);
    const accountProgress = new Map();
    let lastShownPercent = -1;
    let lastEditAt = 0;
    let batches = []; // [{ round, total, success, status }] untuk tampilan antrian per-batch
    let successBeforeRoundLive = 0;

    const updateRealtimeProgress = async ({ email, percent, label }) => {
      accountProgress.set(email, percent);
      const successEmails = new Set(readLines(resultFile).map((line) => line.split("|")[0].trim().toLowerCase()));
      let progressSum = 0;
      for (const account of originalAccounts) {
        const accountEmail = account.split("|")[0].trim().toLowerCase();
        progressSum += successEmails.has(accountEmail)
          ? 100
          : Number(accountProgress.get(accountEmail) || 0);
      }

      // Persen ASLI = total progress semua akun / jumlah akun. Bar hanya penuh kalau benar2 selesai.
      const overallPercent = Math.min(100, Math.floor(progressSum / Math.max(1, totalAccounts)));
      const step = Number(process.env.PROGRESS_STEP_PERCENT || 2);
      const minInterval = Number(process.env.PROGRESS_MIN_INTERVAL_MS || 2500);
      const now = Date.now();
      if (overallPercent < 100) {
        if (overallPercent < lastShownPercent + step) return; // throttle: naik minimal {step}%
        if (now - lastEditAt < minInterval) return; // throttle waktu: hindari spam edit
      }
      lastShownPercent = overallPercent;
      lastEditAt = now;
      // Update success batch berjalan (live).
      if (batches.length) {
        batches[batches.length - 1].success = Math.max(0, successEmails.size - successBeforeRoundLive);
      }
      // Update Done (successCount) live ke DB biar /orders & antrian bergerak realtime.
      await updateOrder(order.id, { successCount: successEmails.size, progressPercent: overallPercent, batches });
      const doneEquivalent = (overallPercent / 100) * totalAccounts;
      await editNotify(
        order.telegramId,
        progressMessageId,
        renderProgress(order, "Ngait akun", doneEquivalent, totalAccounts, `${overallPercent}% - ${label || "proses"}`)
      );
    };

    for (let round = 1; round <= maxRetryRounds; round++) {
      if (await isOrderCancelled(order.id)) break;
      const successBeforeRound = countLines(resultFile);
      const accountsToLink = subtractLines(originalAccounts, [
        ...readLines(resultFile),
        ...readLines(notRegisteredFile),
      ]);

      if (accountsToLink.length === 0) break;

      writeLines(remainingInputFile, accountsToLink);
      successBeforeRoundLive = successBeforeRound;
      batches.push({ round, total: accountsToLink.length, success: 0, status: "RUNNING" });
      await updateOrder(order.id, {
        phase: round === 1 ? "LINKING" : "RETRY_LINKING",
        retryRound: round,
        remainingCount: accountsToLink.length,
        batches,
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

      // Satu pass per round: mumu-psc.py memproses SELURUH akun sisa (input.txt) sekali jalan.
      // Round 1 = semua akun; round berikutnya = hanya yang masih gagal. Maks maxRetryRounds round.
      let stoppedThisRound = false;
      try {
        const r = await runPscWorker(order, `${round}`, (progress) => {
          updateRealtimeProgress(progress).catch((error) => {
            console.error(`[progress] ${error.message}`);
          });
        });
        resultFile = r.resultFile;
        logFile = r.logFile;
        stoppedThisRound = Boolean(r.stopped);
      } catch (error) {
        log(`order #${order.id} round ${round} worker error: ${error.message}`);
      }
      if (stoppedThisRound || (await isOrderCancelled(order.id))) break;

      const successAfterRound = countLines(resultFile);
      const notRegisteredCountRound = countLines(notRegisteredFile);
      const unverifiedCount = Math.max(0, totalAccounts - successAfterRound - notRegisteredCountRound);
      if (batches.length) {
        batches[batches.length - 1].success = Math.max(0, successAfterRound - successBeforeRound);
        batches[batches.length - 1].status = "DONE";
      }
      await updateOrder(order.id, {
        successCount: successAfterRound,
        remainingCount: unverifiedCount,
        batches,
      });

      log(`order #${order.id} round ${round} result success=${successAfterRound}/${totalAccounts} sisa=${unverifiedCount}`);
      await editNotify(
        order.telegramId,
        progressMessageId,
        renderProgress(
          order,
          "Cek hasil Play Store",
          successAfterRound,
          totalAccounts,
          unverifiedCount ? `Belum berhasil: ${unverifiedCount}. Retry ronde berikutnya jika masih ada.` : "Semua akun sudah terdeteksi PaysafeCard."
        )
      );
      if (successAfterRound + notRegisteredCountRound >= totalAccounts) break;
      if (successAfterRound <= successBeforeRound) {
        log(`order #${order.id} no success progress on round ${round}, retrying remaining accounts if retry rounds are left`);
      }
    }

    // Kalau dibatalkan admin di tengah jalan -> BERHENTI (tidak lanjut ronde), tutup CANCELLED,
    // lalu kirim file SUCCESS + file GAGAL (akun sisa yang belum berhasil).
    if (await isOrderCancelled(order.id)) {
      const successCancel = countLines(resultFile);
      const notRegisteredCancel = readLines(notRegisteredFile);
      const remainingCancel = subtractLines(originalAccounts, [...readLines(resultFile), ...notRegisteredCancel]);
      const failedCancel = remainingCancel.length;
      const gagalFile = path.join(order.orderPath, "gagal.txt");
      writeLines(gagalFile, remainingCancel);

      await updateOrder(order.id, {
        status: "CANCELLED",
        successCount: successCancel,
        failedCount: failedCancel + notRegisteredCancel.length,
        remainingCount: failedCancel,
        finishedAt: new Date().toISOString(),
        cancelledByAdmin: true,
      });
      log(`order #${order.id} DIBATALKAN admin. success=${successCancel}/${totalAccounts} gagal=${failedCancel}`);

      // Refund: akun sisa yang BELUM/gagal diproses -> +credit (bisa dipakai ngait gratis order berikutnya).
      // Akun yang sudah berhasil tetap dihitung totalKait. Order ini FINAL (tidak bisa retry).
      const refundCancel = failedCancel > 0 ? failedCancel : 0;
      await usersStore.update((users) => {
        const user = users[order.telegramId];
        if (user) {
          user.totalKait = Number(user.totalKait || 0) + successCancel;
          if (refundCancel > 0) user.credit = Number(user.credit || 0) + refundCancel;
        }
        return users;
      });

      await editNotify(
        order.telegramId,
        progressMessageId,
        `❌ <b>Order #${order.id} dibatalkan admin.</b>\nBerhasil: ${successCancel}/${totalAccounts} • Gagal/belum: ${failedCancel}`
      );
      // Kirim file hasil ke user: success + gagal.
      if (successCancel > 0) {
        await sendDocument(order.telegramId, resultFile, `✅ Berhasil order #${order.id} — ${successCancel} akun (dibatalkan admin)`);
      }
      if (failedCancel > 0) {
        await sendDocument(order.telegramId, gagalFile, `❌ Gagal/belum berhasil order #${order.id} — ${failedCancel} akun (dibatalkan admin)`);
      }
      await notify(
        order.telegramId,
        [
          `Order #${order.id} dibatalkan admin.`,
          "",
          `Total: ${totalAccounts}`,
          `Berhasil (dikirim): ${successCancel}`,
          `Gagal/belum diproses: ${failedCancel}`,
          refundCancel
            ? `\n🎁 ${refundCancel} akun sisa → +${refundCancel} credit ngait (otomatis dipakai gratis di order berikutnya).`
            : "",
          "\n⚠️ Order yang dibatalkan tidak bisa di-retry. Silakan order ulang untuk akun sisa.",
        ].filter(Boolean).join("\n")
      );
      // Admin: notif + file success & gagal.
      for (const adminId of ADMIN_IDS) {
        if (String(adminId) === String(order.telegramId)) continue;
        await notify(adminId, `[ADMIN] Order #${order.id} dibatalkan. Berhasil: ${successCancel}/${totalAccounts} • Gagal: ${failedCancel}`);
        if (successCancel > 0) await sendDocument(adminId, resultFile, `[ADMIN] success #${order.id} (dibatalkan)`).catch(() => {});
        if (failedCancel > 0) await sendDocument(adminId, gagalFile, `[ADMIN] gagal #${order.id} (dibatalkan)`).catch(() => {});
      }
      await deleteNotify(order.telegramId, progressMessageId);
      if (order.queueMessageId) await deleteNotify(order.telegramId, order.queueMessageId);
      return;
    }

    const successCount = countLines(resultFile);
    const notRegistered = readLines(notRegisteredFile);
    const notRegisteredCount = notRegistered.length;
    const remainingUnverified = subtractLines(originalAccounts, [...readLines(resultFile), ...notRegistered]);
    const remainingCount = remainingUnverified.length;
    const failedCount = remainingCount + notRegisteredCount;
    const remainingUnverifiedFile = path.join(order.orderPath, "remaining-unverified.txt");
    writeLines(remainingUnverifiedFile, remainingUnverified);

    await updateOrder(order.id, {
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

    // Auto-refund: tiap akun gagal (setelah semua retry) -> +1 CREDIT (bisa dipakai ngait gratis).
    const refundCredit = remainingCount > 0 ? remainingCount : 0;
    let bonusGranted = 0;
    let bonusMilestoneReached = 0;
    await usersStore.update((users) => {
      const user = users[order.telegramId];
      if (user) {
        user.totalKait = Number(user.totalKait || 0) + successCount;
        user.totalSpend = Number(user.totalSpend || 0) + Number(order.totalPrice || 0);
        // Auto-refund akun gagal -> credit (jumlah akun).
        if (refundCredit > 0) {
          user.credit = Number(user.credit || 0) + refundCredit;
        }
        // Bonus loyalitas: tiap kelipatan 1000 akun ngait -> +50 credit akun.
        const step = Number(process.env.BONUS_MILESTONE_STEP || 1000);
        const perMilestone = Number(process.env.BONUS_CREDIT_PER_1000 || 50);
        const before = Number(user.bonusMilestone || 0);
        const reached = Math.floor(user.totalKait / step) * step;
        if (reached > before) {
          const crossed = (reached - before) / step;
          bonusGranted = crossed * perMilestone;
          user.credit = Number(user.credit || 0) + bonusGranted;
          user.bonusMilestone = reached;
          bonusMilestoneReached = reached;
        }
      }
      return users;
    });
    if (bonusGranted > 0) {
      await notify(
        order.telegramId,
        [
          "🎉 <b>Selamat! Bonus Loyalitas</b>",
          "",
          `Kamu sudah ngait ${bonusMilestoneReached}+ akun!`,
          `🎁 Bonus credit: <b>${bonusGranted} akun</b> ditambahkan.`,
          "Credit otomatis dipakai untuk ngait gratis di order berikutnya.",
        ].join("\n")
      );
    }

    await notify(
      order.telegramId,
      [
        `Order #${order.id} selesai.`,
        "",
        `Total: ${order.totalAccounts}`,
        `Berhasil: ${successCount}`,
        notRegisteredCount ? `Gsuite tidak terdaftar: ${notRegisteredCount}` : "",
        `Gagal/belum berhasil: ${remainingCount}`,
        refundCredit
          ? `\n🎁 ${remainingCount} akun gagal → +${refundCredit} credit ngait (bisa dipakai gratis untuk order berikutnya).`
          : "",
      ].filter(Boolean).join("\n")
    );
    if (successCount > 0) {
      await sendDocument(order.telegramId, resultFile, `Hasil akun berhasil ngait order #${order.id}`);
    }
    if (notRegisteredCount > 0) {
      await sendDocument(order.telegramId, notRegisteredFile, `Gsuite tidak terdaftar order #${order.id}`);
    }
    if (remainingCount > 0) {
      await sendDocument(order.telegramId, remainingUnverifiedFile, `Sisa akun gagal/belum berhasil order #${order.id}`);
      await notify(
        order.telegramId,
        `🔁 Mau ngait ulang <b>${remainingCount} akun gagal</b> pakai saldo kamu?`,
        { inline_keyboard: [[{ text: `🔁 Retry ${remainingCount} akun (pakai saldo)`, callback_data: `retry_${order.id}` }]] }
      );
    }

    // Kirim juga hasil ke admin (rekap) saat order selesai.
    for (const adminId of ADMIN_IDS) {
      if (String(adminId) === String(order.telegramId)) continue;
      await notify(
        adminId,
        [
          `[ADMIN] Order #${order.id} selesai • @${order.username || "-"}`,
          `Total: ${order.totalAccounts} | Berhasil: ${successCount}`,
          notRegisteredCount ? `Tidak terdaftar: ${notRegisteredCount}` : "",
          `Gagal/belum: ${remainingCount}`,
        ].filter(Boolean).join("\n")
      );
      if (successCount > 0) await sendDocument(adminId, resultFile, `[ADMIN] Hasil berhasil order #${order.id}`);
      if (notRegisteredCount > 0) await sendDocument(adminId, notRegisteredFile, `[ADMIN] Gsuite tidak terdaftar order #${order.id}`);
      if (remainingCount > 0) await sendDocument(adminId, remainingUnverifiedFile, `[ADMIN] Sisa gagal order #${order.id}`);
    }

    await deleteNotify(order.telegramId, progressMessageId);
    if (order.queueMessageId) {
      await deleteNotify(order.telegramId, order.queueMessageId);
    }
  } catch (error) {
    log(`order #${order.id} FAILED ${error.message}`);
    await updateOrder(order.id, {
      status: "FAILED",
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
    await notify(order.telegramId, `Order #${order.id} gagal: ${error.message}`);
  }
}

async function loop() {
  await connectMongo();
  log("MongoDB connected.");
  // Recovery: order yang nyangkut RUNNING (worker mati di tengah proses) -> balikin ke QUEUED
  // biar diproses ulang & akhirnya DONE (hilang dari antrian). Akun yang sudah sukses tetap di-skip.
  let resetCount = 0;
  await ordersStore.update((orders) =>
    orders.map((o) => {
      if (o.status === "RUNNING") {
        resetCount++;
        return { ...o, status: "QUEUED" };
      }
      return o;
    })
  );
  if (resetCount > 0) log(`recovery: ${resetCount} order RUNNING di-reset ke QUEUED`);
  log("PSC worker started.");
  while (true) {
    try {
      const orders = await ordersStore.read();
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
    } catch (error) {
      // Error transient (mis. jaringan/Mongo ECONNRESET) -> JANGAN matikan worker, lanjut loop.
      log(`loop error (lanjut): ${error.message}`);
      await sleep(POLL_MS);
    }
  }
}

// Jaring pengaman: error jaringan transient jangan mematikan worker.
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection (diabaikan, worker tetap jalan): ${reason && reason.message ? reason.message : reason}`);
});
process.on("uncaughtException", (error) => {
  log(`uncaughtException (diabaikan, worker tetap jalan): ${error && error.message ? error.message : error}`);
});

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});

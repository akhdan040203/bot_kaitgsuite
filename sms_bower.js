require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const { faker } = require("@faker-js/faker");
const fs = require("fs");
const chalk = require("chalk");
const readline = require("readline");
const { HttpsProxyAgent } = require("https-proxy-agent");

// Constants
const API_KEY = process.env.SMSBOWER_API_KEY;
const DOMAIN = "@gmail.com";
const VERSION = "3.0";
const SALT = "MoB!l3D0KV";
const BASE_URL = "https://smsbower.online/stubs/handler_api.php";

// Logging function
const log = (type, message) => {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const logTypes = {
    info: chalk.blue("INFO"),
    success: chalk.green("SUCCESS"),
    error: chalk.red("ERROR"),
    warn: chalk.yellow("WARNING"),
  };
  const logType = logTypes[type] || chalk.magenta(type.toUpperCase());

  if (type === "error") {
    console.log(`[${timestamp}] ${logType} ❌ ${message}`);
  } else if (type === "success") {
    console.log(`[${timestamp}] ${logType} ✅ ${message}`);
  } else if (type === "warn") {
    console.log(`[${timestamp}] ${logType} ⚠️ ${message}`);
  } else {
    console.log(`[${timestamp}] ${logType} ${message}`);
  }
};

// Helper functions
const getWords = (string) =>
  crypto.createHash("sha1").update(string).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Proxy setup
let axiosInstance = axios;
let usingProxy = false;

async function askUseProxy() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("Do you want to use a proxy? (y/n): ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function setupProxyIfNeeded() {
  usingProxy = await askUseProxy();
  if (usingProxy) {
    const PROXY_URL = process.env.PROXY_URL;
    if (!PROXY_URL) {
      log("warn", "PROXY_URL is not set in .env. Continuing without proxy.");
      usingProxy = false;
      return;
    }
    const agent = new HttpsProxyAgent(PROXY_URL);
    axiosInstance = axios.create({
      httpsAgent: agent,
      httpAgent: agent,
    });
    log("info", `Proxy enabled: ${PROXY_URL}`);
  } else {
    log("info", "Proxy not used.");
  }
}

async function logCurrentIP() {
  try {
    const { data } = await axiosInstance.get(
      "https://api.ipify.org?format=json"
    );
    log(
      "info",
      `Current public IP: ${data.ip} (Proxy: ${usingProxy ? "ON" : "OFF"})`
    );
  } catch (err) {
    log("warn", `Failed to fetch public IP: ${err.message}`);
  }
}

// SMS Bower integration
const smsBowerIntegration = {
  getBalance: async () => {
    try {
      const params = {
        api_key: API_KEY,
        action: "getBalance",
      };
      const { data } = await axiosInstance.get(BASE_URL, { params });
      log("info", `SMS Bower Balance: ${data}`);
      return data;
    } catch (error) {
      log("error", `Failed to get SMS Bower balance: ${error.message}`);
      throw error;
    }
  },

  orderNumber: async () => {
    // service=akl (DOKU), country=6 (Indonesia), maxPrice=2
    const params = {
      api_key: API_KEY,
      action: "getNumber",
      service: "akl",
      country: "6",
      maxPrice: "2",
    };
    try {
      const { data } = await axiosInstance.get(BASE_URL, { params });
      if (typeof data === "string" && data.startsWith("ACCESS_NUMBER")) {
        const parts = data.split(":");
        const activationId = parts[1];
        const phone = parts[2];
        log("info", `DOKU E-Wallet | ${phone} | ${activationId}`);
        return `${phone}|${activationId}`;
      } else {
        log("error", `Failed to order number: ${data}`);
        throw new Error(data);
      }
    } catch (error) {
      log("error", `Failed to order number: ${error.message}`);
      throw error;
    }
  },

  getOtpForRegistration: async (activationId, retries = 3) => {
    const maxAttempts = 15;
    let pollInterval = 8000;
    const startTime = Date.now();
    const timeoutMs = 2 * 60 * 1000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() - startTime > timeoutMs) {
        log(
          "warn",
          `OTP registration timeout (2 minutes). Cancelling order ${activationId}`
        );
        await smsBowerIntegration.cancelOrder(activationId);
        throw new Error("OTP registration timed out after 2 minutes");
      }
      try {
        const params = {
          api_key: API_KEY,
          action: "getStatus",
          id: activationId,
        };
        const { data } = await axiosInstance.get(BASE_URL, { params });
        if (typeof data === "string" && data.startsWith("STATUS_OK")) {
          const code = data.split(":")[1].trim();
          log("info", `DOKU E-Wallet | Status: OK | Code: ${code}`);
          return code;
        } else if (
          typeof data === "string" &&
          (data.includes("STATUS_WAIT_CODE") ||
            data.includes("STATUS_WAIT_RETRY"))
        ) {
          log("info", `DOKU E-Wallet | Status: Waiting for SMS`);
        } else if (typeof data === "string" && data.includes("STATUS_CANCEL")) {
          log("warn", `DOKU E-Wallet | Status: Activation canceled`);
          throw new Error("Activation was canceled");
        } else {
          log("info", `DOKU E-Wallet | Status: ${data}`);
        }
      } catch (error) {
        log("error", `Error getting OTP: ${error.message}`);
      }
      await delay(pollInterval);
    }
    await smsBowerIntegration.cancelOrder(activationId);
    throw new Error("OTP not received after all attempts");
  },

  cancelOrder: async (activationId) => {
    const params = {
      api_key: API_KEY,
      action: "setStatus",
      status: "8",
      id: activationId,
    };
    try {
      const { data } = await axiosInstance.get(BASE_URL, { params });
      log("info", `Cancelled order ${activationId}: ${data}`);
      return data.includes("ACCESS_CANCEL");
    } catch (error) {
      log("error", `Failed to cancel order: ${error.message}`);
      return false;
    }
  },
};

// Doku registration process using SMS Bower
const dokuRegistration = {
  orderNumber: async () => {
    return smsBowerIntegration.orderNumber();
  },

  sendOtp: async (noHp) => {
    const words = getWords(`${VERSION}${noHp}${SALT}`);
    const payload = {
      phoneNo: noHp,
      version: VERSION,
      app_version: "3.1.0",
      deviceId: "1",
      words,
    };
    const data = await axiosInstance.post(
      "https://my.dokuwallet.com/DWMobileAPI/apprequest/doSendOtpForRegistration",
      new URLSearchParams(payload)
    );
    if (!(data.data && data.data.responseCode === "0000")) {
      throw new Error(
        `Failed to send OTP: ${
          data.data ? data.data.responseMsg : "Unknown error"
        }`
      );
    }
  },

  validateOtp: async (noHp, otp) => {
    const words = getWords(`${VERSION}${otp}${noHp}${SALT}`);
    const payload = {
      phoneNo: noHp,
      OTP: otp,
      version: VERSION,
      app_version: "3.1.0",
      deviceId: "1",
      words,
    };
    const data = await axiosInstance.post(
      "https://my.dokuwallet.com/DWMobileAPI/apprequest/doValidateOtpForRegistration",
      new URLSearchParams(payload)
    );
    if (!(data.data && data.data.responseCode === "0000")) {
      throw new Error(
        `Failed to validate OTP: ${
          data.data ? data.data.responseMsg : "Unknown error"
        }`
      );
    }
  },

  submitForm: async (noHp, email, name, otp) => {
    const words = getWords(`${noHp}${SALT}${email}${otp}`);
    const REQUEST_TIMESTAMP = new Date().toISOString().slice(0, -1) + "Z";
    const payload = {
      REQUESTTYPE: "doSignUp",
      PHONE: noHp,
      WORDS: words,
      VERSION: "2.1",
      PIN: "OWLv2nadLlHOQq9OLwbWuAHQQ0FUOFeJmqw9b20ZBRnzQosUw4TanYffGKg8vrkeO8SA9Jpbx+Yb/9yCJNKZQm3iqiUCPBiTH5StbgjpIprzsTMQCuFZ5SfMnD73Fo8XeD7JZnw2ycEEXpEAqmjbLtIF6t/WJuvZtXKIDIAtLWtJjzRHCkt/j3Yk5XHhdw2/oGq33Urwah/t+F3PdXEkmBj5GWRVLlDEf4jkMXCI7BJWNSVsuKf8y/y2Bk59wRfnaXx6SgEmltxTiaDrw7tXXcyLHngZKcYUWF6PRrr4f2Gbw4gX8Zo3kaHXNn4PQ1Ltze70Nvpi9KcToz52upQSEg==",
      APP_VERSION: "3.1.3",
      DEVICEID: "2",
      NAME: name,
      EMAIL: email,
      GENDER: Math.random() < 0.5 ? "F" : "M",
      OTP: otp,
      REQUEST_TIMESTAMP,
    };
    const data = await axiosInstance.post(
      "https://my.dokuwallet.com/DWMobileAPI/apprequest",
      new URLSearchParams(payload)
    );
    if (data.data && data.data.responseCode === "0000") {
      return {
        success: true,
        message: "Registration successful",
        email,
        name,
        phone: noHp,
      };
    } else if (
      data.data &&
      data.data.responseMsg ===
        "No handphone Anda sudah terdaftar sebelumnya, silahkan gunakan phone no lain"
    ) {
      return {
        success: true,
        message: "Phone number already registered",
        email,
        name,
        phone: noHp,
      };
    } else {
      throw new Error(data.data ? data.data.responseMsg : "Unknown error");
    }
  },

  register: async () => {
    try {
      const order = await smsBowerIntegration.orderNumber();
      const [noHp, activationId] = order.split("|");
      // Generate registration email
      const username = faker.internet.userName();
      const email = `${username}cdvss${DOMAIN}`;
      const name = faker.person.fullName();
      await dokuRegistration.sendOtp(noHp);
      const otp = await smsBowerIntegration.getOtpForRegistration(activationId);
      await dokuRegistration.validateOtp(noHp, otp);
      const pin = "123123";
      const submitResult = await dokuRegistration.submitForm(
        noHp,
        email,
        name,
        otp
      );
      if (submitResult.success) {
        log("info", `DOKU E-Wallet | ${submitResult.message}`);
        return {
          noHp: submitResult.phone,
          email: submitResult.email,
          name: submitResult.name,
          pin,
          activationId,
        };
      } else {
        throw new Error("Form submission failed");
      }
    } catch (error) {
      log("error", `DOKU Register Failed : ${error.message}`);
      return null;
    }
  },
};

const main = async () => {
  console.clear();

  await setupProxyIfNeeded();
  await logCurrentIP();

  // Check balance
  await smsBowerIntegration.getBalance();

  // Get number of accounts to create
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const numAccounts = await new Promise((resolve) => {
    rl.question("Enter number of accounts to create: ", (answer) => {
      resolve(parseInt(answer));
    });
  });

  const concurrency = await new Promise((resolve) => {
    rl.question("Enter number of concurrent threads: ", (answer) => {
      rl.close();
      resolve(Math.max(1, parseInt(answer)));
    });
  });

  console.log(
    `Creating ${numAccounts} DOKU accounts with concurrency: ${concurrency}...`
  );

  // Helper for concurrency
  async function runWithConcurrencyUntilTarget(targetSuccess, limit) {
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let totalTried = 0;
    let running = true;
    const successList = [];
    const failedList = [];

    async function createAccount(idx) {
      while (running) {
        const currentIdx = ++totalTried;
        console.log(`\nCreating account attempt ${currentIdx}`);
        try {
          const result = await dokuRegistration.register();
          if (result) {
            const formattedNoHp = result.noHp.startsWith("62")
              ? result.noHp.slice(2)
              : result.noHp;
            await fs.promises.appendFile(
              "./dokufresh2.txt",
              `${formattedNoHp}|${result.pin}|${result.email}\n`
            );
            console.log(`Successfully created account: ${formattedNoHp}`);
            successList.push({
              success: true,
              phone: formattedNoHp,
              email: result.email,
              name: result.name,
            });
            successCount++;
            if (successCount >= targetSuccess) {
              running = false;
              break;
            }
          } else {
            console.log(`Failed to create account attempt ${currentIdx}`);
            failedList.push({ success: false, reason: "Unknown error" });
            failCount++;
          }
        } catch (err) {
          console.log(
            `Failed to create account attempt ${currentIdx}: ${err.message}`
          );
          failedList.push({ success: false, reason: err.message });
          failCount++;
        }
        // Add delay between accounts (optional)
        await delay(5000);
      }
    }

    // Start concurrent workers
    const workers = [];
    for (let i = 0; i < limit; i++) {
      workers.push(createAccount(i));
    }
    await Promise.all(workers);
    return { successList, failedList };
  }

  // Jalankan proses sampai jumlah sukses sesuai target
  const { successList, failedList } = await runWithConcurrencyUntilTarget(
    numAccounts,
    concurrency
  );

  // Print summary
  console.log("\n========== SUMMARY ==========");
  console.log(`Total Success: ${successList.length}`);
  if (successList.length > 0) {
    successList.forEach((r, idx) => {
      console.log(`  [${idx + 1}] ${r.phone} | ${r.email} | ${r.name}`);
    });
  }
  console.log(`Total Failed: ${failedList.length}`);
  if (failedList.length > 0) {
    failedList.forEach((r, idx) => {
      console.log(`  [${idx + 1}] Reason: ${r.reason}`);
    });
  }
  console.log("============================\n");
  console.log("\nProcess completed!");
};

main().catch((err) => {
  log("error", `Main process error: ${err.message}`);
  process.exit(1);
});

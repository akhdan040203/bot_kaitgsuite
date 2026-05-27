require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const { faker } = require("@faker-js/faker");
const fs = require("fs");
const chalk = require("chalk");
const readline = require("readline");

// Constants
const APIKEY = process.env.APIKEY;
const DOMAIN = "@gmail.com";
const VERSION = "3.0";
const SALT = "MoB!l3D0KV";

// Refactored logging function
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
const getWords = (string) => crypto.createHash("sha1").update(string).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SMSHub integration
const smshubIntegration = {
  getBalance: async () => {
    const options = {
      method: "GET",
      url: "https://api.smsvirtual.co/v1/profile/",
      headers: { "X-Api-Key": `${APIKEY}` },
    };
    try {
      const { data } = await axios.request(options);
      const balance = data.data.balance;
      log("info", `SMSHub Balance: ${balance}`);
      return balance;
    } catch (error) {
      log("error", `Failed to get SMSHub balance: ${error.message}`);
      throw error;
    }
  },

  orderNumber: async () => {
    const options = {
      method: "POST",
      url: "https://api.smsvirtual.co/v1/order/",
      headers: {
        "X-Api-Key": `${APIKEY}`,
        "Content-Type": "application/json",
      },
      data: { country: 7, service: 324, operator: "" },
    };
    try {
      const { data } = await axios.request(options);
      const response = data;
      const id = response.data.id;
      const phone = response.data.phone;
      log("info", `DOKU E-Wallet | ${phone} | ${id}`);
      return `${phone}|${id}`;
    } catch (error) {
      log("error", `Failed to order number: ${error.message}`);
      throw error;
    }
  },

  getOtpForRegistration: async (id, retries = 3) => {
    const maxAttempts = 12;
    let backoffTime = 5000;
    const startTime = Date.now();
    const timeoutMs = 2 * 60 * 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() - startTime > timeoutMs) {
        log("warn", `OTP registration timeout (2 minutes). Cancelling order ${id}`);
        try {
          const cancelOptions = {
            method: "PATCH",
            url: `https://api.smsvirtual.co/v1/order/${id}/1`,
            headers: { "X-Api-Key": `${APIKEY}` },
          };
          await axios.request(cancelOptions);
          log("info", `Successfully cancelled order ${id}`);
        } catch (cancelError) {
          log("error", `Failed to cancel order: ${cancelError.message}`);
        }
        throw new Error("OTP registration timed out after 2 minutes");
      }

      try {
        const options = {
          method: "GET",
          url: `https://api.smsvirtual.co/v1/order/status/${id}`,
          headers: { "X-Api-Key": `${APIKEY}` },
        };
        const { data } = await axios.request(options);
        const responseData = data;

        if (responseData.data.orderStatus === "PENDING") {
          log("info", `DOKU E-Wallet | Status: Waiting for SMS`);
        } else if (responseData.data.orderStatus === "CANCEL") {
          log("warn", `DOKU E-Wallet | Status: Activation canceled`);
          throw new Error("Activation was canceled");
        } else if (responseData.data.orderStatus === "SUCCESS") {
          const code = responseData.data.Sms[0].sms;
          log("info", `DOKU E-Wallet | Status: OK | Code: ${code}`);
          return code;
        }
      } catch (error) {
        if (error.response && error.response.status === 429) {
          log("warn", `Rate limit hit. Waiting ${backoffTime / 1000} seconds before retry...`);
          await delay(backoffTime);
          backoffTime = Math.min(backoffTime * 2, 60000);
          continue;
        }
        log("error", `Error getting OTP: ${error.message}`);
        if (error.message.includes("Activation was canceled") || error.message.includes("OTP registration timed out")) {
          throw error;
        }
      }
      await delay(backoffTime);
    }

    if (retries > 0) {
      log("info", `OTP not received. Attempting to request another SMS. Retries left: ${retries}`);
      return smshubIntegration.getOtpForRegistration(id, retries - 1);
    }

    try {
      const cancelOptions = {
        method: "PATCH",
        url: `https://api.smsvirtual.co/v1/order/${id}/1`,
        headers: { "X-Api-Key": `${APIKEY}` },
      };
      await axios.request(cancelOptions);
      log("info", `Cancelled order ${id} after exhausting all retries`);
    } catch (cancelError) {
      log("error", `Failed to cancel order: ${cancelError.message}`);
    }

    throw new Error("OTP not received after all attempts");
  }
};

// Doku registration process
const dokuRegistration = {
  orderNumber: async () => {
    return smshubIntegration.orderNumber();
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

    const data = await axios.post(
      "https://my.dokuwallet.com/DWMobileAPI/apprequest/doSendOtpForRegistration",
      new URLSearchParams(payload)
    );

    if (!(data.data && data.data.responseCode === "0000")) {
      throw new Error(`Failed to send OTP: ${data.data ? data.data.responseMsg : "Unknown error"}`);
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

    const data = await axios.post(
      "https://my.dokuwallet.com/DWMobileAPI/apprequest/doValidateOtpForRegistration",
      new URLSearchParams(payload)
    );

    if (!(data.data && data.data.responseCode === "0000")) {
      throw new Error(`Failed to validate OTP: ${data.data ? data.data.responseMsg : "Unknown error"}`);
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

    const data = await axios.post(
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
      data.data.responseMsg === "No handphone Anda sudah terdaftar sebelumnya, silahkan gunakan phone no lain"
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
      const order = await smshubIntegration.orderNumber();
      const [noHp, orderId] = order.split("|");

      // Generate registration email
      const username = faker.internet.userName();
      const email = `${username}${DOMAIN}`;
      const name = faker.person.fullName();

      await dokuRegistration.sendOtp(noHp);
      const otp = await smshubIntegration.getOtpForRegistration(orderId);
      await dokuRegistration.validateOtp(noHp, otp);

      const pin = "123123";

      const submitResult = await dokuRegistration.submitForm(noHp, email, name, otp);

      if (submitResult.success) {
        log("info", `DOKU E-Wallet | ${submitResult.message}`);
        return {
          noHp: submitResult.phone,
          email: submitResult.email,
          name: submitResult.name,
          pin,
          orderId,
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

  // Check balance
  await smshubIntegration.getBalance();

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

  console.log(`Creating ${numAccounts} DOKU accounts with concurrency: ${concurrency}...`);

  // Helper for concurrency
  async function runWithConcurrency(tasks, limit) {
    const results = [];
    let i = 0;
    async function next() {
      if (i >= tasks.length) return;
      const current = i++;
      results[current] = await tasks[current]();
      await next();
    }
    const runners = [];
    for (let j = 0; j < Math.min(limit, tasks.length); j++) {
      runners.push(next());
    }
    await Promise.all(runners);
    return results;
  }

  // Prepare account creation tasks
  const results = [];
  const tasks = Array.from({ length: numAccounts }, (_, i) => async () => {
    console.log(`\nCreating account ${i + 1}/${numAccounts}`);
    try {
      const result = await dokuRegistration.register();
      if (result) {
        // Save to file
        const formattedNoHp = result.noHp.startsWith("62") ? result.noHp.slice(2) : result.noHp;
        await fs.promises.appendFile(
          "./dokufresh.txt",
          `${formattedNoHp}|${result.pin}\n`
        );
        console.log(`Successfully created account: ${formattedNoHp}`);
        results[i] = { success: true, phone: formattedNoHp, email: result.email, name: result.name };
      } else {
        console.log(`Failed to create account ${i + 1}`);
        results[i] = { success: false, reason: "Unknown error" };
      }
    } catch (err) {
      console.log(`Failed to create account ${i + 1}: ${err.message}`);
      results[i] = { success: false, reason: err.message };
    }
    // Add delay between accounts (optional, can be removed for full speed)
    await delay(5000);
  });

  await runWithConcurrency(tasks, concurrency);

  // Print summary
  const successList = results.filter(r => r && r.success);
  const failedList = results.filter(r => r && !r.success);
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
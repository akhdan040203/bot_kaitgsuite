const puppeteer = require("puppeteer");
const axios = require("axios");
const readline = require("readline");
const fs = require("fs");

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Prompt function
const prompt = (question) => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
};

// Generate random email from API
async function getGeneratedEmail() {
  try {
    const response = await axios.get("http://localhost:5000/generate-email");
    return response.data.email;
  } catch (error) {
    console.error("Error getting generated email:", error);
    return generateRandomEmailFallback();
  }
}

// Fallback email generation
function generateRandomEmailFallback() {
  const characters = "abcdefghijklmnopqrstuvwxyz";
  const usernameLength = Math.floor(Math.random() * (10 - 7 + 1)) + 7;
  let username = "";

  for (let i = 0; i < usernameLength; i++) {
    username += characters[Math.floor(Math.random() * characters.length)];
  }

  return `${username}@premkuy.shop`;
}

// Get verification code from email
async function getEmailCode(email) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(10000); // Wait 10 seconds between attempts
      const response = await axios.get(
        `http://localhost:5000/emails?target=${email}`
      );
      const emails = response.data;

      if (emails && emails.length > 0) {
        const targetEmail = emails.find(
          (email) =>
            email.subject &&
            email.subject.toLowerCase().includes("welcome to capcut")
        );

        if (targetEmail) {
          const codeMatch = targetEmail.subject.match(/\b\d{6}\b/);
          if (codeMatch) {
            console.log(
              `Got verification code on attempt ${attempt + 1}: ${codeMatch[0]}`
            );
            return codeMatch[0];
          }
        }
      }
      console.log(`Email not found, attempt ${attempt + 1} of 5`);
    }
    console.log("Failed to get verification code after all attempts");
    return null;
  } catch (error) {
    console.error("Error getting verification code:", error);
    return null;
  }
}

// Sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Save account to file
async function saveAccountToFile(email, password) {
  try {
    const accountData = `${email} | ${password}\n`;
    fs.appendFileSync("akuncapcut.txt", accountData);
    console.log("Account saved to akuncapcut.txt");
  } catch (error) {
    console.error("Error saving account:", error);
  }
}

// Main signup process
async function signupCapcut() {
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--disable-notifications",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  try {
    const page = (await browser.pages())[0];

    // Get generated email
    const email = await getGeneratedEmail();
    console.log("Using email:", email);

    // Navigate to CapCut signup
    await page.goto("https://www.capcut.com/signup", {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Check for and accept cookies/privacy policy if present
    try {
      console.log("Checking for Accept all button...");
      await page.waitForSelector("button.lv-btn-primary span", {
        timeout: 5000,
      });
      const buttons = await page.$$("button.lv-btn-primary span");

      for (const button of buttons) {
        const buttonText = await page.evaluate((el) => el.textContent, button);
        if (buttonText.includes("Accept all")) {
          console.log("Found Accept all button, clicking it...");
          await button.click();
          await sleep(1000);
          break;
        }
      }
    } catch (error) {
      console.log("Accept all button not found or already accepted");
    }

    // Enter email
    await page.waitForSelector('input[name="signUsername"]');
    await page.type('input[name="signUsername"]', email);
    console.log("Email entered");

    // Click Continue
    await page.waitForSelector("button.lv_sign_in_panel_wide-primary-button");
    await page.click("button.lv_sign_in_panel_wide-primary-button");
    console.log("Clicked continue");

    // Enter password
    await page.waitForSelector('input[type="password"]');
    await page.type('input[type="password"]', "premkuy123");
    console.log("Password entered");

    // Click Sign up
    await page.waitForSelector("button.lv_sign_in_panel_wide-sign-in-button");
    await page.click("button.lv_sign_in_panel_wide-sign-in-button");
    console.log("Clicked sign up");

    // Enter birth year
    await page.waitForSelector("input.gate_birthday-picker-input");
    await page.type("input.gate_birthday-picker-input", "2000");
    console.log("Birth year entered");

    // Select month
    await page.waitForSelector(".gate_birthday-picker-selector");
    await page.click(".gate_birthday-picker-selector");
    await sleep(1000)
    await page.waitForSelector("li.lv-select-option");
    const months = await page.$$("li.lv-select-option");
    await months[0].click();
    console.log("Month selected");

    // Select day
    await page.waitForSelector('input[placeholder="Day"]');
    await page.click('input[placeholder="Day"]');
    await sleep(1000);
    await page.waitForSelector("li.lv-select-option");
    const days = await page.$$("li.lv-select-option");
    await days[0].click();
    console.log("Day selected");

    // Click Next
    await page.waitForSelector("button.lv_sign_in_panel_wide-birthday-next");
    await page.click("button.lv_sign_in_panel_wide-birthday-next");
    console.log("Clicked next");

    // Get verification code
    console.log("Waiting for verification code...");
    const verificationCode = await getEmailCode(email);

    if (verificationCode) {
      console.log("Entering verification code:", verificationCode);
      await page.waitForSelector('input.lv-input[maxlength="6"]');
      await page.type('input.lv-input[maxlength="6"]', verificationCode);

      // Save account
      await saveAccountToFile(email, "Premigu@123");
      console.log("Account creation completed");
    } else {
      console.log("Failed to get verification code");
    }

    await sleep(5000); // Wait to see the result
  } catch (error) {
    console.error("Error in signup process:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Main execution
async function main() {
  try {
    const accountCount = parseInt(
      await prompt("How many CapCut accounts do you want to create? ")
    );

    if (isNaN(accountCount) || accountCount <= 0) {
      console.log("Please enter a valid number greater than 0");
      rl.close();
      return;
    }

    console.log(`Starting creation of ${accountCount} accounts...`);

    for (let i = 1; i <= accountCount; i++) {
      console.log(`\n=== Creating account ${i} of ${accountCount} ===`);
      try {
        await signupCapcut();
        console.log(`Successfully created account ${i}`);
      } catch (error) {
        console.error(`Error creating account ${i}:`, error);
      }
    }

    console.log("\n=== Account creation completed ===");
    console.log(`Total accounts attempted: ${accountCount}`);
    console.log("Check akuncapcut.txt for the list of created accounts");
  } catch (error) {
    console.error("Main process error:", error);
  } finally {
    rl.close();
  }
}

// Run the script
main();

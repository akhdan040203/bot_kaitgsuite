const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "yandex.com",
  "yandex.ru",
]);

const EMAIL_RE = /^[^\s@|:;,]+@[^\s@|:;,]+\.[^\s@|:;,]+$/i;

function normalizeAccountLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return null;

  const cleaned = line.replace(/\t+/g, " ").replace(/\s+/g, " ");
  const emailMatch = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!emailMatch) return { raw: line, error: "Email tidak ditemukan" };

  const email = emailMatch[0].trim().toLowerCase();
  let password = "";
  const afterEmail = cleaned.slice(emailMatch.index + emailMatch[0].length).trim();

  if (afterEmail) {
    password = afterEmail.replace(/^[|:;, \-]+/, "").trim();
  } else {
    const beforeEmail = cleaned.slice(0, emailMatch.index).trim();
    password = beforeEmail.replace(/[|:;, \-]+$/, "").trim();
  }

  if (!password) return { raw: line, email, error: "Password kosong" };
  return { raw: line, email, password, normalized: `${email}|${password}` };
}

function validateGsuiteAccount(account) {
  if (!account || account.error) return account && account.error ? account.error : "Format invalid";
  if (!EMAIL_RE.test(account.email)) return "Email invalid";
  const domain = account.email.split("@")[1].toLowerCase();
  if (FREE_EMAIL_DOMAINS.has(domain)) return "Email gratis ditolak";
  return null;
}

function parseGsuiteInput(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicate = 0;

  for (const line of lines) {
    const account = normalizeAccountLine(line);
    const error = validateGsuiteAccount(account);
    if (error) {
      invalid.push({ raw: line, reason: error });
      continue;
    }

    const key = account.email.toLowerCase();
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    valid.push(account.normalized);
  }

  return {
    totalInput: lines.length,
    valid,
    invalid,
    duplicate,
    convertedText: valid.join("\n") + (valid.length ? "\n" : ""),
  };
}

module.exports = {
  FREE_EMAIL_DOMAINS,
  normalizeAccountLine,
  parseGsuiteInput,
  validateGsuiteAccount,
};

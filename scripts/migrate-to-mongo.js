// Migrasi data lama (data/bot/*.json) ke MongoDB. Jalankan SEKALI: node scripts/migrate-to-mongo.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoStore, connectMongo } = require("../lib/mongo-store");

const DATA_DIR = path.join(__dirname, "..", "data", "bot");

function readJson(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(`Gagal baca ${file}: ${e.message}, pakai default.`);
    return fallback;
  }
}

async function main() {
  await connectMongo();
  console.log("Tersambung ke MongoDB.");

  const users = readJson("users.json", {});
  const orders = readJson("orders.json", []);
  const settings = readJson("settings.json", null);

  await new MongoStore("users", {}).write(users);
  console.log(`✓ users  -> ${Object.keys(users).length} user`);

  await new MongoStore("orders", []).write(orders);
  console.log(`✓ orders -> ${Array.isArray(orders) ? orders.length : 0} order`);

  if (settings) {
    await new MongoStore("settings", {}).write(settings);
    console.log("✓ settings -> tersimpan");
  } else {
    console.log("• settings.json tidak ada, dilewati (akan pakai default saat bot start).");
  }

  console.log("Migrasi selesai.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Migrasi gagal:", e.message);
  process.exit(1);
});

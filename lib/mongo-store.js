const mongoose = require("mongoose");

function clone(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

let StoreModel = null;
function getModel() {
  if (StoreModel) return StoreModel;
  const schema = new mongoose.Schema(
    { _id: String, data: mongoose.Schema.Types.Mixed },
    { minimize: false, versionKey: false }
  );
  StoreModel = mongoose.models.Store || mongoose.model("Store", schema, "stores");
  return StoreModel;
}

// Drop-in pengganti JsonStore, tapi disimpan di MongoDB.
// Tiap "store" (users/orders/settings) jadi 1 dokumen { _id: name, data: <isi> }.
class MongoStore {
  constructor(name, defaultValue) {
    this.name = name;
    this.defaultValue = defaultValue;
  }

  async read() {
    const doc = await getModel().findById(this.name).lean();
    if (!doc || doc.data === undefined || doc.data === null) {
      await this.write(this.defaultValue);
      return clone(this.defaultValue);
    }
    return doc.data;
  }

  async write(value) {
    await getModel().updateOne(
      { _id: this.name },
      { $set: { data: value } },
      { upsert: true }
    );
    return value;
  }

  async update(mutator) {
    const current = await this.read();
    const next = mutator(current) || current;
    await this.write(next);
    return next;
  }
}

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI belum di-set di .env");
  if (mongoose.connection.readyState === 1) return;
  mongoose.set("strictQuery", false);
  await mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || "botkait",
    serverSelectionTimeoutMS: 15000,
  });
}

module.exports = { MongoStore, connectMongo };

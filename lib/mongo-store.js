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

  // Update ATOMIC satu elemen di dalam array `data` (mis. 1 order di store "orders").
  // Hanya menyentuh field tertentu pada 1 elemen -> TIDAK menimpa seluruh array,
  // sehingga aman dari lost-update race antar proses (bot vs worker).
  //   matchField  : nama field id elemen (mis. "id")
  //   matchValues : daftar nilai id yang diterima (mis. [123, "123"]) krn tipe bisa beda
  //   patch       : { field: value } yang akan di-$set
  //   opts.whereField + opts.whereIn : syarat tambahan (mis. status harus QUEUED/PAID)
  // Return true kalau ada elemen yang benar2 ke-update.
  async patchItem(matchField, matchValues, patch, opts = {}) {
    const values = Array.isArray(matchValues) ? matchValues : [matchValues];
    const set = {};
    for (const [key, value] of Object.entries(patch)) {
      set[`data.$[elem].${key}`] = value;
    }
    const elemCond = { [`elem.${matchField}`]: { $in: values } };
    if (opts.whereField && Array.isArray(opts.whereIn)) {
      elemCond[`elem.${opts.whereField}`] = { $in: opts.whereIn };
    }
    const res = await getModel().updateOne(
      { _id: this.name },
      { $set: set },
      { arrayFilters: [elemCond] }
    );
    return (res.modifiedCount || res.nModified || 0) > 0;
  }

  // Baca SATU key dari object `data` (mis. 1 user) pakai projection -> payload kecil & cepat.
  async readOne(key) {
    const doc = await getModel().findById(this.name, { [`data.${key}`]: 1 }).lean();
    if (!doc || !doc.data) return undefined;
    return doc.data[key];
  }

  // Set SATU key di object `data` tanpa menulis ulang seluruh dokumen -> tulis ringan.
  async setOne(key, value) {
    await getModel().updateOne(
      { _id: this.name },
      { $set: { [`data.${key}`]: value } },
      { upsert: true }
    );
    return value;
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

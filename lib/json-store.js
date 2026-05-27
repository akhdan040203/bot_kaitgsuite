const fs = require("fs");
const path = require("path");

class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      this.write(defaultValue);
    }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch (error) {
      return this.defaultValue;
    }
  }

  write(value) {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(current) || current;
    this.write(next);
    return next;
  }
}

module.exports = { JsonStore };

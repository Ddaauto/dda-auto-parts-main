const Database = require("better-sqlite3");

const db = new Database("./dda.sqlite");

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN resetToken TEXT;
  `);
  console.log("✅ resetToken added");
} catch (e) {
  console.log("⚠️ resetToken may already exist");
}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN resetTokenExpiresAt TEXT;
  `);
  console.log("✅ resetTokenExpiresAt added");
} catch (e) {
  console.log("⚠️ resetTokenExpiresAt may already exist");
}

console.log("🎉 DONE");
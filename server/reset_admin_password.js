import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const DB_PATH = process.env.DB_PATH || "./dda.sqlite";
const ADMIN_EMAIL = "ddaautoparts@gmail.com";
const NEW_PASSWORD = "Ddaauto2024";

const db = new Database(DB_PATH);

const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(ADMIN_EMAIL);
if (!user) {
  console.log("❌ No existe ese email en users:", ADMIN_EMAIL);
  process.exit(1);
}

const hash = bcrypt.hashSync(NEW_PASSWORD, 10);
db.prepare("UPDATE users SET passwordHash = ? WHERE email = ?").run(hash, ADMIN_EMAIL);

console.log("✅ Password actualizado para:", ADMIN_EMAIL);
console.log("🔑 Nuevo password:", NEW_PASSWORD);

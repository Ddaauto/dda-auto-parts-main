// server/import_customers_tsv.js
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { randomUUID } from "crypto";

function nowISO() {
  return new Date().toISOString();
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function toInt01(v) {
  const s = String(v ?? "").trim();
  if (s === "1" || s.toLowerCase() === "true" || s.toLowerCase() === "yes") return 1;
  return 0;
}

function splitName(full) {
  const s = String(full || "").trim();
  if (!s) return { firstName: "Customer", lastName: ".", businessName: "" };

  const parts = s.split(/\s+/);
  if (parts.length >= 2) return { firstName: parts[0], lastName: parts.slice(1).join(" "), businessName: "" };

  // 1 sola palabra -> lo tratamos como business
  return { firstName: s, lastName: ".", businessName: s };
}

// TSV (tab separated) + soporta que venga con comillas o espacios
function parseTSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];

  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return rows;
}

const DB_FILE = process.env.DB_PATH || "./dda.sqlite";
const TEMP_PASSWORD = process.env.IMPORT_TEMP_PASSWORD || "DDA12345";

const filePath = process.argv[2];
if (!filePath) {
  console.log("Uso: node import_customers_tsv.js <ruta-al-archivo.tsv>");
  process.exit(1);
}

const abs = path.resolve(filePath);
if (!fs.existsSync(abs)) {
  console.log("No existe el archivo:", abs);
  process.exit(1);
}

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

const text = fs.readFileSync(abs, "utf8");
const rows = parseTSV(text);

let createdCustomers = 0;
let updatedCustomers = 0;
let createdUsers = 0;
let skippedNoEmail = 0;

const hash = bcrypt.hashSync(TEMP_PASSWORD, 10);

const tx = db.transaction(() => {
  for (const r of rows) {
    const email = normEmail(r.Email || r.email);
    if (!email) {
      skippedNoEmail++;
      continue;
    }

    const name = r.Name || r.name || "";
    const { firstName, lastName, businessName } = splitName(name);

    const customer = {
      firstName,
      lastName,
      businessName: String(businessName || "").trim(),
      phone: String(r.Phone || "").trim(),
      email,
      address: String(r.Address || "").trim(),
      street: String(r.Address || "").trim(),
      apt: "",
      city: String(r.City || "").trim(),
      state: String(r.State || "").trim(),
      zip: String(r.Zip || "").trim(),
      resaleTaxNumber: String(r.TaxNumber || "").trim(),
      freeDelivery: toInt01(r.freeDelivery),
    };

    // upsert customer por email
    const existingCust = db.prepare("SELECT id FROM customers WHERE lower(email)=? LIMIT 1").get(email);
    let customerId;

    if (existingCust?.id) {
      customerId = existingCust.id;
      db.prepare(
        `UPDATE customers SET
          firstName=?, lastName=?, businessName=?, phone=?, address=?, street=?, apt=?,
          city=?, state=?, zip=?, resaleTaxNumber=?, freeDelivery=?
         WHERE id=?`
      ).run(
        customer.firstName,
        customer.lastName,
        customer.businessName,
        customer.phone,
        customer.address,
        customer.street,
        customer.apt,
        customer.city,
        customer.state,
        customer.zip,
        customer.resaleTaxNumber,
        customer.freeDelivery,
        customerId
      );
      updatedCustomers++;
    } else {
      customerId = "cus_" + randomUUID();
      db.prepare(
        `INSERT INTO customers (
          id, firstName, lastName, businessName, phone, email, address, createdAt,
          resaleTaxNumber, freeDelivery, street, apt, city, state, zip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        customerId,
        customer.firstName,
        customer.lastName,
        customer.businessName,
        customer.phone,
        customer.email,
        customer.address,
        nowISO(),
        customer.resaleTaxNumber,
        customer.freeDelivery,
        customer.street,
        customer.apt,
        customer.city,
        customer.state,
        customer.zip
      );
      createdCustomers++;
    }

    // upsert user por email (no cambia password si ya existe)
    const existingUser = db.prepare("SELECT id, customerId FROM users WHERE lower(email)=? LIMIT 1").get(email);
    if (existingUser?.id) {
      if (existingUser.customerId !== customerId) {
        db.prepare("UPDATE users SET customerId=? WHERE id=?").run(customerId, existingUser.id);
      }
    } else {
      db.prepare(
        `INSERT INTO users (id, email, passwordHash, customerId, role, createdAt)
         VALUES (?, ?, ?, ?, 'customer', ?)`
      ).run("usr_" + randomUUID(), email, hash, customerId, nowISO());
      createdUsers++;
    }
  }
});

tx();

console.log("✅ Import terminado");
console.log({ createdCustomers, updatedCustomers, createdUsers, skippedNoEmail });
console.log("Temp password para nuevos usuarios:", TEMP_PASSWORD);
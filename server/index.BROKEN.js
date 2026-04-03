// server/index.js
// ✅ SOLO CAMBIOS NECESARIOS para que Stripe funcione automático por WEBHOOK
// - 1) Webhook /stripe/webhook con express.raw (antes de express.json)
// - 2) Quitar duplicados de cors/json
// - 3) create-payment-intent ahora recibe orderId y lo pone en metadata (para que webhook marque PAID)
// - 4) (IMPORTANTE) Mover body parsers (json/urlencoded) DESPUÉS de montar el webhook

import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import multer from "multer";
import path from "path";
import fs from "fs";
import { sendEmail } from "./mailer.js";
import { generateInvoicePDF } from "./invoicePdf.js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
console.log("✅ Stripe loaded:", !!process.env.STRIPE_SECRET_KEY);

const app = express();

app.use((req, res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});

app.use("/uploads", express.static("uploads"));
app.use("/invoices", express.static("invoices")); // ✅ ESTA ES LA CLAVE

// ===== CORS (deja SOLO uno) =====
app.use(
  cors({
    origin: ["http://localhost:5174", "http://localhost:5175"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

const PORT = Number(process.env.PORT || 5177);
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// ✅ IMPORTANT: a prueba de errores (siempre apunta al dda.sqlite dentro de /server)
const DB_PATH = process.env.DB_PATH || path.resolve("./dda.sqlite");

// ===== DB =====
const db = new Database(DB_PATH);

// =====================================================
// STRIPE WEBHOOK (Card auto -> PAID -> PDF + Email)
// IMPORTANT: must be BEFORE express.json()
// =====================================================
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ Como tú estás usando PaymentIntent, escuchamos payment_intent.succeeded
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;

      const orderId = String(pi?.metadata?.orderId || "");
      if (!orderId) return res.json({ ok: true });

      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
      if (!order) return res.json({ ok: true });

      const alreadyPaid =
        String(order.paymentStatus || "").toUpperCase() === "PAID" ||
        String(order.status || "").toUpperCase() === "PAID";

      if (!alreadyPaid) {
        db.prepare(`
          UPDATE orders
          SET paymentStatus='PAID',
              status='PAID',
              paidAt=?
          WHERE id=?
        `).run(new Date().toISOString(), orderId);
      }

      const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

      // Email del cliente (igual que tu flujo Zelle confirm)
      let customerEmail = "";
      const cust = db.prepare("SELECT email FROM customers WHERE id = ?").get(updated.customerId);
      if (cust?.email) customerEmail = String(cust.email || "").trim();

      if (!customerEmail) {
        try {
          const snap = JSON.parse(updated.customerSnapshot || "{}");
          customerEmail = String(snap.email || "").trim();
        } catch {}
      }

      if (!customerEmail) return res.json({ ok: true });

      // Evita doble envío si existen columnas invoiceSentAt/invoiceSentTo
      let shouldSend = true;
      try {
        const row = db.prepare("SELECT invoiceSentAt FROM orders WHERE id=?").get(orderId);
        if (row?.invoiceSentAt) shouldSend = false;
      } catch {}

      if (shouldSend) {
        const pdfPath = await generateInvoicePDF(updated);
        const pdfBase64 = fs.readFileSync(pdfPath, { encoding: "base64" });

        await sendEmail({
          to: customerEmail,
          subject: `Invoice ${updated.invoiceId} — DDA Auto Parts`,
          html: `<p>Your payment was successful. Invoice attached.</p>`,
          attachments: [
            {
              content: pdfBase64,
              filename: `${updated.invoiceId}.pdf`,
              type: "application/pdf",
              disposition: "attachment",
            },
          ],
        });

        // marcar que se envió (si columnas existen)
        try {
          db.prepare(`
            UPDATE orders
            SET invoiceSentAt = ?, invoiceSentTo = ?
            WHERE id = ?
          `).run(new Date().toISOString(), customerEmail, orderId);
        } catch {}
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ Stripe webhook handler error:", e);
    return res.status(500).send("Webhook handler failed");
  }
});

// =====================================================
// Body parsers (DESPUÉS del webhook)
// =====================================================
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================================================
// SHIPPING + TAX SETTINGS
// =====================================================
const ORIGIN_ZIP = "33010";
const UBER_MAX_MILES = 20;

// =====================================================
// CREATE TABLES (safe)
// =====================================================
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  firstName TEXT NOT NULL,
  lastName TEXT NOT NULL,
  businessName TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  address TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  customerId TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  createdAt TEXT NOT NULL,
  FOREIGN KEY(customerId) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  invoiceId TEXT NOT NULL UNIQUE,
  customerId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  paymentMethod TEXT DEFAULT 'Zelle',
  paymentStatus TEXT DEFAULT 'Paid',

  subtotal REAL NOT NULL,
  salesTax REAL NOT NULL,
  discounts REAL NOT NULL,
  total REAL NOT NULL,

  vehicleLabel TEXT DEFAULT '',
  vin TEXT DEFAULT '',
  year TEXT DEFAULT '',
  make TEXT DEFAULT '',
  model TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  trim TEXT DEFAULT '',

  customerSnapshot TEXT NOT NULL,
  itemsJson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PAID'
);

CREATE INDEX IF NOT EXISTS idx_orders_customerId ON orders(customerId);
`);

// ===== Migrations (add columns if missing) =====
function columnExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === col);
}
function addColumn(table, colDef) {
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
}

// customers
if (!columnExists("customers", "resaleTaxNumber")) addColumn("customers", "resaleTaxNumber TEXT DEFAULT ''");
if (!columnExists("customers", "freeDelivery")) addColumn("customers", "freeDelivery INTEGER NOT NULL DEFAULT 0");

// (recomendado para que tu App.jsx funcione con street/city/state/zip)
if (!columnExists("customers", "street")) addColumn("customers", "street TEXT DEFAULT ''");
if (!columnExists("customers", "apt")) addColumn("customers", "apt TEXT DEFAULT ''");
if (!columnExists("customers", "city")) addColumn("customers", "city TEXT DEFAULT ''");
if (!columnExists("customers", "state")) addColumn("customers", "state TEXT DEFAULT ''");
if (!columnExists("customers", "zip")) addColumn("customers", "zip TEXT DEFAULT ''");

// orders
if (!columnExists("orders", "orderNumber")) addColumn("orders", "orderNumber TEXT DEFAULT ''");
if (!columnExists("orders", "shipping")) addColumn("orders", "shipping REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "tax")) addColumn("orders", "tax REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "grandTotal")) addColumn("orders", "grandTotal REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "orderSeq")) addColumn("orders", "orderSeq INTEGER NOT NULL DEFAULT 0");
if (!columnExists("orders", "confirmedBy")) addColumn("orders", "confirmedBy TEXT DEFAULT ''");
if (!columnExists("orders", "confirmedAt")) addColumn("orders", "confirmedAt TEXT DEFAULT ''");
if (!columnExists("orders", "paidAt")) addColumn("orders", "paidAt TEXT DEFAULT ''");

// optional invoice display
if (!columnExists("orders", "shippingCarrier")) addColumn("orders", "shippingCarrier TEXT DEFAULT ''");
if (!columnExists("orders", "shippingService")) addColumn("orders", "shippingService TEXT DEFAULT ''");
if (!columnExists("orders", "shippingEta")) addColumn("orders", "shippingEta TEXT DEFAULT ''");

// store chosen method meta
if (!columnExists("orders", "shippingMethod")) addColumn("orders", "shippingMethod TEXT DEFAULT ''");
if (!columnExists("orders", "shippingIsEstimated"))
  addColumn("orders", "shippingIsEstimated INTEGER NOT NULL DEFAULT 0");
if (!columnExists("orders", "shippingMeta")) addColumn("orders", "shippingMeta TEXT DEFAULT ''");

// zip_geo table
db.exec(`
CREATE TABLE IF NOT EXISTS zip_geo (
  zip TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
`);

// =====================================================
// HELPERS
// =====================================================
const nowISO = () => new Date().toISOString();
const uid = (p) =>
  `${p}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`.toLowerCase();

function makeInvoiceId() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `INV-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random()
    .toString(16)
    .slice(2, 6)
    .toUpperCase()}`;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =====================================================
// SHIPPING (Uber + Free Delivery) + TAX
// =====================================================
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613; // miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function uberEstimateFromMiles(miles) {
  const min = 10;
  const max = 20;
  const start = 5;
  const end = 20;
  if (miles <= start) return min;
  const t = (miles - start) / (end - start);
  return clamp(min + t * (max - min), min, max);
}

function extractZipFromCustomer(customer) {
  const z1 = String(customer?.zip || "").trim();
  if (/^\d{5}$/.test(z1)) return z1;

  const addr = customer?.address;
  if (!addr) return null;

  if (typeof addr === "object") {
    const z = String(addr.zip || "").trim();
    return /^\d{5}$/.test(z) ? z : null;
  }

  const s = String(addr);
  try {
    const obj = JSON.parse(s);
    const z = String(obj?.zip || "").trim();
    if (/^\d{5}$/.test(z)) return z;
  } catch {}

  const m = s.match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

function computeShippingOptionsAdvanced({ items, customer }) {
  const totalWeightLb = (items || []).reduce((s, it) => {
    const w = Number(it.weightLb || 1);
    const q = Number(it.qty || 1);
    return s + Math.max(0.1, w) * Math.max(1, q);
    }, 0);

  const base = Math.max(6, totalWeightLb * 1.8);

  const options = [
    { id: "usps", carrier: "USPS", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 6).toFixed(2)), isEstimated: 0, meta: null },
    { id: "ups", carrier: "UPS", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 14).toFixed(2)), isEstimated: 0, meta: null },
    { id: "fedex", carrier: "FedEx", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 18).toFixed(2)), isEstimated: 0, meta: null },
  ];

  const destZip = extractZipFromCustomer(customer);
  if (destZip) {
    const origin = db.prepare("SELECT lat, lon FROM zip_geo WHERE zip = ?").get(ORIGIN_ZIP);
    const dest = db.prepare("SELECT lat, lon FROM zip_geo WHERE zip = ?").get(destZip);

    if (origin && dest) {
      const miles = haversineMiles(origin.lat, origin.lon, dest.lat, dest.lon);
      if (miles <= UBER_MAX_MILES) {
        const est = Number(uberEstimateFromMiles(miles).toFixed(2));
        options.push({
          id: "uber",
          carrier: "Uber",
          service: "Same-day local (Estimated)",
          eta: "Same-day",
          amount: est,
          isEstimated: 1,
          meta: {
            miles: Number(miles.toFixed(1)),
            originZip: ORIGIN_ZIP,
            destZip,
            rangeMin: 10,
            rangeMax: 20,
          },
        });
      }
    }
  }

  if (Number(customer?.freeDelivery || 0) === 1) {
    options.push({
      id: "free_delivery",
      carrier: "Free Delivery",
      service: "Approved customer",
      eta: "1–3 (local)",
      amount: 0,
      isEstimated: 0,
      meta: null,
    });
  }

  return { totalWeightLb: Number(totalWeightLb.toFixed(2)), options };
}

function calcTax(subtotal, customer) {
  const hasResale = !!String(customer?.resaleTaxNumber || "").trim();
  const TAX_RATE = 0.07;
  const tax = hasResale ? 0 : subtotal * TAX_RATE;
  return Number(tax.toFixed(2));
}

// =====================================================
// UPLOADS
// =====================================================
const uploadsDir = path.resolve("./uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_, __, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_, file, cb) {
    const safe = String(file.originalname || "img")
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
});

app.use("/uploads", express.static(uploadsDir));

app.post("/upload", authRequired, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing file" });
  const url = `http://localhost:${PORT}/uploads/${req.file.filename}`;
  return res.json({ url });
});

// =====================================================
// AUTH
// =====================================================
app.post("/auth/register", (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      phone = "",
      street = "",
      apt = "",
      city = "",
      state = "",
      zip = "",
      address = "",
      businessName = "",
      resaleTaxNumber = "",
    } = req.body || {};

    const em = String(email || "").trim().toLowerCase();
    if (!firstName || !lastName || !em || !password || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(em);
    if (exists) return res.status(409).json({ error: "Email already exists" });

    const customerId = uid("cus");
    const userId = uid("usr");

    const addrText =
      street && city && state && zip
        ? `${street}${apt ? `, ${apt}` : ""}, ${city}, ${state} ${zip}`.trim()
        : String(address || "").trim();

    db.prepare(
      `INSERT INTO customers (
        id, firstName, lastName, businessName, phone, email,
        address, street, apt, city, state, zip,
        resaleTaxNumber, freeDelivery, createdAt
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      customerId,
      String(firstName).trim(),
      String(lastName).trim(),
      String(businessName || "").trim(),
      String(phone || "").trim(),
      em,
      addrText,
      String(street || "").trim(),
      String(apt || "").trim(),
      String(city || "").trim(),
      String(state || "").trim().toUpperCase(),
      String(zip || "").trim(),
      String(resaleTaxNumber || "").trim(),
      0,
      nowISO()
    );

    const passwordHash = bcrypt.hashSync(String(password), 10);

    db.prepare(
      `INSERT INTO users (id, email, passwordHash, customerId, role, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, em, passwordHash, customerId, "customer", nowISO());

    const token = signToken({ userId, customerId, role: "customer", email: em });

    return res.json({
      token,
      user: { id: userId, email: em, role: "customer" },
      customer: db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId),
    });
  } catch (e) {
    return res.status(500).json({ error: "Register failed" });
  }
});

app.post("/auth/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    const em = String(email || "").trim().toLowerCase();
    if (!em || !password) return res.status(400).json({ error: "Missing email/password" });

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(em);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = bcrypt.compareSync(String(password), String(user.passwordHash));
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken({
      userId: user.id,
      customerId: user.customerId,
      role: user.role,
      email: user.email,
    });

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(user.customerId);

    return res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      customer,
    });
  } catch {
    return res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", authRequired, (req, res) => {
  const { userId, customerId } = req.user;
  const user = db
    .prepare("SELECT id, email, role, customerId, createdAt FROM users WHERE id = ?")
    .get(userId);

  if (!user) return res.status(404).json({ error: "User not found" });

  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
  return res.json({ user, customer });
});

// =====================================================
// CUSTOMER (My Account)
// =====================================================
app.get("/customers/me", authRequired, (req, res) => {
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
  return res.json(c);
});

app.put("/customers/me", authRequired, (req, res) => {
  const cur = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
  if (!cur) return res.status(404).json({ error: "Customer not found" });

  const {
    firstName,
    lastName,
    phone,
    businessName,
    resaleTaxNumber,
    address,
    street,
    apt,
    city,
    state,
    zip,
  } = req.body || {};

  const streetV = String(street ?? cur.street ?? "").trim();
  const aptV = String(apt ?? cur.apt ?? "").trim();
  const cityV = String(city ?? cur.city ?? "").trim();
  const stateV = String(state ?? cur.state ?? "").trim().toUpperCase();
  const zipV = String(zip ?? cur.zip ?? "").trim();

  const addrText =
    streetV && cityV && stateV && zipV
      ? `${streetV}${aptV ? `, ${aptV}` : ""}, ${cityV}, ${stateV} ${zipV}`.trim()
      : String(address ?? cur.address ?? "").trim();

  db.prepare(
    `UPDATE customers SET
      firstName=?,
      lastName=?,
      phone=?,
      businessName=?,
      resaleTaxNumber=?,
      address=?,
      street=?,
      apt=?,
      city=?,
      state=?,
      zip=?
    WHERE id=?`
  ).run(
    String(firstName ?? cur.firstName).trim(),
    String(lastName ?? cur.lastName).trim(),
    String(phone ?? cur.phone).trim(),
    String(businessName ?? cur.businessName).trim(),
    String(resaleTaxNumber ?? cur.resaleTaxNumber).trim(),
    addrText,
    streetV,
    aptV,
    cityV,
    stateV,
    zipV,
    req.user.customerId
  );

  const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
  return res.json(updated);
});

// =====================================================
// STRIPE: Create Payment Intent (Card)
// ✅ CAMBIO MINIMO: ahora requiere orderId y lo pone en metadata.orderId
// =====================================================
app.post("/stripe/create-payment-intent", authRequired, async (req, res) => {
  try {
    const { orderId = "", items = [], selectedShippingId = "" } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ ok: false, error: "Missing orderId (create /orders first)" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Cart is empty" });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
    if (!customer) return res.status(404).json({ ok: false, error: "Customer not found" });

    const cleanItems = items.map((it) => ({
      id: String(it.id || ""),
      name: String(it.name || ""),
      sku: String(it.sku || ""),
      mpn: String(it.mpn || ""),
      brand: String(it.brand || ""),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));

    const subtotal = Number(cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2));

    const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });
    const chosen = options.find((o) => o.id === selectedShippingId);
    if (!chosen) {
      const allowed = options.map((o) => o.id).join(", ");
      return res.status(400).json({ ok: false, error: `Shipping method not allowed. Allowed: ${allowed}` });
    }

    const shippingNum = Math.max(0, Number(chosen.amount || 0));
    const taxNum = calcTax(subtotal, customer);
    const grandTotal = Number((subtotal + taxNum + shippingNum).toFixed(2));
    const amountCents = Math.round(grandTotal * 100);

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: String(orderId),
        customerId: String(req.user.customerId),
        shippingMethod: String(chosen.id || ""),
      },
    });

    return res.json({
      ok: true,
      clientSecret: intent.client_secret,
      amount: grandTotal,
    });
  } catch (e) {
    console.error("❌ create-payment-intent error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =====================================================
// STRIPE: Confirm Payment (Card)  (lo dejamos, no rompe nada)
// =====================================================
app.post("/stripe/confirm-payment", authRequired, async (req, res) => {
  try {
    const { paymentIntentId, items = [], selectedShippingId = "", vehicle = {} } = req.body || {};

    if (!paymentIntentId) {
      return res.status(400).json({ ok: false, error: "Missing paymentIntentId" });
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== "succeeded") {
      return res.status(400).json({ ok: false, error: "Payment not completed" });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
    if (!customer) return res.status(404).json({ ok: false, error: "Customer not found" });

    const cleanItems = items.map((it) => ({
      id: String(it.id || ""),
      name: String(it.name || ""),
      sku: String(it.sku || ""),
      mpn: String(it.mpn || ""),
      brand: String(it.brand || ""),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));

    const subtotal = Number(cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2));

    const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });
    const chosen = options.find((o) => o.id === selectedShippingId);
    if (!chosen) {
      return res.status(400).json({ ok: false, error: "Invalid shipping method" });
    }

    const shippingNum = Math.max(0, Number(chosen.amount || 0));
    const taxNum = calcTax(subtotal, customer);
    const grandTotal = Number((subtotal + taxNum + shippingNum).toFixed(2));

    const orderId = uid("ord");
    const invoiceId = makeInvoiceId();
    const seq = nextOrderSeq();
    const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

    db.prepare(`
      INSERT INTO orders (
        id, invoiceId, orderNumber, orderSeq,
        customerId, createdAt, paymentMethod, paymentStatus,
        subtotal, tax, shipping, grandTotal,
        shippingMethod,
        customerSnapshot, itemsJson, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      invoiceId,
      orderNumber,
      seq,
      req.user.customerId,
      nowISO(),
      "Card",
      "PAID",
      subtotal,
      taxNum,
      shippingNum,
      grandTotal,
      chosen.id,
      JSON.stringify(customer),
      JSON.stringify(cleanItems),
      "PAID"
    );

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

    const pdfPath = await generateInvoicePDF(order);
    const pdfBase64 = fs.readFileSync(pdfPath, { encoding: "base64" });

    await sendEmail({
      to: customer.email,
      subject: `Invoice ${order.invoiceId} — DDA Auto Parts`,
      html: `<p>Your payment was successful. Invoice attached.</p>`,
      attachments: [
        {
          content: pdfBase64,
          filename: `${order.invoiceId}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });

    return res.json({ ok: true, order });
  } catch (e) {
    console.error("❌ confirm-payment error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =====================================================
// SHIPPING QUOTE
// =====================================================
app.post("/shipping/quote", authRequired, (req, res) => {
  try {
    const { items = [] } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No items" });

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const { totalWeightLb, options } = computeShippingOptionsAdvanced({ items, customer });

    const warnings = [];
    const destZip = extractZipFromCustomer(customer);
    if (!destZip) warnings.push("No ZIP found in customer profile/address. Uber may not show.");

    // ===== ADD FREE DELIVERY (admin authorized) =====
    if (customer?.allowFreeDelivery) {
      (options || []).push({
        id: "free_delivery",
        carrier: "Local",
        service: "Free Delivery",
        amount: 0,
        eta: "Same day / next day",
      });
    }
    // ==============================================

    return res.json({ weightLb: totalWeightLb, options, warnings });
  } catch (e) {
    return res.status(500).json({ error: "Quote failed" });
  }
});

app.get("/me/local-eligibility", authRequired, (req, res) => {
  try {
    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const { options } = computeShippingOptionsAdvanced({ items: [], customer });
    const isLocal = options.some((o) => o.id === "uber" || o.id === "free_delivery");
    return res.json({ isLocal });
  } catch (e) {
    return res.status(500).json({ error: "local-eligibility failed" });
  }
});

// =====================================================
// ORDERS
// =====================================================
function nextOrderSeq() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const row = db.prepare("SELECT value FROM meta WHERE key='orderSeq'").get();
  const cur = row ? Number(row.value) : 0;
  const next = cur + 1;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('orderSeq', ?)").run(String(next));
  return next;
}

app.post("/orders", authRequired, (req, res) => {
  try {
    const { items = [], paymentMethod = "Zelle", vehicle = {}, selectedShippingId = "" } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const cleanItems = items.map((it) => ({
      id: String(it.id || ""),
      name: String(it.name || ""),
      sku: String(it.sku || ""),
      mpn: String(it.mpn || ""),
      brand: String(it.brand || ""),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));

    const subtotal = Number(cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2));

    const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });

    const chosen = options.find((o) => o.id === selectedShippingId);
    if (!chosen) {
      const allowed = options.map((o) => o.id).join(", ");
      return res.status(400).json({ error: `Shipping method not allowed. Allowed: ${allowed}` });
    }

    // ✅ Payment validation: Zelle only allowed if shipping is Uber / Free Delivery
    const pm = String(paymentMethod || "Zelle").toLowerCase();
    const isZelle = pm === "zelle";
    const shipId = String(chosen.id || "").toLowerCase();

    if (isZelle && !["uber", "free_delivery"].includes(shipId)) {
      return res.status(400).json({
        error: "Zelle is only available for local deliveries (Uber / Free Delivery).",
      });
    }

    const shippingNum = Math.max(0, Number(chosen.amount || 0));
    const taxNum = calcTax(subtotal, customer);
    const discounts = 0;
    const grandTotal = Number((subtotal + taxNum + shippingNum - discounts).toFixed(2));

    const pm2 = String(paymentMethod || "Card").toLowerCase();

    let paymentStatus = pm2 === "zelle" ? "PENDING_ADMIN" : "PENDING_STRIPE";

    // ✅ Stripe ya cobrado desde frontend
    if (pm2 === "card" && String(req.body?.paymentStatusOverride || "") === "PAID") {
      paymentStatus = "PAID";
    }

    const orderStatus = paymentStatus === "PAID" ? "PAID" : "PENDING";

    const orderId = uid("ord");
    const invoiceId = makeInvoiceId();

    const seq = nextOrderSeq();
    const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

    const vehicleLabel = String(vehicle.label || "").trim();

    db.prepare(
      `INSERT INTO orders (
        id, invoiceId, orderNumber, orderSeq,
        customerId, createdAt, paymentMethod, paymentStatus,
        subtotal, salesTax, discounts, total,
        tax, shipping, grandTotal,
        shippingCarrier, shippingService, shippingEta,
        shippingMethod, shippingIsEstimated, shippingMeta,
        vehicleLabel, vin, year, make, model, engine, trim,
        customerSnapshot, itemsJson, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      orderId,
      invoiceId,
      orderNumber,
      seq,
      req.user.customerId,
      nowISO(),
      String(paymentMethod || "Card"),
      paymentStatus,
      subtotal,
      0,
      discounts,
      subtotal,
      taxNum,
      shippingNum,
      grandTotal,
      String(chosen.carrier || ""),
      String(chosen.service || ""),
      String(chosen.eta || ""),
      String(chosen.id || ""),
      Number(chosen.isEstimated ? 1 : 0),
      chosen.meta ? JSON.stringify(chosen.meta) : "",
      vehicleLabel,
      String(vehicle.vin || ""),
      String(vehicle.year || ""),
      String(vehicle.make || ""),
      String(vehicle.model || ""),
      String(vehicle.engine || ""),
      String(vehicle.trim || ""),
      JSON.stringify(customer),
      JSON.stringify(cleanItems),
      orderStatus
    );

    const created = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    return res.json(created);
  } catch (e) {
    console.error("❌ /orders error:", e);
    return res.status(500).json({
      error: "Create order failed",
      detail: String(e?.message || e),
    });
  }
});

app.get("/orders/me", authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, invoiceId, orderNumber, createdAt, grandTotal, paymentMethod, paymentStatus, status
       FROM orders WHERE customerId = ? ORDER BY createdAt DESC`
    )
    .all(req.user.customerId);
  return res.json(rows);
});

app.get("/orders/:id", authRequired, (req, res) => {
  const id = String(req.params.id || "");
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Order not found" });
  if (row.customerId !== req.user.customerId) return res.status(403).json({ error: "Forbidden" });
  return res.json(row);
});

// =====================================================
// ADMIN: toggle Free Delivery
// =====================================================
app.patch("/admin/customers/:id/free-delivery", authRequired, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const customerId = String(req.params.id || "");
  const enabled = req.body?.enabled ? 1 : 0;

  db.prepare("UPDATE customers SET freeDelivery = ? WHERE id = ?").run(enabled, customerId);
  res.json({ ok: true, customerId, freeDelivery: enabled });
});

// =====================================================
// VIN
// =====================================================
app.get("/vin/:vin", async (req, res) => {
  try {
    const v = String(req.params.vin || "").trim().toUpperCase();
    if (v.length !== 17) return res.status(400).json({ error: "VIN must be 17 characters" });

    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${v}?format=json`;
    const r = await fetch(url);
    const j = await r.json();

    const pick = (name) => {
      const hit = (j?.Results || []).find(
        (x) => String(x.Variable || "").toLowerCase() === String(name).toLowerCase()
      );
      return hit?.Value || "";
    };

    const year = pick("Model Year");
    const make = pick("Make");
    const model = pick("Model");
    const engine = pick("Displacement (L)") || "";
    const trim = pick("Trim") || pick("Series") || "";

    return res.json({
      year: year || "",
      make: make || "",
      model: model || "",
      engine: engine ? `${engine}L` : "",
      trim: trim || "",
    });
  } catch {
    return res.status(500).json({ error: "VIN lookup failed" });
  }
});
// =====================================================
// STRIPE: Checkout Session (Card) -> redirects to Stripe
// =====================================================
app.post("/stripe/create-checkout-session", authRequired, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(String(orderId));
    if (!order) return res.status(404).json({ ok: false, error: "Order not found" });

    const amountCents = Math.round(Number(order.grandTotal || 0) * 100);
    if (!amountCents || amountCents < 50) {
      return res.status(400).json({ ok: false, error: "Invalid order total" });
    }

    const cust = db.prepare("SELECT email FROM customers WHERE id = ?").get(order.customerId);
    const customerEmail = String(cust?.email || "").trim() || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: customerEmail,

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `DDA Auto Parts ${order.orderNumber || order.invoiceId}`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],

      // 🔑 CLAVE: para que tu webhook encuentre y marque la orden PAID
      payment_intent_data: {
        metadata: {
          orderId: String(order.id),
          customerId: String(order.customerId),
        },
      },

      success_url: `${process.env.FRONTEND_URL || "http://localhost:5174"}/account`,
      cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5174"}/account`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("❌ create-checkout-session error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true, port: PORT }));

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📦 DB: ${DB_PATH}`);
  console.log(`🖼️ Uploads: http://localhost:${PORT}/uploads/...`);
});

// ===== ADMIN: LISTAR ZELLE PENDIENTES =====
app.get("/admin/orders/zelle-pending", authRequired, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const rows = db.prepare(`
      SELECT * FROM orders
      WHERE LOWER(COALESCE(paymentMethod,'')) = 'zelle'
        AND UPPER(COALESCE(paymentStatus,'')) != 'PAID'
      ORDER BY id DESC
    `).all();

    res.json({ ok: true, orders: rows });
  } catch (e) {
    console.error("zelle-pending error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===== ADMIN: CONFIRMAR PAGO ZELLE =====
app.post("/admin/orders/:id/confirm-zelle", authRequired, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const { id } = req.params;

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found" });

    if (String(order.paymentMethod || "").toLowerCase() !== "zelle") {
      return res.status(400).json({ ok: false, error: "Not a Zelle order" });
    }

    const nowIso = new Date().toISOString();
    const confirmedBy = String(req.user.email || "");

    db.prepare(`
      UPDATE orders
      SET paymentStatus = 'PAID',
          status = 'PAID',
          confirmedBy = ?,
          confirmedAt = ?
      WHERE id = ?
    `).run(confirmedBy, nowIso, id);

    const updated = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);

    let customerEmail = "";
    const cust = db.prepare(`SELECT email FROM customers WHERE id = ?`).get(updated.customerId);
    if (cust?.email) customerEmail = String(cust.email || "").trim();

    if (!customerEmail) {
      try {
        const snap = JSON.parse(updated.customerSnapshot || "{}");
        customerEmail = String(snap.email || "").trim();
      } catch {}
    }

    if (!customerEmail) {
      return res.status(400).json({
        ok: false,
        error: "Customer email not found (customers.email and snapshot.email empty)",
      });
    }

    const subject = `Payment confirmed — Invoice ${updated.invoiceId} (DDA Auto Parts)`;

    const text = `Thank you for your order!
Payment confirmed for invoice ${updated.invoiceId}.
Order #: ${updated.orderNumber}

Total: $${Number(updated.grandTotal || updated.total || 0).toFixed(2)}

You can view your invoice in your account.`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
        <h2 style="margin:0 0 10px">Payment confirmed ✅</h2>
        <p style="margin:0 0 12px">Thank you for your order at <b>DDA Auto Parts</b>.</p>
        <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
          <p style="margin:0 0 6px"><b>Invoice:</b> ${updated.invoiceId}</p>
          <p style="margin:0 0 6px"><b>Order #:</b> ${updated.orderNumber}</p>
          <p style="margin:0"><b>Total:</b> $${Number(updated.grandTotal || updated.total || 0).toFixed(2)}</p>
        </div>
        <p style="margin-top:12px;color:#6b7280;font-size:12px">If you have questions, reply to this email.</p>
      </div>
    `;

    const pdfPath = await generateInvoicePDF(updated);
    const pdfBase64 = fs.readFileSync(pdfPath, { encoding: "base64" });

    await sendEmail({
      to: customerEmail,
      subject,
      html: html + `<p style="margin-top:12px">Your invoice PDF is attached.</p>`,
      text: text + `\n\nInvoice PDF attached.`,
      attachments: [
        {
          content: pdfBase64,
          filename: `${updated.invoiceId}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });

    try {
      db.prepare(`
        UPDATE orders
        SET invoiceSentAt = ?, invoiceSentTo = ?
        WHERE id = ?
      `).run(new Date().toISOString(), customerEmail, id);
    } catch {}

    return res.json({ ok: true, order: updated, emailedTo: customerEmail });
  } catch (e) {
    console.error("confirm-zelle error:", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

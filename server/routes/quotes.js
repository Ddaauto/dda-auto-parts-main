
import { Router } from "express";
import crypto from "crypto";
// Secure customer quote approval links
export default function createQuotesRouter(db, authRequired) {
  const router = Router();

 

  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      quoteNumber TEXT NOT NULL UNIQUE,
      customerName TEXT NOT NULL,
      customerEmail TEXT DEFAULT '',
      itemsJson TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      shipping REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      expiresAt TEXT,
     approvalTokenHash TEXT, 
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

const quoteColumns = db.prepare("PRAGMA table_info(quotes)").all();

if (!quoteColumns.some((column) => column.name === "expiresAt")) {
  db.exec("ALTER TABLE quotes ADD COLUMN expiresAt TEXT");
}

if (!quoteColumns.some((column) => column.name === "approvalTokenHash")) {
  db.exec("ALTER TABLE quotes ADD COLUMN approvalTokenHash TEXT");
}

  function calculate(body) {
    const items = body.items;

    if (!Array.isArray(items) || !items.length) {
      throw new Error("At least one item is required");
    }

    let subtotal = 0;

    const cleanItems = items.map((item) => {
      const name = String(item.name || "").trim();
      const qty = Number(item.qty);
      const price = Number(item.price);

      if (!name || !Number.isInteger(qty) || qty <= 0 ||
          !Number.isFinite(price) || price < 0) {
        throw new Error("Invalid quote item");
      }

      subtotal += qty * price;

      return {
        name,
        sku: String(item.sku || ""),
        qty,
        price
      };
    });

    const tax = Number(body.tax ?? 0);
    const shipping = Number(body.shipping ?? 0);

    if (![tax, shipping].every(
      n => Number.isFinite(n) && n >= 0
    )) {
      throw new Error("Invalid tax or shipping");
    }

    subtotal = Number(subtotal.toFixed(2));

    return {
      itemsJson: JSON.stringify(cleanItems),
      subtotal,
      tax,
      shipping,
      total: Number((subtotal + tax + shipping).toFixed(2))
    };
  }
// PUBLIC CUSTOMER QUOTE ROUTES
  router.get("/public/:token", (req, res) => {
  const token = String(req.params.token || "");

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(404).json({ error: "Quote not found" });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const quote = db.prepare(`
    SELECT quoteNumber, customerName, itemsJson,
           subtotal, tax, shipping, total,
           notes, status, expiresAt
    FROM quotes
    WHERE approvalTokenHash = ?
  `).get(tokenHash);

  if (!quote) {
    return res.status(404).json({ error: "Quote not found" });
  }

  const expired = quote.expiresAt &&
    new Date(quote.expiresAt).getTime() <= Date.now();

  res.json({
    ...quote,
    items: JSON.parse(quote.itemsJson),
    itemsJson: undefined,
    status: expired && quote.status === "SENT"
      ? "EXPIRED"
      : quote.status
  });
});
  // PUBLIC CUSTOMER APPROVAL OR REJECTION
  router.post("/public/:token/decision", (req, res) => {
  const token = String(req.params.token || "");
  const decision = String(req.body?.decision || "").toUpperCase();

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(404).json({ error: "Quote not found" });
  }

  if (!["ACCEPTED", "REJECTED"].includes(decision)) {
    return res.status(400).json({ error: "Invalid decision" });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE quotes
    SET status = ?, updatedAt = ?
    WHERE approvalTokenHash = ?
      AND status = 'SENT'
      AND expiresAt > ?
  `).run(decision, now, tokenHash, now);

  if (result.changes !== 1) {
    return res.status(409).json({
      error: "Quote unavailable, expired, or already answered"
    });
  }

  res.json({ ok: true, status: decision });
});
 router.use(authRequired);

router.use((req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
});
  router.get("/", (req, res) => {
    
db.prepare(`
  UPDATE quotes
  SET status = 'EXPIRED',
      updatedAt = ?
  WHERE status IN ('DRAFT', 'SENT')
    AND expiresAt IS NOT NULL
    AND expiresAt <= ?
`).run(new Date().toISOString(), new Date().toISOString());

    const rows = db.prepare(
      "SELECT * FROM quotes ORDER BY createdAt DESC"
    ).all();

    res.json(rows.map(row => ({
      ...row,
      items: JSON.parse(row.itemsJson)
    })));
  });

  router.post("/", (req, res) => {
    try {
      const customerName = String(
        req.body.customerName || ""
      ).trim();

      if (!customerName) {
        return res.status(400).json({
          error: "Customer name is required"
        });
      }

      const totals = calculate(req.body);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      
const expiresDate = new Date();
expiresDate.setUTCDate(expiresDate.getUTCDate() + 30);
const expiresAt = expiresDate.toISOString();

      const quoteNumber = `QT-${Date.now()}-${id.slice(0, 6)}`;
const approvalToken = crypto.randomBytes(32).toString("hex");
      const approvalTokenHash = crypto
  .createHash("sha256")
  .update(approvalToken)
  .digest("hex");
      db.prepare(`
        INSERT INTO quotes (
          id, quoteNumber, customerName, customerEmail,
          itemsJson, subtotal, tax, shipping, total,
         notes, status, expiresAt, approvalTokenHash, createdAt, updatedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        quoteNumber,
        customerName,
        String(req.body.customerEmail || ""),
        totals.itemsJson,
        totals.subtotal,
        totals.tax,
        totals.shipping,
        totals.total,
        String(req.body.notes || ""),
        "DRAFT",
expiresAt,
approvalTokenHash,        
now,
now
      );

      res.status(201).json({
        ok: true,
        id,
        quoteNumber,
approvalToken
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch("/:id", (req, res) => {
    try {
      const existing = db.prepare(
        "SELECT * FROM quotes WHERE id = ?"
      ).get(req.params.id);

      if (!existing) {
        return res.status(404).json({
          error: "Quote not found"
        });
      }

      const allowed = ["DRAFT", "SENT", "ACCEPTED",
                       "REJECTED", "EXPIRED"];

      const status = String(
        req.body.status || existing.status
      ).toUpperCase();

      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: "Invalid status"
        });
      }

      const data = {
        ...existing,
        ...req.body,
        items: req.body.items ??
          JSON.parse(existing.itemsJson)
      };

      const totals = calculate(data);
      const customerName = String(
        data.customerName || ""
      ).trim();

      if (!customerName) {
        throw new Error("Customer name is required");
      }

      db.prepare(`
        UPDATE quotes SET
          customerName = ?,
          customerEmail = ?,
          itemsJson = ?,
          subtotal = ?,
          tax = ?,
          shipping = ?,
          total = ?,
          notes = ?,
          status = ?,
          updatedAt = ?
        WHERE id = ?
      `).run(
        customerName,
        String(data.customerEmail || ""),
        totals.itemsJson,
        totals.subtotal,
        totals.tax,
        totals.shipping,
        totals.total,
        String(data.notes || ""),
        status,
        new Date().toISOString(),
        req.params.id
      );

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}


import { Router } from "express";
import crypto from "crypto";
import { sendEmail } from "../mailer.js";
import PDFDocument from "pdfkit";

// Secure customer quote approval links
export default function createQuotesRouter(db, authRequired, { makeInvoiceId, nextOrderSeq } = {}) {
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
function generateQuotePDF(quote) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
   doc.fontSize(20).text("DDA AUTO PARTS", { align: "center" });
doc.moveDown();

doc.fontSize(16).text("QUOTATION", { align: "center" });
doc.moveDown();

doc.fontSize(11);
doc.text(`Quote Number: ${quote.quoteNumber}`);
doc.text(`Customer: ${quote.customerName}`);
doc.text(`Date: ${new Date(quote.createdAt).toLocaleDateString("en-US")}`);
doc.text(`Valid Until: ${new Date(quote.expiresAt).toLocaleDateString("en-US")}`);

doc.moveDown();
 doc.fontSize(12).text("PRODUCTS", { underline: true });
doc.moveDown(0.5);

const items = JSON.parse(quote.itemsJson);

items.forEach((item, index) => {
  const lineTotal = Number(item.qty) * Number(item.price);

  doc.fontSize(10).text(
    `${index + 1}. ${item.name} | Qty: ${item.qty} | Unit: $${Number(item.price).toFixed(2)} | Total: $${lineTotal.toFixed(2)}`
  );
  doc.moveDown(0.5);
});
doc.moveDown();

doc.fontSize(11).text(`Subtotal: $${Number(quote.subtotal).toFixed(2)}`, { align: "right" });
doc.text(`Tax: $${Number(quote.tax).toFixed(2)}`, { align: "right" });
doc.text(`Shipping: $${Number(quote.shipping).toFixed(2)}`, { align: "right" });

doc.moveDown(0.5);
doc.fontSize(14).text(`TOTAL: $${Number(quote.total).toFixed(2)}`, {
  align: "right"
});
if (quote.notes) {
  doc.moveDown();
  doc.fontSize(11).text("NOTES:", { underline: true });
  doc.fontSize(10).text(String(quote.notes));
}    
doc.end(); 
  });
}
 async function sendQuoteEmail(quote, approvalToken) {
  const pdfBuffer = await generateQuotePDF(quote);

  const quoteLink =
    `${process.env.FRONTEND_URL}/quote/${approvalToken}`;

  await sendEmail({
    to: quote.customerEmail,
    subject: `DDA Auto Parts - Quotation ${quote.quoteNumber}`,
    html: `
      <h2>DDA Auto Parts</h2>
      <p>Hello ${quote.customerName},</p>
      <p>Please find your quotation attached.</p>
      <p><strong>Quote:</strong> ${quote.quoteNumber}</p>
      <p><strong>Total:</strong> $${Number(quote.total).toFixed(2)}</p>
      <p><strong>Valid until:</strong>
        ${new Date(quote.expiresAt).toLocaleDateString("en-US")}
      </p>
      <p>
        <a href="${quoteLink}">
          Review, Accept or Reject Your Quotation
        </a>
      </p>
      <p>Thank you for choosing DDA Auto Parts.</p>
    `,
    attachments: [
      {
        filename: `${quote.quoteNumber}.pdf`,
        content: pdfBuffer
      }
    ]
  });
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

    try {
      const result = db.transaction(() => {
        const quote = db.prepare(
          "SELECT * FROM quotes WHERE approvalTokenHash = ?"
        ).get(tokenHash);

        if (!quote) {
          return { error: "Quote not found", code: 404 };
        }

        if (quote.status === "ACCEPTED" && decision === "ACCEPTED") {
          const existing = db.prepare(
            "SELECT id, orderNumber FROM orders WHERE quoteId = ?"
          ).get(quote.id);

          if (existing) {
            return {
              status: "ACCEPTED",
              orderId: existing.id,
              orderNumber: existing.orderNumber,
              alreadyProcessed: true
            };
          }

          return { error: "Accepted quote has no linked order", code: 409 };
        }

        if (
          quote.status !== "SENT" ||
          !quote.expiresAt ||
          quote.expiresAt <= now
        ) {
          return {
            error: "Quote unavailable, expired, or already answered",
            code: 409
          };
        }

        if (decision === "REJECTED") {
          db.prepare(
            "UPDATE quotes SET status = 'REJECTED', updatedAt = ? WHERE id = ?"
          ).run(now, quote.id);

          return { status: "REJECTED", quote };
        }

        if (
          typeof makeInvoiceId !== "function" ||
          typeof nextOrderSeq !== "function"
        ) {
          throw new Error("Order numbering helpers not configured");
        }

        const customer = db.prepare(
          "SELECT * FROM customers WHERE lower(email) = ?"
        ).get(String(quote.customerEmail || "").trim().toLowerCase());

        if (!customer) {
          return { error: "Customer account not found", code: 409 };
        }

        const items = JSON.parse(quote.itemsJson || "[]");

        if (
          !Array.isArray(items) ||
          !items.length ||
          items.some(item =>
            !String(item.sku || "").trim() ||
            !Number.isSafeInteger(Number(item.qty)) ||
            Number(item.qty) <= 0
          )
        ) {
          return {
            error: "Quote items require valid SKU and quantity",
            code: 400
          };
        }

        const orderId = `ord_${crypto.randomUUID()}`;
        const invoiceId = makeInvoiceId();
        const seq = nextOrderSeq();
        const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

        db.prepare(`
          INSERT INTO orders (
            id, invoiceId, orderNumber, orderSeq,
            customerId, createdAt, paymentMethod, paymentStatus,
            subtotal, salesTax, discounts, total,
            tax, shipping, grandTotal,
            customerSnapshot, itemsJson, status, quoteId
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          orderId, invoiceId, orderNumber, seq,
          customer.id, now, "UNSELECTED", "PENDING",
          quote.subtotal, quote.tax, 0, quote.subtotal,
          quote.tax, quote.shipping, quote.total,
          JSON.stringify(customer), quote.itemsJson,
          "PENDING", quote.id
        );

        db.prepare(
          "UPDATE quotes SET status = 'ACCEPTED', updatedAt = ? WHERE id = ?"
        ).run(now, quote.id);

        return { status: "ACCEPTED", quote, orderId, orderNumber };
      })();

      if (result.error) {
        return res.status(result.code).json({ error: result.error });
      }

      res.json({
        ok: true,
        status: result.status,
        orderId: result.orderId || null,
        orderNumber: result.orderNumber || null,
        alreadyProcessed: !!result.alreadyProcessed
      });

      const quote = result.quote;
      const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;

      if (quote && adminEmail && !result.alreadyProcessed) {
        const action = decision === "ACCEPTED" ? "ACCEPTED" : "REJECTED";

        sendEmail({
          to: adminEmail,
          subject: `Quotation ${quote.quoteNumber} - ${action}`,
          text: `
DDA Auto Parts - Quotation Update

Quote: ${quote.quoteNumber}
Customer: ${quote.customerName}
Email: ${quote.customerEmail}
Total: $${Number(quote.total).toFixed(2)}

Customer decision: ${action}

Log in to ADMIN to review this quotation.
          `
        }).catch(err => {
          console.error("Quote admin notification error:", err);
        });
      }
    } catch (err) {
      console.error("Quote decision error:", err);
      return res.status(500).json({
        error: "Unable to process quote decision"
      });
    }
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
// ADMIN: SEND QUOTE TO CUSTOMER BY EMAIL
  router.post("/:id/send", async (req, res) => {
  try {
    const quote = db.prepare(
      "SELECT * FROM quotes WHERE id = ?"
    ).get(req.params.id);

    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    if (quote.status !== "DRAFT") {
      return res.status(409).json({
        error: "Only draft quotes can be sent"
      });
    }

    if (!quote.customerEmail?.trim()) {
      return res.status(400).json({
        error: "Customer email is required"
      });
    }

    if (!process.env.FRONTEND_URL) {
      return res.status(500).json({
        error: "FRONTEND_URL is not configured"
      });
    }

    const approvalToken = crypto.randomBytes(32).toString("hex");
    const approvalTokenHash = crypto
      .createHash("sha256")
      .update(approvalToken)
      .digest("hex");

    const quoteForEmail = { ...quote };


    const result = db.prepare(`
      UPDATE quotes
      SET status = 'SENT',
          approvalTokenHash = ?,
          updatedAt = ?
      WHERE id = ? AND status = 'DRAFT'
    `).run(approvalTokenHash, new Date().toISOString(), quote.id);

    if (result.changes !== 1) {
      return res.status(409).json({
        error: "Quote status changed during sending"
      });
    }
try {
  await sendQuoteEmail(quoteForEmail, approvalToken);
} catch (emailError) {
  db.prepare(`
    UPDATE quotes
    SET status = 'DRAFT',
        approvalTokenHash = NULL,
        updatedAt = ?
    WHERE id = ? AND status = 'SENT'
      AND approvalTokenHash = ?
  `).run(new Date().toISOString(), quote.id, approvalTokenHash);

  throw emailError;
}
    console.log(`Quotation ${quote.quoteNumber} email sent successfully`);
    res.json({ ok: true, status: "SENT" });
  } catch (err) {
    console.error("Quote email error:", err);
    res.status(500).json({
      error: "Unable to send quotation"
    });
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

import "dotenv/config";
import express from "express";
import createShippingBoxesRouter from "./routes/shippingBoxes.js";
import createShippoRatesRouter from "./routes/shippoRates.js";
import createReturnsClaimsRouter from "./routes/returnsClaims.js";
import createCustomerTrackingRouter from "./routes/customerTracking.js";
import createShippingOriginRouter from "./routes/shippingOrigin.js";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { sendEmail, sendAdminZellePendingEmail } from "./mailer.js";
import { generateInvoicePDF } from "./invoicePdf.js";
import Stripe from "stripe";
import stripeRoutes from "./routes/stripe.js";
import { requestFullStripeRefund } from "./services/stripeCancellationRefund.js";
import createQuotesRouter from "./routes/quotes.js";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
console.log("✅ Stripe loaded:", !!process.env.STRIPE_SECRET_KEY);

const app = express();
// ================================
// STRIPE WEBHOOK (RAW) - DEBE IR AQUI ARRIBA
// ================================
const stripeWebhook = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripeWebhook.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err) {
    console.error("❌ Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "refund.updated" || event.type === "refund.created" || event.type === "charge.refunded") {
      // Only settle our own tracked refund; never infer completion from a charge event.
      if (event.type === "charge.refunded") return res.json({ received: true });
      const incoming = event.data.object;
      const tracked = db.prepare(
        "SELECT * FROM stripe_cancellation_refunds WHERE stripeRefundId = ?"
      ).get(incoming.id);
      if (!tracked) return res.json({ received: true });
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(tracked.orderId);
      if (!order || order.status !== "CANCELLED" ||
          Number(tracked.amountCents) !== Number(incoming.amount) ||
          String(tracked.stripePaymentIntentId || "") !== String(incoming.payment_intent || "")) {
        console.error("Stripe refund webhook mismatch; manual review required", incoming.id);
        return res.status(409).json({ error: "Refund/order mismatch" });
      }
      const newStatus = String(incoming.status || "").toLowerCase();
      if (!["pending", "requires_action", "succeeded", "failed", "canceled"].includes(newStatus)) {
        console.warn("Unrecognized Stripe refund status:", newStatus);
        return res.json({ received: true });
      }
      // Webhooks can arrive out of order. Never downgrade a confirmed refund.
      const updated = db.transaction(() => {
        const latest = db.prepare(
          "SELECT refundStatus FROM stripe_cancellation_refunds WHERE orderId = ?"
        ).get(tracked.orderId);
        if (String(latest?.refundStatus || "").toLowerCase() === "succeeded") return false;
        db.prepare(`
          UPDATE stripe_cancellation_refunds
          SET refundStatus = ?, updatedAt = datetime('now') WHERE orderId = ?
        `).run(newStatus, tracked.orderId);
        if (newStatus === "succeeded") {
          return !!db.prepare(`
            UPDATE orders SET paymentStatus = 'REFUNDED'
            WHERE id = ? AND status = 'CANCELLED' AND paymentStatus = 'REFUND_PENDING'
          `).run(tracked.orderId).changes;
        }
        return false;
      })();
      if (updated) {
        logOrderEvent(tracked.orderId, "STRIPE_REFUND_CONFIRMED", "Stripe confirmed refund succeeded", "system", null);
        await notifyCustomerRefundConfirmedOnce(tracked.orderId);
      }
      return res.json({ received: true });
    }
    if (event.type === "checkout.session.completed" && event.data.object?.metadata?.quoteOrderId) {
      const session = event.data.object;
      if (session.payment_status !== "paid") return res.json({ received: true });
      const meta = session.metadata;
      const saved = db.transaction(() => {
        const order = db.prepare("SELECT * FROM orders WHERE id = ? AND quoteId = ?")
          .get(meta.quoteOrderId, meta.quoteId);
        if (!order || order.stripeSessionId !== session.id) {
          throw new Error("Quote payment session does not match its order");
        }
        if (String(order.status || "").toUpperCase() === "CANCELLED") {
          if (Math.round(Number(order.grandTotal) * 100) !== session.amount_total ||
              String(session.currency).toLowerCase() !== "usd") {
            throw new Error("Cancelled quote checkout total mismatch");
          }
          db.prepare(`
            UPDATE orders SET paymentStatus = 'REFUND_PENDING'
            WHERE id = ? AND status = 'CANCELLED'
              AND paymentStatus IN ('PENDING', 'CANCELLED', 'PAYMENT_VERIFICATION_PENDING')
          `).run(order.id);
          return { orderId: order.id, cancelledPayment: true };
        }
        if (order.paymentStatus === "PAID") {
          if (!order.inventoryDeductedAt) deductInventoryOnceForPaidOrder(db, order.id);
          return { orderId: order.id, alreadyPaid: true };
        }
        if (order.paymentStatus !== "PENDING" || String(order.status).toUpperCase() !== "PENDING") {
          throw new Error("Quote order is not awaiting payment");
        }
        if (Math.round(Number(order.grandTotal) * 100) !== session.amount_total ||
            String(session.currency).toLowerCase() !== "usd") {
          throw new Error("Quote checkout total mismatch");
        }
        db.prepare("UPDATE orders SET paymentStatus = 'PAID', status = 'PAID', paymentMethod = 'Card', stripePaymentIntentId = COALESCE(stripePaymentIntentId, ?) WHERE id = ?").run(typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null, order.id);
        deductInventoryOnceForPaidOrder(db, order.id);
        return { orderId: order.id, alreadyPaid: false };
      })();
      if (saved.cancelledPayment) {
        logOrderEvent(saved.orderId, "CANCELLED_PAYMENT_CONFIRMED", "Stripe payment arrived after quote cancellation; refund required", "system", null);
        console.warn("Stripe payment received for cancelled quote order; refund pending:", saved.orderId);
        return res.json({ received: true });
      }
      if (!saved.alreadyPaid) {
        const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(saved.orderId);
        try {
          const customer = db.prepare("SELECT email FROM customers WHERE id = ?").get(order.customerId);
          const email = customer?.email;
          if (email) {
            const pdfPath = await generateInvoicePDF(order);
            await sendEmail({
              to: email,
              subject: `Payment confirmed — Invoice ${order.invoiceId} (DDA Auto Parts)`,
              text: `Payment confirmed for order ${order.orderNumber}. Your invoice is attached.`,
              attachments: [{
                content: fs.readFileSync(pdfPath, { encoding: "base64" }),
                filename: `${order.invoiceId}.pdf`,
                type: "application/pdf",
                disposition: "attachment"
              }]
            });
          }
        } catch (emailError) {
          console.error("Quote invoice email failed; payment is recorded:", emailError);
        }
      }
      return res.json({ received: true });
    }
    if (event.type === "checkout.session.completed") {
  const session = event.data.object;
    if (session.payment_status !== "paid") {
  console.log("Stripe session not paid:", session.id);
  return res.json({ received: true });
}  
      const existingOrder = db.prepare(
  "SELECT id FROM orders WHERE stripeSessionId = ?"
).get(session.id);

if (existingOrder) {
  console.log("Stripe session already processed:", session.id);
  return res.json({ received: true });
}
  const meta = session?.metadata || {};

  console.log("✅ checkout.session.completed:", session.id, "metadata:", meta);

  const customerEmail = String(meta.customerEmail || "").trim().toLowerCase();
  const selectedShippingId = String(meta.selectedShippingId || "");
  const vehicle = {
    label: String(meta.vehicleLabel || ""),
    vin: String(meta.vehicleVin || ""),
  };

  if (!customerEmail) {
    console.error("❌ Missing customerEmail in metadata");
    return res.json({ received: true });
  }
  if (!selectedShippingId) {
    console.error("❌ Missing selectedShippingId in metadata");
    return res.json({ received: true });
  }

  // 1) Buscar customer por email
  const customer = db
    .prepare("SELECT * FROM customers WHERE lower(email) = ?")
    .get(customerEmail);

  if (!customer) {
    console.error("❌ Customer not found for email:", customerEmail);
    return res.json({ received: true });
  }

  // 2) Obtener line_items desde Stripe (qty + unit_amount)
  const full = await stripeWebhook.checkout.sessions.retrieve(session.id, {
    expand: ["line_items.data.price"],
  });

  const li = full?.line_items?.data || [];
  if (!li.length) {
    console.error("❌ No line_items found on session:", session.id);
    return res.json({ received: true });
  }
const fullProducts = await Promise.all(
  li.map(async (x) => {
    const productId = x?.price?.product;

    if (!productId) {
      throw new Error("Stripe product ID missing");
    }

    return stripeWebhook.products.retrieve(
      typeof productId === "string" ? productId : productId.id
    );
  })
);
  const cleanItems = li.map((x, idx) => {
  const name = String(x?.description || `Item ${idx + 1}`);
  const qty = Number(x?.quantity);
  const unitCents = Number(x?.price?.unit_amount || 0);
  const price = Number((unitCents / 100).toFixed(2));

  const sku = String(
    fullProducts[idx]?.metadata?.sku || ""
  ).trim();

  if (!sku) {
    throw new Error(`Missing SKU for ${name}`);
  }

  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new Error(`Invalid quantity for SKU ${sku}`);
  }

  return {
    id: `stripe_${idx + 1}`,
    name,
    sku,
    mpn: "",
    brand: "",
    price,
    qty,
    weightLb: 1,
  };
});

  // 3) Totales y shipping usando tu misma lógica
  const subtotal = Number(
    cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2)
  );

  const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });
  const chosen = options.find((o) => String(o.id) === String(selectedShippingId));

  if (!chosen) {
    const allowed = options.map((o) => o.id).join(", ");
    console.error("❌ Shipping not allowed:", selectedShippingId, "Allowed:", allowed);
    return res.json({ received: true });
  }

  const shippingNum = Math.max(0, Number(chosen.amount || 0));
  const taxNum = calcTax(subtotal, customer);
  const discounts = 0;
  const grandTotal = Number((subtotal + taxNum + shippingNum - discounts).toFixed(2));

  // 4) Crear orden PAID/Card
      const saveWebhookOrder = db.transaction(() => {
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
    customerSnapshot, itemsJson, status, stripeSessionId
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    orderId,
    invoiceId,
    orderNumber,
    seq,
    customer.id,
    nowISO(),
    "Card",
    "PAID",
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
    "", "", "", "", "", 
   JSON.stringify(customer),
JSON.stringify(cleanItems),
"PAID",
session.id
);
  db.prepare("UPDATE orders SET stripePaymentIntentId = ? WHERE id = ?").run(
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null,
    orderId
  );
  deductInventoryOnceForPaidOrder(db, orderId);
  return orderId;
});

const orderId = saveWebhookOrder();
const createdOrder = db.prepare("SELECT orderNumber, invoiceId FROM orders WHERE id = ?").get(orderId);
console.log("✅ Order created:", createdOrder.orderNumber, createdOrder.invoiceId);
  console.log("🚀 Starting email block...");
console.log("📧 customerEmail metadata:", customerEmail);

  // ✅ Enviar invoice por email (igual que Zelle confirm)
const created = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);

// email real del customer
let emailTo = "";
const custRow = db.prepare(`SELECT email FROM customers WHERE id = ?`).get(created.customerId);
if (custRow?.email) emailTo = String(custRow.email || "").trim();

// fallback snapshot
if (!emailTo) {
  try {
    const snap = JSON.parse(created.customerSnapshot || "{}");
    emailTo = String(snap.email || "").trim();
  } catch {}
}

if (!emailTo) {
  console.error("❌ Card paid: Customer email not found for order:", created.id);
} else {
  const subject = `Payment confirmed — Invoice ${created.invoiceId} (DDA Auto Parts)`;

  const text = `Thank you for your order!
Payment confirmed for invoice ${created.invoiceId}.
Order #: ${created.orderNumber}

Total: $${Number(created.grandTotal || created.total || 0).toFixed(2)}

You can view your invoice in your account.`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2 style="margin:0 0 10px">Payment confirmed ✅</h2>
      <p style="margin:0 0 12px">Thank you for your order at <b>DDA Auto Parts</b>.</p>
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
        <p style="margin:0 0 6px"><b>Invoice:</b> ${created.invoiceId}</p>
        <p style="margin:0 0 6px"><b>Order #:</b> ${created.orderNumber}</p>
        <p style="margin:0"><b>Total:</b> $${Number(created.grandTotal || created.total || 0).toFixed(2)}</p>
      </div>
      <p style="margin-top:12px;color:#6b7280;font-size:12px">If you have questions, reply to this email.</p>
    </div>
  `;

  const pdfPath = await generateInvoicePDF(created);
  const pdfBase64 = fs.readFileSync(pdfPath, { encoding: "base64" });


await sendEmail({
  to: emailTo,
  subject,
  html: html + `<p style="margin-top:12px">Your invoice PDF is attached.</p>`,
  text: text + `\n\nInvoice PDF attached.`,
  attachments: [
    {
      content: pdfBase64,
      filename: `${created.invoiceId}.pdf`,
      type: "application/pdf",
      disposition: "attachment",
    },
  ],
});


  // marcar enviado (si existen las columnas)
  try {
    db.prepare(`UPDATE orders SET invoiceSentAt = ?, invoiceSentTo = ? WHERE id = ?`)
      .run(new Date().toISOString(), emailTo, created.id);
  } catch {}

  console.log("✅ Card invoice emailed to:", emailTo);
}

}


    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

app.use((req, res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});
app.use("/uploads", express.static("uploads"));
app.use("/invoices", express.static("invoices")); // ✅ ESTA ES LA CLAVE
app.use(cors()); // permite llamadas desde cualquier localhost (dev)
app.use(express.json({ limit: "6mb" })); 
app.use(express.urlencoded({ extended: true }));
app.use(stripeRoutes);


// =====================================================
// STRIPE: Create Payment Intent (Card)
// =====================================================
app.post("/stripe/create-payment-intent", authRequired, async (req, res) => {
  try {
    const { items = [], selectedShippingId = "" } = req.body || {};

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

    // Shipping server-truth
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
// STRIPE: Confirm Payment (Card)
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
const existingOrder = db.prepare(
  "SELECT * FROM orders WHERE stripePaymentIntentId = ?"
).get(pi.id);

if (existingOrder) {
  return res.json({ ok: true, order: existingOrder });
}
    const customer = db
      .prepare("SELECT * FROM customers WHERE id = ?")
      .get(req.user.customerId);

    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

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
const savePaidOrder = db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (
        id, invoiceId, orderNumber, orderSeq,
        customerId, createdAt, paymentMethod, paymentStatus,
        subtotal, tax, shipping, grandTotal,
        shippingMethod,
        customerSnapshot, itemsJson, status, stripePaymentIntentId
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
"PAID",
pi.id
);
    deductInventoryOnceForPaidOrder(db, orderId);
});

savePaidOrder();
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


// ===== CORS =====
app.use(
  cors({
    origin: [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  process.env.FRONTEND_URL,
].filter(Boolean),
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
function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function logOrderEvent(orderId, type, message, actorType = "system", actorId = null, meta = null) {
  try {
    db.prepare(`
      INSERT INTO order_events (orderId, type, message, actorType, actorId, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      type,
      message || "",
      actorType || "system",
      actorId || null,
      meta ? JSON.stringify(meta) : null
    );
  } catch (err) {
    console.error("logOrderEvent error:", err);
  }
}
async function notifyCustomerCancellationStatus(order) {
  const customer = db.prepare("SELECT email FROM customers WHERE id = ?").get(order.customerId);
  if (!customer?.email) return false;
  const payment = String(order.paymentStatus || "").toUpperCase();
  const detail = payment === "REFUNDED"
    ? "Your refund has been confirmed by the payment processor."
    : payment === "REFUND_PENDING"
      ? "Your refund is being processed. We will notify you when confirmed."
      : payment === "PAYMENT_VERIFICATION_PENDING"
        ? "We are verifying whether payment was received. Any confirmed payment will be reviewed for a full refund."
        : "No refund is required unless a payment is subsequently confirmed.";
  const number = String(order.orderNumber || order.id);
  await sendEmail({
    to: customer.email,
    subject: `Order cancelled - ${number} | DDA Auto Parts`,
    text: `Your order ${number} has been cancelled. ${detail}`
  });
  return true;
}
// One delivery attempt per refund. An uncertain email outcome is left for
// manual review rather than risking duplicate customer notifications.
async function notifyCustomerRefundConfirmedOnce(orderId) {
  const order = db.prepare(`
    SELECT o.*, c.email AS customerEmail FROM orders o
    LEFT JOIN customers c ON c.id = o.customerId WHERE o.id = ?
  `).get(orderId);
  if (!order || String(order.status).toUpperCase() !== "CANCELLED" ||
      String(order.paymentStatus).toUpperCase() !== "REFUNDED" || !order.customerEmail) return false;
  const claimed = db.prepare(`
    INSERT OR IGNORE INTO refund_confirmation_emails (orderId, status)
    VALUES (?, 'SENDING')
  `).run(orderId);
  if (!claimed.changes) return false;
  try {
    await sendEmail({
      to: order.customerEmail,
      subject: `Refund confirmed - ${order.orderNumber || order.id} | DDA Auto Parts`,
      text: String(order.paymentMethod || "").toLowerCase() === "zelle"
        ? `DDA Auto Parts has recorded the Zelle refund for cancelled order ${order.orderNumber || order.id} as sent. Please check your receiving account.`
        : `Your refund for cancelled order ${order.orderNumber || order.id} has been confirmed by the payment processor. Please allow your payment provider time to post the credit.`
    });
    db.prepare("UPDATE refund_confirmation_emails SET status = 'SENT' WHERE orderId = ?").run(orderId);
    return true;
  } catch (err) {
    db.prepare("UPDATE refund_confirmation_emails SET status = 'REVIEW_REQUIRED' WHERE orderId = ?").run(orderId);
    console.error("Refund confirmation email requires review:", orderId, err);
    return false;
  }
}
// ===== NOTIFY ADMIN (cancel request) =====
async function notifyAdminCancelRequested(order) {
  console.log("NOTIFY ADMIN CANCEL REQUEST:", order);
  const adminEmail = "ddaautoparts@gmail.com";

  const subject = `Cancel request: ${order.orderNumber || order.id}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2>Cancellation request received</h2>
      <p>Order #: ${order.orderNumber || ""}</p>
      <p>Invoice: ${order.invoiceId || ""}</p>
      <p>Total: $${Number(order.grandTotal || 0).toFixed(2)}</p>
      <p>Customer: ${order.customerEmail || ""}</p>
    </div>
  `;

  await sendEmail({
    to: adminEmail,
    subject,
    html,
    text: subject,
  });
}
async function notifyCustomerCancelApproved(order) {
console.log("NOTIFY CUSTOMER APPROVED:", order);
  const customerEmail = order.customerEmail;
  if (!customerEmail) return;

  const subject = `Cancellation approved - ${order.orderNumber || order.id}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2>Cancellation approved</h2>
      <p>Your cancellation request has been approved.</p>
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
        <p><b>Order #:</b> ${order.orderNumber || ""}</p>
        <p><b>Invoice:</b> ${order.invoiceId || ""}</p>
        <p><b>Status:</b> ${order.status || "CANCELLED"}</p>
        <p><b>Total:</b> $${Number(order.grandTotal || 0).toFixed(2)}</p>
      </div>
      <p style="margin-top:12px">If payment was already made, refund processing will follow your store policy.</p>
    </div>
  `;

  await sendEmail({
    to: customerEmail,
    subject,
    html,
    text: `Your cancellation request has been approved for order ${order.orderNumber || order.id}.`,
  });
}
async function notifyCustomerCancelRejected(order) {
  const customerEmail = order.customerEmail;
  if (!customerEmail) return;

  const subject = `Cancellation request denied - ${order.orderNumber || order.id}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2>Cancellation request denied</h2>
      <p>Your cancellation request was reviewed and could not be approved.</p>
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
        <p><b>Order #:</b> ${order.orderNumber || ""}</p>
        <p><b>Invoice:</b> ${order.invoiceId || ""}</p>
        <p><b>Status:</b> ${order.status || ""}</p>
        <p><b>Total:</b> $${Number(order.grandTotal || 0).toFixed(2)}</p>
      </div>
      <p style="margin-top:12px">If the order has already shipped, the return and refund process follows store policy after delivery and product inspection.</p>
    </div>
  `;

  await sendEmail({
    to: customerEmail,
    subject,
    html,
    text: `Your cancellation request was denied for order ${order.orderNumber || order.id}.`,
  });
}
async function notifyAdminRefundMarked(order) {
  const adminEmail = "ddaautoparts@gmail.com";

  const subject = `Refund marked: ${order.orderNumber || order.id}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2>Refund marked</h2>
      <p>An order was marked as refunded.</p>
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
        <p><b>Order #:</b> ${order.orderNumber || ""}</p>
        <p><b>Invoice:</b> ${order.invoiceId || ""}</p>
        <p><b>Status:</b> ${order.status || ""}</p>
        <p><b>Payment status:</b> ${order.paymentStatus || ""}</p>
        <p><b>Total:</b> $${Number(order.grandTotal || 0).toFixed(2)}</p>
        <p><b>Customer:</b> ${order.customerEmail || ""}</p>
      </div>
    </div>
  `;

  await sendEmail({
    to: adminEmail,
    subject,
    html,
    text: subject,
  });
}
async function notifyCustomerRefunded(order) {
  let customerEmail = order.customerEmail;

try {
  const snap = JSON.parse(order.customerSnapshot || "{}");
  if (snap.email) {
    customerEmail = snap.email;
  }
} catch (e) {}
  if (!customerEmail) return;

  const subject = `Refund processed - ${order.orderNumber || order.id}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.4">
      <h2>Refund processed</h2>
      <p>Your order has been marked as refunded.</p>
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:12px;max-width:520px">
        <p><b>Order #:</b> ${order.orderNumber || ""}</p>
        <p><b>Invoice:</b> ${order.invoiceId || ""}</p>
        <p><b>Status:</b> ${order.status || ""}</p>
        <p><b>Payment status:</b> ${order.paymentStatus || "REFUNDED"}</p>
        <p><b>Total refunded:</b> $${Number(order.grandTotal || 0).toFixed(2)}</p>
      </div>
      <p style="margin-top:12px">If you have questions, please reply to this email.</p>
    </div>
  `;

  await sendEmail({
    to: customerEmail,
    subject,
    html,
    text: `Your order ${order.orderNumber || order.id} has been refunded.`,
  });
}
try {
  db.prepare(`ALTER TABLE orders ADD COLUMN cancelRejected INTEGER DEFAULT 0`).run();
} catch (e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orderId INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT,
    actorType TEXT NOT NULL DEFAULT 'system',
    actorId TEXT,
    meta TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// ===== INVENTORY: products table (SQLite) =====
db.exec(`
CREATE TABLE IF NOT EXISTS refund_confirmation_emails (
  orderId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'SENDING'
);
CREATE TABLE IF NOT EXISTS inventory_cancellation_restorations (
  orderId TEXT PRIMARY KEY,
  restoredAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  brand TEXT,
  mpn TEXT,
  asin TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  fitsAll INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// ===== PRODUCT COST COLUMN =====
try {
  db.exec(`ALTER TABLE products ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0;`);
} catch {}
// ===== PRODUCT MARGIN COLUMN (percent) =====
try {
  db.exec(`ALTER TABLE products ADD COLUMN margin_pct REAL NOT NULL DEFAULT 30;`);
} catch {}
// =========================YA 
// INVENTORY: verify + decrement
// =========================
function normalizeSku(s) {
  return String(s || "").trim();
}

function qtyInt(n) {
  const q = Math.floor(Number(n || 0));
  return Number.isFinite(q) ? q : 0;
}

function reserveInventoryOrThrow(db, items) {
  const quantities = new Map();

  // Agrupar cantidades por SKU
  for (const it of items) {
    const sku = String(it.sku || "").trim();
    const qty = Number(it.qty);

    if (!sku) throw new Error("Item missing SKU");
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new Error(`Invalid qty for SKU ${sku}`);
    }

    quantities.set(sku, (quantities.get(sku) || 0) + qty);
  }

  const getStock = db.prepare(
    "SELECT stock FROM products WHERE sku = ?"
  );

  const decStock = db.prepare(
    "UPDATE products SET stock = stock - ? WHERE sku = ?"
  );

  // Verificar todas las cantidades antes de descontar
  for (const [sku, qty] of quantities) {
    const row = getStock.get(sku);

    if (!row) throw new Error(`SKU not found: ${sku}`);

    const stock = Number(row.stock || 0);

    if (stock < qty) {
      throw new Error(
        `Not enough stock for ${sku}. Have ${stock}, need ${qty}`
      );
    }
  }

  // Descontar inventario
  for (const [sku, qty] of quantities) {
    decStock.run(qty, sku);
  }
}
// Restore reserved stock at most once; called inside the same transaction as cancellation.
function restoreInventoryForCancelledOrder(db, orderId) {
  const order = db.prepare("SELECT status, inventoryDeductedAt, itemsJson FROM orders WHERE id = ?").get(orderId);
  if (!order || String(order.status || "").toUpperCase() !== "CANCELLED") {
    throw new Error("Order must be cancelled before restoring inventory");
  }
  if (!order.inventoryDeductedAt) return false;
  const claimed = db.prepare(
    "INSERT OR IGNORE INTO inventory_cancellation_restorations (orderId) VALUES (?)"
  ).run(orderId);
  if (!claimed.changes) return false;
  const items = JSON.parse(order.itemsJson || "[]");
  if (!Array.isArray(items) || !items.length) throw new Error("Invalid cancelled order items");
  const quantities = new Map();
  for (const item of items) {
    const sku = String(item.sku || "").trim();
    const qty = Number(item.qty);
    if (!sku || !Number.isSafeInteger(qty) || qty <= 0) throw new Error("Invalid cancelled order item");
    const total = (quantities.get(sku) || 0) + qty;
    if (!Number.isSafeInteger(total)) throw new Error("Invalid cancelled order quantity");
    quantities.set(sku, total);
  }
  for (const [sku, qty] of quantities) {
    const updated = db.prepare("UPDATE products SET stock = stock + ? WHERE sku = ?").run(qty, sku);
    if (updated.changes !== 1) throw new Error("Cannot restore missing SKU: " + sku);
  }
  return true;
}
function deductInventoryOnceForPaidOrder(db, orderId) {
  return db.transaction(() => {
    const order = db.prepare(
      "SELECT * FROM orders WHERE id = ?"
    ).get(orderId);

    if (!order) throw new Error("Order not found");

    // Never allocate stock to an order cancelled while payment confirmation
    // or another asynchronous fulfillment step was still in flight.
    if (["CANCELLED", "CANCEL_REQUESTED"].includes(String(order.status || "").toUpperCase())) {
      throw new Error("Cannot deduct inventory for a cancelled order");
    }

    if (order.inventoryDeductedAt) {
      return false;
    }

    if (String(order.paymentStatus).toUpperCase() !== "PAID") {
      throw new Error("Payment is not confirmed");
    }

    const items = JSON.parse(order.itemsJson || "[]");

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Order has no items");
    }

    reserveInventoryOrThrow(db, items);

    db.prepare(
      "UPDATE orders SET inventoryDeductedAt = ? WHERE id = ?"
    ).run(new Date().toISOString(), orderId);

    return true;
  })();
}
// =====================================================
// SHIPPING + TAX SETTINGS
// =====================================================
const ORIGIN_ZIP = "33018";
const UBER_MAX_MILES = 20;

// =====================================================
// CREATE TABLES (safe) + SAFE MIGRATIONS
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
  createdAt TEXT NOT NULL,

  -- (optional fields your app may use)
  street TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  resaleTaxNumber TEXT DEFAULT '',
  freeDelivery INTEGER DEFAULT 0
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

  -- order numbering
  orderNumber TEXT DEFAULT '',
  orderSeq INTEGER DEFAULT 0,

  customerId TEXT NOT NULL,
  createdAt TEXT NOT NULL,

  paymentMethod TEXT DEFAULT 'Zelle',
  paymentStatus TEXT DEFAULT 'PENDING',
  status TEXT NOT NULL DEFAULT 'PENDING',

  -- totals
  subtotal REAL NOT NULL,
  salesTax REAL NOT NULL,
  discounts REAL NOT NULL,
  total REAL NOT NULL,

  -- extra totals your code uses
  tax REAL DEFAULT 0,
  shipping REAL DEFAULT 0,
  grandTotal REAL DEFAULT 0,

  -- shipping details
  shippingCarrier TEXT DEFAULT '',
  shippingService TEXT DEFAULT '',
  shippingEta TEXT DEFAULT '',
  shippingMethod TEXT DEFAULT '',
  shippingIsEstimated INTEGER DEFAULT 0,
  shippingMeta TEXT DEFAULT '',

  -- vehicle
  vehicleLabel TEXT DEFAULT '',
  vin TEXT DEFAULT '',
  year TEXT DEFAULT '',
  make TEXT DEFAULT '',
  model TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  trim TEXT DEFAULT '',

  -- snapshots
  customerSnapshot TEXT NOT NULL,
  itemsJson TEXT NOT NULL,

  -- admin confirm / email tracking
  confirmedBy TEXT DEFAULT '',
  confirmedAt TEXT DEFAULT '',
  invoiceSentAt TEXT DEFAULT '',
  invoiceSentTo TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orders_customerId ON orders(customerId);
CREATE INDEX IF NOT EXISTS idx_orders_invoiceId ON orders(invoiceId);
CREATE INDEX IF NOT EXISTS idx_orders_orderNumber ON orders(orderNumber);
`);

// ✅ Stripe anti-duplicados: guardar session.id en la orden
try { db.exec(`ALTER TABLE orders ADD COLUMN stripeSessionId TEXT;`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripeSessionId ON orders(stripeSessionId);`); } catch {}
// Evitar órdenes duplicadas por el mismo pago de Stripe
if (!columnExists("orders", "stripePaymentIntentId")) {
  db.exec("ALTER TABLE orders ADD COLUMN stripePaymentIntentId TEXT");
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripePaymentIntentId
  ON orders(stripePaymentIntentId)
  WHERE stripePaymentIntentId IS NOT NULL
`);

// Track Stripe refund requests separately from order payment state.
db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_cancellation_refunds (
    orderId TEXT PRIMARY KEY,
    stripeRefundId TEXT UNIQUE,
    stripePaymentIntentId TEXT,
    refundStatus TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    amountCents INTEGER,
    lastError TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// =====================================================
// SAFE MIGRATIONS (adds missing columns if DB already existed)
// =====================================================
try {
  // ---- customers migrations ----
  const ccols = db.prepare(`PRAGMA table_info(customers)`).all().map((c) => c.name);
  const cadd = (name, type, defSql = "") => {
    if (!ccols.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${type}${defSql};`);
  };
  cadd("street", "TEXT", " DEFAULT ''");
  cadd("city", "TEXT", " DEFAULT ''");
  cadd("state", "TEXT", " DEFAULT ''");
  cadd("zip", "TEXT", " DEFAULT ''");
  cadd("resaleTaxNumber", "TEXT", " DEFAULT ''");
  cadd("freeDelivery", "INTEGER", " DEFAULT 0");

  // ---- orders migrations ----
  const ocols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
  const oadd = (name, type, defSql = "") => {
    if (!ocols.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}${defSql};`);
  };

  // numbering
  oadd("orderNumber", "TEXT", " DEFAULT ''");
  oadd("orderSeq", "INTEGER", " DEFAULT 0");

  // totals used by code
  oadd("tax", "REAL", " DEFAULT 0");
  oadd("shipping", "REAL", " DEFAULT 0");
  oadd("grandTotal", "REAL", " DEFAULT 0");

  // shipping details
  oadd("shippingCarrier", "TEXT", " DEFAULT ''");
  oadd("shippingService", "TEXT", " DEFAULT ''");
  oadd("shippingEta", "TEXT", " DEFAULT ''");
  oadd("shippingMethod", "TEXT", " DEFAULT ''");
  oadd("shippingIsEstimated", "INTEGER", " DEFAULT 0");
  oadd("shippingMeta", "TEXT", " DEFAULT ''");

  // admin confirm / email tracking
  oadd("confirmedBy", "TEXT", " DEFAULT ''");
  oadd("confirmedAt", "TEXT", " DEFAULT ''");
  oadd("invoiceSentAt", "TEXT", " DEFAULT ''");
  oadd("invoiceSentTo", "TEXT", " DEFAULT ''");

  // ensure indexes exist
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_customerId ON orders(customerId);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_invoiceId ON orders(invoiceId);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_orderNumber ON orders(orderNumber);`);
} catch (e) {
  console.error("DB migration error:", e);
} 

// ===== Migrations (add columns if missing) =====
function columnExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === col);
}
function addColumn(table, colDef) {
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
}

// customers
if (!columnExists("customers", "resaleTaxNumber"))
  addColumn("customers", "resaleTaxNumber TEXT DEFAULT ''");

if (!columnExists("customers", "freeDelivery"))
  addColumn("customers", "freeDelivery INTEGER NOT NULL DEFAULT 0");

// (recomendado para que tu App.jsx funcione con street/city/state/zip)
if (!columnExists("customers", "street")) addColumn("customers", "street TEXT DEFAULT ''");
if (!columnExists("customers", "apt")) addColumn("customers", "apt TEXT DEFAULT ''");
if (!columnExists("customers", "city")) addColumn("customers", "city TEXT DEFAULT ''");
if (!columnExists("customers", "state")) addColumn("customers", "state TEXT DEFAULT ''");
if (!columnExists("customers", "zip")) addColumn("customers", "zip TEXT DEFAULT ''");

// orders
if (!columnExists("orders", "orderNumber"))
  addColumn("orders", "orderNumber TEXT DEFAULT ''");
if (!columnExists("orders", "shipping"))
  addColumn("orders", "shipping REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "tax"))
  addColumn("orders", "tax REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "grandTotal"))
  addColumn("orders", "grandTotal REAL NOT NULL DEFAULT 0");
if (!columnExists("orders", "orderSeq"))
  addColumn("orders", "orderSeq INTEGER NOT NULL DEFAULT 0");
if (!columnExists("orders", "confirmedBy"))
  addColumn("orders", "confirmedBy TEXT DEFAULT ''");

if (!columnExists("orders", "confirmedAt"))
  addColumn("orders", "confirmedAt TEXT DEFAULT ''");

if (!columnExists("orders", "paidAt"))
  addColumn("orders", "paidAt TEXT DEFAULT ''");


// optional invoice display
if (!columnExists("orders", "shippingCarrier"))
  addColumn("orders", "shippingCarrier TEXT DEFAULT ''");
if (!columnExists("orders", "shippingService"))
  addColumn("orders", "shippingService TEXT DEFAULT ''");
if (!columnExists("orders", "shippingEta"))
  addColumn("orders", "shippingEta TEXT DEFAULT ''");

// store chosen method meta
if (!columnExists("orders", "shippingMethod"))
  addColumn("orders", "shippingMethod TEXT DEFAULT ''");
if (!columnExists("orders", "shippingIsEstimated"))
  addColumn("orders", "shippingIsEstimated INTEGER NOT NULL DEFAULT 0");
if (!columnExists("orders", "shippingMeta"))
  addColumn("orders", "shippingMeta TEXT DEFAULT ''");

// zip_geo table (created by your import script)
db.exec(`
CREATE TABLE IF NOT EXISTS zip_geo (
  zip TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
`);

// Preview-only ZIP coordinates from the uploaded uszips.csv.
// Seed on boot because the test database starts without the ZIP import.
if (process.env.NODE_ENV === "test") {
  const insertPreviewZip = db.prepare(
    "INSERT OR IGNORE INTO zip_geo (zip, lat, lon) VALUES (?, ?, ?)"
  );
  insertPreviewZip.run("33010", 25.83309, -80.27902);
  insertPreviewZip.run("33018", 25.92, -80.39274);
}

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
// Relacionar cada orden con su cotización original
if (!columnExists("orders", "quoteId")) {
  db.exec("ALTER TABLE orders ADD COLUMN quoteId INTEGER");
}

// Impedir convertir una cotización dos veces
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_quoteId
  ON orders(quoteId)
  WHERE quoteId IS NOT NULL
`);
// Control para evitar descontar inventario dos veces
if (!columnExists("orders", "inventoryDeductedAt")) {
  db.exec("ALTER TABLE orders ADD COLUMN inventoryDeductedAt TEXT");
}
app.use("/api/quotes", createQuotesRouter(db, authRequired, {
  makeInvoiceId,
  nextOrderSeq,
  stripe,
  getLocalShippingOptions: (items, customer) => computeShippingOptionsAdvanced({ items, customer }).options
}));

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

// price between $10 and $20 depending on miles
function uberEstimateFromMiles(miles) {
  const min = 10;
  const max = 20;
  const start = 5; // <=5mi => $10
  const end = 20; // at 20mi => $20
  if (miles <= start) return min;
  const t = (miles - start) / (end - start);
  return clamp(min + t * (max - min), min, max);
}

function extractZipFromCustomer(customer) {
  // 1) prefer customer.zip column (best)
  const z1 = String(customer?.zip || "").trim();
  if (/^\d{5}$/.test(z1)) return z1;

  // 2) try customer.address if it contains JSON or text
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
  // base “weight model” (your current logic)
  const totalWeightLb = (items || []).reduce((s, it) => {
    const w = Number(it.weightLb || 1);
    const q = Number(it.qty || 1);
    return s + Math.max(0.1, w) * Math.max(1, q);
  }, 0);

  const base = Math.max(6, totalWeightLb * 1.8);

  const options = [
    {
      id: "usps",
      carrier: "USPS",
      service: "Service selected by provider",
      eta: "Provider estimate",
      amount: Number((base + 6).toFixed(2)),
      isEstimated: 0,
      meta: null,
    },
    {
      id: "ups",
      carrier: "UPS",
      service: "Service selected by provider",
      eta: "Provider estimate",
      amount: Number((base + 14).toFixed(2)),
      isEstimated: 0,
      meta: null,
    },
    {
      id: "fedex",
      carrier: "FedEx",
      service: "Service selected by provider",
      eta: "Provider estimate",
      amount: Number((base + 18).toFixed(2)),
      isEstimated: 0,
      meta: null,
    },
  ];

  // Uber same-day local (distance check via zip_geo)
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

  // Free delivery ONLY if approved
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
    console.error("register error:", e);
    return res.status(500).json({ error: "Register failed" });
  }
});

app.post("/auth/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    const em = String(email || "").trim().toLowerCase();

    if (!em || !password) {
      return res.status(400).json({ error: "Missing email/password" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(em);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = bcrypt.compareSync(String(password), String(user.passwordHash));
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

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
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (process.env.NODE_ENV === "test") {
      return res.status(503).json({ error: "Password reset emails are disabled on this preview server. No reset email was sent." });
    }

    const customer = db.prepare(`
      SELECT id, email, firstName, lastName
      FROM customers
      WHERE lower(email) = ?
    `).get(email);

    if (!customer) {
      return res.json({
        ok: true,
        message: "If that email exists, a reset link has been sent."
      });
    }

    

const token = crypto.randomBytes(32).toString("hex");
const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hora

db.prepare(`
  UPDATE users
  SET resetToken = ?, resetTokenExpiresAt = ?
  WHERE email = ?
`).run(token, expiresAt, customer.email);
    const resetLink = `${String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "")}/?reset_token=${encodeURIComponent(token)}`;

    const fullName =
      [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() || "Customer";

    await sendEmail({
      to: customer.email,
      subject: "Reset your password - DDA Auto Parts",
      html: `
        <p>Hello ${fullName},</p>
        <p>Click the button below to reset your password:</p>
        <p>
          <a href="${resetLink}" style="padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
            Reset Password
          </a>
        </p>
        <p>If you did not request this, ignore this email.</p>
      `,
    });

    return res.json({
      ok: true,
      message: "If that email exists, a reset link has been sent."
    });
  } catch (err) {
    console.error("forgot-password error:", err);
    return res.status(500).json({ error: "Failed to process forgot password" });
  }
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!token || !password) {
      return res.status(400).json({ error: "Token and password are required" });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    const user = db.prepare(`
      SELECT * FROM users
      WHERE resetToken = ?
    `).get(token);

    if (!user) {
      return res.status(400).json({ error: "Invalid token" });
    }

    // 🔥 verificar expiración
    if (!user.resetTokenExpiresAt || new Date(user.resetTokenExpiresAt) < new Date()) {
      return res.status(400).json({ error: "Token expired" });
    }

    const passwordHash = bcrypt.hashSync(password, 10);

    db.prepare(`
      UPDATE users
      SET passwordHash = ?, resetToken = NULL, resetTokenExpiresAt = NULL
      WHERE id = ?
    `).run(passwordHash, user.id);

    return res.json({
      ok: true,
      message: "Password updated successfully"
    });

  } catch (err) {
    console.error("reset-password error:", err);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});
app.post("/auth/change-password", authRequired, (req, res) => {
  try {
    const userId = req.user?.userId;
    const { currentPassword, newPassword } = req.body || {};

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (String(newPassword).length < 8) {
  return res.status(400).json({ error: "New password must be at least 8 characters" });
}

if (!/[A-Z]/.test(String(newPassword))) {
  return res.status(400).json({ error: "New password must include at least 1 uppercase letter" });
}

if (!/[0-9]/.test(String(newPassword))) {
  return res.status(400).json({ error: "New password must include at least 1 number" });
}

if (!/[!@#$%^&*(),.?":{}|<>]/.test(String(newPassword))) {
  return res.status(400).json({ error: "New password must include at least 1 special character" });
}

if (/(012|123|234|345|456|567|678|789)/.test(String(newPassword))) {
  return res.status(400).json({ error: "Password cannot contain consecutive numbers like 123" });
}

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const ok = bcrypt.compareSync(String(currentPassword), String(user.passwordHash));
    if (!ok) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newPasswordHash = bcrypt.hashSync(String(newPassword), 10);

    db.prepare(`
      UPDATE users
      SET passwordHash = ?
      WHERE id = ?
    `).run(newPasswordHash, userId);

    return res.json({
      ok: true,
      message: "Password updated successfully"
    });
  } catch (err) {
    console.error("change-password error:", err);
    return res.status(500).json({ error: "Failed to change password" });
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
// ADMIN: Customers list
// =====================================================
app.use("/admin/shipping-boxes", createShippingBoxesRouter(db, authRequired));
app.use("/admin/shippo", createShippoRatesRouter(db, authRequired));
// Delivery timestamp is nullable until verified from the carrier; never infer it from purchase date.
try { db.exec("ALTER TABLE orders ADD COLUMN deliveredAt TEXT DEFAULT NULL"); } catch (e) {
  if (!String(e.message || "").includes("duplicate column name")) throw e;
}
app.use("/returns-claims", createReturnsClaimsRouter(db, authRequired));
app.use("/shipping", createCustomerTrackingRouter(db, authRequired));
app.use("/admin/shipping-origin", createShippingOriginRouter(db, authRequired));

app.get("/admin/customers", authRequired, (req, res) => {
  try {
    // Solo admin
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rows = db.prepare(`
      SELECT
        id, firstName, lastName, businessName,
        email, phone, city, state, zip, freeDelivery, createdAt
      FROM customers
      ORDER BY createdAt DESC
      LIMIT 200
    `).all();

    return res.json(rows);
  } catch (e) {
    console.error("❌ /admin/customers error:", e);
    return res.status(500).json({ error: "Failed to list customers" });
  }
});
// =====================================================
// ADMIN: Orders list
// =====================================================
app.get("/admin/orders", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

   const rows = db.prepare(`
  SELECT
    o.id,
    o.orderNumber,
    o.invoiceId,
    c.email AS email,
    o.grandTotal,
    o.tax,
    o.shipping,
    o.subtotal,
    o.itemsJson,
    o.status,
    o.paymentStatus,
    o.paymentMethod,
    o.createdAt
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customerId
  ORDER BY o.createdAt DESC
  LIMIT 500
`).all();
const rowsWithProfit = rows.map((o) => {
  const items = safeJsonParse(o.itemsJson) || [];
  let totalCost = 0;

  for (const item of items) {
    const product = db.prepare(`
      SELECT cost_cents
      FROM products
      WHERE id = ?
    `).get(item.id);

    const cost = Number(product?.cost_cents || 0) / 100;
    const qty = Number(item?.qty || 0);

    totalCost += cost * qty;
  }

  return {
    ...o,
    cost: Number(totalCost.toFixed(2)),
    profit: Number((Number(o.subtotal || 0) - totalCost).toFixed(2)),
  };
});

return res.json(rowsWithProfit);
  } catch (e) {
    console.error("❌ /admin/orders error:", e);
    return res.status(500).json({ error: "Failed to list orders" });
  }
});
app.get("/admin/dashboard", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const totalOrdersRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM orders
    `).get();

    const revenueRow = db.prepare(`
      SELECT COALESCE(SUM(grandTotal), 0) AS total
      FROM orders
      WHERE UPPER(COALESCE(paymentStatus, '')) != 'REFUNDED'
    `).get();

    const cancelledRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM orders
      WHERE UPPER(COALESCE(status, '')) = 'CANCELLED'
    `).get();

    const refundedRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM orders
      WHERE UPPER(COALESCE(paymentStatus, '')) = 'REFUNDED'
    `).get();

    const activeOrders = db.prepare(`
  SELECT id, subtotal, itemsJson, paymentStatus
  FROM orders
  WHERE UPPER(COALESCE(paymentStatus, '')) != 'REFUNDED'
`).all();

    let totalProfit = 0;

    for (const order of activeOrders) {
      const items = safeJsonParse(order.itemsJson) || [];
      let totalCost = 0;

      for (const item of items) {
        const product = db.prepare(`
          SELECT cost_cents
          FROM products
          WHERE id = ?
        `).get(item.id);

        console.log("ITEM PROFIT:", item);
        console.log("PRODUCT FOUND:", product);

        const cost = Number(product?.cost_cents || 0) / 100;
        const qty = Number(item?.qty || 0);

        totalCost += cost * qty;
      }

      const subtotal = Number(order?.subtotal || 0);
totalProfit += subtotal - totalCost;
    }

    res.json({
      ok: true,
      stats: {
        totalOrders: Number(totalOrdersRow?.total || 0),
        revenue: Number(revenueRow?.total || 0),
        cancelled: Number(cancelledRow?.total || 0),
        refunded: Number(refundedRow?.total || 0),
        profit: Number(totalProfit.toFixed(2)),
      },
    });
  } catch (e) {
    console.error("❌ /admin/dashboard error:", e);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});
app.put("/admin/orders/:id/cancel", authRequired, async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;
    const order = db.prepare("SELECT id, status, paymentStatus FROM orders WHERE id = ?").get(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (["LABEL_CREATED", "SHIPPED", "DELIVERED"].includes(String(order.status || "").toUpperCase())) {
      return res.status(409).json({ error: "This order requires shipping-aware cancellation review" });
    }
    const labelPurchase = db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? LIMIT 1").get(id);
    if (labelPurchase) return res.status(409).json({ error: "Shipping label exists or purchase is in progress; manual shipping review required" });
    const result = db.transaction(() => {
      const current = db.prepare("SELECT status FROM orders WHERE id = ?").get(id);
      if (!current || ["CANCELLED", "SHIPPED", "DELIVERED", "LABEL_CREATED"].includes(String(current.status || "").toUpperCase())) {
        return { changes: 0 };
      }
      // Recheck the label reservation inside the cancellation transaction.
      if (db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? LIMIT 1").get(id)) {
        return { changes: 0 };
      }
      const updated = db.prepare(`
        UPDATE orders
        SET status = 'CANCELLED',
            paymentStatus = CASE
              WHEN paymentStatus = 'PAID' THEN 'REFUND_PENDING'
              WHEN paymentStatus = 'PENDING_ADMIN' THEN 'PAYMENT_VERIFICATION_PENDING'
              WHEN paymentStatus = 'PENDING' AND (stripeSessionId IS NOT NULL OR stripePaymentIntentId IS NOT NULL)
                THEN 'PAYMENT_VERIFICATION_PENDING'
              ELSE 'CANCELLED'
            END
        WHERE id = ? AND status NOT IN ('CANCELLED', 'SHIPPED', 'DELIVERED', 'LABEL_CREATED')
      `).run(id);
      if (updated.changes) restoreInventoryForCancelledOrder(db, id);
      return updated;
    })();
    if (!result.changes) return res.status(409).json({ error: "Order is not eligible for direct cancellation" });

    console.log("CANCEL ORDER ID:", id);
    console.log("CANCEL CHANGES:", result.changes);
logOrderEvent(
  id,
  "ORDER_CANCELLED",
  "Order cancelled by admin",
  "admin",
  req.user?.id ? String(req.user.id) : null
);
    const cancelled = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    let refund = null;
    if (String(cancelled?.paymentStatus || "").toUpperCase() === "REFUND_PENDING" &&
        String(cancelled?.paymentMethod || "").toLowerCase() !== "zelle") {
      refund = await submitCancelledStripeRefund(cancelled, "admin", req.user?.id ? String(req.user.id) : null);
      if (!refund.ok) console.warn("Admin cancellation requires Stripe refund review:", id);
    }
    try {
      await notifyCustomerCancellationStatus(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
    } catch (emailError) {
      console.error("Admin cancellation customer email failed:", emailError);
    }
    return res.json({ ok: true, changes: result.changes, refund });
  } catch (e) {
    console.error("❌ /admin/orders/:id/cancel error:", e);
    return res.status(500).json({ error: "Failed to cancel order" });
  }
});
// Read-only preview. Never approve cancellation or charge a fee based on this alone.
app.get("/admin/orders/:id/label-cancellation-preview", authRequired, (req, res) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const order = db.prepare("SELECT id, status, grandTotal FROM orders WHERE id = ?").get(String(req.params.id || ""));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (["SHIPPED", "DELIVERED", "CANCELLED"].includes(String(order.status || "").toUpperCase())) return res.status(409).json({ error: "Shipped, delivered, or cancelled orders cannot enter this review" });
  const labels = db.prepare(
    "SELECT id, amount, currency, refundStatus, shippoTransactionId FROM shipping_labels WHERE orderId = ?"
  ).all(order.id);
  if (!labels.length) return res.status(409).json({ error: "No purchased label found; use the no-label cancellation workflow" });
  // Never calculate a customer fee when a label's purchase amount or currency is uncertain.
  const cents = labels.map(label => {
    const amount = String(label.amount ?? "").trim();
    if (!/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(amount) ||
        String(label.currency || "").toUpperCase() !== "USD" ||
        !label.shippoTransactionId) return null;
    const value = Math.round(Number(amount) * 100);
    return Number.isSafeInteger(value) ? value : null;
  });
  if (cents.some(value => value === null)) {
    return res.status(409).json({ error: "Label cost not verified; manual shipping review required" });
  }
  const labelCostCents = cents.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(labelCostCents) || labelCostCents > Number.MAX_SAFE_INTEGER - 500) return res.status(409).json({ error: "Invalid total label cost" });
  const processingFeeCents = 500;
  return res.json({
    orderId: order.id, orderStatus: order.status,
    labelCount: labels.length, labelCostCents, processingFeeCents,
    potentialCancellationFeeCents: labelCostCents + processingFeeCents,
    labelRefundStatuses: labels.map(label => label.refundStatus || "UNKNOWN"),
    requiresAdminApproval: true,
    shippingConfirmationRequired: true,
    approvalEnabled: false,
    notice: "Estimate only. Verify carrier pickup and Shippo label refund before approving or charging."
  });
});
app.put("/admin/orders/:id/approve-cancel", authRequired, async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;

    const row = db.prepare(`
      SELECT id, status      FROM orders
      WHERE id = ?
    `).get(id);

    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (String(row.status || "").toUpperCase() !== "CANCEL_REQUESTED") {
      return res.status(400).json({ error: "Order is not waiting for cancel approval" });
    }
    const labelPurchase = db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? LIMIT 1").get(id);
    if (labelPurchase) return res.status(409).json({ error: "Shipping label exists or purchase is in progress; shipping review required" });
    // Stop fulfillment immediately; refunds are handled after cancellation.
    const result = db.prepare(`
  UPDATE orders
  SET status = 'CANCELLED',
      paymentStatus = CASE WHEN paymentStatus = 'PAID' THEN 'REFUND_PENDING' ELSE paymentStatus END
  WHERE id = ? AND status = 'CANCEL_REQUESTED'
`).run(id);
logOrderEvent(
  id,
  "CANCEL_APPROVED",
  "Admin approved cancellation",
  "admin",
  req.user?.id ? String(req.user.id) : null
);

logOrderEvent(
  id,
  "ORDER_CANCELLED",
  "Order marked as cancelled",
  "admin",
  req.user?.id ? String(req.user.id) : null
);
const order = db.prepare(`
  SELECT o.*, c.email AS customerEmail
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customerId
  WHERE o.id = ?
`).get(id);

try {
  await notifyCustomerCancelApproved(order);
} catch (e) {
  console.error("Email notify customer approve error:", e);
}

return res.json({ ok: true, changes: result.changes });
  } catch (e) {
    console.error("❌ /admin/orders/:id/approve-cancel error:", e);
    return res.status(500).json({ error: "Failed to approve cancellation" });
  }
});
app.put("/admin/orders/:id/reject-cancel", authRequired, async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;

    const row = db.prepare(`
      SELECT id, status, paymentStatus
      FROM orders
      WHERE id = ?
    `).get(id);

    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }

    console.log("REJECT row:", row);

    if (String(row.status || "").toUpperCase() !== "CANCEL_REQUESTED") {
      return res.status(400).json({ error: "Order is not waiting for cancel approval" });
    }

    const newStatus =
      String(row.paymentStatus || "").toUpperCase() === "PAID"
        ? "PAID"
        : "PENDING";

    const result = db.prepare(`
      UPDATE orders
      SET status = ?,
          cancelRejected = 1
      WHERE id = ?
    `).run(newStatus, id);
logOrderEvent(
  id,
  "CANCEL_REJECTED",
  "Admin rejected cancellation",
  "admin",
  req.user?.id ? String(req.user.id) : null
);
    const updated = db.prepare(`
  SELECT o.*, c.email AS customerEmail
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customerId
  WHERE o.id = ?
`).get(id);

console.log("REJECT newStatus:", newStatus);
console.log("REJECT changes:", result.changes);
console.log("REJECT updated row:", updated);

try {
  await notifyCustomerCancelRejected(updated);
} catch (e) {
  console.error("Email notify customer reject error:", e);
}

return res.json({ ok: true, changes: result.changes, status: newStatus, updated });
  } catch (e) {
    console.error("❌ reject cancel error:", e);
    return res.status(500).json({ error: "Failed to reject cancellation" });
  }
});
async function submitCancelledStripeRefund(order, actorType = "system", actorId = null) {
  const id = order.id;
  const claim = db.prepare(`
    INSERT OR IGNORE INTO stripe_cancellation_refunds (orderId, refundStatus)
    VALUES (?, 'REQUESTING')
  `).run(id);
  if (!claim.changes) {
    const previous = db.prepare("SELECT * FROM stripe_cancellation_refunds WHERE orderId = ?").get(id);
    return { ok: false, alreadyRequested: true, refund: previous };
  }
  try {
    const result = await requestFullStripeRefund({ stripe, order });
    db.prepare(`
      UPDATE stripe_cancellation_refunds
      SET stripeRefundId = ?, stripePaymentIntentId = ?, refundStatus = ?, amountCents = ?,
          updatedAt = datetime('now')
      WHERE orderId = ?
    `).run(result.refundId, result.paymentIntentId, result.status, result.amount, id);
    logOrderEvent(id, "STRIPE_REFUND_REQUESTED", "Stripe refund submitted; confirmation pending", actorType, actorId);
    // Stripe can deliver refund.updated before the refund ID is persisted.
    // Reconcile directly after saving, and accept only a verified succeeded status.
    try {
      const verified = await stripe.refunds.retrieve(result.refundId);
      if (verified.id === result.refundId &&
          verified.status === "succeeded" &&
          verified.amount === result.amount &&
          String(verified.payment_intent || "") === result.paymentIntentId) {
        db.transaction(() => {
          db.prepare(`
            UPDATE stripe_cancellation_refunds
            SET refundStatus = 'succeeded', updatedAt = datetime('now')
            WHERE orderId = ? AND stripeRefundId = ?
          `).run(id, result.refundId);
          db.prepare(`
            UPDATE orders SET paymentStatus = 'REFUNDED'
            WHERE id = ? AND status = 'CANCELLED' AND paymentStatus = 'REFUND_PENDING'
          `).run(id);
        })();
        logOrderEvent(id, "STRIPE_REFUND_CONFIRMED", "Stripe refund succeeded (verified by API)", "system", null);
        await notifyCustomerRefundConfirmedOnce(id);
      }
    } catch (verificationError) {
      // The refund request was already submitted: never issue a second refund.
      console.warn("Stripe refund verification pending:", id, verificationError.message);
    }
    const current = db.prepare("SELECT paymentStatus FROM orders WHERE id = ?").get(id);
    return { ok: true, refundId: result.refundId, stripeStatus: result.status,
      paymentStatus: current?.paymentStatus || "REFUND_PENDING" };
  } catch (error) {
    // Do not automatically retry: Stripe may have processed the request.
    db.prepare(`
      UPDATE stripe_cancellation_refunds SET refundStatus = 'REVIEW_REQUIRED',
          lastError = ?, updatedAt = datetime('now') WHERE orderId = ?
    `).run(String(error.message || error).slice(0, 1000), id);
    console.error("Stripe cancellation refund needs review:", id, error);
    return { ok: false, reviewRequired: true };
  }
}
// Admin-only controlled Stripe refund attempt. The order is already cancelled
// before this route can be used. A unique row and Stripe idempotency key
// prevent duplicate refund requests; uncertain network outcomes require review.
app.post("/admin/orders/:id/request-stripe-refund", authRequired, async (req, res) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const id = String(req.params.id || "");
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (String(order.status).toUpperCase() !== "CANCELLED" ||
      String(order.paymentStatus).toUpperCase() !== "REFUND_PENDING" ||
      String(order.paymentMethod).toLowerCase() === "zelle") {
    return res.status(409).json({ error: "Cancelled card order with refund pending required" });
  }
  const outcome = await submitCancelledStripeRefund(order, "admin", req.user?.id ? String(req.user.id) : null);
  return res.status(outcome.ok ? 200 : 409).json(outcome);
});
app.put("/admin/orders/:id/refund", authRequired, async (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;

    const row = db.prepare(`
      SELECT id, paymentStatus
      FROM orders
      WHERE id = ?
    `).get(id);

    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (String(row.paymentStatus || "").toUpperCase() === "REFUNDED") {
      return res.status(400).json({ error: "Already refunded" });
    }
    const refundOrder = db.prepare("SELECT status, paymentMethod FROM orders WHERE id = ?").get(id);
    if (String(refundOrder?.status || "").toUpperCase() !== "CANCELLED" || String(row.paymentStatus || "").toUpperCase() !== "REFUND_PENDING") {
      return res.status(409).json({ error: "Order must be cancelled with refund pending" });
    }
    if (String(refundOrder.paymentMethod || "").toLowerCase() !== "zelle") {
      return res.status(409).json({ error: "Card refunds must be verified through Stripe; this action is for manual Zelle confirmation only" });
    }
    if (req.body?.refundSentConfirmed !== true) {
      return res.status(400).json({ error: "Confirm the Zelle refund was actually sent before marking this order refunded", required: "refundSentConfirmed" });
    }

    const result = db.prepare(`
      UPDATE orders
      SET paymentStatus = 'REFUNDED'
      WHERE id = ? AND status = 'CANCELLED' AND paymentStatus = 'REFUND_PENDING'
    `).run(id);
    if (!result.changes) return res.status(409).json({ error: "Refund state changed; refresh the order" });
logOrderEvent(
  id,
  "ORDER_REFUNDED",
  "Order marked as refunded",
  "admin",
  req.user?.id ? String(req.user.id) : null
);
    const order = db.prepare(`
      SELECT o.*, c.email AS customerEmail
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customerId
      WHERE o.id = ?
    `).get(id);
console.log("REFUND order for emails:", order);
    try {
      await notifyAdminRefundMarked(order);
    } catch (e) {
      console.error("Email notify admin refund error:", e);
    }
// The shared notification claim prevents duplicate confirmation emails.
    // This manual Zelle confirmation is recorded only after ADMIN attests payment was sent.
    await notifyCustomerRefundConfirmedOnce(id);
    return res.json({ ok: true, changes: result.changes });
  } catch (e) {
    console.error("❌ refund error:", e);
    return res.status(500).json({ error: "Failed to mark refund" });
  }
});
app.get("/admin/orders/:id/events", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;

    const events = db.prepare(`
      SELECT id, orderId, type, message, actorType, actorId, meta, createdAt
      FROM order_events
      WHERE orderId = ?
      ORDER BY datetime(createdAt) DESC, id DESC
    `).all(id);

    const parsed = events.map((e) => ({
      ...e,
      meta: e.meta ? safeJsonParse(e.meta) : null,
    }));

    res.json({ ok: true, events: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load order events" });
  }
});
// ===== ADMIN PRODUCTS: GET all =====
app.get("/admin/products", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rows = db
      .prepare(`
        SELECT
          id, sku, name, mpn,
          price_cents, cost_cents, margin_pct,
          stock, category, brand, asin,
          active, fitsAll, image_url,
          createdAt, updatedAt
        FROM products
        ORDER BY id DESC
      `)
      .all();

    return res.json(rows);
  } catch (e) {
    console.error("❌ /admin/products error:", e);
    return res.status(500).json({ error: "Failed to load products" });
  }
});

// ===== STORE PRODUCTS: PUBLIC =====
app.get("/products", (req, res) => {
  try {
    const rows = db
      .prepare(`
        SELECT
          id,
          sku,
          name,
          mpn,
          price_cents,
          stock,
          image_url,
          category,
          brand,
          active
        FROM products
        WHERE active = 1
        ORDER BY id DESC
      `)
      .all();

    return res.json(rows);
  } catch (e) {
    console.error("❌ /products error:", e);
    return res.status(500).json({ error: "Failed to load products" });
  }
});

// ===== ADMIN PRODUCTS: CREATE =====
app.post("/admin/products", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      sku,
      name,
      price_cents = 0,
      stock = 0,
      category = "",
      brand = "",
      mpn = "",
      asin = "",
      active = 1,
      fitsAll = 0,
      image_url = ""
    } = req.body || {};

    if (!sku || !name) {
      return res.status(400).json({ error: "Missing sku or name" });
    }

    const stmt = db.prepare(`
      INSERT INTO products
      (sku, name, price_cents, stock, category, brand, mpn, asin, active, fitsAll, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sku,
      name,
      price_cents,
      stock,
      category,
      brand,
      mpn,
      asin,
      active ? 1 : 0,
      fitsAll ? 1 : 0,
      image_url
    );

    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error("❌ /admin/products CREATE error:", e);
    if (String(e.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "SKU already exists" });
    }
    return res.status(500).json({ error: "Failed to create product" });
  }
});

// ===== ADMIN PRODUCTS: UPDATE =====
app.put("/admin/products/:id", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const b = req.body || {};

    const name = typeof b.name === "string" ? b.name : null;
    const sku = typeof b.sku === "string" ? b.sku : null;
    const mpn = typeof b.mpn === "string" ? b.mpn : null;
    const brand = typeof b.brand === "string" ? b.brand : null;
    const asin = typeof b.asin === "string" ? b.asin : null;
    const category = typeof b.category === "string" ? b.category : null;

    // price ($) -> cents
const price = b.price;
const priceCents =
  price === "" || price == null ? null : Math.max(0, Math.round(Number(price) * 100));

// ✅ cost ($) -> cents
const cost = b.cost;
const costCents =
  cost === "" || cost == null ? null : Math.max(0, Math.round(Number(cost) * 100));

// ✅ margin (%)
const marginPct = b.marginPct;
const marginPctNum =
  marginPct === "" || marginPct == null ? null : Math.max(0, Number(marginPct));

// ✅ MODO A: price automático = cost / (1 - margin)
// margin 30% => price = cost / 0.70
let finalPriceCents = Number.isFinite(priceCents) ? priceCents : null;

if (Number.isFinite(costCents) && Number.isFinite(marginPctNum)) {
  const m = Math.min(99.0, marginPctNum) / 100; // evita 100%
  const priceAuto = costCents / (1 - m);
  finalPriceCents = Math.max(0, Math.round(priceAuto));
}

    const stock =
      b.stock === "" || b.stock == null ? null : Math.max(0, Math.floor(Number(b.stock)));

    const active = b.active == null ? null : (b.active ? 1 : 0);
    const fitsAll = b.fitsAll == null ? null : (b.fitsAll ? 1 : 0);

    const imageUrl = typeof b.imageUrl === "string" ? b.imageUrl : null;

    const sets = [];
    const vals = [];

    const push = (col, val) => {
      if (val !== null && val !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(val);
      }
    };

    push("name", name);
    push("sku", sku);
    push("mpn", mpn);
    push("brand", brand);
    push("asin", asin);
    push("category", category);

    push("price_cents", Number.isFinite(finalPriceCents) ? finalPriceCents : null);
push("cost_cents", Number.isFinite(costCents) ? costCents : null);
push("margin_pct", Number.isFinite(marginPctNum) ? marginPctNum : null);

    push("stock", Number.isFinite(stock) ? stock : null);
    push("active", active);
    push("fitsAll", fitsAll);
    push("image_url", imageUrl);

    if (sets.length === 0) return res.json({ ok: true, unchanged: true });

    sets.push("updatedAt = datetime('now')");

    const sql = `UPDATE products SET ${sets.join(", ")} WHERE id = ?`;
    vals.push(id);

    const r = db.prepare(sql).run(...vals);
    if (r.changes === 0) return res.status(404).json({ error: "Product not found" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ /admin/products/:id update error:", e);
    if (String(e.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "SKU already exists" });
    }
    return res.status(500).json({ error: "Failed to update product" });
  }
});
// ===== ADMIN PRODUCTS: IMPORT CSV =====
app.post("/admin/products/import", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { rows } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "Invalid CSV data" });
    }

    const insert = db.prepare(`
      INSERT INTO products
      (sku, name, price_cents, cost_cents, margin_pct, stock, category, brand, mpn, asin, active, fitsAll)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const trx = db.transaction((items) => {
      for (const r of items) {
        if (!r.sku || !r.name) continue;

// evitar duplicados
const exists = db
  .prepare("SELECT id FROM products WHERE sku = ?")
  .get(r.sku);

if (exists) continue;

        const price = Number(r.price || 0);
        const cost = Number(r.cost || 0);
        const margin = Number(r.marginPct || 0);

        insert.run(
          r.sku,
          r.name,
          Math.round(price * 100),
          Math.round(cost * 100),
          margin,
          Number(r.stock || 0),
          r.category || "",
          r.brand || "",
          r.mpn || "",
          r.asin || "",
          1,
          0
        );
      }
    });

    trx(rows);

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ IMPORT CSV error:", e);
    return res.status(500).json({ error: "Failed to import CSV" });
  }
});
// ===== ADMIN PRODUCTS: DELETE =====
app.delete("/admin/products/:id", authRequired, (req, res) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const r = db.prepare(`DELETE FROM products WHERE id = ?`).run(id);

    if (r.changes === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ /admin/products/:id delete error:", e);
    return res.status(500).json({ error: "Failed to delete product" });
  }
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
// ORDERS (My Account)
// =====================================================
app.get("/orders/me", authRequired, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT * FROM orders
         WHERE customerId = ?
         ORDER BY createdAt DESC`
      )
      .all(req.user.customerId);

    return res.json(rows);
  } catch (e) {
    console.error("❌ /orders/me error:", e);
    return res.status(500).json({ error: "Failed to load orders" });
  }
});
app.get("/orders/:id", authRequired, (req, res) => {
  try {
    const orderId = String(req.params.id || "");
    const customerId = req.user.customerId;

    const row = db
      .prepare("SELECT * FROM orders WHERE id = ? AND customerId = ?")
      .get(orderId, customerId);

    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});
app.put("/orders/:id/request-cancel", authRequired, async (req, res) => {
  try {
    const orderId = String(req.params.id || "");
    const customerId = req.user.customerId;

    const row = db
      .prepare("SELECT id, customerId, status, createdAt, cancelRejected FROM orders WHERE id = ? AND customerId = ?")
      .get(orderId, customerId);

    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (Number(row.cancelRejected || 0) === 1) {
      return res.status(400).json({ error: "Cancellation request was already denied for this order." });
    }

    const currentStatus = String(row.status || "").toUpperCase();

    if (!["PENDING", "PAID"].includes(currentStatus)) {
      return res.status(400).json({ error: "This order cannot be cancellation-requested" });
    }

    const createdAtMs = new Date(row.createdAt).getTime();
    const nowMs = Date.now();
    const days30 = 30 * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > days30) {
      return res.status(400).json({ error: "Cancellation request period has expired (30 days)." });
    }

    // Decide under a single database transaction so label purchase reservations
    // and cancellation cannot both be initiated in this database.
    const decision = db.transaction(() => {
      const current = db.prepare(
        "SELECT status, paymentStatus FROM orders WHERE id = ? AND customerId = ?"
      ).get(orderId, customerId);
      if (!current || !["PENDING", "PAID"].includes(String(current.status || "").toUpperCase())) {
        return { error: "Order is no longer eligible for cancellation" };
      }
      const label = db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? LIMIT 1").get(orderId);
      if (label) {
        const result = db.prepare(
          "UPDATE orders SET status = 'CANCEL_REQUESTED' WHERE id = ? AND customerId = ? AND status IN ('PENDING', 'PAID')"
        ).run(orderId, customerId);
        return { result, status: "CANCEL_REQUESTED" };
      }
      const result = db.prepare(`
        UPDATE orders
        SET status = 'CANCELLED',
            paymentStatus = CASE
              WHEN paymentStatus = 'PAID' THEN 'REFUND_PENDING'
              WHEN paymentStatus = 'PENDING_ADMIN' THEN 'PAYMENT_VERIFICATION_PENDING'
              WHEN paymentStatus = 'PENDING' AND (stripeSessionId IS NOT NULL OR stripePaymentIntentId IS NOT NULL) THEN 'PAYMENT_VERIFICATION_PENDING'
              ELSE 'CANCELLED'
            END
        WHERE id = ? AND customerId = ? AND status IN ('PENDING', 'PAID')
      `).run(orderId, customerId);
      if (result.changes) restoreInventoryForCancelledOrder(db, orderId);
      return { result, status: "CANCELLED" };
    })();
    if (decision.error || !decision.result?.changes) {
      return res.status(409).json({ error: decision.error || "Order state changed; retry cancellation" });
    }
    const result = decision.result;
    logOrderEvent(
      orderId,
      decision.status === "CANCELLED" ? "ORDER_CANCELLED" : "CANCEL_REQUESTED",
      decision.status === "CANCELLED" ? "Customer cancelled before label purchase; refund to follow if paid" : "Customer requested cancellation",
      "customer",
      req.user?.id ? String(req.user.id) : null
    );
    const order = db.prepare(`
      SELECT o.*, c.email AS customerEmail
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customerId
      WHERE o.id = ?
    `).get(orderId);

    try {
      await notifyAdminCancelRequested(order);
    } catch (e) {
      console.error("Email notify admin error:", e);
    }

    // Automatically request a full refund only after cancellation is committed.
    // Never retry a potentially submitted refund without reconciliation.
    if (decision.status === "CANCELLED" &&
        String(order.paymentStatus || "").toUpperCase() === "REFUND_PENDING" &&
        String(order.paymentMethod || "").toLowerCase() !== "zelle") {
      const refundOutcome = await submitCancelledStripeRefund(order);
      if (!refundOutcome.ok) {
        console.warn("Cancelled order requires Stripe refund review:", orderId);
      }
    }

    if (decision.status === "CANCELLED") {
      try {
        await notifyCustomerCancellationStatus(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId));
      } catch (emailError) {
        console.error("Customer cancellation email failed:", emailError);
      }
    }

    console.log("REQUEST CANCEL ORDER ID:", orderId);
    console.log("REQUEST CANCEL CHANGES:", result.changes);

    return res.json({ ok: true, changes: result.changes, status: decision.status, refundPending: decision.status === "CANCELLED" && String(order.paymentStatus || "").toUpperCase() === "REFUND_PENDING" });
  } catch (e) {
    console.error("❌ /orders/:id/request-cancel error:", e);
    return res.status(500).json({ error: "Failed to request cancellation" });
  }
});
// =====================================================
// SHIPPING QUOTE (returns options incl Uber + Free Delivery)
// =====================================================
app.post("/shipping/quote", authRequired, (req, res) => {
  try {
    const { items = [] } = req.body || {};
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "No items" });

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

    // Re-usa tu lógica avanzada para saber si sale Uber
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
    const { items = [], paymentMethod = "Zelle", vehicle = {}, selectedShippingId = "" } =
      req.body || {};

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

    // ✅ server-truth shipping options (includes Uber/free if allowed)
    const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });

    const chosen = options.find((o) => o.id === selectedShippingId);
    if (!chosen) {
      const allowed = options.map((o) => o.id).join(", ");
      return res.status(400).json({
        error: `Shipping method not allowed. Allowed: ${allowed}`,
      });
    }

    // ✅ Payment validation: Zelle only allowed if shipping is Uber / Free Delivery
    const pm = String(paymentMethod || "zelle").toLowerCase();
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

    const pm2 = String(paymentMethod || "zelle").toLowerCase();

    let paymentStatus =
      pm2 === "zelle" ? "PENDING_ADMIN" : "PENDING";

    // ✅ Stripe ya cobrado desde frontend
    if (
      pm2 === "card" &&
      String(req.body?.paymentStatusOverride || "") === "PAID"
    ) {
      paymentStatus = "PAID";
    }

    const orderStatus = paymentStatus === "PAID" ? "PAID" : "PENDING";

    const orderId = uid("ord");
    const invoiceId = makeInvoiceId();

    const seq = nextOrderSeq();
    const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

    const vehicleLabel = String(vehicle.label || "").trim();

   db.prepare(`
  INSERT INTO orders (
    id, invoiceId, orderNumber, orderSeq,
    customerId, createdAt, paymentMethod, paymentStatus,
    subtotal, salesTax, discounts, total,
    tax, shipping, grandTotal,
    shippingCarrier, shippingService, shippingEta,
    shippingMethod, shippingIsEstimated, shippingMeta,
    vehicleLabel, vin, year, make, model, engine, trim,
    customerSnapshot, itemsJson, status
  )
  VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?
  )
`).run(
  orderId,
  invoiceId,
  orderNumber,
  seq,

  customer.id,
  nowISO(),
  String(paymentMethod || "Zelle"),
  String(paymentStatus),

  subtotal,
  taxNum,
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
  String(orderStatus)
);

// ✅ NUEVO: ORDER CREATED EVENT
logOrderEvent(
  orderId,
  "ORDER_CREATED",
  "Order created",
  "customer",
  req.user?.id ? String(req.user.id) : null
);
// === Admin email: Zelle pendiente (solo 1 vez) ===
if (pm2 === "zelle") {
  try {
    const row = db
      .prepare(`SELECT id, orderNumber, orderSeq, grandTotal, customerSnapshot, zelleNotifiedAt
                FROM orders WHERE id = ?`)
      .get(orderId);

    if (row) {
      let customerEmail = "N/A";
      try {
        const snap = JSON.parse(row.customerSnapshot || "{}");
        customerEmail = snap.email || snap.customerEmail || "N/A";
      } catch {}

      sendAdminZellePendingEmail({
        orderNumber: row.orderNumber,
        orderSeq: row.orderSeq,
        customerEmail,
        grandTotal: row.grandTotal,
      })
        .then(() => {
          db.prepare(
            `UPDATE orders SET zelleNotifiedAt = datetime('now') WHERE id = ?`
          ).run(orderId);
        })
        .catch((e) => {
          console.log("Admin Zelle pending email failed:", e.message);
        });
    }
  } catch (e) {
    console.log("Admin Zelle pending email failed:", e.message);
  }
}   
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

// =====================================================
// ADMIN: toggle Free Delivery (optional)
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

// ===== ADMIN: CREATE ORDER FOR CUSTOMER =====
app.post("/admin/orders/create", authRequired, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const {
      email = "",
      items = [],
      selectedShippingId = "uber",
      paymentMethod = "Zelle",
    } = req.body || {};

    const customerEmail = String(email || "").trim().toLowerCase();
    if (!customerEmail) {
      return res.status(400).json({ ok: false, error: "Missing customer email" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items array is empty" });
    }

    const customer = db
      .prepare("SELECT * FROM customers WHERE lower(email) = ?")
      .get(customerEmail);

    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found for that email" });
    }

    // Normalize items
    const cleanItems = items.map((it) => ({
      id: String(it.id || ""),
      name: String(it.name || ""),
      sku: String(it.sku || "").trim(),
      mpn: String(it.mpn || ""),
      brand: String(it.brand || ""),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));

    // Strict validation
    for (const it of cleanItems) {
      if (!it.sku) {
        return res.status(400).json({
          ok: false,
          error: `Missing sku for item "${it.name || "unknown"}". Inventory requires sku.`,
        });
      }
      if (!Number.isFinite(it.qty) || it.qty <= 0) {
        return res.status(400).json({
          ok: false,
          error: `Invalid qty for sku ${it.sku}`,
        });
      }
    }

    const subtotal = Number(
      cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2)
    );

    const { options } = computeShippingOptionsAdvanced({
      items: cleanItems,
      customer,
    });

    const chosen = options.find(
      (o) => String(o.id) === String(selectedShippingId)
    );

    if (!chosen) {
      const allowed = options.map((o) => o.id).join(", ");
      return res.status(400).json({
        ok: false,
        error: `Shipping method not allowed. Allowed: ${allowed}`,
      });
    }

    // Payment rules
    const pm = String(paymentMethod || "Zelle").toLowerCase();
    const isZelle = pm === "zelle";
    const shipId = String(chosen.id || "").toLowerCase();

    if (isZelle && !["uber", "free_delivery"].includes(shipId)) {
      return res.status(400).json({
        ok: false,
        error:
          "Zelle is only available for local deliveries (Uber / Free Delivery).",
      });
    }

    const shippingNum = Math.max(0, Number(chosen.amount || 0));
    const taxNum = calcTax(subtotal, customer);
    const discounts = 0;
    const grandTotal = Number(
      (subtotal + taxNum + shippingNum - discounts).toFixed(2)
    );

    const paymentStatus = pm === "zelle" ? "PENDING_ADMIN" : "PENDING";
    const orderStatus = paymentStatus === "PAID" ? "PAID" : "PENDING";

    const orderId = uid("ord");
    const invoiceId = makeInvoiceId();
    const seq = nextOrderSeq();
    const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

    const insertOrder = db.prepare(`
      INSERT INTO orders (
        id, invoiceId, orderNumber, orderSeq,
        customerId, createdAt, paymentMethod, paymentStatus,
        subtotal, salesTax, discounts, total,
        tax, shipping, grandTotal,
        shippingCarrier, shippingService, shippingEta,
        shippingMethod, shippingIsEstimated, shippingMeta,
        vehicleLabel, vin, year, make, model, engine, trim,
        customerSnapshot, itemsJson, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // ✅ TRANSACTION
    const tx = db.transaction(() => {
      

      // 2️⃣ Insert order
      insertOrder.run(
        orderId,
        invoiceId,
        orderNumber,
        seq,
        customer.id,
        nowISO(),
        String(paymentMethod || "Zelle"),
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
        "", "", "", "", "", "", "", // vehicle
        JSON.stringify(customer),
        JSON.stringify(cleanItems),
        orderStatus
      );

      return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    });

    const created = tx();
    logOrderEvent(
  orderId,
  "ORDER_CREATED",
  "Order created by admin",
  "admin",
  req.user?.id ? String(req.user.id) : null
);

// === Admin email: Zelle pendiente (solo 1 vez) ===
if (pm === "zelle") {
  try {
    const row = db
      .prepare(`SELECT id, orderNumber, orderSeq, grandTotal, customerSnapshot, zelleNotifiedAt
                FROM orders WHERE id = ?`)
      .get(created.id);

    if (row && !row.zelleNotifiedAt) {
      let customerEmail = "N/A";
      try {
        const snap = JSON.parse(row.customerSnapshot || "{}");
        customerEmail = snap.email || snap.customerEmail || "N/A";
      } catch {}

      sendAdminZellePendingEmail({
        orderNumber: row.orderNumber,
        orderSeq: row.orderSeq,
        customerEmail,
        grandTotal: row.grandTotal,
      })
        .then(() => {
          db.prepare(
            `UPDATE orders SET zelleNotifiedAt = datetime('now') WHERE id = ?`
          ).run(created.id);
        })
        .catch((e) => {
          console.log("Admin Zelle pending email failed:", e.message);
        });
    }
  } catch (e) {
    console.log("Admin Zelle pending email failed:", e.message);
  }
}

return res.json({ ok: true, order: created });

    return res.json({ ok: true, order: created });
  } catch (e) {
    console.error("admin create order error:", e);

    const msg = String(e.message || e);

    if (
      msg.includes("Insufficient stock") ||
      msg.includes("SKU not found") ||
      msg.includes("Missing sku") ||
      msg.includes("Invalid qty")
    ) {
      return res.status(400).json({ ok: false, error: msg });
    }

    return res.status(500).json({ ok: false, error: msg });
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

    if (order.paymentStatus === "PAID") {
      return res.status(409).json({ ok: false, error: "Payment already confirmed" });
    }
    if (order.status === "CANCELLED" && order.paymentStatus === "PAYMENT_VERIFICATION_PENDING") {
      const result = db.prepare(`
        UPDATE orders SET paymentStatus = 'REFUND_PENDING', confirmedBy = ?, confirmedAt = ?
        WHERE id = ? AND status = 'CANCELLED' AND paymentStatus = 'PAYMENT_VERIFICATION_PENDING'
      `).run(String(req.user.email || ""), new Date().toISOString(), id);
      if (!result.changes) return res.status(409).json({ ok: false, error: "Payment verification state changed" });
      logOrderEvent(id, "CANCELLED_PAYMENT_CONFIRMED", "Zelle payment arrived after cancellation; manual refund required", "admin", req.user?.id ? String(req.user.id) : null);
      return res.json({ ok: true, status: "CANCELLED", paymentStatus: "REFUND_PENDING", manualRefundRequired: true });
    }
    if (order.paymentStatus !== "PENDING_ADMIN" || order.status !== "PENDING") {
      return res.status(409).json({ ok: false, error: "Order is not awaiting Zelle confirmation" });
    }
    const nowIso = new Date().toISOString();
    const confirmedBy = String(req.user.email || "");

    const confirmPayment = db.transaction(() => {
  db.prepare(`
    UPDATE orders
    SET paymentStatus = 'PAID',
        status = 'PAID',
        confirmedBy = ?,
        confirmedAt = ?
    WHERE id = ?
  `).run(confirmedBy, nowIso, id);

  deductInventoryOnceForPaidOrder(db, id);
});

confirmPayment();

    const updated = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);

    // ✅ Email del cliente (FUENTE REAL: tabla customers)
    let customerEmail = "";
    const cust = db.prepare(`SELECT email FROM customers WHERE id = ?`).get(updated.customerId);
    if (cust?.email) customerEmail = String(cust.email || "").trim();

    // fallback: snapshot
    if (!customerEmail) {
      try {
        const snap = JSON.parse(updated.customerSnapshot || "{}");
        customerEmail = String(snap.email || "").trim();
      } catch {}
    }

    // Si aún no hay email, devolvemos error (para NO “fingir” éxito)
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

    // ✅ Genera PDF y adjunta
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

    // ✅ MARCAR QUE SE ENVIÓ (si tienes estas columnas, perfecto)
    // Si NO tienes invoiceSentAt/invoiceSentTo, comenta este bloque.
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
// ===== ADMIN: PREVIEW ORDER (mismo cálculo que checkout) =====
app.post("/admin/orders/preview", authRequired, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const {
      customerEmail = "",
      items = [],
      selectedShippingId = "uber",
      paymentMethod = "Zelle",
    } = req.body || {};

    const email = String(customerEmail || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Missing customer email" });

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items array is empty" });
    }

    const customer = db
      .prepare("SELECT * FROM customers WHERE lower(email) = ?")
      .get(email);

    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const cleanItems = items.map((it) => ({
      sku: String(it.sku || "").trim(),
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));

    const subtotal = Number(
      cleanItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2)
    );

    const { options } = computeShippingOptionsAdvanced({
      items: cleanItems,
      customer,
    });

    const chosen =
      options.find((o) => String(o.id) === String(selectedShippingId)) ||
      options[0];

    if (!chosen) {
      return res.status(400).json({ ok: false, error: "No shipping available" });
    }

    const pm = String(paymentMethod || "Zelle").toLowerCase();
    const shipId = String(chosen.id || "").toLowerCase();

    if (pm === "zelle" && !["uber", "free_delivery"].includes(shipId)) {
      return res.status(400).json({
        ok: false,
        error: "Zelle only allowed for Uber / Free Delivery",
      });
    }

    const shipping = Math.max(0, Number(chosen.amount || 0));
    const tax = calcTax(subtotal, customer);
    const grandTotal = Number((subtotal + shipping + tax).toFixed(2));

    return res.json({
      ok: true,
      subtotal,
      shipping,
      tax,
      grandTotal,
      chosen,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e.message || e),
    });
  }
});
// ===== ADMIN: CREAR ORDEN PARA UN CLIENTE =====
app.post("/admin/orders/create-legacy", authRequired, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const {
      customerEmail = "",
      customerId = "",
      items = [],
      paymentMethod = "Zelle", // Admin puede elegir
      vehicle = {},
      selectedShippingId = "",
      
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Cart is empty" });
    }

    // 1) Buscar customer (por id o email)
    let customer = null;

    if (customerId) {
      customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(String(customerId));
    } else if (customerEmail) {
      customer = db
        .prepare("SELECT * FROM customers WHERE lower(email) = ?")
        .get(String(customerEmail).trim().toLowerCase());
    }

    if (!customer) {
      return res.status(404).json({
        ok: false,
        error: "Customer not found (use customerId or customerEmail)",
      });
    }

    // 2) Limpiar items
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

    // 3) Shipping server-truth
    const { options } = computeShippingOptionsAdvanced({ items: cleanItems, customer });
    const chosen = options.find((o) => o.id === selectedShippingId);

    if (!chosen) {
      const allowed = options.map((o) => o.id).join(", ");
      return res.status(400).json({
        ok: false,
        error: `Shipping method not allowed. Allowed: ${allowed}`,
      });
    }

    // 4) Reglas de pago (mismas que /orders)
    const pm = String(paymentMethod || "Zelle").toLowerCase();
    const shipId = String(chosen.id || "").toLowerCase();

    if (pm === "zelle" && !["uber", "free_delivery"].includes(shipId)) {
      return res.status(400).json({
        ok: false,
        error: "Zelle is only available for local deliveries (Uber / Free Delivery).",
      });
    }

    const shippingNum = Math.max(0, Number(chosen.amount || 0));
    const taxNum = calcTax(subtotal, customer);
    const discounts = 0;
    const grandTotal = Number((subtotal + taxNum + shippingNum - discounts).toFixed(2));

    // 5) Estado pago
    let paymentStatus = pm === "zelle" ? "PENDING_ADMIN" : "PENDING";
    if (String(paymentStatusOverride || "").toUpperCase() === "PAID") paymentStatus = "PAID";
    const orderStatus = paymentStatus === "PAID" ? "PAID" : "PENDING";

    // 6) IDs
    const orderId = uid("ord");
    const invoiceId = makeInvoiceId();

    const seq = nextOrderSeq();
    const orderNumber = `ORD-${String(seq).padStart(6, "0")}`;

    const vehicleLabel = String(vehicle.label || "").trim();

    // 7) Insert order
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
      VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )`
    ).run(
      orderId,
      invoiceId,
      orderNumber,
      seq,
      customer.id,
      nowISO(),
      String(paymentMethod || "Zelle"),
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
    return res.json({ ok: true, order: created });
  } catch (e) {
    console.error("❌ /admin/orders/create error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


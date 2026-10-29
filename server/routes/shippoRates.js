import { Router } from "express";
import { randomUUID } from "node:crypto";
import { plannedShipDate, addBusinessDays } from "../shippingCalendar.js";

// Admin-only shipping rates and explicitly confirmed label purchase.
export default function createShippoRatesRouter(db, authRequired) {
  const router = Router();
  router.use(authRequired);
  router.use((req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
  // Persistent record for purchased labels. Populated by the future purchase workflow.
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_labels (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    shippoTransactionId TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL DEFAULT '',
    service TEXT NOT NULL DEFAULT '',
    trackingNumber TEXT NOT NULL DEFAULT '',
    trackingUrl TEXT NOT NULL DEFAULT '',
    labelUrl TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    lengthIn REAL, widthIn REAL, heightIn REAL, weightOz REAL,
    purchasedAt TEXT NOT NULL,
    refundStatus TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(orderId) REFERENCES orders(id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS shippo_rate_quotes (
    rateId TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    carrier TEXT NOT NULL,
    service TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    lengthIn REAL NOT NULL, widthIn REAL NOT NULL, heightIn REAL NOT NULL, weightOz REAL NOT NULL,
    expiresAt TEXT NOT NULL
  )`);
  const labelColumns = db.prepare("PRAGMA table_info(shipping_labels)").all().map(column => column.name);
  if (!labelColumns.includes("shippoRefundId")) db.exec("ALTER TABLE shipping_labels ADD COLUMN shippoRefundId TEXT NOT NULL DEFAULT ''");
  router.get("/orders/:id/labels", (req, res) => {
    const exists = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
    if (!exists) return res.status(404).json({ error: "Order not found" });
    const labels = db.prepare(`SELECT id, carrier, service, trackingNumber, trackingUrl,
      labelUrl, amount, currency, lengthIn, widthIn, heightIn, weightOz,
      purchasedAt, refundStatus, shippoRefundId FROM shipping_labels WHERE orderId = ? ORDER BY purchasedAt DESC`).all(req.params.id);
    res.json({ labels });
  });
  const orderSnapshot = id => {
    const row = db.prepare(`SELECT id, orderNumber, invoiceId, createdAt, customerSnapshot, itemsJson, status FROM orders WHERE id = ?`).get(id);
    if (!row) return null;
    let customer = {}, items = [];
    try { customer = JSON.parse(row.customerSnapshot || "{}"); } catch {}
    try { items = JSON.parse(row.itemsJson || "[]"); } catch {}
    return {
      id: row.id, orderNumber: row.orderNumber, invoiceId: row.invoiceId,
      createdAt: row.createdAt, status: row.status,
      customer: {
        name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
        email: customer.email || "",
        street1: customer.street || customer.address || "",
        city: customer.city || "", state: customer.state || "", zip: customer.zip || "",
      },
      items: Array.isArray(items) ? items.map(item => ({
        id: item.id, name: item.name || item.title || item.sku || "Product",
        sku: item.sku || "", qty: Number(item.qty || item.quantity || 1),
      })) : [],
    };
  };
  router.get("/orders/:id", (req, res) => {
    const order = orderSnapshot(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order });
  });
  router.post("/rates", async (req, res) => {
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured on this server" });
    const { box, orderId } = req.body || {};
    let destination = req.body?.destination;
    if (orderId) {
      const order = orderSnapshot(String(orderId));
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (String(order.status).toUpperCase() !== "PAID") return res.status(409).json({ error: "Only paid, uncanceled, unshipped orders can receive labels" });
      const existing = db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? AND refundStatus NOT IN ('PENDING', 'SUCCESS') LIMIT 1").get(order.id);
      if (existing) return res.status(409).json({ error: "This order already has a shipping label" });
      destination = order.customer;
    }
    const origin = db.prepare('SELECT * FROM shipping_origin WHERE id = 1').get();
    const positive = v => Number.isFinite(Number(v)) && Number(v) > 0;
    const zip = v => /^\d{5}(?:-\d{4})?$/.test(String(v || ""));
    const fields = ["lengthIn", "widthIn", "heightIn", "weightOz"];
    if (!box || !fields.every(k => positive(box[k]))) {
      return res.status(400).json({ error: "Confirmed package dimensions and total weight are required" });
    }
    if (!destination || !zip(destination.zip) || !destination.city ||
        !destination.state || !destination.street1) {
      return res.status(400).json({ error: "Full destination address is required" });
    }
    const originZip = String(origin?.zip || "");
    if (!zip(originZip) || !origin?.street1 || !origin?.city || !origin?.state) {
      return res.status(400).json({ error: "Full origin address is required; default ZIP is 33018" });
    }
    const address = (a) => ({
      name: String(a.name || "DDA Auto Parts").slice(0, 100),
      street1: String(a.street1).slice(0, 150),
      street2: String(a.street2 || "").slice(0, 150),
      city: String(a.city).slice(0, 100),
      state: String(a.state).slice(0, 40),
      zip: String(a.zip).slice(0, 10),
      country: "US",
    });
    const payload = {
      address_from: address({ ...origin, zip: originZip }),
      address_to: address(destination),
      parcels: [{
        length: String(Number(box.lengthIn)), width: String(Number(box.widthIn)),
        height: String(Number(box.heightIn)), distance_unit: "in",
        weight: String(Number(box.weightOz)), mass_unit: "oz",
      }],
      async: false,
    };
    try {
      const response = await fetch("https://api.goshippo.com/shipments/", {
        method: "POST",
        headers: {
          Authorization: `ShippoToken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.status(502).json({ error: "Shippo rate request failed", details: data?.detail || null });
      }
      if (orderId) {
        const save = db.prepare(`INSERT OR REPLACE INTO shippo_rate_quotes
          (rateId, orderId, carrier, service, amount, currency, lengthIn, widthIn, heightIn, weightOz, expiresAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.transaction(() => {
          for (const rate of data.rates || []) {
            if (!rate.object_id || rate.test === true) continue;
            save.run(rate.object_id, String(orderId), String(rate.provider || ""), String(rate.servicelevel?.name || ""), String(rate.amount || ""), String(rate.currency || "USD"),
              Number(box.lengthIn), Number(box.widthIn), Number(box.heightIn), Number(box.weightOz), expiresAt);
          }
        })();
      }
      const shipDate = plannedShipDate();
      return res.json({
        shipmentId: data.object_id,
        plannedShipDate: shipDate,
        rates: (data.rates || []).map(rate => ({
          id: rate.object_id,
          carrier: rate.provider,
          service: rate.servicelevel?.name || rate.servicelevel?.token || "",
          amount: rate.amount,
          currency: rate.currency,
          estimatedDays: rate.estimated_days ?? null,
          // Conservative business-day window; carrier-specific delivery schedules may differ.
          estimatedDeliveryStart: Number.isInteger(Number(rate.estimated_days)) && Number(rate.estimated_days) > 0
            ? addBusinessDays(shipDate, Number(rate.estimated_days)) : null,
          estimatedDeliveryEnd: Number.isInteger(Number(rate.estimated_days)) && Number(rate.estimated_days) > 0
            ? addBusinessDays(shipDate, Number(rate.estimated_days) + 1) : null,
          durationTerms: rate.duration_terms || null,
          test: rate.test === true,
        })),
        messages: (data.messages || []).map(m => ({ text: m.text, source: m.source })),
        purchased: false,
      });
    } catch {
      return res.status(502).json({ error: "Shippo did not respond; no label was purchased" });
    }
  });
  // Purchase is never automatic. The administrator must confirm the exact quoted rate.
  router.post("/orders/:id/purchase-label", async (req, res) => {
    const orderId = String(req.params.id);
    const rateId = String(req.body?.rateId || "");
    const confirmed = req.body?.confirm === true;
    if (!confirmed || !rateId) return res.status(400).json({ error: "Explicit label purchase confirmation and rateId required" });
    if (req.body?.hazmat === true) return res.status(422).json({ error: "Hazmat shipping requires carrier-specific dangerous goods validation and compliant labels. Do not purchase a standard label for this shipment." });
    const order = db.prepare("SELECT id, status FROM orders WHERE id = ?").get(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.status).toUpperCase() !== "PAID") return res.status(409).json({ error: "Order is not eligible for shipping; resolve cancellation requests first" });
    const quote = db.prepare("SELECT * FROM shippo_rate_quotes WHERE rateId = ? AND orderId = ?").get(rateId, orderId);
    if (!quote || new Date(quote.expiresAt).getTime() < Date.now()) return res.status(409).json({ error: "Rate expired; request new Shippo rates" });
    if (req.body?.expectedAmount !== quote.amount || req.body?.expectedCurrency !== quote.currency) return res.status(409).json({ error: "Rate amount confirmation mismatch" });
    if (db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? AND refundStatus NOT IN ('PENDING', 'SUCCESS') LIMIT 1").get(orderId))
      return res.status(409).json({ error: "An active label already exists for this order" });
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured" });
    // Persist a purchase reservation BEFORE contacting Shippo to prevent accidental double charges.
    const reservationId = "pending-" + randomUUID();
    try {
      db.prepare(`INSERT INTO shipping_labels
        (id, orderId, shippoTransactionId, carrier, service, amount, currency, lengthIn, widthIn, heightIn, weightOz, purchasedAt, refundStatus)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PURCHASING')`)
        .run(reservationId, orderId, reservationId, quote.carrier, quote.service, quote.amount, quote.currency,
          quote.lengthIn, quote.widthIn, quote.heightIn, quote.weightOz, new Date().toISOString());
    } catch {
      return res.status(409).json({ error: "Label purchase is already in progress or exists; contact support before retrying" });
    }
    try {
      const response = await fetch("https://api.goshippo.com/transactions/", {
        method: "POST",
        headers: { Authorization: `ShippoToken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ rate: rateId, label_file_type: "PDF", async: false }),
        signal: AbortSignal.timeout(25000),
      });
      const result = await response.json();
      if (!response.ok || result.status !== "SUCCESS" || !result.object_id || !result.label_url) {
        // Preserve the reservation for manual investigation: Shippo may have charged the account.
        db.prepare("UPDATE shipping_labels SET refundStatus = 'PURCHASE_REVIEW' WHERE id = ?").run(reservationId);
        return res.status(502).json({ error: "Shippo did not confirm a successful label. Review Shippo transactions before retrying.", details: result.messages || null });
      }
      db.transaction(() => {
        db.prepare(`UPDATE shipping_labels SET shippoTransactionId = ?, labelUrl = ?, trackingNumber = ?,
          trackingUrl = ?, purchasedAt = ?, refundStatus = '' WHERE id = ?`)
          .run(result.object_id, result.label_url, result.tracking_number || "",
            result.tracking_url_provider || "", new Date().toISOString(), reservationId);
        const changed = db.prepare("UPDATE orders SET status = 'SHIPPED' WHERE id = ? AND status = 'PAID'").run(orderId);
        if (changed.changes !== 1) throw new Error("Order changed while purchasing label");
        db.prepare("DELETE FROM shippo_rate_quotes WHERE orderId = ?").run(orderId);
      })();
      return res.json({ ok: true, trackingNumber: result.tracking_number || "", labelUrl: result.label_url });
    } catch (error) {
      db.prepare("UPDATE shipping_labels SET refundStatus = 'PURCHASE_REVIEW' WHERE id = ? AND refundStatus = 'PURCHASING'").run(reservationId);
      return res.status(502).json({ error: "Purchase outcome requires manual verification in Shippo; do not purchase again.", details: String(error.message || error) });
    }
  });
  const applyConfirmedLabelRefund = (orderId, labelId, refundId, status) => {
    db.transaction(() => {
      db.prepare("UPDATE shipping_labels SET refundStatus = ?, shippoRefundId = ? WHERE id = ? AND orderId = ?").run(status, refundId, labelId, orderId);
      if (!["PENDING", "SUCCESS"].includes(status)) return;
      const otherActive = db.prepare("SELECT id FROM shipping_labels WHERE orderId = ? AND id != ? AND refundStatus NOT IN ('PENDING', 'SUCCESS') LIMIT 1").get(orderId, labelId);
      if (!otherActive) db.prepare("UPDATE orders SET status = 'PAID' WHERE id = ? AND status = 'SHIPPED' AND paymentStatus = 'PAID'").run(orderId);
    })();
  };
  // Label refunds never refund the customer payment.
  router.post("/orders/:id/labels/:labelId/request-refund", async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Explicit refund request confirmation required" });
    const label = db.prepare("SELECT * FROM shipping_labels WHERE id = ? AND orderId = ?").get(req.params.labelId, req.params.id);
    if (!label) return res.status(404).json({ error: "Label not found" });
    if (label.refundStatus || !label.labelUrl || label.shippoTransactionId.startsWith("pending-"))
      return res.status(409).json({ error: "Label is not eligible for a new refund request; review existing status" });
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured" });
    const claimed = db.prepare("UPDATE shipping_labels SET refundStatus = 'REQUESTING' WHERE id = ? AND refundStatus = ''").run(label.id);
    if (claimed.changes !== 1) return res.status(409).json({ error: "A refund request is already in progress" });
    try {
      const response = await fetch("https://api.goshippo.com/refunds/", {
        method: "POST",
        headers: { Authorization: `ShippoToken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: label.shippoTransactionId, async: false }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Do not automatically retry: an uncertain response could create duplicate requests.
        db.prepare("UPDATE shipping_labels SET refundStatus = 'REFUND_REVIEW' WHERE id = ?").run(label.id);
        return res.status(502).json({ error: "Shippo did not accept or confirm the refund. Check Shippo before retrying.", details: result.detail || result.messages || null });
      }
      const status = String(result.status || "PENDING").toUpperCase();
      applyConfirmedLabelRefund(label.orderId, label.id, String(result.object_id || ""), status);
      return res.json({ ok: true, refundStatus: status, refundId: result.object_id || null, message: ["PENDING", "SUCCESS"].includes(status) ? "Shippo accepted the label refund request. Order returns to Unshipped if no other active labels. Customer payment unchanged." : "Refund response needs review; order status unchanged." });
    } catch {
      db.prepare("UPDATE shipping_labels SET refundStatus = 'REFUND_REVIEW' WHERE id = ?").run(label.id);
      return res.status(502).json({ error: "Refund outcome is uncertain. Verify in Shippo before any retry." });
    }
  });
  router.post("/orders/:id/labels/:labelId/refresh-refund", async (req, res) => {
    const label = db.prepare("SELECT * FROM shipping_labels WHERE id = ? AND orderId = ?").get(req.params.labelId, req.params.id);
    if (!label) return res.status(404).json({ error: "Label not found" });
    if (!label.shippoRefundId) return res.status(409).json({ error: "No Shippo refund ID recorded; check Shippo manually" });
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured" });
    try {
      const response = await fetch(`https://api.goshippo.com/refunds/${encodeURIComponent(label.shippoRefundId)}/`, {
        headers: { Authorization: `ShippoToken ${token}` }, signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ error: "Could not check refund status in Shippo" });
      const status = String(result.status || label.refundStatus).toUpperCase();
      applyConfirmedLabelRefund(label.orderId, label.id, label.shippoRefundId, status);
      return res.json({ refundStatus: status, message: ["PENDING", "SUCCESS"].includes(status) ? "Label refund request accepted. Order is Unshipped if no other active labels. Customer payment unchanged." : "Refund status updated. Customer payment unchanged." });
    } catch { return res.status(502).json({ error: "Could not reach Shippo" }); }
  });
  return router;
}

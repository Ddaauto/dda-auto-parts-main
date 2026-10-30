import { Router } from "express";
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
  for (const ddl of [
    "ALTER TABLE shipping_labels ADD COLUMN packageItemsJson TEXT DEFAULT '[]'",
    "ALTER TABLE shippo_rate_quotes ADD COLUMN packageItemsJson TEXT DEFAULT '[]'"
  ]) { try { db.exec(ddl); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; } }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_shippo_one_inflight_purchase_per_order ON shipping_labels(orderId) WHERE refundStatus IN ('PURCHASING','PURCHASE_REVIEW')");
  const purchasedLabels = id => db.prepare("SELECT * FROM shipping_labels WHERE orderId = ? AND COALESCE(refundStatus,'') NOT IN ('SUCCESS','REFUNDED')").all(id);
  const packageAllocation = (order, input, multi) => {
    const totals = new Map();
    for (const item of order.items) {
      const key = String(item.id || item.sku || "");
      const qty = Number(item.qty);
      if (!key || !Number.isSafeInteger(qty) || qty < 1) return { error: "Order contains invalid item quantities" };
      totals.set(key, (totals.get(key) || 0) + qty);
    }
    if (!multi) {
      if (purchasedLabels(order.id).length) return { error: "Order already has a label; use multi-package mode to allocate remaining items" };
      return { items: [...totals].map(([key, qty]) => ({ key, qty })) };
    }
    if (!Array.isArray(input) || !input.length) return { error: "Choose quantities for this package" };
    const selected = new Map();
    for (const item of input) {
      const key = String(item.key || "");
      const qty = Number(item.qty);
      if (!totals.has(key) || !Number.isSafeInteger(qty) || qty < 1 || selected.has(key)) return { error: "Invalid package item allocation" };
      selected.set(key, qty);
    }
    const allocated = new Map();
    for (const label of purchasedLabels(order.id)) {
      if (["PURCHASING","PURCHASE_REVIEW"].includes(label.refundStatus)) return { error: "Previous purchase requires manual review" };
      let parts; try { parts = JSON.parse(label.packageItemsJson || "[]"); } catch { return { error: "Existing package allocation needs review" }; }
      if (!parts.length) return { error: "Existing label lacks package allocation; manual review required" };
      for (const part of parts) allocated.set(part.key, (allocated.get(part.key) || 0) + Number(part.qty));
    }
    for (const [key, qty] of selected) {
      if (qty + (allocated.get(key) || 0) > totals.get(key)) return { error: "Package quantity exceeds unshipped quantity" };
    }
    return { items: [...selected].map(([key, qty]) => ({ key, qty })) };
  };
  router.get("/orders/:id/labels", (req, res) => {
    const exists = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
    if (!exists) return res.status(404).json({ error: "Order not found" });
    const labels = db.prepare(`SELECT id, carrier, service, trackingNumber, trackingUrl,
      labelUrl, amount, currency, lengthIn, widthIn, heightIn, weightOz,
      purchasedAt, refundStatus, packageItemsJson, carrierTrackingStatus, carrierTrackingCheckedAt FROM shipping_labels WHERE orderId = ? ORDER BY purchasedAt DESC`).all(req.params.id);
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
      const multi = req.body?.multiPackage === true;
      if (!["PAID","LABEL_CREATED"].includes(String(order.status).toUpperCase()) || (order.status === "LABEL_CREATED" && !multi))
        return res.status(409).json({ error: "Order is not eligible for this shipping mode" });
      const existing = purchasedLabels(order.id);
      if (existing.length && !multi) return res.status(409).json({ error: "Existing labels require multi-package mode" });
      const allocation = packageAllocation(order, req.body?.packageItems, multi);
      if (allocation.error) return res.status(409).json({ error: allocation.error });
      req.packageAllocation = allocation.items;
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
          (rateId, orderId, carrier, service, amount, currency, lengthIn, widthIn, heightIn, weightOz, expiresAt, packageItemsJson)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.transaction(() => {
          for (const rate of data.rates || []) {
            if (!rate.object_id || rate.test === true) continue;
            save.run(rate.object_id, String(orderId), String(rate.provider || ""), String(rate.servicelevel?.name || ""), String(rate.amount || ""), String(rate.currency || "USD"),
              Number(box.lengthIn), Number(box.widthIn), Number(box.heightIn), Number(box.weightOz), expiresAt, JSON.stringify(req.packageAllocation || []));
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
    const order = db.prepare("SELECT id, status FROM orders WHERE id = ?").get(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!["PAID","LABEL_CREATED"].includes(String(order.status).toUpperCase())) return res.status(409).json({ error: "Order is not eligible for shipping; resolve cancellation requests first" });
    const quote = db.prepare("SELECT * FROM shippo_rate_quotes WHERE rateId = ? AND orderId = ?").get(rateId, orderId);
    if (!quote || new Date(quote.expiresAt).getTime() < Date.now()) return res.status(409).json({ error: "Rate expired; request new Shippo rates" });
    if (req.body?.expectedAmount !== quote.amount || req.body?.expectedCurrency !== quote.currency) return res.status(409).json({ error: "Rate amount confirmation mismatch" });
    const existingLabels = purchasedLabels(orderId);
    if (existingLabels.some(label => ["PURCHASING","PURCHASE_REVIEW"].includes(label.refundStatus)))
      return res.status(409).json({ error: "Prior label purchase needs manual review" });
    if (existingLabels.length && req.body?.multiPackage !== true)
      return res.status(409).json({ error: "Explicit multi-package confirmation required" });
    const currentOrder = orderSnapshot(orderId);
    const allocation = packageAllocation(currentOrder, JSON.parse(quote.packageItemsJson || "[]"), existingLabels.length > 0 || req.body?.multiPackage === true);
    if (allocation.error) return res.status(409).json({ error: allocation.error });
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured" });
    // The selected rate must be allocated to an actual package, and its
    // quantities must still be available after previous labels.
    if (!allocation.items.length) return res.status(409).json({ error: "No items assigned to this package" });
    // Persist a purchase reservation BEFORE contacting Shippo to prevent accidental double charges.
    const reservationId = "pending-" + rateId;
    try {
      db.prepare(`INSERT INTO shipping_labels
        (id, orderId, shippoTransactionId, carrier, service, amount, currency, lengthIn, widthIn, heightIn, weightOz, purchasedAt, refundStatus, packageItemsJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PURCHASING', ?)`)
        .run(reservationId, orderId, reservationId, quote.carrier, quote.service, quote.amount, quote.currency,
          quote.lengthIn, quote.widthIn, quote.heightIn, quote.weightOz, new Date().toISOString(), JSON.stringify(allocation.items));
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
        const changed = db.prepare("UPDATE orders SET status = 'LABEL_CREATED' WHERE id = ? AND status IN ('PAID','LABEL_CREATED')").run(orderId);
        if (changed.changes !== 1) throw new Error("Order changed while purchasing label");
        db.prepare("DELETE FROM shippo_rate_quotes WHERE orderId = ?").run(orderId);
      })();
      return res.json({ ok: true, trackingNumber: result.tracking_number || "", labelUrl: result.label_url });
    } catch (error) {
      db.prepare("UPDATE shipping_labels SET refundStatus = 'PURCHASE_REVIEW' WHERE id = ? AND refundStatus = 'PURCHASING'").run(reservationId);
      return res.status(502).json({ error: "Purchase outcome requires manual verification in Shippo; do not purchase again.", details: String(error.message || error) });
    }
  });
  return router;
}

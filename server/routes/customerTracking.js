import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { sendEmail } from "../mailer.js";
import { shipmentProgress } from "../services/shipmentProgress.js";

// Shippo tracking states are independent of the purchase of a shipping label.
export default function createCustomerTrackingRouter(db, authRequired) {
  const router = Router();
  for (const statement of [
    "ALTER TABLE shipping_labels ADD COLUMN carrierTrackingStatus TEXT DEFAULT ''",
    "ALTER TABLE shipping_labels ADD COLUMN carrierTrackingCheckedAt TEXT DEFAULT ''",
    "ALTER TABLE shipping_labels ADD COLUMN carrierTrackingEventAt TEXT DEFAULT ''"
  ]) {
    try { db.exec(statement); } catch (error) {
      if (!String(error.message || "").includes("duplicate column name")) throw error;
    }
  }
  const activeLabels = orderId => db.prepare(`SELECT id, carrier, service, trackingNumber, trackingUrl,
    purchasedAt, carrierTrackingStatus, carrierTrackingCheckedAt, packageItemsJson, testMode
    FROM shipping_labels WHERE orderId = ? AND shippoTransactionId NOT LIKE 'pending-%'
    AND COALESCE(refundStatus,'') NOT IN ('PENDING','SUCCESS','REFUNDED','PURCHASING','PURCHASE_REVIEW')
    ORDER BY purchasedAt ASC, id ASC`).all(orderId);
  const progress = (orderId, labels) => {
    const row = db.prepare("SELECT itemsJson FROM orders WHERE id = ?").get(orderId);
    let items;
    try { items = JSON.parse(row?.itemsJson || "[]"); } catch { items = []; }
    return shipmentProgress(items, labels);
  };
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_notifications (
    orderId TEXT NOT NULL,
    status TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sentAt TEXT,
    PRIMARY KEY (orderId, status)
  )`);
  let delivering = false;
  async function deliverNotifications() {
    if (delivering) return;
    delivering = true;
    try {
      const pending = db.prepare("SELECT * FROM shipping_notifications WHERE sentAt IS NULL ORDER BY rowid LIMIT 50").all();
      for (const message of pending) {
        try {
          await sendEmail({
            to: message.recipient,
            subject: message.subject,
            text: message.body,
            idempotencyKey: `shipping/${message.orderId}/${message.status}`,
          });
          db.prepare("UPDATE shipping_notifications SET sentAt = ? WHERE orderId = ? AND status = ?")
            .run(new Date().toISOString(), message.orderId, message.status);
        } catch (error) {
          console.error("Shipping notification delivery failed", message.orderId, message.status, error.message);
        }
      }
    } finally {
      delivering = false;
    }
  }
  const retry = setInterval(() => void deliverNotifications().catch(console.error), 60_000);
  retry.unref();

  const validStatus = status => ["UNKNOWN", "PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE", "OUT_FOR_DELIVERY"].includes(status);
  const applyTracking = db.transaction((orderId, labelId, status, rawDate, testMode) => {
    const now = new Date().toISOString();
    const eventAt = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
    const changed = db.prepare(`UPDATE shipping_labels
      SET carrierTrackingStatus = ?, carrierTrackingCheckedAt = ?, carrierTrackingEventAt = COALESCE(?, carrierTrackingEventAt)
      WHERE id = ? AND testMode = ? AND shippoTransactionId NOT LIKE 'pending-%'
        AND COALESCE(refundStatus, '') NOT IN ('PENDING','SUCCESS','REFUNDED','PURCHASING','PURCHASE_REVIEW')
        AND (NULLIF(carrierTrackingEventAt, '') IS NULL OR carrierTrackingEventAt < ?)`)
      .run(status, now, eventAt, labelId, Number(testMode), eventAt);
    if (!changed.changes) return;

    const labels = activeLabels(orderId);
    const { status: next } = progress(orderId, labels);
    if (next !== "SHIPPED" && next !== "DELIVERED") return;
    const order = db.prepare(`SELECT o.status, o.orderNumber, o.customerSnapshot, c.email
      FROM orders o LEFT JOIN customers c ON c.id = o.customerId WHERE o.id = ?`).get(orderId);
    if (!order || !["LABEL_CREATED", "SHIPPED"].includes(order.status) || order.status === next) return;
    if (next === "DELIVERED") {
      const dates = db.prepare("SELECT carrierTrackingEventAt FROM shipping_labels WHERE id = ?");
      const deliveredAt = labels.map(label => dates.get(label.id).carrierTrackingEventAt).filter(Boolean).sort().at(-1) || now;
      db.prepare("UPDATE orders SET status = ?, deliveredAt = COALESCE(deliveredAt, ?) WHERE id = ?").run(next, deliveredAt, orderId);
    } else {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(next, orderId);
    }

    let recipient = order.email;
    if (!recipient) {
      try { recipient = JSON.parse(order.customerSnapshot || "{}").email; } catch {}
    }
    if (!recipient || (testMode && process.env.NODE_ENV !== "test")) return;
    const title = next === "SHIPPED" ? "Shipped" : "Delivered";
    const tracking = labels.map(label => `${label.carrier} ${label.trackingNumber}`).join("\n");
    db.prepare(`INSERT OR IGNORE INTO shipping_notifications (orderId, status, recipient, subject, body)
      VALUES (?, ?, ?, ?, ?)`).run(orderId, next, recipient, `${title} — Order ${order.orderNumber || orderId}`,
        `Your DDA Auto Parts order has been ${title.toLowerCase()}.\n\nPackage tracking\n${tracking}`);
  });

  router.post("/shippo/webhook", (req, res) => {
    const secret = process.env.SHIPPO_WEBHOOK_TOKEN;
    if (!secret) return res.sendStatus(503);
    const digest = value => createHash("sha256").update(value).digest();
    if (typeof req.query.token !== "string" || !timingSafeEqual(digest(secret), digest(req.query.token))) {
      return res.sendStatus(401);
    }
    const { event, data, test } = req.body || {};
    if (event !== "track_updated") return res.sendStatus(204);
    const tracking = data?.tracking_status;
    if (typeof test !== "boolean" || typeof data?.transaction !== "string" ||
        !validStatus(tracking?.status) || !Number.isFinite(Date.parse(tracking?.status_date))) {
      return res.sendStatus(400);
    }
    const label = db.prepare(`SELECT id, orderId FROM shipping_labels WHERE shippoTransactionId = ?
      AND trackingNumber = ? AND LOWER(carrier) = LOWER(?) AND testMode = ?`)
      .get(data.transaction, String(data.tracking_number || ""), String(data.carrier || ""), Number(test));
    if (label) applyTracking(label.orderId, label.id, tracking.status, tracking.status_date, test);
    res.sendStatus(204);
    void deliverNotifications().catch(console.error);
  });

  router.use(authRequired);
  router.get("/orders/:id/tracking", (req, res) => {
    const customerId = req.user?.customerId;
    if (!customerId) return res.status(403).json({ error: "Customer account required" });
    const order = db.prepare("SELECT id, orderNumber, deliveredAt FROM orders WHERE id = ? AND customerId = ?")
      .get(req.params.id, customerId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const labels = activeLabels(order.id);
    const tracking = labels.map(label => ({
      labelId: label.id, carrier: label.carrier, service: label.service,
      number: label.trackingNumber, url: label.trackingUrl, labelCreatedAt: label.purchasedAt,
      carrierStatus: label.carrierTrackingStatus || "", checkedAt: label.carrierTrackingCheckedAt || null
    }));
    const state = progress(order.id, labels);
    const { pickedUp, delivered, complete, status: shippingStatus } = state;
    const allPackagesAccepted = complete && labels.length > 0 && pickedUp === labels.length
      && !["RETURNED", "DELIVERY_FAILURE", "UNVERIFIED"].includes(shippingStatus);
    return res.json({
      orderId: order.id, orderNumber: order.orderNumber,
      shippingStatus, carrierAcceptanceConfirmed: pickedUp > 0,
      allPackagesAccepted,
      allItemsLabeled: complete, packageCount: labels.length, pickedUpCount: pickedUp, deliveredCount: delivered,
      deliveredAt: order.deliveredAt || null,
      tracking: tracking[0] || null, packages: tracking
    });
  });
  // Refresh uses the same tracking transitions as the Shippo webhook.
  router.post("/admin/orders/:id/refresh-tracking", async (req,res) => {
    if (req.user?.role !== "admin") return res.status(403).json({error:"Admin only"});
    const order=db.prepare("SELECT id, deliveredAt FROM orders WHERE id = ?").get(req.params.id);
    if(!order)return res.status(404).json({error:"Order not found"});
    const labels=activeLabels(order.id);
    const selectedId = String(req.body?.labelId || "");
    if (labels.length > 1 && !selectedId) return res.status(400).json({error:"Select a package labelId to refresh"});
    const label = selectedId ? labels.find(item => item.id === selectedId) : labels[0];
    if(!label?.carrier || !label?.trackingNumber)return res.status(409).json({error:"No active label with carrier and tracking number"});
    const token=process.env.SHIPPO_API_TOKEN;
    if(!token)return res.status(503).json({error:"Shippo is not configured"});
    if (Boolean(label.testMode) !== token.startsWith("shippo_test_")) return res.status(409).json({error:"Shippo mode does not match this label"});
    try {
      const url=`https://api.goshippo.com/tracks/${encodeURIComponent(label.carrier)}/${encodeURIComponent(label.trackingNumber)}`;
      const response=await fetch(url,{headers:{Authorization:`ShippoToken ${token}`},signal:AbortSignal.timeout(12000)});
      if(!response.ok)return res.status(502).json({error:"Shippo tracking lookup failed",shippoStatus:response.status});
      const payload=await response.json();
      const status=String(payload?.tracking_status?.status || "").toUpperCase();
      if(!validStatus(status))return res.status(502).json({error:"Unexpected Shippo tracking status"});
      applyTracking(order.id, label.id, status, payload?.tracking_status?.status_date, Boolean(label.testMode));
      const updated = db.prepare("SELECT deliveredAt FROM orders WHERE id = ?").get(order.id);
      res.json({ ok: true, carrierStatus: status, deliveredAt: updated.deliveredAt || null });
      void deliverNotifications().catch(console.error);
    } catch(error) {
      return res.status(502).json({error:"Could not verify tracking with Shippo"});
    }
  });
  return router;
}

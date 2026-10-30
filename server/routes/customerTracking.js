import { Router } from "express";

// Shippo tracking states are independent of the purchase of a shipping label.
export default function createCustomerTrackingRouter(db, authRequired) {
  const router = Router();
  for (const statement of [
    "ALTER TABLE shipping_labels ADD COLUMN carrierTrackingStatus TEXT DEFAULT ''",
    "ALTER TABLE shipping_labels ADD COLUMN carrierTrackingCheckedAt TEXT DEFAULT ''"
  ]) {
    try { db.exec(statement); } catch (error) {
      if (!String(error.message || "").includes("duplicate column name")) throw error;
    }
  }
  router.use(authRequired);
  const activeLabels = orderId => db.prepare(`SELECT id, carrier, service, trackingNumber, trackingUrl,
    purchasedAt, carrierTrackingStatus, carrierTrackingCheckedAt, packageItemsJson
    FROM shipping_labels WHERE orderId = ? AND shippoTransactionId NOT LIKE 'pending-%'
    AND COALESCE(refundStatus,'') NOT IN ('PENDING','SUCCESS','REFUNDED','PURCHASING','PURCHASE_REVIEW')
    ORDER BY purchasedAt ASC, id ASC`).all(orderId);
  // Never mark an order fully shipped while some ordered units have no label.
  // Legacy labels without allocations remain unverified rather than guessed.
  const fullyAllocated = (orderId, labels) => {
    const row = db.prepare("SELECT itemsJson FROM orders WHERE id = ?").get(orderId);
    let items;
    try { items = JSON.parse(row?.itemsJson || "[]"); } catch { return false; }
    if (!Array.isArray(items) || !items.length || !labels.length) return false;
    const required = new Map();
    for (const item of items) {
      const key = String(item.id || item.sku || "");
      const qty = Number(item.qty || item.quantity || 1);
      if (!key || !Number.isSafeInteger(qty) || qty < 1) return false;
      required.set(key, (required.get(key) || 0) + qty);
    }
    const allocated = new Map();
    for (const label of labels) {
      let parts;
      try { parts = JSON.parse(label.packageItemsJson || "[]"); } catch { return false; }
      if (!Array.isArray(parts) || !parts.length) return false;
      for (const part of parts) {
        const key = String(part.key || "");
        const qty = Number(part.qty);
        if (!required.has(key) || !Number.isSafeInteger(qty) || qty < 1) return false;
        allocated.set(key, (allocated.get(key) || 0) + qty);
      }
    }
    return [...required].every(([key, qty]) => allocated.get(key) === qty);
  };
  const accepted = status => ["TRANSIT","DELIVERED","OUT_FOR_DELIVERY","FAILURE","RETURNED"].includes(status);
  const delivery = status => status === "DELIVERED";
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
    const pickedUp = labels.filter(label => accepted(label.carrierTrackingStatus || "")).length;
    const delivered = labels.filter(label => delivery(label.carrierTrackingStatus || "")).length;
    const complete = fullyAllocated(order.id, labels);
    const shippingStatus = !labels.length ? "NOT_LABELED"
      : complete && delivered === labels.length ? "DELIVERED"
      : complete && pickedUp === labels.length ? "SHIPPED"
      : pickedUp > 0 ? "PARTIALLY_SHIPPED" : "LABEL_CREATED";
    return res.json({
      orderId: order.id, orderNumber: order.orderNumber,
      shippingStatus, carrierAcceptanceConfirmed: pickedUp > 0,
      allPackagesAccepted: complete && labels.length > 0 && pickedUp === labels.length,
      allItemsLabeled: complete, packageCount: labels.length, pickedUpCount: pickedUp, deliveredCount: delivered,
      deliveredAt: order.deliveredAt || null,
      tracking: tracking[0] || null, packages: tracking
    });
  });
  // Explicit admin-only refresh. No label purchases, refunds or customer emails.
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
    try {
      const url=`https://api.goshippo.com/tracks/${encodeURIComponent(label.carrier)}/${encodeURIComponent(label.trackingNumber)}`;
      const response=await fetch(url,{headers:{Authorization:`ShippoToken ${token}`},signal:AbortSignal.timeout(12000)});
      if(!response.ok)return res.status(502).json({error:"Shippo tracking lookup failed",shippoStatus:response.status});
      const payload=await response.json();
      const status=String(payload?.tracking_status?.status || "").toUpperCase();
      if(!["UNKNOWN","PRE_TRANSIT","TRANSIT","DELIVERED","RETURNED","FAILURE","OUT_FOR_DELIVERY"].includes(status))return res.status(502).json({error:"Unexpected Shippo tracking status"});
      const now=new Date().toISOString();
      const rawDate=payload?.tracking_status?.status_date;
      const deliveryDate=status==="DELIVERED" && rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
      db.transaction(()=>{
        db.prepare("UPDATE shipping_labels SET carrierTrackingStatus = ?, carrierTrackingCheckedAt = ? WHERE id = ?").run(status,now,label.id);
        const all = activeLabels(order.id);
        const deliveredAll = all.length > 0 && all.every(item => item.carrierTrackingStatus === "DELIVERED");
        const pickedUpAll = all.length > 0 && all.every(item =>
          ["TRANSIT","OUT_FOR_DELIVERY","DELIVERED","RETURNED","FAILURE"].includes(item.carrierTrackingStatus));
        if (deliveredAll && fullyAllocated(order.id, all)) {
          db.prepare("UPDATE orders SET status = 'DELIVERED' WHERE id = ? AND status IN ('LABEL_CREATED', 'SHIPPED')").run(order.id);
          db.prepare("UPDATE orders SET deliveredAt = COALESCE(deliveredAt, ?) WHERE id = ?").run(deliveryDate || now,order.id);
        } else if (pickedUpAll && fullyAllocated(order.id, all)) {
          db.prepare("UPDATE orders SET status = 'SHIPPED' WHERE id = ? AND status = 'LABEL_CREATED'").run(order.id);
        }
      })();
      return res.json({ok:true,carrierStatus:status,deliveredAt:deliveryDate || order.deliveredAt || null});
    } catch(error) {
      return res.status(502).json({error:"Could not verify tracking with Shippo"});
    }
  });
  return router;
}

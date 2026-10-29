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
  const activeLabel = orderId => db.prepare(`SELECT id, carrier, service, trackingNumber, trackingUrl,
    purchasedAt, carrierTrackingStatus, carrierTrackingCheckedAt
    FROM shipping_labels WHERE orderId = ? AND shippoTransactionId NOT LIKE 'pending-%'
    AND COALESCE(refundStatus,'') NOT IN ('PENDING','SUCCESS','REFUNDED')
    ORDER BY purchasedAt DESC LIMIT 1`).get(orderId);
  router.get("/orders/:id/tracking", (req, res) => {
    const customerId = req.user?.customerId;
    if (!customerId) return res.status(403).json({ error: "Customer account required" });
    const order = db.prepare("SELECT id, orderNumber, deliveredAt FROM orders WHERE id = ? AND customerId = ?")
      .get(req.params.id, customerId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const label = activeLabel(order.id);
    const carrierStatus = label?.carrierTrackingStatus || "";
    const accepted = ["TRANSIT","DELIVERED","OUT_FOR_DELIVERY","FAILURE","RETURNED"].includes(carrierStatus);
    return res.json({
      orderId: order.id, orderNumber: order.orderNumber,
      shippingStatus: order.deliveredAt ? "DELIVERED" : accepted ? "SHIPPED" : label ? "LABEL_CREATED" : "NOT_LABELED",
      carrierAcceptanceConfirmed: accepted,
      deliveredAt: order.deliveredAt || null,
      tracking: label ? {
        carrier: label.carrier, service: label.service, number: label.trackingNumber,
        url: label.trackingUrl, labelCreatedAt: label.purchasedAt,
        carrierStatus, checkedAt: label.carrierTrackingCheckedAt || null
      } : null
    });
  });
  // Explicit admin-only refresh. No label purchases, refunds or customer emails.
  router.post("/admin/orders/:id/refresh-tracking", async (req,res) => {
    if (req.user?.role !== "admin") return res.status(403).json({error:"Admin only"});
    const order=db.prepare("SELECT id, deliveredAt FROM orders WHERE id = ?").get(req.params.id);
    if(!order)return res.status(404).json({error:"Order not found"});
    const label=activeLabel(order.id);
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
        if(deliveryDate)db.prepare("UPDATE orders SET deliveredAt = COALESCE(deliveredAt, ?) WHERE id = ?").run(deliveryDate,order.id);
      })();
      return res.json({ok:true,carrierStatus:status,deliveredAt:deliveryDate || order.deliveredAt || null});
    } catch(error) {
      return res.status(502).json({error:"Could not verify tracking with Shippo"});
    }
  });
  return router;
}

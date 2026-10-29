import { Router } from "express";

// Read-only customer tracking; label purchase does not prove carrier acceptance.
export default function createCustomerTrackingRouter(db, authRequired) {
  const router = Router();
  router.use(authRequired);
  router.get("/orders/:id/tracking", (req, res) => {
    const customerId = req.user?.customerId;
    if (!customerId) return res.status(403).json({ error: "Customer account required" });
    const order = db.prepare("SELECT id, orderNumber, status, deliveredAt FROM orders WHERE id = ? AND customerId = ?")
      .get(req.params.id, customerId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const label = db.prepare(`SELECT carrier, service, trackingNumber, trackingUrl, purchasedAt
      FROM shipping_labels WHERE orderId = ? AND shippoTransactionId NOT LIKE 'pending-%'
      AND COALESCE(refundStatus,'') NOT IN ('PENDING','SUCCESS','REFUNDED')
      ORDER BY purchasedAt DESC LIMIT 1`).get(order.id);
    const status = order.deliveredAt ? "DELIVERED" : label ? "LABEL_CREATED" : "NOT_LABELED";
    return res.json({
      orderId: order.id, orderNumber: order.orderNumber,
      shippingStatus: status,
      // Carrier acceptance requires a verified Shippo tracking event, not orders.status.
      carrierAcceptanceConfirmed: false,
      deliveredAt: order.deliveredAt || null,
      tracking: label ? {
        carrier: label.carrier, service: label.service,
        number: label.trackingNumber, url: label.trackingUrl,
        labelCreatedAt: label.purchasedAt
      } : null
    });
  });
  return router;
}

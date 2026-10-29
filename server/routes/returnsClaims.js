import { Router } from "express";
import crypto from "node:crypto";

export default function createReturnsClaimsRouter(db, authRequired) {
  const router = Router();
  db.exec(`
    CREATE TABLE IF NOT EXISTS returns_claims (
      id TEXT PRIMARY KEY,
      orderId TEXT NOT NULL,
      customerId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('RETURN','WARRANTY','CORE','DAMAGE')),
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      shippingChoice TEXT NOT NULL DEFAULT '',
      originalBoxConfirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
      adminNotes TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_returns_claims_customer ON returns_claims(customerId);
    CREATE INDEX IF NOT EXISTS idx_returns_claims_order ON returns_claims(orderId);
  `);
  router.use(authRequired);
  const daysSince = iso => (Date.now() - new Date(iso).getTime()) / 86400000;
  router.get("/me", (req,res) => {
    if (!req.user?.customerId) return res.status(403).json({error:"Customer only"});
    return res.json(db.prepare("SELECT * FROM returns_claims WHERE customerId = ? ORDER BY createdAt DESC").all(req.user.customerId));
  });
  router.post("/", (req,res) => {
    const customerId = req.user?.customerId;
    if (!customerId) return res.status(403).json({error:"Customer only"});
    const {orderId,kind,sku,quantity=1,reason,shippingChoice="",originalBoxConfirmed=false}=req.body||{};
    if (!["RETURN","WARRANTY","CORE","DAMAGE"].includes(kind)) return res.status(400).json({error:"Invalid request type"});
    if (!orderId || !sku || !String(reason||"").trim() || !Number.isSafeInteger(Number(quantity)) || Number(quantity)<1 || Number(quantity)>1000) return res.status(400).json({error:"Order, product, quantity and reason are required"});
    const order=db.prepare("SELECT * FROM orders WHERE id = ? AND customerId = ?").get(String(orderId),customerId);
    if (!order) return res.status(404).json({error:"Order not found"});
    const items=JSON.parse(order.itemsJson||"[]");
    const item=items.find(p=>String(p.sku||"")===String(sku));
    if (!item || Number(quantity)>Number(item.qty||item.quantity||1)) return res.status(400).json({error:"Item or quantity not in order"});
    // No delivery timestamp means no invented return window.
    if (["RETURN","CORE"].includes(kind)) {
      if (!order.deliveredAt || !Number.isFinite(new Date(order.deliveredAt).getTime())) return res.status(409).json({error:"Delivery date not yet confirmed. Contact support to request a return."});
      const elapsed=daysSince(order.deliveredAt);
      if (elapsed<0 || elapsed>15) return res.status(409).json({error:"15-day return window has expired or delivery date is invalid"});
    }
    if (kind==="CORE" && (!originalBoxConfirmed || !["DDA_LABEL","OWN_SHIPPING"].includes(shippingChoice))) return res.status(400).json({error:"Confirm original product box and select core shipping method"});
    // Warranty eligibility, hazmat status and core deposits must be validated against
    // immutable order-item metadata before these cases can be approved.
    const now=new Date().toISOString(),id=crypto.randomUUID();
    db.prepare("INSERT INTO returns_claims (id,orderId,customerId,kind,sku,quantity,reason,shippingChoice,originalBoxConfirmed,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,order.id,customerId,kind,String(sku),Number(quantity),String(reason).trim().slice(0,4000),kind==="CORE"?shippingChoice:"",kind==="CORE"?1:0,now,now);
    return res.status(201).json({id,status:"PENDING_REVIEW",message:"Request submitted for admin review. No label or refund has been issued."});
  });
  router.get("/admin", (req,res)=>{
    if(req.user?.role!=="admin")return res.status(403).json({error:"Admin only"});
    return res.json(db.prepare("SELECT * FROM returns_claims ORDER BY createdAt DESC LIMIT 500").all());
  });
  router.patch("/admin/:id", (req,res)=>{
    if(req.user?.role!=="admin")return res.status(403).json({error:"Admin only"});
    const status=String(req.body?.status||"");
    if(!["PENDING_REVIEW","MORE_INFO_REQUIRED","REJECTED"].includes(status))return res.status(400).json({error:"Only review or rejection is available until eligibility verification and payment integrations are complete"});
    const result=db.prepare("UPDATE returns_claims SET status = ?,adminNotes = ?,updatedAt = ? WHERE id = ?").run(status,String(req.body?.adminNotes||"").slice(0,4000),new Date().toISOString(),req.params.id);
    return result.changes?res.json({ok:true}):res.status(404).json({error:"Request not found"});
  });
  return router;
}

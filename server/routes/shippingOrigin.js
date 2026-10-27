import { Router } from "express";

// Admin-controlled origin for future shipments; existing orders are never changed.
export default function createShippingOriginRouter(db, authRequired) {
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_origin (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    name TEXT NOT NULL, street1 TEXT NOT NULL, street2 TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'US', phone TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL
  )`);
  db.prepare(`INSERT OR IGNORE INTO shipping_origin
    (id, name, street1, street2, city, state, zip, country, phone, updatedAt)
    VALUES (1, 'DDA Auto Parts', '11115 W Okeechobee Rd', 'Unit 170',
      'Hialeah Gardens', 'FL', '33018', 'US', '', ?)`).run(new Date().toISOString());

  const router = Router();
  router.use(authRequired);
  router.use((req, res, next) => req.user?.role === "admin"
    ? next() : res.status(403).json({ error: "Admin only" }));

  router.get("/", (_req, res) => res.json({
    origin: db.prepare("SELECT * FROM shipping_origin WHERE id = 1").get(),
  }));
  router.put("/", (req, res) => {
    const fields = ["name", "street1", "street2", "city", "state", "zip", "phone"];
    const origin = Object.fromEntries(fields.map(k => [k, String(req.body?.[k] ?? "").trim()]));
    if (["name", "street1", "city", "state", "zip"].some(k => !origin[k]))
      return res.status(400).json({ error: "Name, street, city, state and ZIP are required" });
    if (!/^\\d{5}(?:-\\d{4})?$/.test(origin.zip) || !/^[A-Za-z]{2}$/.test(origin.state))
      return res.status(400).json({ error: "Invalid US ZIP or state" });
    if (fields.some(k => origin[k].length > 150))
      return res.status(400).json({ error: "Field too long" });
    db.prepare(`UPDATE shipping_origin SET name=@name, street1=@street1,
      street2=@street2, city=@city, state=@state, zip=@zip, phone=@phone,
      updatedAt=@updatedAt WHERE id=1`).run({ ...origin, state: origin.state.toUpperCase(),
      updatedAt: new Date().toISOString() });
    res.json({ origin: db.prepare("SELECT * FROM shipping_origin WHERE id = 1").get() });
  });
  return router;
}

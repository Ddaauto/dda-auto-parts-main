import { Router } from "express";
import crypto from "crypto";
import { INITIAL_SHIPPING_BOXES, validateShippingBox, recommendBoxForItems } from "../shippingBoxes.js";

export default function createShippingBoxesRouter(db, authRequired) {
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_boxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lengthIn REAL NOT NULL,
    widthIn REAL NOT NULL,
    heightIn REAL NOT NULL,
    emptyWeightOz REAL,
    weightSource TEXT NOT NULL DEFAULT 'unknown',
    active INTEGER NOT NULL DEFAULT 1
  )`);
  const count = db.prepare("SELECT COUNT(*) AS n FROM shipping_boxes").get().n;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO shipping_boxes
      (id, name, lengthIn, widthIn, heightIn, emptyWeightOz, weightSource, active)
      VALUES (@id, @name, @lengthIn, @widthIn, @heightIn, @emptyWeightOz, @weightSource, @active)`);
    db.transaction(() => {
      for (const box of INITIAL_SHIPPING_BOXES) insert.run({ ...box, active: 1 });
    })();
  }

  const router = Router();
  router.use(authRequired);
  router.use((req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });

  // Packing preview only: no order modification, carrier quote, or label purchase.
  router.post("/recommend", (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return res.status(400).json({ error: "Provide 1 to 50 items" });
    }
    let count = 0;
    for (const item of items) {
      const qty = Number(item.qty);
      count += qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > 50 || count > 50 ||
          !["lengthIn", "widthIn", "heightIn"].every(k =>
            Number.isFinite(Number(item[k])) && Number(item[k]) > 0)) {
        return res.status(400).json({ error: "Valid dimensions and quantities are required; do not guess them" });
      }
    }
    const boxes = db.prepare("SELECT * FROM shipping_boxes WHERE active = 1").all();
    const box = recommendBoxForItems(items, boxes);
    if (!box) return res.json({ box: null, warning: "No confirmed fit; choose packaging manually" });
    const weightsKnown = items.every(it => it.weightOz !== "" && it.weightOz != null &&
      Number.isFinite(Number(it.weightOz)) && Number(it.weightOz) > 0);
    const boxWeightKnown = box.emptyWeightOz != null && Number.isFinite(Number(box.emptyWeightOz));
    const totalWeightOz = weightsKnown && boxWeightKnown
      ? items.reduce((sum, it) => sum + Number(it.weightOz) * Number(it.qty), Number(box.emptyWeightOz))
      : null;
    return res.json({
      box: { ...box, active: Boolean(box.active) },
      totalWeightOz,
      estimated: !weightsKnown || !boxWeightKnown || box.weightSource !== "measured" ||
        items.some(it => it.weightSource !== "measured"),
      warning: "Packing is provisional. Verify dimensions, cushioning and final weight before purchasing a label.",
    });
  });

  router.get("/", (_req, res) => {
    const boxes = db.prepare("SELECT * FROM shipping_boxes ORDER BY name").all();
    res.json({ boxes: boxes.map((b) => ({ ...b, active: Boolean(b.active) })) });
  });

  router.post("/", (req, res) => {
    try {
      const box = validateShippingBox(req.body);
      const name = String(req.body?.name || "").trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "Box name required" });
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO shipping_boxes
        (id, name, lengthIn, widthIn, heightIn, emptyWeightOz, weightSource, active)
        VALUES (@id, @name, @lengthIn, @widthIn, @heightIn, @emptyWeightOz, @weightSource, @active)`)
        .run({ id, name, ...box, active: Number(box.active) });
      return res.status(201).json({ id });
    } catch (err) { return res.status(400).json({ error: err.message }); }
  });

  router.put("/:id", (req, res) => {
    try {
      const old = db.prepare("SELECT * FROM shipping_boxes WHERE id = ?").get(req.params.id);
      if (!old) return res.status(404).json({ error: "Box not found" });
      const box = validateShippingBox({ ...old, ...req.body });
      const name = String(req.body?.name ?? old.name).trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "Box name required" });
      db.prepare(`UPDATE shipping_boxes SET name=@name, lengthIn=@lengthIn,
        widthIn=@widthIn, heightIn=@heightIn, emptyWeightOz=@emptyWeightOz,
        weightSource=@weightSource, active=@active WHERE id=@id`)
        .run({ id: old.id, name, ...box, active: Number(box.active) });
      return res.json({ ok: true });
    } catch (err) { return res.status(400).json({ error: err.message }); }
  });

  router.delete("/:id", (req, res) => {
    const result = db.prepare("DELETE FROM shipping_boxes WHERE id = ?").run(req.params.id);
    return result.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Box not found" });
  });
  return router;
}

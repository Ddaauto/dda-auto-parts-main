import { Router } from "express";
import crypto from "crypto";
import { INITIAL_SHIPPING_BOXES, validateShippingBox } from "../shippingBoxes.js";

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

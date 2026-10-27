import { Router } from "express";

// Admin-only, read-only rate lookup. No labels are purchased and no orders are changed.
export default function createShippoRatesRouter(db, authRequired) {
  const router = Router();
  router.use(authRequired);
  router.use((req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
  router.post("/rates", async (req, res) => {
    const token = process.env.SHIPPO_API_TOKEN;
    if (!token) return res.status(503).json({ error: "Shippo is not configured on this server" });
    const { box, destination } = req.body || {};
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
      return res.json({
        shipmentId: data.object_id,
        rates: (data.rates || []).map(rate => ({
          id: rate.object_id,
          carrier: rate.provider,
          service: rate.servicelevel?.name || rate.servicelevel?.token || "",
          amount: rate.amount,
          currency: rate.currency,
          estimatedDays: rate.estimated_days ?? null,
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
  return router;
}

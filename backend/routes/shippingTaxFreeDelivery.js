// backend/routes/shippingTaxFreeDelivery.js
// =====================================================
// DDA AUTO PARTS — Shipping Quote (USPS/UPS/FedEx + Uber + Free Delivery)
// - Uber: estimado $10–$20 si <= 20 miles desde ZIP 33010 (requiere zip_geo)
// - Free Delivery: SOLO si customers.freeDelivery = 1 (no visible para otros)
// - NO cambia tu /orders actual (no hay conflicto)
// =====================================================

const ORIGIN_ZIP = "33010";
const UBER_MAX_MILES = 20;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613; // miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// price between $10 and $20 depending on miles
function uberEstimateFromMiles(miles) {
  const min = 10;
  const max = 20;
  const start = 5;  // <=5mi => $10
  const end = 20;   // 20mi => $20
  if (miles <= start) return min;
  const t = (miles - start) / (end - start);
  return clamp(min + t * (max - min), min, max);
}

// Try to extract ZIP from customers.address (JSON preferred, fallback regex)
function extractZipFromCustomerAddress(addressValue) {
  if (!addressValue) return null;

  if (typeof addressValue === "object") {
    const z = String(addressValue.zip || "").trim();
    return /^\d{5}$/.test(z) ? z : null;
  }

  const s = String(addressValue);

  // Try JSON first
  try {
    const obj = JSON.parse(s);
    const z = String(obj?.zip || "").trim();
    if (/^\d{5}$/.test(z)) return z;
  } catch (_) {}

  // Fallback: regex for 5 digits
  const m = s.match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

function safeHasZipGeo(db) {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='zip_geo'"
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

export function registerShippingTaxFreeDeliveryRoutes(app, db, auth) {
  // POST /shipping/quote  ✅ (esto es lo que tu App.jsx llama)
  app.post("/shipping/quote", auth, (req, res) => {
    try {
      const { items = [] } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "No items" });
      }

      const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId);
      if (!customer) return res.status(404).json({ error: "Customer not found" });

      // ===== tu modelo actual (peso -> base) =====
      const totalWeightLb = items.reduce((s, it) => {
        const w = Number(it.weightLb || 1);
        const q = Number(it.qty || 1);
        return s + Math.max(0.1, w) * Math.max(1, q);
      }, 0);

      const base = Math.max(6, totalWeightLb * 1.8);

      const options = [
        { id: "usps", carrier: "USPS", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 6).toFixed(2)) },
        { id: "ups", carrier: "UPS", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 14).toFixed(2)) },
        { id: "fedex", carrier: "FedEx", service: "Service selected by provider", eta: "Provider estimate", amount: Number((base + 18).toFixed(2)) },
      ];

      // ===== UBER (solo si zip_geo existe y distancia <= 20mi) =====
      const canUseZipGeo = safeHasZipGeo(db);
      if (canUseZipGeo) {
        const destZip = extractZipFromCustomerAddress(customer.address);
        if (destZip) {
          const origin = db.prepare("SELECT lat, lon FROM zip_geo WHERE zip = ?").get(ORIGIN_ZIP);
          const dest = db.prepare("SELECT lat, lon FROM zip_geo WHERE zip = ?").get(destZip);

          if (origin && dest) {
            const miles = haversineMiles(origin.lat, origin.lon, dest.lat, dest.lon);
            if (miles <= UBER_MAX_MILES) {
              const est = Number(uberEstimateFromMiles(miles).toFixed(2));
              options.push({
                id: "uber",
                carrier: "Uber",
                service: `Same-day local (Estimated ${miles.toFixed(1)} mi)`,
                eta: "Same-day",
                amount: est,
              });
            }
          }
        }
      }

      // ===== FREE DELIVERY (solo aprobados) =====
      if (Number(customer.freeDelivery) === 1) {
        options.push({
          id: "free",
          carrier: "Free Delivery",
          service: "Approved customer only",
          eta: "1–3 days (local)",
          amount: 0,
        });
      }

      return res.json({
        weightLb: Number(totalWeightLb.toFixed(2)),
        options,
      });
    } catch (e) {
      return res.status(500).json({ error: "Quote failed" });
    }
  });
}

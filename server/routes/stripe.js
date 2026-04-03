// server/routes/stripe.js
import express from "express";
import Stripe from "stripe";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

// Health check
router.get("/stripe/ping", (req, res) => {
  res.json({ ok: true });
});

// Create Checkout Session (NO orderId)
router.post("/stripe/create-checkout-session", async (req, res) => {
  try {
    const { items, selectedShippingId, vehicle, customerEmail } = req.body || {};


    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing items" });
    }
    if (!selectedShippingId) {
      return res.status(400).json({ error: "Missing selectedShippingId" });
    }

    const line_items = items.map((i) => {
      const qty = Math.max(1, Number(i.qty || 1));
      const unit_amount = Math.round(Number(i.price || 0) * 100);

      if (!Number.isFinite(unit_amount) || unit_amount <= 0) {
        throw new Error(`Invalid item price for ${i?.name || "item"}`);
      }

      return {
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount,
          product_data: {
            name: String(i.name || "Item"),
          },
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url:
        process.env.STRIPE_SUCCESS_URL ||
        "http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        process.env.STRIPE_CANCEL_URL ||
        "http://localhost:5173/checkout",
      metadata: {
  selectedShippingId: String(selectedShippingId),
  vehicleLabel: String(vehicle?.label || ""),
  vehicleVin: String(vehicle?.vin || ""),
  customerEmail: String(customerEmail || ""),
},
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe create-checkout-session error:", err);
    return res.status(500).json({ error: err?.message || "Stripe error" });
  }
});

export default router;

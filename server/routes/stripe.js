import express from "express";

export default function createStripeRouter({ stripe, db, authRequired, computeShippingOptionsAdvanced, calcTax }) {
  const router = express.Router();
  router.get("/stripe/ping", (_req, res) => res.json({ ok: true }));

  router.post("/stripe/create-checkout-session", authRequired, async (req, res) => {
    const { items, selectedShippingId, vehicle } = req.body || {};
    if (!Array.isArray(items) || !items.length || !selectedShippingId) {
      return res.status(400).json({ error: "Cart and shipping option are required" });
    }
    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.user.customerId ?? null);
    if (!customer) return res.status(403).json({ error: "Customer account required" });

    const getProduct = db.prepare("SELECT sku, name, price_cents, stock FROM products WHERE sku = ? AND active = 1");
    const products = new Map();
    for (const item of items) {
      const sku = String(item?.sku || "").trim();
      const product = getProduct.get(sku);
      const qty = Number(item?.qty);
      const totalQty = qty + (products.get(sku)?.qty || 0);
      if (!product || !Number.isSafeInteger(qty) || qty <= 0 || totalQty > product.stock || product.price_cents <= 0) {
        return res.status(400).json({ error: "Invalid product quantity, price or availability" });
      }
      products.set(sku, { ...product, qty: totalQty, weightLb: 1 });
    }
    const cart = [...products.values()];
    const { options } = computeShippingOptionsAdvanced({ items: cart, customer });
    const shipping = options.find(option => option.id === selectedShippingId);
    if (!shipping) return res.status(400).json({ error: "Shipping method is unavailable" });

    const subtotal = cart.reduce((sum, item) => sum + item.price_cents * item.qty, 0);
    const lineItems = cart.map(item => ({
      quantity: item.qty,
      price_data: {
        currency: "usd",
        unit_amount: item.price_cents,
        product_data: { name: item.name, metadata: { sku: item.sku } },
      },
    }));
    for (const [name, amount] of [["Shipping", shipping.amount], ["Sales tax", calcTax(subtotal / 100, customer)]]) {
      const cents = Math.round(amount * 100);
      if (cents > 0) lineItems.push({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: cents, product_data: { name, metadata: { checkoutFee: name } } },
      });
    }
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: lineItems,
        success_url: process.env.STRIPE_SUCCESS_URL ||
          "http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: process.env.STRIPE_CANCEL_URL || "http://localhost:5173/checkout",
        metadata: {
          checkoutPricing: "server-v1",
          selectedShippingId,
          vehicleLabel: String(vehicle?.label || "").slice(0, 500),
          vehicleVin: String(vehicle?.vin || "").slice(0, 500),
          customerEmail: customer.email,
        },
      });
      return res.json({ url: session.url });
    } catch (error) {
      console.error("Stripe Checkout creation failed:", error.message);
      return res.status(502).json({ error: "Could not start Stripe Checkout" });
    }
  });
  return router;
}

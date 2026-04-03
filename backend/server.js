require("dotenv").config();
const KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
console.log("KEY prefix:", KEY.slice(0, 12));
console.log("KEY length:", KEY.length);
console.log("KEY suffix:", KEY.slice(-4));

const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(KEY);

const app = express();
app.use(cors());
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: items.map((i) => ({
        price_data: {
          currency: "usd",
          product_data: { name: i.name },
          unit_amount: Math.round(Number(i.price) * 100),
        },
        quantity: Number(i.qty || 1),
      })),
      success_url: "http://localhost:5173/?success=1",
      cancel_url: "http://localhost:5173/?cancel=1",
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 4242, () =>
  console.log("Stripe backend listo en http://localhost:4242")
);

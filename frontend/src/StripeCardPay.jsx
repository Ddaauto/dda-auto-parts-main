import { useMemo, useState } from "react";
import { CardElement, useElements, useStripe } from "@stripe/react-stripe-js";

const API = import.meta.env.VITE_API_URL || "http://localhost:5177";

export default function StripeCardPay({
  items = [],
  selectedShippingId = "",
  token = "",
  vehicle = {},
  onSuccess,
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const cleanItems = useMemo(() => {
    return (items || []).map((it) => ({
      id: it.id,
      name: it.name,
      sku: it.sku,
      mpn: it.mpn,
      brand: it.brand,
      price: Number(it.price || 0),
      qty: Number(it.qty || 1),
      weightLb: Number(it.weightLb || 1),
    }));
  }, [items]);

  async function handlePay() {
  setErr("");

  if (!Array.isArray(cleanItems) || cleanItems.length === 0) {
    setErr("Cart is empty.");
    return;
  }

  if (!selectedShippingId) {
    setErr("Select a shipping method first.");
    return;
  }

  setBusy(true);
  try {
    const r = await fetch(`${API}/stripe/create-checkout-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        items: cleanItems,
        selectedShippingId,
        vehicle,
      }),
    });

    const d = await r.json();
    if (!d?.url) throw new Error("Failed to create checkout session");

    window.location.href = d.url;
  } catch (e) {
    setErr(String(e?.message || e));
  } finally {
    setBusy(false);
  }
}


  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
        <CardElement options={{ hidePostalCode: true }} />
      </div>

      {err && <div style={{ color: "crimson" }}>{err}</div>}

      <button onClick={handlePay} disabled={busy || !stripe || !elements}>
        {busy ? "Processing..." : "Pay with Card"}
      </button>
    </div>
  );
}

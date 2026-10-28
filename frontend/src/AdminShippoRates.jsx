import React, { useEffect, useState } from "react";

export default function AdminShippoRates({ api }) {
  const [form, setForm] = useState({
    lengthIn: "", widthIn: "", heightIn: "", weightOz: "",
    toStreet: "", toCity: "", toState: "", toZip: "",
  });
  const [origin, setOrigin] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [ordersError, setOrdersError] = useState("");
  const loadOrders = async () => {
    try {
      const res = await fetch(`${api}/admin/shippo/orders`, { headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load orders");
      setOrders(data.orders || []);
    } catch (err) { setOrdersError(err.message); }
  };
  useEffect(() => { loadOrders(); }, [api]);
  const chooseOrder = id => {
    const order = orders.find(o => o.id === id) || null;
    setSelectedOrder(order);
    setRates(null);
    if (order) setForm(old => ({ ...old, toStreet: order.customer.street1, toCity: order.customer.city, toState: order.customer.state, toZip: order.customer.zip }));
  };
  const [originError, setOriginError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`${api}/admin/shipping-origin`, { headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` } })
      .then(async res => { const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || `Origin request failed (${res.status})`); return data.origin; })
      .then(value => { if (active) setOrigin(value); })
      .catch(err => { if (active) setOriginError(err.message); });
    return () => { active = false; };
  }, [api]);
  const [rates, setRates] = useState(null);
  const [error, setError] = useState("");
  const formatDate = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : null;
  const sortedRates = [...(rates?.rates || [])].sort((a, b) => Number(a.amount) - Number(b.amount));
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setForm(old => ({ ...old, [key]: value }));
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError(""); setRates(null);
    try {
      const token = localStorage.getItem("token") || "";
      const res = await fetch(`${api}/admin/shippo/rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          box: {
            lengthIn: Number(form.lengthIn), widthIn: Number(form.widthIn),
            heightIn: Number(form.heightIn), weightOz: Number(form.weightOz),
          },
          destination: { street1: form.toStreet, city: form.toCity, state: form.toState, zip: form.toZip },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Rate request failed (${res.status})`);
      setRates(data);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const field = (key, label, type = "text") => <label key={key} style={{ display: "grid", gap: 4 }}>
    {label}
    <input className="input" type={type} required min={type === "number" ? "0.01" : undefined}
      step={type === "number" ? "any" : undefined}
      value={form[key]} onChange={e => update(key, e.target.value)} />
  </label>;
  return <div className="card" style={{ marginTop: 16 }}>
    <h2>Shippo – Live shipping rates</h2>
    <p>Admin preview only. Enter verified package dimensions and total packed weight. No label is purchased and no order is changed.</p>
    <section style={{ margin: "20px 0", padding: 20, background: "#f8fafc", borderRadius: 12 }}>
      <h3 style={{ marginTop: 0 }}>Order details</h3>
      <label style={{ display: "grid", gap: 8, maxWidth: 520 }}>Select DDA Auto Parts order
        <select className="input" value={selectedOrder?.id || ""} onChange={e => chooseOrder(e.target.value)}>
          <option value="">Manual rate lookup (no order selected)</option>
          {orders.map(order => <option key={order.id} value={order.id}>{order.orderNumber || order.invoiceId || order.id} — {order.customer.name || order.customer.email}</option>)}
        </select>
      </label>
      {ordersError && <p role="alert" style={{ color: "#dc2626" }}>{ordersError}</p>}
      {!orders.length && !ordersError && <p style={{ color: "#64748b" }}>No orders yet. You can still check rates manually. Orders will appear here automatically.</p>}
      {selectedOrder && <div style={{ marginTop: 16 }}>
        <p><strong>Order:</strong> {selectedOrder.orderNumber || selectedOrder.invoiceId} · <strong>Customer:</strong> {selectedOrder.customer.name || selectedOrder.customer.email}</p>
        <p><strong>Ship to:</strong> {[selectedOrder.customer.street1, selectedOrder.customer.city, selectedOrder.customer.state, selectedOrder.customer.zip].filter(Boolean).join(", ") || "Missing shipping address"}</p>
        <h4>Products in shipment</h4>
        {selectedOrder.items.length ? selectedOrder.items.map((item, index) => <div key={item.id || index} style={{ display: "flex", justifyContent: "space-between", padding: "12px 4px", borderBottom: "1px solid #e2e8f0" }}><span><strong>{item.name}</strong>{item.sku && <small style={{ display: "block", color: "#64748b" }}>SKU: {item.sku}</small>}</span><strong>Qty: {item.qty}</strong></div>) : <p>No product details available.</p>}
      </div>}
    </section>
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <h3>Package (inches / ounces)</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("lengthIn", "Length (in)", "number")}
        {field("widthIn", "Width (in)", "number")}
        {field("heightIn", "Height (in)", "number")}
        {field("weightOz", "Packed weight (oz)", "number")}
      </div>
      <h3>Ship from (saved ADMIN address)</h3>
      {originError && <p role="alert" style={{ color: "#dc2626" }}>Unable to load saved origin: {originError}</p>}
      {origin ? <p>{[origin.name, origin.street1, origin.street2, origin.city, origin.state, origin.zip].filter(Boolean).join(", ")}</p> : !originError && <p>Loading saved shipping origin...</p>}
      <p>To change this address, use the Shipping Origin tab.</p>
      <h3>Ship to {selectedOrder ? "(from customer order — review before quoting)" : ""}</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("toStreet", "Street address")}
        {field("toCity", "City")}
        {field("toState", "State")}
        {field("toZip", "ZIP")}
      </div>
      <button className="btn btnPrimary" type="submit" disabled={busy || !origin}>
        {busy ? "Checking rates..." : "Get Shippo rates"}
      </button>
    </form>
    {error && <p role="alert" style={{ color: "#dc2626" }}>{error}</p>}
    {rates && <div style={{ marginTop: 16 }}>
      <h3>Available rates {rates.rates?.length ? `(${rates.rates.length})` : ""}</h3>
      {!rates.rates?.length && <p>No rates returned for this package and address.</p>}
      <p style={{ color: "#64748b", marginTop: 4 }}>Sorted by price: lowest to highest. Delivery windows are approximate, not guaranteed; carrier schedules may vary.</p>
      {rates.plannedShipDate && <p style={{ marginTop: 8, fontWeight: 600 }}>Planned ship date: {formatDate(rates.plannedShipDate)}</p>}
      <div style={{ overflowX: "auto", marginTop: 16 }}>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "separate", borderSpacing: "0 8px", minWidth: 680 }}>
          <thead><tr style={{ color: "#475569" }}>
            {["Carrier", "Service", "Price", "Estimated delivery", "Mode"].map(label =>
              <th key={label} style={{ padding: "12px 18px", fontSize: 13, fontWeight: 700 }}>{label}</th>)}
          </tr></thead>
          <tbody>{sortedRates.map((rate, index) => <tr key={rate.id || index} style={{ background: index === 0 ? "#ecfdf5" : "#f8fafc" }}>
            <td style={{ padding: "18px", borderRadius: "10px 0 0 10px", fontWeight: 700 }}>{rate.carrier}</td>
            <td style={{ padding: "18px" }}>{rate.service}{index === 0 && <span style={{ display: "inline-block", marginLeft: 10, padding: "4px 9px", background: "#047857", color: "#fff", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>Lowest price</span>}</td>
            <td style={{ padding: "18px", fontWeight: 800, fontSize: 17, whiteSpace: "nowrap" }}>{Number(rate.amount).toFixed(2)} {rate.currency}</td>
            <td style={{ padding: "18px" }}>{rate.estimatedDeliveryStart && rate.estimatedDeliveryEnd ? <><strong>{formatDate(rate.estimatedDeliveryStart)} – {formatDate(rate.estimatedDeliveryEnd)}</strong><div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>Approx. {rate.estimatedDays} transit days + buffer</div></> : "Not provided"}</td>
            <td style={{ padding: "18px", borderRadius: "0 10px 10px 0" }}>{rate.test ? "Test" : "Live"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Rates only. Labels have not been purchased.</p>
    </div>}
  </div>;
}

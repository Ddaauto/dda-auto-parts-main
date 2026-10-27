import React, { useState } from "react";

export default function AdminShippoRates({ api }) {
  const [form, setForm] = useState({
    lengthIn: "", widthIn: "", heightIn: "", weightOz: "",
    fromStreet: "", fromCity: "Hialeah", fromState: "FL", fromZip: "33018",
    toStreet: "", toCity: "", toState: "", toZip: "",
  });
  const [rates, setRates] = useState(null);
  const [error, setError] = useState("");
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
          origin: { street1: form.fromStreet, city: form.fromCity, state: form.fromState, zip: form.fromZip },
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
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <h3>Package (inches / ounces)</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("lengthIn", "Length (in)", "number")}
        {field("widthIn", "Width (in)", "number")}
        {field("heightIn", "Height (in)", "number")}
        {field("weightOz", "Packed weight (oz)", "number")}
      </div>
      <h3>Ship from</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("fromStreet", "Street address")}
        {field("fromCity", "City")}
        {field("fromState", "State")}
        {field("fromZip", "ZIP")}
      </div>
      <h3>Ship to</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {field("toStreet", "Street address")}
        {field("toCity", "City")}
        {field("toState", "State")}
        {field("toZip", "ZIP")}
      </div>
      <button className="btn btnPrimary" type="submit" disabled={busy}>
        {busy ? "Checking rates..." : "Get Shippo rates"}
      </button>
    </form>
    {error && <p role="alert" style={{ color: "#dc2626" }}>{error}</p>}
    {rates && <div style={{ marginTop: 16 }}>
      <h3>Available rates {rates.rates?.length ? `(${rates.rates.length})` : ""}</h3>
      {!rates.rates?.length && <p>No rates returned for this package and address.</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", textAlign: "left" }}>
          <thead><tr><th>Carrier</th><th>Service</th><th>Rate</th><th>Estimated days</th><th>Mode</th></tr></thead>
          <tbody>{(rates.rates || []).map(rate => <tr key={rate.id}>
            <td>{rate.carrier}</td><td>{rate.service}</td>
            <td>{rate.amount} {rate.currency}</td>
            <td>{rate.estimatedDays ?? "Not provided"}</td>
            <td>{rate.test ? "Test" : "Live"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Rates only. Labels have not been purchased.</p>
    </div>}
  </div>;
}

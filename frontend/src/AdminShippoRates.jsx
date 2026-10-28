import React, { useEffect, useState } from "react";

export default function AdminShippoRates({ api }) {
  const [form, setForm] = useState({
    lengthIn: "", widthIn: "", heightIn: "", weightOz: "",
    toStreet: "", toCity: "", toState: "", toZip: "",
  });
  const [origin, setOrigin] = useState(null);
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
      <h3>Ship to</h3>
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

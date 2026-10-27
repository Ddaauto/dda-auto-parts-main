import React, { useEffect, useState } from "react";

const fields = [
  ["name", "Sender name"], ["street1", "Street address"],
  ["street2", "Suite / unit"], ["city", "City"], ["state", "State"],
  ["zip", "ZIP"], ["phone", "Contact phone (optional)"],
];
export default function AdminShippingOrigin({ api }) {
  const [origin, setOrigin] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const request = async (method, body) => {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${api}/admin/shipping-origin`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data.origin;
  };
  useEffect(() => {
    request("GET").then(setOrigin).catch(e => setError(e.message));
  }, [api]);
  const save = async e => {
    e.preventDefault();
    setSaving(true); setError(""); setMessage("");
    try {
      setOrigin(await request("PUT", origin));
      setMessage("Shipping origin saved for future shipments.");
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };
  return <div className="card" style={{ marginTop: 16 }}>
    <h2>Shipping Origin</h2>
    <p>Only ADMIN can change this address. Changes apply to future shipments, not past orders.</p>
    {error && <p role="alert" style={{ color: "red" }}>{error}</p>}
    {message && <p role="status">{message}</p>}
    {origin && <form onSubmit={save}>
      {fields.map(([field, label]) => <label key={field} style={{ display: "block", marginBottom: 12 }}>
        {label}<input style={{ display: "block", width: "100%", maxWidth: 420 }}
          value={origin[field] || ""} onChange={e => setOrigin({ ...origin, [field]: e.target.value })}
          required={!["street2", "phone"].includes(field)} />
      </label>)}
      <button className="btn" disabled={saving}>{saving ? "Saving..." : "Save shipping origin"}</button>
    </form>}
  </div>;
}

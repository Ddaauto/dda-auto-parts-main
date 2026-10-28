import React, { useEffect, useState } from "react";

export default function AdminShippingLabelDetails({ api, orderId }) {
  const [labels, setLabels] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`${api}/admin/shippo/orders/${encodeURIComponent(orderId)}/labels`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` },
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load labels");
      return data.labels || [];
    }).then(data => { if (active) setLabels(data); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, orderId]);
  if (loading) return <p>Loading shipping labels...</p>;
  if (error) return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  if (!labels.length) return <p style={{ color: "#64748b" }}>No Shippo label is recorded for this order yet. Label printing and refunds will be available after purchasing a label through DDA.</p>;
  return <div style={{ display: "grid", gap: 12 }}>
    {labels.map(label => <div key={label.id} style={{ padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, background: "#f8fafc" }}>
      <strong>{label.carrier} — {label.service}</strong>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <div><small>Purchased</small><div>{label.purchasedAt ? new Date(label.purchasedAt).toLocaleString() : "—"}</div></div>
        <div><small>Tracking number</small><div>{label.trackingNumber || "—"}</div></div>
        <div><small>Label cost</small><div>{label.amount ? `${label.currency} ${label.amount}` : "—"}</div></div>
        <div><small>Package</small><div>{[label.lengthIn, label.widthIn, label.heightIn].every(Boolean) ? `${label.lengthIn} × ${label.widthIn} × ${label.heightIn} in` : "—"} · {label.weightOz || "—"} oz</div></div>
        <div><small>Refund status</small><div>{label.refundStatus || "Not requested"}</div></div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        {label.labelUrl && <a className="btn" href={label.labelUrl} target="_blank" rel="noopener noreferrer">Reprint Label</a>}
        {label.trackingUrl && <a className="btn" href={label.trackingUrl} target="_blank" rel="noopener noreferrer">Track shipment</a>}
      </div>
      <small style={{ display: "block", marginTop: 10, color: "#64748b" }}>Label cancellation/refund requires carrier eligibility and Shippo confirmation. No refund is initiated from this screen yet.</small>
    </div>)}
  </div>;
}

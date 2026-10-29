import React, { useEffect, useState } from "react";

export default function AdminShippingLabelDetails({ api, orderId }) {
  const [labels, setLabels] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const act = async (label, action) => {
    if (busyId) return;
    if (action === "request-refund" && !window.confirm("Request cancellation/refund of this SHIPPING LABEL from Shippo? Approval is not guaranteed. This does NOT cancel the customer's order or refund their purchase.")) return;
    setBusyId(label.id); setError(""); setMessage("");
    try {
      const response = await fetch(`${api}/admin/shippo/orders/${encodeURIComponent(orderId)}/labels/${encodeURIComponent(label.id)}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(action === "request-refund" ? { confirm: true } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Shippo request failed");
      setLabels(old => old.map(item => item.id === label.id ? { ...item, refundStatus: data.refundStatus } : item));
      setMessage(data.message || "Shippo status updated.");
    } catch (err) { setError(err.message); }
    finally { setBusyId(""); }
  };
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

  if (!labels.length) return <p style={{ color: "#64748b" }}>No Shippo label is recorded for this order yet. Label printing and refunds will be available after purchasing a label through DDA.</p>;
  return <div style={{ display: "grid", gap: 12 }}>
    {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
    {message && <p role="status" style={{ color: "#166534" }}>{message}</p>}
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
        {!label.refundStatus && label.labelUrl && <button className="btn" type="button" disabled={Boolean(busyId)} onClick={() => act(label, "request-refund")}>{busyId === label.id ? "Submitting..." : "Request label refund"}</button>}
        {label.shippoRefundId && <button className="btn" type="button" disabled={Boolean(busyId)} onClick={() => act(label, "refresh-refund")}>{busyId === label.id ? "Checking..." : "Refresh refund status"}</button>}
      </div>
      <small style={{ display: "block", marginTop: 10, color: "#64748b" }}>Shippo decides refund eligibility. Once Shippo accepts the refund request, the order returns to Unshipped so you can purchase a replacement label. The refund may remain pending for days. Customer payment is unchanged.</small>
    </div>)}
  </div>;
}

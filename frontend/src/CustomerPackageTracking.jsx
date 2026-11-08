import React, { useEffect, useState } from "react";

export default function CustomerPackageTracking({ api, orderId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setData(null); setError(""); setOpen(false); }, [orderId]);
  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch(`${api}/shipping/orders/${encodeURIComponent(orderId)}/tracking`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Tracking unavailable");
      setData(body);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  return <div style={{ marginTop: 8 }}>
    <button className="btn" type="button" disabled={loading}
      onClick={() => { if (!open) load(); setOpen(!open); }}>
      {loading ? "Loading..." : open ? "Hide packages" : "Track packages"}
    </button>
    {open && <>
      {error && <p role="alert">{error}</p>}
      {data && <div style={{ padding: 12, marginTop: 8, border: "1px solid #e2e8f0", borderRadius: 8 }}>
        <strong>{data.shippingStatus?.replaceAll("_", " ")} · {data.packageCount} package(s)</strong>
        {(data.packages || []).map((pkg, index) => <div key={pkg.labelId || index} style={{ padding: "8px 0", borderBottom: "1px solid #e2e8f0" }}>
          <strong>Package {index + 1}</strong> · {pkg.carrier || "Carrier pending"} · {pkg.carrierStatus || "Label created"}
          <div>Tracking: {pkg.number || "Pending"}</div>
          {pkg.url && <a href={pkg.url} target="_blank" rel="noopener noreferrer">Track with carrier</a>}
        </div>)}
      </div>}
    </>}
  </div>;
}

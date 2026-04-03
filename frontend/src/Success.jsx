import { useEffect, useMemo, useState } from "react";

const API = "http://localhost:5177";

export default function Success() {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState("");

  const sessionId = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("session_id") || "";
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

        const token = localStorage.getItem("token") || "";

        // 1) Traer las ordenes del cliente (las mismas que salen en My History)
        const r = await fetch(`${API}/orders/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || "Failed to load orders");

        // tomar la orden más reciente (normalmente la que acabas de pagar)
        const list = Array.isArray(data?.orders) ? data.orders : Array.isArray(data) ? data : [];
        const newest =
          list
            .slice()
            .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;

        setOrder(newest);
      } catch (e) {
        setErr(e.message || "Failed to load order");
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  return (
    <div className="container" style={{ paddingTop: 40 }}>
      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ fontSize: 22 }}>✅</div>
          <div style={{ fontSize: 26, fontWeight: 900 }}>Payment Successful</div>
        </div>

        <div style={{ marginTop: 8, color: "var(--muted)" }}>Your order has been placed.</div>

        <div style={{ marginTop: 14 }}>
          {loading ? (
            <div className="badge">Loading order…</div>
          ) : err ? (
            <div className="badge" style={{ color: "tomato" }}>
              {err}
            </div>
          ) : order ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="badge">
                Order #: <b>{order.orderNumber || order.invoiceId || order.id}</b>
              </div>
              {order.invoiceId ? (
                <div className="badge">
                  Invoice ID: <b>{order.invoiceId}</b>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="badge">Order not found yet (refresh in a moment).</div>
          )}
        </div>

        <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a className="btn btnPrimary" href="/account">
            Go to My Account
          </a>

          <a className="btn" href="/">
            Continue shopping
          </a>
        </div>
      </div>
    </div>
  );
}
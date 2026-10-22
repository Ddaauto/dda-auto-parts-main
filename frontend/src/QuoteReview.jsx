import { useEffect, useState } from "react";

const API = (import.meta.env.VITE_API_URL || "http://localhost:5177").replace(/\/$/, "");

function dollars(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export default function QuoteReview() {
  const token = window.location.pathname.split("/")[2] || "";
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid quotation link");
        const response = await fetch(`${API}/api/quotes/public/${token}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Quotation not found");
        if (active) setQuote(data);
      } catch (err) {
        if (active) setError(err.message || "Unable to load quotation");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [token]);

  async function decide(decision) {
    if (working || quote?.status !== "SENT") return;
    const action = decision === "ACCEPTED" ? "approve" : "reject";
    if (!window.confirm(`Are you sure you want to ${action} this quotation?`)) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/quotes/public/${token}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to submit decision");
      setQuote((previous) => ({ ...previous, status: decision }));
      setMessage(decision === "ACCEPTED" ? "Quotation approved. Thank you!" : "Quotation declined.");
    } catch (err) {
      setError(err.message || "Unable to submit decision");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "#f5f7fa", color: "#18212d", padding: "36px 16px", fontFamily: "Arial, sans-serif" }}>
      <section style={{ maxWidth: 760, margin: "0 auto", background: "white", borderRadius: 14, padding: 28, boxShadow: "0 4px 20px #00000012" }}>
        <h1 style={{ marginTop: 0 }}>DDA Auto Parts</h1>
        <h2>Quotation Review</h2>
        {loading && <p>Loading quotation...</p>}
        {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
        {message && <p role="status" style={{ color: "#176b42", fontWeight: 700 }}>{message}</p>}
        {quote && (
          <>
            <p><strong>Quote:</strong> {quote.quoteNumber}</p>
            <p><strong>Customer:</strong> {quote.customerName}</p>
            <p><strong>Valid until:</strong> {quote.expiresAt ? new Date(quote.expiresAt).toLocaleDateString("en-US") : "—"}</p>
            <p><strong>Status:</strong> {quote.status}</p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
                <thead><tr><th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #ddd" }}>Product</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
                <tbody>
                  {(quote.items || []).map((item, index) => (
                    <tr key={index}>
                      <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{item.name}</td>
                      <td style={{ textAlign: "center" }}>{item.qty}</td>
                      <td style={{ textAlign: "right" }}>{dollars(item.price)}</td>
                      <td style={{ textAlign: "right" }}>{dollars(Number(item.price) * Number(item.qty))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ textAlign: "right", marginTop: 20 }}>
              <p>Subtotal: {dollars(quote.subtotal)}</p>
              <p>Tax: {dollars(quote.tax)}</p>
              <p>Shipping: {dollars(quote.shipping)}</p>
              <h3>Total: {dollars(quote.total)}</h3>
            </div>
            {quote.notes && <p><strong>Notes:</strong> {quote.notes}</p>}
            {quote.status === "SENT" && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 28 }}>
                <button disabled={working} onClick={() => decide("ACCEPTED")} style={{ padding: "12px 24px", border: 0, borderRadius: 8, background: "#176b42", color: "white", cursor: "pointer" }}>Approve Quote</button>
                <button disabled={working} onClick={() => decide("REJECTED")} style={{ padding: "12px 24px", border: "1px solid #b42318", borderRadius: 8, background: "white", color: "#b42318", cursor: "pointer" }}>Reject Quote</button>
              </div>
            )}
            {quote.status === "EXPIRED" && <p>This quotation has expired.</p>}
          </>
        )}
      </section>
    </main>
  );
}

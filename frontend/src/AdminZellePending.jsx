import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:5177";



export default function AdminZellePending({ onCount }) {
  const token =
  localStorage.getItem("token") ||
  localStorage.getItem("adminToken") ||
  localStorage.getItem("authToken") ||
  "";

console.log("TOKEN_ADMIN:", token);
console.log("API:", API);


  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  async function loadOrders() {
    setLoading(true);
    setError("");
    try {
console.log("API:", API);
console.log("TOKEN:", token ? token.slice(0, 20) + "..." : null);

      const r = await fetch(`${API}/admin/orders/zelle-pending`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error loading orders");
      setOrders(data.orders || []);
     onCount?.((data.orders || []).length); 
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmPayment(orderId) {
    if (!window.confirm("Confirm Zelle payment for this order?")) return;

    setBusyId(orderId);
    try {
      const r = await fetch(
  `${API}/admin/orders/${orderId}/confirm-zelle`,
  {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }
);

      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Confirm failed");

      // quitar de la lista
     setOrders((prev) => {
  const next = prev.filter((o) => o.id !== orderId);
  onCount?.(next.length);
  return next;
});
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    loadOrders();
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h2>Zelle Pending Payments</h2>

      {loading && <p>Loading...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {orders.length === 0 && !loading && (
        <p>No Zelle pending orders</p>
      )}

      {orders.length > 0 && (
        <table border="1" cellPadding="8" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Order #</th>
              <th>Invoice</th>
              <th>Total</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.orderNumber || o.id}</td>
                <td>{o.invoiceId}</td>
                <td>${Number(o.grandTotal || o.total).toFixed(2)}</td>
                <td>{new Date(o.createdAt).toLocaleString()}</td>
                <td>
                  <button
                    disabled={busyId === o.id}
                    onClick={() => confirmPayment(o.id)}
                  >
                    {busyId === o.id ? "Confirming..." : "Confirm Payment"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import fitmentData from "./data/fitment.json";
import AdminZellePending from "./AdminZellePending";

// .env (frontend/.env)
// VITE_ADMIN_USER=admin
// VITE_ADMIN_PASS=1234
const ADMIN_USER = import.meta.env.VITE_ADMIN_USER;
const ADMIN_PASS = import.meta.env.VITE_ADMIN_PASS;
const API = import.meta.env.VITE_API_URL;

const blankPick = { make: "", model: "", engine: "", yearStart: "", yearEnd: "" };
const LOW_STOCK_THRESHOLD = 3;
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function calcPriceFromMargin(cost, marginPct) {
  const c = Number(cost || 0);
  const m = Number(marginPct || 0) / 100;

  if (!Number.isFinite(c) || c <= 0) return 0;
  if (!Number.isFinite(m) || m < 0 || m >= 0.95) return 0;

  return +(c / (1 - m)).toFixed(2);
}
function csvEscape(s) {
  const str = String(s ?? "");
  if (/[",\n]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}
const PRODUCT_CATEGORIES = [
  "Brakes",
  "Filters",
  "Engine",
  "Cooling",
  "Suspension",
  "Electrical",
  "Exhaust",
  "Fluids & Maintenance",
];
export default function Admin() {
  

  // ====== AUTH (FORM, NO PROMPT) ======
  const [authorized, setAuthorized] = useState(localStorage.getItem("adminAuth") === "true");
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr] = useState("");

  const [adminTab, setAdminTab] = useState("products");
  const [customers, setCustomers] = useState([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customersLoading, setCustomersLoading] = useState(false);
const [orders, setOrders] = useState([]);
const [ordersLoading, setOrdersLoading] = useState(false);
const [zellePendingCount, setZellePendingCount] = useState(0);
const [coSearchName, setCoSearchName] = useState("");
const [coShowSuggest, setCoShowSuggest] = useState(false);
const [coSelectedCustomer, setCoSelectedCustomer] = useState(null);
const [coSearchProd, setCoSearchProd] = useState("");
const [coProdSuggestOpen, setCoProdSuggestOpen] = useState(false);
const [coItems, setCoItems] = useState([]); // [{ sku, name, price, qty, weightLb }]
const [coPreview, setCoPreview] = useState(null);
const [coPreviewLoading, setCoPreviewLoading] = useState(false);
const [coPreviewErr, setCoPreviewErr] = useState("");
const [openProductId, setOpenProductId] = useState(null);
const [productSearch, setProductSearch] = useState("");
const [productCategoryFilter, setProductCategoryFilter] = useState("");
const [productStatusFilter, setProductStatusFilter] = useState("all");
const [productLowStockOnly, setProductLowStockOnly] = useState(false);
const [productSortKey, setProductSortKey] = useState("name");
const [productSortDir, setProductSortDir] = useState("asc");
const [productSaveState, setProductSaveState] = useState({});
const [dirtyProducts, setDirtyProducts] = useState({});
const [importingCsv, setImportingCsv] = useState(false);
const [orderEventsById, setOrderEventsById] = useState({});
const [orderEventsOpen, setOrderEventsOpen] = useState({});
const [orderEventsLoading, setOrderEventsLoading] = useState({});
const [orderSearch, setOrderSearch] = useState("");
const [dashboardStats, setDashboardStats] = useState({
  totalOrders: 0,
  revenue: 0,
  cancelled: 0,
  refunded: 0,
  profit: 0,
});
const [dashboardLoading, setDashboardLoading] = useState(false);
useEffect(() => {
  loadDashboard();
}, []);
function toggleProductSort(key) {
  setProductSortKey((prevKey) => {
    if (prevKey === key) {
      setProductSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
      return prevKey;
    }
    setProductSortDir("asc");
    return key;
  });
}

  const doLogin = async () => {
    setLoginErr("");

    const u = String(loginUser || "").trim();
    const p = String(loginPass || "").trim();

    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u, password: p }),
      });

      const data = await r.json();

      if (!r.ok || !data.token) {
        setLoginErr(data.error || "Login failed");
        return;
      }

      // ✅ guardar token REAL del backend
      localStorage.setItem("token", data.token);
      localStorage.setItem("adminAuth", "true");

      setAuthorized(true);
      setLoginUser("");
      setLoginPass("");
    } catch (e) {
      setLoginErr("Cannot connect to server");
    }
  };

  const logout = () => {
    localStorage.removeItem("adminAuth");
    localStorage.removeItem("token");
    setAuthorized(false);
  };

  // ====== FITMENT LISTS (dropdowns) ======
  const fitments = useMemo(() => (Array.isArray(fitmentData) ? fitmentData : []), []);

  const makes = useMemo(() => {
    const s = new Set(fitments.map((r) => r.make).filter(Boolean));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [fitments]);

  const modelsByMake = useMemo(() => {
    const map = new Map();
    for (const r of fitments) {
      if (!r.make || !r.model) continue;
      if (!map.has(r.make)) map.set(r.make, new Set());
      map.get(r.make).add(r.model);
    }
    const out = {};
    for (const [mk, set] of map.entries()) out[mk] = Array.from(set).sort((a, b) => a.localeCompare(b));
    return out;
  }, [fitments]);

  const enginesByMakeModel = useMemo(() => {
    const map = new Map(); // key = make||model
    for (const r of fitments) {
      if (!r.make || !r.model || !r.engine) continue;
      const key = `${r.make}||${r.model}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(r.engine);
    }
    const out = {};
    for (const [key, set] of map.entries()) out[key] = Array.from(set).sort((a, b) => a.localeCompare(b));
    return out;
  }, [fitments]);

  // ====== PRODUCTS STATE ======
  const [products, setProducts] = useState([]);

  const [coEmail, setCoEmail] = useState("");
  const [coShippingId, setCoShippingId] = useState("uber");
  const [coPaymentMethod, setCoPaymentMethod] = useState("Zelle");
  // selector inventario (Create Order)
const [productQuery, setProductQuery] = useState("");
const [pickSku, setPickSku] = useState("");
const [pickQty, setPickQty] = useState(1);

 useEffect(() => {
  (async () => {
    try {
      const token = localStorage.getItem("token");
      if (!token) return setProducts([]);

      const r = await fetch(`${API_BASE}/admin/products`, {
        headers: { Authorization: "Bearer " + token },
      });

      const data = await r.json();

      const arr = Array.isArray(data) ? data : [];
      const normalized = arr.map((p) => ({
        ...p,
        price: typeof p.price_cents === "number" ? p.price_cents / 100 : (p.price ?? 0),
        cost: typeof p.cost_cents === "number" ? p.cost_cents / 100 : (p.cost ?? 0),
        marginPct: typeof p.margin_pct === "number" ? p.margin_pct : (p.marginPct ?? 0),
        stock: p.stock ?? 0,
        _pick: p._pick || { ...blankPick },
      }));

      setProducts(normalized);
    } catch (e) {
      console.error("Load products error:", e);
      setProducts([]);
    }
  })();
}, [adminTab]);
 useEffect(() => {
  const email = String(coEmail || "").trim();
  if (!email || !coItems || coItems.length === 0) {
    setCoPreview(null);
    setCoPreviewErr("");
    return;
  }

  const t = setTimeout(async () => {
    setCoPreviewLoading(true);
    setCoPreviewErr("");

    try {
      const r = await fetch(`${API}/admin/orders/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
        },
        body: JSON.stringify({
          customerEmail: email,
          items: coItems,
          selectedShippingId: coShippingId,
          paymentMethod: coPaymentMethod,
        }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || "Preview failed");

      setCoPreview(data);

      // si backend eligió otro shipping, sincroniza el selector
      if (data?.chosen?.id && String(data.chosen.id) !== String(coShippingId)) {
        setCoShippingId(String(data.chosen.id));
      }
    } catch (e) {
      setCoPreview(null);
      setCoPreviewErr(e.message || "Preview failed");
    } finally {
      setCoPreviewLoading(false);
    }
  }, 250);

  return () => clearTimeout(t);
}, [coEmail, coItems, coShippingId, coPaymentMethod]);
  // ====== ACTIONS ======
  const addProduct = async () => {
  try {
    const token = localStorage.getItem("token");
    if (!token) return alert("No admin token. Login again.");

    // SKU temporal único (SQLite requiere sku + name)
    const tempSku = "NEW-" + Date.now();

    const r = await fetch(`${API_BASE}/admin/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        sku: tempSku,
        name: "(New product)",
        price_cents: 0,
        stock: 0,
        active: 1,
        fitsAll: 0,
      }),
    });

    const out = await r.json();
    if (!r.ok) return alert(out?.error || "Failed to create product");

    // Recargar lista desde SQLite
    const r2 = await fetch(`${API_BASE}/admin/products`, {
      headers: { Authorization: "Bearer " + token },
    });

    const list = await r2.json();
    if (!r2.ok) return alert(list?.error || "Failed to reload products");

    const arr = Array.isArray(list) ? list : [];
    
const normalized = arr.map((p) => ({
  ...p,
  price: typeof p.price_cents === "number" ? p.price_cents / 100 : (p.price ?? 0),
  cost: typeof p.cost_cents === "number" ? p.cost_cents / 100 : (p.cost ?? 0),
  marginPct: typeof p.margin_pct === "number" ? p.margin_pct : (p.marginPct ?? 0),
  stock: p.stock ?? 0,
  _pick: p._pick || { ...blankPick },
}));
    setProducts(normalized);
  } catch (e) {
    console.error(e);
    alert("Failed to add product");
  }
};

  const delProduct = async (id) => {
  const ok = window.confirm("Delete this product?");
  if (!ok) return;

  try {
    const token = localStorage.getItem("token");
    if (!token) return;

    const r = await fetch(`https://dda-backend-ajr3.onrender.com/admin/products/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + token,
      },
    });

    const out = await r.json().catch(() => ({}));

    if (!r.ok) {
      alert(out?.error || "Failed to delete product");
      return;
    }

    setProducts((prev) => prev.filter((p) => p.id !== id));
  } catch (e) {
    console.error(e);
    alert("Failed to delete product");
  }
};  

const setField = (id, key, value) => {
  setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, [key]: value } : p)));

  setDirtyProducts((prev) => ({
    ...prev,
    [id]: true,
  }));
};

// 👇 PEGA ESTO AQUÍ
const saveProduct = async (p) => {
  try {
   const token = localStorage.getItem("token");
if (!token) return;

const errors = validateProduct(p);
if (errors.length) {
  setProductSaveState((prev) => ({
    ...prev,
    [p.id]: "error",
  }));
  alert("Missing required fields:\n\n" + errors.join("\n"));
  return;
}

setProductSaveState((prev) => ({
  ...prev,
  [p.id]: "saving",
}));
setDirtyProducts((prev) => ({
  ...prev,
  [p.id]: false,
}));
    const r = await fetch(`https://dda-backend-ajr3.onrender.com/admin/products/${p.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        name: p.name ?? "",
        sku: p.sku ?? "",
        mpn: p.mpn ?? "",
        brand: p.brand ?? "",
        asin: p.asin ?? "",
        category: p.category ?? "",
        price: p.price ?? null,
        cost: p.cost ?? null,
        marginPct: p.marginPct ?? 0,
        stock: p.stock ?? null,
        active: p.active !== false,
        fitsAll: !!p.fitsAll,
        imageUrl: p.imageUrl ?? "",
      }),
    });

    const out = await r.json().catch(() => ({}));

    if (!r.ok) {
      setProductSaveState((prev) => ({
        ...prev,
        [p.id]: "error",
      }));
      alert(out?.error || "Failed to save product");
      return;
    }

    setProductSaveState((prev) => ({
      ...prev,
      [p.id]: "saved",
    }));

    setTimeout(() => {
      setProductSaveState((prev) => {
        if (prev[p.id] !== "saved") return prev;
        return { ...prev, [p.id]: "" };
      });
    }, 1500);
  } catch (e) {
    console.error(e);
    setProductSaveState((prev) => ({
      ...prev,
      [p.id]: "error",
    }));
    alert("Failed to save product");
  }
};

const setPickField = (id, key, value) => {
  setProducts((prev) =>
    prev.map((p) => {
      if (p.id !== id) return p;

      const pick = { ...(p._pick || blankPick), [key]: value };

      // resets dependientes
      if (key === "make") {
        pick.model = "";
        pick.engine = "";
      }
      if (key === "model") {
        pick.engine = "";
      }

      return { ...p, _pick: pick };
    })
  );
};

  const addFitmentToProduct = (id) => {
    setProducts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;

        const cur = p._pick || blankPick;
        if (!cur.make || !cur.model || !cur.engine) return p;

        const ys = cur.yearStart ? Number(cur.yearStart) : undefined;
        const ye = cur.yearEnd ? Number(cur.yearEnd) : undefined;

        const nextFit = {
          make: cur.make,
          model: cur.model,
          engine: cur.engine,
          ...(Number.isFinite(ys) ? { yearStart: ys } : {}),
          ...(Number.isFinite(ye) ? { yearEnd: ye } : {}),
        };

        return {
          ...p,
          fits: [...(Array.isArray(p.fits) ? p.fits : []), nextFit],
          _pick: { ...blankPick },
        };
      })
    );
  };

  const removeFitment = (id, idx) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, fits: (p.fits || []).filter((_, i) => i !== idx) } : p))
    );
  };

const customerHasFreeDelivery = (c) => Number(c?.freeDelivery) === 1;
const stockLabel = (n) => {
  const stock = Number(n || 0);
  if (stock <= 0) return { text: "OUT OF STOCK", kind: "out" };
  if (stock <= LOW_STOCK_THRESHOLD) return { text: `LOW STOCK: ${stock}`, kind: "low" };
  return { text: `Stock: ${stock}`, kind: "ok" };
};

const renderStockBadge = (stockValue) => {
  const s = stockLabel(stockValue);

  const style =
    s.kind === "out"
      ? { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" }
      : s.kind === "low"
      ? { background: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" }
      : {};

  return (
    <div className="badge" style={style}>
      {s.text}
    </div>
  );
};
  const exportCSV = () => {
    const headers = [
      "name",
      "price",
      "stock",
      "category",
      "imageUrl",
      "active",
      "fitsAll",
      "sku",
      "asin",
      "partNumber",
      "brand",
      "fitments",
    ];

    const lines = [headers.join(",")];

    for (const p of products) {
      const fitmentsStr = (p.fits || [])
        .map((f) => {
          const ys = f.yearStart != null ? f.yearStart : "";
          const ye = f.yearEnd != null ? f.yearEnd : "";
          const yrs = ys || ye ? `${ys}-${ye}` : "";
          return [f.make, f.model, f.engine, yrs].filter(Boolean).join(" ");
        })
        .join(" | ");

      const row = [
        csvEscape(p.name),
        csvEscape(p.price),
        csvEscape(p.stock ?? 0),
        csvEscape(p.category),
        csvEscape(p.imageUrl),
        csvEscape(p.active !== false),
        csvEscape(!!p.fitsAll),
        csvEscape(p.sku),
        csvEscape(p.asin),
        csvEscape(p.mpn),
        csvEscape(p.brand),
        csvEscape(fitmentsStr),
      ].join(",");

      lines.push(row);
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "products.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  async function loadCustomers() {
    setCustomersLoading(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API}/admin/customers`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Failed to load customers");
      }

      const data = await res.json();
      setCustomers(Array.isArray(data) ? data : data.rows || []);
    } catch (e) {
      alert(e.message || "Failed to load customers");
    } finally {
      setCustomersLoading(false);
    }
  }
async function loadOrders() {
  setOrdersLoading(true);
  try {
    const token = localStorage.getItem("token");
    const res = await fetch(`${API}/admin/orders`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || "Failed to load orders");
    }

    const data = await res.json();
    setOrders(Array.isArray(data) ? data : (data.orders || []));
    setAdminTab("orders");
  } catch (e) {
    alert(e.message || "Failed to load orders");
  } finally {
    setOrdersLoading(false);
  }
}
async function cancelOrder(id) {
  if (!window.confirm("Cancel this order?")) return;

  try {
    const token = localStorage.getItem("token");

    await fetch(`${API}/admin/orders/${id}/cancel`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    await loadOrders();
  } catch (e) {
    alert(e.message || "Could not cancel order");
  }
}
async function approveCancelOrder(id) {
  if (!window.confirm("Approve this cancellation request?")) return;

  try {
    const token = localStorage.getItem("token");

    await fetch(`${API}/admin/orders/${id}/approve-cancel`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    await loadOrders();
  } catch (e) {
    alert(e.message || "Could not approve cancellation");
  }
}
async function rejectCancelOrder(id) {
  if (!window.confirm("Reject this cancellation request?")) return;

  try {
    const token = localStorage.getItem("token");

    await fetch(`${API}/admin/orders/${id}/reject-cancel`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    await loadOrders();
  } catch (e) {
    alert(e.message || "Could not reject cancellation");
  }
}
async function markRefunded(id) {
  if (!window.confirm("Mark this order as refunded?")) return;

  try {
    const token = localStorage.getItem("token");

    await fetch(`${API}/admin/orders/${id}/refund`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    await loadOrders();
  } catch (e) {
    alert(e.message || "Could not mark refunded");
  }
}
async function loadDashboard() {
  setDashboardLoading(true);
  try {
    const token = localStorage.getItem("token");

    const res = await fetch(`${API}/admin/dashboard`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load dashboard");
    }

    setDashboardStats({
  totalOrders: Number(data?.stats?.totalOrders || 0),
  revenue: Number(data?.stats?.revenue || 0),
  cancelled: Number(data?.stats?.cancelled || 0),
  refunded: Number(data?.stats?.refunded || 0),
  profit: Number(data?.stats?.profit || 0),
});
  } catch (e) {
    alert(e.message || "Failed to load dashboard");
  } finally {
    setDashboardLoading(false);
  }
}
async function toggleOrderHistory(orderId) {
  const isOpen = !!orderEventsOpen[orderId];

  if (isOpen) {
    setOrderEventsOpen((prev) => ({ ...prev, [orderId]: false }));
    return;
  }

  setOrderEventsOpen((prev) => ({ ...prev, [orderId]: true }));

  if (orderEventsById[orderId]) return;

  setOrderEventsLoading((prev) => ({ ...prev, [orderId]: true }));

  try {
    const token = localStorage.getItem("token");

    const res = await fetch(`${API}/admin/orders/${orderId}/events`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load order history");
    }

    setOrderEventsById((prev) => ({
      ...prev,
      [orderId]: Array.isArray(data.events) ? data.events : [],
    }));
  } catch (e) {
    alert(e.message || "Failed to load order history");
  } finally {
    setOrderEventsLoading((prev) => ({ ...prev, [orderId]: false }));
  }
}
function formatOrderEventLabel(ev) {
  switch (String(ev?.type || "").toUpperCase()) {
    case "ORDER_CREATED":
      return "Order created";
    case "PAYMENT_MARKED_PAID":
      return "Payment marked as paid";
    case "CANCEL_REQUESTED":
      return "Customer requested cancellation";
    case "CANCEL_APPROVED":
      return "Cancellation approved";
    case "CANCEL_REJECTED":
      return "Cancellation rejected";
    case "ORDER_CANCELLED":
      return "Order cancelled";
    case "ORDER_REFUNDED":
      return "Order refunded";
    case "EMAIL_SENT":
      return "Email sent";
    default:
      return ev?.message || ev?.type || "Event";
  }
}

function formatEventDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatEventActor(ev) {
  const actorType = String(ev?.actorType || "").toLowerCase();

  if (actorType === "admin") return "Admin";
  if (actorType === "customer") return "Customer";
  return "System";
}
function getOrderProfit(order) {
  try {
    const items = Array.isArray(order?.items)
      ? order.items
      : JSON.parse(order?.itemsJson || "[]");

    let totalCost = 0;

    for (const item of items) {
      const qty = Number(item?.qty || 0);
      const cost = Number(item?.cost || item?.cost_cents || 0);

      const unitCost = cost > 1000 ? cost / 100 : cost;

      totalCost += unitCost * qty;
    }

    const subtotal = Number(order?.subtotal || 0);
    return subtotal - totalCost;
  } catch {
    return 0;
  }
}
const filteredOrders = (orders || []).filter((o) => {
  const q = String(orderSearch || "").trim().toLowerCase();
  if (!q) return true;

  return [
    o.orderNumber,
    o.invoiceId,
    o.email,
    o.status,
    o.paymentMethod,
    o.paymentStatus,
    o.id,
  ].some((v) => String(v || "").toLowerCase().includes(q));
});
  // ====== LOGIN SCREEN ======
  if (!authorized) {
    return (
      <div className="container">
        <div className="card" style={{ maxWidth: 520, margin: "40px auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <h1 style={{ marginTop: 0, marginBottom: 0 }}>Admin Login</h1>
          </div>

          <div style={{ color: "var(--muted)", marginTop: 10, marginBottom: 14 }}>
            Enter your credentials to access the admin panel.
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <input
              className="input"
              placeholder="Username"
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              autoComplete="username"
            />
            <input
              className="input"
              placeholder="Password"
              type="password"
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === "Enter") doLogin();
              }}
            />

            {loginErr ? <div style={{ color: "#ff5c5c", fontWeight: 700 }}>{loginErr}</div> : null}

            <button className="btn btnPrimary" onClick={doLogin}>
              Sign in
            </button>

            <a href="/" style={{ color: "var(--muted)", marginTop: 6 }}>
              ← Back to store
            </a>
          </div>

          <div style={{ marginTop: 14, fontSize: 13, color: "var(--muted)" }}>
            Tip: If login always fails, restart: <b>CTRL+C</b> then <b>npm run dev</b> (Vite reloads .env on start).
          </div>
        </div>
      </div>
    );
  }
// filtro productos para selector (Create Order)
const productOptions = (products || []).filter((p) => {
  const q = productQuery.trim().toLowerCase();
  if (!q) return true;
  return (
    String(p.sku || "").toLowerCase().includes(q) ||
    String(p.name || "").toLowerCase().includes(q) ||
    String(p.mpn || "").toLowerCase().includes(q)
  );
});
const saveProductNow = (productId) => {
  const latest = getLatestProduct(productId);
  if (latest) saveProduct(latest);
};
const validateProduct = (p) => {
  const errors = [];

  const price = safeNum(p.price ?? 0);
  const cost = safeNum(p.cost ?? 0);
  const marginPct = safeNum(p.marginPct ?? 0);

  if (!Number.isFinite(price) || price <= 0) {
    errors.push("Price is required");
  }

  if (!Number.isFinite(cost) || cost <= 0) {
    errors.push("Cost is required");
  }
  
  if (!Number.isFinite(marginPct) || marginPct <= 0) {
    errors.push("Margin % is required");
  }

  if (!String(p.category || "").trim()) {
    errors.push("Category is required");
  }

  if (!String(p.brand || "").trim()) {
    errors.push("Brand is required");
  }

  const hasSku = !!String(p.sku || "").trim();
  const hasPartNumber = !!String(p.mpn || "").trim();

  if (!hasSku && !hasPartNumber) {
    errors.push("Fill at least SKU or Part Number");
  }

  return errors;
};
  // ====== ADMIN PANEL ======
  return (
    <div style={{ width: "100%", maxWidth: "100%", padding: "10px 20px" }}>
      <div className="topbar" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0 }}>Admin</h1>
          <a href="/" style={{ color: "var(--muted)" }}>
            ← Back to store
          </a>
          <div className="badge" style={{ marginTop: 10 }}>
            Fitment rows loaded: {fitments.length}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
  

  <button className="btn btnPrimary" onClick={addProduct}>
    + Add product
  </button>

  <button className="btn" onClick={exportCSV}>
    Export CSV
  </button>

  {/* INPUT OCULTO */}
  <input
    type="file"
    accept=".csv,text/csv"
    id="csvImportInput"
    style={{ display: "none" }}
    onChange={async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        setImportingCsv(true);

        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) {
          alert("CSV is empty");
          return;
        }

        const headers = lines[0].split(",").map((h) => h.trim());
        const rows = lines.slice(1).map((line) => {
          const cols = line.split(",").map((v) => v.trim());
          const obj = {};
          headers.forEach((h, i) => {
            obj[h] = cols[i] ?? "";
          });
          return obj;
        });

        const token = localStorage.getItem("token");
        if (!token) return;

       const r = await fetch(`${API_BASE}/admin/products/import`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ rows }),
        });

        const out = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(out?.error || "Failed to import CSV");
          return;
        }

        await loadProducts();
alert("CSV imported successfully");
      } catch (err) {
        console.error(err);
        alert("Failed to import CSV");
      } finally {
        setImportingCsv(false);
        e.target.value = "";
      }
    }}
  />

  {/* BOTÓN IMPORT */}
  <button
    className="btn"
    onClick={() => document.getElementById("csvImportInput")?.click()}
    disabled={importingCsv}
  >
    {importingCsv ? "Importing..." : "Import CSV"}
  </button>

  <button className="btn" onClick={logout} title="Logout">
    Logout
  </button>
</div>
      </div>


      <button
        className="btn"
        style={{ marginLeft: 10 }}
        onClick={() => {
          setAdminTab("customers");
          loadCustomers();
        }}
      >
        Customers
      </button>

<button
  className="btn"
  style={{ marginLeft: 10 }}
  onClick={() => {
    loadOrders();
  }}
>
  Orders
</button>
<button
  className="btn"
  style={{ marginLeft: 10 }}
  onClick={() => setAdminTab("products")}
>
  Products
</button>

<button
  className="btn"
  style={{ marginLeft: 10 }}
  onClick={() => {
    setAdminTab("createOrder");
    loadCustomers();
  }}
>
  Create Order
</button>
   
<button
  className="btn"
  style={{
    marginLeft: 10,
    background: zellePendingCount > 0 ? "#facc15" : undefined,
    color: zellePendingCount > 0 ? "#000" : undefined,
    fontWeight: zellePendingCount > 0 ? 700 : undefined,
  }}
  onClick={() => setAdminTab("zelle")}
>
  Zelle Pending {zellePendingCount > 0 ? `(${zellePendingCount})` : ""}
</button>



{/* =========================
    CUSTOMERS TAB
========================= */}
{adminTab === "customers" && (
  <div className="card" style={{ marginTop: 16 }}>
    <div style={{ fontWeight: 800, marginBottom: 10 }}>Customers</div>

    {/* 🔍 SEARCH */}
    <input
      className="input"
      placeholder="Search customer..."
      value={customerSearch}
      onChange={(e) => setCustomerSearch(e.target.value)}
      style={{ maxWidth: 400, marginBottom: 12 }}
    />

    {customersLoading ? (
      <div>Loading...</div>
    ) : (
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>Name</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>Business</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>Email</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>Phone</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>City/State</th>
              <th style={{ textAlign: "center", padding: 8, borderBottom: "1px solid #eee" }}>Free</th>
            </tr>
          </thead>
          <tbody>
            {(customers || [])
              .filter((c) => {
                const q = customerSearch.toLowerCase();

                return (
                  `${c.firstName || ""} ${c.lastName || ""}`.toLowerCase().includes(q) ||
                  (c.email || "").toLowerCase().includes(q) ||
                  (c.phone || "").toLowerCase().includes(q) ||
                  (c.businessName || "").toLowerCase().includes(q) ||
                  (c.city || "").toLowerCase().includes(q) ||
                  (c.state || "").toLowerCase().includes(q)
                );
              })
              .map((c) => (
                <tr key={c.id}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                    {c.firstName} {c.lastName}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                    {c.businessName || "-"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{c.email}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                    {c.phone || "-"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                    {(c.city || "-") + " / " + (c.state || "-")}
                  </td>
                  <td
                    style={{
                      padding: 8,
                      borderBottom: "1px solid #f3f3f3",
                      textAlign: "center",
                    }}
                  >
                    {Number(c.freeDelivery) ? "✅" : "—"}
                  </td>
                </tr>
              ))}

            {!customers?.length && (
              <tr>
                <td colSpan={6} style={{ padding: 10, opacity: 0.7 }}>
                  No customers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    )}
  </div>
)}

{/* =========================
    ORDERS TAB
========================= */}
{adminTab === "orders" && (
  <>
    {/* DASHBOARD */}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 16 }}>
      
      <div className="card">
        <div style={{ fontSize: 12, opacity: 0.7 }}>Total Orders</div>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {dashboardLoading ? "..." : dashboardStats.totalOrders}
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 12, opacity: 0.7 }}>Revenue</div>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {dashboardLoading ? "..." : `$${dashboardStats.revenue.toFixed(2)}`}
        </div>
      </div>
<div className="card">
  <div style={{ fontSize: 12, opacity: 0.7 }}>Profit</div>
  <div style={{ fontSize: 22, fontWeight: 800 }}>
    {dashboardLoading ? "..." : `$${dashboardStats.profit.toFixed(2)}`}
  </div>
</div>
      <div className="card">
        <div style={{ fontSize: 12, opacity: 0.7 }}>Cancelled</div>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {dashboardLoading ? "..." : dashboardStats.cancelled}
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 12, opacity: 0.7 }}>Refunded</div>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {dashboardLoading ? "..." : dashboardStats.refunded}
        </div>
      </div>

    </div>
<div className="card" style={{ marginTop: 16, marginBottom: 12 }}>
  <div style={{ display: "grid", gap: 8 }}>
    <div style={{ fontWeight: 800 }}>Search Orders</div>

    <input
      className="input"
      placeholder="Search by order #, invoice, email..."
      value={orderSearch}
      onChange={(e) => setOrderSearch(e.target.value)}
    />
  </div>
</div>
   {/* ORDERS */}
<div className="card" style={{ marginTop: 16, width: "100%", maxWidth: "100%" }}>
  <div style={{ fontWeight: 800, marginBottom: 10, fontSize: 17 }}>Orders</div>

  {ordersLoading ? (
    <div>Loading...</div>
  ) : (
    <div style={{ overflowX: "hidden" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          whiteSpace: "nowrap",
          fontSize: 14
        }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Order #</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Invoice</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Email</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Total</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Tax</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Shipping</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Cost</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Profit</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Status</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Payment</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Date</th>
            <th style={{ textAlign: "left", padding: 5, borderBottom: "1px solid #eee" }}>Actions</th>
          </tr>
        </thead>

        <tbody>
          {(filteredOrders || []).map((o) => (
            <React.Fragment key={o.id}>
              <tr>
                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3" }}>{o.orderNumber}</td>
                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3" }}>{o.invoiceId}</td>
                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3" }}>{o.email}</td>

                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                  ${Number(o.grandTotal || 0).toFixed(2)}
                </td>

                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                  ${Number(o.tax || 0).toFixed(2)}
                </td>

                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                  ${Number(o.shipping || 0).toFixed(2)}
                </td>

                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                  ${Number(o.cost || 0).toFixed(2)}
                </td>

                <td style={{ padding: 4, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                  ${Number(o.profit || 0).toFixed(2)}
                </td>

                <td style={{ padding: 5, borderBottom: "1px solid #f3f3f3" }}>
                  {o.status || o.paymentStatus}
                </td>

                <td style={{ padding: 5, borderBottom: "1px solid #f3f3f3" }}>
                  {o.paymentMethod}
                </td>

                <td style={{ padding: 5, borderBottom: "1px solid #f3f3f3" }}>
                  {o.createdAt}
                </td>

                <td style={{ padding: 5, borderBottom: "1px solid #f3f3f3" }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    {String(o.status || "").toUpperCase() === "CANCEL_REQUESTED" ? (
                      <>
                        <button className="btn" onClick={() => approveCancelOrder(o.id)}>
                          Approve
                        </button>

                        <button
                          className="btn"
                          style={{ background: "#eee" }}
                          onClick={() => rejectCancelOrder(o.id)}
                        >
                          Reject
                        </button>
                      </>
                    ) : String(o.status || "").toUpperCase() !== "CANCELLED" ? (
                      <button className="btn" onClick={() => cancelOrder(o.id)}>
                        Cancel
                      </button>
                    ) : (
                      <span style={{ opacity: 0.6 }}>—</span>
                    )}

                    {String(o.paymentStatus || "").toUpperCase() === "REFUNDED" ? (
                      <span style={{ opacity: 0.6 }}>Refunded</span>
                    ) : String(o.status || "").toUpperCase() === "CANCELLED" ? (
                      <button className="btn" onClick={() => markRefunded(o.id)}>
                        Refund
                      </button>
                    ) : (
                      <span style={{ opacity: 0.6 }}>—</span>
                    )}

                    <button className="btn" onClick={() => toggleOrderHistory(o.id)}>
                      {orderEventsOpen[o.id] ? "Hide history" : "View history"}
                    </button>
                  </div>
                </td>
              </tr>

                  {/* HISTORY */}
                  {orderEventsOpen[o.id] && (
                    <tr>
                      <td colSpan={8} style={{ padding: 10 }}>
                        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                          <div style={{ fontWeight: 800, marginBottom: 10 }}>
                            Order History
                          </div>

                          {orderEventsLoading[o.id] ? (
                            <div style={{ opacity: 0.7 }}>Loading history...</div>
                          ) : (orderEventsById[o.id] || []).length === 0 ? (
                            <div style={{ opacity: 0.7 }}>No history available.</div>
                          ) : (
                            <div style={{ display: "grid", gap: 10 }}>
                              {orderEventsById[o.id].map((ev) => (
                                <div
                                  key={ev.id}
                                  style={{
                                    border: "1px solid var(--border)",
                                    borderRadius: 10,
                                    padding: 10,
                                    background: "var(--card)",
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <div style={{ fontWeight: 700 }}>
                                      {formatOrderEventLabel(ev)}
                                    </div>
                                    <div style={{ opacity: 0.7, fontSize: 12 }}>
                                      {formatEventDate(ev.createdAt)}
                                    </div>
                                  </div>

                                  <div style={{ marginTop: 6, opacity: 0.8, fontSize: 12 }}>
                                    By: {formatEventActor(ev)}
                                  </div>

                                  {ev.message && (
                                    <div style={{ marginTop: 6, fontSize: 13 }}>
                                      {ev.message}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}

              {!filteredOrders?.length && (
                <tr>
                  <td colSpan={8} style={{ padding: 10, opacity: 0.7 }}>
                    No orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </>
)}
{/* =========================
    ZELLE PENDING TAB
========================= */}
{adminTab === "zelle" && (
  <div className="card" style={{ marginTop: 16 }}>
    <AdminZellePending onCount={(n) => setZellePendingCount(n)} />
  </div>
)}
{/* =========================
    CREATE ORDER TAB
========================= */}
{adminTab === "createOrder" && (
  <div className="card" style={{ marginTop: 16 }}>
    <div style={{ fontWeight: 800, marginBottom: 10 }}>Create Order for Customer</div>

    <div style={{ display: "grid", gap: 10 }}>
      {/* ===== Customer search ===== */}
      <div style={{ display: "grid", gap: 8 }}>
        <input
          className="input"
          placeholder="Search customer by name (or business)"
          value={coSearchName}
          onChange={(e) => {
            setCoSearchName(e.target.value);
            setCoSelectedCustomer(null);
            setCoShowSuggest(true);
          }}
          onFocus={() => setCoShowSuggest(true)}
          onBlur={() => setTimeout(() => setCoShowSuggest(false), 120)}
        />

        {coShowSuggest &&
          (() => {
            const q = String(coSearchName || "").trim().toLowerCase();

            const list = (customers || [])
              .filter((c) => {
                const name = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
                const biz = String(c.businessName || "").toLowerCase();
                if (!q) return true;
                return name.includes(q) || biz.includes(q);
              })
              .slice(0, 8);

            if (!list.length) return null;

            return (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  overflow: "hidden",
                }}
              >
                {list.map((c) => {
                  const name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
                  const line2 = [c.businessName, c.city, c.state].filter(Boolean).join(" • ");

                  return (
                    <div
                      key={c.id}
                      onMouseDown={() => {
                        setCoEmail(c.email || "");
                        setCoSearchName(name || c.email || "");
                        setCoSelectedCustomer(c);
                        setCoShowSuggest(false);

                        if (customerHasFreeDelivery(c)) {
                          setCoShippingId("free_delivery");
                        }
                      }}
                      style={{
                        padding: 10,
                        cursor: "pointer",
                        borderBottom: "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 800 }}>{name || c.email}</div>

                        {customerHasFreeDelivery(c) ? (
                          <span
                            style={{
                              ffontSize: 13,
                              fontWeight: 800,
                              padding: "2px 8px",
                              borderRadius: 999,
                              border: "1px solid var(--border)",
                              background: "rgba(34,197,94,0.18)",
                            }}
                          >
                            FREE DELIVERY
                          </span>
                        ) : null}
                      </div>

                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        {c.email}
                        {line2 ? ` • ${line2}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

        {/* este email se usa para crear la orden */}
        <input
          className="input"
          placeholder="Customer email (auto-filled)"
          value={coEmail}
          onChange={(e) => {
            setCoEmail(e.target.value);
            setCoSelectedCustomer(null);
          }}
        />
      </div>

      {/* ===== Shipping + Payment ===== */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <select className="select" value={coShippingId} onChange={(e) => setCoShippingId(e.target.value)}>
          <option value="uber">uber</option>
          <option value="free_delivery">free_delivery</option>

          <option value="usps" disabled={customerHasFreeDelivery(coSelectedCustomer)}>
            usps
          </option>
          <option value="ups" disabled={customerHasFreeDelivery(coSelectedCustomer)}>
            ups
          </option>
          <option value="fedex" disabled={customerHasFreeDelivery(coSelectedCustomer)}>
            fedex
          </option>
        </select>

        <select className="select" value={coPaymentMethod} onChange={(e) => setCoPaymentMethod(e.target.value)}>
          <option value="Zelle">Zelle</option>
          <option value="Card">Card</option>
        </select>
      </div>

      {/* ===== Add item from inventory (simple select) ===== */}
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        <div className="badge">Add item from inventory</div>

        <input
          className="input"
          placeholder="Search by SKU, Name, or Part Number (MPN)"
          value={productQuery}
          onChange={(e) => setProductQuery(e.target.value)}
        />

        <select className="input" value={pickSku} onChange={(e) => setPickSku(e.target.value)}>
          <option value="">Select product…</option>
          {productOptions.map((p) => (
            <option key={p.id || p.sku} value={p.sku}>
              {p.sku} — {p.name} • Stock: {p.stock ?? 0} {p.mpn ? `(MPN: ${p.mpn})` : ""}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            min={1}
            value={pickQty}
            onChange={(e) => setPickQty(Number(e.target.value || 1))}
          />

          <button
            className="btn"
            type="button"
            onClick={() => {
              if (!pickSku) return alert("Pick a product first");

              const p = (products || []).find((x) => String(x.sku) === String(pickSku));
              if (!p) return alert("Product not found");

              const sku = String(p.sku || "").trim();
              if (!sku) return alert("This product has no SKU. Add SKU first.");
const stock = Number(p.stock ?? 0);
if (stock <= 0) return alert(`OUT OF STOCK: ${sku}`);
              const nextItem = {
                sku,
                name: p.name || sku,
                mpn: p.mpn || "",
                brand: p.brand || "",
                price: typeof p.price === "number" ? p.price : 0,
                qty: Math.max(1, Number(pickQty || 1)),
                weightLb: 1,
              };

              setCoItems((prev) => {
                const idx = prev.findIndex((x) => x.sku === sku);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = { ...copy[idx], qty: Number(copy[idx].qty || 1) + nextItem.qty };
                  return copy;
                }
                return [...prev, nextItem];
              });

              setPickSku("");
              setPickQty(1);
            }}
          >
            Add item
          </button>
        </div>
      </div>

      {/* ===== Add items (search dropdown) ===== */}
      <div className="badge">Add items</div>

      <input
        className="input"
        placeholder="Search product by SKU / name / part number"
        value={coSearchProd}
        onChange={(e) => {
          setCoSearchProd(e.target.value);
          setCoProdSuggestOpen(true);
        }}
        onFocus={() => setCoProdSuggestOpen(true)}
        onBlur={() => setTimeout(() => setCoProdSuggestOpen(false), 120)}
      />

      {coProdSuggestOpen && (
        <div className="card" style={{ padding: 10, marginTop: 8, maxHeight: 220, overflow: "auto" }}>
          {products
            .filter((p) => {
              const q = coSearchProd.trim().toLowerCase();
              if (!q) return false;
              return (
                String(p.sku || "").toLowerCase().includes(q) ||
                String(p.name || "").toLowerCase().includes(q) ||
                String(p.mpn || "").toLowerCase().includes(q)
              );
            })
            .slice(0, 12)
            .map((p) => (
              <button
                key={p.id}
                className="btn"
                style={{ width: "100%", justifyContent: "space-between", marginBottom: 6 }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const sku = String(p.sku || "").trim();
                  if (!sku) return alert("This product has no SKU. Add SKU first.");

                  setCoItems((prev) => {
                    const idx = prev.findIndex((x) => x.sku === sku);
                    if (idx >= 0) {
                      const copy = [...prev];
                      copy[idx] = { ...copy[idx], qty: Number(copy[idx].qty || 1) + 1 };
                      return copy;
                    }
                    return [
                      ...prev,
                      {
                        sku,
                        name: p.name || sku,
                        price: typeof p.price === "number" ? p.price : 0,
                        qty: 1,
                        weightLb: 1,
                        mpn: p.mpn || "",
                        brand: p.brand || "",
                      },
                    ];
                  });

                  setCoSearchProd("");
                  setCoProdSuggestOpen(false);
                }}
              >
                <span>
                  <b>{p.sku}</b> — {p.name || "(no name)"} {p.mpn ? `• ${p.mpn}` : ""}
                </span>
                <span>${typeof p.price === "number" ? p.price.toFixed(2) : "0.00"}</span>
              </button>
            ))}

          {coSearchProd.trim() && (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              If you don’t see it, check SKU/name/MPN in Products.
            </div>
          )}
        </div>
      )}

      {/* ===== items table ===== */}
      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {coItems.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No items yet.</div>
        ) : (
          coItems.map((it, idx) => (
            <div
              key={it.sku}
              className="card"
              style={{
                padding: 10,
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 220 }}>
  <div>
    <b>{it.sku}</b> — {it.name}
    {it.mpn ? <span style={{ color: "var(--muted)" }}> • {it.mpn}</span> : null}
  </div>

  {(() => {
  const stock = Number(
    (products || []).find((p) => String(p.sku) === String(it.sku))?.stock ?? 0
  );

  if (stock <= 0) {
    return (
      <div style={{ color: "#dc2626", fontSize: 12, marginTop: 2 }}>
        OUT OF STOCK
      </div>
    );
  }

  if (stock <= 3) {
    return (
      <div style={{ color: "#ea580c", fontSize: 12, marginTop: 2 }}>
        LOW STOCK: {stock}
      </div>
    );
  }

  return (
    <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2 }}>
      Stock: {stock}
    </div>
  );
})()}
</div>

              <div style={{ width: 110, textAlign: "right" }}>${Number(it.price || 0).toFixed(2)}</div>

              <input
  className="input"
  type="number"
  style={{ width: 90 }}
  value={it.qty}
  min={1}
  onChange={(e) => {
    const raw = Math.max(1, Math.floor(Number(e.target.value || 1)));

    const prod = (products || []).find(
      (p) => String(p.sku) === String(it.sku)
    );

    const stock = Number(prod?.stock ?? 0);

    const v = stock > 0 ? Math.min(raw, stock) : raw;

    if (stock > 0 && raw > stock) {
      alert(`Max stock for ${it.sku} is ${stock}.`);
    }

    setCoItems((prev) =>
      prev.map((x, i) => (i === idx ? { ...x, qty: v } : x))
    );
  }}
/>

              <button className="btn" onClick={() => setCoItems((prev) => prev.filter((_, i) => i !== idx))}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {/* ===== Totals (preview) like checkout ===== */}
      <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
        {coPreviewLoading ? (
          <div className="badge">Calculating totals…</div>
        ) : coPreviewErr ? (
          <div className="badge" style={{ border: "1px solid rgba(255,0,0,0.25)" }}>
            {coPreviewErr}
          </div>
        ) : coPreview ? (
          <>
            <div className="badge">
              Subtotal: <b>${Number(coPreview.subtotal || 0).toFixed(2)}</b>
            </div>

            <div className="badge">
              Shipping ({String(coPreview.chosen?.id || "")}
              {coPreview.chosen?.carrier ? ` • ${coPreview.chosen.carrier}` : ""}
              {coPreview.chosen?.service ? ` • ${coPreview.chosen.service}` : ""}
              {coPreview.chosen?.eta ? ` • ${coPreview.chosen.eta}` : ""}
              ): <b>${Number(coPreview.shipping || 0).toFixed(2)}</b>
            </div>

            <div className="badge">
              Tax: <b>${Number(coPreview.tax || 0).toFixed(2)}</b>
            </div>

            <div className="badge" style={{ fontWeight: 900 }}>
              Grand Total: ${Number(coPreview.grandTotal || 0).toFixed(2)}
            </div>
          </>
        ) : (
          <div className="badge">Add email + items to see totals.</div>
        )}
      </div>

      {/* ===== CREATE ORDER BUTTON ===== */}
      <div style={{ marginTop: 24 }}>
        <button
          className="btn"
          disabled={
            !String(coEmail || "").trim() ||
            coItems.length === 0 ||
            coPreviewLoading ||
            !!coPreviewErr
          }
          style={{
            width: "100%",
            padding: "14px 18px",
            fontWeight: 800,
            fontSize: 16,
            opacity:
              !String(coEmail || "").trim() ||
              coItems.length === 0 ||
              coPreviewLoading ||
              !!coPreviewErr
                ? 0.6
                : 1,
            cursor:
              !String(coEmail || "").trim() ||
              coItems.length === 0 ||
              coPreviewLoading ||
              !!coPreviewErr
                ? "not-allowed"
                : "pointer",
          }}
          onClick={async () => {
            try {
              const email = String(coEmail || "").trim();
              if (!email) return alert("Enter customer email");
              if (!coItems || coItems.length === 0) return alert("Add at least 1 item");

              const r = await fetch(`${API}/admin/orders/create`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
                },
                body: JSON.stringify({
                  email,
                  items: coItems,
                  selectedShippingId: coShippingId,
                  paymentMethod: coPaymentMethod,
                }),
              });

              const data = await r.json();
              if (!r.ok || !data.ok) throw new Error(data.error || "Create order failed");

              alert(`✅ Order created: ${data.order.orderNumber} (${data.order.invoiceId})`);

              // Reset form
              setCoItems([]);
              setCoSearchProd("");
              setCoProdSuggestOpen(false);
              setCoSearchName("");
              setCoShowSuggest(false);
              setPickSku("");
              setPickQty(1);
            } catch (e) {
              alert(e.message || "Create order failed");
            }
          }}
        >
          Create Order
        </button>
      </div>
    </div>
  </div>
)}
{/* =========================
    PRODUCTS TAB
========================= */}
{adminTab === "products" && (
  <>
    {(() => {
      const filteredProducts = (products || []).filter((p) => {
        const q = String(productSearch || "").trim().toLowerCase();

        const matchesSearch =
          !q ||
          String(p.name || "").toLowerCase().includes(q) ||
          String(p.sku || "").toLowerCase().includes(q) ||
          String(p.brand || "").toLowerCase().includes(q) ||
          String(p.mpn || "").toLowerCase().includes(q) ||
          String(p.category || "").toLowerCase().includes(q);

        const matchesCategory =
          !productCategoryFilter || String(p.category || "") === productCategoryFilter;

        const matchesStatus =
          productStatusFilter === "all"
            ? true
            : productStatusFilter === "active"
            ? p.active !== false
            : p.active === false;

        const stockNum = safeNum(p.stock ?? 0);
        const matchesLowStock = !productLowStockOnly || stockNum <= 1;

        return matchesSearch && matchesCategory && matchesStatus && matchesLowStock;
      });

      return (
        <>
          {/* FILTER BAR */}
          <div className="card" style={{ marginTop: 16 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.5fr 0.95fr 0.95fr auto auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input
                className="input"
                placeholder="Search by name, SKU, brand, part number, category..."
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
              />

              <select
                className="input"
                value={productCategoryFilter}
                onChange={(e) => setProductCategoryFilter(e.target.value)}
              >
                <option value="">All categories</option>
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                className="input"
                value={productStatusFilter}
                onChange={(e) => setProductStatusFilter(e.target.value)}
              >
                <option value="all">All status</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
              </select>

              <label style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={productLowStockOnly}
                  onChange={(e) => setProductLowStockOnly(e.target.checked)}
                />
                Low stock only
              </label>

              <div className="badge">Results: {filteredProducts.length}</div>
            </div>
          </div>

          {/* TABLE */}
          <div className="card" style={{ marginTop: 16, overflow: "hidden", padding: 0 }}>
            {/* HEADER */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2.2fr 1.35fr 1fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr 1.05fr",
                gap: 8,
                padding: "10px 12px",
                borderBottom: "1px solid var(--border)",
                fontWeight: 800,
                fontSize: 12,
                color: "var(--muted)",
                background: "rgba(255,255,255,0.04)",
                alignItems: "center",
              }}
            >
              <div>Product</div>
              <div>SKU</div>
              <div>Category</div>
              <div>Price</div>
              <div>Cost</div>
              <div>Profit</div>
              <div>Margin</div>
              <div>Stock</div>
              <div>Actions</div>
            </div>

            {/* ROWS */}
            {filteredProducts.map((p, rowIndex) => {
              const cur = p._pick || blankPick;
              const modelOptions = cur.make ? modelsByMake[cur.make] || [] : [];
              const engineOptions =
                cur.make && cur.model
                  ? enginesByMakeModel[`${cur.make}||${cur.model}`] || []
                  : [];
              const isOpen = openProductId === p.id;

              return (
                <div
                  key={p.id}
                  style={{
                    borderBottom:
                      rowIndex === filteredProducts.length - 1
                        ? "none"
                        : "1px solid var(--border)",
                  }}
                >
                  {/* MAIN ROW */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "2.2fr 1.35fr 1fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr 1.05fr",
                      gap: 8,
                      padding: "10px 12px",
                      alignItems: "center",
                      fontSize: 15,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: 14,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          lineHeight: 1.15,
                        }}
                        title={p.name || ""}
                      >
                        {p.name?.trim() ? p.name : "(New product)"}
                      </div>

                      <div
                        style={{
                          marginTop: 4,
                          display: "flex",
                          gap: 4,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <div className="badge" style={{ fontSize: 11, padding: "4px 8px" }}>
                          {p.active !== false ? "Active" : "Inactive"}
                        </div>

                        {!!p.fitsAll && (
                          <div className="badge" style={{ fontSize: 11, padding: "4px 8px" }}>
                            Universal
                          </div>
                        )}

                        <div style={{ transform: "scale(0.92)", transformOrigin: "left center" }}>
                          {renderStockBadge(p.stock)}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                      }}
                      title={p.sku || ""}
                    >
                      {p.sku?.trim() ? p.sku : "—"}
                    </div>

                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                      }}
                      title={p.category || ""}
                    >
                      {p.category?.trim() ? p.category : "—"}
                    </div>

                    <div style={{ fontSize: 14 }}>${Number(p.price ?? 0).toFixed(2)}</div>
<div style={{ fontSize: 14 }}>${Number(p.cost ?? 0).toFixed(2)}</div>
<div style={{ fontSize: 14, fontWeight: 700 }}>
  ${(safeNum(p.price ?? 0) - safeNum(p.cost ?? 0)).toFixed(2)}
</div>
<div style={{ fontSize: 14 }}>{Number(p.marginPct ?? 0).toFixed(2)}%</div>
<div style={{ fontSize: 14 }}>{safeNum(p.stock ?? 0)}</div>


                    <div
  style={{
    display: "flex",
    gap: 6,
    justifyContent: "flex-start",
    whiteSpace: "nowrap",
  }}
>
 <button
  className="btn"
  style={{ padding: "8px 10px", fontSize: 13 }}
  onClick={() => {
    if (isOpen && dirtyProducts[p.id]) {
      const ok = window.confirm("You have unsaved changes. Close anyway?");
      if (!ok) return;
    }
    setOpenProductId(isOpen ? null : p.id);
  }}
>
  {isOpen ? "Close" : "Edit"}
</button>

  
  <button
    className="btn"
    style={{ padding: "8px 10px", fontSize: 13 }}
    onClick={() => delProduct(p.id)}
  >
    Delete
  </button>
</div>
                  </div>

                  {/* EXPANDED EDIT PANEL */}
                  {isOpen && (
                    <div
                      style={{
                        padding: 14,
                        borderTop: "1px solid var(--border)",
                        background: "rgba(255,255,255,0.03)",
                      }}
                    >
                      {/* BASIC INFO */}
<div
  style={{
    display: "flex",
    gap: 8,
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    flexWrap: "wrap",
  }}
>
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <div className="badge">Basic info</div>

    {productSaveState[p.id] === "saving" && <div className="badge">Saving...</div>}
    {productSaveState[p.id] === "saved" && <div className="badge">Saved</div>}
    {productSaveState[p.id] === "error" && <div className="badge">Save failed</div>}
  </div>

  <button
  className="btn btnPrimary"
  onClick={() => saveProduct(p)}
>
  Save
</button>
</div>

<div
  style={{
    display: "grid",
    gridTemplateColumns: "1.5fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 1fr",
    gap: 10,
  }}
>
  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Name</div>
    <input
      className="input"
      placeholder="Name"
      value={p.name || ""}
      onChange={(e) => setField(p.id, "name", e.target.value)}
    />
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Price</div>
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--muted)",
        }}
      >
        $
      </span>
      <input
        className="input"
        type="number"
        value={p.price ?? 0}
        readOnly
        style={{ paddingLeft: 26, opacity: 0.85 }}
      />
    </div>
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Cost</div>
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--muted)",
        }}
      >
        $
      </span>
      <input
        className="input"
        type="number"
        value={p.cost ?? 0}
        onChange={(e) => {
          const cost = safeNum(e.target.value);
          const marginPct = safeNum(p.marginPct ?? 0);
          const newPrice = calcPriceFromMargin(cost, marginPct);

          setProducts((prev) =>
            prev.map((x) =>
              x.id === p.id ? { ...x, cost, price: newPrice } : x
            )
          );
        }}
        style={{ paddingLeft: 26 }}
      />
    </div>
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Profit</div>
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--muted)",
        }}
      >
        $
      </span>
      <input
        className="input"
        type="number"
        value={(safeNum(p.price ?? 0) - safeNum(p.cost ?? 0)).toFixed(2)}
        readOnly
        style={{ paddingLeft: 26, opacity: 0.85, fontWeight: 700 }}
      />
    </div>
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Margin %</div>
    <input
      className="input"
      type="number"
      placeholder="Margin %"
      value={p.marginPct ?? ""}
      onChange={(e) => {
        const marginPct = safeNum(e.target.value);
        const cost = safeNum(p.cost ?? 0);
        const newPrice = calcPriceFromMargin(cost, marginPct);

        setProducts((prev) =>
          prev.map((x) =>
            x.id === p.id ? { ...x, marginPct, price: newPrice } : x
          )
        );
      }}
    />
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>QTY</div>
    <input
      className="input"
      type="number"
      placeholder="QTY"
      value={p.stock ?? 0}
      onChange={(e) => setField(p.id, "stock", safeNum(e.target.value))}
    />
  </div>

  <div style={{ display: "grid", gap: 4 }}>
    <div style={{ fontSize: 12, color: "var(--muted)" }}>Category</div>
    <select
      className="input"
      value={p.category || ""}
      onChange={(e) => setField(p.id, "category", e.target.value)}
    >
      <option value="">Select category</option>
      {PRODUCT_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  </div>
</div>

                      {/* IMAGE */}
<div className="badge" style={{ marginTop: 14 }}>
  Image
</div>

<div
  style={{
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    alignItems: "center",
  }}
>
  <input
    className="input"
    placeholder="Image URL (optional)"
    value={p.imageUrl || ""}
    onChange={(e) => setField(p.id, "imageUrl", e.target.value)}
  />

  <button
    className="btn"
    onClick={() => setField(p.id, "imageUrl", "")}
    title="Remove image"
  >
    Remove image
  </button>
</div>

<div
  style={{
    marginTop: 10,
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
  }}
>
  <input
    className="input"
    type="file"
    accept="image/png,image/jpeg"
    onChange={async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!["image/png", "image/jpeg"].includes(file.type)) {
        alert("Only JPG or PNG allowed");
        e.target.value = "";
        return;
      }

      const dataUrl = await fileToDataURL(file);
      setField(p.id, "imageUrl", dataUrl);
      e.target.value = "";
    }}
    style={{ maxWidth: 340 }}
  />

  {p.imageUrl ? (
    <div
      className="badge"
      style={{
        maxWidth: 420,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      Image set {p.imageUrl.startsWith("data:image") ? "(uploaded)" : "(url)"}
    </div>
  ) : (
    <div className="badge">No image</div>
  )}
</div>

{p.imageUrl ? (
  <div style={{ marginTop: 10 }}>
    <div
      style={{
        width: 120,
        height: 120,
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <img
        src={p.imageUrl}
        alt="preview"
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  </div>
) : null}

                   {/* PRODUCT INFO */}
<div className="badge" style={{ marginTop: 14 }}>
  Product info
</div>

<div
  style={{
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 1fr",
    gap: 10,
  }}
>
  {/* SKU */}
  <input
    className="input"
    placeholder="SKU"
    value={p.sku || ""}
    onChange={(e) => setField(p.id, "sku", e.target.value)}
  />

  {/* BRAND */}
  <input
    className="input"
    placeholder="Brand"
    value={p.brand || ""}
    onChange={(e) => setField(p.id, "brand", e.target.value)}
  />

  {/* PART NUMBER */}
  <input
    className="input"
    placeholder="Part Number"
    value={p.mpn || ""}
    onChange={(e) => setField(p.id, "mpn", e.target.value)}
  />

  {/* ASIN */}
  <input
    className="input"
    placeholder="ASIN (optional)"
    value={p.asin || ""}
    onChange={(e) => setField(p.id, "asin", e.target.value)}
  />
</div>

<div
  style={{
    marginTop: 12,
    display: "flex",
    gap: 18,
    alignItems: "center",
    flexWrap: "wrap",
  }}
>
  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <input
      type="checkbox"
      checked={p.active !== false}
      onChange={(e) => setField(p.id, "active", e.target.checked)}
    />
    Active
  </label>

  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <input
      type="checkbox"
      checked={!!p.fitsAll}
      onChange={(e) => setField(p.id, "fitsAll", e.target.checked)}
    />
    Fits all (universal)
  </label>
</div>

                      {/* FITMENTS */}
                      <div className="badge" style={{ marginTop: 14 }}>
                        Fitments (multiple)
                      </div>

                      <div
                        style={{
                          marginTop: 10,
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                          gap: 10,
                        }}
                      >
                        <select
                          className="select"
                          value={cur.make}
                          onChange={(e) => setPickField(p.id, "make", e.target.value)}
                        >
                          <option value="">Make</option>
                          {makes.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>

                        <select
                          className="select"
                          value={cur.model}
                          disabled={!cur.make}
                          onChange={(e) => setPickField(p.id, "model", e.target.value)}
                        >
                          <option value="">{cur.make ? "Model (choose make)" : "Model"}</option>
                          {modelOptions.map((mo) => (
                            <option key={mo} value={mo}>
                              {mo}
                            </option>
                          ))}
                        </select>

                        <select
                          className="select"
                          value={cur.engine}
                          disabled={!cur.model}
                          onChange={(e) => setPickField(p.id, "engine", e.target.value)}
                        >
                          <option value="">{cur.model ? "Engine (choose model)" : "Engine"}</option>
                          {engineOptions.map((en) => (
                            <option key={en} value={en}>
                              {en}
                            </option>
                          ))}
                        </select>

                        <input
                          className="input"
                          placeholder="Year start (optional)"
                          value={cur.yearStart || ""}
                          onChange={(e) => setPickField(p.id, "yearStart", e.target.value)}
                        />

                        <input
                          className="input"
                          placeholder="Year end (optional)"
                          value={cur.yearEnd || ""}
                          onChange={(e) => setPickField(p.id, "yearEnd", e.target.value)}
                        />
                      </div>

                      <button
                        className="btn btnPrimary"
                        style={{ marginTop: 10 }}
                        onClick={() => addFitmentToProduct(p.id)}
                        disabled={!cur.make || !cur.model || !cur.engine}
                        title={
                          !cur.make || !cur.model || !cur.engine
                            ? "Pick make/model/engine first"
                            : "Add fitment"
                        }
                      >
                        + Add fitment
                      </button>

                      <div style={{ marginTop: 10, color: "var(--muted)" }}>
                        {(p.fits || []).length === 0 ? (
                          <div>No fitments added yet.</div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {(p.fits || []).map((f, idx) => (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  padding: 10,
                                  borderRadius: 12,
                                  border: "1px solid var(--border)",
                                  background: "rgba(255,255,255,0.04)",
                                  color: "var(--text)",
                                }}
                              >
                                <div>
                                  {f.make} • {f.model} • {f.engine}
                                  {f.yearStart != null || f.yearEnd != null
                                    ? ` • ${f.yearStart ?? ""}-${f.yearEnd ?? ""}`
                                    : ""}
                                </div>

                                <button
                                  className="btn"
                                  onClick={() => removeFitment(p.id, idx)}
                                  title="Remove fitment"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredProducts.length === 0 && (
              <div style={{ padding: 16, color: "var(--muted)" }}>
                No matching products found.
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              ⚠️ Uploading images stores them in your browser (localStorage). Very large images can hit
              storage limits. Later we can move images to hosting and keep only URLs.
            </div>
          </div>
        </>
      );
    })()}
  </>
)}
    </div>
  );
}
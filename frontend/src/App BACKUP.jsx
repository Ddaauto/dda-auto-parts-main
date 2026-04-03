import { useEffect, useMemo, useState } from "react";
import Admin from "./Admin";
import Register from "./Register";
import "./App.css";
import logo from "./assets/logo.jpg";

/**
 * =========================
 * CONFIG
 * =========================
 */
const API = "http://localhost:5177";
const YEARS = Array.from({ length: 36 }, (_, i) => 2026 - i);
const OTHER = "__OTHER__";

const MAKES_USA = [
  "Acura","Alfa Romeo","Audi","BMW","Buick","Cadillac","Chevrolet","Chrysler","Dodge",
  "Fiat","Ford","Genesis","GMC","Honda","Hyundai","Infiniti","Jaguar","Jeep","Kia",
  "Land Rover","Lexus","Lincoln","Mazda","Mercedes-Benz","Mini","Mitsubishi","Nissan",
  "Porsche","Ram","Subaru","Tesla","Toyota","Volkswagen","Volvo",
  "Aston Martin","Bentley","Ferrari","Lamborghini","Maserati","McLaren","Rolls-Royce",
  "Polestar","Rivian","Lucid","Smart","Suzuki","Isuzu","Saab","Pontiac","Saturn",
  "Scion","Hummer","Oldsmobile","Mercury","Plymouth"
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function money(n) {
  const x = Number(n || 0);
  return x.toFixed(2);
}
function canonFromList(value, list) {
  const v = String(value || "").trim();
  if (!v) return "";
  const hit = list.find((x) => String(x).toLowerCase() === v.toLowerCase());
  return hit || v;
}
function normalizeEngine(input) {
  let e = String(input || "").trim();
  if (!e) return "";
  e = e.replace(/\s+/g, " ");
  const up = e.toUpperCase();
  if (/^\d+(\.\d+)?$/.test(up)) return `${up}L`;
  if (/^\d+(\.\d+)?\s*L$/.test(up)) return up.replace(/\s*L$/, "L");
  return up;
}

/**
 * =========================
 * SIMPLE ROUTER
 * =========================
 */
function useRoute() {
  const [route, setRoute] = useState(window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (path) => {
    const cur = window.location.pathname || "/";
    if (cur === path) return;
    window.history.pushState({}, "", path);
    setRoute(path);
  };
  return { route, go };
}

/**
 * =========================
 * API HELPERS
 * =========================
 */
function getToken() {
  return localStorage.getItem("token") || "";
}
function setToken(t) {
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}
async function api(path, { method = "GET", body } = {}) {
  const token = getToken();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || "Request failed");
  return data;
}

/**
 * =========================
 * INVOICE HELPERS
 * =========================
 */
const WHATSAPP_NUMBER = "17867044796"; // your number

function buildCustomerAddress(c) {
  const street = c?.street || "";
  const apt = c?.apt ? `, ${c.apt}` : "";
  const city = c?.city || "";
  const state = c?.state || "";
  const zip = c?.zip || "";
  const line = `${street}${apt}, ${city}, ${state} ${zip}`.trim();
  return line || (c?.address || "");
}

function buildShareText(inv) {
  const lines = [];
  lines.push(`DDA Auto Parts - Invoice`);
  lines.push(`Order: ${inv.orderNumber || "-"}`);
  lines.push(`Invoice: ${inv.invoiceId}`);
  lines.push(`Date: ${inv.createdAt}`);
  lines.push("");
  lines.push(`Customer: ${inv.customerName}`);
  lines.push(`Business: ${inv.businessName || "-"}`);
  lines.push(`Phone: ${inv.phone || "-"}`);
  lines.push(`Email: ${inv.email || "-"}`);
  lines.push(`Address: ${inv.address || "-"}`);
  if (inv.resaleTaxNumber) lines.push(`Resale Tax #: ${inv.resaleTaxNumber}`);
  lines.push("");
  if (inv.vehicleLabel) {
    lines.push(`Vehicle: ${inv.vehicleLabel}`);
    if (inv.vin) lines.push(`VIN: ${inv.vin}`);
    lines.push("");
  }
  lines.push("Items:");
  (inv.items || []).forEach((it) => {
    lines.push(`- ${it.name} x${it.qty} @ $${money(it.price)} = $${money(it.qty * it.price)}`);
  });
  lines.push("");
  lines.push(`Subtotal: $${money(inv.subtotal)}`);
  lines.push(`Tax: $${money(inv.tax || 0)}`);
  lines.push(`Shipping (${inv.shippingCarrier || ""} ${inv.shippingService || ""}): $${money(inv.shipping || 0)}`);
  lines.push(`TOTAL: $${money(inv.grandTotal)}`);
  return lines.join("\n");
}

function openInvoiceWindow(inv) {
  const escapeHtml = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const rows = (inv.items || [])
    .map((it, idx) => {
      const lineTotal = Number(it.price || 0) * Number(it.qty || 1);
      return `
        <tr>
          <td class="c">${idx + 1}</td>
          <td>${escapeHtml(it.name)}</td>
          <td class="r">${it.qty}</td>
          <td class="r">$${money(it.price)}</td>
          <td class="r">$${money(lineTotal)}</td>
        </tr>
      `;
    })
    .join("");

  const shippingLine = `${inv.shippingCarrier || ""} ${inv.shippingService || ""}`.trim() || "Shipping";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Invoice ${escapeHtml(inv.invoiceId)}</title>
<style>
  :root{--border:#d1d5db;--muted:#6b7280;}
  body{font-family:Arial,Helvetica,sans-serif;margin:22px;color:#111;}
  .wrap{max-width:900px;margin:0 auto;}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}
  h1{margin:0;font-size:18px;}
  .muted{color:var(--muted);font-size:12px;margin-top:4px;}
  .logo{width:70px;height:70px;object-fit:contain;}
  .hr{border:none;border-top:1px solid var(--border);margin:12px 0;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
  .box{border-top:1px solid var(--border);padding-top:10px;}
  .box h3{margin:0 0 6px 0;font-size:12px;}
  .kv{font-size:12px;display:grid;grid-template-columns:140px 1fr;gap:6px 10px;}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px;}
  th,td{border:1px solid var(--border);padding:8px;}
  thead th{background:#f3f4f6;}
  .c{text-align:center;width:36px;}
  .r{text-align:right;white-space:nowrap;}
  .summary{width:360px;margin-left:auto;margin-top:10px;font-size:12px;}
  .row{display:flex;justify-content:space-between;border:1px solid var(--border);border-bottom:none;padding:7px 8px;}
  .row:last-child{border-bottom:1px solid var(--border);font-weight:900;}
  .actions{margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;}
  .btn{border:1px solid #111;background:#111;color:#fff;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:800;}
  .btn.secondary{background:#fff;color:#111;}
  @media print{.actions{display:none;}body{margin:10mm;}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div style="font-weight:900;font-size:14px">INVOICE</div>
        <h1>DDA Auto Parts</h1>
        <div class="muted">Order No: ${escapeHtml(inv.orderNumber || "—")}</div>
        <div class="muted">Invoice No: ${escapeHtml(inv.invoiceId)}</div>
        <div class="muted">Date: ${escapeHtml(inv.createdAt)}</div>
      </div>
      <div>
        <img class="logo" src="${escapeHtml(logo)}" alt="logo"/>
      </div>
    </div>

    <hr class="hr"/>

    <div class="grid">
      <div class="box">
        <h3>Bill to</h3>
        <div class="kv">
          <div><b>${escapeHtml(inv.customerName)}</b></div><div></div>
          <div>Business:</div><div>${escapeHtml(inv.businessName || "-")}</div>
          <div>Phone:</div><div>${escapeHtml(inv.phone || "-")}</div>
          <div>Email:</div><div>${escapeHtml(inv.email || "-")}</div>
          <div>Address:</div><div>${escapeHtml(inv.address || "-")}</div>
          ${inv.resaleTaxNumber ? `<div>Resale Tax #:</div><div>${escapeHtml(inv.resaleTaxNumber)}</div>` : ``}
        </div>
      </div>

      <div class="box">
        <h3>Vehicle / Shipping</h3>
        <div class="kv">
          <div>Selected:</div><div>${escapeHtml(inv.vehicleLabel || "—")}</div>
          <div>VIN:</div><div>${escapeHtml(inv.vin || "—")}</div>
          <div>Shipping:</div><div>${escapeHtml(shippingLine)} ${inv.shippingEta ? `(${escapeHtml(inv.shippingEta)})` : ""}</div>
          <div>Method:</div><div>${escapeHtml(inv.paymentMethod || "Zelle")}</div>
          <div>Status:</div><div>${escapeHtml(inv.paymentStatus || "Paid")}</div>
        </div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="c">#</th>
          <th>Item</th>
          <th class="r">Qty</th>
          <th class="r">Unit</th>
          <th class="r">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5" style="color:var(--muted)">No items</td></tr>`}
      </tbody>
    </table>

    <div class="summary">
      <div class="row"><span>Subtotal</span><span>$${money(inv.subtotal)}</span></div>
      <div class="row"><span>Tax</span><span>$${money(inv.tax || 0)}</span></div>
      <div class="row"><span>${escapeHtml(shippingLine)}</span><span>$${money(inv.shipping || 0)}</span></div>
      <div class="row"><span>Total</span><span>$${money(inv.grandTotal)}</span></div>
    </div>

    <div class="actions">
      <button class="btn" onclick="window.print()">Print</button>

      <button class="btn secondary" onclick="
        navigator.clipboard.writeText(document.getElementById('share').textContent);
        alert('Copied ✅');
      ">Copy</button>

      <button class="btn secondary" onclick="
        const txt = encodeURIComponent(document.getElementById('share').textContent);
        window.open('https://wa.me/${WHATSAPP_NUMBER}?text=' + txt, '_blank');
      ">WhatsApp</button>

      <button class="btn secondary" onclick="
        const txt = encodeURIComponent(document.getElementById('share').textContent);
        window.location.href = 'sms:?&body=' + txt;
      ">SMS</button>

      <button class="btn secondary" onclick="
        const body = encodeURIComponent(document.getElementById('share').textContent);
        const subject = encodeURIComponent('Invoice ${escapeHtml(inv.invoiceId)} - DDA Auto Parts');
        window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
      ">Email</button>
    </div>

    <pre id="share" style="display:none">${escapeHtml(inv.shareText || "")}</pre>

    <div style="margin-top:18px;font-size:11px;color:var(--muted);text-align:center;">
      Thanks for your Business.
    </div>
  </div>
</body>
</html>`;

  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  return true;
}

/**
 * =========================
 * LOGIN COMPONENT
 * =========================
 */
function Login({ onLogged }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (!email || !password) return setErr("Missing email/password");

    try {
      setLoading(true);
const r = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Login failed");

      setToken(data.token);
      onLogged?.();
    } catch (e) {
      setErr(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 520, margin: "26px auto" }}>
      <h2 style={{ marginTop: 0 }}>Login</h2>
      {err ? <div style={{ color: "#ff9a9a", fontWeight: 800, marginBottom: 10 }}>{err}</div> : null}
      <div style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btnPrimary" onClick={submit} disabled={loading}>
          {loading ? "Loading..." : "Login"}
        </button>
      </div>
    </div>
  );
}

/**
 * =========================
 * ACCOUNT PAGE
 * =========================
 */
function AccountPage({ me, setMe, onBack }) {
  const [profile, setProfile] = useState(null);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setBusy(true);
    setErr("");
    try {
      const c = await api("/customers/me");
      const o = await api("/orders/me");
      setProfile(c);
      setOrders(Array.isArray(o) ? o : []);
    } catch (e) {
      setErr(e.message || "Failed to load account");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setErr("");
    try {
      // required fields (basic)
      if (!profile.firstName || !profile.lastName || !profile.phone || !profile.street || !profile.city || !profile.state || !profile.zip) {
        setErr("Missing required fields (name, phone, street, city, state, zip).");
        setSaving(false);
        return;
      }
      const updated = await api("/customers/me", { method: "PUT", body: profile });
      setProfile(updated);
      const fresh = await api("/auth/me");
      setMe(fresh);
      setErr("");
    } catch (e) {
      setErr(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const openOrderInvoice = async (orderId) => {
    try {
      const row = await api(`/orders/${orderId}`);
      const items = JSON.parse(row.itemsJson || "[]");
      const customerSnapshot = JSON.parse(row.customerSnapshot || "{}");

      const subtotal = Number(row.subtotal ?? 0);
      const tax = Number(row.tax ?? 0);
      const shipping = Number(row.shipping ?? 0);
      const grandTotal = Number(row.grandTotal ?? (subtotal + tax + shipping));

      const inv = {
        orderId: row.id,
        orderNumber: row.orderNumber || "",
        invoiceId: row.invoiceId,
        createdAt: new Date(row.createdAt).toLocaleString(),
        customerName:
          customerSnapshot.firstName
            ? `${customerSnapshot.firstName} ${customerSnapshot.lastName || ""}`.trim()
            : (customerSnapshot.name || "-"),
        businessName: customerSnapshot.businessName || "",
        phone: customerSnapshot.phone || "",
        email: customerSnapshot.email || "",
        address: buildCustomerAddress(customerSnapshot) || customerSnapshot.address || "",
        resaleTaxNumber: String(customerSnapshot.resaleTaxNumber || "").trim(),

        vehicleLabel: row.vehicleLabel || "",
        vin: row.vin || "",

        shippingCarrier: row.shippingCarrier || "",
        shippingService: row.shippingService || "",
        shippingEta: row.shippingEta || "",

        items,
        subtotal,
        tax,
        shipping,
        grandTotal,
        paymentMethod: row.paymentMethod || "Zelle",
        paymentStatus: row.paymentStatus || "Paid",
      };

      inv.shareText = buildShareText(inv);
      openInvoiceWindow(inv);
    } catch (e) {
      alert(e.message || "Could not open invoice");
    }
  };

  if (busy) return <div className="container"><div className="card">Loading account…</div></div>;

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand" style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <img
            src={logo}
            alt="DDA Auto Parts"
            style={{
              width: 54,
              height: 54,
              objectFit: "contain",
              borderRadius: 12,
              background: "rgba(255,255,255,.06)",
              border: "1px solid rgba(255,255,255,.10)",
            }}
          />
          <div>
            <h1 style={{ margin: 0, fontSize: 18 }}>My Account</h1>
            <div className="sub" style={{ fontSize: 13 }}>{me?.user?.email || ""}</div>
          </div>
        </div>

        <div className="pills">
          <button className="btn" onClick={onBack}>← Store</button>
          <button
            className="btn"
            onClick={() => {
              setToken("");
              setMe(null);
              window.history.pushState({}, "", "/");
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {err ? <div className="card" style={{ color: "#ff9a9a", fontWeight: 800 }}>{err}</div> : null}

      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h2 className="sectionTitle">Profile</h2>

          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input className="input" placeholder="First name *" value={profile?.firstName || ""} onChange={(e) => setProfile((p) => ({ ...p, firstName: e.target.value }))} />
              <input className="input" placeholder="Last name *" value={profile?.lastName || ""} onChange={(e) => setProfile((p) => ({ ...p, lastName: e.target.value }))} />
            </div>

            <input className="input" placeholder="Business name (optional)" value={profile?.businessName || ""} onChange={(e) => setProfile((p) => ({ ...p, businessName: e.target.value }))} />

            <input className="input" placeholder="Email" value={profile?.email || ""} disabled />
            <input className="input" placeholder="Phone *" value={profile?.phone || ""} onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} />

            <input className="input" placeholder="Street *" value={profile?.street || ""} onChange={(e) => setProfile((p) => ({ ...p, street: e.target.value }))} />
            <input className="input" placeholder="Apt/Suite (optional)" value={profile?.apt || ""} onChange={(e) => setProfile((p) => ({ ...p, apt: e.target.value }))} />

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
              <input className="input" placeholder="City *" value={profile?.city || ""} onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))} />
              <input className="input" placeholder="State *" value={profile?.state || ""} onChange={(e) => setProfile((p) => ({ ...p, state: e.target.value }))} />
              <input className="input" placeholder="ZIP *" value={profile?.zip || ""} onChange={(e) => setProfile((p) => ({ ...p, zip: e.target.value }))} />
            </div>

            <input
              className="input"
              placeholder="Resale Tax Number (optional) - Tax exempt"
              value={profile?.resaleTaxNumber || ""}
              onChange={(e) => setProfile((p) => ({ ...p, resaleTaxNumber: e.target.value }))}
            />

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn btnPrimary" onClick={saveProfile} disabled={saving}>
                {saving ? "Saving…" : "Save profile"}
              </button>
              <button className="btn" onClick={load}>Refresh</button>
            </div>
          </div>

          <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 13 }}>
            Required: name, phone, street, city, state, zip. Resale Tax Number is optional (tax exempt).
          </div>
        </div>

        <div className="card">
          <h2 className="sectionTitle">Purchase history</h2>

          {orders.length === 0 ? (
            <div style={{ color: "var(--muted)" }}>No orders yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {orders.map((o) => (
                <div key={o.id} className="card" style={{ padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>{o.orderNumber || "—"}</div>
                      <div style={{ fontWeight: 900, marginTop: 4 }}>{o.invoiceId}</div>
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>{new Date(o.createdAt).toLocaleString()}</div>
                      <div style={{ marginTop: 6 }} className="badge">
                        Status: <strong>{o.status || o.paymentStatus || "PAID"}</strong>
                      </div>
                    </div>

                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 900, fontSize: 18 }}>
                        ${money(o.grandTotal ?? 0)}
                      </div>
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>{o.paymentMethod || "Zelle"}</div>
                      <button className="btn btnPrimary" style={{ marginTop: 10 }} onClick={() => openOrderInvoice(o.id)}>
                        Open invoice
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 13 }}>
            Open invoice → print / copy / WhatsApp / SMS / Email.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * =========================
 * MAIN APP
 * =========================
 */
export default function App() {
  // ===== ADMIN ROUTE =====
  if (window.location.pathname === "/admin") return <Admin />;

  const { route, go } = useRoute();

  const [me, setMe] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authTab, setAuthTab] = useState("login"); // login | register

  const [toast, setToast] = useState("");

  // theme/lang (optional, keep simple)
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const loadMe = async () => {
    try {
      const token = getToken();
      if (!token) {
        setMe(null);
        return;
      }
      const data = await api("/auth/me");
      setMe(data);
    } catch {
      setToken("");
      setMe(null);
    }
  };

  useEffect(() => {
    (async () => {
      await loadMe();
      setAuthLoading(false);
    })();
  }, []);

  // ===== VEHICLE FILTERS =====
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");

  const [model, setModel] = useState("");
  const [modelOther, setModelOther] = useState("");

  const [engine, setEngine] = useState("");
  const [engineOther, setEngineOther] = useState("");

  const [trim, setTrim] = useState("");
  const [trimOther, setTrimOther] = useState("");

  const modelValue = model === OTHER ? modelOther : model;
  const engineValue = engine === OTHER ? engineOther : engine;
  const trimValue = trim === OTHER ? trimOther : trim;

  // ===== SEARCH MODE =====
  const [mode, setMode] = useState("vehicle"); // vehicle | vin | plate

  // VIN
  const [vin, setVin] = useState("");
  const [vinLoaded, setVinLoaded] = useState("");
  const [vinLoading, setVinLoading] = useState(false);
  const [vinError, setVinError] = useState("");

  // Plate (pending)
  const [plate, setPlate] = useState("");
  const [plateState, setPlateState] = useState("FL");

  // Quick search
  const [q, setQ] = useState("");

  // Checkout / Shipping
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("Zelle"); 
// "Zelle" | "Card"

  const [shippingOptions, setShippingOptions] = useState([]);
  const [shippingChoice, setShippingChoice] = useState("");
  const [shippingLoading, setShippingLoading] = useState(false);

  // Cart
  const [cart, setCart] = useState(() => {
    try {
      const saved = localStorage.getItem("cart");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { localStorage.setItem("cart", JSON.stringify(cart)); } catch {}
  }, [cart]);

  // Demo vehicle tables (replace later)
  const vehicles = useMemo(
    () => ({
      Toyota: { Corolla: ["1.8L", "2.0L"], Camry: ["2.5L", "3.5L"], RAV4: ["2.5L"] },
      Honda: { Fit: ["1.5L"], Civic: ["1.5T", "2.0L"], Accord: ["1.5T", "2.0T"] },
      Ford: { "F-150": ["2.7L", "3.5L", "5.0L"], "F-250": ["6.0L", "6.4L"], Escape: ["1.5L", "2.0L"] },
      Chevrolet: { Silverado: ["4.3L", "5.3L", "6.2L"], Malibu: ["1.5T", "2.0T"], Equinox: ["1.5T"] },
    }),
    []
  );
  const trimsByMakeModel = useMemo(
    () => ({
      Honda: { Civic: ["LX", "EX", "Sport", "Touring"], Accord: ["LX", "Sport", "EX-L"], Fit: ["LX", "Sport", "EX"] },
      Toyota: { Camry: ["LE", "SE", "XSE"], Corolla: ["L", "LE", "XSE"], RAV4: ["LE", "XLE", "Adventure"] },
      Ford: { "F-150": ["XL", "XLT", "Lariat", "Platinum"], Escape: ["S", "SE", "SEL", "Titanium"], "F-250": ["XL", "XLT", "Lariat"] },
      Chevrolet: { Silverado: ["Work Truck", "Custom", "LT", "RST", "High Country"], Malibu: ["LS", "RS", "LT", "Premier"] },
    }),
    []
  );

  const makeCanon = useMemo(() => {
    const inList = canonFromList(make, MAKES_USA);
    const key = Object.keys(vehicles).find((k) => k.toLowerCase() === String(inList).toLowerCase());
    return key || inList;
  }, [make, vehicles]);

  const hasMakeData = !!vehicles[makeCanon];
  const models = makeCanon && hasMakeData ? Object.keys(vehicles[makeCanon] || {}) : [];
  const engines = makeCanon && hasMakeData && modelValue ? (vehicles[makeCanon]?.[modelValue] || []) : [];
  const trims = makeCanon && modelValue ? (trimsByMakeModel?.[makeCanon]?.[modelValue] || []) : [];

  // Products from Admin localStorage only (no demo)
  const [adminProducts, setAdminProducts] = useState([]);
  useEffect(() => {
    const load = () => {
      const saved = localStorage.getItem("products");
      if (!saved) return setAdminProducts([]);

      let raw = [];
      try { raw = JSON.parse(saved); } catch { raw = []; }

      const normalized = (Array.isArray(raw) ? raw : []).map((p) => ({
        id: p.id || Date.now() + Math.random(),
        name: p.name || "",
        price: Number(p.price) || 0,
        stock: p.stock ?? 0,
        image: p.image || "",
        imageUrl: p.imageUrl || "",
        fitsAll: !!p.fitsAll,
        category: p.category || "",
        active: p.active !== false,
        sku: p.sku || "",
        asin: p.asin || "",
        mpn: p.mpn || "",
        brand: p.brand || "",
        fits: Array.isArray(p.fits) ? p.fits : [{ make: p.make || "", model: p.model || "", engine: p.engine || "" }],
      }));

      setAdminProducts(normalized);
    };

    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  const filtered = useMemo(() => {
    const qq = norm(q);
    const wantsVehicle = !!(makeCanon && modelValue && normalizeEngine(engineValue));

    return adminProducts.filter((p) => {
      if (p.active === false) return false;

      const matchesQuick =
        qq.length === 0
          ? true
          : [p.name, p.brand, p.sku, p.mpn, p.asin, p.category].some((v) => norm(v).includes(qq));

      const matchesVehicle = p.fitsAll
        ? true
        : wantsVehicle
        ? (p.fits || []).some((f) => {
            const okMake = makeCanon ? String(f.make || "").toLowerCase() === String(makeCanon).toLowerCase() : true;
            const okModel = modelValue ? String(f.model || "").toLowerCase() === String(modelValue).toLowerCase() : true;
            const okEngine = normalizeEngine(engineValue) ? normalizeEngine(f.engine) === normalizeEngine(engineValue) : true;

            let okYear = true;
            if (year) {
              const y = Number(year);
              const ys = f.yearStart != null ? Number(f.yearStart) : null;
              const ye = f.yearEnd != null ? Number(f.yearEnd) : null;
              if (Number.isFinite(y)) {
                if (Number.isFinite(ys) && y < ys) okYear = false;
                if (Number.isFinite(ye) && y > ye) okYear = false;
              }
            }
            return okMake && okModel && okEngine && okYear;
          })
        : true;

      return matchesQuick && matchesVehicle;
    });
  }, [adminProducts, q, makeCanon, modelValue, engineValue, year]);

  const canShowProducts = useMemo(() => {
    if (norm(q).length > 0) return true;
    if (makeCanon && modelValue && normalizeEngine(engineValue)) return true;
    return false;
  }, [q, makeCanon, modelValue, engineValue]);

  // Cart totals (display only; backend is source of truth)
  const subtotal = useMemo(
    () => cart.reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 1), 0),
    [cart]
  );

  const hasResale = !!String(me?.customer?.resaleTaxNumber || "").trim();
  const taxPreview = hasResale ? 0 : subtotal * 0.07;
  const chosenShip = shippingOptions.find((o) => o.id === shippingChoice);
  const shippingPreview = Number(chosenShip?.amount || 0);
  const totalPreview = subtotal + taxPreview + shippingPreview;

  const addToCart = (p) => {
    setCart((prev) => {
      const found = prev.find((i) => i.id === p.id);
      if (found) return prev.map((i) => (i.id === p.id ? { ...i, qty: (i.qty || 1) + 1 } : i));
      return [...prev, { ...p, qty: 1 }];
    });
    setToast("Added ✅");
    setTimeout(() => setToast(""), 1100);
  };

  const increaseQty = (id) => setCart((prev) => prev.map((i) => (i.id === id ? { ...i, qty: i.qty + 1 } : i)));
  const decreaseQty = (id) =>
    setCart((prev) => prev.map((i) => (i.id === id ? { ...i, qty: i.qty - 1 } : i)).filter((i) => i.qty > 0));
  const removeFromCart = (id) => setCart((prev) => prev.filter((i) => i.id !== id));

  const clearVehicle = () => {
    setYear("");
    setMake("");
    setModel("");
    setModelOther("");
    setEngine("");
    setEngineOther("");
    setTrim("");
    setTrimOther("");
    setVinLoaded("");
  };

  const lookupVin = async () => {
    const v = String(vin || "").trim().toUpperCase();
    setVin(v);

    if (v.length !== 17) {
      setVinError("VIN must be 17 characters.");
      return;
    }

    setVinLoading(true);
    setVinError("");

    try {
      const r = await fetch(`${API}/vin/${v}`);
      const data = await r.json();

      if (data?.error) {
        setVinError(String(data.error));
        return;
      }

      const m = canonFromList(data.make || "", MAKES_USA);

      setYear(data.year || "");
      setMake(m || "");

      const decodedModel = String(data.model || "").trim();
      if (decodedModel) {
        setModel(decodedModel);
        setModelOther("");
      } else {
        setModel(OTHER);
        setModelOther("");
      }

      const decodedTrim = String(data.trim || "").trim();
      if (decodedTrim) {
        setTrim(decodedTrim);
        setTrimOther("");
      } else {
        setTrim("");
        setTrimOther("");
      }

      const rawEngine = String(data.engine || "").trim();
      const invalidEngine = !rawEngine || ["N/A", "NA", "UNKNOWN", "NONE"].includes(rawEngine.toUpperCase());
      if (invalidEngine) {
        setEngine(OTHER);
        setEngineOther("");
      } else {
        setEngine(normalizeEngine(rawEngine));
        setEngineOther("");
      }

      setVinLoaded(v);
      setMode("vehicle");

      setToast(invalidEngine ? "VIN missing engine → type it ✅" : "VIN decoded ✅");
      setTimeout(() => setToast(""), 1400);
    } catch {
      setVinError("VIN lookup failed.");
    } finally {
      setVinLoading(false);
    }
  };

  const loadShipping = async () => {
    setShippingLoading(true);
    try {
      const data = await api("/shipping/quote", {
        method: "POST",
        body: {
          items: cart.map((i) => ({
            id: i.id,
            qty: i.qty,
            weightLb: i.weightLb || 1,
          })),
        },
      });
      const opts = data.options || [];
      setShippingOptions(opts);
      setShippingChoice(opts[0]?.id || "");
    } catch (e) {
      alert(e.message || "Shipping quote failed");
    } finally {
      setShippingLoading(false);
    }
  };

  const openCheckout = async () => {
    if (!cart.length) return;

    const c = me?.customer || {};
    // require complete address
    const ok =
      c.firstName && c.lastName && c.phone && c.email &&
      c.street && c.city && c.state && c.zip;

    if (!ok) {
      alert("Complete your profile (name, phone, street, city, state, zip) in My Account.");
      go("/account");
      return;
    }

    setCheckoutOpen(true);
    await loadShipping();
  };

  const placeOrder = async () => {
    if (!cart.length) return;
    if (!shippingChoice) {
      alert("Select a shipping option.");
      return;
    }

    const vehicleLabel = `${year || "—"} / ${makeCanon || "—"} / ${modelValue || "—"} / ${engineValue || "—"} / ${trimValue || "—"}`;

    try {
      const created = await api("/orders", {
        method: "POST",
        body: {
          paymentMethod: "Zelle",
          selectedShippingId: shippingChoice,
          vehicle: {
            label: vehicleLabel,
            vin: vinLoaded || "",
            year: year || "",
            make: makeCanon || "",
            model: modelValue || "",
            engine: engineValue || "",
            trim: trimValue || "",
          },
          items: cart.map((i) => ({
            id: i.id,
            name: i.name,
            sku: i.sku || "",
            mpn: i.mpn || "",
            brand: i.brand || "",
            price: Number(i.price || 0),
            qty: Number(i.qty || 1),
            weightLb: i.weightLb || 1,
          })),
        },
      });

      const items = JSON.parse(created.itemsJson || "[]");
      const snap = JSON.parse(created.customerSnapshot || "{}");

      const sub = Number(created.subtotal ?? subtotal);
      const tx = Number(created.tax ?? 0);
      const sh = Number(created.shipping ?? 0);
      const gt = Number(created.grandTotal ?? (sub + tx + sh));

      const inv = {
        orderId: created.id,
        orderNumber: created.orderNumber || "",
        invoiceId: created.invoiceId,
        createdAt: new Date(created.createdAt).toLocaleString(),

        customerName: snap.firstName ? `${snap.firstName} ${snap.lastName || ""}`.trim() : "-",
        businessName: snap.businessName || "",
        phone: snap.phone || "",
        email: snap.email || "",
        address: buildCustomerAddress(snap) || snap.address || "",
        resaleTaxNumber: String(snap.resaleTaxNumber || "").trim(),

        vehicleLabel: created.vehicleLabel || vehicleLabel,
        vin: created.vin || vinLoaded || "",

        shippingCarrier: created.shippingCarrier || chosenShip?.carrier || "",
        shippingService: created.shippingService || chosenShip?.service || "",
        shippingEta: created.shippingEta || chosenShip?.eta || "",

        items,
        subtotal: sub,
        tax: tx,
        shipping: sh,
        grandTotal: gt,

        paymentMethod: created.paymentMethod || "Zelle",
        paymentStatus: created.paymentStatus || "Paid",
      };

      inv.shareText = buildShareText(inv);
      openInvoiceWindow(inv);

      setCart([]);
      setCheckoutOpen(false);
      setToast("Order created ✅");
      setTimeout(() => setToast(""), 1400);
    } catch (e) {
      alert(e.message || "Checkout failed");
    }
  };

  // ROUTES
  if (authLoading) return <div className="container"><div className="card">Loading…</div></div>;
  if (route === "/account") return <AccountPage me={me} setMe={setMe} onBack={() => go("/")} />;

  // 🔐 AUTH GATE
  if (!me) {
    return (
      <div className="container">
        <div className="card" style={{ maxWidth: 720, margin: "20px auto" }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <img src={logo} alt="DDA Auto Parts" style={{ width: 56, height: 56, borderRadius: 12, objectFit: "contain" }} />
            <div>
              <h2 style={{ margin: 0 }}>DDA Auto Parts</h2>
              <div style={{ color: "var(--muted)", marginTop: 4, fontSize: 13 }}>
                Login required to access the store.
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
              <span className="badge">Theme</span>
              <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? "🌙" : "☀️"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className={"btn " + (authTab === "login" ? "btnPrimary" : "")} onClick={() => setAuthTab("login")}>
              Login
            </button>
            <button className={"btn " + (authTab === "register" ? "btnPrimary" : "")} onClick={() => setAuthTab("register")}>
              Register
            </button>
          </div>
        </div>

        {authTab === "login" ? (
          <Login onLogged={async () => { await loadMe(); go("/"); }} />
        ) : (
          <Register onRegistered={async () => { await loadMe(); go("/"); }} />
        )}
      </div>
    );
  }

  // ===== STORE UI =====
  return (
    <div className="container">
      {toast && <div className="toast">{toast}</div>}

      {/* TOPBAR */}
      <div className="topbar">
        <div className="brand" style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <img
            src={logo}
            alt="DDA Auto Parts"
            style={{
              width: 64,
              height: 64,
              objectFit: "contain",
              borderRadius: 12,
              background: "rgba(255,255,255,.06)",
              border: "1px solid rgba(255,255,255,.10)",
            }}
          />
          <div>
            <h1 style={{ margin: 0 }}>DDA Auto Parts</h1>
            <div className="sub">Shipping only • UPS / USPS / FedEx</div>
          </div>
        </div>

        <div className="pills">
          <button className="btn" onClick={() => go("/account")}>My Account</button>
          <button className="btn" onClick={() => { setToken(""); setMe(null); go("/"); }}>
            Logout
          </button>

          <span className="badge">Theme</span>
          <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
        </div>
      </div>

      {/* QUICK SEARCH */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="sectionTitle">Quick search</h2>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by Part Number, SKU, Brand or Name"
        />
      </div>

      {/* GRID */}
      <div className="grid">
        {/* LEFT */}
        <div className="card" style={{ overflow: "visible" }}>
          <h2 className="sectionTitle">Search by vehicle</h2>

          {/* MODE BUTTONS */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <span className="badge">Mode:</span>

            <button className={"btn " + (mode === "vehicle" ? "btnPrimary" : "")} onClick={() => setMode("vehicle")}>
              Vehicle
            </button>

            <button className={"btn " + (mode === "vin" ? "btnPrimary" : "")} onClick={() => setMode("vin")}>
              VIN
            </button>

            <button className={"btn " + (mode === "plate" ? "btnPrimary" : "")} onClick={() => setMode("plate")}>
              Plate
            </button>
          </div>

          {/* VIN MODE */}
          {mode === "vin" && (
            <div style={{ marginTop: 8 }}>
              <div className="badge" style={{ marginBottom: 10 }}>VIN</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input
                  className="input"
                  value={vin}
                  onChange={(e) => setVin(e.target.value.toUpperCase())}
                  placeholder="Enter VIN (17 characters)"
                  maxLength={17}
                />

                <button
                  className={"btn " + (!vinLoading ? "btnPrimary" : "")}
                  onClick={lookupVin}
                  disabled={vinLoading}
                >
                  {vinLoading ? "Loading..." : "Decode VIN"}
                </button>

                {vinError ? <div style={{ color: "#ff9a9a", fontWeight: 800 }}>{vinError}</div> : null}
              </div>
            </div>
          )}

          {/* PLATE MODE (PENDING) */}
          {mode === "plate" && (
            <div style={{ marginTop: 8 }}>
              <div className="badge" style={{ marginBottom: 10 }}>Plate</div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                <input
                  className="input"
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder="Enter plate"
                />
                <select className="select" value={plateState} onChange={(e) => setPlateState(e.target.value)}>
                  {US_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                </select>

                <div className="badge" style={{ gridColumn: "1 / -1" }}>
                  Pending: plate lookup coming soon.
                </div>
              </div>
            </div>
          )}

          {/* VEHICLE MODE */}
          {mode === "vehicle" && (
            <>
              {vinLoaded ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                  <span className="badge">
                    <strong>VIN:</strong>&nbsp;{vinLoaded.slice(0, 3)}…{vinLoaded.slice(-4)}
                  </span>
                  <button className="btn" onClick={() => setMode("vin")}>Change VIN</button>
                </div>
              ) : null}

              <div className="filters" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
                <select className="select" value={year} onChange={(e) => setYear(e.target.value)}>
                  <option value="">Year</option>
                  {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>

                <select
                  className="select"
                  value={makeCanon}
                  onChange={(e) => {
                    setMake(e.target.value);
                    setModel("");
                    setModelOther("");
                    setEngine("");
                    setEngineOther("");
                    setTrim("");
                    setTrimOther("");
                    setVinLoaded("");
                  }}
                >
                  <option value="">Make</option>
                  {MAKES_USA.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>

                <select
                  className="select"
                  value={model}
                  disabled={!makeCanon}
                  onChange={(e) => {
                    const v = e.target.value;
                    setModel(v);
                    if (v !== OTHER) setModelOther("");
                  }}
                >
                  <option value="">Model</option>
                  {(models || []).map((mo) => <option key={mo} value={mo}>{mo}</option>)}
                  <option value={OTHER}>Other (type)</option>
                </select>

                <select
                  className="select"
                  value={engine}
                  disabled={!modelValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEngine(v);
                    if (v !== OTHER) setEngineOther("");
                  }}
                >
                  <option value="">Engine</option>
                  {(engines || []).map((en) => <option key={en} value={en}>{en}</option>)}
                  <option value={OTHER}>Other (type)</option>
                </select>

                <select
                  className="select"
                  value={trim}
                  disabled={!modelValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTrim(v);
                    if (v !== OTHER) setTrimOther("");
                  }}
                >
                  <option value="">Trim (optional)</option>
                  {(trims || []).map((tr) => <option key={tr} value={tr}>{tr}</option>)}
                  <option value={OTHER}>Other (type)</option>
                </select>

                <button className="btn" onClick={clearVehicle}>Clear</button>
              </div>

              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                {model === OTHER && (
                  <input className="input" value={modelOther} onChange={(e) => setModelOther(e.target.value)} placeholder="Type model" />
                )}
                {engine === OTHER && (
                  <input
                    className="input"
                    value={engineOther}
                    onChange={(e) => setEngineOther(e.target.value)}
                    onBlur={() => setEngineOther((prev) => normalizeEngine(prev))}
                    placeholder='Type engine (e.g. "5.3L")'
                  />
                )}
                {trim === OTHER && (
                  <input className="input" value={trimOther} onChange={(e) => setTrimOther(e.target.value)} placeholder="Type trim" />
                )}
              </div>

              <div style={{ marginTop: 10 }}>
                <span className="badge">
                  <strong>Selected:</strong>&nbsp;
                  {year || "—"} / {makeCanon || "—"} / {modelValue || "—"} / {engineValue || "—"} / {trimValue || "—"}
                </span>
              </div>

              <hr className="hr" />
            </>
          )}
        </div>

        {/* RIGHT: CART */}
        <div className="card">
          <h2 className="sectionTitle">Cart</h2>

          {cart.length === 0 ? (
            <>
              <p style={{ color: "var(--muted)" }}>Cart is empty</p>
              <hr className="hr" />
              <div style={{ fontWeight: 900, fontSize: 18 }}>Total: ${money(0)}</div>
            </>
          ) : (
            <>
              {cart.map((p) => (
                <div key={p.id} style={{ marginBottom: 10 }}>
                  <strong>{p.name}</strong>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <button className="btn" onClick={() => decreaseQty(p.id)}>−</button>
                    <span>{p.qty}</span>
                    <button className="btn" onClick={() => increaseQty(p.id)}>+</button>

                    <span style={{ marginLeft: "auto" }}>
                      ${money(Number(p.price) * (p.qty || 1))}
                    </span>

                    <button className="btn" onClick={() => removeFromCart(p.id)} title="Remove">✕</button>
                  </div>
                </div>
              ))}

              <hr className="hr" />

              <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 700 }}>Subtotal</span>
                  <span style={{ fontWeight: 900 }}>${money(subtotal)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 700 }}>Tax</span>
                  <span style={{ fontWeight: 900 }}>${money(taxPreview)}</span>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  {hasResale ? "Tax exempt (Resale Tax Number on file)" : "Tax rate: 7%"}
                </div>
              </div>

              <button className="btn btnPrimary" onClick={openCheckout}>
                Checkout
              </button>
            </>
          )}
        </div>
      </div>

      {/* PRODUCTS */}
      <div style={{ marginTop: 16 }}>
        <h2 className="sectionTitle">Products</h2>

        <div className="badge" style={{ marginBottom: 12 }}>
          Results: <strong>{canShowProducts ? filtered.length : 0}</strong>
        </div>

        {adminProducts.length === 0 ? (
          <div className="card" style={{ color: "var(--muted)" }}>
            No products yet. Go to <strong>/admin</strong> and add products.
          </div>
        ) : !canShowProducts ? (
          <div className="card" style={{ color: "var(--muted)" }}>
            Use quick search or select Make/Model/Engine.
          </div>
        ) : filtered.length === 0 ? (
          <div className="card" style={{ color: "var(--muted)" }}>
            No results found.
          </div>
        ) : (
          <div className="products">
            {filtered.map((p) => (
              <div key={p.id} className="productCard">
                <div className="productTop">
                  <div className="productImg">
                    {p.image || p.imageUrl ? (
                      <img
                        src={p.image || p.imageUrl}
                        alt={p.name}
                        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 14 }}
                      />
                    ) : (
                      (p.name || "P").slice(0, 2).toUpperCase()
                    )}
                  </div>

                  <div className="productMeta">
                    <h3 className="productName">{p.name}</h3>

                    <div className="productPriceRow">
                      <div className="productPrice">${Number(p.price) || 0}</div>
                      <div className="productCurrency">USD</div>
                    </div>

                    <div className="chips" style={{ marginTop: 8 }}>
                      {p.mpn ? <span className="chip">Part: {p.mpn}</span> : null}
                      {p.sku ? <span className="chip">SKU: {p.sku}</span> : null}
                      {p.brand ? <span className="chip">Brand: {p.brand}</span> : null}
                    </div>
                  </div>
                </div>

                <div className="productActions">
                  <span className="badge">{p.fitsAll ? "Universal" : "Vehicle specific"}</span>
                  <button className="btn btnPrimary" onClick={() => addToCart(p)}>
                    Add to cart
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CHECKOUT MODAL */}
      {checkoutOpen && (
        <div className="modalBackdrop" onClick={() => setCheckoutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Checkout</h2>
              <button className="btn" onClick={() => setCheckoutOpen(false)}>✕</button>
            </div>

            <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 13 }}>
              ETA depends on the provider.
            </div>

            <hr className="hr" />
<div className="badge" style={{ marginBottom: 10 }}>Payment method</div>

<div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
  <label className="card" style={{ padding: 12, cursor: "pointer" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input
        type="radio"
        checked={paymentMethod === "Card"}
        onChange={() => setPaymentMethod("Card")}
      />
      <div>
        <div style={{ fontWeight: 900 }}>Credit / Debit Card</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Pay securely with card (Stripe coming soon)
        </div>
      </div>
    </div>
  </label>

  <label className="card" style={{ padding: 12, cursor: "pointer" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input
        type="radio"
        checked={paymentMethod === "Zelle"}
        onChange={() => setPaymentMethod("Zelle")}
      />
      <div>
        <div style={{ fontWeight: 900 }}>Zelle</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Zelle transfer (manual confirmation)
        </div>
      </div>
    </div>
  </label>
</div>

<hr className="hr" />

            <div className="badge" style={{ marginBottom: 10 }}>Shipping options</div>

            {shippingLoading ? (
              <div className="badge">Loading shipping…</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {(shippingOptions || []).map((op) => (
                  <label key={op.id} className="card" style={{ padding: 12, cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <input
                          type="radio"
                          checked={shippingChoice === op.id}
                          onChange={() => setShippingChoice(op.id)}
                        />
                        <div>
                          <div style={{ fontWeight: 900 }}>
                            {op.carrier} — {op.service}
                          </div>
                          <div style={{ color: "var(--muted)", fontSize: 13 }}>
                            ETA: {op.eta || "Provider estimate"}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontWeight: 900 }}>${money(op.amount)}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <hr className="hr" />

            <div className="badge" style={{ marginBottom: 10 }}>Summary</div>

            <div style={{ display: "grid", gap: 8 }}>
              {cart.map((i) => (
                <div key={i.id} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{i.name} × {i.qty || 1}</span>
                  <span>${money(Number(i.price || 0) * Number(i.qty || 1))}</span>
                </div>
              ))}

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                <span style={{ fontWeight: 700 }}>Subtotal</span>
                <span style={{ fontWeight: 900 }}>${money(subtotal)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700 }}>Tax</span>
                <span style={{ fontWeight: 900 }}>${money(taxPreview)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700 }}>Shipping</span>
                <span style={{ fontWeight: 900 }}>${money(shippingPreview)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontWeight: 900, fontSize: 18 }}>
                <span>Total</span>
                <span>${money(totalPreview)}</span>
              </div>

              {hasResale ? (
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Tax exempt (Resale Tax Number on file).
                </div>
              ) : (
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  Tax rate: 7%.
                </div>
              )}
            </div>

            <div className="modalFooter">
              <button className="btn btnPrimary" onClick={placeOrder} disabled={!shippingChoice || shippingLoading}>
                Place order
              </button>
              <button className="btn" onClick={() => setCheckoutOpen(false)}>
                Cancel
              </button>
            </div>

            <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
              After placing the order, the invoice opens for print/copy/send.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}








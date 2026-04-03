import { useState } from "react";

export default function Register({ onRegistered }) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    businessName: "",
    email: "",
    password: "",
    phone: "",
    street: "",
    apt: "",
    city: "",
    state: "",
    zip: "",
    resaleTaxNumber: "",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setError("");

    // Validación obligatoria
    if (
      !form.firstName ||
      !form.lastName ||
      !form.email ||
      !form.password ||
      !form.phone ||
      !form.street ||
      !form.city ||
      !form.state ||
      !form.zip
    ) {
      setError("Please fill all required fields.");
      return;
    }

    try {
      setLoading(true);
      const r = await fetch("http://localhost:5177/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Register failed");

      // guardar token
      localStorage.setItem("token", data.token);

      onRegistered?.(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 520, margin: "40px auto" }}>
      <h2>Create Account</h2>

      {error && <div style={{ color: "red", marginBottom: 10 }}>{error}</div>}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <input className="input" placeholder="First Name *" onChange={(e) => set("firstName", e.target.value)} />
        <input className="input" placeholder="Last Name *" onChange={(e) => set("lastName", e.target.value)} />
      </div>

      <input
        className="input"
        placeholder="Business Name (optional)"
        onChange={(e) => set("businessName", e.target.value)}
      />

      <input className="input" placeholder="Email *" onChange={(e) => set("email", e.target.value)} />
      <input
        className="input"
        type="password"
        placeholder="Password *"
        onChange={(e) => set("password", e.target.value)}
      />

      <input className="input" placeholder="Phone *" onChange={(e) => set("phone", e.target.value)} />

      <input className="input" placeholder="Street Address *" onChange={(e) => set("street", e.target.value)} />
      <input className="input" placeholder="Apt / Suite" onChange={(e) => set("apt", e.target.value)} />

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
        <input className="input" placeholder="City *" onChange={(e) => set("city", e.target.value)} />
        <input className="input" placeholder="State *" onChange={(e) => set("state", e.target.value)} />
        <input className="input" placeholder="ZIP *" onChange={(e) => set("zip", e.target.value)} />
      </div>

      <input
        className="input"
        placeholder="Resale Tax Number (optional)"
        onChange={(e) => set("resaleTaxNumber", e.target.value)}
      />

      <button className="btn btnPrimary" onClick={submit} disabled={loading}>
        {loading ? "Creating..." : "Create Account"}
      </button>
    </div>
  );
}

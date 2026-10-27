import React, { useEffect, useState } from "react";

const blank = { name: "", lengthIn: "", widthIn: "", heightIn: "", emptyWeightOz: "", weightSource: "unknown", active: true };

export default function AdminShippingBoxes({ api }) {
  const [boxes, setBoxes] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const request = async (path = "", options = {}) => {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${api}/admin/shipping-boxes${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
  const load = async () => {
    try { setError(""); setBoxes((await request()).boxes || []); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [api]);
  const edit = (box) => {
    setEditing(box.id);
    setForm({ ...box, emptyWeightOz: box.emptyWeightOz ?? "" });
    setError("");
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = {
        ...form,
        lengthIn: Number(form.lengthIn),
        widthIn: Number(form.widthIn),
        heightIn: Number(form.heightIn),
        emptyWeightOz: form.emptyWeightOz === "" ? null : Number(form.emptyWeightOz),
      };
      await request(editing ? `/${encodeURIComponent(editing)}` : "", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      setForm(blank);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const remove = async (box) => {
    if (!window.confirm(`Delete ${box.name}?`)) return;
    try { setError(""); await request(`/${encodeURIComponent(box.id)}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e.message); }
  };
  const toggle = async (box) => {
    try {
      setError("");
      await request(`/${encodeURIComponent(box.id)}`, {
        method: "PUT",
        body: JSON.stringify({ active: !box.active }),
      });
      await load();
    } catch (e) { setError(e.message); }
  };

  return <div className="card" style={{ marginTop: 16 }}>
    <h2>Shipping Boxes</h2>
    <p>Box dimensions are in inches. Empty box weight is in ounces. Unknown weights remain unverified.</p>
    {error && <p role="alert" style={{ color: "#dc2626" }}>{error}</p>}
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", textAlign: "left" }}>
        <thead><tr><th>Box</th><th>Dimensions (in)</th><th>Empty weight</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{boxes.map(box => <tr key={box.id}>
          <td>{box.name}</td>
          <td>{box.lengthIn} × {box.widthIn} × {box.heightIn}</td>
          <td>{box.emptyWeightOz == null ? "Unknown" : `${box.emptyWeightOz} oz (${box.weightSource})`}</td>
          <td>{box.active ? "Active" : "Inactive"}</td>
          <td>
            <button className="btn" type="button" onClick={() => edit(box)}>Edit</button>{" "}
            <button className="btn" type="button" onClick={() => toggle(box)}>{box.active ? "Disable" : "Enable"}</button>{" "}
            <button className="btn" type="button" onClick={() => remove(box)}>Delete</button>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    <h3>{editing ? "Edit box" : "Add box"}</h3>
    <form onSubmit={save} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
      {["name", "lengthIn", "widthIn", "heightIn", "emptyWeightOz"].map(key => <label key={key} style={{ display: "grid", gap: 4 }}>
        {({ name: "Name", lengthIn: "Length (in)", widthIn: "Width (in)", heightIn: "Height (in)", emptyWeightOz: "Empty weight (oz, optional)" })[key]}
        <input className="input" type={key === "name" ? "text" : "number"} min={key === "emptyWeightOz" ? "0" : "0.01"} step="any"
          required={key !== "emptyWeightOz"} value={form[key]}
          onChange={e => setForm({ ...form, [key]: e.target.value })} />
      </label>)}
      <label>Weight source <select className="select" value={form.weightSource}
        onChange={e => setForm({ ...form, weightSource: e.target.value })}>
        <option value="unknown">Unknown</option>
        <option value="estimated">Estimated</option>
        <option value="measured">Measured</option>
      </select></label>
      <button className="btn btnPrimary" disabled={busy} type="submit">{busy ? "Saving..." : editing ? "Save changes" : "Add box"}</button>
      {editing && <button className="btn" type="button" onClick={() => { setEditing(null); setForm(blank); }}>Cancel</button>}
    </form>
  </div>;
}

import React, { useState } from "react";

// All actions are deliberately one-at-a-time: a financial decision must never
// be chained to a preview or silently retried after an uncertain response.
export default function AdminCancellationSettlement({ order, api, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const id = order?.id;
  const status = String(order?.status || "").toUpperCase();
  const paymentMethod = String(order?.paymentMethod || "").toLowerCase();
  const zelle = paymentMethod === "zelle";
  const money = cents => "$" + (Number(cents) / 100).toFixed(2);
  async function request(path, method = "GET", body, warning) {
    if (busy) return;
    if (warning && !window.confirm(warning + "\n\nThis action cannot be automatically reversed.")) return;
    setBusy(true); setError("");
    try {
      const token = localStorage.getItem("token");
      const response = await fetch(`${api}/admin/orders/${encodeURIComponent(id)}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}; review before retrying`);
      setResult({ path, data });
      if (method !== "GET") await onChanged?.();
    } catch (e) { setError(e.message || "Action failed; reconcile before retrying"); }
    finally { setBusy(false); }
  }
  function attested(path, method, body, warning) {
    if (!window.confirm("Have you independently verified that the carrier has NOT picked up the parcel?")) return;
    request(path, method, { ...body, carrierNotPickedUpConfirmed: true }, warning);
  }
  function verifiedShippo() {
    const shippoTransactionId = window.prompt("Shippo label transaction ID (from reconciliation):");
    if (!shippoTransactionId) return;
    const amount = window.prompt("Amount ACTUALLY received from Shippo, in USD (e.g. 12.34):");
    if (!amount || !/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(amount)) return setError("Enter a valid USD amount");
    const evidenceReference = window.prompt("Reference proving the funds were received (required):");
    if (!evidenceReference) return;
    request("shippo-refund-verification", "POST", {
      fundsReceivedConfirmed: true, shippoTransactionId: shippoTransactionId.trim(),
      verifiedAmountCents: Math.round(Number(amount) * 100), evidenceReference: evidenceReference.trim()
    }, "Record only money actually received from Shippo.");
  }
  function confirmZelle(path, amountCents, first = false) {
    const amount = window.prompt("Enter the exact USD amount ALREADY SENT by Zelle:");
    if (!amount || !/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(amount)) return;
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) return setError("Invalid refund amount");
    const transferReference = first ? undefined : window.prompt("Actual Zelle transfer reference:");
    if (!first && !transferReference) return;
    request(path, "POST", { refundSentConfirmed: true, amountCents: cents,
      ...(first ? {} : { transferReference: transferReference.trim() }) },
      `Confirm that ${money(cents)} was ALREADY transferred by Zelle. Do not use this button to send money.`);
  }
  function batchAction(stripe) {
    const raw = window.prompt("Existing prepared Shippo batch ID (numeric):");
    if (!raw || !/^[1-9]\\d*$/.test(raw)) return setError("Valid batch ID required");
    const path = `shippo-additional-refund/batches/${raw}/${stripe ? "refund-stripe" : "confirm-zelle"}`;
    if (stripe) request(path, "POST", { confirmRefund: true },
      "Submit a REAL Stripe refund for this prepared batch? Verify its amount and status first.");
    else confirmZelle(path);
  }
  const button = (label, callback) => <button type="button" className="btn" disabled={busy} onClick={callback}>{label}</button>;
  return <div style={{ marginTop: 12, padding: 12, border: "1px solid #cbd5e1", borderRadius: 8 }}>
    <strong>Label cancellation & Shippo refund review</strong>
    <p style={{ fontSize: 12 }}>Admin only. Actions are separate and require verification. Never repeat a payment after an uncertain response.</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {["LABEL_CREATED", "CANCEL_REQUESTED"].includes(status) && <>
        {button("1. Preview label fees", () => request("label-cancellation-preview"))}
        {button("2. Open review", () => attested("label-cancellation-review", "POST", {}, "Create cancellation review?"))}
        {button("3. Approve review", () => attested("label-cancellation-review/decision", "PUT", { decision: "APPROVED" }, "Approve label cancellation review?"))}
        {button("Reject review", () => attested("label-cancellation-review/decision", "PUT", { decision: "REJECTED" }, "Reject this review?"))}
        {button("4. Preview settlement", () => request("label-cancellation-settlement"))}
        {button("5. Prepare settlement", () => request("label-cancellation-settlement/prepare", "POST", { confirmPrepare: true }, "Prepare the settlement? No funds move."))}
        {button("6. Cancel order", () => attested("label-cancellation-settlement/cancel-order", "POST", { confirmCancellation: true }, "FINAL: cancel the order and restore eligible inventory? Refund is NOT sent yet."))}
      </>}
      {status === "CANCELLED" && <>
        {zelle ? button("Confirm initial Zelle refund", () => confirmZelle("label-cancellation-settlement/confirm-zelle-refund", null, true))
          : button("Issue initial Stripe refund", () => request("label-cancellation-settlement/refund-stripe", "POST", { confirmRefund: true }, "This submits a REAL Stripe refund. Verify settlement first."))}
        {button("View Shippo reconciliation", () => request("shippo-refund-reconciliation"))}
        {button("Record received Shippo funds", verifiedShippo)}
        {button("Prepare first additional refund", () => request("shippo-additional-refund/prepare", "POST", { confirmPrepare: true }, "Prepare refund of verified Shippo funds?"))}
        {zelle ? button("Confirm first additional Zelle", () => confirmZelle("shippo-additional-refund/confirm-zelle"))
          : button("Issue first additional Stripe", () => request("shippo-additional-refund/refund-stripe", "POST", { confirmRefund: true }, "This submits a REAL additional Stripe refund."))}
        {button("Prepare next Shippo batch", () => request("shippo-additional-refund/prepare-next-batch", "POST", { confirmPrepare: true }, "Prepare next batch of verified Shippo funds?"))}
        {zelle ? button("Confirm later Zelle batch", () => batchAction(false))
          : button("Issue later Stripe batch", () => batchAction(true))}
      </>}
    </div>
    {status === "CANCELLED" && <p style={{ fontSize: 12 }}>Later refund batches require their batch ID and separate confirmation; do not assume Shippo's status means money was received.</p>}
    {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
    {result && <div style={{ marginTop: 8, maxHeight: 250, overflow: "auto", fontSize: 12 }}>
      <strong>Last response: {result.path}</strong><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result.data, null, 2)}</pre>
    </div>}
  </div>;
}

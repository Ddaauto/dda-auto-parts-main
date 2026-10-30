// Pure multi-package shipment rules. No network calls or database writes.
export function shipmentProgress(items, labels) {
  const required = new Map();
  if (!Array.isArray(items) || !items.length || !Array.isArray(labels)) return { complete: false, pickedUp: 0, delivered: 0, status: "NOT_LABELED" };
  for (const item of items) {
    const key = String(item.id || item.sku || "");
    const qty = Number(item.qty || item.quantity || 1);
    if (!key || !Number.isSafeInteger(qty) || qty < 1) return { complete: false, pickedUp: 0, delivered: 0, status: "UNVERIFIED" };
    required.set(key, (required.get(key) || 0) + qty);
  }
  const allocated = new Map();
  let valid = true;
  for (const label of labels) {
    let parts;
    try { parts = typeof label.packageItemsJson === "string" ? JSON.parse(label.packageItemsJson) : label.packageItemsJson; } catch { valid = false; break; }
    if (!Array.isArray(parts) || !parts.length) { valid = false; break; }
    for (const part of parts) {
      const key = String(part.key || "");
      const qty = Number(part.qty);
      if (!required.has(key) || !Number.isSafeInteger(qty) || qty < 1) { valid = false; break; }
      allocated.set(key, (allocated.get(key) || 0) + qty);
    }
    if (!valid) break;
  }
  const complete = valid && labels.length > 0 && [...required].every(([key, qty]) => allocated.get(key) === qty);
  const accepted = new Set(["TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "FAILURE"]);
  const pickedUp = labels.filter(l => accepted.has(l.carrierTrackingStatus)).length;
  const delivered = labels.filter(l => l.carrierTrackingStatus === "DELIVERED").length;
  const status = !labels.length ? "NOT_LABELED"
    : complete && delivered === labels.length ? "DELIVERED"
    : complete && pickedUp === labels.length ? "SHIPPED"
    : pickedUp > 0 ? "PARTIALLY_SHIPPED" : "LABEL_CREATED";
  return { complete, pickedUp, delivered, status };
}

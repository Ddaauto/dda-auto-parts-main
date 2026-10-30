import test from "node:test";
import assert from "node:assert/strict";
import { shipmentProgress } from "../services/shipmentProgress.js";
const items = [{ id: "a", qty: 2 }, { id: "b", qty: 1 }];
const label = (parts, status = "PRE_TRANSIT") => ({ packageItemsJson: JSON.stringify(parts), carrierTrackingStatus: status });
test("unlabeled orders are not shipped", () => {
  assert.equal(shipmentProgress(items, []).status, "NOT_LABELED");
});
test("first of multiple packages picked up is only partially shipped", () => {
  const p = shipmentProgress(items, [label([{ key: "a", qty: 1 }], "TRANSIT")]);
  assert.equal(p.complete, false);
  assert.equal(p.status, "PARTIALLY_SHIPPED");
});
test("all quantities allocated and all picked up means shipped", () => {
  const p = shipmentProgress(items, [label([{ key: "a", qty: 2 }], "TRANSIT"), label([{ key: "b", qty: 1 }], "TRANSIT")]);
  assert.equal(p.complete, true);
  assert.equal(p.status, "SHIPPED");
});
test("all packages delivered means delivered", () => {
  const p = shipmentProgress(items, [label([{ key: "a", qty: 2 }], "DELIVERED"), label([{ key: "b", qty: 1 }], "DELIVERED")]);
  assert.equal(p.status, "DELIVERED");
});
test("one label still in pre-transit cannot mark entire order shipped", () => {
  const p = shipmentProgress(items, [label([{ key: "a", qty: 2 }], "TRANSIT"), label([{ key: "b", qty: 1 }])]);
  assert.equal(p.status, "PARTIALLY_SHIPPED");
});
test("duplicate allocations cannot count as complete", () => {
  const p = shipmentProgress(items, [label([{ key: "a", qty: 2 }], "DELIVERED"), label([{ key: "a", qty: 2 }], "DELIVERED")]);
  assert.equal(p.complete, false);
  assert.notEqual(p.status, "DELIVERED");
});
test("legacy or malformed allocations require review", () => {
  assert.equal(shipmentProgress(items, [{ packageItemsJson: "{broken", carrierTrackingStatus: "DELIVERED" }]).complete, false);
  assert.equal(shipmentProgress(items, [{ packageItemsJson: "[]", carrierTrackingStatus: "DELIVERED" }]).complete, false);
});
test("unknown products and negative quantities never complete", () => {
  assert.equal(shipmentProgress(items, [label([{ key: "unknown", qty: 3 }], "DELIVERED")]).complete, false);
  assert.equal(shipmentProgress(items, [label([{ key: "a", qty: -2 }], "DELIVERED")]).complete, false);
});

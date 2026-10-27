import test from "node:test";
import assert from "node:assert/strict";
import { federalHolidays, isBusinessDay, plannedShipDate } from "../shippingCalendar.js";

test("weekday before cutoff reserves one preparation day", () => {
  assert.equal(plannedShipDate("2026-10-26T13:00:00-04:00"), "2026-10-27");
});
test("weekday after 2 PM begins preparation next business day", () => {
  assert.equal(plannedShipDate("2026-10-26T14:00:00-04:00"), "2026-10-28");
});
test("Friday before and after cutoff", () => {
  assert.equal(plannedShipDate("2026-10-23T13:59:00-04:00"), "2026-10-26");
  assert.equal(plannedShipDate("2026-10-23T14:00:00-04:00"), "2026-10-27");
});
test("weekend orders prepare Monday and ship Tuesday", () => {
  assert.equal(plannedShipDate("2026-10-24T11:00:00-04:00"), "2026-10-27");
});
test("federal holiday blocks preparation and dispatch", () => {
  assert.equal(plannedShipDate("2026-11-25T13:00:00-05:00"), "2026-11-27");
  assert.equal(plannedShipDate("2026-11-26T11:00:00-05:00"), "2026-11-30");
});
test("observed New Year's Day can fall in previous calendar year", () => {
  assert.ok(federalHolidays(2021).has("2021-12-31"));
  assert.equal(isBusinessDay(new Date("2021-12-31T12:00:00Z")), false);
});
test("Miami daylight saving offset is respected", () => {
  assert.equal(plannedShipDate("2026-07-06T17:59:00Z"), "2026-07-07");
  assert.equal(plannedShipDate("2026-07-06T18:00:00Z"), "2026-07-08");
});

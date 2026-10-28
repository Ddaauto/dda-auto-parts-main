// DDA Auto Parts: conservative fulfillment dates for customer-facing delivery estimates.
// Dates use America/New_York and exclude weekends and observed US federal holidays.
// Carrier transit days and carrier-specific closures must be applied separately.
const ZONE = "America/New_York";
const pad = n => String(n).padStart(2, "0");
const key = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
const plusDays = (d, n) => new Date(d.getTime() + n * 86400000);
const observed = d => {
  const weekday = d.getUTCDay();
  return weekday === 6 ? plusDays(d, -1) : weekday === 0 ? plusDays(d, 1) : d;
};
const nthWeekday = (y, m, weekday, nth) => {
  const first = day(y, m, 1);
  return day(y, m, 1 + (weekday - first.getUTCDay() + 7) % 7 + 7 * (nth - 1));
};
const lastWeekday = (y, m, weekday) => {
  const last = day(y, m + 1, 0);
  return plusDays(last, -(last.getUTCDay() - weekday + 7) % 7);
};
export function federalHolidays(year) {
  const days = new Set();
  // Include adjacent-year observed dates, e.g. Dec 31 for next year's Jan 1.
  for (const y of [year - 1, year, year + 1]) {
    const fixed = [[1,1],[6,19],[7,4],[11,11],[12,25]];
    for (const [m,d] of fixed) days.add(key(observed(day(y,m,d))));
    for (const d of [
      nthWeekday(y,1,1,3), nthWeekday(y,2,1,3), lastWeekday(y,5,1),
      nthWeekday(y,9,1,1), nthWeekday(y,10,1,2), nthWeekday(y,11,4,4),
    ]) days.add(key(d));
  }
  return days;
}
export function isBusinessDay(d) {
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6 &&
    !federalHolidays(d.getUTCFullYear()).has(key(d));
}
export function nextBusinessDay(d) {
  let candidate = plusDays(d, 1);
  while (!isBusinessDay(candidate)) candidate = plusDays(candidate, 1);
  return candidate;
}
export function plannedShipDate(orderTimestamp = new Date()) {
  const instant = new Date(orderTimestamp);
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid order timestamp");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)])
  );
  const ordered = day(parts.year, parts.month, parts.day);
  // Orders received at or after 2 PM start preparation the next business day.
  // One full business day of preparation is then reserved before dispatch.
  const beforeCutoff = parts.hour < 14;
  const preparationStart = beforeCutoff && isBusinessDay(ordered)
    ? ordered : nextBusinessDay(ordered);
  return key(nextBusinessDay(preparationStart));
}

export function addBusinessDays(dateString, count) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
  if (!match || !Number.isInteger(count) || count < 0) throw new Error("Invalid delivery date or days");
  let date = day(Number(match[1]), Number(match[2]), Number(match[3]));
  for (let i = 0; i < count; i++) date = nextBusinessDay(date);
  return key(date);
}

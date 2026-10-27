// Initial shipping box presets for DDA Auto Parts.
// Dimensions are inches. Empty-box weights are intentionally null until measured.
// Estimated weights must be clearly identified and never presented as verified.
export const INITIAL_SHIPPING_BOXES = [
  [1, 8, 4, 4],
  [2, 10, 6, 4],
  [3, 9, 7, 7],
  [4, 9, 9, 7],
  [5, 10, 8, 8],
  [6, 10, 10, 10],
  [7, 12, 10, 10],
  [8, 6, 6, 6],
  [9, 12, 8, 5],
  [10, 13, 10, 9],
].map(([number, lengthIn, widthIn, heightIn]) => ({
  id: `box-${number}`,
  name: `Box #${number}`,
  lengthIn,
  widthIn,
  heightIn,
  emptyWeightOz: null,
  weightSource: "unknown",
  active: true,
}));

export function validateShippingBox(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid box");
  const dimensions = ["lengthIn", "widthIn", "heightIn"].map((key) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 120) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  });
  const rawWeight = input.emptyWeightOz;
  const emptyWeightOz = rawWeight == null || rawWeight === ""
    ? null
    : Number(rawWeight);
  if (emptyWeightOz !== null && (!Number.isFinite(emptyWeightOz) || emptyWeightOz < 0)) {
    throw new Error("Invalid emptyWeightOz");
  }
  return {
    lengthIn: dimensions[0],
    widthIn: dimensions[1],
    heightIn: dimensions[2],
    emptyWeightOz,
    weightSource: emptyWeightOz === null ? "unknown" : input.weightSource === "estimated" ? "estimated" : "measured",
    active: input.active !== false && input.active !== 0,
  };
}

// For a single item with known dimensions. Complex orders require a packing algorithm.
// Check all 6 orientations so a box can be rotated.
export function fitsBox(item, box) {
  const a = [item.lengthIn, item.widthIn, item.heightIn].map(Number).sort((x, y) => x - y);
  const b = [box.lengthIn, box.widthIn, box.heightIn].map(Number).sort((x, y) => x - y);
  return a.every((n, i) => Number.isFinite(n) && n > 0 && n <= b[i]);
}

export function recommendBoxForSingleItem(item, boxes) {
  if (!item || ![item.lengthIn, item.widthIn, item.heightIn].every((v) => Number(v) > 0)) return null;
  return boxes.filter((box) => box.active && fitsBox(item, box))
    .sort((a, b) => a.lengthIn * a.widthIn * a.heightIn - b.lengthIn * b.widthIn * b.heightIn)[0] || null;
}


// Conservative orthogonal packing: every item occupies a non-overlapping rectangular
// space. A failed result means "not confirmed", not proof that packing is impossible.
// Padding, fragile-item separation and irregular shapes require human confirmation.
export function recommendBoxForItems(items, boxes) {
  if (!Array.isArray(items) || !items.length) return null;
  const pieces = [];
  for (const item of items) {
    const dims = [item.lengthIn, item.widthIn, item.heightIn].map(Number);
    const qty = Number(item.qty);
    if (!dims.every(v => Number.isFinite(v) && v > 0) ||
        !Number.isInteger(qty) || qty < 1 || qty > 50 || pieces.length + qty > 50) return null;
    for (let n = 0; n < qty; n++) pieces.push(dims);
  }
  pieces.sort((a, b) => b[0] * b[1] * b[2] - a[0] * a[1] * a[2]);
  const candidates = (boxes || []).filter(b => b.active)
    .sort((a, b) => a.lengthIn * a.widthIn * a.heightIn - b.lengthIn * b.widthIn * b.heightIn);
  const orientations = (d) => {
    const [x, y, z] = d;
    return [[x,y,z],[x,z,y],[y,x,z],[y,z,x],[z,x,y],[z,y,x]];
  };
  for (const box of candidates) {
    let spaces = [[Number(box.lengthIn), Number(box.widthIn), Number(box.heightIn)]];
    let fits = true;
    for (const piece of pieces) {
      let placed = false;
      for (let i = 0; i < spaces.length && !placed; i++) {
        const [l, w, h] = spaces[i];
        for (const [x, y, z] of orientations(piece)) {
          if (x > l || y > w || z > h) continue;
          spaces.splice(i, 1,
            [l-x, w, h], [x, w-y, h], [x, y, h-z]);
          spaces = spaces.filter(s => s.every(v => v > 0));
          placed = true;
          break;
        }
      }
      if (!placed) { fits = false; break; }
    }
    if (fits) return box;
  }
  return null;
}

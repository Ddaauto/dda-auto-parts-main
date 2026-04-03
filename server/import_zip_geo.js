import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.resolve("./dda.sqlite");
// uszips.csv está en la raíz: C:\Users\darie\tienda-autopartes\uszips.csv
const CSV_PATH = path.resolve(process.cwd(), "../uszips.csv");

function cleanCell(v) {
  return String(v ?? "")
    .replace(/^\uFEFF/, "")          // BOM
    .trim()
    .replace(/^"+|"+$/g, "")         // quita " al inicio/fin
    .replace(/^'+|'+$/g, "");        // quita ' al inicio/fin
}

if (!fs.existsSync(CSV_PATH)) {
  console.error("❌ No existe uszips.csv en:", CSV_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);

// Crear tabla zip_geo
db.exec(`
CREATE TABLE IF NOT EXISTS zip_geo (
  zip TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
`);

const raw = fs.readFileSync(CSV_PATH, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

if (lines.length < 2) {
  console.error("❌ CSV vacío o inválido");
  process.exit(1);
}

// Detectar separador (; o ,) en base a la primera línea
const headerLine = lines[0];
const delimiter = headerLine.includes(";") ? ";" : ",";

// Headers limpios (sin comillas)
const headers = headerLine
  .split(delimiter)
  .map((h) => cleanCell(h).toLowerCase());

const idxZip = headers.indexOf("zip");
const idxLat = headers.indexOf("lat");

// el CSV tuyo tiene "lng"
const idxLng = headers.indexOf("lng") !== -1 ? headers.indexOf("lng") : headers.indexOf("lon");

if (idxZip === -1 || idxLat === -1 || idxLng === -1) {
  console.error("❌ CSV inválido. Necesito columnas: zip, lat, lng (o lon)");
  console.error("Headers encontrados:", headers);
  process.exit(1);
}

const insert = db.prepare(`
  INSERT OR REPLACE INTO zip_geo (zip, lat, lon)
  VALUES (?, ?, ?)
`);

let count = 0;

db.transaction(() => {
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter);

    const zip = cleanCell(cols[idxZip]);
    const lat = parseFloat(cleanCell(cols[idxLat]));
    const lon = parseFloat(cleanCell(cols[idxLng]));

    if (!/^\d{5}$/.test(zip)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    insert.run(zip, lat, lon);
    count++;
  }
})();

console.log("✅ ZIPs importados correctamente:", count);
console.log("📍 Tabla: zip_geo");
console.log("📦 DB:", path.resolve(DB_PATH));
console.log("📄 CSV:", path.resolve(CSV_PATH));

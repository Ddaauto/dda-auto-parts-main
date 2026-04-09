const Database = require("better-sqlite3");

const db = new Database("./dda.sqlite");
const result = db.pragma("wal_checkpoint(FULL)");
console.log(result);
db.close();

console.log("Checkpoint done");
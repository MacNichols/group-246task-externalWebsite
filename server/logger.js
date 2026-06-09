/**
 * Session Logger
 *
 * Writes complete session records to disk as newline-delimited JSON (NDJSON).
 * One file per day, one record per completed session.
 * Merge with Qualtrics data using qualtricsRid as the key.
 */

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayFilename() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(LOG_DIR, `sessions_${stamp}.ndjson`);
}

function logSession(sessionExport) {
  ensureLogDir();
  const line = JSON.stringify(sessionExport) + "\n";
  try {
    fs.appendFileSync(todayFilename(), line, "utf8");
  } catch (err) {
    console.error("[logger] Failed to write session log:", err.message);
  }
}

module.exports = { logSession };

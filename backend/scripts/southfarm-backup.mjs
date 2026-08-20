import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(scriptDirectory, "..");

function option(name, fallback = "") {
  const prefix = name + "=";
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function safeName(value) {
  return String(value || "manual").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
}

const databasePath = path.resolve(option("--db", process.env.SOUTHFARM_DB_PATH || path.join(backendDirectory, "data", "southfarm.db")));
const outputDirectory = path.resolve(option("--out-dir", path.join(backendDirectory, "backups")));
const label = safeName(option("--label", "southfarm"));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(outputDirectory, label + "-" + timestamp + ".db");

if (!fs.existsSync(databasePath)) {
  throw new Error("Database not found: " + databasePath);
}
fs.mkdirSync(outputDirectory, { recursive: true });
if (fs.existsSync(outputPath)) {
  throw new Error("Backup already exists: " + outputPath);
}

const source = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const sourceIntegrity = source.prepare("PRAGMA integrity_check").get();
  if (sourceIntegrity?.integrity_check !== "ok") {
    throw new Error("Source database integrity check failed");
  }
  await source.backup(outputPath);
} finally {
  source.close();
}

const verification = new Database(outputPath, { readonly: true, fileMustExist: true });
let integrity;
try {
  integrity = verification.prepare("PRAGMA integrity_check").get()?.integrity_check;
} finally {
  verification.close();
}
if (integrity !== "ok") {
  throw new Error("Backup integrity check failed");
}

const hash = crypto.createHash("sha256");
hash.update(fs.readFileSync(outputPath));
const metadata = {
  backup_path: outputPath,
  source_path: databasePath,
  created_at: new Date().toISOString(),
  integrity,
  size_bytes: fs.statSync(outputPath).size,
  sha256: hash.digest("hex"),
};
console.log(JSON.stringify(metadata, null, 2));

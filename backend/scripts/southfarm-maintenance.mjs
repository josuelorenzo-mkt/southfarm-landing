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

function integerOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isoCutoff(now, daysOrMonths, unit) {
  const date = new Date(now);
  if (unit === "months") date.setUTCMonth(date.getUTCMonth() - daysOrMonths);
  else date.setUTCDate(date.getUTCDate() - daysOrMonths);
  return date.toISOString();
}

const databasePath = path.resolve(option("--db", process.env.SOUTHFARM_DB_PATH || path.join(backendDirectory, "data", "southfarm.db")));
const apply = process.argv.includes("--apply");
const nowValue = option("--now", new Date().toISOString());
const now = new Date(nowValue);
if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid ISO date");
const scanDays = integerOption("--scan-days", 30);
const activityMonths = integerOption("--activity-months", 6);
const scanCutoff = isoCutoff(now, scanDays, "days");
const activityCutoff = isoCutoff(now, activityMonths, "months");

if (!fs.existsSync(databasePath)) throw new Error("Database not found: " + databasePath);
const db = new Database(databasePath);
db.pragma("foreign_keys = ON");

function hasTable(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function count(sql, parameters) {
  return Number(db.prepare(sql).get(...parameters)?.count || 0);
}

const terminalStatuses = "('completed', 'error', 'cancelled', 'expired')";
const actions = [];
if (hasTable("scan_sessions")) {
  actions.push({
    name: "scan_sessions_older_than_30_days",
    count: () => count("SELECT COUNT(*) AS count FROM scan_sessions WHERE COALESCE(completed_at, created_at) < ?", [scanCutoff]),
    delete: () => db.prepare("DELETE FROM scan_sessions WHERE COALESCE(completed_at, created_at) < ?").run(scanCutoff).changes,
  });
}
if (hasTable("warmup_sessions")) {
  actions.push({
    name: "warmup_sessions_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM warmup_sessions WHERE COALESCE(timestamp, created_at) < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM warmup_sessions WHERE COALESCE(timestamp, created_at) < ?").run(activityCutoff).changes,
  });
}
if (hasTable("task_runs")) {
  actions.push({
    name: "scan_task_runs_older_than_30_days",
    count: () => count("SELECT COUNT(*) AS count FROM task_runs WHERE task_type LIKE 'scan_%' AND status IN " + terminalStatuses + " AND COALESCE(completed_at, updated_at, created_at) < ?", [scanCutoff]),
    delete: () => db.prepare("DELETE FROM task_runs WHERE task_type LIKE 'scan_%' AND status IN " + terminalStatuses + " AND COALESCE(completed_at, updated_at, created_at) < ?").run(scanCutoff).changes,
  });
  actions.push({
    name: "non_scan_task_runs_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM task_runs WHERE task_type NOT LIKE 'scan_%' AND status IN " + terminalStatuses + " AND COALESCE(completed_at, updated_at, created_at) < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM task_runs WHERE task_type NOT LIKE 'scan_%' AND status IN " + terminalStatuses + " AND COALESCE(completed_at, updated_at, created_at) < ?").run(activityCutoff).changes,
  });
}
if (hasTable("task_events")) {
  actions.push({
    name: "task_events_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM task_events WHERE created_at < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM task_events WHERE created_at < ?").run(activityCutoff).changes,
  });
}
if (hasTable("notifications")) {
  actions.push({
    name: "notifications_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM notifications WHERE created_at < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM notifications WHERE created_at < ?").run(activityCutoff).changes,
  });
}
if (hasTable("publication_events")) {
  actions.push({
    name: "terminal_publication_events_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM publication_events event JOIN publication_jobs job ON job.id = event.publication_job_id WHERE job.status IN ('completed', 'failed', 'cancelled') AND COALESCE(job.completed_at, job.updated_at, job.created_at) < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM publication_events WHERE publication_job_id IN (SELECT id FROM publication_jobs WHERE status IN ('completed', 'failed', 'cancelled') AND COALESCE(completed_at, updated_at, created_at) < ?)").run(activityCutoff).changes,
  });
}
if (hasTable("publication_jobs")) {
  actions.push({
    name: "terminal_publication_jobs_older_than_6_months",
    count: () => count("SELECT COUNT(*) AS count FROM publication_jobs WHERE status IN ('completed', 'failed', 'cancelled') AND COALESCE(completed_at, updated_at, created_at) < ?", [activityCutoff]),
    delete: () => db.prepare("DELETE FROM publication_jobs WHERE status IN ('completed', 'failed', 'cancelled') AND COALESCE(completed_at, updated_at, created_at) < ?").run(activityCutoff).changes,
  });
}

const preview = actions.map((action) => ({ name: action.name, eligible_rows: action.count() }));
const result = {
  mode: apply ? "apply" : "dry-run",
  database_path: databasePath,
  evaluated_at: now.toISOString(),
  policy: {
    scan_retention_days: scanDays,
    activity_retention_months: activityMonths,
    scan_cutoff: scanCutoff,
    activity_cutoff: activityCutoff,
  },
  actions: preview,
};

if (apply && actions.length) {
  const execute = db.transaction(() => actions.map((action) => ({
    name: action.name,
    deleted_rows: action.delete(),
  })));
  result.actions = execute();
}

db.close();
console.log(JSON.stringify(result, null, 2));

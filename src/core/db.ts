import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "./config";
import type { JobPosting, JobStatus } from "./types";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(env.dataDir, { recursive: true });
  db = new Database(path.join(env.dataDir, "applypilot.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      ats TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      url TEXT,
      apply_url TEXT,
      description TEXT,
      posted_at TEXT,
      comp_text TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      status_reason TEXT,
      score INTEGER,
      score_json TEXT,
      tailored_json TEXT,
      verify_json TEXT,
      gate_json TEXT,
      apply_json TEXT,
      pdf_path TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      job_id TEXT,
      agent TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
    CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL);
  `);
  return db;
}

export interface JobRow {
  id: string;
  ats: string;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  apply_url: string | null;
  description: string | null;
  posted_at: string | null;
  comp_text: string | null;
  status: JobStatus;
  status_reason: string | null;
  score: number | null;
  score_json: string | null;
  tailored_json: string | null;
  verify_json: string | null;
  gate_json: string | null;
  apply_json: string | null;
  pdf_path: string | null;
  discovered_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export function rowToPosting(r: JobRow): JobPosting {
  return {
    id: r.id,
    ats: r.ats as JobPosting["ats"],
    company: r.company,
    title: r.title,
    location: r.location ?? "",
    url: r.url ?? "",
    applyUrl: r.apply_url ?? r.url ?? "",
    description: r.description ?? "",
    postedAt: r.posted_at ?? undefined,
    compText: r.comp_text ?? undefined,
  };
}

/** Insert new postings; returns how many were new. Existing jobs are left untouched. */
export function upsertJobs(jobs: JobPosting[]): number {
  const stmt = getDb().prepare(`INSERT OR IGNORE INTO jobs (id, ats, company, title, location, url, apply_url, description, posted_at, comp_text)
    VALUES (@id, @ats, @company, @title, @location, @url, @applyUrl, @description, @postedAt, @compText)`);
  let n = 0;
  getDb().transaction(() => {
    for (const j of jobs) n += stmt.run({ ...j, postedAt: j.postedAt ?? null, compText: j.compText ?? null }).changes;
  })();
  return n;
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listJobs(opts: { status?: JobStatus | JobStatus[]; minScore?: number; limit?: number } = {}): JobRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) {
    const s = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${s.map(() => "?").join(",")})`);
    args.push(...s);
  }
  if (opts.minScore !== undefined) {
    where.push("score >= ?");
    args.push(opts.minScore);
  }
  const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(score,-1) DESC, discovered_at DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, opts.limit ?? 500) as JobRow[];
}

type Patch = Partial<Omit<JobRow, "id">>;
export function updateJob(id: string, patch: Patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb().prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...patch, id });
}

export function setStatus(id: string, status: JobStatus, reason?: string) {
  updateJob(id, { status, status_reason: reason ?? null, ...(status === "submitted" ? { submitted_at: new Date().toISOString() } : {}) });
}

export function statusCounts(): Record<string, number> {
  const rows = getDb().prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function submittedToday(company?: string): number {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const sql = `SELECT COUNT(*) n FROM jobs WHERE status='submitted' AND submitted_at >= ? ${company ? "AND company = ?" : ""}`;
  const args = company ? [since.toISOString(), company] : [since.toISOString()];
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

export function submittedForCompany(company: string, days = 30): number {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return (getDb().prepare("SELECT COUNT(*) n FROM jobs WHERE status='submitted' AND company = ? AND submitted_at >= ?").get(company, since) as { n: number }).n;
}

/* ---------------- Tracing ---------------- */

export function logEvent(agent: string, level: "info" | "warn" | "error", message: string, jobId?: string, data?: unknown) {
  getDb()
    .prepare("INSERT INTO events (job_id, agent, level, message, data) VALUES (?, ?, ?, ?, ?)")
    .run(jobId ?? null, agent, level, message, data === undefined ? null : JSON.stringify(data));
  const tag = level === "error" ? "✖" : level === "warn" ? "!" : "•";
  if (process.env.APPLYPILOT_QUIET !== "1") console.log(`${tag} [${agent}] ${jobId ? jobId + " " : ""}${message}`);
}

export function jobEvents(jobId: string) {
  return getDb().prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id").all(jobId) as {
    id: number;
    ts: string;
    agent: string;
    level: string;
    message: string;
    data: string | null;
  }[];
}

export function recentEvents(limit = 50) {
  return getDb().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number;
    ts: string;
    job_id: string | null;
    agent: string;
    level: string;
    message: string;
  }[];
}

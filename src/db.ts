import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export let db: DatabaseSync;

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function genToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'admin',
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT ''
);
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  current_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','deprecated')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ingest','client')),
  security_flags_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver TEXT NOT NULL,
  body TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  lint_score INTEGER DEFAULT 0,
  lint_report_json TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  author_kind TEXT NOT NULL DEFAULT 'admin' CHECK (author_kind IN ('admin','token')),
  author_token_id INTEGER,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(skill_id, semver)
);
CREATE TABLE skill_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_version_id INTEGER NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE(skill_version_id, path)
);
CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT ''
);
CREATE TABLE collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, skill_id)
);
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["skills:read"]',
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('category','collection','skill')),
  target_id INTEGER NOT NULL,
  pin TEXT NOT NULL DEFAULT 'latest',
  UNIQUE(token_id, kind, target_id)
);
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('github','git','direct','local')),
  auto_refresh_hours INTEGER,
  last_run_at TEXT,
  last_status TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('categorize','dedupe_review','improve_descriptions')),
  params_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor_kind TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail_json TEXT DEFAULT '{}'
);
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  token_id INTEGER,
  tool TEXT NOT NULL,
  skill_name TEXT,
  skill_version TEXT
);
`,
  2: `
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE skill_tags (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, tag_id)
);
`,
};

function loadMigrations(d: DatabaseSync) {
  d.exec(
    "CREATE TABLE IF NOT EXISTS migrations (num INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
  );
  const row = d.prepare("SELECT MAX(num) m FROM migrations").get() as { m: number | null };
  const current = row.m ?? 0;
  for (const num of Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b)) {
    if (num <= current) continue;
    d.exec(MIGRATIONS[num]);
    d.prepare("INSERT INTO migrations (num) VALUES (?)").run(num);
  }
}

export function initDb(path: string) {
  if (db) return;
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON"); // skill delete must cascade to collection_items/skill_tags
  loadMigrations(db);
}

export function audit(
  actor_kind: "admin" | "token" | "system",
  actor_id: number | null,
  action: string,
  detail: unknown = {},
) {
  db.prepare(
    "INSERT INTO audit (actor_kind, actor_id, action, detail_json) VALUES (?,?,?,?)",
  ).run(actor_kind, actor_id, action, JSON.stringify(detail));
}

export function usageRow(tokenId: number | null, tool: string, skill?: string, version?: string) {
  db.prepare("INSERT INTO usage (token_id, tool, skill_name, skill_version) VALUES (?,?,?,?)").run(
    tokenId,
    tool,
    skill ?? null,
    version ?? null,
  );
}

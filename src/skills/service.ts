import matter from "gray-matter";
import * as semver from "semver";
import { db, audit, sha256 } from "../db.ts";
import { lintSkill } from "./lint.ts";

export { semver };

export interface SkillFileInput {
  path: string;
  content: Buffer | string;
}

export interface PublishInput {
  skillName: string;
  semver: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  files?: SkillFileInput[];
  sourceUrl?: string;
  authorKind: "admin" | "token";
  authorTokenId?: number;
  createIfMissing?: boolean;
  source?: "manual" | "ingest" | "client";
  description?: string; // for createIfMissing
}

export interface ResolvedSkill {
  skill_id: number;
  name: string;
  status: string;
  category: string | null;
  tags: string[];
  version_id: number;
  semver: string;
  description: string;
  frontmatter: Record<string, unknown>;
  pin: string;
}

const ALLOWED_DIRS = ["references/", "assets/", "scripts/"];

function storeFiles(versionId: number, files: SkillFileInput[]): void {
  for (const f of files) {
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), "utf8");
    db.prepare(
      "INSERT INTO skill_files (skill_version_id, path, content, sha256, size) VALUES (?,?,?,?,?)",
    ).run(versionId, f.path, buf, sha256(buf), buf.length);
  }
}

export function publishVersion(input: PublishInput): { ok: boolean; error?: string; versionId?: number; lint?: ReturnType<typeof lintSkill> } {
  let skill = db.prepare("SELECT * FROM skills WHERE name = ?").get(input.skillName) as
    | { id: number; status: string; current_version_id: number | null }
    | undefined;

  if (!skill) {
    if (!input.createIfMissing) return { ok: false, error: `skill '${input.skillName}' not found` };
    db.prepare("INSERT INTO skills (name, source) VALUES (?, ?)").run(
      input.skillName,
      input.source ?? (input.authorKind === "token" ? "client" : "manual"),
    );
    skill = db.prepare("SELECT * FROM skills WHERE name = ?").get(input.skillName) as {
      id: number;
      status: string;
      current_version_id: number | null;
    };
  }

  // parse: body may already be frontmatter-stripped, or full SKILL.md
  let fm = input.frontmatter ?? {};
  let body = input.body;
  const raw = input.body.trimStart();
  if (raw.startsWith("---")) {
    const parsed = matter(input.body);
    fm = { ...fm, ...parsed.data };
    body = parsed.content;
  }
  if (!fm.name) fm.name = input.skillName;

  // new version without an explicit description: inherit from the latest approved version
  if (!fm.description) {
    const prev = db
      .prepare(
        "SELECT frontmatter_json FROM skill_versions WHERE skill_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1",
      )
      .get(skill.id) as any;
    if (prev) {
      const prevFm = JSON.parse(prev.frontmatter_json);
      if (prevFm.description) fm.description = prevFm.description;
      if (prevFm.license && !fm.license) fm.license = prevFm.license;
      if (prevFm.compatibility && !fm.compatibility) fm.compatibility = prevFm.compatibility;
      if (prevFm.metadata && !fm.metadata) fm.metadata = prevFm.metadata;
    }
  }

  const lint = lintSkill({
    name: input.skillName,
    frontmatter: fm,
    body,
    files: input.files?.map((f) => ({ path: f.path, size: Buffer.byteLength(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content)) })),
  });
  if (!lint.ok) return { ok: false, error: "lint failed", lint };

  const status = input.authorKind === "admin" ? "approved" : "pending";
  try {
    const r = db
      .prepare(
        "INSERT INTO skill_versions (skill_id, semver, body, frontmatter_json, lint_score, lint_report_json, status, author_kind, author_token_id, source_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        skill.id,
        input.semver,
        body,
        JSON.stringify(fm),
        lint.score,
        JSON.stringify(lint.report),
        status,
        input.authorKind,
        input.authorTokenId ?? null,
        input.sourceUrl ?? null,
      );
    const versionId = Number(r.lastInsertRowid);
    if (input.files?.length) {
      storeFiles(versionId, input.files);
    } else {
      // a new version without files inherits the previous version's bundle,
      // so bumping a version never silently drops references/scripts/assets
      const prev = db
        .prepare(
          "SELECT id FROM skill_versions WHERE skill_id = ? AND id != ? AND status = 'approved' ORDER BY id DESC LIMIT 1",
        )
        .get(skill.id, versionId) as any;
      if (prev) {
        const inherited = db
          .prepare("SELECT path, content FROM skill_files WHERE skill_version_id = ?")
          .all(prev.id) as any[];
        if (inherited.length) storeFiles(versionId, inherited.map((f) => ({ path: f.path, content: Buffer.from(f.content) })));
      }
    }

    if (status === "approved") {
      // An approved publish makes the skill current AND live. A skill that was
      // left in draft (e.g. by a security flag) is not silently promoted.
      const cur = db.prepare("SELECT status FROM skills WHERE id = ?").get(skill.id) as { status: string };
      const nextStatus = cur.status === "deprecated" ? "deprecated" : "published";
      db.prepare(
        "UPDATE skills SET current_version_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(versionId, nextStatus, skill.id);
    }
    audit(input.authorKind, input.authorTokenId ?? null, "skill.publish", {
      skill: input.skillName,
      semver: input.semver,
      status,
      lint_score: lint.score,
    });
    return { ok: true, versionId, lint };
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) {
      return { ok: false, error: `version ${input.semver} already exists`, lint };
    }
    throw e;
  }
}

export function approveVersion(versionId: number, makeCurrent: boolean): boolean {
  const v = db.prepare("SELECT * FROM skill_versions WHERE id = ?").get(versionId) as any;
  if (!v) return false;
  db.prepare("UPDATE skill_versions SET status = 'approved' WHERE id = ?").run(versionId);
  if (makeCurrent || !v.skill_id) {
    db.prepare("UPDATE skills SET current_version_id = ?, status = 'published', updated_at = datetime('now') WHERE id = ?").run(
      versionId,
      v.skill_id,
    );
  } else {
    const s = db.prepare("SELECT status FROM skills WHERE id = ?").get(v.skill_id) as any;
    if (s && s.status === "draft") {
      db.prepare("UPDATE skills SET status = 'published' WHERE id = ?").run(v.skill_id);
    }
  }
  audit("admin", null, "skill.version.approve", { version_id: versionId, make_current: makeCurrent });
  return true;
}

export function rejectVersion(versionId: number): boolean {
  const r = db.prepare("UPDATE skill_versions SET status = 'rejected' WHERE id = ?").run(versionId);
  if (Number(r.changes) === 0) return false;
  audit("admin", null, "skill.version.reject", { version_id: versionId });
  return true;
}

// resolve the concrete version for a skill given a pin policy
function resolveVersion(skillId: number, currentVersionId: number | null, pin: string): { id: number; semver: string } | null {
  if (pin === "latest" || pin === "") {
    if (!currentVersionId) return null;
    const v = db.prepare("SELECT id, semver FROM skill_versions WHERE id = ?").get(currentVersionId) as any;
    return v ?? null;
  }
  if (pin.startsWith("major:")) {
    const major = Number(pin.slice(6));
    const rows = db
      .prepare("SELECT id, semver FROM skill_versions WHERE skill_id = ? AND status = 'approved'")
      .all(skillId) as any[];
    const matching = rows
      .map((r) => ({ ...r, parsed: semver.parse(r.semver) }))
      .filter((r) => r.parsed && r.parsed.major === major)
      .sort((a, b) => semver.rcompare(a.parsed, b.parsed));
    return matching[0] ?? null;
  }
  // exact (strip optional 'exact:' prefix)
  const want = pin.replace(/^exact:/, "");
  const v = db
    .prepare("SELECT id, semver FROM skill_versions WHERE skill_id = ? AND semver = ? AND status = 'approved'")
    .get(skillId, want) as any;
  return v ?? null;
}

// Admin sessions (tokenId === null) see every published skill.
export function resolveAllPublished(): ResolvedSkill[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.status, s.current_version_id, c.name AS category
       FROM skills s LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.status = 'published' ORDER BY s.name`,
    )
    .all() as any[];
  const out: ResolvedSkill[] = [];
  for (const s of rows) {
    const v = resolveVersion(s.id, s.current_version_id, "latest");
    if (!v) continue;
    const full = db.prepare("SELECT frontmatter_json FROM skill_versions WHERE id = ?").get(v.id) as any;
    const fm = JSON.parse(full.frontmatter_json);
    out.push({
      skill_id: s.id,
      name: s.name,
      status: s.status,
      category: s.category ?? null,
      tags: tagsOf(s.id),
      version_id: v.id,
      semver: v.semver,
      description: String(fm.description ?? ""),
      frontmatter: fm,
      pin: "latest",
    });
  }
  return out;
}

export function tagsOf(skillId: number): string[] {
  return (db
    .prepare("SELECT t.name FROM skill_tags st JOIN tags t ON t.id = st.tag_id WHERE st.skill_id = ? ORDER BY t.name")
    .all(skillId) as any[]).map((r) => r.name);
}

// ---------- delete with undo ----------
// ponytail: in-memory snapshot for the last deletes; a restart drops the undo
// buffer, which only means the Undo button has nothing to restore.

export interface SkillSnapshot {
  skill: Record<string, any>;
  versions: Record<string, any>[]; // each with .files rows
  tags: string[];
  collectionIds: number[];
  assignments: { token_id: number; pin: string }[];
}

export function snapshotSkill(name: string): SkillSnapshot | null {
  const s = db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as any;
  if (!s) return null;
  const versions = (db.prepare("SELECT * FROM skill_versions WHERE skill_id = ?").all(s.id) as any[]).map((v) => ({
    ...v,
    files: db.prepare("SELECT path, content, sha256, size FROM skill_files WHERE skill_version_id = ?").all(v.id),
  }));
  return {
    skill: s,
    versions,
    tags: tagsOf(s.id),
    collectionIds: (db.prepare("SELECT collection_id FROM collection_items WHERE skill_id = ?").all(s.id) as any[]).map((r) => r.collection_id),
    assignments: db.prepare("SELECT token_id, pin FROM assignments WHERE kind = 'skill' AND target_id = ?").all(s.id) as any[],
  };
}

export function deleteSkillWithSnapshot(name: string): { snapshot: SkillSnapshot } | null {
  const snapshot = snapshotSkill(name);
  if (!snapshot) return null;
  db.prepare("DELETE FROM assignments WHERE kind = 'skill' AND target_id = ?").run(snapshot.skill.id);
  db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  return { snapshot };
}

export function restoreSkill(snap: SkillSnapshot): boolean {
  if (db.prepare("SELECT id FROM skills WHERE name = ?").get(snap.skill.name)) return false;
  const s = snap.skill;
  // references must still exist — FK failures would abort the whole restore
  const categoryId = s.category_id && db.prepare("SELECT id FROM categories WHERE id = ?").get(s.category_id) ? s.category_id : null;
  const r = db
    .prepare(
      "INSERT INTO skills (id, name, category_id, status, source, security_flags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(s.id, s.name, categoryId, s.status, s.source, s.security_flags_json, s.created_at, s.updated_at);
  const skillId = Number(r.lastInsertRowid);
  for (const v of snap.versions as any[]) {
    const vr = db
      .prepare(
        "INSERT INTO skill_versions (id, skill_id, semver, body, frontmatter_json, lint_score, lint_report_json, status, author_kind, author_token_id, source_url, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(v.id, skillId, v.semver, v.body, v.frontmatter_json, v.lint_score, v.lint_report_json, v.status, v.author_kind, v.author_token_id, v.source_url, v.created_at);
    const versionId = Number(vr.lastInsertRowid);
    for (const f of v.files as any[])
      db.prepare("INSERT INTO skill_files (skill_version_id, path, content, sha256, size) VALUES (?,?,?,?,?)").run(versionId, f.path, f.content, f.sha256, f.size);
  }
  // current_version_id was rewritten by the version re-insert; point it back
  db.prepare("UPDATE skills SET current_version_id = ? WHERE id = ?").run(s.current_version_id, skillId);
  for (const tag of snap.tags) {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
    db.prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) SELECT ?, id FROM tags WHERE name = ?").run(skillId, tag);
  }
  for (const cid of snap.collectionIds)
    db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, skill_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM collections WHERE id = ?)").run(cid, skillId, cid);
  for (const a of snap.assignments)
    db.prepare("INSERT OR IGNORE INTO assignments (token_id, kind, target_id, pin) SELECT ?, 'skill', ?, ? WHERE EXISTS (SELECT 1 FROM tokens WHERE id = ?)").run(a.token_id, skillId, a.pin, a.token_id);
  return true;
}

export function resolveVisibleSkills(tokenId: number): ResolvedSkill[] {
  const assigns = db
    .prepare("SELECT kind, target_id, pin FROM assignments WHERE token_id = ? ORDER BY CASE kind WHEN 'skill' THEN 0 WHEN 'collection' THEN 1 ELSE 2 END, id")
    .all(tokenId) as any[];
  const skillIds = new Map<number, string>(); // skill_id -> pin (most specific assignment wins: skill > collection > category)
  for (const a of assigns) {
    if (a.kind === "skill") {
      if (!skillIds.has(a.target_id)) skillIds.set(a.target_id, a.pin);
    } else if (a.kind === "category") {
      const rows = db.prepare("SELECT id FROM skills WHERE category_id = ?").all(a.target_id) as any[];
      for (const r of rows) if (!skillIds.has(r.id)) skillIds.set(r.id, a.pin);
    } else if (a.kind === "collection") {
      const rows = db.prepare("SELECT skill_id FROM collection_items WHERE collection_id = ?").all(a.target_id) as any[];
      for (const r of rows) if (!skillIds.has(r.skill_id)) skillIds.set(r.skill_id, a.pin);
    }
  }
  const out: ResolvedSkill[] = [];
  for (const [skillId, pin] of skillIds) {
    const s = db
      .prepare(
        `SELECT s.id, s.name, s.status, s.current_version_id, c.name AS category
         FROM skills s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ?`,
      )
      .get(skillId) as any;
    if (!s || s.status !== "published") continue;
    const v = resolveVersion(skillId, s.current_version_id, pin);
    if (!v) continue;
    const full = db.prepare("SELECT frontmatter_json FROM skill_versions WHERE id = ?").get(v.id) as any;
    const fm = JSON.parse(full.frontmatter_json);
    out.push({
      skill_id: s.id,
      name: s.name,
      status: s.status,
      category: s.category ?? null,
      tags: tagsOf(s.id),
      version_id: v.id,
      semver: v.semver,
      description: String(fm.description ?? ""),
      frontmatter: fm,
      pin,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getResolved(skillName: string, version?: string): { resolved: ResolvedSkill; body: string } | null {
  const s = db
    .prepare(
      `SELECT s.id, s.name, s.status, s.current_version_id, c.name AS category
       FROM skills s LEFT JOIN categories c ON c.id = s.category_id WHERE s.name = ? AND s.status = 'published'`,
    )
    .get(skillName) as any;
  if (!s) return null;
  let v: any;
  if (version) {
    v = db
      .prepare("SELECT id, semver FROM skill_versions WHERE skill_id = ? AND semver = ? AND status = 'approved'")
      .get(s.id, version);
  } else if (s.current_version_id) {
    v = db.prepare("SELECT id, semver FROM skill_versions WHERE id = ? AND status = 'approved'").get(s.current_version_id);
  }
  if (!v) return null;
  const full = db.prepare("SELECT body, frontmatter_json FROM skill_versions WHERE id = ?").get(v.id) as any;
  return {
    resolved: {
      skill_id: s.id,
      name: s.name,
      status: s.status,
      category: s.category ?? null,
      tags: tagsOf(s.id),
      version_id: v.id,
      semver: v.semver,
      description: String(JSON.parse(full.frontmatter_json).description ?? ""),
      frontmatter: JSON.parse(full.frontmatter_json),
      pin: "latest",
    },
    body: full.body,
  };
}

export function listVersionFiles(versionId: number): { path: string; sha256: string; size: number }[] {
  return db
    .prepare("SELECT path, sha256, size FROM skill_files WHERE skill_version_id = ? ORDER BY path")
    .all(versionId) as any[];
}

export function getVersionFile(versionId: number, path: string): { content: Buffer } | null {
  const r = db.prepare("SELECT content FROM skill_files WHERE skill_version_id = ? AND path = ?").get(versionId, path) as any;
  return r ? { content: Buffer.from(r.content) } : null;
}

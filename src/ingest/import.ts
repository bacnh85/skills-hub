import { db, audit } from "../db.ts";
import { publishVersion } from "../skills/service.ts";
import { fetchSource, parseSource } from "./fetchers.ts";
import { scanDir, type FoundSkill } from "./scanner.ts";
import * as semver from "semver";

export interface ImportReportItem {
  skill: string;
  action: "created" | "version-added" | "skipped" | "error";
  semver?: string;
  pending?: boolean;
  lint_score?: number;
  security_flags?: string[];
  notes?: string[];
  error?: string;
}

export async function importFromUrl(url: string, actorId: number | null = null): Promise<{ items: ImportReportItem[] }> {
  const parsed = parseSource(url);
  const fetched = await fetchSource(parsed);
  const items: ImportReportItem[] = [];
  try {
    const found = scanDir(fetched.dir);
    for (const f of found) {
      items.push(await importOne(f, actorId));
    }
    if (items.length === 0) items.push({ skill: "(none)", action: "error", error: "no SKILL.md found in source" });
  } finally {
    fetched.cleanup();
  }
  audit("system", actorId, "ingest.import", { url, count: items.length });
  return { items };
}

async function importOne(f: FoundSkill, actorId: number | null): Promise<ImportReportItem> {
  const existing = db.prepare("SELECT id FROM skills WHERE name = ?").get(f.name) as any;

  // unchanged content: skip instead of bumping a patch version on every refresh
  if (existing) {
    const last = db
      .prepare("SELECT body, frontmatter_json FROM skill_versions WHERE skill_id = ? ORDER BY id DESC LIMIT 1")
      .get(existing.id) as any;
    if (last && last.body.trim() === f.body.trim()) {
      return { skill: f.name, action: "skipped" };
    }
  }

  let ver = String((f.frontmatter.metadata as any)?.version ?? f.frontmatter.version ?? "").trim();
  if (ver && !semver.valid(ver)) ver = "";
  if (!ver) {
    if (existing) {
      const last = db.prepare("SELECT semver FROM skill_versions WHERE skill_id = ? ORDER BY id DESC LIMIT 1").get(existing.id) as any;
      ver = last ? String(semver.inc(last.semver, "patch")) : "0.1.0";
    } else {
      ver = "0.1.0";
    }
  }
  const dup = existing
    ? db.prepare("SELECT id FROM skill_versions WHERE skill_id = ? AND semver = ?").get(existing.id, ver)
    : null;
  if (dup) return { skill: f.name, action: "skipped", semver: ver };

  const r = publishVersion({
    skillName: f.name,
    semver: ver,
    body: `---\nname: ${f.name}\n${f.frontmatter.description ? `description: ${JSON.stringify(String(f.frontmatter.description))}\n` : ""}---\n${f.body}`,
    files: f.files
      .filter((x) => x.path !== "SKILL.md")
      .map((x) => ({ path: x.path, content: x.content })),
    sourceUrl: f.frontmatter.source ? String(f.frontmatter.source) : undefined,
    authorKind: "admin",
    source: "ingest",
    createIfMissing: true,
  });
  if (!r.ok) return { skill: f.name, action: "error", error: r.error, lint_score: r.lint?.score, security_flags: f.security_flags };

  if (f.security_flags.length > 0) {
    // force pending + record flags on the skill row
    if (r.versionId) db.prepare("UPDATE skill_versions SET status = 'pending' WHERE id = ?").run(r.versionId);
    db.prepare("UPDATE skills SET security_flags_json = ?, status = 'draft' WHERE name = ?").run(JSON.stringify(f.security_flags), f.name);
    return {
      skill: f.name,
      action: existing ? "version-added" : "created",
      semver: ver,
      pending: true,
      lint_score: r.lint?.score,
      security_flags: f.security_flags,
      notes: f.notes,
    };
  }
  // clean imports from trusted admins stay admin-approved; skill published
  db.prepare("UPDATE skills SET status = 'published' WHERE name = ?").run(f.name);
  return {
    skill: f.name,
    action: existing ? "version-added" : "created",
    semver: ver,
    pending: false,
    lint_score: r.lint?.score,
    notes: f.notes,
  };
}

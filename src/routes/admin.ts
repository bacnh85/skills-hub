import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, audit, genToken, sha256 } from "../db.ts";
import { adminGuard, type Actor } from "../auth.ts";
import { publishVersion, approveVersion, rejectVersion, getResolved, listVersionFiles, deleteSkillWithSnapshot, restoreSkill, type SkillSnapshot } from "../skills/service.ts";
import { config } from "../config.ts";

const body200 = "This is placeholder body content for a new skill. Replace with real instructions before publishing.\n".repeat(5);

function actor(req: any): Actor {
  return req.actor as Actor;
}

export function registerAdminRoutes(app: FastifyInstance) {
  // encapsulated scope: the auth hook must NOT leak to public/health routes
  app.register(async (scope) => {
    scope.addHook("preHandler", adminGuard);
    registerAdminRoutesInner(scope);
  });
}

function registerAdminRoutesInner(app: FastifyInstance) {
  // undo buffer for the last deletes; single process, single admin — memory is enough
  let undoSeq = 0;
  let undoBuffer: { id: number; snapshots: SkillSnapshot[]; actor: number | null }[] = [];

  // ---------- categories ----------
  app.get("/api/categories", async () =>
    db.prepare("SELECT * FROM categories ORDER BY name").all(),
  );
  app.get("/api/tags", async () =>
    db
      .prepare(
        `SELECT t.id, t.name, COUNT(st.skill_id) AS skill_count
         FROM tags t LEFT JOIN skill_tags st ON st.tag_id = t.id
         GROUP BY t.id ORDER BY t.name`,
      )
      .all(),
  );
  app.post("/api/tags", async (req, reply) => {
    const p = z.object({ name: z.string().min(1).max(48) }).parse(req.body);
    const name = p.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (!name) return reply.code(400).send({ error: "tag needs letters or digits" });
    const existing = db.prepare("SELECT id, name FROM tags WHERE name = ?").get(name) as any;
    if (existing) return existing; // idempotent: adding an existing tag is fine
    const r = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name);
    audit("admin", actor(req).id, "tag.create", { name });
    reply.code(201);
    return { id: Number(r.lastInsertRowid), name };
  });
  app.delete("/api/tags/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    audit("admin", actor(req).id, "tag.delete", { id });
    return { ok: true };
  });
  app.post("/api/categories", async (req, reply) => {
    const p = z.object({ name: z.string().min(1).max(64), description: z.string().default("") }).parse(req.body);
    try {
      const r = db.prepare("INSERT INTO categories (name, description) VALUES (?,?)").run(p.name, p.description);
      audit("admin", actor(req).id, "category.create", p);
      reply.code(201);
      return { id: Number(r.lastInsertRowid), ...p };
    } catch {
      return reply.code(409).send({ error: "category exists" });
    }
  });
  app.delete("/api/categories/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    db.prepare("UPDATE skills SET category_id = NULL WHERE category_id = ?").run(id);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    audit("admin", actor(req).id, "category.delete", { id });
    return { ok: true };
  });

  // ---------- collections ----------
  app.get("/api/collections", async () => {
    const cols = db.prepare("SELECT * FROM collections ORDER BY name").all() as any[];
    for (const c of cols) {
      c.skill_ids = (db.prepare("SELECT skill_id FROM collection_items WHERE collection_id = ?").all(c.id) as any[]).map(
        (r) => r.skill_id,
      );
    }
    return cols;
  });
  app.post("/api/collections", async (req, reply) => {
    const p = z.object({ name: z.string().min(1).max(64), description: z.string().default(""), skill_ids: z.array(z.number()).default([]) }).parse(req.body);
    try {
      const r = db.prepare("INSERT INTO collections (name, description) VALUES (?,?)").run(p.name, p.description);
      const id = Number(r.lastInsertRowid);
      for (const sid of p.skill_ids)
        db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, skill_id) VALUES (?,?)").run(id, sid);
      audit("admin", actor(req).id, "collection.create", p);
      reply.code(201);
      return { id };
    } catch {
      return reply.code(409).send({ error: "collection exists" });
    }
  });
  app.patch("/api/collections/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const p = z.object({ name: z.string().min(1).max(64).optional(), description: z.string().optional(), skill_ids: z.array(z.number()).optional() }).parse(req.body);
    if (p.name) db.prepare("UPDATE collections SET name = ? WHERE id = ?").run(p.name, id);
    if (p.description !== undefined) db.prepare("UPDATE collections SET description = ? WHERE id = ?").run(p.description, id);
    if (p.skill_ids) {
      db.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(id);
      for (const sid of p.skill_ids)
        db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, skill_id) VALUES (?,?)").run(id, sid);
    }
    audit("admin", actor(req).id, "collection.update", { id, ...p });
    return { ok: true };
  });
  app.delete("/api/collections/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    db.prepare("DELETE FROM collections WHERE id = ?").run(id);
    audit("admin", actor(req).id, "collection.delete", { id });
    return { ok: true };
  });

  // ---------- skills ----------
  app.get("/api/skills", async (req) => {
    const q = z
      .object({ status: z.string().optional(), category_id: z.coerce.number().optional(), tag: z.string().optional(), q: z.string().optional() })
      .parse((req as any).query);
    let sql = `SELECT s.id, s.name, s.status, s.source, s.category_id, c.name AS category, s.security_flags_json,
      s.current_version_id, v.semver AS current_semver, json_extract(v.frontmatter_json, '$.description') AS description, s.updated_at
      FROM skills s
      LEFT JOIN categories c ON c.id = s.category_id
      LEFT JOIN skill_versions v ON v.id = s.current_version_id WHERE 1=1`;
    const args: any[] = [];
    if (q.status) {
      sql += " AND s.status = ?";
      args.push(q.status);
    }
    if (q.category_id) {
      sql += " AND s.category_id = ?";
      args.push(q.category_id);
    }
    if (q.q) {
      sql += " AND s.name LIKE ?";
      args.push(`%${q.q}%`);
    }
    if (q.tag) {
      sql += " AND s.id IN (SELECT st.skill_id FROM skill_tags st JOIN tags t ON t.id = st.tag_id WHERE t.name = ?)";
      args.push(q.tag.toLowerCase());
    }
    sql += " ORDER BY s.name";
    const rows = db.prepare(sql).all(...args) as any[];
    if (rows.length === 0) return rows;
    const tagRows = db
      .prepare(
        `SELECT st.skill_id, t.name FROM skill_tags st JOIN tags t ON t.id = st.tag_id
         WHERE st.skill_id IN (${rows.map(() => "?").join(",")}) ORDER BY t.name`,
      )
      .all(...rows.map((r) => r.id)) as any[];
    const bySkill = new Map<number, string[]>();
    for (const t of tagRows) {
      if (!bySkill.has(t.skill_id)) bySkill.set(t.skill_id, []);
      bySkill.get(t.skill_id)!.push(t.name);
    }
    return rows.map((r) => ({ ...r, tags: bySkill.get(r.id) ?? [] }));
  });

  app.post("/api/skills", async (req, reply) => {
    const p = z
      .object({
        name: z.string().min(1).max(64),
        category_id: z.number().nullable().optional(),
        description: z.string().min(1),
        body: z.string().default(""),
        files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
        publish: z.boolean().default(true),
        semver: z.string().default("0.1.0"),
      })
      .parse(req.body);
    const body = p.body.trim() ? p.body : body200;
    const r = publishVersion({
      skillName: p.name,
      semver: p.semver,
      body,
      frontmatter: { description: p.description },
      files: p.files,
      authorKind: "admin",
      createIfMissing: true,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, lint: r.lint });
    if (p.category_id) db.prepare("UPDATE skills SET category_id = ? WHERE name = ?").run(p.category_id, p.name);
    if (p.publish) db.prepare("UPDATE skills SET status = 'published' WHERE name = ?").run(p.name);
    else db.prepare("UPDATE skills SET status = 'draft' WHERE name = ?").run(p.name);
    audit("admin", actor(req).id, "skill.create", { name: p.name, semver: p.semver });
    const s = db.prepare("SELECT id FROM skills WHERE name = ?").get(p.name) as any;
    reply.code(201);
    return { id: s.id, version_id: r.versionId, lint: r.lint };
  });

  app.get("/api/skills/:name", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse((req as any).params);
    const s = db
      .prepare(
        `SELECT s.*, c.name AS category, v.semver AS current_semver
         FROM skills s LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN skill_versions v ON v.id = s.current_version_id
         WHERE s.name = ?`,
      )
      .get(name) as any;
    if (!s) return reply.code(404).send({ error: "not found" });
    const tags = (db
      .prepare("SELECT t.name FROM skill_tags st JOIN tags t ON t.id = st.tag_id WHERE st.skill_id = ? ORDER BY t.name")
      .all(s.id) as any[]).map((r) => r.name);
    const versions = db
      .prepare(
        `SELECT id, semver, status, author_kind, lint_score, source_url, created_at FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(s.id);
    const cur = s.current_version_id
      ? db.prepare("SELECT body, frontmatter_json, lint_report_json FROM skill_versions WHERE id = ?").get(s.current_version_id) as any
      : null;
    return {
      ...s,
      security_flags: JSON.parse(s.security_flags_json ?? "[]"),
      tags,
      versions,
      current: cur
        ? { body: cur.body, frontmatter: JSON.parse(cur.frontmatter_json), lint_report: JSON.parse(cur.lint_report_json), files: listVersionFiles(s.current_version_id) }
        : null,
    };
  });

  app.patch("/api/skills/:name", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse((req as any).params);
    const p = z
      .object({
        category_id: z.number().nullable().optional(),
        status: z.enum(["draft", "published", "deprecated"]).optional(),
        tags: z.array(z.string().min(1).max(48)).optional(),
      })
      .parse(req.body);
    const s = db.prepare("SELECT id FROM skills WHERE name = ?").get(name) as any;
    if (!s) return reply.code(404).send({ error: "not found" });
    if (p.category_id !== undefined) db.prepare("UPDATE skills SET category_id = ? WHERE id = ?").run(p.category_id, s.id);
    if (p.status) db.prepare("UPDATE skills SET status = ?, updated_at = datetime('now') WHERE id = ?").run(p.status, s.id);
    if (p.tags) {
      db.prepare("DELETE FROM skill_tags WHERE skill_id = ?").run(s.id);
      for (const raw of p.tags) {
        const t = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
        if (!t) continue;
        let row = db.prepare("SELECT id FROM tags WHERE name = ?").get(t) as any;
        if (!row) row = db.prepare("INSERT INTO tags (name) VALUES (?)").run(t);
        db.prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) VALUES (?,?)").run(s.id, Number(row.lastInsertRowid ?? row.id));
      }
    }
    audit("admin", actor(req).id, "skill.update", { name, ...p });
    return { ok: true };
  });

  app.delete("/api/skills/:name/tags/:tag", async (req, reply) => {
    const { name, tag } = z.object({ name: z.string(), tag: z.string() }).parse((req as any).params);
    const s = db.prepare("SELECT id FROM skills WHERE name = ?").get(name) as any;
    if (!s) return reply.code(404).send({ error: "not found" });
    db.prepare("DELETE FROM skill_tags WHERE skill_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)").run(s.id, tag.toLowerCase());
    return { ok: true };
  });

  app.delete("/api/skills/:name", async (req, reply) => {
    const { name } = (req as any).params as { name: string };
    const r = deleteSkillWithSnapshot(name);
    if (!r) return reply.code(404).send({ error: "not found" });
    undoBuffer.unshift({ id: ++undoSeq, snapshots: [r.snapshot], actor: actor(req).id });
    if (undoBuffer.length > 10) undoBuffer.pop();
    audit("admin", actor(req).id, "skill.delete", { name });
    return { ok: true, undo_id: undoBuffer[0].id };
  });

  app.post("/api/skills/delete-batch", async (req) => {
    const p = z.object({ names: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body);
    let deleted = 0;
    const missing: string[] = [];
    const snapshots: SkillSnapshot[] = [];
    for (const name of p.names) {
      const r = deleteSkillWithSnapshot(name);
      if (!r) { missing.push(name); continue; }
      snapshots.push(r.snapshot);
      deleted++;
    }
    undoBuffer.unshift({ id: ++undoSeq, snapshots, actor: actor(req).id });
    if (undoBuffer.length > 10) undoBuffer.pop();
    audit("admin", actor(req).id, "skill.delete.batch", { names: p.names, deleted, missing });
    return { ok: true, deleted, missing, undo_id: undoBuffer[0].id };
  });

  app.post("/api/skills/undo-delete", async (req, reply) => {
    const { undo_id } = z.object({ undo_id: z.coerce.number() }).parse(req.body ?? {});
    const entry = undoBuffer.find((u) => u.id === undo_id && u.actor === actor(req).id);
    if (!entry) return reply.code(404).send({ error: "undo window expired" });
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const snap of entry.snapshots) {
      if (restoreSkill(snap)) restored.push(snap.skill.name);
      else skipped.push(snap.skill.name);
    }
    undoBuffer = undoBuffer.filter((u) => u.id !== undo_id);
    audit("admin", actor(req).id, "skill.restore", { restored, skipped });
    return { ok: true, restored, skipped };
  });

  // ---------- versions ----------
  app.post("/api/skills/:name/versions", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse((req as any).params);
    const p = z
      .object({
        semver: z.string().min(1),
        body: z.string().min(1),
        files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
        source_url: z.string().optional(),
      })
      .parse(req.body);
    const r = publishVersion({
      skillName: name,
      semver: p.semver,
      body: p.body,
      files: p.files,
      sourceUrl: p.source_url,
      authorKind: "admin",
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, lint: r.lint });
    reply.code(201);
    return { version_id: r.versionId, lint: r.lint };
  });

  app.post("/api/versions/:id/approve", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const p = z.object({ make_current: z.boolean().default(true) }).parse(req.body ?? {});
    if (!approveVersion(id, p.make_current)) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.post("/api/versions/:id/reject", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    if (!rejectVersion(id)) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.get("/api/versions/pending", async () =>
    db
      .prepare(
        `SELECT v.id, v.semver, v.lint_score, v.created_at, s.name AS skill, v.author_token_id, t.name AS token_name, v.source_url
         FROM skill_versions v JOIN skills s ON s.id = v.skill_id LEFT JOIN tokens t ON t.id = v.author_token_id
         WHERE v.status = 'pending' ORDER BY v.created_at DESC`,
      )
      .all(),
  );

  // ---------- tokens ----------
  app.get("/api/tokens", async () => {
    const rows = db
      .prepare(
        `SELECT id, name, prefix, scopes_json, revoked_at, last_used_at, created_at FROM tokens ORDER BY created_at DESC`,
      )
      .all() as any[];
    return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes_json) }));
  });

  app.post("/api/tokens", async (req, reply) => {
    const p = z
      .object({
        name: z.string().min(1).max(64),
        scopes: z.array(z.enum(["skills:read", "skills:write"])).default(["skills:read"]),
      })
      .parse(req.body);
    const token = genToken("ct");
    const r = db
      .prepare("INSERT INTO tokens (name, token_hash, prefix, scopes_json) VALUES (?,?,?,?)")
      .run(p.name, sha256(token), token.slice(0, 8), JSON.stringify(p.scopes));
    audit("admin", actor(req).id, "token.create", { name: p.name, scopes: p.scopes });
    reply.code(201);
    return { id: Number(r.lastInsertRowid), token }; // plaintext shown ONCE
  });

  app.delete("/api/tokens/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE id = ?").run(id);
    audit("admin", actor(req).id, "token.revoke", { id });
    return { ok: true };
  });

  // ---------- assignments ----------
  app.get("/api/tokens/:id/assignments", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    return db
      .prepare(
        `SELECT a.id, a.kind, a.target_id, a.pin,
          CASE a.kind WHEN 'category' THEN (SELECT name FROM categories WHERE id = a.target_id)
                      WHEN 'collection' THEN (SELECT name FROM collections WHERE id = a.target_id)
                      ELSE (SELECT name FROM skills WHERE id = a.target_id) END AS target_name
         FROM assignments a WHERE a.token_id = ? ORDER BY a.kind, a.id`,
      )
      .all(id);
  });

  app.put("/api/tokens/:id/assignments", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const p = z
      .object({
        kind: z.enum(["category", "collection", "skill"]),
        target_id: z.number(),
        pin: z.string().default("latest"),
      })
      .parse(req.body);
    if (!["latest", ""].includes(p.pin) && !p.pin.startsWith("major:") && !p.pin.startsWith("exact:")) {
      // allow bare semver as exact
      if (!/^\d+\.\d+\.\d+$/.test(p.pin)) return reply.code(400).send({ error: "pin must be latest | major:N | exact:X.Y.Z | X.Y.Z" });
    }
    db.prepare(
      "INSERT INTO assignments (token_id, kind, target_id, pin) VALUES (?,?,?,?) ON CONFLICT(token_id, kind, target_id) DO UPDATE SET pin = excluded.pin",
    ).run(id, p.kind, p.target_id, p.pin.startsWith("exact:") || /^\d/.test(p.pin) ? (p.pin.startsWith("exact:") ? p.pin : `exact:${p.pin}`) : p.pin);
    audit("admin", actor(req).id, "assignment.set", { token_id: id, ...p });
    return { ok: true };
  });

  app.delete("/api/tokens/:id/assignments/:aid", async (req) => {
    const { aid } = z.object({ aid: z.coerce.number() }).parse((req as any).params);
    db.prepare("DELETE FROM assignments WHERE id = ?").run(aid);
    audit("admin", actor(req).id, "assignment.delete", { aid });
    return { ok: true };
  });

  // what a client token will actually see
  app.get("/api/tokens/:id/preview", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const tok = db.prepare("SELECT id FROM tokens WHERE id = ? AND revoked_at IS NULL").get(id);
    if (!tok) return reply.code(404).send({ error: "token not found" });
    const { resolveVisibleSkills } = await import("../skills/service.ts");
    return resolveVisibleSkills(id).map((r) => ({ name: r.name, semver: r.semver, description: r.description, category: r.category, pin: r.pin }));
  });

  // ---------- dashboard ----------
  app.get("/api/stats", async () => {
    const one = (sql: string) => (db.prepare(sql).get() as any).n;
    return {
      skills: one("SELECT COUNT(*) n FROM skills"),
      published: one("SELECT COUNT(*) n FROM skills WHERE status = 'published'"),
      pending_versions: one("SELECT COUNT(*) n FROM skill_versions WHERE status = 'pending'"),
      categories: one("SELECT COUNT(*) n FROM categories"),
      collections: one("SELECT COUNT(*) n FROM collections"),
      tags: one("SELECT COUNT(*) n FROM tags"),
      tokens: one("SELECT COUNT(*) n FROM tokens WHERE revoked_at IS NULL"),
      sources: one("SELECT COUNT(*) n FROM sources WHERE enabled = 1"),
      ai_configured: Boolean(config.AI_BASE_URL),
    };
  });
  app.get("/api/audit", async (req) => {
    const q = z.object({ limit: z.coerce.number().default(100) }).parse((req as any).query);
    return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.min(q.limit, 1000));
  });
  app.get("/api/usage", async (req) => {
    const q = z.object({ limit: z.coerce.number().default(50) }).parse((req as any).query);
    return db
      .prepare(
        `SELECT skill_name, COALESCE(skill_version,'—') AS skill_version, COUNT(*) n, MAX(ts) last_used
         FROM usage WHERE skill_name IS NOT NULL AND skill_name NOT LIKE '%:denied'
         GROUP BY skill_name ORDER BY n DESC LIMIT ?`,
      )
      .all(Math.min(q.limit, 500));
  });

  // ---------- export / import ----------
  app.get("/api/export", async (req) => {
    const tables = ["categories", "skills", "skill_versions", "skill_files", "collections", "collection_items", "tokens", "assignments", "sources"];
    const dump: Record<string, unknown[]> = {};
    for (const t of tables) {
      dump[t] =
        t === "skill_files"
          ? db.prepare("SELECT id, skill_version_id, path, hex(content) AS content_hex, sha256, size FROM skill_files").all()
          : t === "tokens"
            ? db.prepare("SELECT id, name, prefix, scopes_json, revoked_at, created_at FROM tokens").all() // no hashes: tokens not portable
            : db.prepare(`SELECT * FROM ${t}`).all();
    }
    audit("admin", actor(req).id, "export", {});
    return { exported_at: new Date().toISOString(), tables: dump };
  });
}

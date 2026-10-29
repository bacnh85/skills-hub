import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, audit } from "../db.ts";
import { importFromUrl } from "../ingest/import.ts";
import { parseSource } from "../ingest/fetchers.ts";
import { adminGuard } from "../auth.ts";

export function registerOpsRoutes(app: FastifyInstance) {
  app.register(async (scope) => {
    scope.addHook("preHandler", adminGuard);
    registerOpsInner(scope);
  });
}

function registerOpsInner(app: FastifyInstance) {
  // ---------- sources ----------
  app.get("/api/sources", async () => db.prepare("SELECT * FROM sources ORDER BY id DESC").all());

  app.post("/api/sources", async (req, reply) => {
    const p = z
      .object({ url: z.string().min(4), auto_refresh_hours: z.number().nullable().default(null) })
      .parse(req.body);
    const parsed = parseSource(p.url);
    const r = db
      .prepare("INSERT INTO sources (url, kind, auto_refresh_hours) VALUES (?,?,?)")
      .run(p.url, parsed.kind, p.auto_refresh_hours);
    audit("admin", (req as any).actor?.id ?? null, "source.create", { url: p.url, kind: parsed.kind });
    reply.code(201);
    return { id: Number(r.lastInsertRowid), kind: parsed.kind };
  });

  app.delete("/api/sources/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    audit("admin", (req as any).actor?.id ?? null, "source.delete", { id });
    return { ok: true };
  });

  // dry run: fetch + scan, store nothing
  app.post("/api/import/preview", async (req, reply) => {
    const p = z.object({ url: z.string().min(4) }).parse(req.body);
    try {
      const { fetchSource } = await import("../ingest/fetchers.ts");
      const { scanDir } = await import("../ingest/scanner.ts");
      const parsed = parseSource(p.url);
      const fetched = await fetchSource(parsed);
      try {
        const found = scanDir(fetched.dir);
        return found.map((f) => ({
          name: f.name,
          description: String(f.frontmatter.description ?? ""),
          version: String((f.frontmatter.metadata as any)?.version ?? f.frontmatter.version ?? ""),
          files: f.files.map((x) => x.path),
          security_flags: f.security_flags,
        }));
      } finally {
        fetched.cleanup();
      }
    } catch (e: any) {
      return reply.code(400).send({ error: String(e.message) });
    }
  });

  app.post("/api/sources/:id/run", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const src = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as any;
    if (!src) return reply.code(404).send({ error: "not found" });
    try {
      const { items } = await importFromUrl(src.url);
      db.prepare("UPDATE sources SET last_run_at = datetime('now'), last_status = ? WHERE id = ?").run(
        `ok: ${items.filter((i) => i.action !== "error" && i.action !== "skipped").length} imported`,
        id,
      );
      return { items };
    } catch (e: any) {
      db.prepare("UPDATE sources SET last_run_at = datetime('now'), last_status = ? WHERE id = ?").run(
        `error: ${String(e.message).slice(0, 200)}`,
        id,
      );
      return reply.code(400).send({ error: String(e.message) });
    }
  });

  app.post("/api/import/run", async (req, reply) => {
    const p = z.object({ url: z.string().min(4) }).parse(req.body);
    try {
      return await importFromUrl(p.url);
    } catch (e: any) {
      return reply.code(400).send({ error: String(e.message) });
    }
  });

  // ---------- AI jobs ----------
  app.post("/api/ai/jobs", async (req, reply) => {
    const p = z.object({ kind: z.enum(["categorize", "dedupe_review", "improve_descriptions"]), params: z.record(z.any()).default({}) }).parse(req.body);
    const r = db.prepare("INSERT INTO ai_jobs (kind, params_json) VALUES (?,?)").run(p.kind, JSON.stringify(p.params));
    audit("admin", (req as any).actor?.id ?? null, "ai.job.enqueue", { kind: p.kind });
    reply.code(201);
    return { id: Number(r.lastInsertRowid), status: "queued" };
  });

  app.get("/api/ai/jobs", async () =>
    db.prepare("SELECT id, kind, status, error, created_at FROM ai_jobs ORDER BY id DESC LIMIT 50").all(),
  );

  app.get("/api/ai/jobs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse((req as any).params);
    const job = db.prepare("SELECT * FROM ai_jobs WHERE id = ?").get(id) as any;
    if (!job) return reply.code(404).send({ error: "not found" });
    return { ...job, params: JSON.parse(job.params_json ?? "{}"), result: job.result_json ? JSON.parse(job.result_json) : null };
  });

  // apply an AI suggestion through normal REST semantics (AI never mutates directly)
  app.post("/api/ai/apply/categorize", async (req, reply) => {
    const p = z.object({ skill: z.string(), category: z.string(), create: z.boolean().default(false) }).parse(req.body);
    let cat = db.prepare("SELECT id FROM categories WHERE name = ?").get(p.category) as any;
    if (!cat) {
      if (!p.create) return reply.code(404).send({ error: `category '${p.category}' does not exist (pass create:true to make it)` });
      const r = db.prepare("INSERT INTO categories (name) VALUES (?)").run(p.category);
      cat = { id: Number(r.lastInsertRowid) };
    }
    db.prepare("UPDATE skills SET category_id = ? WHERE name = ?").run(cat.id, p.skill);
    audit("admin", (req as any).actor?.id ?? null, "ai.apply.categorize", p);
    return { ok: true };
  });

  app.post("/api/ai/apply/description", async (req, reply) => {
    const p = z.object({ version_id: z.number(), description: z.string().min(1).max(1024) }).parse(req.body);
    const v = db.prepare("SELECT id, frontmatter_json FROM skill_versions WHERE id = ?").get(p.version_id) as any;
    if (!v) return reply.code(404).send({ error: "version not found" });
    const fm = JSON.parse(v.frontmatter_json);
    fm.description = p.description;
    db.prepare("UPDATE skill_versions SET frontmatter_json = ? WHERE id = ?").run(JSON.stringify(fm), p.version_id);
    audit("admin", (req as any).actor?.id ?? null, "ai.apply.description", { version_id: p.version_id });
    return { ok: true };
  });
}

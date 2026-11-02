import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, audit } from "../db.ts";
import { importFromUrl } from "../ingest/import.ts";
import { parseSource } from "../ingest/fetchers.ts";
import { adminGuard } from "../auth.ts";
import { runChat, parseProposals } from "../ai/chat.ts";

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
          notes: f.notes,
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
    const parsed = z
      .object({ url: z.string().min(4), skills: z.array(z.string().min(1)).min(1).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const p = parsed.data;
    try {
      return await importFromUrl(p.url, null, p.skills);
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

  // ---------- AI chat (sessions persist in chat_messages; single admin) ----------
  const CONTEXT_TURNS = 20;
  const sessionIdSchema = z.string().min(8).max(64);
  const wireMessages = (sessionId: string) =>
    (db
      .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, CONTEXT_TURNS) as any[])
      .reverse()
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));

  app.post("/api/ai/chat", async (req, reply) => {
    const parsed = z
      .object({
        session_id: z.string().min(8).max(64).optional(),
        message: z.string().min(1).max(32000),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const p = parsed.data;
    const sessionId = p.session_id;
    // the turn is stored only after a successful completion — a failed AI call
    // never leaves a half-written exchange, and a retry can't duplicate the user row
    const context = sessionId
      ? [...wireMessages(sessionId), { role: "user" as const, content: p.message }]
      : [{ role: "user" as const, content: p.message }];
    try {
      const { reply: text, reasoning } = await runChat(context);
      const proposals = parseProposals(text);
      let messageId: number | null = null;
      if (sessionId) {
        db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?,?,?)").run(sessionId, "user", p.message);
        const r = db
          .prepare("INSERT INTO chat_messages (session_id, role, content, reasoning, proposals_json) VALUES (?,?,?,?,?)")
          .run(sessionId, "assistant", text, reasoning ?? null, proposals.length ? JSON.stringify(proposals.map((pr) => ({ ...pr, applied: false }))) : null);
        messageId = Number(r.lastInsertRowid);
      }
      audit("admin", (req as any).actor?.id ?? null, "ai.chat", { session_id: sessionId ?? null, turns: 1 });
      return { reply: text, ...(reasoning ? { reasoning } : {}), proposals, message_id: messageId };
    } catch (e: any) {
      return reply.code(502).send({ error: String(e.message) });
    }
  });

  app.get("/api/ai/chat/sessions", async () =>
    db
      .prepare(
        `SELECT session_id,
                substr(MIN(CASE WHEN role='user' THEN content END), 1, 60) AS title,
                COUNT(*) AS messages, MAX(created_at) AS last_at
         FROM chat_messages GROUP BY session_id ORDER BY MAX(id) DESC LIMIT 30`,
      )
      .all(),
  );

  app.get("/api/ai/chat/sessions/:id", async (req, reply) => {
    const parsed = sessionIdSchema.safeParse((req as any).params.id);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid id" });
    const id = parsed.data;
    const rows = db
      .prepare("SELECT id, role, content, reasoning, proposals_json FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 200")
      .all(id) as any[];
    if (!rows.length) return reply.code(404).send({ error: "session not found" });
    return {
      session_id: id,
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        reasoning: r.reasoning,
        proposals: r.proposals_json ? JSON.parse(r.proposals_json) : [],
      })),
    };
  });

  app.delete("/api/ai/chat/sessions/:id", async (req, reply) => {
    const parsed = sessionIdSchema.safeParse((req as any).params.id);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid id" });
    const id = parsed.data;
    db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
    audit("admin", (req as any).actor?.id ?? null, "ai.chat.session.delete", { session_id: id });
    return { ok: true };
  });

  // the UI marks proposals applied after each successful Apply (survives reloads;
  // re-applying any proposal is idempotent, so a lost marking can't corrupt anything)
  app.put("/api/ai/chat/messages/:id/proposals", async (req, reply) => {
    const parsedId = z.coerce.number().safeParse((req as any).params.id);
    if (!parsedId.success) return reply.code(400).send({ error: "invalid message id" });
    const id = parsedId.data;
    const parsed = z
      .object({
        proposals: z.array(
          z.object({
            action: z.enum(["set_category", "set_status", "set_tags", "set_description"]),
            skill: z.string().min(1),
            category: z.string().optional(),
            create: z.boolean().optional(),
            status: z.string().optional(),
            tags: z.array(z.string()).optional(),
            description: z.string().max(1024).optional(),
            applied: z.boolean().optional(),
          }),
        ).max(50),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    const p = parsed.data;
    const row = db.prepare("SELECT id FROM chat_messages WHERE id = ?").get(id);
    if (!row) return reply.code(404).send({ error: "message not found" });
    db.prepare("UPDATE chat_messages SET proposals_json = ? WHERE id = ?").run(JSON.stringify(p.proposals), id);
    audit("admin", (req as any).actor?.id ?? null, "ai.chat.proposals.update", { message_id: id });
    return { ok: true };
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

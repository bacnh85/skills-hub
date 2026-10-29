import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveVisibleSkills, getResolved, listVersionFiles, getVersionFile } from "../skills/service.ts";
import { resolveActor, requireAuth } from "../auth.ts";
import { db, usageRow } from "../db.ts";
import { config } from "../config.ts";
import { tarBuffer } from "../tar.ts";
import { gzipSync } from "node:zlib";

export function registerPublicRoutes(app: FastifyInstance) {
  // auth: bearer or ?token=; visibility enforced via assignments
  function guard(req: any, reply: any): boolean {
    const actor = resolveActor(req);
    if (!actor) {
      if (config.PUBLIC_SKILL_ACCESS) return true; // anonymous read allowed for published skills
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    req.actor = actor;
    return true;
  }

  // Only a client token is scoped. An admin id is NOT a token id — passing the
  // admin's row id here would silently scope admins to whichever client token
  // happens to share that number.
  function tokenIdOf(actor: { kind: string; id: number } | undefined): number | null {
    return actor?.kind === "token" ? actor.id : null;
  }

  function allowedForToken(tokenId: number | null, skillName: string): boolean {
    if (tokenId === null) return true; // admin or anonymous (guard() already checked auth)
    return resolveVisibleSkills(tokenId).some((s) => s.name === skillName);
  }

  function markdown(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
  }

  app.get("/s/:name/SKILL.md", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { name } = z.object({ name: z.string() }).parse((req as any).params);
    const actor = (req as any).actor as { kind: string; id: number } | undefined;
    if (!allowedForToken(tokenIdOf(actor), name))
      return reply.code(403).send({ error: "skill not assigned to this token" });
    const r = getResolved(name);
    if (!r) return reply.code(404).send({ error: "not found" });
    if (actor?.kind === "token") usageRow(actor.id, "http.get_skill", name, r.resolved.semver);
    reply.header("content-type", "text/markdown; charset=utf-8");
    return markdown(r.resolved.name, r.resolved.description, r.body);
  });

  app.get("/s/:name/:semver/SKILL.md", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { name, semver } = z.object({ name: z.string(), semver: z.string() }).parse((req as any).params);
    const actor = (req as any).actor as { kind: string; id: number } | undefined;
    if (!allowedForToken(tokenIdOf(actor), name)) return reply.code(403).send({ error: "skill not assigned" });
    const r = getResolved(name, semver);
    if (!r) return reply.code(404).send({ error: "not found" });
    reply.header("content-type", "text/markdown; charset=utf-8");
    return markdown(name, r.resolved.description, r.body);
  });

  function filesFor(name: string, version?: string): { path: string; data: Buffer }[] | null {
    const r = getResolved(name, version);
    if (!r) return null;
    const files = [
      {
        path: `${r.resolved.name}/SKILL.md`,
        data: Buffer.from(markdown(r.resolved.name, r.resolved.description, r.body), "utf8"),
      },
    ];
      for (const f of listVersionFiles(r.resolved.version_id)) {
        const c = getVersionFile(r.resolved.version_id, f.path);
        if (c) files.push({ path: `${r.resolved.name}/${f.path}`, data: Buffer.from(c.content) });
      }
    return files;
  }

  app.get("/s/:name.tgz", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { name } = z.object({ name: z.string() }).parse((req as any).params);
    const actor = (req as any).actor as { kind: string; id: number } | undefined;
    if (!allowedForToken(tokenIdOf(actor), name)) return reply.code(403).send({ error: "skill not assigned" });
    const files = filesFor(name);
    if (!files) return reply.code(404).send({ error: "not found" });
    if (actor?.kind === "token") usageRow(actor.id, "http.get_skill_tgz", name);
    reply.header("content-type", "application/gzip");
    return reply.send(gzipSync(tarBuffer(files)));
  });

  app.get("/c/:collection.tgz", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { collection } = z.object({ collection: z.string() }).parse((req as any).params);
    const col = db.prepare("SELECT id FROM collections WHERE name = ?").get(collection) as any;
    if (!col) return reply.code(404).send({ error: "collection not found" });
    const names = (
      db
        .prepare(
          "SELECT s.name FROM collection_items ci JOIN skills s ON s.id = ci.skill_id WHERE ci.collection_id = ? AND s.status = 'published' ORDER BY s.name",
        )
        .all(col.id) as any[]
    ).map((r) => r.name);
    const files: { path: string; data: Buffer }[] = [];
    for (const n of names) {
      const f = filesFor(n);
      if (f) files.push(...f);
    }
    if (files.length === 0) return reply.code(404).send({ error: "collection empty or not found" });
    reply.header("content-type", "application/gzip");
    return reply.send(gzipSync(tarBuffer(files)));
  });
}

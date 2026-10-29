import type { FastifyRequest, FastifyReply } from "fastify";
import { db, sha256 } from "./db.ts";

export interface AdminInfo {
  kind: "admin";
  id: number;
  name: string;
}

export interface TokenInfo {
  kind: "token";
  id: number;
  name: string;
  scopes: string[];
}

export type Actor = AdminInfo | TokenInfo;

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const q = req.query as Record<string, string> | undefined;
  if (q?.token) return q.token;
  return null;
}

function lookup(token: string): Actor | null {
  const hash = sha256(token);
  const admin = db.prepare("SELECT id, name FROM admins WHERE token_hash = ?").get(hash) as
    | { id: number; name: string }
    | undefined;
  if (admin) return { kind: "admin", id: admin.id, name: admin.name };
  const row = db
    .prepare("SELECT id, name, scopes_json, revoked_at FROM tokens WHERE token_hash = ?")
    .get(hash) as { id: number; name: string; scopes_json: string; revoked_at: string | null } | undefined;
  if (row && !row.revoked_at) {
    return { kind: "token", id: row.id, name: row.name, scopes: JSON.parse(row.scopes_json) };
  }
  return null;
}

function touch(actor: Actor) {
  if (actor.kind === "token") {
    db.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?").run(actor.id);
  }
}

export function resolveActor(req: FastifyRequest): Actor | null {
  const t = bearer(req);
  if (!t) return null;
  const actor = lookup(t);
  if (actor) touch(actor);
  return actor;
}

export function requireAuth(actor: Actor | null, scope?: string): actor is Actor {
  if (!actor) return false;
  if (actor.kind === "admin") return true;
  if (!scope) return actor.scopes.includes("skills:read");
  return actor.scopes.includes(scope);
}

export function hasScope(actor: Actor, scope: string): boolean {
  if (actor.kind === "admin") return true;
  return actor.scopes.includes(scope);
}

// preHandler factories for admin REST
export function adminGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const actor = resolveActor(req);
  if (!requireAuth(actor)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  (req as any).actor = actor;
  done();
}

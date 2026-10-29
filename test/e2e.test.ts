import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8901;
const AI_PORT = 8902;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "sk_e2e_admin_token";
const REPO = join(import.meta.dirname, "fixtures", "sample-skill-repo");

let dataDir: string;
let server: ChildProcess;
let aiStub: ChildProcess;

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready: ${url}`);
}

const api = async (path: string, opts: any = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sp-e2e-"));
  aiStub = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "ai-stub.ts"), String(AI_PORT)], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1200));
  server = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(dataDir, "test.db"),
      ADMIN_TOKEN: ADMIN,
      AI_BASE_URL: `http://localhost:${AI_PORT}/v1`,
      AI_MODEL: "stub",
    },
    stdio: "ignore",
  });
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  server?.kill();
  aiStub?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("1. auth: admin endpoints reject anonymous, accept the admin token", async () => {
  const anon = await fetch(`${BASE}/api/skills`);
  assert.equal(anon.status, 401);
  const ok = await api("/api/skills");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, []);
});

test("2. create category + skill, lint score recorded", async () => {
  const cat = await api("/api/categories", { method: "POST", body: JSON.stringify({ name: "dev" }) });
  assert.equal(cat.status, 201);

  const skill = await api("/api/skills", {
    method: "POST",
    body: JSON.stringify({
      name: "pdf-report",
      category_id: cat.body.id,
      description: "Create PDF reports from templates. Use when generating customer documents.",
      body: "# PDF Report\n\n1. Load template\n2. Render",
      files: [{ path: "references/api.md", content: "# API\nrender(opts)" }],
      semver: "1.0.0",
      publish: true,
    }),
  });
  assert.equal(skill.status, 201);
  assert.ok(skill.body.lint.score > 80, `lint score was ${skill.body.lint.score}`);

  const detail = await api("/api/skills/pdf-report");
  assert.equal(detail.body.status, "published");
  assert.equal(detail.body.current_semver, "1.0.0");
  assert.equal(detail.body.current.files.length, 1);
});

test("2b. tags: set via PATCH, normalized, searchable via /api/tags, filterable", async () => {
  const set = await api("/api/skills/pdf-report", {
    method: "PATCH",
    body: JSON.stringify({ tags: ["PDF", "reporting", "pdf"] }),
  });
  assert.equal(set.status, 200);
  const detail = await api("/api/skills/pdf-report");
  assert.deepEqual(detail.body.tags, ["pdf", "reporting"]); // deduped + lowercased

  const list = await api("/api/tags");
  assert.ok(list.body.some((t: any) => t.name === "pdf" && t.skill_count === 1));
  assert.ok(list.body.some((t: any) => t.name === "reporting"));

  const filtered = await api("/api/skills?tag=pdf");
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].name, "pdf-report");

  // remove one tag via PATCH, then check the list shrank
  await api("/api/skills/pdf-report", { method: "PATCH", body: JSON.stringify({ tags: ["pdf"] }) });
  const after = await api("/api/skills/pdf-report");
  assert.deepEqual(after.body.tags, ["pdf"]);

  const dup = await api("/api/tags", { method: "POST", body: JSON.stringify({ name: "pdf" }) });
  assert.equal(dup.status, 200); // idempotent
});

test("3. token assignment + version pinning resolution", async () => {
  const tok = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "proj-alpha", scopes: ["skills:read"] }) });
  assert.match(tok.body.token, /^ct_/);
  const id = tok.body.id;

  await api(`/api/tokens/${id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "category", target_id: 1, pin: "latest" }) });
  let prev = await api(`/api/tokens/${id}/preview`);
  assert.deepEqual(prev.body.map((p: any) => `${p.name}@${p.semver}`), ["pdf-report@1.0.0"]);

  // publish 1.1.0 (inherits description) -> latest pin follows
  const v2 = await api("/api/skills/pdf-report/versions", { method: "POST", body: JSON.stringify({ semver: "1.1.0", body: "# v1.1\n\nBetter rendering." }) });
  assert.equal(v2.status, 201);
  prev = await api(`/api/tokens/${id}/preview`);
  assert.deepEqual(prev.body.map((p: any) => p.semver), ["1.1.0"]);

  // exact pin beats the category's latest
  const sid = (await api("/api/skills/pdf-report")).body.id;
  await api(`/api/tokens/${id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "skill", target_id: sid, pin: "exact:1.0.0" }) });
  prev = await api(`/api/tokens/${id}/preview`);
  assert.deepEqual(prev.body.map((p: any) => `${p.semver}/${p.pin}`), ["1.0.0/exact:1.0.0"]);

  // major pin resolves the highest in that major
  await api(`/api/tokens/${id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "skill", target_id: sid, pin: "major:1" }) });
  prev = await api(`/api/tokens/${id}/preview`);
  assert.deepEqual(prev.body.map((p: any) => p.semver), ["1.1.0"]);
});

test("4. MCP: per-token visibility, 3-tier disclosure, write scope enforcement", async () => {
  const tokens = await api("/api/tokens");
  const proj = tokens.body.find((t: any) => t.name === "proj-alpha");

  // reissue a known-value token is impossible (hashed) — so create a fresh one
  const fresh = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "mcp-client", scopes: ["skills:read"] }) });
  const ct = fresh.body.token;
  await api(`/api/tokens/${fresh.body.id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "category", target_id: 1, pin: "latest" }) });

  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    return client;
  };

  // unauthenticated MCP is refused
  const anon = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(anon.status, 401);

  const client = await connect(ct);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t: any) => t.name).sort(), [
    "skills_create", "skills_get", "skills_get_file", "skills_list", "skills_search",
  ]);

  // tier 1: list is metadata only
  const list = await client.callTool({ name: "skills_list", arguments: {} });
  const listed = JSON.parse((list as any).content[0].text);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "pdf-report");
  assert.ok(!("body" in listed[0]), "tier 1 must not include the body");

  // tier 2: body + manifest
  const got = await client.callTool({ name: "skills_get", arguments: { name: "pdf-report" } });
  const gotText = (got as any).content[0].text;
  assert.match(gotText, /# PDF Report|Better rendering/);
  assert.match(gotText, /references\/api\.md/);

  // tier 3: a single bundled file
  const file = await client.callTool({ name: "skills_get_file", arguments: { name: "pdf-report", path: "references/api.md" } });
  assert.match((file as any).content[0].text, /render\(opts\)/);

  // traversal refused
  const bad = await client.callTool({ name: "skills_get_file", arguments: { name: "pdf-report", path: "../../etc/passwd" } });
  assert.match((bad as any).content[0].text, /Error/);

  // read-only token cannot write
  const denied = await client.callTool({ name: "skills_create", arguments: { name: "sneaky", description: "x y z", body_md: "# x" } });
  assert.match((denied as any).content[0].text, /skills:write/);

  await client.close();

  // write token -> pending -> approve -> visible
  const w = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "author", scopes: ["skills:read", "skills:write"] }) });
  const wc = await connect(w.body.token);
  const created = await wc.callTool({
    name: "skills_create",
    arguments: {
      name: "sql-query-writer",
      description: "Write optimized SQL with CTEs and window functions. Use when the user needs production queries.",
      body_md: "# SQL\n\nWrite CTEs.",
    },
  });
  assert.match((created as any).content[0].text, /PENDING/i);
  await wc.close();

  // pending visible to admin, not to clients
  const pending = await api("/api/versions/pending");
  assert.equal(pending.body.length, 1);
  const stillHidden = await api(`/api/tokens/${fresh.body.id}/preview`);
  assert.equal(stillHidden.body.length, 1, "pending version must not leak to clients");

  const approved = await api(`/api/versions/${pending.body[0].id}/approve`, { method: "POST", body: JSON.stringify({ make_current: true }) });
  assert.equal(approved.body.ok, true);

  // now assignable and visible
  const sid = (await api("/api/skills/sql-query-writer")).body.id;
  await api(`/api/tokens/${fresh.body.id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "skill", target_id: sid, pin: "latest" }) });
  const prev = await api(`/api/tokens/${fresh.body.id}/preview`);
  assert.equal(prev.body.length, 2);
});

test("4b. MCP with an ADMIN token is unscoped (sees the whole published catalog)", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } },
  });
  const client = new Client({ name: "e2e-admin", version: "1.0.0" });
  await client.connect(transport);
  const list = await client.callTool({ name: "skills_list", arguments: {} });
  const names = JSON.parse((list as any).content[0].text).map((s: any) => s.name);
  // every published skill, including ones no token is assigned to
  assert.ok(names.includes("pdf-report"), `admin should see pdf-report, got ${names.join(",")}`);
  assert.ok(names.includes("sql-query-writer"), `admin should see sql-query-writer, got ${names.join(",")}`);
  await client.close();
});

test("5. npx-skills interop: .tgz serves a valid tarball with SKILL.md", async () => {
  const tokens = await api("/api/tokens");
  const ct = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "tgz-client", scopes: ["skills:read"] }) })).body.token;
  const id = (await api("/api/tokens")).body.find((t: any) => t.name === "tgz-client").id;
  await api(`/api/tokens/${id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "category", target_id: 1, pin: "latest" }) });

  const res = await fetch(`${BASE}/s/pdf-report.tgz`, { headers: { authorization: `Bearer ${ct}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");

  const buf = Buffer.from(await res.arrayBuffer());
  const { list } = await import("tar");
  const dir = mkdtempSync(join(tmpdir(), "sp-tgz-"));
  const entries: string[] = [];
  await list({ file: "x.tgz", cwd: dir } as any).catch(() => {});
  // parse from buffer instead
  const { Readable } = await import("node:stream");
  const fs = await import("node:fs");
  const p = join(dir, "a.tgz");
  fs.writeFileSync(p, buf);
  await list({ file: p, cwd: dir, onReadEntry: (e: any) => entries.push(e.path) });
  assert.ok(entries.includes("pdf-report/SKILL.md"), `entries: ${entries.join(", ")}`);
  assert.ok(entries.some((e) => e.startsWith("pdf-report/references/")));
  rmSync(dir, { recursive: true, force: true });

  // markdown endpoint reflects assignment scoping
  const other = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "unassigned", scopes: ["skills:read"] }) })).body.token;
  const forbidden = await fetch(`${BASE}/s/pdf-report/SKILL.md`, { headers: { authorization: `Bearer ${other}` } });
  assert.equal(forbidden.status, 403);
});

test("5b. admin token is unscoped on the HTTP endpoints too (not confused with a client id)", async () => {
  // Regression: the routes passed the admin's row id where a *token* id was
  // expected, so an admin was scoped to whichever client token shared that number.
  const res = await fetch(`${BASE}/s/pdf-report/SKILL.md`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 200, "admin must be able to read any published skill");

  const tgz = await fetch(`${BASE}/s/pdf-report.tgz`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(tgz.status, 200, "admin must be able to download any published skill");

  // and a client token is still properly scoped
  const other = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "scoping-check", scopes: ["skills:read"] }) })).body.token;
  const denied = await fetch(`${BASE}/s/pdf-report/SKILL.md`, { headers: { authorization: `Bearer ${other}` } });
  assert.equal(denied.status, 403, "unassigned client token must be refused");
});

test("6. ingest: preview stores nothing, import gates flagged skills", async () => {
  const before = await api("/api/skills");
  const preview = await api("/api/import/preview", { method: "POST", body: JSON.stringify({ url: REPO }) });
  assert.equal(preview.status, 200);
  const names = preview.body.map((p: any) => p.name).sort();
  assert.deepEqual(names, ["good-skill", "sketchy-skill", "unversioned"]);

  const sketchy = preview.body.find((p: any) => p.name === "sketchy-skill");
  assert.ok(sketchy.security_flags.length > 0, "injection pattern must be flagged");
  assert.match(sketchy.security_flags.join(" "), /prompt-injection/);

  const afterPreview = await api("/api/skills");
  assert.equal(afterPreview.body.length, before.body.length, "preview must not store anything");

  const run = await api("/api/import/run", { method: "POST", body: JSON.stringify({ url: REPO }) });
  assert.equal(run.status, 200);
  const items = run.body.items;
  assert.equal(items.length, 3);
  const flagged = items.find((i: any) => i.skill === "sketchy-skill");
  assert.equal(flagged.pending, true, "flagged skill must wait for approval");
  const good = items.find((i: any) => i.skill === "good-skill");
  assert.equal(good.pending, false);

  const sketchySkill = await api("/api/skills/sketchy-skill");
  assert.equal(sketchySkill.body.status, "draft");
  assert.ok(sketchySkill.body.security_flags.length > 0);

  // idempotent re-import
  const again = await api("/api/import/run", { method: "POST", body: JSON.stringify({ url: REPO }) });
  assert.ok(again.body.items.every((i: any) => i.action === "skipped"), "unchanged content must not bump versions");
});

test("7. AI jobs run and suggestions apply through normal REST", async () => {
  const enq = await api("/api/ai/jobs", { method: "POST", body: JSON.stringify({ kind: "categorize" }) });
  assert.equal(enq.status, 201);

  let job: any = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = (await api(`/api/ai/jobs/${enq.body.id}`)).body;
    if (job.status === "done" || job.status === "error") break;
  }
  assert.equal(job.status, "done", `job ended ${job.status}: ${job.error ?? ""}`);
  assert.ok(job.result.suggestions.length > 0);

  const target = job.result.suggestions.find((s: any) => s.skill === "good-skill");
  const applied = await api("/api/ai/apply/categorize", { method: "POST", body: JSON.stringify({ skill: target.skill, category: target.category }) });
  assert.equal(applied.status, 200);
  const detail = await api("/api/skills/good-skill");
  assert.equal(detail.body.category, target.category);
});

test("8. every earlier action is in the audit log", async () => {
  const audit = await api("/api/audit?limit=200");
  const actions = audit.body.map((a: any) => a.action);
  for (const expected of ["skill.create", "skill.publish", "token.create", "assignment.set", "skill.version.approve", "ingest.import", "ai.job.enqueue", "ai.apply.categorize", "admin.bootstrap"]) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});

test("8b. delete: single + batch, assignments cleaned up", async () => {
  // scaffold: two skills, one collection, one skill-kind assignment
  const a = await api("/api/skills", { method: "POST", body: JSON.stringify({ name: "del-me-a", description: "x", body: "# A\n\nstep", semver: "0.1.0" }) });
  const b = await api("/api/skills", { method: "POST", body: JSON.stringify({ name: "del-me-b", description: "x", body: "# B\n\nstep", semver: "0.1.0" }) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const tok = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: "del-probe" }) });
  const skills = await api("/api/skills");
  const idA = skills.body.find((s: any) => s.name === "del-me-a").id;
  const idB = skills.body.find((s: any) => s.name === "del-me-b").id;
  await api(`/api/tokens/${tok.body.id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "skill", target_id: idA }) });
  await api("/api/collections", { method: "POST", body: JSON.stringify({ name: "del-pack", skill_ids: [idB] }) });

  // single delete removes the skill AND its skill-kind assignment
  const one = await api("/api/skills/del-me-a", { method: "DELETE", body: "{}" });
  assert.equal(one.status, 200);
  assert.equal((await api("/api/skills/del-me-a")).status, 404);
  const assigns = await api(`/api/tokens/${tok.body.id}/assignments`);
  assert.ok(!assigns.body.some((x: any) => x.kind === "skill" && x.target_id === idA), "skill assignment survived delete");

  // batch delete removes the rest and reports missing names
  const batch = await api("/api/skills/delete-batch", { method: "POST", body: JSON.stringify({ names: ["del-me-b", "del-me-ghost"] }) });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.body, { ok: true, deleted: 1, missing: ["del-me-ghost"], undo_id: batch.body.undo_id });
  assert.ok(Number.isInteger(batch.body.undo_id), "batch delete returns an undo id");
  const cols = await api("/api/collections");
  const pack = cols.body.find((c: any) => c.name === "del-pack");
  assert.ok(pack, "collection itself survives");
  assert.equal(pack.skill_ids.length, 0, "collection_items row should cascade away");

  // undo restores the skill, its version and its collection membership
  const undo = await api("/api/skills/undo-delete", { method: "POST", body: JSON.stringify({ undo_id: batch.body.undo_id }) });
  assert.equal(undo.status, 200);
  assert.deepEqual(undo.body, { ok: true, restored: ["del-me-b"], skipped: [] });
  assert.equal((await api("/api/skills/del-me-b")).status, 200);
  const pack2 = (await api("/api/collections")).body.find((c: any) => c.name === "del-pack");
  assert.equal(pack2.skill_ids.length, 1, "collection membership restored");
  const detail2 = await api("/api/skills/del-me-b");
  assert.ok(detail2.body.current?.body?.includes("step"), "version body survived delete+restore");

  // single delete + undo restores the token assignment too (del-me-b had none; give it one)
  await api(`/api/tokens/${tok.body.id}/assignments`, { method: "PUT", body: JSON.stringify({ kind: "skill", target_id: idB }) });
  const one2 = await api("/api/skills/del-me-b", { method: "DELETE", body: "{}" });
  assert.ok(Number.isInteger(one2.body.undo_id), "single delete returns an undo id");
  const undoB = await api("/api/skills/undo-delete", { method: "POST", body: JSON.stringify({ undo_id: one2.body.undo_id }) });
  assert.deepEqual(undoB.body, { ok: true, restored: ["del-me-b"], skipped: [] });
  const assigns2 = await api(`/api/tokens/${tok.body.id}/assignments`);
  assert.ok(assigns2.body.some((x: any) => x.kind === "skill" && x.target_id === idB), "skill assignment restored");

  // second undo of the same id is gone (window consumed)
  const undo2 = await api("/api/skills/undo-delete", { method: "POST", body: JSON.stringify({ undo_id: batch.body.undo_id }) });
  assert.equal(undo2.status, 404);

  // serving the restored skill works end to end (del-probe token holds the restored assignment)
  const tgz = await fetch(`${BASE}/s/del-me-b.tgz`, { headers: { authorization: `Bearer ${tok.body.token}` } });
  assert.equal(tgz.status, 200);
});

test("9. client-served endpoints honour PUBLIC_SKILL_ACCESS=false", async () => {
  const res = await fetch(`${BASE}/s/pdf-report/SKILL.md`);
  assert.equal(res.status, 401, "anonymous read must be refused when PUBLIC_SKILL_ACCESS is false");
});

#!/usr/bin/env node
// skills-hub CLI — two-way project/global skill sync.
//   sync    pull pinned manifest skills into .agents/skills/ (idempotent, never clobbers local edits)
//   push    publish changed local skills back to the hub (client tokens land pending approval)
//   status  local-vs-lock and manifest-vs-hub drift, no writes
// Transport is one function (callHub) so a REST fallback can replace MCP later.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import matter from "gray-matter";
import * as semver from "semver";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

interface Manifest {
  hub: string;
  skills: Record<string, string>; // name -> semver | "latest"
}
interface LockEntry {
  version: string;
  origin: string;
  files: Record<string, string>; // path -> sha256
}
type Lock = Record<string, LockEntry>;

// ---------- config ----------

function globalMode(flags: Set<string>) {
  return flags.has("--global");
}
function pathsFor(global: boolean, cwd: string) {
  const base = global ? join(process.env.HOME ?? "~", ".agents") : join(cwd, ".agents");
  return {
    skillsDir: join(base, "skills"),
    manifest: join(base, "skills.json"),
    lock: join(base, "skills.lock.json"),
  };
}
function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch (e: any) {
    fail(`${p} is not valid JSON: ${e.message}`);
  }
}
function loadManifest(p: paths): Manifest | null {
  const m = readJson<Manifest>(p.manifest);
  if (m && (!m.skills || typeof m.skills !== "object")) fail("manifest: 'skills' must be an object of name -> version");
  return m;
}

const TOKEN = process.env.HUB_TOKEN ?? "";
function requireToken() {
  if (!TOKEN) fail("no token: set HUB_TOKEN (create one on the hub's Tokens page; ct_… for clients, admin token for auto-publish)");
}

// ---------- transport (single swap point) ----------

async function callHub<T = any>(method: "GET", url: string): Promise<{ status: number; buf: Buffer }>;
async function callHub<T = any>(method: "MCP", tool: string, args: Record<string, unknown>): Promise<T>;
async function callHub(method: any, a: string, b?: Record<string, unknown>): Promise<any> {
  requireToken();
  if (method === "GET") {
    const u = new URL(a);
    u.searchParams.set("token", TOKEN);
    const res = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  }
  const hub = a; // MCP form: (a=hubUrl, b=toolArgs after tool name)
  throw new Error("unreachable");
}

async function callTool(hub: string, tool: string, args: Record<string, unknown>): Promise<string> {
  requireToken();
  const res = await fetch(`${hub.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (res.status === 401) fail("token rejected by hub (401)");
  if (!res.ok) fail(`hub MCP call failed: HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as any;
  const text = json?.result?.content?.[0]?.text;
  if (text === undefined) fail(`hub MCP returned no text: ${JSON.stringify(json).slice(0, 300)}`);
  if (/^Error:/i.test(text)) fail(text);
  return text;
}

async function fetchTgz(hub: string, name: string, version: string): Promise<Buffer> {
  const u = `${hub.replace(/\/$/, "")}/s/${encodeURIComponent(name)}/${encodeURIComponent(version)}.tgz`;
  const res = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (res.status === 401) fail(`token rejected (401) fetching ${name}@${version}`);
  if (res.status === 403) fail(`skill '${name}' is not assigned to this token`);
  if (res.status === 404) fail(`skill '${name}' version '${version}' not found on hub`);
  if (!res.ok) fail(`fetch ${name}@${version} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- local tree helpers ----------

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".DS_Store" || e.name.startsWith(".git")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of walkFiles(dir)) out[rel] = sha256(readFileSync(join(dir, rel)));
  return out;
}

// ---------- sync (pull) ----------

async function cmdSync(p: paths, hubUrl: string, manifest: Manifest, force: boolean, lock: Lock): Promise<number> {
  let failures = 0;
  let changed = false;
  // resolve "latest" pins once
  const listed = JSON.parse(await callTool(hubUrl, "skills_list", {})) as { name: string; version: string }[];
  for (const [name, pin] of Object.entries(manifest.skills ?? {})) {
    const target = pin === "latest" ? (listed.find((s) => s.name === name)?.version ?? fail(`skill '${name}' not visible to this token`)) : pin;
    const dir = join(p.skillsDir, name);
    const prev = lock[name];
    const localHashes = existsSync(dir) ? hashTree(dir) : null;

    // conflict guard: local edits vs lock — pull never clobbers work
    if (localHashes && prev && sha256OfFiles(localHashes) !== sha256OfFiles(prev.files) && !force) {
      console.log(`${name}  local changes (lock mismatch), skipped — run 'skills-hub push ${name}' or pass --force`);
      failures++;
      continue;
    }
    if (localHashes && prev && prev.version === target && sha256OfFiles(localHashes) === sha256OfFiles(prev.files)) {
      console.log(`${name}  ${target} ✓ (up to date)`);
      continue;
    }
    mkdirSync(p.skillsDir, { recursive: true });
    // download to temp, extract, then swap in — no half-writes
    const buf = await fetchTgz(hubUrl, name, target).catch((e) => {
      console.log(`${name}  ✗ ${e.message}`);
      failures++;
      return null;
    });
    if (!buf) continue;
    const tmp = mkdtempSync(join(tmpdir(), "hub-sync-"));
    const extracted = join(tmp, "extracted");
    try {
      const inner = gunzipSync(buf);
      // tar entries are rooted at <name>/ and carry no dir entries — extract
      // with strip:1 into a fresh dir (mkdirSync so tar.x can cd into it)
      mkdirSync(extracted, { recursive: true });
      await pipeline(Readable.from(inner), tar.x({ cwd: extracted, strip: 1 }));
      rmSync(dir, { recursive: true, force: true });
      renameSync(extracted, dir);
      const hashObj = hashTree(dir);
      lock[name] = { version: target, origin: hubUrl, files: hashObj };
      changed = true;
      console.log(`${name}  ${target} ✓`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (changed) writeFileSync(p.lock, JSON.stringify(lock, null, 2) + "\n");
  return failures;
}
const sha256OfFiles = (files: Record<string, string>) => sha256(JSON.stringify(Object.entries(files).sort()));

// ---------- push ----------

async function cmdPush(p: paths, hubUrl: string, names: string[], lock: Lock, manifest: Manifest | null): Promise<number> {
  if (!existsSync(p.skillsDir)) fail(`no skills dir at ${p.skillsDir}`);
  const all = readdirSync(p.skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(p.skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name);
  const targets = names.length ? names : all;
  let failures = 0;
  let manifestDirty = false;
  for (const name of targets) {
    if (!all.includes(name)) {
      console.log(`${name}  ✗ not a skill dir (missing SKILL.md) under ${p.skillsDir}`);
      failures++;
      continue;
    }
    const dir = join(p.skillsDir, name);
    const hashes = hashTree(dir);
    const prev = lock[name];
    const managed = !!prev;
    if (managed && sha256OfFiles(hashes) === sha256OfFiles(prev.files)) {
      console.log(`${name}  unchanged, skipped`);
      continue;
    }
    // parse SKILL.md
    let doc: matter.GrayMatterFile<any>;
    try {
      doc = matter(readFileSync(join(dir, "SKILL.md"), "utf8"));
    } catch (e: any) {
      console.log(`${name}  ✗ SKILL.md unreadable: ${e.message}`);
      failures++;
      continue;
    }
    const description = String(doc.data.description ?? "").trim();
    if (!description) {
      console.log(`${name}  ✗ SKILL.md frontmatter needs a description (hub lint rejects it otherwise)`);
      failures++;
      continue;
    }
    // bundle files (skip SKILL.md itself; skip binaries with a warning — hub strips them anyway)
    const files: { path: string; content: string }[] = [];
    for (const rel of walkFiles(dir)) {
      if (rel === "SKILL.md") continue;
      const buf = readFileSync(join(dir, rel));
      if (buf.includes(0)) {
        console.log(`${name}  ! skipped binary ${rel} (hub stores text files only)`);
        continue;
      }
      files.push({ path: rel, content: buf.toString("utf8") });
    }
    // publish: no version → hub patch-bumps (or 0.1.0 for new skills)
    let resultText: string;
    try {
      resultText = await callTool(hubUrl, "skills_create", {
        name,
        description,
        body_md: doc.content,
        files,
      });
    } catch (e: any) {
      console.log(`${name}  ✗ ${e.message}`);
      failures++;
      continue;
    }
    // "Skill 'x' v1.2.1 stored as PENDING|PUBLISHED …"
    const m = resultText.match(/v(\d+\.\d+\.\d+)/);
    const newVer = m?.[1];
    if (!newVer) {
      console.log(`${name}  ✗ unexpected hub reply: ${resultText.slice(0, 200)}`);
      failures++;
      continue;
    }
    lock[name] = { version: newVer, origin: hubUrl, files: hashes };
    if (manifest && !manifest.skills[name]) {
      manifest.skills[name] = newVer;
      manifestDirty = true;
    }
    const state = /PUBLISHED/.test(resultText) ? "published" : "pending approval";
    console.log(`${name}  → v${newVer} (${state})`);
  }
  writeFileSync(p.lock, JSON.stringify(lock, null, 2) + "\n");
  if (manifestDirty && manifest) writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + "\n");
  return failures;
}

// ---------- status ----------

async function cmdStatus(p: paths, hubUrl: string, manifest: Manifest | null, lock: Lock, json: boolean): Promise<void> {
  const out: Record<string, any> = { dirty: [], stale: [], pendingPush: [], ok: [] };
  if (manifest) {
    const listed = JSON.parse(await callTool(hubUrl, "skills_list", {})) as { name: string; version: string }[];
    for (const [name, pin] of Object.entries(manifest.skills ?? {})) {
      const dir = join(p.skillsDir, name);
      const prev = lock[name];
      const local = existsSync(dir) ? hashTree(dir) : null;
      if (local && prev && sha256OfFiles(local) !== sha256OfFiles(prev.files)) out.dirty.push(name);
      else if (!local) out.pendingPush.push(`${name} (not synced)`);
      else out.ok.push(`${name}@${prev?.version ?? "?"}`);
      const hub = listed.find((s) => s.name === name);
      if (hub && pin !== "latest" && hub.version !== pin) out.stale.push(`${name}: pinned ${pin}, hub ${hub.version}`);
      if (hub && pin === "latest" && prev && hub.version !== prev.version) out.stale.push(`${name}: lock ${prev.version}, hub ${hub.version}`);
    }
  }
  // unmanaged local skills = never pushed
  if (existsSync(p.skillsDir)) {
    for (const e of readdirSync(p.skillsDir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(p.skillsDir, e.name, "SKILL.md")) && !lock[e.name]) out.pendingPush.push(e.name);
    }
  }
  if (json) {
    console.log(JSON.stringify(out));
  } else {
    for (const d of out.dirty) console.log(`${d}  local changes unpushed`);
    for (const s of out.stale) console.log(`${s}  update available`);
    for (const s of out.pendingPush) console.log(`${s}  not tracked by hub`);
    for (const o of out.ok) console.log(`${o}  ✓`);
    if (!out.dirty.length && !out.stale.length && !out.pendingPush.length) console.log("clean");
  }
}

// ---------- entry ----------

function fail(msg: string): never {
  console.error(`skills-hub: ${msg}`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1).filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const cwd = process.cwd();
  const p = pathsFor(globalMode(flags), cwd);
  const manifest = loadManifest(p);
  const hubUrl = process.env.HUB_URL ?? manifest?.hub;
  if (!hubUrl && cmd && cmd !== "help") fail("no hub URL: set HUB_URL or add {\"hub\": …} to the manifest");
  const lock = readJson<Lock>(p.lock) ?? {};

  switch (cmd) {
    case "sync": {
      if (!manifest?.skills || !Object.keys(manifest.skills).length) fail(`no skills in manifest ${p.manifest} — add {"skills": {"name": "1.2.0"}}`);
      cmdSync(p, hubUrl!, manifest, flags.has("--force"), lock)
        .then((f) => process.exit(f ? 1 : 0))
        .catch((e) => fail(e.message));
      break;
    }
    case "push": {
      cmdPush(p, hubUrl!, rest, lock, manifest)
        .then((f) => process.exit(f ? 1 : 0))
        .catch((e) => fail(e.message));
      break;
    }
    case "status": {
      cmdStatus(p, hubUrl!, manifest, lock, flags.has("--json"))
        .catch((e) => fail(e.message));
      break;
    }
    default:
      console.log(`skills-hub — two-way skill sync with a skills-hub registry

usage:
  skills-hub sync    [--global] [--force]   pull manifest skills into .agents/skills/
  skills-hub push [names…] [--global]       publish changed skills (client tokens land pending)
  skills-hub status  [--global] [--json]    drift report, no writes

env: HUB_URL (or manifest "hub"), HUB_TOKEN (ct_… client or admin token)
manifest: ${p.manifest}   lock: ${p.lock}`);
      process.exit(cmd === "help" ? 0 : 1);
  }
}

interface paths {
  skillsDir: string;
  manifest: string;
  lock: string;
}

main();

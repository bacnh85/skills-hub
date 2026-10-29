# Self-Hosted Skills Portal (MCP Registry) — Implementation Plan

## Context

Many PCs, projects, and agents each keep their own copy of skills (SKILL.md folders); they drift, duplicate, and confuse clients. We build **one self-hosted portal** that (1) serves skills to any MCP-capable agent over streamable HTTP with per-token visibility, (2) has an admin web UI protected by admin tokens, (3) supports per-client-token assignment of categories/collections/individual skills with version pinning, (4) lets trusted client tokens write skills back through MCP (with admin approval), (5) runs AI jobs (categorize, dedupe-review, description improvements), and (6) ingests skills from external sources the way `npx skills` does (GitHub/GitLab/git URLs, direct SKILL.md/zip/tar URLs). Research summary is in `docs/research.md` (write it as step 0 so decisions stay grounded).

**Stack (decided):** single Node.js 22 + TypeScript service · Fastify (REST + static UI) · `@modelcontextprotocol/sdk` (streamable HTTP at `/mcp`) · SQLite via `better-sqlite3` (single-file DB, blobs in DB → one thing to back up) · vanilla no-build ES-module SPA for the admin UI · AI via any OpenAI-compatible chat completions endpoint (works with local Ollama/LM Studio). One process, one Dockerfile, one volume.

## Research-validated design decisions (from docs/research.md)

- **3-tier progressive disclosure** over MCP (agentskills.io / skills-mcp pattern): `skills_list`/`skills_search` return name+description+version only (~100 tokens/skill) → `skills_get` returns full SKILL.md + file manifest → `skills_get_file` returns one bundled file on demand. Scripts are NEVER executed server-side; they are served as text only.
- **Per-token filtering happens inside tool responses**, not via dynamic tool schemas — the tool list is static; the data is scoped. Declare `tools.listChanged: true` and emit `notifications/tools/list_changed` when an admin edits a token's assignments so live clients refresh.
- **Auth**: bearer tokens (admin + client) on REST and MCP. Full OAuth 2.1 is documented as the upgrade path but not built (private deployment; matches Open SSR's pragmatic pattern).
- **Immutable versions**: publishing never mutates a version row; a skill points at versions, tokens pin `latest` / `major-N` / exact semver.
- **`npx skills` interop — archives are `.tgz` only** (decision: `tar` + `node:zlib` createGzip; the CLI accepts `.tar.gz`/`.tgz`, so no zip dependency). The portal serves `GET /s/:name/SKILL.md`, `GET /s/:name.tgz`, `GET /s/:name/:semver.tgz`, and `GET /c/:collection.tgz`. (The CLI itself also accepts zip URLs from *other* sources; the portal simply never emits zip.)
- **Missing features found in research, added**: lint/conformance scoring (Skilldex idea), approval workflow for client writes, JSONL-style audit log (Open SSR idea), prompt-injection + secret scanning on ingest, usage telemetry, whole-registry export.

## Steps

### 0. Scaffold + research doc
1. `git init`, `package.json` (type: module, engines: node>=22), `tsconfig.json` (NodeNext, strict), install deps: `fastify`, `@fastify/static`, `@fastify/cors`, `better-sqlite3`, `gray-matter`, `zod`, `semver`, `@modelcontextprotocol/sdk`, `simple-git`, `tar`. Dev: `typescript`, `tsx`, `@types/node`, `@types/better-sqlite3`.
2. Write `docs/research.md` — condensed findings with source links (agentskills.io spec, vercel-labs/skills CLI reference, MCP auth + listChanged, skills-mcp, Open SSR, Skilldex paper).
3. `src/config.ts` — env config with zod: `PORT` (default 8787), `BASE_URL`, `DB_PATH` (default `./data/portal.db`), `ADMIN_TOKEN` (optional; if absent, generate on first boot, print once, store hash), `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`, `GITHUB_TOKEN`, `PUBLIC_SKILL_ACCESS` (default false).
4. `src/db.ts` — open SQLite, `PRAGMA journal_mode=WAL`, migrations table + `migrations/001_init.sql`. Schema:
   - `admins(id, name, token_hash UNIQUE, created_at)`
   - `categories(id, name UNIQUE, description)`
   - `skills(id, name UNIQUE, category_id NULL, current_version_id NULL, status: draft|published|deprecated, source: manual|ingest|client, created_at, updated_at)`
   - `skill_versions(id, skill_id, semver, body TEXT, frontmatter_json, lint_score INT, lint_report_json, status: pending|approved|rejected, author_kind: admin|token, author_token_id NULL, source_url NULL, created_at, UNIQUE(skill_id, semver))`
   - `skill_files(id, skill_version_id, path, content BLOB, sha256, size)` (paths restricted to `references/`, `assets/`, `scripts/`, no `..`, no symlinks at ingest time)
   - `collections(id, name UNIQUE, description)` + `collection_items(collection_id, skill_id)`
   - `tokens(id, name, token_hash UNIQUE, prefix (first 8 chars for display), scopes_json (["skills:read"], optionally "skills:write"), revoked_at NULL, last_used_at, created_at)`
   - `assignments(id, token_id, kind: category|collection|skill, target_id, pin: latest|major:N|exact semver, UNIQUE(token_id, kind, target_id))`
   - `sources(id, url, kind: github|git|direct, auto_refresh_hours NULL, last_run_at, last_status, enabled)`
   - `ai_jobs(id, kind: categorize|dedupe_review|improve_descriptions, params_json, status: queued|running|done|error, result_json, error NULL, created_at)`
   - `audit(id, ts, actor_kind: admin|token|system, actor_id, action, detail_json)`
   - `usage(id, ts, token_id, tool, skill_name NULL, skill_version NULL)`
5. `src/auth.ts` — `sha256(token)` lookup for `Authorization: Bearer sk_...` (admin) / `ct_...` (client). Fastify preHandler helpers `requireAdmin` / `requireClient(scope?)`; update `last_used_at`. Admin token created at first boot if env unset (format `sk_<32 hex>`, printed once).
6. `src/server.ts` — Fastify app assembly; `GET /healthz` open; `Dockerfile` (node:22-slim, `npm ci && npm run build`, CMD `node dist/server.js`, volume `/app/data`); `docker-compose.yml` (one service, one volume). `.gitignore` (`data/`, `node_modules`, `dist`).

### 1. Skill core: lint, CRUD REST, resolution
1. `src/skills/lint.ts` — `lintSkill(input): {score, report[]}` (no external linter): name rule (≤64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen), description present and 50–1024 chars with "when to use" heuristic, YAML frontmatter parses, recognized fields lowercase/unique, body non-empty, ≤500 lines warn, files ≤25 MiB total / ≤1000 files (mirror skills CLI limits). Score 0–100, diagnostics with line refs.
2. `src/skills/service.ts`:
   - `createSkill(adminInput)` / `publishVersion(skillName, {semver, body, files, sourceUrl, authorKind, authorTokenId})` — parse with `gray-matter`, lint, store version `pending` (client author) or `approved` (admin author); a version becomes visible to clients only when `approved` AND skill `published`. Publishing sets `skills.current_version_id` only for admin publishes; client versions wait for approval.
   - `resolveVisibleSkills(tokenId)` — the core assignment engine: collect assignments → for each target expand to skills (category → all its skills; collection → member skills; skill → itself) → dedupe by skill_id → for each, resolve concrete version from pin (`latest` → current_version_id; `major:N` → max semver with major N among approved; exact → that semver) → return `[{skill, version, files}]`. Skills with no resolvable version are skipped.
3. REST `/api` (admin-token protected, zod-validated): full CRUD for `skills` (create, edit category/status, list w/ filter+search, detail w/ versions+files+lint), `categories`, `collections` (+items), `versions` (approve/reject pending, set current, get by semver), `export` (GET /api/export → single JSON archive of the whole registry; POST /api/export/import to restore). Every mutation writes an `audit` row.

### 2. Client-serving endpoints + `npx skills` interop
`src/public/routes.ts` — token-gated (Bearer or `?token=`), archive routes serve **`.tgz` only** (tar + `node:zlib` createGzip; layout `<skill-name>/SKILL.md` + subdirs, matching CLI expectations):
   - `GET /s/:name/SKILL.md` (current approved version), `GET /s/:name/:semver/SKILL.md`
   - `GET /s/:name.tgz`, `GET /s/:name/:semver.tgz`, `GET /c/:collection.tgz`
   - If `PUBLIC_SKILL_ACCESS=true` these routes skip auth for `published` skills only.
   - Visibility check reuses `resolveVisibleSkills` — a token can only fetch skills it is assigned.

### 3. MCP server (per-token)
`src/mcp/server.ts` using `@modelcontextprotocol/sdk` `McpServer` + streamable HTTP mount at `/mcp` (and `/mcp?token=` fallback for header-less clients). Auth resolves the client token before the MCP handshake; unauthenticated → HTTP 401.
Tools (static list; data scoped per token):
1. `skills_list()` → `[{name, version, description, category}]` from `resolveVisibleSkills` — description only, progressive disclosure tier 1.
2. `skills_search(query)` → FTS5 match over name+description+frontmatter tags of the token's visible set (SQLite FTS5 virtual table maintained on publish; no embedding service — zero-dep, good enough at registry scale; embeddings are a documented upgrade path).
3. `skills_get(name, version?)` → full SKILL.md body + manifest of bundled files (`[{path, sha256, size}]`) — tier 2.
4. `skills_get_file(name, path, version?)` → single file content (text; scripts served as source, never executed) — tier 3.
5. `skills_create(name, description, body_md, files?)` → requires `skills:write` scope; lints, stores as **pending** version with `author_token_id`; returns lint score + "awaiting admin approval". (403 with clear message if scope missing.)
- Declare `tools: {listChanged: true}`; on admin approval / assignment change / publish, notify connected sessions (`server.sendToolListChanged()`).
- Every tool call writes a `usage` row (token, tool, skill, version) — telemetry for the dashboard.
- Version shown to clients is always the **resolved pinned approved** version — pending versions never leak.

### 4. Ingest from external sources (`npx skills`-like)
`src/ingest/` :
1. `fetchers.ts` — resolve a source to a local temp dir of skill folders:
   - GitHub `owner/repo` or full URL (incl. `/tree/main/skills/x` subpaths) → download tarball via `https://api.github.com/repos/{o}/{r}/tarball/{ref}` with optional `GITHUB_TOKEN` header (no git binary needed); GitLab → `{repo}/-/archive/{ref}.zip`… GitLab archives are zip → for GitLab/generic git URLs fall back to `simple-git` `git clone --depth 1` (documented prerequisite: git binary present; GitHub path works without it).
   - Direct URL to a single `SKILL.md` or `.zip`/`.tar`/`.tar.gz`/`.tgz` → fetch (10 MiB download / 25 MiB extracted / 1000 files caps, matching skills CLI defaults). (Ingest still *accepts* zip from external sources — only the portal's own served archives are tgz.)
   - Local path (admin-entered, same caps).
2. `scanner.ts` — walk temp dir for `*/SKILL.md`, parse frontmatter, collect sibling `references/ assets/ scripts/` files, run linter + **security scan**: reject binaries/oversize, flag prompt-injection heuristics (regex list: "ignore previous instructions", "disregard all", exfiltration-style URLs in scripts) and secret patterns (aws key, ghp_, sk-, PEM blocks) → flagged items import as `pending` with a `security_flags` list in lint_report even when lint score is high.
3. `import.ts` — for each found skill: create or add new version (semver from frontmatter `metadata.version` else `0.1.0`; if version exists, skip and report). Records `source_url`, writes audit, returns per-skill import report.
4. REST: `POST /api/sources` (add), `POST /api/sources/:id/run` (import now), `DELETE`, list with last status. In-process scheduler (`setInterval`, 60s tick) refreshes sources with `auto_refresh_hours` set — no cron dependency.
5. `GET /api/import/preview?url=...` — dry-run: fetch + scan + lint, return report WITHOUT storing (admin reviews before importing).
6. skills.sh discovery: `GET /api/discover?q=...` proxies `https://skills.sh/api/search?q=` (best-effort; if the public API shape differs, fall back to returning the CLI command `npx skills find <q>` as guidance — verify live during implementation).

### 5. AI jobs
`src/ai/` :
1. `client.ts` — single `chatComplete(messages, {json})` helper using `fetch` against `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` (OpenAI-compatible `/chat/completions`; works with Ollama). If unset, jobs fail fast with "AI not configured".
2. `jobs.ts` — in-process worker (poll `ai_jobs` every 5s):
   - `categorize`: for each uncategorized published skill, send name+description, ask JSON `{category, confidence, reason}` mapped against existing category names (or propose new).
   - `dedupe_review`: pairwise similarity via FTS + description overlap → AI confirms → report of `{skill_a, skill_b, verdict, reason}` suggestions.
   - `improve_descriptions`: for skills with lint-flagged vague descriptions, propose rewritten description (≤1024 chars, includes "use when" triggers).
   - **All AI output is advisory** — stored in `result_json`, surfaced in the UI as suggestions with Apply buttons that call the normal admin REST endpoints. AI never mutates directly.
3. REST: `POST /api/ai/jobs` (kind + optional params), `GET /api/ai/jobs` (list + results).

### 6. Admin web UI (no-build SPA)
1. Repo-root `DESIGN.md` (tokens: IBM Plex Sans + IBM Plex Mono via Google Fonts, paper `#F3F1EA` desk, ink `#22302A`, single forest accent `#1E6B50`, 8px spacing, radius 4/8, elevation sm/md only; direction: "a card catalog / ledger for agent skills, not a SaaS dashboard" — ruled table rows, mono numerals with `tabular-nums`, index-number signatures).
2. `public/` static ES modules served by `@fastify/static` at `/ui` (no build step, no framework): hash-routed views —
   - **Login** (paste admin token; localStorage; `401` handling)
   - **Dashboard**: counts (skills/versions/tokens/pending), recent audit, top-used skills (from `usage`)
   - **Skills**: filterable list (category/status/source), detail: frontmatter, body preview, version timeline (approve/reject/set-current), lint report, file browser, security flags
   - **Categories** & **Collections**: CRUD + membership editors
   - **Tokens**: create (shows full token ONCE), revoke, scope toggles (`skills:read`/`skills:write`), **assignment matrix** (rows = tokens, columns = categories/collections/skills, cell = pin policy select: latest/major-N/exact) + per-token "visible skills" preview (server endpoint `GET /api/tokens/:id/preview` → `resolveVisibleSkills` output) so admins see exactly what a client will see
   - **Sources**: add/run/schedule + preview-before-import + import reports
   - **AI**: run job, review suggestions, apply
   - **Audit**: filterable timeline
3. Every interactive element ships default/hover/focus-visible/active/disabled states; `prefers-reduced-motion` fallback for the one page-load reveal; loading + empty + error states per view (UX discipline, strict mode).
4. Client-connect snippet page per token: copyable config for Claude Code / Cursor / pi (`claude mcp add skills-portal --header "Authorization: Bearer ct_..." --transport http <BASE_URL>/mcp`) plus `npx skills add <BASE_URL>/s/<name>.tgz` example.

### 7. End-to-end verification
`test/e2e.test.ts` (node:test + tsx) — boots the server on a random port with a temp DB:
1. **Auth**: `/api/skills` without token → 401; with generated admin token → 200.
2. **CRUD+lint**: create category `dev`, create skill `pdf-report` v1.0.0 with body+one reference file → lint score >80, appears in `/api/skills`.
3. **Token assignment**: create client token (read only) assigned to category `dev` pin `latest` → `resolveVisibleSkills` (via `/api/tokens/:id/preview`) contains `pdf-report@1.0.0`; publish v1.1.0 → preview shows 1.1.0; reassign pin `exact:1.0.0` → preview shows 1.0.0.
4. **MCP**: connect with SDK `Client` + `StreamableHTTPClientTransport` + Bearer header → `skills_list` shows only assigned skill; `skills_get` returns body + manifest; `skills_get_file` returns the reference file; unassigned skill name → not found; `skills_create` with read-only token → tool error; with write token → pending version; admin approves via REST → `skills_list` reflects it after `listChanged`.
5. **Interop**: `GET /s/pdf-report.tgz` with token → 200, tar contains `pdf-report/SKILL.md`; simulate `npx skills add` by pointing the real CLI at the URL in a scratch dir (optional, network-permitting — assert the HTTP contract otherwise).
6. **Ingest**: `POST /api/import/preview` + `run` against `test/fixtures/sample-skill-repo/` (local path with 2 skills, one with an injection-pattern file) → 2 skills imported, flagged one pending with security_flags.
7. **AI job**: with `AI_BASE_URL` pointed at a stub server (node:test local http returning canned JSON) → categorize job completes with suggestions; apply suggestion via REST.
8. **Audit**: every step 2–7 action present in audit rows.
Manual UI check: run portal, screenshot `/ui` flows (login → tokens → matrix → skill detail), run `ux_audit` on the stylesheet — must pass before handoff.

## Critical files & anchors
- `src/db.ts` + `migrations/001_init.sql` — schema is the contract everything else reads
- `src/skills/service.ts` (`resolveVisibleSkills`, `publishVersion`) — the assignment/version engine
- `src/mcp/server.ts` — 5 tools, per-token scope + listChanged notifications
- `src/ingest/import.ts` (+ `scanner.ts` security scan) — external trust boundary
- `public/app.js` (+ `DESIGN.md`) — admin portal surface

## Verification (how "done" is proven)
`npm test` runs the e2e suite above (steps 1–8) against a live server instance — covers auth, assignment pinning, MCP visibility/scoping/teardown, interop archive, ingest scanning, AI apply, audit. Plus manual: `docker compose up` → login → import fixture repo → connect Claude Code with a client token → agent lists/loads a skill. `ux_audit` pass on the UI stylesheet is a handoff gate.

## Assumptions & contingencies
- **Single-instance SQLite** is fine (self-host, one node). If HA is ever needed → Postgres swap behind the service layer, not before.
- **skills.sh search API** may not be public/stable → if `GET /api/discover` proxying fails at implementation time, degrade to storing/returning CLI guidance (`npx skills find <q>`) and direct-URL import; direct import is the load-bearing feature.
- **GitLab zip archives**: zip extraction would need a dep (`extract-zip`) — instead GitLab/git-generic sources use `git clone --depth 1` via `simple-git`; GitHub (the dominant case) is tarball-only, no git binary required. If gitless GitLab import becomes a real need, add `extract-zip` then.
- **AI provider**: any OpenAI-compatible endpoint incl. local Ollama; if none configured, AI pages show a clear "not configured" empty state and everything else works.
- **FTS5** is compiled into better-sqlite3's default SQLite — if the bundled build lacks it (verify at boot with `SELECT fts5(?')` probe), fall back to LIKE-based search (same interface).
- **Embeddings/semantic search** deliberately out (YAGNI at registry scale); FTS5 now, documented upgrade path later.

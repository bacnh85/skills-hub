# Research: skill discovery over MCP, and what a central portal needs

Condensed notes backing the design decisions in this repo. All claims verified
against the sources linked below at implementation time.

## 1. What a skill is (the format we implement)

The open **Agent Skills** format ([agentskills.io](https://agentskills.io/),
spec repo [agentskills/agentskills](https://github.com/agentskills/agentskills)):
a directory containing `SKILL.md` — YAML frontmatter plus a markdown body —
and optional `scripts/`, `references/`, `assets/` siblings.

| Field | Required | Rule |
|---|---|---|
| `name` | yes | ≤64 chars, lowercase `[a-z0-9-]`, no leading/trailing/double hyphen, matches the directory name |
| `description` | yes | ≤1024 chars; must say **what it does and when to use it** |
| `license` | no | license name or bundled file reference |
| `compatibility` | no | ≤500 chars, environment requirements |
| `metadata` | no | arbitrary key/value (where we read `version` from on import) |
| `allowed-tools` | no | space-delimited, experimental across implementations |

Implementations ignore unknown top-level fields (forward compatibility) and
reject invalid YAML, duplicate recognized fields, or wrong field casing.
Bodies should stay under ~500 lines with detail moved into `references/`.

This is exactly what `src/skills/lint.ts` enforces — the "conformance score"
idea borrowed from the [Skilldex paper](https://arxiv.org/html/2604.16911v1),
which argues that a skill whose description is too vague to trigger reliably
is published identically to a well-formed one, and that no spec-grounded
quality signal existed. So we compute one on every publish/import.

## 2. Best practice for discovery over MCP: three-tier progressive disclosure

The consensus pattern (Anthropic's skills model, restated by
[Microsoft Agent Framework's MCP skills source](https://learn.microsoft.com/en-us/agent-framework/agents/skills),
[FastMCP's skills provider](https://gofastmcp.com/servers/providers/skills), and
[skills-mcp](https://github.com/Jignesh-Ponamwar/skills-mcp)) is four stages,
of which the last two are MCP calls:

1. **Advertise** — name + description only, ~100 tokens per skill, so the agent
   knows what exists without loading anything.
2. **Load** — full `SKILL.md` body on demand (<5000 tokens recommended).
3. **Read resources** — individual bundled files, only when the body mentions them.
4. **Run scripts** — execute a bundled script (we deliberately do **not** do this;
   see §6).

The measured claim from the upstream skills-mcp project is the important one: **embed only the
frontmatter** for search. Embedding full bodies pollutes the vector space with
instruction prose that was never meant to be queried.

Our implementation maps this onto five tools: `skills_list` (tier 1),
`skills_search` (tier 1, keyword), `skills_get` (tier 2, body + manifest),
`skills_get_file` (tier 3), `skills_create` (write path).

## 3. Per-client scoping is the gap in every existing registry

Surveyed self-hosted / open options:

| Project | Strengths | Missing vs. this brief |
|---|---|---|
| [skills-mcp](https://github.com/Jignesh-Ponamwar/skills-mcp) | semantic search, 7 tools, versioned skills, self-hostable | no per-token assignment, no write path, no AI, no ingest, Cloudflare/Qdrant-bound |
| [Open SSR](https://github.com/cobibean/shared-skills-registry-mcp) | self-hosted FastAPI + control panel, checksummed bundles, JSONL audit, install guardrails | **one shared token**, read-only registry, no AI, no crawl |
| [Skilldex](https://arxiv.org/html/2604.16911v1) | hierarchical scopes (global/shared/project), conformance scoring, skillsets | research code; no admin UI, AI, or ingest |
| [mcp-skill-hub](https://github.com/undermybelt/mcp-skill-hub), [GlobalSkillRegistry](https://github.com/IcanBENCHurCAT/GlobalSkillRegistry) | turn a skill dir into a registry; sync from git | no token model, no approval flow |

Conclusion: building is justified, and **per-token assignment is the feature
none of them has**. Two ideas we adopted from Skilldex: multi-level scoping
(here: skill > collection > category specificity) and *skillsets* (here:
collections — bundling skills that must stay mutually coherent).

Version pinning per token (`latest` / `major:N` / `exact:X.Y.Z`) is our answer
to "clients get confused when a skill changes under them" — the same instinct
as a lockfile.

## 4. Trust boundaries this design must respect

Four distinct ones, each handled explicitly:

1. **Admin vs. client** — separate token prefixes (`sk_` / `ct_`), both hashed
   at rest (SHA-256); plaintext shown once at creation.
2. **Client write vs. published state** — a token with `skills:write` can only
   *propose*. Versions land `pending`; an admin approves. Nothing a client
   writes reaches another client unapproved.
3. **External code vs. the registry** — anything ingested is untrusted. We scan
   for prompt-injection patterns (`ignore previous instructions`, `system
   prompt`, `curl … | sh`) and credential shapes (`AKIA…`, `ghp_…`, `sk-…`, PEM
   blocks). Flagged imports are forced to `draft` regardless of lint score.
4. **Script execution** — skills ship `scripts/`, but this server never executes
   them. `skills_get_file` returns source text only. Execution stays the
   client's decision, matching the CLI's own warning ("they run with full agent
   permissions").

MCP's own guidance ([authorization tutorial](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization))
recommends OAuth 2.1 with per-tool scopes and short-lived tokens. For a
private-network self-host, bearer tokens are the pragmatic step (Open SSR makes
the same call); OAuth 2.1 is the documented upgrade path, not a requirement.

## 5. Interop with the existing CLI ecosystem

The [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI
(`npx skills`) is the de-facto client. Its `add` command accepts:

- `owner/repo`, full GitHub/GitLab/Azure URLs, any git URL, local paths
- **a direct URL to a single `SKILL.md` or to a `.zip` / `.tar` / `.tar.gz` / `.tgz` archive**
  (10 MiB download / 25 MiB extracted / 1000 files, overridable)

That last line is why the portal serves `.tgz` archives and raw `SKILL.md`
paths: the standard CLI installs straight from the portal with no plugin and no
registry client. Verified end to end — `npx skills add <url>/s/pdf-report.tgz`
installed `SKILL.md` *and* the bundled `references/api.md`.

We emit **tgz only** (via a ~40-line ustar writer + `node:zlib`, no zip
dependency). Ingest still *accepts* zip from third-party sources.

## 6. Deliberate non-goals

- **No server-side script execution.** Unbounded code execution on the registry
  host would break trust boundaries 3 and 4 above.
- **No embedding service.** Search is keyword matching over the token's visible
  set, which is small by construction (that is the point of assignment). An
  embedding index is the documented upgrade if a single token ever needs to
  search thousands of skills.
- **No OAuth 2.1 / DCR.** Bearer tokens cover the private-deployment case;
  adding an authorization server is the upgrade when this becomes multi-tenant
  on the public internet.
- **No HA / multi-instance.** One SQLite file, one process, one volume — the
  self-host story stays "back up one directory".

## Sources

- Agent Skills spec & overview — https://agentskills.io/ · https://github.com/agentskills/agentskills
- Microsoft Agent Framework, skills (fields, progressive disclosure, MCP source) — https://learn.microsoft.com/en-us/agent-framework/agents/skills
- FastMCP, serving skills — https://gofastmcp.com/servers/providers/skills
- skills-mcp (3-tier architecture, frontmatter-only embeddings) — https://github.com/Jignesh-Ponamwar/skills-mcp
- Open SSR (self-hosted registry, control panel, audit, threat model) — https://github.com/cobibean/shared-skills-registry-mcp
- Skilldex (conformance scoring, hierarchical scopes, skillsets) — https://arxiv.org/html/2604.16911v1
- `npx skills` CLI reference (source formats, direct URL/archive install, caps) — https://github.com/vercel-labs/skills/blob/main/docs/commands.md
- MCP tools & `listChanged` — https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP authorization guidance (OAuth 2.1, least-privilege scopes) — https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization

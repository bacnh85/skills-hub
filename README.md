# Skills Hub

One self-hosted registry for agent skills (`SKILL.md` folders), served to any
MCP-capable agent with **per-token visibility**, plus an admin web UI with
AI-assisted organisation and `npx skills`-style importing.

- **MCP server** at `/mcp` — five tools, three-tier progressive disclosure
- **Admin web UI** at `/ui/index.html` — skills, categories, collections, tokens, sources, AI, audit
- **Client HTTP** — `GET /s/<name>/SKILL.md`, `GET /s/<name>.tgz`, `GET /c/<collection>.tgz`
- **One process, one SQLite file, one volume.** Node 22+, no native deps.

## Quick start

```bash
npm install
npm run build
npm start            # prints a generated admin token on first boot
```

Or with Docker:

```bash
docker compose up --build
```

Open `http://localhost:8787/ui/index.html` and paste the admin token.

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `DB_PATH` | `./data/portal.db` | SQLite file (the whole registry) |
| `ADMIN_TOKEN` | generated | fixed admin token; otherwise printed once at first boot |
| `PUBLIC_SKILL_ACCESS` | `false` | allow unauthenticated reads of published skills |
| `AI_BASE_URL` | — | OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1` for Ollama) |
| `AI_API_KEY` | — | optional |
| `AI_MODEL` | — | model name for the configured endpoint |
| `GITHUB_TOKEN` | — | raises GitHub API limits and enables private repos |

## Connect an agent

```bash
claude mcp add skills-hub --transport http \
  --header "Authorization: Bearer ct_…" \
  http://localhost:8787/mcp
```

Or install a skill directly with the standard CLI — no plugin needed:

```bash
npx skills add http://localhost:8787/s/pdf-report.tgz?token=ct_…
```

## Tokens and what a client sees

Issue one token per project or machine. A token sees **only** what you assign:

- a **category** (all its skills), a **collection** (a named bundle), or a **single skill**
- each assignment carries a version policy: `latest`, `major:N`, or `exact:X.Y.Z`
- when several apply, the most specific wins: **skill > collection > category**

The token detail page shows a live "what this token sees" preview, so you never
have to guess what an agent will get.

Tokens with `skills:write` can propose skills over MCP. Proposals are stored
**pending** and stay invisible until an admin approves them.

## Importing skills

Sources accept what `npx skills` accepts: `owner/repo`, GitHub/GitLab URLs
(including `/tree/<ref>/<subpath>`), direct `.tgz` URLs, and local paths.

Every import is scanned before it lands:

- malformed frontmatter is rejected outright by the linter (score + diagnostics)
- prompt-injection and credential patterns force the skill to `draft` with flags visible on its record
- re-importing unchanged content is a no-op (no version churn)

Use **Preview only** to inspect a source without storing anything.

## MCP tools

| Tool | Tier | Purpose |
|---|---|---|
| `skills_list` | 1 | name, version, description of assigned skills |
| `skills_search` | 1 | keyword match over your visible set |
| `skills_get` | 2 | full `SKILL.md` + bundled-file manifest |
| `skills_get_file` | 3 | one `references/`, `assets/` or `scripts/` file (text; never executed) |
| `skills_create` | — | propose a skill/version (requires `skills:write`; lands pending) |

## AI desk

Runs advisory jobs against your configured model: sort uncategorised skills into
categories, review duplicate pairs, rewrite weak descriptions. Results are
proposals in the UI with explicit Apply buttons — the model never mutates the
registry directly.

## Develop

```bash
npm run dev     # tsx, no build step
npm test        # 9 end-to-end tests against a live server
```

Design system: [`DESIGN.md`](DESIGN.md). Research notes and the reasoning behind
each trust boundary: [`docs/research.md`](docs/research.md).

## Use it from pi (or any MCP client)

`.pi/mcp.json.example` is a ready config for [pi](https://pi.dev). Copy it to
`.pi/mcp.json` and set the token:

```bash
cp .pi/mcp.json.example .pi/mcp.json
sed -i '' "s/\${SKILLS_MCP_TOKEN}/$(grep ^ADMIN_TOKEN= .env | cut -d= -f2)/" .pi/mcp.json
pi mcp list        # expect: skills-hub: connected, 5 tools
```

`.pi/mcp.json` is gitignored because it holds a token. Pi only loads a project
MCP config after the project is trusted: run `/trust` once in an interactive
session (it saves the decision to `~/.pi/agent/trust.json`), start with
`pi --approve` for a one-off, or set `defaultProjectTrust: "always"` to skip the
prompt. Run `/reload` after changing servers — connections are established at
session start, so a server added mid-session is not callable until then.

`exposure` is set to `direct` so the model sees all five tools without a
`tool_search` round trip. Switch it to `deferred` to keep the context lean and
load them on demand.

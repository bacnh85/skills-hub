import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  resolveVisibleSkills,
  resolveAllPublished,
  getResolved,
  listVersionFiles,
  getVersionFile,
  publishVersion,
  approveVersion,
} from "../skills/service.ts";
import { deleteSkills, undoDelete, updateSkillMeta } from "../skills/manage.ts";
import { hasScope, type Actor } from "../auth.ts";
import { db, usageRow } from "../db.ts";
import * as semver from "semver";

const PKG_VERSION = "0.1.0";

function buildMcpServer(actor: Actor): McpServer {
  const server = new McpServer(
    { name: "skills-hub", version: PKG_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  const tokenId = actor.kind === "token" ? actor.id : null;
  // admin sessions are unscoped: they see the whole published catalog
  const visible = () =>
    tokenId === null ? resolveAllPublished() : resolveVisibleSkills(tokenId);
  const denied = (tool: string, name?: string) => {
    usageRow(tokenId, `${tool}:denied`, name);
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: your token does not have skills:write scope. Ask the hub admin to grant it.",
        },
      ],
    };
  };

  server.tool(
    "skills_list",
    "List skills assigned to your token (name + description only)",
    {},
    async () => {
      usageRow(tokenId, "skills_list");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              visible().map((s) => ({
                name: s.name,
                version: s.semver,
                description: s.description,
                category: s.category,
                tags: s.tags,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "skills_search",
    "Search your assigned skills by keyword",
    { query: z.string() },
    async ({ query }) => {
      usageRow(tokenId, "skills_search");
      const q = query.toLowerCase();
      const hits = visible().filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category?.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)) ||
          JSON.stringify(s.frontmatter.metadata ?? {})
            .toLowerCase()
            .includes(q),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              hits.map((s) => ({
                name: s.name,
                version: s.semver,
                description: s.description,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "skills_get",
    "Get the full SKILL.md instructions and file manifest for a skill",
    {
      name: z.string(),
      version: z
        .string()
        .optional()
        .describe(
          "pin a specific version; default is your token's resolved version",
        ),
    },
    async ({ name, version }) => {
      usageRow(tokenId, "skills_get", name, version);
      if (tokenId !== null && !visible().some((s) => s.name === name)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: skill '${name}' is not assigned to your token`,
            },
          ],
        };
      }
      const r = getResolved(name, version);
      if (!r)
        return {
          content: [{ type: "text", text: `Error: skill '${name}' not found` }],
        };
      const manifest = listVersionFiles(r.resolved.version_id);
      return {
        content: [
          {
            type: "text",
            text: `# ${r.resolved.name} v${r.resolved.semver}\n\n${r.body}\n\n## Bundled files (use skills_get_file to read)\n${
              manifest.length
                ? manifest
                    .map(
                      (f) =>
                        `- ${f.path} (${f.size} bytes, sha256 ${f.sha256})`,
                    )
                    .join("\n")
                : "(none)"
            }`,
          },
        ],
      };
    },
  );

  server.tool(
    "skills_get_file",
    "Read one bundled file (references/, assets/, scripts/) of a skill",
    { name: z.string(), path: z.string(), version: z.string().optional() },
    async ({ name, path, version }) => {
      usageRow(tokenId, "skills_get_file", name, version);
      if (tokenId !== null && !visible().some((s) => s.name === name)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: skill '${name}' is not assigned to your token`,
            },
          ],
        };
      }
      const r = getResolved(name, version);
      if (!r)
        return {
          content: [{ type: "text", text: `Error: skill '${name}' not found` }],
        };
      // any bundled file is readable, but never escape the bundle
      if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
        return { content: [{ type: "text", text: `Error: invalid path` }] };
      }
      const f = getVersionFile(r.resolved.version_id, path);
      if (!f)
        return {
          content: [
            {
              type: "text",
              text: `Error: file '${path}' not found in ${name}`,
            },
          ],
        };
      return { content: [{ type: "text", text: f.content.toString("utf8") }] };
    },
  );

  server.tool(
    "skills_create",
    "Propose a new skill or a new version (stored as pending until an admin approves)",
    {
      name: z.string().describe("skill name: lowercase [a-z0-9-]"),
      description: z
        .string()
        .describe("what the skill does and when to use it"),
      body_md: z
        .string()
        .describe("SKILL.md instructions (markdown, without frontmatter)"),
      version: z
        .string()
        .optional()
        .describe(
          "semver; defaults to a patch bump of the latest approved version",
        ),
      files: z
        .array(z.object({ path: z.string(), content: z.string() }))
        .optional(),
    },
    async ({ name, description, body_md, version, files }) => {
      if (!hasScope(actor, "skills:write")) {
        usageRow(tokenId, "skills_create:denied", name);
        return {
          content: [
            {
              type: "text",
              text: "Error: your token does not have skills:write scope. Ask the hub admin to grant it.",
            },
          ],
        };
      }
      // resolve default version
      let v = version;
      if (!v) {
        const s = db
          .prepare("SELECT id FROM skills WHERE name = ?")
          .get(name) as any;
        if (s) {
          const last = db
            .prepare(
              "SELECT semver FROM skill_versions WHERE skill_id = ? ORDER BY id DESC LIMIT 1",
            )
            .get(s.id) as any;
          v = last ? (semver.inc(last.semver, "patch") ?? "0.1.0") : "0.1.0";
        } else {
          v = "0.1.0";
        }
      }
      // Attribute the write to whoever actually made it: an admin session writes
      // as an admin (auto-approved, like the REST API); a client token writes
      // as a client and lands pending until an admin approves it.
      const asAdmin = actor.kind === "admin";
      const r = publishVersion({
        skillName: name,
        semver: v,
        body: body_md,
        frontmatter: { description },
        files: files?.map((f) => ({ path: f.path, content: f.content })),
        authorKind: asAdmin ? "admin" : "token",
        authorTokenId: asAdmin ? undefined : (tokenId ?? undefined),
        source: asAdmin ? "manual" : "client",
        createIfMissing: true,
      });
      usageRow(tokenId, "skills_create", name, v);
      if (!r.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${r.error}\n${(r.lint?.report ?? []).map((d) => `- [${d.level}] ${d.field ?? ""}: ${d.message}`).join("\n")}`,
            },
          ],
        };
      }
      const state = asAdmin ? "PUBLISHED" : "PENDING";
      const tail = asAdmin
        ? "The admin session published it immediately."
        : "An admin must approve it before clients can see it.";
      return {
        content: [
          {
            type: "text",
            text: `Skill '${name}' v${v} stored as ${state} (lint score ${r.lint?.score}/100). ${tail}`,
          },
        ],
      };
    },
  );

  if (hasScope(actor, "skills:write")) {
    server.tool(
      "skills_update",
      "Update a skill's status and/or tags",
      {
        name: z.string(),
        status: z.enum(["draft", "published", "deprecated"]).optional(),
        tags: z
          .array(z.string().min(1).max(48))
          .optional()
          .describe("replaces the full tag set"),
      },
      async ({ name, status, tags }) => {
        if (!hasScope(actor, "skills:write"))
          return denied("skills_update", name);
        usageRow(tokenId, "skills_update", name);
        if (!status && !tags)
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: skills_update only changes status and/or tags — to edit body or description, create a new version with skills_create",
              },
            ],
          };
        const ok = updateSkillMeta(name, { status, tags }, actor.id);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Skill '${name}' updated.`
                : `Error: skill '${name}' not found`,
            },
          ],
        };
      },
    );

    server.tool(
      "skills_delete",
      "Delete skill(s) with snapshot; returns an undo_id usable with skills_undelete",
      { names: z.array(z.string().min(1)).min(1).max(200) },
      async ({ names }) => {
        if (!hasScope(actor, "skills:write"))
          return denied("skills_delete", names[0]);
        usageRow(tokenId, "skills_delete", names[0]);
        const r = deleteSkills(names, actor.id);
        return {
          content: [
            {
              type: "text",
              text: `Deleted: ${r.deleted.length ? r.deleted.join(", ") : "(none)"}${r.missing.length ? `\nNot found: ${r.missing.join(", ")}` : ""}\nundo_id: ${r.undo_id} (use skills_undelete)`,
            },
          ],
        };
      },
    );

    server.tool(
      "skills_undelete",
      "Restore skill(s) deleted via skills_delete, using the undo_id it returned",
      { undo_id: z.number() },
      async ({ undo_id }) => {
        if (!hasScope(actor, "skills:write")) return denied("skills_undelete");
        usageRow(tokenId, "skills_undelete");
        const r = undoDelete(undo_id, actor.id);
        if (!r)
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: undo window expired or undo_id ${undo_id} not yours`,
              },
            ],
          };
        return {
          content: [
            {
              type: "text",
              text: `Restored: ${r.restored.join(", ") || "(none)"}${r.skipped.length ? `\nSkipped: ${r.skipped.join(", ")}` : ""}`,
            },
          ],
        };
      },
    );

    server.tool(
      "skills_publish",
      "Publish a skill (sets status=published so assigned tokens can see it)",
      { name: z.string() },
      async ({ name }) => {
        if (!hasScope(actor, "skills:write"))
          return denied("skills_publish", name);
        usageRow(tokenId, "skills_publish", name);
        const ok = updateSkillMeta(name, { status: "published" }, actor.id);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Skill '${name}' published.`
                : `Error: skill '${name}' not found`,
            },
          ],
        };
      },
    );

    server.tool(
      "skills_unpublish",
      "Unpublish a skill (sets status=draft; clients stop seeing it, nothing is deleted)",
      { name: z.string() },
      async ({ name }) => {
        if (!hasScope(actor, "skills:write"))
          return denied("skills_unpublish", name);
        usageRow(tokenId, "skills_unpublish", name);
        const ok = updateSkillMeta(name, { status: "draft" }, actor.id);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Skill '${name}' unpublished (draft).`
                : `Error: skill '${name}' not found`,
            },
          ],
        };
      },
    );

    server.tool(
      "skills_approve_version",
      "Approve a pending skill version (admin session only)",
      { version_id: z.number(), make_current: z.boolean().default(true) },
      async ({ version_id, make_current }) => {
        if (actor.kind !== "admin") {
          usageRow(tokenId, "skills_approve_version:denied");
          return {
            content: [{ type: "text", text: "Error: admin session required." }],
          };
        }
        usageRow(tokenId, "skills_approve_version");
        const ok = approveVersion(version_id, make_current);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Version ${version_id} approved.`
                : `Error: version ${version_id} not found`,
            },
          ],
        };
      },
    );
  }

  return server;
}

export function registerMcp(app: FastifyInstance) {
  app.all("/mcp", async (req, reply) => {
    const { resolveActor } = await import("../auth.ts");
    const actor = resolveActor(req);
    if (!actor)
      return reply
        .code(401)
        .send({
          error:
            "unauthorized: pass a client token as Authorization: Bearer ct_... or ?token=",
        });

    const server = buildMcpServer(actor);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: data is scoped per request anyway
      enableJsonResponse: true,
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}

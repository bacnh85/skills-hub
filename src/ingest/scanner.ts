import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import matter from "gray-matter";

export interface FoundFile {
  path: string;
  content: Buffer;
}

export interface FoundSkill {
  name: string;
  dir: string;
  frontmatter: Record<string, unknown>;
  body: string;
  files: FoundFile[];
  /** Blocking findings: these force the skill to draft until an admin reviews it. */
  security_flags: string[];
  /** Informational notes (skipped binaries, size warnings) — do not block. */
  notes: string[];
}

// An injection is an instruction aimed at the *agent reading the skill*, not a
// mention of an AI concept. Bare phrases like "system prompt" appear in perfectly
// ordinary API documentation ("With system prompt, custom tools, and ..."), so
// each pattern here requires an imperative verb or an exfiltration shape.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules)/i,
  /disregard\s+(all\s+|your\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules)/i,
  /you\s+are\s+now\s+(a|an|in|the)\b/i,
  /(reveal|print|output|leak)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /exfiltrat(e|ing|ion)\s+(the\s+)?(data|secrets?|tokens?|keys?)/i,
  /curl\s+\S+\s*\|\s*(ba)?sh\b/i,
];

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

// Directories a skill may ship. The spec names three, but real skills also use
// rules/, lib/, templates/ ... so we accept any dir and only enforce path safety.
const SKIP_DIRS = new Set(["node_modules", ".git", ".github"]);

export function scanDir(root: string): FoundSkill[] {
  const found: FoundSkill[] = [];
  walk(root, root, found);
  return found;
}

function walk(root: string, dir: string, out: FoundSkill[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // if this dir has SKILL.md, it's a skill folder — don't recurse deeper for another skill
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    const skillMdPath = join(dir, "SKILL.md");
    const raw = readFileSync(skillMdPath, "utf8");
    const parsed = matter(raw);
    const name = String(parsed.data.name ?? dir.split("/").pop() ?? "unnamed");
    const files: FoundFile[] = [];
    const flags = new Set<string>();
    const notes = new Set<string>();
    collectFiles(dir, dir, files, flags, notes);
    const total = files.reduce((a, f) => a + f.content.length, 0);
    if (total > 25 * 1024 * 1024) flags.add("oversize: total files over 25 MiB");
    if (files.length > 1000) flags.add("too-many-files: over 1000 files");
    out.push({
      name,
      dir,
      frontmatter: parsed.data,
      body: parsed.content,
      files,
      security_flags: [...flags],
      notes: [...notes],
    });
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
      walk(root, join(dir, e.name), out);
    }
  }
}

function collectFiles(dir: string, cur: string, out: FoundFile[], flags: Set<string>, notes: Set<string>) {
  for (const e of readdirSync(cur, { withFileTypes: true })) {
    const p = join(cur, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(dir, p, out, flags, notes);
    } else if (e.isFile()) {
      const buf = readFileSync(p);
      const rel = relative(dir, p).split(sep).join("/");
      if (rel !== "SKILL.md") {
        if (buf.includes(0)) {
          // fonts, images and other binaries are ordinary skill assets
          notes.add(`binary asset kept: ${rel}`);
          continue;
        }
        const text = buf.toString("utf8");
        const hits = new Set<string>();
        for (const pat of INJECTION_PATTERNS) {
          if (pat.test(text)) hits.add(`prompt-injection detected in ${rel}`);
        }
        for (const hit of hits) flags.add(hit);
        for (const pat of SECRET_PATTERNS) {
          if (pat.test(text)) flags.add(`possible-secret in ${rel}`);
        }
      }
      out.push({ path: rel, content: buf });
    }
  }
}


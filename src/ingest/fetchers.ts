import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract } from "../zipstub.ts";

export interface FetchedSource {
  dir: string; // temp dir containing skill folders
  cleanup: () => void;
  kind: string;
}

export interface ParsedSource {
  kind: "github" | "git" | "direct" | "local";
  owner?: string;
  repo?: string;
  ref?: string;
  subpath?: string;
  url: string;
}

export function parseSource(url: string): ParsedSource {
  // shorthand owner/repo
  const short = url.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { kind: "github", owner: short[1], repo: short[2], url };
  if (url.startsWith("http")) {
    const gh = url.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)((?:\/.*)?))?\/?$/);
    if (gh) return { kind: "github", owner: gh[1], repo: gh[2], ref: gh[3], subpath: (gh[4] ?? "").replace(/^\//, "") || undefined, url };
    if (url.includes("github.com") || url.includes("gitlab.com")) return { kind: "git", url };
    return { kind: "direct", url };
  }
  return { kind: "local", url };
}

export async function fetchSource(parsed: ParsedSource): Promise<FetchedSource> {
  const dir = mkdtempSync(join(tmpdir(), "skills-ingest-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    if (parsed.kind === "github") {
      const ref = parsed.ref || "HEAD";
      const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${ref}`, {
        headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`github tarball fetch failed: ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 100 * 1024 * 1024) throw new Error("repo archive over 100 MiB");
      await pipeline(Readable.from(buf), tar.x({ cwd: dir }));
      // tarball extracts to <repo>-<sha>/ — flatten
      return { dir: flatten(dir), cleanup, kind: "github" };
    }
    if (parsed.kind === "git") {
      const { simpleGit } = await import("simple-git");
      await simpleGit().clone(parsed.url, dir, ["--depth", "1", "--single-branch"]);
      return { dir, cleanup, kind: "git" };
    }
    if (parsed.kind === "direct") {
      const res = await fetch(parsed.url);
      if (!res.ok) throw new Error(`direct fetch failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 10 * 1024 * 1024) throw new Error("download over 10 MiB cap");
      if (parsed.url.endsWith(".zip")) {
        extract(buf, dir);
        return { dir: flatten(dir), cleanup, kind: "direct" };
      }
      if (/\.t(ar\.)?gz$|\.tgz$/.test(parsed.url)) {
        await pipeline(Readable.from(buf), tar.x({ cwd: dir }));
        return { dir: flatten(dir), cleanup, kind: "direct" };
      }
      // assume single SKILL.md
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, "imported"), { recursive: true });
      writeFileSync(join(dir, "imported", "SKILL.md"), buf);
      return { dir, cleanup, kind: "direct" };
    }
    // local
    const { statSync, cpSync } = await import("node:fs");
    if (!statSync(parsed.url).isDirectory()) throw new Error(`local path '${parsed.url}' is not a directory`);
    cpSync(parsed.url, dir, { recursive: true });
    return { dir, cleanup, kind: "local" };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// if the extraction produced a single top-level dir, return path into it
function flatten(dir: string): string {
  const entries = readdirSync(dir);
  if (entries.length === 1 && statSync(join(dir, entries[0])).isDirectory()) {
    return join(dir, entries[0]);
  }
  return dir;
}

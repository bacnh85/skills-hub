export interface LintDiag {
  level: "error" | "warn";
  field?: string;
  line?: number;
  message: string;
}

export interface LintResult {
  score: number;
  ok: boolean;
  report: LintDiag[];
}

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function lintSkill(input: {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  files?: { path: string; size: number }[];
}): LintResult {
  const report: LintDiag[] = [];
  let score = 100;

  const penalize = (n: number, d: LintDiag) => {
    report.push(d);
    score -= n;
  };

  // name rule: <=64 chars, [a-z0-9-], no leading/trailing/double hyphen
  if (!input.name || input.name.length > 64) {
    penalize(20, { level: "error", field: "name", message: "name must be 1-64 characters" });
  } else if (!NAME_RE.test(input.name) || input.name.includes("--")) {
    penalize(20, {
      level: "error",
      field: "name",
      message: "name must be lowercase [a-z0-9-], no leading/trailing/double hyphen",
    });
  }

  // description: present, 50-1024 chars, contains "use when"/"use this"/"for" trigger heuristic
  const desc = String(input.frontmatter.description ?? "");
  if (!desc) {
    penalize(25, { level: "error", field: "description", message: "description is required" });
  } else {
    if (desc.length > 1024)
      penalize(10, { level: "warn", field: "description", message: "description over 1024 chars" });
    if (desc.length < 50)
      penalize(10, {
        level: "warn",
        field: "description",
        message: "description under 50 chars; add task keywords and 'use when' triggers",
      });
    if (!/use when|use this|for .{3,}|when .{3,}/i.test(desc))
      penalize(5, {
        level: "warn",
        field: "description",
        message: "add a 'Use when ...' trigger so agents can match tasks",
      });
  }

  // recognized frontmatter fields must be lowercase
  const recognized = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
  for (const k of Object.keys(input.frontmatter)) {
    if (recognized.some((r) => r.toLowerCase() === k.toLowerCase()) && !recognized.includes(k)) {
      penalize(10, { level: "error", field: k, message: `field '${k}' must be lowercase '${k.toLowerCase()}'` });
    }
  }

  // body: non-empty, <=500 lines
  const lines = input.body.split("\n").length;
  if (input.body.trim().length === 0) {
    penalize(25, { level: "error", field: "body", message: "SKILL.md body is empty" });
  } else if (lines > 500) {
    penalize(5, {
      level: "warn",
      field: "body",
      message: `body is ${lines} lines (>500); move detail to references/`,
    });
  }

  // files caps (mirror skills CLI: 25 MiB / 1000 files)
  if (input.files) {
    if (input.files.length > 1000)
      penalize(20, { level: "error", field: "files", message: "more than 1000 files" });
    const total = input.files.reduce((a, f) => a + f.size, 0);
    if (total > 25 * 1024 * 1024)
      penalize(20, { level: "error", field: "files", message: "total file size over 25 MiB" });
    for (const f of input.files) {
      const parts = f.path.split("/");
      if (f.path.startsWith("/") || f.path.includes("..") || parts[0] === "") {
        penalize(20, { level: "error", field: "files", message: `unsafe path '${f.path}'` });
      }
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { score, ok: report.every((d) => d.level !== "error"), report };
}

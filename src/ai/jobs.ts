import matter from "gray-matter";
import { db, audit } from "../db.ts";
import { config } from "../config.ts";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export async function chatComplete(messages: ChatMessage[], json = true): Promise<string> {
  if (!config.AI_BASE_URL) throw new Error("AI not configured: set AI_BASE_URL (OpenAI-compatible, e.g. http://localhost:11434/v1 for Ollama)");
  const res = await fetch(`${config.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.AI_API_KEY ? { authorization: `Bearer ${config.AI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: config.AI_MODEL ?? "default",
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- job kinds ----------

export async function runCategorize(): Promise<unknown> {
  const skills = db
    .prepare("SELECT s.id, s.name FROM skills s WHERE s.category_id IS NULL AND s.status != 'deprecated'")
    .all() as any[];
  const cats = (db.prepare("SELECT name FROM categories").all() as any[]).map((c) => c.name);
  if (skills.length === 0) return { suggestions: [], note: "no uncategorized skills" };
  const desc = (id: number) => {
    const s = db.prepare("SELECT current_version_id FROM skills WHERE id = ?").get(id) as any;
    if (!s?.current_version_id) return "";
    const v = db.prepare("SELECT frontmatter_json FROM skill_versions WHERE id = ?").get(s.current_version_id) as any;
    return String(JSON.parse(v.frontmatter_json).description ?? "");
  };
  const suggestions = [];
  for (const s of skills) {
    const out = await chatComplete([
      { role: "system", content: "You categorize agent skills. Reply with JSON only." },
      {
        role: "user",
        content: `Existing categories: ${JSON.stringify(cats)}\nSkill: ${s.name}\nDescription: ${desc(s.id)}\n\nReply JSON: {"category": "...", "new_category": true|false, "reason": "..."}. Prefer an existing category unless none fits.`,
      },
    ]);
    try {
      suggestions.push({ skill: s.name, skill_id: s.id, ...JSON.parse(out) });
    } catch {
      suggestions.push({ skill: s.name, skill_id: s.id, error: "unparseable AI response", raw: out.slice(0, 200) });
    }
  }
  return { suggestions };
}

export async function runDedupeReview(): Promise<unknown> {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, v.frontmatter_json FROM skills s
       JOIN skill_versions v ON v.id = s.current_version_id WHERE s.status = 'published'`,
    )
    .all() as any[];
  const skills = rows.map((r) => ({ id: r.id, name: r.name, description: String(JSON.parse(r.frontmatter_json).description ?? "") }));
  const pairs = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      const out = await chatComplete([
        { role: "system", content: "You compare agent skills for overlap. Reply with JSON only." },
        {
          role: "user",
          content: `Skill A: ${a.name} — ${a.description}\nSkill B: ${b.name} — ${b.description}\n\nReply JSON: {"duplicate": true|false, "reason": "..."}'. Duplicate means they teach substantially the same capability.`,
        },
      ]);
      try {
        const parsed = JSON.parse(out);
        if (parsed.duplicate) pairs.push({ skill_a: a.name, skill_b: b.name, reason: parsed.reason });
      } catch {
        // skip unparseable
      }
    }
  }
  return { duplicates: pairs, compared: (skills.length * (skills.length - 1)) / 2 };
}

export async function runImproveDescriptions(): Promise<unknown> {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, v.id AS vid, v.frontmatter_json, v.lint_report_json FROM skills s
       JOIN skill_versions v ON v.id = s.current_version_id WHERE s.status = 'published'`,
    )
    .all() as any[];
  const out = [];
  for (const r of rows) {
    const report = JSON.parse(r.lint_report_json ?? "[]");
    const descIssue = report.find((d: any) => d.field === "description");
    if (!descIssue) continue;
    const fm = JSON.parse(r.frontmatter_json);
    const suggested = await chatComplete([
      { role: "system", content: "You rewrite agent-skill descriptions. Reply with JSON only." },
      {
        role: "user",
        content: `Skill: ${r.name}\nCurrent description: ${fm.description ?? ""}\nIssue: ${descIssue.message}\n\nRewrite it: 50-1024 chars, specific about what it does and when to use it (include 'Use when ...' triggers). Reply JSON: {"description": "..."}`,
      },
    ]);
    try {
      out.push({ skill: r.name, version_id: r.vid, current: fm.description, issue: descIssue.message, ...JSON.parse(suggested) });
    } catch {
      out.push({ skill: r.name, version_id: r.vid, error: "unparseable AI response" });
    }
  }
  return { suggestions: out };
}

// ---------- worker ----------

let started = false;
export function startAiWorker() {
  if (started) return;
  started = true;
  const timer = setInterval(async () => {
    try {
      const job = db.prepare("SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as any;
      if (!job) return;
      db.prepare("UPDATE ai_jobs SET status = 'running' WHERE id = ?").run(job.id);
      try {
        const fn = job.kind === "categorize" ? runCategorize : job.kind === "dedupe_review" ? runDedupeReview : runImproveDescriptions;
        const result = await fn();
        db.prepare("UPDATE ai_jobs SET status = 'done', result_json = ? WHERE id = ?").run(JSON.stringify(result), job.id);
        audit("system", null, "ai.job.done", { job_id: job.id, kind: job.kind });
      } catch (e: any) {
        db.prepare("UPDATE ai_jobs SET status = 'error', error = ? WHERE id = ?").run(String(e.message).slice(0, 500), job.id);
      }
    } catch {
      // worker must never crash the process
    }
  }, 5000);
  timer.unref?.();
}

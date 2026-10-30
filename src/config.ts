import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  BASE_URL: z.string().default(""),
  DB_PATH: z.string().default("./data/portal.db"),
  ADMIN_TOKEN: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  PUBLIC_SKILL_ACCESS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export const config = Env.parse(process.env);

let baseUrl = config.BASE_URL;
export function getBaseUrl(): string {
  return baseUrl;
}
export function setBaseUrl(url: string) {
  baseUrl = url || `http://localhost:${config.PORT}`;
}

// ---- runtime-editable settings (settings table overrides env; no restart) ----
// ponytail: plain kv table, three known keys; a config framework would be bloat
import { db } from "./db.ts";

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string | null) {
  if (value === null || value === "") {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

export function aiConfig() {
  return {
    base_url: getSetting("ai_base_url") ?? config.AI_BASE_URL,
    api_key: getSetting("ai_api_key") ?? config.AI_API_KEY,
    model: getSetting("ai_model") ?? config.AI_MODEL,
  };
}

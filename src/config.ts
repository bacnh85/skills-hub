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

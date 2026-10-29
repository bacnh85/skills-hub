import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, setBaseUrl } from "./config.ts";
import { initDb, db, genToken, sha256, audit } from "./db.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { registerMcp } from "./mcp/server.ts";
import { registerOpsRoutes } from "./routes/ops.ts";
import { startAiWorker } from "./ai/jobs.ts";
import { startSourceScheduler } from "./routes/scheduler.ts";

const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });

await initDb(config.DB_PATH);

// first boot: create admin token (env or generated, printed once)
const adminRow = db.prepare("SELECT COUNT(*) n FROM admins").get() as { n: number };
if (adminRow.n === 0) {
  const token = config.ADMIN_TOKEN ?? genToken("sk");
  db.prepare("INSERT INTO admins (name, token_hash) VALUES (?,?)").run("admin", sha256(token));
  if (!config.ADMIN_TOKEN) {
    console.log("==============================================");
    console.log("Admin token (shown once, store it now):");
    console.log(token);
    console.log("==============================================");
  } else {
    console.log("Admin token from ADMIN_TOKEN env configured.");
  }
  audit("system", null, "admin.bootstrap", {});
}

await app.register(cors, { origin: true });
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
await app.register(fastifyStatic, { root: publicDir, prefix: "/ui/" });

app.get("/healthz", async () => ({ ok: true, time: new Date().toISOString() }));

registerAdminRoutes(app);
registerOpsRoutes(app);
registerPublicRoutes(app);
registerMcp(app);
startAiWorker();
startSourceScheduler();

const welcome = {
  name: "skills-hub",
  ui: "/ui/index.html",
  mcp: "/mcp (Authorization: Bearer ct_...)",
  health: "/healthz",
};

app.get("/", async () => welcome);

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    setBaseUrl(`http://localhost:${config.PORT}`);
    console.log(`skills-hub listening on :${config.PORT} — UI at /ui/index.html, MCP at /mcp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

// npm prepare hook: build dist/ when typescript is installed (git/npm installs,
// CI build stage) and exit cleanly when it isn't (docker runtime stage's
// `npm ci --omit=dev` also runs prepare, and tsc is a dev dependency).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (!existsSync(join(import.meta.dirname, "..", "node_modules", "typescript"))) {
  console.log("prepare: typescript absent, skipping build");
  process.exit(0);
}
const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc")], { stdio: "inherit" });
process.exit(r.status ?? 0);

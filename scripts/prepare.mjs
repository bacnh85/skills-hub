// npm prepare hook: build dist/ for source installs (npx github:…, npm install
// from git) but never inside the Dockerfile, where npm ci runs before
// tsconfig.json/src are copied. Condition: build only when tsconfig.json is
// present next to package.json AND typescript is installed.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "tsconfig.json")) || !existsSync(join(root, "src"))) {
  console.log("prepare: no tsconfig/src (deps-only install), skipping build");
  process.exit(0);
}
if (!existsSync(join(root, "node_modules", "typescript"))) {
  console.log("prepare: typescript not installed, skipping build");
  process.exit(0);
}
const r = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], {
  cwd: root,
  stdio: "inherit",
});
process.exit(r.status ?? 0);

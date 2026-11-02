// pi extension: two-way skill sync with a skills-hub registry.
// Install: cp pi-extension/skills-hub.ts ~/.pi/agent/extensions/
// Usage:   /hub            → sync, then reload so skills go live without restart
//          /hub push [n]   → publish changed local skills back to the hub
//          /hub status     → drift report
// Env:     HUB_URL, HUB_TOKEN (same as the CLI); the manifest at
//          .agents/skills.json pins the project's skill scope.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);

async function runCli(args: string[], cwd: string) {
  try {
    const { stdout } = await run("npx", ["--yes", "github:bacnh85/skills-hub", ...args], {
      cwd,
      env: process.env,
      timeout: 120_000,
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch (e: any) {
    return [`error: ${(e.stderr || e.stdout || e.message).toString().trim().split("\n").pop()}`];
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hub", {
    description: "Sync project skills with skills-hub (sync | push [names] | status), then reload",
    handler: async (args, ctx) => {
      const sub = args.trim() || "sync";
      ctx.ui.notify(`skills-hub ${sub}…`, "info");
      const lines = await runCli(sub.split(/\s+/), ctx.cwd);
      for (const l of lines.slice(-6)) ctx.ui.notify(l, l.startsWith("error") ? "error" : "info");
      if (sub === "sync" || sub.startsWith("push")) await ctx.reload(); // make new/updated skills live now
    },
  });

  // drift notice on session start — fire and forget, failures silent
  pi.on("session_start", async (_event, ctx) => {
    if (!existsSync(join(ctx.cwd, ".agents", "skills.json"))) return;
    const lines = await runCli(["status"], ctx.cwd);
    const interesting = lines.filter((l) => /unpushed|update available|not tracked/.test(l));
    if (interesting.length) ctx.ui.notify(`skills-hub: ${interesting.join("; ")}`, "info");
  });
}

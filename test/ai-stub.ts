// stub OpenAI-compatible server for AI job tests
import { createServer } from "node:http";

const canned: Record<string, unknown> = {
  categorize: { category: "dev", new_category: false, reason: "Development tooling" },
  dedupe: { duplicate: false, reason: "different capabilities" },
  improve: { description: "Format changelogs from git history into Keep a Changelog markdown. Use when the user asks for release notes or changelog entries." },
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const prompt = JSON.stringify(payload.messages ?? "");
    let content = canned.dedupe;
    if (prompt.includes("categoriz")) content = canned.categorize;
    else if (prompt.includes("Rewrite") || prompt.includes("rewrite")) content = canned.improve;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
});

const port = Number(process.argv[2] ?? 8799);
server.listen(port, () => console.log(`ai stub on :${port}`));

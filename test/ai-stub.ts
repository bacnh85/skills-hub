// stub OpenAI-compatible server for AI job tests
import { createServer } from "node:http";

const canned: Record<string, unknown> = {
  categorize: { category: "dev", new_category: false, reason: "Development tooling" },
  dedupe: { duplicate: false, reason: "different capabilities" },
  improve: { description: "Format changelogs from git history into Keep a Changelog markdown. Use when the user asks for release notes or changelog entries." },
};

const CHAT_MARKER = "Skills Hub catalog assistant";
const CHAT_REPLY =
  "Here's my plan.\n\n```json\n" +
  JSON.stringify([{ action: "set_category", skill: "good-skill", category: "dev", create: false }], null, 2) +
  "\n```";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const prompt = JSON.stringify(payload.messages ?? "");
    // chat branch: proves reasoning_effort reaches the wire + proposals survive the round trip
    const firstMsg = payload.messages?.[0]?.content ?? "";
    if (firstMsg.includes(CHAT_MARKER)) {
      const msg: Record<string, unknown> = { content: CHAT_REPLY };
      if (payload.reasoning_effort) msg.reasoning_content = `thinking at ${payload.reasoning_effort}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
      return;
    }
    let content = canned.dedupe;
    if (prompt.includes("categoriz")) content = canned.categorize;
    else if (prompt.includes("Rewrite") || prompt.includes("rewrite")) content = canned.improve;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
});

const port = Number(process.argv[2] ?? 8799);
server.listen(port, () => console.log(`ai stub on :${port}`));

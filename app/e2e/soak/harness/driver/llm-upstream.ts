// An OpenAI-compatible upstream for the LLM capture scenario: answers
// POST /v1/chat/completions with a chat.completion whose content is
// `--completion-bytes` long.
//
//   bun llm-upstream.ts 18082 [--completion-bytes 32768]
import { parseArgs } from "./rpc.ts";

const port = Number(process.argv[2] ?? "18082");
const args = parseArgs(process.argv.slice(3));
const content = "y".repeat(Number(args["completion-bytes"] ?? "32768"));

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") {
      return new Response("ok");
    }
    const body = (await req.json()) as { model?: string };
    return Response.json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "soak-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
  },
});

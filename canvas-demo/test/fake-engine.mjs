// A wire fixture, NOT the real Codex or DSH runtime. Uses a real local HTTP gateway.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import path from "node:path";
const engine = process.argv[2];
const send = (msg) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let endpoint, token;
if (engine === "dsh") {
  const rows = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--patch") + 1], "utf8"),
  );
  if (!rows.some((r) => r.id === "persistent-bash" && r.disabled))
    throw Error("Shell not disabled");
  endpoint =
    rows.find((r) => r.id === "llm-deepseek").config.baseURL +
    "/chat/completions";
  token = process.env.DEEPSEEK_API_KEY;
} else {
  const config = readFileSync(
    path.join(process.env.CODEX_HOME, "config.toml"),
    "utf8",
  );
  endpoint = JSON.parse(config.match(/base_url = (.+)/)[1]) + "/responses";
  token = process.env.CANVAS_GATEWAY_TOKEN;
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize")
    return send({
      id: msg.id,
      result: {
        serverInfo: {
          name: "deepseek-harness-sdk-runtime",
          version: "fixture",
        },
      },
    });
  if (msg.method === "thread/start")
    return send({ id: msg.id, result: { thread: { id: "thread" } } });
  const input = JSON.parse(
    engine === "dsh"
      ? msg.params.contentBlocks[0].text
      : msg.params.input[0].text,
  );
  const sessionId = msg.params.sessionId;
  if (input.instruction === "hang") return;
  const proposal = structuredClone(input.snapshot);
  const card = proposal.components.find(
    (c) => c.id === input.selectedComponent,
  );
  card.title = input.instruction.replace(/^标题：/, "");
  if (input.instruction === "invalid") card.title = 4;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      engine === "dsh"
        ? {
            model: "fixture",
            messages: [{ role: "user", content: JSON.stringify(input) }],
          }
        : {
            model: "fixture",
            store: false,
            input: [{ role: "user", content: JSON.stringify(input) }],
          },
    ),
  });
  if (!response.ok)
    return send({
      id: msg.id,
      error: { code: -1, message: "Gateway rejected fixture" },
    });
  await response.text();
  if (engine === "dsh") {
    // Notifications may precede the RPC response. An early idle must not finish the run.
    send({ method: "session.status", params: { sessionId, status: "idle" } });
    send({
      method: "session.event",
      params: {
        sessionId,
        event: {
          type: "agent/inbox/spliced",
          data: { inserted: [{ id: "message-1" }] },
        },
      },
    });
    send({
      method: "session.event",
      params: {
        sessionId: "foreign",
        event: {
          type: "assistant/message",
          data: {
            message: { content: [{ type: "text", text: "wrong session" }] },
          },
        },
      },
    });
    send({ id: msg.id, result: { messageId: "message-1" } });
    send({
      method: "session.event",
      params: {
        sessionId,
        event: {
          type: "assistant/message",
          data: {
            message: {
              content: [{ type: "text", text: JSON.stringify(proposal) }],
            },
          },
        },
      },
    });
    send({ method: "session.status", params: { sessionId, status: "idle" } });
  } else {
    send({ id: msg.id, result: { turn: { id: "turn" } } });
    send({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", text: JSON.stringify(proposal) },
      },
    });
    send({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
  }
});

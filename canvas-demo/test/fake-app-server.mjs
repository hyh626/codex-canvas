// Protocol fixture only: never a substitute for a live Codex/model test.
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize")
    send({ id: msg.id, result: { userAgent: "fixture" } });
  else if (msg.method === "thread/start")
    send({ id: msg.id, result: { thread: { id: "fixture-thread" } } });
  else if (msg.method === "turn/start") {
    const input = JSON.parse(msg.params.input[0].text);
    input.snapshot.components[0].title = "Protocol verified";
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", text: JSON.stringify(input.snapshot) },
      },
    });
    send({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
  }
});

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Store, validate } from "./store.mjs";
import { runEngine, engineCapabilities } from "./engine.mjs";
import { componentCommand } from "./commands.mjs";
import { createGateway } from "./gateway.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp({
  dir = path.join(here, ".data"),
  engineOptions = {},
  allowDsh = Boolean(
    process.env.DSH_BIN &&
    process.env.CANVAS_DSH_MODEL &&
    process.env.CANVAS_DSH_URL &&
    process.env.CANVAS_DSH_API_KEY,
  ),
  allowCodex = Boolean(
    process.env.CANVAS_MODEL &&
    process.env.CANVAS_RESPONSES_URL &&
    process.env.CANVAS_API_KEY,
  ),
} = {}) {
  const store = new Store(dir);
  const clients = new Set();
  const token = randomUUID();
  let busy = false;
  const broadcast = () => {
    for (const client of clients)
      client.write(`data: ${JSON.stringify(store.view())}\n\n`);
  };
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    const origin = `http://${host}`;
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (
        req.headers.host !== host &&
        req.headers.host !== `localhost:${server.address().port}`
      )
        return send(403, { error: "Invalid host" });
      if (
        req.headers.origin &&
        ![origin, origin.replace("127.0.0.1", "localhost")].includes(
          req.headers.origin,
        )
      )
        return send(403, { error: "Invalid origin" });
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/api/state")
        return send(200, {
          ...store.view(),
          token,
          codexEnabled: allowCodex,
          dshEnabled: allowDsh,
          engineCapabilities,
        });
      if (req.method === "GET" && url.pathname.startsWith("/api/event/")) {
        const event = store.events.find(
          (e) => e.event_id === url.pathname.slice(11),
        );
        if (!event) return send(404, { error: "Event not found" });
        return send(200, {
          event,
          ...(event.payload.delta
            ? { changes: store.get(event.payload.delta) }
            : {}),
          ...(event.payload.plan
            ? { reconstructed_request: store.rebuild(event.payload.plan) }
            : {}),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write(`data: ${JSON.stringify(store.view())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="canvas-trajectory.json"',
        );
        return send(200, store.export());
      }
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(url.pathname)
      ) {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.writeHead(200, {
          "Content-Type": file.endsWith("html")
            ? "text/html; charset=utf-8"
            : file.endsWith("js")
              ? "text/javascript"
              : "text/css",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
        });
        return res.end(fs.readFileSync(path.join(here, "public", file)));
      }
      if (req.method !== "POST") return send(404, { error: "Not found" });
      const supplied = Buffer.from(req.headers["x-canvas-token"] || "");
      if (
        supplied.length !== token.length ||
        !timingSafeEqual(supplied, Buffer.from(token))
      )
        return send(403, { error: "Invalid session token" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 32000)
          return send(413, { error: "Request too large" });
      }
      const data = JSON.parse(body);
      if (url.pathname === "/api/component") {
        const event = componentCommand(store, data);
        const beforeIds = new Set(
          store.get(event.payload.before).components.map((c) => c.id),
        );
        const newCard = store
          .get(event.payload.after)
          .components.find((c) => !beforeIds.has(c.id));
        broadcast();
        return send(200, {
          ...store.view(),
          selectedComponentId: newCard?.id || data.componentId,
        });
      }
      if (url.pathname === "/api/edit")
        store.commit({
          state: data.state,
          baseRevision: data.baseRevision,
          commandId: data.commandId,
        });
      else if (["/api/undo", "/api/redo"].includes(url.pathname))
        store.history(url.pathname.slice(5), data.baseRevision, data.commandId);
      else if (url.pathname === "/api/comment") {
        if (data.baseRevision !== store.revision)
          return send(409, { error: "Comment anchor revision changed" });
        if (
          !store.state.components.some((c) => c.id === data.componentId) ||
          !["title", "body"].includes(data.nodeId) ||
          typeof data.text !== "string" ||
          !data.text.trim() ||
          data.text.length > 2000
        )
          throw Error("Invalid comment");
        store.append(
          "comment.created",
          {
            component_id: data.componentId,
            node_id: data.nodeId,
            revision: store.revision,
            text: data.text,
          },
          "human",
        );
      } else if (url.pathname === "/api/agent") {
        if (busy)
          return send(409, { error: "An agent proposal is already running" });
        if (data.baseRevision !== store.revision)
          return send(409, { error: "Revision conflict" });
        if (
          typeof data.prompt !== "string" ||
          !data.prompt.trim() ||
          data.prompt.length > 2000 ||
          !["mock", "codex", "dsh"].includes(data.engine)
        )
          throw Error("Invalid agent request");
        if (data.engine === "codex" && !allowCodex)
          return send(422, {
            error:
              "Codex requires CANVAS_MODEL, CANVAS_RESPONSES_URL and CANVAS_API_KEY. Model requests must pass the audited HTTP gateway.",
          });
        if (data.engine === "dsh" && !allowDsh)
          return send(422, {
            error:
              "DSH requires DSH_BIN, CANVAS_DSH_MODEL, CANVAS_DSH_URL and CANVAS_DSH_API_KEY.",
          });
        busy = true;
        try {
          const baseRevision = store.revision;
          const snapshot = structuredClone(store.state);
          const message = store.append(
            "user.message",
            { text: data.prompt, component_id: data.componentId },
            "human",
          );
          const input = {
            snapshot,
            baseRevision,
            selectedComponent: data.componentId,
            instruction: data.prompt,
            recentChanges: store.events
              .filter((e) => e.type === "workspace.edit_committed")
              .slice(-3)
              .map((e) => ({
                revision: e.payload.revision,
                actor: e.actor,
                changes: e.payload.delta ? store.get(e.payload.delta) : [],
              })),
            recentComments: store.events
              .filter((e) => e.type === "comment.created")
              .slice(-6)
              .map((e) => e.payload),
          };
          if (Buffer.byteLength(JSON.stringify(input)) > 8000)
            throw Error(
              "Model context exceeds this demo’s 8 KB limit; reduce card content/comments before retrying.",
            );
          let proposal;
          if (data.engine === "mock") {
            const { request, event } = store.prepare(
              [{ role: "user", content: input }],
              data.capture === true,
            );
            proposal = structuredClone(request.input[0].content.snapshot);
            const c = proposal.components.find(
              (c) => c.id === data.componentId,
            );
            if (!c) throw Error("Select a component");
            if (/add|新增|添加/i.test(data.prompt))
              proposal.components.push({
                id: `card-${randomUUID().slice(0, 8)}`,
                title: "A new direction",
                body: "This component was added through the same commit pipeline.",
                color: "#0d9488",
              });
            else if (/color|颜色|紫|绿/i.test(data.prompt))
              c.color = c.color === "#0d9488" ? "#6366f1" : "#0d9488";
            else
              c.title = data.prompt
                .replace(/^(title|标题)\s*[:：]\s*/i, "")
                .slice(0, 120);
            store.append(
              "model.response_received",
              {
                response: store.put(proposal),
                request_event_id: event.event_id,
              },
              "runtime",
              [event.event_id],
            );
          } else {
            const gateway = await createGateway(store, {
              endpoint:
                engineOptions[data.engine]?.endpoint ??
                (data.engine === "dsh"
                  ? process.env.CANVAS_DSH_URL
                  : process.env.CANVAS_RESPONSES_URL),
              protocol: engineCapabilities[data.engine].wire,
              apiKey:
                engineOptions[data.engine]?.apiKey ??
                (data.engine === "dsh"
                  ? process.env.CANVAS_DSH_API_KEY
                  : process.env.CANVAS_API_KEY),
              capture: data.capture === true,
            });
            try {
              const auditStart = store.events.length;
              const result = await runEngine(
                data.engine,
                input,
                (type, payload) =>
                  store.append(type, { ref: store.put(payload) }),
                { ...engineOptions[data.engine], gateway },
              );
              if (
                !store.events
                  .slice(auditStart)
                  .some(
                    (e) =>
                      e.type === "model.request_prepared" &&
                      e.payload.verification?.assert === true,
                  )
              )
                throw Error("Engine returned without an audited model request");
              proposal = result.proposal;
            } finally {
              gateway.close();
            }
          }
          validate(proposal);
          store.commit({
            state: proposal,
            baseRevision,
            commandId: data.commandId,
            actor: "agent",
            causedBy: [message.event_id],
          });
        } catch (error) {
          store.append("agent.failed", { message: error.message });
          throw error;
        } finally {
          busy = false;
          broadcast();
        }
      } else return send(404, { error: "Not found" });
      broadcast();
      return send(200, store.view());
    } catch (error) {
      send(error.status || 400, { error: error.message });
    }
  });
  return {
    server,
    store,
    close: () => {
      for (const client of clients) client.end();
      server.close();
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp();
  app.server.listen(Number(process.env.PORT || 4317), "127.0.0.1", () =>
    console.log(
      `Canvas ready at http://127.0.0.1:${app.server.address().port}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      app.close();
      process.exit(0);
    });
}

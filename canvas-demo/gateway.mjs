import http from "node:http";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hash, stable } from "./store.mjs";

// This gateway is the only model transport configured in the isolated Codex home.
// Unsupported routes/remote conversation dependencies fail closed, never bypass audit.
export async function createGateway(
  store,
  { endpoint, apiKey, capture = false },
) {
  const target = new URL(endpoint);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !target.pathname.endsWith("/responses")
  )
    throw Error("Use a clean /responses endpoint URL");
  if (
    target.protocol !== "https:" &&
    !(
      target.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(target.hostname)
    )
  )
    throw Error("Provider must use HTTPS (loopback mock may use HTTP)");
  const token = randomUUID();
  const server = http.createServer(async (req, res) => {
    let requestId;
    const reject = (error) => {
      store.append("model.request_rejected", {
        message: error.message,
        request_id: requestId ?? null,
      });
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message } }));
      } else res.destroy();
    };
    try {
      if (req.headers.authorization !== `Bearer ${token}`)
        throw Error("Invalid gateway token");
      if (req.method !== "POST" || req.url !== "/responses")
        throw Error(
          "Unsupported model route (including compaction): audit refused",
        );
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024)
          throw Error("Model input exceeds demo limit");
      }
      const body = JSON.parse(raw);
      if (
        body.store !== false ||
        body.previous_response_id != null ||
        body.conversation != null ||
        !Array.isArray(body.input)
      )
        throw Error("Only full-context stateless requests are supported");
      if (body.input.some((item) => item.type === "item_reference"))
        throw Error("Remote item references cannot be reconstructed");
      const headers = { "content-type": "application/json" };
      // Forward and record all non-transport, non-auth application headers.
      for (const [key, value] of Object.entries(req.headers))
        if (
          ![
            "authorization",
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
          ].includes(key)
        )
          headers[key] = value;
      const descriptor = { method: "POST", url: target.href, headers };
      const config = { ...body };
      delete config.input;
      const plan = {
        builder: "responses-http-v1",
        descriptor: store.put(descriptor),
        config: store.put(config),
        items: body.input.map((item) => store.put(item)),
      };
      const actual = { descriptor, body };
      const rebuilt = store.rebuild(plan);
      if (!isDeepStrictEqual(rebuilt, actual))
        throw Error("Model request reconstruction failed");
      const prepared = store.append("model.request_prepared", {
        plan,
        verification: {
          assert: true,
          scope: "responses-http-request",
          request_hash: hash(stable(actual)),
        },
        ...(capture ? { body: store.put(actual) } : {}),
      });
      requestId = prepared.event_id;
      const response = await fetch(target, {
        method: "POST",
        redirect: "error",
        headers: { ...headers, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(110000),
      });
      store.append("model.response_started", {
        request_id: requestId,
        status: response.status,
        headers: store.put(Object.fromEntries(response.headers)),
      });
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") || "application/json",
      });
      let index = 0;
      for await (const chunk of response.body) {
        // Persist actual bytes before they become visible to Codex, including failed partial streams.
        store.append("model.response_chunk", {
          request_id: requestId,
          index: index++,
          bytes_base64: store.put(Buffer.from(chunk).toString("base64")),
        });
        res.write(chunk);
      }
      store.append("model.response_received", {
        request_id: requestId,
        chunks: index,
      });
      res.end();
    } catch (error) {
      if (requestId)
        store.append("model.request_failed", {
          request_id: requestId,
          message: error.message,
        });
      reject(error);
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy()); // WS is intentionally unsupported.
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    token,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

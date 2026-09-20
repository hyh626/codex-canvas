import { inspectHTML } from './html.mjs';
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
export const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const hash = (data) => createHash("sha256").update(data).digest("hex");
export const initial = {
  components: [
    {
      id: "welcome",
      title: "Build something together.",
      body: "One canvas. Human and agent, working on the same model.",
      color: "#6366f1",
    },
  ],
};
export function validate(state) {
  if (
    !state ||
    !Array.isArray(state.components) ||
    state.components.length < 1 ||
    state.components.length > 8
  )
    throw Error("Canvas needs 1–8 components");
  const ids = new Set();
  for (const c of state.components) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(c.id) || ids.has(c.id))
      throw Error("Invalid or duplicate component ID");
    ids.add(c.id);
    if (c.kind === 'html') {
      if (Object.keys(c).sort().join() !== 'html,id,kind') throw Error('Unknown HTML component field');
      inspectHTML(c.html);
      continue;
    }
    if (
      typeof c.title !== "string" ||
      c.title.length > 120 ||
      typeof c.body !== "string" ||
      c.body.length > 2000 ||
      !/^#[0-9a-f]{6}$/i.test(c.color)
    )
      throw Error("Invalid component fields");
    if (Object.keys(c).sort().join() !== "body,color,id,title")
      throw Error("Unknown component field");
  }
  if (Object.keys(state).join() !== "components")
    throw Error("Unknown state field");
  return structuredClone(state);
}
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function componentHTML(c) {
  if (c.kind === "html") return c.html;
  return `<article data-component-id="${c.id}" style="--accent:${c.color}"><h2 data-node-id="title">${escape(c.title)}</h2><p data-node-id="body">${escape(c.body)}</p></article>\n`;
}
export function diffModel(before, after) {
  const left = new Map(before.components.map((c) => [c.id, c]));
  const right = new Map(after.components.map((c) => [c.id, c]));
  const changes = [];
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    if (!left.has(id) || !right.has(id))
      changes.push({
        component_id: id,
        node_id: null,
        before: left.get(id) ?? null,
        after: right.get(id) ?? null,
      });
    else
      for (const field of ["kind", "html", "title", "body", "color"])
        if (left.get(id)[field] !== right.get(id)[field])
          changes.push({
            component_id: id,
            node_id: field,
            before: left.get(id)[field] ?? null,
            after: right.get(id)[field] ?? null,
          });
  }
  if (
    before.components.map((c) => c.id).join() !==
    after.components.map((c) => c.id).join()
  )
    changes.push({
      node_id: "component-order",
      before: before.components.map((c) => c.id),
      after: after.components.map((c) => c.id),
    });
  return changes;
}

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.lock = path.join(this.dir, "writer.lock");
    this.lockFd = fs.openSync(this.lock, "wx");
    fs.writeSync(this.lockFd, String(process.pid));
    try {
      this.blobs = path.join(this.dir, "blobs", "sha256");
      fs.mkdirSync(this.blobs, { recursive: true });
      this.log = path.join(this.dir, "events.jsonl");
      let raw = fs.existsSync(this.log)
        ? fs.readFileSync(this.log, "utf8")
        : "";
      // A final partial line is an interrupted append; preserve evidence, then recover the committed prefix.
      if (raw && !raw.endsWith("\n")) {
        fs.writeFileSync(
          path.join(this.dir, `incomplete-${Date.now()}.txt`),
          raw,
        );
        raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
        fs.writeFileSync(this.log, raw);
      }
      this.events = raw.trim() ? raw.trimEnd().split("\n").map(JSON.parse) : [];
      this.events.forEach((e, i) => {
        if (e.seq !== i + 1 || e.schema_version !== 1)
          throw Error("Invalid log sequence/version");
      });
      this.sessionId = this.events[0]?.session_id || randomUUID();
      this.fd = fs.openSync(this.log, "a");
      if (!this.events.length)
        this.append(
          "session.started",
          { snapshot: this.put(initial) },
          "runtime",
        );
      this.replay();
      this.materialize();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    if (this.lockFd !== undefined) {
      fs.closeSync(this.lockFd);
      this.lockFd = undefined;
      fs.unlinkSync(this.lock);
    }
  }
  put(value) {
    const bytes = Buffer.from(stable(value));
    const sha256 = hash(bytes);
    const target = path.join(this.blobs, sha256);
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) !== sha256)
      throw Error("Blob integrity failure");
    if (!fs.existsSync(target)) {
      const fd = fs.openSync(target, "wx");
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { sha256, size_bytes: bytes.length, media_type: "application/json" };
  }
  get(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref?.sha256))
      throw Error("Invalid blob reference");
    const bytes = fs.readFileSync(path.join(this.blobs, ref.sha256));
    if (hash(bytes) !== ref.sha256 || bytes.length !== ref.size_bytes)
      throw Error("Blob integrity failure");
    return JSON.parse(bytes);
  }
  append(type, payload, kind = "runtime", caused_by = []) {
    const event = {
      schema_version: 1,
      session_id: this.sessionId,
      event_id: randomUUID(),
      seq: this.events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      actor: { kind, id: kind },
      caused_by,
      payload,
    };
    fs.writeSync(this.fd, JSON.stringify(event) + "\n");
    fs.fsyncSync(this.fd);
    this.events.push(event);
    return event;
  }
  replay() {
    this.state = validate(this.get(this.events[0].payload.snapshot));
    this.revision = 0;
    this.undo = [];
    this.redo = [];
    for (const e of this.events.filter(
      (e) => e.type === "workspace.edit_committed",
    )) {
      if (
        e.payload.revision !== this.revision + 1 ||
        !isDeepStrictEqual(this.get(e.payload.before), this.state)
      )
        throw Error("Broken revision chain");
      this.state = validate(this.get(e.payload.after));
      this.revision++;
      if (e.payload.mode === "undo") this.redo.push(this.undo.pop());
      else if (e.payload.mode === "redo") this.undo.push(this.redo.pop());
      else {
        this.undo.push(e.event_id);
        this.redo = [];
      }
    }
  }
  materialize() {
    const root = path.join(this.dir, "workspace");
    fs.mkdirSync(path.join(root, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "canvas.json"),
      JSON.stringify(
        {
          revision: this.revision,
          components: this.state.components.map((c) => ({
            id: c.id,
            path: `components/${c.id}.html`,
          })),
        },
        null,
        2,
      ),
    );
    const current = new Set(this.state.components.map((c) => `${c.id}.html`));
    for (const file of fs.readdirSync(path.join(root, "components")))
      if (!current.has(file))
        fs.unlinkSync(path.join(root, "components", file));
    for (const c of this.state.components)
      fs.writeFileSync(
        path.join(root, "components", `${c.id}.html`),
        componentHTML(c),
      );
  }
  view() {
    return {
      state: this.state,
      revision: this.revision,
      canUndo: this.undo.length > 0,
      canRedo: this.redo.length > 0,
      events: this.events,
    };
  }
  commit({
    state,
    baseRevision,
    commandId,
    actor = "human",
    mode = "edit",
    target = null,
    causedBy = [],
    intent = null,
  }) {
    const fingerprint = hash(
      stable({
        state,
        baseRevision,
        mode,
        target,
        ...(intent ? { intent } : {}),
      }),
    );
    if (typeof commandId !== "string" || commandId.length > 100)
      throw Error("commandId required");
    const existing = this.events.find(
      (e) =>
        e.type === "workspace.edit_committed" &&
        e.payload.command_id === commandId,
    );
    if (existing) {
      if (existing.payload.fingerprint !== fingerprint)
        throw Error("Command ID reused with different input");
      return existing;
    }
    if (baseRevision !== this.revision)
      throw Object.assign(
        Error("Revision conflict. Reload, then reapply your edit."),
        { status: 409 },
      );
    state = validate(state);
    const before = this.put(this.state);
    const after = this.put(state);
    const delta = this.put(diffModel(this.state, state));
    const event = this.append(
      "workspace.edit_committed",
      {
        command_id: commandId,
        ...(intent ? { intent } : {}),
        fingerprint,
        revision: this.revision + 1,
        before,
        after,
        delta,
        mode,
        target,
      },
      actor,
      causedBy,
    );
    this.replay();
    this.materialize();
    return event;
  }
  history(mode, baseRevision, commandId) {
    const id = (mode === "undo" ? this.undo : this.redo).at(-1);
    if (!id) throw Error(`Nothing to ${mode}`);
    const event = this.events.find((e) => e.event_id === id);
    return this.commit({
      state: this.get(event.payload[mode === "undo" ? "before" : "after"]),
      baseRevision,
      commandId,
      mode,
      target: id,
    });
  }
  rebuild(plan) {
    if (plan.builder === "responses-http-v1")
      return {
        descriptor: this.get(plan.descriptor),
        body: {
          ...this.get(plan.config),
          input: plan.items.map((ref) => this.get(ref)),
        },
      };
    if (plan.builder !== "mock-request-v1")
      throw Error("Unknown request builder");
    return {
      ...this.get(plan.config),
      input: plan.items.map((ref) => this.get(ref)),
    };
  }
  prepare(input, capture = false) {
    const config = {
      model: "deterministic-canvas-mock",
      instructions: "Return a validated canvas proposal.",
      stream: false,
    };
    const plan = {
      builder: "mock-request-v1",
      config: this.put(config),
      items: input.map((item) => this.put(item)),
    };
    const actual = { ...config, input: structuredClone(input) }; // Runtime path; reconstruction independently reloads persisted blobs.
    const rebuilt = this.rebuild(plan);
    if (!isDeepStrictEqual(actual, rebuilt)) {
      this.append("model.request_rejected", {
        reason: "reconstruction mismatch",
      });
      throw Error("Request reconstruction failed");
    }
    const event = this.append("model.request_prepared", {
      plan,
      verification: {
        assert: true,
        scope: "mock-model-request",
        request_hash: hash(stable(actual)),
      },
      ...(capture ? { body: this.put(actual) } : {}),
    });
    return { request: actual, event };
  }
  export() {
    const blobs = Object.fromEntries(
      fs
        .readdirSync(this.blobs)
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(this.blobs, name)).toString("base64"),
        ]),
    );
    return {
      format: "canvas-demo-archive-v1",
      events_jsonl: fs.readFileSync(this.log, "utf8"),
      blobs,
    };
  }
}

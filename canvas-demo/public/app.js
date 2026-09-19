const $ = (id) => document.getElementById(id);
let view,
  token,
  selected = "welcome",
  editRevision,
  dirty = false,
  running = false;
const status = (text, error = false) => {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
};
async function api(route, payload) {
  const response = await fetch("/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
    body: JSON.stringify({ ...payload, commandId: crypto.randomUUID() }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
function fillEditor() {
  const c = view.state.components.find((c) => c.id === selected);
  if (!c) return;
  for (const key of ["title", "body", "color"]) $(key).value = c[key];
  $("selected").textContent = c.id;
  editRevision = view.revision;
  dirty = false;
}
function render(next) {
  view = next;
  if (!view.state.components.some((c) => c.id === selected)) {
    selected = view.state.components[0].id;
    dirty = false;
  }
  $("revision").textContent = "r" + view.revision;
  $("count").textContent = String(view.state.components.length).padStart(
    2,
    "0",
  );
  $("undo").disabled = !view.canUndo;
  $("redo").disabled = !view.canRedo;
  $("model").textContent = JSON.stringify(
    { revision: view.revision, ...view.state },
    null,
    2,
  );
  $("canvas").replaceChildren();
  $("components").replaceChildren();
  for (const c of view.state.components) {
    const choose = () => {
      if (dirty && !confirm("Discard your uncommitted edit?")) return;
      selected = c.id;
      dirty = false;
      render(view);
    };
    const nav = document.createElement("button");
    nav.textContent = "◇  " + c.id;
    nav.className = c.id === selected ? "active" : "";
    nav.onclick = choose;
    $("components").append(nav);
    const card = document.createElement("article");
    card.className = "card" + (c.id === selected ? " selected" : "");
    card.style.setProperty("--accent", c.color);
    card.tabIndex = 0;
    card.setAttribute("aria-label", c.id);
    card.dataset.componentId = c.id;
    const marker = document.createElement("div");
    marker.className = "marker";
    const title = document.createElement("h3");
    title.dataset.nodeId = "title";
    title.textContent = c.title;
    const body = document.createElement("p");
    body.dataset.nodeId = "body";
    body.textContent = c.body;
    const footer = document.createElement("small");
    footer.textContent = c.id.toUpperCase() + " / SHARED COMPONENT";
    card.append(marker, title, body, footer);
    card.onclick = choose;
    card.onkeydown = (e) => {
      if (e.key === "Enter") choose();
    };
    $("canvas").append(card);
  }
  $("events").replaceChildren();
  for (const event of [...view.events].reverse().slice(0, 12)) {
    const row = document.createElement("button");
    row.className = "event-row";
    const seq = document.createElement("span");
    seq.textContent = String(event.seq).padStart(3, "0");
    const label = document.createElement("b");
    label.textContent = event.type;
    const actor = document.createElement("em");
    actor.textContent = event.actor.kind;
    row.append(seq, label, actor);
    row.onclick = async () => {
      const detail = await (await fetch("/api/event/" + event.event_id)).json();
      $("event").textContent = JSON.stringify(detail, null, 2);
      $("event").parentElement.open = true;
    };
    $("events").append(row);
  }
  if (!dirty) fillEditor();
}
async function act(fn, message) {
  try {
    await fn();
    status(message);
  } catch (e) {
    status(e.message, true);
  }
}
$("editor").oninput = () => {
  dirty = true;
};
$("editor").onsubmit = (event) => {
  event.preventDefault();
  act(async () => {
    // Preserve the revision from when this form was loaded. Never silently rebase an old form.
    const state = structuredClone(view.state);
    Object.assign(
      state.components.find((c) => c.id === selected),
      {
        title: $("title").value,
        body: $("body").value,
        color: $("color").value,
      },
    );
    const next = await api("edit", { state, baseRevision: editRevision });
    dirty = false;
    render(next);
  }, "Human edit committed. The canvas is now rendering the new model.");
};
for (const mode of ["undo", "redo"])
  $(mode).onclick = () =>
    act(
      async () => {
        dirty = false;
        render(await api(mode, { baseRevision: view.revision }));
      },
      mode === "undo"
        ? "Undo appended a new transaction."
        : "Redo appended a new transaction.",
    );
document.onkeydown = (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "z" &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    $(e.shiftKey ? "redo" : "undo").click();
  }
};
$("addComment").onclick = () =>
  act(async () => {
    render(
      await api("comment", {
        componentId: selected,
        nodeId: $("anchor").value,
        baseRevision: view.revision,
        text: $("comment").value,
      }),
    );
    $("comment").value = "";
  }, "Comment saved with component ID, node ID and revision.");
$("engine").onchange = () => {
  const mock = $("engine").value === "mock";
  $("audit").textContent = mock
    ? "assert = true · mock request"
    : "assert = true · Responses HTTP";
  $("agentNote").textContent = mock
    ? "Mock recognizes title text, “change color”, and “add card”. No model API call."
    : "Codex proposes changes through an audited Responses HTTP gateway. Unsupported transports are rejected.";
};
$("run").onclick = () =>
  act(async () => {
    if (running) return;
    running = true;
    $("run").disabled = true;
    status("Agent is preparing a proposal…");
    try {
      render(
        await api("agent", {
          prompt: $("prompt").value,
          engine: $("engine").value,
          capture: $("capture").checked,
          componentId: selected,
          baseRevision: view.revision,
        }),
      );
    } finally {
      running = false;
      $("run").disabled = false;
    }
  }, "Agent proposal validated and committed. Try Undo.");
for (const button of document.querySelectorAll("[data-prompt]"))
  button.onclick = () => {
    $("prompt").value = button.dataset.prompt;
  };
try {
  const response = await fetch("/api/state");
  const initial = await response.json();
  token = initial.token;
  $("engine").querySelector("[value=codex]").disabled = !initial.codexEnabled;
  render(initial);
  status("Ready. Edit the selected component or try an agent instruction.");
  const events = new EventSource("/api/stream");
  events.onmessage = (e) => render(JSON.parse(e.data));
  events.onopen = () => {
    $("connection").textContent = "● Connected";
  };
  events.onerror = () => {
    $("connection").textContent = "Reconnecting…";
  };
} catch (error) {
  status(error.message, true);
}

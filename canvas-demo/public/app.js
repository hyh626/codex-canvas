import { htmlNodes, htmlPreview, locateHTML } from './html-ui.js';
const $ = (id) => document.getElementById(id);
let view,
  token,
  selected = "welcome",
  editRevision,
  dirty = false,
  running = false,
  inlineTarget = null;
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
  const html = c.kind === 'html';
  $('cardFields').hidden = html;
  $('htmlFields').hidden = !html;
  for (const key of ['title','body','color']) { $(key).disabled = html; if (!html) $(key).value = c[key]; }
  if (html) $('htmlSource').value = c.html;
  const previousAnchor = $('anchor').value;
  $('anchor').replaceChildren(...(html ? htmlNodes(c.html) : [{id:'title'},{id:'body'}]).map(n => new Option(n.id, n.id)));
  if ([...$('anchor').options].some(o => o.value === previousAnchor)) $('anchor').value = previousAnchor;
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
  const selectedIndex = view.state.components.findIndex(
    (c) => c.id === selected,
  );
  $("moveEarlier").disabled = selectedIndex === 0;
  $("moveLater").disabled = selectedIndex === view.state.components.length - 1;
  $("deleteCard").disabled = view.state.components.length === 1;
  $("newCard").disabled = $("newHTML").disabled = $("duplicate").disabled =
    view.state.components.length >= 8;
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
      if (selected === c.id) return;
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
    card.style.setProperty("--accent", c.color || "#6366f1");
    card.tabIndex = 0;
    card.setAttribute("aria-label", c.id);
    card.dataset.componentId = c.id;
    if (c.kind === 'html') {
      card.append(htmlPreview(c, choose, openInline, id => { $('anchor').value = id; }));
      const label = document.createElement('small'); label.textContent = c.id + ' / HTML · double-click text to edit'; card.append(label);
      $('canvas').append(card);
      continue;
    }
    const marker = document.createElement("div");
    marker.className = "marker";
    const title = document.createElement("h3");
    title.dataset.nodeId = "title";
    title.textContent = c.title;
    const body = document.createElement("p");
    body.dataset.nodeId = "body";
    body.textContent = c.body;
    for (const [element, nodeId] of [
      [title, "title"],
      [body, "body"],
    ]) {
      element.ondblclick = (event) => {
        event.stopPropagation();
        openInline(c, nodeId);
      };
      element.title = "Double-click to edit";
    }
    const editButton = document.createElement("button");
    editButton.textContent = "Edit text";
    editButton.onclick = (event) => {
      event.stopPropagation();
      openInline(c, "body");
    };
    const footer = document.createElement("small");
    footer.textContent = c.id.toUpperCase() + " / SHARED COMPONENT";
    card.append(marker, title, body, footer, editButton);
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
  $("comments").replaceChildren();
  const comments = view.events.filter(
    (e) => e.type === "comment.created" && e.payload.component_id === selected,
  );
  if (!comments.length)
    $("comments").textContent = "No comments on this component yet.";
  for (const event of comments) {
    const item = document.createElement("article");
    item.className = "comment-item";
    const anchor = document.createElement("small");
    anchor.textContent = `${event.payload.node_id} · anchored at r${event.payload.revision}`;
    const text = document.createElement("p");
    text.textContent = event.payload.text;
    const use = document.createElement("button");
    use.textContent = "Use as agent instruction";
    use.onclick = () => {
      $("prompt").value = event.payload.text;
      $("prompt").focus();
      status("Comment copied into the agent prompt. Review it, then run.");
    };
    const component = view.state.components.find(c => c.id === selected);
    const ids = component.kind === 'html' ? htmlNodes(component.html).map(n => n.id) : ['title','body'];
    const located = ids.includes(event.payload.node_id);
    const locate = document.createElement('button'); locate.textContent = located ? 'Locate node' : 'Node removed · historical comment'; locate.disabled = !located;
    locate.onclick = () => locateHTML(selected, event.payload.node_id);
    item.append(anchor, text, locate, use);
    $("comments").append(item);
  }
  if (!dirty) fillEditor();
}
async function act(fn, message) {
  try {
    if ((await fn()) === false) return;
    status(message);
  } catch (e) {
    status(e.message, true);
  }
}
function discardDraft() {
  if (dirty && !confirm("Discard your uncommitted inspector edit?"))
    return false;
  dirty = false;
  return true;
}
function openInline(card, nodeId) {
  if (!discardDraft()) return;
  selected = card.id;
  render(view);
  inlineTarget = { componentId: card.id, nodeId, baseRevision: view.revision };
  $("inlineLabel").textContent = `Edit ${nodeId}`;
  $("inlineContext").textContent =
    `${card.id} · revision ${view.revision}. Later changes will cause a conflict.`;
  $("inlineText").value = card.kind === "html" ? htmlNodes(card.html).find(n => n.id === nodeId).text : card[nodeId];
  $("inlineText").maxLength = nodeId === "title" ? 120 : 2000;
  $("inlineError").textContent = "";
  $("inlineEdit").showModal();
  $("inlineText").focus();
}
$('rebaseInline').onclick = () => {
  const c = view.state.components.find(c => c.id === inlineTarget.componentId);
  const node = c?.kind === 'html' ? htmlNodes(c.html).find(n => n.id === inlineTarget.nodeId && n.leaf) : c && {text:c[inlineTarget.nodeId]};
  if (!node) { $('inlineError').textContent = 'Target no longer exists or is not a text leaf.'; return; }
  $('inlineContext').textContent = `Latest r${view.revision}: ${node.text}. Your draft is retained. Commit explicitly to replace this text.`;
  inlineTarget.baseRevision = view.revision;
  $('inlineError').textContent = '';
};
$('reloadEditor').onclick = () => { if (discardDraft()) fillEditor(); };
$("cancelInline").onclick = () => $("inlineEdit").close();
$("inlineForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const next = await api("component", {
      operation: "set_text",
      ...inlineTarget,
      text: $("inlineText").value,
    });
    $("inlineEdit").close();
    render(next);
    status("Canvas text committed with its target and source diff.");
  } catch (error) {
    $("inlineError").textContent = error.message;
  }
};
for (const [id, operation, direction] of [
  ["newCard", "create"],
  ["newHTML", "create_html"],
  ["duplicate", "duplicate"],
  ["deleteCard", "delete"],
  ["moveEarlier", "move", -1],
  ["moveLater", "move", 1],
]) {
  $(id).onclick = () =>
    act(async () => {
      if (!discardDraft()) return false;
      const next = await api("component", {
        operation,
        direction,
        componentId: selected,
        baseRevision: view.revision,
      });
      if (
        next.selectedComponentId &&
        next.state.components.some((c) => c.id === next.selectedComponentId)
      )
        selected = next.selectedComponentId;
      render(next);
    }, `${operation} committed. Undo restores the previous state.`);
}
$("editor").oninput = () => {
  dirty = true;
};
$("editor").onsubmit = (event) => {
  event.preventDefault();
  act(async () => {
    // Preserve the revision from when this form was loaded. Never silently rebase an old form.
    const state = structuredClone(view.state);
    const c = state.components.find(c => c.id === selected);
    if (c.kind === 'html') c.html = $('htmlSource').value;
    else Object.assign(c, {title:$('title').value,body:$('body').value,color:$('color').value});
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
    !$("inlineEdit").open &&
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
    : `assert = true · ${$("engine").value === "dsh" ? "Chat Completions HTTP" : "Responses HTTP"}`;
  $("agentNote").textContent = mock
    ? "Mock recognizes title text, “change color”, “add card”, and HTML “layout”. No model API call."
    : "The selected engine proposes changes through an audited HTTP gateway. Unsupported transports are rejected.";
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
  $("engine").querySelector("[value=dsh]").disabled = !initial.dshEnabled;
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

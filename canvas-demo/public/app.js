import { htmlNodes, htmlPreview, locateHTML } from './html-ui.js';
import { scenarioById, scenarios, scenarioProgress } from "/scenarios.js";
const $ = (id) => document.getElementById(id);
let view,
  token,
  selected = "welcome",
  editRevision,
  dirty = false,
  running = false,
  runningRevision = null,
  inlineTarget = null,
  mindSelection = { mode: "node", nodeIds: [] },
  mindSelectionMode = "node",
  selectedScenarioId = scenarios[0].id;
const evalMode = new URLSearchParams(location.search).get("eval") === "1";
const inlineDraftKey = "canvas.inline-draft.v1";
const saveInlineDraft = () => {
  if ($("inlineEdit").open && inlineTarget)
    sessionStorage.setItem(inlineDraftKey, JSON.stringify({ ...inlineTarget, value: $("inlineText").value }));
};
const clearInlineDraft = () => sessionStorage.removeItem(inlineDraftKey);
const refreshConnection = () => {
  $("connection").textContent = navigator.onLine ? "● Connected" : "Disconnected";
};
window.addEventListener("offline", refreshConnection);
window.addEventListener("online", refreshConnection);
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
  const mindMap = c.kind === 'mind_map';
  $('cardFields').hidden = html;
  $('htmlFields').hidden = !html;
  $('editor').hidden = mindMap;
  $('reloadEditor').hidden = mindMap;
  if (mindMap) {
    $('selected').textContent = c.id;
    const previousAnchor = $('anchor').value;
    $('anchor').replaceChildren(...c.nodes.map(node => new Option(node.label, node.id)));
    if (c.nodes.some(node => node.id === previousAnchor)) $('anchor').value = previousAnchor;
    else $('anchor').value = mindSelection.nodeIds[0] ?? c.rootId;
    return;
  }
  for (const key of ['title','body','color']) { $(key).disabled = html; if (!html) $(key).value = c[key]; }
  if (html) $('htmlSource').value = c.html;
  const previousAnchor = $('anchor').value;
  $('anchor').replaceChildren(...(html ? htmlNodes(c.html) : [{id:'title'},{id:'body'}]).map(n => new Option(n.id, n.id)));
  if ([...$('anchor').options].some(o => o.value === previousAnchor)) $('anchor').value = previousAnchor;
  $("selected").textContent = c.id;
  editRevision = view.revision;
  dirty = false;
}
function renderScenario(followActive = true) {
  const latest = [...view.events]
    .reverse()
    .find((event) => event.type === "scenario.started");
  if (followActive && latest) selectedScenarioId = latest.payload.scenario_id;
  $("scenario").value = selectedScenarioId;
  const scenario = scenarioById.get(selectedScenarioId);
  const progress = scenarioProgress(scenario, view);
  $("cujTitle").textContent = scenario.title;
  $("cujSummary").textContent = scenario.summary;
  $("cujExpected").textContent = scenario.expected;
  $("cujSteps").replaceChildren();
  for (const step of progress.steps) {
    const item = document.createElement("li");
    item.className = step.done ? "done" : step.manual ? "manual" : "";
    const marker = document.createElement("span");
    marker.textContent = step.done ? "✓" : step.manual ? "◎" : "○";
    const label = document.createElement("span");
    label.textContent = step.label;
    item.append(marker, label);
    $("cujSteps").append(item);
  }
  const automated = progress.steps.filter((step) => !step.manual);
  const completed = automated.filter((step) => step.done).length;
  $("cujProgress").textContent = !progress.active
    ? "Not loaded"
    : completed === automated.length
      ? `Auto checks passed · ${completed}/${automated.length}`
      : `In progress · ${completed}/${automated.length}`;
  $("cujProgress").className =
    "pill " +
    (progress.active && completed === automated.length ? "passed" : "");
}
function render(next) {
  const previousProposalStatus = view?.proposal?.status;
  view = next;
  const proposalStatus = view.proposal?.status ?? "none";
  $("proposalReview").hidden = proposalStatus === "none";
  $("proposalSummary").textContent = proposalStatus === "conflicted"
    ? "This proposal is based on an older revision. Review the latest canvas and retry."
    : proposalStatus === "pending"
      ? `Staged at revision ${view.proposal.baseRevision}. Accept or reject before it changes the canvas.`
      : "";
  $("acceptProposal").disabled = proposalStatus !== "pending";
  $("rejectProposal").disabled = proposalStatus !== "pending";
  if (running && runningRevision !== null && view.revision !== runningRevision)
    status("The proposal is based on an older revision. Your edit is preserved; retry against the latest version.", true);
  else if (proposalStatus === "pending" && previousProposalStatus !== "pending")
    status("Proposal ready for review.");
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
  const selectedComponent = view.state.components.find(c => c.id === selected);
  const isMindMap = selectedComponent?.kind === "mind_map";
  if (isMindMap && mindSelection.nodeIds.some(id => !selectedComponent.nodes.some(node => node.id === id))) mindSelection = {mode:'node',nodeIds:[selectedComponent.rootId]};
  if (isMindMap && !mindSelection.nodeIds.length) mindSelection = {mode:'node',nodeIds:[selectedComponent.rootId]};
  $("mindMapToolbar").hidden = !isMindMap;
  $("componentToolbar").hidden = isMindMap;
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
      mindSelection = c.kind === 'mind_map' ? {mode:'node',nodeIds:[c.rootId]} : {mode:'node',nodeIds:[]};
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
    if (c.kind === 'mind_map') {
      const map = document.createElement('article');
      map.className = 'mind-map card' + (c.id === selected ? ' selected' : '');
      map.dataset.componentId = c.id;
      map.setAttribute('aria-label', `Mind map ${c.id}`);
      map.tabIndex = 0;
      renderMindMap(map, c);
      $('canvas').append(map);
      continue;
    }
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
    title.tabIndex = 0;
    const body = document.createElement("p");
    body.dataset.nodeId = "body";
    body.textContent = c.body;
    body.tabIndex = 0;
    for (const [element, nodeId] of [
      [title, "title"],
      [body, "body"],
    ]) {
      element.ondblclick = (event) => {
        event.stopPropagation();
        openInline(c, nodeId);
      };
      element.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          openInline(c, nodeId);
        }
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
  const comments = (view.comments ?? []).filter((comment) => comment.component_id === selected);
  if (!comments.length)
    $("comments").textContent = "No comments on this component yet.";
  for (const comment of comments) {
    const item = document.createElement("article");
    item.className = "comment-item";
    const anchor = document.createElement("small");
    anchor.textContent = `${comment.node_id} · anchored at r${comment.revision}${comment.resolved ? " · resolved" : ""}`;
    const text = document.createElement("p");
    text.textContent = comment.text;
    const use = document.createElement("button");
    use.textContent = "Use as agent instruction";
    use.disabled = comment.resolved;
    use.onclick = () => {
      $("prompt").value = comment.text;
      $("prompt").focus();
      status("Comment copied into the agent prompt. Review it, then run.");
    };
    const component = view.state.components.find(c => c.id === selected);
    const ids = component.kind === 'html' ? htmlNodes(component.html).map(n => n.id) : component.kind === 'mind_map' ? component.nodes.map(n => n.id) : ['title','body'];
    const located = ids.includes(comment.node_id);
    const locate = document.createElement('button'); locate.textContent = located ? 'Locate node' : 'Node removed · historical comment'; locate.disabled = !located;
    locate.onclick = () => {
      if (component.kind === 'mind_map') {
        const node = [...document.querySelectorAll(`[data-component-id="${CSS.escape(selected)}"] .mind-map-node[data-node-id]`)].find(el => el.dataset.nodeId === comment.node_id);
        node?.scrollIntoView({block:'nearest',inline:'nearest'});
        if (node) { node.classList.add('comment-located'); setTimeout(() => node.classList.remove('comment-located'),1800); }
      } else locateHTML(selected, comment.node_id);
    };
    item.append(anchor, text, locate, use);
    if (!comment.resolved) {
      const target = document.createElement("select");
      target.setAttribute("aria-label", "New comment anchor");
      for (const candidate of view.state.components) {
        const nodes = candidate.kind === "html" ? htmlNodes(candidate.html).map((node) => node.id) : candidate.kind === 'mind_map' ? candidate.nodes.map(node => node.id) : ["title", "body"];
        for (const nodeId of nodes) target.append(new Option(`${candidate.id} · ${nodeId}`, `${candidate.id}/${nodeId}`));
      }
      target.value = `${comment.component_id}/${comment.node_id}`;
      const reanchor = document.createElement("button");
      reanchor.textContent = "Move anchor";
      reanchor.onclick = () => act(async () => {
        const [targetComponentId, targetNodeId] = target.value.split("/");
        render(await api("comment-lifecycle/reanchor", {
          comment_id: comment.comment_id,
          component_id: comment.component_id,
          from_node_id: comment.node_id,
          target_component_id: targetComponentId,
          to_node_id: targetNodeId,
        }));
      }, "Comment anchor moved.");
      const resolve = document.createElement("button");
      resolve.textContent = "Resolve comment";
      resolve.onclick = () => act(async () => {
        render(await api("comment-lifecycle/resolve", { comment_id: comment.comment_id }));
      }, "Comment resolved.");
      item.append(target, reanchor, resolve);
    }
    $("comments").append(item);
  }
  renderScenario();
  if (isMindMap) {
    const ids = mindSelection.nodeIds;
    $('mindSelectionLabel').textContent = ids.length ? `${mindSelection.mode}: ${ids.join(', ')}` : 'Choose a node';
    $('deleteMindNode').disabled = !ids.length || ids.includes(selectedComponent.rootId);
    $('duplicateMindNode').disabled = !ids.length || ids.includes(selectedComponent.rootId) || mindSelection.mode !== 'node';
    $('addMindNode').disabled = !ids.length;
    const activeNode = selectedComponent.nodes.find(node => node.id === ids[0]);
    const siblings = activeNode ? selectedComponent.nodes.filter(node => node.parentId === activeNode.parentId) : [];
    $('mindEarlier').disabled = !activeNode || mindSelection.mode !== 'node' || activeNode.id === selectedComponent.rootId || activeNode.order === 0;
    $('mindLater').disabled = !activeNode || mindSelection.mode !== 'node' || activeNode.id === selectedComponent.rootId || activeNode.order >= siblings.length - 1;
  }
  if (!dirty) fillEditor();
}

function renderMindMap(container, component) {
  const byId = new Map(component.nodes.map(node => [node.id, node]));
  const children = new Map();
  for (const node of component.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node); children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a,b) => a.order-b.order);
  const leaves = new Map(); let leafIndex = 0, maxDepth = 0;
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(node.id) ?? [];
    if (!kids.length) { const index = leafIndex++; leaves.set(node.id, [index, index]); return [index,index]; }
    const ranges = kids.map(child => walk(child, depth + 1));
    const range = [ranges[0][0], ranges[ranges.length-1][1]]; leaves.set(node.id, range); return range;
  };
  walk(byId.get(component.rootId), 0);
  const slotY = 142, colX = 235, margin = 28, nodeW = 190;
  const nodeHeight = node => Math.max(58, Math.ceil(Array.from(node.label).reduce((n, ch) => n + (ch.codePointAt(0) > 255 ? 1 : .55), 0) / 20) * 17 + 22);
  const width = margin * 2 + maxDepth * colX + nodeW;
  const height = Math.max(150, margin * 2 + Math.max(leafIndex, 1) * slotY);
  container.style.width = `${width}px`; container.style.height = `${height}px`;
  container.dataset.mindMapId = component.id;
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('mind-map-edges'); svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('aria-hidden','true');
  const positions = new Map();
  const nodes = document.createElement('div'); nodes.className = 'mind-map-nodes';
  const place = (node, depth) => {
    const [a,b] = leaves.get(node.id); const x = margin + depth * colX; const h = nodeHeight(node); const y = margin + ((a+b)/2) * slotY + (slotY-h)/2;
    positions.set(node.id, {x,y,h});
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'mind-map-node' + (mindSelection.nodeIds.includes(node.id) ? ' selected' : '');
    el.dataset.nodeId = node.id; el.textContent = node.label; el.title = 'Click to select; double-click to rename';
    el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.width = `${nodeW}px`; el.style.height = `${h}px`;
    el.setAttribute('aria-pressed', String(mindSelection.nodeIds.includes(node.id)));
    el.onclick = event => {
      event.stopPropagation();
      if (mindSelectionMode === 'multi' || event.shiftKey) {
        const ids = new Set(mindSelection.nodeIds); ids.has(node.id) ? ids.delete(node.id) : ids.add(node.id);
        mindSelection = { mode:'multi', nodeIds:[...ids] };
      } else mindSelection = { mode:mindSelectionMode, nodeIds:[node.id] };
      render(view);
    };
    el.ondblclick = event => { event.stopPropagation(); openMindMapInline(component,node); };
    el.onkeydown = event => { if (event.key === 'F2' || event.key === 'Enter' && event.detail === 0) { event.preventDefault(); openMindMapInline(component,node); } };
    nodes.append(el);
    for (const child of children.get(node.id) ?? []) place(child, depth+1);
  };
  place(byId.get(component.rootId), 0);
  for (const node of component.nodes) if (node.id !== component.rootId) {
    const p = positions.get(node.parentId), q = positions.get(node.id);
    const line = document.createElementNS('http://www.w3.org/2000/svg','path');
    line.setAttribute('d',`M ${p.x+nodeW} ${p.y+p.h/2} C ${p.x+nodeW+25} ${p.y+p.h/2}, ${q.x-25} ${q.y+q.h/2}, ${q.x} ${q.y+q.h/2}`);
    line.dataset.edgeFrom = node.parentId; line.dataset.edgeTo = node.id; svg.append(line);
  }
  container.append(svg,nodes);
}
function openMindMapInline(component,node) {
  if (!discardDraft()) return;
  selected = component.id; mindSelection = {mode:'node',nodeIds:[node.id]}; render(view);
  inlineTarget = {componentId:component.id,nodeId:node.id,baseRevision:view.revision,mindMap:true};
  $('inlineLabel').textContent = `Rename ${node.id}`;
  $('inlineContext').textContent = `${component.id} · mind map node · revision ${view.revision}`;
  $('inlineText').value = node.label; $('inlineText').maxLength = 120;
  $('inlineError').textContent = ''; $('inlineEdit').showModal(); $('inlineText').focus();
}

function observedUIState() {
  const active = document.activeElement;
  const inlineOpen = $("inlineEdit").open;
  const inspectorDraft = dirty
    ? {
        component_id: selected,
        node_id: null,
        base_revision: editRevision,
        value: $("htmlFields").hidden
          ? { title: $("title").value, body: $("body").value, color: $("color").value }
          : $("htmlSource").value,
      }
    : null;
  const inlineDraft = inlineOpen
    ? {
        component_id: inlineTarget.componentId,
        node_id: inlineTarget.nodeId,
        base_revision: inlineTarget.baseRevision,
        value: $("inlineText").value,
      }
    : null;
  const error = inlineOpen && $("inlineError").textContent
    ? $("inlineError").textContent
    : $("status").classList.contains("error")
      ? $("status").textContent
      : null;
  const statusText = $("status").textContent;
  return {
    schema_version: 1,
    selected_component_id: selected ?? null,
    selected_scenario_id: selectedScenarioId,
    open_panel: $("event").parentElement.open ? "event" : $("model").parentElement.open ? "model" : "none",
    focus: active && active !== document.body ? active.id || active.tagName.toLowerCase() : null,
    scroll: { app_x: Math.round(scrollX), app_y: Math.round(scrollY), canvas_x: Math.round($("canvas").scrollLeft), canvas_y: Math.round($("canvas").scrollTop) },
    dirty,
    running,
    proposal: { status: view.proposal?.status ?? "none" },
    connection: $("connection").textContent.includes("Connected") ? "connected" : $("connection").textContent.includes("Reconnecting") ? "reconnecting" : "disconnected",
    dialogs: [{ id: "inlineEdit", open: inlineOpen }],
    editor: {
      mode: inlineOpen ? "inline_text" : dirty ? "inspector_model" : "none",
      draft: inlineDraft ?? inspectorDraft,
      error,
      rebase_available: inlineOpen && Boolean(error),
    },
    status: {
      text: statusText,
      tone: error ? "error" : running || view.proposal?.status === "pending" ? "pending" : /committed|validated|passed/i.test(statusText) ? "success" : "neutral",
    },
    controls: { undo_enabled: !$("undo").disabled, redo_enabled: !$("redo").disabled, run_enabled: !$("run").disabled },
  };
}

if (evalMode) {
  globalThis.__canvasEval = {
    renderSnapshot(next, options = {}) {
      if (options.scenarioId) selectedScenarioId = options.scenarioId;
      if (options.selectedComponentId) selected = options.selectedComponentId;
      render(next);
    },
    async sync() {
      const next = await (await fetch("/api/state")).json();
      render(next);
      return next;
    },
    select(componentId) {
      selected = componentId;
      render(view);
    },
    openInline(componentId, nodeId, value, baseRevision = view.revision) {
      const component = view.state.components.find((item) => item.id === componentId);
      openInline(component, nodeId);
      inlineTarget.baseRevision = baseRevision;
      $("inlineText").value = value;
      saveInlineDraft();
    },
    showError(message) {
      status(message, true);
    },
    currentView() {
      return { state: structuredClone(view.state), revision: view.revision };
    },
    observedUIState,
  };
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
  saveInlineDraft();
}
$("inlineText").addEventListener("input", saveInlineDraft);
$('rebaseInline').onclick = () => {
  const c = view.state.components.find(c => c.id === inlineTarget.componentId);
  const node = c?.kind === 'html' ? htmlNodes(c.html).find(n => n.id === inlineTarget.nodeId && n.leaf) : c?.kind === 'mind_map' ? c.nodes.find(n => n.id === inlineTarget.nodeId) && {text:c.nodes.find(n => n.id === inlineTarget.nodeId).label} : c && {text:c[inlineTarget.nodeId]};
  if (!node) { $('inlineError').textContent = 'Target no longer exists or is not a text leaf.'; return; }
  $('inlineContext').textContent = `Latest r${view.revision}: ${node.text}. Your draft is retained. Commit explicitly to replace this text.`;
  inlineTarget.baseRevision = view.revision;
  $('inlineError').textContent = '';
  saveInlineDraft();
};
$('reloadEditor').onclick = () => { if (discardDraft()) fillEditor(); };
$("cancelInline").onclick = () => { $("inlineEdit").close(); clearInlineDraft(); };
$("inlineForm").onsubmit = async (event) => {
  event.preventDefault();
  if (inlineTarget.nodeId === "title" && !$("inlineText").value.trim()) {
    $("inlineError").textContent = "Title cannot be empty";
    return;
  }
  try {
    const next = await api(inlineTarget.mindMap ? "command" : "component", inlineTarget.mindMap
      ? { operation: 'mind_map_rename', componentId:inlineTarget.componentId, nodeId:inlineTarget.nodeId, text:$('inlineText').value, baseRevision:inlineTarget.baseRevision }
      : { operation: "set_text", ...inlineTarget, text: $("inlineText").value });
    $("inlineEdit").close();
    clearInlineDraft();
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
$('newMindMap').onclick = () => act(async () => {
  if (!discardDraft()) return false;
  const next = await api('command',{operation:'create_mind_map',componentId:`map-${crypto.randomUUID().slice(0,8)}`,baseRevision:view.revision});
  selected = next.state.components.at(-1).id; mindSelection={mode:'node',nodeIds:[next.state.components.at(-1).rootId]}; render(next);
}, 'Mind map created.');
for (const [id, mode] of [['selectNode','node'],['selectSubtree','subtree'],['selectMulti','multi']]) $(id).onclick=()=>{
  mindSelectionMode=mode;
  if (mindSelection.nodeIds.length) mindSelection={mode,nodeIds:mode==='multi'?mindSelection.nodeIds:[mindSelection.nodeIds[0]]};
  render(view);
};
async function mindCommand(operation, extra={}) {
  if (!discardDraft()) return false;
  const nodeId=mindSelection.nodeIds[0];
  const next=await api('command',{operation,componentId:selected,nodeId,parentId:nodeId,baseRevision:view.revision,...extra});
  if (operation==='mind_map_add') {
    const map=next.state.components.find(c=>c.id===selected);
    const added=map.nodes.find(n=>!view.state.components.find(c=>c.id===selected).nodes.some(old=>old.id===n.id));
    if (added) { mindSelectionMode='node'; mindSelection={mode:'node',nodeIds:[added.id]}; }
  }
  render(next);
}
$('addMindNode').onclick=()=>act(()=>mindCommand('mind_map_add',{text:'New idea'}),'Child node added.');
$('deleteMindNode').onclick=()=>act(()=>mindCommand('mind_map_delete'),'Branch deleted.');
$('duplicateMindNode').onclick=()=>act(()=>mindCommand('mind_map_duplicate'),'Branch duplicated.');
$('mindEarlier').onclick=()=>act(async()=>{
  const map=view.state.components.find(c=>c.id===selected), node=map.nodes.find(n=>n.id===mindSelection.nodeIds[0]);
  return mindCommand('mind_map_move',{parentId:node.parentId,order:Math.max(0,node.order-1)});
},'Node reordered.');
$('mindLater').onclick=()=>act(async()=>{
  const map=view.state.components.find(c=>c.id===selected), node=map.nodes.find(n=>n.id===mindSelection.nodeIds[0]);
  const peers=map.nodes.filter(n=>n.parentId===node.parentId);
  return mindCommand('mind_map_move',{parentId:node.parentId,order:Math.min(peers.length-1,node.order+1)});
},'Node reordered.');
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
    runningRevision = view.revision;
    $("run").disabled = true;
    status("Agent is preparing a proposal…");
    try {
      render(
        await api("agent", {
          prompt: $("prompt").value,
          engine: $("engine").value,
          capture: $("capture").checked,
          componentId: selected,
          ...(view.state.components.find(c=>c.id===selected)?.kind === 'mind_map' && mindSelection.nodeIds.length ? { selection: mindSelection } : {}),
          baseRevision: view.revision,
          reviewMode: $("reviewBeforeCommit").checked ? "stage" : "commit",
        }),
      );
    } finally {
      running = false;
      runningRevision = null;
      $("run").disabled = false;
    }
  }, $("reviewBeforeCommit").checked ? "Proposal ready for review." : "Agent proposal validated and committed. Try Undo.");
for (const [buttonId, decision] of [["acceptProposal", "accept"], ["rejectProposal", "reject"]])
  $(buttonId).onclick = () => act(async () => {
    const proposal = view.proposal;
    render(await api("proposal", { proposalId: proposal.proposalId, decision, baseRevision: proposal.baseRevision }));
  }, decision === "accept" ? "Proposal accepted and committed." : "Proposal rejected without changing the canvas.");
$("importArchive").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  const file = $("importFile").files[0];
  if (!file) return;
  try {
    const archive = JSON.parse(await file.text());
    if (!confirm("Replace this workspace with the imported trajectory?")) return;
    clearInlineDraft();
    render(await api("import", { archive }));
    status("Trajectory restored with its full history.");
  } catch (error) {
    status(error.message, true);
  } finally {
    $("importFile").value = "";
  }
};
for (const button of document.querySelectorAll("[data-prompt]"))
  button.onclick = () => {
    $("prompt").value = button.dataset.prompt;
  };
for (const scenario of scenarios)
  $("scenario").append(new Option(scenario.title, scenario.id));
$("scenario").onchange = () => {
  selectedScenarioId = $("scenario").value;
  renderScenario(false);
};
$("loadScenario").onclick = () =>
  act(async () => {
    if (!discardDraft()) return false;
    const next = await api("scenario", {
      scenarioId: selectedScenarioId,
      baseRevision: view.revision,
    });
    selected = next.selectedComponentId;
    dirty = false;
    render(next);
  }, "CUJ fixture committed. Follow the steps; progress updates from the model and trajectory.");
try {
  const response = await fetch("/api/state");
  const initial = await response.json();
  token = initial.token;
  $("engine").querySelector("[value=codex]").disabled = !initial.codexEnabled;
  $("engine").querySelector("[value=dsh]").disabled = !initial.dshEnabled;
  render(initial);
  status("Ready. Edit the selected component or try an agent instruction.");
  const savedInline = sessionStorage.getItem(inlineDraftKey);
  if (savedInline) {
    try {
      const draft = JSON.parse(savedInline);
      const component = view.state.components.find((item) => item.id === draft.componentId);
      if (component) {
        openInline(component, draft.nodeId);
        inlineTarget.baseRevision = draft.baseRevision;
        $("inlineText").value = draft.value;
        saveInlineDraft();
      } else clearInlineDraft();
    } catch { clearInlineDraft(); }
  }
  if (evalMode) {
    refreshConnection();
  } else {
    const events = new EventSource("/api/stream");
    events.onmessage = (e) => render(JSON.parse(e.data));
    events.onopen = () => {
      $("connection").textContent = "● Connected";
    };
    events.onerror = () => {
      $("connection").textContent = "Reconnecting…";
    };
  }
} catch (error) {
  status(error.message, true);
}

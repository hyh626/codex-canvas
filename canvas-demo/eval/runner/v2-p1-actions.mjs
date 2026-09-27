import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../../server.mjs";

/**
 * Execution drivers for the five P1 CUJ action kinds.
 *
 * run.mjs integration contract:
 *
 *   const outcome = await executeV2P1Action({ action, context });
 *
 * `action` is one JSONL action record. `context` must provide:
 * - `page`: the Playwright page currently displaying the eval workspace.
 * - `app`: the createApp result (`app.store.state`, `.revision`, and `.events`).
 * - `request(method, pathname, payload?)`: authenticated same-origin API request;
 *   returns `{ ok, status, body }`, including real HTTP failures.
 * - `renderCurrent()`: fetch and render the current API model in the eval page.
 * - `renderSnapshot(body, options?)`: render an API response without another request.
 * - `selectedComponentId`: actual model ID resolved by the caller's alias map.
 *
 * Return values use the runner's `{ ok, status, body }` shape and may include
 * `evidence`, which is diagnostic evidence for action-results.jsonl. This
 * module never converts an unimplemented endpoint into success.
 */

const result = (ok, status, body, evidence = undefined) => ({
  ok,
  status,
  body,
  ...(evidence === undefined ? {} : { evidence }),
});

const evidenceForResponse = (method, pathname, response) => ({
  request: { method, pathname },
  response: { status: response.status, ok: response.ok, body: response.body },
});

function applyChanges(state, changes) {
  const next = structuredClone(state);
  for (const change of changes ?? []) {
    const component = next.components.find((item) => item.id === change.component_id);
    if (!component) throw new Error(`Unknown component: ${change.component_id}`);
    if (!Object.hasOwn(component, change.field))
      throw new Error(`Field ${change.field} does not exist on component ${change.component_id}`);
    component[change.field] = change.value;
  }
  return next;
}

async function coordinatedChange(action, context) {
  const { app, request, renderSnapshot, selectedComponentId } = context;
  let next;
  try {
    next = applyChanges(app.store.state, action.input.changes);
  } catch (error) {
    return result(false, 400, { error: error.message }, { validation_error: error.message });
  }
  const response = await request("POST", "/api/edit", {
    state: next,
    baseRevision: app.store.revision,
    commandId: `eval-${action.step}`,
  });
  if (response.ok)
    await renderSnapshot(response.body, { selectedComponentId });
  return {
    ...response,
    evidence: {
      ...evidenceForResponse("POST", "/api/edit", response),
      requested_changes: action.input.changes,
      resulting_component_ids: app.store.state.components.map(({ id }) => id),
      resulting_revision: app.store.revision,
    },
  };
}

async function commentLifecycle(action, context) {
  const { request, app, selectedComponentId, page, renderSnapshot } = context;
  const setup = await request("POST", "/api/comment", {
    componentId: selectedComponentId,
    nodeId: "title",
    baseRevision: app.store.revision,
    text: `Eval anchor for ${action.input.operation}`,
    commandId: `eval-comment-${action.step}`,
  });
  if (!setup.ok)
    return { ...setup, evidence: evidenceForResponse("POST", "/api/comment", setup) };
  const created = [...(setup.body?.events ?? [])].reverse().find((event) => event.type === "comment.created");
  if (!created) return result(false, 502, { error: "Comment endpoint returned no comment.created event" });

  if (action.input.operation === "remove_anchor") {
    const next = structuredClone(app.store.state);
    const component = next.components.find((item) => item.id === selectedComponentId);
    if (component?.kind !== "html" || !component.html.includes('data-node-id="title"'))
      return result(false, 400, { error: "Orphan case requires an HTML title node" });
    component.html = component.html.replace('data-node-id="title"', 'data-node-id="replacement"');
    const edit = await request("POST", "/api/edit", {
      state: next,
      baseRevision: app.store.revision,
      commandId: `eval-orphan-${action.step}`,
    });
    if (edit.ok) await renderSnapshot(edit.body, { selectedComponentId });
    const historical = edit.ok && await page.getByRole("button", { name: "Node removed · historical comment" }).count() === 1;
    return {
      ...edit,
      ok: edit.ok && historical,
      evidence: {
        setup: evidenceForResponse("POST", "/api/comment", setup),
        edit: evidenceForResponse("POST", "/api/edit", edit),
        historical_comment_visible: historical,
      },
    };
  }

  // The comment-create endpoint exists today. Lifecycle mutations are sent to
  // the explicit lifecycle route so a missing product endpoint is observed as
  // an actual HTTP failure, with the successfully created anchor retained.
  const pathname = `/api/comment-lifecycle/${encodeURIComponent(action.input.operation)}`;
  const sourceNode = action.input.from_node_id?.endsWith("-title") ? "title" : action.input.from_node_id;
  const targetComponentId = action.input.to_node_id?.replace(/-(title|body)$/, "");
  const targetNodeId = action.input.to_node_id?.match(/-(title|body)$/)?.[1] ?? action.input.to_node_id;
  const lifecycle = await request("POST", pathname, {
    comment_id: created.event_id,
    component_id: selectedComponentId,
    from_node_id: sourceNode,
    target_component_id: targetComponentId,
    to_node_id: targetNodeId,
    operation: action.input.operation,
  });
  if (lifecycle.ok) await renderSnapshot(lifecycle.body, { selectedComponentId });
  return {
    ...lifecycle,
    evidence: {
      setup: evidenceForResponse("POST", "/api/comment", setup),
      lifecycle: evidenceForResponse("POST", pathname, lifecycle),
      event_count_after_setup: app.store.events.length,
    },
  };
}

async function exportRestore(action, context) {
  const { request, app } = context;
  const archiveResponse = await request("GET", "/api/export");
  if (!archiveResponse.ok)
    return { ...archiveResponse, evidence: evidenceForResponse("GET", "/api/export", archiveResponse) };

  const archive = structuredClone(archiveResponse.body);
  const archiveEvidence = {
    format: archive?.format,
    event_bytes: typeof archive?.events_jsonl === "string" ? Buffer.byteLength(archive.events_jsonl) : null,
    blob_count: archive?.blobs && typeof archive.blobs === "object" ? Object.keys(archive.blobs).length : 0,
  };
  if (action.input.fault === "missing_blob" && archive.blobs) {
    const firstBlob = Object.keys(archive.blobs)[0];
    if (firstBlob) {
      delete archive.blobs[firstBlob];
    } else {
      // Make the archive reference a syntactically valid SHA-256 asset, then
      // omit it. This exercises the missing-reference check rather than
      // succeeding/failing on an unrelated malformed blob key.
      const missingBytes = Buffer.from(`missing-eval-blob-${action.step}`);
      const missingHash = createHash("sha256").update(missingBytes).digest("hex");
      const events = archive.events_jsonl.trimEnd().split("\n").map(JSON.parse);
      events[0].eval_asset = { sha256: missingHash, size_bytes: missingBytes.length };
      archive.events_jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    }
  }

  const destinationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-eval-restore-"));
  const destination = createApp({ dir: destinationDirectory });
  try {
    await new Promise((resolve) => destination.server.listen(0, "127.0.0.1", resolve));
    const destinationUrl = `http://127.0.0.1:${destination.server.address().port}`;
    const initial = await (await fetch(`${destinationUrl}/api/state`)).json();
    const destinationBefore = { state: initial.state, revision: initial.revision, events: initial.events };
    const response = await fetch(`${destinationUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": initial.token },
      body: JSON.stringify({ archive, fault: action.input.fault ?? null, operation: action.input.operation }),
    });
    const restore = { ok: response.ok, status: response.status, body: await response.json() };
    const destinationAfter = await (await fetch(`${destinationUrl}/api/state`)).json();
    const destinationUnchanged = JSON.stringify(destinationBefore) === JSON.stringify({ state: destinationAfter.state, revision: destinationAfter.revision, events: destinationAfter.events });
    const destinationRestored = restore.ok &&
      destinationAfter.revision === app.store.revision &&
      JSON.stringify(destinationAfter.state) === JSON.stringify(app.store.state) &&
      JSON.stringify(destinationAfter.events) === JSON.stringify(app.store.events);
    return {
      ...restore,
      ok: restore.ok && destinationRestored,
      evidence: {
        archive: archiveEvidence,
        restore: evidenceForResponse("POST", "/api/import", restore),
        destination_before: destinationBefore,
        destination_after: { state: destinationAfter.state, revision: destinationAfter.revision, events: destinationAfter.events },
        destination_unchanged: destinationUnchanged,
        destination_restored: destinationRestored,
      },
    };
  } finally {
    await new Promise((resolve) => { destination.server.once("close", resolve); destination.close(); });
    fs.rmSync(destinationDirectory, { recursive: true, force: true });
  }
}

async function readUiState(page) {
  return page.evaluate(() => globalThis.__canvasEval?.observedUIState?.() ?? null);
}

async function openInline(page, componentId, nodeId, value, baseRevision) {
  await page.evaluate(
    ({ componentId, nodeId, value, baseRevision }) =>
      globalThis.__canvasEval.openInline(componentId, nodeId, value, baseRevision),
    { componentId, nodeId, value, baseRevision },
  );
  await page.locator("#inlineText").focus();
}

async function submitInline(page) {
  let responseStatus = null;
  const onResponse = (response) => {
    if (new URL(response.url()).pathname === "/api/component") responseStatus = response.status();
  };
  page.on("response", onResponse);
  try {
    await page.getByRole("button", { name: "Commit edit" }).last().click();
    await page.waitForFunction(() => {
      const dialog = document.getElementById("inlineEdit");
      return !dialog?.open || Boolean(document.getElementById("inlineError")?.textContent);
    }, null, { timeout: 5000 });
  } finally {
    page.off("response", onResponse);
  }
  return { responseStatus, ui: await readUiState(page), alert: await page.locator("#inlineError").textContent() };
}

async function reconnect(action, context) {
  const { page, app, request, selectedComponentId, renderCurrent } = context;
  const operation = action.input.operation;
  if (operation === "reload_resume") {
    await openInline(page, selectedComponentId, "title", action.input.draft, app.store.revision);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(globalThis.__canvasEval));
    const ui = await readUiState(page);
    const current = await request("GET", "/api/state");
    const modelMatches = current.ok && JSON.stringify(current.body.state) === JSON.stringify(app.store.state);
    const draftRetained = ui?.editor?.draft?.value === action.input.draft;
    return result(
      current.ok && modelMatches && draftRetained,
      current.ok && modelMatches && draftRetained ? 200 : 422,
      current.body,
      { operation, ui_after_reload: ui, model_matches_server: modelMatches, draft_retained: draftRetained },
    );
  }

  const draft = operation === "concurrent_edit" ? action.input.local_title : action.input.draft;
  const nodeId = "title";
  const baseRevision = app.store.revision;
  await openInline(page, selectedComponentId, nodeId, draft, baseRevision);
  const offlineBefore = await readUiState(page);
  await page.context().setOffline(true);
  await page.waitForFunction(() => globalThis.__canvasEval?.observedUIState?.().connection !== "connected", null, { timeout: 2000 }).catch(() => {});
  const uiWhileOffline = await readUiState(page);
  const disconnectedObserved = ["disconnected", "reconnecting"].includes(uiWhileOffline?.connection);
  let remote = null;
  let submit;
  try {
    if (operation === "disconnect_with_draft") {
      await page.context().setOffline(false);
      await page.waitForFunction(() => globalThis.__canvasEval?.observedUIState?.().connection === "connected", null, { timeout: 2000 }).catch(() => {});
      const uiAfterReconnect = await readUiState(page);
      const retained = uiAfterReconnect?.editor?.draft?.value === draft;
      const reconnectedObserved = uiAfterReconnect?.connection === "connected";
      const ok = retained && disconnectedObserved && reconnectedObserved;
      return result(ok, ok ? 200 : 422, { draft_retained: retained }, {
        operation, offline_ui_before: offlineBefore, ui_while_offline: uiWhileOffline,
        ui_after_reconnect: uiAfterReconnect, retained_draft: uiAfterReconnect?.editor?.draft ?? null,
        disconnected_observed: disconnectedObserved, reconnected_observed: reconnectedObserved,
      });
    }
    if (operation === "concurrent_edit") {
      const remoteResponse = await request("POST", "/api/component", {
        operation: "set_text",
        componentId: selectedComponentId,
        nodeId,
        text: action.input.remote_title,
        baseRevision: app.store.revision,
        commandId: `eval-remote-${action.step}`,
      });
      remote = evidenceForResponse("POST", "/api/component", remoteResponse);
      if (!remoteResponse.ok)
        return { ...remoteResponse, evidence: { operation, offline_ui_before: offlineBefore, remote } };
    }
    await page.context().setOffline(false);
    submit = await submitInline(page);
    if (!submit.alert && submit.responseStatus === 200) await renderCurrent();
    const ok = operation === "concurrent_edit"
      ? disconnectedObserved && submit.responseStatus === 409 && Boolean(submit.alert) &&
        submit.ui?.editor?.draft?.value === draft && app.store.state.components.find((item) => item.id === selectedComponentId)?.title === action.input.remote_title
      : Boolean(submit.ui?.editor?.draft) && Boolean(submit.alert);
    return result(ok, submit.responseStatus ?? (ok ? 200 : 503), { error: submit.alert || null }, {
      operation,
      offline_ui_before: offlineBefore,
      ui_while_offline: uiWhileOffline,
      disconnected_observed: disconnectedObserved,
      remote,
      submit_http_status: submit.responseStatus,
      submit_ui: submit.ui,
      retained_draft: submit.ui?.editor?.draft ?? null,
    });
  } finally {
    await page.context().setOffline(false).catch(() => {});
  }
}

async function keyboardInteraction(action, context) {
  const { page, app, selectedComponentId, renderCurrent } = context;
  page.setDefaultTimeout(4000);
  const steps = action.input.steps ?? [];
  const component = app.store.state.components.find((item) => item.id === selectedComponentId);
  if (!component) return result(false, 404, { error: `Component ${selectedComponentId} not found` });
  if (action.input.viewport) await page.setViewportSize(action.input.viewport);
  if (action.input.text_scale) await page.evaluate((scale) => { document.body.style.zoom = String(scale); }, action.input.text_scale);

  if (steps.includes("focus-title")) {
    await page.getByRole("heading", { name: component.title, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("inlineEdit")?.open === true);
  }
  if (steps.includes("edit")) {
    const textbox = page.locator("#inlineText");
    await textbox.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(action.input.new_title ?? "Focused launch");
  }
  if (steps.includes("save")) {
    await page.getByRole("button", { name: "Commit edit" }).last().focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("inlineEdit")?.open, null, { timeout: 5000 });
  }
  if (steps.includes("undo")) {
    await page.locator("body").focus();
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.getElementById("undo")?.disabled === true, null, { timeout: 5000 }).catch(() => {});
  }
  let cardReachable = !steps.includes("open-card");
  if (steps.includes("open-card")) {
    await page.locator("body").focus();
    for (let tab = 0; tab < 50 && !cardReachable; tab += 1) {
      await page.keyboard.press("Tab");
      cardReachable = await page.evaluate(
        (componentId) => document.activeElement?.closest?.("[data-component-id]")?.dataset.componentId === componentId,
        selectedComponentId,
      );
    }
  }
  if (steps.includes("read-body")) {
    const body = page.locator(`[data-component-id="${selectedComponentId}"] p`).first();
    await body.focus();
  }
  if (steps.includes("close-card")) {
    await page.keyboard.press("Escape");
  }
  if (steps.includes("submit-invalid")) {
    const nodeId = action.input.node_id ?? "title";
    await openInline(page, selectedComponentId, nodeId, action.input.value ?? " ", app.store.revision);
    await page.locator("#inlineText").focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(action.input.value ?? " ");
    await page.getByRole("button", { name: "Commit edit" }).last().focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => Boolean(document.querySelector("#inlineError")?.textContent), null, { timeout: 5000 }).catch(() => {});
  }

  if (steps.includes("read-live-region")) {
    const alert = await page.locator("#inlineError").textContent();
    const role = await page.locator("#inlineError").getAttribute("role");
    const state = await readUiState(page);
    const announced = role === "alert" && Boolean(alert?.trim());
    return result(announced, announced ? 200 : 422, { alert }, {
      alert_role: role,
      alert_text: alert,
      active_element: await page.evaluate(() => document.activeElement?.id ?? null),
      ui_state: state,
    });
  }

  if (steps.includes("undo")) await renderCurrent();
  const ui = await readUiState(page);
  const layout = await page.evaluate(() => ({
    scroll_width: document.documentElement.scrollWidth,
    viewport_width: document.documentElement.clientWidth,
    focused_component_id: document.activeElement?.closest?.("[data-component-id]")?.dataset.componentId ?? null,
    overflowing_elements: [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 12)
      .map((element) => ({ tag: element.tagName.toLowerCase(), id: element.id, class_name: element.className, right: Math.round(element.getBoundingClientRect().right) })),
  }));
  const reachable = cardReachable;
  const bodyReachable = !steps.includes("read-body") || await page.evaluate(
    (componentId) => document.activeElement === document.querySelector(`[data-component-id="${componentId}"] p`),
    selectedComponentId,
  );
  const noOverflow = layout.scroll_width <= layout.viewport_width;
  const ok = reachable && bodyReachable && noOverflow;
  return result(ok, ok ? 200 : 422, { ui, layout }, { steps, ui, viewport: page.viewportSize(), layout, card_reachable: cardReachable, body_reachable: bodyReachable });
}

export async function executeV2P1Action({ action, context }) {
  if (!action || !context) throw new TypeError("action and context are required");
  switch (action.kind) {
    case "coordinated_change":
      return coordinatedChange(action, context);
    case "comment_lifecycle":
      return commentLifecycle(action, context);
    case "export_restore":
      return exportRestore(action, context);
    case "reconnect":
      return reconnect(action, context);
    case "keyboard_interaction":
      return keyboardInteraction(action, context);
    default:
      throw new Error(`Not a P1 action kind: ${action.kind}`);
  }
}

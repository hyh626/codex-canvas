import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const mediaExtensions = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["text/html", ".html"],
  ["text/yaml", ".yaml"],
  ["application/json", ".json"],
]);

export class ArtifactStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }

  put(value, mediaType = "application/json") {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === "string" ? value : canonical(value));
    const sha256 = digest(bytes);
    const relativePath = `${sha256}${mediaExtensions.get(mediaType) ?? ".bin"}`;
    const target = path.join(this.directory, relativePath);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    return { sha256, path: relativePath, size_bytes: bytes.length, media_type: mediaType };
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonical(value));
}

export function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

async function stablePage(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll("iframe")].map((frame) => {
      if (frame.contentDocument?.readyState === "complete") return undefined;
      return new Promise((resolve) => {
        frame.addEventListener("load", resolve, { once: true });
        setTimeout(resolve, 2000);
      });
    }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function capturePage({ page, artifacts, caseId, captureId, mode, trigger, eventsThroughSeq, consoleMessages }) {
  try {
    await stablePage(page);
    const before = eventsThroughSeq();
    const uiState = await page.evaluate(() => globalThis.__canvasEval.observedUIState());
    const view = await page.evaluate(() => globalThis.__canvasEval.currentView());
    const appPng = await page.screenshot({ fullPage: false, animations: "disabled", caret: "hide" });
    const canvas = page.locator("#canvas");
    const canvasPng = await canvas.screenshot({ animations: "disabled", caret: "hide" });
    const appBox = await page.locator("body").boundingBox();
    const canvasBox = await canvas.boundingBox();
    const screenshots = [
      { surface: "app", artifact: artifacts.put(appPng, "image/png"), width: Math.max(1, Math.round(appBox?.width ?? 1)), height: Math.max(1, Math.round(appBox?.height ?? 1)) },
      { surface: "canvas", selector: "#canvas", artifact: artifacts.put(canvasPng, "image/png"), width: Math.max(1, Math.round(canvasBox?.width ?? 1)), height: Math.max(1, Math.round(canvasBox?.height ?? 1)) },
    ];
    const selected = uiState.selected_component_id;
    const selectedCard = selected ? page.locator(`[data-component-id="${selected}"]`) : null;
    if (selectedCard && await selectedCard.count()) {
      const componentBox = await selectedCard.boundingBox();
      if (componentBox) screenshots.push({ surface: "component", selector: `[data-component-id="${selected}"]`, component_id: selected, artifact: artifacts.put(await selectedCard.screenshot({ animations: "disabled", caret: "hide" }), "image/png"), width: Math.max(1, Math.round(componentBox.width)), height: Math.max(1, Math.round(componentBox.height)) });
    }
    const iframeEvidence = await page.evaluate(() => [...document.querySelectorAll("iframe.html-preview")].map((frame) => {
      const component = frame.closest("[data-component-id]");
      const documentRoot = frame.contentDocument?.documentElement;
      if (!documentRoot) return { component_id: component?.dataset.componentId ?? "unknown", selector: `iframe[title=${JSON.stringify(frame.title)}]`, status: "error", error: { name: "IframeUnavailable", message: "iframe contentDocument is unavailable" } };
      return {
        component_id: component?.dataset.componentId ?? "unknown",
        selector: `iframe[title=${JSON.stringify(frame.title)}]`,
        status: "ready",
        dom: documentRoot.outerHTML,
        layout: [...frame.contentDocument.querySelectorAll("[data-node-id]")].map((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { node_id: node.dataset.nodeId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, flex_direction: style.flexDirection };
        }),
      };
    }));
    const iframes = iframeEvidence.map((item) => item.status === "ready"
      ? { component_id: item.component_id, selector: item.selector, status: "ready", dom: artifacts.put(item.dom, "text/html"), layout: artifacts.put(item.layout) }
      : item);
    const dom = await page.content();
    const accessibility = await page.locator("body").ariaSnapshot();
    const after = eventsThroughSeq();
    if (before !== after) throw Object.assign(Error(`trajectory moved during capture: ${before} -> ${after}`), { stage: "stability" });
    const modelRef = artifacts.put(view.state);
    const modelHash = digest(Buffer.from(canonical(view.state)));
    const record = {
      schema_version: 1,
      capture_id: captureId,
      case_id: caseId,
      mode,
      status: "ok",
      trigger,
      state: { events_through_seq: before, revision: view.revision, model: modelRef, model_hash: modelHash, ui_state: artifacts.put(uiState) },
      evidence: {
        stability: { renderer_seq: before, fonts_ready: true, pending_requests: 0, animation_frames_waited: 2, iframes_expected: iframeEvidence.length, iframes_ready: iframeEvidence.filter((item) => item.status === "ready").length },
        captures: screenshots,
        dom: artifacts.put(dom, "text/html"),
        accessibility: artifacts.put(accessibility, "text/yaml"),
        console: artifacts.put(consoleMessages),
        iframes,
      },
    };
    if (mode === "live_checkpoint") {
      record.trigger.action.event_seq_at_capture = before;
      record.trigger.action.event_seq_after_capture = after;
    }
    return { record, uiState };
  } catch (error) {
    return {
      record: {
        schema_version: 1,
        capture_id: captureId,
        case_id: caseId,
        mode,
        status: error.stage === "stability" ? "blocked" : "render_error",
        trigger,
        error: { stage: error.stage ?? "capture", name: error.name, message: error.message },
      },
      uiState: null,
    };
  }
}

export function partialEqual(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => partialEqual(actual[index], item));
  return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => partialEqual(actual[key], value));
}

import { stable } from "../../store.mjs";

/** Validate the committed rooted ordered-tree model before considering its rendering. */
export function judgeMindMapModel(component, { maxNodes = 64 } = {}) {
  const errors = [];
  if (!component || component.kind !== "mind_map") return { pass: false, errors: ["component is not kind mind_map"] };
  const nodes = component.nodes;
  if (!Array.isArray(nodes)) return { pass: false, errors: ["nodes must be an array"] };
  if (nodes.length === 0) errors.push("mind map must have at least one node");
  if (nodes.length > maxNodes) errors.push(`node count ${nodes.length} exceeds limit ${maxNodes}`);
  const byId = new Map();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id) errors.push("every node requires a non-empty string id");
    else if (byId.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    else byId.set(node.id, node);
    if (typeof node?.label !== "string") errors.push(`node ${node?.id ?? "?"} label must be a string`);
    if (!Number.isInteger(node?.order) || node.order < 0) errors.push(`node ${node?.id ?? "?"} order must be a non-negative integer`);
  }
  const root = byId.get(component.rootId);
  if (!root) errors.push(`rootId ${component.rootId ?? "<missing>"} does not reference a node`);
  else if (root.parentId !== null) errors.push("root node parentId must be null");
  const siblings = new Map();
  for (const node of nodes) {
    if (node.id === component.rootId) continue;
    if (!byId.has(node.parentId)) errors.push(`node ${node.id} references missing parent ${node.parentId}`);
    const list = siblings.get(node.parentId) ?? [];
    list.push(node);
    siblings.set(node.parentId, list);
  }
  for (const [parentId, children] of siblings) {
    const orders = children.map(({ order }) => order).sort((a, b) => a - b);
    if (new Set(orders).size !== orders.length) errors.push(`siblings of ${parentId} have duplicate order values`);
    if (orders.some((order, index) => order !== index)) errors.push(`siblings of ${parentId} must have contiguous order values starting at zero`);
  }
  for (const node of nodes) {
    const seen = new Set();
    let current = node;
    while (current && current.id !== component.rootId) {
      if (seen.has(current.id)) { errors.push(`cycle detected at node ${current.id}`); break; }
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    if (!current) errors.push(`node ${node.id} is disconnected from root ${component.rootId}`);
  }
  return { pass: errors.length === 0, errors, nodeCount: nodes.length, rootId: component.rootId };
}

/** Inspect rendered node/edge DOM and screen geometry against the committed tree. */
export async function inspectMindMapDom(page, componentId) {
  return page.evaluate((id) => {
    const escape = globalThis.CSS?.escape ?? ((value) => value.replaceAll('"', '\\"'));
    const component = document.querySelector(`[data-component-id="${escape(id)}"]`);
    if (!component) return { found: false, nodeIds: [], edges: [], nodes: [], componentBounds: null };
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const nodes = [...component.querySelectorAll(".mind-map-node[data-node-id]")].map((element) => ({
      id: element.getAttribute("data-node-id"), label: element.textContent.trim(), bounds: rect(element),
    }));
    const edges = [...component.querySelectorAll("[data-edge-from][data-edge-to]")].map((element) => {
      const pathBounds = rect(element);
      let points = null;
      try {
        const length = element.getTotalLength();
        const start = element.getPointAtLength(0), end = element.getPointAtLength(length);
        const matrix = element.getScreenCTM();
        if (matrix) {
          const toScreen = (point) => {
            const screen = element.ownerSVGElement.createSVGPoint();
            screen.x = point.x; screen.y = point.y;
            const transformed = screen.matrixTransform(matrix);
            return { x: transformed.x, y: transformed.y };
          };
          points = { start: toScreen(start), end: toScreen(end) };
        }
      } catch {}
      const style = getComputedStyle(element);
      return {
        from: element.getAttribute("data-edge-from"), to: element.getAttribute("data-edge-to"),
        visible: (pathBounds.width > 0 || pathBounds.height > 0) && style.display !== "none" && style.visibility !== "hidden" && style.stroke !== "none",
        points,
      };
    });
    const canvas = document.querySelector('#canvas');
    return { found: true, nodeIds: nodes.map(({ id: nodeId }) => nodeId), nodes, edges,
      componentBounds: rect(component), canvasViewportBounds: canvas ? rect(canvas) : null };
  }, componentId);
}

export function judgeMindMapDom(component, dom, { gap = 0, connectorTolerance = 8, requireViewportFit = false } = {}) {
  const errors = [];
  if (!dom?.found) return { pass: false, errors: ["mind map component is missing from rendered DOM"] };
  const expectedIds = component.nodes.map(({ id }) => id).sort();
  const actualIds = [...dom.nodeIds].sort();
  if (stable(actualIds) !== stable(expectedIds)) errors.push("rendered node IDs do not match committed node IDs");
  const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
  if (duplicates.length) errors.push(`rendered duplicate node IDs: ${[...new Set(duplicates)].join(", ")}`);
  const byNode = new Map(dom.nodes.map((node) => [node.id, node]));
  const modelById = new Map(component.nodes.map((node) => [node.id, node]));
  const bounds = dom.componentBounds;
  for (const node of dom.nodes) {
    const box = node.bounds;
    const expectedLabel = modelById.get(node.id)?.label;
    if (typeof expectedLabel === "string" && node.label !== expectedLabel)
      errors.push(`rendered node ${node.id} label does not exactly match the committed label`);
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
      errors.push(`node ${node.id} has invalid or empty geometry`);
    if (bounds && (box.x < bounds.x - 1 || box.y < bounds.y - 1 || box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1))
      errors.push(`node ${node.id} lies outside its mind map component bounds`);
    const viewport = dom.canvasViewportBounds;
    if (requireViewportFit && viewport && (box.x < viewport.x - 1 || box.right > viewport.right + 1))
      errors.push(`node ${node.id} is clipped by the canvas viewport`);
  }
  for (let i = 0; i < dom.nodes.length; i++) for (let j = i + 1; j < dom.nodes.length; j++) {
    const a = dom.nodes[i].bounds, b = dom.nodes[j].bounds;
    if (a.x < b.right + gap && a.right + gap > b.x && a.y < b.bottom + gap && a.bottom + gap > b.y)
      errors.push(`rendered nodes ${dom.nodes[i].id} and ${dom.nodes[j].id} overlap`);
  }
  const expectedEdges = component.nodes.filter(({ id }) => id !== component.rootId).map(({ id, parentId }) => `${parentId}\u0000${id}`).sort();
  const actualEdges = dom.edges.map(({ from, to }) => `${from}\u0000${to}`).sort();
  if (stable(actualEdges) !== stable(expectedEdges)) errors.push("rendered connector pairs do not match committed parent-child relationships");
  for (const edge of dom.edges) {
    if (!byNode.has(edge.from) || !byNode.has(edge.to)) errors.push(`connector ${edge.from} → ${edge.to} references a missing rendered node`);
    if (!edge.visible) errors.push(`connector ${edge.from} → ${edge.to} has empty geometry`);
    const parent = byNode.get(edge.from)?.bounds;
    const child = byNode.get(edge.to)?.bounds;
    if (parent && child && edge.points) {
      const expectedStart = { x: parent.right, y: parent.y + parent.height / 2 };
      const expectedEnd = { x: child.x, y: child.y + child.height / 2 };
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      if (distance(edge.points.start, expectedStart) > connectorTolerance || distance(edge.points.end, expectedEnd) > connectorTolerance)
        errors.push(`connector ${edge.from} → ${edge.to} does not join the rendered parent and child nodes`);
    } else if (parent && child) errors.push(`connector ${edge.from} → ${edge.to} has no measurable endpoint geometry`);
  }
  return { pass: errors.length === 0, errors, expectedNodeIds: expectedIds, actualNodeIds: actualIds, expectedEdges, actualEdges, nodes: dom.nodes, componentBounds: bounds };
}

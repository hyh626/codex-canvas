import assert from "node:assert/strict";
import test from "node:test";

import { judgeMindMapDom, judgeMindMapModel } from "../eval/runner/mind-map-judge.mjs";

const tree = () => ({
  id: "ideas",
  kind: "mind_map",
  rootId: "root",
  nodes: [
    { id: "root", parentId: null, order: 0, label: "Idea" },
    { id: "a", parentId: "root", order: 0, label: "A" },
    { id: "b", parentId: "root", order: 1, label: "B" },
  ],
});
const dom = () => ({
  found: true,
  nodeIds: ["root", "a", "b"],
  componentBounds: { x: 0, y: 0, width: 400, height: 300, right: 400, bottom: 300 },
  nodes: [
    { id: "root", label: "Idea", bounds: { x: 100, y: 20, width: 100, height: 40, right: 200, bottom: 60 } },
    { id: "a", label: "A", bounds: { x: 20, y: 120, width: 80, height: 40, right: 100, bottom: 160 } },
    { id: "b", label: "B", bounds: { x: 220, y: 120, width: 80, height: 40, right: 300, bottom: 160 } },
  ],
  edges: [
    { from: "root", to: "a", visible: true, points: { start: { x: 200, y: 40 }, end: { x: 20, y: 140 } } },
    { from: "root", to: "b", visible: true, points: { start: { x: 200, y: 40 }, end: { x: 220, y: 140 } } },
  ],
});

test("mind map model judge accepts a rooted ordered tree", () => {
  assert.equal(judgeMindMapModel(tree()).pass, true);
});

test("mind map model judge catches duplicate IDs, broken parents, order gaps and cycles", () => {
  const invalid = tree();
  invalid.nodes[1].parentId = "b";
  invalid.nodes[1].order = 3;
  invalid.nodes[2].parentId = "a";
  invalid.nodes.push({ id: "a", parentId: "root", order: 2, label: "duplicate" });
  const result = judgeMindMapModel(invalid);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate node id a")));
  assert.ok(result.errors.some((error) => error.includes("cycle")));
});

test("mind map DOM judge catches missing nodes, wrong connectors, overlap and out-of-bounds geometry", () => {
  const component = tree();
  const observed = dom();
  observed.nodeIds.pop();
  observed.nodes[2].bounds.x = 90;
  observed.nodes[2].bounds.right = 170;
  observed.nodes[2].label = "B with injected text";
  observed.edges.pop();
  observed.edges.push({ from: "root", to: "missing", visible: false, points: { start: { x: 600, y: 600 }, end: { x: 700, y: 700 } } });
  const result = judgeMindMapDom(component, observed);
  assert.equal(result.pass, false);
  assert.ok(result.errors.includes("rendered node IDs do not match committed node IDs"));
  assert.ok(result.errors.some((error) => error.includes("overlap")));
  assert.ok(result.errors.some((error) => error.includes("connector pairs")));
  assert.ok(result.errors.some((error) => error.includes("empty geometry")));
  assert.ok(result.errors.some((error) => error.includes("committed label")));
});

test("mind map DOM judge catches a visible connector displaced away from its nodes", () => {
  const observed = dom();
  observed.edges[0].points.start.x += 30;
  const result = judgeMindMapDom(tree(), observed);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((error) => error.includes("does not join")));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { componentCommand } from '../commands.mjs';
import { assertScopedMindMapProposal, selectionContext, validateMindMap } from '../mind-map.mjs';
import { createApp } from '../server.mjs';

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mind-map-'));
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function command(store, input) {
  return componentCommand(store, { baseRevision: store.revision, commandId: randomUUID(), ...input });
}

test('mind map commands preserve IDs, ordering and undo history', t => {
  const store = temporaryStore(t);
  command(store, { operation: 'create_mind_map', componentId: 'map-1', nodeId: 'root', text: 'Plan' });
  command(store, { operation: 'mind_map_add', componentId: 'map-1', nodeId: 'a', parentId: 'root', text: 'A' });
  command(store, { operation: 'mind_map_add', componentId: 'map-1', nodeId: 'b', parentId: 'root', text: 'B' });
  command(store, { operation: 'mind_map_add', componentId: 'map-1', nodeId: 'child', parentId: 'a', text: 'Child' });
  const before = structuredClone(store.state);
  command(store, { operation: 'mind_map_move', componentId: 'map-1', nodeId: 'a', parentId: 'b', order: 0 });
  let map = store.state.components.find(component => component.id === 'map-1');
  assert.equal(map.nodes.find(node => node.id === 'a').parentId, 'b');
  assert.equal(map.nodes.find(node => node.id === 'child').parentId, 'a');
  assert.throws(() => command(store, { operation: 'mind_map_move', componentId: 'map-1', nodeId: 'b', parentId: 'child' }), /Invalid mind map move/);
  assert.equal(store.revision, 5);
  store.history('undo', store.revision, randomUUID());
  assert.deepEqual(store.state, before);
  store.history('redo', store.revision, randomUUID());
  map = store.state.components.find(component => component.id === 'map-1');
  assert.equal(map.nodes.find(node => node.id === 'a').parentId, 'b');
  validateMindMap(map);
});

test('selected map data is canonical and proposal scope is enforced', () => {
  const component = { id:'map-1', kind:'mind_map', rootId:'root', nodes:[
    { id:'root', parentId:null, order:0, label:'Plan' },
    { id:'a', parentId:'root', order:0, label:'A' },
    { id:'child', parentId:'a', order:0, label:'Child' },
    { id:'b', parentId:'root', order:1, label:'B' },
  ] };
  const context = selectionContext(component, { mode:'subtree', nodeIds:['a'] }, 3);
  assert.deepEqual(context.context.nodes.map(node => node.id), ['a','child']);
  assert.deepEqual(context.context.ancestors, [{ id:'root', label:'Plan' }]);
  const before = { components:[component] };
  const allowed = structuredClone(before);
  allowed.components[0].nodes.find(node => node.id === 'child').label = 'Revised';
  assert.doesNotThrow(() => assertScopedMindMapProposal(before, allowed, context));
  const outside = structuredClone(allowed);
  outside.components[0].nodes.find(node => node.id === 'b').label = 'Unselected';
  assert.throws(() => assertScopedMindMapProposal(before, outside, context), /outside the selection/);
});

test('agent request records selected tree data and stages a scoped proposal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mind-map-http-'));
  const app = createApp({ dir, allowCodex:false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await (await fetch(`${base}/api/state`)).json();
  const token = initial.token;
  async function post(route, payload) {
    const response = await fetch(`${base}/api/${route}`, { method:'POST', headers:{'Content-Type':'application/json','X-Canvas-Token':token}, body:JSON.stringify(payload) });
    return { status:response.status, body:await response.json() };
  }
  const created = await post('command', { operation:'create_mind_map', componentId:'map-1', nodeId:'root', text:'Plan', baseRevision:0, commandId:'create-map' });
  assert.equal(created.status, 200);
  const staged = await post('agent', { engine:'mock', prompt:'add Next task', componentId:'map-1', selection:{mode:'node',nodeIds:['root']}, baseRevision:1, reviewMode:'stage', capture:true, commandId:'stage-map' });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.selectionContext.context.nodes[0].label, 'Plan');
  assert.equal(staged.body.selectionContext.instruction, 'add Next task');
  assert.equal(staged.body.status, 'pending');
  assert.equal(app.store.revision, 1);
  assert.ok(app.store.events.some(event => event.type === 'model.request_prepared'));
  const accepted = await post('proposal', { proposalId:staged.body.proposalId, decision:'accept', baseRevision:1, commandId:'accept-map' });
  assert.equal(accepted.status, 200);
  assert.equal(app.store.revision, 2);
  assert.equal(app.store.state.components.find(component => component.id === 'map-1').nodes.length, 2);
});

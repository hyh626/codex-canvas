import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { inspectHTML, sampleHTML, setHTMLText, mockLayout, textNodes } from '../html.mjs';

test('HTML source edits preserve surrounding bytes and reject active content/ambiguous anchors', () => {
  const updated = setHTMLText(sampleHTML, 'body', '<hello> & goodbye');
  assert.equal(updated, sampleHTML.replace('Edit this text, then ask the agent to change the layout.', '&lt;hello&gt; &amp; goodbye'));
  assert.deepEqual(textNodes(mockLayout(updated)), textNodes(updated));
  for (const bad of [sampleHTML.replace('<header', '<script'), sampleHTML.replace('data-node-id="body"', 'data-node-id="title"'), sampleHTML.replace('<h2', '<h2 onclick="alert(1)"'), sampleHTML.replace('gap:16px', 'background:url(https://example.com)'), sampleHTML.replace('</h2>', '')]) assert.throws(() => inspectHTML(bad));
  assert.throws(() => setHTMLText(sampleHTML, 'root', 'would destroy children'));
});

test('HTML CUJ: HTTP text, comment, agent layout, stale edit, undo/redo and restart preserve source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'canvas-html-'));
  let app = createApp({dir});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  let token = (await (await fetch(origin+'/api/state')).json()).token;
  const post = async (route, data) => {
    const r = await fetch(origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':token},body:JSON.stringify({commandId:randomUUID(),...data})});
    return {status:r.status,body:await r.json()};
  };
  try {
    let r = await post('component',{operation:'create_html',baseRevision:0});
    assert.equal(r.status,200);
    const id = r.body.selectedComponentId;
    const edit = {operation:'set_text',componentId:id,nodeId:'title',text:'Human title',baseRevision:1};
    assert.equal((await post('component', edit)).status,200);
    assert.equal((await post('comment',{componentId:id,nodeId:'title',baseRevision:2,text:'Keep this title when changing the layout'})).status,200);
    const before = app.store.state.components[1].html;
    r = await post('agent',{componentId:id,engine:'mock',baseRevision:2,prompt:'layout: horizontal'});
    assert.equal(r.status,200);
    const after = app.store.state.components[1].html;
    assert.notEqual(before,after);
    assert.deepEqual(textNodes(before),textNodes(after));
    assert.equal((await post('component',{...edit,text:'stale'})).status,409);
    assert.equal((await post('undo',{baseRevision:3})).status,200);
    assert.equal(app.store.state.components[1].html,before);
    assert.equal((await post('redo',{baseRevision:4})).status,200);
    const snapshot = structuredClone(app.store.view());
    const requests = snapshot.events.filter(e => e.type === 'model.request_prepared');
    assert.equal(requests.length,1);
    assert.equal(requests[0].payload.body,undefined);
    const context = app.store.rebuild(requests[0].payload.plan).input[0].content;
    assert.equal(context.snapshot.components[1].html,before);
    assert.equal(context.recentComments[0].node_id,'title');
    app.close();
    app = createApp({dir});
    assert.deepEqual(app.store.view(),snapshot);
    assert.equal(fs.readFileSync(path.join(dir,'workspace','components',id+'.html'),'utf8'),after);
  } finally { app.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

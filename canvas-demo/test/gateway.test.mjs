import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway.mjs';
import { Store, hash, stable } from '../store.mjs';

test('Responses gateway verifies persisted reconstruction before forwarding and records exact stream bytes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-gateway-')); const store = new Store(dir); let calls = 0, received;
  const wire = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const provider = http.createServer(async (req, res) => {
    calls++; let raw = ''; for await (const chunk of req) raw += chunk; received = JSON.parse(raw);
    assert.equal(req.headers.authorization, 'Bearer secret-test-key');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const gateway = await createGateway(store, { endpoint: `http://127.0.0.1:${provider.address().port}/responses`, apiKey: 'secret-test-key' });
  t.after(() => { gateway.close(); provider.closeAllConnections(); provider.close(); store.close(); fs.rmSync(dir, { recursive: true }); });
  const body = { model: 'fixture', store: false, stream: true, input: [{ role: 'user', content: 'hello' }], tools: [] };
  const post = (payload, route = '/responses') => fetch(gateway.baseURL + route, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const response = await post(body); assert.equal(response.status, 200); assert.equal(await response.text(), wire); assert.deepEqual(received, body);
  const event = store.events.find(e => e.type === 'model.request_prepared'); const rebuilt = store.rebuild(event.payload.plan);
  assert.deepEqual(rebuilt.body, body); assert.equal(event.payload.verification.assert, true); assert.equal(hash(stable(rebuilt)), event.payload.verification.request_hash); assert.equal('body' in event.payload, false);
  const chunks = store.events.filter(e => e.type === 'model.response_chunk').map(e => Buffer.from(store.get(e.payload.bytes_base64), 'base64')); assert.equal(Buffer.concat(chunks).toString(), wire);
  assert.equal(JSON.stringify(store.export()).includes('secret-test-key'), false);
  assert.equal((await post({ ...body, previous_response_id: 'remote' })).status, 400);
  assert.equal((await post(body, '/responses/compact')).status, 400); assert.equal(calls, 1);
  const original = store.rebuild.bind(store); store.rebuild = plan => { const value = original(plan); value.body.model = 'corrupt'; return value; };
  assert.equal((await post(body)).status, 400); assert.equal(calls, 1, 'mismatched reconstructed request must never reach provider');
});

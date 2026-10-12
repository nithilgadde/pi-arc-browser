import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { BrowserBridge } from '../src/bridge.mjs';

const origin = `chrome-extension://${'a'.repeat(32)}`;
async function fixture(t, options) {
  const bridge = new BrowserBridge(options);
  await bridge.start();
  t.after(() => bridge.stop());
  return bridge;
}
async function connect(bridge, token = bridge.pairing.token) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin });
  await once(ws, 'open');
  const reply = Promise.race([
    once(ws, 'message').then(([data]) => JSON.parse(data)),
    once(ws, 'close').then(([code]) => ({ closed: code })),
  ]);
  ws.send(JSON.stringify({ type: 'auth', token }));
  return { ws, reply: await reply };
}
function fakeCompanion(ws, fn = () => ({ ok: true })) {
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'request') {
      const result = fn(msg);
      if (result !== undefined) ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    }
  });
}

test('binds loopback on random port and provides no HTTP API', async t => {
  const b = await fixture(t);
  assert.equal(b.server.address().address, '127.0.0.1');
  assert.equal((await fetch(`http://127.0.0.1:${b.port}/`)).status, 404);
  assert.equal(b.pairing.token.length, 64);
  assert.equal(b.status.connected, false);
  assert.equal('token' in b.status, false);
});

test('rejects webpage origins before websocket upgrade', async t => {
  const b = await fixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/bridge`, { origin: 'https://evil.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('rejects missing origin and wrong path', async t => {
  const b = await fixture(t);
  for (const [path, opts] of [['/bridge', {}], ['/other', { origin }]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}${path}`, opts);
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
  }
});

test('rejects forged Host even with extension Origin', async t => {
  const b = await fixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/bridge`, { origin, headers: { Host: 'evil.example' } });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('rejects invalid token, accepts one authenticated companion only', async t => {
  const b = await fixture(t);
  assert.equal((await connect(b, 'bad')).reply.closed, 1008);
  const first = await connect(b);
  assert.equal(first.reply.type, 'ready');
  assert.equal((await connect(b)).reply.closed, 1008);
  assert.equal(b.connected, true);
});

test('closes unauthenticated connections on deadline', async t => {
  const b = await fixture(t, { authTimeoutMs: 20 });
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/bridge`, { origin });
  await once(ws, 'open');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
});

test('round trip returns results and keeps ping out of request pipeline', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  fakeCompanion(ws, req => ({ action: req.action, params: req.params }));
  const pong = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal(JSON.parse((await pong)[0]).type, 'pong');
  assert.deepEqual(await b.request('click', { tabId: 42, ref: 'abc' }), { action: 'click', params: { tabId: 42, ref: 'abc' } });
  assert.equal(b.pending.size, 0);
});

test('serializes requests instead of dispatching simultaneous clicks', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  const seen = [];
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type !== 'request') return;
    seen.push(msg);
    if (seen.length === 1) setTimeout(() => ws.send(JSON.stringify({ type: 'response', id: msg.id, result: 1 })), 20);
    else ws.send(JSON.stringify({ type: 'response', id: msg.id, result: 2 }));
  });
  const results = await Promise.all([b.request('click', { tabId: 1 }), b.request('type', { tabId: 1 })]);
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(seen.map(x => x.action), ['click', 'type']);
});

test('companion errors reject the tool without inventing success', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  ws.on('message', data => {
    const msg = JSON.parse(data);
    ws.send(JSON.stringify({ type: 'response', id: msg.id, error: 'Tab not shared' }));
  });
  await assert.rejects(b.request('snapshot', { tabId: 999 }), /Tab not shared/);
});

test('abort disconnects in-flight requests and does not replay queued actions', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  const controller = new AbortController();
  let calls = 0;
  fakeCompanion(ws, () => { calls++; controller.abort(); });
  const first = b.request('click', {}, controller.signal);
  const second = b.request('type', {});
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /may have occurred/);
  assert.equal(results[1].status, 'rejected');
  assert.equal(calls, 1);
  assert.equal(b.connected, false);
});

test('timeout disconnects and rejects queued work', async t => {
  const b = await fixture(t, { timeoutMs: 30 });
  const { ws } = await connect(b);
  let calls = 0;
  fakeCompanion(ws, () => { calls++; });
  const results = await Promise.allSettled([b.request('click', {}), b.request('click', {})]);
  assert.match(results[0].reason.message, /timed out/);
  assert.equal(results[1].status, 'rejected');
  assert.equal(calls, 1);
});

test('pre-aborted request is never sent', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  let calls = 0;
  fakeCompanion(ws, () => { calls++; });
  const c = new AbortController(); c.abort();
  await assert.rejects(b.request('click', {}, c.signal), /cancelled before dispatch/);
  assert.equal(calls, 0);
});

test('malformed authenticated response closes connection and rejects pending work', async t => {
  const b = await fixture(t);
  const { ws } = await connect(b);
  ws.on('message', () => ws.send('not json'));
  await assert.rejects(b.request('snapshot', { tabId: 1 }), /disconnected/);
  assert.equal(b.pending.size, 0);
});

test('stop is idempotent, revokes token, and permits fresh start', async t => {
  const b = await fixture(t);
  const token = b.pairing.token;
  await connect(b);
  await Promise.all([b.stop(), b.stop()]);
  assert.equal(b.connected, false);
  assert.equal(b.status.running, false);
  await b.start();
  assert.notEqual(b.pairing.token, token);
  assert.equal((await connect(b, token)).reply.closed, 1008);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { BrowserBridge } from '../src/bridge.mjs';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const loader = process.env.PI_EXTENSION_LOADER ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, message, milliseconds = 500) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function authenticate(bridge, token = bridge.pairing.token) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin });
  await once(ws, 'open');
  const outcome = Promise.race([
    once(ws, 'message').then(([data]) => ({ message: JSON.parse(data.toString()) })),
    once(ws, 'close').then(([code]) => ({ closed: code })),
  ]);
  ws.send(JSON.stringify({ type: 'auth', token }));
  return { ws, outcome: await outcome };
}

async function loadExtension() {
  const { loadExtensions } = await import(loader);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = await loadExtensions([`${cwd}/src/index.ts`], cwd);
  assert.deepEqual(result.errors, []);
  return result.extensions[0];
}

function deferredUI() {
  const confirmations = [];
  const notifications = [];
  const ui = {
    confirm() {
      return new Promise(resolve => confirmations.push(resolve));
    },
    notify(message, level) { notifications.push({ message, level }); },
    setStatus() {},
  };
  return { ctx: { hasUI: true, ui }, confirmations, notifications };
}

async function readMode(extension) {
  const tool = extension.tools.get('arc_browser').definition;
  const result = await tool.execute('status', { action: 'status' }, undefined, undefined, { hasUI: false });
  return JSON.parse(result.content[0].text).mode;
}

async function shutdown(extension) {
  for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, {});
}

test('rejected half-open upgrade cannot hold bridge shutdown open', async t => {
  const bridge = new BrowserBridge();
  await bridge.start();
  const socket = net.createConnection({ host: '127.0.0.1', port: bridge.port, allowHalfOpen: true });
  t.after(() => socket.destroy());
  t.after(() => bridge.stop());
  await once(socket, 'connect');
  socket.write([
    'GET /bridge HTTP/1.1',
    `Host: 127.0.0.1:${bridge.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
    'Origin: https://evil.example',
    '',
    '',
  ].join('\r\n'));
  const [response] = await once(socket, 'data');
  assert.match(response.toString(), /403 Forbidden/);

  await withTimeout(bridge.stop(), 250, 'bridge.stop() hung on a rejected half-open upgrade');
  assert.equal(bridge.status.running, false);
});

test('a closing client with pending work cannot be replaced or later disconnect a fresh client', async t => {
  const bridge = new BrowserBridge({ timeoutMs: 50 });
  await bridge.start();
  t.after(() => bridge.stop());
  const token = bridge.pairing.token;
  const first = await authenticate(bridge, token);
  assert.equal(first.outcome.message.type, 'ready');

  const requestSeen = once(first.ws, 'message');
  const pending = bridge.request('click', { tabId: 1, ref: 'r1' });
  pending.catch(() => {});
  await requestSeen;

  first.ws._socket.pause();
  first.ws.close();
  await waitFor(() => bridge.client?.readyState === WebSocket.CLOSING, 'server did not retain the old client in CLOSING state');

  const replacement = await authenticate(bridge, token);
  assert.equal(replacement.outcome.closed, 1008);
  assert.equal(bridge.client?.readyState, WebSocket.CLOSING);

  first.ws._socket.destroy();
  await assert.rejects(pending, /disconnected/i);
  await waitFor(() => !bridge.client, 'old client was not retired');

  const fresh = await authenticate(bridge, token);
  assert.equal(fresh.outcome.message.type, 'ready');
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(bridge.connected, true, 'old request timeout disconnected the fresh client');
  fresh.ws.terminate();
});

test('stale auto-mode approvals cannot override newer consent decisions', { skip: !existsSync(loader) }, async t => {
  for (const invalidator of ['mode ask', 'stop', 'session_shutdown', 'new mode auto']) {
    await t.test(invalidator, async () => {
      const extension = await loadExtension();
      const command = extension.commands.get('browser');
      const fixture = deferredUI();
      let alreadyShutdown = false;
      try {
        const staleAuto = command.handler('mode auto', fixture.ctx);
        assert.equal(fixture.confirmations.length, 1);

        if (invalidator === 'session_shutdown') {
          await shutdown(extension);
          alreadyShutdown = true;
        } else if (invalidator === 'new mode auto') {
          const newerAuto = command.handler('mode auto', fixture.ctx);
          assert.equal(fixture.confirmations.length, 2);
          fixture.confirmations[1](false);
          await newerAuto;
        } else {
          await command.handler(invalidator, fixture.ctx);
        }

        fixture.confirmations[0](true);
        await staleAuto;
        assert.equal(await readMode(extension), 'ask');
        assert.equal(fixture.notifications.filter(({ level }) => level === 'warning').length, 0);
      } finally {
        if (!alreadyShutdown) await shutdown(extension);
      }
    });
  }
});

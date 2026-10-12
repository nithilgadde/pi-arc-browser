import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const loader = process.env.PI_EXTENSION_LOADER ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
test('real Pi loader registers tool and command without starting a server', { skip: !existsSync(loader) }, async () => {
  const { loadExtensions } = await import(loader);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = await loadExtensions([`${cwd}/src/index.ts`], cwd);
  assert.deepEqual(result.errors, []);
  const extension = result.extensions[0];
  const tool = extension.tools.get('arc_browser').definition;
  assert.ok(extension.commands.has('browser'));
  assert.equal(tool.parameters.type, 'object');
  const status = await tool.execute('test', { action: 'status' }, undefined, undefined, { hasUI: false });
  const data = JSON.parse(status.content[0].text);
  assert.equal(data.running, false);
  assert.equal(data.mode, 'ask');
  assert.ok(data.companionPath.endsWith('/companion/'));
  assert.equal('token' in data, false);
  await assert.rejects(tool.execute('test', { action: 'click', tabId: 1, x: 0, y: 0 }, undefined, undefined, { hasUI: false }), /disconnected/);
  for (const handler of extension.handlers.get('session_shutdown')) await handler({}, {});
});

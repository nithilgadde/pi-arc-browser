import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_MODES, parseAccessMode, assertBackgroundTab } from '../companion/lib/contracts.mjs';

const agentTab = { id: 123, url: 'https://example.com', active: false, incognito: false };
test('browser access modes are explicit and validated', () => {
  assert.deepEqual(ACCESS_MODES, ['follow-active', 'manual', 'background']);
  for (const mode of ACCESS_MODES) assert.equal(parseAccessMode(mode), mode);
  for (const bad of ['all', '', true, null, {}, 'BACKGROUND']) assert.throws(() => parseAccessMode(bad), /Access mode/);
});
test('background ownership is required regardless of URL or foreground status', () => {
  assert.throws(() => assertBackgroundTab(agentTab, false), /not an agent-owned/);
  assert.throws(() => assertBackgroundTab(null, false), /not an agent-owned/);
  assert.doesNotThrow(() => assertBackgroundTab(agentTab, true));
});
test('background work pauses on selected agent tabs; metadata listing remains possible', () => {
  const active = { ...agentTab, active: true };
  assert.throws(() => assertBackgroundTab(active, true), /active under user control/);
  assert.doesNotThrow(() => assertBackgroundTab(active, true, false));
});
test('background scope rejects incognito, missing, or protected pages', () => {
  for (const tab of [null, { ...agentTab, incognito: true }, { ...agentTab, url: 'chrome://settings' }, { ...agentTab, url: 'file:///tmp/test.html' }, { ...agentTab, url: 'https://chromewebstore.google.com/' }]) {
    assert.throws(() => assertBackgroundTab(tab, true), /allowed HTTP/);
  }
});

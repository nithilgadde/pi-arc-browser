import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { BrowserBridge } from '../src/bridge.mjs';

const executablePath = process.env.PI_BROWSER_CHROMIUM;
test('follow-active: connect once, switch tabs on demand, refuse background access and honor revocation', { skip: !executablePath, timeout: 120_000 }, async t => {
  const html = await readFile(new URL('./fixture.html', import.meta.url));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const bridge = new BrowserBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const profile = await mkdtemp(join(tmpdir(), 'pi-arc-follow-test-'));
  const companion = fileURLToPath(new URL('../companion', import.meta.url));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${companion}`, `--load-extension=${companion}`],
  });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  const first = await context.newPage();
  await first.goto(`${url}first`);
  const second = await context.newPage();
  await second.goto(`${url}second`);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const send = (type, extra = {}) => popup.evaluate(message => chrome.runtime.sendMessage(message), { type, ...extra });
  assert.equal(await popup.locator('#follow-active').isChecked(), true);
  await popup.locator('#pairing').fill(JSON.stringify(bridge.pairing));
  await popup.locator('#connect').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Connected'));
  assert.equal(bridge.connected, true);
  assert.equal(await popup.locator('#share').isVisible(), false);
  assert.equal(await popup.locator('#follow-active').isDisabled(), true);
  assert.equal((await send('setFollowActive', { enabled: false })).ok, false);

  // A protected extension page is active; no fallback to a background website.
  await popup.bringToFront();
  assert.deepEqual((await bridge.request('tabs', {})).tabs, []);
  await first.bringToFront();
  let tabs = await bridge.request('tabs', {});
  assert.equal(tabs.accessMode, 'follow-active');
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].url, `${url}first`);
  const firstId = tabs.tabs[0].id;
  let snapshot = await bridge.request('snapshot', { tabId: firstId });
  assert.equal(snapshot.url, `${url}first`);
  const firstNameRef = snapshot.elements.find(e => e.name === 'Name').ref;
  await bridge.request('fill', { tabId: firstId, ref: firstNameRef, text: 'first only' });
  assert.equal(await first.locator('#name').inputValue(), 'first only');

  // No Share click. The next request discovers the newly active tab.
  await second.bringToFront();
  await assert.rejects(bridge.request('type', { tabId: firstId, text: 'wrong tab' }), /active|changed|scope|shared/i);
  assert.equal(await first.locator('#name').inputValue(), 'first only');
  assert.equal(await second.locator('#name').inputValue(), '');
  tabs = await bridge.request('tabs', {});
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].url, `${url}second`);
  const secondId = tabs.tabs[0].id;
  assert.notEqual(secondId, firstId);
  await assert.rejects(bridge.request('snapshot', { tabId: firstId }), /active|changed|scope|shared/i);
  await assert.rejects(bridge.request('focus', { tabId: firstId }), /active|changed|scope|shared/i);
  await assert.rejects(bridge.request('close', { tabId: firstId }), /active|changed|scope|shared/i);
  assert.equal(first.isClosed(), false);
  snapshot = await bridge.request('snapshot', { tabId: secondId });
  assert.equal(snapshot.url, `${url}second`);
  // getTargets().attached also includes Playwright's own CDP sessions. Check this
  // companion's ownership instead, then verify its debugger cannot reach the old tab.
  const attached = await popup.evaluate(async () => (await chrome.storage.session.get('companionState')).companionState.attachedTabIds);
  assert.ok(!attached.includes(firstId), 'previously followed tab must be detached');
  assert.ok(attached.includes(secondId));
  const oldDebuggerAccess = await popup.evaluate(async tabId => {
    try { await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics'); return true; }
    catch { return false; }
  }, firstId);
  assert.equal(oldDebuggerAccess, false);

  // Returning to an earlier tab does not resurrect old snapshot refs.
  await first.bringToFront();
  await bridge.request('tabs', {});
  await assert.rejects(bridge.request('click', { tabId: firstId, ref: firstNameRef }), /snapshot|stale/i);
  snapshot = await bridge.request('snapshot', { tabId: firstId });
  const freshNameRef = snapshot.elements.find(e => e.name === 'Name').ref;

  // Test-only CDP interception deterministically switches tabs between input steps.
  // Production exposes no arbitrary code or CDP tool to the model.
  const switchAfterCommand = async (method, type) => worker.evaluate(({ firstId, secondId, method, type }) => {
    const original = chrome.debugger.sendCommand;
    let armed = true;
    globalThis.__restoreTestDispatch = () => { chrome.debugger.sendCommand = original; };
    chrome.debugger.sendCommand = async function(source, command, params) {
      const result = await original.call(chrome.debugger, source, command, params);
      if (armed && source.tabId === firstId && command === method && (!type || params?.type === type)) {
        armed = false;
        await chrome.tabs.update(secondId, { active: true });
      }
      return result;
    };
  }, { firstId, secondId, method, type });
  await switchAfterCommand('Input.dispatchMouseEvent', 'mouseReleased');
  try {
    await assert.rejects(bridge.request('fill', { tabId: firstId, ref: freshNameRef, text: 'MUST NOT TYPE' }), /active|changed|scope|shared|snapshot|detach/i);
  } finally { await worker.evaluate(() => globalThis.__restoreTestDispatch()); }
  assert.equal(await first.locator('#name').inputValue(), 'first only');
  assert.equal(await second.locator('#name').inputValue(), '');
  await first.bringToFront();
  await bridge.request('tabs', {});
  await switchAfterCommand('Page.captureScreenshot');
  try {
    await assert.rejects(bridge.request('screenshot', { tabId: firstId }), /active|changed|scope|shared|detach/i);
  } finally { await worker.evaluate(() => globalThis.__restoreTestDispatch()); }

  // Active browser settings/extension page must not expose the old web page.
  await popup.bringToFront();
  assert.deepEqual((await bridge.request('tabs', {})).tabs, []);
  await assert.rejects(bridge.request('screenshot', { tabId: firstId }), /active|allowed|http|shared|protected/i);
  await second.bringToFront();
  assert.equal((await bridge.request('tabs', {})).tabs[0].id, secondId);

  // A new tab created by Pi becomes the sole current authorized tab.
  const opened = await bridge.request('open', { url: `${url}opened` });
  tabs = await bridge.request('tabs', {});
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].id, opened.tab.id);
  await bridge.request('close', { tabId: opened.tab.id });
  await second.bringToFront();
  await bridge.request('tabs', {});

  // Cancelling debugging is explicit revocation, not permission to auto-reattach.
  const detached = await send('unshareCurrent');
  // Follow mode may reject the legacy popup action; test the exposed detach tool instead.
  if (!detached.ok) await bridge.request('detach', { tabId: secondId });
  await assert.rejects(bridge.request('snapshot', { tabId: secondId }), /paused|revok|reconnect|detach|connect|shared/i);
  await first.bringToFront();
  let afterRevocation;
  try { afterRevocation = await bridge.request('tabs', {}); }
  catch (error) { assert.match(error.message, /paused|revok|reconnect|connect/i); }
  if (afterRevocation) assert.deepEqual(afterRevocation.tabs, []);

  // Explicit reconnect restores follow mode without Share.
  await send('disconnect');
  assert.equal((await send('connect')).ok, true);
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'getStatus' })).result.connection === 'connected');
  await first.bringToFront();
  assert.equal((await bridge.request('tabs', {})).tabs[0].id, firstId);

  // Manual preference remains available and persists after reconnect.
  await send('disconnect');
  assert.equal((await send('setFollowActive', { enabled: false })).ok, true);
  await send('connect');
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'getStatus' })).result.connection === 'connected');
  tabs = await bridge.request('tabs', {});
  assert.equal(tabs.accessMode, 'manual');
  assert.deepEqual(tabs.tabs, []);
  assert.equal((await send('shareCurrent')).ok, true);
  assert.equal((await bridge.request('tabs', {})).tabs[0].id, firstId);
  await send('disconnect');
  await assert.rejects(bridge.request('tabs', {}), /connect/i);
});

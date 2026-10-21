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
test('real Chromium companion: pair, opt-in, observe, act, verify, revoke', { skip: !executablePath, timeout: 120_000 }, async t => {
  const html = await readFile(new URL('./fixture.html', import.meta.url));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const bridge = new BrowserBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const profile = await mkdtemp(join(tmpdir(), 'pi-arc-browser-test-'));
  const companion = fileURLToPath(new URL('../companion', import.meta.url));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${companion}`, `--load-extension=${companion}`],
  });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  const page = await context.newPage();
  await page.goto(url);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#access-mode').selectOption('manual'); // Exercise legacy manual sharing explicitly.
  await popup.locator('#pairing').fill(JSON.stringify(bridge.pairing));
  await popup.locator('#connect').click();
  await popup.waitForFunction(() => document.querySelector('#share').disabled === false);
  assert.equal(bridge.connected, true);
  assert.deepEqual((await bridge.request('tabs', {})).tabs, []);

  // The trusted popup sends the same request its Share current tab button sends.
  // Keep the test page active, since opening the popup as a tab changes the active tab.
  await page.bringToFront();
  const shared = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'shareCurrent' }));
  assert.equal(shared.ok, true, shared.error);
  const tabs = await bridge.request('tabs', {});
  assert.equal(tabs.tabs.length, 1);
  const tabId = tabs.tabs[0].id;
  assert.equal(tabs.tabs[0].url, url);
  const request = (action, params = {}) => bridge.request(action, { tabId, ...params });
  let snapshot = await request('snapshot');
  assert.match(snapshot.content, /Browser smoke test/);
  assert.ok(!JSON.stringify(snapshot).includes('fake-test-secret'));
  const ref = (name) => {
    const element = snapshot.elements.find(e => e.name === name);
    assert.ok(element, `missing snapshot element ${name}`);
    return element.ref;
  };
  const oldNameRef = ref('Name');
  await request('fill', { ref: oldNameRef, text: 'Pi test' });
  assert.equal(await page.locator('#name').inputValue(), 'Pi test');
  await request('fill', { ref: oldNameRef, text: '' });
  assert.equal(await page.locator('#name').inputValue(), '');
  await request('type', { text: 'Inserted' });
  assert.equal(await page.locator('#name').inputValue(), 'Inserted');
  await request('press', { key: 'Tab' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'notes');
  await request('type', { text: 'Some notes' });
  assert.equal(await page.locator('#notes').inputValue(), 'Some notes');
  await request('click', { ref: ref('Increment') });
  assert.equal(await page.locator('#count').textContent(), '1');
  await request('select', { ref: ref('Color'), values: ['blue'] });
  assert.equal(await page.locator('#color').inputValue(), 'blue');
  await request('click', { ref: ref('Shadow action') });
  assert.equal(await page.locator('#shadow output').textContent(), 'done');
  await assert.rejects(request('fill', { ref: ref('Password'), text: 'do-not-enter' }), /manual|password/i);
  await request('click', { ref: ref('Password') });
  await assert.rejects(request('type', { text: 'do-not-enter' }), /manual|password/i);
  assert.equal(await page.locator('#password').inputValue(), 'fake-test-secret');

  await request('click', { ref: ref('Replace name field') });
  await assert.rejects(request('fill', { ref: oldNameRef, text: 'wrong' }), /stale|disconnected/i);
  snapshot = await request('snapshot');
  await assert.rejects(request('click', { ref: oldNameRef }), /stale/i);
  await request('fill', { ref: ref('Name'), text: 'Fresh reference' });
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'test-cover';
    cover.style = 'position:fixed;inset:0;z-index:9999;background:white';
    document.body.append(cover);
  });
  await assert.rejects(request('click', { ref: ref('Increment') }), /obscur|occlu|cover|intercept/i);
  assert.equal(await page.locator('#count').textContent(), '1');
  await page.locator('#test-cover').evaluate(element => element.remove());
  await page.locator('#notes').focus();
  await page.evaluate(() => document.querySelector('#name').onfocus = () => document.querySelector('#notes').focus());
  await assert.rejects(request('fill', { ref: ref('Name'), text: 'wrong target' }), /focus/i);
  assert.equal(await page.locator('#notes').inputValue(), 'Some notes');
  await page.evaluate(() => document.querySelector('#name').onfocus = null);
  const shot = await request('screenshot');
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(Buffer.from(shot.data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.ok(shot.width > 0 && shot.height > 0);

  // Explicit IDs do not bypass tab sharing, even if the tab exists in this profile.
  const unshared = await popup.evaluate(async url => {
    const tab = await chrome.tabs.create({ url, active: false });
    return tab.id;
  }, url);
  await assert.rejects(bridge.request('snapshot', { tabId: unshared }), /shared/i);
  assert.equal((await bridge.request('tabs', {})).tabs.length, 1);
  await request('scroll', { deltaY: 1100 });
  await page.waitForFunction(() => scrollY > 0);
  await assert.rejects(request('click', { ref: ref('Name') }), /viewport|visible|screen/i);
  assert.match((await request('snapshot')).content, /Bottom marker/);

  await request('navigate', { url: `${url}next` });
  await page.waitForURL(`${url}next`);
  await page.waitForLoadState('domcontentloaded');
  assert.equal((await request('snapshot')).url, `${url}next`);
  await request('back');
  await page.waitForURL(url);
  await request('forward');
  await page.waitForURL(`${url}next`);
  await request('reload');
  await page.waitForLoadState('domcontentloaded');
  const opened = await bridge.request('open', { url });
  assert.ok(opened.tab.id !== tabId);
  assert.equal((await bridge.request('tabs', {})).tabs.length, 2);
  await bridge.request('close', { tabId: opened.tab.id });
  assert.equal((await bridge.request('tabs', {})).tabs.length, 1);
  await request('focus');
  await request('wait', { milliseconds: 10 });

  const detached = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'disconnect' }));
  assert.equal(detached.ok, true);
  await assert.rejects(request('snapshot'), /connect/i);
  const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'getStatus' }));
  assert.deepEqual(status.result.sharedTabIds, []);
});

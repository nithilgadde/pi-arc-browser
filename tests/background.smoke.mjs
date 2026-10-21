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

test('background: only inactive tabs created by this connection are accessible', { skip: !executablePath, timeout: 180_000 }, async t => {
  const html = await readFile(new URL('./fixture.html', import.meta.url));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const bridge = new BrowserBridge();
  await bridge.start();
  t.after(() => bridge.stop());

  const profile = await mkdtemp(join(tmpdir(), 'pi-arc-background-test-'));
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
  const foreground = await context.newPage();
  await foreground.goto(`${url}foreground`);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const send = (type, extra = {}) => popup.evaluate(
    message => chrome.runtime.sendMessage(message),
    { type, ...extra },
  );
  const browserForeground = () => worker.evaluate(async () => {
    const window = await chrome.windows.getLastFocused({ populate: true });
    const activeTab = window.tabs.find(tab => tab.active);
    return { windowId: window.id, focused: window.focused, activeTabId: activeTab?.id };
  });
  const directDebuggerAccess = tabId => worker.evaluate(async id => {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, 'Page.getLayoutMetrics');
      return true;
    } catch {
      return false;
    }
  }, tabId);
  const openBackground = async path => {
    const expectedUrl = `${url}${path}`;
    const pagePromise = context.waitForEvent('page');
    const resultPromise = bridge.request('open', { url: expectedUrl });
    const [page, result] = await Promise.all([pagePromise, resultPromise]);
    await page.waitForURL(expectedUrl);
    await page.waitForLoadState('domcontentloaded');
    assert.equal(result.tab.url, expectedUrl);
    assert.equal(result.tab.active, false);
    assert.equal(typeof result.tab.id, 'number');
    assert.equal(typeof result.tab.title, 'string');
    return { page, tab: result.tab };
  };
  const assertForegroundUnchanged = async (browserState, domState) => {
    assert.deepEqual(await browserForeground(), browserState);
    assert.deepEqual(await foreground.evaluate(() => ({
      url: location.href,
      value: document.querySelector('#name').value,
      notes: document.querySelector('#notes').value,
      count: document.querySelector('#count').textContent,
      color: document.querySelector('#color').value,
      activeId: document.activeElement?.id,
      scrollY,
    })), domState);
  };

  // The three-way access selector defaults to follow-active and can be changed only
  // while disconnected. Exercise the runtime API as well as the popup rendering.
  assert.deepEqual(
    new Set(await popup.locator('#access-mode option').evaluateAll(options => options.map(option => option.value))),
    new Set(['follow-active', 'manual', 'background']),
  );
  assert.equal(await popup.locator('#access-mode').inputValue(), 'follow-active');
  const modeChanged = await send('setAccessMode', { mode: 'background' });
  assert.equal(modeChanged.ok, true, modeChanged.error);
  await popup.waitForFunction(() => document.querySelector('#access-mode').value === 'background');

  await popup.locator('#pairing').fill(JSON.stringify(bridge.pairing));
  await popup.locator('#connect').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Connected'));
  assert.equal(bridge.connected, true);
  assert.equal(await popup.locator('#access-mode').isDisabled(), true);
  const connectedModeChange = await send('setAccessMode', { mode: 'manual' });
  assert.equal(connectedModeChange.ok, false);
  assert.match(connectedModeChange.error, /disconnect|connected|mode/i);
  assert.equal((await send('getStatus')).result.accessMode, 'background');

  // Existing normal tabs, including the extension UI itself, never enter the owned set.
  await foreground.bringToFront();
  await foreground.locator('#name').fill('User keeps control');
  await foreground.locator('#name').focus();
  const initialForeground = await browserForeground();
  const initialForegroundDom = await foreground.evaluate(() => ({
    url: location.href,
    value: document.querySelector('#name').value,
    notes: document.querySelector('#notes').value,
    count: document.querySelector('#count').textContent,
    color: document.querySelector('#color').value,
    activeId: document.activeElement?.id,
    scrollY,
  }));
  const existingId = initialForeground.activeTabId;
  assert.equal(typeof existingId, 'number');

  let tabs = await bridge.request('tabs', {});
  assert.equal(tabs.accessMode, 'background');
  assert.deepEqual(tabs.tabs, []);
  assert.equal(typeof tabs.note, 'string');
  assert.match(tabs.note, /background|agent|created/i);
  await assert.rejects(bridge.request('snapshot', { tabId: existingId }), /owned|authoriz|access|shared|agent|session|background/i);
  await assert.rejects(bridge.request('navigate', { tabId: existingId, url: `${url}forbidden` }), /owned|authoriz|access|shared|agent|session|background/i);
  await assert.rejects(bridge.request('focus', { tabId: existingId }), /owned|authoriz|access|shared|agent|session|background|focus/i);
  await assert.rejects(bridge.request('close', { tabId: existingId }), /owned|authoriz|access|shared|agent|session|background/i);
  assert.equal(foreground.isClosed(), false);
  const shareAttempt = await send('shareCurrent');
  assert.equal(shareAttempt.ok, false);
  assert.match(shareAttempt.error, /background|manual|share|mode/i);
  assert.deepEqual((await bridge.request('tabs', {})).tabs, []);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // open creates inactive, non-incognito tabs in the user's last-focused normal
  // window and never changes the user's active tab or focused DOM element.
  const first = await openBackground('agent-one');
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), first.tab.id)).incognito, false);
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), first.tab.id)).windowId, initialForeground.windowId);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  const second = await openBackground('agent-two');
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), second.tab.id)).incognito, false);
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), second.tab.id)).windowId, initialForeground.windowId);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  tabs = await bridge.request('tabs', {});
  assert.equal(tabs.accessMode, 'background');
  assert.deepEqual(new Set(tabs.tabs.map(tab => tab.id)), new Set([first.tab.id, second.tab.id]));
  assert.ok(tabs.tabs.every(tab => tab.active === false));

  const firstRequest = (action, params = {}) => bridge.request(action, { tabId: first.tab.id, ...params });
  const secondRequest = (action, params = {}) => bridge.request(action, { tabId: second.tab.id, ...params });

  // Snapshot and screenshot are from the background document, not the foreground tab.
  let firstSnapshot = await firstRequest('snapshot');
  assert.equal(firstSnapshot.url, `${url}agent-one`);
  assert.match(firstSnapshot.content, /Browser smoke test/);
  assert.ok(!JSON.stringify(firstSnapshot).includes('fake-test-secret'));
  const firstRef = name => {
    const element = firstSnapshot.elements.find(candidate => candidate.name === name);
    assert.ok(element, `missing first-tab snapshot element ${name}`);
    return element.ref;
  };
  const shot = await firstRequest('screenshot');
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(Buffer.from(shot.data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.ok(shot.width > 0 && shot.height > 0);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Every interaction works while the owned tabs remain inactive, and state is
  // isolated between multiple agent-created tabs.
  await firstRequest('fill', { ref: firstRef('Name'), text: 'Agent one value' });
  const secondSnapshot = await secondRequest('snapshot');
  const secondRef = name => {
    const element = secondSnapshot.elements.find(candidate => candidate.name === name);
    assert.ok(element, `missing second-tab snapshot element ${name}`);
    return element.ref;
  };
  await secondRequest('fill', { ref: secondRef('Name'), text: 'Agent two value' });
  assert.equal(await first.page.locator('#name').inputValue(), 'Agent one value');
  assert.equal(await second.page.locator('#name').inputValue(), 'Agent two value');

  await firstRequest('click', { ref: firstRef('Increment') });
  assert.equal(await first.page.locator('#count').textContent(), '1');
  await firstRequest('click', { ref: firstRef('Notes') });
  await firstRequest('type', { text: 'Background notes' });
  assert.equal(await first.page.locator('#notes').inputValue(), 'Background notes');
  await firstRequest('press', { key: 'Tab' });
  assert.equal(await first.page.evaluate(() => document.activeElement?.id), 'password');
  await firstRequest('select', { ref: firstRef('Color'), values: ['blue'] });
  assert.equal(await first.page.locator('#color').inputValue(), 'blue');
  await firstRequest('scroll', { deltaY: 1100 });
  await first.page.waitForFunction(() => scrollY > 0);
  assert.equal(await foreground.evaluate(() => scrollY), 0);
  await firstRequest('wait', { milliseconds: 10 });
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Focus is categorically unavailable in background mode, even for an owned tab.
  await assert.rejects(firstRequest('focus'), /background|focus|foreground|user control/i);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // If the user selects an agent tab, all access pauses until the user switches away.
  await first.page.bringToFront();
  await assert.rejects(firstRequest('snapshot'), /active|foreground|user control/i);
  assert.equal(await first.page.locator('#name').inputValue(), 'Agent one value');
  await foreground.bringToFront();
  assert.equal((await firstRequest('snapshot')).url, `${url}agent-one`);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Opening a new page from an agent page does not confer ownership on the child.
  const childUrl = `${url}agent-popup`;
  await first.page.evaluate(href => {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.textContent = 'Spawn agent popup';
    document.body.append(link);
  }, childUrl);
  firstSnapshot = await firstRequest('snapshot');
  const popupRef = firstSnapshot.elements.find(element => element.name === 'Spawn agent popup')?.ref;
  assert.ok(popupRef, 'missing popup link snapshot ref');
  const childPagePromise = context.waitForEvent('page');
  await firstRequest('click', { ref: popupRef });
  const childPage = await childPagePromise;
  await childPage.waitForURL(childUrl);
  await childPage.waitForLoadState('domcontentloaded');
  const childId = await worker.evaluate(async expectedUrl => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === expectedUrl)?.id;
  }, childUrl);
  assert.equal(typeof childId, 'number');
  assert.ok(!(await bridge.request('tabs', {})).tabs.some(tab => tab.id === childId));
  await assert.rejects(bridge.request('snapshot', { tabId: childId }), /owned|authoriz|access|shared|agent|session|background/i);
  await assert.rejects(bridge.request('close', { tabId: childId }), /owned|authoriz|access|shared|agent|session|background/i);
  assert.equal(childPage.isClosed(), false);
  // A website's target=_blank popup can itself activate a tab. Background mode
  // deliberately does not seize focus back or adopt that unowned popup. This is
  // documented as a site-driven limitation; restore focus as the test user.
  await foreground.bringToFront();
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Test-only CDP interception deterministically selects the agent tab between
  // commands. Production exposes no arbitrary CDP or code execution tool.
  const activateAfterCommand = (tabId, method, type) => worker.evaluate(({ tabId, method, type }) => {
    const original = chrome.debugger.sendCommand;
    let armed = true;
    globalThis.__restoreBackgroundTestDispatch = () => { chrome.debugger.sendCommand = original; };
    chrome.debugger.sendCommand = async function(source, command, params) {
      const result = await original.call(chrome.debugger, source, command, params);
      if (armed && source.tabId === tabId && command === method && (!type || params?.type === type)) {
        armed = false;
        await chrome.tabs.update(tabId, { active: true });
      }
      return result;
    };
  }, { tabId, method, type });
  const restoreDispatch = () => worker.evaluate(() => globalThis.__restoreBackgroundTestDispatch());

  await firstRequest('scroll', { deltaY: -1100 });
  await first.page.waitForFunction(() => scrollY === 0);
  firstSnapshot = await firstRequest('snapshot');
  await activateAfterCommand(first.tab.id, 'Input.dispatchMouseEvent', 'mouseReleased');
  try {
    await assert.rejects(
      firstRequest('fill', { ref: firstRef('Name'), text: 'MUST NOT BE INSERTED' }),
      /active|foreground|user control/i,
    );
  } finally {
    await restoreDispatch();
  }
  assert.equal((await browserForeground()).activeTabId, first.tab.id, 'fill race hook did not select the agent tab');
  assert.equal(await first.page.locator('#name').inputValue(), 'Agent one value');
  await foreground.bringToFront();
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  await activateAfterCommand(first.tab.id, 'Page.captureScreenshot');
  try {
    await assert.rejects(firstRequest('screenshot'), /active|foreground|user control/i);
  } finally {
    await restoreDispatch();
  }
  assert.equal((await browserForeground()).activeTabId, first.tab.id, 'screenshot race hook did not select the agent tab');
  await foreground.bringToFront();
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Select also returns DOM-derived data: discard it if the user takes over
  // while Runtime.evaluate is pending (the selection itself may have happened).
  await activateAfterCommand(first.tab.id, 'Runtime.evaluate');
  try {
    await assert.rejects(firstRequest('select', { ref: firstRef('Color'), values: ['red'] }), /active|foreground|user control/i);
  } finally {
    await restoreDispatch();
  }
  await foreground.bringToFront();
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // Navigation/history/reload continue to work without foregrounding the tab.
  await firstRequest('navigate', { url: `${url}agent-one-next` });
  await first.page.waitForURL(`${url}agent-one-next`);
  assert.equal((await firstRequest('snapshot')).url, `${url}agent-one-next`);
  await firstRequest('back');
  await first.page.waitForURL(`${url}agent-one`);
  await firstRequest('forward');
  await first.page.waitForURL(`${url}agent-one-next`);
  await firstRequest('reload');
  await first.page.waitForLoadState('domcontentloaded');
  assert.equal((await firstRequest('snapshot')).url, `${url}agent-one-next`);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // close works for an owned inactive tab and cannot affect the foreground tab.
  const disposable = await openBackground('agent-close');
  const disposableClosed = disposable.page.waitForEvent('close');
  await bridge.request('close', { tabId: disposable.tab.id });
  await disposableClosed;
  assert.ok(!(await bridge.request('tabs', {})).tabs.some(tab => tab.id === disposable.tab.id));
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  // detach is permanent revocation for this connection: listing cannot silently
  // reattach it, and even a direct debugger command from the extension now fails.
  await secondRequest('detach');
  assert.equal(second.page.isClosed(), false);
  assert.ok(!(await bridge.request('tabs', {})).tabs.some(tab => tab.id === second.tab.id));
  await assert.rejects(secondRequest('snapshot'), /detach|revok|owned|authoriz|access|session/i);
  assert.equal(await directDebuggerAccess(second.tab.id), false);
  await bridge.request('tabs', {});
  await assert.rejects(secondRequest('snapshot'), /detach|revok|owned|authoriz|access|session/i);
  assert.equal(await directDebuggerAccess(second.tab.id), false);

  // Disconnect detaches and forgets the remaining owned set but deliberately
  // leaves those tabs open. Reconnecting starts a fresh empty ownership scope.
  const disconnected = await send('disconnect');
  assert.equal(disconnected.ok, true, disconnected.error);
  assert.equal(first.page.isClosed(), false);
  assert.equal(second.page.isClosed(), false);
  assert.equal(await directDebuggerAccess(first.tab.id), false);
  await assert.rejects(bridge.request('tabs', {}), /connect/i);

  const reconnected = await send('connect');
  assert.equal(reconnected.ok, true, reconnected.error);
  await popup.waitForFunction(async () => (
    await chrome.runtime.sendMessage({ type: 'getStatus' })
  ).result.connection === 'connected');
  tabs = await bridge.request('tabs', {});
  assert.equal(tabs.accessMode, 'background');
  assert.deepEqual(tabs.tabs, []);
  await assert.rejects(firstRequest('snapshot'), /owned|authoriz|access|shared|agent|session|background/i);
  await assert.rejects(secondRequest('snapshot'), /owned|authoriz|access|shared|agent|session|background|detach|revok/i);

  const fresh = await openBackground('agent-after-reconnect');
  tabs = await bridge.request('tabs', {});
  assert.deepEqual(tabs.tabs.map(tab => tab.id), [fresh.tab.id]);
  assert.equal(tabs.tabs[0].active, false);
  await assertForegroundUnchanged(initialForeground, initialForegroundDom);

  await send('disconnect');
});

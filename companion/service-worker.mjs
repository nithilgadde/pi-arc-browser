import {
  ACCESS_MODES, CompanionError, assertActiveRequestGeneration, assertBackgroundTab, assertFollowRequestedTab, bridgeUrl, errorMessage,
  followTabPolicy, isAllowedPageUrl, parseAccessMode, parseBridgeMessage, parseFollowActive, parsePairing,
  serializeBridgeMessage, validateActionParams
} from "./lib/contracts.mjs";
import {
  createInspectActiveExpression, createResolveRefExpression, createSnapshotExpression,
  createSnapshotId, snapshotResult
} from "./lib/snapshot.mjs";

const DEBUGGER_VERSION = "1.3";
const SESSION_KEY = "companionState";
const PING_INTERVAL_MS = 20000;
const READY_TIMEOUT_MS = 10000;

class FollowScopeError extends CompanionError {}

let socket = null;
let connectionState = "disconnected";
let connectionDetail = "Not connected";
let readyTimer = null;
let pingTimer = null;
let lastPongAt = 0;
let generation = 0;
let accessMode = "follow-active";
let followActive = true;
let followPaused = false;
let processing = false;
let activeRequestGeneration = null;
let requestQueue = [];
const pendingIds = new Set();
const sharedTabs = new Set();
// Connection-local provenance: never restore ownership of tabs from an earlier connection.
const agentTabs = new Set();
const attachedTabs = new Set();
const snapshotStates = new Map();
const blockedFollowTabs = new Set();
const intentionalDetachTabs = new Set();

const initialized = initialize();

async function initialize() {
  try { await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch {}
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const old = stored?.[SESSION_KEY] || {};
  accessMode = ACCESS_MODES.includes(old.accessMode) ? old.accessMode : (old.followActive !== false ? "follow-active" : "manual");
  followActive = accessMode === "follow-active";
  // A restarted worker cannot retain its authenticated WebSocket. Fail closed and
  // clean up any debugger sessions recorded by the previous worker.
  for (const id of Array.isArray(old.attachedTabIds) ? old.attachedTabIds : []) {
    if (Number.isInteger(id)) {
      try { await chrome.debugger.detach({ tabId: id }); } catch {}
    }
  }
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      pairing: old.pairing || null,
      accessMode,
      followActive,
      sharedTabIds: [],
      attachedTabIds: []
    }
  });
}

async function getStoredState() {
  const value = await chrome.storage.session.get(SESSION_KEY);
  return value?.[SESSION_KEY] || {};
}

async function persistRuntimeState() {
  const old = await getStoredState();
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      pairing: old.pairing || null,
      accessMode,
      followActive,
      sharedTabIds: [...sharedTabs],
      attachedTabIds: [...attachedTabs]
    }
  });
}

async function setPairing(pairing) {
  const parsed = parsePairing(pairing);
  const old = await getStoredState();
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      pairing: parsed,
      accessMode,
      followActive,
      sharedTabIds: old.sharedTabIds || [],
      attachedTabIds: old.attachedTabIds || []
    }
  });
}

async function setFollowActive(enabled) {
  return setAccessMode(parseFollowActive(enabled) ? "follow-active" : "manual");
}

async function setAccessMode(mode) {
  if (connectionState !== "disconnected") throw new CompanionError("Disconnect before changing browser access mode");
  accessMode = parseAccessMode(mode);
  followActive = accessMode === "follow-active";
  followPaused = false;
  blockedFollowTabs.clear();
  await revokeAllTabs();
  await persistRuntimeState();
  await broadcastStatus();
  return publicStatus();
}

async function publicStatus() {
  const state = await getStoredState();
  return {
    connection: connectionState,
    detail: connectionDetail,
    paired: Boolean(state.pairing),
    followActive,
    accessMode,
    followPaused: followActive && followPaused,
    sharedTabIds: [...sharedTabs].sort((a, b) => a - b)
  };
}

async function broadcastStatus() {
  try { await chrome.runtime.sendMessage({ type: "statusChanged", status: await publicStatus() }); } catch {}
}

function clearTimers() {
  if (readyTimer) clearTimeout(readyTimer);
  if (pingTimer) clearInterval(pingTimer);
  readyTimer = null;
  pingTimer = null;
}

async function connect() {
  await initialized;
  const stored = await getStoredState();
  if (!stored.pairing) throw new CompanionError("Enter pairing JSON first");
  const pairing = parsePairing(stored.pairing);
  await disconnect("Reconnecting");
  followPaused = false;
  blockedFollowTabs.clear();
  connectionState = "connecting";
  connectionDetail = "Connecting to local bridge…";
  await broadcastStatus();

  let ws;
  try {
    ws = new WebSocket(bridgeUrl(pairing.port));
  } catch (error) {
    connectionState = "disconnected";
    connectionDetail = "Bridge connection failed";
    await broadcastStatus();
    throw error;
  }
  socket = ws;
  const socketGeneration = ++generation;
  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    connectionState = "authenticating";
    connectionDetail = "Authenticating…";
    ws.send(serializeBridgeMessage({ type: "auth", token: pairing.token }));
    readyTimer = setTimeout(() => {
      if (socket === ws && connectionState !== "connected") ws.close(1008, "ready timeout");
    }, READY_TIMEOUT_MS);
    void broadcastStatus();
  });
  ws.addEventListener("message", (event) => void receiveBridgeMessage(ws, socketGeneration, event.data));
  ws.addEventListener("error", () => {
    if (socket === ws) connectionDetail = "Bridge connection failed";
  });
  ws.addEventListener("close", () => void socketLost(ws, "Disconnected"));
}

async function disconnect(detail = "Disconnected") {
  const ws = socket;
  socket = null;
  ++generation;
  clearTimers();
  requestQueue = [];
  pendingIds.clear();
  connectionState = "disconnected";
  connectionDetail = detail;
  // Finish the old close handshake before the UI can immediately reconnect. The
  // bridge intentionally refuses replacements while it still owns a closing client.
  const closed = !ws || ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    if (ws.readyState < WebSocket.CLOSING) {
      try { ws.close(1000, "client disconnect"); } catch { clearTimeout(timer); resolve(); }
    }
  });
  await revokeAllTabs();
  await closed;
  await broadcastStatus();
}

async function socketLost(ws, detail) {
  if (socket !== ws) return;
  await disconnect(detail);
}

function sendToSocket(ws, value) {
  if (socket !== ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(serializeBridgeMessage(value));
  return true;
}

async function receiveBridgeMessage(ws, socketGeneration, raw) {
  if (socket !== ws) return;
  let message;
  try {
    message = parseBridgeMessage(raw);
  } catch (error) {
    let id;
    try {
      const candidate = typeof raw === "string" ? JSON.parse(raw) : null;
      if (candidate?.type === "request" && typeof candidate.id === "string" && candidate.id.length <= 128) id = candidate.id;
    } catch {}
    if (id) {
      try { sendToSocket(ws, { type: "response", id, error: errorMessage(error) }); } catch { ws.close(1009, "response too large"); }
    } else {
      ws.close(1008, "invalid message");
    }
    return;
  }

  if (message.type === "ready") {
    if (connectionState !== "authenticating") { ws.close(1008, "unexpected ready"); return; }
    clearTimeout(readyTimer);
    readyTimer = null;
    connectionState = "connected";
    connectionDetail = "Connected";
    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > PING_INTERVAL_MS * 3) { ws.close(1008, "pong timeout"); return; }
      try { sendToSocket(ws, { type: "ping" }); } catch { ws.close(1009, "ping failed"); }
    }, PING_INTERVAL_MS);
    await broadcastStatus();
    return;
  }
  if (message.type === "pong") {
    if (connectionState === "connected") lastPongAt = Date.now();
    return;
  }
  if (connectionState !== "connected") {
    sendToSocket(ws, { type: "response", id: message.id, error: "bridge is not ready" });
    return;
  }
  if (pendingIds.has(message.id)) {
    sendToSocket(ws, { type: "response", id: message.id, error: "duplicate request id" });
    return;
  }
  pendingIds.add(message.id);
  requestQueue.push({ message, ws, generation: socketGeneration });
  void drainQueue();
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  try {
    while (requestQueue.length) {
      const item = requestQueue.shift();
      const { message, ws } = item;
      try {
        if (item.generation !== generation || socket !== ws) continue;
        activeRequestGeneration = item.generation;
        const result = await executeAction(message.action, message.params, item.generation);
        if (item.generation === generation && socket === ws) {
          sendToSocket(ws, { type: "response", id: message.id, result });
        }
      } catch (error) {
        if (item.generation === generation && socket === ws) {
          try { sendToSocket(ws, { type: "response", id: message.id, error: errorMessage(error) }); }
          catch { ws.close(1009, "response too large"); }
        }
      } finally {
        activeRequestGeneration = null;
        pendingIds.delete(message.id);
      }
    }
  } finally {
    processing = false;
  }
}

async function detachOwnedDebugger(tabId) {
  intentionalDetachTabs.add(tabId);
  try {
    await chrome.debugger.detach({ tabId });
    setTimeout(() => intentionalDetachTabs.delete(tabId), 1000);
  } catch {
    intentionalDetachTabs.delete(tabId);
  }
}

async function attachAndShare(tabId, expectedGeneration, following = false) {
  if (connectionState !== "connected" || generation !== expectedGeneration) throw new CompanionError("Bridge disconnected before the tab could be shared");
  let tab = await chrome.tabs.get(tabId);
  assertRequestLive(expectedGeneration);
  if (accessMode === "background") assertBackgroundTab(tab, agentTabs.has(tabId));
  if (!isAllowedPageUrl(tab.url) || (following && tab.incognito)) {
    throw new CompanionError(following
      ? "Only non-incognito, non-protected HTTP(S) tabs can be followed"
      : "Only non-protected HTTP(S) tabs can be shared");
  }
  if (following && blockedFollowTabs.has(tabId)) throw new FollowScopeError(followTabPolicy(tab, true).note);
  if (!attachedTabs.has(tabId)) {
    intentionalDetachTabs.delete(tabId);
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      attachedTabs.add(tabId);
    } catch (error) {
      if (following) {
        followPaused = true;
        blockedFollowTabs.add(tabId);
        connectionDetail = "Follow active tab paused until reconnect";
      }
      throw new CompanionError(following
        ? "Debugger access was not granted for the active tab. Disconnect and reconnect before trying it again."
        : errorMessage(error));
    }
  }
  try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
  if (connectionState !== "connected" || generation !== expectedGeneration || !isAllowedPageUrl(tab?.url) || (following && tab?.incognito) ||
      (accessMode === "background" && (!agentTabs.has(tabId) || tab?.active || tab?.incognito))) {
    attachedTabs.delete(tabId);
    await detachOwnedDebugger(tabId);
    await persistRuntimeState();
    if (!isAllowedPageUrl(tab?.url) || (following && tab?.incognito)) throw new CompanionError("Tab reached a protected or incognito page before it could be accessed");
    throw new CompanionError("Bridge disconnected before the tab could be accessed");
  }
  sharedTabs.add(tabId);
  await persistRuntimeState();
  await broadcastStatus();
  return tab;
}

async function shareCurrentTab() {
  await initialized;
  if (accessMode !== "manual") throw new CompanionError("Manual sharing is available only in Manual shared tabs mode");
  if (connectionState !== "connected") throw new CompanionError("Connect to the bridge before sharing a tab");
  const expectedGeneration = generation;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new CompanionError("No active tab found");
  await attachAndShare(tab.id, expectedGeneration);
  return { tabId: tab.id };
}

async function detachTab(tabId, shouldBroadcast = true) {
  agentTabs.delete(tabId);
  sharedTabs.delete(tabId);
  snapshotStates.delete(tabId);
  const wasAttached = attachedTabs.delete(tabId);
  if (wasAttached) await detachOwnedDebugger(tabId);
  await persistRuntimeState();
  if (shouldBroadcast) await broadcastStatus();
}

async function unshareCurrentTab() {
  await initialized;
  if (accessMode === "background") throw new CompanionError("Your current tab is not shared in Background mode. Disconnect to revoke all agent tabs.");
  if (followActive) {
    if (connectionState !== "connected") throw new CompanionError("Connect before pausing Follow active tab");
    const previousTabId = [...sharedTabs][0] ?? null;
    const decision = await queryFollowCandidate(generation);
    const tabId = decision.candidate?.id ?? previousTabId;
    followPaused = true;
    if (Number.isInteger(tabId)) blockedFollowTabs.add(tabId);
    connectionDetail = "Follow active tab paused until reconnect";
    await revokeAllTabs();
    await broadcastStatus();
    return {
      tabId,
      accessMode: "follow-active",
      note: "Follow active tab access is paused. Disconnect and reconnect to allow it again."
    };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new CompanionError("No active tab found");
  if (!sharedTabs.has(tab.id)) throw new CompanionError("The current tab is not shared");
  await detachTab(tab.id);
  return { tabId: tab.id };
}

async function revokeAllTabs() {
  const ids = new Set([...sharedTabs, ...attachedTabs]);
  sharedTabs.clear();
  agentTabs.clear();
  attachedTabs.clear();
  snapshotStates.clear();
  await Promise.all([...ids].map((tabId) => detachOwnedDebugger(tabId)));
  await persistRuntimeState();
}

async function revokeInvalidTab(tabId) {
  await detachTab(tabId);
  throw new CompanionError("Tab is no longer an allowed http(s) page and has been unshared");
}

async function requireSharedTab(tabId) {
  if (!sharedTabs.has(tabId)) throw new CompanionError(`Tab ${tabId} is not shared`);
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { await detachTab(tabId); throw new CompanionError(`Tab ${tabId} no longer exists`); }
  if (!isAllowedPageUrl(tab.url)) return revokeInvalidTab(tabId);
  if (!attachedTabs.has(tabId)) {
    sharedTabs.delete(tabId);
    await persistRuntimeState();
    throw new CompanionError(`Debugger is detached from tab ${tabId}`);
  }
  return tab;
}

async function queryFollowCandidate(expectedGeneration) {
  assertRequestLive(expectedGeneration);
  let browserWindow;
  try { browserWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); }
  catch { browserWindow = null; }
  assertRequestLive(expectedGeneration);
  if (!browserWindow?.id) return { tab: null, code: "no-active-tab", note: followTabPolicy(null).note };
  if (browserWindow.incognito) {
    const policy = followTabPolicy({ id: 0, url: "https://incognito.invalid/", incognito: true });
    return { tab: null, code: policy.code, note: policy.note };
  }
  const [rawTab] = await chrome.tabs.query({ active: true, windowId: browserWindow.id });
  assertRequestLive(expectedGeneration);
  const tab = rawTab ? { ...rawTab, incognito: Boolean(rawTab.incognito || browserWindow.incognito) } : null;
  const policy = followTabPolicy(tab, followPaused || (tab ? blockedFollowTabs.has(tab.id) : false));
  return { tab: policy.eligible ? tab : null, candidate: tab, code: policy.code, note: policy.note };
}

async function revokeFollowedExcept(keepTabId = null) {
  const ids = new Set([...sharedTabs, ...attachedTabs]);
  for (const tabId of ids) {
    if (tabId !== keepTabId) await detachTab(tabId, false);
  }
  await broadcastStatus();
}

function followChangedError() {
  return new FollowScopeError("The active Arc tab changed. Re-run tabs; the action was stopped and was not redirected.");
}

async function resolveFollowActive(expectedGeneration, requestedTabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await queryFollowCandidate(expectedGeneration);
    if (!first.tab) {
      await revokeFollowedExcept(null);
      return first;
    }
    if (requestedTabId !== undefined) {
      try { assertFollowRequestedTab(requestedTabId, first.tab.id); }
      catch { await revokeFollowedExcept(null); throw followChangedError(); }
    }
    await revokeFollowedExcept(first.tab.id);
    const second = await queryFollowCandidate(expectedGeneration);
    if (!second.tab || second.tab.id !== first.tab.id) {
      await revokeFollowedExcept(null);
      if (requestedTabId !== undefined) throw followChangedError();
      if (!second.tab) return second;
      continue;
    }
    try { await attachAndShare(second.tab.id, expectedGeneration, true); }
    catch (error) {
      await revokeFollowedExcept(null);
      if (connectionState !== "connected" || generation !== expectedGeneration || requestedTabId !== undefined) throw error;
      return { tab: null, candidate: second.tab, code: "attach-refused", note: errorMessage(error) };
    }
    const final = await queryFollowCandidate(expectedGeneration);
    if (final.tab?.id === second.tab.id) return final;
    await revokeFollowedExcept(null);
    if (requestedTabId !== undefined) throw followChangedError();
    if (!final.tab) return final;
  }
  await revokeFollowedExcept(null);
  throw new FollowScopeError("The active Arc tab kept changing. Re-run tabs when the desired tab is active.");
}

async function assertFollowCommandScope(tabId, expectedGeneration) {
  const active = await queryFollowCandidate(expectedGeneration);
  if (!active.tab) {
    await revokeFollowedExcept(null);
    throw new FollowScopeError(active.note);
  }
  if (active.tab.id !== tabId) {
    await revokeFollowedExcept(null);
    throw followChangedError();
  }
}

async function requireAgentTab(tabId, expectedGeneration, requireInactive = true) {
  assertRequestLive(expectedGeneration);
  // Check provenance BEFORE retrieving any tab metadata.
  if (!agentTabs.has(tabId)) assertBackgroundTab(null, false);
  const tab = await requireSharedTab(tabId);
  assertRequestLive(expectedGeneration);
  assertBackgroundTab(tab, agentTabs.has(tabId), requireInactive);
  return tab;
}

async function command(tabId, method, params = {}) {
  assertActiveRequestGeneration(activeRequestGeneration, generation, connectionState);
  if (accessMode === "background") await requireAgentTab(tabId, activeRequestGeneration);
  if (followActive) await assertFollowCommandScope(tabId, activeRequestGeneration);
  assertActiveRequestGeneration(activeRequestGeneration, generation, connectionState);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function assertResultScope(tabId, expectedGeneration) {
  assertRequestLive(expectedGeneration);
  if (accessMode === "background") await requireAgentTab(tabId, expectedGeneration);
  if (followActive) await assertFollowCommandScope(tabId, expectedGeneration);
  assertRequestLive(expectedGeneration);
}

async function isolatedContext(tabId) {
  await command(tabId, "Page.enable");
  const tree = await command(tabId, "Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) throw new CompanionError("Could not identify the top frame");
  const world = await command(tabId, "Page.createIsolatedWorld", {
    frameId,
    worldName: "pi-arc-companion",
    grantUniveralAccess: false
  });
  if (!world?.executionContextId) throw new CompanionError("Could not create isolated page world");
  return world.executionContextId;
}

async function evaluateFixed(tabId, contextId, expression) {
  const response = await command(tabId, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  if (response?.exceptionDetails) {
    throw new CompanionError(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "page operation failed");
  }
  return response?.result?.value;
}

async function resolveRef(tabId, ref, purpose, values) {
  const state = snapshotStates.get(tabId);
  if (!state) throw new CompanionError("No current snapshot references for this tab");
  try {
    return await evaluateFixed(tabId, state.contextId, createResolveRefExpression({
      snapshotId: state.snapshotId, ref, purpose, ...(values ? { values } : {})
    }));
  } catch (error) {
    if (/cannot find (?:an? )?(?:execution )?context|execution context (?:was )?destroyed|target (?:was )?navigated/i.test(errorMessage(error))) {
      snapshotStates.delete(tabId);
    }
    throw error;
  }
}

async function viewport(tabId) {
  const metrics = await command(tabId, "Page.getLayoutMetrics");
  const value = metrics.cssLayoutViewport || metrics.layoutViewport;
  if (!value || !Number.isFinite(value.clientWidth) || !Number.isFinite(value.clientHeight)) {
    throw new CompanionError("Could not read the page viewport");
  }
  return { width: value.clientWidth, height: value.clientHeight };
}

function checkedPoint(point, size) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
      point.x >= size.width || point.y >= size.height) {
    throw new CompanionError(`Coordinates must be inside the ${Math.round(size.width)}×${Math.round(size.height)} viewport`);
  }
  return point;
}

async function pointFor(tabId, params, purpose = "point") {
  const size = await viewport(tabId);
  const point = params.ref ? await resolveRef(tabId, params.ref, purpose) : { x: params.x, y: params.y };
  return { ...checkedPoint(point, size), size };
}

async function trustedClick(tabId, point, button = "left", clickCount = 1) {
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  for (let count = 1; count <= clickCount; count++) {
    await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: count });
    await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: count });
  }
}

const KEY_INFO = Object.freeze({
  Enter: ["Enter", "Enter", 13, "\r"], Tab: ["Tab", "Tab", 9, ""], Escape: ["Escape", "Escape", 27, ""],
  Backspace: ["Backspace", "Backspace", 8, ""], Delete: ["Delete", "Delete", 46, ""],
  ArrowUp: ["ArrowUp", "ArrowUp", 38, ""], ArrowDown: ["ArrowDown", "ArrowDown", 40, ""],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37, ""], ArrowRight: ["ArrowRight", "ArrowRight", 39, ""],
  Home: ["Home", "Home", 36, ""], End: ["End", "End", 35, ""],
  PageUp: ["PageUp", "PageUp", 33, ""], PageDown: ["PageDown", "PageDown", 34, ""],
  Space: [" ", "Space", 32, " "]
});

function parseKeyCombo(raw) {
  const parts = raw.split("+");
  if (parts.some((part) => !part)) throw new CompanionError("Invalid key combination");
  let modifiers = 0;
  for (const modifier of parts.slice(0, -1)) {
    const name = modifier.toLowerCase();
    if (name === "alt") modifiers |= 1;
    else if (name === "control" || name === "ctrl") modifiers |= 2;
    else if (name === "meta" || name === "command" || name === "cmd") modifiers |= 4;
    else if (name === "shift") modifiers |= 8;
    else throw new CompanionError(`Unknown key modifier: ${modifier}`);
  }
  const rawKey = parts.at(-1);
  const aliases = { Esc: "Escape", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", " ": "Space" };
  const named = aliases[rawKey] || rawKey;
  if (KEY_INFO[named]) {
    const [key, code, windowsVirtualKeyCode, text] = KEY_INFO[named];
    return { key, code, windowsVirtualKeyCode, text: modifiers & 6 ? "" : text, modifiers };
  }
  if ([...rawKey].length !== 1) throw new CompanionError(`Unsupported key: ${rawKey}`);
  const upper = rawKey.toUpperCase();
  const isLetter = /^[A-Z]$/.test(upper);
  const isDigit = /^[0-9]$/.test(rawKey);
  return {
    key: modifiers & 8 ? upper : rawKey,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${rawKey}` : "",
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: modifiers & 6 ? "" : (modifiers & 8 ? upper : rawKey),
    modifiers
  };
}

async function trustedPress(tabId, raw) {
  const key = parseKeyCombo(raw);
  const commands = [];
  if (key.code === "KeyA" && (key.modifiers & 6)) commands.push("selectAll");
  if (key.key === "Backspace") commands.push("deleteBackward");
  if (key.key === "Delete") commands.push("deleteForward");
  await command(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", ...key, ...(commands.length ? { commands } : {})
  });
  await command(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode, modifiers: key.modifiers });
}

async function waitForUrl(tabId, expected, expectedGeneration) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assertRequestLive(expectedGeneration);
    const tab = await chrome.tabs.get(tabId);
    assertRequestLive(expectedGeneration);
    if (isAllowedPageUrl(tab.url)) return tab;
    if (isAllowedPageUrl(tab.pendingUrl)) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
    if (tab.url && tab.url !== "about:blank" && tab.url !== expected) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new CompanionError("New tab did not reach an allowed http(s) page");
}

function assertRequestLive(requestGeneration) {
  if (connectionState !== "connected" || generation !== requestGeneration) {
    throw new CompanionError("Bridge disconnected while the action was in progress");
  }
}

async function openBackgroundTab(url, expectedGeneration) {
  assertRequestLive(expectedGeneration);
  const targetWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  assertRequestLive(expectedGeneration);
  if (!targetWindow?.id || targetWindow.incognito) {
    throw new CompanionError("Open a non-incognito normal Arc window first. Pi will not create or focus a window.");
  }
  const created = await chrome.tabs.create({ url, active: false, windowId: targetWindow.id });
  try {
    const tab = await waitForUrl(created.id, url, expectedGeneration);
    assertRequestLive(expectedGeneration);
    assertBackgroundTab(tab, true);
    agentTabs.add(tab.id);
    await attachAndShare(tab.id, expectedGeneration);
    const verified = await requireAgentTab(tab.id, expectedGeneration);
    return {
      tab: { id: verified.id, url: verified.url, title: verified.title || "", active: false },
      accessMode: "background"
    };
  } catch (error) {
    // Never close an errored tab that the user may already have taken over.
    if (generation === expectedGeneration && agentTabs.has(created.id)) await detachTab(created.id);
    throw new CompanionError(`${errorMessage(error)} The newly opened tab was left open without agent access.`);
  }
}

async function executeAction(action, untrustedParams, requestGeneration) {
  const params = validateActionParams(action, untrustedParams);
  if (action === "tabs") {
    if (accessMode === "background") {
      const tabs = [];
      for (const tabId of [...agentTabs]) {
        try {
          const tab = await requireAgentTab(tabId, requestGeneration, false);
          tabs.push({ id: tab.id, url: tab.url, title: tab.title || "", active: Boolean(tab.active) });
        } catch (error) { assertRequestLive(requestGeneration); }
      }
      return { tabs, accessMode: "background", note: "Only tabs opened by Pi in this connection are accessible. Open a URL to create an inactive agent tab. Existing tabs stay private; focus is disabled. Work pauses on agent tabs you select." };
    }
    if (followActive) {
      const active = await resolveFollowActive(requestGeneration);
      if (!active.tab) return { tabs: [], accessMode: "follow-active", note: active.note };
      return {
        tabs: [{ id: active.tab.id, url: active.tab.url, title: active.tab.title || "", active: true }],
        accessMode: "follow-active",
        note: active.note
      };
    }
    const tabs = [];
    for (const tabId of [...sharedTabs].sort((a, b) => a - b)) {
      try {
        const tab = await requireSharedTab(tabId);
        tabs.push({ id: tab.id, url: tab.url, title: tab.title || "", active: Boolean(tab.active) });
      } catch {}
    }
    return { tabs, accessMode: "manual" };
  }
  if (action === "open") {
    if (accessMode === "background") return openBackgroundTab(params.url, requestGeneration);
    assertRequestLive(requestGeneration);
    if (followActive && followPaused) {
      throw new FollowScopeError("Follow active tab access is paused. Disconnect and reconnect before opening a tab through Pi.");
    }
    const createProperties = { url: params.url, active: true };
    if (followActive) {
      let targetWindow;
      try { targetWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); }
      catch { targetWindow = null; }
      assertRequestLive(requestGeneration);
      if (!targetWindow?.id) throw new FollowScopeError("No normal Arc window is available for the new tab.");
      if (targetWindow.incognito) throw new FollowScopeError("Pi will not open or follow tabs in an incognito window.");
      createProperties.windowId = targetWindow.id;
    }
    const created = await chrome.tabs.create(createProperties);
    try {
      if (followActive) await revokeFollowedExcept(created.id);
      let tab = await waitForUrl(created.id, params.url, requestGeneration);
      if (followActive) {
        const current = await queryFollowCandidate(requestGeneration);
        if (current.tab?.id !== created.id) {
          await revokeFollowedExcept(null);
          throw followChangedError();
        }
        const resolved = await resolveFollowActive(requestGeneration, created.id);
        if (!resolved.tab) throw new FollowScopeError(resolved.note);
        tab = resolved.tab;
      } else {
        await attachAndShare(tab.id, requestGeneration);
      }
      return {
        tab: { id: tab.id, url: tab.url, title: tab.title || "", active: Boolean(tab.active) },
        accessMode: followActive ? "follow-active" : "manual"
      };
    } catch (error) {
      if (!(followActive && error instanceof FollowScopeError)) {
        try { await chrome.tabs.remove(created.id); } catch {}
      }
      throw error;
    }
  }

  if (accessMode === "background" && action === "focus") {
    throw new CompanionError("Focus is disabled in Background mode. Pi will not switch your current tab or window.");
  }
  let tab;
  if (accessMode === "background") {
    tab = await requireAgentTab(params.tabId, requestGeneration);
  } else if (followActive) {
    const active = await resolveFollowActive(requestGeneration, params.tabId);
    if (!active.tab) throw new FollowScopeError(active.note);
    tab = active.tab;
  } else {
    tab = await requireSharedTab(params.tabId);
  }
  assertRequestLive(requestGeneration);
  switch (action) {
    case "focus":
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      return { tabId: tab.id };
    case "close":
      // Recheck after asynchronous work; never close a tab the user just selected.
      await assertResultScope(tab.id, requestGeneration);
      await chrome.tabs.remove(tab.id);
      await detachTab(tab.id);
      return { tabId: tab.id, closed: true };
    case "navigate":
      await assertResultScope(tab.id, requestGeneration);
      snapshotStates.delete(tab.id);
      await chrome.tabs.update(tab.id, { url: params.url });
      return { tabId: tab.id, url: params.url };
    case "back":
      await assertResultScope(tab.id, requestGeneration);
      snapshotStates.delete(tab.id);
      await chrome.tabs.goBack(tab.id);
      return { tabId: tab.id };
    case "forward":
      await assertResultScope(tab.id, requestGeneration);
      snapshotStates.delete(tab.id);
      await chrome.tabs.goForward(tab.id);
      return { tabId: tab.id };
    case "reload":
      await assertResultScope(tab.id, requestGeneration);
      snapshotStates.delete(tab.id);
      await chrome.tabs.reload(tab.id);
      return { tabId: tab.id };
    case "snapshot": {
      const contextId = await isolatedContext(tab.id);
      const snapshotId = createSnapshotId();
      const value = await evaluateFixed(tab.id, contextId, createSnapshotExpression({
        snapshotId, maxChars: params.maxChars, maxElements: params.maxElements
      }));
      const result = snapshotResult(value);
      await assertResultScope(tab.id, requestGeneration);
      snapshotStates.set(tab.id, { contextId, snapshotId });
      return result;
    }
    case "click": {
      const point = await pointFor(tab.id, params, "click");
      await trustedClick(tab.id, point, params.button, params.clickCount);
      return { tabId: tab.id, x: point.x, y: point.y };
    }
    case "fill": {
      const point = await pointFor(tab.id, params, "fill");
      await trustedClick(tab.id, point);
      assertRequestLive(requestGeneration);
      await resolveRef(tab.id, params.ref, "focused");
      await trustedPress(tab.id, /Mac/i.test(point.platform || "") ? "Meta+a" : "Control+a");
      await trustedPress(tab.id, "Backspace");
      if (params.text) await command(tab.id, "Input.insertText", { text: params.text });
      return { tabId: tab.id, filled: true };
    }
    case "type": {
      const contextId = await isolatedContext(tab.id);
      const active = await evaluateFixed(tab.id, contextId, createInspectActiveExpression());
      if (active?.forbidden) throw new CompanionError(active.reason || `${active.type} inputs must be filled manually`);
      if (params.text) await command(tab.id, "Input.insertText", { text: params.text });
      return { tabId: tab.id, typed: true };
    }
    case "press": {
      const contextId = await isolatedContext(tab.id);
      const active = await evaluateFixed(tab.id, contextId, createInspectActiveExpression());
      if (active?.forbidden) throw new CompanionError(active.reason || `${active.type} inputs must be handled manually`);
      assertRequestLive(requestGeneration);
      await trustedPress(tab.id, params.key);
      return { tabId: tab.id, key: params.key };
    }
    case "scroll": {
      const size = await viewport(tab.id);
      const point = checkedPoint({ x: params.x ?? size.width / 2, y: params.y ?? size.height / 2 }, size);
      await command(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: point.x, y: point.y, deltaX: params.deltaX, deltaY: params.deltaY
      });
      return { tabId: tab.id };
    }
    case "hover": {
      const point = await pointFor(tab.id, params, "hover");
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      return { tabId: tab.id, x: point.x, y: point.y };
    }
    case "select": {
      const result = await resolveRef(tab.id, params.ref, "select", params.values);
      await assertResultScope(tab.id, requestGeneration);
      return { tabId: tab.id, values: result.values };
    }
    case "screenshot": {
      const size = await viewport(tab.id);
      const image = await command(tab.id, "Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: false
      });
      if (typeof image?.data !== "string") throw new CompanionError("Screenshot capture failed");
      await assertResultScope(tab.id, requestGeneration);
      return { mimeType: "image/png", data: image.data, width: Math.round(size.width), height: Math.round(size.height) };
    }
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, params.milliseconds));
      if (followActive) {
        const current = await resolveFollowActive(requestGeneration, tab.id);
        if (!current.tab) throw new FollowScopeError(current.note);
      } else if (accessMode === "background") {
        await requireAgentTab(tab.id, requestGeneration);
      } else {
        await requireSharedTab(tab.id);
      }
      return { tabId: tab.id, waited: params.milliseconds };
    case "detach":
      if (followActive) {
        followPaused = true;
        blockedFollowTabs.add(tab.id);
        connectionDetail = "Follow active tab paused until reconnect";
      }
      await detachTab(tab.id);
      return followActive
        ? { tabId: tab.id, detached: true, accessMode: "follow-active", note: followTabPolicy(tab, true).note }
        : { tabId: tab.id, detached: true };
    case "drag": {
      const size = await viewport(tab.id);
      const from = checkedPoint({ x: params.fromX, y: params.fromY }, size);
      const to = checkedPoint({ x: params.toX, y: params.toY }, size);
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...from, button: "none" });
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
      for (let step = 1; step <= 8; step++) {
        const ratio = step / 8;
        await command(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio,
          button: "left", buttons: 1
        });
      }
      await command(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
      return { tabId: tab.id };
    }
    default:
      throw new CompanionError(`Unknown action: ${action}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || message.type === "statusChanged") return false;
  const popupUrl = chrome.runtime.getURL("popup.html");
  if (sender.id !== chrome.runtime.id || sender.url !== popupUrl) return false;
  (async () => {
    await initialized;
    switch (message.type) {
      case "getStatus": return publicStatus();
      case "setPairing": await setPairing(message.pairing); return publicStatus();
      case "setFollowActive": return setFollowActive(message.enabled);
      case "setAccessMode": return setAccessMode(message.mode);
      case "connect": await connect(); return publicStatus();
      case "shareCurrent": await shareCurrentTab(); return publicStatus();
      case "unshareCurrent": await unshareCurrentTab(); return publicStatus();
      case "disconnect": await disconnect(); return publicStatus();
      default: throw new CompanionError("Unknown popup command");
    }
  })().then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return;
  const intentional = intentionalDetachTabs.delete(source.tabId);
  if (!sharedTabs.has(source.tabId) && !attachedTabs.has(source.tabId)) return;
  sharedTabs.delete(source.tabId);
  agentTabs.delete(source.tabId);
  attachedTabs.delete(source.tabId);
  snapshotStates.delete(source.tabId);
  if (followActive && !intentional && reason !== "target_closed" && connectionState === "connected") {
    followPaused = true;
    blockedFollowTabs.add(source.tabId);
    connectionDetail = "Debugger access was revoked; reconnect before following that tab again";
  }
  void persistRuntimeState().then(broadcastStatus);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!sharedTabs.has(tabId) && !attachedTabs.has(tabId) && !agentTabs.has(tabId)) return;
  agentTabs.delete(tabId);
  sharedTabs.delete(tabId);
  attachedTabs.delete(tabId);
  snapshotStates.delete(tabId);
  blockedFollowTabs.delete(tabId);
  intentionalDetachTabs.delete(tabId);
  void persistRuntimeState().then(broadcastStatus);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sharedTabs.has(tabId)) return;
  if (changeInfo.status === "loading" || changeInfo.url) snapshotStates.delete(tabId);
  if (changeInfo.url && !isAllowedPageUrl(changeInfo.url)) void detachTab(tabId);
});

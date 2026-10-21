export const MAX_INBOUND_BYTES = 1024 * 1024;
// Keep a full MiB below the bridge's 16 MiB WebSocket frame limit.
export const MAX_OUTBOUND_BYTES = 15 * 1024 * 1024;
export const ACTIONS = Object.freeze([
  "tabs", "open", "focus", "close", "navigate", "back", "forward", "reload",
  "snapshot", "click", "fill", "type", "press", "scroll", "hover", "select",
  "screenshot", "wait", "detach", "drag"
]);
const ACTION_SET = new Set(ACTIONS);
const encoder = new TextEncoder();

export class CompanionError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompanionError";
  }
}

function fail(message) { throw new CompanionError(message); }
function object(value, label = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function keys(value, allowed) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`unknown parameter: ${extra[0]}`);
}
function string(value, label, max = 100000, allowEmpty = true) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (!allowEmpty && value.length === 0) fail(`${label} must not be empty`);
  if (value.length > max) fail(`${label} is too long`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}
function finite(value, label, min = -1000000, max = 1000000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be a finite number from ${min} to ${max}`);
  }
  return value;
}
function tabId(value) { return integer(value, "tabId", 0, 2147483647); }
function optionalNumber(value, label, fallback) {
  return value === undefined ? fallback : finite(value, label);
}
function tabOnly(params) {
  keys(params, ["tabId"]);
  return { tabId: tabId(params.tabId) };
}

export function parsePairing(value) {
  object(value, "pairing");
  keys(value, ["port", "token"]);
  return {
    port: integer(value.port, "port", 1, 65535),
    token: string(value.token, "token", 8192, false)
  };
}

export function parsePairingText(text) {
  string(text, "pairing JSON", 16384, false);
  let value;
  try { value = JSON.parse(text); } catch { fail("pairing must be valid JSON"); }
  return parsePairing(value);
}

export function bridgeUrl(port) {
  return `ws://127.0.0.1:${integer(port, "port", 1, 65535)}/bridge`;
}

export function isAllowedPageUrl(raw) {
  if (typeof raw !== "string") return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "chromewebstore.google.com") return false;
  if (host === "chrome.google.com" && url.pathname.toLowerCase().startsWith("/webstore")) return false;
  if (host === "microsoftedge.microsoft.com" && url.pathname.toLowerCase().includes("/addons")) return false;
  return true;
}

export function requireAllowedPageUrl(raw, label = "url") {
  string(raw, label, 8192, false);
  if (!isAllowedPageUrl(raw)) fail(`${label} must be a non-protected http(s) URL`);
  return new URL(raw).href;
}

export function followTabPolicy(tab, blocked = false) {
  if (!tab || !Number.isInteger(tab.id)) {
    return { eligible: false, code: "no-active-tab", note: "No active tab was found in the last focused normal Arc window." };
  }
  if (tab.incognito) {
    return { eligible: false, code: "incognito", note: "Incognito tabs are never followed. Switch to a normal Arc window and re-run tabs." };
  }
  if (!isAllowedPageUrl(tab.url)) {
    return { eligible: false, code: "protected", note: "The active tab is not an allowed HTTP(S) page. Switch tabs and re-run tabs." };
  }
  if (blocked) {
    return { eligible: false, code: "blocked", note: "Follow active tab access is paused after debugger access was revoked. Disconnect and reconnect to allow it again." };
  }
  return { eligible: true, code: "allowed", note: "Only the active tab is accessible; background tabs remain unavailable." };
}

export const ACCESS_MODES = Object.freeze(["follow-active", "manual", "background"]);

export function parseAccessMode(value) {
  if (!ACCESS_MODES.includes(value)) fail("Access mode must be follow-active, manual, or background");
  return value;
}

export function assertBackgroundTab(tab, owned, requireInactive = true) {
  if (!owned) fail("This tab is not an agent-owned background tab from this connection");
  if (!tab || tab.incognito || !isAllowedPageUrl(tab.url)) {
    fail("Agent tabs must remain on non-incognito, allowed HTTP(S) pages");
  }
  if (requireInactive && tab.active) {
    fail("Agent tab is active under user control. Switch away from it to allow background work; Pi will not move your focus.");
  }
}

export function assertFollowRequestedTab(requestedTabId, activeTabId) {
  if (requestedTabId !== activeTabId) {
    fail("The active Arc tab changed. Re-run tabs and use the returned active tabId; the action was not redirected.");
  }
}

export function parseBridgeMessage(raw) {
  if (typeof raw !== "string") fail("bridge messages must be text");
  if (encoder.encode(raw).byteLength > MAX_INBOUND_BYTES) fail("bridge message is too large");
  let value;
  try { value = JSON.parse(raw); } catch { fail("bridge message is not valid JSON"); }
  object(value, "bridge message");
  string(value.type, "message type", 32, false);
  if (value.type === "ready" || value.type === "pong") {
    keys(value, ["type"]);
    return { type: value.type };
  }
  if (value.type !== "request") fail(`unsupported bridge message type: ${value.type}`);
  keys(value, ["type", "id", "action", "params"]);
  const id = string(value.id, "request id", 128, false);
  const action = string(value.action, "action", 32, false);
  if (!ACTION_SET.has(action)) fail(`unknown action: ${action}`);
  return { type: "request", id, action, params: validateActionParams(action, value.params) };
}

export function validateActionParams(action, raw) {
  if (!ACTION_SET.has(action)) fail(`unknown action: ${action}`);
  const params = object(raw, "params");
  switch (action) {
    case "tabs":
      keys(params, []);
      return {};
    case "open":
      keys(params, ["url"]);
      return { url: requireAllowedPageUrl(params.url) };
    case "focus": case "close": case "back": case "forward": case "reload":
    case "screenshot": case "detach":
      return tabOnly(params);
    case "navigate":
      keys(params, ["tabId", "url"]);
      return { tabId: tabId(params.tabId), url: requireAllowedPageUrl(params.url) };
    case "snapshot": {
      keys(params, ["tabId", "maxChars", "maxElements"]);
      return {
        tabId: tabId(params.tabId),
        maxChars: params.maxChars === undefined ? 12000 : integer(params.maxChars, "maxChars", 100, 20000),
        maxElements: params.maxElements === undefined ? 100 : integer(params.maxElements, "maxElements", 1, 200)
      };
    }
    case "click": {
      keys(params, ["tabId", "ref", "x", "y", "button", "clickCount"]);
      const hasRef = params.ref !== undefined;
      const hasPoint = params.x !== undefined || params.y !== undefined;
      if (hasRef === hasPoint) fail("click requires either ref or x and y");
      if (hasPoint && (params.x === undefined || params.y === undefined)) fail("click requires both x and y");
      const result = {
        tabId: tabId(params.tabId),
        button: params.button === undefined ? "left" : string(params.button, "button", 8, false),
        clickCount: params.clickCount === undefined ? 1 : integer(params.clickCount, "clickCount", 1, 2)
      };
      if (!["left", "middle", "right"].includes(result.button)) fail("button must be left, middle, or right");
      if (hasRef) result.ref = string(params.ref, "ref", 256, false);
      else { result.x = finite(params.x, "x", -100000, 100000); result.y = finite(params.y, "y", -100000, 100000); }
      return result;
    }
    case "fill":
      keys(params, ["tabId", "ref", "text"]);
      return { tabId: tabId(params.tabId), ref: string(params.ref, "ref", 256, false), text: string(params.text, "text", 50000) };
    case "type":
      keys(params, ["tabId", "text"]);
      return { tabId: tabId(params.tabId), text: string(params.text, "text", 50000) };
    case "press":
      keys(params, ["tabId", "key"]);
      return { tabId: tabId(params.tabId), key: string(params.key, "key", 100, false) };
    case "scroll":
      keys(params, ["tabId", "deltaX", "deltaY", "x", "y"]);
      return {
        tabId: tabId(params.tabId),
        deltaX: optionalNumber(params.deltaX, "deltaX", 0),
        deltaY: optionalNumber(params.deltaY, "deltaY", 0),
        ...(params.x === undefined ? {} : { x: finite(params.x, "x", -100000, 100000) }),
        ...(params.y === undefined ? {} : { y: finite(params.y, "y", -100000, 100000) })
      };
    case "hover": {
      keys(params, ["tabId", "ref", "x", "y"]);
      const hasRef = params.ref !== undefined;
      const hasPoint = params.x !== undefined || params.y !== undefined;
      if (hasRef === hasPoint) fail("hover requires either ref or x and y");
      if (hasPoint && (params.x === undefined || params.y === undefined)) fail("hover requires both x and y");
      return hasRef
        ? { tabId: tabId(params.tabId), ref: string(params.ref, "ref", 256, false) }
        : { tabId: tabId(params.tabId), x: finite(params.x, "x", -100000, 100000), y: finite(params.y, "y", -100000, 100000) };
    }
    case "select": {
      keys(params, ["tabId", "ref", "values"]);
      if (!Array.isArray(params.values) || params.values.length > 100) fail("values must be an array of at most 100 strings");
      return {
        tabId: tabId(params.tabId), ref: string(params.ref, "ref", 256, false),
        values: params.values.map((value, index) => string(value, `values[${index}]`, 1000))
      };
    }
    case "wait":
      keys(params, ["tabId", "milliseconds"]);
      return { tabId: tabId(params.tabId), milliseconds: integer(params.milliseconds, "milliseconds", 0, 5000) };
    case "drag":
      keys(params, ["tabId", "fromX", "fromY", "toX", "toY"]);
      return {
        tabId: tabId(params.tabId),
        fromX: finite(params.fromX, "fromX", -100000, 100000),
        fromY: finite(params.fromY, "fromY", -100000, 100000),
        toX: finite(params.toX, "toX", -100000, 100000),
        toY: finite(params.toY, "toY", -100000, 100000)
      };
    default:
      fail(`unknown action: ${action}`);
  }
}

export function serializeBridgeMessage(value) {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength > MAX_OUTBOUND_BYTES) fail("bridge response is too large");
  return json;
}

export function parseFollowActive(value) {
  if (typeof value !== "boolean") fail("enabled must be a boolean");
  return value;
}

export function assertActiveRequestGeneration(activeGeneration, currentGeneration, connectionState) {
  if (!Number.isInteger(activeGeneration) || activeGeneration !== currentGeneration || connectionState !== "connected") {
    fail("Bridge connection changed while the browser action was in progress");
  }
}

export function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1000) || "unknown error";
}

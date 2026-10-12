import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionError, assertActiveRequestGeneration, assertFollowRequestedTab, followTabPolicy,
  isAllowedPageUrl, parseBridgeMessage, parseFollowActive, parsePairingText, validateActionParams
} from "../companion/lib/contracts.mjs";
import {
  createInspectActiveExpression, createResolveRefExpression, createSnapshotExpression, snapshotResult
} from "../companion/lib/snapshot.mjs";

test("pairing and bridge protocol validate untrusted input", () => {
  assert.deepEqual(parsePairingText('{"port":4312,"token":"secret"}'), { port: 4312, token: "secret" });
  assert.throws(() => parsePairingText('{"port":0,"token":"x"}'), /port/);
  assert.throws(() => parsePairingText('{"port":4312,"token":""}'), /token/);
  assert.throws(() => parseBridgeMessage('{"type":"request","id":"1","action":"eval","params":{}}'), /unknown action/);
  assert.throws(() => parseBridgeMessage(`{"type":"pong","padding":"${"x".repeat(1024 * 1024)}"}`), /too large/);
  assert.deepEqual(
    parseBridgeMessage('{"type":"request","id":"r1","action":"wait","params":{"tabId":7,"milliseconds":12}}'),
    { type: "request", id: "r1", action: "wait", params: { tabId: 7, milliseconds: 12 } }
  );
});

test("request generation guard blocks stale CDP work after disconnect or reconnect", () => {
  assert.doesNotThrow(() => assertActiveRequestGeneration(7, 7, "connected"));
  assert.throws(() => assertActiveRequestGeneration(7, 8, "connected"), /connection changed/);
  assert.throws(() => assertActiveRequestGeneration(7, 7, "disconnected"), /connection changed/);
  assert.throws(() => assertActiveRequestGeneration(null, 7, "connected"), /connection changed/);
});

test("follow-active policy exposes only an eligible active tab", () => {
  const allowed = { id: 9, url: "https://example.com/", incognito: false };
  assert.deepEqual(followTabPolicy(allowed).code, "allowed");
  assert.equal(followTabPolicy(null).code, "no-active-tab");
  assert.equal(followTabPolicy({ ...allowed, incognito: true }).code, "incognito");
  assert.equal(followTabPolicy({ ...allowed, url: "chrome://settings" }).code, "protected");
  assert.equal(followTabPolicy(allowed, true).code, "blocked");
  assert.doesNotThrow(() => assertFollowRequestedTab(9, 9));
  assert.throws(() => assertFollowRequestedTab(9, 10), /active Arc tab changed/);
  assert.equal(parseFollowActive(true), true);
  assert.throws(() => parseFollowActive("true"), /boolean/);
});

test("page URL policy allows ordinary web pages and rejects protected schemes/stores", () => {
  assert.equal(isAllowedPageUrl("https://example.com/path"), true);
  assert.equal(isAllowedPageUrl("http://127.0.0.1:3000/"), true);
  assert.equal(isAllowedPageUrl("chrome://settings"), false);
  assert.equal(isAllowedPageUrl("file:///tmp/private"), false);
  assert.equal(isAllowedPageUrl("https://chromewebstore.google.com/detail/example"), false);
  assert.equal(isAllowedPageUrl("https://chrome.google.com/webstore/detail/example"), false);
  assert.equal(isAllowedPageUrl("https://user:secret@example.com/"), false);
});

test("action validation normalizes requests and enforces bounds and shapes", () => {
  assert.deepEqual(validateActionParams("snapshot", { tabId: 4 }), {
    tabId: 4, maxChars: 12000, maxElements: 100
  });
  assert.throws(() => validateActionParams("snapshot", { tabId: 4, maxChars: 20001 }), /maxChars/);
  assert.throws(() => validateActionParams("snapshot", { tabId: 4, maxElements: 201 }), /maxElements/);
  assert.throws(() => validateActionParams("click", { tabId: 4, ref: "r", x: 1, y: 2 }), /either ref/);
  assert.throws(() => validateActionParams("fill", { tabId: 4, ref: "r", text: "x", script: "alert(1)" }), /unknown parameter/);
  assert.throws(() => validateActionParams("wait", { tabId: 4, milliseconds: 5001 }), /milliseconds/);
  assert.deepEqual(validateActionParams("select", { tabId: 4, ref: "r", values: ["a", "b"] }), {
    tabId: 4, ref: "r", values: ["a", "b"]
  });
});

test("snapshot is bounded, records actual elements, traverses open shadow roots, and omits password values", () => {
  class FakeNode {}
  FakeNode.TEXT_NODE = 3;
  FakeNode.ELEMENT_NODE = 1;
  class FakeElement extends FakeNode {
    constructor(localName, text = "") {
      super();
      this.nodeType = 1;
      this.localName = localName;
      this.childNodes = [];
      this.attrs = new Map();
      this.innerText = text;
      this.isConnected = true;
      this.ownerDocument = null;
      this.disabled = false;
      this.readOnly = false;
      this.isContentEditable = false;
      this.shadowRoot = null;
      this.parentElement = null;
      this.rect = { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    }
    getClientRects() { return [this.getBoundingClientRect()]; }
    getBoundingClientRect() { return this.rect; }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    hasAttribute(name) { return this.attrs.has(name); }
    dispatchEvent() { return true; }
  }
  class FakeInput extends FakeElement {
    constructor(type, value) { super("input"); this.type = type; this.value = value; this.placeholder = ""; this.checked = false; }
  }
  class FakeTextArea extends FakeElement {}
  class FakeSelect extends FakeElement {}
  class FakeText extends FakeNode {
    constructor(value, parentElement) { super(); this.nodeType = 3; this.nodeValue = value; this.parentElement = parentElement; }
  }
  const button = new FakeElement("button", "Save");
  const text = new FakeText("Visible page text", button);
  button.childNodes.push(text);
  const password = new FakeInput("password", "never expose this");
  const host = new FakeElement("div");
  const shadowButton = new FakeElement("button", "Shadow action");
  host.shadowRoot = { childNodes: [shadowButton] };
  let hitElement = button;
  const fakeDocument = {
    title: "Fixture",
    childNodes: [button, password, host],
    activeElement: null,
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [button.getBoundingClientRect()] }),
    getElementById: () => null,
    elementFromPoint: () => hitElement
  };
  for (const element of [button, password, host, shadowButton]) element.ownerDocument = fakeDocument;

  Object.assign(globalThis, {
    Node: FakeNode,
    Element: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    document: fakeDocument,
    getComputedStyle: (element) => element.styleMock || ({ display: "block", visibility: "visible", opacity: "1" }),
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 20,
    location: { href: "https://example.test/" }
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });

  const value = (0, eval)(createSnapshotExpression({ snapshotId: "pi-fixture", maxChars: 10, maxElements: 3 }));
  const result = snapshotResult(value);
  assert.equal(result.elements.length, 3);
  assert.match(result.content, /\[text truncated\]/);
  assert.equal(result.elements.some((item) => item.name === "Shadow action"), true);
  const passwordDescription = result.elements.find((item) => item.type === "password");
  assert.equal(Object.hasOwn(passwordDescription, "value"), false);
  assert.equal(globalThis.__PI_ARC_SNAPSHOT_REFS__.refs.get("pi-fixture.e1"), button);
  fakeDocument.activeElement = password;
  assert.deepEqual((0, eval)(createInspectActiveExpression()), {
    forbidden: true, type: "password", reason: "password inputs must be filled manually"
  });
  fakeDocument.activeElement = new FakeElement("iframe");
  assert.match((0, eval)(createInspectActiveExpression()).reason, /Cannot type into a focused iframe/);

  const editable = new FakeInput("text", "");
  editable.ownerDocument = fakeDocument;
  globalThis.__PI_ARC_SNAPSHOT_REFS__.refs.set("pi-fixture.edit", editable);
  hitElement = editable;
  fakeDocument.activeElement = host;
  assert.throws(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.edit", purpose: "focused" })),
    /did not receive focus/
  );
  fakeDocument.activeElement = editable;
  assert.doesNotThrow(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.edit", purpose: "focused" }))
  );
  hitElement = button;

  const resolved = (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.e1", purpose: "click" }));
  assert.deepEqual({ x: resolved.x, y: resolved.y }, { x: 60, y: 25 });
  hitElement = host;
  assert.throws(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.e1", purpose: "click" })),
    /obscured/
  );
  hitElement = button;
  button.styleMock = { display: "block", visibility: "visible", opacity: "0" };
  assert.throws(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.e1", purpose: "click" })),
    /not visible/
  );
  button.styleMock = null;
  button.rect = { x: 10, y: 900, left: 10, top: 900, right: 110, bottom: 930, width: 100, height: 30 };
  assert.throws(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.e1", purpose: "click" })),
    /outside the visible viewport/
  );
  button.isConnected = false;
  assert.throws(
    () => (0, eval)(createResolveRefExpression({ snapshotId: "pi-fixture", ref: "pi-fixture.e1", purpose: "click" })),
    /stale or disconnected/
  );
});

test("snapshot result rejects malformed page output", () => {
  assert.throws(() => snapshotResult({ snapshotId: "x", elements: [] }), /invalid snapshot/);
  assert.ok(new CompanionError("x") instanceof Error);
});

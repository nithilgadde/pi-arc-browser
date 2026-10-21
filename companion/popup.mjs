import { parsePairingText } from "./lib/contracts.mjs";

const elements = {
  pairing: document.querySelector("#pairing"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  accessMode: document.querySelector("#access-mode"),
  accessDisclosure: document.querySelector("#access-disclosure"),
  manualControls: document.querySelector("#manual-controls"),
  tabsTitle: document.querySelector("#tabs-title"),
  tabsHint: document.querySelector("#tabs-hint"),
  share: document.querySelector("#share"),
  unshare: document.querySelector("#unshare"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#status-dot"),
  sharedTabs: document.querySelector("#shared-tabs"),
  tabCount: document.querySelector("#tab-count"),
  error: document.querySelector("#error")
};
let latestStatus = {
  connection: "disconnected", detail: "Not connected", paired: false,
  followActive: true, accessMode: "follow-active", sharedTabIds: []
};
let busy = false;

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Companion did not respond");
  return response.result;
}

function render(status) {
  latestStatus = status;
  const connected = status.connection === "connected";
  const transitioning = status.connection === "connecting" || status.connection === "authenticating";
  elements.status.textContent = status.detail || status.connection;
  elements.statusDot.className = `status-dot ${status.connection}`;
  elements.tabCount.textContent = String(status.sharedTabIds.length);
  elements.sharedTabs.textContent = status.sharedTabIds.length ? status.sharedTabIds.join(" · ") : "None";
  const mode = status.accessMode || (status.followActive !== false ? "follow-active" : "manual");
  const following = mode === "follow-active";
  const background = mode === "background";
  elements.accessMode.value = mode;
  elements.accessMode.disabled = busy || status.connection !== "disconnected";
  elements.manualControls.hidden = mode !== "manual";
  elements.tabsTitle.textContent = background ? "Agent tabs" : following ? "Accessible tab" : "Shared tabs";
  elements.accessDisclosure.textContent = background
    ? "Pi opens its own inactive tabs without switching yours. Existing tabs stay private. These tabs use your current browser logins, not a separate profile."
    : following
      ? "Connect allows Pi to inspect and control the current allowed tab when Pi requests it. Background tabs remain inaccessible."
      : "Manual mode requires Share current tab. Only tabs listed below are accessible.";
  elements.tabsHint.textContent = background
    ? "Ask Pi to open a URL. Work pauses if you select an agent tab. Disconnect revokes access but leaves tabs open."
    : following
      ? "Pi resolves the active allowed tab only when requested. Arc shows its normal debugger banner while attached."
      : "Only HTTP(S) tabs you explicitly share are accessible. Arc shows its normal debugger banner while attached.";
  elements.connect.disabled = busy || connected || transitioning;
  elements.disconnect.disabled = busy || status.connection === "disconnected";
  elements.share.disabled = busy || !connected || mode !== "manual";
  elements.unshare.disabled = busy || !connected || mode !== "manual" || status.sharedTabIds.length === 0;
  if (status.paired && !elements.pairing.value) elements.pairing.placeholder = "Pairing saved for this browser session";
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

async function run(button, operation, pendingMode) {
  elements.error.hidden = true;
  busy = true;
  button.dataset.state = "loading";
  render(latestStatus);
  if (typeof pendingMode === "string") elements.accessMode.value = pendingMode;
  try {
    const status = await operation();
    button.dataset.state = "success";
    render(status);
  } catch (error) {
    button.dataset.state = "error";
    showError(error);
  } finally {
    busy = false;
    setTimeout(() => { delete button.dataset.state; }, 700);
    try { render(await send("getStatus")); } catch {}
  }
}

elements.connect.addEventListener("click", () => run(elements.connect, async () => {
  const text = elements.pairing.value.trim();
  if (text) {
    const pairing = parsePairingText(text);
    await send("setPairing", { pairing });
    elements.pairing.value = "";
  }
  return send("connect");
}));
elements.disconnect.addEventListener("click", () => run(elements.disconnect, () => send("disconnect")));
elements.accessMode.addEventListener("change", () => {
  const mode = elements.accessMode.value;
  void run(elements.accessMode, () => send("setAccessMode", { mode }), mode);
});
elements.share.addEventListener("click", () => run(elements.share, () => send("shareCurrent")));
elements.unshare.addEventListener("click", () => run(elements.unshare, () => send("unshareCurrent")));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "statusChanged" && message.status) render(message.status);
});

try { render(await send("getStatus")); }
catch (error) { showError(error); render(latestStatus); }

import { parsePairingText } from "./lib/contracts.mjs";

const elements = {
  pairing: document.querySelector("#pairing"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  followActive: document.querySelector("#follow-active"),
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
  const following = status.followActive !== false;
  elements.followActive.checked = following;
  elements.followActive.disabled = busy || status.connection !== "disconnected";
  elements.manualControls.hidden = following;
  elements.tabsTitle.textContent = following ? "Accessible tab" : "Shared tabs";
  elements.accessDisclosure.textContent = following
    ? "Connect allows Pi to inspect and control the current allowed tab when Pi requests it. Background tabs remain inaccessible."
    : "Manual mode requires Share current tab. Only tabs listed below are accessible.";
  elements.tabsHint.textContent = following
    ? "Pi resolves the active allowed tab only when requested. Arc shows its normal debugger banner while attached."
    : "Only HTTP(S) tabs you explicitly share are accessible. Arc shows its normal debugger banner while attached.";
  elements.connect.disabled = busy || connected || transitioning;
  elements.disconnect.disabled = busy || status.connection === "disconnected";
  elements.share.disabled = busy || !connected || following;
  elements.unshare.disabled = busy || !connected || following || status.sharedTabIds.length === 0;
  if (status.paired && !elements.pairing.value) elements.pairing.placeholder = "Pairing saved for this browser session";
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

async function run(button, operation, pendingFollowValue) {
  elements.error.hidden = true;
  busy = true;
  button.dataset.state = "loading";
  render(latestStatus);
  if (typeof pendingFollowValue === "boolean") elements.followActive.checked = pendingFollowValue;
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
elements.followActive.addEventListener("change", () => {
  const enabled = elements.followActive.checked;
  void run(elements.followActive, () => send("setFollowActive", { enabled }), enabled);
});
elements.share.addEventListener("click", () => run(elements.share, () => send("shareCurrent")));
elements.unshare.addEventListener("click", () => run(elements.unshare, () => send("unshareCurrent")));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "statusChanged" && message.status) render(message.status);
});

try { render(await send("getStatus")); }
catch (error) { showError(error); render(latestStatus); }

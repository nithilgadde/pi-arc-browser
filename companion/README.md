# Pi Arc Browser

A dependency-free Chrome Manifest V3 extension for allowing Pi to use the active tab in the user's existing Arc session. It uses `chrome.debugger` and Chrome DevTools Protocol; Arc does not need to be launched with a remote-debugging port.

## Install in Arc

1. Open `arc://extensions` (or **Extensions → Manage Extensions**).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `companion/` directory.
4. Pin **Pi Arc Browser** if desired.

## Connect and follow the active tab

1. Start the Pi browser bridge and copy its pairing JSON, shaped like:
   ```json
   {"port": 3210, "token": "…"}
   ```
2. Paste it into the extension popup. **Follow active tab** is enabled by default.
3. Choose **Connect**. This permits Pi to resolve the active tab only when Pi makes a browser request; it does not continuously capture tabs.
4. Make the intended ordinary HTTP(S) tab active in the last-used normal Arc window. Pi's next `tabs` request attaches it and Arc shows its normal debugger notice.

Background tabs remain inaccessible. Switching tabs causes the previously followed debugger to detach; Pi must call `tabs` again and use the new tab ID. Protected and extension pages return an empty list rather than falling back to a background page. Incognito tabs are never auto-followed.

For legacy behavior, choose **Manual shared tabs** in the **Browser access** selector while disconnected. Manual **Share current tab** and **Unshare current tab** controls then appear. The mode cannot be changed while connecting or connected.

For separate work while you browse, choose **Background agent tabs** before connecting. Pi's `open` creates inactive tabs without focusing a window. Only tabs created in this connection are owned; existing tabs and website-created popups are never adopted. Multiple agent tabs are supported. Pi cannot `focus` any tab in this mode, and all content actions pause if you select an agent tab. Disconnect leaves tabs open but forgets ownership; a reconnect needs new agent tabs. Cancelling debugging or detaching revokes that tab without silent reattachment.

Background tabs use your existing profile/logins. Websites may open their own foreground popups or dialogs, or throttle background rendering; the companion does not seize focus back or promise desktop isolation.

Pairing and the follow preference are stored in `chrome.storage.session`, never sync storage. The extension does not reconnect automatically. **Disconnect**, a WebSocket loss, closing a tab, navigating to a protected page, or Chrome detaching the debugger revokes access as applicable. A debugger cancellation, follow-mode unshare, or `detach` action pauses all automatic following until an explicit disconnect and reconnect. Disconnecting detaches every companion-owned debugger session.

## Security boundary

- In follow mode, `tabs` returns only the current eligible tab from Arc's last-focused normal window. It never returns background-tab metadata.
- Every targeted follow-mode action refuses a tab ID that is no longer active and tells the caller to re-run `tabs`; actions are never redirected to a different tab.
- Every CDP command rechecks the connection generation and applicable scope: current active tab in follow mode, or owned and inactive agent tab in background mode. Snapshot, screenshot, and select-result scope is checked again before page-derived data is returned.
- Background tab ownership is connection-local, checked before fetching tab metadata, and never restored from storage. Its `open` action uses `active: false` in a non-incognito normal window. `focus` and manual sharing are denied.
- In manual mode, only tabs shared by an explicit popup gesture are exposed. The remote `open` action may create and follow/share a new HTTP(S) tab while connected.
- Every action rechecks the current tab URL. Browser-internal pages, files, extension pages, Chrome Web Store pages, and Edge Add-ons pages are rejected.
- There are no content scripts, externally connectable messages, cookie permissions, network interception permissions, or page `postMessage` channels.
- Page scripts cannot supply CDP methods or JavaScript. The extension uses a fixed action allowlist and fixed isolated-world functions.
- Ref actions are tied to actual element objects from the latest snapshot. Navigation, a newer snapshot, removed elements, or a lost isolated execution context makes old refs stale.
- Password values are omitted. Password and file inputs must be filled manually.

Page content and accessibility text returned by snapshots must still be treated as untrusted data by the bridge/model.

## Bridge protocol

The popup opens `ws://127.0.0.1:PORT/bridge`. On open the extension sends:

```json
{"type":"auth","token":"…"}
```

The bridge answers `{"type":"ready"}`. The extension then sends `{"type":"ping"}` every 20 seconds and expects `{"type":"pong"}`. Requests and responses are:

```json
{"type":"request","id":"unique-id","action":"snapshot","params":{"tabId":123}}
{"type":"response","id":"unique-id","result":{}}
{"type":"response","id":"unique-id","error":"message"}
```

Requests execute sequentially. Unknown actions, duplicate in-flight IDs, invalid parameters, text messages over 1 MiB, and invalid URL schemes are rejected. Queued requests are discarded on disconnect, every CDP send rechecks the originating connection generation and follow scope, and in-flight results are not delivered after that generation or active tab changes. There is no action retry.

`tabs` returns `accessMode: "follow-active"`, `"manual"`, or `"background"`. Follow mode returns one active eligible tab or `tabs: []` with an explanatory `note`. Background mode returns only current-connection agent tabs (initially empty); an owned tab's `active: true` means its content actions are paused for user control.

Popup-only control: `{type:"setAccessMode", mode:"background"}` (or the other modes) is accepted only while disconnected. Legacy `{type:"setFollowActive", enabled:boolean}` maps to follow-active/manual. The remote bridge has no mode-changing action.

Supported actions: `tabs`, `open`, `focus`, `close`, `navigate`, `back`, `forward`, `reload`, `snapshot`, `click`, `fill`, `type`, `press`, `scroll`, `hover`, `select`, `screenshot`, `wait`, `detach`, and optional `drag`.

Snapshot limits are `maxChars: 100..20000` (default 12000) and `maxElements: 1..200` (default 100). Snapshots include visible top-document text, actionable elements in the top document and open shadow roots, and viewport data. They do not inspect iframe DOM. Trusted coordinate input can target visible iframe content, but text insertion into a focused iframe is refused because the companion cannot prove that the inner target is not a password or file input. Waits are capped at 5 seconds.

## Tests

From the repository root:

```sh
node --test tests/companion.test.mjs tests/background-policy.test.mjs
# With a Chromium executable and playwright-core installed:
PI_BROWSER_CHROMIUM="/path/to/chromium" npm run test:browser
```

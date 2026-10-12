# Pi Arc Browser

A Pi extension + Arc/Chromium companion that lets Pi operate **your existing, logged-in tabs**. No separate browser profile, remote-debugging launch flags, cloud relay, or accessibility permissions.

This implements a browser-assistant workflow, not all of Claude Cowork. It cannot control native applications or Arc's chrome/sidebar.

## Install

Requirements: macOS, Node 22+, a recent Arc version supporting Manifest V3 and `chrome.debugger`, and the Earendil Pi coding agent.

```sh
cd ~/Desktop/pi-arc-browser
npm install --omit=peer --ignore-scripts
pi install ~/Desktop/pi-arc-browser
```

In Pi, run `/reload` (or restart Pi).

### One-time Arc setup

1. Open **`chrome://extensions`** in Arc.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select **`~/Desktop/pi-arc-browser/companion`**.
4. Pin **Pi Arc Browser** if helpful.

Keep this folder in place. Pi and Arc load files from it; moving it requires reinstalling/reloading their respective paths.

### Pair a Pi session

1. In Pi, run **`/browser start`**. This copies private pairing JSON to your clipboard.
2. Open the **Pi Arc Browser** extension popup in Arc. Paste pairing, leave **Follow active tab** checked, and click **Connect**.
3. Select the website tab you want Pi to use, return to Pi, and ask a browser task. **No Share click is needed**, including when you switch to another tab.

   > Look at my current Arc tab and tell me what is on the page.

   > Fill out this form using the details below, but stop before submitting.

   > Summarize the article in my active tab.

**Follow active tab** gives Pi access only to the current allowed HTTP(S) tab in your last-focused normal Arc window. The current tab is resolved when Pi makes a browser request, not continuously watched. Returning to your Pi terminal does not lose the selected browser tab. Previously active/background tabs become inaccessible; switching tabs during an action causes it to stop rather than typing/clicking in the wrong tab. Protected pages and incognito tabs are not followed.

The browser's debugger/automation banner is expected. Cancelling it or revoking a followed tab pauses automatic access until you explicitly reconnect.

For manual multi-tab access, disconnect, uncheck **Follow active tab**, reconnect, and use **Share current tab** for each desired tab. Manual mode preserves the previous sharing workflow; new user-created tabs/popups are not automatically shared. The access-mode checkbox is disabled while connected.

Pairing is per Pi session. After disconnect, reload, or stopping Pi, reconnect. Follow mode needs no re-sharing; manual mode does. There is no automatic reconnect or action replay. Use `/browser pair` to copy the running session's pairing again. Do not paste pairing into a web page or the chat.

### Updating an already loaded companion

After changing these source files, open `chrome://extensions` in Arc and click the reload icon on **Pi Arc Browser**. Run `/reload` then `/browser start` in Pi, paste the new pairing into the companion, and connect. Follow active tab is enabled by default; previously chosen manual mode remains available.

## Commands

| Command | Effect |
| --- | --- |
| `/browser start` | Start a loopback bridge on a random free port; copy pairing to clipboard |
| `/browser pair` | Copy current pairing again |
| `/browser status` | Show connection status and companion path, never the token |
| `/browser mode ask` | Ask for approval before every browser-changing action (default) |
| `/browser mode auto` | User-confirmed automatic browser actions for this Pi session |
| `/browser stop` | Revoke pairing and stop the bridge; leave web tabs open |
| `/skill:arc-browser` | Load the browser workflow instructions explicitly |

In auto mode, the agent is still instructed to ask before sensitive actions. **This is agent guidance, not a reliable semantic firewall.** A generic click can submit, purchase, delete, or authorize access. Use `ask` mode and inspect the page for high-stakes tasks. Disconnect in the Arc popup at any time.

## Capabilities

The `arc_browser` tool supports:

- Active-tab discovery without sharing clicks, or explicit multi-tab sharing in manual mode.
- Opening, focusing, navigation, back/forward, reload, close, and detach within the authorized scope.
- Bounded visible DOM snapshots and actionable, stale-checked element references.
- PNG screenshots returned as actual image content to vision-capable models.
- Ref-based or coordinate clicking/hovering; single/double and left/middle/right clicks.
- Fill/replace fields, insert text, key/chord presses, select options, and scrolling.
- Short waits and observe → act → verify workflows.

All tab actions require an explicit `tabId` from `tabs`. Examples:

```json
{"action":"tabs"}
{"action":"snapshot","tabId":123,"maxChars":12000,"maxElements":100}
{"action":"click","tabId":123,"ref":"<reference from snapshot>"}
{"action":"fill","tabId":123,"ref":"<reference from snapshot>","text":"Hello"}
{"action":"press","tabId":123,"key":"Enter"}
{"action":"screenshot","tabId":123}
{"action":"scroll","tabId":123,"deltaY":600}
```

Screenshot coordinates are CSS viewport coordinates, not physical monitor pixels. Use the returned dimensions when scaling a resized image. Screenshots should be called directly rather than through text-only codemode wrappers.

## Architecture and security

```text
Pi model → arc_browser tool → session-local WebSocket bridge
                                    ↑ authenticated loopback
                          Arc companion service worker
                                    ↓ chrome.debugger / CDP
                       active tab / manually shared tabs
```

- The listener starts only on `/browser start`, not during extension discovery or startup.
- The server binds only `127.0.0.1`, checks Host/path and a Chrome-extension Origin, and requires a random 256-bit secret. No HTTP control API or browser-page message bridge.
- Pairing tokens are kept out of model-facing status/results. Tokens are sensitive: another process running as your user could read your clipboard; this is not protection from a compromised machine.
- Connecting with **Follow active tab** authorizes the currently active allowed web tab on demand, not background tabs. Uncheck it before connecting for explicit per-tab sharing instead. The model cannot change this permission setting. No cookie, network-interception, arbitrary-JavaScript, or native-filesystem tools are exposed to the model.
- Operations are serialized and never automatically retried. Cancelling/timing out disconnects and invalidates queued requests. Already-dispatched input cannot be undone.
- Page text is marked untrusted. Prompt guidance warns against page instructions, secret extraction, and unauthorized consequential actions.
- Default mutation approval uses Pi dialogs. `auto` is an explicit user choice, not a model-callable setting.
- Reload/shutdown/stop close sockets. Disconnecting detaches debugging and clears sharing.

### Privacy

The bridge has no cloud relay or telemetry, **but Pi sends tool results and screenshots to your configured model provider**. Pi transcripts can retain URLs, page content, and text you ask it to enter. Password input values are excluded from DOM snapshots, but screenshot pixels and arbitrary page text are not reliably redacted.

Snapshots and screenshots are saved under a session-created `pi-arc-browser-*` directory in the macOS temporary directory, with a private directory and owner-only files. They are retained for inspection and are not guaranteed to disappear when Pi exits; delete them when no longer needed. Pairing is copied to your OS clipboard by `/browser start` or `/browser pair`; overwrite your clipboard after pasting it if needed.

## Limitations and troubleshooting

- **No connected browser:** run `/browser start` and connect the companion. Multiple Pi sessions have different ports/tokens; pair the intended one.
- **No active allowed tab:** select a normal HTTP(S) website tab in Arc, then ask Pi again. No Share click is needed in follow mode.
- **Tab changed/not active:** Pi must call `tabs` again and inspect the current page. It cannot keep acting on the previous background tab. To use several tabs without switching, explicitly choose manual mode and share them.
- **Tab not shared in manual mode:** share it from the popup. Manual mode does not automatically share user-created tabs.
- **Stale reference:** take a new snapshot and identify the element again.
- **DevTools/debugger conflict:** close that tab's DevTools. In follow mode, reconnect if access was paused; in manual mode, re-share. Cancelling the debugger banner revokes access; Pi must not silently reattach.
- **Navigation still loading:** observe again or use a short wait; navigation acknowledgement is not evidence the page finished loading.
- **Timeout or cancellation:** an action may already have happened. Reconnect (and re-share only in manual mode), then inspect before retrying anything consequential.
- **Protected pages:** Chromium/Arc settings, extension pages, browser UI, and some restricted stores cannot be automated through this tool.
- **Frames/shadow roots:** DOM snapshots cover the top document and supported open shadow roots, not every embedded frame or closed shadow root. Use screenshots and coordinates where appropriate. Typing into an iframe is refused when the companion cannot safely inspect the focused input; handle it manually. Some pages still require manual work.
- **Manual only:** passwords, MFA, CAPTCHAs, native dialogs, file pickers/uploads, and browser permission prompts. No CAPTCHA bypass or bot-detection evasion.
- **Arc compatibility:** Arc exposes Chromium APIs but may differ from Chrome. Actual Arc pairing and website interaction require a manual smoke test on your installed version.
- **No images:** use a vision-capable model and make sure Pi's `images.blockImages` is not enabled.

## Development and verification

```sh
npm test
npm run check
```

The test suite checks bridge authentication/origin rejection, serialized requests, cancellation/timeouts, protocol validation, approval races, and companion behavior using mocks where available. The Pi-loader smoke test uses the installed Pi runtime at the Homebrew path or `PI_EXTENSION_LOADER`; it skips on machines without that runtime.

An additional **real Chromium extension smoke test** runs in a throwaway profile against a harmless local fixture. It covers follow-active and manual access, pairing, typing/clearing, clicks, selects, screenshots, scrolling, navigation, open/close, password refusal, stale/offscreen/obscured targets, focus traps, background-tab refusal, and disconnection. It never opens your Arc profile:

```sh
PI_BROWSER_CHROMIUM="/path/to/Chromium/executable" npm run test:browser
```

`playwright-core` is a development dependency; the browser executable must already be installed. Without that environment variable, the browser smoke test skips. Chromium testing does not substitute for a live Arc smoke test.

Manual smoke test: share a non-sensitive test page; list tabs; snapshot; type in a harmless input; click a harmless button; scroll; screenshot; then disconnect and verify further requests fail. Check an unshared tab cannot be inspected. Use only a local/test form, not a live purchase or message submission.

## Uninstall

```sh
pi remove ~/Desktop/pi-arc-browser
```

Remove the Pi Arc Browser companion in Arc's extensions page, run `/reload` in Pi, and remove the source folder if no longer needed.

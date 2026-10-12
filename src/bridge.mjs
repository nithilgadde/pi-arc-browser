import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_PAYLOAD = 16 * 1024 * 1024;

/** A per-session, loopback-only bridge. No HTTP API and no action retries. */
export class BrowserBridge {
  constructor({ timeoutMs = 30_000, authTimeoutMs = 5_000, onStatus = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.authTimeoutMs = authTimeoutMs;
    this.onStatus = onStatus;
    this.token = randomBytes(32).toString('hex');
    this.pending = new Map();
    this.sockets = new Set();
    this.tail = Promise.resolve();
    this.epoch = 0;
  }

  get connected() { return this.client?.readyState === WebSocket.OPEN; }
  get status() { return { running: !!this.port, connected: !!this.connected, port: this.port ?? null }; }
  get pairing() {
    if (!this.port) throw new Error('Bridge is not running. Run /browser start.');
    return { port: this.port, token: this.token };
  }

  async start() {
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async _start() {
    this.token = randomBytes(32).toString('hex');
    this.server = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not found');
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (req, socket, head) => {
      const host = `127.0.0.1:${this.port}`;
      if (req.url !== '/bridge' || req.headers.host !== host ||
          !EXTENSION_ORIGIN.test(req.headers.origin ?? '') || this.wss.clients.size >= 8) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._accept(ws));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    // Runtime errors should not crash Pi. Close and revoke the bridge instead.
    this.server.on('error', () => { void this.stop(); });
    this.onStatus(this.status);
  }

  _accept(ws) {
    let authenticated = false;
    const timer = setTimeout(() => ws.close(1008, 'Authentication required'), this.authTimeoutMs);
    timer.unref();
    ws.on('error', () => {});
    ws.on('message', (bytes, isBinary) => {
      let msg;
      try {
        if (isBinary || (!authenticated && bytes.length > 1024)) throw new Error();
        msg = JSON.parse(bytes.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
      } catch { ws.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        const candidate = typeof msg.token === 'string' ? Buffer.from(msg.token) : Buffer.alloc(0);
        const expected = Buffer.from(this.token);
        if (msg.type !== 'auth' || candidate.length !== expected.length ||
            !timingSafeEqual(candidate, expected) || this.client) {
          ws.close(1008, 'Authentication rejected or bridge already paired');
          return;
        }
        clearTimeout(timer);
        authenticated = true;
        this.client = ws;
        this.epoch++;
        ws.send(JSON.stringify({ type: 'ready' }));
        this.onStatus(this.status);
        return;
      }
      if (ws !== this.client) return;
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type !== 'response' || typeof msg.id !== 'string') {
        ws.close(1008, 'Invalid response'); return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return; // Ignore late/unsolicited results, never execute requests.
      if (typeof msg.error === 'string') pending.reject(new Error(msg.error.slice(0, 2000)));
      else if (Object.hasOwn(msg, 'result')) pending.resolve(msg.result);
      else pending.reject(new Error('Companion returned a response without a result.'));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (this.client === ws) this._disconnect('Arc disconnected. Reconnect the companion; only manual access mode requires re-sharing.');
    });
  }

  _disconnect(reason) {
    const ws = this.client;
    this.client = undefined;
    this.epoch++;
    for (const request of [...this.pending.values()]) request.reject(new Error(reason));
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'Session ended');
    this.onStatus(this.status);
  }

  /** Serialize even if the model calls tools in parallel. Queued calls cannot survive reconnection. */
  request(action, params, signal) {
    const epoch = this.epoch;
    const run = this.tail.then(() => {
      if (signal?.aborted) throw new Error('Browser action cancelled before dispatch.');
      if (!this.connected || epoch !== this.epoch) throw new Error('Arc is not connected to this request session. Run /browser start and connect the companion. Follow active tab needs no Share click; only manual mode requires sharing.');
      return this._request(action, params, signal);
    });
    this.tail = run.catch(() => {});
    return run;
  }

  _request(action, params, signal) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const owner = this.client;
      const epoch = this.epoch;
      let timer;
      const settle = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        fn(value);
      };
      const cancel = (reason) => {
        if (!this.pending.has(id)) return;
        if (this.client !== owner || this.epoch !== epoch) {
          this.pending.get(id).reject(new Error('Browser connection changed; action outcome is unknown.'));
          return;
        }
        // A dispatched browser action may already have happened. Disconnect to revoke queued work.
        this._disconnect(`${reason} The action may have occurred; inspect before retrying. Reconnect to continue (re-share only in manual access mode).`);
      };
      const abort = () => cancel('Browser action cancelled.');
      this.pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      timer = setTimeout(() => cancel('Browser action timed out.'), this.timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.client.send(JSON.stringify({ type: 'request', id, action, params }), (error) => {
        if (error) cancel('Failed to send browser action.');
      });
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this._stop();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  async _stop() {
    if (this.starting) await this.starting.catch(() => {});
    this._disconnect('Browser bridge stopped.');
    this.token = randomBytes(32).toString('hex');
    const server = this.server;
    const wss = this.wss;
    this.server = undefined;
    this.wss = undefined;
    this.port = undefined;
    // terminate unauthenticated clients too; do not let ws close handshakes delay reload/shutdown.
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    this.onStatus(this.status);
  }
}

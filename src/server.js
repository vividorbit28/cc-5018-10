import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, normalized);
  return full.startsWith(root) ? full : null;
}

export class Server {
  constructor({ config, engine, encoder, publicDir, outDir }) {
    this.config = config;
    this.engine = engine;
    this.encoder = encoder;
    this.publicDir = publicDir;
    this.outDir = outDir;
    this.http = null;
    this.wss = null;
    this.sockets = new Set();
    this.streamRates = new Map();
    this.streamSizes = new Map();
    this.boundary = 'showcontrolframe';
    this.audioClients = new Set();
    this.startedAt = Date.now();
  }

  async start() {
    this.http = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws) => this.onSocket(ws));
    this.wireEngine();
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.config.httpPort, this.config.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  wireEngine() {
    this.engine.on('state', (state) => this.broadcast({ type: 'state', state }));
    this.engine.on('program-frame', (jpeg) => {
      this.broadcastFrame('program', jpeg);
    });
    this.engine.on('preview-frame', (jpeg) => {
      this.broadcastFrame('preview', jpeg);
    });
    this.engine.on('take-result', (result) => this.broadcast({ type: 'take-result', result }));
    this.engine.on('decision', (entry) => this.broadcast({ type: 'decision', entry }));
    this.engine.on('warning', (entry) => this.broadcast({ type: 'warning', entry }));
    // Preview audio is proxied through the encoder's MP3 monitor stream; source
    // audition audio is taken from the ingest preview pipe.
    this.engine.on('program-audio', (chunk) => this.pushAudio('program', chunk));
  }

  pushAudio(kind, chunk) {
    if (kind !== 'program') return;
    for (const res of this.audioClients) {
      if (res.writableEnded || res.writableLength > 512 * 1024) continue;
      res.write(chunk);
    }
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  broadcastFrame(kind, jpeg) {
    const header = Buffer.from(`${JSON.stringify({ type: 'frame', kind, at: Date.now() })}\n`);
    for (const ws of this.wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws._frameKind !== kind) continue;
      if (ws.bufferedAmount > 1024 * 1024) continue;
      ws.send(header);
      ws.send(jpeg);
    }
  }

  onSocket(ws) {
    ws._frameKind = null;
    ws.send(JSON.stringify({ type: 'hello', state: this.engine.state() }));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(ws, msg);
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
    });
    this.sockets.add(ws);
  }

  handleMessage(ws, msg) {
    switch (msg.type) {
      case 'subscribe': {
        ws._frameKind = msg.kind === 'preview' ? 'preview' : 'program';
        break;
      }
      case 'preview': {
        const result = this.engine.setPreview(msg.source);
        ws.send(JSON.stringify({ type: 'command-result', command: 'preview', result }));
        break;
      }
      case 'take': {
        const result = this.engine.requestTake(msg.source);
        ws.send(JSON.stringify({ type: 'command-result', command: 'take', result }));
        if (!result.ok) this.engine.emit('take-result', { ok: false, ...result });
        break;
      }
      case 'reconnect': {
        const result = this.engine.reconnectSource(msg.source);
        ws.send(JSON.stringify({ type: 'command-result', command: 'reconnect', result }));
        break;
      }
      case 'stall': {
        const result = this.engine.simulateStall(msg.source, msg.ms || 1500);
        ws.send(JSON.stringify({ type: 'command-result', command: 'stall', result }));
        break;
      }
      case 'state': {
        ws.send(JSON.stringify({ type: 'state', state: this.engine.state() }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: `unknown message ${msg.type}` }));
    }
  }

  handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/state') {
      return json(res, this.engine.state());
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, { ok: true, uptimeMs: Date.now() - this.startedAt, encoder: this.encoder.snapshot() });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      return json(res, { error: 'not found' }, 404);
    }

    if (req.method === 'GET' && pathname === '/stream/program.mjpg') {
      return this.multipartStream(res, () => this.encoder.monitorJpeg);
    }
    if (req.method === 'GET' && pathname === '/stream/preview.mjpg') {
      return this.multipartStream(res, () => this.engine.previewMonitor?.jpeg || null);
    }
    const sourceFrame = /^\/stream\/source\/([\x41-\x5a\x61-\x7a0-9_-]+)\.mjpg$/.exec(pathname);
    if (req.method === 'GET' && sourceFrame) {
      const id = sourceFrame[1];
      return this.multipartStream(res, () => (this.engine.previews.get(id) || {}).jpeg || null);
    }
    if (req.method === 'GET' && pathname === '/audio/program.mp3') {
      return this.loopAudio(res, 'program');
    }

    if (req.method === 'GET' && pathname.startsWith('/hls/')) {
      const file = safeJoin(path.join(this.outDir, 'hls'), pathname.slice('/hls'.length));
      return file ? this.sendFile(res, file, { cache: false }) : notFound(res);
    }
    if (req.method === 'GET' && pathname === '/archive/program.ts') {
      return this.sendFile(res, path.join(this.outDir, 'program.ts'), { cache: false });
    }
    if (req.method === 'GET' && pathname.startsWith('/vendor/hls.js')) {
      return this.sendFile(res, path.join(this.config.root, 'node_modules/hls.js/dist/hls.min.js'), { cache: true });
    }
    if (req.method === 'GET' && pathname.startsWith('/media/')) {
      const file = safeJoin(path.join(this.config.root, 'media'), pathname.slice('/media'.length));
      return file ? this.sendFile(res, file, { cache: true }) : notFound(res);
    }

    const publicFile = safeJoin(this.publicDir, pathname === '/' ? '/index.html' : pathname);
    if (publicFile) return this.sendFile(res, publicFile, { cache: false });
    return notFound(res);
  }

  multipartStream(res, getJpeg) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${this.boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'close',
      Pragma: 'no-cache'
    });
    let closed = false;
    const timer = setInterval(() => {
      if (closed) return;
      const jpeg = getJpeg();
      if (!jpeg) return;
      if (res.writableLength > 512 * 1024) return;
      res.write(`--${this.boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    }, 100);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  }

  loopAudio(res, kind) {
    if (kind !== 'program') return notFound(res);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'close'
    });
    this.audioClients.add(res);
    res.on('close', () => this.audioClients.delete(res));
  }

  sendFile(res, file, { cache }) {
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) return notFound(res);
      const ext = path.extname(file);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cache ? 'public, max-age=86400' : 'no-store'
      };
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  }

  async stop() {
    for (const ws of this.wss?.clients || []) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (this.wss) this.wss.close();
    if (this.http) await new Promise((resolve) => this.http.close(resolve));
  }
}

function json(res, value, code = 200) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

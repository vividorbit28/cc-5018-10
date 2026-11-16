import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { rgbaToI420Into } from './compositor.js';
import { timecodeFromFrames } from './util.js';

// Each input is a separate generator with its own frame rate, raster, audio
// sample rate and clock. Video frames are rendered in Node (so counters and
// timecode are real per-frame values rather than an ffmpeg expression), paced at
// the source's native rate, then encoded to MPEG-TS with its own audio tone.
//
// `ppm` skews that generator's timeline against the switcher's wall clock so the
// synchroniser is exercised with genuinely independent clocks.
export class SourceSimulator extends EventEmitter {
  constructor(source, { ffmpeg }) {
    super();
    this.source = source;
    this.ffmpeg = ffmpeg;
    this.server = null;
    this.encoder = null;
    this.socket = null;
    this.restartTimer = null;
    this.stopped = true;
    this.status = 'offline';
    this.startedAt = 0;
    this.stallUntil = 0;
    this.logTail = [];
    this.frameIndex = 0;
    this.frameLog = [];
    this._renderer = null;
    this._timer = null;
  }

  get url() {
    return `tcp://127.0.0.1:${this.source.port}`;
  }

  async start() {
    if (this.server) return;
    this.stopped = false;
    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.attach(socket));
      server.once('error', reject);
      server.listen(this.source.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.setStatus('waiting');
        resolve();
      });
    });
    this.server.on('error', (error) => this.emit('warning', error.message));
  }

  attach(socket) {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.socket = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopEncoder();
      this.setStatus(this.stopped ? 'offline' : 'waiting');
    });
    this.restartTimer = setTimeout(() => {
      if (this.socket === socket) this.startEncoder();
    }, 80);
  }

  driftFactor() {
    return 1 + this.source.ppm / 1_000_000;
  }

  buildRenderer() {
    const s = this.source;
    const canvas = createCanvas(s.width, s.height);
    const ctx = canvas.getContext('2d');
    const frameBytes = s.width * s.height * 3 / 2;
    return {
      width: s.width,
      height: s.height,
      canvas,
      ctx,
      rgba: Buffer.alloc(s.width * s.height * 4),
      yuv: Buffer.alloc(frameBytes),
      frameBytes
    };
  }

  // Draws one source-native frame. Counters are drawn from the generator's own
  // frame index and PTS, so what the operator sees in preview is exactly what
  // the synchroniser receives.
  renderFrame(index, ptsSeconds) {
    if (!this._renderer) this._renderer = this.buildRenderer();
    const r = this._renderer;
    const s = this.source;
    const { ctx: g, width: w, height: h } = r;

    g.fillStyle = s.background;
    g.fillRect(0, 0, w, h);

    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += Math.max(24, Math.round(w / 12))) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y < h; y += Math.max(24, Math.round(h / 8))) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }

    g.fillStyle = s.accent;
    g.fillRect(0, 0, w, Math.max(4, Math.round(h * 0.014)));

    // Moving bar quantised to the source's own frame index: a visual check that
    // output frames advance in order even when the source is repeated/dropped.
    const barW = Math.round(w * 0.20);
    const barX = Math.round(((index % 50) / 50) * (w + barW)) - barW;
    g.fillStyle = `${s.accent}bf`;
    g.fillRect(barX, Math.round(h * 0.86), barW, Math.round(h * 0.08));

    g.fillStyle = s.accent;
    g.fillRect(0, 0, Math.round(w * 0.10), Math.round(h * 0.16));

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(h * 0.10)}px "DejaVu Sans"`;
    g.fillText(s.label, Math.round(w * 0.04), Math.round(h * 0.36));

    g.fillStyle = '#d7e6f7';
    g.font = `bold ${Math.round(h * 0.045)}px "DejaVu Sans"`;
    g.fillText(
      `${w}x${h}  ${s.fps}fps  ${s.sampleRate}Hz`,
      Math.round(w * 0.04),
      Math.round(h * 0.44)
    );

    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(h * 0.13)}px "DejaVu Sans Mono"`;
    g.fillText(`FRAME ${String(index).padStart(7, '0')}`, Math.round(w * 0.04), Math.round(h * 0.60));

    g.fillStyle = '#ffd166';
    g.font = `bold ${Math.round(h * 0.07)}px "DejaVu Sans Mono"`;
    g.fillText(timecodeFromFrames(index, s.fps), Math.round(w * 0.04), Math.round(h * 0.70));

    g.fillStyle = '#9db4c9';
    g.font = `${Math.round(h * 0.045)}px "DejaVu Sans Mono"`;
    g.fillText(`PTS ${ptsSeconds.toFixed(3)}s`, Math.round(w * 0.04), Math.round(h * 0.77));

    g.fillStyle = s.accent;
    g.font = `bold ${Math.round(h * 0.05)}px "DejaVu Sans"`;
    g.fillText(
      `${s.tone} Hz  PPM ${s.ppm >= 0 ? '+' : ''}${s.ppm}`,
      Math.round(w * 0.04),
      Math.round(h * 0.84)
    );

    r.rgba.set(g.getImageData(0, 0, w, h).data);
    rgbaToI420Into(r.rgba, w, h, r.yuv);
    return r.yuv;
  }

  startEncoder() {
    this.stopEncoder();
    if (!this.socket || this.socket.destroyed) return;
    const s = this.source;
    const raster = { width: s.width, height: s.height };
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'warning',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${raster.width}x${raster.height}`,
      '-r', String(s.fps), '-i', 'pipe:3',
      // Not -re: audio is slaved to the muxer, which is itself paced by the
      // video pipe. With a drift factor both media advance together, which is
      // what a source whose clock runs fast actually looks like.
      '-f', 'lavfi', '-i', `sine=frequency=${s.tone}:sample_rate=${s.sampleRate}`,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-g', String(s.fps), '-keyint_min', String(s.fps),
      '-sc_threshold', '0', '-b:v', s.bitrate, '-maxrate', s.bitrate, '-bufsize', '2400k',
      '-c:a', 'aac', '-b:a', '128k', '-ar', String(s.sampleRate), '-ac', '2',
      '-af', 'volume=0.16',
      '-max_muxing_queue_size', '1024',
      '-f', 'mpegts', '-muxdelay', '0.03', '-muxpreload', '0.03', 'pipe:1'
    ];
    const encoder = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    this.encoder = encoder;
    this.startedAt = Date.now();
    this.frameIndex = 0;
    this.logTail = [];

    encoder.stdout.on('data', (chunk) => {
      if (Date.now() < this.stallUntil) return;
      if (this.socket && !this.socket.destroyed) this.socket.write(chunk);
    });
    encoder.stdio[3].on('error', () => {});
    let tail = '';
    encoder.stderr.on('data', (chunk) => {
      tail += chunk.toString();
      const rows = tail.split('\n');
      tail = rows.pop() || '';
      for (const row of rows) {
        if (!row.trim()) continue;
        this.logTail.push(row);
        if (this.logTail.length > 24) this.logTail.shift();
        if (/error|invalid|refused|failed/i.test(row)) this.emit('warning', row.trim());
      }
    });
    encoder.on('exit', (code) => {
      if (this.encoder === encoder) this.encoder = null;
      if (!this.stopped && code !== 0) this.emit('warning', `generator ${s.id} exited (${code})`);
    });

    this.startPacing();
    this.setStatus('feeding');
  }

  // Paces rendered frames from the generator's own clock. A positive PPM makes
  // the generator's clock run ahead of wall time, so it produces more frames per
  // wall second (and its PTS leads). A negative PPM starves it. The switcher must
  // reconcile that on its own program timeline.
  startPacing() {
    if (this._timer) clearInterval(this._timer);
    const s = this.source;
    const factor = this.driftFactor();
    const startWall = Date.now();
    this.frameIndex = 0;
    this._timer = setInterval(() => {
      const enc = this.encoder;
      if (!enc || !enc.stdio[3] || enc.stdio[3].destroyed) return;
      // Bound the socket queue: if the ingest is behind, stop rendering rather
      // than growing an unbounded in-process backlog.
      if (this.socket && this.socket.writableLength > 4 * 1024 * 1024) return;
      const elapsed = ((Date.now() - startWall) / 1000) * factor;
      const due = Math.floor(elapsed * s.fps);
      // Bound catch-up so a GC pause cannot dump hundreds of frames at once.
      let guard = 0;
      while (this.frameIndex < due && guard < 3) {
        const pts = this.frameIndex / s.fps;
        const yuv = this.renderFrame(this.frameIndex, pts);
        this.frameIndex += 1;
        guard += 1;
        if (!enc.stdio[3].write(Buffer.from(yuv))) {
          // Encoder is behind; leave the rest for the next tick.
          break;
        }
      }
    }, Math.max(4, Math.round(1000 / (s.fps * 2))));
  }

  stopEncoder() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.encoder) {
      const encoder = this.encoder;
      this.encoder = null;
      try {
        encoder.stdio[3]?.end();
      } catch {
        // ignore
      }
      try {
        encoder.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  // Test hook: stop forwarding the transport stream for `ms`, imitating a source
  // that falls behind. The generator keeps running so the backlog is real when
  // forwarding resumes (though frames generated during the stall are dropped by
  // this simulator unless buffered by the OS; the switcher still sees a gap).
  stall(ms) {
    this.stallUntil = Date.now() + ms;
    return this.stallUntil;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  snapshot() {
    return {
      id: this.source.id,
      label: this.source.label,
      status: this.status,
      url: this.url,
      generatedFrames: this.frameIndex,
      native: {
        width: this.source.width,
        height: this.source.height,
        fps: this.source.fps,
        sampleRate: this.source.sampleRate,
        tone: this.source.tone,
        ppm: this.source.ppm
      },
      log: this.logTail.slice(-4)
    };
  }

  async stop() {
    this.stopped = true;
    this.stopEncoder();
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    this.setStatus('offline');
  }
}

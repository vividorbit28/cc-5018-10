import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FramecrcParser } from './framecrc.js';

// Pulls one independent input and de-interleaves it into:
//   fd3 raw yuv420p at the program raster (one frame per source frame)
//   fd4 framecrc rows for exactly those frames (source PTS preserved)
//   fd5 raw s16le stereo at the program sample rate
//   fd6 framecrc rows for fixed-size audio blocks (source PTS preserved)
//   fd7 MJPEG preview for the multiview
//   fd8 MP3 preview audio
//
// Video and audio are each paired with their own timing rows. The switcher, not
// the decoder, decides how those source timestamps map onto program time.
export class SourceIngest extends EventEmitter {
  constructor(source, { ffmpeg, raster, audioRate, audioBlockSamples, preview }) {
    super();
    this.source = source;
    this.ffmpeg = ffmpeg;
    this.raster = raster;
    this.audioRate = audioRate;
    this.audioBlockSamples = audioBlockSamples;
    this.preview = preview;
    this.proc = null;
    this.session = 0;
    this.state = 'idle';
    this.videoMetaQueue = [];
    this.audioMetaQueue = [];
    this.videoCarry = Buffer.alloc(0);
    this.audioCarry = Buffer.alloc(0);
    this.previewCarry = Buffer.alloc(0);
    this.pendingAudioBlocks = [];
    this.stats = {
      connectedAt: null,
      videoFrames: 0,
      audioBlocks: 0,
      previewFrames: 0,
      lastError: null
    };
    this.logTail = [];
  }

  get videoFrameBytes() {
    return this.raster.width * this.raster.height * 3 / 2;
  }

  get audioBlockBytes() {
    return this.audioBlockSamples * 4;
  }

  start() {
    if (this.proc) return;
    const { width, height } = this.raster;
    const sr = this.audioRate;
    const block = this.audioBlockSamples;
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
    const audioChain = `aformat=sample_fmts=s16:channel_layouts=stereo,aresample=${sr}:resampler=soxr:precision=28`;

    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'warning', '-copyts', '-nostats',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-probesize', '500000', '-analyzeduration', '1000000',
      // Pace the decode to the input's own media clock. Without this the demuxer
      // drains a backlog as fast as the generator can fill the socket, so audio
      // and video arrive seconds "ahead" of the anchor and the queue bound then
      // trims almost everything. This bounds the buffer at the transport, which
      // is where it belongs.
      '-re',
      '-i', this.source.url,
      '-map', '0:v:0', '-an', '-vf', vf, '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:3',
      '-map', '0:v:0', '-an', '-vf', vf, '-fps_mode', 'passthrough',
      '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-f', 'framecrc', 'pipe:4',
      '-map', '0:a:0', '-vn', '-af', audioChain,
      '-f', 's16le', '-ar', String(sr), '-ac', '2', 'pipe:5',
      '-map', '0:a:0', '-vn',
      '-af', `${audioChain},asetnsamples=n=${block}:p=1`,
      '-c:a', 'pcm_s16le', '-f', 'framecrc', 'pipe:6',
      '-map', '0:v:0', '-an',
      '-vf', `${vf},scale=${this.preview.width}:${this.preview.height},fps=${this.preview.fps}`,
      '-c:v', 'mjpeg', '-q:v', '7', '-f', 'image2pipe', 'pipe:7',
      '-map', '0:a:0', '-vn', '-af', 'aresample=48000',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:8'
    ];
    this.session += 1;
    const session = this.session;
    const proc = spawn(this.ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    this.setState('connecting');
    this.stats.connectedAt = null;
    this.stats.lastError = null;
    this.videoMetaQueue = [];
    this.audioMetaQueue = [];
    this.videoCarry = Buffer.alloc(0);
    this.audioCarry = Buffer.alloc(0);
    this.previewCarry = Buffer.alloc(0);

    this.bindVideo(proc.stdio[3], session);
    this.bindAudio(proc.stdio[5], session);
    this.bindPreview(proc.stdio[7], session);
    this.bindMeta(proc.stdio[4], this.videoMetaQueue, 'video', session);
    this.bindMeta(proc.stdio[6], this.audioMetaQueue, 'audio', session);

    proc.stdio[8].on('data', (chunk) => {
      if (this.session !== session) return;
      this.emit('preview-audio', chunk);
    });
    for (let i = 3; i <= 8; i += 1) {
      if (proc.stdio[i]) proc.stdio[i].on('error', () => {});
    }

    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split('\n');
      stderrTail = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 30) this.logTail.shift();
        if (/error|failed|invalid|refused/i.test(line)) {
          this.stats.lastError = line.trim();
          this.emit('warning', line.trim());
        }
      }
    });
    proc.on('error', (error) => {
      this.stats.lastError = error.message;
      this.emit('warning', error.message);
    });
    proc.on('exit', (code, signal) => {
      if (this.session !== session) return;
      this.proc = null;
      const wasConnected = this.stats.connectedAt !== null;
      this.stats.connectedAt = null;
      this.setState(wasConnected ? 'reconnecting' : 'offline');
      this.emit('down', { code, signal });
    });
  }

  bindMeta(stream, queue, kind, session) {
    const parser = new FramecrcParser({
      onRow: (row) => {
        if (this.session !== session) return;
        queue.push(row);
        if (queue.length > 400) queue.shift();
        if (kind === 'audio') this.flushAudio(session);
      }
    });
    stream.on('data', (chunk) => {
      if (this.session !== session) return;
      parser.push(chunk);
    });
    stream.on('error', () => {});
  }

  bindVideo(stream, session) {
    stream.on('data', (chunk) => {
      if (this.session !== session) return;
      if (this.stats.connectedAt === null) this.markConnected();
      this.videoCarry = this.videoCarry.length ? Buffer.concat([this.videoCarry, chunk]) : chunk;
      const frameBytes = this.videoFrameBytes;
      let offset = 0;
      while (this.videoCarry.length - offset >= frameBytes) {
        const frame = this.videoCarry.subarray(offset, offset + frameBytes);
        offset += frameBytes;
        const meta = this.videoMetaQueue.shift();
        this.stats.videoFrames += 1;
        if (!meta) {
          // Metadata should arrive with or before the frame; drop an unlabelled
          // frame rather than assigning it invented timing.
          continue;
        }
        this.emit('video', {
          pts: meta.ptsTime,
          duration: meta.durationTime,
          data: Buffer.from(frame)
        });
      }
      this.videoCarry = this.videoCarry.length > offset
        ? Buffer.from(this.videoCarry.subarray(offset))
        : Buffer.alloc(0);
    });
    stream.on('error', () => {});
  }

  bindAudio(stream, session) {
    stream.on('data', (chunk) => {
      if (this.session !== session) return;
      if (this.stats.connectedAt === null) this.markConnected();
      this.audioCarry = this.audioCarry.length ? Buffer.concat([this.audioCarry, chunk]) : chunk;
      this.flushAudio(session);
    });
    stream.on('error', () => {});
  }

  flushAudio(session) {
    if (session !== this.session) return;
    const blockBytes = this.audioBlockBytes;
    let offset = 0;
    while (this.audioCarry.length - offset >= blockBytes) {
      const block = Buffer.from(this.audioCarry.subarray(offset, offset + blockBytes));
      offset += blockBytes;
      this.stats.audioBlocks += 1;
      this.pendingAudioBlocks.push(block);
    }
    this.audioCarry = this.audioCarry.length > offset
      ? Buffer.from(this.audioCarry.subarray(offset))
      : Buffer.alloc(0);

    while (this.pendingAudioBlocks.length && this.audioMetaQueue.length) {
      const block = this.pendingAudioBlocks.shift();
      const meta = this.audioMetaQueue.shift();
      this.emit('audio', { pts: meta.ptsTime, duration: meta.durationTime, data: block });
    }
    // Hard bound so a metadata hiccup cannot grow memory without limit.
    if (this.pendingAudioBlocks.length > 100) this.pendingAudioBlocks.shift();
  }

  bindPreview(stream, session) {
    stream.on('data', (chunk) => {
      if (this.session !== session) return;
      this.previewCarry = this.previewCarry.length ? Buffer.concat([this.previewCarry, chunk]) : chunk;
      const soi = Buffer.from([0xff, 0xd8]);
      const eoi = Buffer.from([0xff, 0xd9]);
      let start = this.previewCarry.indexOf(soi);
      while (start !== -1) {
        const end = this.previewCarry.indexOf(eoi, start + 2);
        if (end === -1) break;
        const jpeg = Buffer.from(this.previewCarry.subarray(start, end + 2));
        this.stats.previewFrames += 1;
        this.emit('preview', jpeg);
        start = this.previewCarry.indexOf(soi, end + 2);
      }
      if (start === -1) this.previewCarry = Buffer.alloc(0);
      else if (start > 0) this.previewCarry = Buffer.from(this.previewCarry.subarray(start));
      if (this.previewCarry.length > 4 * 1024 * 1024) this.previewCarry = Buffer.alloc(0);
    });
    stream.on('error', () => {});
  }

  markConnected() {
    this.stats.connectedAt = Date.now();
    this.setState('online');
    this.emit('online');
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  stop() {
    this.session += 1;
    const wasConnected = this.stats.connectedAt !== null;
    this.stats.connectedAt = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      this.videoMetaQueue = [];
      this.audioMetaQueue = [];
      this.pendingAudioBlocks = [];
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    // The exit handler is ignored for this session, so report the transition
    // here; otherwise a manual rebuild leaves the source marked connected.
    if (wasConnected) this.emit('down', { code: null, signal: 'rebuild' });
    this.setState('offline');
  }
}

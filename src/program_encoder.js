import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, rmrf } from './util.js';

// Encodes the composited program and fans it out from one encoder process:
//   fd5 MJPEG program monitor (multiview "on air" tile + browser monitor)
//   fd6 MP3 program monitor audio
//   HLS segments for network delivery
//   MPEG-TS archive for offline verification
// The program timeline is driven by the caller, so output frame order and audio
// sample counts advance monotonically regardless of input reconnects.
export class ProgramEncoder extends EventEmitter {
  constructor({ ffmpeg, output, outDir }) {
    super();
    this.ffmpeg = ffmpeg;
    this.output = output;
    this.outDir = outDir;
    this.hlsDir = path.join(outDir, 'hls');
    this.archivePath = path.join(outDir, 'program.ts');
    this.proc = null;
    this.running = false;
    this.stderr = [];
    this.framesIn = 0;
    this.audioBlocksIn = 0;
    this.startedAt = null;
    this.monitorJpeg = null;
    this.monitorJpegSeq = 0;
    this.monitorAudioSeq = 0;
    this.monitorAudioBytes = 0;
    this.carry = Buffer.alloc(0);
    this.lastFrameAt = null;
  }

  start() {
    if (this.proc) return;
    rmrf(this.outDir);
    ensureDir(this.hlsDir);
    const { width, height, fps, sampleRate } = this.output;
    const tee = [
      `[f=mpegts]/${trimSlash(this.archivePath)}`,
      `[f=hls:hls_time=${this.output.hlsSegment}:hls_list_size=${this.output.hlsListSize}` +
        `:hls_flags=delete_segments+independent_segments` +
        `:hls_segment_filename=/${trimSlash(this.hlsDir)}/seg_%05d.ts]/${trimSlash(this.hlsDir)}/index.m3u8`
    ].join('|');

    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`,
      '-r', String(fps), '-i', 'pipe:3',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:4',
      // Program encode: one encoder, two delivery sinks.
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', this.output.preset, '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-b:v', this.output.videoBitrate, '-maxrate', this.output.maxrate,
      '-bufsize', this.output.bufsize, '-max_delay', '0',
      '-c:a', 'aac', '-b:a', this.output.audioBitrate, '-ar', String(sampleRate),
      '-f', 'tee', '-use_fifo', '1', tee,
      // Browser monitor video.
      '-map', '0:v:0', '-an',
      '-vf', `scale=${this.output.monitorWidth}:${this.output.monitorHeight},fps=${this.output.monitorFps}`,
      '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:5',
      // Browser monitor audio.
      '-map', '1:a:0', '-vn',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-ar', String(sampleRate), '-f', 'mp3', 'pipe:6'
    ];
    const proc = spawn(this.ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    this.running = true;
    this.startedAt = Date.now();
    this.stderr = [];

    for (const stream of [proc.stdio[3], proc.stdio[4]]) {
      if (stream) stream.on('error', () => {});
    }
    proc.stdio[3].on('drain', () => this.emit('drain'));
    proc.stdio[4].on('drain', () => this.emit('drain'));

    const jpeg = proc.stdio[5];
    let carry = Buffer.alloc(0);
    const soi = Buffer.from([0xff, 0xd8]);
    const eoi = Buffer.from([0xff, 0xd9]);
    jpeg.on('data', (chunk) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = carry.indexOf(soi);
      while (start !== -1) {
        const end = carry.indexOf(eoi, start + 2);
        if (end === -1) break;
        this.monitorJpeg = Buffer.from(carry.subarray(start, end + 2));
        this.monitorJpegSeq += 1;
        this.emit('monitor-frame', this.monitorJpeg);
        start = carry.indexOf(soi, end + 2);
      }
      if (start === -1) carry = Buffer.alloc(0);
      else if (start > 0) carry = Buffer.from(carry.subarray(start));
      if (carry.length > 8 * 1024 * 1024) carry = Buffer.alloc(0);
    });
    jpeg.on('error', () => {});
    proc.stdio[6].on('data', (chunk) => {
      this.monitorAudioBytes += chunk.length;
      this.monitorAudioSeq += 1;
      this.emit('monitor-audio', chunk);
    });
    proc.stdio[6].on('error', () => {});

    let tail = '';
    proc.stderr.on('data', (chunk) => {
      tail += chunk.toString();
      const rows = tail.split('\n');
      tail = rows.pop() || '';
      for (const row of rows) {
        if (!row.trim()) continue;
        this.stderr.push(row);
        if (this.stderr.length > 80) this.stderr.shift();
        if (/error|failed|invalid|dropped/i.test(row)) this.emit('warning', row.trim());
      }
    });

    proc.on('error', (error) => this.emit('warning', error.message));
    proc.on('exit', (code, signal) => {
      this.running = false;
      this.proc = null;
      this.emit('exit', { code, signal });
    });
  }

  writeVideo(frame) {
    if (!this.proc) return false;
    this.framesIn += 1;
    this.lastFrameAt = Date.now();
    return this.proc.stdio[3].write(frame);
  }

  writeAudio(samples) {
    if (!this.proc) return false;
    this.audioBlocksIn += 1;
    return this.proc.stdio[4].write(samples);
  }

  snapshot() {
    return {
      running: this.running,
      framesIn: this.framesIn,
      audioBlocksIn: this.audioBlocksIn,
      startedAt: this.startedAt,
      hlsUrl: '/hls/index.m3u8',
      archiveUrl: '/archive/program.ts',
      monitorJpegSeq: this.monitorJpegSeq,
      warnings: this.stderr.slice(-3)
    };
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    if (proc.stdio[3]) proc.stdio[3].end();
    if (proc.stdio[4]) proc.stdio[4].end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function trimSlash(p) {
  return p.replace(/^\/+/, '');
}

export function archiveSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

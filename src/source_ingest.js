import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FramecrcParser } from './framecrc.js';
import {
  DECODE_ADAPTER_VERSION,
  DECODE_PIPES,
  DecodeAdapterError,
  decodeArgs,
  planContract,
  resolveDecodePlan
} from './decode_adapter.js';

// Pulls one independent input through the versioned decode adapter and
// de-interleaves the pipes into typed events:
//   video      raw frames in the plan's pixel format (one per source frame)
//   audio      fixed-size blocks at the plan's output sample rate
// Both carry the source timestamp read from their own framecrc pipe, converted
// through the time base the adapter declared. The switcher, not the decoder,
// decides how those timestamps map onto program time.
//
// End of stream: ffmpeg signals EOF, then any frames still held by the decoder
// are flushed and written before the process exits. We stop accepting new data
// on `drain`, call parser.flush() to recover a final row without a newline, and
// report `ended` only after every pipe has closed.
export class SourceIngest extends EventEmitter {
  constructor(source, options) {
    super();
    this.source = source;
    this.plan = resolveDecodePlan(source, options);
    this.raster = this.plan.raster;
    this.audioRate = this.plan.audio.sampleRate;
    this.audioBlockSamples = this.plan.audio.blockSamples;
    this.preview = this.plan.preview;
    this.ffmpeg = options.ffmpeg || null;
    if (!this.ffmpeg) {
      throw new DecodeAdapterError('DECODE_FFMPEG_UNAVAILABLE', `source ${source.id} has no ffmpeg executable`, {
        field: 'ffmpeg'
      });
    }
    this.proc = null;
    this.session = 0;
    this.state = 'idle';
    this.videoMetaQueue = [];
    this.audioMetaQueue = [];
    this.videoCarry = Buffer.alloc(0);
    this.audioCarry = Buffer.alloc(0);
    this.previewCarry = Buffer.alloc(0);
    this.pendingVideoFrames = [];
    this.pendingAudioBlocks = [];
    this.parsers = new Map();
    this.drained = false;
    this.videoTimeBase = null;
    this.audioTimeBase = null;
    this.timeBaseMismatch = null;
    this.stats = {
      connectedAt: null,
      videoFrames: 0,
      audioBlocks: 0,
      previewFrames: 0,
      videoMetaRows: 0,
      audioMetaRows: 0,
      videoFramesWithoutMeta: 0,
      audioBlocksWithoutMeta: 0,
      videoMetaRowsWithoutFrame: 0,
      audioMetaRowsWithoutFrame: 0,
      timeBaseErrors: 0,
      drainFlushed: 0,
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

  contract() {
    return planContract(this.plan);
  }

  start() {
    if (this.proc) return;
    const plan = this.plan;

    this.session += 1;
    const session = this.session;
    const proc = spawn(this.ffmpeg, decodeArgs(plan), {
      stdio: [
        'ignore', // fd0 stdin
        'ignore', // fd1 stdout
        'pipe', // fd2 stderr
        'pipe', // fd3 video
        'pipe', // fd4 video meta
        'pipe', // fd5 audio
        'pipe', // fd6 audio meta
        'pipe', // fd7 preview jpeg
        'pipe' // fd8 preview audio
      ]
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
    this.pendingVideoFrames = [];
    this.pendingAudioBlocks = [];
    this.parsers = new Map();
    this.drained = false;
    this.videoTimeBase = null;
    this.audioTimeBase = null;
    this.timeBaseMismatch = null;

    this.bindVideo(proc.stdio[DECODE_PIPES.video], session);
    this.bindAudio(proc.stdio[DECODE_PIPES.audio], session);
    this.bindPreview(proc.stdio[DECODE_PIPES.preview], session);
    this.bindMeta(proc.stdio[DECODE_PIPES.videoMeta], this.videoMetaQueue, 'video', session);
    this.bindMeta(proc.stdio[DECODE_PIPES.audioMeta], this.audioMetaQueue, 'audio', session);

    proc.stdio[DECODE_PIPES.previewAudio].on('data', (chunk) => {
      if (this.session !== session) return;
      this.emit('preview-audio', chunk);
    });
    for (let fd = DECODE_PIPES.video; fd <= DECODE_PIPES.previewAudio; fd += 1) {
      if (proc.stdio[fd]) proc.stdio[fd].on('error', () => {});
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
    proc.on('close', (code, signal) => {
      if (this.session !== session) return;
      // A finite input ends on its own. `close` (not `exit`) is used because it
      // fires only after every stdio pipe has delivered its final bytes: the
      // payload pipes drain before the process is reaped, so the last frame and
      // its framecrc row are both in hand when the queues are reconciled.
      this.finalizeStreams(session);
      this.proc = null;
      const wasConnected = this.stats.connectedAt !== null;
      this.stats.connectedAt = null;
      const ended = this.drained && code === 0;
      this.setState(ended ? 'ended' : wasConnected ? 'reconnecting' : 'offline');
      this.emit('down', { code, signal, reason: ended ? 'eof' : 'transport' });
    });
  }

  finalizeStreams(session) {
    if (session !== this.session) return;
    this.drained = true;
    for (const [kind, parser] of this.parsers) {
      parser.flush();
      const flushed = parser.rowCount + parser.errorCount;
      if (kind === 'video' && parser.timeBase) this.videoTimeBase = parser.timeBase;
      if (kind === 'audio' && parser.timeBase) this.audioTimeBase = parser.timeBase;
      if (flushed > 0) this.stats.drainFlushed += 1;
      if (parser.errorCount > 0) {
        this.stats.timeBaseErrors += parser.errorCount;
        this.emit('warning', `${kind} timestamps: ${parser.lastError}`);
      }
    }
    // Reconcile both directions once no more data can arrive. A payload with no
    // timestamp cannot be placed in program time, so it stays visible as
    // unlabelled instead of being given an invented one; a timestamp with no
    // payload is reported separately, since that is a lost frame, not a lost
    // timestamp.
    if (this.pendingVideoFrames.length) this.stats.videoFramesWithoutMeta += this.pendingVideoFrames.length;
    if (this.pendingAudioBlocks.length) this.stats.audioBlocksWithoutMeta += this.pendingAudioBlocks.length;
    this.stats.videoMetaRowsWithoutFrame += this.videoMetaQueue.length;
    this.stats.audioMetaRowsWithoutFrame += this.audioMetaQueue.length;
    this.emit('drained', this.drainEvidence());
  }

  drainEvidence() {
    return {
      adapterVersion: this.plan.adapterVersion,
      drainMode: this.plan.drain.mode,
      flushedParsers: this.stats.drainFlushed,
      videoTimeBase: this.videoTimeBase ? `${this.videoTimeBase.num}/${this.videoTimeBase.den}` : null,
      audioTimeBase: this.audioTimeBase ? `${this.audioTimeBase.num}/${this.audioTimeBase.den}` : null,
      timeBaseMismatch: this.timeBaseMismatch,
      videoFrames: this.stats.videoFrames,
      audioBlocks: this.stats.audioBlocks,
      videoMetaRows: this.stats.videoMetaRows,
      audioMetaRows: this.stats.audioMetaRows,
      videoFramesWithoutMeta: this.stats.videoFramesWithoutMeta,
      audioBlocksWithoutMeta: this.stats.audioBlocksWithoutMeta,
      videoMetaRowsWithoutFrame: this.stats.videoMetaRowsWithoutFrame,
      audioMetaRowsWithoutFrame: this.stats.audioMetaRowsWithoutFrame,
      timeBaseErrors: this.stats.timeBaseErrors
    };
  }

  bindMeta(stream, queue, kind, session) {
    const parser = new FramecrcParser({
      onRow: (row) => {
        if (this.session !== session) return;
        if (kind === 'video' && !this.videoTimeBase) this.videoTimeBase = row.timeBase;
        if (kind === 'audio' && !this.audioTimeBase) this.audioTimeBase = row.timeBase;
        // The plan states the time base the caller asked for; the source states
        // the one it actually delivered (a 24 fps file through a 25 fps plan is
        // legitimate). Every timestamp is converted with the source's own
        // rational time base, and a divergence from the plan is surfaced as
        // evidence instead of being silently reinterpreted or dropped.
        const expected = kind === 'video' ? this.plan.video.timeBase : this.plan.audio.timeBase;
        if (
          expected &&
          !this.timeBaseMismatch?.[kind] &&
          (row.timeBase.num !== expected.num || row.timeBase.den !== expected.den)
        ) {
          this.timeBaseMismatch = this.timeBaseMismatch || {};
          this.timeBaseMismatch[kind] = {
            expected: `${expected.num}/${expected.den}`,
            actual: `${row.timeBase.num}/${row.timeBase.den}`
          };
          this.emit(
            'warning',
            `${kind} time base ${row.timeBase.num}/${row.timeBase.den} differs from decode plan ` +
              `${expected.num}/${expected.den} (using the source's time base)`
          );
        }
        queue.push(row);
        if (queue.length > 400) queue.shift();
        if (kind === 'audio') this.flushAudio(session);
        else this.pairVideo(session);
      },
      onError: (message) => {
        if (this.session !== session) return;
        this.stats.timeBaseErrors += 1;
        this.emit('warning', `${kind} framecrc: ${message}`);
      }
    });
    this.parsers.set(kind, parser);
    stream.on('data', (chunk) => {
      if (this.session !== session) return;
      parser.push(chunk);
      if (kind === 'video') this.stats.videoMetaRows = parser.rowCount;
      else this.stats.audioMetaRows = parser.rowCount;
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
        this.pendingVideoFrames.push(Buffer.from(this.videoCarry.subarray(offset, offset + frameBytes)));
        offset += frameBytes;
      }
      this.videoCarry = this.videoCarry.length > offset
        ? Buffer.from(this.videoCarry.subarray(offset))
        : Buffer.alloc(0);
      // The payload pipe and the timestamp pipe are independent descriptors, so
      // either can be read first. Buffer whichever arrives early and pair when
      // both sides are present; never discard a frame for being ahead of its
      // timestamp.
      this.pairVideo(session);
    });
    stream.on('error', () => {});
  }

  pairVideo(session) {
    if (session !== this.session) return;
    while (this.pendingVideoFrames.length && this.videoMetaQueue.length) {
      const frame = this.pendingVideoFrames.shift();
      const meta = this.videoMetaQueue.shift();
      this.stats.videoFrames += 1;
      this.emit('video', {
        pts: meta.ptsTime,
        duration: meta.durationTime,
        data: frame,
        timeBase: meta.timeBase
      });
    }
    // Hard bound so a metadata hiccup cannot grow memory without limit.
    while (this.pendingVideoFrames.length > 100) {
      this.pendingVideoFrames.shift();
      this.stats.videoFramesWithoutMeta += 1;
    }
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
      this.emit('audio', {
        pts: meta.ptsTime,
        duration: meta.durationTime,
        data: block,
        timeBase: meta.timeBase
      });
    }
    // Hard bound so a metadata hiccup cannot grow memory without limit.
    while (this.pendingAudioBlocks.length > 100) {
      this.pendingAudioBlocks.shift();
      this.stats.audioBlocksWithoutMeta += 1;
    }
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
    if (wasConnected) this.emit('down', { code: null, signal: 'rebuild', reason: 'stop' });
    this.setState('offline');
  }

  snapshot() {
    return {
      adapterVersion: DECODE_ADAPTER_VERSION,
      contract: this.contract(),
      state: this.state,
      stats: { ...this.stats },
      drain: this.drainEvidence()
    };
  }
}

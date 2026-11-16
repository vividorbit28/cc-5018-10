import { EventEmitter } from 'node:events';
import { SyncSource } from './sync_source.js';
import { SourceIngest } from './source_ingest.js';
import { Compositor } from './compositor.js';
import { PreviewCompositor } from './preview_compositor.js';
import { AggregateLogger, RingLog, timecodeFromFrames } from './util.js';

class ProgramClock {
  constructor(fps) {
    this.fps = fps;
    this.sampleRate = 48000;
    this.frame = 0;
    this.sample = 0;
  }

  get pts() {
    return this.frame / this.fps;
  }
}

// The master control kernel. It owns the program clock, the per-source
// synchronisers and the take logic. Program media time advances one frame at a
// time; a take only changes which source is mapped onto that time at a frame
// boundary, so the output frame numbering and audio sample count never reset.
export class Engine extends EventEmitter {
  constructor({ config, ffmpeg, dataDir, now = () => Date.now() }) {
    super();
    this.config = config;
    this.ffmpeg = ffmpeg;
    this.dataDir = dataDir;
    this.now = now;
    this.outputConfig = config.output;
    this.samplesPerFrame = config.output.sampleRate / config.output.fps;
    if (!Number.isInteger(this.samplesPerFrame)) {
      throw new Error('OUT_SAMPLE_RATE must be an integer multiple of OUT_FPS');
    }
    this.clock = new ProgramClock(config.output.fps);
    this.syncer = new Map();
    this.ingests = new Map();
    this.previews = new Map();
    this.sourceFrameSeq = new Map();
    this.onAirId = null;
    this.previewId = config.sources[0]?.id || null;
    this.pendingTake = null;
    this.takeSeq = 0;
    this.takeLog = new RingLog({ limit: 300 });
    this.decisionLog = new RingLog({ limit: 400 });
    this.decisionAgg = new AggregateLogger({
      log: this.decisionLog,
      minIntervalMs: 1200,
      onEntry: (entry) => this.emit('decision', entry)
    });
    this.stateSeq = 0;
    this.programMonitor = { jpeg: null, seq: 0, at: 0 };
    this.programAudioSeq = 0;
    this.programAudioBytes = 0;
    this.lastTake = null;
    this.running = false;
    this.timer = null;
    this.startWall = 0;
    this.encoderLagMs = 0;
    this.warnings = [];
    this.restartTimers = new Map();
    this.slateCache = new Map();
    this.overlayState = { bufferLabel: 'BUF --', takeInfo: '' };
    this.lastPvwAt = 0;
    this.pvwInterval = 1000 / config.previewFps;
    this.encoder = null;
  }

  attachEncoder(encoder) {
    this.encoder = encoder;
    encoder.on('monitor-frame', (jpeg) => {
      this.programMonitor = { jpeg, seq: this.programMonitor.seq + 1, at: this.now() };
      this.emit('program-frame', jpeg);
    });
    encoder.on('monitor-audio', (chunk) => {
      this.programAudioBytes += chunk.length;
      this.programAudioSeq += 1;
      this.emit('program-audio', chunk);
    });
    encoder.on('warning', (line) => this.warn('encoder', line));
    encoder.on('exit', (info) => {
      if (this.running) this.warn('encoder', `program encoder exited (${info.code ?? info.signal})`);
    });
  }

  attachSources({ sources, simulatorFactory }) {
    this.simulators = new Map();
    for (const source of sources) {
      const sync = new SyncSource(source, {
        fps: this.outputConfig.fps,
        sampleRate: this.outputConfig.sampleRate,
        latencyMs: this.config.targetLatencyMs,
        lockSpanMs: this.config.lockSpanMs,
        maxVideoBufferMs: this.config.maxVideoBufferMs,
        maxAudioBufferMs: this.config.maxAudioBufferMs,
        clock: { now: () => this.clock.pts }
      });
      this.syncer.set(source.id, sync);
      const ingest = new SourceIngest(source, {
        ffmpeg: this.ffmpeg,
        raster: { width: this.outputConfig.width, height: this.outputConfig.height },
        audioRate: this.outputConfig.sampleRate,
        audioBlockSamples: this.config.ingestAudioBlock,
        preview: {
          fps: this.config.monitor.fps,
          width: this.config.monitor.width,
          height: this.config.monitor.height
        }
      });
      this.ingests.set(source.id, ingest);
      ingest.on('video', ({ pts, duration, data }) => {
        sync.onVideo({ pts, duration, data });
        this.sourceVideoAt.set(source.id, this.now());
      });
      ingest.on('audio', ({ pts, data }) => {
        sync.onAudio({ pts, data });
        this.sourceAudioAt.set(source.id, this.now());
      });
      ingest.on('preview', (jpeg) => {
        this.previews.set(source.id, { jpeg, at: this.now() });
        this.emit('source-frame', source.id, jpeg);
      });
      ingest.on('preview-audio', (chunk) => {
        if (this.previewId === source.id) this.emit('preview-audio', chunk);
      });
      ingest.on('online', () => {
        sync.setOnline(true);
        this.logDecision('source-locked', { source: source.id, note: 'transport online, acquiring timestamps' });
        this.emitStateNow();
      });
      ingest.on('down', ({ code, signal } = {}) => {
        sync.setOnline(false);
        this.logDecision('source-down', {
          source: source.id,
          note: `transport lost (${code ?? signal ?? '?'}); holding last frame, rebuilding input`
        });
        if (signal !== 'rebuild') this.scheduleIngestRestart(source.id);
        this.emitStateNow();
      });
      ingest.on('warning', (line) => this.warn(source.id, line));
    }
    for (const source of sources) {
      this.simulators.set(source.id, simulatorFactory(source));
    }
    this.sourceVideoAt = new Map();
    this.sourceAudioAt = new Map();
  }

  get compositor() {
    if (!this._compositor) {
      this._compositor = new Compositor({
        width: this.outputConfig.width,
        height: this.outputConfig.height,
        fps: this.outputConfig.fps
      });
      this._previewCompositor = new PreviewCompositor({
        width: this.config.monitor.width,
        height: this.config.monitor.height,
        fps: this.outputConfig.fps
      });
    }
    return this._compositor;
  }

  get previewCompositor() {
    if (!this._previewCompositor) this.compositor;
    return this._previewCompositor;
  }

  async startSources() {
    for (const [id, simulator] of this.simulators) {
      simulator.on('status', () => this.emitStateNow());
      simulator.on('warning', (line) => this.warn(id, line));
      await simulator.start();
      this.startIngest(id);
    }
  }

  startIngest(id) {
    const ingest = this.ingests.get(id);
    const sync = this.syncer.get(id);
    if (!ingest) return;
    this.logDecision('ingest-start', { source: id, session: ingest.session + 1 });
    ingest.start();
    sync.beginSession(ingest.session);
    this.emitStateNow();
  }

  scheduleIngestRestart(id) {
    if (!this.running || this.restartTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      if (!this.running) return;
      const ingest = this.ingests.get(id);
      // Rebuild only if it is still down; a reconnect may already have happened.
      if (ingest && ingest.state !== 'online') this.startIngest(id);
    }, 700);
    this.restartTimers.set(id, timer);
  }

  reconnectSource(id) {
    const simulator = this.simulators?.get(id);
    const ingest = this.ingests.get(id);
    if (!ingest) return { ok: false, code: 'unknown-source' };
    this.logDecision('ingest-restart', { source: id, note: 'operator requested input rebuild' });
    ingest.stop();
    if (simulator && simulator.socket) {
      try {
        simulator.socket.destroy();
      } catch {
        // ignore
      }
    }
    setTimeout(() => this.startIngest(id), 120);
    return { ok: true, scheduled: true };
  }

  simulateStall(id, ms = 1500) {
    const simulator = this.simulators?.get(id);
    if (!simulator) return { ok: false, code: 'unknown-source' };
    const until = simulator.stall(ms);
    this.logDecision('source-stall', { source: id, ms, note: 'simulated input stall' });
    this.emit('sources-changed');
    return { ok: true, until };
  }

  startTicker() {
    if (this.running) return;
    this.running = true;
    this.startWall = this.now() - (this.clock.frame / this.outputConfig.fps) * 1000;
    const frameMs = 1000 / this.outputConfig.fps;
    const schedule = () => {
      if (!this.running) return;
      const target = this.startWall + ((this.clock.frame + 1) / this.outputConfig.fps) * 1000;
      const delay = Math.max(0, Math.min(frameMs, target - this.now()));
      this.timer = setTimeout(() => {
        this.tick();
        schedule();
      }, delay);
    };
    schedule();
  }

  // Advances the program by at most `maxFrames` frames. Program frame numbers
  // are never skipped: when the encoder back-pressures, program time pauses
  // until it drains and the lag is reported instead of dropping frames.
  tick(maxFrames = 4) {
    if (!this.encoder || !this.encoder.running) return;
    const frameMs = 1000 / this.outputConfig.fps;
    let emitted = 0;
    while (emitted < maxFrames) {
      const nextAt = this.startWall + ((this.clock.frame + 1) * frameMs);
      if (this.now() < nextAt) break;
      this.emitProgramFrame();
      emitted += 1;
    }
    this.encoderLagMs = Math.max(0, this.now() - (this.startWall + this.clock.frame * frameMs));
    this.updatePreviewMonitor();
    this.emitStateThrottled();
  }

  emitProgramFrame() {
    const T = this.clock.pts;
    this.commitPendingTake(T);
    const onAir = this.onAirId ? this.syncer.get(this.onAirId) : null;
    let selection = onAir ? onAir.select(T) : { status: 'no-program', frame: null };
    let frameData = selection.frame ? selection.frame.data : null;

    let slateKey = null;
    if (!frameData) {
      const reason = this.onAirId ? selection.status : 'no-program';
      slateKey = `${reason}:${this.onAirId || 'none'}`;
      frameData = this.slateFrame(slateKey, {
        title: reason === 'no-program' ? 'NO PROGRAM' : 'SOURCE UNAVAILABLE',
        subtitle: this.onAirId ? this.labelFor(this.onAirId) : 'Select a source and press TAKE',
        detail: reason === 'no-program' ? 'Program clock is running' : `State: ${reason}`,
        accent: '#ff5f5f'
      });
    }

    const sourceConfig = this.onAirId ? this.sourceConfig(this.onAirId) : null;
    const leadMs = selection.leadMs;
    const counters = onAir ? onAir.counters : null;
    const overlay = {
      sourceLabel: sourceConfig ? sourceConfig.label : 'BLACK',
      role: sourceConfig ? sourceConfig.role : 'Program output',
      accent: sourceConfig ? sourceConfig.accent : '#7f97ad',
      frameIndex: this.clock.frame,
      programPts: T,
      audioLabel: onAir
        ? `${sourceConfig.label} · ${sourceConfig.tone} Hz · ${this.outputConfig.sampleRate / 1000} kHz`
        : 'MUTED · no source',
      onAir: true,
      takeInfo: this.lastTake
        ? `TAKE ${this.lastTake.seq} @ ${timecodeFromFrames(this.lastTake.programFrame, this.outputConfig.fps)}`
        : 'READY',
      bufferLabel: `BUF ${leadMs === null || leadMs === undefined ? '--' : `${Math.round(leadMs)}ms`} · ${counters ? counters.fills : 0}F/${counters ? counters.drops : 0}D/${counters ? counters.silenceEvents : 0}S`
    };
    if (selection.status === 'repeat' || selection.status === 'starved') {
      overlay.accent = '#ff9f43';
    }

    const composed = this.compositor.compose(frameData, overlay);
    this.encoder.writeVideo(composed);

    const audio = this.pullProgramAudio(T, onAir);
    this.encoder.writeAudio(audio.buffer);

    this.recordDecisions(onAir, selection, audio, T);

    this.clock.frame += 1;
    this.clock.sample += this.samplesPerFrame;
    this.emit('frame', {
      frame: this.clock.frame,
      sample: this.clock.sample,
      onAir: this.onAirId,
      selection: selection.status,
      audio: audio.status
    });
  }

  pullProgramAudio(T, onAir) {
    const count = this.samplesPerFrame;
    if (!onAir) {
      return { buffer: Buffer.alloc(count * 4, 0), status: 'silence', reason: 'no-program' };
    }
    return onAir.pullAudio(T, count);
  }

  recordDecisions(onAir, selection, audio, T) {
    if (!onAir) return;
    const now = this.now();
    const tc = timecodeFromFrames(this.clock.frame, this.outputConfig.fps);
    const last = onAir.counters;
    const prev = this._prevCounters?.get(onAir.id);
    if (prev) {
      if (last.drops > prev.drops) {
        const delta = last.drops - prev.drops;
        this.decisionAgg.note(`drop:${onAir.id}`, {
          kind: 'drop',
          source: onAir.id,
          label: this.labelFor(onAir.id),
          programFrame: this.clock.frame,
          programTc: tc,
          note: onAir.lastDecision && onAir.lastDecision.kind === 'rebase'
            ? 'input ahead of target latency: rebase dropped stale frames'
            : 'late or backwards frames dropped',
          frames: delta,
          amount: delta
        }, delta, now);
      }
      if (last.fills > prev.fills) {
        const delta = last.fills - prev.fills;
        this.decisionAgg.note(`fill:${onAir.id}`, {
          kind: 'fill',
          source: onAir.id,
          label: this.labelFor(onAir.id),
          programFrame: this.clock.frame,
          programTc: tc,
          note: onAir.online
            ? 'source late: repeated last frame for program time'
            : 'source offline: held last frame',
          frames: delta,
          amount: delta
        }, delta, now);
      }
      if (last.audioDrops > prev.audioDrops) {
        const delta = last.audioDrops - prev.audioDrops;
        this.decisionAgg.note(`audio-drop:${onAir.id}`, {
          kind: 'audio-drop',
          source: onAir.id,
          label: this.labelFor(onAir.id),
          programFrame: this.clock.frame,
          programTc: tc,
          note: 'audio resampled timeline re-aligned; samples discarded',
          samples: delta,
          amount: delta
        }, delta, now);
      }
      if (last.silenceEvents > prev.silenceEvents) {
        const delta = last.silenceSamples - prev.silenceSamples;
        this.decisionAgg.note(`audio-silence:${onAir.id}`, {
          kind: 'silence',
          source: onAir.id,
          label: this.labelFor(onAir.id),
          programFrame: this.clock.frame,
          programTc: tc,
          note: audio.status === 'silence'
            ? 'no source audio for program time: muted'
            : 'audio gap inside program block: muted the gap',
          samples: delta,
          amount: delta
        }, delta, now);
      }
    }
    if (!this._prevCounters) this._prevCounters = new Map();
    this._prevCounters.set(onAir.id, { ...last });
  }

  slateFrame(key, options) {
    if (!this.slateCache.has(key)) {
      const yuv = this.compositor.renderSlate(options);
      this.slateCache.set(key, yuv);
      if (this.slateCache.size > 6) this.slateCache.delete(this.slateCache.keys().next().value);
    }
    return this.slateCache.get(key);
  }

  sourceConfig(id) {
    return this.config.sources.find((s) => s.id === id) || null;
  }

  labelFor(id) {
    return this.sourceConfig(id)?.label || id;
  }

  setPreview(sourceId) {
    if (!this.syncer.has(sourceId)) {
      return { ok: false, code: 'unknown-source', message: `Unknown source ${sourceId}` };
    }
    this.previewId = sourceId;
    this.emitStateNow();
    return { ok: true, previewId: this.previewId };
  }

  requestTake(sourceId) {
    if (!this.syncer.has(sourceId)) {
      return this.rejectTake(sourceId, 'unknown-source', 'Unknown source');
    }
    if (this.onAirId === sourceId) {
      return this.rejectTake(sourceId, 'already-live', `${this.labelFor(sourceId)} is already on air`);
    }
    const sync = this.syncer.get(sourceId);
    if (!sync.online || !sync.locked) {
      // Accept the request but hold it until the source is usable; the deadline
      // produces explicit operator feedback instead of a silent no-op.
      const deadline = this.now() + this.config.takeTimeoutMs;
      this.pendingTake = {
        sourceId,
        requestedAt: this.now(),
        requestedFrame: this.clock.frame,
        requestedProgram: this.clock.pts,
        deadline,
        attempt: 0
      };
      this.emitStateNow();
      return {
        ok: true,
        pending: true,
        code: 'source-not-ready',
        message: `${this.labelFor(sourceId)} is locking; take will commit when it is ready`
      };
    }
    this.pendingTake = {
      sourceId,
      requestedAt: this.now(),
      requestedFrame: this.clock.frame,
      requestedProgram: this.clock.pts,
      deadline: this.now() + this.config.takeTimeoutMs,
      attempt: 0
    };
    this.emitStateNow();
    return { ok: true, pending: true, message: `TAKE queued for ${this.labelFor(sourceId)}` };
  }

  rejectTake(sourceId, code, message) {
    const record = this.takeLog.append({
      kind: 'rejected',
      source: sourceId,
      label: sourceId ? this.labelFor(sourceId) : null,
      code,
      message,
      programFrame: this.clock.frame,
      programTc: timecodeFromFrames(this.clock.frame, this.outputConfig.fps),
      programSample: this.clock.sample
    });
    this.emit('take-result', { ok: false, code, message, record });
    this.emitStateNow();
    return { ok: false, code, message };
  }

  commitPendingTake(T) {
    if (!this.pendingTake) return;
    const pending = this.pendingTake;
    const sync = this.syncer.get(pending.sourceId);
    pending.attempt += 1;
    if (!sync || this.now() > pending.deadline) {
      this.pendingTake = null;
      this.rejectTake(
        pending.sourceId,
        sync ? 'source-timeout' : 'unknown-source',
        sync ? `${this.labelFor(pending.sourceId)} did not become ready in time` : 'Unknown source'
      );
      return;
    }
    if (!sync.online || !sync.locked) return;
    const probe = sync.peek(T);
    if (!probe.available) return;

    const from = this.onAirId;
    this.onAirId = pending.sourceId;
    if (this.previewId === pending.sourceId) {
      const next = this.config.sources.find((s) => s.id !== this.onAirId);
      if (next) this.previewId = next.id;
    }
    sync.resetForTake(T);
    this.pendingTake = null;
    const delayedMs = Math.max(0, (this.clock.pts - pending.requestedProgram) * 1000);
    const record = this.takeLog.append({
      kind: 'take',
      seq: ++this.takeSeq,
      from: from || null,
      fromLabel: from ? this.labelFor(from) : null,
      to: pending.sourceId,
      toLabel: this.labelFor(pending.sourceId),
      programFrame: this.clock.frame,
      programTc: timecodeFromFrames(this.clock.frame, this.outputConfig.fps),
      programPts: Number(T.toFixed(3)),
      programSample: this.clock.sample,
      sourcePts: Number(probe.framePts.toFixed(3)),
      sourceBufferMs: Math.round(probe.leadMs),
      delayedMs: Math.round(delayedMs)
    });
    this.lastTake = record;
    this.logDecision('take', {
      source: pending.sourceId,
      note: `${from ? this.labelFor(from) : 'BLACK'} -> ${this.labelFor(pending.sourceId)} at program frame ${this.clock.frame}`
    });
    this.emit('take-result', { ok: true, record });
    this.emitStateNow();
  }

  logDecision(kind, payload) {
    const entry = this.decisionLog.append({ kind, ...payload });
    this.emit('decision', entry);
    return entry;
  }

  warn(source, line) {
    const entry = { at: this.now(), source, line };
    this.warnings.push(entry);
    if (this.warnings.length > 50) this.warnings.shift();
    this.emit('warning', entry);
  }

  updatePreviewMonitor() {
    const now = this.now();
    if (now - this.lastPvwAt < this.pvwInterval) return;
    this.lastPvwAt = now;
    const id = this.previewId;
    if (!id) return;
    const sync = this.syncer.get(id);
    const preview = this.previews.get(id);
    const config = this.sourceConfig(id);
    const T = this.clock.pts;
    const probe = sync ? sync.peek(T) : { available: false, leadMs: null };
    const jpeg = this.previewCompositor.render({
      sourceJpeg: preview ? preview.jpeg : null,
      source: config,
      available: Boolean(probe.available),
      leadMs: probe.leadMs,
      bufferFrames: sync ? sync.video.length : 0,
      locked: sync ? sync.locked : false,
      online: sync ? sync.online : false,
      programFrame: this.clock.frame,
      previewIsProgram: id === this.onAirId
    });
    this.previewMonitor = { jpeg, at: now, sequence: (this.previewMonitor?.sequence || 0) + 1 };
    this.emit('preview-frame', jpeg);
  }

  emitStateThrottled() {
    const now = this.now();
    if (this._lastStateAt && now - this._lastStateAt < 180) return;
    this._lastStateAt = now;
    this.emitStateNow();
  }

  emitStateNow() {
    this.stateSeq += 1;
    this.emit('state', this.state());
  }

  state() {
    const T = this.clock.pts;
    const sources = this.config.sources.map((source) => {
      const sync = this.syncer.get(source.id);
      const ingest = this.ingests.get(source.id);
      const simulator = this.simulators?.get(source.id);
      const snap = sync ? sync.snapshot(T) : null;
      return {
        ...source,
        role: source.role,
        previewUrl: `/stream/source/${source.id}.mjpg`,
        onAir: this.onAirId === source.id,
        previewed: this.previewId === source.id,
        ingestState: ingest ? ingest.state : 'idle',
        simulator: simulator ? simulator.snapshot() : null,
        sync: snap
      };
    });
    return {
      seq: this.stateSeq,
      running: this.running,
      now: this.now(),
      program: {
        onAir: this.onAirId,
        onAirLabel: this.onAirId ? this.labelFor(this.onAirId) : null,
        preview: this.previewId,
        previewLabel: this.previewId ? this.labelFor(this.previewId) : null,
        frame: this.clock.frame,
        frameCount: this.clock.frame,
        sample: this.clock.sample,
        sampleCount: this.clock.sample,
        pts: T,
        timecode: timecodeFromFrames(this.clock.frame, this.outputConfig.fps),
        sampleRate: this.outputConfig.sampleRate,
        fps: this.outputConfig.fps,
        width: this.outputConfig.width,
        height: this.outputConfig.height,
        encoderLagMs: Math.round(this.encoderLagMs),
        pendingTake: this.pendingTake
          ? { sourceId: this.pendingTake.sourceId, label: this.labelFor(this.pendingTake.sourceId), requestedAt: this.pendingTake.requestedAt }
          : null,
        lastTake: this.lastTake
      },
      output: this.encoder ? this.encoder.snapshot() : { running: false },
      sources,
      takeLog: this.takeLog.tail(40),
      decisionLog: this.decisionLog.tail(40),
      warnings: this.warnings.slice(-4)
    };
  }

  async stop() {
    this.running = false;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const ingest of this.ingests.values()) ingest.stop();
    for (const simulator of this.simulators?.values() || []) {
      await simulator.stop();
    }
    if (this.encoder) await this.encoder.stop();
    this.decisionAgg.flushAll();
  }
}

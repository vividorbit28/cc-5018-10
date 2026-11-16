import { clamp } from './util.js';

// Per-source synchroniser.
//
// Program time is the authority: a source frame is chosen by mapping program
// time onto that source's own PTS clock through a per-connection anchor, never
// by "the newest frame we happen to have". The anchor is established when a
// connection delivers its first frame:
//
//   requiredPts(T) = anchorSrcPts + (T - anchorProgram)
//
// and playout therefore trails the live edge by roughly the configured target
// latency. Buffers are bounded; when a source runs fast the mapping is rebased
// (frames dropped), when it runs slow the last frame is repeated (fill) and
// audio is muted, and every such decision is counted and logged.
export class SyncSource {
  constructor(source, options) {
    this.source = source;
    this.fps = options.fps;
    this.sampleRate = options.sampleRate;
    this.latency = options.latencyMs / 1000;
    this.lockSpan = options.lockSpanMs / 1000;
    this.maxVideoBuffer = options.maxVideoBufferMs / 1000;
    this.maxAudioBuffer = options.maxAudioBufferMs / 1000;
    this.clock = options.clock;

    this.session = 0;
    this.anchorSrcPts = null;
    this.anchorProgram = null;
    this.firstPts = null;
    this.lastPts = null;
    this.lastAudioPts = null;
    this.locked = false;
    this.online = false;
    this.lastShown = null;
    this.lastShownPts = null;
    this.audioCursor = null;
    this.lastAudioStatus = 'idle';

    this.video = [];
    this.audio = [];

    this.counters = {
      videoIn: 0,
      videoLive: 0,
      fills: 0,
      drops: 0,
      skipped: 0,
      audioTrimmed: 0,
      backwards: 0,
      rebases: 0,
      audioIn: 0,
      audioDrops: 0,
      silenceSamples: 0,
      silenceEvents: 0
    };
    this.lastDecision = null;
    this.lastRebaseAt = null;
  }

  get id() {
    return this.source.id;
  }

  beginSession(session) {
    this.session = session;
    this.anchorSrcPts = null;
    this.anchorProgram = null;
    this.firstPts = null;
    this.lastPts = null;
    this.lastAudioPts = null;
    this.locked = false;
    this.audioCursor = null;
    this.video = [];
    this.audio = [];
    // lastShown intentionally survives: an input rebuild must not flash a slate
    // into program while the transport reconnects.
  }

  setOnline(online) {
    this.online = online;
    if (!online) this.locked = false;
  }

  requiredPts(programTime) {
    if (this.anchorSrcPts === null || this.anchorProgram === null) return null;
    return this.anchorSrcPts + (programTime - this.anchorProgram);
  }

  // Earliest program time at which this source can be played without starving.
  readyProgramTime() {
    if (this.anchorSrcPts === null) return Infinity;
    return this.anchorProgram;
  }

  onVideo({ pts, duration, data }) {
    this.counters.videoIn += 1;
    if (this.firstPts === null) {
      this.firstPts = pts;
      // Anchor source PTS to program time using the wall clock at the moment the
      // connection delivers this frame. Playout then trails behind the live edge
      // by `latency`, which is what makes a cut land on a real queued frame
      // instead of "whatever arrived most recently".
      this.anchorSrcPts = pts;
      this.anchorProgram = this.clock.now() + this.latency;
    }
    const span = pts - this.firstPts;
    if (!this.locked && span >= this.lockSpan && this.video.length >= 2) {
      this.locked = true;
    }
    if (this.lastPts !== null && pts <= this.lastPts + 1e-6) {
      this.counters.backwards += 1;
      this.counters.drops += 1;
      this.lastDecision = { kind: 'backwards-pts', at: this.clock.now(), pts };
      return;
    }
    this.lastPts = pts;
    this.video.push({ pts, duration: duration || 1 / this.fps, data });

    this.enforceVideoBound();
  }

  enforceVideoBound() {
    if (this.anchorSrcPts === null) return;
    const now = this.clock.now();
    const required = this.requiredPts(now);
    if (required === null) return;
    const newest = this.video.length ? this.video[this.video.length - 1].pts : required;
    const lead = newest - required;
    if (lead > this.maxVideoBuffer * 0.8) {
      this.rebase(now, lead);
    }
    // Consumed frames older than required minus a small guard are useless.
    while (this.video.length > 1 && this.video[1].pts <= required - 0.05) {
      const gone = this.video.shift();
      // Skipping the *source's* frames is not the same as losing *program*
      // frames: while off air the playhead legitimately trails the newest
      // frames. Count it separately so drop counters stay meaningful.
      this.counters.skipped += 1;
      this.lastSkipped = gone.pts;
    }
  }

  rebase(programTime, lead) {
    const target = this.latency;
    const shift = lead - target;
    if (shift <= 0) return;
    const newRequired = this.requiredPts(programTime) + shift;
    const dropped = this.video.filter((entry) => entry.pts < newRequired).length;
    this.anchorProgram -= shift;
    this.counters.rebases += 1;
    this.counters.drops += dropped;
    this.lastRebaseAt = programTime;
    this.lastDecision = { kind: 'rebase', at: programTime, shift, dropped };
    if (this.audioCursor !== null) {
      const targetSample = Math.round(this.requiredPts(programTime) * this.sampleRate);
      const skipped = targetSample - this.audioCursor;
      if (skipped > 0) {
        this.counters.audioDrops += skipped;
        this.lastDecision.audioDropped = skipped;
      }
      this.audioCursor = targetSample;
    }
  }

  // Chooses the frame that represents program time `programTime`.
  select(programTime) {
    if (!this.online && !this.lastShown) {
      return { status: 'offline', frame: null, requiredPts: this.requiredPts(programTime) };
    }
    const required = this.requiredPts(programTime);
    if (required === null) {
      return { status: 'acquiring', frame: null, requiredPts: null };
    }
    if (!this.locked && !this.lastShown) {
      return { status: 'acquiring', frame: null, requiredPts: required };
    }

    let index = -1;
    for (let i = this.video.length - 1; i >= 0; i -= 1) {
      if (this.video[i].pts <= required + 1e-6) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      const entry = this.video[index];
      if (index > 0) this.video.splice(0, index);
      const behind = required - entry.pts;
      // If program time has moved past the display window of the newest frame we
      // can find, no new frame exists for this moment: repeat the held frame and
      // account for it explicitly. This is what a slow or stalled source looks
      // like on the output timeline.
      const exhausted = required >= entry.pts + entry.duration - 1e-6;
      const newest = this.video.length ? this.video[this.video.length - 1] : entry;
      this.lastShown = entry;
      this.lastShownPts = entry.pts;
      if (exhausted) {
        this.counters.fills += 1;
        this.lastDecision = { kind: 'fill', at: programTime, behind };
        return {
          status: 'repeat',
          frame: entry,
          requiredPts: required,
          newestPts: newest.pts,
          leadMs: (newest.pts - required) * 1000,
          behindMs: behind * 1000,
          late: true
        };
      }
      this.counters.videoLive += 1;
      return {
        status: 'live',
        frame: entry,
        requiredPts: required,
        newestPts: newest.pts,
        leadMs: (newest.pts - required) * 1000,
        behindMs: behind * 1000,
        late: false
      };
    }

    if (this.lastShown) {
      this.counters.fills += 1;
      this.lastDecision = { kind: 'fill', at: programTime, reason: this.online ? 'late' : 'offline' };
      const newest = this.video.length ? this.video[this.video.length - 1].pts : this.lastShownPts;
      return {
        status: 'repeat',
        frame: this.lastShown,
        requiredPts: required,
        newestPts: newest,
        leadMs: (newest - required) * 1000,
        behindMs: (required - this.lastShownPts) * 1000,
        late: true
      };
    }
    return { status: this.online ? 'starved' : 'offline', frame: null, requiredPts: required };
  }

  onAudio({ pts, data }) {
    this.counters.audioIn += 1;
    if (this.lastAudioPts !== null && pts <= this.lastAudioPts - 1e-6) {
      // Overlapping AAC priming or a transport restart; keep the later block.
      this.counters.audioDrops += Math.round(data.length / 4);
      return;
    }
    this.lastAudioPts = pts;
    this.audio.push({ start: Math.round(pts * this.sampleRate), data });
    this.enforceAudioBound();
  }

  enforceAudioBound() {
    if (this.anchorSrcPts === null) return;
    const requiredSample = Math.round(this.requiredPts(this.clock.now()) * this.sampleRate);
    const maxSamples = Math.round(this.maxAudioBuffer * this.sampleRate);
    // Only discard blocks that are entirely behind the hard bound. Everything
    // closer to the playhead is left for pullAudio, which decides precisely
    // which samples are muted versus consumed.
    while (
      this.audio.length > 1 &&
      this.audio[0].start + this.audio[0].data.length / 4 <= requiredSample - maxSamples
    ) {
      const block = this.audio.shift();
      this.counters.audioTrimmed += block.data.length / 4;
    }
  }

  // Returns exactly `count` stereo s16le samples, muted and accounted for
  // whenever the source cannot supply them.
  pullAudio(programTime, count) {
    const out = Buffer.alloc(count * 4, 0);
    const required = this.requiredPts(programTime);
    if (required === null || !this.locked) {
      this.counters.silenceSamples += count;
      this.counters.silenceEvents += 1;
      this.lastAudioStatus = 'no-source';
      return { buffer: out, status: 'silence', reason: 'no-source' };
    }
    const expected = Math.round(required * this.sampleRate);
    if (this.audioCursor === null) this.audioCursor = expected;
    if (Math.abs(this.audioCursor - expected) > this.sampleRate * 0.12) {
      const delta = expected - this.audioCursor;
      if (delta > 0) this.counters.audioDrops += delta;
      else this.counters.silenceSamples += -delta;
      this.audioCursor = expected;
      this.lastAudioStatus = delta > 0 ? 'resync-drop' : 'resync-pad';
    }

    let cursor = this.audioCursor;
    let filled = 0;
    let muted = 0;
    let dropped = 0;
    let guard = 0;
    while (filled < count && guard < 64) {
      guard += 1;
      while (this.audio.length && this.audio[0].start + this.audio[0].data.length / 4 <= cursor) {
        this.audio.shift();
      }
      if (!this.audio.length) {
        muted += count - filled;
        filled = count;
        break;
      }
      const block = this.audio[0];
      const blockStart = block.start;
      const blockSamples = block.data.length / 4;
      if (cursor < blockStart) {
        const gap = Math.min(blockStart - cursor, count - filled);
        muted += gap;
        filled += gap;
        cursor += gap;
        if (gap === 0) break;
        continue;
      }
      const offset = cursor - blockStart;
      if (offset >= blockSamples) {
        this.audio.shift();
        continue;
      }
      const take = Math.min(blockSamples - offset, count - filled);
      block.data.copy(out, filled * 4, offset * 4, (offset + take) * 4);
      filled += take;
      cursor += take;
    }
    if (filled < count) {
      muted += count - filled;
      filled = count;
    }
    this.audioCursor = cursor;
    this.counters.silenceSamples += muted;
    if (muted > 0) this.counters.silenceEvents += 1;
    this.counters.audioDrops += dropped;
    const status = muted === count ? 'silence' : muted > 0 ? 'partial' : 'live';
    this.lastAudioStatus = status;
    return { buffer: out, status, muted, dropped };
  }

  // Non-mutating view of what `select` would do at this program time. Used by
  // the take logic to confirm a cut can land on a real frame before committing.
  peek(programTime) {
    const required = this.requiredPts(programTime);
    if (required === null || !this.locked || !this.video.length) {
      return { available: false, sameAsLast: false, leadMs: null, framePts: null };
    }
    let entry = null;
    for (let i = this.video.length - 1; i >= 0; i -= 1) {
      if (this.video[i].pts <= required + 1e-6) {
        entry = this.video[i];
        break;
      }
    }
    if (!entry) return { available: false, sameAsLast: false, leadMs: null, framePts: null };
    const newest = this.video[this.video.length - 1].pts;
    return {
      available: true,
      sameAsLast: this.lastShownPts !== null && Math.abs(entry.pts - this.lastShownPts) < 1e-6,
      framePts: entry.pts,
      leadMs: (newest - required) * 1000,
      requiredPts: required
    };
  }

  resetForTake(programTime) {
    // Called when this source is about to go on air so audio starts exactly at
    // the program sample that matches the first program frame.
    const required = this.requiredPts(programTime);
    if (required === null) return;
    const expected = Math.round(required * this.sampleRate);
    if (this.audioCursor === null || Math.abs(this.audioCursor - expected) > 4) {
      this.audioCursor = expected;
    }
  }

  snapshot(programTime) {
    const required = this.requiredPts(programTime);
    const newest = this.video.length ? this.video[this.video.length - 1].pts : null;
    const oldest = this.video.length ? this.video[0].pts : null;
    const audioEnd = this.audio.length
      ? this.audio[this.audio.length - 1].start + this.audio[this.audio.length - 1].data.length / 4
      : null;
    const audioStart = this.audio.length ? this.audio[0].start : null;
    const leadMs = required !== null && newest !== null ? clamp((newest - required) * 1000, -10000, 10000) : null;
    const audioLeadMs = required !== null && audioEnd !== null
      ? clamp((audioEnd - required * this.sampleRate) / this.sampleRate * 1000, -10000, 10000)
      : null;
    return {
      id: this.id,
      online: this.online,
      locked: this.locked,
      session: this.session,
      spanMs: this.firstPts !== null && this.lastPts !== null ? (this.lastPts - this.firstPts) * 1000 : 0,
      bufferFrames: this.video.length,
      bufferMs: oldest !== null && newest !== null ? (newest - oldest) * 1000 : 0,
      leadMs,
      audioBufferMs: audioStart !== null && audioEnd !== null ? (audioEnd - audioStart) / this.sampleRate * 1000 : 0,
      audioLeadMs,
      readyInMs: this.anchorProgram === null ? null : Math.max(0, (this.anchorProgram - programTime) * 1000),
      counters: { ...this.counters },
      lastDecision: this.lastDecision,
      audioStatus: this.lastAudioStatus,
      anchor: this.anchorSrcPts === null
        ? null
        : { srcPts: this.anchorSrcPts, program: this.anchorProgram }
    };
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSource } from '../src/sync_source.js';
import { timecodeFromFrames } from '../src/util.js';
import { FramecrcParser } from '../src/framecrc.js';

class FakeClock {
  constructor() { this.t = 0; }
  now() { return this.t; }
  set(t) { this.t = t; }
}

const FPS = 25;
const SR = 48000;
const FRAME_BLOCK = 0.04;
const AUDIO_BYTES = 1920 * 4; // 40ms of stereo s16le

function makeSource(rate = 1, { seconds = 8, stall = null } = {}) {
  const clock = new FakeClock();
  const source = new SyncSource({ id: 'src' }, {
    fps: FPS,
    sampleRate: SR,
    latencyMs: 300,
    lockSpanMs: 400,
    maxVideoBufferMs: 1200,
    maxAudioBufferMs: 1500,
    clock
  });
  source.setOnline(true);

  // Producer time tracks wall time scaled by `rate`; i.e. a source running at
  // 1.08x emits program time 8% faster than the wall clock. Pre-roll 1.2s.
  let videoPts = 0;
  let audioPts = 0;
  const frame = Buffer.alloc(8);

  const feed = (t) => {
    if (stall && t >= stall[0] && t < stall[1]) return;
    const videoDue = Math.floor(t / FRAME_BLOCK) * rate;
    while (videoPts < videoDue * FRAME_BLOCK + FRAME_BLOCK) {
      source.onVideo({ pts: videoPts, duration: FRAME_BLOCK, data: frame });
      videoPts += FRAME_BLOCK;
    }
    const audioDue = Math.floor(t / 0.02) * rate;
    while (audioPts < audioDue * 0.02 + 0.02) {
      source.onAudio({ pts: audioPts, data: Buffer.alloc(AUDIO_BYTES) });
      audioPts += 0.02;
    }
  };

  for (let t = 0; t <= 1.2; t += FRAME_BLOCK) {
    clock.set(t);
    feed(t);
  }

  const stats = { live: 0, repeat: 0, acquiring: 0, audioLive: 0, audioSilence: 0 };
  for (let t = 1.2; t <= seconds; t += FRAME_BLOCK) {
    clock.set(t);
    feed(t);
    const selection = source.select(t);
    const audio = source.pullAudio(t, 1920);
    if (selection.status === 'live') stats.live += 1;
    else if (selection.status === 'repeat') stats.repeat += 1;
    else stats.acquiring += 1;
    if (audio.status === 'live') stats.audioLive += 1;
    else if (audio.status === 'silence') stats.audioSilence += 1;
  }
  return { source, stats };
}

test('steady source: program time is served live, no fills or drops', () => {
  const { source, stats } = makeSource(1);
  assert.ok(stats.live > 150, `live frames: ${JSON.stringify(stats)}`);
  assert.equal(source.counters.fills, 0);
  assert.equal(source.counters.drops, 0);
  assert.ok(stats.audioLive > 150, `live audio: ${JSON.stringify(stats)}`);
  assert.equal(source.counters.silenceSamples, 0);
});

test('slow source: repeated frames and muted samples are counted, then recovers', () => {
  const { source, stats } = makeSource(1, { seconds: 5, stall: [3.0, 3.8] });
  assert.ok(stats.repeat > 0, `repeat frames: ${stats.repeat}`);
  assert.ok(source.counters.fills > 0);
  assert.ok(source.counters.silenceSamples > 0);
  assert.ok(stats.live > 50, `recovered live frames: ${stats.live}`);
});

test('fast source: lead is bounded by rebase and drops are counted', () => {
  // 8% overspeed produces only ~0.64s of lead in 8s, below the 0.96s rebase
  // threshold; the window has to be long enough for the bound to engage.
  const { source } = makeSource(1.08, { seconds: 20 });
  assert.ok(source.counters.drops > 0, `drops=${source.counters.drops} rebases=${source.counters.rebases}`);
  assert.ok(source.counters.rebases > 0, `rebases=${source.counters.rebases}`);
  assert.ok(source.video.length < 60, `queue=${source.video.length}`);
});

test('slow input: repeated frames accounted as fills', () => {
  const { source } = makeSource(0.92, { seconds: 8 });
  assert.ok(source.counters.fills > 0);
});

test('audio pull always returns exactly the requested sample count', () => {
  const { source } = makeSource(1, { seconds: 2 });
  const out = source.pullAudio(2.0, 1920);
  assert.equal(out.buffer.length, 1920 * 4);
});

test('beginSession keeps last shown frame so a rebuild does not flash slate', () => {
  const { source } = makeSource(1, { seconds: 2 });
  assert.ok(source.lastShown);
  const held = source.lastShown;
  source.beginSession(99);
  assert.equal(source.lastShown, held);
  assert.equal(source.anchorSrcPts, null);
});

test('timecode formats frames as HH:MM:SS:FF', () => {
  assert.equal(timecodeFromFrames(0, 25), '00:00:00:00');
  assert.equal(timecodeFromFrames(25, 25), '00:00:01:00');
  assert.equal(timecodeFromFrames(25 * 60 + 5, 25), '00:01:00:05');
  assert.equal(timecodeFromFrames(25 * 3600 + 1, 25), '01:00:00:01');
});

test('framecrc parser reads the timebase header and rows', () => {
  const rows = [];
  const parser = new FramecrcParser({ onRow: (row) => rows.push(row) });
  parser.push(Buffer.from('#tb 0: 1/25\n#software: ffmpeg\n0, 0, 0, 1, 8, 0xdeadbeef\n0, 1, 1, 1, 8, 0x1234\n'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ptsTime, 0);
  assert.equal(rows[1].ptsTime, 0.04);
  assert.equal(rows[0].durationTime, 0.04);
  assert.equal(rows[0].size, 8);
});

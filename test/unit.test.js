import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncSource } from '../src/sync_source.js';
import { timecodeFromFrames } from '../src/util.js';
import { FramecrcParser } from '../src/framecrc.js';
import {
  DECODE_ADAPTER_VERSION,
  DECODE_PIPES,
  DecodeAdapterError,
  createDecodePlan,
  decodeArgs,
  migrateLegacyProgramConfig,
  planContract,
  resolveDecodePlan
} from '../src/decode_adapter.js';
import { createAudioMeter, dbToLevel, meterS16le, summarizeMeter } from '../src/audio_meter.js';
import { probeFfmpeg } from '../src/media_runtime.js';

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

test('framecrc parser keeps the rational time base instead of only the ratio', () => {
  const rows = [];
  const parser = new FramecrcParser({ onRow: (row) => rows.push(row) });
  parser.push(Buffer.from('#tb 0: 1/24\n0, 34, 34, 1, 1382400, 0x1\n'));
  assert.deepEqual(rows[0].timeBase, { stream: 0, num: 1, den: 24 });
  assert.equal(parser.timeBase.den, 24);
});

test('framecrc parser recovers a final row without a trailing newline on flush', () => {
  const rows = [];
  const parser = new FramecrcParser({ onRow: (row) => rows.push(row) });
  parser.push(Buffer.from('#tb 0: 1/48000\n0, 67200, 67200, 960, 3840, 0x1'));
  assert.equal(rows.length, 0);
  parser.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ptsTime, 1.4);
});

test('framecrc parser reports a malformed row instead of inventing timing', () => {
  const errors = [];
  const rows = [];
  const parser = new FramecrcParser({ onRow: (row) => rows.push(row), onError: (m) => errors.push(m) });
  parser.push(Buffer.from('#tb 0: 1/25\nnot,a,valid,row\n'));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(parser.errorCount, 1);
});

const BASE_PLAN_REQUEST = {
  version: DECODE_ADAPTER_VERSION,
  source: { id: 'cam1', label: 'CAM 1' },
  raster: { width: 1280, height: 720 },
  video: { pixelFormat: 'yuv420p', fpsMode: 'passthrough', scaleFlags: 'bilinear', fps: 25 },
  audio: {
    sampleRate: 48000,
    channels: 2,
    sampleFormat: 's16',
    outputFormat: 's16le',
    blockSamples: 960,
    resampler: 'soxr',
    resamplerPrecision: 28
  },
  preview: { fps: 10, width: 480, height: 270, jpegQuality: 7 },
  previewAudio: { sampleRate: 48000, codec: 'libmp3lame', bitrate: '64k' },
  input: { url: 'tcp://127.0.0.1:5701', kind: 'stream', pacing: 'realtime' },
  drain: { mode: 'eof-flush', eofFlush: true, flushPackets: true }
};

test('decode plan declares pixel format, rational time bases and drain policy', () => {
  const plan = createDecodePlan(structuredClone(BASE_PLAN_REQUEST));
  const contract = planContract(plan);
  assert.equal(contract.adapterVersion, '2.0.0');
  assert.equal(contract.pixelFormat, 'yuv420p');
  assert.equal(contract.videoTimeBase, '1/25');
  assert.equal(contract.audioTimeBase, '1/48000');
  assert.equal(contract.drainMode, 'eof-flush');
  assert.equal(contract.legacyFrom, null);
});

test('decode plan refuses to fill in missing fields with defaults', () => {
  const missingOutput = structuredClone(BASE_PLAN_REQUEST);
  delete missingOutput.audio.outputFormat;
  assert.throws(() => createDecodePlan(missingOutput), (error) => {
    assert.ok(error instanceof DecodeAdapterError);
    assert.equal(error.code, 'DECODE_FIELD_MISSING');
    assert.equal(error.field, 'audio.outputFormat');
    return true;
  });

  const noDrainFlush = structuredClone(BASE_PLAN_REQUEST);
  delete noDrainFlush.drain.eofFlush;
  assert.throws(() => createDecodePlan(noDrainFlush), /drain\.eofFlush must be true/);
});

test('decode plan rejects an unversioned request instead of guessing', () => {
  const request = structuredClone(BASE_PLAN_REQUEST);
  delete request.version;
  assert.throws(() => createDecodePlan(request), (error) => error.code === 'DECODE_VERSION_REQUIRED');
});

test('decode plan rejects a pixel format outside the validated set', () => {
  const request = structuredClone(BASE_PLAN_REQUEST);
  request.video.pixelFormat = 'rgb24';
  assert.throws(() => createDecodePlan(request), (error) => error.code === 'DECODE_FIELD_INVALID');
});

test('legacy 1.0.0 config is converted and records every assumption', () => {
  const plan = migrateLegacyProgramConfig({ id: 'cam1', label: 'CAM 1' }, {
    version: '1.0.0',
    url: 'tcp://127.0.0.1:5701',
    raster: { width: 1280, height: 720 },
    fps: 30,
    audioRate: 48000,
    audioBlockSamples: 960,
    preview: { fps: 10, width: 480, height: 270 }
  });
  assert.equal(plan.adapterVersion, '2.0.0');
  assert.equal(plan.legacy.from, '1.0.0');
  assert.ok(plan.legacy.assumed.includes('video.pixelFormat=yuv420p'));
  assert.equal(planContract(plan).legacyFrom, '1.0.0');
  assert.equal(planContract(plan).videoTimeBase, '1/30');
});

test('resolveDecodePlan accepts an explicit plan, converts legacy config, and refuses ambiguity', () => {
  const source = { id: 'cam1', label: 'CAM 1' };
  const plan = createDecodePlan(structuredClone(BASE_PLAN_REQUEST));
  assert.equal(resolveDecodePlan(source, { ffmpeg: 'x', plan }), plan);

  const migrated = resolveDecodePlan(source, {
    version: '1.0.0',
    url: 'tcp://127.0.0.1:5701',
    raster: { width: 1280, height: 720 },
    fps: 25,
    audioRate: 48000,
    audioBlockSamples: 960,
    preview: { fps: 10, width: 480, height: 270 }
  });
  assert.equal(migrated.legacy.from, '1.0.0');

  assert.throws(() => resolveDecodePlan(source, { ffmpeg: 'x' }), (error) => error.code === 'DECODE_CONTRACT_MISSING');
});

test('decode args carry the plan pipe numbers and explicit format filter', () => {
  const plan = createDecodePlan(structuredClone(BASE_PLAN_REQUEST));
  const args = decodeArgs(plan);
  const joined = args.join(' ');
  assert.ok(joined.includes(`pipe:${DECODE_PIPES.video}`));
  assert.ok(joined.includes(`pipe:${DECODE_PIPES.audioMeta}`));
  assert.ok(joined.includes('format=yuv420p'));
  assert.ok(joined.includes('-fps_mode passthrough'));
  assert.ok(joined.includes('-flush_packets 1'));
  assert.ok(!joined.includes('rgb24'));
});

test('the audio payload and timestamp pipes share one block boundary', () => {
  const plan = createDecodePlan(structuredClone(BASE_PLAN_REQUEST));
  const args = decodeArgs(plan);
  const blockFilter = 'asetnsamples=n=960:p=1';
  // The raw pipe is read as 960-sample blocks, so it must be reblocked exactly
  // like the framecrc pipe. Otherwise the padded tail row has no samples and
  // the final samples have no timestamp row, and the EOF drain cannot balance.
  const audioStart = args.indexOf(`pipe:${DECODE_PIPES.audio}`);
  const metaStart = args.indexOf(`pipe:${DECODE_PIPES.audioMeta}`);
  const rawArgs = args.slice(0, audioStart);
  const metaArgs = args.slice(audioStart + 1, metaStart);
  for (const [name, slice] of [['raw', rawArgs], ['meta', metaArgs]]) {
    const filter = slice[slice.indexOf('-af') + 1] || '';
    assert.ok(filter.includes(blockFilter), `${name} filter lacks ${blockFilter}: ${filter}`);
  }
});

test('audio meter measures real sample levels, not a decorative animation', () => {
  const meter = createAudioMeter({ smoothing: 0 });
  const block = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960 * 2; i += 1) {
    // A quieter square wave with periodic full-scale spikes, so peak and RMS
    // differ the way a real programme signal does.
    const amplitude = i % 240 === 0 ? 32767 : 4096;
    block.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  meterS16le(meter, block);
  const summary = summarizeMeter(meter);
  assert.ok(summary.rmsDb > -20 && summary.rmsDb < 0, `rmsDb=${summary.rmsDb}`);
  assert.ok(summary.peakLevel > summary.rmsLevel);
  assert.equal(meter.silentBlocks, 0);

  const silent = createAudioMeter({ smoothing: 0 });
  meterS16le(silent, Buffer.alloc(960 * 4));
  assert.equal(summarizeMeter(silent).rmsDb, -70);
  assert.equal(silent.silentBlocks, 1);
  assert.equal(dbToLevel(-70), 0);
});

test('media runtime probe validates the ffmpeg actually on disk', () => {
  const binary = process.env.FFMPEG || path.join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg');
  if (!fs.existsSync(binary)) return;
  const probe = probeFfmpeg(binary);
  assert.equal(probe.available, true);
  assert.equal(probe.compatible, true, probe.problems?.join('; '));
  assert.ok(probe.major >= 5);
  assert.equal(probe.capabilities.fpsMode, true);
  assert.equal(probe.capabilities.flushPackets, true);
});

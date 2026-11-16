import { SourceIngest } from '../src/source_ingest.js';
import { migrateLegacyProgramConfig, createDecodePlan } from '../src/decode_adapter.js';

const ffmpeg = process.env.FFMPEG || '/workspace/node_modules/ffmpeg-static/ffmpeg';

function legacyPlan(file) {
  return migrateLegacyProgramConfig({ id: 'fixture', label: 'FIXTURE' }, {
    version: '1.0.0',
    url: file,
    raster: { width: 1280, height: 720 },
    fps: 25,
    audioRate: 48000,
    audioBlockSamples: 960,
    preview: { fps: 10, width: 480, height: 270 }
  });
}

// Exercises the migrated ingest on a finite file so end-of-stream is real, not
// simulated: no transport is killed and no reconnection happens.
export async function runFixture(file, options = {}) {
  const plan = options.legacy ? legacyPlan(file) : createDecodePlan({
    version: '2.0.0',
    source: { id: 'fixture', label: 'FIXTURE' },
    raster: { width: 1280, height: 720 },
    video: { pixelFormat: 'yuv420p', fpsMode: 'passthrough', scaleFlags: 'bilinear', fps: options.fps || 25 },
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
    input: { url: file, kind: 'file', pacing: 'fast' },
    drain: { mode: 'eof-flush', eofFlush: true, flushPackets: true }
  });

  const ingest = new SourceIngest({ id: 'fixture', label: 'FIXTURE' }, { ffmpeg, plan });
  const video = [];
  const audio = [];
  const warnings = [];
  let drained = null;
  let down = null;
  ingest.on('video', (entry) => video.push(entry));
  ingest.on('audio', (entry) => audio.push(entry));
  ingest.on('warning', (line) => warnings.push(line));
  ingest.on('drained', (evidence) => { drained = evidence; });
  ingest.on('down', (info) => { down = info; });

  const ended = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), options.timeoutMs || 60000);
    ingest.on('state', (state) => {
      if (state === 'ended' || state === 'offline') {
        clearTimeout(timer);
        resolve(state);
      }
    });
  });
  ingest.start();
  const finalState = await ended;
  return { plan, ingest, video, audio, warnings, drained, down, finalState };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node test/decode_fixture_probe.js <file.ts> [legacy]');
    process.exit(2);
  }
  const result = await runFixture(file, { legacy: process.argv[3] === 'legacy' });
  const videoPts = result.video.map((entry) => entry.pts);
  const audioPts = result.audio.map((entry) => entry.pts);
  const monotonic = (values) => values.every((value, i) => i === 0 || value > values[i - 1]);
  console.log(JSON.stringify({
    state: result.finalState,
    frames: result.video.length,
    audioBlocks: result.audio.length,
    videoPtsMonotonic: monotonic(videoPts),
    audioPtsMonotonic: monotonic(audioPts),
    firstVideoPts: videoPts[0],
    lastVideoPts: videoPts.at(-1),
    firstAudioPts: audioPts[0],
    lastAudioPts: audioPts.at(-1),
    drain: result.drained,
    down: result.down,
    warnings: result.warnings.slice(0, 5),
    contract: result.ingest.contract(),
    legacyFrom: result.plan.legacy?.from || null
  }, null, 2));
}

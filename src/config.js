import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function num(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const sourceDefaults = [
  {
    id: 'cam1',
    label: 'CAM 1',
    role: 'Camera 1',
    width: 640,
    height: 360,
    fps: 25,
    sampleRate: 44100,
    tone: 440,
    accent: '#3aa0ff',
    accentRgb: [58, 160, 255],
    background: '#08182c',
    bitrate: '1600k',
    port: 5701,
    ppm: 0
  },
  {
    id: 'cam2',
    label: 'CAM 2',
    role: 'Camera 2',
    width: 1280,
    height: 720,
    fps: 30,
    sampleRate: 48000,
    tone: 660,
    accent: '#3ddc84',
    accentRgb: [61, 220, 132],
    background: '#082015',
    bitrate: '3200k',
    port: 5702,
    ppm: 0
  },
  {
    id: 'test',
    label: 'TEST',
    role: 'Test pattern',
    width: 960,
    height: 540,
    fps: 24,
    sampleRate: 32000,
    tone: 880,
    accent: '#ff5f9e',
    accentRgb: [255, 95, 158],
    background: '#210c17',
    bitrate: '2200k',
    port: 5703,
    ppm: 0
  }
];

const sources = sourceDefaults.map((source) => {
  const resolved = {
    ...source,
    ppm: num(`PPM_${source.id.toUpperCase()}`, source.ppm),
    port: num(`PORT_${source.id.toUpperCase()}`, source.port)
  };
  resolved.url = env[`URL_${source.id.toUpperCase()}`] || `tcp://127.0.0.1:${resolved.port}`;
  return resolved;
});

const output = {
  width: num('OUT_WIDTH', 1280),
  height: num('OUT_HEIGHT', 720),
  fps: num('OUT_FPS', 25),
  sampleRate: num('OUT_SAMPLE_RATE', 48000),
  videoBitrate: env.OUT_VIDEO_BITRATE || '3000k',
  maxrate: env.OUT_MAXRATE || '3600k',
  bufsize: env.OUT_BUFSIZE || '6000k',
  audioBitrate: env.OUT_AUDIO_BITRATE || '160k',
  preset: env.OUT_PRESET || 'veryfast',
  hlsSegment: num('OUT_HLS_SEGMENT', 1),
  hlsListSize: num('OUT_HLS_LIST', 8),
  monitorFps: num('MONITOR_FPS', 10),
  monitorWidth: num('MONITOR_WIDTH', 480),
  monitorHeight: num('MONITOR_HEIGHT', 270)
};

export const config = {
  root,
  host: env.HOST || '127.0.0.1',
  httpPort: num('HTTP_PORT', 8080),
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  ffmpeg: env.FFMPEG || '',
  sources,
  output,
  monitor: {
    fps: output.monitorFps,
    width: output.monitorWidth,
    height: output.monitorHeight
  },
  // Audio block delivered by each ingest (source-rate domain, 48 kHz after
  // resampling): 20 ms per block.
  ingestAudioBlock: num('INGEST_AUDIO_BLOCK', 960),
  // Versioned decode contract. 2.0.0 is the explicit interface; "1.0.0" replays
  // the original program config through the conversion path.
  decode: {
    adapterVersion: env.DECODE_ADAPTER_VERSION || '2.0.0',
    pixelFormat: env.DECODE_PIXEL_FORMAT || 'yuv420p',
    fpsMode: env.DECODE_FPS_MODE || 'passthrough',
    scaleFlags: env.DECODE_SCALE_FLAGS || 'bilinear',
    resampler: env.DECODE_RESAMPLER || 'soxr',
    resamplerPrecision: num('DECODE_RESAMPLER_PRECISION', 28),
    drainMode: env.DECODE_DRAIN_MODE || 'eof-flush'
  },
  // Target distance behind each source's live edge, in milliseconds. This is the
  // fixed playout latency that makes a cut land on a real frame instead of
  // whatever arrived most recently.
  targetLatencyMs: num('TARGET_LATENCY_MS', 320),
  // Hard bound on per-source buffering.
  maxVideoBufferMs: num('MAX_VIDEO_BUFFER_MS', 1200),
  maxAudioBufferMs: num('MAX_AUDIO_BUFFER_MS', 1500),
  // Source is considered unusable until this much PTS span has been observed.
  lockSpanMs: num('LOCK_SPAN_MS', 700),
  // A take waits this long for a locking source before it is rejected aloud.
  takeTimeoutMs: num('TAKE_TIMEOUT_MS', 6000),
  previewFps: num('PREVIEW_FPS', 8),
  startSources: bool('START_SOURCES', true)
};

export function sourceById(id) {
  return config.sources.find((source) => source.id === id) || null;
}

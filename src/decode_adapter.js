import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Versioned decode contract for every heterogeneous input.
//
// Inputs arrive at different rasters, frame rates, sample rates and pixel
// formats, and can be live sockets or finite files. Rather than letting each
// caller assemble its own ffmpeg command line, the switcher asks this module for
// one explicit `DecodePlan` per source. A plan carries the pixel format, the
// rational time base expected from each timestamp pipe, the end-of-stream drain
// policy and the provenance of every value, so an incomplete config fails loudly
// instead of silently inheriting a default.
//
// Versions:
//   1.0.0 — the original implicit program config
//           ({ raster, audioRate, audioBlockSamples, preview }). It assumed
//           yuv420p, a 1/fps time base and no explicit pump flushing.
//   2.0.0 — explicit contract: format filter + pixel format, declared rational
//           time bases, -fps_mode passthrough, packet/pipeline flush on EOF.
//
// A 1.0.0 request is converted, never reused as-is, and the resulting plan
// records `legacy.from` so evidence and logs can name the path taken.

export const DECODE_ADAPTER_VERSION = '2.0.0';
export const LEGACY_DECODE_ADAPTER_VERSION = '1.0.0';
export const SUPPORTED_DECODE_ADAPTER_VERSIONS = Object.freeze([
  LEGACY_DECODE_ADAPTER_VERSION,
  DECODE_ADAPTER_VERSION
]);
export const SUPPORTED_PIXEL_FORMATS = Object.freeze(['yuv420p']);
export const SUPPORTED_FPS_MODES = Object.freeze(['passthrough', 'cfr']);
export const SUPPORTED_PACING = Object.freeze(['realtime', 'fast']);
export const SUPPORTED_DRAIN_MODES = Object.freeze(['eof-flush']);

// Pipe numbering is part of the adapter contract: ingest and the planner must
// agree or frames get paired with the wrong timestamps.
export const DECODE_PIPES = Object.freeze({
  video: 3,
  videoMeta: 4,
  audio: 5,
  audioMeta: 6,
  preview: 7,
  previewAudio: 8
});

export class DecodeAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecodeAdapterError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new DecodeAdapterError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) fail('DECODE_FIELD_MISSING', `decode plan requires object ${field}`, { field });
  return value;
}

function requireNumber(obj, key, field, { integer = false, min = null, even = false } = {}) {
  const value = obj[key];
  if (value === undefined || value === null || value === '') {
    fail('DECODE_FIELD_MISSING', `decode plan requires ${field}`, { field });
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be a finite number, got ${JSON.stringify(value)}`, { field });
  }
  if (integer && !Number.isInteger(value)) {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be an integer, got ${value}`, { field });
  }
  if (min !== null && value < min) {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be >= ${min}, got ${value}`, { field });
  }
  if (even && value % 2 !== 0) {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be even, got ${value}`, { field });
  }
  return value;
}

function requireString(obj, key, field) {
  const value = obj[key];
  if (value === undefined || value === null || value === '') {
    fail('DECODE_FIELD_MISSING', `decode plan requires ${field}`, { field });
  }
  if (typeof value !== 'string') {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be a string`, { field });
  }
  return value;
}

function requireEnum(obj, key, field, allowed) {
  const value = requireString(obj, key, field);
  if (!allowed.includes(value)) {
    fail('DECODE_FIELD_INVALID', `decode plan ${field} must be one of ${allowed.join(', ')}, got ${value}`, {
      field,
      allowed
    });
  }
  return value;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep(value[key]);
  }
  return value;
}

export function inputKindForUrl(url) {
  const text = String(url ?? '');
  if (!text) fail('DECODE_FIELD_MISSING', 'decode plan requires input.url', { field: 'input.url' });
  if (/^(tcp|udp|rtmp|rtmps|srt|http|https|rtsp):\/\//i.test(text)) return 'stream';
  if (/^file:\/\//i.test(text)) return 'file';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    fail('DECODE_INPUT_UNSUPPORTED', `unsupported input scheme in ${text}`, { field: 'input.url' });
  }
  return 'file';
}

// Builds a 2.0.0 plan from a fully explicit request. Nothing is defaulted: a
// caller that forgets a field gets a named error, not a plausible-looking plan.
export function createDecodePlan(request) {
  const req = requireObject(request, 'request');

  if (req.version !== DECODE_ADAPTER_VERSION) {
    if (req.version === undefined || req.version === null) {
      fail(
        'DECODE_VERSION_REQUIRED',
        'decode request must name its adapter version; legacy program configs must say version "1.0.0"',
        { field: 'version' }
      );
    }
    fail('DECODE_VERSION_UNSUPPORTED', `unsupported decode adapter version ${req.version}`, {
      field: 'version',
      supported: SUPPORTED_DECODE_ADAPTER_VERSIONS
    });
  }

  const source = requireObject(req.source, 'source');
  const raster = requireObject(req.raster, 'raster');
  const audio = requireObject(req.audio, 'audio');
  const preview = requireObject(req.preview, 'preview');
  const previewAudio = requireObject(req.previewAudio, 'previewAudio');
  const input = requireObject(req.input, 'input');
  const video = requireObject(req.video, 'video');
  const drain = requireObject(req.drain, 'drain');

  const width = requireNumber(raster, 'width', 'raster.width', { integer: true, min: 2, even: true });
  const height = requireNumber(raster, 'height', 'raster.height', { integer: true, min: 2, even: true });

  const pixelFormat = requireEnum(video, 'pixelFormat', 'video.pixelFormat', SUPPORTED_PIXEL_FORMATS);
  const fpsMode = requireEnum(video, 'fpsMode', 'video.fpsMode', SUPPORTED_FPS_MODES);
  const scaleFlags = requireString(video, 'scaleFlags', 'video.scaleFlags');

  const sampleRate = requireNumber(audio, 'sampleRate', 'audio.sampleRate', { integer: true, min: 8000 });
  const channels = requireNumber(audio, 'channels', 'audio.channels', { integer: true, min: 2, max: 2 });
  const sampleFormat = requireString(audio, 'sampleFormat', 'audio.sampleFormat');
  if (sampleFormat !== 's16') {
    fail('DECODE_FIELD_INVALID', `decode plan audio.sampleFormat must be s16, got ${sampleFormat}`, {
      field: 'audio.sampleFormat'
    });
  }
  const outputFormat = requireString(audio, 'outputFormat', 'audio.outputFormat');
  if (outputFormat !== 's16le') {
    fail('DECODE_FIELD_INVALID', `decode plan audio.outputFormat must be s16le, got ${outputFormat}`, {
      field: 'audio.outputFormat'
    });
  }
  const blockSamples = requireNumber(audio, 'blockSamples', 'audio.blockSamples', { integer: true, min: 1 });
  const resampler = requireString(audio, 'resampler', 'audio.resampler');
  const resamplerPrecision = resampler === 'soxr'
    ? requireNumber(audio, 'resamplerPrecision', 'audio.resamplerPrecision', { integer: true, min: 1 })
    : null;

  const previewFps = requireNumber(preview, 'fps', 'preview.fps', { min: 0.1 });
  const previewWidth = requireNumber(preview, 'width', 'preview.width', { integer: true, min: 2, even: true });
  const previewHeight = requireNumber(preview, 'height', 'preview.height', { integer: true, min: 2, even: true });
  const jpegQuality = requireNumber(preview, 'jpegQuality', 'preview.jpegQuality', { integer: true, min: 1 });

  const previewAudioRate = requireNumber(previewAudio, 'sampleRate', 'previewAudio.sampleRate', {
    integer: true,
    min: 8000
  });
  const previewAudioCodec = requireString(previewAudio, 'codec', 'previewAudio.codec');
  const previewAudioBitrate = requireString(previewAudio, 'bitrate', 'previewAudio.bitrate');

  const url = requireString(input, 'url', 'input.url');
  const kind = requireEnum(input, 'kind', 'input.kind', ['stream', 'file']);
  const pacing = requireEnum(input, 'pacing', 'input.pacing', SUPPORTED_PACING);
  if (kind === 'file' && pacing === 'realtime' && !fs.existsSync(fileUrlToPath(url))) {
    fail('DECODE_INPUT_MISSING', `decode input does not exist: ${url}`, { field: 'input.url' });
  }

  const drainMode = requireEnum(drain, 'mode', 'drain.mode', SUPPORTED_DRAIN_MODES);
  if (drain.eofFlush !== true) {
    fail(
      'DECODE_FIELD_INVALID',
      'decode plan drain.eofFlush must be true: buffered frames only reach the pipes after an explicit flush',
      { field: 'drain.eofFlush' }
    );
  }
  if (drain.flushPackets !== true) {
    fail(
      'DECODE_FIELD_INVALID',
      'decode plan drain.flushPackets must be true: pipes must be flushed per packet on live output',
      { field: 'drain.flushPackets' }
    );
  }

  return freezeDeep({
    adapterVersion: DECODE_ADAPTER_VERSION,
    sourceId: requireString(source, 'id', 'source.id'),
    label: requireString(source, 'label', 'source.label'),
    raster: { width, height },
    video: {
      pixelFormat,
      fpsMode,
      scaleFlags,
      timeBase: { num: 1, den: requireNumber(video, 'fps', 'video.fps', { min: 0.1 }) }
    },
    audio: {
      sampleRate,
      channels,
      sampleFormat,
      outputFormat,
      blockSamples,
      resampler,
      resamplerPrecision,
      timeBase: { num: 1, den: sampleRate }
    },
    preview: { fps: previewFps, width: previewWidth, height: previewHeight, jpegQuality },
    previewAudio: { sampleRate: previewAudioRate, codec: previewAudioCodec, bitrate: previewAudioBitrate },
    input: { url, kind, pacing },
    drain: { mode: drainMode, eofFlush: true, flushPackets: true },
    legacy: null
  });
}

// Converts the original program config (the shape SourceIngest accepted before
// the migration) into a 2.0.0 plan. Every implicit assumption of 1.0.0 is made
// explicit here, and recorded, instead of being copied as a hidden default.
export function migrateLegacyProgramConfig(source, legacy) {
  const cfg = requireObject(legacy, 'legacy');
  const raster = requireObject(cfg.raster, 'legacy.raster');
  const preview = requireObject(cfg.preview, 'legacy.preview');

  if (legacy.version !== undefined && legacy.version !== '1.0.0') {
    fail('DECODE_VERSION_UNSUPPORTED', `legacy program config declares version ${legacy.version}`, {
      field: 'version',
      supported: SUPPORTED_DECODE_ADAPTER_VERSIONS
    });
  }

  const url = requireString(cfg, 'url', 'legacy.url');
  const request = {
    version: DECODE_ADAPTER_VERSION,
    source: { id: source.id, label: source.label },
    raster: { width: raster.width, height: raster.height },
    video: {
      pixelFormat: 'yuv420p',
      fpsMode: 'passthrough',
      scaleFlags: 'bilinear',
      fps: requireNumber(cfg, 'fps', 'legacy.fps', { min: 0.1 })
    },
    audio: {
      sampleRate: requireNumber(cfg, 'audioRate', 'legacy.audioRate', { integer: true, min: 8000 }),
      channels: 2,
      sampleFormat: 's16',
      outputFormat: 's16le',
      blockSamples: requireNumber(cfg, 'audioBlockSamples', 'legacy.audioBlockSamples', { integer: true, min: 1 }),
      resampler: 'soxr',
      resamplerPrecision: 28
    },
    preview: {
      fps: requireNumber(preview, 'fps', 'legacy.preview.fps', { min: 0.1 }),
      width: requireNumber(preview, 'width', 'legacy.preview.width', { integer: true, min: 2, even: true }),
      height: requireNumber(preview, 'height', 'legacy.preview.height', { integer: true, min: 2, even: true }),
      jpegQuality: preview.jpegQuality === undefined ? 7 : preview.jpegQuality
    },
    previewAudio: { sampleRate: 48000, codec: 'libmp3lame', bitrate: '64k' },
    input: { url, kind: inputKindForUrl(url), pacing: 'realtime' },
    drain: { mode: 'eof-flush', eofFlush: true, flushPackets: true }
  };
  const plan = createDecodePlan(request);
  const migrated = {
    ...plan,
    legacy: {
      from: '1.0.0',
      convertedAt: new Date().toISOString(),
      assumed: [
        'video.pixelFormat=yuv420p',
        'video.fpsMode=passthrough',
        'audio.channels=2',
        'audio.sampleFormat=s16',
        'audio.resampler=soxr',
        'audio.resamplerPrecision=28',
        'previewAudio.sampleRate=48000',
        'input.pacing=realtime',
        'drain.mode=eof-flush'
      ]
    }
  };
  return freezeDeep(migrated);
}

// Single entry point used by SourceIngest. Accepts a 2.0.0 plan directly or the
// old program config, which must identify itself as version 1.0.0 (or be
// unmistakably the legacy shape).
export function resolveDecodePlan(source, options) {
  if (isPlainObject(options) && options.plan) return options.plan;
  if (!isPlainObject(options)) {
    fail('DECODE_FIELD_MISSING', `source ${source?.id ?? '?'} has no decode options`, { field: 'options' });
  }
  const looksLegacy =
    options.raster !== undefined ||
    options.audioRate !== undefined ||
    options.audioBlockSamples !== undefined;
  if (options.version !== undefined && options.version !== '1.0.0' && options.version !== DECODE_ADAPTER_VERSION) {
    fail('DECODE_VERSION_UNSUPPORTED', `unsupported decode adapter version ${options.version}`, {
      field: 'version',
      supported: SUPPORTED_DECODE_ADAPTER_VERSIONS
    });
  }
  if (looksLegacy) return migrateLegacyProgramConfig(source, options);
  fail(
    'DECODE_CONTRACT_MISSING',
    `source ${source?.id ?? '?'} must pass an explicit decode plan (adapter ${DECODE_ADAPTER_VERSION}) ` +
      'or a legacy 1.0.0 program config; refusing to guess defaults',
    { field: 'decode' }
  );
}

function fileUrlToPath(url) {
  if (/^file:\/\//i.test(url)) return fileURLToPath(url);
  return path.resolve(url);
}

// ffmpeg arguments for a plan. Kept beside the planner so the two cannot drift.
export function decodeArgs(plan) {
  if (!plan || plan.adapterVersion !== DECODE_ADAPTER_VERSION) {
    fail('DECODE_PLAN_INVALID', 'decodeArgs requires a 2.0.0 decode plan', { field: 'plan' });
  }
  const { raster, video, audio, preview, previewAudio, input } = plan;
  const videoChain = [
    `scale=${raster.width}:${raster.height}:force_original_aspect_ratio=decrease:flags=${video.scaleFlags}`,
    `pad=${raster.width}:${raster.height}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `format=${video.pixelFormat}`
  ].join(',');
  const audioChain = [
    `aformat=sample_fmts=${audio.sampleFormat}:channel_layouts=stereo`,
    `aresample=${audio.sampleRate}:resampler=${audio.resampler}` +
      (audio.resamplerPrecision === null ? '' : `:precision=${audio.resamplerPrecision}`)
  ].join(',');
  // Preview mirrors the program chain (same raster, aspect and SAR) and only
  // then downsamples for the multiview, matching what operators saw before the
  // migration.
  const previewChain = `${videoChain},scale=${preview.width}:${preview.height},fps=${preview.fps}`;

  const inputArgs = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-copyts', '-nostats'
  ];
  if (input.kind === 'stream') {
    inputArgs.push('-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '500000', '-analyzeduration', '1000000');
  }
  if (input.pacing === 'realtime') inputArgs.push('-re');
  inputArgs.push('-i', input.url);

  const flush = plan.drain.flushPackets ? ['-flush_packets', '1'] : [];
  return [
    ...inputArgs,
    '-map', '0:v:0', '-an', '-vf', videoChain, '-fps_mode', video.fpsMode,
    '-pix_fmt', video.pixelFormat, ...flush, '-f', 'rawvideo', `pipe:${DECODE_PIPES.video}`,
    '-map', '0:v:0', '-an', '-vf', videoChain, '-fps_mode', video.fpsMode,
    '-pix_fmt', video.pixelFormat, ...flush, '-f', 'framecrc', `pipe:${DECODE_PIPES.videoMeta}`,
    '-map', '0:a:0', '-vn',
    // Both audio pipes must agree on block boundaries: the payload pipe is read
    // as fixed-size blocks of `blockSamples`, so it is reblocked exactly like
    // the timestamp pipe. `p=1` pads the final block with silence at EOF, which
    // is the declared drain policy; without it the tail bytes have no timestamp
    // row and the last row has no samples.
    '-af', `${audioChain},asetnsamples=n=${audio.blockSamples}:p=1`,
    ...flush, '-f', audio.outputFormat, '-ar', String(audio.sampleRate), '-ac', String(audio.channels),
    `pipe:${DECODE_PIPES.audio}`,
    '-map', '0:a:0', '-vn',
    '-af', `${audioChain},asetnsamples=n=${audio.blockSamples}:p=1`,
    '-c:a', 'pcm_s16le', ...flush, '-f', 'framecrc', `pipe:${DECODE_PIPES.audioMeta}`,
    '-map', '0:v:0', '-an', '-vf', previewChain,
    '-c:v', 'mjpeg', '-q:v', String(preview.jpegQuality), ...flush, '-f', 'image2pipe',
    `pipe:${DECODE_PIPES.preview}`,
    '-map', '0:a:0', '-vn', '-af', `aresample=${previewAudio.sampleRate}`,
    '-c:a', previewAudio.codec, '-b:a', previewAudio.bitrate, ...flush, '-f', 'mp3',
    `pipe:${DECODE_PIPES.previewAudio}`
  ];
}

// Evidence object surfaced in kernel state and verification output. It restates
// the contract actually handed to ffmpeg rather than whatever a caller hoped.
export function planContract(plan) {
  if (!plan) return null;
  return {
    adapterVersion: plan.adapterVersion,
    legacyFrom: plan.legacy ? plan.legacy.from : null,
    pixelFormat: plan.video.pixelFormat,
    fpsMode: plan.video.fpsMode,
    videoTimeBase: `${plan.video.timeBase.num}/${plan.video.timeBase.den}`,
    audioTimeBase: `${plan.audio.timeBase.num}/${plan.audio.timeBase.den}`,
    audioSampleRate: plan.audio.sampleRate,
    audioOutputFormat: plan.audio.outputFormat,
    audioBlockSamples: plan.audio.blockSamples,
    resampler: plan.audio.resampler,
    drainMode: plan.drain.mode,
    inputKind: plan.input.kind,
    pacing: plan.input.pacing
  };
}

export function timeBaseLabel(timeBase) {
  if (!timeBase) return null;
  const seconds = timeBase.num / timeBase.den;
  return `${timeBase.num}/${timeBase.den} (${seconds.toPrecision(8)}s)`;
}

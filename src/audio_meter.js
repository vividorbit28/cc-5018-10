// Real audio metering for the operator UI.
//
// The old console animated its bars with CSS regardless of what was actually on
// the wire. These meters compute RMS and peak from the same s16le blocks the
// switcher passes to the encoder, so a silent program, a stalled source or a
// muted preview is visible as a number instead of a decoration.

const FLOOR_DB = -70;

export function createAudioMeter({ channels = 2, smoothing = 0.65 } = {}) {
  return {
    channels,
    smoothing,
    rms: 0,
    peak: 0,
    rmsDb: FLOOR_DB,
    peakDb: FLOOR_DB,
    blocks: 0,
    samples: 0,
    silentBlocks: 0,
    lastAt: null,
    updatedAt: null
  };
}

export function meterS16le(meter, buffer) {
  if (!buffer || buffer.length < 4) return meter;
  const samples = Math.floor(buffer.length / 2);
  const frames = Math.floor(samples / meter.channels);
  if (frames <= 0) return meter;

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < frames * meter.channels; i += 1) {
    const value = buffer.readInt16LE(i * 2) / 32768;
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sum / (frames * meter.channels));
  meter.rms = meter.rms * meter.smoothing + rms * (1 - meter.smoothing);
  meter.peak = Math.max(peak, meter.peak * 0.85);
  meter.rmsDb = toDb(meter.rms);
  meter.peakDb = toDb(meter.peak);
  meter.blocks += 1;
  meter.samples += frames;
  if (meter.peak < 1e-5) meter.silentBlocks += 1;
  meter.lastAt = Date.now();
  meter.updatedAt = meter.lastAt;
  return meter;
}

// MP3 monitor chunks cannot be metered without decoding, so they only advance a
// liveness timestamp. Missing PCM for longer than `staleMs` is reported as a
// fault rather than shown as a quiet signal.
export function meterHealth(meter, now, { staleMs = 1500 } = {}) {
  if (!meter.updatedAt) return { state: 'waiting', silentMs: null, detail: 'no audio blocks yet' };
  const ageMs = now - meter.updatedAt;
  if (ageMs > staleMs) {
    return { state: 'stale', silentMs: ageMs, detail: `no audio for ${ageMs}ms` };
  }
  if (meter.peak < 1e-5) return { state: 'silent', silentMs: ageMs, detail: 'program audio is silent' };
  return { state: 'live', silentMs: 0, detail: null };
}

export function toDb(amplitude) {
  if (!(amplitude > 0)) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(amplitude));
}

// Maps dBFS to a 0..1 bar height with the same floor as the meter.
export function dbToLevel(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

export function summarizeMeter(meter) {
  return {
    rmsDb: round1(meter.rmsDb),
    peakDb: round1(meter.peakDb),
    rmsLevel: round3(dbToLevel(meter.rmsDb)),
    peakLevel: round3(dbToLevel(meter.peakDb)),
    blocks: meter.blocks,
    samples: meter.samples,
    silentBlocks: meter.silentBlocks
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

#!/usr/bin/env node
// Generates the finite fixtures used by `npm run verify:fixtures`.
//
// Each file is a short, self-contained MPEG-TS clip at a different frame rate
// and audio sample rate. They exist so end-of-stream drain can be exercised on
// real files instead of a simulated transport: the decoder must flush its
// buffered frames, pair every frame with a timestamp, and report `eof` rather
// than a transport failure.
//
// Usage: node scripts/make_fixtures.js [--out dir] [--ffmpeg path]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(arg('--out', path.join(root, 'test/fixtures')));
const ffmpeg = arg('--ffmpeg', process.env.FFMPEG || path.join(root, 'node_modules/ffmpeg-static/ffmpeg'));

// Same three input shapes the show control ingests, so the fixtures cover the
// frame rates the switcher actually reconciles.
const CLIPS = [
  { name: 'src24.ts', width: 640, height: 360, fps: 24, sampleRate: 32000, tone: 880 },
  { name: 'src25.ts', width: 960, height: 540, fps: 25, sampleRate: 44100, tone: 440 },
  { name: 'src30.ts', width: 1280, height: 720, fps: 30, sampleRate: 48000, tone: 660 }
];

function encode(clip) {
  const file = path.join(outDir, clip.name);
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${clip.width}x${clip.height}:rate=${clip.fps}:duration=2`,
    '-f', 'lavfi', '-i', `sine=frequency=${clip.tone}:sample_rate=${clip.sampleRate}:duration=2`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-g', String(clip.fps), '-keyint_min', String(clip.fps), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(clip.sampleRate), '-ac', '2',
    // A non-zero start keeps the fixtures honest about sources whose first PTS
    // is not zero, which the ingest must map rather than assume.
    '-output_ts_offset', '1.4',
    '-f', 'mpegts', file
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg failed for ${clip.name}: ${err.trim()}`));
      else resolve(file);
    });
  });
}

fs.mkdirSync(outDir, { recursive: true });
for (const clip of CLIPS) {
  const file = await encode(clip);
  console.log(`  ${path.relative(root, file)}  ${clip.width}x${clip.height}@${clip.fps} ${clip.sampleRate}Hz ${clip.tone}Hz`);
}
console.log(`\nFixtures written to ${outDir}`);

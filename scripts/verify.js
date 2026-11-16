#!/usr/bin/env node
// End-to-end verification against a running show-control instance.
//
//   1. captures the program timeline (frame + sample counters) across a cut
//      and asserts both advance monotonically with no reset;
//   2. cuts to each source in turn, measures the dominant tone of the
//      *encoded program output* and samples the delivered program picture,
//      proving the picture and sound on air both match the kernel's selection;
//   3. decodes the delivered MPEG-TS/HLS with ffmpeg and fails on any decode
//      error or frame-count shortfall.
//
// Usage: node scripts/verify.js [--url http://127.0.0.1:8080] [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = arg('--url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
const ffmpeg = process.env.FFMPEG || path.join(root, 'node_modules/ffmpeg-static/ffmpeg');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function getState() {
  const res = await fetch(`${baseUrl}/api/state`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`state request failed: ${res.status}`);
  return res.json();
}

class Console {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.state = null;
    this.takes = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state' || msg.type === 'hello') this.state = msg.state;
      if (msg.type === 'take-result') this.takes.push(msg.result);
    });
  }

  async send(message) {
    await this.ready;
    this.ws.send(JSON.stringify(message));
  }

  close() {
    this.ws.close();
  }
}

async function take(client, sourceId, { timeoutMs = 8000 } = {}) {
  await client.send({ type: 'preview', source: sourceId });
  await sleep(150);
  await client.send({ type: 'take', source: sourceId });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (state.program.onAir === sourceId) return state;
    await sleep(120);
  }
  throw new Error(`take to ${sourceId} did not commit within ${timeoutMs}ms`);
}

function runFfmpeg(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (chunk) => out.push(chunk));
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out), err });
    });
  });
}

// Downloads the live archive into a temp dir and returns the file path.
async function downloadArchive() {
  const res = await fetch(`${baseUrl}/archive/program.ts`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`archive request failed: ${res.status}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcontrol-verify-'));
  const file = path.join(dir, 'program.ts');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { dir, file };
}

function toneMagnitude(samples, sampleRate, frequency) {
  // Goertzel over a Hamming-windowed analysis block.
  const n = samples.length;
  const k = Math.round((n * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    s0 = samples[i] * window + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

function classifyTone(f32le, expectedTone, candidateTones) {
  const samples = new Float32Array(
    f32le.buffer,
    f32le.byteOffset,
    Math.floor(f32le.length / 4)
  );
  if (samples.length < 4800) return { ok: false, detail: `too few samples: ${samples.length}` };
  const best = candidateTones
    .map((tone) => ({ tone, magnitude: toneMagnitude(samples, 48000, tone) }))
    .sort((a, b) => b.magnitude - a.magnitude)[0];
  return {
    ok: best.tone === expectedTone,
    detail: `expected ${expectedTone}Hz, strongest ${best.tone}Hz (m=${best.magnitude.toFixed(4)})`,
    best
  };
}

// Grabs the most recent JPEG from the delivered program monitor and averages its
// upper half. Each generated source has a distinct background colour, so this
// cheaply proves the program raster actually switched rather than only the label.
async function captureProgramColour() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl}/stream/program.mjpg`, { signal: controller.signal });
    const reader = res.body.getReader();
    let buffer = Buffer.alloc(0);
    while (buffer.length < 60000) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
    }
    reader.cancel().catch(() => {});
    const frames = [];
    const soi = Buffer.from([0xff, 0xd8]);
    const eoi = Buffer.from([0xff, 0xd9]);
    let index = 0;
    while (true) {
      const start = buffer.indexOf(soi, index);
      if (start < 0) break;
      const end = buffer.indexOf(eoi, start + 2);
      if (end < 0) break;
      frames.push(buffer.subarray(start, end + 2));
      index = end + 2;
    }
    if (!frames.length) return null;
    const jpeg = frames[frames.length - 1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcontrol-frame-'));
    const file = path.join(dir, 'frame.jpg');
    fs.writeFileSync(file, jpeg);
    const { out, code } = await runFfmpeg([
      '-hide_banner', '-nostdin', '-v', 'error', '-i', file,
      '-vf', 'crop=iw:ih/2:0:0,scale=1:1', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    if (code !== 0 || out.length < 3) return null;
    return [out[0], out[1], out[2]];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function colourDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

async function captureProgramAudio(ms = 2600) {
  const res = await fetch(`${baseUrl}/audio/program.mp3`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`program audio unavailable: ${res.status}`);
  const chunks = [];
  const reader = res.body.getReader();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => ({ timeout: true }))
    ]);
    if (result.timeout) break;
    if (result.done) break;
    chunks.push(Buffer.from(result.value));
  }
  reader.cancel().catch(() => {});
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'showcontrol-audio-')),
    'program.mp3'
  );
  fs.writeFileSync(file, Buffer.concat(chunks));
  const { out, code, err } = await runFfmpeg([
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'
  ]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (code !== 0 || out.length === 0) {
    throw new Error(`program audio decode failed: ${err.trim().slice(0, 160)}`);
  }
  return out;
}

async function decodeIntegrity(file, extraArgs = []) {
  const { code, err } = await runFfmpeg([
    '-hide_banner', '-nostdin', '-v', 'error', ...extraArgs, '-i', file, '-f', 'null', '-'
  ]);
  const errors = err
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: code === 0 && errors.length === 0, detail: errors.slice(0, 2).join(' | ') };
}

// The archive is appended to while it is fetched, so its tail may contain a
// partial GOP. Decode only up to a couple of seconds before the end of the
// media the file actually contains, measured from the file itself so a slow
// download cannot make the margin fall inside the still-being-written tail.
async function probeDuration(file) {
  const { err } = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file]);
  const match = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(err);
  if (!match) return null;
  const [, hh, mm, ss, frac] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(`0.${frac}`);
}

async function archiveIntegrity(file) {
  const duration = await probeDuration(file);
  if (!duration) return { ok: false, detail: 'could not read archive duration', seconds: 0 };
  const inspect = Math.max(1, duration - 2);
  const result = await decodeIntegrity(file, ['-t', inspect.toFixed(3)]);
  return { ...result, seconds: inspect };
}

async function frameCount(file) {
  const { out, code } = await runFfmpeg([
    '-hide_banner', '-nostdin', '-v', 'error', '-i', file,
    '-map', '0:v:0', '-f', 'framecrc', '-'
  ]);
  if (code !== 0) return 0;
  return out.toString().split('\n').filter((line) => /^0,/.test(line)).length;
}

async function main() {
  console.log(`\nShow-control verification against ${baseUrl}\n`);
  const probe = await getState();
  const sources = probe.sources;
  if (sources.length < 2) throw new Error('need at least two sources to verify a cut');

  // Let sources lock before starting.
  for (let i = 0; i < 60; i += 1) {
    const state = await getState();
    if (state.sources.every((s) => s.sync?.locked && s.sync?.online)) break;
    await sleep(250);
  }

  const client = new Console(wsUrl);
  await client.ready;

  const taken = [];
  for (const source of sources) {
    const before = await getState();
    if (before.program.onAir === source.id) continue;
    const state = await take(client, source.id);
    // Capture the delivered media while this source is actually on air, then
    // sample the timeline again once the cut has settled.
    const audio = await captureProgramAudio(2600);
    const colour = await captureProgramColour();
    taken.push({
      source,
      state: await getState(),
      audio,
      colour
    });
  }

  if (taken.length === 0) throw new Error('no cuts were performed');

  console.log('\n[1] program timeline continuity');
  const frames = taken.map((entry) => entry.state.program.frame);
  const samples = taken.map((entry) => entry.state.program.sample);
  const monotonicFrames = frames.every((value, i) => i === 0 || value > frames[i - 1]);
  const monotonicSamples = samples.every((value, i) => i === 0 || value > samples[i - 1]);
  check('program frame count advances across cuts', monotonicFrames, frames.join(' -> '));
  check('program sample count advances across cuts', monotonicSamples, samples.join(' -> '));
  check(
    'sample count stays frame-aligned (1920/frame)',
    taken.every((entry) => entry.state.program.sample === entry.state.program.frame * 1920)
  );

  const takeRecords = (await getState()).takeLog.filter((entry) => entry.kind === 'take');
  check('kernel recorded every cut', takeRecords.length >= taken.length, `${takeRecords.length} records`);
  check(
    'take records carry frame and sample positions',
    takeRecords.every((entry) => Number.isInteger(entry.programFrame) && Number.isInteger(entry.programSample))
  );

  console.log('\n[2] picture and audio on air match the selected source');
  const candidateTones = [...new Set(sources.map((s) => s.tone))];
  for (const entry of taken) {
    const result = classifyTone(entry.audio, entry.source.tone, candidateTones);
    check(
      `after TAKE to ${entry.source.label}: delivered program audio is ${entry.source.tone}Hz`,
      result.ok,
      result.detail
    );
    const expected = hexToRgb(entry.source.background);
    const actual = entry.colour;
    const distance = actual ? colourDistance(actual, expected) : Infinity;
    check(
      `after TAKE to ${entry.source.label}: program picture is ${entry.source.label}`,
      distance < 26,
      actual
        ? `background rgb(${actual.join(',')}) vs expected rgb(${expected.join(',')}), distance ${distance.toFixed(1)}`
        : 'could not sample program monitor'
    );
  }

  console.log('\n[3] delivered output is decodable');
  const lastArchive = await downloadArchive();
  const integrity = await archiveIntegrity(lastArchive.file);
  check(
    'completed program TS interval decodes without errors',
    integrity.ok,
    integrity.detail || `clean, ${integrity.seconds.toFixed(1)}s inspected`
  );
  const decodedFrames = await frameCount(lastArchive.file);
  check(
    'program TS contains decodable video frames',
    decodedFrames > 25,
    `${decodedFrames} frames`
  );
  fs.rmSync(lastArchive.dir, { recursive: true, force: true });

  const hlsRes = await fetch(`${baseUrl}/hls/index.m3u8`, { cache: 'no-store' });
  const manifest = hlsRes.ok ? await hlsRes.text() : '';
  check('HLS manifest is served', hlsRes.ok && manifest.includes('#EXTM3U'));
  const segments = manifest.split('\n').filter((line) => line.endsWith('.ts'));
  check('HLS manifest lists live segments', segments.length > 0, `${segments.length} segments`);
  if (segments.length) {
    const segmentUrl = `${baseUrl}/hls/${segments[segments.length - 1]}`;
    const segmentRes = await fetch(segmentUrl, { cache: 'no-store' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcontrol-seg-'));
    const file = path.join(dir, 'segment.ts');
    if (segmentRes.ok) fs.writeFileSync(file, Buffer.from(await segmentRes.arrayBuffer()));
    check('HLS segment downloads', segmentRes.ok && fs.statSync(file).size > 1000, `${fs.statSync(file).size} bytes`);
    if (segmentRes.ok) {
      const segIntegrity = await decodeIntegrity(file);
      check('HLS segment decodes without errors', segIntegrity.ok, segIntegrity.detail || 'clean');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  client.close();
  console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`} — ${pass} passed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nverification aborted:', error.message);
  process.exit(2);
});

import fs from 'node:fs';
import path from 'node:path';

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function timecodeFromFrames(frame, fps) {
  const totalSeconds = Math.floor(frame / fps);
  const ff = Math.floor(frame % fps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${String(ms).padStart(3, '0')}`;
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export class RingLog {
  constructor({ file, limit = 400 } = {}) {
    this.file = file;
    this.limit = limit;
    this.items = [];
    this.seq = 0;
    this.stream = null;
    if (file) {
      ensureDir(path.dirname(file));
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }

  append(entry) {
    const item = { seq: ++this.seq, wall: new Date().toISOString(), ...entry };
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    if (this.stream) this.stream.write(`${JSON.stringify(item)}\n`);
    return item;
  }

  tail(n = 60) {
    return this.items.slice(-n);
  }

  close() {
    if (this.stream) this.stream.end();
  }
}

export class AggregateLogger {
  // Collapses repeated decisions (fill/silence/drop) into periodic entries so the
  // operator log stays readable while counters remain exact.
  constructor({ log, minIntervalMs = 1000, onEntry = null } = {}) {
    this.log = log;
    this.minIntervalMs = minIntervalMs;
    this.onEntry = onEntry;
    this.pending = new Map();
    this.lastEmit = new Map();
  }

  note(key, entry, amount = 1, now = Date.now()) {
    const state = this.pending.get(key) || { amount: 0, entry };
    state.amount += amount;
    state.entry = { ...entry, amount: state.amount };
    this.pending.set(key, state);
    const last = this.lastEmit.get(key) || 0;
    if (now - last >= this.minIntervalMs) this.flush(key, now);
  }

  flush(key, now = Date.now()) {
    const state = this.pending.get(key);
    if (!state || state.amount === 0) return null;
    const item = this.log.append(state.entry);
    this.pending.delete(key);
    this.lastEmit.set(key, now);
    if (this.onEntry) this.onEntry(item);
    return item;
  }

  flushAll(now = Date.now()) {
    for (const key of [...this.pending.keys()]) this.flush(key, now);
  }
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

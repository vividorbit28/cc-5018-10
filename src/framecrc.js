// Parses ffmpeg's framecrc output so the switcher can read exact per-frame and
// per-audio-block source timestamps without a container parser.
//
// The header carries a rational time base (`#tb <stream>: num/den`). It is kept
// as a rational and also exposed as seconds-per-tick, because source rates are
// deliberately heterogeneous (24/25/30 fps, 32/44.1/48 kHz) and rounding a
// rational to a float once, at the edge, keeps every downstream conversion
// consistent.
export class FramecrcParser {
  constructor({ onRow, onError } = {}) {
    this.onRow = onRow;
    this.onError = onError;
    this.timeBase = null;
    this.timebase = null;
    this.buffer = '';
    this.rowCount = 0;
    this.errorCount = 0;
    this.lastError = null;
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.parseLine(line);
    }
  }

  // ffmpeg can exit with a final row that has no trailing newline. Drain it
  // explicitly instead of losing the last timestamp at end of stream.
  flush() {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.parseLine(line);
  }

  parseLine(line) {
    if (line.startsWith('#')) {
      this.parseHeader(line);
      return;
    }
    const row = this.parseRow(line);
    if (row) {
      this.rowCount += 1;
      if (this.onRow) this.onRow(row);
    } else {
      this.fail(`malformed framecrc row: ${line.slice(0, 120)}`);
    }
  }

  parseHeader(line) {
    const match = /^#tb\s+(\d+):\s*(\d+)\/(\d+)\s*$/.exec(line);
    if (!match) return;
    const stream = Number(match[1]);
    const num = Number(match[2]);
    const den = Number(match[3]);
    if (!(num > 0) || !(den > 0)) {
      this.fail(`invalid framecrc time base: ${line}`);
      return;
    }
    if (this.timeBase) {
      if (this.timeBase.num !== num || this.timeBase.den !== den) {
        this.fail(`framecrc time base changed mid-stream: ${this.timeBase.num}/${this.timeBase.den} -> ${num}/${den}`);
      }
      return;
    }
    this.timeBase = { stream, num, den };
    this.timebase = num / den;
  }

  parseRow(line) {
    if (!this.timeBase) {
      this.fail('framecrc row arrived before the time base header');
      return null;
    }
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 6) return null;
    const dts = Number(parts[1]);
    const pts = Number(parts[2]);
    const duration = Number(parts[3]);
    const size = Number(parts[4]);
    if (!Number.isFinite(dts) || !Number.isFinite(pts) || !Number.isFinite(duration) || !Number.isFinite(size)) {
      return null;
    }
    const tb = this.timebase;
    return {
      dts,
      pts,
      duration,
      size,
      tb,
      timeBase: { ...this.timeBase },
      ptsTime: pts * tb,
      durationTime: duration * tb
    };
  }

  fail(message) {
    this.errorCount += 1;
    this.lastError = message;
    if (this.onError) this.onError(message);
  }
}

// Parses ffmpeg's framecrc output so the switcher can read exact per-frame and
// per-audio-block source timestamps without a container parser.
export class FramecrcParser {
  constructor({ onRow } = {}) {
    this.onRow = onRow;
    this.timebase = null;
    this.buffer = '';
    this.sawHeader = false;
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (line.startsWith('#')) {
        this.parseHeader(line);
        continue;
      }
      const row = this.parseRow(line);
      if (row && this.onRow) this.onRow(row);
    }
  }

  parseHeader(line) {
    const match = /^#tb\s+\d+:\s*(\d+)\/(\d+)$/.exec(line);
    if (match) {
      this.timebase = Number(match[1]) / Number(match[2]);
      this.sawHeader = true;
    }
  }

  parseRow(line) {
    if (!this.timebase) return null;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) return null;
    const dts = Number(parts[1]);
    const pts = Number(parts[2]);
    const duration = Number(parts[3]);
    const size = Number(parts[4]);
    if (!Number.isFinite(pts) || !Number.isFinite(duration)) return null;
    const tb = this.timebase;
    return {
      dts,
      pts,
      duration,
      size,
      tb,
      ptsTime: pts * tb,
      durationTime: duration * tb
    };
  }
}

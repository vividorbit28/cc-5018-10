import { createCanvas } from '@napi-rs/canvas';
import { timecodeFromFrames } from './util.js';

const STRIP_HEIGHT_RATIO = 0.155;

// Renders the program overlay and composites it onto source frames. Source
// video arrives as full-raster yuv420p, so only the overlay strip and badges are
// converted from RGBA; the rest is a straight plane copy.
export class Compositor {
  constructor({ width, height, fps }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.stripHeight = Math.round(height * STRIP_HEIGHT_RATIO / 2) * 2;
    this.stripTop = height - this.stripHeight;
    this.canvas = createCanvas(width, this.stripHeight);
    this.ctx = this.canvas.getContext('2d');
    this.badgeCanvas = createCanvas(Math.round(width * 0.30), Math.round(height * 0.09));
    this.badgeCtx = this.badgeCanvas.getContext('2d');
    this.slateCanvas = createCanvas(width, height);
    this.slateCtx = this.slateCanvas.getContext('2d');
    this.stripRgba = Buffer.alloc(width * this.stripHeight * 4);
    this.badgeRgba = Buffer.alloc(this.badgeCanvas.width * this.badgeCanvas.height * 4);
    this.stripYuv = Buffer.alloc(width * this.stripHeight * 3 / 2);
    this.badgeYuv = Buffer.alloc(this.badgeCanvas.width * this.badgeCanvas.height * 3 / 2);
    this.staticSlate = null;
    this.frameScratch = Buffer.alloc(0);
    this.previewOut = Buffer.alloc(width * height * 3 / 2);
  }

  // Full-frame slate used before any source is available and for offline takes.
  renderSlate({ title, subtitle, detail, accent }) {
    const { width, height, slateCtx: g } = this;
    const grad = g.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#0a1018');
    grad.addColorStop(1, '#111c2b');
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 2;
    for (let x = 0; x < width; x += 64) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
    for (let y = 0; y < height; y += 64) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.stroke();
    }
    g.fillStyle = accent || '#ff5f5f';
    g.fillRect(0, 0, width, 8);
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(height * 0.075)}px "DejaVu Sans"`;
    g.fillText(title, width / 2, height * 0.44);
    g.fillStyle = '#9db4c9';
    g.font = `${Math.round(height * 0.035)}px "DejaVu Sans"`;
    g.fillText(subtitle, width / 2, height * 0.52);
    if (detail) {
      g.fillStyle = '#6f8aa3';
      g.font = `${Math.round(height * 0.026)}px "DejaVu Sans"`;
      g.fillText(detail, width / 2, height * 0.575);
    }
    const rgba = slatetoRgba(g, width, height);
    return rgbaToI420(rgba, width, height);
  }

  drawStrip({ sourceLabel, role, accent, frameIndex, programPts, audioLabel, onAir, takeInfo, bufferLabel }) {
    const { width, stripHeight, ctx: g } = this;
    const h = stripHeight;
    g.clearRect(0, 0, width, h);
    g.fillStyle = 'rgba(6,11,18,0.93)';
    g.fillRect(0, 0, width, h);
    g.fillStyle = accent;
    g.fillRect(0, 0, width, 4);

    const pad = Math.round(width * 0.018);
    const bigSize = Math.round(h * 0.30);
    const midSize = Math.round(h * 0.18);
    const smallSize = Math.round(h * 0.145);

    // Left: on-air tally and source label.
    g.fillStyle = onAir ? '#ff3b3b' : '#20364a';
    g.beginPath();
    const tallyW = Math.round(width * 0.055);
    const tallyH = Math.round(h * 0.34);
    this.roundedRect(g, pad, Math.round(h * 0.20), tallyW, tallyH, 6);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(tallyH * 0.52)}px "DejaVu Sans"`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(onAir ? 'PGM' : 'PVW', pad + tallyW / 2, Math.round(h * 0.20) + tallyH / 2 + 1);

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff';
    g.font = `bold ${bigSize}px "DejaVu Sans"`;
    g.fillText(sourceLabel, pad + tallyW + pad * 0.7, Math.round(h * 0.40));
    g.fillStyle = '#8fa9c0';
    g.font = `${smallSize}px "DejaVu Sans"`;
    g.fillText(role, pad + tallyW + pad * 0.7, Math.round(h * 0.62));

    // Middle: timecode and frame count.
    const tcx = width * 0.40;
    g.fillStyle = '#7f97ad';
    g.font = `${smallSize}px "DejaVu Sans"`;
    g.fillText('PROGRAM TC', tcx, Math.round(h * 0.28));
    g.fillStyle = '#ffd166';
    g.font = `bold ${midSize}px "DejaVu Sans Mono"`;
    g.fillText(timecodeFromFrames(frameIndex, this.fps), tcx, Math.round(h * 0.58));
    g.fillStyle = '#6f8aa3';
    g.font = `${smallSize}px "DejaVu Sans Mono"`;
    g.fillText(`FRAME ${String(frameIndex).padStart(7, '0')}  PTS ${programPts.toFixed(3)}s`, tcx, Math.round(h * 0.82));

    // Right: audio source and buffer health.
    const rx = width * 0.70;
    g.fillStyle = '#8fa9c0';
    g.font = `${smallSize}px "DejaVu Sans"`;
    g.fillText('AUDIO', rx, Math.round(h * 0.28));
    g.fillStyle = '#ffffff';
    g.font = `bold ${smallSize}px "DejaVu Sans"`;
    g.fillText(audioLabel, rx, Math.round(h * 0.50));
    g.fillStyle = '#7f97ad';
    g.font = `${smallSize}px "DejaVu Sans Mono"`;
    g.fillText(bufferLabel, rx, Math.round(h * 0.72));
    if (takeInfo) {
      g.fillStyle = '#ffd166';
      g.font = `${smallSize}px "DejaVu Sans Mono"`;
      g.fillText(takeInfo, rx, Math.round(h * 0.90));
    }

    const rgba = this.ctx.getImageData(0, 0, width, h).data;
    this.stripRgba.set(rgba);
    rgbaToI420Into(this.stripRgba, width, h, this.stripYuv);
  }

  roundedRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // Produces a program frame: base source frame (or slate) with the overlay
  // strip composited in. Returns a fresh Buffer owned by the caller.
  compose(baseYuv, overlay) {
    const { width, height } = this;
    const frameBytes = width * height * 3 / 2;
    const out = Buffer.allocUnsafe(frameBytes);
    if (baseYuv) baseYuv.copy(out, 0, 0, frameBytes);
    else out.fill(16, 0, width * height), out.fill(128, width * height);

    this.drawStrip(overlay);
    const stripY = this.stripYuv;
    const stripH = this.stripHeight;
    const stripTop = this.stripTop;
    // Luma rows.
    stripY.copy(out, stripTop * width, 0, width * stripH);
    // Chroma planes (strip height and top are even, so rows align).
    const chromaOffset = width * height;
    const stripChromaOffset = width * stripH;
    const chromaW = width / 2;
    const stripChromaRows = stripH / 2;
    stripY.copy(
      out,
      chromaOffset + (stripTop / 2) * chromaW,
      stripChromaOffset,
      stripChromaOffset + chromaW * stripChromaRows
    );
    stripY.copy(
      out,
      chromaOffset + chromaW * (height / 2) + (stripTop / 2) * chromaW,
      stripChromaOffset + chromaW * stripChromaRows,
      stripChromaOffset + chromaW * stripChromaRows * 2
    );
    return out;
  }

  // Small JPEG used for the program monitor when no encoder preview exists.
  slateJpeg(width, height) {
    const canvas = createCanvas(width, height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#0a1018';
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#ff5f5f';
    g.font = `bold ${Math.round(height * 0.09)}px "DejaVu Sans"`;
    g.textAlign = 'center';
    g.fillText('NO PROGRAM', width / 2, height / 2);
    return canvas.toBuffer('image/jpeg', 70);
  }
}

function slatetoRgba(g, width, height) {
  const data = g.getImageData(0, 0, width, height).data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function rgbaToI420(rgba, width, height) {
  const out = Buffer.allocUnsafe(width * height * 3 / 2);
  rgbaToI420Into(rgba, width, height, out);
  return out;
}

export function rgbaToI420Into(rgba, width, height, out) {
  const yPlane = width * height;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const p = (row + x) * 4;
      out[row + x] = (66 * rgba[p] + 129 * rgba[p + 1] + 25 * rgba[p + 2] + 128) >> 8;
    }
  }
  let u = yPlane;
  let v = yPlane + (width / 2) * (height / 2);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const p = (y * width + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      out[u++] = clampByte(128 + ((-38 * r - 74 * g + 112 * b) >> 8));
      out[v++] = clampByte(128 + ((112 * r - 94 * g - 18 * b) >> 8));
    }
  }
  return out;
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

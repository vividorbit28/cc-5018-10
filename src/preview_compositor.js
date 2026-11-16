import { createCanvas, Image } from '@napi-rs/canvas';

// Preview/multiview compositor. This is presentation-only: the program raster
// is produced by Compositor and encoded by ProgramEncoder. Here we render the
// operator's preview tile (source image + preview tally + buffer health) as
// JPEG so the UI can show it without a second video pipeline.
export class PreviewCompositor {
  constructor({ width, height, fps }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  render({ sourceJpeg, source, available, leadMs, bufferFrames, locked, online, programFrame, previewIsProgram }) {
    const { width: w, height: h, ctx: g } = this;
    g.fillStyle = '#05080d';
    g.fillRect(0, 0, w, h);

    if (sourceJpeg) {
      try {
        const image = new Image();
        image.src = sourceJpeg;
        const scale = Math.min(w / image.width, h / image.height);
        const dw = image.width * scale;
        const dh = image.height * scale;
        g.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } catch {
        this.drawMissing(g, 'SIGNAL DECODE ERROR');
      }
    } else {
      this.drawMissing(g, online ? 'ACQUIRING' : 'NO SIGNAL');
    }

    const accent = source ? source.accent : '#7f97ad';
    g.fillStyle = 'rgba(4,8,13,0.78)';
    g.fillRect(0, 0, w, Math.round(h * 0.20));
    g.fillStyle = previewIsProgram ? '#ff3b3b' : accent;
    g.fillRect(0, 0, w, 3);

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = previewIsProgram ? '#ff6b6b' : '#ffffff';
    g.font = `bold ${Math.round(h * 0.085)}px "DejaVu Sans"`;
    g.fillText(source ? source.label : 'PREVIEW', Math.round(w * 0.03), Math.round(h * 0.10));

    g.fillStyle = '#a9bfd3';
    g.font = `${Math.round(h * 0.052)}px "DejaVu Sans"`;
    const detail = source
      ? `${source.width}x${source.height} · ${source.fps}fps · ${source.sampleRate / 1000}kHz`
      : '';
    g.fillText(detail, Math.round(w * 0.03), Math.round(h * 0.165));

    // Right-hand status block.
    g.textAlign = 'right';
    g.fillStyle = previewIsProgram ? '#ff6b6b' : accent;
    g.font = `bold ${Math.round(h * 0.06)}px "DejaVu Sans"`;
    g.fillText(previewIsProgram ? 'ON AIR' : 'PREVIEW', w - Math.round(w * 0.03), Math.round(h * 0.09));

    g.fillStyle = '#8fa9c0';
    g.font = `${Math.round(h * 0.05)}px "DejaVu Sans Mono"`;
    const buf = leadMs === null || leadMs === undefined ? '--' : `${Math.round(leadMs)}ms`;
    g.fillText(`BUF ${buf}`, w - Math.round(w * 0.03), Math.round(h * 0.155));

    // Bottom strip: lock/availability.
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(4,8,13,0.8)';
    g.fillRect(0, h - Math.round(h * 0.16), w, Math.round(h * 0.16));
    g.fillStyle = '#ffffff';
    g.font = `${Math.round(h * 0.052)}px "DejaVu Sans Mono"`;
    const status = !online ? 'OFFLINE · HOLD' : !locked ? 'LOCKING' : available ? 'SYNCED' : 'LATE';
    g.fillText(`${status}  F:${bufferFrames}  PGM ${String(programFrame).padStart(6, '0')}`, Math.round(w * 0.03), h - Math.round(h * 0.05));

    return this.canvas.toBuffer('image/jpeg', 72);
  }

  drawMissing(g, label) {
    const { width: w, height: h } = this;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 2;
    for (let x = -h; x < w; x += 26) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + h, 0);
      g.stroke();
    }
    g.fillStyle = '#5e7790';
    g.font = `bold ${Math.round(h * 0.07)}px "DejaVu Sans"`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }
}

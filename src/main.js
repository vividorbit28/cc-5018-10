import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Engine } from './engine.js';
import { ProgramEncoder } from './program_encoder.js';
import { SourceSimulator } from './source_simulator.js';
import { Server } from './server.js';
import { assertCompatibleFfmpeg, ffmpegStaticMismatch, mediaDependencyEvidence } from './media_runtime.js';
import { ensureDir } from './util.js';

function resolveFfmpeg() {
  if (config.ffmpeg) return config.ffmpeg;
  const candidates = [
    path.join(config.root, 'node_modules/ffmpeg-static/ffmpeg'),
    '/usr/bin/ffmpeg'
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('No ffmpeg binary found; set FFMPEG=/path/to/ffmpeg');
}

async function main() {
  const ffmpeg = resolveFfmpeg();
  // Fail before any pipe opens if the decoder on disk cannot honour the
  // adapter's contract. The probe reads the binary actually being executed.
  const probe = assertCompatibleFfmpeg(ffmpeg);
  const mismatch = ffmpegStaticMismatch(probe, config.root);
  if (mismatch) console.warn(`[show-control] media dependency warning: ${mismatch}`);
  const outDir = path.join(config.dataDir, 'output');
  ensureDir(outDir);

  const encoder = new ProgramEncoder({ ffmpeg, output: config.output, outDir });
  const engine = new Engine({ config, ffmpeg, dataDir: config.dataDir });
  engine.mediaDependency = {
    ...mediaDependencyEvidence(ffmpeg),
    adapterVersion: config.decode.adapterVersion,
    staticMismatch: mismatch
  };
  engine.attachEncoder(encoder);
  engine.attachSources({
    sources: config.sources,
    simulatorFactory: (source) => new SourceSimulator(source, { ffmpeg })
  });

  encoder.start();
  if (config.startSources) {
    await engine.startSources();
  }
  engine.startTicker();

  const server = new Server({
    config,
    engine,
    encoder,
    publicDir: path.join(config.root, 'public'),
    outDir
  });
  await server.start();

  const url = `http://${config.host}:${config.httpPort}/`;
  console.log('');
  console.log('  SHOW CONTROL — master control switcher');
  console.log('  -----------------------------------------');
  console.log(`  Control surface : ${url}`);
  console.log(`  Program HLS     : ${url}hls/index.m3u8`);
  console.log(`  Program archive : ${url}archive/program.ts`);
  console.log(`  Program monitor : ${url}stream/program.mjpg`);
  console.log(`  Output format   : ${config.output.width}x${config.output.height}@${config.output.fps} ${config.output.sampleRate} Hz`);
  console.log(
    `  Media decoder   : FFmpeg ${probe.version} (${probe.status}, decode adapter ${config.decode.adapterVersion})`
  );
  for (const source of config.sources) {
    console.log(
      `  Source ${source.label.padEnd(5)} : ${source.width}x${source.height}@${source.fps} ` +
        `${source.sampleRate}Hz ${source.tone}Hz tone on ${source.port}`
    );
  }
  console.log('  -----------------------------------------');
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\n[show-control] ${signal} received, shutting down`);
    try {
      await server.stop();
      await engine.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[show-control] fatal:', error);
  process.exit(1);
});

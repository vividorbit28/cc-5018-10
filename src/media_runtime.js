import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Verifies the media dependency that the running process actually uses, not the
// version a lockfile claims. A lock entry can say one thing while the binary on
// disk (or FFMPEG=) is another, so the switcher probes the executable itself and
// records the result as evidence.
//
// The target this project is validated against is FFmpeg 7.0.x from
// ffmpeg-static b6.1.1. 6.x is accepted (the adapter needs -fps_mode and
// -flush_packets, both present since 5.x) but flagged as `untested`, and
// anything older is rejected because the explicit pixel-format and drain
// contract cannot be honoured.

export const VALIDATED_FFMPEG = Object.freeze({
  source: 'ffmpeg-static@b6.1.1',
  major: 7,
  minor: 0,
  // Release asset names the binaries are built from.
  builds: Object.freeze({ linux: 'ffmpeg-7.0.2-amd64-static / ffmpeg-7.0.2-arm64-static' })
});

export const MINIMUM_SUPPORTED_MAJOR = 5;

const REQUIRED_FILTERS = ['scale', 'pad', 'setsar', 'format', 'aresample', 'asetnsamples', 'fps'];
const REQUIRED_ENCODERS = ['libx264', 'aac', 'libmp3lame', 'mjpeg'];

let cached = null;

export function probeFfmpeg(ffmpegPath, { force = false } = {}) {
  if (!force && cached && cached.path === ffmpegPath) return cached;

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    cached = {
      path: ffmpegPath || null,
      available: false,
      compatible: false,
      reason: `ffmpeg binary not found at ${ffmpegPath || '(unset)'}`
    };
    return cached;
  }

  let versionText = '';
  try {
    versionText = execFileSync(ffmpegPath, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000
    });
  } catch (error) {
    cached = {
      path: ffmpegPath,
      available: false,
      compatible: false,
      reason: `ffmpeg -version failed: ${error.message.split('\n')[0]}`
    };
    return cached;
  }

  const versionMatch = /ffmpeg version\s+(?:n?)?(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionText);
  const major = versionMatch ? Number(versionMatch[1]) : null;
  const minor = versionMatch ? Number(versionMatch[2]) : null;
  const patch = versionMatch && versionMatch[3] !== undefined ? Number(versionMatch[3]) : 0;
  const buildLine = versionText.split('\n').find((line) => /^built with|^configuration:/.test(line)) || '';
  const configuration = versionText
    .split('\n')
    .filter((line) => line.startsWith('configuration:'))
    .join(' ');

  const capabilities = probeCapabilities(ffmpegPath, configuration);
  const problems = [];
  if (major === null) problems.push('could not parse ffmpeg version');
  else if (major < MINIMUM_SUPPORTED_MAJOR) {
    problems.push(`ffmpeg ${major}.${minor} is older than the supported minimum ${MINIMUM_SUPPORTED_MAJOR}.x`);
  }
  if (major !== null && !capabilities.fpsMode) problems.push('missing -fps_mode');
  if (major !== null && !capabilities.flushPackets) problems.push('missing -flush_packets');
  for (const filter of REQUIRED_FILTERS) {
    if (!capabilities.filters.includes(filter)) problems.push(`missing filter ${filter}`);
  }
  for (const encoder of REQUIRED_ENCODERS) {
    if (!capabilities.encoders.includes(encoder)) problems.push(`missing encoder ${encoder}`);
  }

  const compatible = problems.length === 0;
  const validated = major === VALIDATED_FFMPEG.major && minor === VALIDATED_FFMPEG.minor;
  let status = 'validated';
  if (!compatible) status = 'incompatible';
  else if (!validated) status = 'untested';

  cached = {
    path: ffmpegPath,
    available: true,
    version: major === null ? null : `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
    validatedAgainst: `${VALIDATED_FFMPEG.source} (FFmpeg ${VALIDATED_FFMPEG.major}.${VALIDATED_FFMPEG.minor}.x)`,
    status,
    compatible,
    validated,
    build: buildLine.trim(),
    capabilities,
    problems
  };
  return cached;
}

function probeCapabilities(ffmpegPath, configuration) {
  const run = (args) => {
    try {
      return execFileSync(ffmpegPath, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000
      });
    } catch {
      return '';
    }
  };
  const help = run(['-hide_banner', '-h', 'full']);
  const filters = run(['-hide_banner', '-filters'])
    .split('\n')
    .map((line) => line.match(/^\s*[A-Z.]{3}\s+(\S+)\s+/))
    .filter(Boolean)
    .map((match) => match[1]);
  const encoders = run(['-hide_banner', '-encoders'])
    .split('\n')
    .map((line) => line.match(/^\s*[A-Z.]{6}\s+(\S+)\s+/))
    .filter(Boolean)
    .map((match) => match[1]);
  return {
    fpsMode: /\s-fps_mode\b/.test(help),
    flushPackets: /\s-flush_packets\b/.test(help),
    copyts: /\s-copyts\b/.test(help),
    soxr: /--enable-libsoxr/.test(configuration),
    filters,
    encoders
  };
}

// Used by main() at boot and by verification. Throws with every problem listed
// so a bad environment stops the show instead of decoding with a fallback.
export function assertCompatibleFfmpeg(ffmpegPath) {
  const probe = probeFfmpeg(ffmpegPath);
  if (!probe.compatible) {
    const detail = probe.problems?.length ? probe.problems.join('; ') : probe.reason;
    const error = new Error(
      `media decoder dependency is not usable: ${probe.path || 'unset'} — ${detail}. ` +
        `Expected ${VALIDATED_FFMPEG.source}.`
    );
    error.code = 'MEDIA_DEP_INCOMPATIBLE';
    error.probe = probe;
    throw error;
  }
  return probe;
}

export function mediaDependencyEvidence(ffmpegPath) {
  const probe = probeFfmpeg(ffmpegPath);
  return {
    executable: probe.path,
    version: probe.version || null,
    status: probe.status,
    validatedAgainst: probe.validatedAgainst,
    adapterVersion: null,
    problems: probe.problems || (probe.reason ? [probe.reason] : [])
  };
}

// ffmpeg-static ships a README beside the binary naming the build it contains.
// The release tag does not track the FFmpeg major (b6.1.1 contains FFmpeg
// 7.0.2), so the README is the trustworthy local statement of what was
// downloaded. A mismatch means the binary was replaced or the install is partial.
export function ffmpegStaticMismatch(probe, root) {
  const readmePath = path.join(root, 'node_modules/ffmpeg-static/ffmpeg.README');
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const declared = /^\s*version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(readme);
    if (!declared || !probe.version) return null;
    if (declared[1] !== probe.version) {
      return `ffmpeg-static README declares ${declared[1]} but the binary reports ${probe.version}`;
    }
    return null;
  } catch {
    return null;
  }
}

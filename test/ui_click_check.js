#!/usr/bin/env node
// Drives the real operator console against a running show-control instance.
//
// There is no browser runtime in this environment, so the console is loaded the
// way the browser would load it — the served index.html plus the served app.js,
// unchanged — inside jsdom, and the actual controls are clicked. Every value
// asserted here is produced by the console's own rendering code from kernel
// state, so this proves the control page calls the migrated kernel rather than
// reimplementing it.
//
// Usage: node test/ui_click_check.js [--url http://127.0.0.1:8080]
import { JSDOM } from 'jsdom';

const baseUrl = (process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:8080').replace(/\/$/, '');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  console.log(`\nConsole click-through against ${baseUrl}\n`);
  const html = await (await fetch(`${baseUrl}/`)).text();
  const appJs = await (await fetch(`${baseUrl}/app.js`)).text();

  // Build the page without executing its scripts, then run the console script
  // exactly as served so nothing about the UI logic is rewritten for the test.
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(stripped, {
    url: `${baseUrl}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.fetch = (input, init) => {
    const url = String(input);
    return fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, init);
  };
  const objectUrls = new Map();
  let objectUrlSeq = 0;
  window.URL.createObjectURL = (blob) => {
    objectUrlSeq += 1;
    const url = `blob:console/${objectUrlSeq}`;
    objectUrls.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = (url) => objectUrls.delete(url);
  window.HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  window.HTMLMediaElement.prototype.load = function load() {};

  window.eval(appJs);

  const $ = (id) => window.document.getElementById(id);
  await waitFor(() => $('conn-pill').dataset.state === 'open', { label: 'kernel WebSocket connection' });
  check('served console connects to the kernel over WebSocket', true, $('conn-pill').textContent);

  await waitFor(() => window.document.querySelectorAll('.source-card').length >= 2, {
    label: 'source cards rendered from kernel state'
  });
  const cards = [...window.document.querySelectorAll('.source-card')];
  check('console renders one card per kernel source', cards.length >= 2, `${cards.length} cards`);

  const nameOf = (card) => card.querySelector('.source-title strong').textContent.trim();
  const onAirName = () => $('stat-onair').textContent.trim();

  // Click a source thumbnail: the real preview control, not a synthetic event.
  // Pick a source that is not already on air so the TAKE below is an actual cut
  // rather than a no-op the kernel correctly refuses to record.
  const first = cards.find((card) => nameOf(card) !== onAirName()) || cards[0];
  const firstName = nameOf(first);
  first.querySelector('.source-thumb').click();
  await waitFor(() => $('preview-name').textContent.trim() === firstName, {
    label: `preview of ${firstName}`
  });
  check('clicking a source thumbnail sets the preview monitor', true, `${firstName} on PVW`);

  // Watch the preview picture arrive through the console's own frame channel.
  await waitFor(() => objectUrls.has($('preview-img').getAttribute('src')), {
    label: 'preview JPEG from kernel'
  });
  const previewBlob = objectUrls.get($('preview-img').getAttribute('src'));
  check(
    'preview monitor receives a real JPEG from the kernel',
    previewBlob?.type === 'image/jpeg' && previewBlob.size > 1000,
    `${previewBlob?.type}, ${previewBlob?.size} bytes`
  );

  // Click the card's TAKE: preview + take, the same path an operator uses.
  first.querySelector('[data-action="take"]').click();
  await waitFor(() => onAirName() === firstName, {
    label: `${firstName} on air`
  });
  check('pressing TAKE puts the previewed source on air', true, $('stat-onair').textContent);

  await waitFor(() => /已切入|拒绝/.test($('take-status').textContent), { label: 'take result reported' });
  const takeStatus = $('take-status').textContent;
  check(
    'console reports the cut with its program position',
    /已切入/.test(takeStatus) && /节目帧|时间码/.test(takeStatus),
    takeStatus.replace(/\s+/g, ' ').slice(0, 90)
  );

  // Program picture channel.
  await waitFor(() => objectUrls.has($('program-img').getAttribute('src')), {
    label: 'program JPEG from kernel'
  });
  const programBlob = objectUrls.get($('program-img').getAttribute('src'));
  check(
    'program monitor receives a real JPEG from the kernel',
    programBlob?.type === 'image/jpeg' && programBlob.size > 1000,
    `${programBlob?.type}, ${programBlob?.size} bytes`
  );

  // Program audio: the console must show measured levels, never an animation.
  // Wait for a real level rather than the -70 dBFS floor that the program shows
  // for the instant between a take committing and the first audio block.
  const meterPeak = () => {
    const match = /(-?\d+(?:\.\d+)?)\s*\/\s*均/.exec($('audio-meter').textContent);
    return match ? Number(match[1]) : null;
  };
  await waitFor(() => meterPeak() !== null && meterPeak() > -60, {
    label: 'audible program dBFS in the meter'
  });
  const meterText = $('audio-meter').textContent;
  check('program audio readout shows measured dBFS', meterPeak() > -60, meterText);

  // Turn sound on so the meter reflects the monitored program output.
  $('audio-toggle').click();
  await waitFor(() => $('audio-toggle').textContent === '静音', { label: 'program audio enabled' });
  check('program audio enable button drives the real monitor element', $('audio-toggle').textContent === '静音');

  await sleep(600);
  const barHeights = () =>
    [...$('audio-bars').children].map((bar) => parseFloat(bar.style.height) || 0);
  // Levels are pushed continuously, but a single sample can land on a frame
  // where the kernel just reported a momentarily-silent block. Wait for the
  // meter to be live rather than judging one instant; if it never goes live the
  // fault text is part of the failure detail.
  const barsLive = () =>
    $('audio-bars').classList.contains('live') && barHeights().at(-1) > 20;
  try {
    await waitFor(barsLive, { timeoutMs: 6000, label: 'live meter bars' });
  } catch {
    // fall through so the assertions below report the real state
  }
  const bars = barHeights();
  check(
    'meter bars are driven by computed levels, not CSS animation',
    barsLive() && bars.at(-1) > bars[0],
    `heights ${bars.map((h) => h.toFixed(0)).join('/')}` +
      ($('audio-fault').hidden ? '' : ` · fault: ${$('audio-fault').textContent}`)
  );
  check('meter is marked live while the program carries signal', $('audio-bars').classList.contains('live'));
  check('live meter shows no audio fault', $('audio-fault').hidden, $('audio-fault').textContent);

  // Preview source audio evidence, rendered by the console itself.
  await waitFor(() => /dBFS|异常/.test($('preview-audio-health').textContent), {
    label: 'preview audio health'
  });
  const previewHealth = $('preview-audio-health').textContent;
  check(
    'preview monitor reports the previewed source audio',
    /预监源音频 .*dBFS/.test(previewHealth) || /异常/.test(previewHealth),
    previewHealth
  );

  // Exception path: a state message with a stale program audio meter must be
  // surfaced in the UI, not swallowed. Build it from the kernel's own snapshot
  // so the rest of the page keeps rendering normally.
  const baseState = await (await fetch(`${baseUrl}/api/state`)).json();
  window.handleControlMessage({
    type: 'state',
    state: {
      ...baseState,
      audio: {
        program: {
          ...(baseState.audio?.program || {}),
          meter: { rmsDb: -70, peakDb: -70, rmsLevel: 0, peakLevel: 0, blocks: 12, samples: 23040 },
          health: { state: 'stale', silentMs: 2400, detail: 'no audio for 2400ms' }
        }
      }
    }
  });
  check(
    'console surfaces a program audio fault instead of hiding it',
    !$('audio-fault').hidden && /节目音频中断/.test($('audio-fault').textContent),
    $('audio-fault').textContent
  );
  check('fault state is exposed on the element for styling', $('audio-fault').dataset.state === 'stale');

  // Silent preview health must also be visible.
  window.handleControlMessage({
    type: 'state',
    state: {
      ...baseState,
      preview: { ...(baseState.preview || {}), audio: { source: { rmsDb: -70, peakDb: -70 }, health: { state: 'silent', detail: 'program audio is silent' } } }
    }
  });
  check(
    'console surfaces a silent preview audio state',
    /异常/.test($('preview-audio-health').textContent) &&
      $('preview-audio-health').dataset.state === 'silent',
    $('preview-audio-health').textContent
  );

  console.log(`\n${fail === 0 ? 'ALL CONSOLE CHECKS PASSED' : `${fail} CONSOLE CHECK(S) FAILED`} — ${pass} passed\n`);
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nconsole check aborted:', error.message);
  process.exit(2);
});

// Operator console. Every control goes through the show-control kernel over the
// WebSocket command channel; every displayed value comes back from the kernel
// state, never from local guesses. If the kernel refuses a take, the refusal is
// shown here and written into the kernel's take history.
const $ = (id) => document.getElementById(id);

const els = {
  connPill: $('conn-pill'),
  programTc: $('program-tc'),
  programFrame: $('program-frame'),
  programPts: $('program-pts'),
  programSample: $('program-sample'),
  outFormat: $('out-format'),
  outLag: $('out-lag'),
  sourceList: $('source-list'),
  sourceSummary: $('source-summary'),
  previewImg: $('preview-img'),
  programImg: $('program-img'),
  previewName: $('preview-name'),
  previewMeta: $('preview-meta'),
  programMeta: $('program-meta'),
  takeBtn: $('take-btn'),
  takeTarget: $('take-target'),
  takeStatus: $('take-status'),
  selPreviewSource: $('sel-preview-source'),
  statOnAir: $('stat-onair'),
  statPvw: $('stat-pvw'),
  statLag: $('stat-lag'),
  statBuffer: $('stat-buffer'),
  onairCounters: $('onair-counters'),
  pendingTake: $('pending-take'),
  takeLog: $('take-log'),
  decisionLog: $('decision-log'),
  warningLog: $('warning-log'),
  warnCount: $('warn-count'),
  programStateLabel: $('program-state-label'),
  programVideo: $('program-video'),
  playerNote: $('player-note'),
  programAudio: $('program-audio'),
  audioSourceLabel: $('audio-source-label'),
  audioBars: $('audio-bars'),
  audioMeter: $('audio-meter'),
  audioFault: $('audio-fault'),
  audioToggle: $('audio-toggle'),
  previewAudioHealth: $('preview-audio-health'),
  uptime: $('uptime'),
};

const app = {
  state: null,
  ctrl: null,
  programWs: null,
  previewWs: null,
  ctrlRetry: 0,
  frameUrls: { program: null, preview: null },
  takeStatusTimer: null,
  audioStarted: false,
  sourceCards: new Map(),
  lastDecisionSeq: 0,
  lastWarningSeq: 0,
};

const KIND_LABEL = {
  fill: '补帧',
  drop: '丢帧',
  'audio-drop': '音频丢样',
  silence: '静音',
  take: '切换',
  'source-locked': '源锁定',
  'source-down': '源断开',
  'source-stall': '源停顿',
  'ingest-start': '输入启动',
  'ingest-restart': '输入重建',
};

const DECISION_CLASSES = new Set([
  'fill', 'drop', 'audio-drop', 'silence', 'take', 'source-locked',
  'source-down', 'source-stall', 'ingest-start', 'ingest-restart'
]);

// ---------------------------------------------------------------- connection

function setConn(state, text) {
  els.connPill.dataset.state = state;
  els.connPill.textContent = text;
}

function connectControl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  app.ctrl = ws;
  setConn('connecting', '连接中');

  ws.onopen = () => {
    app.ctrlRetry = 0;
    setConn('open', '已连接内核');
    ws.send(JSON.stringify({ type: 'state' }));
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControlMessage(msg);
  };
  ws.onclose = () => {
    setConn('closed', '内核断开');
    app.ctrlRetry = Math.min(app.ctrlRetry + 1, 6);
    setTimeout(connectControl, 500 * app.ctrlRetry);
  };
  ws.onerror = () => setConn('closed', '连接错误');
}

function send(msg) {
  if (!app.ctrl || app.ctrl.readyState !== WebSocket.OPEN) {
    flashTakeStatus('内核未连接，命令未送达', 'err');
    return false;
  }
  app.ctrl.send(JSON.stringify(msg));
  return true;
}

function connectFrames(kind, onJpeg) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', kind }));
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return;
    const view = new Uint8Array(event.data);
    let newline = -1;
    for (let i = 0; i < Math.min(view.length, 256); i += 1) {
      if (view[i] === 0x0a) {
        newline = i;
        break;
      }
    }
    if (newline < 0) return;
    const payload = new Blob([view.subarray(newline + 1)], { type: 'image/jpeg' });
    if (app.frameUrls[kind]) URL.revokeObjectURL(app.frameUrls[kind]);
    app.frameUrls[kind] = URL.createObjectURL(payload);
    onJpeg(app.frameUrls[kind]);
  };
  ws.onclose = () => setTimeout(() => connectFrames(kind, onJpeg), 1000);
  return ws;
}

// ---------------------------------------------------------------- messages

function handleControlMessage(msg) {
  switch (msg.type) {
    case 'hello':
    case 'state':
      applyState(msg.state);
      break;
    case 'take-result':
      reportTake(msg.result);
      break;
    case 'decision':
      appendDecision(msg.entry);
      break;
    case 'warning':
      appendWarning(msg.entry);
      break;
    case 'command-result':
      if (msg.command === 'preview' && !msg.result?.ok) {
        flashTakeStatus(msg.result?.message || '预监失败', 'err');
      }
      if (msg.command === 'reconnect' && msg.result?.ok) {
        flashTakeStatus('已请求重建输入连接（节目时钟不重置）', 'pending');
      }
      if (msg.command === 'stall' && msg.result?.ok) {
        flashTakeStatus('已模拟信号源停顿，观察补帧/静音计数', 'pending');
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- rendering

function applyState(state) {
  if (!state) return;
  app.state = state;
  const p = state.program;

  els.programTc.textContent = p.timecode;
  els.programFrame.textContent = `FRAME ${String(p.frame).padStart(7, '0')}`;
  els.programPts.textContent = `PTS ${p.pts.toFixed(3)}s`;
  els.programSample.textContent = p.sample.toLocaleString('en-US');
  els.outFormat.textContent = `${p.width}x${p.height}@${p.fps} · ${(p.sampleRate / 1000).toFixed(1)} kHz`;
  els.outLag.textContent = `编码延迟 ${p.encoderLagMs}ms`;

  els.previewName.textContent = p.previewLabel || '—';
  els.statOnAir.textContent = p.onAirLabel || '未切入';
  els.statPvw.textContent = p.previewLabel || '—';
  els.statLag.textContent = `${p.encoderLagMs}ms`;
  els.programStateLabel.textContent = p.onAirLabel ? `${p.onAirLabel} 播出中` : '未切入';

  renderSources(state.sources);
  renderTakeLog(state.takeLog, state.sources);
  renderDecisionLog(state.decisionLog);
  renderWarnings(state.warnings);
  renderOnAir(state);

  const onAirSource = state.sources.find((s) => s.onAir);
  els.statBuffer.textContent = onAirSource?.sync
    ? `${Math.round(onAirSource.sync.leadMs ?? 0)}ms · ${onAirSource.sync.bufferFrames}F`
    : '—';
  els.audioSourceLabel.textContent = onAirSource
    ? `${onAirSource.label} · ${onAirSource.tone} Hz · ${onAirSource.sampleRate / 1000} kHz 输入`
    : '无节目音频';

  renderAudio(state);
  renderPreviewMeta(state);

  // Take button reflects the kernel's pending-take state, not local intent.
  const previewId = p.preview;
  const canTake = Boolean(previewId) && previewId !== p.onAir && !p.pendingTake;
  els.takeBtn.disabled = !canTake;
  els.takeTarget.textContent = previewId ? labelOf(state.sources, previewId) : '—';
  els.selPreviewSource.disabled = !previewId && !state.sources.length;

  if (p.pendingTake) {
    els.pendingTake.hidden = false;
    els.pendingTake.textContent =
      `TAKE 等待中：${p.pendingTake.label} 正在锁定，超时会被内核拒绝并记入切换记录`;
  } else {
    els.pendingTake.hidden = true;
  }
}

function labelOf(sources, id) {
  return sources.find((s) => s.id === id)?.label || id;
}

function renderAudio(state) {
  // Bars and readout reflect the dBFS the kernel measured from the exact
  // samples handed to the encoder. They are not an animation: a silent or stale
  // program shows an empty meter and the reason below it.
  const audio = state.audio?.program || {};
  const meter = audio.meter || {};
  const health = audio.health || { state: 'waiting', detail: '等待音频' };
  const level = app.audioStarted ? meter.peakLevel ?? 0 : 0;
  const bars = els.audioBars.children;
  for (let i = 0; i < bars.length; i += 1) {
    const threshold = (i + 1) / bars.length;
    bars[i].style.height = `${Math.max(6, Math.round(Math.min(1, level) * threshold * 100))}%`;
  }
  els.audioBars.classList.toggle('live', app.audioStarted && health.state === 'live');
  els.audioBars.classList.toggle('muted', !app.audioStarted || health.state !== 'live');
  els.audioMeter.textContent =
    meter.rmsDb === undefined ? '-- dBFS' : `${meter.peakDb.toFixed(1)} / 均 ${meter.rmsDb.toFixed(1)} dBFS`;

  const fault =
    health.state === 'live'
      ? null
      : health.state === 'waiting'
        ? '节目音频尚未开始输出'
        : health.state === 'stale'
          ? `节目音频中断：${health.detail}`
          : `节目音频静音：${health.detail}${audio.error ? ` · ${audio.error}` : ''}`;
  els.audioFault.hidden = !fault;
  els.audioFault.textContent = fault || '';
  els.audioFault.dataset.state = health.state;
}

function renderPreviewMeta(state) {
  const preview = state.preview || {};
  const health = preview.audio?.health || { state: 'waiting', detail: '预监源音频未就绪' };
  const meter = preview.audio?.source;
  const label = health.state === 'live' && meter
    ? `预监源音频 ${meter.rmsDb.toFixed(1)} dBFS`
    : `预监源音频异常：${health.detail}`;
  els.previewAudioHealth.textContent = label;
  els.previewAudioHealth.dataset.state = health.state;
}

function renderSources(sources) {
  const seen = new Set();
  for (const source of sources) {
    seen.add(source.id);
    let card = app.sourceCards.get(source.id);
    if (!card) {
      card = buildSourceCard(source);
      app.sourceCards.set(source.id, card);
      els.sourceList.appendChild(card.root);
    }
    updateSourceCard(card, source);
  }
  for (const [id, card] of app.sourceCards) {
    if (!seen.has(id)) {
      card.root.remove();
      app.sourceCards.delete(id);
    }
  }
  els.sourceSummary.textContent = `${sources.length} 路输入 · 独立时钟`;
}

function buildSourceCard(source) {
  const root = document.createElement('article');
  root.className = 'source-card';
  root.innerHTML = `
    <div class="source-thumb" data-action="preview">
      <img alt="${source.label} 输入" />
      <div class="source-tags"></div>
    </div>
    <div class="source-body">
      <div class="source-title">
        <strong>${source.label}</strong>
        <span class="source-spec"></span>
      </div>
      <div class="source-metrics">
        <div class="c-buf"><b>--</b>缓冲 ms</div>
        <div class="c-fill"><b>0</b>补帧</div>
        <div class="c-drop"><b>0</b>丢帧</div>
        <div class="c-sil"><b>0</b>静音</div>
        <div><b class="c-lock">--</b>锁定</div>
        <div><b class="c-state">--</b>连接</div>
      </div>
      <div class="source-actions">
        <button class="btn small" data-action="preview">预监</button>
        <button class="btn small" data-action="take">TAKE</button>
        <button class="btn small ghost" data-action="reconnect" title="重建输入连接，节目时钟不重置">重建</button>
        <button class="btn small warn" data-action="stall" title="模拟该路信号源停顿 1.5 秒">停顿</button>
      </div>
    </div>`;
  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'preview') send({ type: 'preview', source: source.id });
    else if (action === 'take') {
      send({ type: 'preview', source: source.id });
      send({ type: 'take', source: source.id });
    } else if (action === 'reconnect') send({ type: 'reconnect', source: source.id });
    else if (action === 'stall') send({ type: 'stall', source: source.id, ms: 1500 });
  });
  const img = root.querySelector('img');
  img.src = source.previewUrl;
  img.onerror = () => {
    setTimeout(() => {
      img.src = `${source.previewUrl}?t=${Date.now()}`;
    }, 2000);
  };
  return {
    root,
    img,
    spec: root.querySelector('.source-spec'),
    tags: root.querySelector('.source-tags'),
    buf: root.querySelector('.c-buf b'),
    fill: root.querySelector('.c-fill b'),
    drop: root.querySelector('.c-drop b'),
    sil: root.querySelector('.c-sil b'),
    lock: root.querySelector('.c-lock'),
    state: root.querySelector('.c-state'),
  };
}

function updateSourceCard(card, source) {
  const sync = source.sync || {};
  const counters = sync.counters || {};
  card.root.classList.toggle('is-onair', source.onAir);
  card.root.classList.toggle('is-preview', source.previewed && !source.onAir);

  card.spec.textContent =
    `${source.width}x${source.height} · ${source.fps}fps · ${(source.sampleRate / 1000).toFixed(1)}kHz · ${source.tone}Hz`;

  const tags = [];
  if (source.onAir) tags.push('<span class="tag pgm">PGM</span>');
  if (source.previewed) tags.push('<span class="tag pvw">PVW</span>');
  if (source.ingestState !== 'online') {
    tags.push(`<span class="tag offline">${escapeHtml(source.ingestState || 'offline')}</span>`);
  }
  card.tags.innerHTML = tags.join('');

  card.buf.textContent = sync.leadMs === null || sync.leadMs === undefined ? '--' : Math.round(sync.leadMs);
  card.fill.textContent = counters.fills ?? 0;
  card.drop.textContent = counters.drops ?? 0;
  card.sil.textContent = counters.silenceEvents ?? 0;
  card.lock.textContent = sync.locked ? (sync.online ? '是' : '保持') : sync.online ? '锁定中' : '否';
  card.state.textContent = source.simulator?.status || source.ingestState || '--';

  const takeBtn = card.root.querySelector('[data-action="take"]');
  takeBtn.disabled = source.onAir || !sync.online || !sync.locked;
}

function renderOnAir(state) {
  const onAir = state.sources.find((s) => s.onAir);
  if (!onAir) {
    els.onairCounters.innerHTML = '<span class="counter-chip">未切入节目</span>';
    els.programMeta.textContent = '无信号';
    return;
  }
  const c = onAir.sync?.counters || {};
  const s = onAir.sync || {};
  els.programMeta.textContent =
    `${onAir.label} · ${s.leadMs === null || s.leadMs === undefined ? '--' : Math.round(s.leadMs)}ms · ${s.bufferFrames ?? 0}F`;
  els.onairCounters.innerHTML = [
    chip('buffer', `缓冲 <b>${s.bufferFrames ?? 0}</b>F`),
    chip('', `锁定 <b>${s.locked ? '是' : '否'}</b>`),
    chip('', `音频缓冲 <b>${Math.round(s.audioBufferMs ?? 0)}</b>ms`),
    chip('', `最近音频 <b>${escapeHtml(s.audioStatus || '--')}</b>`),
    chip('fill', `补帧 <b>${c.fills ?? 0}</b>`),
    chip('drop', `丢帧 <b>${c.drops ?? 0}</b>`),
    chip('sil', `静音事件 <b>${c.silenceEvents ?? 0}</b> / <b>${(c.silenceSamples ?? 0).toLocaleString('en-US')}</b> 样本`),
  ].join('');
}

function chip(cls, html) {
  return `<span class="counter-chip ${cls}">${html}</span>`;
}

function renderTakeLog(entries, sources) {
  const rows = [...entries].reverse();
  if (rows.length === 0) {
    els.takeLog.innerHTML = '<tr><td colspan="7" class="dim">尚无切换记录</td></tr>';
    return;
  }
  els.takeLog.innerHTML = rows
    .map((entry) => {
      if (entry.kind === 'rejected') {
        return `<tr class="rejected"><td>—</td><td>${escapeHtml(entry.programTc || '')}</td>
          <td>${entry.programFrame ?? '—'}</td><td>${fmtNum(entry.programSample)}</td>
          <td colspan="3">拒绝：${escapeHtml(entry.message || entry.code || '')}（${escapeHtml(labelOf(sources, entry.source) || '')}）</td></tr>`;
      }
      return `<tr>
        <td>${entry.seq}</td>
        <td>${escapeHtml(entry.programTc || '')}</td>
        <td>${entry.programFrame}</td>
        <td>${fmtNum(entry.programSample)}</td>
        <td class="src">${escapeHtml(entry.fromLabel || 'BLACK')}</td>
        <td class="dst">${escapeHtml(entry.toLabel || '')}</td>
        <td>${entry.delayedMs ? `+${entry.delayedMs}ms` : '即时'}</td>
      </tr>`;
    })
    .join('');
}

function renderDecisionLog(entries) {
  const rows = [...entries].reverse().slice(0, 40);
  if (rows.length === 0) {
    els.decisionLog.innerHTML = '<li class="dim">等待内核事件…</li>';
    return;
  }
  els.decisionLog.innerHTML = rows.map(decisionRow).join('');
}

function decisionRow(entry) {
  const kind = DECISION_CLASSES.has(entry.kind) ? entry.kind : '';
  const label = KIND_LABEL[entry.kind] || entry.kind;
  const amount = entry.amount !== undefined && entry.amount !== null ? ` ×${entry.amount}` : '';
  const msg = entry.note || entry.message || '';
  const src = entry.label ? `[${entry.label}] ` : '';
  return `<li class="${kind}">
    <span class="t">${entry.programTc || shortTime(entry.wall)}</span>
    <span class="k">${escapeHtml(label)}${amount}</span>
    <span class="msg">${escapeHtml(src + msg)}</span>
  </li>`;
}

function appendDecision(entry) {
  if (!entry) return;
  const placeholder = els.decisionLog.querySelector('li.dim');
  if (placeholder) els.decisionLog.innerHTML = '';
  els.decisionLog.insertAdjacentHTML('afterbegin', decisionRow(entry));
  while (els.decisionLog.children.length > 60) els.decisionLog.lastElementChild.remove();
}

function renderWarnings(warnings) {
  els.warnCount.textContent = String(warnings.length);
  if (!warnings.length) {
    els.warningLog.innerHTML = '<li class="dim">无告警</li>';
    return;
  }
  els.warningLog.innerHTML = [...warnings]
    .reverse()
    .map(
      (w) => `<li><span class="t">${shortTime(w.at)}</span><span class="k">${escapeHtml(w.source || '')}</span>
        <span class="msg">${escapeHtml(w.line || '')}</span></li>`
    )
    .join('');
}

function appendWarning(warning) {
  if (!warning) return;
  const placeholder = els.warningLog.querySelector('li.dim');
  if (placeholder) els.warningLog.innerHTML = '';
  els.warningLog.insertAdjacentHTML(
    'afterbegin',
    `<li><span class="t">${shortTime(warning.at)}</span><span class="k">${escapeHtml(warning.source || '')}</span>
      <span class="msg">${escapeHtml(warning.line || '')}</span></li>`
  );
  if (app.state) {
    app.state.warnings = [...(app.state.warnings || []), warning].slice(-4);
    els.warnCount.textContent = String(app.state.warnings.length);
  }
}

function reportTake(result) {
  if (!result) return;
  if (result.ok) {
    const record = result.record;
    flashTakeStatus(
      `已切入 ${record.toLabel} · 时间码 ${record.programTc} · 节目帧 ${record.programFrame} · 样本 ${fmtNum(record.programSample)}`,
      'ok'
    );
    if (app.state) app.state.program.lastTake = record;
  } else {
    flashTakeStatus(`切换被内核拒绝：${result.message || result.code || '未知原因'}`, 'err');
  }
}

function flashTakeStatus(text, tone = '') {
  els.takeStatus.textContent = text;
  els.takeStatus.className = `take-status ${tone}`;
  if (app.takeStatusTimer) clearTimeout(app.takeStatusTimer);
  app.takeStatusTimer = setTimeout(() => {
    els.takeStatus.className = 'take-status';
    els.takeStatus.textContent = defaultTakeHint();
  }, 6000);
}

function defaultTakeHint() {
  const p = app.state?.program;
  if (p?.pendingTake) return `TAKE 等待 ${p.pendingTake.label} 锁定…`;
  return '选择预监源后按 TAKE 切入节目';
}

// ---------------------------------------------------------------- program media

let hls = null;

function startProgramFallback() {
  // No HLS support: keep the real program output visible by drawing the encoded
  // program monitor stream (the same MPEG-TS, decoded server-side) instead of
  // leaving the player blank.
  els.playerNote.textContent = '此浏览器不支持 HLS · 显示编码器节目监听';
  els.programVideo.style.display = 'none';
  const img = document.createElement('img');
  img.id = 'program-fallback';
  img.alt = '节目输出监听';
  img.style.cssText = 'width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:#03060a';
  img.src = '/stream/program.mjpg';
  els.programVideo.parentElement.insertBefore(img, els.programVideo);
}

function startHls() {
  const video = els.programVideo;
  const url = '/hls/index.m3u8';
  if (window.Hls?.isSupported()) {
    hls = new window.Hls({
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      maxBufferLength: 6,
      enableWorker: true,
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        els.playerNote.textContent = `HLS 致命错误：${data.type}，重试中…`;
        setTimeout(() => hls.startLoad(), 1500);
      }
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      els.playerNote.textContent = 'HLS 直播中 · 真实编码输出';
      video.play().catch(() => {
        els.playerNote.textContent = 'HLS 已就绪，点击播放器开始播放';
      });
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    els.playerNote.textContent = '原生 HLS 直播中';
  } else {
    startProgramFallback();
  }
}

function startProgramAudio() {
  if (app.audioStarted) return;
  app.audioStarted = true;
  els.programAudio.src = `/audio/program.mp3?t=${Date.now()}`;
  els.programAudio.play().catch(() => {
    app.audioStarted = false;
    els.audioToggle.textContent = '开启声音';
    flashTakeStatus('浏览器阻止了音频播放，请再次点击「开启声音」', 'err');
    return;
  });
  els.audioToggle.textContent = '静音';
  if (app.state) renderAudio(app.state);
}

function stopProgramAudio() {
  app.audioStarted = false;
  els.programAudio.pause();
  els.programAudio.removeAttribute('src');
  els.programAudio.load();
  els.audioToggle.textContent = '开启声音';
  if (app.state) renderAudio(app.state);
}

els.audioToggle.addEventListener('click', () => {
  if (app.audioStarted) stopProgramAudio();
  else startProgramAudio();
});

els.programAudio.addEventListener('error', () => {
  if (app.audioStarted) {
    els.audioToggle.textContent = '音频重连…';
    setTimeout(() => {
      stopProgramAudio();
      startProgramAudio();
    }, 2000);
  }
});

// ---------------------------------------------------------------- controls

els.takeBtn.addEventListener('click', () => {
  const previewId = app.state?.program.preview;
  if (!previewId) return;
  send({ type: 'take', source: previewId });
});

els.selPreviewSource.addEventListener('click', () => {
  const previewId = app.state?.program.preview;
  if (!previewId) return;
  const card = app.sourceCards.get(previewId);
  card?.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.repeat && !event.target.closest('button, input, textarea')) {
    els.takeBtn.click();
  }
});

// ---------------------------------------------------------------- utilities

function shortTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function pollHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const health = await res.json();
    const secs = Math.floor((health.uptimeMs || 0) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    els.uptime.textContent = `内核运行 ${mm}:${ss} · 编码帧 ${health.encoder?.framesIn ?? 0}`;
  } catch {
    els.uptime.textContent = '—';
  }
}

// ---------------------------------------------------------------- boot

connectFrames('program', (url) => {
  els.programImg.src = url;
});
connectFrames('preview', (url) => {
  els.previewImg.src = url;
});
connectControl();
startHls();
pollHealth();
setInterval(pollHealth, 5000);

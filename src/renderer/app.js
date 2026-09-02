/* global clipperrr */
const $ = (id) => document.getElementById(id);
const video = $('video');
const api = window.clipperrr;
if (api.platform === 'darwin') document.body.classList.add('mac');

const state = {
  id: null, info: null, duration: 0,
  inT: 0, outT: 0,
  view: [0, 0],          // visible timeline window [start, end]
  stopAt: null,          // pause when playback reaches this time
  activeJob: null,       // { id, cancel }
  tools: null,
};

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmt(t) {
  if (!isFinite(t)) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtShort(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function toast(msg, kind = '', actions = []) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = a.label; b.onclick = () => { a.onClick(); el.remove(); };
    el.appendChild(b);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 12000 : 6000);
  return el;
}
const fpsOf = () => (state.info && state.info.fps > 0 ? state.info.fps : 30);
const frameDur = () => 1 / fpsOf();
const frameOf = (t) => Math.round(t * fpsOf());
const snapFrame = (t) => frameOf(t) / fpsOf();

// ---------- wordmark: Herunterladschneidausgeber → Herr Schneider ----------
(function wordmark() {
  const full = 'Herunterladschneidausgeber';
  const keep = new Set([0, 1, 2, 7, 11, 12, 13, 14, 15, 16, 17, 22, 25]); // H e r r  s c h n e i d  e r
  const el = $('wordmark');
  const spans = [...full].map((c, i) => { const sp = document.createElement('span'); sp.className = 'ch'; sp.textContent = c; sp.dataset.i = i; el.appendChild(sp); return sp; });
  setTimeout(() => {
    for (const sp of spans) if (!keep.has(Number(sp.dataset.i))) sp.classList.add('drop');
    // The 'd' before 'schneid' fades out but keeps a word-space of width, so the gap in
    // "Herr Schneider" forms as part of the same collapse rather than animating afterwards.
    spans[10].classList.add('gap');
    // Swap s → S while everything is still moving, so the change is barely noticeable.
    setTimeout(() => { spans[11].textContent = 'S'; }, 350);
  }, 1400);
})();

// ---------- busy overlay ----------
function busy(title, { cancellable = true, indeterminate = false } = {}) {
  $('busy').hidden = false;
  $('busy-title').textContent = title;
  $('busy-detail').textContent = '';
  $('busy-bar').style.width = '0%';
  $('busy-bar').classList.toggle('indeterminate', indeterminate);
  $('busy-cancel').hidden = !cancellable;
}
function busyProgress(pct, detail) {
  if (pct != null) { $('busy-bar').classList.remove('indeterminate'); $('busy-bar').style.width = `${Math.round(pct * 100)}%`; }
  if (detail != null) $('busy-detail').textContent = detail;
}
function unbusy() { $('busy').hidden = true; state.activeJob = null; }
$('busy-cancel').onclick = () => { if (state.activeJob) api.cancel(state.activeJob); };
api.onProgress((p) => {
  if (p.jobId !== state.activeJob) return;
  if (p.done) return;
  if (p.stage === 'info') return busyProgress(null, 'Looking up video…');
  if (p.stage === 'merge') return busyProgress(1, 'Merging streams…');
  if (p.stage === 'index') return busyProgress(1, 'Adding to library…');
  const bits = [];
  if (p.size) bits.push(p.size);
  if (p.speed) bits.push(p.speed);
  if (p.eta) bits.push(`ETA ${p.eta}`);
  busyProgress(p.percent, bits.length ? bits.join(' · ') : (p.percent != null ? `${Math.round(p.percent * 100)}%` : ''));
});
const newJobId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

// ---------- loading ----------
async function loadFile(file) {
  try {
    busy('Reading file…', { cancellable: false, indeterminate: true });
    const { id, info, src } = await api.load(file);
    state.id = id; state.info = info; state.duration = info.duration;
    state.inT = 0; state.outT = info.duration; state.view = [0, info.duration];
    $('empty').hidden = true; $('controls').hidden = false;
    document.title = `${info.name} — Herr Schneider`;
    updateExportUI();
    if (info.playable) {
      await attachSource(src, true);
    } else {
      await useProxy('This format can’t be previewed directly; building a preview copy…');
    }
    render();
  } catch (e) {
    unbusy();
    toast(e.message || String(e), 'err');
  }
}

function attachSource(src, fallbackToProxy) {
  return new Promise((resolve) => {
    const onMeta = () => { cleanup(); unbusy(); if (state.duration <= 0) { state.duration = video.duration; state.outT = state.duration; state.view = [0, state.duration]; } resetThumbs(src); resolve(); };
    const onErr = async () => { cleanup(); if (fallbackToProxy) { await useProxy('Preview failed; building a preview copy…'); } else { unbusy(); toast('Could not play this video.', 'err'); } resolve(); };
    const cleanup = () => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
    video.src = src;
    video.load();
  });
}

async function useProxy(msg) {
  busy(msg, { cancellable: true });
  state.activeJob = `proxy-${state.id}`;
  try {
    const { src } = await api.proxy(state.id);
    await attachSource(src, false);
  } catch (e) {
    unbusy();
    if (!e.message?.includes('Cancelled')) toast(e.message, 'err');
  }
}

async function fetchUrl(url, force = false) {
  url = (url || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  await refreshTools();
  if (!state.tools.ytdlp) {
    const ok = await installYtDlp();
    if (!ok) return;
  }
  const jobId = newJobId('dl');
  busy('Fetching video…', { cancellable: true, indeterminate: true });
  state.activeJob = jobId;
  try {
    const r = await api.download(url, jobId, force);
    $('url-input').value = '';
    if (r.cached) toast(`Already in your library (fetched ${ago(r.item.fetchedAt)}). Opening the saved copy.`, 'ok', [{ label: 'Re-download', onClick: () => fetchUrl(url, true) }]);
    await loadFile(r.file);
  } catch (e) {
    unbusy();
    if (!e.message?.includes('Cancelled')) toast(e.message, 'err');
  }
}

async function installYtDlp() {
  busy('Downloading yt-dlp…', { cancellable: false });
  state.activeJob = 'ytdlp-install';
  try {
    await api.installYtDlp();
    await refreshTools();
    unbusy();
    toast('yt-dlp installed.', 'ok');
    return true;
  } catch (e) {
    unbusy();
    toast(`Could not install yt-dlp: ${e.message}`, 'err');
    return false;
  }
}

async function refreshTools() {
  state.tools = await api.tools();
  const w = $('tool-warning');
  const missing = [];
  if (!state.tools.ffmpeg) missing.push('ffmpeg');
  if (!state.tools.ffprobe) missing.push('ffprobe');
  w.innerHTML = '';
  if (missing.length) {
    w.hidden = false;
    w.textContent = `Missing ${missing.join(' and ')}. Install ffmpeg (brew install ffmpeg / winget install ffmpeg / apt install ffmpeg) or set CLIPPERRR_FFMPEG.`;
  } else if (!state.tools.ytdlp) {
    w.hidden = false;
    w.textContent = 'yt-dlp is not installed. It will be downloaded automatically the first time you fetch a link, or ';
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'install it now';
    b.onclick = installYtDlp; w.appendChild(b);
  } else {
    w.hidden = true;
  }
}

// ---------- export ----------
const EXPORT_FIELDS = ['mode', 'quality', 'size', 'fps', 'format'];
let audioOn = true;
function setAudio(on) {
  audioOn = on;
  $('audio').setAttribute('aria-pressed', String(on));
  showIcon('icon-audio-on', on); showIcon('icon-audio-off', !on);
}
$('audio').onclick = () => { setAudio(!audioOn); updateExportUI(); };
function exportSettings() {
  return { mode: $('mode').value, quality: $('quality').value, size: Number($('size').value), fps: Number($('fps').value), audio: audioOn, format: $('format').value };
}
function targetDims(info, quality, size) {
  let w = info.width, h = info.height;
  const cap = quality === '1080' ? 1080 : quality === '720' ? 720 : 0;
  const short = Math.min(w, h);
  if (cap && short > cap) { w *= cap / short; h *= cap / short; }
  w *= size / 100; h *= size / 100;
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
// Throughput calibration (pixels·frames per second) learned from real exports.
const DEFAULT_RATE = { encode: 200e6, gif: 60e6 };
let rates = {};
try { rates = JSON.parse(localStorage.getItem('rates') || '{}'); } catch {}
function pixelsOf(o) {
  const copy = o.format !== 'gif' && o.mode === 'copy';
  const [w, h] = copy ? [state.info.width, state.info.height] : targetDims(state.info, o.quality, o.size);
  const clip = Math.max(0, state.outT - state.inT);
  const fps = o.format === 'gif' ? Math.min(o.fps, Math.ceil(fpsOf())) : fpsOf();
  return { w, h, clip, fps, px: w * h * fps * clip };
}
function estimate(o) {
  const info = state.info;
  const { w, h, clip, fps, px } = pixelsOf(o);
  const hasAudio = !!info.acodec && o.audio && o.format !== 'gif';
  let bytes, secs;
  if (o.format === 'gif') {
    bytes = px * 0.09;
    secs = px / (rates.gif || DEFAULT_RATE.gif);
  } else if (o.mode === 'copy') {
    bytes = (info.size / Math.max(0.1, info.duration)) * clip;
    secs = Math.max(0.3, clip * 0.03);
  } else {
    bytes = (px * 0.12) / 8 + (hasAudio ? (192000 / 8) * clip : 0);
    secs = px / (rates.encode || DEFAULT_RATE.encode) + (hasAudio ? clip * 0.02 : 0);
  }
  return { w, h, clip, fps, bytes, secs: Math.max(0.3, secs), hasAudio };
}
// Show head+tail; if it overflows, shorten `head` from its middle with an ellipsis.
// The full text goes in the tooltip.
function fitMiddle(el, head, tail) {
  const full = head + tail;
  el.title = full;
  el.textContent = full;
  if (el.scrollWidth <= el.clientWidth) return;
  let lo = 0, hi = head.length;
  const fits = (k) => { const a = Math.ceil(k / 2), b = Math.floor(k / 2); el.textContent = head.slice(0, a) + '…' + (b ? head.slice(-b) : '') + tail; return el.scrollWidth <= el.clientWidth; };
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
  fits(lo);
}
function fmtSecs(s) { return s < 1 ? '< 1 s' : s < 90 ? `≈ ${Math.round(s)} s` : `≈ ${Math.round(s / 60)} min`; }
function codecName(c) { return ({ h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC' })[c] || (c || '').toUpperCase(); }
function updateExportUI() {
  const o = exportSettings();
  const gif = o.format === 'gif';
  const copy = !gif && o.mode === 'copy';
  const hasAudio = !!(state.info && state.info.acodec);
  $('mode-field').hidden = gif;
  $('quality-field').hidden = copy;
  $('size-field').hidden = copy;
  $('fps-field').hidden = !gif;
  $('audio-field').hidden = gif || !hasAudio;
  if (state.info) {
    const i = state.info;
    const srcRest = [`${i.width}×${i.height}`, i.fps ? `${i.fps.toFixed(3).replace(/\.?0+$/, '')} fps` : null, [codecName(i.vcodec), i.acodec ? codecName(i.acodec) : null].filter(Boolean).join(' / '), fmtShort(i.duration)].filter(Boolean).join(' · ');
    fitMiddle($('src-desc'), i.name, ' · ' + srcRest);
    const e = estimate(o);
    const parts = [`Clip ${e.clip.toFixed(2)} s`, `${e.w}×${e.h}`];
    if (gif) parts.push(`${e.fps} fps`, 'GIF');
    else if (copy) parts.push([codecName(i.vcodec), e.hasAudio ? codecName(i.acodec) : null].filter(Boolean).join(' / '), 'MP4');
    else parts.push(e.hasAudio ? 'H.264 / AAC' : 'H.264', 'MP4');
    parts.push(`≈ ${fmtBytes(e.bytes)}`, fmtSecs(e.secs));
    fitMiddle($('out-desc'), parts.join(' · '), '');
  }
  try { localStorage.setItem('export', JSON.stringify(o)); } catch {}
}
for (const id of EXPORT_FIELDS) $(id).addEventListener('change', updateExportUI);
try {
  const saved = JSON.parse(localStorage.getItem('export') || 'null');
  if (saved) { for (const id of EXPORT_FIELDS) if (saved[id] != null) $(id).value = String(saved[id]); if (saved.audio != null) setAudio(!!saved.audio); }
} catch {}
updateExportUI();

async function doExport() {
  if (!state.id || state.activeJob) return;
  if (state.outT - state.inT < 0.05) return toast('Selection is too short.', 'err');
  const o = exportSettings();
  const ext = o.format === 'gif' ? 'gif' : 'mp4';
  const base = state.info.name.replace(/\.[^.]+$/, '');
  const output = await api.saveFileDialog(`${base} [${fmtShort(state.inT).replace(/:/g, '.')}-${fmtShort(state.outT).replace(/:/g, '.')}].${ext}`, ext);
  if (!output) return;
  const jobId = newJobId('export');
  busy(ext === 'gif' ? 'Exporting GIF…' : o.mode === 'copy' ? 'Exporting (fast copy)…' : 'Exporting (re-encoding)…');
  state.activeJob = jobId;
  video.pause();
  const t0 = performance.now();
  try {
    const r = await api.exportClip({ id: state.id, start: state.inT, end: state.outT, ...o, output, jobId });
    unbusy();
    // Learn this machine's real throughput for future estimates.
    const key = o.format === 'gif' ? 'gif' : o.mode === 'copy' ? null : 'encode';
    if (key) {
      const secs = (performance.now() - t0) / 1000;
      const { px } = pixelsOf(o);
      if (secs > 0.5 && px > 0) { rates[key] = rates[key] ? rates[key] * 0.5 + (px / secs) * 0.5 : px / secs; try { localStorage.setItem('rates', JSON.stringify(rates)); } catch {} updateExportUI(); }
    }
    toast(`Exported ${r.output.split(/[\\/]/).pop()}`, 'ok', [{ label: 'Show in folder', onClick: () => api.showInFolder(r.output) }]);
  } catch (e) {
    unbusy();
    if (!e.message?.includes('Cancelled')) toast(e.message, 'err');
  }
}

// ---------- playback ----------
function seek(t) { video.currentTime = clamp(t, 0, state.duration); state.stopAt = null; }
// Step by whole frames from the current frame index (avoids float drift), landing
// a hair past the frame boundary so Chromium reliably shows that frame.
function seekFrames(n) {
  const f = clamp(frameOf(video.currentTime) + n, 0, Math.max(0, Math.round(state.duration * fpsOf()) - 1));
  seek(f / fpsOf() + 0.0005);
}
function togglePlay() {
  if (video.paused) {
    if (video.currentTime >= state.inT && video.currentTime < state.outT - 0.01) state.stopAt = state.outT;
    else state.stopAt = null;
    video.play();
  } else video.pause();
}
function previewClip() { video.currentTime = state.inT; state.stopAt = state.outT; video.play(); }
function setMuted(m) {
  video.muted = m;
  showIcon('icon-sound', !m); showIcon('icon-muted', m);
  $('btn-mute').classList.toggle('muted', m);
  try { localStorage.setItem('muted', m ? '1' : '0'); } catch {}
}
try { setMuted(localStorage.getItem('muted') === '1'); } catch { setMuted(false); }
// Audible scrubbing: while dragging the playhead with sound on, play tiny bursts at the new position.
let scrubTimer = null;
function scrubTo(t) {
  seek(t);
  if (video.muted || !state.info?.acodec) return;
  video.play().catch(() => {});
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => { video.pause(); video.currentTime = t; }, 90);
}
function endScrub() { clearTimeout(scrubTimer); scrubTimer = null; if (!video.paused) video.pause(); }
video.addEventListener('timeupdate', () => {
  if (state.stopAt != null && video.currentTime >= state.stopAt - 0.02) { video.pause(); video.currentTime = state.stopAt; state.stopAt = null; }
  renderPlayhead();
});
function showIcon(id, on) { $(id).toggleAttribute('hidden', !on); }
function showPlaying(p) { showIcon('icon-play', !p); showIcon('icon-pause', p); }
video.addEventListener('play', () => { showPlaying(true); tick(); });
video.addEventListener('pause', () => showPlaying(false));
video.addEventListener('ended', () => showPlaying(false));
function tick() { if (!video.paused) { renderPlayhead(); requestAnimationFrame(tick); } }

function setIn(t) { state.inT = clamp(snapFrame(t), 0, state.duration); if (state.outT < state.inT + frameDur()) state.outT = Math.min(state.duration, state.inT + frameDur()); render(); }
function setOut(t) { state.outT = clamp(snapFrame(t), 0, state.duration); if (state.inT > state.outT - frameDur()) state.inT = Math.max(0, state.outT - frameDur()); render(); }

// ---------- timeline ----------
const track = $('track');
const viewLen = () => Math.max(0.001, state.view[1] - state.view[0]);
const xOf = (t) => ((t - state.view[0]) / viewLen()) * track.clientWidth;
const tOf = (x) => state.view[0] + (x / track.clientWidth) * viewLen();

function render() {
  if (state.info) updateExportUI();
  $('t-in').textContent = fmt(state.inT);
  $('t-out').textContent = fmt(state.outT);
  $('t-len').textContent = fmt(state.outT - state.inT);
  const a = xOf(state.inT), b = xOf(state.outT);
  $('selection').style.left = `${a}px`; $('selection').style.width = `${Math.max(0, b - a)}px`;
  $('handle-in').style.left = `${a}px`; $('handle-out').style.left = `${b}px`;
  renderRuler(); renderPlayhead(); drawStrip(); renderNav();
}
function renderPlayhead() {
  $('t-cur').textContent = fmt(video.currentTime);
  $('t-frame').textContent = state.info ? `Frame ${frameOf(video.currentTime)}` : '';
  $('playhead').style.left = `${xOf(video.currentTime)}px`;
  if (state.duration) $('nav-playhead').style.left = `${(video.currentTime / state.duration) * nav.clientWidth}px`;
}
function renderRuler() {
  const r = $('ruler'); r.innerHTML = '';
  const w = track.clientWidth; if (!w) return;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const target = viewLen() / (w / 90);
  const step = steps.find((s) => s >= target) || steps[steps.length - 1];
  const first = Math.ceil(state.view[0] / step) * step;
  for (let t = first; t <= state.view[1]; t += step) {
    const d = document.createElement('div'); d.className = 'tick';
    d.style.left = `${xOf(t)}px`;
    d.textContent = step < 1 ? fmt(t).replace(/0+$/, '').replace(/\.$/, '') : fmtShort(t);
    r.appendChild(d);
  }
}
const isZoomed = () => state.view[0] > 0.001 || state.view[1] < state.duration - 0.001;
function setView(a, b) {
  state.view = [Math.max(0, a), Math.min(state.duration, b)];
  render();
}
function zoomBy(factor) {
  const len = clamp(viewLen() * factor, 0.5, state.duration);
  const t = video.currentTime;
  const anchor = t >= state.view[0] && t <= state.view[1] ? t : (state.view[0] + state.view[1]) / 2;
  const frac = (anchor - state.view[0]) / viewLen();
  const start = clamp(anchor - frac * len, 0, state.duration - len);
  setView(start, start + len);
}
function zoomSelection() {
  const wholeClip = state.inT <= 0.001 && state.outT >= state.duration - 0.001;
  const len = Math.max(0.2, state.outT - state.inT);
  const pad = Math.max(0.25, len * 0.12);
  const already = Math.abs(state.view[0] - Math.max(0, state.inT - pad)) < 0.01 && Math.abs(state.view[1] - Math.min(state.duration, state.outT + pad)) < 0.01;
  if (wholeClip || already) {
    // Nothing to zoom to (or already there): zoom 4× around the playhead instead.
    const vl = Math.max(0.5, viewLen() / 4);
    const a = clamp(video.currentTime - vl / 2, 0, state.duration - vl);
    return setView(a, a + vl);
  }
  setView(state.inT - pad, state.outT + pad);
}
function zoomReset() { setView(0, state.duration); }

let drag = null;
// kinds: 'in' / 'out' drag a handle; 'select' sweeps a new in→out range from the press point
// (a press without movement is a plain seek).
function startDrag(kind, e) {
  const rect = track.getBoundingClientRect();
  const tAt = (ev) => clamp(tOf(ev.clientX - rect.left), state.view[0], state.view[1]);
  drag = { kind, x0: e.clientX, t0: snapFrame(tAt(e)), moved: false };
  e.preventDefault();
  const move = (ev) => {
    const t = tAt(ev);
    if (drag.kind === 'in') { setIn(t); scrubTo(t); return; }
    if (drag.kind === 'out') { setOut(t); scrubTo(t); return; }
    if (!drag.moved && Math.abs(ev.clientX - drag.x0) < 4) return;
    drag.moved = true;
    const a = Math.min(drag.t0, t), b = Math.max(drag.t0, t);
    state.inT = clamp(snapFrame(a), 0, state.duration);
    state.outT = clamp(Math.max(snapFrame(b), state.inT + frameDur()), 0, state.duration);
    render();
    scrubTo(t);
  };
  const up = () => {
    if (drag && drag.kind === 'select' && !drag.moved) seek(drag.t0);
    drag = null; endScrub();
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  if (kind !== 'select') move(e);
}
$('handle-in').addEventListener('mousedown', (e) => { e.stopPropagation(); startDrag('in', e); });
$('handle-out').addEventListener('mousedown', (e) => { e.stopPropagation(); startDrag('out', e); });
track.addEventListener('mousedown', (e) => startDrag('select', e));

// ---- overview bar: whole video, zoom window, drag to choose a portion ----
const nav = $('nav');
const navT = (clientX) => clamp(((clientX - nav.getBoundingClientRect().left) / nav.clientWidth) * state.duration, 0, state.duration);
function renderNav() {
  const W = nav.clientWidth; if (!W || !state.duration) return;
  const px = (t) => (t / state.duration) * W;
  $('nav-sel').style.left = `${px(state.inT)}px`; $('nav-sel').style.width = `${Math.max(1, px(state.outT) - px(state.inT))}px`;
  $('nav-view').style.left = `${px(state.view[0])}px`; $('nav-view').style.width = `${Math.max(2, px(state.view[1]) - px(state.view[0]))}px`;
  $('nav-view').classList.toggle('full', !isZoomed());
  $('nav-playhead').style.left = `${px(video.currentTime)}px`;
  $('btn-zoom-out').disabled = !isZoomed();
  $('btn-zoom-in').disabled = viewLen() <= 0.5;
}
nav.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const onView = e.target === $('nav-view') && isZoomed();
  const t0 = navT(e.clientX);
  const len = viewLen();
  const offset = t0 - state.view[0];
  let moved = false;
  const move = (ev) => {
    const t = navT(ev.clientX);
    if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
    moved = true;
    if (onView) { const s = clamp(t - offset, 0, state.duration - len); setView(s, s + len); }
    else { const a = Math.min(t0, t), b = Math.max(t0, t); const l = Math.max(0.5, b - a); const s = clamp(a, 0, state.duration - l); setView(s, s + l); }
  };
  const up = () => {
    if (!moved && isZoomed()) { const s = clamp(t0 - len / 2, 0, state.duration - len); setView(s, s + len); }
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
});
track.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = track.getBoundingClientRect();
  if (e.shiftKey || (Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
    const dt = ((e.deltaX || e.deltaY) / track.clientWidth) * viewLen();
    const s = clamp(state.view[0] + dt, 0, state.duration - viewLen());
    setView(s, s + viewLen());
  } else {
    const anchor = tOf(e.clientX - rect.left);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    let len = clamp(viewLen() * factor, 0.5, state.duration);
    const frac = (anchor - state.view[0]) / viewLen();
    let s = clamp(anchor - frac * len, 0, state.duration - len);
    setView(s, s + len);
  }
}, { passive: false });
window.addEventListener('resize', render);
new ResizeObserver(() => { if (state.id) render(); }).observe(track);

// ---------- library ----------
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
function fmtUploadDate(s) {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
let clearArmed = null;
async function openLibrary() {
  $('library').hidden = false;
  clearArmed = null; $('library-clear').textContent = 'Clear all';
  await renderLibrary();
}
async function renderLibrary() {
  const { items, root, totalBytes } = await api.library.list();
  $('library-stats').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'} · ${fmtBytes(totalBytes)}` : '';
  $('library-path').textContent = `Stored in ${root}`;
  $('library-empty').hidden = items.length > 0;
  $('library-clear').disabled = items.length === 0;
  const list = $('library-list'); list.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div'); el.className = 'lib-item';
    const thumb = it.thumb ? Object.assign(document.createElement('img'), { className: 'lib-thumb', src: `clip://thumb/${it.id}`, alt: '' })
      : Object.assign(document.createElement('div'), { className: 'lib-thumb placeholder', textContent: '▶' });
    thumb.title = 'Open'; thumb.onclick = () => openFromLibrary(it);
    const body = document.createElement('div'); body.className = 'lib-body';
    const title = document.createElement('div'); title.className = 'lib-title'; title.textContent = it.title; title.title = it.title; title.onclick = () => openFromLibrary(it);
    const l1 = document.createElement('div'); l1.className = 'lib-line';
    l1.textContent = [it.uploader, it.domain, fmtUploadDate(it.uploadDate) && `published ${fmtUploadDate(it.uploadDate)}`].filter(Boolean).join(' · ');
    const l2 = document.createElement('div'); l2.className = 'lib-line';
    l2.textContent = [fmtShort(it.duration), `${it.width}×${it.height}`, it.fps ? `${Math.round(it.fps)} fps` : null, [it.vcodec, it.acodec].filter(Boolean).join('/'), fmtBytes(it.size)].filter(Boolean).join(' · ');
    const l3 = document.createElement('div'); l3.className = 'lib-line';
    l3.append(`Fetched ${ago(it.fetchedAt)}${it.opens > 1 ? `, opened ${it.opens}×` : ''} from `);
    const a = document.createElement('a'); a.href = '#'; a.textContent = it.webpageUrl; a.title = 'Open the original page in your browser';
    a.onclick = (e) => { e.preventDefault(); api.openExternal(it.webpageUrl); };
    l3.appendChild(a);
    body.append(title, l1, l2, l3);
    if (it.description) { const d = document.createElement('div'); d.className = 'lib-desc'; d.textContent = it.description; d.title = it.description; body.appendChild(d); }
    const actions = document.createElement('div'); actions.className = 'lib-actions';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.onclick = fn; return b; };
    actions.append(
      mk('Open', 'primary', () => openFromLibrary(it)),
      mk('Show file', '', () => api.showInFolder(it.file)),
      mk('Delete', 'danger', async () => { await api.library.remove(it.id); renderLibrary(); }),
    );
    el.append(thumb, body, actions);
    list.appendChild(el);
  }
}
async function openFromLibrary(it) {
  try {
    const file = await api.library.open(it.id);
    $('library').hidden = true;
    await loadFile(file);
  } catch (e) { toast(e.message, 'err'); renderLibrary(); }
}
$('btn-library').onclick = openLibrary;
$('library-close').onclick = () => { $('library').hidden = true; };
$('library').addEventListener('click', (e) => { if (e.target === $('library')) $('library').hidden = true; });
$('library-folder').onclick = () => api.library.openFolder();
$('library-clear').onclick = async () => {
  if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; const n = await api.library.clear(); toast(`Deleted ${n} fetched video${n === 1 ? '' : 's'}.`, 'ok'); renderLibrary(); $('library-clear').textContent = 'Clear all'; return; }
  $('library-clear').textContent = 'Click again to delete everything';
  clearArmed = setTimeout(() => { clearArmed = null; $('library-clear').textContent = 'Clear all'; }, 4000);
};

// ---------- filmstrip thumbnails + hover frame preview ----------
const strip = $('strip');
const thumbVideo = $('thumb-video');
const hoverVideo = $('hover-video');
const thumbs = { cache: new Map(), queue: [], busy: false, src: null, aspect: 16 / 9, gen: 0 };

function thumbSlotWidth() { return Math.round(track.clientHeight * thumbs.aspect); }
function thumbTimeKey(t) { return Math.round(t * 10) / 10; }   // 0.1 s grid, shared across zoom levels

function resetThumbs(src) {
  thumbs.cache.clear(); thumbs.queue.length = 0; thumbs.busy = false; thumbs.gen++;
  thumbs.src = src;
  thumbs.aspect = state.info && state.info.height ? state.info.width / state.info.height : 16 / 9;
  thumbVideo.src = src; hoverVideo.src = src;
  drawStrip();
}

function requestThumb(key) {
  if (thumbs.cache.has(key) || thumbs.queue.includes(key)) return;
  thumbs.queue.push(key);
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbs.busy || !thumbs.queue.length || !thumbs.src) return;
  thumbs.busy = true;
  const gen = thumbs.gen;
  while (thumbs.queue.length && gen === thumbs.gen) {
    // Prefer thumbnails that are currently visible.
    const [a, b] = state.view;
    const i = thumbs.queue.findIndex((k) => k >= a && k <= b);
    const key = thumbs.queue.splice(i >= 0 ? i : 0, 1)[0];
    try {
      const bmp = await grabFrame(thumbVideo, key, Math.round(thumbSlotWidth() * devicePixelRatio), Math.round(track.clientHeight * devicePixelRatio));
      if (gen !== thumbs.gen) break;
      thumbs.cache.set(key, bmp);
      if (thumbs.cache.size > 600) thumbs.cache.delete(thumbs.cache.keys().next().value);
      drawStrip();
    } catch { /* codec hiccup: skip this slot */ }
  }
  thumbs.busy = false;
}

// Seek an offscreen <video> to t and paint the frame into a bitmap.
function grabFrame(v, t, w, h) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(v, 0, 0, w, h); resolve(c); };
    const fail = () => { cleanup(); reject(new Error('seek failed')); };
    const timer = setTimeout(fail, 4000);
    const cleanup = () => { clearTimeout(timer); v.removeEventListener('seeked', done); v.removeEventListener('error', fail); };
    v.addEventListener('seeked', done); v.addEventListener('error', fail);
    if (v.readyState >= 1 && Math.abs(v.currentTime - t) < 0.0001) { done(); return; }
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, state.duration - 0.05));
  });
}

function nearestThumb(t, tol) {
  let best = null, bd = Infinity;
  for (const [k, b] of thumbs.cache) { const d = Math.abs(k - t); if (d < bd) { bd = d; best = b; } }
  return bd <= tol ? best : null;
}

function drawStrip() {
  const W = track.clientWidth, H = track.clientHeight;
  if (!W || !H) return;
  const dpr = devicePixelRatio || 1;
  if (strip.width !== Math.round(W * dpr) || strip.height !== Math.round(H * dpr)) { strip.width = Math.round(W * dpr); strip.height = Math.round(H * dpr); }
  const ctx = strip.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!state.id || !thumbs.src) return;
  const sw = thumbSlotWidth();
  const secPerPx = viewLen() / W;
  const first = Math.floor(state.view[0] / (sw * secPerPx));
  for (let i = first; ; i++) {
    const x0 = i * sw - state.view[0] / secPerPx;
    if (x0 > W) break;
    const t = thumbTimeKey(Math.min(state.duration, (x0 + sw / 2) * secPerPx + state.view[0]));
    const exact = thumbs.cache.get(t);
    // While the exact frame is pending (e.g. right after a resize or zoom), show the nearest
    // cached one so the strip never blanks out.
    const bmp = exact || nearestThumb(t, sw * secPerPx / 2 + 0.05);
    if (bmp) ctx.drawImage(bmp, x0, 0, sw, H);
    else { ctx.fillStyle = 'rgba(128,128,128,0.10)'; ctx.fillRect(x0, 0, sw, H); }
    if (!exact) requestThumb(t);
  }
  // Dim everything outside the selection.
  const a = xOf(state.inT), b = xOf(state.outT);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--scrim').trim() || 'rgba(255,255,255,0.8)';
  if (a > 0) ctx.fillRect(0, 0, a, H);
  if (b < W) ctx.fillRect(b, 0, W - b, H);
  // hairlines between slots
  ctx.fillStyle = 'rgba(128,128,128,0.25)';
  for (let i = first; ; i++) { const x = i * sw - state.view[0] / secPerPx; if (x > W) break; if (x > 0) ctx.fillRect(Math.round(x), 0, 1, H); }
}

// Hover: thin line + exact frame preview.
let hoverReq = 0, hoverPending = null, hoverBusy = false;
async function showHover(clientX) {
  const rect = track.getBoundingClientRect();
  const x = clamp(clientX - rect.left, 0, rect.width);
  const t = clamp(snapFrame(tOf(x)), 0, state.duration);
  $('hoverline').hidden = false; $('hoverline').style.left = `${x}px`;
  const pv = $('hover-preview'); pv.hidden = false;
  const pw = pv.offsetWidth;
  pv.style.left = `${clamp(x - pw / 2, 0, rect.width - pw)}px`;
  $('hover-time').textContent = `${fmt(t)} · f${frameOf(t)}`;
  hoverPending = t;
  if (hoverBusy) return;
  hoverBusy = true;
  while (hoverPending != null) {
    const want = hoverPending; hoverPending = null;
    try {
      const c = $('hover-canvas');
      const ratio = thumbs.aspect;
      const cw = Math.round(176 * devicePixelRatio), ch = Math.round((176 / ratio) * devicePixelRatio);
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; c.style.height = `${Math.round(176 / ratio)}px`; }
      const bmp = await grabFrame(hoverVideo, want + 0.0005, cw, ch);
      c.getContext('2d').drawImage(bmp, 0, 0);
    } catch {}
  }
  hoverBusy = false;
}
function hideHover() { $('hoverline').hidden = true; $('hover-preview').hidden = true; hoverPending = null; }
track.addEventListener('mousemove', (e) => { if (state.id) showHover(e.clientX); });
track.addEventListener('mouseleave', () => { if (!drag) hideHover(); });
window.addEventListener('mousemove', (e) => { if (drag && state.id) showHover(e.clientX); });
window.addEventListener('mouseup', () => setTimeout(() => { if (!track.matches(':hover')) hideHover(); }, 0));

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { if (!$('help').hidden) $('help').hidden = true; else if (!$('library').hidden) $('library').hidden = true; else if (inInput) e.target.blur(); else zoomReset(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); return $('library').hidden ? openLibrary() : ($('library').hidden = true); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); return openFile(); }
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); return $('url-input').focus(); }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return doExport(); }
  if (inInput) return;
  if (e.key === '?') { e.preventDefault(); $('help').hidden = !$('help').hidden; return; }
  if (e.key.toLowerCase() === 'q' && !mod) { window.close(); return; }
  if (!state.id) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (e.ctrlKey) setIn(video.currentTime);
      else if (e.altKey) setOut(video.currentTime);
      else togglePlay();
      break;
    case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) seek(video.currentTime - 1); else if (e.altKey) seek(video.currentTime - 5); else seekFrames(-1); break;
    case 'ArrowRight': e.preventDefault(); if (e.shiftKey) seek(video.currentTime + 1); else if (e.altKey) seek(video.currentTime + 5); else seekFrames(1); break;
    case 'Comma': seekFrames(e.shiftKey ? -10 : -1); break;
    case 'Period': seekFrames(e.shiftKey ? 10 : 1); break;
    case 'KeyI': setIn(video.currentTime); break;
    case 'KeyO': setOut(video.currentTime); break;
    case 'KeyP': previewClip(); break;
    case 'KeyM': setMuted(!video.muted); break;
    case 'BracketLeft': seek(state.inT); break;
    case 'BracketRight': seek(state.outT); break;
    case 'Home': seek(0); break;
    case 'End': seek(state.duration); break;
    case 'KeyZ': if (e.shiftKey) zoomReset(); else zoomSelection(); break;
    default: return;
  }
  renderPlayhead();
});

// ---------- buttons / drop / menu ----------
async function openFile() { const f = await api.openFileDialog(); if (f) loadFile(f); }
$('btn-open').onclick = openFile;
$('btn-play').onclick = togglePlay;
$('btn-preview').onclick = previewClip;
$('btn-set-in').onclick = () => setIn(video.currentTime);
$('btn-set-out').onclick = () => setOut(video.currentTime);
$('btn-zoom-in').onclick = () => zoomBy(1 / 1.6);
$('btn-zoom-out').onclick = () => zoomBy(1.6);
$('btn-mute').onclick = () => setMuted(!video.muted);
$('btn-export').onclick = doExport;
$('btn-help').onclick = () => { $('help').hidden = false; };
$('help-close').onclick = () => { $('help').hidden = true; };
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });
$('url-form').addEventListener('submit', (e) => { e.preventDefault(); $('url-input').blur(); fetchUrl($('url-input').value); });
video.addEventListener('click', () => { if (state.id) togglePlay(); });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) return loadFile(api.pathForFile(f));
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text && /^https?:\/\//i.test(text.trim())) fetchUrl(text.trim().split('\n')[0]);
});

api.onOpen((t) => {
  if (t.file) loadFile(t.file);
  else if (t.url) { $('url-input').value = t.url; fetchUrl(t.url); }
  else if (t.command === 'open') openFile();
  else if (t.command === 'link') $('url-input').focus();
  else if (t.command === 'export') doExport();
  else if (t.command === 'help') $('help').hidden = false;
  else if (t.command === 'library') openLibrary();
});

refreshTools();
api.ready();

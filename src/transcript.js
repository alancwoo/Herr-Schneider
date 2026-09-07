// Transcripts: find subtitle tracks for a video (yt-dlp captions in the library
// folder, sidecar .vtt/.srt files, or text streams embedded in the container),
// parse them into flat cues, and fetch captions for older library items.
const fs = require('fs');
const path = require('path');

const SUB_EXT = /\.(vtt|srt|json3)$/i;
const TEXT_SUB_CODECS = ['subrip', 'srt', 'webvtt', 'mov_text', 'ass', 'ssa', 'text'];
// English plus the original spoken language of auto captions; skip live-chat replays.
const DEFAULT_LANGS = 'en,en-[A-Za-z]{2},.*-orig,-live_chat';

// ---- parsing ----
function parseTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}
function clean(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')          // ASS style overrides
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// WebVTT and SRT share the same block structure.
function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a), end = parseTime(b);
    if (!isFinite(start)) continue;
    const body = lines.slice(i + 1).map(clean).filter(Boolean);
    if (!body.length) continue;
    cues.push({ start, end: isFinite(end) && end > start ? end : start + 2, lines: body });
  }
  return cues;
}

// YouTube's json3 format: events with segments.
function parseJson3(text) {
  const data = JSON.parse(text);
  const cues = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const t = clean(ev.segs.map((s) => s.utf8 || '').join(''));
    if (!t) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + Math.max(0.5, (ev.dDurationMs || 2000) / 1000), lines: [t] });
  }
  return cues;
}

// Auto captions arrive as a rolling two-line window where each line is repeated in
// the next cue. Drop lines already shown by the previous cue so every cue is new text.
function flatten(cues) {
  cues.sort((a, b) => a.start - b.start);
  const out = [];
  let prev = [];
  for (const c of cues) {
    let k = 0;
    while (k < c.lines.length && prev.includes(c.lines[k])) k++;
    const lines = c.lines.slice(k);
    prev = c.lines;
    if (!lines.length) { if (out.length) out[out.length - 1].end = Math.max(out[out.length - 1].end, c.end); continue; }
    const text = lines.join(' ');
    const last = out[out.length - 1];
    if (last && last.text === text) { last.end = Math.max(last.end, c.end); continue; }
    if (last && last.end > c.start) last.end = c.start;
    out.push({ start: c.start, end: c.end, text });
  }
  return out;
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const cues = /\.json3$/i.test(file) ? parseJson3(text) : parseVtt(text);
  return flatten(cues);
}

// ---- locating tracks ----
let displayNames = null;
function langName(code) {
  const base = code.replace(/-orig$/, '');
  if (base === 'und' || !base) return 'Unknown language';
  try {
    displayNames = displayNames || new Intl.DisplayNames(['en'], { type: 'language' });
    const n = displayNames.of(base.replace(/_/g, '-'));
    if (n && n !== base) return n;
  } catch {}
  return base.toUpperCase();
}

function trackLabel(t) {
  const bits = [langName(t.lang)];
  if (/-orig$/.test(t.lang)) bits.push('original');
  if (t.auto) bits.push('auto-generated');
  return bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(', ')})` : bits[0];
}

// Subtitle files in dir. With `base`, only files belonging to that video (same
// basename) count; library folders hold one video so everything counts.
function scanDir(dir, base, meta) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => SUB_EXT.test(f)); } catch { return []; }
  if (base) files = files.filter((f) => f === base + path.extname(f) || f.startsWith(base + '.'));
  const tracks = files.map((f) => {
    const stem = f.replace(SUB_EXT, '');
    const seg = stem.includes('.') ? stem.split('.').pop() : '';
    const lang = /^[a-zA-Z]{2,3}([-_][\w]+)*$/.test(seg) ? seg : 'und';
    const manual = !!(meta && meta.subtitles && meta.subtitles[lang]);
    const auto = !manual && !!(meta && meta.automatic_captions && meta.automatic_captions[lang]);
    return { key: path.join(dir, f), file: path.join(dir, f), lang, auto, manual };
  });
  // "xx" and "xx-orig" auto captions are the same text; keep the original.
  const langs = new Set(tracks.map((t) => t.lang));
  const kept = tracks.filter((t) => !(t.auto && langs.has(t.lang + '-orig')));
  const rank = (t) => (t.manual ? 0 : 2) + (/^en/.test(t.lang) ? 0 : 1);
  kept.sort((a, b) => rank(a) - rank(b) || a.lang.localeCompare(b.lang));
  return kept.map((t) => ({ ...t, label: trackLabel(t), source: t.manual ? 'subtitles' : t.auto ? 'auto captions' : 'subtitle file' }));
}

function readMeta(dir) {
  try {
    const f = fs.readdirSync(dir).find((x) => /\.info\.json$/i.test(x));
    return f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
  } catch { return null; }
}

// Pull a text subtitle stream out of the container as WebVTT (cached).
function extractEmbedded(run, tools, file, streamIndex, cacheDir, cacheKey) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${cacheKey}-s${streamIndex}.vtt`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const { promise } = run(tools.ffmpeg, ['-y', '-hide_banner', '-nostats', '-i', file, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', out]);
  return promise.then(() => out);
}

// Fetch captions only (no video) with yt-dlp into dir.
function fetchSubs(run, tools, url, dir, langs = DEFAULT_LANGS) {
  const args = [
    '--no-playlist', '--skip-download', '--no-warnings', '--no-write-playlist-metafiles',
    '--write-subs', '--write-auto-subs', '--sub-langs', langs, '--sub-format', 'vtt/srt/best',
    '--sleep-subtitles', '1',
    '--ffmpeg-location', path.dirname(tools.ffmpeg),
    '--trim-filenames', '120', '-o', '%(title)s [%(id)s].%(ext)s',
    url,
  ];
  const job = run(tools.ytdlp, args, { cwd: dir });
  const promise = job.promise.catch((e) => {
    if (/429|Too Many Requests/.test(e.message)) throw new Error('The site is rate-limiting caption downloads right now (HTTP 429). Try again in a few minutes.');
    throw e;
  });
  return { promise, cancel: job.cancel };
}

// Captions are best-effort during a video download: --ignore-errors turns a failed
// caption request into a warning instead of aborting the whole download.
const SUB_ARGS = ['--write-subs', '--write-auto-subs', '--sub-langs', DEFAULT_LANGS, '--sub-format', 'vtt/srt/best', '--ignore-errors'];

module.exports = { parseFile, parseVtt, parseJson3, flatten, scanDir, readMeta, extractEmbedded, fetchSubs, langName, SUB_ARGS, TEXT_SUB_CODECS, DEFAULT_LANGS };

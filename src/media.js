// ffprobe / ffmpeg / yt-dlp wrappers. Every long-running call returns a
// { promise, cancel } pair so the UI can abort it.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PLAYABLE_CONTAINERS = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'];
const PLAYABLE_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const PLAYABLE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'];
const PLAYABLE_PIXFMT = ['yuv420p', 'yuvj420p'];

function run(bin, args, { onLine, cwd } = {}) {
  const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let cancelled = false;
  const feed = (which) => {
    let buf = '';
    return (chunk) => {
      const s = chunk.toString();
      if (which === 'stdout') stdout += s;
      else stderr += s.slice(-20000);
      buf += s;
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      for (const line of parts) if (onLine) onLine(line, which);
    };
  };
  child.stdout.on('data', feed('stdout'));
  child.stderr.on('data', feed('stderr'));
  const promise = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Failed to start ${path.basename(bin)}: ${e.message}`)));
    child.on('close', (code) => {
      if (cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(`${path.basename(bin)} exited with code ${code}\n${tail}`));
    });
  });
  const cancel = () => {
    cancelled = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
    else child.kill('SIGTERM');
  };
  return { promise, cancel, child };
}

function rotationOf(stream) {
  let rot = 0;
  if (stream.tags && stream.tags.rotate) rot = Number(stream.tags.rotate) || 0;
  for (const sd of stream.side_data_list || []) {
    if (sd.rotation !== undefined) rot = Number(sd.rotation) || 0;
  }
  return ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
}

async function probe(tools, file) {
  const { promise } = run(tools.ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const { stdout } = await promise;
  const data = JSON.parse(stdout);
  const v = (data.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video stream found in this file.');
  const rot = rotationOf(v);
  const swap = rot === 90 || rot === 270;
  const fpsParts = (v.avg_frame_rate || v.r_frame_rate || '0/1').split('/');
  const fps = fpsParts[1] ? Number(fpsParts[0]) / Number(fpsParts[1]) : Number(fpsParts[0]);
  const duration = Number(data.format?.duration) || Number(v.duration) || 0;
  const containers = (data.format?.format_name || '').split(',');
  const playable =
    containers.some((c) => PLAYABLE_CONTAINERS.includes(c)) &&
    PLAYABLE_VIDEO.includes(v.codec_name) &&
    (v.codec_name !== 'h264' || PLAYABLE_PIXFMT.includes(v.pix_fmt)) &&
    (!a || PLAYABLE_AUDIO.includes(a.codec_name));
  return {
    path: file,
    name: path.basename(file),
    size: Number(data.format?.size) || fs.statSync(file).size,
    duration,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: isFinite(fps) ? fps : 0,
    vcodec: v.codec_name,
    acodec: a ? a.codec_name : null,
    pixFmt: v.pix_fmt,
    container: containers[0],
    playable,
  };
}

function cacheKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

function ffmpegProgress(duration, onProgress) {
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && duration > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
  };
}

// Make a browser-friendly preview copy (720p-ish H.264/AAC MP4).
function makeProxy(tools, info, proxyDir, onProgress) {
  fs.mkdirSync(proxyDir, { recursive: true });
  const out = path.join(proxyDir, `${cacheKey(info.path)}.mp4`);
  if (fs.existsSync(out)) return { promise: Promise.resolve(out), cancel() {} };
  const tmp = out + '.part.mp4';
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    '-i', info.path,
    '-vf', "scale='trunc(min(1280,iw)/2)*2':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', tmp,
  ];
  const job = run(tools.ffmpeg, args, { onLine: ffmpegProgress(info.duration, onProgress) });
  const promise = job.promise.then(
    () => { fs.renameSync(tmp, out); return out; },
    (e) => { try { fs.unlinkSync(tmp); } catch {} throw e; },
  );
  return { promise, cancel: job.cancel };
}

// Output dimensions after the quality cap (on the shorter edge) and the size percentage.
function targetDims(info, quality, size) {
  let w = info.width, h = info.height;
  const cap = quality === '1080' ? 1080 : quality === '720' ? 720 : 0;
  const short = Math.min(w, h);
  if (cap && short > cap) { w *= cap / short; h *= cap / short; }
  const pct = (Number(size) || 100) / 100;
  w *= pct; h *= pct;
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}

// Export the [start, end] range of info.path to output.
// format:  'mp4' | 'gif'
// mode:    'copy' (fast, keyframe-accurate) | 'encode' (frame-accurate)   (mp4 only)
// quality: 'original' | '1080' | '720'      size: 100 | 50 | 25   (encode/gif only)
// audio:   include the audio track          fps: gif frame rate
function exportClip(tools, { info, start, end, mode, quality, size, audio, format, fps, output }, onProgress) {
  // Floor the start to the millisecond so a frame sitting exactly on the in-point is never
  // discarded by ffmpeg's accurate seek; the duration is rounded up for the same reason.
  const ss = Math.floor(start * 1000) / 1000;
  const duration = Math.max(0.01, Math.ceil((end - ss) * 1000) / 1000);
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
  args.push('-ss', ss.toFixed(3), '-i', info.path, '-t', duration.toFixed(3));
  const [w, h] = targetDims(info, quality, size);
  if (format === 'gif') {
    const rate = Math.min(Number(fps) || 15, info.fps > 0 ? Math.ceil(info.fps) : 30);
    args.push('-map', '0:v:0', '-an');
    args.push('-vf', `fps=${rate},scale=${w}:${h}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`);
    args.push('-loop', '0', '-f', 'gif', output);
  } else if (mode === 'copy') {
    args.push('-map', '0:v:0');
    if (audio) args.push('-map', '0:a?'); else args.push('-an');
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', output);
  } else {
    args.push('-map', '0:v:0');
    if (audio) args.push('-map', '0:a?'); else args.push('-an');
    if (w !== info.width || h !== info.height) args.push('-vf', `scale=${w}:${h}:flags=lanczos`);
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart', '-f', 'mp4', output);
  }
  const job = run(tools.ffmpeg, args, { onLine: ffmpegProgress(duration, onProgress) });
  return { promise: job.promise.then(() => output), cancel: job.cancel };
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|flv|ts|mpg|mpeg|3gp|ogv)$/i;

// Fetch a URL with yt-dlp into dir (one folder per download), preferring a
// browser-playable MP4. Also saves the page metadata (info.json) and thumbnail.
function download(tools, url, dir, onProgress) {
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '--no-playlist', '--newline', '--progress', '--no-warnings',
    '--write-info-json', '--write-thumbnail', '--no-write-playlist-metafiles',
    '--ffmpeg-location', path.dirname(tools.ffmpeg),
    '-f', 'bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--trim-filenames', '120',
    '-o', '%(title)s [%(id)s].%(ext)s',
    '--print', 'after_move:filepath',
    url,
  ];
  let printed = null;
  const onLine = (line) => {
    const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/.exec(line);
    if (m) return onProgress && onProgress({ stage: 'download', percent: Number(m[1]) / 100, size: m[2], speed: m[3], eta: m[4] });
    if (/^\[Merger\]|^\[ffmpeg\]/.test(line)) return onProgress && onProgress({ stage: 'merge', percent: 1 });
    if (/^\[(?:youtube|generic|[\w:]+)\] .*(?:Extracting|Downloading)/.test(line)) return onProgress && onProgress({ stage: 'info', percent: 0 });
    const t = line.trim();
    if (t && path.isAbsolute(t) && fs.existsSync(t)) printed = t;
  };
  const job = run(tools.ytdlp, args, { onLine, cwd: dir });
  const promise = job.promise.then(() => {
    if (printed) return printed;
    const files = fs.readdirSync(dir).filter((f) => VIDEO_EXT.test(f) && !/\.part$/i.test(f)).map((f) => path.join(dir, f));
    if (!files.length) throw new Error('yt-dlp finished but no file was produced.');
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0];
  });
  return { promise, cancel: job.cancel };
}

module.exports = { probe, makeProxy, exportClip, download, targetDims };

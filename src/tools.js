// Locate ffmpeg / ffprobe / yt-dlp in a cross-platform way.
// Order: env override > bundled static build > PATH (plus common install dirs
// that GUI apps don't see because they don't inherit the shell PATH).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

function unasar(p) {
  return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p;
}

function isExecutableFile(f) {
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return false;
    if (!isWin) fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function extraDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  } else if (isWin) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    dirs.push(path.join(home, 'scoop', 'shims'));
    if (process.env.ChocolateyInstall) dirs.push(path.join(process.env.ChocolateyInstall, 'bin'));
    dirs.push('C:\\ffmpeg\\bin');
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/snap/bin', '/var/lib/flatpak/exports/bin');
  }
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'));
  return dirs;
}

function findOnPath(name) {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(extraDirs());
  for (const dir of dirs) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      if (isExecutableFile(f)) return f;
    }
  }
  return null;
}

function bundled(mod, pick) {
  try {
    const v = pick(require(mod));
    const p = unasar(v);
    return isExecutableFile(p) ? p : null;
  } catch {
    return null;
  }
}

let cache = null;

function ytDlpLocalPath(userData) {
  return path.join(userData, 'bin', isWin ? 'yt-dlp.exe' : 'yt-dlp');
}

function resolveTools(userData, force = false) {
  if (cache && !force) return cache;
  const ffmpeg =
    process.env.CLIPPERRR_FFMPEG ||
    bundled('ffmpeg-static', (m) => m) ||
    findOnPath('ffmpeg');
  const ffprobe =
    process.env.CLIPPERRR_FFPROBE ||
    bundled('ffprobe-static', (m) => m.path) ||
    findOnPath('ffprobe');
  const local = ytDlpLocalPath(userData);
  const ytdlp =
    process.env.CLIPPERRR_YTDLP ||
    findOnPath('yt-dlp') ||
    (isExecutableFile(local) ? local : null);
  cache = { ffmpeg, ffprobe, ytdlp };
  return cache;
}

function ytDlpReleaseAsset() {
  const arch = process.arch;
  if (isWin) return arch === 'ia32' ? 'yt-dlp_x86.exe' : arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'arm' ? 'yt-dlp_linux_armv7l' : 'yt-dlp_linux';
}

// Download the latest yt-dlp release binary into userData/bin.
async function installYtDlp(userData, onProgress) {
  const dest = ytDlpLocalPath(userData);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpReleaseAsset()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    out.write(Buffer.from(value));
    if (onProgress && total) onProgress(got / total);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
  if (process.platform === 'darwin') {
    // Strip the quarantine flag so Gatekeeper lets the binary run.
    await new Promise((r) => spawn('xattr', ['-d', 'com.apple.quarantine', dest]).on('close', r).on('error', r));
  }
  cache = null;
  return dest;
}

module.exports = { resolveTools, installYtDlp };

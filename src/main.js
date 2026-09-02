const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { resolveTools, installYtDlp } = require('./tools');
const media = require('./media');
const { Library, buildItem } = require('./library');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');

// Custom scheme so the renderer can stream local files with HTTP range support.
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let pendingOpen = null;
let rendererReady = false;
let lastOpen = { key: '', at: 0 };
const loaded = new Map(); // id -> { info, src path }
let library = null;
const jobs = new Map(); // jobId -> cancel()
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function userDir(sub) {
  const d = path.join(app.getPath('userData'), sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function argTarget(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--'));
  const t = args[args.length - 1];
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return { url: t };
  const p = path.resolve(t);
  return fs.existsSync(p) ? { file: p } : null;
}

function sendOpen(target) {
  if (!target) return;
  // macOS delivers command-line files both via argv and 'open-file'; ignore the duplicate.
  const key = target.file || target.url || target.command;
  if (key === lastOpen.key && Date.now() - lastOpen.at < 3000) return;
  lastOpen = { key, at: Date.now() };
  if (rendererReady && win) win.webContents.send('app:open', target);
  else pendingOpen = target;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#111114',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const send = (ch, arg) => () => win && win.webContents.send('app:open', { command: ch, arg });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Open Link…', accelerator: 'CmdOrCtrl+L', click: send('link') },
        { label: 'Library', accelerator: 'CmdOrCtrl+B', click: send('library') },
        { type: 'separator' },
        { label: 'Export Clip…', accelerator: 'CmdOrCtrl+S', click: send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Keyboard Shortcuts', click: send('help') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function serveFile(file, request) {
  let stat;
  try { stat = fs.statSync(file); } catch { return new Response('Not found', { status: 404 }); }
  const size = stat.size;
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  let start = 0, end = size - 1, status = 200;
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    if (m[1]) start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
    if (!m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
}

function progress(jobId, payload) {
  if (win) win.webContents.send('job:progress', { jobId, ...payload });
}

function track(jobId, job) {
  jobs.set(jobId, job.cancel);
  return job.promise.finally(() => jobs.delete(jobId));
}

app.whenReady().then(() => {
  library = new Library(userDir('sources'));
  protocol.handle('clip', (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'thumb') {
      const it = library.get(u.pathname.replace(/^\//, ''));
      return it && it.thumb ? serveFile(it.thumb, request) : new Response('No thumbnail', { status: 404 });
    }
    const entry = loaded.get(u.pathname.replace(/^\//, ''));
    if (!entry) return new Response('Unknown media id', { status: 404 });
    const file = u.searchParams.get('proxy') ? entry.proxy : entry.info.path;
    if (!file) return new Response('No file', { status: 404 });
    return serveFile(file, request);
  });
  buildMenu();
  createWindow();
  sendOpen(argTarget(process.argv));
});

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  sendOpen(argTarget(argv));
});
app.on('open-file', (e, file) => { e.preventDefault(); sendOpen({ file }); });
app.on('open-url', (e, url) => { e.preventDefault(); sendOpen({ url }); });
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });

// ---- IPC ----
ipcMain.on('app:ready', () => {
  rendererReady = true;
  if (pendingOpen && win) { win.webContents.send('app:open', pendingOpen); pendingOpen = null; }
});

const tools = () => resolveTools(app.getPath('userData'));

ipcMain.handle('tools:status', () => ({ ...tools(), userData: app.getPath('userData') }));

ipcMain.handle('tools:installYtDlp', async () => {
  const jobId = 'ytdlp-install';
  const p = await installYtDlp(app.getPath('userData'), (pct) => progress(jobId, { percent: pct, stage: 'download' }));
  progress(jobId, { done: true });
  return p;
});

ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', '3gp', 'ogv', 'gif'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_e, { defaultName, ext }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos') || app.getPath('home'), defaultName),
    filters: [ext === 'gif' ? { name: 'Animated GIF', extensions: ['gif'] } : { name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.toLowerCase().endsWith('.' + ext) ? r.filePath : r.filePath + '.' + ext;
});

ipcMain.handle('media:load', async (_e, file) => {
  const t = tools();
  if (!t.ffprobe) throw new Error('ffprobe not found. Install ffmpeg or set CLIPPERRR_FFPROBE.');
  const info = await media.probe(t, file);
  const id = crypto.randomBytes(8).toString('hex');
  loaded.set(id, { info, proxy: null });
  return { id, info, src: `clip://media/${id}` };
});

ipcMain.handle('media:proxy', async (_e, id) => {
  const entry = loaded.get(id);
  if (!entry) throw new Error('Unknown media id');
  const jobId = `proxy-${id}`;
  const job = media.makeProxy(tools(), entry.info, userDir('proxies'), (pct) => progress(jobId, { percent: pct }));
  entry.proxy = await track(jobId, job);
  progress(jobId, { done: true });
  return { src: `clip://media/${id}?proxy=1` };
});

ipcMain.handle('media:download', async (_e, { url, jobId, force }) => {
  const t = tools();
  if (!t.ytdlp) throw new Error('yt-dlp not found.');
  if (!t.ffmpeg) throw new Error('ffmpeg not found.');
  if (!force) {
    const existing = library.findByUrl(url);
    if (existing) { library.touch(existing.id); return { file: existing.file, item: existing, cached: true }; }
  }
  progress(jobId, { stage: 'info', percent: 0 });
  const dir = library.newDir();
  const job = media.download(t, url, dir, (p) => progress(jobId, p));
  let file;
  try { file = await track(jobId, job); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  progress(jobId, { stage: 'index', percent: 1 });
  const info = await media.probe(t, file);
  const item = library.add(buildItem({ url, dir, file, info }));
  library.touch(item.id);
  progress(jobId, { done: true });
  return { file, item, cached: false };
});

// ---- library ----
ipcMain.handle('library:list', () => ({ items: library.list(), root: library.root, totalBytes: library.totalBytes() }));
ipcMain.handle('library:open', (_e, id) => { const it = library.get(id); if (!it) throw new Error('Item no longer exists'); library.touch(id); return it.file; });
ipcMain.handle('library:remove', (_e, id) => library.remove(id));
ipcMain.handle('library:clear', () => library.clear());
ipcMain.handle('library:openFolder', () => shell.openPath(library.root));

ipcMain.handle('media:export', async (_e, { id, jobId, ...opts }) => {
  const entry = loaded.get(id);
  if (!entry) throw new Error('Unknown media id');
  const job = media.exportClip(tools(), { ...opts, info: entry.info }, (pct) => progress(jobId, { percent: pct }));
  const out = await track(jobId, job);
  progress(jobId, { done: true });
  return { output: out };
});

ipcMain.handle('job:cancel', (_e, jobId) => {
  const c = jobs.get(jobId);
  if (c) c();
  return !!c;
});
ipcMain.handle('job:cancelAll', () => { for (const c of jobs.values()) c(); });
ipcMain.handle('shell:showItemInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openExternal', (_e, u) => shell.openExternal(u));

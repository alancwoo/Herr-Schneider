// Library of fetched videos: a JSON index next to the per-download folders.
// Each item lives in its own folder (video + yt-dlp info.json + thumbnail).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class Library {
  constructor(root) {
    this.root = root;
    this.indexFile = path.join(root, 'library.json');
    fs.mkdirSync(root, { recursive: true });
    this.items = [];
    this.load();
  }

  load() {
    try { this.items = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')).items || []; } catch { this.items = []; }
  }

  save() {
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
    fs.renameSync(tmp, this.indexFile);
  }

  // Drop entries whose files vanished (user deleted them by hand).
  prune() {
    const before = this.items.length;
    this.items = this.items.filter((it) => fs.existsSync(it.file));
    if (this.items.length !== before) this.save();
  }

  list() {
    this.prune();
    return [...this.items].sort((a, b) => b.fetchedAt - a.fetchedAt);
  }

  get(id) { return this.items.find((it) => it.id === id) || null; }

  newDir() {
    const dir = path.join(this.root, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  static normalizeUrl(u) {
    try {
      const url = new URL(u.trim());
      url.hash = '';
      for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|si$|feature$|t$)/.test(k)) url.searchParams.delete(k);
      url.hostname = url.hostname.replace(/^(www|m)\./, '');
      return url.toString().replace(/\/$/, '');
    } catch { return u.trim(); }
  }

  // Identity key we can compute from a URL without touching the network.
  // YouTube is special-cased because it has so many URL shapes; other sites
  // fall back to the normalized URL.
  static keyForUrl(u) {
    try {
      const url = new URL(u.trim());
      const host = url.hostname.replace(/^(www|m|music)\./, '');
      let id = null;
      if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
      else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
        id = url.searchParams.get('v');
        const m = /^\/(shorts|embed|live|v)\/([\w-]{6,})/.exec(url.pathname);
        if (!id && m) id = m[2];
      }
      if (id) return `youtube:${id}`;
    } catch {}
    return null;
  }

  findByUrl(u) {
    this.prune();
    const key = Library.keyForUrl(u);
    if (key) { const hit = this.items.find((it) => it.key === key); if (hit) return hit; }
    const n = Library.normalizeUrl(u);
    return this.items.find((it) => it.urls.some((x) => Library.normalizeUrl(x) === n)) || null;
  }

  add(item) {
    item.id = item.id || crypto.randomBytes(6).toString('hex');
    // Same video fetched again (e.g. via a different URL shape): replace the old copy.
    if (item.key) for (const dup of this.items.filter((it) => it.key === item.key && it.id !== item.id)) this.remove(dup.id);
    this.items.push(item);
    this.save();
    return item;
  }

  touch(id) {
    const it = this.get(id);
    if (it) { it.lastOpenedAt = Date.now(); it.opens = (it.opens || 0) + 1; this.save(); }
  }

  remove(id) {
    const it = this.get(id);
    if (!it) return false;
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    if (it.dir && it.dir.startsWith(this.root)) fs.rmSync(it.dir, { recursive: true, force: true });
    else fs.rmSync(it.file, { force: true });
    return true;
  }

  clear() {
    const n = this.items.length;
    for (const it of this.items) if (it.dir && it.dir.startsWith(this.root)) fs.rmSync(it.dir, { recursive: true, force: true });
    this.items = [];
    this.save();
    // Also sweep orphaned folders from failed/cancelled downloads.
    for (const d of fs.readdirSync(this.root)) {
      const p = path.join(this.root, d);
      try { if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    return n;
  }

  totalBytes() { return this.items.reduce((s, it) => s + (it.size || 0), 0); }
}

// Build a library item from a finished download folder + ffprobe info.
function buildItem({ url, dir, file, info }) {
  let meta = {};
  let thumb = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (/\.info\.json$/i.test(f)) { try { meta = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} }
      else if (/\.(jpe?g|png|webp)$/i.test(f)) thumb = p;
    }
  } catch {}
  const pick = (...keys) => { for (const k of keys) if (meta[k] != null && meta[k] !== '') return meta[k]; return null; };
  const urls = [url];
  for (const u of [meta.webpage_url, meta.original_url]) if (u && !urls.includes(u)) urls.push(u);
  const extractor = pick('extractor_key', 'extractor');
  const key = extractor && meta.id ? `${String(extractor).toLowerCase()}:${meta.id}` : null;
  return {
    id: null,
    key,
    urls,
    sourceUrl: url,
    webpageUrl: pick('webpage_url', 'original_url') || url,
    domain: (() => { try { return new URL(pick('webpage_url') || url).hostname.replace(/^www\./, ''); } catch { return null; } })(),
    extractor,
    title: pick('title', 'fulltitle') || info.name.replace(/\.[^.]+$/, ''),
    description: (pick('description') || '').slice(0, 400) || null,
    uploader: pick('uploader', 'channel', 'creator', 'artist'),
    uploadDate: pick('upload_date', 'release_date'),
    viewCount: pick('view_count'),
    remoteThumbnail: pick('thumbnail'),
    thumb,
    dir,
    file,
    fileName: info.name,
    size: info.size,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    vcodec: info.vcodec,
    acodec: info.acodec,
    container: info.container,
    fetchedAt: Date.now(),
    lastOpenedAt: null,
    opens: 0,
  };
}

module.exports = { Library, buildItem };

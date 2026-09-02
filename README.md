<p align="center">
  <img src="docs/wordmark.gif" width="302" alt="Herunterladschneidausgeber collapses into Herr Schneider" />
</p>

<h1 align="center">Herr Schneider</h1>

<p align="center">Paste a link or drop a file. Mark in and out. Export.<br />
A small, precise video clipper for macOS, Windows and Linux.</p>

<p align="center">
  <img src="docs/screenshot.png" width="100%" alt="Herr Schneider main window" />
</p>

## Features

- **Any source.** Open a local file, or paste a YouTube link or any URL yt-dlp understands. The video is fetched, kept in a library, and opened.
- **Frame-accurate.** Arrow keys step single frames. In and out points snap to the frame grid, and the export starts on exactly the frame you marked.
- **Filmstrip timeline.** Thumbnails along the track, a hairline hover cursor with a preview of that exact frame, draggable in/out handles, zoom into the selection.
- **Hear it.** Mute toggle, and audible scrubbing while you drag.
- **One clear export.** Format → Mode → Quality → Size → Audio, with a live source→output summary and an estimated file size and time.
  - MP4: *Precise* re-encodes frame-accurately (Original / 1080p / 720p, 100 / 50 / 25 %), *Fast* copies the streams untouched.
  - Animated GIF with a per-clip palette and selectable frame rate.
- **Library.** Every fetched video is kept with its title, uploader, publish date, description, thumbnail, source URL and format details. Fetching the same link again just opens it. Delete items, clear all, or open the folder.
- **Plays anything.** Formats the built-in player can't decode get an automatic preview proxy. Export always cuts from the original.
- **Monochrome.** Helvetica, hairlines, no colour. Follows your system's light or dark mode.

## Run

```
npm install
npm start
npm start -- path/to/video.mp4
npm start -- "https://youtu.be/…"
```

ffmpeg and ffprobe are bundled. yt-dlp is used from your PATH if present, otherwise downloaded automatically on first fetch. Override any of them with `CLIPPERRR_FFMPEG`, `CLIPPERRR_FFPROBE`, `CLIPPERRR_YTDLP`.

## Build

```
npm run dist:mac      # .dmg, arm64 + x64
npm run dist:win      # NSIS installer + portable .exe
npm run dist:linux    # AppImage + .deb
```

Installers land in `dist/`. macOS builds need a Mac. When building for another OS, fetch that platform's ffmpeg first, e.g. `npm_config_platform=win32 npm_config_arch=x64 npm install ffmpeg-static`.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| P | Preview the clip |
| M | Mute / unmute |
| ← → | One frame (Shift: 1 s, Alt: 5 s) |
| , . | One frame (Shift: 10 frames) |
| I / O | Set in / out at the playhead |
| [ ] | Jump to in / out |
| Z / Shift+Z | Zoom to selection / reset |
| Ctrl/Cmd+O | Open file |
| Ctrl/Cmd+L | Open link |
| Ctrl/Cmd+B | Library |
| Ctrl/Cmd+S | Export |
| ? | All shortcuts |

## The name

The full name is *Herunterladschneidausgeber*: download-cut-exporter. Strike out the spare letters and what remains is **Herr Schneider**, Mr. Cutter.

Fetched videos live in the app data folder (`~/Library/Application Support/herunterladschneidausgeber/sources` on macOS, `%APPDATA%\herunterladschneidausgeber\sources` on Windows, `~/.config/herunterladschneidausgeber/sources` on Linux).

MIT. Built on Electron, ffmpeg and yt-dlp. Screenshot footage: [Sintel](https://durian.blender.org), © Blender Foundation, CC BY 3.0.

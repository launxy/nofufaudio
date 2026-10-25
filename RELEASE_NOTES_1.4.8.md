# NofufAudio 1.4.8 — Release Notes

## Summary
Version 1.4.8 focuses on quality of life: the queue now survives restarts, the library is
searchable, sortable and groupable, track starts are faster, and it adds infinite radio,
a mini-player, Discord Rich Presence, ListenBrainz scrobbling, persistent downloads and a
large batch of bug fixes and performance work.

## Changes vs. 1.4.7

### Playback & queue
- **Persistent queue**: the queue, the current track and the playback position are saved and
  restored on launch (no forced autoplay; toggle in Settings → Playback, "Reanudar cola al abrir").
- **Faster track starts**: the next 3 tracks of the queue are pre-resolved in the background and
  YouTube stream URLs older than ~4 h are silently re-resolved before they can fail.
- **Infinite Radio**: new "Radio" toggle in the queue view; when the queue ends the app fetches
  related tracks (YouTube mix) and keeps playing.
- **Sleep timer**: pause after 15/30/60 minutes or at the end of the current track, with a live
  countdown in the button tooltip.
- Shuffle no longer repeats the current track; crossfade restores the volume after a backward
  seek; a failed resume no longer leaves a fake "playing" state.

### Library
- Instant search, sorting (added order / title / artist / most played) and grouping by artist or
  album with sticky section headers.
- **Multi-select** (Ctrl/Shift + click) in library and favorites with a floating action bar:
  play now, add to queue, add to playlist, bulk remove. Esc clears the selection.
- Tracks can be **dragged onto sidebar playlists** to add them.

### Stats
- Play counts per track, a "Top del mes" shelf on Home and an auto-maintained "Tus hits"
  playlist (top 25 most played).

### Downloads
- **Persistent download queue**: unfinished downloads resume automatically on launch
  (yt-dlp keeps its .part files).
- Optional **filename template** (e.g. `{artist} - {title}`) in Settings → Descargas, applied to
  every YouTube download path.
- Copy progress now sends ~1 IPC message per percent instead of one per chunk.

### Integrations (new Settings section)
- **Discord Rich Presence**: dependency-free module that speaks the local Discord IPC socket
  protocol directly; the Application ID is configurable in Settings.
- **ListenBrainz scrobbling**: listens are submitted after 50 % of the track or 4 minutes,
  whichever comes first; token validation built in.

### Player UI
- **Mini-player**: compact always-on-top window with cover, progress bar and transport controls.
- Stream **quality tooltip** (codec · bitrate, e.g. "opus · 160kbps") on the artist label.
- Keyboard focus indicators app-wide (`:focus-visible`, text fields keep their own focus style),
  consistent scrollbars, higher-contrast secondary text, adapted sidebar/panels on narrow
  windows and `prefers-reduced-motion` support.

### Performance
- Switching tracks no longer rebuilds the whole queue DOM (only the active row toggles class).
- Settings and library writes are debounced: dragging sliders no longer writes to disk on every
  tick and the background image is no longer rewritten during drag.
- Library rows outside the viewport are skipped by the renderer (`content-visibility`), the
  playlist view re-renders throttled and the thumbnail prefetch is O(n) instead of O(n²).
- Google Fonts load non-blocking, so startup stays fast offline; removed a 404 request
  (`tauri-shim.js`) on every launch.
- Visualizer: no more perpetual 300 ms polling when hidden or disabled, cached fade gradient,
  and HiDPI (devicePixelRatio) canvas rendering.

### Bug fixes
- Fixed drag & drop of audio files (Electron ≥32 removed `File.path`; paths are now resolved
  through `webUtils.getPathForFile` in the preload).
- The URL add button and the playlist-import overlay can no longer get stuck after a failed
  resolution (try/finally).
- Long-pressing a queue item without moving no longer swallows the click, so the track plays.
- Volume normalization keeps working when the Nightcore audio chain is built; the WebAudio chain
  re-connects itself after an equalizer rebuild.
- Visualizer cover art now displays (it read a non-existent `track.art`).
- Fixed an init race where disk configuration could be overwritten by stale localStorage, and
  removed calls to two render functions that never existed.
- Hardened HTML interpolation: external thumbnails, covers and ids are escaped in attributes.

## Files touched
- `resources/app/main.js` — stream quality in yt-dlp output, `check-youtube-session`, ListenBrainz IPC,
  Discord RPC wiring, mini-player window, download filename template, throttled copy progress.
- `resources/app/preload.js` — new APIs: `getPathForFile`, `checkYoutubeSession`,
  `lbValidateToken` / `lbSubmitListen`, `rpcUpdate` and the mini-player bridge.
- `resources/app/src/app.js` — all features and fixes listed above.
- `resources/app/src/index.html` — library toolbar, radio/sleep/mini buttons, multi-select bar,
  popovers, settings rows (session check, resume queue, filename template, Integraciones),
  Home "Top del mes".
- `resources/app/src/style.css` — styles for the new UI, focus/scrollbar/contrast/narrow-window
  improvements and `content-visibility`.
- `resources/app/src/mini.html` — new mini-player window.
- `resources/app/discordRPC.js` — new dependency-free Discord Rich Presence module.
- `resources/app/src/i18n.js` — new Spanish strings.
- `resources/app/package.json` — version 1.4.8.

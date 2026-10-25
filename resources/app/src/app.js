
let queue        = [];
let currentIndex = -1;
let isPlaying    = false;
let isMuted      = false;
let currentVolume = 0.8;
let searchMode   = 'yt';
let isShuffle    = false;
let isRepeat     = false;
let isRadio      = false;
let _sleepAtEnd  = false; // sleep timer "al acabar esta canción" (lo consume el handler 'ended')

let library   = [];
let favorites = [];
let playlists = [];
let settings  = {};
let currentPlaylistId = null;
let ctxTrack  = null;
let ctxContext = null;
let lyricsPanelOpen = false;
let editingTrackId = null;
let crossfadeTimer = null;
let _audioRetryCount    = 0;
let _audioRetryInProgress = false;
let _playGeneration     = 0;

// Hooks que initExtraFeatures (IIFE final) reasigna; no-ops hasta entonces
function _updateRpcState() {}
function _syncMiniNow() {}
function _syncMiniTime() {}
function _scrobbleSchedule(t) {}
function _scrobbleTick() {}
function _initExtraAfterData() {}

let _lastLyricsResult = null;
const _LYRICS_CACHE_MAX = 40;
const _lyricsCache = new Map();
let _romajiActive = false;
let _syncedLines = null;
let _activeLrcLineIdx = -1;

let _kuroshiroInstance = null;
let _kuroshiroInitPromise = null;
let _romanizeActive = false;
let _lastLyricsEntry = null;
let _lyricsRenderToken = 0;

const _LRC_OFFSET_STEP = 250, _LRC_OFFSET_MIN = -10000, _LRC_OFFSET_MAX = 10000;
let _lrcOffsetSec = 0;
function _lrcOffsetMs() {
  const v = parseInt(settings.lyricsOffsetMs, 10);
  return Number.isFinite(v) ? Math.min(_LRC_OFFSET_MAX, Math.max(_LRC_OFFSET_MIN, v)) : 0;
}
function _lrcRenderOffset() {
  _lrcOffsetSec = _lrcOffsetMs() / 1000;
  const val = document.getElementById('lyrics-offset-val');
  if (val) {
    const ms = _lrcOffsetMs();
    val.textContent = (ms > 0 ? '+' : '') + ms + ' ms';
  }
}
function _lrcBumpOffset(delta) {
  settings.lyricsOffsetMs = _lrcOffsetMs() + delta;
  saveSettings();
  _lrcRenderOffset();
  _activeLrcLineIdx = -99;
}

const KEYS = {
  library:'nfa_library', favorites:'nfa_favorites',
  playlists:'nfa_playlists', settings:'nfa_settings',
  queue:'nfa_queue', playcounts:'nfa_playcounts', downloads:'nfa_downloads'
};
const DEFAULT_SETTINGS = {
  defaultVolume: 80,
  crossfade: false,
  crossfadeDuration: 3,
  normalize: false,
  autoplay: true,
  showDuration: true,
  spinArt: true,
  accentColor: '#ffffff',
  autoLyrics: false,
  lyricsSize: 13,
  lyricsFont: 'inherit',
  lyricsOffsetMs: 0,
  minimizeTray: true,
  closeTray: true,
  hideWindowControls: false,
  syncedLyrics: true,
  downloadDir: '',
  downloadFormat: 'mp3',
  vizEnabled: true,
  vizStyle: 'bars',
  vizColor: '#ffffff',
  vizShadow: true,
  vizSensitivity: 1.5,
  theme: null,
  language: 'es',
  cookieBrowser: 'auto',
  appIcon: 'default',
  trayIcon: 'tray-default',
  resumeOnOpen: true,
  radioEnabled: false,
  downloadTemplate: '{artist} - {title}',
  discordRpc: false,
  discordClientId: '',
  lbEnabled: false,
  lbToken: '',
};

let _selAppIcon = 'default';
let _selTrayIcon = 'tray-default';
let _iconEntries = [];

function _iconLabel(entry) {
  const t = (window.i18n && window.i18n.t) ? window.i18n.t.bind(window.i18n) : null;
  if (entry.id === 'default') return t ? t('settings.iconDefault') : 'Original';
  if (entry.id === 'alt') return t ? t('settings.iconAlt') : 'Alternativo';
  if (entry.id === 'tray-default') return t ? t('settings.iconTrayDefault') : 'Tray original';
  if (entry.id.startsWith('custom:')) {
    const f = entry.id.slice(7).replace(/^custom-\d+-/, '').replace(/\.png$/i, '');
    return f || entry.id;
  }
  return entry.id;
}

function _iconGridHTML(selectedId, sizeClass) {
  return _iconEntries.map(e => {
    const label = _iconLabel(e);
    return `<button class="icon-pick ${sizeClass}${e.id === selectedId ? ' active' : ''}" data-icon-id="${escapeHTML(e.id)}" title="${escapeHTML(label)}">` +
      `<img src="${e.url}" alt="" loading="lazy" onerror="this.style.display='none'">` +
      `<span>${escapeHTML(label)}</span></button>`;
  }).join('');
}

function _bindIconGrid(gridId, getSel, setSel) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.querySelectorAll('.icon-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      setSel(btn.dataset.iconId);
      grid.querySelectorAll('.icon-pick').forEach(b =>
        b.classList.toggle('active', b.dataset.iconId === getSel()));
    });
  });
}

async function _renderIconSelectors() {
  const appGrid = document.getElementById('setting-appicon-grid');
  const trayGrid = document.getElementById('setting-trayicon-grid');
  if (!appGrid || !trayGrid) return;
  try {
    if (window.nofuf?.listIcons) {
      const list = await window.nofuf.listIcons();
      if (Array.isArray(list) && list.length) _iconEntries = list;
    }
  } catch (_) {}
  const valid = new Set(_iconEntries.map(e => e.id));
  if (!valid.has(_selAppIcon)) _selAppIcon = 'default';
  if (!valid.has(_selTrayIcon)) _selTrayIcon = 'tray-default';
  appGrid.innerHTML = _iconGridHTML(_selAppIcon, 'icon-dock');
  trayGrid.innerHTML = _iconGridHTML(_selTrayIcon, 'icon-tray');
  _bindIconGrid('setting-appicon-grid', () => _selAppIcon, v => { _selAppIcon = v; });
  _bindIconGrid('setting-trayicon-grid', () => _selTrayIcon, v => { _selTrayIcon = v; });
}

function _stripStrayFontScale(theme) {
  if (theme && typeof theme === 'object' && '--font-scale' in theme) {
    delete theme['--font-scale'];
  }
  return theme;
}

function loadData() {
  try { library   = JSON.parse(localStorage.getItem(KEYS.library)   || '[]'); } catch { library=[]; }
  try { favorites = JSON.parse(localStorage.getItem(KEYS.favorites) || '[]'); } catch { favorites=[]; }
  try { playlists = JSON.parse(localStorage.getItem(KEYS.playlists) || '[]'); } catch { playlists=[]; }
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
    settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    _stripStrayFontScale(settings.theme);
  } catch { settings = { ...DEFAULT_SETTINGS }; }
}

(function applyEarlyTheme() {
  try {
    const rawStr = localStorage.getItem(KEYS.settings);
    const raw = JSON.parse(rawStr || '{}');
    settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    _stripStrayFontScale(settings.theme);
    if (settings.theme) applyTheme(settings.theme);
  document.body.classList.toggle('hide-window-controls', !!settings.hideWindowControls);
  try { _lrcRenderOffset(); } catch (_) {}
  } catch (e) {}
})();

function _cfgWrite(name, data) {
  try {
    if (window.nofuf?.configWrite)
      window.nofuf.configWrite(name, JSON.stringify(data, null, 2));
  } catch (e) {  }
}
async function _cfgRead(name) {
  try {
    if (!window.nofuf?.configRead) return null;
    const txt = await window.nofuf.configRead(name);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) { return null; }
}

function _cleanTrackForDisk(t) {
  if (!t || typeof t !== 'object') return t;
  const c = { ...t };
  // Estado transitorio de memoria: una Promise serializa como {} (truthy) y
  // al recargar bloquea resolveLazyTrack (early-return sin resolver → src='').
  delete c._resolving;
  delete c._albumChecked;
  return c;
}
function saveLibrary() {
  const clean = library.map(_cleanTrackForDisk);
  localStorage.setItem(KEYS.library, JSON.stringify(clean));
  _cfgWrite('library.json', clean);
}
function _debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  return wrapped;
}
// Serializa TODA la biblioteca (localStorage + IPC a disco): agrupar escrituras frecuentes
const saveLibrarySoon = _debounce(saveLibrary, 1200);
let _plViewRenderTimer = null;
function renderPlaylistViewThrottled(pl) {
  if (!pl) return;
  if (_plViewRenderTimer) return;
  _plViewRenderTimer = setTimeout(() => {
    _plViewRenderTimer = null;
    const cur = playlists.find(p => p.id === pl.id);
    if (cur && currentPlaylistId === pl.id) renderPlaylistView(cur);
  }, 1000);
}

// ============ Cola persistente ============
// La cola se guarda (pistas, índice y posición) para reanudarla al abrir.
// Las URLs de stream caducan, así que las pistas de YouTube se marcan lazy de nuevo.
function _queueSaveState() {
  return {
    tracks: queue.map(t => {
      const c = _cleanTrackForDisk(t);
      if (c.type === 'youtube') { c.url = ''; c.lazy = true; }
      return c;
    }),
    index: currentIndex,
    position: (isPlaying && audioPlayer.duration) ? audioPlayer.currentTime : (_resumePosition || 0),
    ts: Date.now(),
  };
}
function saveQueueNow() {
  if (!queue.length) { try { localStorage.removeItem(KEYS.queue); } catch {} return; }
  try { localStorage.setItem(KEYS.queue, JSON.stringify(_queueSaveState())); } catch {}
}
const saveQueueSoon = _debounce(saveQueueNow, 800);

let _resumePosition = 0;
function restoreSavedQueue() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEYS.queue) || 'null'); } catch {}
  if (!saved || !Array.isArray(saved.tracks) || !saved.tracks.length) return false;
  queue = saved.tracks.map(t => ({ ...t }));
  const idx = Number.isInteger(saved.index) ? saved.index : 0;
  currentIndex = (idx >= 0 && idx < queue.length) ? idx : 0;
  _resumePosition = Math.max(0, Number(saved.position) || 0);
  const t = queue[currentIndex];
  if (t) {
    try { syncNowPlayingHeader(t); } catch (_) {}
    try { updateFavBtn(t.id); } catch (_) {}
  }
  updatePlaybackUI();
  return true;
}
function saveFavorites() {
  localStorage.setItem(KEYS.favorites, JSON.stringify(favorites));
  _cfgWrite('favorites.json', favorites);
}
function savePlaylists() {
  localStorage.setItem(KEYS.playlists, JSON.stringify(playlists));
  _cfgWrite('playlists.json', playlists);
}
function saveSettings() {
  if (window.i18n && window.i18n.getLanguage) settings.language = window.i18n.getLanguage();
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  _cfgWrite('settings.json', settings);
}
// Los sliders escriben settings en cada evento input: agrupar para no martillear el disco
const saveSettingsSoon = _debounce(saveSettings, 500);

// Carga del disco antes del primer render: DOMContentLoaded espera a esta promesa
// para que los datos de library.json/settings.json nunca sean pisados por los de localStorage.
let _initConfigPromise = (async function initConfigFiles() {
  if (!window.nofuf?.configRead || !window.nofuf?.configWrite) return;
  try {
    const FILES = [
      { name: 'library.json',    empty: [] },
      { name: 'favorites.json',  empty: [] },
      { name: 'playlists.json',  empty: [] },
      { name: 'settings.json',   empty: {} },
      { name: 'background.json', empty: {} },
    ];

    const results = await Promise.all(FILES.map(async ({ name, empty }) => {
      let txt = await window.nofuf.configRead(name);
      if (txt === null || txt === undefined) {
        await window.nofuf.configWrite(name, JSON.stringify(empty, null, 2));
        return null;
      }
      try { return JSON.parse(txt); } catch { return null; }
    }));

    const [lib, favs, pls, cfg, bg] = results;
    let changed = false;

    if (Array.isArray(lib))  {
      library = lib.map(t => {
        const c = t.type === 'youtube' ? { ...t, url: '', lazy: true } : { ...t };
        // Basura transitoria de sesiones anteriores (Promise → {} truthy):
        // impediría resolver el stream al reproducir.
        delete c._resolving;
        delete c._albumChecked;
        return c;
      });
      localStorage.setItem(KEYS.library, JSON.stringify(library));
      changed = true;
    }
    if (Array.isArray(favs)) { favorites = favs; localStorage.setItem(KEYS.favorites, JSON.stringify(favorites)); changed = true; }
    if (Array.isArray(pls))  { playlists = pls;  localStorage.setItem(KEYS.playlists, JSON.stringify(playlists)); changed = true; }
    if (cfg && typeof cfg === 'object' && Object.keys(cfg).length > 0) {
      if (cfg.theme && cfg.theme['--bg-image'] && (!bg || !bg.dataUrl)) {
        const migratedBg = { dataUrl: cfg.theme['--bg-image'], opts: {} };
        try { migratedBg.opts = JSON.parse(cfg.theme['--bg-opts'] || '{}'); } catch {}
        await window.nofuf.configWrite('background.json', JSON.stringify(migratedBg, null, 2));
        delete cfg.theme['--bg-image'];
        delete cfg.theme['--bg-opts'];
      }
      const prevTheme = (settings && settings.theme) || {};
      const diskTheme = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};
      const mergedTheme = _stripStrayFontScale(Object.assign({}, prevTheme, diskTheme));
      if (prevTheme['--base-font-size']) {
        mergedTheme['--base-font-size'] = prevTheme['--base-font-size'];
      }
      settings = Object.assign({}, DEFAULT_SETTINGS, cfg, {
        theme: Object.keys(mergedTheme).length ? mergedTheme : null,
      });
      localStorage.setItem(KEYS.settings, JSON.stringify(settings));
      changed = true;
    }

    if (changed) {
      try { applySettings(); }          catch(e) {}
      try { applyTheme(settings.theme); } catch(e) {}
      try { renderLibraryUI(); }         catch(e) {}
      try { renderSidebarPlaylists(); }  catch(e) {}
      try { renderFavoritesUI(); }       catch(e) {}
      try {
        if (settings.eqGains) { _eqGains = [...settings.eqGains]; _eqUpdateAllUI(); _eqApplyGains(); }
        document.querySelectorAll('.eq-preset-btn[data-preset]').forEach(b => b.classList.remove('active'));
        if (settings.eqPreset) {
          _eqActivePreset = settings.eqPreset;
          if (!_eqActivePreset.startsWith('user:')) {
            document.querySelectorAll('.eq-preset-btn[data-preset]').forEach(b =>
              b.classList.toggle('active', b.dataset.preset === _eqActivePreset));
          }
        }
        _eqRenderUserPresets();
      } catch(e) {}

      try {
        const pending = library.filter(t =>
          t.thumbnail && (!t.cover || !t.cover.startsWith('data:'))
        );
        if (pending.length > 0) preFetchYouTubeThumbnails(pending);
      } catch(e) {}
    }

    const bgData = bg && bg.dataUrl ? bg
                 : null;
    if (bgData) {
      window._nofufPendingBg = bgData;
      if (typeof window._nofufApplyBg === 'function') {
        try { window._nofufApplyBg(bgData.dataUrl, bgData.opts); } catch(e) {}
      }
    }

  } catch (e) { console.warn('[nofuf] initConfigFiles:', e); }
})();

const audioPlayer = new Audio();

const _domNoop = new Proxy(function(){}, {
  get(t, k)    { return k === Symbol.toPrimitive ? () => '' : _domNoop; },
  set()        { return true; },
  apply()      { return _domNoop; },
  construct()  { return _domNoop; },
});

const dom = {
  btnMinimize:    document.getElementById('btn-minimize'),
  btnMaximize:    document.getElementById('btn-maximize'),
  btnClose:       document.getElementById('btn-close'),
  btnReload:      document.getElementById('btn-reload'),
  btnSettings:    document.getElementById('btn-settings'),
  btnImportFiles: document.getElementById('btn-import-files'),
  btnImportFolder:document.getElementById('btn-import-folder'),
  btnImportFiles2:document.getElementById('btn-import-files-2'),
  sidebar:        document.querySelector('.sidebar'),
  dropOverlay:    document.getElementById('drop-overlay'),
  urlInput:       document.getElementById('url-input'),
  urlAddBtn:      document.getElementById('url-add-btn'),
  urlStatus:      document.getElementById('url-status'),
  ytSearchInput:  document.getElementById('yt-search-input'),
  ytSearchClear:  document.getElementById('yt-search-clear'),
  ytSearchPanel:  document.getElementById('yt-search-panel'),
  ytSearchOverlay:document.getElementById('yt-search-overlay'),
  ytResultsList:  document.getElementById('yt-results-list'),
  ytSearchPlaceholder: document.getElementById('yt-search-placeholder'),
  ytPanelClose:   document.getElementById('yt-search-panel-close'),
  trackSource:    _domNoop,
  trackTitle:     _domNoop,
  trackArtist:    _domNoop,
  artPlaceholder: _domNoop,
  artImage:       _domNoop,
  queueList:      document.getElementById('queue-list'),
  queueEmpty:     document.getElementById('queue-empty'),
  libraryList:    document.getElementById('library-list'),
  libraryEmpty:   document.getElementById('library-empty'),
  favoritesList:  document.getElementById('favorites-list'),
  favoritesEmpty: document.getElementById('favorites-empty'),
  playlistTrackList: document.getElementById('playlist-track-list'),
  playlistEmpty:  document.getElementById('playlist-empty'),
  btnShuffle:     document.getElementById('btn-shuffle'),
  btnRepeat:      document.getElementById('btn-repeat'),
  btnShuffleQ:    document.getElementById('btn-shuffle-queue'),
  btnRepeatQ:     document.getElementById('btn-repeat-queue'),
  btnClearQueue:  document.getElementById('btn-clear-queue'),
  timeCurrent:    document.getElementById('time-current'),
  timeTotal:      document.getElementById('time-total'),
  progressTrack:  document.getElementById('progress-track'),
  progressFill:   document.getElementById('progress-fill'),
  progressThumb:  document.getElementById('progress-thumb'),
  btnMute:        document.getElementById('btn-mute'),
  volIconOn:      document.getElementById('vol-icon-on'),
  volIconOff:     document.getElementById('vol-icon-off'),
  volTrack:       document.getElementById('vol-track'),
  volFill:        document.getElementById('vol-fill'),
  volThumb:       document.getElementById('vol-thumb'),
  volNumberInput: document.getElementById('vol-number-input'),
  btnPrev:        document.getElementById('btn-prev'),
  btnPlay:        document.getElementById('btn-play'),
  btnNext:        document.getElementById('btn-next'),
  playIcon:       document.getElementById('play-icon'),
  pauseIcon:      document.getElementById('pause-icon'),
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText:    document.getElementById('loading-text'),
  toast:          document.getElementById('toast'),
  barArt:         document.getElementById('bar-art'),
  barTitle:       document.getElementById('bar-title-display'),
  barArtist:      document.getElementById('bar-artist-display'),
  barFavBtn:      document.getElementById('bar-fav-btn'),
  lyricsPanel:    document.getElementById('lyrics-panel'),
  lyricsClose:    document.getElementById('lyrics-close'),
  lyricsBody:     document.getElementById('lyrics-body'),
  lyricsArt:      document.getElementById('lyrics-art'),
  lyricsTrackName:document.getElementById('lyrics-track-name'),
  lyricsArtistName:document.getElementById('lyrics-artist-name'),
  lyricsSourceBar:document.getElementById('lyrics-source-bar'),
  lyricsSourceSelect:document.getElementById('lyrics-source-select'),
  playlistHeroName: document.getElementById('playlist-hero-name'),
  playlistHeroCount:document.getElementById('playlist-hero-count'),
  playlistHeroArt:  document.getElementById('playlist-hero-art'),
  playlistArtOverlay:document.getElementById('playlist-art-overlay'),
  playlistCoverInput:document.getElementById('playlist-cover-input'),
  playlistPlayBtn:   document.getElementById('playlist-play-btn'),
  playlistAddFromQueue:document.getElementById('playlist-add-from-queue'),
  playlistDeleteBtn: document.getElementById('playlist-delete-btn'),
  playlistListSidebar:document.getElementById('playlist-list-sidebar'),
  btnNewPlaylist:    document.getElementById('btn-new-playlist'),
  modalBackdrop:   document.getElementById('modal-backdrop'),
  modalClose:      document.getElementById('modal-close'),
  modalCancel:     document.getElementById('modal-cancel'),
  modalCreate:     document.getElementById('modal-create'),
  modalNameInput:  document.getElementById('modal-playlist-name'),
  modalArtPick:    document.getElementById('modal-art-pick'),
  modalCoverInput: document.getElementById('modal-cover-input'),
  modalArtPreview: document.getElementById('modal-art-preview'),
  modalEditBackdrop: document.getElementById('modal-edit-backdrop'),
  modalEditClose:    document.getElementById('modal-edit-close'),
  modalEditCancel:   document.getElementById('modal-edit-cancel'),
  modalEditSave:     document.getElementById('modal-edit-save'),
  editTitleInput:    document.getElementById('edit-title-input'),
  editArtistInput:   document.getElementById('edit-artist-input'),
  editArtPick:       document.getElementById('edit-art-pick'),
  editArtPreview:    document.getElementById('edit-art-preview'),
  editCoverInput:    document.getElementById('edit-cover-input'),
  modalSettingsBackdrop: document.getElementById('modal-settings-backdrop'),
  modalSettingsClose:    document.getElementById('modal-settings-close'),
  modalSettingsCancel:   document.getElementById('modal-settings-cancel'),
  modalSettingsSave:     document.getElementById('modal-settings-save'),
  settingDefaultVolume:  document.getElementById('setting-default-volume'),
  settingDefaultVolumeVal: document.getElementById('setting-default-volume-val'),
  settingCrossfade:      document.getElementById('setting-crossfade'),
  settingCrossfadeDuration: document.getElementById('setting-crossfade-duration'),
  settingCrossfadeDurationVal: document.getElementById('setting-crossfade-duration-val'),
  crossfadeDurationRow:  document.getElementById('crossfade-duration-row'),
  settingNormalize:      document.getElementById('setting-normalize'),
  settingAutoplay:       document.getElementById('setting-autoplay'),
  settingShowDuration:   document.getElementById('setting-show-duration'),
  settingSpinArt:        document.getElementById('setting-spin-art'),
  settingAutoLyrics:     document.getElementById('setting-auto-lyrics'),
  settingMinimizeTray:   document.getElementById('setting-minimize-tray'),
  settingCloseTray:      document.getElementById('setting-close-tray'),
  settingCookieBrowser:  document.getElementById('setting-cookie-browser'),
  settingCookieBrowserStatus: document.getElementById('setting-cookie-browser-status'),
  settingManualCookies:  document.getElementById('setting-manual-cookies'),
  settingManualCookiesStatus: document.getElementById('setting-manual-cookies-status'),
  settingManualCookiesSave:  document.getElementById('setting-manual-cookies-save'),
  settingManualCookiesClear: document.getElementById('setting-manual-cookies-clear'),
  settingImportLibraryBtn:    document.getElementById('setting-import-library-btn'),
  settingImportLibraryStatus: document.getElementById('setting-import-library-status'),
  settingHideWindowControls: document.getElementById('setting-hide-window-controls'),
  ctxMenu:         document.getElementById('ctx-menu'),
  ctxEdit:         document.getElementById('ctx-edit'),
  ctxPlaylistOpts: document.getElementById('ctx-playlist-options'),
  ctxFav:          document.getElementById('ctx-fav'),
  ctxLib:          document.getElementById('ctx-lib'),
  ctxPlayNext:     document.getElementById('ctx-play-next'),
  ctxDelete:       document.getElementById('ctx-delete'),
  navItems:        document.querySelectorAll('.nav-item'),
  views:           document.querySelectorAll('.view'),
};

document.addEventListener('DOMContentLoaded', async () => {
  // Esperar a la carga de configuración del disco para no pintar datos viejos de localStorage
  try { await (_initConfigPromise || Promise.resolve()); } catch (_) {}
  loadData();
  loadRecentlyPlayed();
  loadPlayCounts();
  applySettings();
  currentVolume = settings.defaultVolume / 100;
  setVolume(currentVolume);
  setupEventListeners();
  // Reanudar la cola de la sesión anterior (sin autoplay)
  const _queueRestored = settings.resumeOnOpen !== false ? restoreSavedQueue() : false;
  renderSidebarPlaylists();
  updateQueueUI();
  renderLibraryUI();
  renderFavoritesUI();
  renderHomeView();
  refreshAutoHitsPlaylist();
  _initExtraAfterData();
  showView('home');
  if (_queueRestored) {
    showToast(window.i18n && window.i18n.T ? window.i18n.T('Cola restaurada · pulsa play para continuar') : 'Cola restaurada · pulsa play para continuar');
  }
  _initDownloadsResume();
});

window.addEventListener('load', () => {
  if (settings.theme) applyTheme(settings.theme);
});

function applySettings() {
  if (settings.theme) applyTheme(settings.theme);
  if (window.nofuf && window.nofuf.setCookieBrowser) {
    window.nofuf.setCookieBrowser(settings.cookieBrowser || 'auto').catch(() => {});
  }
  const accentVal = (settings.theme && settings.theme['--accent']) || settings.accentColor || '#ffffff';
  document.documentElement.style.setProperty('--accent', accentVal);
  const _lyricsSize = settings.lyricsSize || 13;
  document.documentElement.style.setProperty('--lyrics-font-size', _lyricsSize + 'px');
  const lt = document.querySelector('.lyrics-text');
  if (lt) {
    lt.style.fontSize = _lyricsSize + 'px';
    if (settings.lyricsFont) lt.style.fontFamily = settings.lyricsFont;
  }
  const _lsSlider = document.getElementById('tp-lyrics-size');
  const _lsVal    = document.getElementById('tp-lyrics-size-val');
  if (_lsSlider) { _lsSlider.value = _lyricsSize; }
  if (_lsVal)    { _lsVal.textContent = _lyricsSize + 'px'; }
  document.querySelectorAll('.qi-dur').forEach(el => {
    el.classList.toggle('hidden', !settings.showDuration);
  });
  document.body.classList.toggle('hide-window-controls', !!settings.hideWindowControls);
  const img = dom.artImage;
  if (settings.spinArt && isPlaying) {
    img.classList.add('spinning');
    img.classList.remove('paused');
  } else if (!settings.spinArt) {
    img.classList.remove('spinning', 'paused');
  }
}

function showView(name) {
  if (window.closeArtistPage) window.closeArtistPage();
  dom.views.forEach(v => v.classList.remove('active'));
  dom.navItems.forEach(n => n.classList.remove('active'));
  const v = document.getElementById('view-' + name);
  if (v) v.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (nav) nav.classList.add('active');
  document.querySelectorAll('.sb-playlist').forEach(el => el.classList.remove('active'));
  if (name === 'playlist') {
    const active = document.querySelector(`.sb-playlist[data-id="${currentPlaylistId}"]`);
    if (active) active.classList.add('active');
  }
}

function getGreeting() {
  const h = new Date().getHours();
  const key = (h < 6) ? 'home.greetingNight'
    : (h < 12) ? 'home.greetingMorning'
    : (h < 18) ? 'home.greetingAfternoon'
    : 'home.greetingNight';
  return (window.i18n && window.i18n.t) ? window.i18n.t(key) : 'Buenas tardes';
}

function renderHomeView() {
  const greetEl = document.getElementById('home-greeting');
  if (greetEl) greetEl.textContent = getGreeting();

  const recentShelf = document.getElementById('home-recents-shelf');
  if (recentShelf) {
    recentShelf.className = 'home-shelf recents-shelf';
    const recents = getRecentlyPlayed();
    if (recents.length === 0) {
      recentShelf.innerHTML = `<div class="home-empty-hint">${window.i18n ? window.i18n.T('Aún no has reproducido nada') : 'Aún no has reproducido nada'}</div>`;
    } else {
      recentShelf.innerHTML = recents.map(t => {
        const src = t.cover || t.thumbnail || '';
        const artHtml = src
          ? `<img src="${src}" alt="" loading="lazy">`
          : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        return `<div class="home-recent-card" data-id="${t.id}">
          <div class="home-recent-art">${artHtml}</div>
          <span class="home-recent-title">${escapeHTML(t.title)}</span>
        </div>`;
      }).join('');
      recentShelf.querySelectorAll('.home-recent-card').forEach(el => {
        el.addEventListener('contextmenu', e => { e.preventDefault(); const t = findTrackById(el.dataset.id); if (t) openCtxMenu(e, t, 'home'); });
        el.addEventListener('click', () => {
          const t = findTrackById(el.dataset.id);
          if (!t) return;
          if (!queue.find(q => q.id === t.id)) queue.push({...t});
          const qi = queue.findIndex(q => q.id === t.id);
          updateQueueUI(); showView('queue'); playTrack(qi);
        });
      });
    }
  }

  const sugShelf = document.getElementById('home-suggestions-shelf');
  if (sugShelf) renderSuggestionsShelf(sugShelf);

  renderTopShelf();

  const plShelf = document.getElementById('home-playlists-shelf');
  if (plShelf) {
    if (playlists.length === 0) {
      plShelf.innerHTML = `<div class="home-empty-hint">${window.i18n ? window.i18n.T('Importa una playlist para verla aquí') : 'Importa una playlist para verla aquí'}</div>`;
    } else {
      plShelf.innerHTML = playlists.slice(0, 12).map(pl => {
        const src = pl.cover || '';
        const artHtml = src
          ? `<img src="${src}" alt="">`
          : `<svg class="home-card-art-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        const count = pl.tracks.length;
        return `<div class="home-card" data-pl="${pl.id}">
          <div class="home-card-art">
            ${artHtml}
            <div class="home-card-play">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="home-card-title">${escapeHTML(pl.name)}</div>
          <div class="home-card-sub">${count} canción${count !== 1 ? 'es' : ''}</div>
        </div>`;
      }).join('');
      plShelf.querySelectorAll('.home-card').forEach(el => {
        el.addEventListener('click', () => openPlaylist(el.dataset.pl));
        el.querySelector('.home-card-play')?.addEventListener('click', e => {
          e.stopPropagation();
          const pl = playlists.find(p => p.id === el.dataset.pl);
          if (!pl || !pl.tracks.length) return;
          const tracks = pl.tracks.map(id => findTrackById(id)).filter(Boolean);
          queue = [...tracks];
          updateQueueUI(); showView('queue'); playTrack(0);
        });
      });
    }
  }

  const libShelf = document.getElementById('home-library-shelf');
  if (libShelf) {
    if (library.length === 0) {
      libShelf.innerHTML = `<div class="home-empty-hint">${window.i18n ? window.i18n.T('Importa canciones para verlas aquí') : 'Importa canciones para verlas aquí'}</div>`;
    } else {
      libShelf.innerHTML = library.slice(0, 12).map(t => {
        const src = t.cover || t.thumbnail || '';
        const artHtml = src
          ? `<img src="${src}" alt="" loading="lazy">`
          : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        return `<div class="home-card" data-id="${t.id}">
          <div class="home-card-art">
            ${artHtml}
            <div class="home-card-play">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="home-card-title">${escapeHTML(t.title)}</div>
          <div class="home-card-sub">${escapeHTML(t.artist)}</div>
        </div>`;
      }).join('');
      libShelf.querySelectorAll('.home-card').forEach(el => {
        el.addEventListener('contextmenu', e => { e.preventDefault(); const t = findTrackById(el.dataset.id); if (t) openCtxMenu(e, t, 'home'); });
        el.addEventListener('click', () => {
          const t = findTrackById(el.dataset.id);
          if (!t) return;
          if (!queue.find(q => q.id === t.id)) queue.push({...t});
          const qi = queue.findIndex(q => q.id === t.id);
          updateQueueUI(); showView('queue'); playTrack(qi);
        });
      });
    }
  }

  const favShelf = document.getElementById('home-favorites-shelf');
  if (favShelf) {
    const favTracks = favorites.map(id => findTrackById(id)).filter(Boolean);
    if (favTracks.length === 0) {
      favShelf.innerHTML = `<div class="home-empty-hint">${window.i18n ? window.i18n.T('Marca canciones como favoritas') : 'Marca canciones como favoritas'}</div>`;
    } else {
      favShelf.innerHTML = favTracks.slice(0, 12).map(t => {
        const src = t.cover || t.thumbnail || '';
        const artHtml = src
          ? `<img src="${src}" alt="" loading="lazy">`
          : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        return `<div class="home-card" data-id="${t.id}">
          <div class="home-card-art">
            ${artHtml}
            <div class="home-card-play">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="home-card-title">${escapeHTML(t.title)}</div>
          <div class="home-card-sub">${escapeHTML(t.artist)}</div>
        </div>`;
      }).join('');
      favShelf.querySelectorAll('.home-card').forEach(el => {
        el.addEventListener('contextmenu', e => { e.preventDefault(); const t = findTrackById(el.dataset.id); if (t) openCtxMenu(e, t, 'home'); });
        el.addEventListener('click', () => {
          const t = findTrackById(el.dataset.id);
          if (!t) return;
          if (!queue.find(q => q.id === t.id)) queue.push({...t});
          const qi = queue.findIndex(q => q.id === t.id);
          updateQueueUI(); showView('queue'); playTrack(qi);
        });
      });
    }
  }
}

const RECENT_KEY = 'nfa_recents';
let recentlyPlayed = [];
function loadRecentlyPlayed() {
  try { recentlyPlayed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { recentlyPlayed = []; }
}
function addToRecents(trackId) {
  recentlyPlayed = [trackId, ...recentlyPlayed.filter(id => id !== trackId)].slice(0, 20);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentlyPlayed));
}
function getRecentlyPlayed() {
  return recentlyPlayed.map(id => findTrackById(id)).filter(Boolean).slice(0, 12);
}

// ============ Contadores de reproducción + Top del mes + "Tus hits" ============
let playCounts = {};
function loadPlayCounts() {
  try { playCounts = JSON.parse(localStorage.getItem(KEYS.playcounts) || '{}'); } catch { playCounts = {}; }
}
function incrementPlayCount(trackId) {
  if (!trackId) return;
  const e = playCounts[trackId] || { n: 0, last: 0 };
  e.n++; e.last = Date.now();
  playCounts[trackId] = e;
  try { localStorage.setItem(KEYS.playcounts, JSON.stringify(playCounts)); } catch {}
}
function getTopTracks(limit = 8, withinMs = 30 * 24 * 3600 * 1000) {
  const now = Date.now();
  const entries = Object.entries(playCounts)
    .map(([id, e]) => ({ id, n: e.n || 0, last: e.last || 0 }))
    .filter(e => {
      const t = findTrackById(e.id);
      return t && (!withinMs || (now - e.last) <= withinMs);
    })
    .sort((a, b) => b.n - a.n || b.last - a.last);
  // Si el mes no genera suficiente historial, caer al top histórico
  if (entries.length < Math.min(4, limit)) {
    return Object.entries(playCounts)
      .map(([id, e]) => ({ id, n: e.n || 0, last: e.last || 0 }))
      .filter(e => findTrackById(e.id))
      .sort((a, b) => b.n - a.n || b.last - a.last)
      .slice(0, limit);
  }
  return entries.slice(0, limit);
}

function _topCardHTML(t) {
  const src = t.cover || t.thumbnail || '';
  const artHtml = src
    ? `<img src="${escapeHTML(src)}" alt="" loading="lazy">`
    : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const plays = (playCounts[t.id]?.n) || 0;
  return `<div class="home-recent-card" data-id="${escapeHTML(t.id)}" title="${plays} reproducciones">
    <div class="home-recent-art">${artHtml}</div>
    <span class="home-recent-title">${escapeHTML(t.title)}</span>
  </div>`;
}

function renderTopShelf() {
  const section = document.getElementById('home-top-section');
  const shelf = document.getElementById('home-top-shelf');
  if (!shelf) return;
  const top = getTopTracks(8);
  if (!top.length) { if (section) section.style.display = 'none'; shelf.innerHTML = ''; return; }
  if (section) section.style.display = '';
  shelf.innerHTML = top.map(e => findTrackById(e.id)).filter(Boolean).map(_topCardHTML).join('');
  shelf.querySelectorAll('.home-recent-card').forEach(el => {
    el.addEventListener('click', () => {
      const t = findTrackById(el.dataset.id);
      if (!t) return;
      if (!queue.find(q => q.id === t.id)) queue.push({...t});
      const qi = queue.findIndex(q => q.id === t.id);
      updateQueueUI(); showView('queue'); playTrack(qi);
    });
  });
}

// Playlist automática "Tus hits" (top 25 por reproducciones)
function refreshAutoHitsPlaylist() {
  const AUTO_ID = 'nfa-auto-hits';
  const top = Object.entries(playCounts)
    .map(([id, e]) => ({ id, n: e.n || 0 }))
    .filter(e => findTrackById(e.id))
    .sort((a, b) => b.n - a.n)
    .slice(0, 25);
  if (top.length < 3) return; // no crear hasta haber escuchado algo
  let pl = playlists.find(p => p.id === AUTO_ID);
  const ids = top.map(e => e.id);
  if (!pl) {
    pl = { id: AUTO_ID, name: 'Tus hits', cover: null, tracks: ids, auto: true };
    playlists.unshift(pl);
  } else {
    pl.tracks = ids;
  }
  savePlaylists();
  renderSidebarPlaylists();
}

const _externalSugCache = new Map();
const EXTERNAL_SUG_TTL = 10 * 60 * 1000;
let _sugRenderToken = 0;

function _pickSuggestionSeed() {
  for (const id of recentlyPlayed) {
    const t = findTrackById(id);
    if (t?.videoId) return t;
  }
  for (const id of favorites) {
    const t = findTrackById(id);
    if (t?.videoId) return t;
  }
  return null;
}

async function getExternalSuggestions(limit = 8) {
  if (!window.nofuf?.resolveYouTubeRelated) return [];
  const seed = _pickSuggestionSeed();
  if (!seed) return [];

  let related;
  const cached = _externalSugCache.get(seed.videoId);
  if (cached && (Date.now() - cached.ts) < EXTERNAL_SUG_TTL) {
    related = cached.videos;
  } else {
    const res = await window.nofuf.resolveYouTubeRelated(seed.videoId);
    if (res?.type !== 'success') return [];
    related = res.videos;
    if (_externalSugCache.size >= 30) {
      const oldestSug = _externalSugCache.keys().next().value;
      if (oldestSug !== undefined) _externalSugCache.delete(oldestSug);
    }
    _externalSugCache.set(seed.videoId, { ts: Date.now(), videos: related });
  }

  const knownVideoIds = new Set(
    library.map(t => t.videoId).filter(Boolean)
      .concat(recentlyPlayed.map(id => findTrackById(id)?.videoId).filter(Boolean))
  );

  return related
    .filter(v => !knownVideoIds.has(v.id))
    .slice(0, limit)
    .map(v => ({
      id: 'related-' + v.id,
      videoId: v.id,
      title: v.title,
      artist: v.uploader || '',
      thumbnail: v.thumbnail || '',
      external: true,
    }));
}

function _sugCardHTML(t) {
  const src = t.cover || t.thumbnail || '';
  const artHtml = src
    ? `<img src="${src}" alt="" loading="lazy">`
    : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  return `<div class="home-card" data-id="${t.id}" ${t.external ? `data-external data-video-id="${t.videoId}"` : ''}>
    <div class="home-card-art">
      ${artHtml}
      <div class="home-card-play">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </div>
    <div class="home-card-title">${escapeHTML(t.title)}</div>
    <div class="home-card-sub">${escapeHTML(t.artist)}</div>
  </div>`;
}

function _bindSugCardEvents(sugShelf) {
  sugShelf.querySelectorAll('.home-card').forEach(el => {
    if (el.dataset.external !== undefined) {
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        const vId = el.dataset.videoId;
        const title = el.querySelector('.home-card-title')?.textContent || '';
        const artist = el.querySelector('.home-card-sub')?.textContent || '';
        const thumb = el.querySelector('.home-card-art img')?.src || '';
        const lazyTrack = {
          id: 'yt-' + vId,
          type: 'youtube',
          videoId: vId,
          title,
          artist,
          duration: 0,
          cover: thumb,
          thumbnail: thumb,
          ytUrl: `https://www.youtube.com/watch?v=${vId}`,
        };
        openCtxMenu(e, lazyTrack, 'home');
      });
      el.addEventListener('click', () => _playExternalSuggestion(el.dataset.videoId, el.querySelector('.home-card-title')?.textContent || '', el.querySelector('.home-card-sub')?.textContent || ''));
    } else {
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        const t = findTrackById(el.dataset.id);
        if (t) openCtxMenu(e, t, 'home');
      });
      el.addEventListener('click', () => {
        const t = findTrackById(el.dataset.id);
        if (!t) return;
        if (!queue.find(q => q.id === t.id)) queue.push({...t});
        const qi = queue.findIndex(q => q.id === t.id);
        updateQueueUI(); showView('queue'); playTrack(qi);
      });
    }
  });
}

async function _playExternalSuggestion(videoId, fallbackTitle, fallbackArtist) {
  showToast?.(`Cargando "${fallbackTitle}"…`);
  try {
    const result = await window.nofuf.resolveYouTube(`https://www.youtube.com/watch?v=${videoId}`);
    if (result.type === 'error') { showToast?.('⚠ ' + result.message); return; }
    const track = {
      id: 'yt-' + videoId + '-' + Date.now(),
      type: 'youtube',
      videoId: result.videoId,
      title: result.title || fallbackTitle,
      artist: result.artist || fallbackArtist,
      duration: 0,
      cover: result.thumbnail || '',
      url: result.streamUrl,
      ytUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
    queue.push(track);
    const qi = queue.length - 1;
    updateQueueUI(); showView('queue'); playTrack(qi);
  } catch (err) {
    showToast?.('⚠ Error al cargar el vídeo');
  }
}

async function renderSuggestionsShelf(sugShelf) {
  const myToken = ++_sugRenderToken;
  const libSuggestions = getSuggestions(12);

  if (libSuggestions.length === 0) {
    sugShelf.innerHTML = `<div class="home-empty-hint">${window.i18n ? window.i18n.T('Escucha algunas canciones para recibir sugerencias') : 'Escucha algunas canciones para recibir sugerencias'}</div>`;
  } else {
    sugShelf.innerHTML = libSuggestions.map(_sugCardHTML).join('');
    _bindSugCardEvents(sugShelf);
  }

  const external = await getExternalSuggestions(8);
  if (myToken !== _sugRenderToken) return;
  if (external.length === 0) return;

  const combined = [...external, ...libSuggestions].slice(0, 16);
  sugShelf.innerHTML = combined.map(_sugCardHTML).join('');
  _bindSugCardEvents(sugShelf);
}

function getSuggestions(limit = 12) {
  if (library.length === 0) return [];

  const weights = {};
  recentlyPlayed.forEach((id, idx) => {
    const t = findTrackById(id);
    if (!t || !t.artist) return;
    weights[t.artist] = (weights[t.artist] || 0) + Math.max(1, 20 - idx);
  });
  favorites.forEach(id => {
    const t = findTrackById(id);
    if (!t || !t.artist) return;
    weights[t.artist] = (weights[t.artist] || 0) + 8;
  });

  const heardIds = new Set([...recentlyPlayed, ...favorites]);

  const scored = library
    .filter(t => !heardIds.has(t.id))
    .map(t => ({ t, score: weights[t.artist] || 0 }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  let picks = scored.slice(0, limit).map(c => c.t);

  if (picks.length < limit) {
    const pickedIds = new Set(picks.map(p => p.id));
    const rest = library.filter(t => !heardIds.has(t.id) && !pickedIds.has(t.id));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    picks = picks.concat(rest.slice(0, limit - picks.length));
  }

  return picks;
}

function setupEventListeners() {
  dom.btnMinimize.addEventListener('click', () => window.nofuf.minimize());
  dom.btnMaximize.addEventListener('click', () => window.nofuf.maximize());
  dom.btnClose.addEventListener('click',    () => window.nofuf.close());
  if (dom.btnReload) dom.btnReload.addEventListener('click', () => window.nofuf.reload());
  document.getElementById('btn-logo-home')?.addEventListener('click', () => {
    _closeVizView();
    showView('home');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'F5' || (e.key === 'r' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      window.nofuf.reload();
    }
  });
  dom.btnSettings.addEventListener('click', openSettingsModal);

  dom.navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'home') renderHomeView();
      showView(btn.dataset.view);
    });
  });

  document.getElementById('home-see-all-playlists')?.addEventListener('click', () => {
    if (playlists.length) openPlaylist(playlists[0].id);
    else showView('library');
  });
  document.getElementById('home-see-all-library')?.addEventListener('click', () => showView('library'));
  document.getElementById('home-see-all-favorites')?.addEventListener('click', () => showView('favorites'));

  dom.btnImportFiles.addEventListener('click',  importFiles);
  dom.btnImportFolder.addEventListener('click', importFolder);
  dom.btnImportFiles2.addEventListener('click', importFiles);

  dom.urlAddBtn.addEventListener('click', handleYouTubeAdd);
  dom.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleYouTubeAdd(); });

  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnNext.addEventListener('click', playNext);
  dom.btnPrev.addEventListener('click', playPrev);

  dom.btnShuffle.addEventListener('click', () => {
    isShuffle = !isShuffle;
    dom.btnShuffle.classList.toggle('active', isShuffle);
    if (dom.btnShuffleQ) dom.btnShuffleQ.classList.toggle('active', isShuffle);
    showToast(isShuffle ? 'Shuffle activado' : 'Shuffle desactivado');
  });
  dom.btnRepeat.addEventListener('click', () => {
    isRepeat = !isRepeat;
    dom.btnRepeat.classList.toggle('active', isRepeat);
    if (dom.btnRepeatQ) dom.btnRepeatQ.classList.toggle('active', isRepeat);
    showToast(isRepeat ? 'Repetición activada' : 'Repetición desactivada');
  });

  if (dom.btnShuffleQ) dom.btnShuffleQ.addEventListener('click', () => {
    isShuffle = !isShuffle;
    dom.btnShuffleQ.classList.toggle('active', isShuffle);
    dom.btnShuffle.classList.toggle('active', isShuffle);
    showToast(isShuffle ? 'Shuffle activado' : 'Shuffle desactivado');
  });
  if (dom.btnRepeatQ) dom.btnRepeatQ.addEventListener('click', () => {
    isRepeat = !isRepeat;
    dom.btnRepeatQ.classList.toggle('active', isRepeat);
    dom.btnRepeat.classList.toggle('active', isRepeat);
    showToast(isRepeat ? 'Repetición activada' : 'Repetición desactivada');
  });

  dom.btnClearQueue.addEventListener('click', () => {
    queue = []; currentIndex = -1; audioPlayer.src = ''; isPlaying = false;
    updatePlaybackUI(); resetNowPlaying(); updateQueueUI();
    showToast('Cola limpiada');
  });

  const btnClearLibrary = document.getElementById('btn-clear-library');
  if (btnClearLibrary) {
    btnClearLibrary.addEventListener('click', () => {
      if (!library.length) return showToast('La biblioteca ya está vacía');
      if (!confirm(window.i18n && window.i18n.T ? window.i18n.T(`¿Eliminar las ${library.length} canciones de la biblioteca?\nEsto no borra los archivos de tu disco.`) : `¿Eliminar las ${library.length} canciones de la biblioteca?\nEsto no borra los archivos de tu disco.`)) return;
      library = [];
      saveLibrary();
      renderLibraryUI();
      showToast('Biblioteca vaciada');
    });
  }

  setupSlider(dom.progressTrack, (pct) => {
    if (audioPlayer.duration) audioPlayer.currentTime = pct * audioPlayer.duration;
  });
  setupSlider(dom.volTrack, (pct) => { setVolume(pct); });
  if (dom.volNumberInput) {
    dom.volNumberInput.addEventListener('input', () => {
      let val = parseInt(dom.volNumberInput.value, 10);
      if (isNaN(val)) return;
      val = Math.min(100, Math.max(0, val));
      setVolume(val / 100);
    });
    dom.volNumberInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.volNumberInput.blur(); });
  }

  dom.btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    audioPlayer.muted = isMuted;
    dom.volIconOn.style.display  = isMuted ? 'none'  : '';
    dom.volIconOff.style.display = isMuted ? '' : 'none';
    dom.volFill.style.width  = isMuted ? '0%' : `${currentVolume * 100}%`;
    dom.volThumb.style.left  = isMuted ? '0%' : `${currentVolume * 100}%`;
  });

  let _lastPctStr = '', _lastTimeStr = '';
  let _lastPosSave = 0;
  audioPlayer.addEventListener('timeupdate', () => {
    if (!audioPlayer.duration) return;
    const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    const pctStr = `${pct}%`;
    if (pctStr !== _lastPctStr) {
      _lastPctStr = pctStr;
      dom.progressFill.style.width = pctStr;
      dom.progressThumb.style.left = pctStr;
    }
    const timeStr = formatTime(audioPlayer.currentTime);
    if (timeStr !== _lastTimeStr) {
      _lastTimeStr = timeStr;
      dom.timeCurrent.textContent = timeStr;
    }
    // Guardar la posición para reanudar (cada 5 s)
    const now = Date.now();
    if (now - _lastPosSave > 5000) {
      _lastPosSave = now;
      saveQueueSoon();
      _scrobbleTick();
      _syncMiniTime();
    }
    if (settings.crossfade && audioPlayer.duration > 0) {
      const remaining = audioPlayer.duration - audioPlayer.currentTime;
      const fd = settings.crossfadeDuration;
      if (remaining <= fd && remaining > 0) {
        const vol = (remaining / fd) * currentVolume;
        audioPlayer.volume = Math.max(0, linearToAudioVolume(vol));
        if (remaining <= fd * 0.15 && !audioPlayer._crossfadeTriggered) {
          audioPlayer._crossfadeTriggered = true;
          playNext();
        }
      } else {
        audioPlayer._crossfadeTriggered = false;
        // Fuera de la ventana de crossfade: restaurar el volumen por si hubo seek atrás
        audioPlayer.volume = linearToAudioVolume(currentVolume);
      }
    }
  });
  audioPlayer.addEventListener('loadedmetadata', () => {
    dom.timeTotal.textContent = formatTime(audioPlayer.duration);
  });
  audioPlayer.addEventListener('ended', () => {
    // Sleep timer "al acabar esta canción": detener antes del avance automático
    if (_sleepAtEnd) {
      _sleepAtEnd = false;
      isPlaying = false;
      updatePlaybackUI();
      _updateRpcState();
      _syncMiniNow();
      showToast(window.i18n && window.i18n.T ? window.i18n.T('Temporizador: música detenida') : 'Temporizador: música detenida');
      return;
    }
    if (isRepeat) { audioPlayer.currentTime = 0; audioPlayer.play().catch(()=>{}); }
    else if (settings.autoplay !== false) playNext();
  });
  audioPlayer.addEventListener('play',  () => { updateSpinArt(true);  });
  audioPlayer.addEventListener('pause', () => { updateSpinArt(false); });

  audioPlayer.addEventListener('error', async () => {
    const code = audioPlayer.error?.code ?? 0;
    if (code === 1 ) return;
    if (_audioRetryInProgress) return;

    const t = (currentIndex >= 0) ? queue[currentIndex] : null;
    if (!t) { hideLoading(); return; }

    if (t.type === 'youtube' && _audioRetryCount < 3) {
      _audioRetryInProgress = true;
      _audioRetryCount++;
      console.warn(`[audio] Error (código ${code}), reintento ${_audioRetryCount}/3:`, t.title);
      t.url  = '';
      t.lazy = true;
      t._resolving = null;
      if (_audioRetryCount >= 2 && t.spMeta) { t.videoId = ''; t.ytUrl = ''; }
      audioPlayer.src = '';
      audioPlayer.load();
      if (_audioRetryCount === 1) showToast('Reintentando…');
      try {
        await playTrack(currentIndex);
      } catch(e) {
        hideLoading();
        showToast('No se pudo reproducir. Comprueba tu conexión.');
        _audioRetryCount = 0;
      } finally {
        _audioRetryInProgress = false;
      }
      return;
    }

    _audioRetryCount = 0;
    _audioRetryInProgress = false;
    hideLoading();
    showToast('No se pudo reproducir. Comprueba tu conexión.');
  });
  audioPlayer.addEventListener('playing', () => {
    _audioRetryCount = 0;
    _audioRetryInProgress = false;
  });

  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop',     e => e.preventDefault());
  dom.sidebar.addEventListener('dragenter', () => dom.dropOverlay.classList.add('active'));
  dom.dropOverlay.addEventListener('dragleave', () => dom.dropOverlay.classList.remove('active'));
  dom.dropOverlay.addEventListener('drop', async e => {
    dom.dropOverlay.classList.remove('active');
    e.preventDefault();
    // Electron moderno no expone File.path: resolver la ruta real vía webUtils en el preload
    const files = Array.from(e.dataTransfer.files)
      .map(f => {
        try { return (f && typeof f.path === 'string' && f.path) || (window.nofuf.getPathForFile ? window.nofuf.getPathForFile(f) : ''); }
        catch { return ''; }
      })
      .filter(Boolean);
    if (files.length) { showLoading('Procesando archivos…'); await processFilePaths(files); hideLoading(); }
  });

  dom.lyricsClose.addEventListener('click', closeLyricsPanel);

  const _btnLyricsToggle = document.getElementById('btn-lyrics-toggle');
  if (_btnLyricsToggle) {
    _btnLyricsToggle.addEventListener('click', () => {
      if (dom.lyricsPanel.classList.contains('open')) {
        closeLyricsPanel();
      } else {
        openLyricsPanel();
      }
    });
  }

  const _sidebarEl      = document.getElementById('sidebar-left');
  const _sbToggleBtn    = document.getElementById('btn-sidebar-toggle');

  function toggleSidebar() {
    if (!_sidebarEl) return;
    const collapsed = _sidebarEl.classList.toggle('collapsed');
    if (_sbToggleBtn) _sbToggleBtn.classList.toggle('collapsed', collapsed);
  }

  if (_sbToggleBtn) {
    _sbToggleBtn.addEventListener('click', toggleSidebar);
  }

  const _romajiBtn = document.getElementById('lyrics-romaji-btn');
  if (_romajiBtn) {
    _romajiBtn.addEventListener('click', () => {
      _romajiActive = !_romajiActive;
      _romajiBtn.classList.toggle('active', _romajiActive);
      if (currentIndex >= 0 && queue[currentIndex]) {
        fetchLyrics(queue[currentIndex]);
      }
    });
  }

  const _romanizeBtn = document.getElementById('lyrics-romanize-btn');
  if (_romanizeBtn) {
    _romanizeBtn.addEventListener('click', async () => {
      _romanizeActive = !_romanizeActive;
      _romanizeBtn.classList.toggle('active', _romanizeActive);

      if (_romanizeActive) {
        _romanizeBtn.classList.add('loading');
        _romanizeBtn.disabled = true;
        const kuroshiro = await getKuroshiro();
        _romanizeBtn.classList.remove('loading');
        _romanizeBtn.disabled = false;
        if (!kuroshiro) {
          _romanizeActive = false;
          _romanizeBtn.classList.remove('active');
          console.error('[romanize] No se pudo inicializar Kuroshiro/Kuromoji.');
          return;
        }
      }

      if (_lastLyricsEntry) renderLyricsContent(_lastLyricsEntry);
    });
  }

  const _offMinus = document.getElementById('lyrics-offset-minus');
  const _offPlus  = document.getElementById('lyrics-offset-plus');
  if (_offMinus) _offMinus.addEventListener('click', () => _lrcBumpOffset(-_LRC_OFFSET_STEP));
  if (_offPlus)  _offPlus.addEventListener('click', () => _lrcBumpOffset(_LRC_OFFSET_STEP));
  _lrcRenderOffset();

  dom.barFavBtn.addEventListener('click', () => {
    if (currentIndex < 0 || !queue[currentIndex]) return;
    toggleFavorite(queue[currentIndex]);
  });

  dom.playlistHeroArt.addEventListener('click', () => dom.playlistCoverInput.click());
  dom.playlistCoverInput.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (!pl) return;
      pl.cover = ev.target.result;
      savePlaylists(); renderSidebarPlaylists(); renderPlaylistHero(pl);
    };
    reader.readAsDataURL(file);
  });
  dom.playlistHeroName.addEventListener('blur', () => {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) return;
    pl.name = dom.playlistHeroName.textContent.trim() || 'Playlist';
    savePlaylists(); renderSidebarPlaylists();
  });
  dom.playlistPlayBtn.addEventListener('click', () => {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl || !pl.tracks.length) return;
    queue = pl.tracks.map(id => findTrackById(id)).filter(Boolean);
    updateQueueUI(); showView('queue'); if (queue.length) playTrack(0);
  });
  dom.playlistAddFromQueue.addEventListener('click', () => {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) return;
    let added = 0;
    queue.forEach(t => { if (!pl.tracks.includes(t.id)) { pl.tracks.push(t.id); added++; } });
    addTracksToLibrary(queue);
    savePlaylists(); renderPlaylistView(pl);
    showToast(`${added} canciones añadidas`);
  });
  dom.playlistDeleteBtn.addEventListener('click', () => {
    playlists = playlists.filter(p => p.id !== currentPlaylistId);
    savePlaylists(); renderSidebarPlaylists(); showView('queue');
    showToast('Playlist eliminada');
  });

  const playlistClearBtn = document.getElementById('playlist-clear-btn');
  if (playlistClearBtn) {
    playlistClearBtn.addEventListener('click', () => {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (!pl || !pl.tracks.length) return showToast('La playlist ya está vacía');
      if (!confirm(window.i18n && window.i18n.T ? window.i18n.T(`¿Quitar las ${pl.tracks.length} canciones de la playlist "${pl.name}"?`) : `¿Quitar las ${pl.tracks.length} canciones de la playlist "${pl.name}"?`)) return;
      pl.tracks = [];
      savePlaylists();
      renderPlaylistView(pl);
      showToast('Canciones eliminadas de la playlist');
    });
  }

  dom.btnNewPlaylist.addEventListener('click', openNewPlaylistModal);
  dom.modalClose.addEventListener('click', closeModal);
  dom.modalCancel.addEventListener('click', closeModal);
  dom.modalBackdrop.addEventListener('click', e => { if (e.target === dom.modalBackdrop) closeModal(); });
  dom.modalCreate.addEventListener('click', createPlaylist);
  dom.modalArtPick.addEventListener('click', () => dom.modalCoverInput.click());
  dom.modalArtPreview.addEventListener('click', () => dom.modalCoverInput.click());
  dom.modalCoverInput.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      dom.modalArtPreview.src = ev.target.result;
      dom.modalArtPreview.style.display = 'block';
      dom.modalArtPick.style.display = 'none';
    };
    reader.readAsDataURL(file);
  });
  dom.modalNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createPlaylist(); });

  dom.modalEditClose.addEventListener('click', closeEditModal);
  dom.modalEditCancel.addEventListener('click', closeEditModal);
  dom.modalEditSave.addEventListener('click', saveEditedTrack);
  dom.editArtPick.addEventListener('click', () => dom.editCoverInput.click());
  dom.editArtPreview.addEventListener('click', () => dom.editCoverInput.click());
  dom.editCoverInput.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      dom.editArtPreview.src = ev.target.result;
      dom.editArtPreview.style.display = 'block';
      dom.editArtPick.style.display = 'none';
    };
    reader.readAsDataURL(file);
  });

  dom.modalSettingsClose.addEventListener('click', closeSettingsModal);
  dom.modalSettingsCancel.addEventListener('click', closeSettingsModal);
  dom.modalSettingsBackdrop.addEventListener('click', e => { if (e.target === dom.modalSettingsBackdrop) closeSettingsModal(); });
  dom.modalSettingsSave.addEventListener('click', saveSettingsFromModal);

  dom.settingManualCookiesSave.addEventListener('click', async () => {
    const content = dom.settingManualCookies.value.trim();
    if (!content) { showToast('Pega primero tu cookies.txt'); return; }
    dom.settingManualCookiesSave.disabled = true;
    const res = await window.nofuf.setManualCookies(content).catch(e => ({ ok: false, error: e.message }));
    dom.settingManualCookiesSave.disabled = false;
    if (res && res.ok) {
      dom.settingManualCookiesStatus.textContent = 'Cookies manuales activas y en uso';
      dom.settingManualCookies.value = '';
      showToast('Cookies guardadas');
    } else {
      showToast(res && res.error ? res.error : 'No se pudieron guardar las cookies');
    }
  });
  dom.settingManualCookiesClear.addEventListener('click', async () => {
    await window.nofuf.clearManualCookies().catch(() => {});
    dom.settingManualCookiesStatus.textContent = 'Sin cookies manuales guardadas';
    showToast('Cookies manuales eliminadas');
  });

  dom.settingImportLibraryBtn.addEventListener('click', handleImportYoutubeLibrary);
  if (window.nofuf && window.nofuf.onYoutubeLibraryProgress) {
    window.nofuf.onYoutubeLibraryProgress(progress => {
      if (!dom.settingImportLibraryStatus) return;
      if (progress.stage === 'favorites') dom.settingImportLibraryStatus.textContent = 'Importando favoritos…';
      else if (progress.stage === 'filtering-favorites') dom.settingImportLibraryStatus.textContent = `Filtrando ${progress.total} favoritos (solo música)…`;
      else if (progress.stage === 'listing-playlists') dom.settingImportLibraryStatus.textContent = 'Buscando tus playlists…';
      else if (progress.stage === 'playlist') dom.settingImportLibraryStatus.textContent = `Importando playlist ${progress.index + 1}/${progress.total}: ${progress.title}`;
    });
  }
  dom.settingDefaultVolume.addEventListener('input', () => {
    dom.settingDefaultVolumeVal.textContent = dom.settingDefaultVolume.value + '%';
  });
  dom.settingCrossfadeDuration.addEventListener('input', () => {
    dom.settingCrossfadeDurationVal.textContent = dom.settingCrossfadeDuration.value + 's';
  });
  dom.settingCrossfade.addEventListener('change', () => {
    dom.crossfadeDurationRow.style.display = dom.settingCrossfade.checked ? '' : 'none';
  });
  const _importIconBtn = document.getElementById('setting-import-icon');
  if (_importIconBtn && !_importIconBtn.dataset.wired) {
    _importIconBtn.dataset.wired = '1';
    _importIconBtn.addEventListener('click', async () => {
      try {
        if (!window.nofuf?.importIconFile) return;
        const res = await window.nofuf.importIconFile();
        if (!res || res.ok === false) {
          if (res && res.error) showToast(res.error);
          return;
        }
        if (res && res.id && !_iconEntries.some(e => e.id === res.id)) _iconEntries.push(res);
        await _renderIconSelectors();
      } catch (e) { showToast('Error: ' + e.message); }
    });
  }
  const _checkUpdBtn = document.getElementById('setting-check-update');
  if (_checkUpdBtn && !_checkUpdBtn.dataset.wired) {
    _checkUpdBtn.dataset.wired = '1';
    _checkUpdBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('setting-update-status');
      const dlBtn = document.getElementById('setting-download-update');
      const t = (window.i18n && window.i18n.t) ? window.i18n.t.bind(window.i18n) : (k => k);
      if (dlBtn) dlBtn.style.display = 'none';
      if (statusEl) statusEl.textContent = t('common.loading');
      _checkUpdBtn.disabled = true;
      try {
        const res = await window.nofuf?.checkAppUpdate();
        if (!res || !res.ok) {
          if (statusEl) statusEl.textContent = t('settings.updateError');
        } else if (res.updateAvailable) {
          if (statusEl) statusEl.textContent = `${t('settings.updateAvailable')} (v${res.current || '?'} → v${res.latest})`;
          if (dlBtn) dlBtn.style.display = '';
        } else {
          if (statusEl) statusEl.textContent = `${t('settings.upToDate')} (v${res.current})`;
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = t('settings.updateError');
      } finally {
        _checkUpdBtn.disabled = false;
      }
    });
  }
  const _dlUpdBtn = document.getElementById('setting-download-update');
  if (_dlUpdBtn && !_dlUpdBtn.dataset.wired) {
    _dlUpdBtn.dataset.wired = '1';
    _dlUpdBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('setting-update-status');
      const t = (window.i18n && window.i18n.t) ? window.i18n.t.bind(window.i18n) : (k => k);
      // Segunda fase: ya instalada → este botón reinicia la app
      if (_dlUpdBtn.dataset.restart === '1') {
        try { window.nofuf?.restartApp?.(); } catch (_) {}
        return;
      }
      if (!window.nofuf?.applyAppUpdate) { showToast('Actualizador no disponible'); return; }
      const _checkBtn = document.getElementById('setting-check-update');
      _dlUpdBtn.disabled = true;
      if (_checkBtn) _checkBtn.disabled = true;
      let _unsub = null;
      try {
        if (window.nofuf?.onUpdateProgress) {
          _unsub = window.nofuf.onUpdateProgress((p) => {
            if (!statusEl || !p || p.finished) return;
            statusEl.textContent = `Actualizando ${p.done}/${p.total}…`;
          });
        }
        if (statusEl) statusEl.textContent = t('common.loading');
        showLoading('Actualizando NofufAudio…');
        const res = await window.nofuf.applyAppUpdate();
        hideLoading();
        if (res && res.ok) {
          const v = res.latest ? ` v${res.latest}` : '';
          if (statusEl) statusEl.textContent = `Actualizado${v} (${res.updated} archivos). Reinicia para aplicar.`;
          showToast('Actualización instalada. Reinicia la app.');
          _dlUpdBtn.dataset.restart = '1';
          _dlUpdBtn.textContent = (settings.language === 'es') ? 'Reiniciar ahora' : 'Restart now';
          _dlUpdBtn.disabled = false;
        } else {
          const msg = (res && res.error) || t('settings.updateError');
          if (statusEl) statusEl.textContent = msg;
          showToast(msg);
          _dlUpdBtn.disabled = false;
        }
      } catch (e) {
        hideLoading();
        if (statusEl) statusEl.textContent = e.message;
        showToast(e.message);
        _dlUpdBtn.disabled = false;
      } finally {
        try { _unsub && _unsub(); } catch (_) {}
        if (_checkBtn) _checkBtn.disabled = false;
      }
    });
  }
  document.querySelectorAll('.color-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-pick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.documentElement.style.setProperty('--accent', btn.dataset.color);
    });
  });

  document.addEventListener('click', e => {
    if (!dom.ctxMenu.contains(e.target)) closeCtxMenu();
  });
  dom.ctxEdit.addEventListener('click', () => {
    if (ctxTrack) openEditModal(ctxTrack);
    closeCtxMenu();
  });
  dom.ctxFav.addEventListener('click', () => {
    if (ctxTrack) { toggleFavorite(ctxTrack); updateFavButtonsForTrack(ctxTrack.id); }
    closeCtxMenu();
  });
  dom.ctxLib.addEventListener('click', () => {
    if (ctxTrack) { addTracksToLibrary([ctxTrack]); showToast('Guardado en biblioteca'); }
    closeCtxMenu();
  });
  dom.ctxPlayNext.addEventListener('click', () => {
    if (!ctxTrack) return;
    const insertAt = currentIndex + 1;
    queue.splice(insertAt, 0, {...ctxTrack, id: ctxTrack.id + '-' + Date.now()});
    updateQueueUI(); showToast('Reproduciendo siguiente');
    closeCtxMenu();
  });
  dom.ctxDelete.addEventListener('click', () => {
    if (!ctxTrack) return;
    deleteTrack(ctxTrack, ctxContext);
    closeCtxMenu();
  });
}

function updateSpinArt(playing) {
  if (!settings.spinArt) return;
  if (playing) {
    dom.artImage.classList.add('spinning');
    dom.artImage.classList.remove('paused');
  } else {
    dom.artImage.classList.add('paused');
  }
}

function setupSlider(trackEl, onChange) {
  const getPct = e => {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };
  trackEl.addEventListener('mousedown', e => {
    onChange(getPct(e));
    let raf = null, pending = 0;
    const flush = () => { raf = null; onChange(pending); };
    const onMove = ev => {
      pending = getPct(ev);
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (raf != null) { cancelAnimationFrame(raf); raf = null; onChange(pending); }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function importFiles() {
  const paths = await window.nofuf.openFileDialog();
  if (paths?.length) { showLoading('Cargando archivos…'); await processFilePaths(paths); hideLoading(); }
}
async function importFolder() {
  const paths = await window.nofuf.openFolderDialog();
  if (paths?.length) { showLoading(`Cargando ${paths.length} canciones…`); await processFilePaths(paths); hideLoading(); }
}

async function processFilePaths(paths) {
  const exts = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus'];
  const newTracks = [];
  for (const p of paths) {
    if (!exts.some(e => p.toLowerCase().endsWith(e))) continue;
    const meta = await window.nofuf.readFileMetadata(p);
    const track = {
      id:     'local-' + Date.now() + Math.random(),
      type:   'local',
      title:  meta.title,
      artist: meta.artist,
      duration: meta.duration,
      path:   p,
      cover:  meta.cover,
      url:    window.nofuf.pathToFileUrl(p),
      ytUrl:  null,
    };
    queue.push(track);
    newTracks.push(track);
  }
  addTracksToLibrary(newTracks);
  updateQueueUI(); renderLibraryUI();
  if (currentIndex === -1 && queue.length > 0) playTrack(0);
}

function isYouTubePlaylistUrl(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    return !!(list && list.length > 10);
  } catch { return false; }
}

function isSpotifyPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname === 'open.spotify.com') && u.pathname.startsWith('/playlist/');
  } catch { return false; }
}

function extractSpotifyPlaylistId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('playlist');
    return idx !== -1 ? parts[idx + 1] : null;
  } catch { return null; }
}

function isDeezerPlaylistUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i,'');
    return host === 'deezer.com' && u.pathname.includes('/playlist/');
  } catch { return false; }
}

function extractDeezerPlaylistId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/playlist\/(\d+)/);
    if (m) return m[1];
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('playlist');
    return idx !== -1 ? parts[idx + 1] : null;
  } catch { return null; }
}

async function handleYouTubeAdd() {
  const url = dom.urlInput.value.trim();
  if (!url) return;

  if (isYouTubePlaylistUrl(url)) {
    await handleYouTubePlaylistImport(url);
    return;
  }

  if (isSpotifyPlaylistUrl(url)) {
    await handleSpotifyPlaylistImport(url);
    return;
  }

  if (isDeezerPlaylistUrl(url)) {
    await handleDeezerPlaylistImport(url);
    return;
  }

  dom.urlAddBtn.disabled = true;
  setYouTubeStatus('loading', 'Resolviendo…');

  let result;
  try {
    result = await window.nofuf.resolveYouTube(url);
  } catch (e) {
    result = { type: 'error', message: (e && e.message) || 'Error resolviendo el enlace.' };
  } finally {
    dom.urlAddBtn.disabled = false;
  }

  if (result.type === 'error') {
    setYouTubeStatus('error', result.message);
    showToast(result.message);
    return;
  }

  setYouTubeStatus('success', '✓ Añadido');
  dom.urlInput.value = '';

  let coverBase64 = null;
  if (result.thumbnail) {
    coverBase64 = await window.nofuf.fetchImageBase64(result.thumbnail).catch(() => null);
  }

  const track = {
    id:     'yt-' + result.videoId + '-' + Date.now(),
    type:   'youtube',
    title:  result.title,
    artist: result.artist,
    duration: 0,
    cover:  coverBase64,
    url:    result.streamUrl,
    ytUrl:  url,
    videoId: result.videoId,
  };

  queue.push(track);
  addTracksToLibrary([track]);
  updateQueueUI(); renderLibraryUI();
  showToast('Añadido a la cola');
  if (currentIndex === -1 && queue.length > 0) playTrack(queue.length - 1);
  setTimeout(() => setYouTubeStatus('', ''), 3000);
}

function setSpotifyStatus(type, msg) { setYouTubeStatus(type, msg); }

async function handleSpotifyPlaylistImport(url) {
  const playlistId = extractSpotifyPlaylistId(url);
  if (!playlistId) {
    setSpotifyStatus('error', 'URL de Spotify inválida.');
    return;
  }

  dom.urlAddBtn.disabled = true;
  dom.urlInput.value = '';
  setSpotifyStatus('loading', 'Conectando con Spotify…');
  showLoading('Importando playlist de Spotify…');

  let result;
  try {
    result = await window.nofuf.importSpotifyPlaylist(playlistId);
  } catch(e) {
    result = { type: 'error', message: e.message };
  }

  dom.urlAddBtn.disabled = false;
  hideLoading();

  if (!result || result.type === 'error') {
    setSpotifyStatus('error', result?.message || 'No se pudo importar la playlist.');
    showToast('⚠ No se pudo importar la playlist');
    return;
  }

  const { playlistTitle, tracks: spTracks } = result;

  if (!spTracks?.length) {
    setSpotifyStatus('error', 'No se encontraron canciones. ¿La playlist es pública?');
    showToast('⚠ Playlist vacía o privada');
    return;
  }

  setSpotifyStatus('loading', `Importando ${spTracks.length} canciones…`);

  const pl = {
    id:     'sp-pl-' + playlistId + '-' + Date.now(),
    name:   playlistTitle,
    cover:  null,
    tracks: [],
  };

  // Probar hasta 3 candidatas: la primera puede fallar (CDN caído, URL rota)
  const coverCandidates = spTracks.filter(t => t.cover).slice(0, 3);
  for (const c of coverCandidates) {
    try {
      const img = await window.nofuf.fetchImageBase64(c.cover).catch(() => null);
      if (img) { pl.cover = img; break; }
    } catch (_) {}
  }

  const newTracks = [];
  for (const sp of spTracks) {
    const track = {
      id:        'sp-' + sp.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type:      'youtube',
      title:     sp.title,
      artist:    sp.artist,
      album:     sp.album || '',
      duration:  sp.duration || 0,
      cover:     sp.cover || null,
      url:       '',
      ytUrl:     '',
      videoId:   '',
      thumbnail: sp.cover || '',
      lazy:      true,
      spMeta:    { title: sp.title, artist: sp.artist },
    };
    newTracks.push(track);
    pl.tracks.push(track.id);
  }

  addTracksToLibrary(newTracks);
  playlists.push(pl);
  savePlaylists();
  renderSidebarPlaylists();
  renderLibraryUI();

  setSpotifyStatus('success', `✓ ${pl.tracks.length} canciones importadas`);
  showToast(`"${playlistTitle}" importada · ${pl.tracks.length} canciones`);
  setTimeout(() => setSpotifyStatus('', ''), 6000);
  openPlaylist(pl.id);

  preResolveSpotifyTracks(newTracks, pl.id);
}

async function handleDeezerPlaylistImport(url) {
  const playlistId = extractDeezerPlaylistId(url);
  if (!playlistId) {
    setYouTubeStatus('error', 'URL de Deezer inválida.');
    return;
  }

  dom.urlAddBtn.disabled = true;
  dom.urlInput.value = '';
  setYouTubeStatus('loading', 'Conectando con Deezer…');
  showLoading('Importando playlist de Deezer…');

  let result;
  try {
    result = await window.nofuf.importDeezerPlaylist(playlistId);
  } catch(e) {
    result = { type: 'error', message: e.message };
  }

  dom.urlAddBtn.disabled = false;
  hideLoading();

  if (!result || result.type === 'error') {
    setYouTubeStatus('error', result?.message || 'No se pudo importar la playlist.');
    showToast('⚠ No se pudo importar la playlist');
    return;
  }

  const { playlistTitle, tracks: dzTracks } = result;

  if (!dzTracks?.length) {
    setYouTubeStatus('error', 'No se encontraron canciones. ¿La playlist es pública?');
    showToast('⚠ Playlist vacía o privada');
    return;
  }

  setYouTubeStatus('loading', `Importando ${dzTracks.length} canciones…`);

  const pl = {
    id:     'dz-pl-' + playlistId + '-' + Date.now(),
    name:   playlistTitle,
    cover:  null,
    tracks: [],
  };

  const firstWithCover = dzTracks.find(t => t.cover);
  if (firstWithCover?.cover) {
    const candidates = dzTracks.filter(t => t.cover).slice(0, 3);
    for (const c of candidates) {
      try {
        const img = await window.nofuf.fetchImageBase64(c.cover).catch(() => null);
        if (img) { pl.cover = img; break; }
      } catch (_) {}
    }
  }

  const newTracks = [];
  for (const dz of dzTracks) {
    const track = {
      id:        'dz-' + dz.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type:      'youtube',
      title:     dz.title,
      artist:    dz.artist,
      album:     dz.album || '',
      duration:  dz.duration || 0,
      cover:     dz.cover || null,
      url:       '',
      ytUrl:     '',
      videoId:   '',
      thumbnail: dz.cover || '',
      lazy:      true,
      spMeta:    { title: dz.title, artist: dz.artist },
    };
    newTracks.push(track);
    pl.tracks.push(track.id);
  }

  addTracksToLibrary(newTracks);
  playlists.push(pl);
  savePlaylists();
  renderSidebarPlaylists();
  renderLibraryUI();

  setYouTubeStatus('success', `✓ ${pl.tracks.length} canciones importadas`);
  showToast(`"${playlistTitle}" importada · ${pl.tracks.length} canciones`);
  setTimeout(() => setYouTubeStatus('', ''), 6000);
  openPlaylist(pl.id);

  preResolveSpotifyTracks(newTracks, pl.id);
}

async function preResolveSpotifyTracks(tracks, playlistId) {
  let resolved = 0;
  const total = tracks.length;
  const BATCH = 3;
  for (let i = 0; i < tracks.length; i += BATCH) {
    const batch = tracks.slice(i, i + BATCH);
    await Promise.all(batch.map(async (track) => {
      if (!track.lazy || track.videoId) return;
      try {
        const res = await window.nofuf.resolveSpotifyToYouTube(track.title, track.artist);
        if (res?.type === 'success' && res.videoId) {
          track.videoId = res.videoId;
          track.ytUrl   = `https://www.youtube.com/watch?v=${res.videoId}`;
          const ytThumb = `https://i.ytimg.com/vi/${res.videoId}/mqdefault.jpg`;
          track.thumbnail = ytThumb;
          // NO borrar track.cover: es el artwork de Spotify/Deezer y es mejor
          // que el thumbnail del vídeo. Solo rellenar si venía sin portada.
          if (!track.cover) {
            try {
              track.cover = await window.nofuf.fetchImageBase64(ytThumb).catch(() => null);
            } catch (_) { /* se rellenará al reproducir vía resolveLazyTrack */ }
          }
        }
      } catch(e) {
      }
      resolved++;
    }));
    // Persistir con debounce: serializar la biblioteca entera por cada batch de 3
    // multiplicaba el coste con playlists grandes (100x para 300 canciones)
    saveLibrarySoon();
    const pct = Math.round((resolved / total) * 100);
    if (pct < 100) {
      setSpotifyStatus('loading', `Preparando playlist… ${resolved}/${total}`);
    } else {
      setSpotifyStatus('success', `✓ ${total} canciones listas`);
      setTimeout(() => setSpotifyStatus('', ''), 4000);
    }
    // Re-render throttled: la vista de playlist se refresca como mucho 1 vez/seg
    renderPlaylistViewThrottled(playlists.find(p => p.id === playlistId));
  }
  saveLibrary();
  preFetchYouTubeThumbnails(tracks);
}

async function handleYouTubePlaylistImport(url) {
  dom.urlAddBtn.disabled = true;
  setYouTubeStatus('loading', 'Leyendo playlist…');
  showLoading('Importando playlist de YouTube…');

  let result;
  try {
    result = await window.nofuf.resolveYouTubePlaylist(url);
  } catch (e) {
    result = { type: 'error', message: (e && e.message) || 'Error importando la playlist.' };
  } finally {
    dom.urlAddBtn.disabled = false;
    hideLoading();
  }

  if (result.type === 'error') {
    setYouTubeStatus('error', result.message);
    showToast(result.message);
    return;
  }

  const { playlistTitle, videos } = result;
  if (!videos || !videos.length) {
    setYouTubeStatus('error', 'Playlist vacía.');
    showToast('No se encontraron vídeos en la playlist.');
    return;
  }

  setYouTubeStatus('loading', `Procesando ${videos.length} canciones…`);
  dom.urlInput.value = '';

  const pl = {
    id:     'yt-pl-' + Date.now(),
    name:   playlistTitle,
    cover:  null,
    tracks: [],
  };

  const firstWithThumb = videos.find(v => v.thumbnail);
  if (firstWithThumb?.thumbnail) {
    pl.cover = await window.nofuf.fetchImageBase64(firstWithThumb.thumbnail).catch(() => null);
  }

  const newTracks = [];
  const BAD_ARTISTS = new Set(['NA', 'N/A', '']);
  for (const v of videos) {
    const existing = library.find(t => t.videoId === v.id);
    if (existing) {
      if (BAD_ARTISTS.has((existing.artist || '').trim()) && v.uploader) {
        existing.artist = v.uploader;
      }
      pl.tracks.push(existing.id);
      continue;
    }
    const track = {
      id:        'yt-' + v.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
      type:      'youtube',
      title:     v.title,
      artist:    v.uploader || 'YouTube',
      duration:  v.duration || 0,
      cover:     null,
      url:       '',
      ytUrl:     `https://www.youtube.com/watch?v=${v.id}`,
      videoId:   v.id,
      thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      lazy:      true,
    };
    newTracks.push(track);
    pl.tracks.push(track.id);
  }

  addTracksToLibrary(newTracks);
  saveLibrary();
  playlists.push(pl);
  savePlaylists();
  renderSidebarPlaylists();
  renderLibraryUI();

  const total = pl.tracks.length;
  setYouTubeStatus('success', `✓ ${total} canciones importadas`);
  showToast(`"${playlistTitle}" importada · ${total} canciones`);
  setTimeout(() => setYouTubeStatus('', ''), 6000);

  openPlaylist(pl.id);

  preFetchYouTubeThumbnails(newTracks);

}

function videosToLibraryTracks(videos) {
  const newTracks = [];
  const BAD_ARTISTS = new Set(['NA', 'N/A', '']);
  const trackIds = [];
  for (const v of videos) {
    const existing = library.find(t => t.videoId === v.id);
    if (existing) {
      if (BAD_ARTISTS.has((existing.artist || '').trim()) && v.uploader) existing.artist = v.uploader;
      trackIds.push(existing.id);
      continue;
    }
    const track = {
      id:        'yt-' + v.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type:      'youtube',
      title:     v.title,
      artist:    v.uploader || 'YouTube',
      duration:  v.duration || 0,
      cover:     null,
      url:       '',
      ytUrl:     `https://www.youtube.com/watch?v=${v.id}`,
      videoId:   v.id,
      thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      lazy:      true,
    };
    newTracks.push(track);
    trackIds.push(track.id);
  }
  return { newTracks, trackIds };
}

async function handleImportYoutubeLibrary() {
  if (!window.nofuf || !window.nofuf.importYoutubeLibrary) return;
  dom.settingImportLibraryBtn.disabled = true;
  dom.settingImportLibraryStatus.textContent = 'Conectando…';
  showLoading('Importando biblioteca de YouTube…');

  const result = await window.nofuf.importYoutubeLibrary().catch(e => ({ type: 'error', message: e.message }));

  hideLoading();
  dom.settingImportLibraryBtn.disabled = false;

  if (!result || result.type === 'error') {
    const msg = (result && result.message) || 'No se pudo importar la biblioteca.';
    dom.settingImportLibraryStatus.textContent = msg;
    showToast(msg);
    return;
  }

  let allNewTracks = [];
  let favCount = 0, plCount = 0;

  if (result.favorites && result.favorites.videos && result.favorites.videos.length) {
    const { newTracks, trackIds } = videosToLibraryTracks(result.favorites.videos);
    allNewTracks = allNewTracks.concat(newTracks);
    for (const id of trackIds) {
      if (!favorites.includes(id)) favorites.push(id);
    }
    favCount = trackIds.length;
    saveFavorites();
  }

  for (const p of (result.playlists || [])) {
    if (!p.videos || !p.videos.length) continue;
    const { newTracks, trackIds } = videosToLibraryTracks(p.videos);
    allNewTracks = allNewTracks.concat(newTracks);
    const existingPl = playlists.find(pl => pl.ytPlaylistId === p.playlistId);
    if (existingPl) {
      existingPl.tracks = trackIds;
    } else {
      playlists.push({
        id: 'yt-pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        name: p.playlistTitle || 'Playlist de YouTube',
        cover: null,
        tracks: trackIds,
        ytPlaylistId: p.playlistId,
      });
    }
    plCount++;
  }

  addTracksToLibrary(allNewTracks);
  saveLibrary();
  savePlaylists();
  renderSidebarPlaylists();
  renderLibraryUI();
  renderFavoritesUI();

  preFetchYouTubeThumbnails(allNewTracks);

  const msg = `Importado: ${favCount} favoritos, ${plCount} playlists`;
  dom.settingImportLibraryStatus.textContent = msg;
  showToast(msg);
}

async function preFetchYouTubeThumbnails(tracks) {
  let changed = false;
  // Map id→track: library.find dentro del bucle era O(n²) con bibliotecas grandes
  const libById = new Map(library.map(t => [t.id, t]));
  for (const track of tracks) {
    if (track.cover && track.cover.startsWith('data:')) continue;
    if (track.type === 'youtube' && track.videoId) {
      const reliableThumb = `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`;
      if (track.thumbnail !== reliableThumb) {
        track.thumbnail = reliableThumb;
        const lt = libById.get(track.id);
        if (lt) lt.thumbnail = reliableThumb;
        changed = true;
      }
      if (track.cover && !track.cover.startsWith('data:')) {
        track.cover = null;
        const lt = libById.get(track.id);
        if (lt) lt.cover = null;
        changed = true;
      }
    }
  }
  if (changed) {
    saveLibrary();
    updateQueueUI();
    renderLibraryUI();
    if (currentPlaylistId) {
      const activePl = playlists.find(p => p.id === currentPlaylistId);
      if (activePl) renderPlaylistView(activePl);
    }
    renderHomeView();
  }
}

async function resolveLazyTrack(t, { silent = false } = {}) {
  if (!t.lazy || (t.url && t.url.startsWith('http'))) return true;
  // _resolving corrupto cargado de disco (objeto plano, no Promise) significaba
  // early-return sin resolver y src='' → la canción nunca sonaba. Solo vale una Promise real.
  if (t._resolving && typeof t._resolving.then === 'function') return t._resolving;
  t._resolving = null;

  t._resolving = (async () => {
    if (t.spMeta && !t.videoId) {
      if (!silent) setYouTubeStatus('loading', `Buscando "${t.spMeta.title}"…`);
      const cleanTitle = t.spMeta.title.replace(/\s*[\(\[](feat\.|ft\.|with\s|prod\.|remix|version|remastered|explicit)[^\)\]]*[\)\]]/gi, '').trim();
      const primaryArtist = t.spMeta.artist.split(/[,&\/]/)[0].trim();
      const queries = [
        `${primaryArtist} - ${cleanTitle}`,
        `${primaryArtist} ${cleanTitle} audio`,
        `${t.spMeta.artist} ${t.spMeta.title}`,
      ];
      let bestResult = null;
      for (const ytQuery of queries) {
        const searchRes = await window.nofuf.searchYouTube(ytQuery);
        if (searchRes.type === 'error' || !searchRes.results?.length) continue;
        const titleLow = cleanTitle.toLowerCase();
        const origTitleLow = t.spMeta.title.toLowerCase();
        const artistLow = primaryArtist.toLowerCase();
        const allArtistsLow = t.spMeta.artist.toLowerCase();
        let best = null, bestScore = -1;
        for (const r of searchRes.results) {
          const rt = (r.title || '').toLowerCase();
          const ru = (r.uploader || '').toLowerCase();
          let score = 0;
          if (rt.includes(titleLow)) score += 4;
          else if (rt.includes(origTitleLow)) score += 3;
          if (rt.includes(artistLow) || ru.includes(artistLow)) score += 3;
          allArtistsLow.split(/[,&\/]/).forEach(a => {
            const aClean = a.trim();
            if (aClean && (rt.includes(aClean) || ru.includes(aClean))) score += 1;
          });
          if (rt.includes('cover') && !origTitleLow.includes('cover')) score -= 3;
          if (rt.includes('karaoke')) score -= 5;
          if (rt.includes('tutorial')) score -= 5;
          if (rt.includes('reaction')) score -= 5;
          if (rt.includes('live') && !origTitleLow.includes('live')) score -= 1;
          if (rt.includes('remix') && !origTitleLow.includes('remix')) score -= 2;
          if (ru.includes('vevo') || ru.includes('oficial') || ru.includes('official')) score += 2;
          if (ru.includes(artistLow)) score += 2;
          if (score > bestScore) { bestScore = score; best = r; }
        }
        if (best && bestScore >= 0) { bestResult = best; break; }
        if (best && !bestResult) bestResult = best;
      }
      if (!bestResult) {
        const lastResort = await window.nofuf.searchYouTube(`${t.spMeta.artist} ${t.spMeta.title}`);
        if (lastResort.type === 'error' || !lastResort.results?.length) {
          if (!silent) { setYouTubeStatus('error', 'No encontrado en YouTube'); showToast(`⚠ No encontrado: ${t.spMeta.title}`); }
          return false;
        }
        bestResult = lastResort.results[0];
      }
      t.videoId = bestResult.id;
      t.ytUrl = `https://www.youtube.com/watch?v=${bestResult.id}`;
    }

    if (!silent) setYouTubeStatus('loading', 'Resolviendo stream…');
    let resolved = await window.nofuf.resolveYouTube(t.ytUrl || `https://www.youtube.com/watch?v=${t.videoId}`);
    if (resolved.type === 'error') {
      await new Promise(r => setTimeout(r, 800));
      resolved = await window.nofuf.resolveYouTube(t.ytUrl || `https://www.youtube.com/watch?v=${t.videoId}`);
    }
    // Fallback: si el videoId concreto falla pero la canción existe con otro ID
    // (típico: restricción regional / borrado), buscar alternativa por título+artista.
    // No se sobrescribe el original hasta confirmar que la alternativa resuelve.
    if (resolved.type === 'error' && t.spMeta?.title) {
      try {
        const alt = await window.nofuf.resolveSpotifyToYouTube(t.spMeta.title, t.spMeta.artist || t.artist || '');
        if (alt?.type === 'success' && alt.videoId && alt.videoId !== t.videoId) {
          const altUrl = `https://www.youtube.com/watch?v=${alt.videoId}`;
          const r2 = await window.nofuf.resolveYouTube(altUrl);
          if (r2?.type === 'success') {
            t.videoId = alt.videoId;
            t.ytUrl = altUrl;
            resolved = r2;
          }
        }
      } catch (_) {}
    }
    // Segundo fallback para pistas YouTube puras sin spMeta: reintentar vía búsqueda
    if (resolved.type === 'error' && !t.spMeta && t.title) {
      try {
        const s = await window.nofuf.searchYouTube(`${t.artist || ''} ${t.title}`.trim());
        const cand = s?.results?.find(r => r.id && r.id !== t.videoId) || s?.results?.[0];
        if (cand?.id && cand.id !== t.videoId) {
          const candUrl = `https://www.youtube.com/watch?v=${cand.id}`;
          const r3 = await window.nofuf.resolveYouTube(candUrl);
          if (r3?.type === 'success') {
            t.videoId = cand.id;
            t.ytUrl = candUrl;
            resolved = r3;
          }
        }
      } catch (_) {}
    }
    if (resolved.type === 'error') {
      if (!silent) { setYouTubeStatus('error', resolved.message); showToast('Error al resolver el stream: ' + resolved.message); }
      return false;
    }
    t.url = resolved.streamUrl;
    t.lazy = false;
    t._resolvedAt = Date.now();
    t.quality = resolved.quality || t.quality || '';
    if (!t.cover && resolved.thumbnail) {
      t.cover = await window.nofuf.fetchImageBase64(resolved.thumbnail).catch(() => null);
    }
    saveLibrarySoon();
    saveQueueSoon();
    if (!silent) { try { syncNowPlayingHeader(t); } catch (_) {} }
    if (!silent) setYouTubeStatus('', '');
    return true;
  })();

  try { return await t._resolving; }
  finally { t._resolving = null; }
}

// Precarga silenciosa de las próximas pistas de la cola (reduce la espera de "Abriendo stream…")
function prefetchUpcoming(count = 3) {
  if (!queue.length || isShuffle) return;
  const targets = [];
  for (let step = 1; step <= count; step++) {
    const next = queue[(currentIndex + step) % queue.length];
    if (!next) break;
    if (next.type === 'youtube' && next.lazy && (!next.url || !next.url.startsWith('http'))) targets.push(next);
  }
  if (!targets.length) return;
  let chain = Promise.resolve();
  for (const t of targets) {
    chain = chain.then(() => resolveLazyTrack(t, { silent: true }).catch(() => {}));
  }
}

// ============ Radio infinita ============
let _isRadioExtending = false;
async function _radioExtend() {
  const cur = queue[currentIndex];
  if (!cur || !cur.videoId || _isRadioExtending) return;
  _isRadioExtending = true;
  try {
    const res = await window.nofuf.resolveYouTubeRelated(cur.videoId);
    if (res?.type === 'success' && res.videos?.length) {
      const existing = new Set(queue.map(q => q.videoId).filter(Boolean));
      const fresh = res.videos.filter(v => v.id && !existing.has(v.id));
      if (fresh.length) {
        const { newTracks } = videosToLibraryTracks(fresh.slice(0, 10));
        // Evitar duplicados por id interno también
        const ids = new Set(queue.map(q => q.id));
        const toAdd = newTracks.filter(t => !ids.has(t.id));
        if (toAdd.length) {
          addTracksToLibrary(toAdd);
          queue.push(...toAdd.map(t => ({ ...t })));
          updateQueueUI();
          saveQueueSoon();
        }
      }
    } else {
      showToast(window.i18n && window.i18n.T ? window.i18n.T('No se encontraron canciones similares') : 'No se encontraron canciones similares');
    }
  } catch (e) {
    console.warn('[radio]', e);
  } finally {
    _isRadioExtending = false;
  }
}

async function updateMediaSessionMetadata(t, myGen) {
  if (!('mediaSession' in navigator)) return;
  if (myGen !== _playGeneration) return;

  const artSrc = t.cover || '';
  const artwork = artSrc
    ? [{ src: artSrc, sizes: '512x512', type: /\.png($|\?)/i.test(artSrc) || artSrc.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  t.title  || '',
    artist: t.artist || '',
    album:  t.album  || '',
    artwork,
  });
  navigator.mediaSession.playbackState = 'playing';
}

function _normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(official|video|audio|lyrics?|hd|hq|remaster(ed)?|ft\.?|feat\.?|topic)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _wordOverlap(a, b) {
  const aw = new Set(a.split(' ').filter(Boolean));
  const bw = new Set(b.split(' ').filter(Boolean));
  if (!aw.size || !bw.size) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  return inter / Math.max(aw.size, bw.size);
}

async function enrichAlbumFromSpotify(t) {
  if (!window.nofuf?.searchSpotify) return null;
  if (t.album && t.cover) return null;

  const query = `${t.artist || ''} ${t.title || ''}`.trim();
  if (!query) return null;

  try {
    const res = await window.nofuf.searchSpotify(query);
    if (res?.type !== 'success' || !res.results?.length) return null;

    const cleanTitle  = _normalizeForMatch(t.title);
    const cleanArtist = _normalizeForMatch(t.artist);

    let best = null, bestScore = 0;
    for (const cand of res.results) {
      const titleSim  = _wordOverlap(cleanTitle,  _normalizeForMatch(cand.title));
      const artistSim = _wordOverlap(cleanArtist, _normalizeForMatch(cand.artist));
      const score = titleSim * 0.65 + artistSim * 0.35;
      if (score > bestScore) { bestScore = score; best = cand; }
    }

    if (!best || bestScore < 0.55) return null;

    return { album: best.album || '', cover: best.cover || '' };
  } catch (e) {
    console.warn('[album-enrich] búsqueda falló:', e.message);
    return null;
  }
}

function syncNowPlayingHeader(t) {
  if (!t) return;
  try {
    const cover = t.cover || '';
    if (dom.trackTitle) dom.trackTitle.textContent = t.title || '';
    if (dom.trackArtist) dom.trackArtist.textContent = t.artist || '';
    if (dom.trackSource) dom.trackSource.textContent = t.type === 'youtube' ? 'YouTube' : 'Local';
    if (dom.barTitle) dom.barTitle.textContent = t.title || '';
    if (dom.barArtist) {
      dom.barArtist.textContent = t.artist || '';
      // Calidad del stream (p. ej. "opus · 160kbps") como tooltip
      dom.barArtist.title = t.quality || '';
    }
    if (dom.artImage) {
      const cur = dom.artImage.getAttribute('src') || '';
      if (cur !== cover) dom.artImage.src = cover;
      dom.artImage.style.display = cover ? 'block' : 'none';
    }
    if (dom.artPlaceholder) dom.artPlaceholder.style.display = cover ? 'none' : 'flex';
    if (dom.barArt) {
      const key = t.id + '|' + (cover ? cover.length + ':' + cover.slice(-32) : 'empty');
      if (dom.barArt.dataset.coverKey !== key) {
        dom.barArt.style.backgroundImage = cover ? `url(${cover})` : 'none';
        dom.barArt.style.backgroundSize = 'cover';
        dom.barArt.style.backgroundPosition = 'center';
        dom.barArt.dataset.coverKey = key;
      }
    }
    if (dom.lyricsArt) {
      const curL = dom.lyricsArt.getAttribute('src') || '';
      if (curL !== cover) dom.lyricsArt.src = cover;
    }
    if (dom.lyricsTrackName) dom.lyricsTrackName.textContent = t.title || '';
    if (dom.lyricsArtistName) dom.lyricsArtistName.textContent = t.artist || '';
  } catch (e) {}
}

async function playTrack(index) {
  if (index < 0 || index >= queue.length) return;
  currentIndex = index;
  const _myGen = ++_playGeneration;
  const t = queue[currentIndex];
  addToRecents(t.id);
  incrementPlayCount(t.id);
  saveQueueSoon();

  // TTL de streams: las URLs de YouTube caducan (~6 h); forzar re-resolución si es vieja
  if (t.type === 'youtube' && !t.lazy && t._resolvedAt && (Date.now() - t._resolvedAt) > 4 * 3600 * 1000) {
    t.lazy = true; t.url = '';
  }

  syncNowPlayingHeader(t);

  await updateMediaSessionMetadata(t, _myGen);

  if (t.type === 'youtube' && !t._albumChecked) {
    t._albumChecked = true;
    enrichAlbumFromSpotify(t).then((info) => {
      if (!info) return;
      let changed = false;
      if (info.album && !t.album) { t.album = info.album; changed = true; }
      if (info.cover && !t.cover) { t.cover = info.cover; changed = true; }
      if (changed) {
        saveLibrary();
        if (_myGen === _playGeneration) {
          syncNowPlayingHeader(t);
          updateMediaSessionMetadata(t, _myGen);
        }
      }
    }).catch((e) => console.warn('[album-enrich] fallo silencioso:', e.message));
  }

  if (dom.lyricsPanel && dom.lyricsPanel.classList.contains('open')) fetchLyrics(t);

  updateFavBtn(t.id);
  updatePlaybackUI();
  updateQueueActiveUI();

  audioPlayer.volume = linearToAudioVolume(currentVolume);

  showLoading('Abriendo stream…');

  if (t.type === 'youtube' && t.lazy && (!t.url || !t.url.startsWith('http'))) {
    const ok = await resolveLazyTrack(t, { silent: false });
    if (_myGen !== _playGeneration) { hideLoading(); return; }
    if (!ok) { hideLoading(); return; }
    syncNowPlayingHeader(t);
    await updateMediaSessionMetadata(t, _myGen);
  }

  if (_myGen !== _playGeneration) { hideLoading(); return; }
  audioPlayer.src = t.url;
  audioPlayer.load();
  // Reanudar la posición guardada: el setter encola el seek aunque no haya metadata aún
  if (_resumePosition > 0) {
    try { audioPlayer.currentTime = _resumePosition; } catch (_) {}
    _resumePosition = 0;
  }

  if (_vizCtx && _vizCtx.state === 'suspended') {
    try { await _vizCtx.resume(); } catch(e) { console.warn('[audio] ctx resume:', e); }
  }

  audioPlayer.play()
    .then(async () => {
      if (_myGen !== _playGeneration) return;
      isPlaying = true;
      updatePlaybackUI();
      hideLoading();
      if (_vizCtx && _vizCtx.state === 'suspended') {
        try { await _vizCtx.resume(); } catch(e) {}
      }
      prefetchUpcoming();
      _updateRpcState();
      _syncMiniNow();
      _scrobbleSchedule(t);
    })
    .catch(err => {
      // Un play() abortado por un cambio rápido de pista no es un error real
      if (_myGen !== _playGeneration || err && err.name === 'AbortError') { hideLoading(); return; }
      hideLoading(); showToast('Error cargando el stream.'); console.error(err);
    });
}

function togglePlay() {
  if (currentIndex === -1 && queue.length > 0) { playTrack(0); return; }
  if (currentIndex === -1) return;
  // Cola restaurada sin src todavía: reproducir la pista actual de verdad
  if (!audioPlayer.src && currentIndex >= 0) { playTrack(currentIndex); return; }
  if (isPlaying) {
    audioPlayer.pause();
    isPlaying = false;
    _updateRpcState();
    _syncMiniNow();
  } else {
    if (_vizCtx && _vizCtx.state === 'suspended') {
      _vizCtx.resume().catch(() => {});
    }
    audioPlayer.play()
      .then(() => { isPlaying = true; updatePlaybackUI(); _updateRpcState(); _syncMiniNow(); })
      .catch(() => { isPlaying = false; updatePlaybackUI(); showToast('No se pudo reanudar la reproducción.'); });
  }
  updatePlaybackUI();
}
function playNext() {
  if (!queue.length) return;
  if (isShuffle) {
    // Evitar repetir la pista actual cuando hay más de una
    let next = currentIndex;
    if (queue.length > 1) {
      while (next === currentIndex) next = Math.floor(Math.random() * queue.length);
    }
    playTrack(next);
  } else if (isRadio && currentIndex >= queue.length - 1 && !isRepeat) {
    // Radio infinita: extender la cola con canciones similares antes de avanzar
    _radioExtend().then(() => {
      playTrack((currentIndex + 1) % queue.length);
    });
  } else {
    playTrack((currentIndex + 1) % queue.length);
  }
}
function playPrev() {
  if (!queue.length) return;
  if (audioPlayer.currentTime > 4) { audioPlayer.currentTime = 0; return; }
  playTrack((currentIndex - 1 + queue.length) % queue.length);
}
function linearToAudioVolume(pct) {
  return Math.pow(pct, 3);
}

function setVolume(pct) {
  currentVolume = pct;
  audioPlayer.volume = linearToAudioVolume(pct);
  if (!isMuted) {
    dom.volFill.style.width = `${pct * 100}%`;
    dom.volThumb.style.left = `${pct * 100}%`;
  }
  if (dom.volNumberInput) dom.volNumberInput.value = Math.round(pct * 100);
}

function deleteTrack(track, context) {
  const libIdx = library.findIndex(t => t.id === track.id);
  if (libIdx >= 0) { library.splice(libIdx, 1); saveLibrary(); }
  const favIdx = favorites.indexOf(track.id);
  if (favIdx >= 0) { favorites.splice(favIdx, 1); saveFavorites(); }
  playlists.forEach(pl => {
    const i = pl.tracks.indexOf(track.id);
    if (i >= 0) pl.tracks.splice(i, 1);
  });
  savePlaylists();
  const qIdx = queue.findIndex(t => t.id === track.id);
  if (qIdx >= 0) {
    queue.splice(qIdx, 1);
    if (currentIndex === qIdx) {
      if (queue.length) playTrack(qIdx >= queue.length ? 0 : qIdx);
      else { currentIndex = -1; audioPlayer.src = ''; isPlaying = false; updatePlaybackUI(); resetNowPlaying(); }
    } else if (currentIndex > qIdx) { currentIndex--; }
  }
  updateQueueUI(); renderLibraryUI(); renderFavoritesUI();
  renderSidebarPlaylists();
  if (context === 'playlist') {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (pl) renderPlaylistView(pl);
  }
  showToast('Canción eliminada');
}

function openEditModal(track) {
  editingTrackId = track.id;
  dom.editTitleInput.value  = track.title;
  dom.editArtistInput.value = track.artist;
  if (track.cover) {
    dom.editArtPreview.src = track.cover;
    dom.editArtPreview.style.display = 'block';
    dom.editArtPick.style.display    = 'none';
  } else {
    dom.editArtPreview.style.display = 'none';
    dom.editArtPick.style.display    = 'flex';
  }
  dom.editCoverInput.value = '';
  dom.modalEditBackdrop.classList.add('open');
  setTimeout(() => dom.editTitleInput.focus(), 50);
}
function closeEditModal() { dom.modalEditBackdrop.classList.remove('open'); editingTrackId = null; }
function saveEditedTrack() {
  if (!editingTrackId) return;
  const newTitle  = dom.editTitleInput.value.trim();
  const newArtist = dom.editArtistInput.value.trim();
  const newCover  = dom.editArtPreview.style.display !== 'none' && dom.editArtPreview.src
    ? dom.editArtPreview.src : null;

  const lt = library.find(t => t.id === editingTrackId);
  if (lt) {
    if (newTitle)  lt.title  = newTitle;
    if (newArtist) lt.artist = newArtist;
    if (newCover)  lt.cover  = newCover;
    saveLibrary();
  }
  const qt = queue.find(t => t.id === editingTrackId);
  if (qt) {
    if (newTitle)  qt.title  = newTitle;
    if (newArtist) qt.artist = newArtist;
    if (newCover)  qt.cover  = newCover;
  }
  if (currentIndex >= 0 && queue[currentIndex]?.id === editingTrackId) {
    const t = queue[currentIndex];
    dom.trackTitle.textContent  = t.title;
    dom.trackArtist.textContent = t.artist;
    dom.barTitle.textContent    = t.title;
    dom.barArtist.textContent   = t.artist;
    if (t.cover) {
      dom.artImage.src = t.cover;
      dom.artImage.style.display = 'block';
      dom.artPlaceholder.style.display = 'none';
      dom.barArt.style.backgroundImage = `url(${t.cover})`;
    }
  }
  updateQueueUI(); renderLibraryUI(); renderFavoritesUI();
  closeEditModal();
  showToast('Canción actualizada');
}

function addTracksToLibrary(tracks) {
  tracks.forEach(t => {
    if (!library.find(l => l.id === t.id)) library.push(t);
  });
  saveLibrary();
}
let _trackIndex = null, _trackIndexLib = null, _trackIndexQueue = null, _trackIndexLibLen = -1, _trackIndexQueueLen = -1;
function _ensureTrackIndex() {
  if (_trackIndex && _trackIndexLib === library && _trackIndexQueue === queue
      && _trackIndexLibLen === library.length && _trackIndexQueueLen === queue.length) return _trackIndex;
  const map = new Map();
  for (let i = queue.length - 1; i >= 0; i--) map.set(queue[i].id, queue[i]);
  for (let i = library.length - 1; i >= 0; i--) map.set(library[i].id, library[i]);
  _trackIndex = map;
  _trackIndexLib = library; _trackIndexQueue = queue;
  _trackIndexLibLen = library.length; _trackIndexQueueLen = queue.length;
  return map;
}
function findTrackById(id) {
  return _ensureTrackIndex().get(id) || null;
}

function toggleFavorite(track) {
  const idx = favorites.indexOf(track.id);
  if (idx >= 0) {
    favorites.splice(idx, 1);
    showToast('Eliminado de favoritos');
  } else {
    favorites.push(track.id);
    addTracksToLibrary([track]);
    showToast('Añadido a favoritos');
  }
  saveFavorites();
  updateFavBtn(track.id);
  // Reconstruir la vista de favoritos solo si está abierta
  if (document.getElementById('view-favorites')?.classList.contains('active')) renderFavoritesUI();
}

// Alterna el corazón en todos los botones de favorito visibles para una pista
function updateFavButtonsForTrack(trackId) {
  const isFav = favorites.includes(trackId);
  document.querySelectorAll('.qi-fav-btn').forEach(btn => {
    if (btn.dataset.id === trackId) {
      btn.classList.toggle('active', isFav);
      btn.querySelector('svg')?.setAttribute('fill', isFav ? 'currentColor' : 'none');
    }
  });
}
function updateFavBtn(id) {
  const isFav = favorites.includes(id);
  dom.barFavBtn.classList.toggle('active', isFav);
}

function openSettingsModal() {
  dom.settingDefaultVolume.value = settings.defaultVolume;
  dom.settingDefaultVolumeVal.textContent = settings.defaultVolume + '%';
  dom.settingCrossfade.checked = settings.crossfade;
  dom.settingCrossfadeDuration.value = settings.crossfadeDuration;
  dom.settingCrossfadeDurationVal.textContent = settings.crossfadeDuration + 's';
  dom.crossfadeDurationRow.style.display = settings.crossfade ? '' : 'none';
  dom.settingNormalize.checked = settings.normalize;
  dom.settingAutoplay.checked  = settings.autoplay !== false;
  dom.settingShowDuration.checked = settings.showDuration !== false;
  dom.settingSpinArt.checked = settings.spinArt !== false;
  dom.settingAutoLyrics.checked = !!settings.autoLyrics;
  dom.settingMinimizeTray.checked = settings.minimizeTray !== false;
  dom.settingCloseTray.checked = settings.closeTray !== false;
  dom.settingHideWindowControls.checked = !!settings.hideWindowControls;
  dom.settingCookieBrowser.value = settings.cookieBrowser || 'auto';
  dom.settingCookieBrowserStatus.textContent = '';
  if (window.nofuf && window.nofuf.getCookieBrowserStatus) {
    window.nofuf.getCookieBrowserStatus().then(status => {
      if (!status) return;
      dom.settingCookieBrowserStatus.textContent = status.detected
        ? `Detectado: ${status.detected}`
        : 'No se ha detectado ninguna sesión de navegador';
    }).catch(() => {});
  }
  dom.settingManualCookies.value = '';
  dom.settingManualCookiesStatus.textContent = '';
  if (window.nofuf && window.nofuf.getManualCookiesStatus) {
    window.nofuf.getManualCookiesStatus().then(status => {
      if (!status) return;
      dom.settingManualCookiesStatus.textContent = status.active
        ? 'Cookies manuales activas y en uso'
        : (status.exists ? 'Cookies guardadas pero desactivadas' : 'Sin cookies manuales guardadas');
    }).catch(() => {});
  }
  dom.settingImportLibraryStatus.textContent = '';
  _selAppIcon = settings.appIcon || 'default';
  _selTrayIcon = settings.trayIcon || 'tray-default';
  _renderIconSelectors().catch(() => {});
  const _verEl = document.getElementById('setting-app-version');
  if (_verEl) {
    _verEl.textContent = '…';
    if (window.nofuf?.getAppVersion) {
      window.nofuf.getAppVersion()
        .then(v => { _verEl.textContent = v ? 'v' + v : '—'; })
        .catch(() => { _verEl.textContent = '—'; });
    } else {
      _verEl.textContent = '—';
    }
  }
  const _updStatus = document.getElementById('setting-update-status');
  if (_updStatus) _updStatus.textContent = '';
  const _dlUpdBtn = document.getElementById('setting-download-update');
  if (_dlUpdBtn) _dlUpdBtn.style.display = 'none';
  document.querySelectorAll('.color-pick').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === settings.accentColor);
  });
  dom.modalSettingsBackdrop.classList.add('open');
}
function closeSettingsModal() { dom.modalSettingsBackdrop.classList.remove('open'); }
function saveSettingsFromModal() {
  const activeColor = document.querySelector('.color-pick.active');
  settings.defaultVolume = parseInt(dom.settingDefaultVolume.value);
  settings.crossfade = dom.settingCrossfade.checked;
  settings.crossfadeDuration = parseInt(dom.settingCrossfadeDuration.value);
  settings.normalize = dom.settingNormalize.checked;
  settings.autoplay  = dom.settingAutoplay.checked;
  settings.showDuration = dom.settingShowDuration.checked;
  settings.spinArt   = dom.settingSpinArt.checked;
  settings.accentColor = activeColor ? activeColor.dataset.color : '#ffffff';
  settings.autoLyrics = dom.settingAutoLyrics.checked;
  settings.minimizeTray = dom.settingMinimizeTray.checked;
  settings.closeTray = dom.settingCloseTray.checked;
  settings.hideWindowControls = dom.settingHideWindowControls.checked;
  settings.cookieBrowser = dom.settingCookieBrowser.value;
  settings.appIcon = _selAppIcon || 'default';
  settings.trayIcon = _selTrayIcon || 'tray-default';
  if (window.nofuf && window.nofuf.setCookieBrowser) {
    window.nofuf.setCookieBrowser(settings.cookieBrowser).catch(() => {});
  }
  saveSettings();
  applySettings();
  const lt = document.querySelector('.lyrics-text');
  if (lt) {
    lt.style.fontSize = settings.lyricsSize + 'px';
    if (settings.lyricsFont) lt.style.fontFamily = settings.lyricsFont;
  }
  closeSettingsModal();
  showToast('Configuración guardada');
}

function openNewPlaylistModal() {
  dom.modalNameInput.value = '';
  dom.modalArtPick.style.display = 'flex';
  dom.modalArtPreview.style.display = 'none';
  dom.modalArtPreview.src = '';
  dom.modalCoverInput.value = '';
  dom.modalBackdrop.classList.add('open');
  setTimeout(() => dom.modalNameInput.focus(), 50);
}
function closeModal() { dom.modalBackdrop.classList.remove('open'); }
function createPlaylist() {
  const name = dom.modalNameInput.value.trim() || 'Nueva playlist';
  const cover = dom.modalArtPreview.src && dom.modalArtPreview.style.display !== 'none'
    ? dom.modalArtPreview.src : null;
  const pl = { id: 'pl-' + Date.now(), name, cover, tracks: [] };
  playlists.push(pl);
  savePlaylists();
  renderSidebarPlaylists();
  closeModal();
  openPlaylist(pl.id);
  showToast(`Playlist "${name}" creada`);
}
function openPlaylist(id) {
  currentPlaylistId = id;
  const pl = playlists.find(p => p.id === id);
  if (!pl) return;
  renderPlaylistHero(pl);
  renderPlaylistView(pl);
  showView('playlist');
}
function renderPlaylistHero(pl) {
  dom.playlistHeroName.textContent = pl.name;
  dom.playlistHeroCount.textContent = window.i18n && window.i18n.T ? window.i18n.T(`${pl.tracks.length} cancion${pl.tracks.length !== 1 ? 'es' : ''}`) : `${pl.tracks.length} cancion${pl.tracks.length !== 1 ? 'es' : ''}`;
  dom.playlistHeroArt.querySelectorAll('img').forEach(img => img.remove());
  if (pl.cover) {
    const img = document.createElement('img');
    img.src = pl.cover;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;border-radius:8px';
    dom.playlistHeroArt.prepend(img);
    dom.playlistHeroArt.querySelector('svg').style.display = 'none';
  } else {
    const sv = dom.playlistHeroArt.querySelector('svg');
    if (sv) sv.style.display = '';
  }
}
function renderPlaylistView(pl) {
  const tracks = pl.tracks.map(id => findTrackById(id)).filter(Boolean);
  dom.playlistHeroCount.textContent = window.i18n && window.i18n.T ? window.i18n.T(`${tracks.length} cancion${tracks.length !== 1 ? 'es' : ''}`) : `${tracks.length} cancion${tracks.length !== 1 ? 'es' : ''}`;
  dom.playlistEmpty.style.display = tracks.length ? 'none' : 'flex';
  dom.playlistTrackList.innerHTML = '';
  const _frag = document.createDocumentFragment();
  tracks.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'playlist',
      onPlay: () => {
        queue = [...tracks];
        updateQueueUI(); playTrack(i);
      },
    });
    _frag.appendChild(el);
  });
  dom.playlistTrackList.appendChild(_frag);
}
function renderSidebarPlaylists() {
  dom.playlistListSidebar.innerHTML = '';
  const _frag = document.createDocumentFragment();
  playlists.forEach(pl => {
    const btn = document.createElement('div');
    btn.className = `sb-playlist${currentPlaylistId === pl.id ? ' active' : ''}`;
    btn.dataset.id = pl.id;
    const thumbHtml = pl.cover
      ? `<div class="sb-playlist-thumb"><img src="${escapeHTML(pl.cover)}"></div>`
      : `<div class="sb-playlist-thumb"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/></svg></div>`;
    btn.innerHTML = `${thumbHtml}<span class="sb-playlist-name">${escapeHTML(pl.name)}</span>`;
    btn.addEventListener('click', () => openPlaylist(pl.id));
    // Soltar canciones de la biblioteca/favoritos sobre la playlist
    btn.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/nofuf-track')) { e.preventDefault(); btn.classList.add('drag-over'); }
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
    btn.addEventListener('drop', e => {
      btn.classList.remove('drag-over');
      const trackId = e.dataTransfer.getData('text/nofuf-track');
      if (!trackId) return;
      e.preventDefault();
      const t = findTrackById(trackId);
      if (t) addTrackToPlaylist(pl.id, t);
    });
    _frag.appendChild(btn);
  });
  dom.playlistListSidebar.appendChild(_frag);
}


function reorderQueue(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= queue.length || toIndex >= queue.length) return;
  const [moved] = queue.splice(fromIndex, 1);
  queue.splice(toIndex, 0, moved);
  if (currentIndex === fromIndex) {
    currentIndex = toIndex;
  } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
    currentIndex--;
  } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
    currentIndex++;
  }
  updateQueueUI();
}

function setupQueueItemDrag(el, index) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.qi-menu-btn') || e.target.closest('.qi-fav-btn')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let placeholder = null;
    let floatingEl = null;
    let grabOffsetY = 0;

    const scrollParent = dom.queueList.closest('.queue-scroll') || dom.queueList.parentElement;

    const activate = () => {
      if (isDragging) return;
      isDragging = true;
      const rect = el.getBoundingClientRect();
      grabOffsetY = startY - rect.top;

      placeholder = document.createElement('div');
      placeholder.className = 'queue-item-placeholder';
      placeholder.style.height = `${rect.height}px`;

      floatingEl = el.cloneNode(true);
      floatingEl.className = `${el.className} qi-dragging-floating`;
      floatingEl.style.width = `${rect.width}px`;
      floatingEl.style.height = `${rect.height}px`;
      floatingEl.style.left = `${rect.left}px`;
      floatingEl.style.top = `${rect.top}px`;
      document.body.appendChild(floatingEl);

      el.classList.add('qi-source-hidden');
      if (el.nextSibling) {
        dom.queueList.insertBefore(placeholder, el.nextSibling);
      } else {
        dom.queueList.appendChild(placeholder);
      }
    };

    const holdTimer = setTimeout(() => {
      activate();
    }, 160);

    const onPointerMove = me => {
      if (!isDragging) {
        if (Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
          clearTimeout(holdTimer);
          activate();
        }
      }
      if (!isDragging || !floatingEl || !placeholder) return;

      me.preventDefault();
      const topPos = me.clientY - grabOffsetY;
      floatingEl.style.top = `${topPos}px`;

      if (scrollParent) {
        const sRect = scrollParent.getBoundingClientRect();
        if (me.clientY < sRect.top + 45) {
          scrollParent.scrollTop -= 8;
        } else if (me.clientY > sRect.bottom - 45) {
          scrollParent.scrollTop += 8;
        }
      }

      const items = Array.from(dom.queueList.children).filter(child => child !== placeholder && child !== el);
      let inserted = false;
      for (const item of items) {
        const r = item.getBoundingClientRect();
        if (me.clientY < r.top + r.height / 2) {
          dom.queueList.insertBefore(placeholder, item);
          inserted = true;
          break;
        }
      }
      if (!inserted && items.length) {
        dom.queueList.appendChild(placeholder);
      }
    };

    const onPointerUp = () => {
      clearTimeout(holdTimer);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (!isDragging) return;

      const remainingChildren = Array.from(dom.queueList.children).filter(child => child !== el);
      const toIndex = remainingChildren.indexOf(placeholder);

      // Solo suprimir el click posterior (play) si hubo un reordenamiento real;
      // una pulsación larga sin mover no debe "comerse" la reproducción
      if (toIndex >= 0 && toIndex !== index) {
        el._dragJustEnded = true;
        setTimeout(() => { delete el._dragJustEnded; }, 150);
      }

      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }
      if (floatingEl && floatingEl.parentNode) {
        floatingEl.parentNode.removeChild(floatingEl);
      }
      el.classList.remove('qi-source-hidden');

      if (toIndex >= 0 && toIndex !== index) {
        reorderQueue(index, toIndex);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}

function updateQueueUI() {
  dom.queueList.innerHTML = '';
  const _frag = document.createDocumentFragment();
  dom.queueEmpty.style.display = queue.length ? 'none' : 'flex';
  queue.forEach((t, i) => {    const el = buildTrackItem(t, i, {
      context: 'queue',
      isActive: i === currentIndex,
      onPlay: () => playTrack(i),
      onRemove: () => {
        queue.splice(i, 1);
        if (currentIndex === i) {
          if (queue.length) playTrack(i >= queue.length ? 0 : i);
          else { currentIndex = -1; audioPlayer.src = ''; isPlaying = false; updatePlaybackUI(); resetNowPlaying(); }
        } else if (currentIndex > i) { currentIndex--; }
        updateQueueUI();
      },
    });
    setupQueueItemDrag(el, i);
    _frag.appendChild(el);
  });
  dom.queueList.appendChild(_frag);
  saveQueueSoon();
}

// Versión ligera para cambios de pista: solo alterna la clase .active
// (reconstruir todo el DOM de la cola en cada play provocaba reflows y re-decodificación de imágenes)
function updateQueueActiveUI() {
  const items = dom.queueList.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === currentIndex);
  }
}

// ============ Biblioteca: búsqueda, orden y agrupación ============
let _libSearch = '', _libSort = 'custom', _libGroup = 'none';
let _libVisible = [];
let _favVisible = [];

function _libraryVisibleTracks() {
  const q = _libSearch.trim().toLowerCase();
  let arr = library;
  if (q) {
    arr = arr.filter(t =>
      (t.title  || '').toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q) ||
      (t.album  || '').toLowerCase().includes(q));
  }
  const coll = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  if (_libSort === 'title')        arr = [...arr].sort((a, b) => coll(a.title, b.title));
  else if (_libSort === 'artist')  arr = [...arr].sort((a, b) => coll(a.artist, b.artist) || coll(a.title, b.title));
  else if (_libSort === 'recent')  arr = [...arr].reverse();
  else if (_libSort === 'plays')   arr = [...arr].sort((a, b) => ((playCounts[b.id]?.n) || 0) - ((playCounts[a.id]?.n) || 0));
  return arr;
}

function renderLibraryUI() {
  _libVisible = _libraryVisibleTracks();
  dom.libraryList.innerHTML = '';
  const _frag = document.createDocumentFragment();
  dom.libraryEmpty.style.display = _libVisible.length ? 'none' : 'flex';
  if (!_libVisible.length && _libSearch.trim()) {
    const hint = dom.libraryEmpty.querySelector('span');
    if (hint) hint.textContent = window.i18n && window.i18n.T ? window.i18n.T('Sin resultados') : 'Sin resultados';
  }

  const makeRow = (t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'library',
      onPlay: () => {
        if (!queue.find(q => q.id === t.id)) queue.push({...t});
        const qi = queue.findIndex(q => q.id === t.id);
        updateQueueUI(); playTrack(qi);
      },
    });
    if (_selIds.has(t.id)) el.classList.add('selected');
    return el;
  };

  if (_libGroup === 'none') {
    _libVisible.forEach((t, i) => _frag.appendChild(makeRow(t, i)));
  } else {
    const keyFn = _libGroup === 'artist'
      ? (t => (t.artist || '').trim() || '—')
      : (t => (t.album || '').trim() || (t.artist || '').trim() || '—');
    // Conteos en una pasada
    const counts = new Map();
    for (const t of _libVisible) { const k = keyFn(t); counts.set(k, (counts.get(k) || 0) + 1); }
    let lastKey = null;
    _libVisible.forEach((t, i) => {
      const k = keyFn(t);
      if (k !== lastKey) {
        lastKey = k;
        const h = document.createElement('div');
        h.className = 'lib-group-header';
        h.innerHTML = `<span>${escapeHTML(k)}</span><span class="lib-group-count">${counts.get(k)}</span>`;
        _frag.appendChild(h);
      }
      _frag.appendChild(makeRow(t, i));
    });
  }
  dom.libraryList.appendChild(_frag);
}

// ============ Selección múltiple (biblioteca / favoritos) ============
const _selIds = new Set();
let _selAnchorId = null;
let _selContext = null;

function handleListSelect(context, track, el, e) {
  const list = context === 'favorites' ? _favVisible : _libVisible;
  _selContext = context;
  const idx = list.findIndex(x => x.id === track.id);
  if (e.shiftKey && _selAnchorId != null) {
    const aIdx = list.findIndex(x => x.id === _selAnchorId);
    if (aIdx >= 0 && idx >= 0) {
      const [s, en] = aIdx < idx ? [aIdx, idx] : [idx, aIdx];
      if (!e.ctrlKey && !e.metaKey) _selIds.clear();
      for (let i = s; i <= en; i++) _selIds.add(list[i].id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (_selIds.has(track.id)) _selIds.delete(track.id);
    else _selIds.add(track.id);
    _selAnchorId = track.id;
  } else {
    _selIds.clear();
    _selIds.add(track.id);
    _selAnchorId = track.id;
  }
  _selApplyClasses();
  _selUpdateBar();
}

function _selApplyClasses() {
  document.querySelectorAll('#library-list .queue-item, #favorites-list .queue-item').forEach(el => {
    el.classList.toggle('selected', _selIds.has(el.dataset.trackId));
  });
}

function _selUpdateBar() {
  const bar = document.getElementById('sel-action-bar');
  if (!bar) return;
  const viewOk = _selIds.size > 0;
  bar.style.display = viewOk ? 'flex' : 'none';
  if (!viewOk) return;
  const countEl = document.getElementById('sel-count');
  if (countEl) countEl.textContent = String(_selIds.size);
}

function _selClear() {
  _selIds.clear();
  _selAnchorId = null;
  _selApplyClasses();
  _selUpdateBar();
}

function _selTracksInOrder() {
  const list = _selContext === 'favorites' ? _favVisible : _libVisible;
  const out = [];
  for (const t of list) if (_selIds.has(t.id)) out.push(t);
  // Añadir por si hay seleccionadas que no están en la vista actual
  for (const id of _selIds) {
    if (!out.find(t => t.id === id)) { const t = findTrackById(id); if (t) out.push(t); }
  }
  return out;
}

function _selDeleteSelected() {
  const ids = [..._selIds];
  if (!ids.length) return;
  const msg = window.i18n && window.i18n.T
    ? window.i18n.T(`¿Quitar ${ids.length} canción${ids.length !== 1 ? 'es' : ''} de la biblioteca?`)
    : `¿Quitar ${ids.length} canción${ids.length !== 1 ? 'es' : ''} de la biblioteca?`;
  if (!confirm(msg)) return;
  const idSet = new Set(ids);
  const curTrack = currentIndex >= 0 ? queue[currentIndex] : null;

  library   = library.filter(t => !idSet.has(t.id));
  favorites = favorites.filter(id => !idSet.has(id));
  playlists.forEach(pl => { pl.tracks = pl.tracks.filter(id => !idSet.has(id)); });
  queue = queue.filter(t => !idSet.has(t.id));

  if (curTrack && idSet.has(curTrack.id)) {
    currentIndex = -1;
    audioPlayer.src = '';
    isPlaying = false;
    updatePlaybackUI();
    resetNowPlaying();
  } else if (curTrack) {
    currentIndex = queue.findIndex(q => q.id === curTrack.id);
  }

  saveLibrary(); saveFavorites(); savePlaylists(); saveQueueNow();
  _selClear();
  updateQueueUI(); renderLibraryUI(); renderFavoritesUI(); renderSidebarPlaylists();
  showToast(window.i18n && window.i18n.T ? window.i18n.T(`${ids.length} eliminadas`) : `${ids.length} eliminadas`);
}

function renderFavoritesUI() {
  const favTracks = favorites.map(id => findTrackById(id)).filter(Boolean);

  const heroCount = document.getElementById('favorites-hero-count');
  if (heroCount) heroCount.textContent = window.i18n && window.i18n.T ? window.i18n.T(`${favTracks.length} cancion${favTracks.length !== 1 ? 'es' : ''}`) : `${favTracks.length} cancion${favTracks.length !== 1 ? 'es' : ''}`;

  dom.favoritesList.innerHTML = '';
  const _favFrag = document.createDocumentFragment();
  dom.favoritesEmpty.style.display = favTracks.length ? 'none' : 'flex';

  const playBtn = document.getElementById('favorites-play-btn');
  if (playBtn) {
    playBtn.onclick = () => {
      if (!favTracks.length) return;
      queue.length = 0;
      favTracks.forEach(t => queue.push({ ...t }));
      updateQueueUI();
      playTrack(0);
      showToast('Reproduciendo favoritos');
    };
  }

  const dlBtn = document.getElementById('favorites-download-btn');
  if (dlBtn) {
    dlBtn.onclick = () => {
      if (!favTracks.length) { showToast('No hay favoritos para descargar'); return; }
      const modalBtn = document.getElementById('playlist-download-all-btn');
      if (!modalBtn) { showToast('Modal de descarga no disponible'); return; }
      modalBtn._overrideTracks = favTracks;
      modalBtn._overrideName   = 'Favoritos';
      modalBtn.click();
      setTimeout(() => { modalBtn._overrideTracks = null; modalBtn._overrideName = null; }, 200);
    };
  }

  const clearBtn = document.getElementById('favorites-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (!favTracks.length) return;
      if (!confirm(window.i18n && window.i18n.T ? window.i18n.T(`¿Eliminar ${favTracks.length} canciones de favoritos?`) : `¿Eliminar ${favTracks.length} canciones de favoritos?`)) return;
      favorites.length = 0;
      localStorage.setItem(KEYS.favorites, JSON.stringify(favorites));
      try { window.nofuf?.configWrite?.('favorites.json', JSON.stringify([])); } catch(e) {}
      renderFavoritesUI();
      renderLibraryUI();
      updateQueueUI();
      showToast('Favoritos eliminados');
    };
  }

  _favVisible = favTracks;
  favTracks.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'favorites',
      onPlay: () => {
        queue = favTracks.map(ft => ({ ...ft }));
        updateQueueUI();
        playTrack(i);
      },
    });
    if (_selIds.has(t.id)) el.classList.add('selected');
    _favFrag.appendChild(el);
  });
  dom.favoritesList.appendChild(_favFrag);
}

let _favSet = null, _favSetRef = null, _favSetLen = -1;
function isFavoriteId(id) {
  if (!_favSet || _favSetRef !== favorites || _favSetLen !== favorites.length) {
    _favSet = new Set(favorites);
    _favSetRef = favorites;
    _favSetLen = favorites.length;
  }
  return _favSet.has(id);
}

function buildTrackItem(t, i, { isActive = false, onPlay, onRemove, context = '' } = {}) {
  const el = document.createElement('div');
  el.className = `queue-item${isActive ? ' active' : ''}`;
  el.dataset.trackId = t.id;
  // Arrastrable hacia las playlists del sidebar (no en la cola: ahí el drag reordena)
  if (context === 'library' || context === 'favorites') {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      try { e.dataTransfer.setData('text/nofuf-track', t.id); e.dataTransfer.effectAllowed = 'copy'; } catch (_) {}
    });
  }
  const isFav = isFavoriteId(t.id);
  const thumbSrc = t.cover || t.thumbnail || null;
  const thumb = thumbSrc
    ? `<img src="${escapeHTML(thumbSrc)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      + `<svg style="display:none;width:100%;height:100%;align-items:center;justify-content:center" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const dur = t.duration > 0 ? formatTime(t.duration) : '—';
  const durClass = settings.showDuration !== false ? 'qi-dur' : 'qi-dur hidden';

  el.innerHTML = `
    <span class="qi-num">${i + 1}</span>
    <div class="qi-thumb">${thumb}</div>
    <div class="qi-info">
      <div class="qi-title">${escapeHTML(t.title)}</div>
      <div class="qi-artist">${escapeHTML(t.artist)}</div>
    </div>
    ${t.type === 'youtube' ? '<span class="qi-type-badge" style="visibility:hidden">MP3</span>' : `<span class="qi-type-badge ${t.type}">MP3</span>`}
    <span class="${durClass}">${dur}</span>
    <button class="qi-fav-btn${isFav ? ' active' : ''}" data-id="${escapeHTML(t.id)}" title="Favorito">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
    </button>
    <button class="qi-menu-btn" title="Más opciones">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
    </button>`;

  el.addEventListener('click', e => {
    if (el._dragJustEnded) { delete el._dragJustEnded; return; }
    if (e.target.closest('.qi-menu-btn') || e.target.closest('.qi-fav-btn')) return;
    // Selección múltiple con Ctrl/Shift en biblioteca y favoritos
    if ((context === 'library' || context === 'favorites') && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      handleListSelect(context, t, el, e);
      return;
    }
    if (onPlay) onPlay();
  });
  el.addEventListener('contextmenu', e => { e.preventDefault(); openCtxMenu(e, t, context); });

  el.querySelector('.qi-fav-btn')?.addEventListener('click', e => {
    e.stopPropagation(); toggleFavorite(t);
  });
  el.querySelector('.qi-menu-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openCtxMenu(e, t, context, onRemove);
  });
  return el;
}

function openCtxMenu(e, track, context, onRemove) {
  ctxTrack   = track;
  ctxContext = context;

  dom.ctxPlaylistOpts.innerHTML = '';
  playlists.forEach(pl => {
    const btn = document.createElement('div');
    btn.className = 'ctx-playlist-item';
    const thumbHtml = pl.cover
      ? `<div class="ctx-pl-thumb"><img src="${escapeHTML(pl.cover)}"></div>`
      : `<div class="ctx-pl-thumb"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/></svg></div>`;
    btn.innerHTML = `${thumbHtml}<span>${escapeHTML(pl.name)}</span>`;
    btn.addEventListener('click', () => { addTrackToPlaylist(pl.id, track); closeCtxMenu(); });
    dom.ctxPlaylistOpts.appendChild(btn);
  });

  const favSpan = dom.ctxFav.querySelector('span');
  if (favSpan) {
    const isFav = favorites.includes(track.id);
    favSpan.textContent = (window.i18n && window.i18n.t)
      ? window.i18n.t(isFav ? 'ctx.removeFavorite' : 'ctx.addFavorite')
      : (isFav ? 'Quitar de favoritos' : 'Añadir a favoritos');
  }

  let x = Math.min(e.clientX, window.innerWidth - 210);
  let y = e.clientY;
  dom.ctxMenu.style.left = x + 'px';
  dom.ctxMenu.style.top  = y + 'px';
  dom.ctxMenu.classList.add('open');

  requestAnimationFrame(() => {
    const menuRect   = dom.ctxMenu.getBoundingClientRect();
    const playerBar  = document.querySelector('.player-bar');
    const playerTop  = playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight;
    const maxBottom  = playerTop - 6;
    if (menuRect.bottom > maxBottom) {
      y = Math.max(0, maxBottom - menuRect.height);
      dom.ctxMenu.style.top = y + 'px';
    }
    if (menuRect.right > window.innerWidth - 6) {
      dom.ctxMenu.style.left = Math.max(0, window.innerWidth - menuRect.width - 6) + 'px';
    }
  });
}
function closeCtxMenu() { dom.ctxMenu.classList.remove('open'); ctxTrack = null; ctxContext = null; }

function addTrackToPlaylist(plId, track) {
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;
  if (pl.tracks.includes(track.id)) { showToast('Ya está en la playlist'); return; }
  pl.tracks.push(track.id);
  addTracksToLibrary([track]);
  savePlaylists();
  if (currentPlaylistId === plId) renderPlaylistView(pl);
  showToast(`Añadido a "${pl.name}"`);
}

function openLyricsPanel() {
  if (!dom.lyricsPanel) return;
  lyricsPanelOpen = true;
  dom.lyricsPanel.style.width = '';
  dom.lyricsPanel.classList.add('open');
  const btn = document.getElementById('btn-lyrics-toggle');
  if (btn) btn.classList.add('active');
  if (currentIndex >= 0 && queue[currentIndex]) fetchLyrics(queue[currentIndex]);
}
function toggleLyricsPanel() {
  if (!dom.lyricsPanel) return;
  if (dom.lyricsPanel.classList.contains('open')) closeLyricsPanel();
  else openLyricsPanel();
}
function closeLyricsPanel() {
  if (!dom.lyricsPanel) return;
  lyricsPanelOpen = false;
  dom.lyricsPanel.style.width = '';
  dom.lyricsPanel.classList.remove('open');
  const btn = document.getElementById('btn-lyrics-toggle');
  if (btn) btn.classList.remove('active');
}

function showLyricsError(track) {
  dom.lyricsSourceBar.style.display = 'none';
  const _notFound = window.i18n && window.i18n.T ? window.i18n.T('No se encontró letra para esta canción.') : 'No se encontró letra para esta canción.';
  const _tryManual = window.i18n && window.i18n.T ? window.i18n.T('Prueba a buscarla manualmente en Genius o AZLyrics.') : 'Prueba a buscarla manualmente en Genius o AZLyrics.';
  dom.lyricsBody.innerHTML = `<div class="lyrics-error">
    ${_notFound}<br><br>
    <strong>${escapeHTML(track.title)}</strong><br>
    <em>${escapeHTML(track.artist)}</em><br><br>
    ${_tryManual}
  </div>`;
}

function updatePlaybackUI() {
  if (isPlaying) {
    dom.playIcon.style.display  = 'none';
    dom.pauseIcon.style.display = '';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } else {
    dom.playIcon.style.display  = '';
    dom.pauseIcon.style.display = 'none';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
  if ('mediaSession' in navigator && !window._mediaSessionHandlersSet) {
    window._mediaSessionHandlersSet = true;
    navigator.mediaSession.setActionHandler('play',          () => { if (!isPlaying) togglePlay(); });
    navigator.mediaSession.setActionHandler('pause',         () => { if (isPlaying)  togglePlay(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack',     () => playNext());
  }
}

function resetNowPlaying() {
  dom.trackSource.textContent = '';
  dom.trackTitle.textContent  = 'Nofufaudio';
  dom.trackArtist.textContent = window.i18n && window.i18n.T ? window.i18n.T('Tu reproductor híbrido') : 'Tu reproductor híbrido';
  dom.artImage.style.display  = 'none';
  dom.artPlaceholder.style.display = 'flex';
  dom.timeCurrent.textContent = '0:00';
  dom.timeTotal.textContent   = '0:00';
  dom.progressFill.style.width = '0%';
  dom.barTitle.textContent  = '—';
  dom.barArtist.textContent = '—';
  dom.barArt.style.backgroundImage = 'none';
  dom.barFavBtn.classList.remove('active');
}

function formatTime(s) {
  if (isNaN(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60); const ss = Math.floor(s % 60);
  return `${m}:${ss < 10 ? '0' : ''}${ss}`;
}

function setYouTubeStatus(type, msg) {
  if (window.i18n && window.i18n.T && msg) msg = window.i18n.T(msg);
  dom.urlStatus.className = `url-status ${type}`;
  dom.urlStatus.textContent = msg;
}

function showLoading(text) {
  if (window.i18n && window.i18n.T && text) text = window.i18n.T(text);
  dom.loadingText.textContent = text; dom.loadingOverlay.style.display = 'flex';
}
function hideLoading()     { dom.loadingOverlay.style.display = 'none'; }

let toastTimer = null;
function showToast(msg) {
  if (window.i18n && window.i18n.T) msg = window.i18n.T(msg);
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2500);
}

function decodeEntities(str = '') {
  return String(str)
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function escapeHTML(str = '') {
  return decodeEntities(str).replace(/[&<>"]/g, t => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[t] || t));
}
function escapeLyricsHTML(str = '') {
  return decodeEntities(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
(function setupResizablePanels() {

  const lyricsEl = document.getElementById('lyrics-panel');
  const lyricsHandle = document.getElementById('lyrics-resize-handle');
  if (lyricsEl && lyricsHandle) {
    let dragging = false, startX = 0, startW = 0, dragRaf = null, pendingW = 0;

    const applyWidth = () => {
      dragRaf = null;
      lyricsEl.style.width = pendingW + 'px';
      document.documentElement.style.setProperty('--lp', pendingW + 'px');
    };

    const onMove = e => {
      if (!dragging) return;
      const delta = startX - e.clientX;
      pendingW = Math.max(180, startW + delta);
      if (dragRaf == null) dragRaf = requestAnimationFrame(applyWidth);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (dragRaf != null) { cancelAnimationFrame(dragRaf); applyWidth(); }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      lyricsHandle.classList.remove('dragging');
      lyricsEl.style.transition = '';
      lyricsEl.style.width = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    lyricsHandle.addEventListener('mousedown', e => {
      if (!lyricsEl.classList.contains('open')) return;
      dragging = true;
      startX = e.clientX;
      startW = lyricsEl.offsetWidth;
      lyricsHandle.classList.add('dragging');
      lyricsEl.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }
})();

if (window.nofuf?.onSaveBeforeHide) {
  window.nofuf.onSaveBeforeHide(() => {
    try { saveLibrarySoon.flush(); saveSettings(); savePlaylists(); saveLibrary(); saveFavorites(); } catch(e) {  }
    try {
      if (window._nofufApplyBg && window._currentBgDataUrl) {
      }
      if (window._nofufSaveBg) window._nofufSaveBg();
    } catch(e) {}
  });
}

if (window.nofuf?.onOpenFilesExternal) {
  window.nofuf.onOpenFilesExternal((files) => {
    try {
      if (Array.isArray(files) && files.length && typeof processFilePaths === 'function') {
        showLoading('Cargando archivos…');
        processFilePaths(files).catch(() => {}).finally(() => hideLoading());
      }
    } catch (_) {}
  });
}

const dom2 = {
  vizCanvas: document.getElementById('visualizer'),
  settingSyncedLyrics: document.getElementById('setting-synced-lyrics'),
  settingPickDownloadDir: document.getElementById('setting-pick-download-dir'),
  settingDownloadDirDisplay: document.getElementById('setting-download-dir-display'),
  settingDownloadFormat: document.getElementById('setting-download-format'),
  settingVizEnabled: document.getElementById('setting-viz-enabled'),
  settingVizStyle:   document.getElementById('setting-viz-style'),
  settingVizColor:   document.getElementById('setting-viz-color'),
  settingVizShadow:  document.getElementById('setting-viz-shadow'),
  settingVizSensitivity: document.getElementById('setting-viz-sensitivity'),
  settingVizSensitivityVal: document.getElementById('setting-viz-sensitivity-val'),
  vizView: document.getElementById('viz-view'),
  vizIdleHint: document.getElementById('viz-idle-hint'),
  vizTrackTitle:  _domNoop,
  vizTrackArtist: _domNoop,
  vizTrackArt:    _domNoop,
  vizSettingsBtn: document.getElementById('viz-settings-btn'),
  vizSettingsDrawer: document.getElementById('viz-settings-drawer'),
  vizSdClose: document.getElementById('viz-sd-close'),
  vizSdEnabled: document.getElementById('viz-sd-enabled'),
  vizSdColor: document.getElementById('viz-sd-color'),
  vizSdShadow: document.getElementById('viz-sd-shadow'),
  vizSdSensitivity: document.getElementById('viz-sd-sensitivity'),
  vizSdSensitivityVal: document.getElementById('viz-sd-sensitivity-val'),
  vizSdOpacity: document.getElementById('viz-sd-opacity'),
  vizSdOpacityVal: document.getElementById('viz-sd-opacity-val'),
  btnViz: document.getElementById('btn-viz'),
  btnExportCfg: document.getElementById('settings-export-config'),
  btnImportCfg: document.getElementById('settings-import-config'),
  btnOpenCfgFolder: document.getElementById('settings-open-config-folder'),
  downloadsPanel: document.getElementById('downloads-panel'),
  downloadsBody:  document.getElementById('downloads-body'),
  downloadsClose: document.getElementById('downloads-close'),
  ctxDownload: document.getElementById('ctx-download'),
};

if (dom.modalEditBackdrop) {
  dom.modalEditBackdrop.addEventListener('click', e => {
    e.stopPropagation();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dom.modalEditBackdrop.classList.contains('open')) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
}

const _origOpenSettingsModal = openSettingsModal;
openSettingsModal = function() {
  _origOpenSettingsModal();
  if (dom2.settingSyncedLyrics)  dom2.settingSyncedLyrics.checked = settings.syncedLyrics !== false;
  if (dom2.settingDownloadDirDisplay) dom2.settingDownloadDirDisplay.textContent = settings.downloadDir || '(no establecida)';
  if (dom2.settingDownloadFormat) dom2.settingDownloadFormat.value = settings.downloadFormat || 'mp3';
  if (dom2.settingVizEnabled)    dom2.settingVizEnabled.checked = settings.vizEnabled !== false;
  if (dom2.settingVizStyle)      dom2.settingVizStyle.value = settings.vizStyle || 'bars';
  if (dom2.settingVizColor)      dom2.settingVizColor.value = settings.vizColor || '#ffffff';
  if (dom2.settingVizShadow)     dom2.settingVizShadow.checked = settings.vizShadow !== false;
  if (dom2.settingVizSensitivity){
    dom2.settingVizSensitivity.value = settings.vizSensitivity || 1.5;
    if (dom2.settingVizSensitivityVal) dom2.settingVizSensitivityVal.textContent = (settings.vizSensitivity||1.5)+'×';
  }
};

const _origSaveSettingsFromModal = saveSettingsFromModal;
saveSettingsFromModal = function() {
  const safeVol = currentVolume;
  if (dom2.settingSyncedLyrics)  settings.syncedLyrics = dom2.settingSyncedLyrics.checked;
  if (dom2.settingDownloadFormat) settings.downloadFormat = dom2.settingDownloadFormat.value;
  if (dom2.settingVizEnabled)    settings.vizEnabled = dom2.settingVizEnabled.checked;
  if (dom2.settingVizStyle)      settings.vizStyle = dom2.settingVizStyle.value;
  if (dom2.settingVizColor)      settings.vizColor = dom2.settingVizColor.value;
  if (dom2.settingVizShadow)     settings.vizShadow = dom2.settingVizShadow.checked;
  if (dom2.settingVizSensitivity) settings.vizSensitivity = parseFloat(dom2.settingVizSensitivity.value);
  if (_normGain) _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
  _origSaveSettingsFromModal();
  currentVolume = safeVol;
  audioPlayer.volume = isMuted ? 0 : linearToAudioVolume(safeVol);
  setVolume(safeVol);
  applyVizSettings();
  _syncVizPanelControls();
  // Reactivar el bucle del visualizador si se volvió a habilitar con la vista abierta
  if (settings.vizEnabled !== false && dom2.vizView?.classList.contains('active')) {
    _vizSettled = false; _vizStart();
  }
  if (lyricsPanelOpen && currentIndex >= 0 && _lastLyricsResult) renderLyrics(_lastLyricsResult);
};

if (dom2.settingVizSensitivity) {
  dom2.settingVizSensitivity.addEventListener('input', () => {
    if (dom2.settingVizSensitivityVal) dom2.settingVizSensitivityVal.textContent = dom2.settingVizSensitivity.value + '×';
  });
}

if (dom2.settingPickDownloadDir) {
  dom2.settingPickDownloadDir.addEventListener('click', async () => {
    const dir = await window.nofuf.downloadPickFolder();
    if (dir) {
      settings.downloadDir = dir;
      if (dom2.settingDownloadDirDisplay) dom2.settingDownloadDirDisplay.textContent = dir;
    }
  });
}

function gatherFullConfig() {
  const vars = ['--bg','--bg2','--bg3','--bg4','--bar-bg','--t1','--t2','--t3','--accent','--border','--font'];
  const css = {};
  const cs = getComputedStyle(document.documentElement);
  vars.forEach(v => { css[v] = (document.documentElement.style.getPropertyValue(v) || cs.getPropertyValue(v) || '').trim(); });
  return {
    _meta: { app:'nofufaudio', version: 3, exportedAt: new Date().toISOString() },
    settings,
    theme: css,
    favorites,
    playlists,
  };
}
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  Object.entries(theme).forEach(([k,v]) => {
    if (!v || typeof v !== 'string') return;
    if (k === '--font-scale') return;
    if (k === '--base-font-size') {
      const px = parseFloat(v) || 14;
      document.documentElement.style.setProperty('--font-scale', (px / 14).toFixed(4));
    } else {
      document.documentElement.style.setProperty(k, v);
    }
  });
}

if (dom2.btnExportCfg) dom2.btnExportCfg.addEventListener('click', async () => {
  const data = gatherFullConfig();
  const txt = JSON.stringify(data, null, 2);
  await window.nofuf.configWrite('nofufaudio-config-export.json', txt);
  const res = await window.nofuf.exportConfigFile('nofufaudio-config.json', txt);
  if (res?.ok) showToast('Config exportada: ' + res.path);
});

if (dom2.btnImportCfg) dom2.btnImportCfg.addEventListener('click', async () => {
  const file = await window.nofuf.importConfigFile();
  if (!file) return;
  try {
    const obj = JSON.parse(file.content);
    if (obj.settings) settings = Object.assign({}, DEFAULT_SETTINGS, obj.settings);
    if (obj.theme)    { settings.theme = obj.theme; applyTheme(obj.theme); }
    if (obj.favorites) { favorites = obj.favorites; saveFavorites(); }
    if (obj.playlists) { playlists = obj.playlists; savePlaylists(); }
    saveSettings();
    applySettings();
    applyVizSettings();
    renderSidebarPlaylists();
    renderFavoritesUI();
    showToast('Configuración importada');
  } catch (e) {
    showToast('Archivo de config inválido');
  }
});

if (dom2.btnOpenCfgFolder) dom2.btnOpenCfgFolder.addEventListener('click', () => {
  window.nofuf.configOpenFolder();
});

const downloads = new Map();

function openDownloadsPanel() { dom2.downloadsPanel.classList.add('open'); }
function closeDownloadsPanel() { dom2.downloadsPanel.classList.remove('open'); }
if (dom2.downloadsClose) dom2.downloadsClose.addEventListener('click', closeDownloadsPanel);

const dlToggle = document.createElement('button');
dlToggle.className = 'dl-toggle-btn';
dlToggle.title = 'Descargas';
dlToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span class="badge" id="dl-badge" style="display:none">0</span>';
document.body.appendChild(dlToggle);
dlToggle.addEventListener('click', () => {
  if (dom2.downloadsPanel.classList.contains('open')) closeDownloadsPanel();
  else openDownloadsPanel();
});

function refreshDownloadsEmpty() {
  const empty = dom2.downloadsBody.querySelector('.downloads-empty');
  if (downloads.size === 0) {
    if (!empty) dom2.downloadsBody.innerHTML = '<div class="downloads-empty">Sin descargas activas</div>';
  } else if (empty) empty.remove();
  const badge = document.getElementById('dl-badge');
  if (badge) {
    badge.textContent = downloads.size;
    badge.style.display = downloads.size > 0 ? '' : 'none';
  }
}

function addDownloadRow(id, track) {
  const el = document.createElement('div');
  el.className = 'dl-item';
  el.dataset.id = id;
  el.innerHTML = `
    <div class="dl-item-title">${escapeHTML((track.artist?track.artist+' — ':'')+track.title)}</div>
    <div class="dl-item-bar"><div class="dl-item-bar-fill"></div></div>
    <div class="dl-item-meta"><span class="dl-pct">0%</span><span class="dl-status">esperando…</span></div>
  `;
  dom2.downloadsBody.prepend(el);
  downloads.set(id, { el, track });
  refreshDownloadsEmpty();
}
function updateDownloadRow(id, data) {
  const entry = downloads.get(id); if (!entry) return;
  const { el } = entry;
  const pct = Math.max(0, Math.min(100, data.percent || 0));
  el.querySelector('.dl-item-bar-fill').style.width = pct + '%';
  el.querySelector('.dl-pct').textContent = pct.toFixed(1) + '%';
  let status = data.status || '';
  if (data.speed) status += ' · ' + data.speed;
  if (data.eta)   status += ' · ETA ' + data.eta;
  el.querySelector('.dl-status').textContent = status;
  if (data.status === 'done') { el.classList.add('done'); el.querySelector('.dl-status').textContent = window.i18n && window.i18n.T ? window.i18n.T('✓ completado') : '✓ completado'; }
  if (data.status === 'error') { el.classList.add('error'); el.querySelector('.dl-status').textContent = '✗ ' + (data.error||'error'); }
}

// ============ Descargas persistentes (retomar al abrir) ============
let _dlPersist = [];
function _dlLoad() { try { _dlPersist = JSON.parse(localStorage.getItem(KEYS.downloads) || '[]'); } catch { _dlPersist = []; } }
function _dlSave() {
  try {
    // Solo interesan las que estaban a medias: las terminadas/fallidas no se reanudan
    localStorage.setItem(KEYS.downloads, JSON.stringify(_dlPersist.filter(d => d.status === 'downloading').slice(-20)));
  } catch {}
}
const _dlSaveSoon = _debounce(_dlSave, 500);
function _dlPersistAdd(item) {
  _dlPersist = _dlPersist.filter(d => d.id !== item.id);
  _dlPersist.push(item);
  _dlSaveSoon();
}
function _dlPersistSet(id, status) {
  const it = _dlPersist.find(d => d.id === id);
  if (it) { it.status = status; _dlSaveSoon(); }
}
function _initDownloadsResume() {
  _dlLoad();
  const pending = _dlPersist.filter(d => d.status === 'downloading' && d.track);
  if (!pending.length) return;
  showToast(`Reanudando ${pending.length} descarga${pending.length !== 1 ? 's' : ''} pendiente${pending.length !== 1 ? 's' : ''}…`);
  let chain = Promise.resolve();
  for (const item of pending) {
    chain = chain
      .then(() => new Promise(r => setTimeout(r, 2500)))
      .then(() => downloadTrack({ ...item.track }, { resumeId: item.id }).catch(() => {}));
  }
}

if (window.nofuf?.onDownloadProgress) {
  window.nofuf.onDownloadProgress((data) => {
    updateDownloadRow(data.id, data);
    if (data.status === 'done') {
      _dlPersistSet(data.id, 'done');
      showToast('Descarga completa');
      setTimeout(() => { downloads.delete(data.id); refreshDownloadsEmpty();  }, 60000);
    } else if (data.status === 'error') {
      _dlPersistSet(data.id, 'error');
    }
  });
}

async function downloadTrack(track, { resumeId = null } = {}) {
  if (!settings.downloadDir) {
    settings.downloadDir = await window.nofuf.downloadDefaultFolder();
    saveSettings();
  }
  let dir = settings.downloadDir;
  if (!dir) { showToast('Elige carpeta de descarga en Configuración'); return; }
  const id = resumeId || ('dl-' + Date.now() + '-' + Math.random().toString(36).slice(2,7));
  addDownloadRow(id, track);
  openDownloadsPanel();
  _dlPersistAdd({
    id,
    status: 'downloading',
    track: { type: track.type, videoId: track.videoId, ytUrl: track.ytUrl, path: track.path, title: track.title, artist: track.artist },
    dir,
    format: settings.downloadFormat || 'mp3',
  });
  try {
    let res;
    if (track.type === 'youtube') {
      res = await window.nofuf.downloadYouTube({
        id, videoId: track.videoId, ytUrl: track.ytUrl,
        title: track.title, artist: track.artist,
        outDir: dir, format: settings.downloadFormat || 'mp3',
        template: settings.downloadTemplate || '{artist} - {title}',
      });
    } else if (track.path) {
      res = await window.nofuf.downloadLocalFile({
        id, srcPath: track.path, outDir: dir,
        title: track.title, artist: track.artist
      });
    } else { showToast('No se puede descargar este audio'); return; }
    if (!res?.ok) showToast('Error en descarga: ' + (res?.error||''));
  } catch (e) { showToast('Error: ' + e.message); }
}

if (dom2.ctxDownload) {
  dom2.ctxDownload.addEventListener('click', () => {
    if (ctxTrack) downloadTrack(ctxTrack);
    closeCtxMenu();
  });
}

(function initPlaylistDownload() {
  try {
  const btn         = document.getElementById('playlist-download-all-btn');
  const backdrop    = document.getElementById('modal-dl-playlist-backdrop');
  const closeBtn    = document.getElementById('modal-dl-playlist-close');
  const cancelBtn   = document.getElementById('modal-dl-playlist-cancel');
  const confirmBtn  = document.getElementById('modal-dl-playlist-confirm');
  const pickDirBtn  = document.getElementById('modal-dl-playlist-pick-dir');
  const dirDisplay  = document.getElementById('modal-dl-playlist-dir-display');
  const formatSel   = document.getElementById('modal-dl-playlist-format');
  const infoDiv     = document.getElementById('modal-dl-playlist-info');

  if (!btn || !backdrop) return;

  let dlDir = '';

  function openModal() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) return;
    const tracks = pl.tracks.map(id => findTrackById(id)).filter(Boolean);
    if (tracks.length === 0) { showToast('La playlist está vacía'); return; }

    dlDir = settings.downloadDir || '';
    dirDisplay.textContent = dlDir || '(no establecida)';
    formatSel.value = settings.downloadFormat || 'mp3';
    infoDiv.textContent = window.i18n && window.i18n.T ? window.i18n.T(`Se descargarán ${tracks.length} canción${tracks.length !== 1 ? 'es' : ''} en la carpeta elegida.`) : `Se descargarán ${tracks.length} canción${tracks.length !== 1 ? 'es' : ''} en la carpeta elegida.`;
    backdrop.style.display = 'flex';
  }

  function closeModal() {
    backdrop.style.display = 'none';
  }

  btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });

  pickDirBtn.addEventListener('click', async () => {
    try {
      const dir = await window.nofuf.downloadPickFolder();
      if (dir) { dlDir = dir; dirDisplay.textContent = dir; }
    } catch (e) { showToast('No se pudo elegir carpeta'); }
  });

  confirmBtn.addEventListener('click', async () => {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) return;
    const tracks = pl.tracks.map(id => findTrackById(id)).filter(Boolean);
    if (tracks.length === 0) { showToast('La playlist está vacía'); closeModal(); return; }

    let dir = dlDir;
    if (!dir) {
      try { dir = await window.nofuf.downloadDefaultFolder(); }
      catch (e) { showToast('No se pudo determinar la carpeta de descarga'); return; }
    }
    if (!dir) { showToast('Elige una carpeta de descarga primero'); return; }

    settings.downloadDir = dir;
    settings.downloadFormat = formatSel.value;
    saveSettings();

    closeModal();
    openDownloadsPanel();
    showToast(`Descargando ${tracks.length} canción${tracks.length !== 1 ? 'es' : ''}…`);

    const fmt = formatSel.value || 'mp3';

    const batchSize = 3;
    for (let i = 0; i < tracks.length; i += batchSize) {
      const batch = tracks.slice(i, i + batchSize);
      await Promise.all(batch.map(async track => {
        const id = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        addDownloadRow(id, track);
        _dlPersistAdd({
          id,
          status: 'downloading',
          track: { type: track.type, videoId: track.videoId, ytUrl: track.ytUrl, path: track.path, title: track.title, artist: track.artist },
          dir, format: fmt,
        });
        try {
          let res;
          if (track.type === 'youtube') {
            res = await window.nofuf.downloadYouTube({
              id, videoId: track.videoId, ytUrl: track.ytUrl,
              title: track.title, artist: track.artist,
              outDir: dir, format: fmt,
              template: settings.downloadTemplate || '{artist} - {title}',
            });
          } else if (track.path) {
            res = await window.nofuf.downloadLocalFile({
              id, srcPath: track.path, outDir: dir,
              title: track.title, artist: track.artist
            });
          }
          if (res && !res.ok) { _dlPersistSet(id, 'error'); showToast(`Error: ${track.title} — ${res.error || ''}`); }
        } catch (e) {
          _dlPersistSet(id, 'error');
          showToast(`Error descargando ${track.title}: ${e.message}`);
        }
      }));
    }
  });
  } catch(e) { console.error('[initPlaylistDownload]', e); }
})();

function parseLRC(lrc) {
  const lines = [];
  lrc.split(/\r?\n/).forEach(line => {
    const matches = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!matches.length) return;
    const text = line.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, '').trim();
    matches.forEach(m => {
      const t = parseInt(m[1])*60 + parseFloat(m[2]);
      lines.push({ t, text });
    });
  });
  lines.sort((a,b) => a.t - b.t);
  return lines;
}

async function fetchLyrics(track, { force = false } = {}) {
  if (!track) return;
  const cacheKey = `${track.id}::${_romajiActive ? 'ro' : 'n'}`;

  dom.lyricsArt.src = track.cover || '';
  dom.lyricsTrackName.textContent  = decodeEntities(track.title);
  dom.lyricsArtistName.textContent = decodeEntities(track.artist);

  if (!force && _lyricsCache.has(cacheKey)) {
    const cached = _lyricsCache.get(cacheKey);
    _lastLyricsResult = cached;
    if (cached && cached.found) renderLyrics(cached);
    else showLyricsError(track);
    return;
  }

  dom.lyricsBody.innerHTML = `<div class="lyrics-loading"><div class="spinner"></div><span>${window.i18n ? window.i18n.T('Buscando letra…') : 'Buscando letra…'}</span></div>`;
  dom.lyricsSourceBar.style.display = 'none';
  _syncedLines = null; _activeLrcLineIdx = -1;
  try {
    const result = await window.nofuf.fetchLyricsMain({
      title: track.title, artist: track.artist, videoId: track.videoId || null,
      romaji: _romajiActive,
    });
    const stillRelevant = currentIndex >= 0 && queue[currentIndex] === track
      && cacheKey === `${track.id}::${_romajiActive ? 'ro' : 'n'}`;
    if (_lyricsCache.size >= _LYRICS_CACHE_MAX) {
      const oldest = _lyricsCache.keys().next().value;
      if (oldest !== undefined) _lyricsCache.delete(oldest);
    }
    _lyricsCache.set(cacheKey, result);
    if (!stillRelevant) return;
    _lastLyricsResult = result;
    if (result && result.found) renderLyrics(result);
    else showLyricsError(track);
  } catch (err) {
    console.error('[lyrics]', err);
    showLyricsError(track);
  }
}

let _romanizeVendorsPromise = null;
function _loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.dataset.lazySrc = src;
    el.addEventListener('load', () => { el.dataset.loaded = '1'; resolve(); }, { once: true });
    el.addEventListener('error', reject, { once: true });
    document.head.appendChild(el);
  });
}
function _loadRomanizeVendors() {
  if (typeof Kuroshiro !== 'undefined' && typeof KuromojiAnalyzer !== 'undefined') return Promise.resolve();
  if (!_romanizeVendorsPromise) {
    _romanizeVendorsPromise = _loadScriptOnce('vendor/kuroshiro.min.js')
      .then(() => _loadScriptOnce('vendor/kuroshiro-analyzer-kuromoji.min.js'))
      .catch(err => { _romanizeVendorsPromise = null; throw err; });
  }
  return _romanizeVendorsPromise;
}

function getKuroshiro() {
  if (_kuroshiroInstance) return Promise.resolve(_kuroshiroInstance);
  if (_kuroshiroInitPromise) return _kuroshiroInitPromise;

  _kuroshiroInitPromise = (async () => {
    try {
      await _loadRomanizeVendors();
      if (typeof Kuroshiro === 'undefined' || typeof KuromojiAnalyzer === 'undefined') {
        console.error('[romanize] Kuroshiro/KuromojiAnalyzer no están cargados (revisa los <script> de vendor/ en index.html).');
        return null;
      }
      const KuroshiroCtor = (typeof Kuroshiro === 'function') ? Kuroshiro : Kuroshiro.default;
      if (typeof KuroshiroCtor !== 'function') {
        console.error('[romanize] No se encontró el constructor de Kuroshiro en el bundle cargado.');
        return null;
      }
      const instance = new KuroshiroCtor();
      await instance.init(new KuromojiAnalyzer({ dictPath: 'vendor/kuromoji-dict/' }));
      _kuroshiroInstance = instance;
      return instance;
    } catch (err) {
      console.error('[romanize] Fallo al inicializar Kuroshiro/Kuromoji:', err);
      _kuroshiroInstance = null;
      return null;
    } finally {
      if (!_kuroshiroInstance) _kuroshiroInitPromise = null;
    }
  })();

  return _kuroshiroInitPromise;
}

async function romanizeText(text) {
  if (!text) return text;
  const kuroshiro = await getKuroshiro();
  if (!kuroshiro) return text;
  try {
    return await kuroshiro.convert(text, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' });
  } catch (err) {
    console.error('[romanize] Error al convertir texto:', err);
    return text;
  }
}

async function romanizeLines(lines) {
  if (!lines || !lines.length) return lines;
  const DELIM = '\u241E';
  const joined = lines.join(DELIM);
  const out = await romanizeText(joined);
  const split = out.split(DELIM);
  if (split.length !== lines.length) {
    console.warn('[romanize] Desajuste de líneas al romanizar, se mantiene el texto original.');
    return lines;
  }
  return split;
}

async function renderLyricsContent(entry) {
  const font = settings.lyricsFont || 'inherit';
  const size = settings.lyricsSize || 13;
  dom.lyricsSourceBar.style.display = '';
  if (dom.lyricsSourceSelect.dataset.silent !== '1') {
    const opts = Array.from(dom.lyricsSourceSelect.options);
    const idx = opts.findIndex(o => o.value === String(entry._idx));
    if (idx !== -1) dom.lyricsSourceSelect.selectedIndex = idx;
  }
  _syncedLines = null; _activeLrcLineIdx = -1;
  _lastLyricsEntry = entry;

  const renderToken = ++_lyricsRenderToken;
  const useSync = settings.syncedLyrics !== false && !!entry.synced;

  let html;
  if (useSync) {
    _syncedLines = parseLRC(entry.synced);
    let texts = _syncedLines.map(l => l.text);
    if (_romanizeActive) {
      texts = await romanizeLines(texts);
      if (renderToken !== _lyricsRenderToken) return;
    }
    html = _syncedLines.map((l, i) =>
      `<span class="lrc-line" data-i="${i}">${escapeLyricsHTML(texts[i]) || '&nbsp;'}</span>`
    ).join('');
  } else {
    let text = entry.lyrics || '';
    if (_romanizeActive) {
      text = await romanizeText(text);
      if (renderToken !== _lyricsRenderToken) return;
    }
    html = escapeLyricsHTML(text);
  }
  dom.lyricsBody.innerHTML = `<div class="lyrics-text" style="font-size:${size}px;font-family:${font}">${html}</div>`;
}

function renderLyrics(result) {
  if (!result || !result.found) return;

  if (result.multiple && result.results && result.results.length > 1 && dom.lyricsSourceSelect) {
    dom.lyricsSourceSelect.innerHTML = '';
    result.results.forEach((r, idx) => {
      r._idx = idx;
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = r.source || r.label || (window.i18n && window.i18n.T ? window.i18n.T(`Resultado ${idx + 1}`) : `Resultado ${idx + 1}`);
      opt.title = r.label || r.source || '';
      dom.lyricsSourceSelect.appendChild(opt);
    });
    dom.lyricsSourceSelect.style.display = '';
    dom.lyricsSourceSelect.onchange = () => {
      const idx = parseInt(dom.lyricsSourceSelect.value, 10);
      const chosen = result.results[idx];
      if (chosen) {
        dom.lyricsSourceSelect.dataset.silent = '1';
        renderLyricsContent(chosen).finally(() => { dom.lyricsSourceSelect.dataset.silent = '0'; });
      }
    };
  } else if (dom.lyricsSourceSelect) {
    dom.lyricsSourceSelect.innerHTML = '';
    dom.lyricsSourceSelect.onchange = null;
    const first0 = (result.results && result.results[0]) || result;
    const opt = document.createElement('option');
    opt.value = '0';
    first0._idx = 0;
    opt.textContent = first0.source || '—';
    dom.lyricsSourceSelect.appendChild(opt);
  }

  const first = (result.results && result.results[0]) || result;
  renderLyricsContent(first);
}

let _lrcSpansCache = null, _lrcSpansCont = null, _lrcPrevIdx = -1;
function _getLrcSpans() {
  const cont = dom.lyricsBody.querySelector('.lyrics-text');
  if (!cont) { _lrcSpansCache = null; _lrcSpansCont = null; return null; }
  if (_lrcSpansCont !== cont || !_lrcSpansCache) {
    _lrcSpansCont = cont;
    _lrcSpansCache = Array.from(cont.querySelectorAll('.lrc-line'));
    _lrcPrevIdx = -1;
  }
  return _lrcSpansCache;
}

audioPlayer.addEventListener('timeupdate', () => {
  if (!_syncedLines || !_syncedLines.length) return;
  const t = audioPlayer.currentTime + _lrcOffsetSec;
  let idx = -1;
  for (let i = 0; i < _syncedLines.length; i++) {
    if (_syncedLines[i].t <= t) idx = i; else break;
  }
  if (idx !== _activeLrcLineIdx) {
    _activeLrcLineIdx = idx;
    const spans = _getLrcSpans();
    if (!spans) return;
    const prev = _lrcPrevIdx;
    const from = prev < 0 ? 0 : Math.min(prev, idx < 0 ? 0 : idx);
    const to   = Math.max(prev, idx);
    for (let i = Math.max(0, from - 1); i <= Math.min(spans.length - 1, to + 1); i++) {
      const s = spans[i];
      s.classList.toggle('active', i === idx);
      s.classList.toggle('passed', i < idx);
    }
    _lrcPrevIdx = idx;
    const active = spans[idx];
    if (active) {
      const r = active.getBoundingClientRect();
      const pr = dom.lyricsBody.getBoundingClientRect();
      if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
        active.scrollIntoView({ behavior:'smooth', block:'center' });
      }
    }
  }
});

let _vizCtx = null, _vizAnalyser = null, _vizSource = null, _vizData = null, _vizRaf = null;

let _normGain = null;

function initVisualizer() {
  if (_vizCtx) return;
  try {
    _vizCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Un contexto creado durante un play() programático puede nacer suspended
    if (_vizCtx.state === 'suspended') _vizCtx.resume().catch(() => {});
    _vizSource = _vizCtx.createMediaElementSource(audioPlayer);
    _vizAnalyser = _vizCtx.createAnalyser();
    _vizAnalyser.fftSize = 1024;
    _normGain = _vizCtx.createGain();
    _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
    _vizSource.connect(_vizAnalyser);
    _vizAnalyser.connect(_normGain);
    _normGain.connect(_vizCtx.destination);
    _vizData = new Uint8Array(_vizAnalyser.frequencyBinCount);
    _vizStart();

    _vizCtx.addEventListener('statechange', () => {
      if (_vizCtx.state === 'suspended' && !audioPlayer.paused) {
        _vizCtx.resume().catch(() => {});
      }
    });
  } catch (e) { console.warn('viz init', e); }
}

function applyVizSettings() {
  if (!dom2.vizCanvas) return;
  if (_normGain) _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
  _syncVizPanelControls();
}

let _vizIdleTimer = null, _vizCanvasCtx = null, _vizLastFilter = null, _vizSettled = false;
let _vizFadeGrad = null, _vizFadeH = -1;

function _vizStart() {
  if (_vizRaf != null || _vizIdleTimer != null) return;
  _vizRaf = requestAnimationFrame(drawViz);
}

function _vizStop() {
  if (_vizRaf != null) { cancelAnimationFrame(_vizRaf); _vizRaf = null; }
  if (_vizIdleTimer != null) { clearTimeout(_vizIdleTimer); _vizIdleTimer = null; }
}

function _vizScheduleNext(active) {
  _vizRaf = null;
  if (active) {
    _vizRaf = requestAnimationFrame(drawViz);
  } else if (_vizIdleTimer == null) {
    _vizIdleTimer = setTimeout(() => { _vizIdleTimer = null; _vizRaf = requestAnimationFrame(drawViz); }, 300);
  }
}

function drawViz() {
  _vizRaf = null;
  if (!_vizAnalyser || !dom2.vizCanvas || settings.vizEnabled === false) { _vizStop(); return; }
  const cvs = dom2.vizCanvas;
  // Ventana oculta o vista del visualizador cerrada: no dibujar nada.
  // El bucle se reactiva desde los listeners de play/visibilitychange y al abrir la vista.
  if (document.hidden || cvs.offsetParent === null) { _vizSettled = false; _vizStop(); return; }
  const w = cvs.clientWidth || window.innerWidth;
  const h = cvs.clientHeight || 220;
  const dpr = window.devicePixelRatio || 1;
  if (cvs.width !== Math.round(w * dpr)) cvs.width = Math.round(w * dpr);
  if (cvs.height !== Math.round(h * dpr)) cvs.height = Math.round(h * dpr);
  if (!_vizCanvasCtx || _vizCanvasCtx.canvas !== cvs) _vizCanvasCtx = cvs.getContext('2d');
  const ctx = _vizCanvasCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0,w,h);
  _vizAnalyser.getByteFrequencyData(_vizData);
  const color = settings.vizColor || '#ffffff';
  const sens  = settings.vizSensitivity || 1.5;
  const style = settings.vizStyle || 'bars';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const filterVal = settings.vizShadow ? `drop-shadow(0 0 6px ${color})` : 'none';
  if (filterVal !== _vizLastFilter) { cvs.style.filter = filterVal; _vizLastFilter = filterVal; }

  const n = _vizData.length;
  const useBins = Math.floor(n * 0.6);
  if (style === 'bars' || style === 'mirror') {
    const barW = w / useBins;
    for (let i = 0; i < useBins; i++) {
      const v = (_vizData[i] / 255) * sens;
      const bh = Math.min(h, v * h);
      if (style === 'mirror') {
        ctx.fillRect(i * barW, (h - bh)/2, Math.max(1, barW - 1), bh);
      } else {
        ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
      }
    }
  } else if (style === 'wave' || style === 'line') {
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < useBins; i++) {
      const x = (i / useBins) * w;
      const v = (_vizData[i] / 255) * sens;
      const y = h - v * h * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (style === 'wave') { ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = .35; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.stroke();
  } else if (style === 'dots') {
    for (let i = 0; i < useBins; i++) {
      const x = (i / useBins) * w;
      const v = (_vizData[i] / 255) * sens;
      const r = Math.max(1, v * 6);
      ctx.beginPath();
      ctx.arc(x, h - v * h * 0.8, r, 0, Math.PI*2);
      ctx.fill();
    }
  } else if (style === 'circle') {
    const cx = w / 2, cy = h / 2;
    const baseR = Math.min(w, h) * 0.22;
    ctx.lineWidth = 2;
    for (let i = 0; i < useBins; i++) {
      const angle = (i / useBins) * Math.PI * 2 - Math.PI / 2;
      const v = (_vizData[i] / 255) * sens;
      const r = baseR + v * baseR * 1.2;
      const x1 = cx + Math.cos(angle) * baseR;
      const y1 = cy + Math.sin(angle) * baseR;
      const x2 = cx + Math.cos(angle) * r;
      const y2 = cy + Math.sin(angle) * r;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.shadowBlur = 0;
  if (style !== 'circle') {
    const fadeH = Math.round(h * 0.35);
    // Gradiente cacheado: recrearlo cada frame a 60fps era Basura innecesaria
    if (_vizFadeH !== fadeH || !_vizFadeGrad) {
      _vizFadeGrad = ctx.createLinearGradient(0, 0, 0, fadeH);
      _vizFadeGrad.addColorStop(0, 'rgba(0,0,0,1)');
      _vizFadeGrad.addColorStop(1, 'rgba(0,0,0,0)');
      _vizFadeH = fadeH;
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = _vizFadeGrad;
    ctx.fillRect(0, 0, w, fadeH);
    ctx.globalCompositeOperation = 'source-over';
  }

  const isPlaying = !audioPlayer.paused;
  if (dom2.vizIdleHint) dom2.vizIdleHint.classList.toggle('hidden', isPlaying);

  if (isPlaying) {
    _vizSettled = false;
    _vizScheduleNext(true);
  } else {
    let peak = 0;
    for (let i = 0; i < n; i++) { if (_vizData[i] !== 0) { peak = _vizData[i]; break; } }
    if (peak === 0) {
      if (_vizSettled) { _vizStop(); return; }
      _vizSettled = true;
      _vizScheduleNext(true);
    } else {
      _vizSettled = false;
      _vizScheduleNext(true);
    }
  }
}

audioPlayer.addEventListener('play', () => {
  initVisualizer();
  if (_vizCtx?.state === 'suspended') _vizCtx.resume();
  _vizSettled = false;
  _vizStart();
  _startVizWatchdog();
});
audioPlayer.addEventListener('pause', () => {
  _vizSettled = false;
  _vizStart();
  _stopVizWatchdog();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { _vizSettled = false; _vizStart(); }
});
applyVizSettings();

let _vizWatchdogTimer = null;
function _startVizWatchdog() {
  if (_vizWatchdogTimer != null) return;
  _vizWatchdogTimer = setInterval(() => {
    if (!_vizCtx || audioPlayer.paused) return;
    if (_vizCtx.state === 'suspended') _vizCtx.resume().catch(() => {});
  }, 500);
}
function _stopVizWatchdog() {
  if (_vizWatchdogTimer == null) return;
  clearInterval(_vizWatchdogTimer);
  _vizWatchdogTimer = null;
}
window.addEventListener('beforeunload', () => {
  _stopVizWatchdog();
  _vizStop();
});

if (dom2.vizCanvas && settings.vizOpacity != null) {
  dom2.vizCanvas.style.opacity = settings.vizOpacity / 100;
}

function _syncVizPanelControls() {
  const s = settings;
  if (dom2.vizSdEnabled) dom2.vizSdEnabled.checked = s.vizEnabled !== false;
  if (dom2.vizSdColor)   dom2.vizSdColor.value = s.vizColor || '#ffffff';
  if (dom2.vizSdShadow)  dom2.vizSdShadow.checked = s.vizShadow !== false;
  if (dom2.vizSdSensitivity) {
    dom2.vizSdSensitivity.value = s.vizSensitivity || 1.5;
    if (dom2.vizSdSensitivityVal) dom2.vizSdSensitivityVal.textContent = (s.vizSensitivity || 1.5) + '×';
  }
  const op = s.vizOpacity != null ? s.vizOpacity : 90;
  if (dom2.vizSdOpacity) {
    dom2.vizSdOpacity.value = op;
    if (dom2.vizSdOpacityVal) dom2.vizSdOpacityVal.textContent = op + '%';
  }
  document.querySelectorAll('.viz-style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vizStyle === (s.vizStyle || 'bars'));
  });
  const accentVal = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  document.querySelectorAll('.viz-qc').forEach(btn => {
    if (btn.classList.contains('viz-qc--accent')) btn.style.background = accentVal;
    const vc = btn.dataset.vc === 'accent' ? accentVal : btn.dataset.vc;
    btn.classList.toggle('active', vc === (s.vizColor || '#ffffff'));
  });
  if (dom2.settingVizEnabled) dom2.settingVizEnabled.checked = s.vizEnabled !== false;
  if (dom2.settingVizStyle)   dom2.settingVizStyle.value = s.vizStyle || 'bars';
  if (dom2.settingVizColor)   dom2.settingVizColor.value = s.vizColor || '#ffffff';
  if (dom2.settingVizShadow)  dom2.settingVizShadow.checked = s.vizShadow !== false;
  if (dom2.settingVizSensitivity) {
    dom2.settingVizSensitivity.value = s.vizSensitivity || 1.5;
    if (dom2.settingVizSensitivityVal) dom2.settingVizSensitivityVal.textContent = (s.vizSensitivity || 1.5) + '×';
  }
}

function _updateVizTrackInfo() {
  if (!dom2.vizView) return;
  const t = currentIndex >= 0 ? queue[currentIndex] : null;
  if (dom2.vizTrackTitle)  dom2.vizTrackTitle.textContent  = t ? (t.title  || '—') : '—';
  if (dom2.vizTrackArtist) dom2.vizTrackArtist.textContent = t ? (t.artist || '—') : '—';
  if (dom2.vizTrackArt) {
    // Las pistas guardan la portada en cover/thumbnail (no existe .art)
    const artSrc = t ? (t.cover || t.thumbnail || '') : '';
    dom2.vizTrackArt.style.backgroundImage = artSrc ? `url("${artSrc.replace(/"/g, '')}")` : '';
  }
  dom2.vizView.classList.toggle('playing', !audioPlayer.paused);
}

function _openVizView() {
  if (!dom2.vizView) return;
  dom2.vizView.classList.add('active');
  if (dom2.btnViz) dom2.btnViz.classList.add('viz-active');
  _syncVizPanelControls();
  _updateVizTrackInfo();
  if (!_vizCtx) initVisualizer();
  else if (_vizCtx.state === 'suspended') _vizCtx.resume();
  _vizSettled = false;
  _vizStart();
}

function _closeVizView() {
  if (!dom2.vizView) return;
  dom2.vizView.classList.remove('active');
  if (dom2.btnViz) dom2.btnViz.classList.remove('viz-active');
  if (dom2.vizSettingsDrawer) dom2.vizSettingsDrawer.classList.remove('open');
  if (dom2.vizSettingsBtn) dom2.vizSettingsBtn.classList.remove('active');
}

if (dom2.btnViz) {
  dom2.btnViz.addEventListener('click', () => {
    dom2.vizView?.classList.contains('active') ? _closeVizView() : _openVizView();
  });
}

if (dom2.vizSettingsBtn) {
  dom2.vizSettingsBtn.addEventListener('click', () => {
    const open = dom2.vizSettingsDrawer?.classList.toggle('open');
    dom2.vizSettingsBtn.classList.toggle('active', !!open);
  });
}
if (dom2.vizSdClose) {
  dom2.vizSdClose.addEventListener('click', () => {
    dom2.vizSettingsDrawer?.classList.remove('open');
    dom2.vizSettingsBtn?.classList.remove('active');
  });
}

if (dom2.vizSdEnabled) {
  dom2.vizSdEnabled.addEventListener('change', () => {
    settings.vizEnabled = dom2.vizSdEnabled.checked;
    saveSettings(); _syncVizPanelControls();
    // drawViz ya no se auto-reprograma cuando está deshabilitado: relanzar al activarlo
    // (drawViz decidirá por sí mismo si debe parar tras asentarse)
    _vizSettled = false;
    _vizStart();
  });
}
if (dom2.vizSdColor) {
  dom2.vizSdColor.addEventListener('input', () => {
    settings.vizColor = dom2.vizSdColor.value;
    saveSettingsSoon(); _syncVizPanelControls();
  });
}
document.querySelectorAll('.viz-qc').forEach(btn => {
  btn.addEventListener('click', () => {
    const accentVal = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const vc = btn.dataset.vc === 'accent' ? accentVal : btn.dataset.vc;
    settings.vizColor = vc;
    if (dom2.vizSdColor) dom2.vizSdColor.value = vc;
    saveSettings(); _syncVizPanelControls();
  });
});
document.querySelectorAll('.viz-style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.vizStyle = btn.dataset.vizStyle;
    saveSettings(); _syncVizPanelControls();
  });
});
if (dom2.vizSdShadow) {
  dom2.vizSdShadow.addEventListener('change', () => {
    settings.vizShadow = dom2.vizSdShadow.checked;
    saveSettings(); _syncVizPanelControls();
  });
}
if (dom2.vizSdSensitivity) {
  dom2.vizSdSensitivity.addEventListener('input', () => {
    settings.vizSensitivity = parseFloat(dom2.vizSdSensitivity.value);
    if (dom2.vizSdSensitivityVal) dom2.vizSdSensitivityVal.textContent = settings.vizSensitivity + '×';
    saveSettingsSoon();
  });
}
if (dom2.vizSdOpacity) {
  dom2.vizSdOpacity.addEventListener('input', () => {
    settings.vizOpacity = parseInt(dom2.vizSdOpacity.value);
    if (dom2.vizSdOpacityVal) dom2.vizSdOpacityVal.textContent = settings.vizOpacity + '%';
    if (dom2.vizCanvas) dom2.vizCanvas.style.opacity = settings.vizOpacity / 100;
    saveSettingsSoon();
  });
}

audioPlayer.addEventListener('play',  _updateVizTrackInfo);
audioPlayer.addEventListener('pause', _updateVizTrackInfo);
audioPlayer.addEventListener('ended', _updateVizTrackInfo);

const _origPlayTrack = playTrack;
playTrack = function(index) {
  const t = queue[index];
  if (t) { t.title = decodeEntities(t.title); t.artist = decodeEntities(t.artist); }
  _origPlayTrack(index);
  audioPlayer.volume = isMuted ? 0 : linearToAudioVolume(currentVolume);
};

const _volNumInput = document.getElementById('vol-number-input');
if (_volNumInput) {
  const _origSetVolume = setVolume;
  setVolume = function(v) {
    _origSetVolume(v);
    if (document.activeElement !== _volNumInput) _volNumInput.value = Math.round(v * 100);
  };
  _volNumInput.addEventListener('input', () => {
    let v = parseInt(_volNumInput.value);
    if (isNaN(v)) return;
    v = Math.max(0, Math.min(100, v));
    setVolume(v / 100);
  });
  _volNumInput.addEventListener('blur', () => {
    if (_volNumInput.value === '' || isNaN(parseInt(_volNumInput.value))) _volNumInput.value = Math.round(currentVolume*100);
  });
  _volNumInput.value = Math.round(currentVolume * 100);
}

(function setupThemePanel() {
  const panel    = document.getElementById('theme-panel');
  const overlay  = document.getElementById('theme-panel-overlay');
  const btnOpen  = document.getElementById('btn-theme');
  const btnClose = document.getElementById('theme-panel-close');
  if (!panel || !btnOpen) return;

  const PRESETS = {
    dark:     { '--bg':'#121212','--bg2':'#181818','--bg3':'#1f1f1f','--bg4':'#282828','--bar-bg':'#0a0a0a','--t1':'#ffffff','--t2':'#b3b3b3','--t3':'#6a6a6a','--accent':'#ffffff' },
    midnight: { '--bg':'#0d1117','--bg2':'#121822','--bg3':'#1a2230','--bg4':'#222d3e','--bar-bg':'#080c12','--t1':'#e6edf3','--t2':'#8b98a8','--t3':'#586675','--accent':'#5865f2' },
    amoled:   { '--bg':'#000000','--bg2':'#070707','--bg3':'#0f0f0f','--bg4':'#1a1a1a','--bar-bg':'#000000','--t1':'#ffffff','--t2':'#aaaaaa','--t3':'#5a5a5a','--accent':'#ffffff' },
    forest:   { '--bg':'#0d1f0d','--bg2':'#11271a','--bg3':'#163322','--bg4':'#1f4530','--bar-bg':'#081108','--t1':'#e8f5e8','--t2':'#9fc1a4','--t3':'#5a7a60','--accent':'#1db954' },
    ocean:    { '--bg':'#0a1628','--bg2':'#0e1d35','--bg3':'#142844','--bg4':'#1d3a5e','--bar-bg':'#060f1c','--t1':'#e1ecf8','--t2':'#8aa4c4','--t3':'#506580','--accent':'#06b6d4' },
    rose:     { '--bg':'#1a0d10','--bg2':'#241318','--bg3':'#321a22','--bg4':'#45242f','--bar-bg':'#0f0608','--t1':'#fce8ee','--t2':'#c499a6','--t3':'#7a5a64','--accent':'#ec4899' },
    light:    { '--bg':'#f5f5f5','--bg2':'#ffffff','--bg3':'#ececec','--bg4':'#dcdcdc','--bar-bg':'#ffffff','--t1':'#0a0a0a','--t2':'#4a4a4a','--t3':'#8a8a8a','--accent':'#1db954' },
    coffee:   { '--bg':'#1c1208','--bg2':'#26190d','--bg3':'#332213','--bg4':'#4a341d','--bar-bg':'#120a04','--t1':'#f5e9d8','--t2':'#bfa182','--t3':'#7a6450','--accent':'#f59e0b' },
  };

  const COLOR_VARS = ['--bg','--bg2','--bg3','--bg4','--bar-bg','--t1','--t2','--t3','--accent'];

  function toHex(v){
    if (!v) return '#000000';
    v = v.trim();
    if (v.startsWith('#')) {
      if (v.length === 4) return '#' + v.slice(1).split('').map(c=>c+c).join('');
      return v.slice(0,7);
    }
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map(s=>parseFloat(s));
      return '#' + p.slice(0,3).map(n=>Math.max(0,Math.min(255,n|0)).toString(16).padStart(2,'0')).join('');
    }
    return '#000000';
  }
  function currentVar(name){
    return (document.documentElement.style.getPropertyValue(name) ||
            getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();
  }
  let _saveThemeTimer = null;
  function setVar(name, val){
    document.documentElement.style.setProperty(name, val);
    if (!settings.theme) settings.theme = {};
    settings.theme[name] = val;
    if (name === '--accent') settings.accentColor = val;
    const input = panel.querySelector(`.tp-color-input[data-var="${name}"]`);
    if (input) input.value = toHex(val);
    const labelId = `tp-${name.replace('--','')}-val`;
    const lbl = document.getElementById(labelId);
    if (lbl) lbl.textContent = val;
    clearTimeout(_saveThemeTimer);
    _saveThemeTimer = setTimeout(() => saveSettings(), 400);
  }

  function syncControlsFromDOM(){
    COLOR_VARS.forEach(v => {
      const hex = toHex(currentVar(v));
      const input = panel.querySelector(`.tp-color-input[data-var="${v}"]`);
      if (input) input.value = hex;
      const lbl = document.getElementById(`tp-${v.replace('--','')}-val`);
      if (lbl) lbl.textContent = hex;
    });
    const th = settings.theme || {};
    if (radius) {
      const r8 = th['--r8'] || currentVar('--r8') || '8px';
      const rVal = parseInt(r8) || 8;
      radius.value = rVal;
      if (radiusVal) radiusVal.textContent = rVal + 'px';
    }
    if (bord) {
      const bv = th['--border'] || currentVar('--border') || 'rgba(255,255,255,0.07)';
      const match = bv.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
      const pct = match ? Math.round(parseFloat(match[1]) * 100) : 7;
      bord.value = pct;
      if (bordVal) bordVal.textContent = pct + '%';
    }
    const fontEl = document.getElementById('tp-font');
    if (fontEl) {
      const fv = th['--font'] || currentVar('--font') || '';
      if (fv) {
        document.documentElement.style.setProperty('--font', fv);
        document.body.style.fontFamily = fv;
      }
    }
    if (fsize) {
      const fsv = th['--base-font-size'] || null;
      if (fsv) {
        const n     = parseInt(fsv) || 14;
        const scale = (n / 14).toFixed(4);
        fsize.value = n;
        if (fsizeVal) fsizeVal.textContent = n + 'px';
        document.documentElement.style.setProperty('--font-scale', scale);
      }
    }
    if (bd) {
      const bdo = th['--backdrop-opacity'] || currentVar('--backdrop-opacity') || '0.7';
      const pct = Math.round(parseFloat(bdo) * 100) || 70;
      bd.value = pct;
      if (bdVal) bdVal.textContent = pct + '%';
    }
    if (gap) {
      const gv = th['--panel-gap'] || currentVar('--panel-gap') || '8px';
      const n = parseInt(gv) || 8;
      gap.value = n;
      if (gapVal) gapVal.textContent = n + 'px';
    }
    if (bh) {
      const bhv = th['--bar'] || currentVar('--bar') || '90px';
      const n = parseInt(bhv) || 90;
      bh.value = n;
      if (bhVal) bhVal.textContent = n + 'px';
    }
  }

  function openPanel(){
    syncControlsFromDOM();
    panel.classList.add('open');
    overlay.classList.add('active');
  }
  function closePanel(){
    panel.classList.remove('open');
    overlay.classList.remove('active');
    saveSettings();
  }
  btnOpen.addEventListener('click', openPanel);
  if (btnClose) btnClose.addEventListener('click', closePanel);
  if (overlay)  overlay.addEventListener('click', closePanel);

  panel.querySelectorAll('.tp-color-input').forEach(input => {
    input.addEventListener('input', () => setVar(input.dataset.var, input.value));
  });

  panel.querySelectorAll('.tp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      panel.querySelectorAll('.tp-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.entries(preset).forEach(([k,v]) => setVar(k, v));
      syncControlsFromDOM();
      saveSettings();
      showToast(`Tema "${btn.dataset.preset}" aplicado`);
    });
  });

  panel.querySelectorAll('.tp-accent-dot').forEach(dot => {
    dot.addEventListener('click', () => setVar('--accent', dot.dataset.accent));
  });

  const radius = document.getElementById('tp-radius');
  const radiusVal = document.getElementById('tp-radius-val');
  if (radius) {
    radius.addEventListener('input', () => {
      const v = radius.value + 'px';
      document.documentElement.style.setProperty('--r8',  v);
      document.documentElement.style.setProperty('--r12', (parseInt(radius.value)+4) + 'px');
      if (radiusVal) radiusVal.textContent = v;
      if (!settings.theme) settings.theme = {};
      settings.theme['--r8']  = v;
      settings.theme['--r12'] = (parseInt(radius.value)+4) + 'px';
    });
  }

  const bord = document.getElementById('tp-border-opacity');
  const bordVal = document.getElementById('tp-border-opacity-val');
  if (bord) {
    bord.addEventListener('input', () => {
      const v = `rgba(255,255,255,${(bord.value/100).toFixed(3)})`;
      document.documentElement.style.setProperty('--border', v);
      if (bordVal) bordVal.textContent = bord.value + '%';
      if (!settings.theme) settings.theme = {};
      settings.theme['--border'] = v;
    });
  }

  const font = document.getElementById('tp-font');

  const DEFAULT_FONTS = [
    { label: 'DM Sans (original)', value: "'DM Sans',-apple-system,sans-serif" },
    { label: 'Inter',              value: "'Inter',system-ui,sans-serif" },
    { label: 'Outfit',             value: "'Outfit',sans-serif" },
    { label: 'Nunito',             value: "'Nunito',sans-serif" },
    { label: 'Space Grotesk',      value: "'Space Grotesk',sans-serif" },
    { label: 'Syne',               value: "'Syne',sans-serif" },
    { label: 'JetBrains Mono',     value: "'JetBrains Mono',monospace" },
    { label: 'Sistema',            value: 'system-ui,sans-serif' },
  ];

  function applyFontValue(value) {
    document.documentElement.style.setProperty('--font', value);
    document.body.style.fontFamily = value;
    if (!settings.theme) settings.theme = {};
    settings.theme['--font'] = value;
  }

  if (font) {
    (async () => {
      let systemFonts = [];
      try {
        systemFonts = await window.nofuf.getSystemFonts();
      } catch (e) {
        console.warn('[fonts] No se pudieron leer fuentes del sistema:', e);
      }

      font.innerHTML = '';

      const grpApp = document.createElement('optgroup');
      grpApp.label = '── App ──';
      DEFAULT_FONTS.forEach(({ label, value }) => {
        const opt = document.createElement('option');
        opt.value = label;
        opt.dataset.family = value;
        opt.textContent = label;
        grpApp.appendChild(opt);
      });
      font.appendChild(grpApp);

      if (systemFonts.length) {
        const appNames = new Set(DEFAULT_FONTS.map(f => f.label.toLowerCase()));
        const filtered = systemFonts.filter(f => !appNames.has(f.toLowerCase()));

        if (filtered.length) {
          const grpSys = document.createElement('optgroup');
          grpSys.label = '── Sistema ──';
          filtered.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.dataset.family = `'${name}',sans-serif`;
            opt.textContent = name;
            grpSys.appendChild(opt);
          });
          font.appendChild(grpSys);
        }
      }

      const savedFont = settings.theme?.['--font'];
      if (savedFont) {
        const allOpts = Array.from(font.querySelectorAll('option'));
        const match = allOpts.find(o => o.dataset.family === savedFont || o.value === savedFont);
        if (match) {
          font.value = match.value;
        }
      }
    })();

    font.addEventListener('change', () => {
      const selected = font.options[font.selectedIndex];
      const cssFamily = selected?.dataset?.family || font.value;
      applyFontValue(cssFamily);
    });
  }

  const fsize = document.getElementById('tp-font-size');
  const fsizeVal = document.getElementById('tp-font-size-val');
  if (fsize) {
    fsize.addEventListener('input', () => {
      const px    = parseInt(fsize.value) || 14;
      const scale = (px / 14).toFixed(4);
      document.documentElement.style.setProperty('--font-scale', scale);
      if (fsizeVal) fsizeVal.textContent = px + 'px';
      if (!settings.theme) settings.theme = {};
      settings.theme['--base-font-size'] = px + 'px';
      clearTimeout(_saveThemeTimer);
      _saveThemeTimer = setTimeout(() => saveSettings(), 400);
    });
  }

  const lyricsFont = document.getElementById('tp-lyrics-font');

  function applyLyricsFontValue(value) {
    settings.lyricsFont = value;
    document.querySelectorAll('.lyrics-text').forEach(lt => {
      lt.style.fontFamily = value === 'inherit' ? '' : value;
    });
    saveSettings();
  }

  if (lyricsFont) {
    (async () => {
      let systemFonts = [];
      try {
        systemFonts = await window.nofuf.getSystemFonts();
      } catch(e) {
        console.warn('[fonts] No se pudieron leer fuentes del sistema:', e);
      }

      lyricsFont.innerHTML = '';

      const defOpt = document.createElement('option');
      defOpt.value = 'inherit';
      defOpt.dataset.family = 'inherit';
      defOpt.textContent = 'DM Sans (por defecto)';
      lyricsFont.appendChild(defOpt);

      const grpApp = document.createElement('optgroup');
      grpApp.label = '── App ──';
      DEFAULT_FONTS.forEach(({ label, value }) => {
        const opt = document.createElement('option');
        opt.value = label;
        opt.dataset.family = value;
        opt.textContent = label;
        grpApp.appendChild(opt);
      });
      lyricsFont.appendChild(grpApp);

      if (systemFonts.length) {
        const appNames = new Set(DEFAULT_FONTS.map(f => f.label.toLowerCase()));
        const filtered = systemFonts.filter(f => !appNames.has(f.toLowerCase()));
        if (filtered.length) {
          const grpSys = document.createElement('optgroup');
          grpSys.label = '── Sistema ──';
          filtered.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.dataset.family = `'${name}',sans-serif`;
            opt.textContent = name;
            grpSys.appendChild(opt);
          });
          lyricsFont.appendChild(grpSys);
        }
      }

      const savedLyricsFont = settings.lyricsFont || 'inherit';
      const allOpts = Array.from(lyricsFont.querySelectorAll('option'));
      const match = allOpts.find(o => o.dataset.family === savedLyricsFont || o.value === savedLyricsFont);
      if (match) lyricsFont.value = match.value;
    })();

    lyricsFont.addEventListener('change', () => {
      const selected = lyricsFont.options[lyricsFont.selectedIndex];
      const cssFamily = selected?.dataset?.family || lyricsFont.value;
      applyLyricsFontValue(cssFamily);
    });
  }

  const lyricsSize = document.getElementById('tp-lyrics-size');
  const lyricsSizeVal = document.getElementById('tp-lyrics-size-val');
  if (lyricsSize) {
    const savedSize = settings.lyricsSize || 13;
    lyricsSize.value = savedSize;
    if (lyricsSizeVal) lyricsSizeVal.textContent = savedSize + 'px';

    lyricsSize.addEventListener('input', () => {
      const px = parseInt(lyricsSize.value) || 13;
      if (lyricsSizeVal) lyricsSizeVal.textContent = px + 'px';
      settings.lyricsSize = px;
      document.documentElement.style.setProperty('--lyrics-font-size', px + 'px');
      document.querySelectorAll('.lyrics-text').forEach(lt => { lt.style.fontSize = px + 'px'; });
      clearTimeout(_saveThemeTimer);
      _saveThemeTimer = setTimeout(() => saveSettings(), 400);
    });
  }

  const bd = document.getElementById('tp-backdrop-opacity');
  const bdVal = document.getElementById('tp-backdrop-opacity-val');
  if (bd) bd.addEventListener('input', () => {
    const val = (bd.value / 100).toFixed(3);
    document.documentElement.style.setProperty('--backdrop-opacity', val);
    if (bdVal) bdVal.textContent = bd.value + '%';
    if (!settings.theme) settings.theme = {};
    settings.theme['--backdrop-opacity'] = val;
    clearTimeout(_saveThemeTimer);
    _saveThemeTimer = setTimeout(() => saveSettings(), 400);
  });
  const gap = document.getElementById('tp-panel-gap');
  const gapVal = document.getElementById('tp-panel-gap-val');
  if (gap) gap.addEventListener('input', () => {
    document.documentElement.style.setProperty('--panel-gap', gap.value + 'px');
    if (gapVal) gapVal.textContent = gap.value + 'px';
    if (!settings.theme) settings.theme = {};
    settings.theme['--panel-gap'] = gap.value + 'px';
    clearTimeout(_saveThemeTimer);
    _saveThemeTimer = setTimeout(() => saveSettings(), 400);
  });
  const bh = document.getElementById('tp-bar-height');
  const bhVal = document.getElementById('tp-bar-height-val');
  if (bh) bh.addEventListener('input', () => {
    document.documentElement.style.setProperty('--bar', bh.value + 'px');
    if (bhVal) bhVal.textContent = bh.value + 'px';
    if (!settings.theme) settings.theme = {};
    settings.theme['--bar'] = bh.value + 'px';
    clearTimeout(_saveThemeTimer);
    _saveThemeTimer = setTimeout(() => saveSettings(), 400);
  });

  const btnReset = document.getElementById('tp-reset-btn');
  if (btnReset) btnReset.addEventListener('click', () => {
    if (!confirm(window.i18n && window.i18n.T ? window.i18n.T('¿Restablecer todo el tema a los valores por defecto?') : '¿Restablecer todo el tema a los valores por defecto?')) return;
    [...COLOR_VARS, '--r8','--r12','--border','--font','--backdrop-opacity','--panel-gap','--bar',
     '--bg-panel-opacity','--app-panel-blur','--app-panel-brightness']
      .forEach(v => document.documentElement.style.removeProperty(v));
    document.documentElement.style.setProperty('--font-scale', '1');
    settings.theme = null;
    saveSettings();
    Object.entries(PRESETS.dark).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
    const _tlOp = document.getElementById('tp-translucent-opacity');
    const _tlOpV = document.getElementById('tp-translucent-opacity-val');
    const _tlBr = document.getElementById('tp-translucent-brightness');
    const _tlBrV = document.getElementById('tp-translucent-brightness-val');
    const _tlBl = document.getElementById('tp-translucent-blur');
    const _tlBlV = document.getElementById('tp-translucent-blur-val');
    if (_tlOp) { _tlOp.value = 75; if (_tlOpV) _tlOpV.textContent = '75%'; }
    if (_tlBr) { _tlBr.value = 100; if (_tlBrV) _tlBrV.textContent = '100%'; }
    if (_tlBl) { _tlBl.value = 12; if (_tlBlV) _tlBlV.textContent = '12px'; }
    syncControlsFromDOM();
    showToast('Tema restablecido');
  });

  const btnExp = document.getElementById('tp-export-btn');
  if (btnExp) btnExp.addEventListener('click', async () => {
    const data = JSON.stringify({ _meta:{app:'nofufaudio-theme'}, theme: settings.theme || {} }, null, 2);
    if (window.nofuf?.exportConfigFile) {
      const r = await window.nofuf.exportConfigFile('nofufaudio-theme.json', data);
      if (r?.ok) showToast('Tema exportado');
    } else {
      const blob = new Blob([data], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'nofufaudio-theme.json'; a.click();
    }
  });

  const btnImp  = document.getElementById('tp-import-btn');
  const fileImp = document.getElementById('tp-import-file');
  if (btnImp && fileImp) {
    btnImp.addEventListener('click', async () => {
      if (window.nofuf?.importConfigFile) {
        const f = await window.nofuf.importConfigFile();
        if (!f) return;
        try {
          const obj = JSON.parse(f.content);
          const theme = obj.theme || obj;
          settings.theme = _stripStrayFontScale(theme);
          applyTheme(theme);
          syncControlsFromDOM();
          saveSettings();
          showToast('Tema importado');
        } catch { showToast('Archivo inválido'); }
      } else {
        fileImp.click();
      }
    });
    fileImp.addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = ev => {
        try {
          const obj = JSON.parse(ev.target.result);
          const theme = obj.theme || obj;
          settings.theme = _stripStrayFontScale(theme);
          applyTheme(theme);
          syncControlsFromDOM();
          saveSettings();
          showToast('Tema importado');
        } catch { showToast('Archivo inválido'); }
      };
      r.readAsText(file);
    });
  }

  if (settings.theme) {
    applyTheme(settings.theme);
    syncControlsFromDOM();
  }

  const bgPickBtn    = document.getElementById('tp-bg-pick-btn');
  const bgInput      = document.getElementById('tp-bg-input');
  const bgPreview    = document.getElementById('tp-bg-image-preview');
  const bgImgTag     = document.getElementById('tp-bg-img-tag');
  const bgRemoveBtn  = document.getElementById('tp-bg-remove-btn');
  const bgOpacity    = document.getElementById('tp-bg-opacity');
  const bgOpacityVal = document.getElementById('tp-bg-opacity-val');
  const bgBlur       = document.getElementById('tp-bg-blur');
  const bgBlurVal    = document.getElementById('tp-bg-blur-val');
  const bgBright     = document.getElementById('tp-bg-brightness');
  const bgBrightVal  = document.getElementById('tp-bg-brightness-val');
  const bgFit        = document.getElementById('tp-bg-fit');
  const bgGray       = document.getElementById('tp-bg-grayscale');
  const bgGrayVal    = document.getElementById('tp-bg-grayscale-val');

  let bgEl = document.getElementById('app-bg-image');
  if (!bgEl) {
    bgEl = document.createElement('div');
    bgEl.id = 'app-bg-image';
    bgEl.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'background-repeat:no-repeat',
      'background-position:center center',
      'background-size:cover',
      'z-index:-1',
      'pointer-events:none',
      'display:none',
    ].join(';');
    document.body.prepend(bgEl);
  }

  let _currentBgDataUrl = null;

  function applyBgFilters() {
    const blur   = bgBlur   ? bgBlur.value   : 0;
    const bright = bgBright ? bgBright.value : 100;
    const gray   = bgGray   ? bgGray.value   : 0;
    const noop = Number(blur) === 0 && Number(bright) === 100 && Number(gray) === 0;
    bgEl.style.filter = noop ? '' : `blur(${blur}px) brightness(${bright}%) grayscale(${gray}%)`;
    const fit = bgFit ? bgFit.value : 'cover';
    const sizeMap = { cover: 'cover', contain: 'contain', fill: '100% 100%', none: 'auto' };
    bgEl.style.backgroundSize = sizeMap[fit] || 'cover';
  }

  function _syncVizBg(dataUrl, opts) {
    const vizBg = document.getElementById('viz-bg-layer');
    if (!vizBg) return;
    if (dataUrl) {
      vizBg.style.backgroundImage = `url("${dataUrl}")`;
      const fit = opts?.fit || 'cover';
      const sizeMap = { cover: 'cover', contain: 'contain', fill: '100% 100%', none: 'auto' };
      vizBg.style.backgroundSize = sizeMap[fit] || 'cover';
    } else {
      vizBg.style.backgroundImage = '';
    }
  }

  function applyBgImage(dataUrl, opts) {
    if (!dataUrl) return removeBgImage();
    _currentBgDataUrl = dataUrl;
    const opacity = opts?.opacity !== undefined ? opts.opacity : 60;
    bgEl.style.opacity = opacity / 100;
    bgEl.style.backgroundImage = `url("${dataUrl}")`;
    bgEl.style.display = 'block';
    document.body.classList.add('has-bg-image');
    if (bgImgTag) bgImgTag.src = dataUrl;
    if (bgPreview) bgPreview.style.display = 'block';
    if (bgPickBtn) bgPickBtn.style.display = 'none';
    applyBgFilters();
    _syncVizBg(dataUrl, opts);
    if (bgOpacity && opts?.opacity !== undefined) { bgOpacity.value = opts.opacity; if (bgOpacityVal) bgOpacityVal.textContent = opts.opacity + '%'; }
    if (bgBlur    && opts?.blur       !== undefined) { bgBlur.value    = opts.blur;       if (bgBlurVal)    bgBlurVal.textContent    = opts.blur       + 'px'; }
    if (bgBright  && opts?.brightness !== undefined) { bgBright.value  = opts.brightness; if (bgBrightVal)  bgBrightVal.textContent  = opts.brightness + '%'; }
    if (bgFit     && opts?.fit)  bgFit.value = opts.fit;
    if (bgGray    && opts?.grayscale  !== undefined) { bgGray.value    = opts.grayscale;  if (bgGrayVal)    bgGrayVal.textContent    = opts.grayscale  + '%'; }
  }

  function removeBgImage() {
    _currentBgDataUrl = null;
    bgEl.style.backgroundImage = '';
    bgEl.style.display = 'none';
    document.body.classList.remove('has-bg-image');
    _syncVizBg(null);
    if (bgImgTag) bgImgTag.src = '';
    if (bgPreview) bgPreview.style.display = 'none';
    if (bgPickBtn) bgPickBtn.style.display = '';
    if (!settings.theme) settings.theme = {};
    delete settings.theme['--bg-image'];
    delete settings.theme['--bg-opts'];
    saveSettings();
    try { if (window.nofuf?.configWrite) window.nofuf.configWrite('background.json', '{}'); } catch(e) {}
  }

  function getCurrentBgOpts() {
    return {
      opacity:    bgOpacity ? parseInt(bgOpacity.value)    : 60,
      blur:       bgBlur    ? parseInt(bgBlur.value)       : 0,
      brightness: bgBright  ? parseInt(bgBright.value)     : 100,
      fit:        bgFit     ? bgFit.value                  : 'cover',
      grayscale:  bgGray    ? parseInt(bgGray.value)       : 0,
    };
  }

  function saveBgToSettings(dataUrl) {
    const opts = getCurrentBgOpts();
    try { localStorage.setItem('nofuf_bg_opts', JSON.stringify(opts)); } catch(e) {}
    try {
      if (window.nofuf?.configWrite)
        window.nofuf.configWrite('background.json', JSON.stringify({ dataUrl, opts }, null, 2));
    } catch(e) {}
    if (!settings.theme) settings.theme = {};
    delete settings.theme['--bg-image'];
    delete settings.theme['--bg-opts'];
    settings.theme['--bg-opts-only'] = JSON.stringify(opts);
    saveSettings();
  }

  window._nofufApplyBg = function(dataUrl, opts) {
    if (opts && (!opts.opacity && !opts.blur && !opts.brightness)) {
      try {
        const cached = JSON.parse(localStorage.getItem('nofuf_bg_opts') || '{}');
        if (cached.opacity !== undefined) opts = { ...cached, ...opts };
      } catch(e) {}
    }
    applyBgImage(dataUrl, opts || {});
  };
  window._nofufSaveBg = function() {
    clearTimeout(_bgSaveTimer);
    _bgSaveTimer = null;
    if (_currentBgDataUrl) saveBgToSettings(_currentBgDataUrl);
  };

  if (window._nofufPendingBg) {
    const { dataUrl, opts } = window._nofufPendingBg;
    window._nofufPendingBg = null;
    let finalOpts = opts || {};
    try {
      const cached = JSON.parse(localStorage.getItem('nofuf_bg_opts') || '{}');
      if (cached.opacity !== undefined) finalOpts = { ...finalOpts, ...cached };
    } catch(e) {}
    applyBgImage(dataUrl, finalOpts);
  } else if (settings.theme && settings.theme['--bg-image']) {
    let opts = {};
    try { opts = JSON.parse(settings.theme['--bg-opts'] || '{}'); } catch {}
    applyBgImage(settings.theme['--bg-image'], opts);
    saveBgToSettings(settings.theme['--bg-image']);
  }

  if (bgPickBtn) bgPickBtn.addEventListener('click', () => bgInput && bgInput.click());
  if (bgInput) {
    bgInput.addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = ev => {
        const dataUrl = ev.target.result;
        applyBgImage(dataUrl, getCurrentBgOpts());
        saveBgToSettings(dataUrl);
        showToast('Fondo aplicado');
      };
      r.readAsDataURL(file);
      bgInput.value = '';
    });
  }
  if (bgRemoveBtn) bgRemoveBtn.addEventListener('click', () => { removeBgImage(); showToast('Fondo eliminado'); });

  let _bgSaveTimer = null;
  // Durante el drag de sliders solo persistir las opciones (pequeñas);
  // la imagen completa en base64 se escribe al cambiarla y en save-before-hide
  function _saveBgOptsOnly() {
    const opts = getCurrentBgOpts();
    try { localStorage.setItem('nofuf_bg_opts', JSON.stringify(opts)); } catch(e) {}
    if (!settings.theme) settings.theme = {};
    settings.theme['--bg-opts-only'] = JSON.stringify(opts);
    saveSettingsSoon();
  }
  function _saveBgDebounced() {
    clearTimeout(_bgSaveTimer);
    _bgSaveTimer = setTimeout(() => {
      _bgSaveTimer = null;
      if (_currentBgDataUrl) _saveBgOptsOnly();
    }, 300);
  }

  function liveUpdateBg() {
    if (!_currentBgDataUrl) return;
    const opts = getCurrentBgOpts();
    bgEl.style.opacity = opts.opacity / 100;
    applyBgFilters();
    _syncVizBg(_currentBgDataUrl, opts);
    _saveBgDebounced();
  }

  if (bgOpacity) bgOpacity.addEventListener('input', () => {
    if (bgOpacityVal) bgOpacityVal.textContent = bgOpacity.value + '%';
    liveUpdateBg();
  });
  if (bgBlur) bgBlur.addEventListener('input', () => {
    if (bgBlurVal) bgBlurVal.textContent = bgBlur.value + 'px';
    liveUpdateBg();
  });
  if (bgBright) bgBright.addEventListener('input', () => {
    if (bgBrightVal) bgBrightVal.textContent = bgBright.value + '%';
    liveUpdateBg();
  });
  if (bgFit) bgFit.addEventListener('change', () => liveUpdateBg());
  if (bgGray) bgGray.addEventListener('input', () => {
    if (bgGrayVal) bgGrayVal.textContent = bgGray.value + '%';
    liveUpdateBg();
  });

  const tlOpacity    = document.getElementById('tp-translucent-opacity');
  const tlOpacityVal = document.getElementById('tp-translucent-opacity-val');
  const tlBright     = document.getElementById('tp-translucent-brightness');
  const tlBrightVal  = document.getElementById('tp-translucent-brightness-val');
  const tlBlur       = document.getElementById('tp-translucent-blur');
  const tlBlurVal    = document.getElementById('tp-translucent-blur-val');

  function getTranslucentSettings() {
    const t = (settings.theme && settings.theme['--app-translucent-opts']) || null;
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  function saveTranslucentSettings() {
    if (!settings.theme) settings.theme = {};
    settings.theme['--app-translucent-opts'] = JSON.stringify({
      enabled:    true,
      opacity:    tlOpacity ? parseInt(tlOpacity.value)  : 75,
      brightness: tlBright  ? parseInt(tlBright.value)   : 100,
      blur:       tlBlur    ? parseInt(tlBlur.value)     : 12,
    });
    saveSettingsSoon();
  }

  function applyTranslucent() {
    const opacity    = tlOpacity ? tlOpacity.value    : 75;
    const brightness = tlBright  ? tlBright.value     : 100;
    const blur       = tlBlur    ? tlBlur.value       : 12;
    document.documentElement.style.setProperty('--bg-panel-opacity', opacity + '%');
    document.documentElement.style.setProperty('--app-panel-brightness', (brightness / 100));
    document.documentElement.style.setProperty('--app-panel-blur', blur + 'px');
    document.body.classList.add('app-translucent');
  }

  const savedTl = getTranslucentSettings();
  if (savedTl) {
    if (tlOpacity && savedTl.opacity    !== undefined) { tlOpacity.value = savedTl.opacity; if (tlOpacityVal) tlOpacityVal.textContent = savedTl.opacity + '%'; }
    if (tlBright  && savedTl.brightness !== undefined) { tlBright.value  = savedTl.brightness; if (tlBrightVal) tlBrightVal.textContent = savedTl.brightness + '%'; }
    if (tlBlur    && savedTl.blur       !== undefined) { tlBlur.value    = savedTl.blur; if (tlBlurVal) tlBlurVal.textContent = savedTl.blur + 'px'; }
  }
  applyTranslucent();

  if (tlOpacity) tlOpacity.addEventListener('input', () => {
    if (tlOpacityVal) tlOpacityVal.textContent = tlOpacity.value + '%';
    applyTranslucent(); saveTranslucentSettings();
  });
  if (tlBright) tlBright.addEventListener('input', () => {
    if (tlBrightVal) tlBrightVal.textContent = tlBright.value + '%';
    applyTranslucent(); saveTranslucentSettings();
  });
  if (tlBlur) tlBlur.addEventListener('input', () => {
    if (tlBlurVal) tlBlurVal.textContent = tlBlur.value + 'px';
    applyTranslucent(); saveTranslucentSettings();
  });
})();

const EQ_BANDS = [
  { freq: 32,    type: 'lowshelf',  label: '32' },
  { freq: 64,    type: 'peaking',   label: '64' },
  { freq: 125,   type: 'peaking',   label: '125' },
  { freq: 250,   type: 'peaking',   label: '250' },
  { freq: 500,   type: 'peaking',   label: '500' },
  { freq: 1000,  type: 'peaking',   label: '1K' },
  { freq: 2000,  type: 'peaking',   label: '2K' },
  { freq: 4000,  type: 'peaking',   label: '4K' },
  { freq: 8000,  type: 'peaking',   label: '8K' },
  { freq: 16000, type: 'highshelf', label: '16K' },
];

const EQ_PRESETS = {
  flat:       [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
  bass:       [8,  7,  5,  2,  0,  0,  0,  0,  0,  0],
  treble:     [0,  0,  0,  0,  0,  0,  2,  4,  6,  8],
  vocal:      [-2, -2, 0,  3,  5,  5,  4,  2, -1, -2],
  rock:       [5,  4,  2,  0, -1, -1,  0,  2,  4,  5],
  jazz:       [4,  2,  0,  2,  4,  4,  3,  2,  2,  3],
  electronic: [6,  5,  1,  0, -2,  0,  2,  4,  5,  6],
  classical:  [5,  3,  0, -2,  0,  0, -1,  2,  4,  5],
  pop:        [-1,  0,  2,  4,  4,  2,  0, -1, -1, -2],
};

const EQ_MAX_DB = 12;
const EQ_RANGE  = EQ_MAX_DB * 2;

let _eqEnabled   = true;
let _eqFilters   = [];
let _eqGains     = new Array(EQ_BANDS.length).fill(0);
let _eqPanelOpen = false;
let _eqActivePreset = 'flat';
let _eqAudioCtxReady = false;

function _eqBuildChain() {
  if (!_vizCtx || _eqAudioCtxReady) return;
  try {
    try { _vizSource.disconnect(); }   catch(e) {}
    try { _vizAnalyser.disconnect(); } catch(e) {}
    try { if (_normGain) _normGain.disconnect(); } catch(e) {}

    _eqFilters = EQ_BANDS.map((b, i) => {
      const f = _vizCtx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = 1.0;
      f.gain.value = _eqEnabled ? _eqGains[i] : 0;
      return f;
    });

    _vizSource.connect(_eqFilters[0]);
    for (let i = 0; i < _eqFilters.length - 1; i++) {
      _eqFilters[i].connect(_eqFilters[i + 1]);
    }
    _eqFilters[_eqFilters.length - 1].connect(_vizAnalyser);
    _vizAnalyser.connect(_normGain || _vizCtx.destination);
    if (_normGain) _normGain.connect(_vizCtx.destination);

    _eqAudioCtxReady = true;
    console.log('[EQ] Cadena de filtros construida correctamente');
  } catch (e) {
    console.warn('[EQ] Error construyendo cadena:', e);
  }
}

const _origInitVisualizer = initVisualizer;
initVisualizer = function() {
  _origInitVisualizer();
  _eqBuildChain();
};

function _eqApplyGains() {
  _eqFilters.forEach((f, i) => {
    f.gain.setTargetAtTime(_eqEnabled ? _eqGains[i] : 0, _vizCtx ? _vizCtx.currentTime : 0, 0.01);
  });
}

function _eqBuildUI() {
  const container = document.getElementById('eq-bands-container');
  if (!container) return;
  container.innerHTML = '';

  EQ_BANDS.forEach((band, idx) => {
    const bandEl = document.createElement('div');
    bandEl.className = 'eq-band';
    bandEl.dataset.idx = idx;

    bandEl.innerHTML = `
      <div class="eq-band-db" id="eq-db-${idx}">0.0 dB</div>
      <div class="eq-slider-wrap" id="eq-wrap-${idx}">
        <div class="eq-slider-track" id="eq-track-${idx}">
          <div class="eq-slider-fill-pos" id="eq-fill-pos-${idx}"></div>
          <div class="eq-slider-fill-neg" id="eq-fill-neg-${idx}"></div>
          <div class="eq-slider-thumb" id="eq-thumb-${idx}"></div>
        </div>
      </div>
      <div class="eq-band-freq">${band.label}</div>
    `;

    container.appendChild(bandEl);
    _eqSetupBandDrag(bandEl, idx);
  });

  _eqUpdateAllUI();
}

function _eqUpdateBandUI(idx) {
  const gain = _eqGains[idx];
  const pct  = (gain + EQ_MAX_DB) / EQ_RANGE;
  const track = document.getElementById('eq-track-' + idx);
  if (!track) return;
  const h = track.getBoundingClientRect().height || 120;

  const thumbTop = (1 - pct) * h;
  const thumb = document.getElementById('eq-thumb-' + idx);
  const fillPos = document.getElementById('eq-fill-pos-' + idx);
  const fillNeg = document.getElementById('eq-fill-neg-' + idx);
  const dbLabel = document.getElementById('eq-db-' + idx);

  if (thumb) thumb.style.top = `${thumbTop - 7}px`;

  if (gain >= 0) {
    const posH = (gain / EQ_MAX_DB) * (h / 2);
    if (fillPos) { fillPos.style.height = posH + 'px'; }
    if (fillNeg) { fillNeg.style.height = '0px'; }
  } else {
    const negH = (Math.abs(gain) / EQ_MAX_DB) * (h / 2);
    if (fillNeg) { fillNeg.style.height = negH + 'px'; }
    if (fillPos) { fillPos.style.height = '0px'; }
  }

  if (dbLabel) dbLabel.textContent = (gain >= 0 ? '+' : '') + gain.toFixed(1) + ' dB';
}

function _eqUpdateAllUI() {
  EQ_BANDS.forEach((_, i) => _eqUpdateBandUI(i));
}

function _eqSetupBandDrag(bandEl, idx) {
  const wrap = bandEl.querySelector('.eq-slider-wrap');
  let dragging = false;

  function gainFromY(clientY) {
    const track = document.getElementById('eq-track-' + idx);
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const gain = EQ_MAX_DB - pct * EQ_RANGE;
    return Math.round(gain * 2) / 2;
  }

  function onMove(e) {
    if (!dragging) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    _eqGains[idx] = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, gainFromY(clientY)));
    _eqUpdateBandUI(idx);
    if (_eqAudioCtxReady) {
      _eqFilters[idx].gain.setTargetAtTime(_eqEnabled ? _eqGains[idx] : 0, _vizCtx.currentTime, 0.005);
    }
    const gainDisplay = document.getElementById('eq-gain-display');
    if (gainDisplay) gainDisplay.textContent = (_eqGains[idx] >= 0 ? '+' : '') + _eqGains[idx].toFixed(1) + ' dB';
    _eqActivePreset = null;
    document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    bandEl.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
    _eqSaveToSettings();
  }

  wrap.addEventListener('mousedown', e => {
    dragging = true;
    bandEl.classList.add('dragging');
    onMove(e);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    e.preventDefault();
  });
  wrap.addEventListener('touchstart', e => {
    dragging = true;
    bandEl.classList.add('dragging');
    onMove(e);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
    e.preventDefault();
  }, { passive: false });

  wrap.addEventListener('dblclick', () => {
    _eqGains[idx] = 0;
    _eqUpdateBandUI(idx);
    if (_eqAudioCtxReady) _eqFilters[idx].gain.setTargetAtTime(0, _vizCtx.currentTime, 0.01);
    _eqCheckFlat();
    _eqSaveToSettings();
    const gainDisplay = document.getElementById('eq-gain-display');
    if (gainDisplay) gainDisplay.textContent = '0.0 dB';
  });
}

function _eqCheckFlat() {
  const isFlat = _eqGains.every(g => g === 0);
  if (isFlat) {
    _eqActivePreset = 'flat';
    document.querySelectorAll('.eq-preset-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === 'flat');
    });
  }
}

function _eqApplyPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  _eqGains = [...gains];
  _eqUpdateAllUI();
  _eqApplyGains();
  _eqActivePreset = name;
  document.querySelectorAll('.eq-preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === name);
  });
  _eqSaveToSettings();
}

function _eqReset() {
  _eqApplyPreset('flat');
  const gainDisplay = document.getElementById('eq-gain-display');
  if (gainDisplay) gainDisplay.textContent = '0.0 dB';
  showToast('Ecualizador restablecido');
}

function _eqSaveToSettings() {
  settings.eqEnabled = _eqEnabled;
  settings.eqGains   = [..._eqGains];
  settings.eqPreset  = _eqActivePreset;
  saveSettings();
}

function _eqLoadFromSettings() {
  if (settings.eqGains && Array.isArray(settings.eqGains) && settings.eqGains.length === EQ_BANDS.length) {
    _eqGains = [...settings.eqGains];
  }
  if (typeof settings.eqEnabled !== 'undefined') {
    _eqEnabled = !!settings.eqEnabled;
  }
  if (settings.eqPreset) _eqActivePreset = settings.eqPreset;
}

function _eqUserPresetsGet() {
  if (!settings.eqUserPresets || typeof settings.eqUserPresets !== 'object') settings.eqUserPresets = {};
  return settings.eqUserPresets;
}

function _eqUserPresetSave(name) {
  const presets = _eqUserPresetsGet();
  presets[name] = [..._eqGains];
  settings.eqUserPresets = presets;
  saveSettings();
  _eqRenderUserPresets();
  showToast(`Preset "${name}" guardado`);
}

function _eqUserPresetDelete(name) {
  const presets = _eqUserPresetsGet();
  delete presets[name];
  settings.eqUserPresets = presets;
  if (_eqActivePreset === 'user:' + name) _eqActivePreset = 'flat';
  saveSettings();
  _eqRenderUserPresets();
  showToast(`Preset "${name}" eliminado`);
}

function _eqUserPresetApply(name) {
  const presets = _eqUserPresetsGet();
  const gains = presets[name];
  if (!gains || gains.length !== EQ_BANDS.length) return;
  _eqGains = [...gains];
  _eqActivePreset = 'user:' + name;
  _eqApplyGains();
  _eqUpdateAllUI();
  document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
  _eqRenderUserPresets();
  _eqSaveToSettings();
}

function _eqRenderUserPresets() {
  const list = document.getElementById('eq-user-presets-list');
  if (!list) return;
  list.innerHTML = '';
  const presets = _eqUserPresetsGet();
  const names = Object.keys(presets);
  if (names.length === 0) {
    list.innerHTML = '<span style="font-size:10px;color:var(--t3,#888);font-style:italic;">Sin presets guardados</span>';
    return;
  }
  names.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'eq-user-preset-chip' + (_eqActivePreset === 'user:' + name ? ' active' : '');
    chip.title = `Aplicar preset "${name}"`;
    const label = document.createElement('span');
    label.textContent = name;
    label.style.cursor = 'pointer';
    label.addEventListener('click', () => _eqUserPresetApply(name));
    const del = document.createElement('button');
    del.className = 'eq-chip-del';
    del.innerHTML = '×';
    del.title = `Eliminar preset "${name}"`;
    del.addEventListener('click', (e) => { e.stopPropagation(); _eqUserPresetDelete(name); });
    chip.appendChild(label);
    chip.appendChild(del);
    list.appendChild(chip);
  });
}

function _eqShowSavePresetModal() {
  const modal = document.getElementById('eq-preset-name-modal');
  const input = document.getElementById('eq-preset-name-input');
  if (!modal || !input) return;
  input.value = '';
  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

function _eqHideSavePresetModal() {
  const modal = document.getElementById('eq-preset-name-modal');
  if (modal) modal.style.display = 'none';
}

function _eqConfirmSavePreset() {
  const input = document.getElementById('eq-preset-name-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  _eqHideSavePresetModal();
  _eqUserPresetSave(name);
}

function _eqWireUserPresetUI() {
  const saveBtn = document.getElementById('eq-save-preset-btn');
  const confirmBtn = document.getElementById('eq-preset-name-confirm');
  const cancelBtn  = document.getElementById('eq-preset-name-cancel');
  const input      = document.getElementById('eq-preset-name-input');
  if (saveBtn)    saveBtn.addEventListener('click', _eqShowSavePresetModal);
  if (confirmBtn) confirmBtn.addEventListener('click', _eqConfirmSavePreset);
  if (cancelBtn)  cancelBtn.addEventListener('click', _eqHideSavePresetModal);
  if (input)      input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _eqConfirmSavePreset();
    if (e.key === 'Escape') _eqHideSavePresetModal();
  });
  _eqRenderUserPresets();
}

function _eqUpdateSlidersFromGains() {
  const container = document.getElementById('eq-bands-container');
  if (!container) return;
  container.querySelectorAll('.eq-band').forEach((band, i) => {
    const slider = band.querySelector('.eq-slider');
    const label  = band.querySelector('.eq-gain-val');
    if (slider) slider.value = String(-_eqGains[i]);
    if (label)  label.textContent = (_eqGains[i] >= 0 ? '+' : '') + _eqGains[i].toFixed(1);
  });
}

function _eqOpenPanel() {
  _eqPanelOpen = true;
  const panel = document.getElementById('eq-panel');
  const overlay = document.getElementById('eq-panel-overlay');
  const btnEq = document.getElementById('btn-eq');
  if (panel)   { panel.classList.add('open'); if (!_eqEnabled) panel.classList.add('eq-disabled'); }
  if (overlay) overlay.classList.add('active');
  if (btnEq)   btnEq.classList.add('active');
  if (_vizCtx && !_eqAudioCtxReady) _eqBuildChain();
}
function _eqClosePanel() {
  _eqPanelOpen = false;
  const panel = document.getElementById('eq-panel');
  const overlay = document.getElementById('eq-panel-overlay');
  const btnEq = document.getElementById('btn-eq');
  if (panel)   panel.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
  if (btnEq)   btnEq.classList.remove('active');
}

(function initEQ() {
  _eqLoadFromSettings();

  _eqBuildUI();

  const enableChk = document.getElementById('eq-enabled');
  if (enableChk) {
    enableChk.checked = _eqEnabled;
    enableChk.addEventListener('change', () => {
      _eqEnabled = enableChk.checked;
      const panel = document.getElementById('eq-panel');
      if (panel) panel.classList.toggle('eq-disabled', !_eqEnabled);
      _eqApplyGains();
      _eqSaveToSettings();
      showToast(_eqEnabled ? 'Ecualizador activado' : 'Ecualizador desactivado');
    });
  }

  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === _eqActivePreset);
    btn.addEventListener('click', () => _eqApplyPreset(btn.dataset.preset));
  });

  const resetBtn = document.getElementById('eq-reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', _eqReset);

  const btnEq = document.getElementById('btn-eq');
  if (btnEq) {
    btnEq.addEventListener('click', () => {
      if (_eqPanelOpen) _eqClosePanel();
      else _eqOpenPanel();
    });
  }

  const closeBtn = document.getElementById('eq-close');
  if (closeBtn) closeBtn.addEventListener('click', _eqClosePanel);

  const overlay = document.getElementById('eq-panel-overlay');
  if (overlay) overlay.addEventListener('click', _eqClosePanel);

  document.querySelectorAll('.eq-preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === _eqActivePreset);
  });

  _eqWireUserPresetUI();
})();
(function initYouTubeSearch() {
  const input   = dom.ytSearchInput;
  const clearBtn= dom.ytSearchClear;
  const panel   = dom.ytSearchPanel;
  const overlay = dom.ytSearchOverlay;
  const list    = dom.ytResultsList;
  const placeholder = dom.ytSearchPlaceholder;
  const closeBtn = dom.ytPanelClose;

  let searchTimeout = null;
  let lastQuery = '';

  function openPanel() {
    if (window.closeArtistPage) window.closeArtistPage();
    panel.classList.add('open');
    overlay.classList.add('active');
  }

  function closePanel() {
    panel.classList.remove('open');
    overlay.classList.remove('active');
  }

  function showLoading() {
    placeholder.style.display = 'none';
    list.innerHTML = `<div class="yt-search-loading"><div class="spinner"></div><span>Buscando en YouTube…</span></div>`;
  }

  function showError(msg) {
    placeholder.style.display = 'none';
    list.innerHTML = `<div class="yt-search-error">⚠ ${msg}</div>`;
  }

  function showPlaceholder() {
    placeholder.style.display = '';
    list.innerHTML = '';
  }

  function showResults(results) {
    placeholder.style.display = 'none';
    const fsQueryEl = document.getElementById('yt-fs-query-text');
    const fsCountEl = document.getElementById('yt-fs-count');
    if (fsQueryEl) fsQueryEl.textContent = input.value.trim() || '—';
    if (!results.length) {
      if (fsCountEl) fsCountEl.textContent = '';
      list.innerHTML = `<div class="yt-search-error">No se encontraron resultados.</div>`;
      return;
    }
    if (fsCountEl) fsCountEl.textContent = `${results.length} resultado${results.length !== 1 ? 's' : ''}`;
    list.innerHTML = results.map((r, i) => {
      const safeTitle = r.title.replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const safeUploader = (r.uploader||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const thumbHtml = r.thumbnail
        ? `<img class="yt-result-thumb" src="${escapeHTML(r.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="yt-result-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
      const favId = 'yt-' + r.id;
      const isFav = favorites.includes(favId);
      const favTitle = (window.i18n && window.i18n.t) ? window.i18n.t(isFav ? 'ctx.removeFavorite' : 'ctx.addFavorite') : 'Añadir a favoritos';
      return `<div class="yt-result-item" data-id="${r.id}" data-title="${safeTitle}" data-uploader="${safeUploader}">
        <span class="yt-result-index">${i + 1}</span>
        ${thumbHtml}
        <div class="yt-result-meta">
          <div class="yt-result-title">${safeTitle}</div>
          <div class="yt-result-sub">
            <span>${safeUploader}</span>
            ${r.duration !== '—' ? `<span>·</span><span>${r.duration}</span>` : ''}
          </div>
        </div>
        <div class="yt-result-actions">
          <button class="yt-result-fav-btn${isFav ? ' is-fav' : ''}" data-action="favorite" title="${favTitle}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button class="yt-result-pl-btn" data-action="add-playlist" title="Añadir a playlist">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M22 2v6M19 5h6" stroke-width="2.4"/></svg>
          </button>
          <button class="yt-result-add-btn" data-action="queue" title="Añadir a cola">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="sp-result-dl-btn" data-action="download" title="Descargar MP3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="yt-result-play-btn" data-action="play" title="Reproducir ahora">
            <svg width="11" height="11" viewBox="0 0 18 18" fill="none"><path d="M4 3l12 6-12 6V3z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.yt-result-item').forEach(item => {
      const id = item.dataset.id;
      const title = item.dataset.title;
      const uploader = item.dataset.uploader;

      item.querySelector('[data-action="play"]').addEventListener('click', (e) => {
        e.stopPropagation();
        resolveAndPlay(id, title, uploader, true);
      });
      item.querySelector('[data-action="queue"]').addEventListener('click', (e) => {
        e.stopPropagation();
        resolveAndPlay(id, title, uploader, false);
      });
      item.querySelector('[data-action="download"]').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadTrack(buildLazyYtTrack(id, title, uploader));
      });
      item.querySelector('[data-action="favorite"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const track = buildLazyYtTrack(id, title, uploader);
        toggleFavorite(track);
        btn.classList.toggle('is-fav', favorites.includes(track.id));
      });
      item.querySelector('[data-action="add-playlist"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const track = buildLazyYtTrack(id, title, uploader);
        openYtAddPlaylistPopover(btn, track);
      });
      item.addEventListener('click', () => resolveAndPlay(id, title, uploader, true));
    });
  }

  function buildLazyYtTrack(videoId, fallbackTitle, fallbackArtist) {
    return {
      id:        'yt-' + videoId,
      type:      'youtube',
      videoId:   videoId,
      title:     fallbackTitle,
      artist:    fallbackArtist,
      duration:  0,
      cover:     null,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url:       '',
      ytUrl:     `https://www.youtube.com/watch?v=${videoId}`,
      lazy:      true,
    };
  }

  const ytPlPopover = document.getElementById('yt-add-playlist-popover');
  const ytPlPopoverOpts = document.getElementById('yt-add-playlist-options');
  function closeYtAddPlaylistPopover() { ytPlPopover.classList.remove('open'); }
  function openYtAddPlaylistPopover(anchorEl, track) {    ytPlPopoverOpts.innerHTML = '';
    if (!playlists.length) {
      ytPlPopoverOpts.innerHTML = `<div class="ctx-menu-empty">No tienes playlists todavía</div>`;
    } else {
      playlists.forEach(pl => {
        const btn = document.createElement('div');
        btn.className = 'ctx-playlist-item';
        const thumbHtml = pl.cover
          ? `<div class="ctx-pl-thumb"><img src="${pl.cover}"></div>`
          : `<div class="ctx-pl-thumb"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/></svg></div>`;
        btn.innerHTML = `${thumbHtml}<span>${escapeHTML(pl.name)}</span>`;
        btn.addEventListener('click', () => {
          addTrackToPlaylist(pl.id, track);
          closeYtAddPlaylistPopover();
        });
        ytPlPopoverOpts.appendChild(btn);
      });
    }

    const r = anchorEl.getBoundingClientRect();
    ytPlPopover.style.left = '0px';
    ytPlPopover.style.top = '0px';
    ytPlPopover.classList.add('open');
    requestAnimationFrame(() => {
      const menuRect = ytPlPopover.getBoundingClientRect();
      let x = Math.min(r.left, window.innerWidth - menuRect.width - 6);
      let y = r.bottom + 6;
      const playerBar = document.querySelector('.player-bar');
      const playerTop = playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight;
      if (y + menuRect.height > playerTop - 6) y = Math.max(0, r.top - menuRect.height - 6);
      ytPlPopover.style.left = Math.max(0, x) + 'px';
      ytPlPopover.style.top = y + 'px';
    });
  }
  window.openYtAddPlaylistPopover = openYtAddPlaylistPopover;
  document.addEventListener('click', e => {
    if (ytPlPopover.classList.contains('open') && !ytPlPopover.contains(e.target) && !e.target.closest('[data-action="add-playlist"]')) {
      closeYtAddPlaylistPopover();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ytPlPopover.classList.contains('open')) closeYtAddPlaylistPopover();
  });

  async function resolveAndPlay(videoId, fallbackTitle, fallbackArtist, playNow) {
    showToast(playNow ? `Cargando "${fallbackTitle}"…` : `Añadiendo a cola…`);
    try {
      const result = await window.nofuf.resolveYouTube(`https://www.youtube.com/watch?v=${videoId}`);
      if (result.type === 'error') { showToast('⚠ ' + result.message); return; }
      const track = {
        id: 'yt-' + videoId + '-' + Date.now(),
        type: 'youtube',
        videoId: result.videoId,
        title: result.title || fallbackTitle,
        artist: result.artist || fallbackArtist,
        duration: 0,
        cover: result.thumbnail || '',
        url: result.streamUrl,
        ytUrl: `https://www.youtube.com/watch?v=${videoId}`,
      };
      if (playNow) {
        queue.unshift(track);
        currentIndex = 0;
        updateQueueUI();
        playTrack(0);
      } else {
        queue.push(track);
        updateQueueUI();
        showToast(`✓ Añadido: ${track.title}`);
      }
      closePanel();
    } catch (err) {
      showToast('⚠ Error al cargar el vídeo');
    }
  }

  async function doSearch(q) {
    if (!q || q === lastQuery) return;
    lastQuery = q;
    showLoading();
    openPanel();
    let result;
    try {
      result = await window.nofuf.searchYouTube(q);
    } catch (e) {
      result = { type: 'error', message: (e && e.message) || 'Error de búsqueda.' };
    }
    if (q !== lastQuery) return;
    if (result.type === 'error') { showError(result.message); return; }
    showResults(result.results || []);
  }

  input.addEventListener('focus', () => {
    if (searchMode !== 'yt') return;
    if (input.value.trim()) openPanel();
  });

  input.addEventListener('input', () => {
    if (searchMode !== 'yt') return;
    const val = input.value.trim();
    clearBtn.classList.toggle('visible', val.length > 0);
    if (!val) { showPlaceholder(); lastQuery = ''; return; }
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => doSearch(val), 500);
    openPanel();
  });

  input.addEventListener('keydown', e => {
    if (searchMode !== 'yt') return;
    if (e.key === 'Enter') {
      clearTimeout(searchTimeout);
      const val = input.value.trim();
      if (val) doSearch(val);
    }
    if (e.key === 'Escape') closePanel();
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('visible');
    showPlaceholder();
    lastQuery = '';
    closePanel();
    const spPanelEl = document.getElementById('sp-search-panel');
    if (spPanelEl) spPanelEl.classList.remove('open');
    overlay.classList.remove('active');
    input.focus();
  });

  closeBtn.addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);
})();

(function initSearchMode() {
  const toggleBtn     = document.getElementById('search-mode-toggle');
  const iconYt        = document.getElementById('search-icon-yt');
  const iconSp        = document.getElementById('search-icon-sp');
  const searchInput   = document.getElementById('yt-search-input');
  const clearBtn      = document.getElementById('yt-search-clear');
  const ytPanel       = document.getElementById('yt-search-panel');
  const spPanel       = document.getElementById('sp-search-panel');
  const spClose       = document.getElementById('sp-search-panel-close');
  const spList        = document.getElementById('sp-results-list');
  const spPlaceholder = document.getElementById('sp-search-placeholder');
  const overlay       = document.getElementById('yt-search-overlay');

  let spLastQuery    = '';
  let spSearchTimer  = null;

  function setMode(m) {
    searchMode = m;
    if (m === 'sp') {
      toggleBtn.classList.add('sp-mode');
      iconYt.style.display = 'none';
      iconSp.style.display = '';
      searchInput.placeholder = window.i18n && window.i18n.t ? window.i18n.t('tbar.searchSpotify') : 'Buscar en Spotify…';
      ytPanel.classList.remove('open');
    } else {
      toggleBtn.classList.remove('sp-mode');
      iconYt.style.display = '';
      iconSp.style.display = 'none';
      searchInput.placeholder = window.i18n && window.i18n.t ? window.i18n.t('tbar.searchYoutube') : 'Buscar en YouTube…';
      closeSpPanel();
    }
  }

  toggleBtn.addEventListener('click', () => {
    const newMode = searchMode === 'yt' ? 'sp' : 'yt';
    setMode(newMode);
    searchInput.focus();
    const val = searchInput.value.trim();
    clearBtn.classList.toggle('visible', val.length > 0);
    if (val && newMode === 'sp') {
      spLastQuery = '';
      doSpSearch(val);
    }
  });

  function openSpPanel() {
    if (window.closeArtistPage) window.closeArtistPage();
    ytPanel.classList.remove('open');
    spPanel.classList.add('open');
    overlay.classList.add('active');
  }

  function closeSpPanel() {
    spPanel.classList.remove('open');
    if (!ytPanel.classList.contains('open')) {
      overlay.classList.remove('active');
    }
  }

  function spShowLoading() {
    spPlaceholder.style.display = 'none';
    spList.innerHTML = `<div class="yt-search-loading"><div class="spinner" style="border-top-color:#1db954"></div><span>Buscando en Spotify…</span></div>`;
  }

  function spShowError(msg) {
    spPlaceholder.style.display = 'none';
    spList.innerHTML = `<div class="yt-search-error">⚠ ${msg}</div>`;
  }

  function spShowPlaceholder() {
    spList.innerHTML = '';
    spPlaceholder.style.display = '';
  }

  function spFormatDur(secs) {
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function spShowResults(tracks) {
    spPlaceholder.style.display = 'none';
    const fsQueryEl = document.getElementById('sp-fs-query-text');
    const fsCountEl = document.getElementById('sp-fs-count');
    if (fsQueryEl) fsQueryEl.textContent = searchInput.value.trim() || '—';
    if (!tracks.length) {
      if (fsCountEl) fsCountEl.textContent = '';
      spList.innerHTML = `<div class="yt-search-error">No se encontraron resultados en Spotify.</div>`;
      return;
    }
    if (fsCountEl) fsCountEl.textContent = `${tracks.length} resultado${tracks.length !== 1 ? 's' : ''}`;

    spList.innerHTML = tracks.map((t, i) => {
      const safeTitle  = (t.title  || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const safeArtist = (t.artist || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const safeAlbum  = (t.album  || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const durStr = t.duration ? spFormatDur(t.duration) : '';
      const coverHtml = t.cover
        ? `<img class="sp-result-cover" src="${t.cover}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<div class=sp-result-cover-placeholder><svg width=18 height=18 viewBox=\\'0 0 24 24\\' fill=\\'#1db954\\'><path d=\\'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0z\\'/></svg></div>'">`
        : `<div class="sp-result-cover-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="#1db954" opacity=".5"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg></div>`;

      const spFavId = 'sp-' + t.id;
      const spIsFav = favorites.includes(spFavId);
      const spFavTitle = (window.i18n && window.i18n.t) ? window.i18n.t(spIsFav ? 'ctx.removeFavorite' : 'ctx.addFavorite') : 'Añadir a favoritos';
      return `<div class="sp-result-item" data-idx="${i}">
        <span class="yt-result-index">${i + 1}</span>
        ${coverHtml}
        <div class="sp-result-meta">
          <div class="sp-result-title">${safeTitle}</div>
          <div class="sp-result-sub">
            ${t.explicit ? '<span class="sp-explicit-badge">E</span>' : ''}
            <span>${safeArtist}</span>
            ${safeAlbum ? `<span>·</span><span class="sp-album-name">${safeAlbum}</span>` : ''}
          </div>
        </div>
        ${durStr ? `<div class="sp-duration">${durStr}</div>` : ''}
        <div class="sp-result-actions">
          <button class="yt-result-fav-btn${spIsFav ? ' is-fav' : ''}" data-action="favorite" title="${spFavTitle}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button class="yt-result-pl-btn" data-action="add-playlist" title="Añadir a playlist">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M22 2v6M19 5h6" stroke-width="2.4"/></svg>
          </button>
          <button class="sp-result-add-btn" data-action="queue" title="Añadir a cola">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="sp-result-dl-btn" data-action="download" title="Descargar MP3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="sp-result-play-btn" data-action="play" title="Reproducir ahora">
            <svg width="11" height="11" viewBox="0 0 18 18" fill="none"><path d="M4 3l12 6-12 6V3z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    spList.querySelectorAll('.sp-result-item').forEach(item => {
      const idx   = parseInt(item.dataset.idx, 10);
      const track = tracks[idx];
      if (!track) return;

      item.querySelector('[data-action="play"]').addEventListener('click', e => {
        e.stopPropagation();
        spResolveAndAct(item, track, 'play');
      });
      item.querySelector('[data-action="queue"]').addEventListener('click', e => {
        e.stopPropagation();
        spResolveAndAct(item, track, 'queue');
      });
      item.querySelector('[data-action="download"]').addEventListener('click', e => {
        e.stopPropagation();
        spResolveAndAct(item, track, 'download');
      });
      item.querySelector('[data-action="favorite"]').addEventListener('click', e => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const favTrack = buildLazySpTrack(track);
        toggleFavorite(favTrack);
        btn.classList.toggle('is-fav', favorites.includes(favTrack.id));
      });
      item.querySelector('[data-action="add-playlist"]').addEventListener('click', e => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const favTrack = buildLazySpTrack(track);
        window.openYtAddPlaylistPopover(btn, favTrack);
      });
      item.addEventListener('click', () => spResolveAndAct(item, track, 'play'));
    });
  }

  function buildLazySpTrack(spTrack) {
    return {
      id:       'sp-' + spTrack.id,
      type:     'youtube',
      title:    spTrack.title,
      artist:   spTrack.artist,
      album:    spTrack.album || '',
      duration: spTrack.duration || 0,
      cover:    spTrack.cover || null,
      url:      '',
      ytUrl:    '',
      videoId:  '',
      lazy:     true,
      spMeta:   { title: spTrack.title, artist: spTrack.artist },
    };
  }

  async function spResolveAndAct(itemEl, spTrack, action) {
    if (itemEl.classList.contains('sp-matching')) return;
    itemEl.classList.add('sp-matching');

    try {
      const firstArtist = (spTrack.artist || '').split(',')[0].trim();
      const ytQuery = `${firstArtist} ${spTrack.title} official audio`;
      showToast(`🔍 Buscando "${spTrack.title}"…`);

      const searchRes = await window.nofuf.searchYouTube(ytQuery);
      if (!searchRes || searchRes.type === 'error') {
        showToast('⚠ ' + (searchRes?.message || 'Error buscando en YouTube'));
        itemEl.classList.remove('sp-matching');
        return;
      }

      const ytResults = searchRes.results || [];
      if (!ytResults.length) {
        showToast('⚠ No se encontró en YouTube');
        itemEl.classList.remove('sp-matching');
        return;
      }

      const titleLow   = spTrack.title.toLowerCase();
      const cleanTitleLow = spTrack.title.replace(/\s*[\(\[](feat\.|ft\.|with\s|prod\.|remix|version|remastered|explicit)[^\)\]]*[\)\]]/gi, '').trim().toLowerCase();
      const artistLow  = firstArtist.toLowerCase();
      const allArtistsLow = (spTrack.artist || '').toLowerCase();
      let best = ytResults[0];
      let bestScore = -Infinity;
      for (const r of ytResults) {
        const t = (r.title    || '').toLowerCase();
        const u = (r.uploader || '').toLowerCase();
        let score = 0;

        if (t.includes(cleanTitleLow))       score += 4;
        else if (t.includes(titleLow))       score += 3;
        if (t.includes(artistLow) || u.includes(artistLow)) score += 3;
        allArtistsLow.split(/[,&\/]/).forEach(a => {
          const aClean = a.trim();
          if (aClean && (t.includes(aClean) || u.includes(aClean))) score += 1;
        });
        if (t.includes('cover')    && !titleLow.includes('cover'))   score -= 3;
        if (t.includes('karaoke'))                                    score -= 5;
        if (t.includes('tutorial'))                                   score -= 5;
        if (t.includes('reaction'))                                   score -= 5;
        if (t.includes('live')     && !titleLow.includes('live'))     score -= 1;
        if (t.includes('remix')    && !titleLow.includes('remix'))    score -= 2;
        if (u.includes('vevo') || u.includes('oficial') || u.includes('official')) score += 2;
        if (u.includes(artistLow))                                    score += 2;

        if (score > bestScore) { bestScore = score; best = r; }
      }

      const ytUrl = `https://www.youtube.com/watch?v=${best.id}`;

      if (action === 'download') {
        itemEl.classList.remove('sp-matching');
        const outDir = await window.nofuf.downloadDefaultFolder();
        const dlId   = 'sp-dl-' + Date.now();
        showToast(`⬇ Descargando "${spTrack.title}"…`);

        const removeListener = window.nofuf.onDownloadProgress(data => {
          if (data.id !== dlId) return;
          if (data.status === 'done') {
            showToast(`✓ Descargado: ${spTrack.title}`);
            removeListener();
          } else if (data.status === 'error') {
            showToast(`⚠ Error al descargar: ${data.error || 'desconocido'}`);
            removeListener();
          }
        });

        try {
          await window.nofuf.downloadYouTube({
            id:      dlId,
            videoId: best.id,
            ytUrl,
            title:   spTrack.title,
            artist:  spTrack.artist,
            outDir,
            format:  'mp3',
          template: settings.downloadTemplate || '{artist} - {title}',
          });
        } catch (err) {
          removeListener();
          showToast(`⚠ Error al descargar: ${err?.message || 'desconocido'}`);
        }
        closeSpPanel();
        return;
      }

      const resolved = await window.nofuf.resolveYouTube(ytUrl);
      itemEl.classList.remove('sp-matching');

      if (!resolved || resolved.type === 'error') {
        showToast('⚠ ' + (resolved?.message || 'No se pudo obtener audio'));
        return;
      }

      const newTrack = {
        id:      'sp-' + spTrack.id + '-' + Date.now(),
        type:    'youtube',
        videoId: resolved.videoId,
        title:   spTrack.title,
        artist:  spTrack.artist,
        duration: 0,
        cover:   spTrack.cover || resolved.thumbnail || '',
        url:     resolved.streamUrl,
        ytUrl,
      };

      if (action === 'play') {
        queue.unshift(newTrack);
        currentIndex = 0;
        updateQueueUI();
        playTrack(0);
      } else {
        queue.push(newTrack);
        updateQueueUI();
        showToast(`✓ Añadido: ${newTrack.title}`);
      }
      closeSpPanel();

    } catch (err) {
      console.error('[sp-resolve]', err);
      showToast('⚠ Error: ' + (err.message || String(err)));
      itemEl.classList.remove('sp-matching');
    }
  }

  async function doSpSearch(q) {
    q = q.trim();
    if (!q) return;
    if (q === spLastQuery) { openSpPanel(); return; }
    spLastQuery = q;
    spShowLoading();
    openSpPanel();

    let result;
    try {
      result = await window.nofuf.searchSpotify(q);
    } catch(e) {
      result = { type: 'error', message: e.message };
    }

    if (q !== spLastQuery) return;

    if (!result || result.type === 'error') {
      spShowError(result?.message || 'Error de conexión con Spotify');
      return;
    }
    spShowResults(result.results || []);
  }

  searchInput.addEventListener('input', () => {
    if (searchMode !== 'sp') return;
    const val = searchInput.value.trim();
    clearBtn.classList.toggle('visible', val.length > 0);
    if (!val) { spLastQuery = ''; spShowPlaceholder(); closeSpPanel(); return; }
    clearTimeout(spSearchTimer);
    spSearchTimer = setTimeout(() => doSpSearch(val), 450);
    openSpPanel();
  });

  searchInput.addEventListener('keydown', e => {
    if (searchMode !== 'sp') return;
    if (e.key === 'Enter') {
      clearTimeout(spSearchTimer);
      doSpSearch(searchInput.value);
    }
    if (e.key === 'Escape') closeSpPanel();
  });

  searchInput.addEventListener('focus', () => {
    if (searchMode === 'sp' && searchInput.value.trim() && spLastQuery) openSpPanel();
  });

  spClose.addEventListener('click', closeSpPanel);
  overlay.addEventListener('click', closeSpPanel);
})();

(function initArtistSearchAndPage() {
  const input       = document.getElementById('yt-search-input');
  const ytRow        = document.getElementById('yt-artist-row');
  const ytRowLabel   = document.getElementById('yt-artist-row-label');
  const spRow        = document.getElementById('sp-artist-row');
  const spRowLabel   = document.getElementById('sp-artist-row-label');

  const page         = document.getElementById('artist-page');
  const pageClose    = document.getElementById('artist-page-close');
  const pageHeaderName = document.getElementById('artist-page-header-name');
  const pageBanner   = document.getElementById('artist-page-banner');
  const pageName     = document.getElementById('artist-page-name');
  const pageFans     = document.getElementById('artist-page-fans');
  const pagePlayBtn  = document.getElementById('artist-page-play-btn');
  const pageTracklist= document.getElementById('artist-page-tracklist');
  const pageLoading  = document.getElementById('artist-page-loading');
  const pageEmpty    = document.getElementById('artist-page-empty');

  const singlesTitle = document.getElementById('artist-page-singles-title');
  const singlesShelf = document.getElementById('artist-page-singles-shelf');
  const epsTitle     = document.getElementById('artist-page-eps-title');
  const epsShelf     = document.getElementById('artist-page-eps-shelf');
  const albumsTitle  = document.getElementById('artist-page-albums-title');
  const albumsShelf  = document.getElementById('artist-page-albums-shelf');

  const albumPage        = document.getElementById('album-page');
  const albumPageClose   = document.getElementById('album-page-close');
  const albumPageHeaderName = document.getElementById('album-page-header-name');
  const albumPageArt     = document.getElementById('album-page-art');
  const albumPageType    = document.getElementById('album-page-type');
  const albumPageName    = document.getElementById('album-page-name');
  const albumPageCount   = document.getElementById('album-page-count');
  const albumPagePlayBtn = document.getElementById('album-page-play-btn');
  const albumPageAddBtn  = document.getElementById('album-page-add-btn');
  const albumPageTracklist = document.getElementById('album-page-tracklist');
  const albumPageLoading = document.getElementById('album-page-loading');
  const albumPageEmpty   = document.getElementById('album-page-empty');

  let currentAlbumId = null;
  let currentAlbumMeta = null;
  let currentAlbumTracks = [];
  let currentAlbumLoadToken = 0;

  let lastArtistQuery = '';
  let artistDebounce  = null;
  let currentArtistTracks = [];
  let currentArtistLoadToken = 0;

  function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function artistPicPlaceholderHTML() {
    return `<div class="search-artist-chip-pic-placeholder"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></div>`;
  }

  function formatFanCount(n) {
    n = Number(n) || 0;
    const s = window.i18n && window.i18n.t ? window.i18n.t('artist.fans') : 'seguidores';
    const langMap = {es:'es-ES',en:'en-US',pt:'pt-PT',fr:'fr-FR',de:'de-DE',it:'it-IT',ca:'ca-ES',gl:'gl-ES',eu:'eu-ES',ru:'ru-RU',ja:'ja-JP'};
    let locale = 'es-ES';
    try {
      const l = window.i18n && window.i18n.getLanguage ? window.i18n.getLanguage() : 'es';
      locale = langMap[l] || 'es-ES';
    } catch (_) {}
    return `${n.toLocaleString(locale)} ${s}`;
  }

  function renderArtistRow(container, label, artists) {
    if (!container) return;
    if (!artists || !artists.length) {
      container.innerHTML = '';
      if (label) label.style.display = 'none';
      return;
    }
    if (label) label.style.display = '';
    container.innerHTML = artists.map(a => {
      const safeName = esc(a.name);
      const pic = a.picture
        ? `<img class="search-artist-chip-pic" src="${a.picture}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'search-artist-chip-pic-placeholder',innerHTML:'<svg width=26 height=26 viewBox=\\'0 0 24 24\\' fill=none stroke=currentColor stroke-width=1.6><circle cx=12 cy=8 r=4/><path d=\\'M4 21c0-4 4-6 8-6s8 2 8 6\\'/></svg>'}))">`
        : artistPicPlaceholderHTML();
      return `<div class="search-artist-chip" data-id="${a.id}" data-name="${safeName}" data-pic="${a.picture || ''}">
        ${pic}
        <span class="search-artist-chip-name">${safeName}</span>
        <span class="search-artist-chip-tag" data-i18n="search.artistTag">Artista</span>
      </div>`;
    }).join('');
    container.querySelectorAll('.search-artist-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        openArtistPage(chip.dataset.id, chip.dataset.name, chip.dataset.pic);
      });
    });
  }

  async function doArtistSearch(q) {
    q = (q || '').trim();
    if (!q) {
      lastArtistQuery = '';
      renderArtistRow(ytRow, ytRowLabel, []);
      renderArtistRow(spRow, spRowLabel, []);
      return;
    }
    if (q === lastArtistQuery) return;
    lastArtistQuery = q;

    let result;
    try { result = await window.nofuf.searchSpotifyArtists(q); }
    catch (e) { console.error('[artist-search] searchSpotifyArtists lanzó una excepción:', e); result = { type: 'error', message: e.message }; }

    if (q !== lastArtistQuery) return;
    if (!result || result.type === 'error') {
      if (result?.type === 'error') console.error('[artist-search] Error del backend:', result.message);
      renderArtistRow(ytRow, ytRowLabel, []);
      renderArtistRow(spRow, spRowLabel, []);
      return;
    }
    const artists = result.results || [];
    renderArtistRow(ytRow, ytRowLabel, artists);
    renderArtistRow(spRow, spRowLabel, artists);
  }

  if (input) {
    input.addEventListener('input', () => {
      const val = input.value.trim();
      clearTimeout(artistDebounce);
      if (!val) { doArtistSearch(''); return; }
      artistDebounce = setTimeout(() => doArtistSearch(val), 450);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(artistDebounce); doArtistSearch(input.value); }
    });
  }

  function spFormatDur(secs) {
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function renderArtistTracklist(tracks) {
    currentArtistTracks = tracks;
    if (!tracks.length) {
      pageTracklist.innerHTML = '';
      pageEmpty.style.display = '';
      return;
    }
    pageEmpty.style.display = 'none';
    pageTracklist.innerHTML = tracks.map((t, i) => {
      const safeTitle  = esc(t.title);
      const safeArtist = esc(t.artist);
      const durStr = t.duration ? spFormatDur(t.duration) : '';
      const coverHtml = t.cover
        ? `<img class="sp-result-cover" src="${t.cover}" alt="" loading="lazy">`
        : `<div class="sp-result-cover-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="#1db954" opacity=".5"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0z"/></svg></div>`;
      return `<div class="sp-result-item" data-idx="${i}">
        <span class="yt-result-index">${i + 1}</span>
        ${coverHtml}
        <div class="sp-result-meta">
          <div class="sp-result-title">${safeTitle}</div>
          <div class="sp-result-sub">
            ${t.explicit ? '<span class="sp-explicit-badge">E</span>' : ''}
            <span>${safeArtist}</span>
          </div>
        </div>
        ${durStr ? `<div class="sp-duration">${durStr}</div>` : ''}
        <div class="sp-result-actions">
          <button class="sp-result-add-btn" data-action="queue" title="Añadir a cola">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="sp-result-dl-btn" data-action="download" title="Descargar MP3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="sp-result-play-btn" data-action="play" title="Reproducir ahora">
            <svg width="11" height="11" viewBox="0 0 18 18" fill="none"><path d="M4 3l12 6-12 6V3z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    pageTracklist.querySelectorAll('.sp-result-item').forEach(item => {
      const idx = parseInt(item.dataset.idx, 10);
      const track = currentArtistTracks[idx];
      if (!track) return;
      item.querySelector('[data-action="play"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'play');
      });
      item.querySelector('[data-action="queue"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'queue');
      });
      item.querySelector('[data-action="download"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'download');
      });
      item.addEventListener('click', () => resolveArtistTrackAndAct(item, track, 'play'));
    });
  }

  function renderAlbumTracklist(tracks) {
    currentAlbumTracks = tracks;
    if (!tracks.length) {
      albumPageTracklist.innerHTML = '';
      albumPageEmpty.style.display = '';
      return;
    }
    albumPageEmpty.style.display = 'none';
    albumPageTracklist.innerHTML = tracks.map((t, i) => {
      const safeTitle  = esc(t.title);
      const safeArtist = esc(t.artist);
      const durStr = t.duration ? spFormatDur(t.duration) : '';
      const coverHtml = t.cover
        ? `<img class="sp-result-cover" src="${t.cover}" alt="" loading="lazy">`
        : `<div class="sp-result-cover-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="#1db954" opacity=".5"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0z"/></svg></div>`;
      return `<div class="sp-result-item" data-idx="${i}">
        <span class="yt-result-index">${i + 1}</span>
        ${coverHtml}
        <div class="sp-result-meta">
          <div class="sp-result-title">${safeTitle}</div>
          <div class="sp-result-sub">
            ${t.explicit ? '<span class="sp-explicit-badge">E</span>' : ''}
            <span>${safeArtist}</span>
          </div>
        </div>
        ${durStr ? `<div class="sp-duration">${durStr}</div>` : ''}
        <div class="sp-result-actions">
          <button class="sp-result-add-btn" data-action="queue" title="Añadir a cola">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="sp-result-dl-btn" data-action="download" title="Descargar MP3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="sp-result-play-btn" data-action="play" title="Reproducir ahora">
            <svg width="11" height="11" viewBox="0 0 18 18" fill="none"><path d="M4 3l12 6-12 6V3z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    albumPageTracklist.querySelectorAll('.sp-result-item').forEach(item => {
      const idx = parseInt(item.dataset.idx, 10);
      const track = currentAlbumTracks[idx];
      if (!track) return;
      item.querySelector('[data-action="play"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'play');
      });
      item.querySelector('[data-action="queue"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'queue');
      });
      item.querySelector('[data-action="download"]').addEventListener('click', e => {
        e.stopPropagation();
        resolveArtistTrackAndAct(item, track, 'download');
      });
      item.addEventListener('click', () => resolveArtistTrackAndAct(item, track, 'play'));
    });
  }

  async function openAlbumPage(albumId, fallbackTitle, fallbackCover, typeLabel) {
    if (!albumId) return;
    const token = ++currentAlbumLoadToken;
    currentAlbumId = albumId;
    currentAlbumMeta = { title: fallbackTitle, cover: fallbackCover };

    albumPageHeaderName.textContent = fallbackTitle || '—';
    albumPageName.textContent = fallbackTitle || '—';
    albumPageType.textContent = typeLabel || (window.i18n && window.i18n.t ? window.i18n.t('artist.albumType') : 'Álbum');
    albumPageCount.textContent = '';
    albumPageArt.querySelectorAll('img').forEach(img => img.remove());
    if (fallbackCover) {
      const img = document.createElement('img');
      img.src = fallbackCover;
      albumPageArt.appendChild(img);
    }
    albumPageTracklist.innerHTML = '';
    albumPageEmpty.style.display = 'none';
    albumPageLoading.style.display = '';
    albumPageAddBtn.classList.remove('added');
    const existing = findExistingReleasePlaylist(albumId);
    if (existing) albumPageAddBtn.classList.add('added');
    albumPage.classList.add('open');

    let result;
    try { result = await window.nofuf.getSpotifyAlbum(albumId); }
    catch (e) { result = { type: 'error', message: e.message }; }

    if (token !== currentAlbumLoadToken) return;
    albumPageLoading.style.display = 'none';

    if (!result || result.type === 'error' || !result.tracks?.length) {
      albumPageEmpty.textContent = result?.message || (window.i18n && window.i18n.t ? window.i18n.t('artist.noTracks') : 'No se encontraron canciones.');
      albumPageEmpty.style.display = '';
      return;
    }

    const title = result.album?.title || fallbackTitle;
    const cover = result.album?.cover || fallbackCover || '';
    currentAlbumMeta = { title, cover };
    albumPageHeaderName.textContent = title;
    albumPageName.textContent = title;
    if (cover) {
      albumPageArt.querySelectorAll('img').forEach(img => img.remove());
      const img = document.createElement('img');
      img.src = cover;
      albumPageArt.appendChild(img);
    }
    const n = result.tracks.length;
    const countStr = `${n} cancion${n !== 1 ? 'es' : ''}`;
    albumPageCount.textContent = window.i18n && window.i18n.T ? window.i18n.T(countStr) : countStr;

    renderAlbumTracklist(result.tracks);
  }

  function closeAlbumPage() {
    albumPage.classList.remove('open');
    currentAlbumLoadToken++;
  }

  async function resolveArtistTrackAndAct(itemEl, spTrack, action) {
    if (itemEl.classList.contains('sp-matching')) return;
    itemEl.classList.add('sp-matching');
    try {
      const firstArtist = (spTrack.artist || '').split(',')[0].trim();
      const ytQuery = `${firstArtist} ${spTrack.title} official audio`;
      showToast(`🔍 Buscando "${spTrack.title}"…`);

      const searchRes = await window.nofuf.searchYouTube(ytQuery);
      if (!searchRes || searchRes.type === 'error') {
        showToast('⚠ ' + (searchRes?.message || 'Error buscando en YouTube'));
        itemEl.classList.remove('sp-matching');
        return;
      }
      const ytResults = searchRes.results || [];
      if (!ytResults.length) {
        showToast('⚠ No se encontró en YouTube');
        itemEl.classList.remove('sp-matching');
        return;
      }

      const titleLow = spTrack.title.toLowerCase();
      const artistLow = firstArtist.toLowerCase();
      let best = ytResults[0];
      let bestScore = -Infinity;
      for (const r of ytResults) {
        const t = (r.title    || '').toLowerCase();
        const u = (r.uploader || '').toLowerCase();
        let score = 0;
        if (t.includes(titleLow)) score += 4;
        if (t.includes(artistLow) || u.includes(artistLow)) score += 3;
        if (t.includes('cover') && !titleLow.includes('cover')) score -= 3;
        if (t.includes('karaoke')) score -= 5;
        if (t.includes('live') && !titleLow.includes('live')) score -= 1;
        if (u.includes('vevo') || u.includes('oficial') || u.includes('official')) score += 2;
        if (score > bestScore) { bestScore = score; best = r; }
      }

      const ytUrl = `https://www.youtube.com/watch?v=${best.id}`;

      if (action === 'download') {
        itemEl.classList.remove('sp-matching');
        const outDir = await window.nofuf.downloadDefaultFolder();
        const dlId = 'art-dl-' + Date.now();
        showToast(`⬇ Descargando "${spTrack.title}"…`);
        const removeListener = window.nofuf.onDownloadProgress(data => {
          if (data.id !== dlId) return;
          if (data.status === 'done') { showToast(`✓ Descargado: ${spTrack.title}`); removeListener(); }
          else if (data.status === 'error') { showToast(`⚠ Error al descargar: ${data.error || 'desconocido'}`); removeListener(); }
        });
        try {
          await window.nofuf.downloadYouTube({
            id: dlId, videoId: best.id, ytUrl,
            title: spTrack.title, artist: spTrack.artist, outDir, format: 'mp3',
          template: settings.downloadTemplate || '{artist} - {title}',
          });
        } catch (err) {
          removeListener();
          showToast(`⚠ Error al descargar: ${err?.message || 'desconocido'}`);
        }
        return;
      }

      const resolved = await window.nofuf.resolveYouTube(ytUrl);
      itemEl.classList.remove('sp-matching');
      if (!resolved || resolved.type === 'error') {
        showToast('⚠ ' + (resolved?.message || 'No se pudo obtener audio'));
        return;
      }
      const newTrack = {
        id: 'art-' + spTrack.id + '-' + Date.now(),
        type: 'youtube',
        videoId: resolved.videoId,
        title: spTrack.title,
        artist: spTrack.artist,
        duration: 0,
        cover: spTrack.cover || resolved.thumbnail || '',
        url: resolved.streamUrl,
        ytUrl,
      };
      if (action === 'play') {
        queue.unshift(newTrack);
        currentIndex = 0;
        updateQueueUI();
        playTrack(0);
      } else {
        queue.push(newTrack);
        updateQueueUI();
        showToast(`✓ Añadido: ${newTrack.title}`);
      }
    } catch (err) {
      console.error('[artist-resolve]', err);
      showToast('⚠ Error: ' + (err.message || String(err)));
      itemEl.classList.remove('sp-matching');
    }
  }

  const _addingReleaseIds = new Set();

  function renderReleaseShelf(shelfEl, titleEl, releases, typeLabel) {
    if (!shelfEl || !titleEl) return;
    if (!releases || !releases.length) {
      shelfEl.innerHTML = '';
      titleEl.style.display = 'none';
      return;
    }
    titleEl.style.display = '';
    shelfEl.innerHTML = releases.map(r => {
      const safeTitle = esc(r.title);
      const artHtml = r.cover
        ? `<img src="${r.cover}" alt="" loading="lazy">`
        : `<svg class="home-card-art-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13" stroke-linecap="round"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      return `<div class="home-card release-card" data-id="${r.id}" data-title="${safeTitle}" data-cover="${r.cover || ''}">
        <div class="home-card-art">
          ${artHtml}
          <div class="home-card-play" data-action="play-release" title="${window.i18n && window.i18n.t ? window.i18n.t('artist.playRelease') : 'Reproducir'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="release-card-add-btn" data-action="add-release" title="${window.i18n && window.i18n.t ? window.i18n.t('artist.addToSidebar') : 'Añadir a la barra lateral'}">
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="home-card-title">${safeTitle}</div>
        <div class="home-card-sub">${esc(r.year || '')}</div>
      </div>`;
    }).join('');

    shelfEl.querySelectorAll('.release-card').forEach(card => {
      const id = card.dataset.id;
      const title = card.dataset.title;
      const cover = card.dataset.cover;
      card.querySelector('[data-action="play-release"]').addEventListener('click', e => {
        e.stopPropagation();
        playRelease(id, title);
      });
      const addBtn = card.querySelector('[data-action="add-release"]');
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        addAlbumToSidebar(id, title, cover, addBtn);
      });
      card.addEventListener('click', () => openAlbumPage(id, title, cover, typeLabel));
    });
  }

  async function playRelease(albumId, fallbackTitle) {
    showToast(`🔍 ${window.i18n && window.i18n.t ? window.i18n.t('artist.loadingRelease') : 'Cargando'} "${fallbackTitle}"…`);
    let result;
    try { result = await window.nofuf.getSpotifyAlbum(albumId); }
    catch (e) { result = { type: 'error', message: e.message }; }

    if (!result || result.type === 'error' || !result.tracks?.length) {
      showToast('⚠ ' + (result?.message || 'No se pudo cargar el álbum'));
      return;
    }

    const newTracks = result.tracks.map(sp => ({
      id:        'rel-' + sp.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type:      'youtube',
      title:     sp.title,
      artist:    sp.artist,
      album:     sp.album || fallbackTitle,
      duration:  sp.duration || 0,
      cover:     sp.cover || result.album?.cover || null,
      url:       '',
      ytUrl:     '',
      videoId:   '',
      thumbnail: sp.cover || result.album?.cover || '',
      lazy:      true,
      spMeta:    { title: sp.title, artist: sp.artist },
    }));

    queue = [...newTracks, ...queue];
    currentIndex = 0;
    updateQueueUI();
    showView('queue');
    playTrack(0);
  }

  function findExistingReleasePlaylist(albumId) {
    return playlists.find(p => p.sourceAlbumId === albumId);
  }

  async function addAlbumToSidebar(albumId, fallbackTitle, fallbackCover, btnEl, silent) {
    const existing = findExistingReleasePlaylist(albumId);
    if (existing) {
      if (btnEl) btnEl.classList.add('added');
      return existing;
    }
    if (_addingReleaseIds.has(albumId)) return null;
    _addingReleaseIds.add(albumId);
    if (btnEl) btnEl.classList.add('loading');

    let result;
    try { result = await window.nofuf.getSpotifyAlbum(albumId); }
    catch (e) { result = { type: 'error', message: e.message }; }

    _addingReleaseIds.delete(albumId);
    if (btnEl) btnEl.classList.remove('loading');

    if (!result || result.type === 'error' || !result.tracks?.length) {
      showToast('⚠ ' + (result?.message || 'No se pudo añadir el álbum'));
      return null;
    }

    const cover = result.album?.cover || fallbackCover || null;
    const pl = {
      id:            'rel-pl-' + albumId + '-' + Date.now(),
      name:          result.album?.title || fallbackTitle,
      cover,
      tracks:        [],
      sourceAlbumId: albumId,
    };

    const newTracks = result.tracks.map(sp => {
      const track = {
        id:        'rel-' + sp.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type:      'youtube',
        title:     sp.title,
        artist:    sp.artist,
        album:     sp.album || pl.name,
        duration:  sp.duration || 0,
        cover:     sp.cover || cover,
        url:       '',
        ytUrl:     '',
        videoId:   '',
        thumbnail: sp.cover || cover || '',
        lazy:      true,
        spMeta:    { title: sp.title, artist: sp.artist },
      };
      pl.tracks.push(track.id);
      return track;
    });

    addTracksToLibrary(newTracks);
    playlists.push(pl);
    savePlaylists();
    renderSidebarPlaylists();

    if (btnEl) btnEl.classList.add('added');
    if (!silent) {
      const doneLabel = window.i18n && window.i18n.t ? window.i18n.t('artist.addedToSidebar') : 'añadido a la barra lateral';
      showToast(`✓ "${pl.name}" ${doneLabel}`);
    }
    return pl;
  }

  async function openArtistPage(artistId, fallbackName, fallbackPic) {
    if (!artistId) return;
    const token = ++currentArtistLoadToken;

    document.getElementById('yt-search-panel')?.classList.remove('open');
    document.getElementById('sp-search-panel')?.classList.remove('open');
    document.getElementById('yt-search-overlay')?.classList.remove('active');

    pageHeaderName.textContent = fallbackName || '—';
    pageName.textContent = fallbackName || '—';
    pageFans.textContent = '';
    pageBanner.style.backgroundImage = fallbackPic ? `url('${fallbackPic}')` : '';
    pageTracklist.innerHTML = '';
    pageEmpty.style.display = 'none';
    pageLoading.style.display = '';
    page.classList.add('open');
    renderReleaseShelf(singlesShelf, singlesTitle, [], 'Single');
    renderReleaseShelf(epsShelf, epsTitle, [], 'EP');
    renderReleaseShelf(albumsShelf, albumsTitle, [], window.i18n && window.i18n.t ? window.i18n.t('artist.albumType') : 'Álbum');

    let result;
    try { result = await window.nofuf.getSpotifyArtist(artistId); }
    catch (e) { result = { type: 'error', message: e.message }; }

    if (token !== currentArtistLoadToken) return;
    pageLoading.style.display = 'none';

    if (!result || result.type === 'error') {
      pageEmpty.textContent = result?.message || (window.i18n && window.i18n.t ? window.i18n.t('artist.loadError') : 'No se pudo cargar este artista.');
      pageEmpty.style.display = '';
      return;
    }

    const artist = result.artist || {};
    pageHeaderName.textContent = artist.name || fallbackName || '—';
    pageName.textContent = artist.name || fallbackName || '—';
    pageFans.textContent = formatFanCount(artist.nbFan);
    if (artist.picture) pageBanner.style.backgroundImage = `url('${artist.picture}')`;

    renderArtistTracklist(result.tracks || []);
    renderReleaseShelf(singlesShelf, singlesTitle, result.singles || [], 'Single');
    renderReleaseShelf(epsShelf, epsTitle, result.eps || [], 'EP');
    renderReleaseShelf(albumsShelf, albumsTitle, result.albums || [], window.i18n && window.i18n.t ? window.i18n.t('artist.albumType') : 'Álbum');
  }

  function closeArtistPage() {
    page.classList.remove('open');
    currentArtistLoadToken++;
    albumPage.classList.remove('open');
    currentAlbumLoadToken++;
  }
  window.closeArtistPage = closeArtistPage;

  pageClose.addEventListener('click', closeArtistPage);

  pagePlayBtn.addEventListener('click', () => {
    if (!currentArtistTracks.length) return;
    const firstItem = pageTracklist.querySelector('.sp-result-item[data-idx="0"]');
    if (firstItem) resolveArtistTrackAndAct(firstItem, currentArtistTracks[0], 'play');
  });

  albumPageClose.addEventListener('click', closeAlbumPage);

  albumPagePlayBtn.addEventListener('click', () => {
    if (!currentAlbumTracks.length) return;
    const firstItem = albumPageTracklist.querySelector('.sp-result-item[data-idx="0"]');
    if (firstItem) resolveArtistTrackAndAct(firstItem, currentAlbumTracks[0], 'play');
  });

  albumPageAddBtn.addEventListener('click', () => {
    if (!currentAlbumId || !currentAlbumMeta) return;
    addAlbumToSidebar(currentAlbumId, currentAlbumMeta.title, currentAlbumMeta.cover, albumPageAddBtn);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (albumPage.classList.contains('open')) { closeAlbumPage(); return; }
    if (page.classList.contains('open')) closeArtistPage();
  });
})();

(function initNightcore() {

  let _ncEnabled   = false;
  let _ncPitch     = 4;
  let _ncTreble    = 4;
  let _ncReverb    = 0;
  let _ncPanelOpen = false;

  let _ncTrebleNode = null;
  let _ncDryGain    = null;
  let _ncConvolver  = null;
  let _ncWetGain    = null;
  let _ncChainReady = false;

  const NC_PRESETS = {
    nightcore: { pitch:  4, treble:  4 },
    slowed:    { pitch: -3, treble: -2 },
    vaporwave: { pitch: -5, treble:  0 },
  };

  const _NC_WET_MAX = 0.8;

  function _ncWetLevel() {
    return (_ncReverb / 100) * _NC_WET_MAX;
  }

  function _ncFinalRate() {
    return Math.min(4.0, Math.max(0.05, Math.pow(2, _ncPitch / 12)));
  }

  function _ncImpulse(seconds, decay) {
    const rate = _vizCtx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = _vizCtx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // Conecta analyser → treble → dry → (normalización) → destino.
  // Importante: pasar por _normGain; conectando directo a destination la
  // normalización quedaba huérfana y dejaba de afectar al audio.
  function _ncConnect() {
    try { _vizAnalyser.disconnect(); } catch(e) {}
    _vizAnalyser.connect(_ncTrebleNode);
    _ncTrebleNode.connect(_ncDryGain);
    _ncDryGain.connect(_normGain || _vizCtx.destination);
    _ncTrebleNode.connect(_ncConvolver);
    _ncConvolver.connect(_ncWetGain);
    _ncWetGain.connect(_vizCtx.destination);
  }

  function _ncBuildChain(force = false) {
    if (!_vizCtx) return;
    if (_ncChainReady) {
      if (force) { try { _ncConnect(); } catch(e) {} }
      return;
    }
    try {
      _ncTrebleNode = _vizCtx.createBiquadFilter();
      _ncTrebleNode.type = 'highshelf';
      _ncTrebleNode.frequency.value = 8000;
      _ncTrebleNode.gain.value = 0;
      _ncDryGain = _vizCtx.createGain();
      _ncDryGain.gain.value = 1;
      _ncConvolver = _vizCtx.createConvolver();
      _ncConvolver.buffer = _ncImpulse(1.8, 2.5);
      _ncWetGain = _vizCtx.createGain();
      _ncWetGain.gain.value = 0;
      _ncConnect();
      _ncChainReady = true;
      _ncApply();
    } catch(e) { console.warn('[NC] chain error:', e); }
  }

  function _ncApply() {
    if (_ncEnabled) {
      if (_ncPitch === 0) {
        audioPlayer.preservesPitch        = true;
        audioPlayer.mozPreservesPitch     = true;
        audioPlayer.webkitPreservePitch   = true;
        audioPlayer.playbackRate = 1.0;
      } else {
        audioPlayer.preservesPitch        = false;
        audioPlayer.mozPreservesPitch     = false;
        audioPlayer.webkitPreservePitch   = false;
        audioPlayer.playbackRate = _ncFinalRate();
      }
      if (_ncChainReady && _ncTrebleNode) {
        _ncTrebleNode.gain.setTargetAtTime(_ncTreble, _vizCtx.currentTime, 0.02);
      }
      if (_ncChainReady && _ncWetGain) {
        _ncWetGain.gain.setTargetAtTime(_ncWetLevel(), _vizCtx.currentTime, 0.03);
      }
    } else {
      audioPlayer.preservesPitch        = true;
      audioPlayer.mozPreservesPitch     = true;
      audioPlayer.webkitPreservePitch   = true;
      audioPlayer.playbackRate = 1.0;
      if (_ncChainReady && _ncTrebleNode) {
        _ncTrebleNode.gain.setTargetAtTime(0, _vizCtx.currentTime, 0.02);
      }
      if (_ncChainReady && _ncWetGain) {
        _ncWetGain.gain.setTargetAtTime(0, _vizCtx.currentTime, 0.03);
      }
    }
  }

  const _ncOrigInitViz = initVisualizer;
  initVisualizer = function() {
    _ncOrigInitViz();
    if (!_ncChainReady) _ncBuildChain();
  };
  const _ncOrigEqBuild = _eqBuildChain;
  _eqBuildChain = function() {
    _ncOrigEqBuild();
    if (_vizCtx && _eqAudioCtxReady) {
      // El rebuild del EQ deja la cadena NC colgando: reconectarla
      if (_ncChainReady) _ncBuildChain(true);
      else setTimeout(_ncBuildChain, 50);
    }
  };

  const _ncOrigPlayTrack = playTrack;
  playTrack = function(index) {
    _ncOrigPlayTrack(index);
    if (_ncEnabled) {
      audioPlayer.addEventListener('canplay', function _h() {
        audioPlayer.removeEventListener('canplay', _h);
        _ncApply();
      }, { once: true });
    }
  };

  function _ncUpdateUI() {
    const pitchInput  = document.getElementById('nc-pitch');
    const trebleInput = document.getElementById('nc-treble');
    const pitchDisp   = document.getElementById('nc-pitch-display');
    const trebleDisp  = document.getElementById('nc-treble-display');
    const enableChk   = document.getElementById('nc-enabled');
    const reverbInput = document.getElementById('nc-reverb');
    const reverbDisp  = document.getElementById('nc-reverb-display');
    const panel       = document.getElementById('nc-panel');
    const btn         = document.getElementById('btn-nightcore');

    if (pitchInput)  pitchInput.value  = _ncPitch;
    if (trebleInput) trebleInput.value = _ncTreble;
    if (pitchDisp)   pitchDisp.textContent  = (_ncPitch >= 0 ? '+' : '') + _ncPitch.toFixed(1) + ' st';
    if (trebleDisp)  trebleDisp.textContent = (_ncTreble >= 0 ? '+' : '') + _ncTreble.toFixed(1) + ' dB';
    if (enableChk)   enableChk.checked = _ncEnabled;
    if (reverbInput) reverbInput.value = _ncReverb;
    if (reverbDisp)  reverbDisp.textContent = Math.round(_ncReverb) + '%';
    if (panel) {
      panel.classList.toggle('nc-on', _ncEnabled);
    }
    if (btn) {
      btn.classList.toggle('active', _ncEnabled);
      btn.style.color = _ncEnabled ? '#a78bfa' : '';
    }
  }

  function _ncSave() {
    settings.nightcore = { enabled: _ncEnabled, pitch: _ncPitch, treble: _ncTreble, reverb: _ncReverb };
    saveSettingsSoon();
  }

  function _ncLoad() {
    if (settings.nightcore) {
      _ncEnabled = !!settings.nightcore.enabled;
      _ncPitch   = settings.nightcore.pitch   ?? 4;
      _ncTreble  = settings.nightcore.treble  ?? 4;
      const _rv  = settings.nightcore.reverb;
      // Migración: antes era booleano (true = 35%)
      _ncReverb  = (typeof _rv === 'number' && Number.isFinite(_rv))
        ? Math.min(100, Math.max(0, _rv)) : (_rv ? 35 : 0);
    }
  }

  function _ncOpenPanel() {
    _ncPanelOpen = true;
    const panel   = document.getElementById('nc-panel');
    const overlay = document.getElementById('nc-panel-overlay');
    const btn     = document.getElementById('btn-nightcore');
    if (panel)   panel.classList.add('open');
    if (overlay) overlay.classList.add('active');
    if (btn)     btn.classList.add('panel-open');
    if (_vizCtx && !_ncChainReady) _ncBuildChain();
  }
  function _ncClosePanel() {
    _ncPanelOpen = false;
    const panel   = document.getElementById('nc-panel');
    const overlay = document.getElementById('nc-panel-overlay');
    const btn     = document.getElementById('btn-nightcore');
    if (panel)   panel.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    if (btn)     btn.classList.remove('panel-open');
  }

  function _ncApplyPreset(name) {
    const preset = NC_PRESETS[name];
    if (!preset) return;
    _ncPitch  = preset.pitch;
    _ncTreble = preset.treble;
    if (_ncEnabled) _ncApply();
    _ncUpdateUI();
    _ncSave();
    document.querySelectorAll('[data-nc-preset]').forEach(b =>
      b.classList.toggle('active', b.dataset.ncPreset === name));
    showToast('Preset: ' + name.charAt(0).toUpperCase() + name.slice(1));
  }

  function _ncDetectPreset() {
    for (const [name, p] of Object.entries(NC_PRESETS)) {
      if (Math.abs(p.pitch - _ncPitch) < 0.1  &&
          Math.abs(p.treble - _ncTreble) < 0.1) return name;
    }
    return null;
  }

  function _ncMarkPresetButtons() {
    const active = _ncDetectPreset();
    document.querySelectorAll('[data-nc-preset]').forEach(b => {
      b.classList.toggle('active', b.dataset.ncPreset === active);
    });
  }

  function _ncSetupControls() {
    _ncLoad();
    _ncUpdateUI();
    _ncApply();
    _ncMarkPresetButtons();

    const btnNC = document.getElementById('btn-nightcore');
    if (btnNC) {
      btnNC.addEventListener('click', () => {
        if (_ncPanelOpen) _ncClosePanel();
        else _ncOpenPanel();
      });
    }

    const closeBtn = document.getElementById('nc-close');
    if (closeBtn) closeBtn.addEventListener('click', _ncClosePanel);
    const overlay = document.getElementById('nc-panel-overlay');
    if (overlay) overlay.addEventListener('click', _ncClosePanel);

    const enableChk = document.getElementById('nc-enabled');
    if (enableChk) {
      enableChk.addEventListener('change', () => {
        _ncEnabled = enableChk.checked;
        if (_ncEnabled && _vizCtx && !_ncChainReady) _ncBuildChain();
        if (_ncEnabled && !_vizCtx) initVisualizer();
        _ncApply();
        _ncUpdateUI();
        _ncSave();
        showToast(_ncEnabled ? '⚡ Nightcore activado' : 'Nightcore desactivado');
      });
    }

    const reverbInput = document.getElementById('nc-reverb');
    if (reverbInput) {
      reverbInput.addEventListener('input', () => {
        _ncReverb = Math.min(100, Math.max(0, parseFloat(reverbInput.value) || 0));
        const disp = document.getElementById('nc-reverb-display');
        if (disp) disp.textContent = Math.round(_ncReverb) + '%';
        if (_ncEnabled && _ncChainReady && _ncWetGain && _vizCtx) {
          _ncWetGain.gain.setTargetAtTime(_ncWetLevel(), _vizCtx.currentTime, 0.03);
        }
        _ncSave();
      });
    }

    const pitchInput = document.getElementById('nc-pitch');
    if (pitchInput) {
      pitchInput.addEventListener('input', () => {
        _ncPitch = parseFloat(pitchInput.value);
        const disp = document.getElementById('nc-pitch-display');
        if (disp) disp.textContent = (_ncPitch >= 0 ? '+' : '') + _ncPitch.toFixed(1) + ' st';
        if (_ncEnabled) _ncApply();
        _ncMarkPresetButtons();
        _ncSave();
      });
    }

    const trebleInput = document.getElementById('nc-treble');
    if (trebleInput) {
      trebleInput.addEventListener('input', () => {
        _ncTreble = parseFloat(trebleInput.value);
        const disp = document.getElementById('nc-treble-display');
        if (disp) disp.textContent = (_ncTreble >= 0 ? '+' : '') + _ncTreble.toFixed(1) + ' dB';
        if (_ncEnabled && _ncChainReady && _ncTrebleNode) {
          _ncTrebleNode.gain.setTargetAtTime(_ncTreble, _vizCtx.currentTime, 0.02);
        }
        _ncMarkPresetButtons();
        _ncSave();
      });
    }

    document.querySelectorAll('[data-nc-preset]').forEach(btn => {
      btn.addEventListener('click', () => _ncApplyPreset(btn.dataset.ncPreset));
    });

    const resetBtn = document.getElementById('nc-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        _ncApplyPreset('nightcore');
        showToast('Nightcore restablecido');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _ncSetupControls);
    
  } else {
    setTimeout(_ncSetupControls, 0);
  }

})();
// ============================================================
// Integración de funciones nuevas: biblioteca, selección, radio,
// velocidad, sleep, sesión YT, ListenBrainz, Discord, mini-player
// ============================================================
(function initExtraFeatures() {
  const T = (s) => (window.i18n && window.i18n.T) ? window.i18n.T(s) : s;
  const $id = (x) => document.getElementById(x);

  // ---------- Toolbar de biblioteca ----------
  const libSearch = $id('library-search');
  const libSort   = $id('library-sort');
  const libGroup  = $id('library-group');
  if (libSearch) {
    libSearch.placeholder = T('Buscar en biblioteca…');
    let _lsTimer = null;
    libSearch.addEventListener('input', () => {
      clearTimeout(_lsTimer);
      _lsTimer = setTimeout(() => { _libSearch = libSearch.value; renderLibraryUI(); }, 150);
    });
  }
  if (libSort) {
    libSort.addEventListener('change', () => { _libSort = libSort.value; settings.libSort = _libSort; saveSettingsSoon(); renderLibraryUI(); });
  }
  if (libGroup) {
    libGroup.addEventListener('change', () => { _libGroup = libGroup.value; settings.libGroup = _libGroup; saveSettingsSoon(); renderLibraryUI(); });
  }

  // ---------- Barra de selección múltiple ----------
  const selBar = $id('sel-action-bar');
  if (selBar) {
    $id('sel-clear').addEventListener('click', _selClear);
    $id('sel-play').addEventListener('click', () => {
      const tracks = _selTracksInOrder();
      if (!tracks.length) return;
      queue = tracks.map(t => ({ ...t }));
      updateQueueUI();
      _selClear();
      playTrack(0);
      showToast(T('Reproduciendo selección'));
    });
    $id('sel-add-queue').addEventListener('click', () => {
      const tracks = _selTracksInOrder();
      if (!tracks.length) return;
      const ids = new Set(queue.map(q => q.id));
      let added = 0;
      for (const t of tracks) {
        if (ids.has(t.id)) continue;
        queue.push({ ...t }); ids.add(t.id); added++;
      }
      updateQueueUI();
      showToast(added ? `${added} añadidas a la cola` : 'Ya estaban en la cola');
      _selClear();
    });
    $id('sel-delete').addEventListener('click', _selDeleteSelected);
    $id('sel-add-playlist').addEventListener('click', (e) => {
      if (!playlists.length) { showToast(T('Crea una playlist primero')); return; }
      const menu = document.createElement('div');
      menu.className = 'mini-popover';
      menu.innerHTML = `<div class="ctx-menu-label">${T('Añadir a playlist')}</div>`;
      playlists.forEach(pl => {
        const item = document.createElement('button');
        item.className = 'ctx-item';
        item.innerHTML = `<span>${escapeHTML(pl.name)}</span>`;
        item.addEventListener('click', () => {
          const tracks = _selTracksInOrder();
          let added = 0;
          for (const t of tracks) {
            if (!pl.tracks.includes(t.id)) { pl.tracks.push(t.id); added++; }
          }
          if (added) { savePlaylists(); renderSidebarPlaylists(); }
          showToast(added ? `${added} añadidas a "${pl.name}"` : 'Ya estaban en la playlist');
          menu.remove();
          _selClear();
        });
        menu.appendChild(item);
      });
      document.body.appendChild(menu);
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 230) + 'px';
      menu.style.top  = (r.top - menu.offsetHeight - 8) + 'px';
      setTimeout(() => {
        const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
      }, 0);
    });
  }

  // Escape limpia la selección y cierra popovers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (_selIds.size) { _selClear(); return; }
      const slm = $id('sleep-menu');
      if (slm && slm.style.display !== 'none') slm.style.display = 'none';
    }
  });

  // ---------- Radio infinita ----------
  const btnRadio = $id('btn-radio');
  if (btnRadio) {
    btnRadio.addEventListener('click', () => {
      isRadio = !isRadio;
      settings.radioEnabled = isRadio;
      saveSettingsSoon();
      btnRadio.classList.toggle('active', isRadio);
      showToast(isRadio ? T('Radio activada') : T('Radio desactivada'));
    });
  }

  // ---------- Temporizador de apagado ----------
  let _sleepTimer = null, _sleepEndsAt = 0, _sleepTicker = null;
  function _sleepClear() {
    if (_sleepTimer) { clearTimeout(_sleepTimer); _sleepTimer = null; }
    if (_sleepTicker) { clearInterval(_sleepTicker); _sleepTicker = null; }
    _sleepEndsAt = 0; _sleepAtEnd = false;
    const b = $id('btn-sleep');
    if (b) { b.classList.remove('has-countdown'); b.title = T('Temporizador de apagado'); }
  }
  function _sleepSet(val) {
    _sleepClear();
    if (val === 'end') {
      _sleepAtEnd = true;
      showToast(T('La música se detendrá al acabar esta canción'));
      return;
    }
    if (val === 'off') { showToast(T('Temporizador desactivado')); return; }
    const min = parseInt(val, 10);
    if (!min) return;
    const ms = min * 60000;
    _sleepEndsAt = Date.now() + ms;
    _sleepTimer = setTimeout(() => {
      try { audioPlayer.pause(); } catch (_) {}
      isPlaying = false;
      updatePlaybackUI();
      _sleepClear();
      showToast(T('Temporizador: música detenida'));
    }, ms);
    const updateCountdown = () => {
      const b = $id('btn-sleep');
      if (!b) return;
      const left = Math.max(0, _sleepEndsAt - Date.now());
      const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
      b.classList.add('has-countdown');
      b.title = `${T('Temporizador')}: ${mm}:${String(ss).padStart(2, '0')}`;
    };
    updateCountdown();
    _sleepTicker = setInterval(updateCountdown, 1000);
    showToast(`${T('La música se detendrá en')} ${min} min`);
  }
  const btnSleep = $id('btn-sleep');
  const sleepMenu = $id('sleep-menu');
  if (btnSleep && sleepMenu) {
    btnSleep.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = sleepMenu.style.display === 'none';
      sleepMenu.style.display = show ? 'block' : 'none';
      if (show) {
        const r = btnSleep.getBoundingClientRect();
        sleepMenu.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
        sleepMenu.style.top  = (r.top - sleepMenu.offsetHeight - 8) + 'px';
      }
    });
    sleepMenu.querySelectorAll('.sleep-opt').forEach(btn => {
      btn.addEventListener('click', () => { _sleepSet(btn.dataset.sleep); sleepMenu.style.display = 'none'; });
    });
    document.addEventListener('click', (e) => {
      if (sleepMenu.style.display !== 'none' && !sleepMenu.contains(e.target) && e.target !== btnSleep) sleepMenu.style.display = 'none';
    });
  }

  // ---------- Mini-reproductor ----------
  const btnMini = $id('btn-mini');
  if (btnMini) btnMini.addEventListener('click', () => { try { window.nofuf.miniToggle(); } catch (_) {} });
  let _miniLastTime = 0;
  function _miniState(includeCover) {
    const t = currentIndex >= 0 ? queue[currentIndex] : null;
    return {
      title: t ? (t.title || '—') : '—',
      artist: t ? (t.artist || '—') : '—',
      cover: includeCover ? ((t?.cover && /^https?:|data:/.test(t.cover)) ? t.cover : '') : undefined,
      playing: isPlaying && !audioPlayer.paused,
      position: audioPlayer.currentTime || 0,
      duration: audioPlayer.duration || (t?.duration || 0),
    };
  }
  // Reasignar los hooks de nivel módulo (no declarar: daría shadow-scope)
  _syncMiniNow = function() { try { window.nofuf.miniSendState(_miniState(true)); } catch (_) {} };
  _syncMiniTime = function() {
    const now = Date.now();
    if (now - _miniLastTime < 1000) return;
    _miniLastTime = now;
    try { window.nofuf.miniSendState(_miniState(false)); } catch (_) {}
  };
  if (window.nofuf.onMiniControl) {
    window.nofuf.onMiniControl((action) => {
      if (action === 'toggle') togglePlay();
      else if (action === 'next') playNext();
      else if (action === 'prev') playPrev();
      else if (action === 'ready') _syncMiniNow();
    });
  }

  // ---------- Discord Rich Presence ----------
  _updateRpcState = function() {
    try {
      const t = currentIndex >= 0 ? queue[currentIndex] : null;
      const coverUrl = t
        ? ((/^https:\/\//.test(t.cover || '')) ? t.cover : ((/^https:\/\//.test(t.thumbnail || '')) ? t.thumbnail : null))
        : null;
      window.nofuf.rpcUpdate({
        enabled: !!settings.discordRpc,
        title: t ? (t.title || null) : null,
        artist: t?.artist || '',
        album: t?.album || '',
        durationSec: Math.round(audioPlayer.duration || t?.duration || 0),
        positionSec: Math.round(audioPlayer.currentTime || 0),
        coverUrl,
        playing: isPlaying && !audioPlayer.paused,
      });
    } catch (e) {}
  };
  const settingDiscord = $id('setting-discord-rpc');
  if (settingDiscord) {
    settingDiscord.addEventListener('change', () => {
      settings.discordRpc = settingDiscord.checked;
      saveSettings();
      _updateRpcState();
      showToast(settings.discordRpc ? 'Discord Rich Presence activado' : 'Discord Rich Presence desactivado');
    });
  }

  // ---------- ListenBrainz ----------
  let _scrobbleTrack = null, _scrobbled = false;
  _scrobbleSchedule = function(t) {
    _scrobbleTrack = t ? {
      title: t.title || '', artist: t.artist || '', album: t.album || '',
      duration: Math.round(t.duration || 0),
      ts: Math.floor(Date.now() / 1000),
    } : null;
    _scrobbled = false;
  };
  _scrobbleTick = function() {
    if (!settings.lbEnabled || !settings.lbToken || _scrobbled || !_scrobbleTrack) return;
    const d = audioPlayer.duration || 0;
    const c = audioPlayer.currentTime || 0;
    if (d <= 0) return;
    const threshold = Math.min(d * 0.5, 240); // >50% o 4 minutos
    if (c >= threshold) {
      _scrobbled = true;
      window.nofuf.lbSubmitListen({
        token: settings.lbToken,
        payload: {
          listen_type: 'single',
          payload: [{
            listened_at: _scrobbleTrack.ts,
            track_metadata: {
              track_name: _scrobbleTrack.title,
              artist_name: _scrobbleTrack.artist,
              release_name: _scrobbleTrack.album || undefined,
              additional_info: { duration_ms: _scrobbleTrack.duration * 1000, submission_client: 'NofufAudio' },
            },
          }],
        },
      }).catch((e) => console.warn('[listenbrainz]', e));
    }
  }
  const settingLbEnabled = $id('setting-lb-enabled');
  const settingLbToken   = $id('setting-lb-token');
  const settingLbStatus  = $id('setting-lb-status');
  if (settingLbEnabled) {
    settingLbEnabled.addEventListener('change', () => {
      settings.lbEnabled = settingLbEnabled.checked;
      if (settingLbToken && settingLbToken.value.trim()) settings.lbToken = settingLbToken.value.trim();
      saveSettings();
      showToast(settings.lbEnabled ? T('Scrobbling activado') : T('Scrobbling desactivado'));
    });
  }
  const lbValidateBtn = $id('setting-lb-validate');
  if (lbValidateBtn) {
    lbValidateBtn.addEventListener('click', async () => {
      const token = (settingLbToken?.value || settings.lbToken || '').trim();
      if (!token) { if (settingLbStatus) settingLbStatus.textContent = T('Introduce tu token de ListenBrainz.'); return; }
      if (settingLbStatus) settingLbStatus.textContent = '…';
      try {
        const res = await window.nofuf.lbValidateToken(token);
        if (settingLbStatus) settingLbStatus.textContent = res.ok ? `${T('Conectado como')} ${res.user}` : (res.message || T('Token inválido'));
        if (res.ok && settingLbToken) { settings.lbToken = token; saveSettings(); }
      } catch (e) {
        if (settingLbStatus) settingLbStatus.textContent = T('Sin conexión con ListenBrainz.');
      }
    });
  }

  // ---------- Chequeo de sesión de YouTube ----------
  const ytSessionBtn = $id('setting-yt-session-btn');
  const ytSessionSt  = $id('setting-yt-session-status');
  if (ytSessionBtn) {
    ytSessionBtn.addEventListener('click', async () => {
      if (ytSessionSt) ytSessionSt.textContent = T('Comprobando sesión…');
      try {
        const res = await window.nofuf.checkYoutubeSession();
        if (ytSessionSt) {
          ytSessionSt.textContent = res.message || (res.ok ? 'OK' : 'Error');
          ytSessionSt.style.color = res.ok ? 'var(--green)' : 'var(--red)';
        }
      } catch (e) {
        if (ytSessionSt) { ytSessionSt.textContent = T('Error comprobando la sesión'); ytSessionSt.style.color = 'var(--red)'; }
      }
    });
  }

  // ---------- Ajustes: valores nuevos al abrir y guardar ----------
  const _origOpenSettings = openSettingsModal;
  openSettingsModal = function() {
    _origOpenSettings();
    const rq = $id('setting-resume-queue');
    if (rq) rq.checked = settings.resumeOnOpen !== false;
    const tpl = $id('setting-download-template');
    if (tpl) tpl.value = settings.downloadTemplate || '{artist} - {title}';
    const dr = $id('setting-discord-rpc');
    if (dr) dr.checked = !!settings.discordRpc;
    const dcId = $id('setting-discord-client-id');
    if (dcId) dcId.value = settings.discordClientId || '';
    const lbe = $id('setting-lb-enabled');
    if (lbe) lbe.checked = !!settings.lbEnabled;
    const lbt = $id('setting-lb-token');
    if (lbt) lbt.value = settings.lbToken || '';
  };

  const _origSaveSettingsFromModal2 = saveSettingsFromModal;
  saveSettingsFromModal = function() {
    const rq = $id('setting-resume-queue');
    if (rq) settings.resumeOnOpen = rq.checked;
    const tpl = $id('setting-download-template');
    if (tpl) settings.downloadTemplate = tpl.value.trim() || '{artist} - {title}';
    // Discord y ListenBrainz se guardan con sus propios listeners de change,
    // pero el token hay que persistirlo al guardar también
    const lbt = $id('setting-lb-token');
    if (lbt && lbt.value.trim()) settings.lbToken = lbt.value.trim();
    const lbe = $id('setting-lb-enabled');
    if (lbe) settings.lbEnabled = lbe.checked;
    const dcId = $id('setting-discord-client-id');
    if (dcId) settings.discordClientId = dcId.value.trim();
    _origSaveSettingsFromModal2();
  };

  // ---------- Guardar la cola al ocultar/cerrar ----------
  if (window.nofuf?.onSaveBeforeHide) {
    window.nofuf.onSaveBeforeHide(() => {
      try { saveQueueSoon.flush(); saveQueueNow(); } catch (_) {}
      try { _updateRpcState(); } catch (_) {}
    });
  }
  window.addEventListener('beforeunload', () => {
    try { saveQueueSoon.flush(); saveQueueNow(); } catch (_) {}
    try { _dlSave(); } catch (_) {}
  });

  // Inicialización que necesita settings ya cargados (se llama desde DOMContentLoaded)
  _initExtraAfterData = function() {
    if (libSort) { libSort.value = settings.libSort || 'custom'; _libSort = settings.libSort || 'custom'; }
    if (libGroup) { libGroup.value = settings.libGroup || 'none'; _libGroup = settings.libGroup || 'none'; }
    if (btnRadio) {
      isRadio = !!settings.radioEnabled;
      btnRadio.classList.toggle('active', isRadio);
    }
  };
})();

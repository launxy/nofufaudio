/* ═══════════════════════════════════════════════
   NOFUFAUDIO — app.js  v2 (all features)
═══════════════════════════════════════════════ */

/* ── State ── */
let queue        = [];
let currentIndex = -1;
let isPlaying    = false;
let isMuted      = false;
let currentVolume = 0.8;
let searchMode   = 'yt'; // 'yt' | 'sp' — shared across initYouTubeSearch + initSearchMode
let isShuffle    = false;
let isRepeat     = false;

let library   = [];
let favorites = [];
let playlists = [];
let settings  = {};
let currentPlaylistId = null;
let ctxTrack  = null;
let ctxContext = null; // 'queue'|'library'|'favorites'|'playlist'
let lyricsPanelOpen = false;
let editingTrackId = null;
let crossfadeTimer = null;

// Lyrics advanced state (declaradas aquí para evitar ReferenceError por hoisting de let)
let _lastLyricsResult = null;
let _romajiActive = false;
let _syncedLines = null;
let _activeLrcLineIdx = -1;

const KEYS = {
  library:'nfa_library', favorites:'nfa_favorites',
  playlists:'nfa_playlists', settings:'nfa_settings'
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
  minimizeTray: true,
  closeTray: true,
  syncedLyrics: true,
  downloadDir: '',
  downloadFormat: 'mp3',
  vizEnabled: true,
  vizStyle: 'bars',
  vizColor: '#ffffff',
  vizShadow: true,
  vizSensitivity: 1.5,
  theme: null, // CSS vars map saved by theme panel
};

function loadData() {
  try { library   = JSON.parse(localStorage.getItem(KEYS.library)   || '[]'); } catch { library=[]; }
  try { favorites = JSON.parse(localStorage.getItem(KEYS.favorites) || '[]'); } catch { favorites=[]; }
  try { playlists = JSON.parse(localStorage.getItem(KEYS.playlists) || '[]'); } catch { playlists=[]; }
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
    settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  } catch { settings = { ...DEFAULT_SETTINGS }; }
}

/* ── Helpers internos para escribir/leer archivos de config ── */
function _cfgWrite(name, data) {
  try {
    if (window.nofuf?.configWrite)
      window.nofuf.configWrite(name, JSON.stringify(data, null, 2));
  } catch (e) { /* silencioso */ }
}
async function _cfgRead(name) {
  try {
    if (!window.nofuf?.configRead) return null;
    const txt = await window.nofuf.configRead(name);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) { return null; }
}

function saveLibrary() {
  localStorage.setItem(KEYS.library, JSON.stringify(library));
  _cfgWrite('library.json', library);
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
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  _cfgWrite('settings.json', settings);
}

/* ── Crea archivos de config vacíos si no existen, luego carga si existen ── */
(async function initConfigFiles() {
  if (!window.nofuf?.configRead || !window.nofuf?.configWrite) return;
  try {
    // Para cada archivo: si no existe → crearlo vacío. Si existe → cargarlo.
    // background.json se guarda separado (puede ser varios MB en base64)
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

    if (Array.isArray(lib))  { library   = lib;  localStorage.setItem(KEYS.library,   JSON.stringify(library));   changed = true; }
    if (Array.isArray(favs)) { favorites = favs; localStorage.setItem(KEYS.favorites, JSON.stringify(favorites)); changed = true; }
    if (Array.isArray(pls))  { playlists = pls;  localStorage.setItem(KEYS.playlists, JSON.stringify(playlists)); changed = true; }
    if (cfg && typeof cfg === 'object' && Object.keys(cfg).length > 0) {
      // Extraemos --bg-image de settings si estaba ahí (migración del sistema anterior)
      if (cfg.theme && cfg.theme['--bg-image'] && (!bg || !bg.dataUrl)) {
        const migratedBg = { dataUrl: cfg.theme['--bg-image'], opts: {} };
        try { migratedBg.opts = JSON.parse(cfg.theme['--bg-opts'] || '{}'); } catch {}
        await window.nofuf.configWrite('background.json', JSON.stringify(migratedBg, null, 2));
        delete cfg.theme['--bg-image'];
        delete cfg.theme['--bg-opts'];
      }
      settings = Object.assign({}, DEFAULT_SETTINGS, cfg);
      localStorage.setItem(KEYS.settings, JSON.stringify(settings));
      changed = true;
    }

    if (changed) {
      try { applySettings(); }          catch(e) {}
      try { applyTheme(settings.theme); } catch(e) {}
      try { renderLibrary(); }           catch(e) {}
      try { renderSidebarPlaylists(); }  catch(e) {}
      try { renderFavoritesView(); }     catch(e) {}
      // Restaura EQ
      try {
        if (settings.eqGains) { _eqGains = [...settings.eqGains]; _eqUpdateAllUI(); _eqApplyGains(); }
        if (settings.eqPreset) {
          _eqActivePreset = settings.eqPreset;
          if (_eqActivePreset.startsWith('user:')) {
            _eqRenderUserPresets();
          } else {
            document.querySelectorAll('.eq-preset-btn').forEach(b =>
              b.classList.toggle('active', b.dataset.preset === _eqActivePreset));
          }
        }
      } catch(e) {}
    }

    // Restaurar imagen de fondo desde background.json
    // Usamos window._nofufPendingBg para que el panel de temas lo aplique
    // en cuanto esté inicializado (puede no estar listo aún en este momento)
    const bgData = bg && bg.dataUrl ? bg
                 : null;
    if (bgData) {
      window._nofufPendingBg = bgData; // { dataUrl, opts }
      // Intentar aplicar inmediatamente si la función ya existe
      if (typeof window._nofufApplyBg === 'function') {
        try { window._nofufApplyBg(bgData.dataUrl, bgData.opts); } catch(e) {}
      }
    }

  } catch (e) { console.warn('[nofuf] initConfigFiles:', e); }
})();

/* ── Audio ── */
const audioPlayer = new Audio();

/* ── DOM refs ── */
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
  spUrlInput:     document.getElementById('sp-url-input'),
  spUrlAddBtn:    document.getElementById('sp-url-add-btn'),
  spUrlStatus:    document.getElementById('sp-url-status'),
  ytSearchInput:  document.getElementById('yt-search-input'),
  ytSearchClear:  document.getElementById('yt-search-clear'),
  ytSearchPanel:  document.getElementById('yt-search-panel'),
  ytSearchOverlay:document.getElementById('yt-search-overlay'),
  ytResultsList:  document.getElementById('yt-results-list'),
  ytSearchPlaceholder: document.getElementById('yt-search-placeholder'),
  ytPanelClose:   document.getElementById('yt-search-panel-close'),
  trackSource:    document.getElementById('track-source'),
  trackTitle:     document.getElementById('track-title'),
  trackArtist:    document.getElementById('track-artist'),
  artPlaceholder: document.getElementById('art-placeholder'),
  artImage:       document.getElementById('art-image'),
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
  // lyrics
  lyricsPanel:    document.getElementById('lyrics-panel'),
  lyricsClose:    document.getElementById('lyrics-close'),
  lyricsBody:     document.getElementById('lyrics-body'),
  lyricsArt:      document.getElementById('lyrics-art'),
  lyricsTrackName:document.getElementById('lyrics-track-name'),
  lyricsArtistName:document.getElementById('lyrics-artist-name'),
  lyricsSourceBar:document.getElementById('lyrics-source-bar'),
  lyricsSourceLabel:document.getElementById('lyrics-source-label'),
  lyricsResultsBar:  document.getElementById('lyrics-results-bar'),
  lyricsResultsChips:document.getElementById('lyrics-results-chips'),
  // playlist hero
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
  // modals
  modalBackdrop:   document.getElementById('modal-backdrop'),
  modalClose:      document.getElementById('modal-close'),
  modalCancel:     document.getElementById('modal-cancel'),
  modalCreate:     document.getElementById('modal-create'),
  modalNameInput:  document.getElementById('modal-playlist-name'),
  modalArtPick:    document.getElementById('modal-art-pick'),
  modalCoverInput: document.getElementById('modal-cover-input'),
  modalArtPreview: document.getElementById('modal-art-preview'),
  // edit track modal
  modalEditBackdrop: document.getElementById('modal-edit-backdrop'),
  modalEditClose:    document.getElementById('modal-edit-close'),
  modalEditCancel:   document.getElementById('modal-edit-cancel'),
  modalEditSave:     document.getElementById('modal-edit-save'),
  editTitleInput:    document.getElementById('edit-title-input'),
  editArtistInput:   document.getElementById('edit-artist-input'),
  editArtPick:       document.getElementById('edit-art-pick'),
  editArtPreview:    document.getElementById('edit-art-preview'),
  editCoverInput:    document.getElementById('edit-cover-input'),
  // settings modal
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
  settingLyricsSize:     document.getElementById('setting-lyrics-size'),
  settingLyricsSizeVal:  document.getElementById('setting-lyrics-size-val'),
  settingLyricsFont:     document.getElementById('setting-lyrics-font'),
  settingMinimizeTray:   document.getElementById('setting-minimize-tray'),
  settingCloseTray:      document.getElementById('setting-close-tray'),
  // context menu
  ctxMenu:         document.getElementById('ctx-menu'),
  ctxEdit:         document.getElementById('ctx-edit'),
  ctxPlaylistOpts: document.getElementById('ctx-playlist-options'),
  ctxFav:          document.getElementById('ctx-fav'),
  ctxLib:          document.getElementById('ctx-lib'),
  ctxPlayNext:     document.getElementById('ctx-play-next'),
  ctxDelete:       document.getElementById('ctx-delete'),
  // nav
  navItems:        document.querySelectorAll('.nav-item'),
  views:           document.querySelectorAll('.view'),
};

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  loadRecentlyPlayed();
  applySettings();
  currentVolume = settings.defaultVolume / 100;
  setVolume(currentVolume);
  setupEventListeners();
  renderSidebarPlaylists();
  updateQueueUI();
  renderLibraryUI();
  renderFavoritesUI();
  renderHomeView();
  showView('home');
});

/* ══════════════════════════════════════
   APPLY SETTINGS
══════════════════════════════════════ */
function applySettings() {
  // Accent color
  document.documentElement.style.setProperty('--accent', settings.accentColor);
  // Lyrics size + font
  document.documentElement.style.setProperty('--lyrics-font-size', settings.lyricsSize + 'px');
  const lt = document.querySelector('.lyrics-text');
  if (lt) {
    lt.style.fontSize = settings.lyricsSize + 'px';
    if (settings.lyricsFont) lt.style.fontFamily = settings.lyricsFont;
  }
  // Show duration
  document.querySelectorAll('.qi-dur').forEach(el => {
    el.classList.toggle('hidden', !settings.showDuration);
  });
  // Spin art
  const img = dom.artImage;
  if (settings.spinArt && isPlaying) {
    img.classList.add('spinning');
    img.classList.remove('paused');
  } else if (!settings.spinArt) {
    img.classList.remove('spinning', 'paused');
  }
}

/* ══════════════════════════════════════
   NAVIGATION
══════════════════════════════════════ */
function showView(name) {
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

/* ══════════════════════════════════════
   HOME VIEW
══════════════════════════════════════ */
function getGreeting() {
  const h = new Date().getHours();
  if (h < 6)  return 'Buenas noches';
  if (h < 12) return 'Buenos días';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

function renderHomeView() {
  // Greeting
  const greetEl = document.getElementById('home-greeting');
  if (greetEl) greetEl.textContent = getGreeting();

  // ─ Recently played (last 12 unique tracks from history) ─
  const recentShelf = document.getElementById('home-recents-shelf');
  if (recentShelf) {
    recentShelf.className = 'home-shelf recents-shelf';
    const recents = getRecentlyPlayed();
    if (recents.length === 0) {
      recentShelf.innerHTML = '<div class="home-empty-hint">Aún no has reproducido nada</div>';
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

  // ─ Playlists shelf ─
  const plShelf = document.getElementById('home-playlists-shelf');
  if (plShelf) {
    if (playlists.length === 0) {
      plShelf.innerHTML = '<div class="home-empty-hint">Importa una playlist para verla aquí</div>';
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

  // ─ Library shelf ─
  const libShelf = document.getElementById('home-library-shelf');
  if (libShelf) {
    if (library.length === 0) {
      libShelf.innerHTML = '<div class="home-empty-hint">Importa canciones para verlas aquí</div>';
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

  // ─ Favorites shelf ─
  const favShelf = document.getElementById('home-favorites-shelf');
  if (favShelf) {
    const favTracks = favorites.map(id => findTrackById(id)).filter(Boolean);
    if (favTracks.length === 0) {
      favShelf.innerHTML = '<div class="home-empty-hint">Marca canciones como favoritas</div>';
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

/* Track recently played — stored in localStorage */
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

/* ══════════════════════════════════════
   EVENTS
══════════════════════════════════════ */
function setupEventListeners() {
  dom.btnMinimize.addEventListener('click', () => window.nofuf.minimize());
  dom.btnMaximize.addEventListener('click', () => window.nofuf.maximize());
  dom.btnClose.addEventListener('click',    () => window.nofuf.close());
  if (dom.btnReload) dom.btnReload.addEventListener('click', () => window.nofuf.reload());

  // Atajos de teclado: Ctrl+R y F5 para reiniciar la app
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

  // Home section "Ver todo" buttons
  document.getElementById('home-see-all-playlists')?.addEventListener('click', () => showView('queue'));
  document.getElementById('home-see-all-library')?.addEventListener('click', () => showView('library'));
  document.getElementById('home-see-all-favorites')?.addEventListener('click', () => showView('favorites'));

  dom.btnImportFiles.addEventListener('click',  importFiles);
  dom.btnImportFolder.addEventListener('click', importFolder);
  dom.btnImportFiles2.addEventListener('click', importFiles);

  dom.urlAddBtn.addEventListener('click', handleYouTubeAdd);
  dom.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleYouTubeAdd(); });
  dom.spUrlAddBtn.addEventListener('click', handleSpotifyAdd);
  dom.spUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSpotifyAdd(); });

  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnNext.addEventListener('click', playNext);
  dom.btnPrev.addEventListener('click', playPrev);

  // Transport shuffle/repeat (player bar)
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

  // Queue view shuffle/repeat pills
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

  // Clear library button
  const btnClearLibrary = document.getElementById('btn-clear-library');
  if (btnClearLibrary) {
    btnClearLibrary.addEventListener('click', () => {
      if (!library.length) return showToast('La biblioteca ya está vacía');
      if (!confirm(`¿Eliminar las ${library.length} canciones de la biblioteca?\nEsto no borra los archivos de tu disco.`)) return;
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

  audioPlayer.addEventListener('timeupdate', () => {
    if (!audioPlayer.duration) return;
    const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    dom.progressFill.style.width = `${pct}%`;
    dom.progressThumb.style.left = `${pct}%`;
    dom.timeCurrent.textContent  = formatTime(audioPlayer.currentTime);
    // Crossfade
    if (settings.crossfade && audioPlayer.duration > 0) {
      const remaining = audioPlayer.duration - audioPlayer.currentTime;
      const fd = settings.crossfadeDuration;
      if (remaining <= fd && remaining > 0) {
        const vol = (remaining / fd) * currentVolume;
        audioPlayer.volume = Math.max(0, linearToAudioVolume(vol));
        // Trigger next track slightly early so it fades in
        if (remaining <= fd * 0.15 && !audioPlayer._crossfadeTriggered) {
          audioPlayer._crossfadeTriggered = true;
          playNext();
        }
      } else {
        audioPlayer._crossfadeTriggered = false;
      }
    }
  });
  audioPlayer.addEventListener('loadedmetadata', () => {
    dom.timeTotal.textContent = formatTime(audioPlayer.duration);
  });
  audioPlayer.addEventListener('ended', () => {
    if (isRepeat) { audioPlayer.currentTime = 0; audioPlayer.play().catch(()=>{}); }
    else if (settings.autoplay !== false) playNext();
  });
  audioPlayer.addEventListener('play',  () => { updateSpinArt(true);  });
  audioPlayer.addEventListener('pause', () => { updateSpinArt(false); });

  // Drag & drop
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop',     e => e.preventDefault());
  dom.sidebar.addEventListener('dragenter', () => dom.dropOverlay.classList.add('active'));
  dom.dropOverlay.addEventListener('dragleave', () => dom.dropOverlay.classList.remove('active'));
  dom.dropOverlay.addEventListener('drop', async e => {
    dom.dropOverlay.classList.remove('active');
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).map(f => f.path);
    if (files.length) { showLoading('Procesando archivos…'); await processFilePaths(files); hideLoading(); }
  });

  // Lyrics
  dom.lyricsClose.addEventListener('click', closeLyricsPanel);

  // Lyrics toggle button — abre con 1a pulsación, cierra con 2a (igual que la X)
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

  // ── Single sidebar toggle button (en titlebar) ──
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

  // Romaji button — toggles search mode and re-fetches lyrics
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


  dom.barFavBtn.addEventListener('click', () => {
    if (currentIndex < 0 || !queue[currentIndex]) return;
    toggleFavorite(queue[currentIndex]);
  });

  // Playlist hero
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

  // Clear all tracks from playlist
  const playlistClearBtn = document.getElementById('playlist-clear-btn');
  if (playlistClearBtn) {
    playlistClearBtn.addEventListener('click', () => {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (!pl || !pl.tracks.length) return showToast('La playlist ya está vacía');
      if (!confirm(`¿Quitar las ${pl.tracks.length} canciones de la playlist "${pl.name}"?`)) return;
      pl.tracks = [];
      savePlaylists();
      renderPlaylistView(pl);
      showToast('Canciones eliminadas de la playlist');
    });
  }

  // New playlist modal
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

  // Edit track modal
  dom.modalEditClose.addEventListener('click', closeEditModal);
  dom.modalEditCancel.addEventListener('click', closeEditModal);
  // El modal de edición solo se cierra con la X o con Cancelar, no al hacer clic fuera
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

  // Settings modal
  dom.modalSettingsClose.addEventListener('click', closeSettingsModal);
  dom.modalSettingsCancel.addEventListener('click', closeSettingsModal);
  dom.modalSettingsBackdrop.addEventListener('click', e => { if (e.target === dom.modalSettingsBackdrop) closeSettingsModal(); });
  dom.modalSettingsSave.addEventListener('click', saveSettingsFromModal);
  // Settings live previews
  dom.settingDefaultVolume.addEventListener('input', () => {
    dom.settingDefaultVolumeVal.textContent = dom.settingDefaultVolume.value + '%';
  });
  dom.settingCrossfadeDuration.addEventListener('input', () => {
    dom.settingCrossfadeDurationVal.textContent = dom.settingCrossfadeDuration.value + 's';
  });
  dom.settingCrossfade.addEventListener('change', () => {
    dom.crossfadeDurationRow.style.display = dom.settingCrossfade.checked ? '' : 'none';
  });
  dom.settingLyricsSize.addEventListener('input', () => {
    dom.settingLyricsSizeVal.textContent = dom.settingLyricsSize.value + 'px';
  });
  document.querySelectorAll('.color-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-pick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.documentElement.style.setProperty('--accent', btn.dataset.color);
    });
  });

  // Context menu
  document.addEventListener('click', e => {
    if (!dom.ctxMenu.contains(e.target)) closeCtxMenu();
  });
  dom.ctxEdit.addEventListener('click', () => {
    if (ctxTrack) openEditModal(ctxTrack);
    closeCtxMenu();
  });
  dom.ctxFav.addEventListener('click', () => {
    if (ctxTrack) toggleFavorite(ctxTrack);
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

/* ── Spin art ── */
function updateSpinArt(playing) {
  if (!settings.spinArt) return;
  if (playing) {
    dom.artImage.classList.add('spinning');
    dom.artImage.classList.remove('paused');
  } else {
    dom.artImage.classList.add('paused');
  }
}

/* ── Generic slider ── */
function setupSlider(trackEl, onChange) {
  const getPct = e => {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };
  trackEl.addEventListener('mousedown', e => {
    onChange(getPct(e));
    const onMove = ev => onChange(getPct(ev));
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

/* ══════════════════════════════════════
   IMPORT
══════════════════════════════════════ */
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

/* ══════════════════════════════════════
   YOUTUBE
══════════════════════════════════════ */
function isYouTubePlaylistUrl(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    // A playlist URL has a list= param and is NOT a single video (/watch without v= being the only thing)
    // If it has both v= and list=, we treat it as a playlist import
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


async function handleYouTubeAdd() {
  const url = dom.urlInput.value.trim();
  if (!url) return;

  if (isYouTubePlaylistUrl(url)) {
    await handleYouTubePlaylistImport(url);
    return;
  }

  dom.urlAddBtn.disabled = true;
  setYouTubeStatus('loading', 'Resolviendo…');

  const result = await window.nofuf.resolveYouTube(url);
  dom.urlAddBtn.disabled = false;

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

async function handleSpotifyAdd() {
  const url = dom.spUrlInput.value.trim();
  if (!url) return;
  if (!isSpotifyPlaylistUrl(url)) {
    setSpotifyStatus('error', 'Introduce una URL de playlist de Spotify válida.');
    return;
  }
  await handleSpotifyPlaylistImport(url);
}

function setSpotifyStatus(type, msg) {
  dom.spUrlStatus.className = `url-status ${type}`;
  dom.spUrlStatus.textContent = msg;
}

async function handleSpotifyPlaylistImport(url) {
  const playlistId = extractSpotifyPlaylistId(url);
  if (!playlistId) {
    setSpotifyStatus('error', 'URL de Spotify inválida.');
    return;
  }

  dom.spUrlAddBtn.disabled = true;
  dom.spUrlInput.value = '';
  setSpotifyStatus('loading', 'Conectando con Spotify…');
  showLoading('Importando playlist de Spotify…');

  let result;
  try {
    // Delegar completamente al proceso principal (Node.js, sin CORS ni restricciones)
    result = await window.nofuf.importSpotifyPlaylist(playlistId);
  } catch(e) {
    result = { type: 'error', message: e.message };
  }

  dom.spUrlAddBtn.disabled = false;
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

  // Crear entrada de playlist
  const pl = {
    id:     'sp-pl-' + playlistId + '-' + Date.now(),
    name:   playlistTitle,
    cover:  null,
    tracks: [],
  };

  // Portada desde la primera canción con cover
  const firstWithCover = spTracks.find(t => t.cover);
  if (firstWithCover?.cover) {
    pl.cover = await window.nofuf.fetchImageBase64(firstWithCover.cover).catch(() => null);
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

  // ── Pre-resolución en background (estilo spotdl) ──────────────────────
  // Busca el videoId de YouTube para cada track de Spotify en segundo plano,
  // sin bloquear la UI. Así al reproducir ya están listos y no hay espera.
  preResolveSpotifyTracks(newTracks, pl.id);
}

async function preResolveSpotifyTracks(tracks, playlistId) {
  let resolved = 0;
  const total = tracks.length;
  // Procesar en lotes de 3 para no saturar yt-dlp
  const BATCH = 3;
  for (let i = 0; i < tracks.length; i += BATCH) {
    const batch = tracks.slice(i, i + BATCH);
    await Promise.all(batch.map(async (track) => {
      if (!track.lazy || track.videoId) return; // ya resuelto
      try {
        const res = await window.nofuf.resolveSpotifyToYouTube(track.title, track.artist);
        if (res?.type === 'success' && res.videoId) {
          track.videoId = res.videoId;
          track.ytUrl   = `https://www.youtube.com/watch?v=${res.videoId}`;
          // El track sigue lazy=true hasta que se resuelva el stream al reproducir
        }
      } catch(e) {
        // Silencioso: si falla, se resolverá al reproducir como antes
      }
      resolved++;
    }));
    // Guardar progreso cada lote y actualizar UI
    saveLibrary();
    const pct = Math.round((resolved / total) * 100);
    if (pct < 100) {
      setSpotifyStatus('loading', `Preparando playlist… ${resolved}/${total}`);
    } else {
      setSpotifyStatus('success', `✓ ${total} canciones listas`);
      setTimeout(() => setSpotifyStatus('', ''), 4000);
    }
    renderPlaylistView(playlists.find(p => p.id === playlistId));
  }
}


async function handleYouTubePlaylistImport(url) {
  dom.urlAddBtn.disabled = true;
  setYouTubeStatus('loading', 'Leyendo playlist…');
  showLoading('Importando playlist de YouTube…');

  const result = await window.nofuf.resolveYouTubePlaylist(url);
  dom.urlAddBtn.disabled = false;
  hideLoading();

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

  // Create playlist entry
  const pl = {
    id:     'yt-pl-' + Date.now(),
    name:   playlistTitle,
    cover:  null,
    tracks: [],
  };

  // Fetch cover from first video with a valid thumbnail
  const firstWithThumb = videos.find(v => v.thumbnail);
  if (firstWithThumb?.thumbnail) {
    pl.cover = await window.nofuf.fetchImageBase64(firstWithThumb.thumbnail).catch(() => null);
  }

  // Build lightweight track stubs (no stream URL yet — resolved lazily on play)
  const newTracks = [];
  for (const v of videos) {
    const existing = library.find(t => t.videoId === v.id);
    if (existing) {
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
      thumbnail: v.thumbnail || '',
      lazy:      true,
    };
    newTracks.push(track);
    pl.tracks.push(track.id);
  }

  addTracksToLibrary(newTracks);
  playlists.push(pl);
  savePlaylists();
  renderSidebarPlaylists();
  renderLibraryUI();

  const total = pl.tracks.length;
  setYouTubeStatus('success', `✓ ${total} canciones importadas`);
  showToast(`"${playlistTitle}" importada · ${total} canciones`);
  setTimeout(() => setYouTubeStatus('', ''), 6000);

  // Open the newly created playlist
  openPlaylist(pl.id);

  // Pre-fetch cover images in background
  preFetchYouTubeThumbnails(newTracks);

}

/* Pre-fetch YouTube thumbnail images and store as base64 cover in background */
async function preFetchYouTubeThumbnails(tracks) {
  const BATCH = 5;
  for (let i = 0; i < tracks.length; i += BATCH) {
    const batch = tracks.slice(i, i + BATCH);
    await Promise.all(batch.map(async (track) => {
      if (track.cover || !track.thumbnail) return;
      try {
        const base64 = await window.nofuf.fetchImageBase64(track.thumbnail).catch(() => null);
        if (base64) {
          track.cover = base64;
          const lt = library.find(t => t.id === track.id);
          if (lt) lt.cover = base64;
          const qt = queue.find(t => t.id === track.id);
          if (qt) qt.cover = base64;
        }
      } catch(e) { /* silencioso */ }
    }));
    saveLibrary();
    updateQueueUI();
    renderLibraryUI();
    renderFavoritesUI();
    if (currentPlaylistId) {
      const activePl = playlists.find(p => p.id === currentPlaylistId);
      if (activePl) renderPlaylistView(activePl);
    }
  }
}

/* ══════════════════════════════════════
   PLAYBACK
══════════════════════════════════════ */
async function playTrack(index) {
  if (index < 0 || index >= queue.length) return;
  currentIndex = index;
  const t = queue[currentIndex];
  addToRecents(t.id);

  dom.trackTitle.textContent  = t.title;
  dom.trackArtist.textContent = t.artist;
  dom.trackSource.textContent = t.type === 'youtube' ? 'YouTube' : 'Local';
  dom.artImage.src = t.cover || '';
  dom.artImage.style.display   = t.cover ? 'block' : 'none';
  dom.artPlaceholder.style.display = t.cover ? 'none' : 'flex';

  dom.barTitle.textContent  = t.title;
  dom.barArtist.textContent = t.artist;
  dom.barArt.style.backgroundImage = t.cover ? `url(${t.cover})` : 'none';
  dom.barArt.style.backgroundSize = 'cover';
  dom.barArt.style.backgroundPosition = 'center';

  dom.lyricsArt.src = t.cover || '';
  dom.lyricsTrackName.textContent  = t.title;
  dom.lyricsArtistName.textContent = t.artist;

  // ── MPRIS / Media Session metadata (Chromium xesam:title, xesam:artist, xesam:album) ──
  if ('mediaSession' in navigator) {
    const artwork = t.cover
      ? [{ src: t.cover, sizes: '512x512', type: t.cover.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  t.title  || '',
      artist: t.artist || '',
      album:  t.album  || '',
      artwork,
    });
    navigator.mediaSession.playbackState = 'playing';
  }

  // Solo actualizar letras si el panel ya estaba abierto manualmente por el usuario
  if (dom.lyricsPanel && dom.lyricsPanel.classList.contains('open')) fetchLyrics(t);

  updateFavBtn(t.id);
  updatePlaybackUI();
  updateQueueUI();

  // Reset volume if crossfade was lowering it
  audioPlayer.volume = linearToAudioVolume(currentVolume);

  showLoading('Abriendo stream…');

  // Lazy tracks: resolve stream URL on first play
  if (t.type === 'youtube' && t.lazy && (!t.url || !t.url.startsWith('http'))) {
    // Spotify playlist tracks: search YouTube first to get a videoId
    if (t.spMeta && !t.videoId) {
      setYouTubeStatus('loading', `Buscando "${t.spMeta.title}"…`);

      // Limpiar el título de paréntesis secundarios para mejorar la búsqueda
      const cleanTitle = t.spMeta.title.replace(/\s*[\(\[](feat\.|ft\.|with\s|prod\.|remix|version|remastered|explicit)[^\)\]]*[\)\]]/gi, '').trim();
      // Usar solo el primer artista para la query principal
      const primaryArtist = t.spMeta.artist.split(/[,&\/]/)[0].trim();

      // Intentar varias queries en orden de precisión
      const queries = [
        `${primaryArtist} - ${cleanTitle}`,
        `${primaryArtist} ${cleanTitle} audio`,
        `${t.spMeta.artist} ${t.spMeta.title}`,
      ];

      let bestResult = null;
      for (const ytQuery of queries) {
        const searchRes = await window.nofuf.searchYouTube(ytQuery);
        if (searchRes.type === 'error' || !searchRes.results?.length) continue;

        // Scoring mejorado: evalúa cada resultado según múltiples criterios
        const titleLow     = cleanTitle.toLowerCase();
        const origTitleLow = t.spMeta.title.toLowerCase();
        const artistLow    = primaryArtist.toLowerCase();
        const allArtistsLow = t.spMeta.artist.toLowerCase();

        let best = null;
        let bestScore = -1;

        for (const r of searchRes.results) {
          const rt = (r.title || '').toLowerCase();
          const ru = (r.uploader || '').toLowerCase();
          let score = 0;

          // Coincidencia de título (limpio o completo)
          if (rt.includes(titleLow))           score += 4;
          else if (rt.includes(origTitleLow))  score += 3;

          // Coincidencia de artista
          if (rt.includes(artistLow) || ru.includes(artistLow)) score += 3;
          // Artistas adicionales (feat.)
          allArtistsLow.split(/[,&\/]/).forEach(a => {
            const aClean = a.trim();
            if (aClean && (rt.includes(aClean) || ru.includes(aClean))) score += 1;
          });

          // Penalizar vídeos claramente distintos
          if (rt.includes('cover')    && !origTitleLow.includes('cover'))   score -= 3;
          if (rt.includes('karaoke'))                                        score -= 5;
          if (rt.includes('tutorial'))                                       score -= 5;
          if (rt.includes('reaction'))                                       score -= 5;
          if (rt.includes('live')     && !origTitleLow.includes('live'))     score -= 1;
          if (rt.includes('remix')    && !origTitleLow.includes('remix'))    score -= 2;

          // Bonificación por canales oficiales
          if (ru.includes('vevo') || ru.includes('oficial') || ru.includes('official')) score += 2;
          if (ru.includes(artistLow))                                        score += 2;

          if (score > bestScore) { bestScore = score; best = r; }
        }

        if (best && bestScore >= 0) { bestResult = best; break; }
        if (best && !bestResult) bestResult = best;
      }

      if (!bestResult) {
        // Último recurso: búsqueda genérica sin filtros
        const lastResort = await window.nofuf.searchYouTube(`${t.spMeta.artist} ${t.spMeta.title}`);
        if (lastResort.type === 'error' || !lastResort.results?.length) {
          setYouTubeStatus('error', 'No encontrado en YouTube');
          showToast(`⚠ No encontrado: ${t.spMeta.title}`);
          return;
        }
        bestResult = lastResort.results[0];
      }

      t.videoId = bestResult.id;
      t.ytUrl   = `https://www.youtube.com/watch?v=${bestResult.id}`;
    }

    setYouTubeStatus('loading', 'Resolviendo stream…');
    const resolved = await window.nofuf.resolveYouTube(t.ytUrl || `https://www.youtube.com/watch?v=${t.videoId}`);
    if (resolved.type === 'error') {
      hideLoading();
      setYouTubeStatus('error', resolved.message);
      showToast('Error al resolver el stream: ' + resolved.message);
      return;
    }
    t.url = resolved.streamUrl;
    t.lazy = false;
    if (!t.cover && resolved.thumbnail) {
      t.cover = await window.nofuf.fetchImageBase64(resolved.thumbnail).catch(() => null);
      if (t.cover) {
        dom.artImage.src = t.cover;
        dom.artImage.style.display = 'block';
        dom.artPlaceholder.style.display = 'none';
        dom.barArt.style.backgroundImage = `url(${t.cover})`;
        dom.barArt.style.backgroundSize = 'cover';
        dom.barArt.style.backgroundPosition = 'center';
      }
    }
    saveLibrary();
    setYouTubeStatus('', '');
  }

  audioPlayer.src = t.url;
  audioPlayer.load();
  audioPlayer.play()
    .then(() => { isPlaying = true; updatePlaybackUI(); hideLoading(); })
    .catch(err => { hideLoading(); showToast('Error cargando el stream.'); console.error(err); });
}

function togglePlay() {
  if (currentIndex === -1 && queue.length > 0) { playTrack(0); return; }
  if (currentIndex === -1) return;
  if (isPlaying) { audioPlayer.pause(); isPlaying = false; }
  else { audioPlayer.play().catch(() => {}); isPlaying = true; }
  updatePlaybackUI();
}
function playNext() {
  if (!queue.length) return;
  playTrack(isShuffle ? Math.floor(Math.random() * queue.length) : (currentIndex + 1) % queue.length);
}
function playPrev() {
  if (!queue.length) return;
  if (audioPlayer.currentTime > 4) { audioPlayer.currentTime = 0; return; }
  playTrack((currentIndex - 1 + queue.length) % queue.length);
}
/* Convert linear 0-1 slider position to perceptual loudness.
   Uses a power curve (x^3) so that low numbers (8, 10, 15) feel
   proportionally quiet instead of unexpectedly loud.
   Matches the loudness curve used by Spotify / VLC. */
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

/* ══════════════════════════════════════
   DELETE TRACK
══════════════════════════════════════ */
function deleteTrack(track, context) {
  // Remove from library
  const libIdx = library.findIndex(t => t.id === track.id);
  if (libIdx >= 0) { library.splice(libIdx, 1); saveLibrary(); }
  // Remove from favorites
  const favIdx = favorites.indexOf(track.id);
  if (favIdx >= 0) { favorites.splice(favIdx, 1); saveFavorites(); }
  // Remove from all playlists
  playlists.forEach(pl => {
    const i = pl.tracks.indexOf(track.id);
    if (i >= 0) pl.tracks.splice(i, 1);
  });
  savePlaylists();
  // Remove from queue
  const qIdx = queue.findIndex(t => t.id === track.id);
  if (qIdx >= 0) {
    queue.splice(qIdx, 1);
    if (currentIndex === qIdx) {
      if (queue.length) playTrack(qIdx >= queue.length ? 0 : qIdx);
      else { currentIndex = -1; audioPlayer.src = ''; isPlaying = false; updatePlaybackUI(); resetNowPlaying(); }
    } else if (currentIndex > qIdx) { currentIndex--; }
  }
  // Refresh UIs
  updateQueueUI(); renderLibraryUI(); renderFavoritesUI();
  renderSidebarPlaylists();
  if (context === 'playlist') {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (pl) renderPlaylistView(pl);
  }
  showToast('Canción eliminada');
}

/* ══════════════════════════════════════
   EDIT TRACK
══════════════════════════════════════ */
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

  // Update in library
  const lt = library.find(t => t.id === editingTrackId);
  if (lt) {
    if (newTitle)  lt.title  = newTitle;
    if (newArtist) lt.artist = newArtist;
    if (newCover)  lt.cover  = newCover;
    saveLibrary();
  }
  // Update in queue
  const qt = queue.find(t => t.id === editingTrackId);
  if (qt) {
    if (newTitle)  qt.title  = newTitle;
    if (newArtist) qt.artist = newArtist;
    if (newCover)  qt.cover  = newCover;
  }
  // If currently playing, update display
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

/* ══════════════════════════════════════
   LIBRARY
══════════════════════════════════════ */
function addTracksToLibrary(tracks) {
  tracks.forEach(t => {
    if (!library.find(l => l.id === t.id)) library.push(t);
  });
  saveLibrary();
}
function findTrackById(id) {
  return library.find(t => t.id === id) || queue.find(t => t.id === id) || null;
}

/* ══════════════════════════════════════
   FAVORITES
══════════════════════════════════════ */
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
  renderFavoritesUI();
  document.querySelectorAll('.qi-fav-btn').forEach(btn => {
    if (btn.dataset.id === track.id) {
      const isFav = favorites.includes(track.id);
      btn.classList.toggle('active', isFav);
      btn.querySelector('svg').setAttribute('fill', isFav ? 'currentColor' : 'none');
    }
  });
}
function updateFavBtn(id) {
  const isFav = favorites.includes(id);
  dom.barFavBtn.classList.toggle('active', isFav);
}

/* ══════════════════════════════════════
   SETTINGS MODAL
══════════════════════════════════════ */
function openSettingsModal() {
  // Populate from current settings
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
  dom.settingLyricsSize.value = settings.lyricsSize || 13;
  dom.settingLyricsSizeVal.textContent = (settings.lyricsSize || 13) + 'px';
  if (dom.settingLyricsFont) dom.settingLyricsFont.value = settings.lyricsFont || 'inherit';
  dom.settingMinimizeTray.checked = settings.minimizeTray !== false;
  dom.settingCloseTray.checked = settings.closeTray !== false;
  // Color picks
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
  settings.lyricsSize = parseInt(dom.settingLyricsSize.value);
  settings.lyricsFont = dom.settingLyricsFont ? dom.settingLyricsFont.value : 'inherit';
  settings.minimizeTray = dom.settingMinimizeTray.checked;
  settings.closeTray = dom.settingCloseTray.checked;
  saveSettings();
  applySettings();
  // Apply live changes (sin tocar el volumen actual)
  const lt = document.querySelector('.lyrics-text');
  if (lt) {
    lt.style.fontSize = settings.lyricsSize + 'px';
    if (settings.lyricsFont) lt.style.fontFamily = settings.lyricsFont;
  }
  closeSettingsModal();
  showToast('Configuración guardada');
}

/* ══════════════════════════════════════
   PLAYLISTS
══════════════════════════════════════ */
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
  dom.playlistHeroCount.textContent = `${pl.tracks.length} cancion${pl.tracks.length !== 1 ? 'es' : ''}`;
  const existingImg = dom.playlistHeroArt.querySelector('img:not([style])');
  if (existingImg) existingImg.remove();
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
  dom.playlistHeroCount.textContent = `${tracks.length} cancion${tracks.length !== 1 ? 'es' : ''}`;
  dom.playlistEmpty.style.display = tracks.length ? 'none' : 'flex';
  dom.playlistTrackList.innerHTML = '';
  tracks.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'playlist',
      onPlay: () => {
        queue = [...tracks];
        updateQueueUI(); showView('queue'); playTrack(i);
      },
    });
    dom.playlistTrackList.appendChild(el);
  });
}
function renderSidebarPlaylists() {
  dom.playlistListSidebar.innerHTML = '';
  playlists.forEach(pl => {
    const btn = document.createElement('div');
    btn.className = `sb-playlist${currentPlaylistId === pl.id ? ' active' : ''}`;
    btn.dataset.id = pl.id;
    const thumbHtml = pl.cover
      ? `<div class="sb-playlist-thumb"><img src="${pl.cover}"></div>`
      : `<div class="sb-playlist-thumb"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
    btn.innerHTML = `${thumbHtml}<span class="sb-playlist-name">${escapeHTML(pl.name)}</span>`;
    btn.addEventListener('click', () => openPlaylist(pl.id));
    dom.playlistListSidebar.appendChild(btn);
  });
}

/* ══════════════════════════════════════
   RENDER LISTS
══════════════════════════════════════ */
function updateQueueUI() {
  dom.queueList.innerHTML = '';
  dom.queueEmpty.style.display = queue.length ? 'none' : 'flex';
  queue.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
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
    dom.queueList.appendChild(el);
  });
}

function renderLibraryUI() {
  dom.libraryList.innerHTML = '';
  dom.libraryEmpty.style.display = library.length ? 'none' : 'flex';
  library.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'library',
      onPlay: () => {
        if (!queue.find(q => q.id === t.id)) queue.push({...t});
        const qi = queue.findIndex(q => q.id === t.id);
        updateQueueUI(); playTrack(qi);
      },
    });
    dom.libraryList.appendChild(el);
  });
}

function renderFavoritesUI() {
  const favTracks = favorites.map(id => findTrackById(id)).filter(Boolean);
  dom.favoritesList.innerHTML = '';
  dom.favoritesEmpty.style.display = favTracks.length ? 'none' : 'flex';
  favTracks.forEach((t, i) => {
    const el = buildTrackItem(t, i, {
      context: 'favorites',
      onPlay: () => {
        if (!queue.find(q => q.id === t.id)) queue.push({...t});
        const qi = queue.findIndex(q => q.id === t.id);
        updateQueueUI(); playTrack(qi);
      },
    });
    dom.favoritesList.appendChild(el);
  });
}

/* ── Build a track row ── */
function buildTrackItem(t, i, { isActive = false, onPlay, onRemove, context = '' } = {}) {
  const el = document.createElement('div');
  el.className = `queue-item${isActive ? ' active' : ''}`;
  const isFav = favorites.includes(t.id);
  const thumbSrc = t.cover || t.thumbnail || null;
  const thumb = thumbSrc
    ? `<img src="${thumbSrc}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
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
    <span class="qi-type-badge ${t.type}">${t.type === 'youtube' ? 'YT' : 'MP3'}</span>
    <span class="${durClass}">${dur}</span>
    <button class="qi-fav-btn${isFav ? ' active' : ''}" data-id="${t.id}" title="Favorito">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
    </button>
    <button class="qi-menu-btn" title="Más opciones">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
    </button>`;

  el.addEventListener('click', e => {
    if (e.target.closest('.qi-menu-btn') || e.target.closest('.qi-fav-btn')) return;
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

/* ══════════════════════════════════════
   CONTEXT MENU
══════════════════════════════════════ */
function openCtxMenu(e, track, context, onRemove) {
  ctxTrack   = track;
  ctxContext = context;

  // Build playlist options
  dom.ctxPlaylistOpts.innerHTML = '';
  playlists.forEach(pl => {
    const btn = document.createElement('div');
    btn.className = 'ctx-playlist-item';
    const thumbHtml = pl.cover
      ? `<div class="ctx-pl-thumb"><img src="${pl.cover}"></div>`
      : `<div class="ctx-pl-thumb"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/></svg></div>`;
    btn.innerHTML = `${thumbHtml}<span>${escapeHTML(pl.name)}</span>`;
    btn.addEventListener('click', () => { addTrackToPlaylist(pl.id, track); closeCtxMenu(); });
    dom.ctxPlaylistOpts.appendChild(btn);
  });

  // Fav label
  const favSpan = dom.ctxFav.querySelector('span');
  if (favSpan) favSpan.textContent = favorites.includes(track.id) ? 'Quitar de favoritos' : 'Añadir a favoritos';

  const x = Math.min(e.clientX, window.innerWidth  - 210);
  const y = Math.min(e.clientY, window.innerHeight - 320);
  dom.ctxMenu.style.left = x + 'px';
  dom.ctxMenu.style.top  = y + 'px';
  dom.ctxMenu.classList.add('open');
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

/* ══════════════════════════════════════
   LYRICS — Multi-source via main process
══════════════════════════════════════ */
function openLyricsPanel() {
  if (!dom.lyricsPanel) return;
  lyricsPanelOpen = true;
  dom.lyricsPanel.style.width = ''; // dejar que .open + var(--lp) controlen el ancho
  dom.lyricsPanel.classList.add('open');
  const btn = document.getElementById('btn-lyrics-toggle');
  if (btn) btn.classList.add('active');
  if (currentIndex >= 0 && queue[currentIndex]) fetchLyrics(queue[currentIndex]);
}
function toggleLyricsPanel() { // kept for any legacy call
  if (!dom.lyricsPanel) return;
  if (dom.lyricsPanel.classList.contains('open')) closeLyricsPanel();
  else openLyricsPanel();
}
function closeLyricsPanel() {
  if (!dom.lyricsPanel) return;
  lyricsPanelOpen = false;
  dom.lyricsPanel.style.width = ''; // limpiar ancho inline para que CSS tome el control (width:0)
  dom.lyricsPanel.classList.remove('open');
  const btn = document.getElementById('btn-lyrics-toggle');
  if (btn) btn.classList.remove('active');
}

function showLyricsError(track) {
  dom.lyricsSourceBar.style.display = 'none';
  dom.lyricsBody.innerHTML = `<div class="lyrics-error">
    No se encontró letra para esta canción.<br><br>
    <strong>${escapeHTML(track.title)}</strong><br>
    <em>${escapeHTML(track.artist)}</em><br><br>
    Prueba a buscarla manualmente en Genius o AZLyrics.
  </div>`;
}

/* ══════════════════════════════════════
   UI HELPERS
══════════════════════════════════════ */
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
  // Register media session action handlers once
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
  dom.trackArtist.textContent = 'Tu reproductor híbrido';
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
  dom.urlStatus.className = `url-status ${type}`;
  dom.urlStatus.textContent = msg;
}

function showLoading(text) { dom.loadingText.textContent = text; dom.loadingOverlay.style.display = 'flex'; }
function hideLoading()     { dom.loadingOverlay.style.display = 'none'; }

let toastTimer = null;
function showToast(msg) {
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
// Para lyrics: decodifica entidades y devuelve seguro
function escapeLyricsHTML(str = '') {
  return decodeEntities(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
/* ══════════════════════════════════════
   RESIZABLE SIDEBARS
══════════════════════════════════════ */
(function setupResizablePanels() {
  // ─── Left sidebar (resize desactivado) ───

  // ─── Lyrics panel (right sidebar) ───
  const lyricsEl = document.getElementById('lyrics-panel');
  const lyricsHandle = document.getElementById('lyrics-resize-handle');
  if (lyricsEl && lyricsHandle) {
    let dragging = false, startX = 0, startW = 0;
    lyricsHandle.addEventListener('mousedown', e => {
      if (!lyricsEl.classList.contains('open')) return;
      dragging = true;
      startX = e.clientX;
      startW = lyricsEl.offsetWidth;
      lyricsHandle.classList.add('dragging');
      lyricsEl.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = startX - e.clientX; // panel grows leftward
      const newW = Math.max(180, startW + delta);
      lyricsEl.style.width = newW + 'px';
      document.documentElement.style.setProperty('--lp', newW + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      lyricsHandle.classList.remove('dragging');
      lyricsEl.style.transition = '';
      lyricsEl.style.width = ''; // limpiar inline: CSS usará var(--lp) que ya fue actualizado
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }
})();

/* ═══════════════════════════════════════════════════════════════
   v3 — Downloads · Synced Lyrics · Romaji · Visualizer · Config files
═══════════════════════════════════════════════════════════════ */

/* ── Guardar todo cuando la ventana se oculta/minimiza ── */
if (window.nofuf?.onSaveBeforeHide) {
  window.nofuf.onSaveBeforeHide(() => {
    try { saveSettings(); savePlaylists(); saveLibrary(); saveFavorites(); } catch(e) { /* silencioso */ }
    // Guardar imagen de fondo si hay una activa
    try {
      if (window._nofufApplyBg && window._currentBgDataUrl) {
        // _currentBgDataUrl es local al closure del panel, lo exponemos via window
      }
      if (window._nofufSaveBg) window._nofufSaveBg();
    } catch(e) {}
  });
}

/* ─────────────────────────────────────────────
───────────────────────────────────────────── */
const dom2 = {
  // visualizer
  vizCanvas: document.getElementById('visualizer'),
  // settings nuevos
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
  // viz panel
  // viz view
  vizView: document.getElementById('viz-view'),
  vizIdleHint: document.getElementById('viz-idle-hint'),
  vizTrackTitle: document.getElementById('viz-track-title'),
  vizTrackArtist: document.getElementById('viz-track-artist'),
  vizTrackArt: document.getElementById('viz-track-art'),
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
  // config buttons
  btnExportCfg: document.getElementById('settings-export-config'),
  btnImportCfg: document.getElementById('settings-import-config'),
  btnOpenCfgFolder: document.getElementById('settings-open-config-folder'),
  // downloads
  downloadsPanel: document.getElementById('downloads-panel'),
  downloadsBody:  document.getElementById('downloads-body'),
  downloadsClose: document.getElementById('downloads-close'),
  // ctx
  ctxDownload: document.getElementById('ctx-download'),
};

/* ─────────────────────────────────────────────
   1) EDIT MODAL — sólo cierra con X/Cancelar
───────────────────────────────────────────── */
if (dom.modalEditBackdrop) {
  dom.modalEditBackdrop.addEventListener('click', e => {
    // bloquea cualquier cierre por clic fuera del .modal
    e.stopPropagation();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dom.modalEditBackdrop.classList.contains('open')) {
      // bloqueamos también Escape mientras se edita info
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
}

/* ─────────────────────────────────────────────
   2) SETTINGS — extender open/save sin tocar volumen actual
───────────────────────────────────────────── */
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
  // capturamos el volumen actual ANTES de guardar para garantizar que no salta
  const safeVol = currentVolume;
  if (dom2.settingSyncedLyrics)  settings.syncedLyrics = dom2.settingSyncedLyrics.checked;
  if (dom2.settingDownloadFormat) settings.downloadFormat = dom2.settingDownloadFormat.value;
  if (dom2.settingVizEnabled)    settings.vizEnabled = dom2.settingVizEnabled.checked;
  if (dom2.settingVizStyle)      settings.vizStyle = dom2.settingVizStyle.value;
  if (dom2.settingVizColor)      settings.vizColor = dom2.settingVizColor.value;
  if (dom2.settingVizShadow)     settings.vizShadow = dom2.settingVizShadow.checked;
  if (dom2.settingVizSensitivity) settings.vizSensitivity = parseFloat(dom2.settingVizSensitivity.value);
  // normalize: apply to GainNode immediately
  if (_normGain) _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
  _origSaveSettingsFromModal();
  // RESTAURAR el volumen actual (bug "el volumen se dispara")
  currentVolume = safeVol;
  audioPlayer.volume = isMuted ? 0 : linearToAudioVolume(safeVol);
  setVolume(safeVol);
  applyVizSettings();
  _syncVizPanelControls(); // keep viz panel in sync with settings modal
  if (lyricsPanelOpen && currentIndex >= 0 && _lastLyricsResult) renderLyrics(_lastLyricsResult);
};

/* Sensibilidad live label */
if (dom2.settingVizSensitivity) {
  dom2.settingVizSensitivity.addEventListener('input', () => {
    if (dom2.settingVizSensitivityVal) dom2.settingVizSensitivityVal.textContent = dom2.settingVizSensitivity.value + '×';
  });
}

/* Pick download dir */
if (dom2.settingPickDownloadDir) {
  dom2.settingPickDownloadDir.addEventListener('click', async () => {
    const dir = await window.nofuf.downloadPickFolder();
    if (dir) {
      settings.downloadDir = dir;
      if (dom2.settingDownloadDirDisplay) dom2.settingDownloadDirDisplay.textContent = dir;
    }
  });
}

/* ─────────────────────────────────────────────
   3) CONFIG — exportar / importar / abrir carpeta
───────────────────────────────────────────── */
function gatherFullConfig() {
  // recoge variables CSS personalizadas leyendo del documentElement
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
    if (k === '--base-font-size') {
      // font-size is not a CSS variable, apply directly
      document.documentElement.style.fontSize = v;
    } else {
      document.documentElement.style.setProperty(k, v);
    }
  });
}

if (dom2.btnExportCfg) dom2.btnExportCfg.addEventListener('click', async () => {
  const data = gatherFullConfig();
  const txt = JSON.stringify(data, null, 2);
  // guarda en Documents y abre diálogo para compartir
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

/* ─────────────────────────────────────────────
   4) DOWNLOADS — UI y lógica
───────────────────────────────────────────── */
const downloads = new Map(); // id -> {el, track}

function openDownloadsPanel() { dom2.downloadsPanel.classList.add('open'); }
function closeDownloadsPanel() { dom2.downloadsPanel.classList.remove('open'); }
if (dom2.downloadsClose) dom2.downloadsClose.addEventListener('click', closeDownloadsPanel);

// Botón flotante
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
  if (data.status === 'done') { el.classList.add('done'); el.querySelector('.dl-status').textContent = '✓ completado'; }
  if (data.status === 'error') { el.classList.add('error'); el.querySelector('.dl-status').textContent = '✗ ' + (data.error||'error'); }
}

if (window.nofuf?.onDownloadProgress) {
  window.nofuf.onDownloadProgress((data) => {
    updateDownloadRow(data.id, data);
    if (data.status === 'done') {
      showToast('Descarga completa');
      setTimeout(() => { downloads.delete(data.id); refreshDownloadsEmpty(); /* keep row visible until reload */ }, 60000);
    }
  });
}

async function downloadTrack(track) {
  if (!settings.downloadDir) {
    settings.downloadDir = await window.nofuf.downloadDefaultFolder();
    saveSettings();
  }
  let dir = settings.downloadDir;
  if (!dir) { showToast('Elige carpeta de descarga en Configuración'); return; }
  const id = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
  addDownloadRow(id, track);
  openDownloadsPanel();
  try {
    let res;
    if (track.type === 'youtube') {
      res = await window.nofuf.downloadYouTube({
        id, videoId: track.videoId, ytUrl: track.ytUrl,
        title: track.title, artist: track.artist,
        outDir: dir, format: settings.downloadFormat || 'mp3'
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

/* ─────────────────────────────────────────────
   DESCARGAR PLAYLIST COMPLETA
───────────────────────────────────────────── */
(function initPlaylistDownload() {
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

    // Pre-fill with global settings
    dlDir = settings.downloadDir || '';
    dirDisplay.textContent = dlDir || '(no establecida)';
    formatSel.value = settings.downloadFormat || 'mp3';
    infoDiv.textContent = `Se descargarán ${tracks.length} canción${tracks.length !== 1 ? 'es' : ''} en la carpeta elegida.`;
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

    // Resolve dir
    let dir = dlDir;
    if (!dir) {
      try { dir = await window.nofuf.downloadDefaultFolder(); }
      catch (e) { showToast('No se pudo determinar la carpeta de descarga'); return; }
    }
    if (!dir) { showToast('Elige una carpeta de descarga primero'); return; }

    // Persist chosen dir & format as global settings
    settings.downloadDir = dir;
    settings.downloadFormat = formatSel.value;
    saveSettings();

    closeModal();
    openDownloadsPanel();
    showToast(`Descargando ${tracks.length} canción${tracks.length !== 1 ? 'es' : ''}…`);

    const fmt = formatSel.value || 'mp3';

    // Download sequentially in batches of 3
    const batchSize = 3;
    for (let i = 0; i < tracks.length; i += batchSize) {
      const batch = tracks.slice(i, i + batchSize);
      await Promise.all(batch.map(async track => {
        const id = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        addDownloadRow(id, track);
        try {
          let res;
          if (track.type === 'youtube') {
            res = await window.nofuf.downloadYouTube({
              id, videoId: track.videoId, ytUrl: track.ytUrl,
              title: track.title, artist: track.artist,
              outDir: dir, format: fmt
            });
          } else if (track.path) {
            res = await window.nofuf.downloadLocalFile({
              id, srcPath: track.path, outDir: dir,
              title: track.title, artist: track.artist
            });
          }
          if (res && !res.ok) showToast(`Error: ${track.title} — ${res.error || ''}`);
        } catch (e) {
          showToast(`Error descargando ${track.title}: ${e.message}`);
        }
      }));
    }
  });
})();



/* ─────────────────────────────────────────────
   5) LYRICS — sync
───────────────────────────────────────────── */

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

// fetchLyrics — soporta sync (LRC) + multi-resultado + romaji
async function fetchLyrics(track) {
  dom.lyricsBody.innerHTML = '<div class="lyrics-loading"><div class="spinner"></div><span>Buscando letra…</span></div>';
  dom.lyricsArt.src = track.cover || '';
  dom.lyricsTrackName.textContent  = decodeEntities(track.title);
  dom.lyricsArtistName.textContent = decodeEntities(track.artist);
  dom.lyricsSourceBar.style.display = 'none';
  if (dom.lyricsResultsBar) dom.lyricsResultsBar.style.display = 'none';
  _syncedLines = null; _activeLrcLineIdx = -1;
  try {
    const result = await window.nofuf.fetchLyricsMain({
      title: track.title, artist: track.artist, videoId: track.videoId || null,
      romaji: _romajiActive,
    });
    _lastLyricsResult = result;
    if (result && result.found) renderLyrics(result);
    else showLyricsError(track);
  } catch (err) {
    console.error('[lyrics]', err);
    showLyricsError(track);
  }
}

// Render a single lyrics result (plain or synced)
function renderLyricsContent(entry) {
  const font = settings.lyricsFont || 'inherit';
  const size = settings.lyricsSize || 13;
  dom.lyricsSourceBar.style.display = '';
  dom.lyricsSourceLabel.textContent = 'Fuente: ' + (entry.source || '—');
  _syncedLines = null; _activeLrcLineIdx = -1;
  const useSync = settings.syncedLyrics !== false && !!entry.synced;
  let html;
  if (useSync) {
    _syncedLines = parseLRC(entry.synced);
    html = _syncedLines.map((l, i) =>
      `<span class="lrc-line" data-i="${i}">${escapeLyricsHTML(l.text) || '&nbsp;'}</span>`
    ).join('');
  } else {
    html = escapeLyricsHTML(entry.lyrics);
  }
  dom.lyricsBody.innerHTML = `<div class="lyrics-text" style="font-size:${size}px;font-family:${font}">${html}</div>`;
}

function renderLyrics(result) {
  if (!result || !result.found) return;

  // Build picker chips if multiple results
  if (result.multiple && result.results && result.results.length > 1 && dom.lyricsResultsBar) {
    dom.lyricsResultsBar.style.display = '';
    dom.lyricsResultsChips.innerHTML = '';
    result.results.forEach((r, idx) => {
      const chip = document.createElement('button');
      chip.className = 'lyrics-result-chip' + (idx === 0 ? ' active' : '');
      chip.title = r.label || r.source || '';
      chip.textContent = r.source || `Resultado ${idx+1}`;
      chip.addEventListener('click', () => {
        dom.lyricsResultsChips.querySelectorAll('.lyrics-result-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        renderLyricsContent(r);
      });
      dom.lyricsResultsChips.appendChild(chip);
    });
  } else if (dom.lyricsResultsBar) {
    dom.lyricsResultsBar.style.display = 'none';
  }

  // Render first result by default
  const first = (result.results && result.results[0]) || result;
  renderLyricsContent(first);
}

audioPlayer.addEventListener('timeupdate', () => {
  if (!_syncedLines || !_syncedLines.length) return;
  const t = audioPlayer.currentTime;
  let idx = -1;
  for (let i = 0; i < _syncedLines.length; i++) {
    if (_syncedLines[i].t <= t) idx = i; else break;
  }
  if (idx !== _activeLrcLineIdx) {
    _activeLrcLineIdx = idx;
    const cont = dom.lyricsBody.querySelector('.lyrics-text');
    if (!cont) return;
    const spans = cont.querySelectorAll('.lrc-line');
    spans.forEach((s, i) => {
      s.classList.toggle('active', i === idx);
      s.classList.toggle('passed', i < idx);
    });
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

/* ─────────────────────────────────────────────
   7) VISUALIZER — NCS style sobre la barra
───────────────────────────────────────────── */
let _vizCtx = null, _vizAnalyser = null, _vizSource = null, _vizData = null, _vizRaf = null;

let _normGain = null; // GainNode for volume normalization

function initVisualizer() {
  if (_vizCtx) return;
  try {
    _vizCtx = new (window.AudioContext || window.webkitAudioContext)();
    _vizSource = _vizCtx.createMediaElementSource(audioPlayer);
    _vizAnalyser = _vizCtx.createAnalyser();
    _vizAnalyser.fftSize = 2048;
    _normGain = _vizCtx.createGain();
    _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
    _vizSource.connect(_vizAnalyser);
    _vizAnalyser.connect(_normGain);
    _normGain.connect(_vizCtx.destination);
    _vizData = new Uint8Array(_vizAnalyser.frequencyBinCount);
    drawViz();
  } catch (e) { console.warn('viz init', e); }
}

function applyVizSettings() {
  if (!dom2.vizCanvas) return;
  // The canvas is now inside the panel - no need to toggle hidden
  // Apply normalize via GainNode if audio context is ready
  if (_normGain) _normGain.gain.value = settings.normalize ? 1.4 : 1.0;
  // Sync panel controls from settings
  _syncVizPanelControls();
}

function drawViz() {
  cancelAnimationFrame(_vizRaf);
  _vizRaf = requestAnimationFrame(drawViz);
  if (!_vizAnalyser || !dom2.vizCanvas || settings.vizEnabled === false) return;
  const cvs = dom2.vizCanvas;
  // resize to display
  const w = cvs.clientWidth || window.innerWidth;
  const h = cvs.clientHeight || 220;
  if (cvs.width !== w) cvs.width = w;
  if (cvs.height !== h) cvs.height = h;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0,0,w,h);
  _vizAnalyser.getByteFrequencyData(_vizData);
  const color = settings.vizColor || '#ffffff';
  const sens  = settings.vizSensitivity || 1.5;
  const style = settings.vizStyle || 'bars';
  if (settings.vizShadow) { ctx.shadowBlur = 14; ctx.shadowColor = color; }
  else { ctx.shadowBlur = 0; }
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const n = _vizData.length;
  // Use only the lower half of bins (the upper half is mostly silence/noise)
  // and stretch them to fill the full canvas width
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

  // Fade out toward the top so tall bars dissolve gracefully instead of hard-clipping
  ctx.shadowBlur = 0;
  if (style !== 'circle') {
    const fadeH = Math.round(h * 0.35);
    const fade = ctx.createLinearGradient(0, 0, 0, fadeH);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, fadeH);
    ctx.globalCompositeOperation = 'source-over';
  }

  // idle hint
  if (dom2.vizIdleHint) {
    const isPlaying = !audioPlayer.paused;
    dom2.vizIdleHint.classList.toggle('hidden', isPlaying);
  }
}

audioPlayer.addEventListener('play', () => {
  initVisualizer();
  if (_vizCtx?.state === 'suspended') _vizCtx.resume();
});
applyVizSettings();

/* ── VIZ PANEL ──────────────────────────────── */
// Apply saved opacity on load
if (dom2.vizCanvas && settings.vizOpacity != null) {
  dom2.vizCanvas.style.opacity = settings.vizOpacity / 100;
}

/* ── VIZ FULLSCREEN VIEW ─────────────────────────────────────── */

function _syncVizPanelControls() {
  const s = settings;
  // drawer controls
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
  // style buttons
  document.querySelectorAll('.viz-style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vizStyle === (s.vizStyle || 'bars'));
  });
  // quick color buttons — accent is dynamic
  const accentVal = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  document.querySelectorAll('.viz-qc').forEach(btn => {
    if (btn.classList.contains('viz-qc--accent')) btn.style.background = accentVal;
    const vc = btn.dataset.vc === 'accent' ? accentVal : btn.dataset.vc;
    btn.classList.toggle('active', vc === (s.vizColor || '#ffffff'));
  });
  // also sync the main settings modal fields
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
    dom2.vizTrackArt.style.backgroundImage = t?.art ? `url(${t.art})` : '';
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
}

function _closeVizView() {
  if (!dom2.vizView) return;
  dom2.vizView.classList.remove('active');
  if (dom2.btnViz) dom2.btnViz.classList.remove('viz-active');
  // close drawer too
  if (dom2.vizSettingsDrawer) dom2.vizSettingsDrawer.classList.remove('open');
  if (dom2.vizSettingsBtn) dom2.vizSettingsBtn.classList.remove('active');
}

// btn-viz toggles the view
if (dom2.btnViz) {
  dom2.btnViz.addEventListener('click', () => {
    dom2.vizView?.classList.contains('active') ? _closeVizView() : _openVizView();
  });
}

// gear button toggles settings drawer
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

// drawer controls
if (dom2.vizSdEnabled) {
  dom2.vizSdEnabled.addEventListener('change', () => {
    settings.vizEnabled = dom2.vizSdEnabled.checked;
    saveSettings(); _syncVizPanelControls();
  });
}
if (dom2.vizSdColor) {
  dom2.vizSdColor.addEventListener('input', () => {
    settings.vizColor = dom2.vizSdColor.value;
    saveSettings(); _syncVizPanelControls();
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
    saveSettings();
  });
}
if (dom2.vizSdOpacity) {
  dom2.vizSdOpacity.addEventListener('input', () => {
    settings.vizOpacity = parseInt(dom2.vizSdOpacity.value);
    if (dom2.vizSdOpacityVal) dom2.vizSdOpacityVal.textContent = settings.vizOpacity + '%';
    if (dom2.vizCanvas) dom2.vizCanvas.style.opacity = settings.vizOpacity / 100;
    saveSettings();
  });
}

// keep track info up to date when song changes
audioPlayer.addEventListener('play',  _updateVizTrackInfo);
audioPlayer.addEventListener('pause', _updateVizTrackInfo);
audioPlayer.addEventListener('ended', _updateVizTrackInfo);

/* ─────────────────────────────────────────────
   8) Garantizar volumen estable y limpiar entidades
───────────────────────────────────────────── */
const _origPlayTrack = playTrack;
playTrack = function(index) {
  // limpia entidades del título/artista por si vienen codificadas
  const t = queue[index];
  if (t) { t.title = decodeEntities(t.title); t.artist = decodeEntities(t.artist); }
  _origPlayTrack(index);
  audioPlayer.volume = isMuted ? 0 : linearToAudioVolume(currentVolume);
};

/* ─────────────────────────────────────────────
   9) Resize sin límites — re-aplica width incluso a 0 (oculta)
───────────────────────────────────────────── */
// Ya cubierto por las modificaciones a setupResizablePanels (Math.max(0, ...)).

/* ─── Volume number input ─── */
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
  // sincronizar valor inicial
  _volNumInput.value = Math.round(currentVolume * 100);
}

/* ─────────────────────────────────────────────
   10) THEME PANEL — wiring completo (faltaba)
───────────────────────────────────────────── */
(function setupThemePanel() {
  const panel    = document.getElementById('theme-panel');
  const overlay  = document.getElementById('theme-panel-overlay');
  const btnOpen  = document.getElementById('btn-theme');
  const btnClose = document.getElementById('theme-panel-close');
  if (!panel || !btnOpen) return;

  /* Default presets (cada uno es un mapa de CSS vars) */
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
  function setVar(name, val){
    document.documentElement.style.setProperty(name, val);
    if (!settings.theme) settings.theme = {};
    settings.theme[name] = val;
    // sync color input + label
    const input = panel.querySelector(`.tp-color-input[data-var="${name}"]`);
    if (input) input.value = toHex(val);
    const labelId = `tp-${name.replace('--','')}-val`;
    const lbl = document.getElementById(labelId);
    if (lbl) lbl.textContent = val;
  }

  function syncControlsFromDOM(){
    COLOR_VARS.forEach(v => {
      const hex = toHex(currentVar(v));
      const input = panel.querySelector(`.tp-color-input[data-var="${v}"]`);
      if (input) input.value = hex;
      const lbl = document.getElementById(`tp-${v.replace('--','')}-val`);
      if (lbl) lbl.textContent = hex;
    });
    // Sync non-color sliders from saved theme / current CSS vars
    const th = settings.theme || {};
    // Radius
    if (radius) {
      const r8 = th['--r8'] || currentVar('--r8') || '8px';
      const rVal = parseInt(r8) || 8;
      radius.value = rVal;
      if (radiusVal) radiusVal.textContent = rVal + 'px';
    }
    // Border opacity
    if (bord) {
      const bv = th['--border'] || currentVar('--border') || 'rgba(255,255,255,0.07)';
      const match = bv.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
      const pct = match ? Math.round(parseFloat(match[1]) * 100) : 7;
      bord.value = pct;
      if (bordVal) bordVal.textContent = pct + '%';
    }
    // Font family — el select se puebla async; restauramos el CSS directamente
    const fontEl = document.getElementById('tp-font');
    if (fontEl) {
      const fv = th['--font'] || currentVar('--font') || '';
      if (fv) {
        document.documentElement.style.setProperty('--font', fv);
        document.body.style.fontFamily = fv;
      }
    }
    // Font size
    if (fsize) {
      const fsv = th['--base-font-size'] || null;
      if (fsv) {
        const n = parseInt(fsv) || 14;
        fsize.value = n;
        if (fsizeVal) fsizeVal.textContent = n + 'px';
        document.documentElement.style.fontSize = n + 'px';
      }
    }
    // Backdrop opacity
    if (bd) {
      const bdo = th['--backdrop-opacity'] || currentVar('--backdrop-opacity') || '0.7';
      const pct = Math.round(parseFloat(bdo) * 100) || 70;
      bd.value = pct;
      if (bdVal) bdVal.textContent = pct + '%';
    }
    // Panel gap
    if (gap) {
      const gv = th['--panel-gap'] || currentVar('--panel-gap') || '8px';
      const n = parseInt(gv) || 8;
      gap.value = n;
      if (gapVal) gapVal.textContent = n + 'px';
    }
    // Bar height
    if (bh) {
      const bhv = th['--bar-h'] || currentVar('--bar-h') || '90px';
      const n = parseInt(bhv) || 90;
      bh.value = n;
      if (bhVal) bhVal.textContent = n + 'px';
    }
  }

  /* OPEN / CLOSE */
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

  /* COLOR INPUTS (--bg, --bg2, ..., --accent) */
  panel.querySelectorAll('.tp-color-input').forEach(input => {
    input.addEventListener('input', () => setVar(input.dataset.var, input.value));
  });

  /* PRESETS */
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

  /* QUICK ACCENT DOTS */
  panel.querySelectorAll('.tp-accent-dot').forEach(dot => {
    dot.addEventListener('click', () => setVar('--accent', dot.dataset.accent));
  });

  /* RADIUS */
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

  /* BORDER OPACITY */
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

  /* FONT FAMILY */
  const font = document.getElementById('tp-font');

  // Fuentes por defecto de la app (siempre presentes al inicio del selector)
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
    // Cargar fuentes del sistema de forma asíncrona
    (async () => {
      let systemFonts = [];
      try {
        systemFonts = await window.nofuf.getSystemFonts();
      } catch (e) {
        console.warn('[fonts] No se pudieron leer fuentes del sistema:', e);
      }

      // Limpiar el select y reconstruirlo
      font.innerHTML = '';

      // Grupo 1: fuentes propias de la app
      const grpApp = document.createElement('optgroup');
      grpApp.label = '── App ──';
      DEFAULT_FONTS.forEach(({ label, value }) => {
        const opt = document.createElement('option');
        opt.value = label; // guardamos el nombre limpio
        opt.dataset.family = value; // valor CSS real
        opt.textContent = label;
        grpApp.appendChild(opt);
      });
      font.appendChild(grpApp);

      // Grupo 2: fuentes del sistema (excluir duplicados con las de la app)
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

      // Restaurar la fuente guardada en settings
      const savedFont = settings.theme?.['--font'];
      if (savedFont) {
        // Buscar por dataset.family o por value
        const allOpts = Array.from(font.querySelectorAll('option'));
        const match = allOpts.find(o => o.dataset.family === savedFont || o.value === savedFont);
        if (match) {
          font.value = match.value;
        }
      }
    })();

    font.addEventListener('change', () => {
      const selected = font.options[font.selectedIndex];
      // Usar dataset.family si existe (CSS real), si no el value directo
      const cssFamily = selected?.dataset?.family || font.value;
      applyFontValue(cssFamily);
    });
  }

  /* FONT SIZE */
  const fsize = document.getElementById('tp-font-size');
  const fsizeVal = document.getElementById('tp-font-size-val');
  if (fsize) {
    fsize.addEventListener('input', () => {
      document.documentElement.style.fontSize = fsize.value + 'px';
      if (fsizeVal) fsizeVal.textContent = fsize.value + 'px';
      if (!settings.theme) settings.theme = {};
      settings.theme['--base-font-size'] = fsize.value + 'px';
    });
  }

  /* BACKDROP / GAP / BAR HEIGHT */
  const bd = document.getElementById('tp-backdrop-opacity');
  const bdVal = document.getElementById('tp-backdrop-opacity-val');
  if (bd) bd.addEventListener('input', () => {
    document.documentElement.style.setProperty('--backdrop-opacity', bd.value/100);
    if (bdVal) bdVal.textContent = bd.value + '%';
    if (!settings.theme) settings.theme = {};
    settings.theme['--backdrop-opacity'] = String(bd.value/100);
  });
  const gap = document.getElementById('tp-panel-gap');
  const gapVal = document.getElementById('tp-panel-gap-val');
  if (gap) gap.addEventListener('input', () => {
    document.documentElement.style.setProperty('--panel-gap', gap.value + 'px');
    if (gapVal) gapVal.textContent = gap.value + 'px';
    if (!settings.theme) settings.theme = {};
    settings.theme['--panel-gap'] = gap.value + 'px';
  });
  const bh = document.getElementById('tp-bar-height');
  const bhVal = document.getElementById('tp-bar-height-val');
  if (bh) bh.addEventListener('input', () => {
    document.documentElement.style.setProperty('--bar-h', bh.value + 'px');
    if (bhVal) bhVal.textContent = bh.value + 'px';
    if (!settings.theme) settings.theme = {};
    settings.theme['--bar-h'] = bh.value + 'px';
  });

  /* RESET */
  const btnReset = document.getElementById('tp-reset-btn');
  if (btnReset) btnReset.addEventListener('click', () => {
    if (!confirm('¿Restablecer todo el tema a los valores por defecto?')) return;
    [...COLOR_VARS, '--r8','--r12','--border','--font','--backdrop-opacity','--panel-gap','--bar-h']
      .forEach(v => document.documentElement.style.removeProperty(v));
    document.documentElement.style.fontSize = '14px'; // reset base font size
    settings.theme = null;
    saveSettings();
    Object.entries(PRESETS.dark).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
    syncControlsFromDOM();
    showToast('Tema restablecido');
  });

  /* EXPORT */
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

  /* IMPORT */
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
          settings.theme = theme;
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
          settings.theme = theme;
          applyTheme(theme);
          syncControlsFromDOM();
          saveSettings();
          showToast('Tema importado');
        } catch { showToast('Archivo inválido'); }
      };
      r.readAsText(file);
    });
  }

  /* Aplicar tema guardado al arrancar */
  if (settings.theme) {
    applyTheme(settings.theme);
    syncControlsFromDOM();
  }

  /* ── BACKGROUND IMAGE ── */
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

  // Background div — usa background-image CSS (funciona correctamente en Electron)
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
    bgEl.style.filter = `blur(${blur}px) brightness(${bright}%) grayscale(${gray}%)`;
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
    // Restaurar sliders
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
    // Borra también background.json
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
    // Guardar imagen en background.json separado (puede ser varios MB)
    const opts = getCurrentBgOpts();
    try {
      if (window.nofuf?.configWrite)
        window.nofuf.configWrite('background.json', JSON.stringify({ dataUrl, opts }, null, 2));
    } catch(e) {}
    // Guardar sólo las opciones (sin el base64) en settings para tener las preferencias
    if (!settings.theme) settings.theme = {};
    delete settings.theme['--bg-image']; // no meter el base64 en settings.json
    delete settings.theme['--bg-opts'];
    settings.theme['--bg-opts-only'] = JSON.stringify(opts);
    saveSettings();
  }

  // Exponer funciones BG globalmente
  window._nofufApplyBg = function(dataUrl, opts) {
    applyBgImage(dataUrl, opts || {});
  };
  // Guardar el estado actual del fondo (llamado desde onSaveBeforeHide)
  window._nofufSaveBg = function() {
    if (_currentBgDataUrl) saveBgToSettings(_currentBgDataUrl);
  };

  // Restaurar imagen: primero miramos si initConfigFiles ya cargó background.json
  if (window._nofufPendingBg) {
    const { dataUrl, opts } = window._nofufPendingBg;
    window._nofufPendingBg = null;
    applyBgImage(dataUrl, opts || {});
  } else if (settings.theme && settings.theme['--bg-image']) {
    // Migración: la imagen estaba en settings (sistema anterior)
    let opts = {};
    try { opts = JSON.parse(settings.theme['--bg-opts'] || '{}'); } catch {}
    applyBgImage(settings.theme['--bg-image'], opts);
    // Migrar a background.json y limpiar settings
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

  function liveUpdateBg() {
    if (!_currentBgDataUrl) return;
    const opts = getCurrentBgOpts();
    bgEl.style.opacity = opts.opacity / 100;
    applyBgFilters();
    _syncVizBg(_currentBgDataUrl, opts);
    saveBgToSettings(_currentBgDataUrl);
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
})();
/* ═══════════════════════════════════════════════════════════════
   EQUALIZER — Nativo con Web Audio API BiquadFilter (10 bandas)
═══════════════════════════════════════════════════════════════ */

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
const EQ_RANGE  = EQ_MAX_DB * 2; // total dB range (±12)

/* State */
let _eqEnabled   = true;
let _eqFilters   = [];
let _eqGains     = new Array(EQ_BANDS.length).fill(0);
let _eqPanelOpen = false;
let _eqActivePreset = 'flat';
let _eqAudioCtxReady = false;

/* ─── Rebuild EQ chain whenever AudioContext is ready ─── */
function _eqBuildChain() {
  if (!_vizCtx || _eqAudioCtxReady) return;
  try {
    // Disconnect the existing source→analyser→dest chain
    _vizSource.disconnect();
    _vizAnalyser.disconnect();

    // Build 10 biquad filters in series
    _eqFilters = EQ_BANDS.map((b, i) => {
      const f = _vizCtx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = 1.0;
      f.gain.value = _eqEnabled ? _eqGains[i] : 0;
      return f;
    });

    // Chain: source → filters[0..9] → analyser → destination
    _vizSource.connect(_eqFilters[0]);
    for (let i = 0; i < _eqFilters.length - 1; i++) {
      _eqFilters[i].connect(_eqFilters[i + 1]);
    }
    _eqFilters[_eqFilters.length - 1].connect(_vizAnalyser);
    _vizAnalyser.connect(_vizCtx.destination);

    _eqAudioCtxReady = true;
    console.log('[EQ] Cadena de filtros construida correctamente');
  } catch (e) {
    console.warn('[EQ] Error construyendo cadena:', e);
  }
}

/* Hook into visualizer init to build EQ chain after */
const _origInitVisualizer = initVisualizer;
initVisualizer = function() {
  _origInitVisualizer();
  _eqBuildChain();
};

/* Apply current gains to all filters */
function _eqApplyGains() {
  _eqFilters.forEach((f, i) => {
    f.gain.setTargetAtTime(_eqEnabled ? _eqGains[i] : 0, _vizCtx ? _vizCtx.currentTime : 0, 0.01);
  });
}

/* ─── Build UI bands ─── */
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

/* Update visual for one band */
function _eqUpdateBandUI(idx) {
  const gain = _eqGains[idx];
  const pct  = (gain + EQ_MAX_DB) / EQ_RANGE; // 0..1, 0.5 = center
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

/* Drag interaction for each band */
function _eqSetupBandDrag(bandEl, idx) {
  const wrap = bandEl.querySelector('.eq-slider-wrap');
  let dragging = false;

  function gainFromY(clientY) {
    const track = document.getElementById('eq-track-' + idx);
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const gain = EQ_MAX_DB - pct * EQ_RANGE;
    return Math.round(gain * 2) / 2; // snap to 0.5 dB steps
  }

  function onMove(e) {
    if (!dragging) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    _eqGains[idx] = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, gainFromY(clientY)));
    _eqUpdateBandUI(idx);
    if (_eqAudioCtxReady) {
      _eqFilters[idx].gain.setTargetAtTime(_eqEnabled ? _eqGains[idx] : 0, _vizCtx.currentTime, 0.005);
    }
    // update gain display
    const gainDisplay = document.getElementById('eq-gain-display');
    if (gainDisplay) gainDisplay.textContent = (_eqGains[idx] >= 0 ? '+' : '') + _eqGains[idx].toFixed(1) + ' dB';
    // deactivate preset on manual change
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

  /* Double-click to reset band to 0 */
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

/* Apply a preset */
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

/* Reset all bands to flat */
function _eqReset() {
  _eqApplyPreset('flat');
  const gainDisplay = document.getElementById('eq-gain-display');
  if (gainDisplay) gainDisplay.textContent = '0.0 dB';
  showToast('Ecualizador restablecido');
}

/* Save/load EQ state in settings */
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

/* ──────────────────────────────────────────
   EQ USER PRESETS
   Guardados en settings.eqUserPresets = { "Nombre": [g0..g9], ... }
──────────────────────────────────────────── */
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
  _eqUpdateAllUI(); // usa la función correcta que actualiza el DOM real
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

// Wire save preset UI after DOM is ready
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

// Helper to sync sliders with _eqGains (needed when applying user presets)
function _eqUpdateSlidersFromGains() {
  const container = document.getElementById('eq-bands-container');
  if (!container) return;
  container.querySelectorAll('.eq-band').forEach((band, i) => {
    const slider = band.querySelector('.eq-slider');
    const label  = band.querySelector('.eq-gain-val');
    if (slider) slider.value = String(-_eqGains[i]); // inverted axis
    if (label)  label.textContent = (_eqGains[i] >= 0 ? '+' : '') + _eqGains[i].toFixed(1);
  });
}

/* Open/close panel */
function _eqOpenPanel() {
  _eqPanelOpen = true;
  const panel = document.getElementById('eq-panel');
  const overlay = document.getElementById('eq-panel-overlay');
  const btnEq = document.getElementById('btn-eq');
  if (panel)   { panel.classList.add('open'); if (!_eqEnabled) panel.classList.add('eq-disabled'); }
  if (overlay) overlay.classList.add('active');
  if (btnEq)   btnEq.classList.add('active');
  // Init viz/EQ if not done
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

/* ─── INIT EQ ─── */
(function initEQ() {
  // Load saved state
  _eqLoadFromSettings();

  // Build band UI
  _eqBuildUI();

  // Wire up enable toggle
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

  // Wire presets
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === _eqActivePreset);
    btn.addEventListener('click', () => _eqApplyPreset(btn.dataset.preset));
  });

  // Reset button
  const resetBtn = document.getElementById('eq-reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', _eqReset);

  // EQ toggle in player bar
  const btnEq = document.getElementById('btn-eq');
  if (btnEq) {
    btnEq.addEventListener('click', () => {
      if (_eqPanelOpen) _eqClosePanel();
      else _eqOpenPanel();
    });
  }

  // Close button inside panel
  const closeBtn = document.getElementById('eq-close');
  if (closeBtn) closeBtn.addEventListener('click', _eqClosePanel);

  // Overlay click closes
  const overlay = document.getElementById('eq-panel-overlay');
  if (overlay) overlay.addEventListener('click', _eqClosePanel);

  // Apply preset highlight on load
  document.querySelectorAll('.eq-preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === _eqActivePreset);
  });

  // Wire user preset UI
  _eqWireUserPresetUI();
})();
/* ════════════════════════════════════════════════
   YOUTUBE SEARCH BAR — titlebar search
════════════════════════════════════════════════ */
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
    // Update header labels
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
        ? `<img class="yt-result-thumb" src="${r.thumbnail}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="yt-result-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
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
          <button class="yt-result-add-btn" data-action="queue" title="Añadir a cola">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <button class="yt-result-play-btn" data-action="play" title="Reproducir ahora">
            <svg width="11" height="11" viewBox="0 0 18 18" fill="none"><path d="M4 3l12 6-12 6V3z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    // Attach click handlers
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
      // Click row → play
      item.addEventListener('click', () => resolveAndPlay(id, title, uploader, true));
    });
  }

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
    const result = await window.nofuf.searchYouTube(q);
    if (q !== lastQuery) return; // stale
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
    if (!val) showPlaceholder();
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
    // Close Spotify panel if open
    const spPanelEl = document.getElementById('sp-search-panel');
    if (spPanelEl) spPanelEl.classList.remove('open');
    // Hide overlay if both panels closed
    overlay.classList.remove('active');
    input.focus();
  });

  closeBtn.addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);
})();

/* ═══════════════════════════════════════════════════════════════
   SEARCH MODE TOGGLE — YouTube ↔ Spotify
   + SPOTIFY SEARCH — busca en Spotify, resuelve vía YouTube
═══════════════════════════════════════════════════════════════ */
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

  // searchMode is a global (declared at top of file) shared with initYouTubeSearch
  let spLastQuery    = '';
  let spSearchTimer  = null;

  /* ── Mode switching ── */
  function setMode(m) {
    searchMode = m; // update global
    if (m === 'sp') {
      toggleBtn.classList.add('sp-mode');
      iconYt.style.display = 'none';
      iconSp.style.display = '';
      searchInput.placeholder = 'Buscar en Spotify…';
      ytPanel.classList.remove('open');
    } else {
      toggleBtn.classList.remove('sp-mode');
      iconYt.style.display = '';
      iconSp.style.display = 'none';
      searchInput.placeholder = 'Buscar en YouTube…';
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
      spLastQuery = ''; // force re-search
      doSpSearch(val);
    }
  });

  /* ── Panel helpers ── */
  function openSpPanel() {
    ytPanel.classList.remove('open');
    spPanel.classList.add('open');
    overlay.classList.add('active');
  }

  function closeSpPanel() {
    spPanel.classList.remove('open');
    // Only remove overlay if YT panel is also closed
    if (!ytPanel.classList.contains('open')) {
      overlay.classList.remove('active');
    }
  }

  /* ── UI states ── */
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

  /* ── Render results ── */
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

    // Attach events — capture track object by closure over tracks[idx]
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
      item.addEventListener('click', () => spResolveAndAct(item, track, 'play'));
    });
  }

  /* ── Core: find YouTube match and act ── */
  async function spResolveAndAct(itemEl, spTrack, action) {
    if (itemEl.classList.contains('sp-matching')) return;
    itemEl.classList.add('sp-matching');

    try {
      // Build a good YT search query from Spotify metadata
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

      // Score results: scoring mejorado con múltiples criterios
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

        // downloadYouTube handles yt-dlp resolution internally — no need to pre-resolve
        window.nofuf.downloadYouTube({
          id:      dlId,
          videoId: best.id,
          ytUrl,
          title:   spTrack.title,
          artist:  spTrack.artist,
          outDir,
          format:  'mp3',
        });
        closeSpPanel();
        return;
      }

      // Play / queue: resolve stream URL via yt-dlp
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

  /* ── Search ── */
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

    // Discard stale response (user typed something else)
    if (q !== spLastQuery) return;

    if (!result || result.type === 'error') {
      spShowError(result?.message || 'Error de conexión con Spotify');
      return;
    }
    spShowResults(result.results || []);
  }

  /* ── Input event listeners (intercept YT input when in SP mode) ── */
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
  // overlay click closes both panels (YT panel handles its own via initYouTubeSearch)
  overlay.addEventListener('click', closeSpPanel);
})();

/* ═══════════════════════════════════════════════════════════════
   NIGHTCORE v2 — Speed · Pitch (preservesPitch=false) · Treble
   Speed : 0.10× – 2.00×   (playbackRate)
   Pitch : -12 … +12 st    (via preservesPitch=false — pitch sube/baja con la velocidad
                             y luego ajustamos la velocidad extra para conseguir el semitono
                             deseado ENCIMA de la velocidad elegida por el usuario)
   Treble: -12 … +12 dB    (highshelf a 8 kHz, siempre activo en chain)
═══════════════════════════════════════════════════════════════ */
(function initNightcore() {

  /* ── Estado ── */
  let _ncEnabled   = false;
  let _ncSpeed     = 1.30;   // velocidad base elegida por el usuario (0.1–2.0)
  let _ncPitch     = 4;      // semitonos deseados por encima de la velocidad base (-12..+12)
  let _ncTreble    = 4;      // dB highshelf
  let _ncPanelOpen = false;

  /* Web Audio */
  let _ncTrebleNode = null;
  let _ncChainReady = false;

  /* Presets */
  const NC_PRESETS = {
    nightcore: { speed: 1.30, pitch:  4, treble:  4 },
    slowed:    { speed: 0.80, pitch: -3, treble: -2 },
    vaporwave: { speed: 0.72, pitch: -5, treble:  0 },
    speed:     { speed: 1.50, pitch:  0, treble:  2 },
  };

  /* ─── Construir nodo treble en la cadena Web Audio ─── */
  function _ncBuildChain() {
    if (!_vizCtx || _ncChainReady) return;
    try {
      _vizAnalyser.disconnect();
      _ncTrebleNode = _vizCtx.createBiquadFilter();
      _ncTrebleNode.type = 'highshelf';
      _ncTrebleNode.frequency.value = 8000;
      _ncTrebleNode.gain.value = 0;
      _vizAnalyser.connect(_ncTrebleNode);
      _ncTrebleNode.connect(_vizCtx.destination);
      _ncChainReady = true;
      _ncApply();
    } catch(e) { console.warn('[NC] chain error:', e); }
  }

  /* ─── Aplicar todos los parámetros ─── */
  function _ncApply() {
    if (_ncEnabled) {
      /* La velocidad REAL del audio es la velocidad base del usuario más
         la compensación para conseguir el pitch deseado.
         Con preservesPitch=false, el pitch sube 1 semitono por cada ×2^(1/12) ≈ 1.0595 de velocidad.
         Para tener _ncPitch semitonos encima de _ncSpeed, multiplicamos por 2^(_ncPitch/12). */
      const pitchMult = Math.pow(2, _ncPitch / 12);
      const finalRate = Math.min(4.0, Math.max(0.05, _ncSpeed * pitchMult));
      audioPlayer.preservesPitch = false;
      audioPlayer.mozPreservePitch = false;
      audioPlayer.webkitPreservePitch = false;
      audioPlayer.playbackRate = finalRate;
      if (_ncChainReady && _ncTrebleNode) {
        _ncTrebleNode.gain.setTargetAtTime(_ncTreble, _vizCtx.currentTime, 0.02);
      }
    } else {
      audioPlayer.preservesPitch = true;
      audioPlayer.playbackRate = 1.0;
      if (_ncChainReady && _ncTrebleNode) {
        _ncTrebleNode.gain.setTargetAtTime(0, _vizCtx.currentTime, 0.02);
      }
    }
    _ncUpdateFinalSpeed();
  }

  /* Actualiza la etiqueta de velocidad final en el panel */
  function _ncUpdateFinalSpeed() {
    const finalSpd = document.getElementById('nc-final-speed');
    if (!finalSpd) return;
    if (_ncEnabled) {
      const finalRate = Math.min(4.0, Math.max(0.05, _ncSpeed * Math.pow(2, _ncPitch / 12)));
      finalSpd.textContent = finalRate.toFixed(2) + '×';
    } else {
      finalSpd.textContent = '1.00×';
    }
  }

  /* ─── Hooks en la cadena de audio ─── */
  const _ncOrigInitViz = initVisualizer;
  initVisualizer = function() {
    _ncOrigInitViz();
    if (!_ncChainReady) _ncBuildChain();
  };
  const _ncOrigEqBuild = _eqBuildChain;
  _eqBuildChain = function() {
    _ncOrigEqBuild();
    if (_vizCtx && _eqAudioCtxReady && !_ncChainReady) setTimeout(_ncBuildChain, 50);
  };

  /* Re-aplica al cambiar de pista */
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

  /* ─── UI ─── */
  function _ncUpdateUI() {
    const speedInput  = document.getElementById('nc-speed');
    const pitchInput  = document.getElementById('nc-pitch');
    const trebleInput = document.getElementById('nc-treble');
    const speedDisp   = document.getElementById('nc-speed-display');
    const pitchDisp   = document.getElementById('nc-pitch-display');
    const trebleDisp  = document.getElementById('nc-treble-display');
    const enableChk   = document.getElementById('nc-enabled');
    const panel       = document.getElementById('nc-panel');
    const btn         = document.getElementById('btn-nightcore');

    if (speedInput)  speedInput.value  = Math.round(_ncSpeed * 100);
    if (pitchInput)  pitchInput.value  = _ncPitch;
    if (trebleInput) trebleInput.value = _ncTreble;
    if (speedDisp)   speedDisp.textContent  = _ncSpeed.toFixed(2) + '×';
    if (pitchDisp)   pitchDisp.textContent  = (_ncPitch >= 0 ? '+' : '') + _ncPitch.toFixed(1) + ' st';
    if (trebleDisp)  trebleDisp.textContent = (_ncTreble >= 0 ? '+' : '') + _ncTreble.toFixed(1) + ' dB';
    if (enableChk)   enableChk.checked = _ncEnabled;
    if (panel) {
      panel.classList.toggle('nc-on', _ncEnabled);
    }
    if (btn) {
      btn.classList.toggle('active', _ncEnabled);
      btn.style.color = _ncEnabled ? '#a78bfa' : '';
    }
    _ncUpdateFinalSpeed();
  }

  function _ncSave() {
    settings.nightcore = { enabled: _ncEnabled, speed: _ncSpeed, pitch: _ncPitch, treble: _ncTreble };
    saveSettings();
  }

  function _ncLoad() {
    if (settings.nightcore) {
      _ncEnabled = !!settings.nightcore.enabled;
      _ncSpeed   = settings.nightcore.speed   ?? 1.30;
      _ncPitch   = settings.nightcore.pitch   ?? 4;
      _ncTreble  = settings.nightcore.treble  ?? 4;
    }
  }

  /* ─── Panel abrir/cerrar ─── */
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

  /* Activa el preset y marca el botón correcto */
  function _ncApplyPreset(name) {
    const preset = NC_PRESETS[name];
    if (!preset) return;
    _ncSpeed  = preset.speed;
    _ncPitch  = preset.pitch;
    _ncTreble = preset.treble;
    if (_ncEnabled) _ncApply();
    _ncUpdateUI();
    _ncSave();
    document.querySelectorAll('[data-nc-preset]').forEach(b =>
      b.classList.toggle('active', b.dataset.ncPreset === name));
    showToast('Preset: ' + name.charAt(0).toUpperCase() + name.slice(1));
  }

  /* Detecta qué preset coincide con los valores actuales (null = personalizado) */
  function _ncDetectPreset() {
    for (const [name, p] of Object.entries(NC_PRESETS)) {
      if (Math.abs(p.speed - _ncSpeed) < 0.01 &&
          Math.abs(p.pitch - _ncPitch) < 0.1  &&
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

  /* ─── Wire controles ─── */
  function _ncSetupControls() {
    _ncLoad();
    _ncUpdateUI();
    _ncApply();
    _ncMarkPresetButtons();

    /* Botón en la barra de reproducción */
    const btnNC = document.getElementById('btn-nightcore');
    if (btnNC) {
      btnNC.addEventListener('click', () => {
        if (_ncPanelOpen) _ncClosePanel();
        else _ncOpenPanel();
      });
    }

    /* Cerrar panel */
    const closeBtn = document.getElementById('nc-close');
    if (closeBtn) closeBtn.addEventListener('click', _ncClosePanel);
    const overlay = document.getElementById('nc-panel-overlay');
    if (overlay) overlay.addEventListener('click', _ncClosePanel);

    /* Toggle activar/desactivar */
    const enableChk = document.getElementById('nc-enabled');
    if (enableChk) {
      enableChk.addEventListener('change', () => {
        _ncEnabled = enableChk.checked;
        if (_ncEnabled && _vizCtx && !_ncChainReady) _ncBuildChain();
        if (_ncEnabled && !_vizCtx) initVisualizer();
        _ncApply();
        _ncUpdateUI();
        _ncSave();
        showToast(_ncEnabled ? '\u26a1 Nightcore activado' : 'Nightcore desactivado');
      });
    }

    /* Slider velocidad */
    const speedInput = document.getElementById('nc-speed');
    if (speedInput) {
      speedInput.addEventListener('input', () => {
        _ncSpeed = parseInt(speedInput.value) / 100;
        const disp = document.getElementById('nc-speed-display');
        if (disp) disp.textContent = _ncSpeed.toFixed(2) + '\u00d7';
        if (_ncEnabled) _ncApply();
        else _ncUpdateFinalSpeed();
        _ncMarkPresetButtons();
        _ncSave();
      });
    }

    /* Slider pitch */
    const pitchInput = document.getElementById('nc-pitch');
    if (pitchInput) {
      pitchInput.addEventListener('input', () => {
        _ncPitch = parseFloat(pitchInput.value);
        const disp = document.getElementById('nc-pitch-display');
        if (disp) disp.textContent = (_ncPitch >= 0 ? '+' : '') + _ncPitch.toFixed(1) + ' st';
        if (_ncEnabled) _ncApply();
        else _ncUpdateFinalSpeed();
        _ncMarkPresetButtons();
        _ncSave();
      });
    }

    /* Slider treble */
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

    /* Botones de preset */
    document.querySelectorAll('[data-nc-preset]').forEach(btn => {
      btn.addEventListener('click', () => _ncApplyPreset(btn.dataset.ncPreset));
    });

    /* Reset */
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
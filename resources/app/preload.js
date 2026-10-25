const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nofuf', {
  // Electron ≥32 eliminó File.path: esta es la vía oficial para resolver rutas de ficheros arrastrados
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  quit:     () => ipcRenderer.send('window-quit'),
  show:     () => ipcRenderer.send('window-show'),
  reload:   () => ipcRenderer.send('window-reload'),

  openFileDialog:    () => ipcRenderer.invoke('open-file-dialog'),
  openFolderDialog:  () => ipcRenderer.invoke('open-folder-dialog'),
  openImageDialog:   () => ipcRenderer.invoke('open-image-dialog'),
  readFileMetadata:  (filePath) => ipcRenderer.invoke('read-file-metadata', filePath),

  getSystemFonts:            ()               => ipcRenderer.invoke('get-system-fonts'),

  searchSpotify:             (query)          => ipcRenderer.invoke('search-spotify', query),
  searchSpotifyArtists:      (query)          => ipcRenderer.invoke('search-spotify-artists', query),
  getSpotifyArtist:          (artistId)       => ipcRenderer.invoke('get-spotify-artist', artistId),
  getSpotifyAlbum:           (albumId)        => ipcRenderer.invoke('get-spotify-album', albumId),
  importSpotifyPlaylist:     (id)             => ipcRenderer.invoke('import-spotify-playlist', id),
  importDeezerPlaylist:      (id)             => ipcRenderer.invoke('import-deezer-playlist', id),
  resolveSpotifyToYouTube:   (title, artist)  => ipcRenderer.invoke('resolve-spotify-to-youtube', { title, artist }),

  resolveYouTube:         (url) => ipcRenderer.invoke('resolve-youtube', url),
  resolveYouTubePlaylist: (url) => ipcRenderer.invoke('resolve-youtube-playlist', url),
  resolveYouTubeRelated:  (videoId) => ipcRenderer.invoke('resolve-youtube-related', videoId),
  searchYouTube:          (query) => ipcRenderer.invoke('search-youtube', query),
  fetchImageBase64:       (url) => ipcRenderer.invoke('fetch-image-base64', url),
  writeMprisArtwork:      (cover, trackId) => ipcRenderer.invoke('write-mpris-artwork', { cover, trackId }),
  mprisLogPath:           () => ipcRenderer.invoke('mpris-log-path'),
  openMprisLog:           () => ipcRenderer.invoke('open-mpris-log'),
  fetchLyricsMain:   (opts) => ipcRenderer.invoke('fetch-lyrics-main', opts),
  streamProxyPort:   () => ipcRenderer.invoke('stream-proxy-port'),
  setCookieBrowser:      (browser) => ipcRenderer.invoke('set-cookie-browser', browser),
  getCookieBrowserStatus: () => ipcRenderer.invoke('get-cookie-browser-status'),
  setManualCookies:       (content) => ipcRenderer.invoke('set-manual-cookies', content),
  clearManualCookies:     () => ipcRenderer.invoke('clear-manual-cookies'),
  getManualCookiesStatus: () => ipcRenderer.invoke('get-manual-cookies-status'),
  importYoutubeLibrary:   () => ipcRenderer.invoke('import-youtube-library'),
  onYoutubeLibraryProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('youtube-library-progress', listener);
    return () => ipcRenderer.removeListener('youtube-library-progress', listener);
  },

  configDir:         () => ipcRenderer.invoke('config-dir'),
  configRead:        (name) => ipcRenderer.invoke('config-read', name),
  openExternalUrl:   (url) => ipcRenderer.invoke('open-external-url', url),
  configWrite:       (name, content) => ipcRenderer.invoke('config-write', { name, content }),
  configOpenFolder:  () => ipcRenderer.invoke('config-open-folder'),
  exportConfigFile:  (defaultName, content) => ipcRenderer.invoke('export-config-file', { defaultName, content }),
  importConfigFile:  () => ipcRenderer.invoke('import-config-file'),

  downloadPickFolder:  () => ipcRenderer.invoke('download-pick-folder'),
  downloadDefaultFolder: () => ipcRenderer.invoke('download-default-folder'),
  downloadYouTube:     (opts) => ipcRenderer.invoke('download-youtube', opts),
  downloadLocalFile:   (opts) => ipcRenderer.invoke('download-local-file', opts),
  downloadCancel:      (id) => ipcRenderer.invoke('download-cancel', id),
  onDownloadProgress:  (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },

  onSaveBeforeHide: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('save-before-hide', listener);
    return () => ipcRenderer.removeListener('save-before-hide', listener);
  },

  onOpenFilesExternal: (cb) => {
    const listener = (_e, files) => cb(files);
    ipcRenderer.on('open-files-external', listener);
    return () => ipcRenderer.removeListener('open-files-external', listener);
  },

  listIcons:       () => ipcRenderer.invoke('list-icons'),
  importIconFile:  () => ipcRenderer.invoke('import-icon-file'),

  getAppVersion:   () => ipcRenderer.invoke('get-app-version'),
  checkAppUpdate:  () => ipcRenderer.invoke('check-app-update'),
  applyAppUpdate:  () => ipcRenderer.invoke('apply-app-update'),
  restartApp:      () => ipcRenderer.send('restart-app'),
  onUpdateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },

  pathToFileUrl: (p) => {
    if (process.platform === 'win32') return 'file:///' + p.replace(/\\/g, '/');
    return 'file://' + p;
  },
  platform: process.platform,

  // --- Sesión de YouTube ---
  checkYoutubeSession: () => ipcRenderer.invoke('check-youtube-session'),

  // --- ListenBrainz (scrobbling) ---
  lbValidateToken: (token) => ipcRenderer.invoke('lb-validate-token', token),
  lbSubmitListen:  (payload) => ipcRenderer.invoke('lb-submit-listen', payload),

  // --- Discord Rich Presence ---
  rpcUpdate: (state) => ipcRenderer.send('rpc-update', state),

  // --- Mini-reproductor ---
  miniToggle: () => ipcRenderer.send('mini-toggle'),
  miniClose:  () => ipcRenderer.send('mini-close'),
  miniShowMain: () => ipcRenderer.send('mini-show-main'),
  miniSendState: (state) => ipcRenderer.send('mini-state', state),
  miniControl: (action) => ipcRenderer.send('mini-control', action),
  onMiniState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('mini-state', listener);
    return () => ipcRenderer.removeListener('mini-state', listener);
  },
  onMiniControl: (cb) => {
    const listener = (_e, action) => cb(action);
    ipcRenderer.on('mini-control', listener);
    return () => ipcRenderer.removeListener('mini-control', listener);
  },
});
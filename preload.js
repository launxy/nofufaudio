const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nofuf', {
  // Window
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  quit:     () => ipcRenderer.send('window-quit'),
  show:     () => ipcRenderer.send('window-show'),
  reload:   () => ipcRenderer.send('window-reload'),

  // Files / metadata
  openFileDialog:    () => ipcRenderer.invoke('open-file-dialog'),
  openFolderDialog:  () => ipcRenderer.invoke('open-folder-dialog'),
  openImageDialog:   () => ipcRenderer.invoke('open-image-dialog'),
  readFileMetadata:  (filePath) => ipcRenderer.invoke('read-file-metadata', filePath),

  // Sistema
  getSystemFonts:            ()               => ipcRenderer.invoke('get-system-fonts'),

  // Spotify
  searchSpotify:             (query)          => ipcRenderer.invoke('search-spotify', query),
  importSpotifyPlaylist:     (id)             => ipcRenderer.invoke('import-spotify-playlist', id),
  resolveSpotifyToYouTube:   (title, artist)  => ipcRenderer.invoke('resolve-spotify-to-youtube', { title, artist }),

  // YouTube
  resolveYouTube:         (url) => ipcRenderer.invoke('resolve-youtube', url),
  resolveYouTubePlaylist: (url) => ipcRenderer.invoke('resolve-youtube-playlist', url),
  searchYouTube:          (query) => ipcRenderer.invoke('search-youtube', query),
  fetchImageBase64:       (url) => ipcRenderer.invoke('fetch-image-base64', url),
  fetchLyricsMain:   (opts) => ipcRenderer.invoke('fetch-lyrics-main', opts),

  // Config (Documents/nofufaudioConfigs/)
  configDir:         () => ipcRenderer.invoke('config-dir'),
  configRead:        (name) => ipcRenderer.invoke('config-read', name),
  openExternalUrl:   (url) => ipcRenderer.invoke('open-external-url', url),
  configWrite:       (name, content) => ipcRenderer.invoke('config-write', { name, content }),
  configOpenFolder:  () => ipcRenderer.invoke('config-open-folder'),
  exportConfigFile:  (defaultName, content) => ipcRenderer.invoke('export-config-file', { defaultName, content }),
  importConfigFile:  () => ipcRenderer.invoke('import-config-file'),

  // Downloads
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

  pathToFileUrl: (p) => {
    if (process.platform === 'win32') return 'file:///' + p.replace(/\\/g, '/');
    return 'file://' + p;
  },
  platform: process.platform,
});
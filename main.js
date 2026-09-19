/* ═══════════════════════════════════════════════
   NOFUFAUDIO — Main Process (main.js)
   v3 — Iconos, descargas con progreso, configs en Documents,
        sync lyrics, exportar/importar configs.
═══════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');
const { spawn } = require('child_process');


let mainWindow;
let tray = null;
let isQuitting = false;

let musicMetadata;
(async () => { try { musicMetadata = await import('music-metadata'); } catch {} })();

/* ──────────────────────────────────────────────
   CONFIG FOLDER — Documents/nofufaudioConfigs/
   (adapta Windows/Linux/macOS via app.getPath)
────────────────────────────────────────────── */
function getConfigDir() {
  const docs = app.getPath('documents');
  const dir = path.join(docs, 'nofufaudioConfigs');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error('mkdir config', e); }
  return dir;
}

ipcMain.handle('config-dir', () => getConfigDir());

ipcMain.handle('config-read', (_, name) => {
  try {
    const p = path.join(getConfigDir(), name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch (e) { return null; }
});

ipcMain.handle('config-write', (_, { name, content }) => {
  try {
    const p = path.join(getConfigDir(), name);
    fs.writeFileSync(p, content, 'utf-8');
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config-open-folder', () => { shell.openPath(getConfigDir()); });
ipcMain.handle('open-external-url', (_, url) => { shell.openExternal(url); });

/* ──────────────────────────────────────────────
   FUENTES DEL SISTEMA
   Lee las fuentes instaladas en el SO y las devuelve
   ordenadas alfabéticamente para el selector de tipografía.
────────────────────────────────────────────── */
ipcMain.handle('get-system-fonts', async () => {
  return new Promise((resolve) => {
    const platform = process.platform;
    let cmd, args;

    if (platform === 'win32') {
      // PowerShell: leer fuentes del registro de Windows
      cmd = 'powershell';
      args = [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts').PSObject.Properties | ForEach-Object { $_.Name -replace ' \\(.*\\)','' } | Sort-Object -Unique`,
      ];
    } else if (platform === 'darwin') {
      cmd = 'system_profiler';
      args = ['SPFontsDataType', '-json'];
    } else {
      // Linux: fc-list
      cmd = 'fc-list';
      args = [':', 'family'];
    }

    const proc = spawn(cmd, args, { timeout: 10000 });
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', (code) => {
      try {
        const out = Buffer.concat(chunks).toString('utf-8');
        let fonts = [];

        if (platform === 'win32') {
          fonts = out.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 1 && !l.startsWith('PS') && !l.startsWith('-'));
        } else if (platform === 'darwin') {
          const data = JSON.parse(out);
          const items = data?.SPFontsDataType || [];
          const seen = new Set();
          for (const item of items) {
            const fam = item?.families?.[0]?.family || item?._name || '';
            if (fam && !seen.has(fam)) { seen.add(fam); fonts.push(fam); }
          }
        } else {
          fonts = out.split('\n')
            .flatMap(l => l.split(','))
            .map(l => l.trim())
            .filter(l => l.length > 1);
        }

        // Limpiar, deduplicar y ordenar
        const unique = [...new Set(fonts.map(f => f.trim()).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        );
        resolve(unique);
      } catch (e) {
        console.error('[fonts]', e);
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
});

ipcMain.handle('export-config-file', async (_, { defaultName, content }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar configuración',
    defaultPath: path.join(getConfigDir(), defaultName || 'nofufaudio-config.json'),
    filters: [{ name: 'Config JSON', extensions: ['json'] }, { name: 'Texto', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try { fs.writeFileSync(res.filePath, content, 'utf-8'); return { ok: true, path: res.filePath }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('import-config-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar configuración',
    defaultPath: getConfigDir(),
    properties: ['openFile'],
    filters: [{ name: 'Config', extensions: ['json', 'txt'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  try { return { path: res.filePaths[0], content: fs.readFileSync(res.filePaths[0], 'utf-8') }; }
  catch (e) { return null; }
});

/* ──────────────────────────────────────────────
   YT-DLP — localizador cross-platform
   Windows → yt-dlp.exe  |  Linux/macOS → yt-dlp (sin ext.)
   Aplica chmod +x automáticamente en Linux/macOS si hace falta.
────────────────────────────────────────────── */
function findYtDlp() {
  const isWin = process.platform === 'win32';

  // Directorios donde buscar (en orden de preferencia)
  const searchDirs = [
    process.resourcesPath,          // empaquetado con electron-builder (extraResources)
    __dirname,                       // dev / carpeta raíz del proyecto
    path.join(__dirname, 'bin'),     // subcarpeta opcional
  ].filter(Boolean);

  for (const dir of searchDirs) {
    // Intentar primero el binario nativo de la plataforma
    const nativeName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const nativePath = path.join(dir, nativeName);
    if (fs.existsSync(nativePath)) {
      if (!isWin) ensureExecutable(nativePath);
      return nativePath;
    }
    // Fallback: si estamos en Linux y solo hay .exe, NO usarlo
    // (un .exe no se puede ejecutar en Linux sin Wine)
  }

  // Último recurso: confiar en que yt-dlp está en PATH del sistema
  return isWin ? 'yt-dlp.exe' : 'yt-dlp';
}

/** Asegura que el binario tiene permisos de ejecución en Linux/macOS */
function ensureExecutable(binPath) {
  try {
    const stat = fs.statSync(binPath);
    // 0o111 = bits de ejecución para owner/group/others
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(binPath, stat.mode | 0o755);
    }
  } catch (e) {
    console.warn('[yt-dlp] No se pudo hacer chmod +x:', e.message);
  }
}

/* ──────────────────────────────────────────────
   YT-DLP — resolver stream URL
────────────────────────────────────────────── */
function resolveWithYtDlp(videoId) {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    // Use a single --print with a fixed delimiter so we never confuse field order
    // Fields: TITLE|||UPLOADER|||THUMBNAIL|||STREAMURL
    const args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
      '--print', '%(title)s|||%(uploader)s|||%(thumbnail)s|||%(url)s',
      videoUrl
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 30000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        if (stderr.includes('unavailable') || stderr.includes('not available'))
          return resolve({ type:'error', message:'Vídeo no disponible.' });
        if (stderr.includes('Private video')) return resolve({ type:'error', message:'Vídeo privado.' });
        if (stderr.includes('Sign in') || stderr.includes('age'))
          return resolve({ type:'error', message:'Requiere inicio de sesión / edad.' });
        if (code === 127 || stderr.includes('not found') || stderr.includes('No such file'))
          return resolve({ type:'error', message:'yt-dlp no encontrado.' });
        return resolve({ type:'error', message:`Error yt-dlp: ${stderr.slice(0,180)}` });
      }
      const line = stdout.trim().split('\n').find(l => l.includes('|||'));
      if (!line) return resolve({ type:'error', message:'Respuesta yt-dlp incompleta.' });
      const parts = line.split('|||');
      if (parts.length < 4) return resolve({ type:'error', message:'Respuesta yt-dlp incompleta.' });
      const [title, artist, thumbnail, streamUrl] = parts;
      if (!streamUrl?.startsWith('http')) return resolve({ type:'error', message:'No se obtuvo URL de stream.' });
      resolve({ type:'success', videoId, title, artist, thumbnail, streamUrl });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type:'error', message:'yt-dlp no encontrado.' });
      else resolve({ type:'error', message:`Error yt-dlp: ${err.message}` });
    });
  });
}

ipcMain.handle('resolve-youtube', async (_, inputUrl) => {
  let videoId = '';
  try {
    if (inputUrl.includes('youtu.be/'))  videoId = inputUrl.split('youtu.be/')[1].split(/[?#]/)[0];
    else if (inputUrl.includes('v='))    videoId = inputUrl.split('v=')[1].split('&')[0];
    else if (inputUrl.includes('embed/')) videoId = inputUrl.split('embed/')[1].split(/[?#]/)[0];
    else videoId = inputUrl.trim();
  } catch { return { type:'error', message:'Enlace inválido.' }; }
  if (!videoId || videoId.length !== 11) return { type:'error', message:'ID YouTube inválido.' };
  return await resolveWithYtDlp(videoId);
});

/* ──────────────────────────────────────────────
   YT-DLP — resolver playlist completa
────────────────────────────────────────────── */
function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list') || null;
  } catch { return null; }
}

ipcMain.handle('resolve-youtube-playlist', async (event, playlistUrl) => {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    const playlistId = extractPlaylistId(playlistUrl);
    const targetUrl = playlistId
      ? `https://www.youtube.com/playlist?list=${playlistId}`
      : playlistUrl;

    // Phase 1: get flat playlist metadata (fast)
    const args = [
      '--yes-playlist', '--no-warnings', '--flat-playlist',
      '--print', '%(id)s|||%(title)s|||%(uploader)s|||%(thumbnail)s|||%(duration)s',
      targetUrl
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 120000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        if (code === 127 || stderr.includes('not found') || stderr.includes('No such file'))
          return resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
        if (stderr.includes('private') || stderr.includes('Private'))
          return resolve({ type: 'error', message: 'Playlist privada.' });
        return resolve({ type: 'error', message: `Error yt-dlp: ${stderr.slice(0, 200)}` });
      }
      const lines = stdout.trim().split('\n').filter(l => l.includes('|||'));
      if (!lines.length) return resolve({ type: 'error', message: 'No se encontraron vídeos en la playlist.' });

      // Get playlist title from stderr/stdout header if available
      let playlistTitle = 'Playlist de YouTube';
      const titleMatch = stderr.match(/\[download\] Downloading playlist: (.+)/);
      if (titleMatch) playlistTitle = titleMatch[1].trim();

      const videos = lines.map(line => {
        const parts = line.split('|||');
        const [id, title, uploader, thumbnail, durationRaw] = parts;
        const dur = parseInt(durationRaw) || 0;
        return { id: id?.trim(), title: title?.trim() || 'Sin título', uploader: uploader?.trim() || '', thumbnail: thumbnail?.trim() || '', duration: dur };
      }).filter(v => v.id && v.id.length === 11);

      resolve({ type: 'success', playlistTitle, playlistId: playlistId || 'yt-pl', videos });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
      else resolve({ type: 'error', message: `Error yt-dlp: ${err.message}` });
    });
  });
});

/* ──────────────────────────────────────────────
   BÚSQUEDA YouTube (yt-dlp)
────────────────────────────────────────────── */
ipcMain.handle('search-youtube', async (_, query) => {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    const searchUrl = `ytsearch15:${query}`;
    const args = [
      '--no-playlist', '--no-warnings', '--flat-playlist',
      '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s|%(thumbnail)s',
      searchUrl
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 30000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        if (code === 127 || stderr.includes('not found') || stderr.includes('No such file'))
          return resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
        return resolve({ type: 'error', message: `Error yt-dlp: ${stderr.slice(0, 180)}` });
      }
      const results = stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('|');
        if (parts.length < 4) return null;
        const [id, title, uploader, duration, thumbnail] = parts;
        const dur = parseInt(duration) || 0;
        const mins = Math.floor(dur / 60);
        const secs = String(dur % 60).padStart(2, '0');
        return { id, title, uploader, duration: dur > 0 ? `${mins}:${secs}` : '—', thumbnail };
      }).filter(Boolean);
      resolve({ type: 'success', results });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
      else resolve({ type: 'error', message: `Error yt-dlp: ${err.message}` });
    });
  });
});

/* ──────────────────────────────────────────────
   SPOTDL-STYLE: Resolver canción de Spotify → videoId de YouTube
   Búsqueda "artista - título" igual que spotdl, sin descargar nada.
   Devuelve: { type:'success', videoId } | { type:'error', message }
────────────────────────────────────────────── */
function searchYouTubeForTrack(title, artist) {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    // Queries en orden de precisión (igual que spotdl)
    const cleanTitle = title.replace(/\s*[\(\[](feat\.|ft\.|with\s|prod\.|remix|version|remastered|explicit)[^\)\]]*[\)\]]/gi, '').trim();
    const primaryArtist = (artist || '').split(/[,&\/]/)[0].trim();
    const queries = [
      `${primaryArtist} - ${cleanTitle} audio`,
      `${primaryArtist} ${cleanTitle}`,
      `${artist} ${title}`,
    ];

    let attemptIndex = 0;
    function tryNext() {
      if (attemptIndex >= queries.length) {
        return resolve({ type: 'error', message: 'No encontrado en YouTube' });
      }
      const query = queries[attemptIndex++];
      const args = [
        '--no-playlist', '--no-warnings', '--flat-playlist',
        '--print', '%(id)s|%(title)s|%(uploader)s|%(duration)s',
        `ytsearch5:${query}`,
      ];
      let stdout = '', stderr = '';
      const proc = spawn(ytdlpBin, args, { timeout: 20000 });
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        if (code !== 0) return tryNext();
        const results = stdout.trim().split('\n').filter(Boolean).map(line => {
          const parts = line.split('|');
          if (parts.length < 3) return null;
          const [id, t, u, dur] = parts;
          return { id: id?.trim(), title: t?.trim() || '', uploader: u?.trim() || '', duration: parseInt(dur) || 0 };
        }).filter(r => r && r.id && r.id.length === 11);

        if (!results.length) return tryNext();

        // Scoring como spotdl: prioriza coincidencia de título y artista
        const titleLow  = cleanTitle.toLowerCase();
        const origLow   = title.toLowerCase();
        const artistLow = primaryArtist.toLowerCase();
        const allArtLow = (artist || '').toLowerCase();
        let best = null, bestScore = -Infinity;
        for (const r of results) {
          const rt = r.title.toLowerCase();
          const ru = r.uploader.toLowerCase();
          let score = 0;
          if (rt.includes(titleLow))          score += 4;
          else if (rt.includes(origLow))      score += 3;
          if (rt.includes(artistLow) || ru.includes(artistLow)) score += 3;
          allArtLow.split(/[,&\/]/).forEach(a => {
            const ac = a.trim();
            if (ac && (rt.includes(ac) || ru.includes(ac))) score += 1;
          });
          if (rt.includes('cover')    && !origLow.includes('cover'))   score -= 3;
          if (rt.includes('karaoke'))                                   score -= 5;
          if (rt.includes('tutorial'))                                  score -= 5;
          if (rt.includes('reaction'))                                  score -= 5;
          if (rt.includes('live')     && !origLow.includes('live'))    score -= 1;
          if (rt.includes('remix')    && !origLow.includes('remix'))   score -= 2;
          if (ru.includes('vevo') || ru.includes('oficial') || ru.includes('official')) score += 2;
          if (ru.includes(artistLow)) score += 2;
          if (score > bestScore) { bestScore = score; best = r; }
        }
        if (best && bestScore >= 0) return resolve({ type: 'success', videoId: best.id });
        if (best) return resolve({ type: 'success', videoId: best.id });
        tryNext();
      });
      proc.on('error', () => tryNext());
    }
    tryNext();
  });
}

ipcMain.handle('resolve-spotify-to-youtube', async (_, { title, artist }) => {
  return searchYouTubeForTrack(title, artist);
});

/* ──────────────────────────────────────────────
   DESCARGAS — YouTube (yt-dlp) y archivos locales
   Reporta progreso a la ventana via 'download-progress'
────────────────────────────────────────────── */
const activeDownloads = new Map(); // id -> proc

ipcMain.handle('download-pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('download-default-folder', () => {
  try { return app.getPath('music'); } catch { return app.getPath('downloads'); }
});

ipcMain.handle('download-youtube', async (_, { id, videoId, ytUrl, title, artist, outDir, format }) => {
  const ytdlpBin = findYtDlp();
  const url = ytUrl || `https://www.youtube.com/watch?v=${videoId}`;
  const safeTitle = (title || 'audio').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120);
  const safeArtist = (artist || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80);
  const baseName = safeArtist ? `${safeArtist} - ${safeTitle}` : safeTitle;

  const fmt = (format || 'mp3').toLowerCase();
  const useExtract = ['mp3','m4a','opus','wav','flac','aac'].includes(fmt);
  const args = [
    '--no-playlist', '--no-warnings',
    '-o', path.join(outDir, baseName + '.%(ext)s'),
    '--newline', '--progress',
  ];
  if (useExtract) {
    args.push('-x', '--audio-format', fmt, '--audio-quality', '0');
  } else {
    args.push('-f', 'bestaudio');
  }
  args.push(url);

  return new Promise(resolve => {
    let stderr = '';
    const proc = spawn(ytdlpBin, args);
    activeDownloads.set(id, proc);

    const send = (data) => { try { mainWindow?.webContents.send('download-progress', { id, ...data }); } catch {} };
    send({ status: 'starting', percent: 0 });

    const handle = (chunk) => {
      const txt = chunk.toString();
      txt.split(/\r?\n/).forEach(line => {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = parseFloat(m[1]);
          const speedM = line.match(/at\s+([\d.]+\w+\/s)/);
          const etaM = line.match(/ETA\s+([\d:]+)/);
          send({ status:'downloading', percent: pct, speed: speedM?.[1], eta: etaM?.[1] });
        } else if (line.includes('[ExtractAudio]') || line.includes('Destination:')) {
          send({ status:'processing', percent: 99, message: line.slice(0, 120) });
        }
      });
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', d => { stderr += d.toString(); handle(d); });

    proc.on('close', code => {
      activeDownloads.delete(id);
      if (code === 0) {
        send({ status:'done', percent: 100, path: outDir });
        resolve({ ok: true, path: outDir });
      } else {
        send({ status:'error', percent: 0, error: stderr.slice(0,200) || `Código ${code}` });
        resolve({ ok: false, error: stderr.slice(0,200) || `Código ${code}` });
      }
    });
    proc.on('error', err => {
      activeDownloads.delete(id);
      send({ status:'error', percent: 0, error: err.message });
      resolve({ ok: false, error: err.message });
    });
  });
});

ipcMain.handle('download-local-file', async (_, { id, srcPath, outDir, title, artist }) => {
  return new Promise(resolve => {
    try {
      if (!fs.existsSync(srcPath)) return resolve({ ok:false, error:'Archivo origen no existe' });
      const ext = path.extname(srcPath);
      const safeTitle = (title || path.basename(srcPath, ext)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0,120);
      const safeArtist = (artist || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0,80);
      const baseName = safeArtist ? `${safeArtist} - ${safeTitle}${ext}` : `${safeTitle}${ext}`;
      const dest = path.join(outDir, baseName);
      const total = fs.statSync(srcPath).size;
      const send = (data) => { try { mainWindow?.webContents.send('download-progress', { id, ...data }); } catch {} };
      send({ status:'starting', percent: 0 });
      const rs = fs.createReadStream(srcPath);
      const ws = fs.createWriteStream(dest);
      let copied = 0;
      rs.on('data', chunk => {
        copied += chunk.length;
        const pct = total ? (copied / total) * 100 : 0;
        send({ status:'downloading', percent: pct });
      });
      rs.on('error', err => { send({ status:'error', error: err.message }); resolve({ ok:false, error: err.message }); });
      ws.on('error', err => { send({ status:'error', error: err.message }); resolve({ ok:false, error: err.message }); });
      ws.on('finish', () => { send({ status:'done', percent: 100, path: dest }); resolve({ ok:true, path: dest }); });
      rs.pipe(ws);
    } catch (e) { resolve({ ok:false, error: e.message }); }
  });
});

ipcMain.handle('download-cancel', (_, id) => {
  const proc = activeDownloads.get(id);
  if (proc) { try { proc.kill(); } catch {} activeDownloads.delete(id); return true; }
  return false;
});

/* ──────────────────────────────────────────────
   SPOTIFY SEARCH — usa Deezer API (gratuita, sin cuenta, sin token)
   Devuelve los mismos campos que antes: título, artista, álbum, portada, duración.
────────────────────────────────────────────── */
ipcMain.handle('search-spotify', async (_, query) => {
  if (!query || !query.trim()) return { type: 'error', message: 'Búsqueda vacía.' };
  try {
    const q = encodeURIComponent(query.trim());
    const url = `https://api.deezer.com/search?q=${q}&limit=20&output=json`;
    const r = await fetchUrl(url);

    if (r.status === 429) return { type: 'error', message: 'Demasiadas peticiones. Espera un momento.' };
    if (r.status !== 200) return { type: 'error', message: `Error de búsqueda (${r.status}). Inténtalo de nuevo.` };

    let data;
    try { data = JSON.parse(r.body); }
    catch(e) { return { type: 'error', message: 'Respuesta inválida del servidor.' }; }

    const items = data.data || [];
    if (!items.length) return { type: 'success', results: [] };

    const tracks = items.map(t => ({
      id:         String(t.id || ''),
      title:      t.title       || 'Sin título',
      artist:     t.artist?.name || 'Artista desconocido',
      album:      t.album?.title || '',
      duration:   t.duration    || 0,
      cover:      t.album?.cover_medium || t.album?.cover || '',
      previewUrl: t.preview     || null,
      spotifyUrl: t.link        || '',
      explicit:   t.explicit_lyrics || false,
      popularity: t.rank        || 0,
    })).filter(t => t.id);

    return { type: 'success', results: tracks };
  } catch (e) {
    console.error('[search-deezer]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});


/* ──────────────────────────────────────────────
   IMPORTAR PLAYLIST DE SPOTIFY
   Usa SpotifyScraper (sin API key ni credenciales).
   pip install spotifyscraper
────────────────────────────────────────────── */

ipcMain.handle('import-spotify-playlist', async (_, playlistId) => {
  try {
    const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;

    // Ejecutar script Python con SpotifyScraper
    // En producción los .py están en extraResources (process.resourcesPath),
    // en dev están junto a main.js (__dirname)
    const scriptName = 'spotify_scraper_helper.py';
    const scriptPath = [process.resourcesPath, __dirname]
      .filter(Boolean)
      .map(d => path.join(d, scriptName))
      .find(p => fs.existsSync(p)) || path.join(__dirname, scriptName);
    const result = await new Promise((resolve) => {
      // PYTHONUTF8=1 y PYTHONIOENCODING fuerzan UTF-8 en Windows (evita cp1252)
      const spawnEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
      const proc = spawn('python3', [scriptPath, playlistUrl], { timeout: 60000, env: spawnEnv });
      const chunks = [];
      const errChunks = [];
      proc.stdout.on('data', c => chunks.push(c));
      proc.stderr.on('data', c => errChunks.push(c));
      proc.on('close', (code) => {
        const out = Buffer.concat(chunks).toString().trim();
        const err = Buffer.concat(errChunks).toString().trim();
        if (code !== 0 || !out) {
          resolve({ ok: false, error: err || `Exit code ${code}` });
        } else {
          try {
            // Buscar la línea JSON pura (empieza con '{') por si SpotifyScraper
            // cuela algún log INFO en stdout
            const jsonLine = out.split('\n').find(l => l.trimStart().startsWith('{'));
            if (!jsonLine) throw new Error('No JSON line found');
            resolve({ ok: true, data: JSON.parse(jsonLine) });
          } catch(e) {
            resolve({ ok: false, error: 'JSON parse error: ' + out.slice(0, 300) });
          }
        }
      });
      proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    });

    if (!result.ok) {
      return { type: 'error', message: `Error al importar: ${result.error}` };
    }

    const { playlistTitle, tracks: spTracks } = result.data;

    if (!spTracks?.length) {
      return { type: 'error', message: 'La playlist está vacía o no tiene canciones accesibles.' };
    }

    // Enriquecer con Deezer solo si falta cover o duración
    const resolved = [];
    for (const sp of spTracks) {
      if (sp.cover && sp.duration) {
        resolved.push(sp);
        continue;
      }
      try {
        const primaryArtist = (sp.artist || '').split(/[,&]/)[0].trim();
        const q = primaryArtist
          ? `artist:"${primaryArtist}" track:"${sp.title}"`
          : `track:"${sp.title}"`;
        const sr = await fetchUrlJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
        if (sr.ok && sr.data?.data?.length) {
          const titleLow  = sp.title.toLowerCase();
          const artistLow = primaryArtist.toLowerCase();
          let best = sr.data.data[0];
          for (const r of sr.data.data) {
            const rt = (r.title || '').toLowerCase();
            const ra = (r.artist?.name || '').toLowerCase();
            if ((rt.includes(titleLow) || titleLow.includes(rt)) &&
                (!artistLow || ra.includes(artistLow) || artistLow.includes(ra))) {
              best = r; break;
            }
          }
          resolved.push({
            ...sp,
            album:    sp.album || best.album?.title || '',
            duration: sp.duration || best.duration || 0,
            cover:    sp.cover || best.album?.cover_medium || best.album?.cover || '',
          });
        } else {
          resolved.push(sp);
        }
      } catch { resolved.push(sp); }
    }

    console.log(`[sp-import] "${playlistTitle}" — ${resolved.length} canciones listas`);
    return { type: 'success', playlistTitle, tracks: resolved };

  } catch (e) {
    console.error('[sp-import]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});


// Helper: fetch URL y parsear JSON, con headers opcionales
function fetchUrlJson(url, extraHeaders = {}, parseJson = true) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const doFetch = (targetUrl, depth = 0) => {
      if (depth > 5) { resolve({ ok: false }); return; }
      try {
        const req = client.get(targetUrl, {
          timeout: 12000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': parseJson ? 'application/json' : 'text/html',
            ...extraHeaders,
          },
        }, (res) => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            doFetch(res.headers.location, depth + 1); return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (!parseJson) { resolve({ ok: res.statusCode === 200, raw }); return; }
            try {
              const data = JSON.parse(raw);
              resolve({ ok: res.statusCode === 200, data });
            } catch(e) {
              resolve({ ok: false, raw });
            }
          });
          res.on('error', () => resolve({ ok: false }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      } catch(e) { resolve({ ok: false }); }
    };
    doFetch(url);
  });
}

/* ──────────────────────────────────────────────
   FETCH genérico (CORS bypass)
────────────────────────────────────────────── */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const doFetch = (targetUrl, depth = 0) => {
      if (depth > 5) { reject(new Error('Too many redirects')); return; }
      try {
        const req = client.get(targetUrl, { timeout: 10000, headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }}, (res) => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            doFetch(res.headers.location, depth + 1); return;
          }
          let data = '';
          res.on('data', c => data += c.toString());
          res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      } catch(e) { reject(e); }
    };
    doFetch(url);
  });
}

/* ──────────────────────────────────────────────
   LYRICS — devuelve plain + synced (LRC) si existe
────────────────────────────────────────────── */
ipcMain.handle('fetch-lyrics-main', async (_, { title, artist, romaji }) => {
  const cleanTitle  = (title||'').replace(/\(.*?\)/g,'').replace(/\[.*?\]/g,'').replace(/ft\.?.*/i,'').trim();
  const cleanArtist = (artist||'').replace(/\s*ft\.?.*/i,'').split(',')[0].split('&')[0].trim();

  // ── Helper: scrape Genius lyrics page ────────────────────────────────────
  async function scrapeGeniusPage(url) {
    try {
      const page = await fetchUrl(url);
      if (page.status !== 200) return null;
      const containers = [];
      const regex = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let m; while ((m = regex.exec(page.body)) !== null) containers.push(m[1]);
      if (!containers.length) return null;
      let raw = containers.join('\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'');
      raw = raw.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
               .replace(/&quot;/g,'"').replace(/&#x27;/gi,"'").replace(/&#39;/g,"'").replace(/&apos;/g,"'");
      raw = raw.trim();
      return raw.length > 20 ? raw : null;
    } catch(e) { return null; }
  }

  // ── Helper: Genius API search → array of {label, url, lyrics, source} ───
  async function searchGeniusAll(query, maxHits = 5) {
    const results = [];
    try {
      const r = await fetchUrl(`https://genius.com/api/search/multi?per_page=${maxHits}&q=${encodeURIComponent(query)}`);
      if (r.status !== 200) return results;
      const data = JSON.parse(r.body);
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      for (const h of hits.slice(0, maxHits)) {
        if (!h?.result?.url) continue;
        const lyr = await scrapeGeniusPage(h.result.url);
        if (lyr) results.push({
          label: `${h.result.title} — ${h.result.primary_artist?.name || ''}`.trim(),
          url:   h.result.url,
          lyrics: lyr,
          synced: null,
          source: 'Genius'
        });
      }
    } catch(e) { console.log('[genius]', e.message); }
    return results;
  }

  // ── ROMAJI MODE ───────────────────────────────────────────────────────────
  // Only searches genius.com/artists/Genius-romanizations
  if (romaji) {
    const romajiResults = [];
    try {
      // Search the Genius Romanizations artist page
      const artistPageUrl = `https://genius.com/artists/Genius-romanizations`;
      const searchQ = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
      const r = await fetchUrl(`https://genius.com/api/search/multi?per_page=8&q=${encodeURIComponent(cleanTitle + ' romanized')}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
        for (const h of hits.slice(0, 8)) {
          if (!h?.result?.url) continue;
          // Filter: only results from Genius Romanizations artist
          const artistName = (h.result.primary_artist?.name || '').toLowerCase();
          const songTitle  = (h.result.title || '').toLowerCase();
          if (!artistName.includes('genius') && !artistName.includes('romanization') &&
              !songTitle.includes('romanized') && !songTitle.includes('romaji') &&
              !h.result.url.includes('romanized') && !h.result.url.includes('romaji')) continue;
          const lyr = await scrapeGeniusPage(h.result.url);
          if (lyr) romajiResults.push({
            label: h.result.title || songTitle,
            url:   h.result.url,
            lyrics: lyr,
            synced: null,
            source: 'Genius Romanizations'
          });
        }
      }
      // Also try direct artist page search
      const r2 = await fetchUrl(`https://genius.com/api/search/multi?per_page=8&q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist + ' romanized')}`);
      if (r2.status === 200) {
        const data2 = JSON.parse(r2.body);
        const hits2 = data2?.response?.sections?.find(s => s.type === 'song')?.hits || [];
        for (const h of hits2.slice(0, 8)) {
          if (!h?.result?.url) continue;
          const artistName = (h.result.primary_artist?.name || '').toLowerCase();
          const songTitle  = (h.result.title || '').toLowerCase();
          if (!artistName.includes('genius') && !artistName.includes('romanization') &&
              !songTitle.includes('romanized') && !songTitle.includes('romaji') &&
              !h.result.url.includes('romanized') && !h.result.url.includes('romaji')) continue;
          const alreadyIn = romajiResults.some(x => x.url === h.result.url);
          if (alreadyIn) continue;
          const lyr = await scrapeGeniusPage(h.result.url);
          if (lyr) romajiResults.push({
            label: h.result.title || songTitle,
            url:   h.result.url,
            lyrics: lyr,
            synced: null,
            source: 'Genius Romanizations'
          });
        }
      }
    } catch(e) { console.log('[romaji]', e.message); }

    if (romajiResults.length > 0) {
      return { found:true, multiple: romajiResults.length > 1, results: romajiResults,
               lyrics: romajiResults[0].lyrics, synced: null, source: romajiResults[0].source };
    }
    return { found:false };
  }

  // ── NORMAL MODE — collect from all providers ──────────────────────────────
  const allResults = [];

  // 1) lrclib — synced preferred
  try {
    const r = await fetchUrl(`https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`);
    if (r.status === 200) {
      const list = JSON.parse(r.body);
      for (const item of list.slice(0, 3)) {
        if (item.syncedLyrics && item.syncedLyrics.length > 20) {
          allResults.push({ label:`${item.trackName} — ${item.artistName}`, lyrics: item.plainLyrics || item.syncedLyrics, synced: item.syncedLyrics, source:'LRCLib (sync)' });
        } else if (item.plainLyrics && item.plainLyrics.length > 20) {
          allResults.push({ label:`${item.trackName} — ${item.artistName}`, lyrics: item.plainLyrics, synced: null, source:'LRCLib' });
        }
      }
    }
  } catch(e) { console.log('[lrclib]', e.message); }

  // 2) Genius — TITULO + ARTISTA (up to 3 hits)
  const gHits = await searchGeniusAll(`${cleanTitle} ${cleanArtist}`, 3);
  allResults.push(...gHits);

  // 3) AZLyrics
  try {
    const azQ = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
    const r = await fetchUrl(`https://search.azlyrics.com/search.php?q=${azQ}&w=songs`);
    if (r.status === 200) {
      const linkMatch = r.body.match(/href="(https:\/\/www\.azlyrics\.com\/lyrics\/[^"]+\.html)"/);
      if (linkMatch) {
        const page = await fetchUrl(linkMatch[1]);
        if (page.status === 200) {
          const rm = page.body.match(/<!-- Usage of azlyrics[\s\S]*?-->([\s\S]*?)<!-- MxM banner/);
          if (rm) {
            let raw = rm[1].replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
            if (raw.length > 20) allResults.push({ label: `${cleanTitle} — AZLyrics`, lyrics: raw, synced: null, source:'AZLyrics' });
          }
        }
      }
    }
  } catch(e) {}

  // 4) lyrics.ovh
  try {
    const r = await fetchUrl(`https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`);
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      if (data.lyrics?.length > 20) allResults.push({ label:`${cleanTitle} — lyrics.ovh`, lyrics: data.lyrics, synced: null, source:'lyrics.ovh' });
    }
  } catch(e) {}

  // 5) Musixmatch
  try {
    const mmQ = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
    const r = await fetchUrl(`https://www.musixmatch.com/search/${mmQ}/tracks`);
    if (r.status === 200) {
      const linkMatch = r.body.match(/href="(\/lyrics\/[^"?]+)"[^>]*class="[^"]*title[^"]*"/);
      if (linkMatch) {
        const page = await fetchUrl(`https://www.musixmatch.com${linkMatch[1]}`);
        if (page.status === 200) {
          const parts = [];
          const re = /class="[^"]*lyrics__content__ok[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
          let m2; while ((m2 = re.exec(page.body)) !== null) parts.push(m2[1]);
          if (parts.length) {
            let raw = parts.join('\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
            if (raw.length > 20) allResults.push({ label:`${cleanTitle} — Musixmatch`, lyrics: raw, synced: null, source:'Musixmatch' });
          }
        }
      }
    }
  } catch(e) {}

  if (allResults.length === 0) return { found:false };

  return {
    found:    true,
    multiple: allResults.length > 1,
    results:  allResults,
    // default to first result
    lyrics:   allResults[0].lyrics,
    synced:   allResults[0].synced || null,
    source:   allResults[0].source
  };
});

/* ──────────────────────────────────────────────
   IMAGE/FILE helpers
────────────────────────────────────────────── */
ipcMain.handle('fetch-image-base64', async (_, url) => {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const fetch = (targetUrl, depth = 0) => {
      if (depth > 3) { resolve(null); return; }
      client.get(targetUrl, { timeout: 8000 }, (res) => {
        if ([301,302].includes(res.statusCode)) { fetch(res.headers.location, depth + 1); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const mime = res.headers['content-type'] || 'image/jpeg';
          resolve(`data:${mime};base64,${buf.toString('base64')}`);
        });
      }).on('error', () => resolve(null));
    };
    fetch(url);
  });
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name:'Audio', extensions:['mp3','flac','wav','ogg','m4a','aac','opus'] }]
  });
  return result.filePaths;
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties:['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return [];
  try { return fs.readdirSync(result.filePaths[0]).map(f => path.join(result.filePaths[0], f)); }
  catch { return []; }
});

ipcMain.handle('read-file-metadata', async (_, filePath) => {
  try {
    if (!musicMetadata) return { title: path.basename(filePath), artist: 'Unknown', duration:0, cover:null };
    const md = await musicMetadata.parseFile(filePath);
    let coverUrl = null;
    if (md.common.picture?.length > 0) {
      const pic = md.common.picture[0];
      coverUrl = `data:${pic.format};base64,${pic.data.toString('base64')}`;
    }
    return {
      title: md.common.title || path.basename(filePath),
      artist: md.common.artist || 'Artista Desconocido',
      duration: md.format.duration || 0,
      cover: coverUrl
    };
  } catch {
    return { title: path.basename(filePath), artist:'Unknown', duration:0, cover:null };
  }
});

ipcMain.handle('open-image-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties:['openFile'],
    filters:[{ name:'Imágenes', extensions:['jpg','jpeg','png','webp','gif'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const data = fs.readFileSync(r.filePaths[0]);
    const ext = path.extname(r.filePaths[0]).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch { return null; }
});

/* ──────────────────────────────────────────────
   WINDOW
────────────────────────────────────────────── */
function resolveIcon() {
  const candidates = [
    path.join(__dirname, 'logonofufaudio.png'),
    path.join(__dirname, 'logonofufaudio.ico'),
    path.join(process.resourcesPath || __dirname, 'logonofufaudio.png'),
    path.join(process.resourcesPath || __dirname, 'logonofufaudio.ico'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}
// 

function createWindow() {
  const iconPath = resolveIcon();
  mainWindow = new BrowserWindow({
    width: 1100, height: 680, minWidth: 800, minHeight: 560,
    frame: false, transparent: false, backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    icon: iconPath || undefined,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  });
  
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      // Ask renderer to save settings before hiding
      mainWindow.webContents.send('save-before-hide');
      setTimeout(() => mainWindow.hide(), 120);
    }
  });
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-before-hide');
    setTimeout(() => mainWindow.hide(), 120);
  });

  // --- CÓDIGO PARA EL MENÚ DE DESARROLLADOR ---
  const menu = Menu.buildFromTemplate([
    {
      label: 'Desarrollo',
      submenu: [
        {
          label: 'Abrir DevTools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => { mainWindow.webContents.toggleDevTools(); }
        },
        {
          label: 'Reiniciar app',
          accelerator: 'CmdOrCtrl+R',
          click: () => { mainWindow.webContents.reload(); }
        },
        {
          label: 'Reiniciar app (F5)',
          accelerator: 'F5',
          click: () => { mainWindow.webContents.reload(); }
        },
        { role: 'reload' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
  // -------------------------------------------
}

// 

function createTray() {
  const iconPath = resolveIcon();
  let trayIcon;
  if (iconPath) {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') trayIcon = trayIcon.resize({ width: 18, height: 18 });
    else trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Nofufaudio');
  const ctx = Menu.buildFromTemplate([
    { label:'Abrir Nofufaudio', click:()=>{ mainWindow.show(); mainWindow.focus(); } },
    { type:'separator' },
    { label:'Carpeta de configuración', click: () => shell.openPath(getConfigDir()) },
    { type:'separator' },
    { label:'Salir', click:()=>{ isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(ctx);
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.nofufaudio');
  createWindow();
  createTray();
});

ipcMain.on('window-minimize', () => {
  mainWindow.webContents.send('save-before-hide');
  setTimeout(() => mainWindow.hide(), 120);
});
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow.close());
ipcMain.on('window-quit',     () => { isQuitting = true; app.quit(); });
ipcMain.on('window-show',     () => { mainWindow.show(); mainWindow.focus(); });
ipcMain.on('window-reload',   () => { if (mainWindow) mainWindow.webContents.reload(); });

app.on('before-quit', () => isQuitting = true);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
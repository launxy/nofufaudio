
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const discordRPC = require('./discordRPC');

function findPython3() {
  const venvPy = path.join(os.homedir(), '.local', 'share', 'nofufaudio', 'venv', 'bin', 'python3');
  try { if (fs.existsSync(venvPy)) return venvPy; } catch (_) {}
  return 'python3';
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('mpris-name', 'nofufaudio');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
  app.commandLine.appendSwitch('num-raster-threads', '2');
  if (process.env.NOFUF_SINGLE_PROCESS) {
    app.commandLine.appendSwitch('single-process');
  }
}

let _proxyPort = 0;
let _proxyServer = null;

function startStreamProxy() {
  return new Promise((resolve) => {
    function pipeStream(targetUrl, req, res, redirectCount = 0) {
      if (redirectCount > 5) {
        if (!res.headersSent) { res.writeHead(508); res.end('Too many redirects'); }
        return;
      }
      try {
        const parsed = new URL(targetUrl);
        const clientMod = parsed.protocol === 'http:' ? http : https;
        const isHead = req.method === 'HEAD';
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.pathname + parsed.search,
          method: isHead ? 'HEAD' : 'GET',
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
            'Connection': 'keep-alive'
          },
        };
        // Reenviar cabeceras de rango / caché del <audio> para que el seek funcione
        for (const h of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
          if (req.headers[h]) options.headers[h] = req.headers[h];
        }

        const proxyReq = clientMod.request(options, (proxyRes) => {
          const status = proxyRes.statusCode;
          if (status >= 300 && status < 400 && proxyRes.headers.location) {
            let nextLoc = proxyRes.headers.location;
            if (!nextLoc.startsWith('http')) nextLoc = new URL(nextLoc, targetUrl).href;
            try { proxyRes.resume(); } catch (_) {}
            return pipeStream(nextLoc, req, res, redirectCount + 1);
          }

          // googlevideo a veces devuelve 403 con URL expirada o 429 por throttle:
          // no intentar reproducirlo, devolver el código para que el renderer re-resuelva
          if (status !== 200 && status !== 206 && status !== 304) {
            console.error('[proxy] upstream status:', status, 'for', parsed.hostname);
            try { proxyRes.resume(); } catch (_) {}
            if (!res.headersSent) {
              res.writeHead(status, { 'Access-Control-Allow-Origin': '*' });
              res.end();
            }
            return;
          }

          const ct = proxyRes.headers['content-type'] || 'audio/mp4';
          const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Content-Type': ct,
          };
          for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
            if (proxyRes.headers[h]) {
              const out = h.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('-');
              headers[out] = proxyRes.headers[h];
            }
          }
          // Algunos streams vienen sin Accept-Ranges pero sí soportan Range
          if (!headers['Accept-Ranges'] && (status === 206 || headers['Content-Range'])) {
            headers['Accept-Ranges'] = 'bytes';
          }
          res.writeHead(status, headers);
          if (isHead) { try { proxyRes.resume(); } catch (_) {}; res.end(); return; }
          proxyRes.pipe(res);
          const onClose = () => { try { proxyRes.destroy(); } catch (_) {} };
          req.on('close', onClose);
          res.on('close', onClose);
        });

        proxyReq.on('timeout', () => { try { proxyReq.destroy(); } catch (_) {} });
        proxyReq.on('error', (e) => {
          console.error('[proxy] error:', e.message);
          if (!res.headersSent) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
        });
        req.on('aborted', () => { try { proxyReq.destroy(); } catch (e) {} });
        proxyReq.end();
      } catch(e) {
        console.error('[proxy] exception:', e.message);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      }
    }

    _proxyServer = http.createServer((req, res) => {
      try {
        // Preflight CORS del <audio>
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Content-Length': '0',
          });
          res.end();
          return;
        }
        const urlObj = new URL('http://127.0.0.1' + req.url);
        const target = urlObj.searchParams.get('url');
        if (!target || (!target.startsWith('https://') && !target.startsWith('http://'))) {
          res.writeHead(400); res.end('Bad request'); return;
        }
        pipeStream(target, req, res, 0);
      } catch(e) {
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      }
    });

    _proxyServer.listen(0, '127.0.0.1', () => {
      _proxyPort = _proxyServer.address().port;
      console.log('[proxy] stream proxy en puerto', _proxyPort);
      resolve(_proxyPort);
    });
  });
}

let mainWindow;
let tray = null;
let isQuitting = false;

let musicMetadata = null;
async function getMusicMetadata() {
  if (!musicMetadata) {
    try { musicMetadata = await import('music-metadata'); } catch(e) { musicMetadata = null; }
  }
  return musicMetadata;
}

function getConfigDir() {
  const docs = app.getPath('documents');
  const dir = path.join(docs, 'nofufaudioConfigs');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error('mkdir config', e); }
  return dir;
}

ipcMain.handle('config-dir', () => getConfigDir());

const TRAY_I18N = {
  es: { tooltip: 'Nofufaudio', open: 'Abrir Nofufaudio', configFolder: 'Carpeta de configuración', quit: 'Salir' },
  en: { tooltip: 'Nofufaudio', open: 'Open Nofufaudio', configFolder: 'Config folder', quit: 'Quit' },
  pt: { tooltip: 'Nofufaudio', open: 'Abrir Nofufaudio', configFolder: 'Pasta de configuração', quit: 'Sair' },
  fr: { tooltip: 'Nofufaudio', open: 'Ouvrir Nofufaudio', configFolder: 'Dossier de configuration', quit: 'Quitter' },
  de: { tooltip: 'Nofufaudio', open: 'Nofufaudio öffnen', configFolder: 'Konfigurationsordner', quit: 'Beenden' },
  it: { tooltip: 'Nofufaudio', open: 'Apri Nofufaudio', configFolder: 'Cartella di configurazione', quit: 'Esci' },
  ca: { tooltip: 'Nofufaudio', open: 'Obre Nofufaudio', configFolder: 'Carpeta de configuració', quit: 'Surt' },
  gl: { tooltip: 'Nofufaudio', open: 'Abrir Nofufaudio', configFolder: 'Cartafol de configuración', quit: 'Saír' },
  eu: { tooltip: 'Nofufaudio', open: 'Ireki Nofufaudio', configFolder: 'Konfigurazio karpeta', quit: 'Irten' },
  ru: { tooltip: 'Nofufaudio', open: 'Открыть Nofufaudio', configFolder: 'Папка настроек', quit: 'Выйти' },
  ja: { tooltip: 'Nofufaudio', open: 'Nofufaudioを開く', configFolder: '設定フォルダ', quit: '終了' },
};

function getSavedLanguage() {
  try {
    const p = path.join(getConfigDir(), 'settings.json');
    if (!fs.existsSync(p)) return 'es';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
    const supported = ['es','en','pt','fr','de','it','ca','gl','eu','ru','ja'];
    return supported.includes(cfg.language) ? cfg.language : 'es';
  } catch (e) { return 'es'; }
}

const mprisArtDir = path.join(app.getPath('userData'), 'mpris-art');
const mprisLogPath = path.join(app.getPath('userData'), 'mpris-debug.log');

function logMpris(msg) {
  try { fs.appendFileSync(mprisLogPath, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
  console.log('[mpris-art]', msg);
}

try {
  fs.rmSync(mprisArtDir, { recursive: true, force: true });
  fs.mkdirSync(mprisArtDir, { recursive: true });
  fs.writeFileSync(mprisLogPath, `[${new Date().toISOString()}] --- arranque de la app ---\n`);
} catch (e) { console.error('[mpris-art] mkdir:', e.message); }

function downloadBuffer(url, { redirects = 3, timeoutMs = 8000, retries = 1 } = {}) {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(downloadBuffer(res.headers.location, { redirects: redirects - 1, timeoutMs, retries }));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          retryOrGiveUp();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => retryOrGiveUp());
      });
      req.on('error', () => retryOrGiveUp());
      req.setTimeout(timeoutMs, () => { req.destroy(); retryOrGiveUp(); });

      let settled = false;
      function retryOrGiveUp() {
        if (settled) return; settled = true;
        if (retries > 0) resolve(downloadBuffer(url, { redirects, timeoutMs, retries: retries - 1 }));
        else resolve(null);
      }
    } catch (e) { resolve(null); }
  });
}

function extFromUrl(url) {
  const m = /\.(png|jpe?g|webp)(\?|$)/i.exec(url);
  return m ? (m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()) : 'jpeg';
}

ipcMain.handle('write-mpris-artwork', async (_, { cover, trackId } = {}) => {
  try {
    if (!cover || typeof cover !== 'string') {
      logMpris(`track=${trackId} SIN portada (t.cover vacío) → no hay nada que cachear`);
      return null;
    }

    let buf, ext;
    if (cover.startsWith('data:image/')) {
      const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(cover);
      if (!match) {
        logMpris(`track=${trackId} data: URI con formato no reconocido (${cover.slice(0, 30)}...)`);
        return null;
      }
      ext = match[1] === 'jpg' ? 'jpeg' : match[1];
      buf = Buffer.from(match[2], 'base64');
      logMpris(`track=${trackId} portada local (data:${match[1]}, ${buf.length} bytes)`);
    } else if (/^https?:\/\//.test(cover)) {
      logMpris(`track=${trackId} descargando portada remota: ${cover}`);
      buf = await downloadBuffer(cover);
      if (!buf) {
        logMpris(`track=${trackId} FALLÓ la descarga de ${cover}`);
        return null;
      }
      ext = extFromUrl(cover);
      logMpris(`track=${trackId} descarga OK (${buf.length} bytes, ext=${ext})`);
    } else {
      logMpris(`track=${trackId} cover con formato no soportado: ${cover.slice(0, 60)}`);
      return null;
    }

    const safeId  = String(trackId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `art-${safeId}.${ext}`;
    const filePath = path.join(mprisArtDir, fileName);

    fs.writeFileSync(filePath, buf);
    logMpris(`track=${trackId} escrito OK → file://${filePath}`);
    return 'file://' + filePath;
  } catch (e) {
    logMpris(`track=${trackId} EXCEPCIÓN: ${e.message}`);
    return null;
  }
});

ipcMain.handle('mpris-log-path', () => mprisLogPath);
ipcMain.handle('open-mpris-log', () => { shell.openPath(mprisLogPath); });

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
    if (name === 'settings.json') {
      try { refreshTrayLanguage(); } catch (e) {}
      try { applyAppIcons(); } catch (e) {}
      try { _applyDiscordClientId(); } catch (e) {}
    }
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config-open-folder', () => { shell.openPath(getConfigDir()); });
ipcMain.handle('open-external-url', (_, url) => { shell.openExternal(url); });

ipcMain.handle('get-system-fonts', async () => {
  return new Promise((resolve) => {
    const platform = process.platform;
    let cmd, args;

    if (platform === 'win32') {
      cmd = 'powershell';
      args = [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts').PSObject.Properties | ForEach-Object { $_.Name -replace ' \\(.*\\)','' } | Sort-Object -Unique`,
      ];
    } else if (platform === 'darwin') {
      cmd = 'system_profiler';
      args = ['SPFontsDataType', '-json'];
    } else {
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

const COOKIE_BROWSER_CANDIDATES = process.platform === 'darwin'
  ? ['safari', 'chrome', 'firefox', 'brave', 'edge', 'chromium', 'vivaldi', 'opera']
  : ['chrome', 'firefox', 'brave', 'edge', 'chromium', 'vivaldi', 'opera'];

let _cookieBrowserResolved = null;
let _cookieBrowserProbe = null;
let _manualCookieBrowser = 'auto';

function _probeCookieBrowsers(ytdlpBin) {
  const tryOne = (browser) => new Promise((resolve) => {
    const args = [
      '--no-warnings', '--flat-playlist', '--playlist-end', '1',
      '--cookies-from-browser', browser,
      '--print', '%(id)s',
      'ytsearch1:test'
    ];
    const proc = spawn(ytdlpBin, args, { timeout: 12000 });
    let stdout = '', errored = false;
    proc.stdout.on('data', d => stdout += d.toString());
    proc.on('close', code => resolve(!errored && code === 0 && stdout.trim().length > 0));
    proc.on('error', () => { errored = true; resolve(false); });
  });

  return (async () => {
    for (const browser of COOKIE_BROWSER_CANDIDATES) {
      try {
        const ok = await tryOne(browser);
        if (ok) return browser;
      } catch (e) {  }
    }
    return false;
  })();
}

async function getCookieBrowser() {
  if (_manualCookieBrowser === 'none') return null;
  if (_manualCookieBrowser && _manualCookieBrowser !== 'auto') return _manualCookieBrowser;

  if (_cookieBrowserResolved !== null) return _cookieBrowserResolved || null;
  if (!_cookieBrowserProbe) _cookieBrowserProbe = _probeCookieBrowsers(findYtDlp());
  _cookieBrowserResolved = await _cookieBrowserProbe;
  return _cookieBrowserResolved || null;
}

ipcMain.handle('set-cookie-browser', (_, browser) => {
  _manualCookieBrowser = browser || 'auto';
  _cookieBrowserResolved = null;
  _cookieBrowserProbe = null;
  return true;
});

ipcMain.handle('get-cookie-browser-status', async () => {
  const detected = await getCookieBrowser();
  return {
    manual: _manualCookieBrowser,
    detected,
    candidates: COOKIE_BROWSER_CANDIDATES,
  };
});

const MANUAL_COOKIES_FILENAME = 'youtube_cookies.txt';
let _manualCookiesEnabled = false;

function getManualCookiesPath() {
  return path.join(getConfigDir(), MANUAL_COOKIES_FILENAME);
}

function looksLikeNetscapeCookies(content) {
  if (!content || typeof content !== 'string') return false;
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines.some(l => l.split('\t').length >= 6);
}

ipcMain.handle('set-manual-cookies', async (_, content) => {
  if (!looksLikeNetscapeCookies(content)) {
    return { ok: false, error: 'El contenido no parece un cookies.txt válido (formato Netscape).' };
  }
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(getManualCookiesPath(), content, 'utf-8');
    _manualCookiesEnabled = true;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clear-manual-cookies', async () => {
  _manualCookiesEnabled = false;
  try { fs.unlinkSync(getManualCookiesPath()); } catch {}
  return { ok: true };
});

ipcMain.handle('get-manual-cookies-status', async () => {
  const exists = fs.existsSync(getManualCookiesPath());
  if (exists && !_manualCookiesEnabled) _manualCookiesEnabled = true;
  return { active: _manualCookiesEnabled && exists, exists };
});

async function getCookieArgs() {
  if (_manualCookiesEnabled && fs.existsSync(getManualCookiesPath())) {
    return ['--cookies', getManualCookiesPath()];
  }
  const cookieBrowser = await getCookieBrowser();
  return cookieBrowser ? ['--cookies-from-browser', cookieBrowser] : [];
}

function findYtDlp() {
  const isWin = process.platform === 'win32';

  const searchDirs = [
    process.resourcesPath,
    __dirname,
    path.join(__dirname, 'bin'),
  ].filter(Boolean);

  for (const dir of searchDirs) {
    const nativeName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const nativePath = path.join(dir, nativeName);
    if (fs.existsSync(nativePath)) {
      if (!isWin) ensureExecutable(nativePath);
      return nativePath;
    }
  }

  return isWin ? 'yt-dlp.exe' : 'yt-dlp';
}

function ensureExecutable(binPath) {
  try {
    const stat = fs.statSync(binPath);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(binPath, stat.mode | 0o755);
    }
  } catch (e) {
    console.warn('[yt-dlp] No se pudo hacer chmod +x:', e.message);
  }
}

function updateYtDlp() {
  return new Promise((resolveUpdate) => {
    const ytdlpBin = findYtDlp();

    if (!fs.existsSync(ytdlpBin)) {
      return resolveUpdate({ updated: false, reason: 'not-bundled' });
    }

    console.log('[yt-dlp] Comprobando actualizaciones…');
    const proc = spawn(ytdlpBin, ['-U'], { timeout: 25000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      const out = stdout.trim();
      if (code !== 0) {
        console.warn('[yt-dlp] Auto-actualización falló:', stderr.slice(0, 200) || out.slice(0, 200));
        return resolveUpdate({ updated: false, reason: 'error' });
      }
      if (/up to date|actualizado/i.test(out)) {
        console.log('[yt-dlp] Ya estaba actualizado.');
        return resolveUpdate({ updated: false, reason: 'already-latest' });
      }
      console.log('[yt-dlp] Actualizado correctamente:', out.slice(0, 200));
      if (!isWinPlatform()) ensureExecutable(ytdlpBin);
      return resolveUpdate({ updated: true });
    });

    proc.on('error', (err) => {
      console.warn('[yt-dlp] No se pudo lanzar la auto-actualización:', err.message);
      resolveUpdate({ updated: false, reason: 'spawn-error' });
    });
  });
}

function isWinPlatform() {
  return process.platform === 'win32';
}

async function resolveWithYtDlp(videoId) {
  const ytdlpBin = findYtDlp();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const isManifest = (u) => /\.m3u8($|\?)|\.mpd($|\?)|\/manifest(\?|$)/i.test(u || '');

  const runExtract = (extraArgs = [], format = 'bestaudio/best', timeoutMs = 25000) => new Promise((resolve) => {
    const args = [
      '--no-playlist', '--no-warnings',
      '--retries', '3',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', '1',
      '--socket-timeout', '12',
      '--geo-bypass',
      ...extraArgs,
      '-f', format,
      '--print', '%(title)s|||%(uploader)s|||%(thumbnail)s|||%(url)s|||%(ext)s|%(abr)s|%(tbr)s|%(acodec)s',
      videoUrl
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: timeoutMs });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        const err = stderr || '';
        if (/unavailable|not available|Video unavailable/i.test(err))
          return resolve({ type:'error', message:'Vídeo no disponible.' });
        if (/Private video/i.test(err)) return resolve({ type:'error', message:'Vídeo privado.' });
        if (/Sign in|age|login required|PO Token|SABR|nsig|player response/i.test(err))
          return resolve({ type:'retry-auth', message:'Requiere inicio de sesión / edad.' });
        if (code === 127 || /not found|No such file/i.test(err))
          return resolve({ type:'error', message:'yt-dlp no encontrado.' });
        if (/Requested format is not available|no video formats|no audio formats/i.test(err))
          return resolve({ type:'retry-format', message:'Formato no disponible.' });
        // Fallo extrayendo cookies (navegador bloqueado, snap, permisos): no es fallo del vídeo,
        // reintentar sin cookies en vez de dar error
        if (/cookies|cookie.*database|lock|permission|Could not copy/i.test(err))
          return resolve({ type:'retry-nocookie', message:'Fallo de cookies.' });
        return resolve({ type:'error', message:`Error yt-dlp: ${err.slice(0,180)}` });
      }
      const line = stdout.trim().split('\n').find(l => l.includes('|||'));
      if (!line) return resolve({ type:'error', message:'Respuesta yt-dlp incompleta.' });
      const parts = line.split('|||');
      if (parts.length < 4) return resolve({ type:'error', message:'Respuesta yt-dlp incompleta.' });
      const [title, artist, thumbnail, streamUrl] = parts;
      if (!streamUrl?.startsWith('http')) return resolve({ type:'error', message:'No se obtuvo URL de stream.' });
      if (isManifest(streamUrl)) return resolve({ type:'retry-format', message:'Stream es manifiesto.' });

      // Calidad aproximada del stream para mostrarla en el reproductor
      let quality = '';
      if (parts[4]) {
        try {
          const [ext, abr, tbr, acodec] = parts[4].split('|');
          const kbps = Math.round(parseFloat(abr) || parseFloat(tbr) || 0);
          const codecRaw = (acodec && acodec !== 'NA' && acodec !== 'none') ? acodec : '';
          const codec = codecRaw
            ? (codecRaw.startsWith('mp4a') ? 'aac' : codecRaw.startsWith('ec-3') ? 'eac3' : codecRaw.startsWith('opus') ? 'opus' : codecRaw)
            : (ext && ext !== 'NA' ? ext : '');
          quality = [codec, kbps ? kbps + 'kbps' : ''].filter(Boolean).join(' · ');
        } catch (_) {}
      }
      const proxyUrl = `http://127.0.0.1:${_proxyPort}/stream?url=${encodeURIComponent(streamUrl)}`;
      resolve({ type:'success', videoId, title, artist, thumbnail, streamUrl: proxyUrl, quality });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type:'error', message:'yt-dlp no encontrado.' });
      else resolve({ type:'error', message:`Error yt-dlp: ${err.message}` });
    });
  });

  // IMPORTANTE: primero SIN cookies (comportamiento original que ya funcionaba para
  // la mayoría de vídeos públicos). Solo después se prueban cookies y clientes
  // alternativos. Así un fallo de cookies nunca rompe lo que ya funcionaba.
  // No se usa caché de cliente para no envenenar siguientes resoluciones.
  const ORIG_FMT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';
  let cookieArgs = [];
  try { cookieArgs = await getCookieArgs().catch(() => []); } catch (_) { cookieArgs = []; }

  // Clientes que siguen devolviendo URLs reproducibles (el cliente por defecto
  // de yt-dlp, TVHTML5, ahora da 403 en googlevideo tras los cambios de YouTube).
  const attempts = [
    { extra: ['--extractor-args', 'youtube:player_client=android,web'], fmt: ORIG_FMT },
    { extra: ['--extractor-args', 'youtube:player_client=android,web'], fmt: 'bestaudio/best' },
    { extra: [], fmt: ORIG_FMT },
    { extra: [], fmt: 'bestaudio/best' },
  ];
  if (cookieArgs.length) {
    attempts.push({ extra: [...cookieArgs, '--extractor-args', 'youtube:player_client=android,web'], fmt: ORIG_FMT });
    attempts.push({ extra: [...cookieArgs, '--extractor-args', 'youtube:player_client=android,web'], fmt: 'bestaudio/best' });
    attempts.push({ extra: [...cookieArgs], fmt: ORIG_FMT });
    attempts.push({ extra: [...cookieArgs], fmt: 'bestaudio/best' });
  }
  // Clientes alternativos (SABR / PO-token / age-gate / geo). Primero sin cookies,
  // luego con cookies, para no depender de ellas.
  const clients = [
    ['--extractor-args', 'youtube:player_client=android'],
    ['--extractor-args', 'youtube:player_client=ios'],
    ['--extractor-args', 'youtube:player_client=android,web'],
  ];
  for (const c of clients) {
    attempts.push({ extra: [...c], fmt: 'bestaudio/best' });
    if (cookieArgs.length) attempts.push({ extra: [...c, ...cookieArgs], fmt: 'bestaudio/best' });
  }
  attempts.push({ extra: [], fmt: 'bestaudio[protocol^=http]/bestaudio/best' });
  if (cookieArgs.length) attempts.push({ extra: [...cookieArgs], fmt: 'bestaudio[protocol^=http]/bestaudio/best' });
  attempts.push({ extra: [], fmt: 'best[acodec!=none]/best' });

  let lastError = { type:'error', message:'No se pudo resolver el stream.' };
  let sawAuthError = false;
  for (const a of attempts) {
    const r = await runExtract(a.extra, a.fmt);
    if (r.type === 'success') return r;
    if (r.type === 'retry-auth') { sawAuthError = true; lastError = r; continue; }
    if (r.type === 'retry-format' || r.type === 'retry-nocookie') { lastError = r; continue; }
    if (/no encontrado/i.test(r.message || '')) return r;
    lastError = r;
    // Si el error parece transitorio de red pero el formato original falló,
    // seguir probando otros formatos/clientes en vez de rendirse
  }

  if (sawAuthError && !cookieArgs.length) {
    // Las cookies se resolvieron tarde (probe asíncrono): reintentar una vez con frescas
    try {
      const fresh = await getCookieArgs();
      if (fresh.length) {
        const r2 = await runExtract(fresh, 'bestaudio/best');
        if (r2.type === 'success') return r2;
        lastError = r2;
      }
    } catch (_) {}
  }

  if (lastError.type === 'retry-auth') return { type:'error', message:'Requiere inicio de sesión / edad.' };
  if (lastError.type === 'retry-format') return { type:'error', message:'No se obtuvo URL de stream.' };
  if (lastError.type === 'retry-nocookie') return { type:'error', message:'No se obtuvo URL de stream.' };
  return lastError;
}

ipcMain.handle('stream-proxy-port', () => _proxyPort);

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

function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list') || null;
  } catch { return null; }
}

function fetchChannelName(ytdlpBin, videoId) {
  return new Promise(resolve => {
    const args = [
      '--no-warnings', '--skip-download', '--socket-timeout', '8',
      '--print', '%(channel,uploader,uploader_id,channel_id|)s',
      `https://www.youtube.com/watch?v=${videoId}`
    ];
    let out = '';
    const proc = spawn(ytdlpBin, args, { timeout: 15000 });
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', () => {
      const name = out.trim().split('\n')[0]?.trim();
      resolve(name && name !== 'NA' ? name : '');
    });
    proc.on('error', () => resolve(''));
  });
}

async function fetchChannelNamesForVideos(ytdlpBin, videos, concurrency = 8) {
  let idx = 0;
  async function worker() {
    while (idx < videos.length) {
      const v = videos[idx++];
      v.uploader = await fetchChannelName(ytdlpBin, v.id);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, videos.length) }, () => worker());
  await Promise.all(workers);
}

function resolvePlaylistCore(playlistUrl) {
  const ytdlpBin = findYtDlp();
  const playlistId = extractPlaylistId(playlistUrl);
  const targetUrl = playlistId
    ? `https://www.youtube.com/playlist?list=${playlistId}`
    : playlistUrl;

  return getCookieArgs().then(cookieArgs => new Promise((resolve) => {
    const args = [
      '--yes-playlist', '--no-warnings', '--flat-playlist', '-j',
      ...cookieArgs,
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
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) return resolve({ type: 'error', message: 'No se encontraron vídeos en la playlist.' });

      let playlistTitle = 'Playlist de YouTube';
      const titleMatch = stderr.match(/\[download\] Downloading playlist: (.+)/);
      if (titleMatch) playlistTitle = titleMatch[1].trim();

      const pickUploader = entry => {
        const candidates = [entry.uploader, entry.channel, entry.uploader_id, entry.channel_id, entry.artist, entry.creator];
        for (const c of candidates) {
          if (c && typeof c === 'string' && c.trim() && c.trim() !== 'NA') return c.trim();
        }
        return '';
      };
      const pickThumbnail = entry => {
        if (entry.thumbnail) return entry.thumbnail;
        if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
          return entry.thumbnails[entry.thumbnails.length - 1].url || '';
        }
        return '';
      };

      const videos = lines.map(line => {
        let entry;
        try { entry = JSON.parse(line); } catch (e) { return null; }
        if (!entry || !entry.id) return null;
        return {
          id: entry.id,
          title: (entry.title || 'Sin título').trim(),
          uploader: pickUploader(entry),
          thumbnail: pickThumbnail(entry),
          duration: parseInt(entry.duration) || 0
        };
      }).filter(v => v && v.id && v.id.length === 11);

      const missing = videos.filter(v => !v.uploader);
      if (missing.length) {
        fetchChannelNamesForVideos(ytdlpBin, missing).then(() => {
          resolve({ type: 'success', playlistTitle, playlistId: playlistId || 'yt-pl', videos });
        });
      } else {
        resolve({ type: 'success', playlistTitle, playlistId: playlistId || 'yt-pl', videos });
      }
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
      else resolve({ type: 'error', message: `Error yt-dlp: ${err.message}` });
    });
  }));
}

ipcMain.handle('resolve-youtube-playlist', (event, playlistUrl) => resolvePlaylistCore(playlistUrl));

function listOwnPlaylists(cookieArgs) {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    const args = [
      '--no-warnings', '--flat-playlist', '-j',
      ...cookieArgs,
      'https://www.youtube.com/feed/playlists'
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 60000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', () => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const out = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const id = entry.id || extractPlaylistId(entry.url || '');
          if (!id) continue;
          out.push({ id, title: (entry.title || 'Playlist').trim() });
        } catch {}
      }
      resolve(out);
    });
    proc.on('error', () => resolve([]));
  });
}

ipcMain.handle('import-youtube-library', async (event) => {
  const cookieArgs = await getCookieArgs();
  if (!cookieArgs.length) {
    return { type: 'error', message: 'No hay ninguna sesión de YouTube activa (ni cookies manuales ni de navegador). Configúralas en Ajustes → YouTube.' };
  }

  const send = (data) => { try { event.sender.send('youtube-library-progress', data); } catch {} };

  send({ stage: 'favorites' });
  const favResult = await resolvePlaylistCore('https://www.youtube.com/playlist?list=LL');
  let favorites = null;
  if (favResult.type === 'success' && favResult.videos.length) {
    // Sin filtros: se importa TODO lo que haya en Favoritos, sin saltar ninguna canción
    favorites = { ...favResult, videos: favResult.videos };
  }

  send({ stage: 'listing-playlists' });
  const ownPlaylists = await listOwnPlaylists(cookieArgs);

  const playlists = [];
  let done = 0;
  for (const p of ownPlaylists) {
    send({ stage: 'playlist', index: done, total: ownPlaylists.length, title: p.title });
    const r = await resolvePlaylistCore(`https://www.youtube.com/playlist?list=${p.id}`);
    if (r.type === 'success' && r.videos.length) {
      playlists.push({ playlistTitle: p.title || r.playlistTitle, playlistId: p.id, videos: r.videos });
    }
    done++;
  }

  if ((!favorites || !favorites.videos.length) && !playlists.length) {
    return { type: 'error', message: 'No se pudo importar nada. Comprueba que la cookie/sesión sigue siendo válida, o que tu cuenta tiene canciones que le diste a "Me gusta"/en playlists.' };
  }

  return {
    type: 'success',
    favorites: favorites ? { playlistTitle: favorites.playlistTitle, videos: favorites.videos } : null,
    playlists,
  };
});

ipcMain.handle('search-youtube', async (_, query) => {
  const cookieArgs = await getCookieArgs();
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
    const searchUrl = `ytsearch15:${query}`;
    const args = [
      '--no-playlist', '--no-warnings', '--flat-playlist',
      ...cookieArgs,
      '--print', '%(id)s|%(title)s|%(uploader,channel|)s|%(duration)s|%(thumbnail)s',
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
        const cleanUploader = (uploader?.trim() === 'NA' ? '' : uploader?.trim()) || '';
        return { id, title, uploader: cleanUploader, duration: dur > 0 ? `${mins}:${secs}` : '—', thumbnail };
      }).filter(Boolean);
      resolve({ type: 'success', results });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
      else resolve({ type: 'error', message: `Error yt-dlp: ${err.message}` });
    });
  });
});

ipcMain.handle('resolve-youtube-related', async (_, videoId) => {
  if (!videoId || typeof videoId !== 'string') {
    return { type: 'error', message: 'videoId inválido.' };
  }
  const ytdlpBin = findYtDlp();
  const cookieArgs = await getCookieArgs();
  const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;

  return new Promise((resolve) => {
    const args = [
      '--yes-playlist', '--no-warnings', '--flat-playlist', '-j',
      '--playlist-end', '20',
      ...cookieArgs,
      mixUrl
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 30000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code !== 0 && !stdout.trim()) {
        if (code === 127 || stderr.includes('not found') || stderr.includes('No such file'))
          return resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
        return resolve({ type: 'error', message: `Error yt-dlp: ${stderr.slice(0, 180)}` });
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const pickUploader = entry => {
        const candidates = [entry.uploader, entry.channel, entry.uploader_id, entry.channel_id, entry.artist, entry.creator];
        for (const c of candidates) {
          if (c && typeof c === 'string' && c.trim() && c.trim() !== 'NA') return c.trim();
        }
        return '';
      };
      const pickThumbnail = entry => {
        if (entry.thumbnail) return entry.thumbnail;
        if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
          return entry.thumbnails[entry.thumbnails.length - 1].url || '';
        }
        return '';
      };
      const videos = lines.map(line => {
        let entry;
        try { entry = JSON.parse(line); } catch (e) { return null; }
        if (!entry || !entry.id || entry.id === videoId) return null;
        return {
          id: entry.id,
          title: (entry.title || 'Sin título').trim(),
          uploader: pickUploader(entry),
          thumbnail: pickThumbnail(entry)
        };
      }).filter(Boolean);
      if (!videos.length) return resolve({ type: 'error', message: 'No se encontraron canciones relacionadas.' });
      resolve({ type: 'success', videos });
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') resolve({ type: 'error', message: 'yt-dlp no encontrado.' });
      else resolve({ type: 'error', message: `Error yt-dlp: ${err.message}` });
    });
  });
});

function searchYouTubeForTrack(title, artist) {
  return new Promise((resolve) => {
    const ytdlpBin = findYtDlp();
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
        '--print', '%(id)s|%(title)s|%(uploader,channel|)s|%(duration)s',
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
          const cleanUploader = (u?.trim() === 'NA' ? '' : u?.trim()) || '';
          return { id: id?.trim(), title: t?.trim() || '', uploader: cleanUploader, duration: parseInt(dur) || 0 };
        }).filter(r => r && r.id && r.id.length === 11);

        if (!results.length) return tryNext();

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

const activeDownloads = new Map();

ipcMain.handle('download-pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('download-default-folder', () => {
  try { return app.getPath('music'); } catch { return app.getPath('downloads'); }
});

ipcMain.handle('download-youtube', async (_, { id, videoId, ytUrl, title, artist, outDir, format, template }) => {
  const ytdlpBin = findYtDlp();
  const cookieArgs = await getCookieArgs();
  const url = ytUrl || `https://www.youtube.com/watch?v=${videoId}`;
  const safeTitle = (title || 'audio').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120);
  const safeArtist = (artist || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80);
  // Plantilla opcional p.ej. "{artist} - {title}"; sin ella, el formato clásico
  let baseName;
  const tpl = typeof template === 'string' ? template.trim() : '';
  if (tpl && tpl.includes('{')) {
    baseName = tpl
      .replace(/\{artist\}/gi, safeArtist || 'Unknown Artist')
      .replace(/\{title\}/gi, safeTitle)
      .replace(/\{album\}/gi, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s_-]+|[\s_-]+$/g, '')
      .slice(0, 160);
  }
  if (!baseName) baseName = safeArtist ? `${safeArtist} - ${safeTitle}` : safeTitle;

  const fmt = (format || 'mp3').toLowerCase();
  const useExtract = ['mp3','m4a','opus','wav','flac','aac'].includes(fmt);
  const args = [
    '--no-playlist', '--no-warnings',
    '-o', path.join(outDir, baseName + '.%(ext)s'),
    '--newline', '--progress',
    ...cookieArgs,
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
      // Throttle: un mensaje IPC por chunk generaba miles para archivos grandes
      let _lastPctSent = -1;
      rs.on('data', chunk => {
        copied += chunk.length;
        const pct = total ? (copied / total) * 100 : 0;
        const step = Math.floor(pct);
        if (step !== _lastPctSent) { _lastPctSent = step; send({ status:'downloading', percent: pct }); }
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

ipcMain.handle('search-spotify-artists', async (_, query) => {
  if (!query || !query.trim()) return { type: 'error', message: 'Búsqueda vacía.' };
  try {
    const q = encodeURIComponent(query.trim());
    const url = `https://api.deezer.com/search/artist?q=${q}&limit=8&output=json`;
    const r = await fetchUrl(url);

    if (r.status === 429) return { type: 'error', message: 'Demasiadas peticiones. Espera un momento.' };
    if (r.status !== 200) return { type: 'error', message: `Error de búsqueda (${r.status}).` };

    let data;
    try { data = JSON.parse(r.body); }
    catch(e) { return { type: 'error', message: 'Respuesta inválida del servidor.' }; }

    const items = data.data || [];
    const artists = items.map(a => ({
      id:      String(a.id || ''),
      name:    a.name || 'Artista desconocido',
      picture: a.picture_xl || a.picture_big || a.picture_medium || a.picture || '',
      nbFan:   a.nb_fan || 0,
    })).filter(a => a.id && a.name);

    return { type: 'success', results: artists };
  } catch (e) {
    console.error('[search-spotify-artists]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});

ipcMain.handle('get-spotify-artist', async (_, artistId) => {
  if (!artistId) return { type: 'error', message: 'ID de artista inválido.' };
  try {
    const [infoR, topR, albumsR] = await Promise.all([
      fetchUrl(`https://api.deezer.com/artist/${encodeURIComponent(artistId)}`),
      fetchUrl(`https://api.deezer.com/artist/${encodeURIComponent(artistId)}/top?limit=10`),
      fetchUrl(`https://api.deezer.com/artist/${encodeURIComponent(artistId)}/albums?limit=50`),
    ]);

    if (infoR.status !== 200) return { type: 'error', message: `Error al obtener el artista (${infoR.status}).` };

    let info, top, albumsData;
    try { info = JSON.parse(infoR.body); } catch(e) { return { type: 'error', message: 'Respuesta inválida del servidor.' }; }
    if (info.error) return { type: 'error', message: info.error.message || 'Artista no encontrado.' };

    try { top = JSON.parse(topR.body); } catch(e) { top = { data: [] }; }
    try { albumsData = JSON.parse(albumsR.body); } catch(e) { albumsData = { data: [] }; }

    const tracks = (top.data || []).map(t => ({
      id:         String(t.id || ''),
      title:      t.title       || 'Sin título',
      artist:     t.artist?.name || info.name || 'Artista desconocido',
      album:      t.album?.title || '',
      duration:   t.duration    || 0,
      cover:      t.album?.cover_medium || t.album?.cover || '',
      explicit:   t.explicit_lyrics || false,
    })).filter(t => t.id);

    const releases = (albumsData.data || [])
      .filter(a => a && a.id)
      .map(a => ({
        id:          String(a.id),
        title:       a.title || 'Sin título',
        cover:       a.cover_medium || a.cover_big || a.cover || '',
        releaseDate: a.release_date || '',
        year:        (a.release_date || '').slice(0, 4),
        nbTracks:    a.nb_tracks || 0,
        recordType:  a.record_type || 'album',
      }))
      .filter((a, idx, arr) => arr.findIndex(b => b.title === a.title) === idx)
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));

    const singles = releases.filter(a => a.recordType === 'single' && a.nbTracks <= 3);
    const eps     = releases.filter(a => (a.recordType === 'ep') || (a.recordType === 'single' && a.nbTracks > 3 && a.nbTracks <= 6));
    const albums  = releases.filter(a => !singles.includes(a) && !eps.includes(a));

    return {
      type: 'success',
      artist: {
        id:      String(info.id || artistId),
        name:    info.name || 'Artista desconocido',
        picture: info.picture_xl || info.picture_big || info.picture_medium || '',
        nbFan:   info.nb_fan || 0,
        nbAlbum: info.nb_album || 0,
      },
      tracks,
      albums,
      singles,
      eps,
    };
  } catch (e) {
    console.error('[get-spotify-artist]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});

ipcMain.handle('get-spotify-album', async (_, albumId) => {
  if (!albumId) return { type: 'error', message: 'ID de álbum inválido.' };
  try {
    const r = await fetchUrl(`https://api.deezer.com/album/${encodeURIComponent(albumId)}`);
    if (r.status !== 200) return { type: 'error', message: `Error al obtener el álbum (${r.status}).` };

    let data;
    try { data = JSON.parse(r.body); } catch(e) { return { type: 'error', message: 'Respuesta inválida del servidor.' }; }
    if (data.error) return { type: 'error', message: data.error.message || 'Álbum no encontrado.' };

    const cover = data.cover_medium || data.cover_big || data.cover || '';
    const tracks = (data.tracks?.data || []).map(t => ({
      id:       String(t.id || ''),
      title:    t.title || 'Sin título',
      artist:   t.artist?.name || (data.artist?.name) || 'Artista desconocido',
      album:    data.title || '',
      duration: t.duration || 0,
      cover,
      explicit: t.explicit_lyrics || false,
    })).filter(t => t.id);

    return {
      type: 'success',
      album: {
        id:    String(data.id || albumId),
        title: data.title || 'Sin título',
        cover,
      },
      tracks,
    };
  } catch (e) {
    console.error('[get-spotify-album]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});

ipcMain.handle('import-spotify-playlist', async (_, playlistId) => {
  try {
    const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;

    const scriptName = 'spotify_scraper_helper.py';
    const scriptPath = [process.resourcesPath, __dirname]
      .filter(Boolean)
      .map(d => path.join(d, scriptName))
      .find(p => fs.existsSync(p)) || path.join(__dirname, scriptName);
    const result = await new Promise((resolve) => {
      const spawnEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
      const proc = spawn(findPython3(), [scriptPath, playlistUrl], { timeout: 60000, env: spawnEnv });
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

    const norm = (s) => (s || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const cleanQ = (s) => (s || '').replace(/["\\]/g, '').trim();

    async function enrichOne(sp) {
      if (sp.cover && sp.duration) return sp;
      const primaryArtist = (sp.artist || '').split(/[,&\/]/)[0].trim();
      const qTitle = cleanQ(sp.title);
      const qArtist = cleanQ(primaryArtist);
      // NOTA: el endpoint /search de Deezer NO soporta la sintaxis
      // artist:"X" track:"Y" (devuelve 0 resultados). Query simple primero.
      const queries = [
        `${qArtist} ${qTitle}`.trim(),
        qTitle,
      ].filter(Boolean);
      for (const q of queries) {
        let sr;
        try {
          sr = await fetchUrlJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
          if (!sr.ok) {
            await new Promise(r => setTimeout(r, 400));
            sr = await fetchUrlJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
          }
        } catch { sr = { ok: false }; }
        if (!(sr.ok && sr.data?.data?.length)) continue;
        const nTitle = norm(sp.title);
        const nArtist = norm(primaryArtist);
        let best = null, bestScore = -1;
        for (const r of sr.data.data) {
          const rt = norm(r.title);
          const ra = norm(r.artist?.name);
          let score = 0;
          if (nTitle && (rt.includes(nTitle) || nTitle.includes(rt))) score += 4;
          if (nArtist && (ra.includes(nArtist) || nArtist.includes(ra))) score += 3;
          if (score > bestScore) { bestScore = score; best = r; }
        }
        if (!best) best = sr.data.data[0];
        if (!best) continue;
        const alb = best.album || {};
        const cover = sp.cover
          || alb.cover_medium || alb.cover_big || alb.cover_xl || alb.cover || '';
        if (cover && typeof cover === 'string' && cover.startsWith('http')) {
          return {
            ...sp,
            album:    sp.album || alb.title || '',
            duration: sp.duration || best.duration || 0,
            cover,
          };
        }
        if (!sp.duration && best.duration) {
          return { ...sp, album: sp.album || alb.title || '', duration: best.duration };
        }
      }
      return sp;
    }

    // Pool con concurrencia limitada: rápido en playlists grandes y sin saturar a Deezer
    const resolved = new Array(spTracks.length);
    let _eIdx = 0;
    async function _eWorker() {
      while (_eIdx < spTracks.length) {
        const i = _eIdx++;
        try { resolved[i] = await enrichOne(spTracks[i]); }
        catch { resolved[i] = spTracks[i]; }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(5, spTracks.length) }, () => _eWorker()
    ));

    console.log(`[sp-import] "${playlistTitle}" — ${resolved.length} canciones listas`);
    return { type: 'success', playlistTitle, tracks: resolved };

  } catch (e) {
    console.error('[sp-import]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});

ipcMain.handle('import-deezer-playlist', async (_, playlistId) => {
  try {
    if (!playlistId) return { type: 'error', message: 'Falta ID de playlist de Deezer.' };

    const infoRes = await fetchUrlJson(`https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}`);
    if (!infoRes.ok || !infoRes.data) {
      return { type: 'error', message: 'No se pudo obtener la playlist de Deezer.' };
    }
    const playlistTitle = infoRes.data.title || 'Playlist de Deezer';

    const tracks = [];
    const seen = new Set();
    let url = `https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}/tracks?limit=100`;
    let guard = 0;
    while (url && guard < 1000) {
      guard++;
      const r = await fetchUrlJson(url);
      if (!r.ok || !r.data?.data?.length) break;
      for (const t of r.data.data) {
        if (!t || !t.title) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const artist = (t.artist && t.artist.name) ? t.artist.name : '';
        const album = (t.album && t.album.title) ? t.album.title : '';
        const alb = t.album || {};
        const cover = alb.cover_medium || alb.cover_big || alb.cover_xl || alb.cover || '';
        tracks.push({
          id:       String(t.id || t.title),
          title:    t.title,
          artist:   artist,
          album:    album,
          cover:    (typeof cover === 'string' && cover.startsWith('http')) ? cover : '',
          duration: t.duration || 0,
        });
      }
      url = r.data.next || null;
      if (!url) break;
    }

    // If next-link pagination stopped early but total indicates more, try index-based
    const total = infoRes.data?.nb_tracks || infoRes.data?.tracks?.total || 0;
    if (total && tracks.length < total) {
      let idx = tracks.length;
      while (idx < total && idx < total + 100) {
        const r = await fetchUrlJson(`https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}/tracks?limit=100&index=${idx}`);
        if (!r.ok || !r.data?.data?.length) break;
        let added = 0;
        for (const t of r.data.data) {
          if (!t || !t.title) continue;
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          const artist = (t.artist && t.artist.name) ? t.artist.name : '';
          const album = (t.album && t.album.title) ? t.album.title : '';
          const alb = t.album || {};
          const cover = alb.cover_medium || alb.cover_big || alb.cover_xl || alb.cover || '';
          tracks.push({
            id:       String(t.id || t.title),
            title:    t.title,
            artist:   artist,
            album:    album,
            cover:    (typeof cover === 'string' && cover.startsWith('http')) ? cover : '',
            duration: t.duration || 0,
          });
          added++;
        }
        idx += r.data.data.length;
        if (r.data.data.length < 100) break;
        if (added === 0) break;
      }
    }

    if (!tracks.length) {
      return { type: 'error', message: 'La playlist está vacía o no tiene canciones accesibles.' };
    }

    console.log(`[dz-import] "${playlistTitle}" — ${tracks.length} canciones listas (total reportado: ${total})`);
    return { type: 'success', playlistTitle, tracks };

  } catch (e) {
    console.error('[dz-import]', e);
    return { type: 'error', message: `Error: ${e.message}` };
  }
});

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

ipcMain.handle('fetch-lyrics-main', async (_, { title, artist, romaji }) => {
  const cleanTitle  = (title||'').replace(/\(.*?\)/g,'').replace(/\[.*?\]/g,'').replace(/ft\.?.*/i,'').trim();
  const cleanArtist = (artist||'').replace(/\s*ft\.?.*/i,'').split(',')[0].split('&')[0].trim();

  function _decodeLyricEntities(s) {
    return (s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
             .replace(/&quot;/g,'"').replace(/&#x27;/gi,"'").replace(/&#39;/g,"'").replace(/&apos;/g,"'");
  }

  function _balancedDiv(html, openIdx) {
    // openIdx = índice del '<' del div de apertura. Devuelve { inner, end }
    // (end = índice justo tras el </div> que lo cierra) o null.
    let depth = 0, innerStart = -1;
    const re = /<(\/?)div(?=[\s>])[^>]*>|<br\s*\/?>/gi;
    re.lastIndex = openIdx;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (/^<br/i.test(m[0])) continue;
      if (m[1] === '') {
        depth++;
        if (depth === 1) innerStart = m.index + m[0].length;
      } else {
        depth--;
        if (depth === 0 && innerStart !== -1) {
          return { inner: html.slice(innerStart, m.index), end: m.index + m[0].length };
        }
        if (depth < 0) return null;
      }
    }
    return null;
  }

  function _dropExcluded(html) {
    // Quita subárboles data-exclude-from-selection (cabecera de contribuidores/traducciones)
    let out = '', pos = 0;
    const re = /<div[^>]*data-exclude-from-selection="true"[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m.index < pos) continue;
      out += html.slice(pos, m.index);
      const b = _balancedDiv(html, m.index);
      pos = b ? b.end : m.index + m[0].length;
      re.lastIndex = pos;
    }
    return out + html.slice(pos);
  }

  async function scrapeGeniusPage(url) {
    try {
      const page = await fetchUrl(url);
      if (page.status !== 200) return null;
      const body = page.body || '';
      const texts = [];
      const openRe = /<div[^>]*data-lyrics-container="true"[^>]*>/gi;
      let m;
      while ((m = openRe.exec(body)) !== null) {
        const b = _balancedDiv(body, m.index);
        if (!b || !b.inner) continue;
        openRe.lastIndex = b.end;
        let raw = _dropExcluded(b.inner);
        raw = raw.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'');
        raw = _decodeLyricEntities(raw).trim();
        // Los slots vacíos (anuncios) dan texto vacío: se descartan
        if (raw.replace(/\s+/g, ' ').trim().length > 0) texts.push(raw);
      }
      if (!texts.length) return null;
      const full = texts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return full.length > 40 ? full : null;
    } catch(e) { return null; }
  }

  async function searchGeniusAll(query, maxHits = 5) {
    const results = [];
    try {
      const r = await fetchUrl(`https://genius.com/api/search/multi?per_page=${maxHits}&q=${encodeURIComponent(query)}`);
      if (r.status !== 200) return results;
      const data = JSON.parse(r.body);
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      const seen = new Set();
      const jobs = [];
      for (const h of hits.slice(0, maxHits)) {
        if (!h?.result?.url || seen.has(h.result.url)) continue;
        seen.add(h.result.url);
        jobs.push(
          scrapeGeniusPage(h.result.url).then(lyr => lyr ? {
            label: `${h.result.title} — ${h.result.primary_artist?.name || ''}`.trim(),
            url:   h.result.url,
            lyrics: lyr,
            synced: null,
            source: 'Genius'
          } : null).catch(() => null)
        );
      }
      for (const res of await Promise.all(jobs)) if (res) results.push(res);
    } catch(e) { console.log('[genius]', e.message); }
    return results;
  }

  if (romaji) {
    const romajiResults = [];
    const _isRomajiHit = (h) => {
      if (!h?.result?.url) return false;
      const artistName = (h.result.primary_artist?.name || '').toLowerCase();
      const songTitle  = (h.result.title || '').toLowerCase();
      return (artistName.includes('genius') || artistName.includes('romanization') ||
              songTitle.includes('romanized') || songTitle.includes('romaji') ||
              h.result.url.includes('romanized') || h.result.url.includes('romaji'));
    };
    try {
      const romajiCands = [];
      const seenRomaji = new Set();
      const collectRomaji = (hits) => {
        for (const h of (hits || []).slice(0, 8)) {
          if (!h?.result?.url || seenRomaji.has(h.result.url)) continue;
          if (!_isRomajiHit(h)) continue;
          seenRomaji.add(h.result.url);
          romajiCands.push(h);
        }
      };
      const r = await fetchUrl(`https://genius.com/api/search/multi?per_page=8&q=${encodeURIComponent(cleanTitle + ' romanized')}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        collectRomaji(data?.response?.sections?.find(s => s.type === 'song')?.hits);
      }
      const r2 = await fetchUrl(`https://genius.com/api/search/multi?per_page=8&q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist + ' romanized')}`);
      if (r2.status === 200) {
        const data2 = JSON.parse(r2.body);
        collectRomaji(data2?.response?.sections?.find(s => s.type === 'song')?.hits);
      }
      const scraped = await Promise.all(romajiCands.map(h =>
        scrapeGeniusPage(h.result.url).then(lyr => lyr ? {
          label: h.result.title || '',
          url:   h.result.url,
          lyrics: lyr,
          synced: null,
          source: 'Genius Romanizations'
        } : null).catch(() => null)
      ));
      for (const s of scraped) if (s) romajiResults.push(s);
    } catch(e) { console.log('[romaji]', e.message); }

    if (romajiResults.length > 0) {
      return { found:true, multiple: romajiResults.length > 1, results: romajiResults,
               lyrics: romajiResults[0].lyrics, synced: null, source: romajiResults[0].source };
    }
    return { found:false };
  }

  const allResults = [];

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

  const gHits = await searchGeniusAll(`${cleanTitle} ${cleanArtist}`, 5);
  allResults.push(...gHits);

  async function scrapeAZLyrics() {
    const out = [];
    try {
      const azQ = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
      const r = await fetchUrl(`https://search.azlyrics.com/search.php?q=${azQ}&w=songs`);
      if (r.status !== 200) return out;
      const seen = new Set();
      const urls = [];
      const re = /href="(https:\/\/www\.azlyrics\.com\/lyrics\/[^"]+\.html)"/g;
      let m;
      while ((m = re.exec(r.body)) !== null && urls.length < 3) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        urls.push(m[1]);
      }
      const pages = await Promise.all(urls.map(u => fetchUrl(u).catch(() => null)));
      for (const page of pages) {
        if (!page || page.status !== 200) continue;
        const rm = page.body.match(/<!-- Usage of azlyrics[\s\S]*?-->([\s\S]*?)<!-- MxM banner/);
        if (!rm) continue;
        const raw = rm[1].replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
        if (raw.length > 20) out.push({ label: `${cleanTitle} — AZLyrics`, lyrics: raw, synced: null, source:'AZLyrics' });
      }
    } catch(e) {}
    return out;
  }

  async function fetchLyricsOvh() {
    try {
      const r = await fetchUrl(`https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`);
      if (r.status !== 200) return null;
      const data = JSON.parse(r.body);
      if (data.lyrics?.length > 20) return { label:`${cleanTitle} — lyrics.ovh`, lyrics: data.lyrics, synced: null, source:'lyrics.ovh' };
    } catch(e) {}
    return null;
  }

  async function scrapeMusixmatch() {
    try {
      const mmQ = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
      const r = await fetchUrl(`https://www.musixmatch.com/search/${mmQ}/tracks`);
      if (r.status !== 200) return null;
      const linkMatch = r.body.match(/href="(\/lyrics\/[^"?]+)"[^>]*class="[^"]*title[^"]*"/);
      if (!linkMatch) return null;
      const page = await fetchUrl(`https://www.musixmatch.com${linkMatch[1]}`);
      if (page.status !== 200) return null;
      const parts = [];
      const re = /class="[^"]*lyrics__content__ok[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
      let m2; while ((m2 = re.exec(page.body)) !== null) parts.push(m2[1]);
      if (!parts.length) return null;
      const raw = parts.join('\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
      if (raw.length > 20) return { label:`${cleanTitle} — Musixmatch`, lyrics: raw, synced: null, source:'Musixmatch' };
    } catch(e) {}
    return null;
  }

  // Fuentes independientes en paralelo: más opciones sin sumar latencias
  const [azHits, ovhHit, mmHit] = await Promise.all([
    scrapeAZLyrics(), fetchLyricsOvh(), scrapeMusixmatch(),
  ]);
  allResults.push(...azHits);
  if (ovhHit) allResults.push(ovhHit);
  if (mmHit) allResults.push(mmHit);

  if (allResults.length === 0) return { found:false };

  return {
    found:    true,
    multiple: allResults.length > 1,
    results:  allResults,
    lyrics:   allResults[0].lyrics,
    synced:   allResults[0].synced || null,
    source:   allResults[0].source
  };
});

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
    const mm = await getMusicMetadata();
    if (!mm) return { title: path.basename(filePath), artist: 'Unknown', duration:0, cover:null };
    const md = await mm.parseFile(filePath);
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

function resolveIcon() {
  const appRoot = (app.getAppPath ? app.getAppPath() : null) || __dirname;
  const candidates = [
    path.join(appRoot,   'build', 'icons', 'logonofufaudio.png'),
    path.join(__dirname, 'build', 'icons', 'logonofufaudio.png'),
    path.join(appRoot,   'logonofufaudio.png'),
    path.join(__dirname, 'logonofufaudio.png'),
    path.join(process.resourcesPath || __dirname, 'build', 'icons', 'logonofufaudio.png'),
    path.join(process.resourcesPath || __dirname, 'logonofufaudio.png'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function resolveTrayIcon() {
  const appRoot = (app.getAppPath ? app.getAppPath() : null) || __dirname;
  const candidates = [
    path.join(appRoot,   'build', 'icons', 'traynofufaudio.png'),
    path.join(__dirname, 'build', 'icons', 'traynofufaudio.png'),
    path.join(process.resourcesPath || __dirname, 'build', 'icons', 'traynofufaudio.png'),
    path.join(process.resourcesPath || __dirname, 'traynofufaudio.png'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return resolveIcon();
}

function buildTrayImage(iconPath) {
  if (!iconPath) return nativeImage.createEmpty();
  try {
    const buf = fs.readFileSync(iconPath);
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const sz   = process.platform === 'darwin' ? 18 : 22;
      const size = img.getSize();
      if (size.width === sz && size.height === sz) return img;
      return img.resize({ width: sz, height: sz, quality: 'best' });
    }
  } catch(e) { console.warn('[tray] buildTrayImage:', e.message); }
  return nativeImage.createFromPath(iconPath);
}

const APP_ICON_DEFAULT_FILE = 'logonofufaudio.png';
const APP_ICON_ALT_FILE     = 'logonofufaudio_alt.png';
const TRAY_ICON_DEFAULT_FILE = 'traynofufaudio.png';

function getIconsDir() {
  const dir = path.join(getConfigDir(), 'icons');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

function builtinIconPath(fileName) {
  const appRoot = (app.getAppPath ? app.getAppPath() : null) || __dirname;
  const candidates = [
    path.join(appRoot, 'build', 'icons', fileName),
    path.join(__dirname, 'build', 'icons', fileName),
    path.join(process.resourcesPath || __dirname, 'build', 'icons', fileName),
    path.join(process.resourcesPath || __dirname, fileName),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function toFileUrl(p) {
  if (process.platform === 'win32') return 'file:///' + p.replace(/\\/g, '/');
  return 'file://' + p;
}

function listIcons() {
  const out = [];
  const push = (id, file, builtin) => {
    if (!file) return;
    out.push({ id, url: toFileUrl(file), builtin: !!builtin });
  };
  push('default', builtinIconPath(APP_ICON_DEFAULT_FILE), true);
  push('alt', builtinIconPath(APP_ICON_ALT_FILE), true);
  push('tray-default', builtinIconPath(TRAY_ICON_DEFAULT_FILE), true);
  try {
    const dir = getIconsDir();
    const files = fs.readdirSync(dir).filter(f => /\.png$/i.test(f)).sort();
    for (const f of files) {
      const full = path.join(dir, f);
      try { if (fs.statSync(full).isFile()) push('custom:' + f, full, false); } catch {}
    }
  } catch (e) {}
  return out;
}

function getIconSettings() {
  try {
    const p = path.join(getConfigDir(), 'settings.json');
    if (!fs.existsSync(p)) return {};
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
    return { appIcon: cfg.appIcon, trayIcon: cfg.trayIcon };
  } catch (e) { return {}; }
}

function resolveIconId(id, fallbackPath) {
  try {
    if (typeof id === 'string' && id.startsWith('custom:')) {
      const full = path.join(getIconsDir(), id.slice(7));
      if (fs.existsSync(full)) return full;
      return fallbackPath;
    }
    if (id === 'alt') return builtinIconPath(APP_ICON_ALT_FILE) || fallbackPath;
    if (id === 'tray-default') return builtinIconPath(TRAY_ICON_DEFAULT_FILE) || fallbackPath;
    return builtinIconPath(APP_ICON_DEFAULT_FILE) || fallbackPath;
  } catch (e) { return fallbackPath; }
}

function applyAppIcons() {
  try {
    const { appIcon, trayIcon } = getIconSettings();
    if (mainWindow) {
      const appPath = resolveIconId(appIcon, resolveIcon());
      if (appPath) { try { mainWindow.setIcon(appPath); } catch (e) {} }
    }
    if (tray) {
      const trayPath = resolveIconId(trayIcon, resolveTrayIcon());
      if (trayPath) { try { tray.setImage(buildTrayImage(trayPath)); } catch (e) {} }
    }
  } catch (e) {}
}

ipcMain.handle('list-icons', () => listIcons());

const UPDATE_REPO = 'launxy/nofufaudio';
const UPDATE_BRANCHES = ['main', 'master'];

function getLocalAppVersion() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8') || '{}');
    return (pkg.version && String(pkg.version).trim()) || null;
  } catch (e) { return null; }
}

function compareVersions(a, b) {
  const pa = String(a || '').trim().split('.').map(x => parseInt(x, 10));
  const pb = String(b || '').trim().split('.').map(x => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

ipcMain.handle('get-app-version', () => getLocalAppVersion());

ipcMain.handle('check-app-update', async () => {
  const current = getLocalAppVersion();
  const releasesUrl = `https://github.com/${UPDATE_REPO}/releases`;
  for (const branch of UPDATE_BRANCHES) {
    try {
      const r = await fetchUrl(`https://raw.githubusercontent.com/${UPDATE_REPO}/${branch}/resources/app/package.json`);
      if (r.status !== 200 || !r.body) continue;
      let remote = null;
      try { remote = JSON.parse(r.body); } catch (e) { continue; }
      const latest = remote && remote.version ? String(remote.version).trim() : null;
      if (!latest) continue;
      if (!current) return { ok: true, current: null, latest, updateAvailable: true, releasesUrl, branch };
      return { ok: true, current, latest, updateAvailable: compareVersions(current, latest) < 0, releasesUrl, branch };
    } catch (e) { /* sin red o rama inexistente: probar siguiente */ }
  }
  return { ok: false, error: 'network', current, releasesUrl };
});

// ---- Actualizador por sustitución de resources (multiplataforma, sin git/tar) ----
// Descarga la carpeta resources/ del repo (rama main/master) archivo a archivo
// vía HTTPS y la escribe sobre la instalación actual (process.resourcesPath).
// Solo sincroniza resources/app/** y los *.py de la raíz de resources:
// los binarios yt-dlp/yt-dlp.exe se excluyen (ya se auto-actualizan con -U).
// No usa git, tar ni dependencias nuevas: funciona igual en Linux y Windows.
const UPDATE_SKIP_NAMES = new Set(['yt-dlp', 'yt-dlp.exe']);
const UPDATE_MAX_FILE_BYTES = 25 * 1024 * 1024;
let _updateInProgress = false;

function gitBlobSha(buf) {
  const head = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return crypto.createHash('sha1').update(head).update(buf).digest('hex');
}

function downloadBin(url) {
  return new Promise((resolve) => {
    const attempt = (target, depth) => {
      if (depth > 5) return resolve({ ok: false, error: 'demasiadas redirecciones' });
      const client = target.startsWith('https') ? https : http;
      try {
        const req = client.get(target, {
          timeout: 20000,
          headers: { 'User-Agent': 'nofufaudio-updater' },
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            let next = res.headers.location;
            if (!next.startsWith('http')) {
              try { next = new URL(next, target).href; }
              catch { return resolve({ ok: false, error: 'redirect inválido' }); }
            }
            return attempt(next, depth + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: 'http-' + res.statusCode }); }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ ok: true, buf: Buffer.concat(chunks) }));
          res.on('error', () => resolve({ ok: false, error: 'red' }));
        });
        req.on('error', () => resolve({ ok: false, error: 'red' }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    };
    attempt(url, 0);
  });
}

function listLocalScopeFiles(scopeRoot) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(scopeRoot, full).split(path.sep).join('/'));
    }
  };
  const appDir = path.join(scopeRoot, 'app');
  if (fs.existsSync(appDir)) walk(appDir);
  try {
    for (const e of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.py')) out.push(e.name);
    }
  } catch {}
  return out;
}

ipcMain.handle('apply-app-update', async (event) => {
  const send = (data) => { try { event.sender.send('update-progress', data); } catch {} };
  if (_updateInProgress) return { ok: false, error: 'Ya hay una actualización en curso.' };
  if (!app.isPackaged) return { ok: false, error: 'Solo disponible en la app instalada.' };
  const scopeRoot = process.resourcesPath;
  if (!scopeRoot || !fs.existsSync(path.join(scopeRoot, 'app', 'package.json'))) {
    return { ok: false, error: 'No se encontró la carpeta de instalación.' };
  }
  _updateInProgress = true;
  try {
    // 1. Rama disponible + árbol remoto completo (1 sola petición a la API)
    let branch = null, tree = null;
    for (const b of UPDATE_BRANCHES) {
      try {
        const r = await fetchUrl(`https://api.github.com/repos/${UPDATE_REPO}/git/trees/${b}?recursive=1`);
        if (r.status !== 200 || !r.body) continue;
        const j = JSON.parse(r.body);
        if (j && Array.isArray(j.tree)) { branch = b; tree = j.tree; break; }
      } catch {}
    }
    if (!tree) return { ok: false, error: 'No se pudo leer el repositorio (¿sin conexión o límite de GitHub? Prueba más tarde).' };
    if (tree.truncated) return { ok: false, error: 'El repositorio es demasiado grande para actualizar así.' };

    // 2. Filtrar al ámbito permitido
    const wanted = [];
    for (const e of tree) {
      if (!e || e.type !== 'blob' || typeof e.path !== 'string') continue;
      if (!e.path.startsWith('resources/')) continue;
      const rel = e.path.slice('resources/'.length);
      if (!rel || rel.endsWith('/')) continue;
      const parts = rel.split('/');
      if (parts.includes('..')) continue;
      if (UPDATE_SKIP_NAMES.has(parts[parts.length - 1])) continue;
      const underApp = rel.startsWith('app/');
      const rootPy = !rel.includes('/') && rel.endsWith('.py');
      if (!underApp && !rootPy) continue;
      if ((e.size || 0) > UPDATE_MAX_FILE_BYTES) continue;
      wanted.push({ rel, sha: e.sha, size: e.size || 0 });
    }
    if (!wanted.length) return { ok: false, error: 'El repositorio no contiene archivos actualizables.' };

    // 3. Comparar por SHA de blob git y descargar solo lo cambiado (con verificación)
    const total = wanted.length;
    let done = 0, updated = 0, skipped = 0;
    const staged = [];
    for (const w of wanted) {
      const localFull = path.join(scopeRoot, ...w.rel.split('/'));
      let same = false;
      try {
        if (fs.existsSync(localFull) && gitBlobSha(fs.readFileSync(localFull)) === w.sha) same = true;
      } catch {}
      done++;
      if (same) { skipped++; send({ done, total, current: w.rel, skipped: true }); continue; }
      send({ done, total, current: w.rel });
      const rawUrl = `https://raw.githubusercontent.com/${UPDATE_REPO}/${branch}/resources/` +
        w.rel.split('/').map(encodeURIComponent).join('/');
      const dl = await downloadBin(rawUrl);
      if (!dl.ok) return { ok: false, error: `Fallo descargando ${w.rel} (${dl.error}). No se modificó nada.`, done, total };
      if (gitBlobSha(dl.buf) !== w.sha) {
        return { ok: false, error: `Verificación fallida en ${w.rel}. No se modificó nada.`, done, total };
      }
      staged.push({ rel: w.rel, buf: dl.buf });
      updated++;
    }

    // 4. Backup + aplicar (borra locales que ya no existen en remoto, dentro del ámbito)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(getConfigDir(), 'updates-backup', stamp);
    const backupOne = (full, rel) => {
      const dst = path.join(backupDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(full, dst);
    };
    try {
      for (const s of staged) {
        const cur = path.join(scopeRoot, ...s.rel.split('/'));
        if (fs.existsSync(cur)) backupOne(cur, s.rel);
      }
      const remoteSet = new Set(wanted.map(w => w.rel));
      for (const rel of listLocalScopeFiles(scopeRoot)) {
        if (UPDATE_SKIP_NAMES.has(rel.split('/').pop())) continue;
        if (!remoteSet.has(rel)) {
          const full = path.join(scopeRoot, ...rel.split('/'));
          try { backupOne(full, rel); fs.unlinkSync(full); } catch {}
        }
      }
      for (const s of staged) {
        const full = path.join(scopeRoot, ...s.rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, s.buf);
      }
      try {
        const root = path.join(getConfigDir(), 'updates-backup');
        const dirs = fs.readdirSync(root).filter(d => d !== stamp).sort();
        while (dirs.length > 1) {
          const d = dirs.shift();
          fs.rmSync(path.join(root, d), { recursive: true, force: true });
        }
      } catch {}
    } catch (e) {
      return { ok: false, error: `No se pudo escribir la actualización: ${e.message}. Revisa el backup en ${backupDir}.` };
    }

    let latest = null;
    try {
      latest = JSON.parse(fs.readFileSync(path.join(scopeRoot, 'app', 'package.json'), 'utf-8')).version || null;
    } catch {}
    send({ done: total, total, finished: true });
    return { ok: true, updated, skipped, total, backupDir, branch, latest };
  } finally {
    _updateInProgress = false;
  }
});

ipcMain.on('restart-app', () => {
  try { isQuitting = true; } catch {}
  app.relaunch();
  app.quit();
});

ipcMain.handle('import-icon-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar icono PNG',
    properties: ['openFile'],
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const src = r.filePaths[0];
    const base = path.basename(src, path.extname(src)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'icono';
    const dest = path.join(getIconsDir(), `custom-${Date.now()}-${base}.png`);
    fs.copyFileSync(src, dest);
    return { id: 'custom:' + path.basename(dest), url: toFileUrl(dest), builtin: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

function createWindow() {
  const iconPath = resolveIconId(getIconSettings().appIcon, resolveIcon());
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
      mainWindow.webContents.send('save-before-hide');
      setTimeout(() => mainWindow.hide(), 120);
    }
  });
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-before-hide');
    setTimeout(() => mainWindow.hide(), 120);
  });

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
        {
          label: 'Abrir log de MPRIS',
          click: () => { shell.openPath(mprisLogPath); }
        },
        { role: 'reload' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function buildTrayMenu(lang) {
  const L = TRAY_I18N[lang] || TRAY_I18N.es;
  return Menu.buildFromTemplate([
    { label: L.open, click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: L.configFolder, click: () => shell.openPath(getConfigDir()) },
    { type: 'separator' },
    { label: L.quit, click: () => {
      mainWindow.webContents.send('save-before-hide');
      setTimeout(() => { isQuitting = true; app.quit(); }, 200);
    }}
  ]);
}

function refreshTrayLanguage() {
  if (!tray) return;
  const lang = getSavedLanguage();
  const L = TRAY_I18N[lang] || TRAY_I18N.es;
  tray.setToolTip(L.tooltip);
  tray.setContextMenu(buildTrayMenu(lang));
}

function createTray() {
  const trayIconPath = resolveIconId(getIconSettings().trayIcon, resolveTrayIcon());
  const trayImg      = buildTrayImage(trayIconPath);
  try {
    tray = new Tray(trayImg);
    if (!trayImg.isEmpty()) tray.setImage(trayImg);
  } catch(e) {
    console.warn('[tray] Error al crear tray:', e.message);
    try { tray = new Tray(nativeImage.createEmpty()); } catch(e2) { return; }
  }
  const lang = getSavedLanguage();
  const L = TRAY_I18N[lang] || TRAY_I18N.es;
  tray.setToolTip(L.tooltip);
  tray.setContextMenu(buildTrayMenu(lang));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

const _gotSingleLock = app.requestSingleInstanceLock();
if (!_gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    try {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        // Si la segunda instancia trae archivos de audio, reenviarlos a la ventana principal
        const files = (argv || []).filter(a =>
          typeof a === 'string' && /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i.test(a) && fs.existsSync(a)
        );
        if (files.length) {
          try { mainWindow.webContents.send('open-files-external', files); } catch (_) {}
        }
      }
    } catch (_) {}
  });
  app.on('activate', () => {
    try {
      if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
  });
}

app.whenReady().then(async () => {
  await startStreamProxy();
  if (process.platform === 'win32') app.setAppUserModelId('com.nofufaudio');
  createWindow();
  createTray();

  updateYtDlp().catch(() => {});

  const { globalShortcut } = require('electron');
  globalShortcut.register('Alt+F12', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });
});

ipcMain.on('window-minimize', () => {
  mainWindow.webContents.send('save-before-hide');
  setTimeout(() => mainWindow.hide(), 120);
});
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow.close());
ipcMain.on('window-quit',     () => {
  mainWindow.webContents.send('save-before-hide');
  setTimeout(() => { isQuitting = true; app.quit(); }, 200);
});
ipcMain.on('window-show',     () => { mainWindow.show(); mainWindow.focus(); });
ipcMain.on('window-reload',   () => { if (mainWindow) mainWindow.webContents.reload(); });

app.on('before-quit', () => {
  isQuitting = true;
  if (_proxyServer) _proxyServer.close();
  discordRPC.shutdown();
  const { globalShortcut } = require('electron');
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ============================================================
// Sesión de YouTube (estado visible en Ajustes)
// ============================================================
ipcMain.handle('check-youtube-session', async () => {
  const ytdlpBin = findYtDlp();
  const cookieArgs = await getCookieArgs();
  if (!cookieArgs.length) {
    return { ok: false, source: 'none', message: 'Sin sesión: no hay cookies manuales ni de navegador configuradas.' };
  }
  const source = cookieArgs[0] === '--cookies' ? 'manual' : 'browser';
  return new Promise((resolve) => {
    const args = [
      '--no-warnings', '--flat-playlist', '--playlist-end', '1',
      ...cookieArgs,
      '--print', '%(id)s',
      'ytsearch1:nofufaudio session check'
    ];
    let stdout = '', stderr = '';
    const proc = spawn(ytdlpBin, args, { timeout: 25000 });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve({ ok: true, source, message: source === 'manual' ? 'Sesión activa (cookies manuales).' : 'Sesión activa (cookies del navegador).' });
      } else {
        resolve({ ok: false, source, message: 'Sesión caducada o inválida: ' + (stderr || `código ${code}`).slice(0, 140) });
      }
    });
    proc.on('error', (e) => resolve({ ok: false, source, message: 'No se pudo lanzar yt-dlp: ' + e.message }));
  });
});

// ============================================================
// ListenBrainz (scrobbling) — API abierta con token de usuario
// ============================================================
function lbRequest(method, pathname, body, token) {
  return new Promise((resolve) => {
    try {
      const data = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
      const req = https.request({
        hostname: 'api.listenbrainz.org',
        path: pathname,
        method,
        timeout: 12000,
        headers: {
          'Authorization': `Token ${token || ''}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': data.length } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c.toString());
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, json, raw });
        });
      });
      req.on('error', () => resolve({ status: 0, json: null }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
      if (data) req.write(data);
      req.end();
    } catch (e) { resolve({ status: 0, json: null }); }
  });
}

ipcMain.handle('lb-validate-token', async (_, token) => {
  if (!token || typeof token !== 'string') return { ok: false, message: 'Introduce tu token de ListenBrainz.' };
  const r = await lbRequest('GET', '/1/validate-token', null, token.trim());
  if (r.status === 200 && r.json?.valid) return { ok: true, user: r.json.user_name };
  if (r.status === 401) return { ok: false, message: 'Token inválido.' };
  return { ok: false, message: r.status ? `Error ${r.status}` : 'Sin conexión con ListenBrainz.' };
});

ipcMain.handle('lb-submit-listen', async (_, { token, payload }) => {
  if (!token) return { ok: false, message: 'Sin token' };
  const r = await lbRequest('POST', '/1/submit-listens', payload, token);
  return { ok: r.status === 200, status: r.status, message: r.json?.error || '' };
});

// ============================================================
// Discord Rich Presence (módulo propio sin dependencias)
// ============================================================
function _applyDiscordClientId() {
  try {
    const p = path.join(getConfigDir(), 'settings.json');
    if (!fs.existsSync(p)) return;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
    if (cfg.discordClientId) discordRPC.setClientId(cfg.discordClientId);
  } catch (_) {}
}
_applyDiscordClientId();

ipcMain.on('rpc-update', (_e, state) => {
  try {
    if (!state || !state.enabled) { discordRPC.clearActivity(); return; }
    discordRPC.setActivity(state);
  } catch (err) { console.warn('[rpc]', err.message); }
});

// ============================================================
// Mini-reproductor (ventana compacta siempre visible)
// ============================================================
let miniWindow = null;

function createMiniWindow() {
  if (miniWindow) { miniWindow.show(); miniWindow.focus(); return; }
  miniWindow = new BrowserWindow({
    width: 340, height: 108, minWidth: 280, minHeight: 84,
    frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, fullscreenable: false,
    backgroundColor: '#0a0a0f',
    title: 'NofufAudio Mini',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
  });
  miniWindow.setAlwaysOnTop(true, 'floating');
  miniWindow.loadFile(path.join(__dirname, 'src', 'mini.html'));
  miniWindow.on('closed', () => { miniWindow = null; });
}

ipcMain.on('mini-toggle', () => {
  if (miniWindow) { miniWindow.close(); }
  else createMiniWindow();
});
ipcMain.on('mini-close', () => { if (miniWindow) miniWindow.close(); });
ipcMain.on('mini-show-main', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

// Estado del reproductor principal → mini; acciones del mini → principal
ipcMain.on('mini-state', (_e, state) => {
  try { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('mini-state', state); } catch (_) {}
});
ipcMain.on('mini-control', (_e, action) => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini-control', action); } catch (_) {}
});
// Discord Rich Presence sin dependencias: habla directamente con el socket IPC
// local de Discord (protocolo opcodes + JSON). Así el auto-actualizador puede
// sincronizar este archivo sin instalar node_modules.
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OPCODE = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3 };

let _sock = null;
let _connected = false;
let _connecting = false;
let _currentActivity = null;
let _clientId = '1421672891186237510'; // Se sobreescribe con settings.discordClientId
let _reconnectTimer = null;
let _buf = null;

function setClientId(id) {
  const next = String(id || '').trim();
  if (!next || next === _clientId) return;
  _clientId = next;
  // Reconectar con el nuevo Application ID
  if (_connected || _connecting) {
    _disconnect();
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    scheduleReconnect(1500);
  }
}

function _socketCandidates() {
  const out = [];
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), '');
  const names = ['discord', 'snap.discord', 'discordptb', 'discordcanary', 'flatpak-discord'];
  for (const n of names) out.push(path.join(runtime, n, 'discord-ipc-0'));
  out.push(path.join(runtime, 'discord-ipc-0'));
  if (process.platform === 'win32') out.push('\\\\?\\pipe\\discord-ipc-0');
  return out;
}

function _send(op, payload) {
  if (!_sock || !_connected) return false;
  try {
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(data.length, 4);
    _sock.write(Buffer.concat([head, data]));
    return true;
  } catch (e) { return false; }
}

function _disconnect() {
  _connected = false;
  if (_sock) { try { _sock.destroy(); } catch (_) {} _sock = null; }
}

function _connect() {
  if (_connecting || _connected) return;
  _connecting = true;
  const candidates = _socketCandidates();
  let idx = 0;

  const tryNext = () => {
    if (idx >= candidates.length) {
      _connecting = false;
      scheduleReconnect(30_000);
      return;
    }
    const sockPath = candidates[idx++];
    const sock = net.connect(sockPath);
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      tryNext();
    };
    sock.setTimeout(2500, fail);
    sock.on('error', fail);

    sock.on('connect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.removeAllListeners('error');
      sock.on('error', () => { _disconnect(); scheduleReconnect(30_000); });
      _sock = sock;
      _buf = null;
      _send(OPCODE.HANDSHAKE, { v: 1, client_id: _clientId });
      sock.on('data', onData);
      sock.on('close', () => {
        if (_connected) { _connected = false; scheduleReconnect(15_000); }
      });
      // Esperar el READY antes de considerarlo conectado
      _connecting = false;
      if (_currentActivity) setTimeout(() => _pushActivity(_currentActivity), 400);
    });
  };
  tryNext();
}

function scheduleReconnect(ms) {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _connect(); }, ms);
}

function onData(chunk) {
  _buf = _buf ? Buffer.concat([_buf, chunk]) : chunk;
  while (_buf && _buf.length >= 8) {
    const op = _buf.readInt32LE(0);
    const len = _buf.readInt32LE(4);
    if (_buf.length < 8 + len) break;
    const payloadStr = _buf.slice(8, 8 + len).toString('utf-8');
    _buf = _buf.slice(8 + len);
    let payload = null;
    try { payload = JSON.parse(payloadStr); } catch (_) {}
    if (op === OPCODE.CLOSE) { _disconnect(); scheduleReconnect(60_000); return; }
    if (payload && payload.evt === 'READY') {
      _connected = true;
      if (_currentActivity) _pushActivity(_currentActivity);
    }
  }
}

function _pushActivity(activity) {
  if (!_connected) return false;
  return _send(OPCODE.FRAME, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity },
    nonce: String(Date.now()),
  });
}

function setActivity({ title, artist, album, durationSec, positionSec, coverUrl, playing }) {
  if (!title) { clearActivity(); return; }
  const now = Date.now();
  const activity = {
    type: 2, // LISTENING
    details: title.slice(0, 128),
    state: artist ? artist.slice(0, 128) : undefined,
    timestamps: playing
      ? { start: now - Math.max(0, Math.min(positionSec || 0, durationSec || 0)) * 1000,
          end: durationSec ? now + Math.max(0, durationSec - (positionSec || 0)) * 1000 : undefined }
      : undefined,
    assets: {},
    instance: false,
  };
  if (coverUrl && /^https:\/\//.test(coverUrl)) {
    activity.assets.large_image = coverUrl.slice(0, 256);
    activity.assets.large_text = album ? String(album).slice(0, 128) : title.slice(0, 128);
  }
  if (!playing) {
    delete activity.timestamps;
    activity.state = (artist ? artist.slice(0, 100) + ' · ' : '') + 'Pausado';
  }
  _currentActivity = activity;
  if (!_connected) _connect();
  else _pushActivity(activity);
}

function clearActivity() {
  _currentActivity = null;
  if (_connected) _send(OPCODE.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(Date.now()) });
}

function shutdown() {
  _disconnect();
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
}

module.exports = { setActivity, clearActivity, setClientId, shutdown };

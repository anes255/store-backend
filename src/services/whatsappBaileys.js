const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  Browsers,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../../wa-sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const baileysLogger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const sessions = {};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSession(storeId) {
  return sessions[storeId] || null;
}

function getStatus(storeId) {
  const s = sessions[storeId];
  if (!s) return { status: 'not_started', connected: false };
  return {
    status: s.status,
    connected: s.status === 'connected',
    phone: s.phone || null,
    name: s.name || null,
    qr: s.qr || null,
    lastConnected: s.lastConnected || null,
    error: s.error || null,
    retries: s.retries || 0,
  };
}

// ─── Session creation ───────────────────────────────────────────────────────

async function startSession(storeId) {
  const existing = sessions[storeId];
  if (existing) {
    if (existing.status === 'connected') return;
    if (existing.status === 'waiting_qr' && existing.qr) return;
    if (existing.status === 'connecting' && existing.startedAt && (Date.now() - existing.startedAt < 30000)) return;
    if (existing.status === 'reconnecting') return;
  }

  if (existing?.sock) {
    try { existing.sock.ws.close(); } catch (e) {}
    try { existing.sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  const credsFile = path.join(sessionDir, 'creds.json');
  const hasExistingCreds = fs.existsSync(credsFile);

  if (!hasExistingCreds) {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  sessions[storeId] = {
    sock: null, status: 'connecting', qr: null,
    phone: existing?.phone || null, name: existing?.name || null,
    lastConnected: existing?.lastConnected || null,
    error: null, retries: 0, startedAt: Date.now(),
    _reconnectTimer: null,
  };

  try {
    await createSocket(storeId, sessionDir);
  } catch (e) {
    console.error(`[WA-Baileys ${storeId}] startSession error:`, e.message);
    sessions[storeId].status = 'error';
    sessions[storeId].error = e.message;
  }
}

async function createSocket(storeId, sessionDir) {
  let version;
  try {
    const vInfo = await fetchLatestBaileysVersion();
    version = vInfo.version;
    console.log(`[WA-Baileys ${storeId}] WA version: ${version.join('.')}`);
  } catch (e) {
    console.log(`[WA-Baileys ${storeId}] fetchVersion failed, using default`);
    version = [2, 3000, 1015901307];
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log(`[WA-Baileys ${storeId}] Creating socket...`);

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 15000,      // ping every 15s (was 25s)
    retryRequestDelayMs: 500,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,       // keep session alive on WA servers
  });

  sessions[storeId].sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const code = lastDisconnect?.error?.output?.statusCode;
    const errorMsg = lastDisconnect?.error?.message || '';

    console.log(`[WA-Baileys ${storeId}] conn=${connection || '-'} qr=${!!qr} code=${code || '-'} err="${errorMsg}"`);

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        sessions[storeId].error = null;
        sessions[storeId].retries = 0;
        console.log(`[WA-Baileys ${storeId}] ✅ QR READY`);
      } catch (e) {
        console.error(`[WA-Baileys ${storeId}] QR encode error:`, e.message);
      }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].error = null;
      sessions[storeId].retries = 0;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || '';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      console.log(`[WA-Baileys ${storeId}] ✅ CONNECTED: +${sessions[storeId].phone}`);
    }

    if (connection === 'close') {
      // ── Only stop reconnecting if the user explicitly logged out ──
      // Code 401 = loggedOut (user removed linked device from their phone).
      // Everything else (network blips, server restarts, timeouts, stream
      // errors, 408/428/440/500/515 etc.) should reconnect indefinitely
      // so the admin never has to re-scan QR.
      const isLoggedOut = code === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log(`[WA-Baileys ${storeId}] 🔒 LOGGED OUT by user — session cleared`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId] = {
          status: 'logged_out', qr: null, sock: null,
          phone: null, name: null, lastConnected: null,
          error: null, retries: 0,
        };
        return;
      }

      // For every other disconnect reason: reconnect forever with backoff.
      // Cap backoff at 5 minutes so it doesn't wait too long.
      const retries = (sessions[storeId].retries || 0) + 1;
      sessions[storeId].retries = retries;
      const backoff = Math.min(3000 * Math.pow(1.5, Math.min(retries - 1, 10)), 300000);

      console.log(`[WA-Baileys ${storeId}] 🔄 RECONNECTING attempt ${retries} in ${(backoff / 1000).toFixed(0)}s (code=${code} err="${errorMsg}")`);
      sessions[storeId].status = 'reconnecting';
      sessions[storeId].qr = null;
      sessions[storeId].error = `Reconnecting (attempt ${retries}): ${errorMsg || 'connection lost'}`;

      // Clear any previous reconnect timer
      if (sessions[storeId]._reconnectTimer) clearTimeout(sessions[storeId]._reconnectTimer);

      sessions[storeId]._reconnectTimer = setTimeout(async () => {
        try {
          // Make sure creds still exist (user might have disconnected manually while we waited)
          const credsFile = path.join(sessionDir, 'creds.json');
          if (!fs.existsSync(credsFile)) {
            console.log(`[WA-Baileys ${storeId}] Creds deleted during backoff, stopping reconnect`);
            sessions[storeId].status = 'disconnected';
            sessions[storeId].error = null;
            return;
          }
          await createSocket(storeId, sessionDir);
        } catch (e) {
          console.error(`[WA-Baileys ${storeId}] Reconnect error:`, e.message);
          sessions[storeId].error = e.message;
          // Don't set status to 'error' — let the next connection.update handle it
        }
      }, backoff);
    }
  });
}

// ─── Send message ───────────────────────────────────────────────────────────

async function sendMessage(storeId, phone, message) {
  const session = sessions[storeId];
  if (!session || session.status !== 'connected') {
    // Auto-trigger reconnection if session exists with creds but isn't connected
    if (session && session.status !== 'connecting' && session.status !== 'reconnecting' && session.status !== 'logged_out') {
      const sessionDir = path.join(AUTH_DIR, storeId);
      const credsFile = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsFile)) {
        console.log(`[WA-Baileys ${storeId}] sendMessage triggered auto-reconnect (status=${session.status})`);
        startSession(storeId).catch(() => {});
      }
    }
    return { success: false, reason: 'WhatsApp not connected. Scan QR code first.' };
  }

  let num = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (num.startsWith('00213')) num = num.substring(2);
  else if (num.startsWith('0')) num = '213' + num.substring(1);
  else if (!num.startsWith('213') && num.length <= 10) num = '213' + num;

  const jid = num + '@s.whatsapp.net';

  try {
    await delay(2000);
    const result = await session.sock.sendMessage(jid, { text: message });
    console.log(`[WA-Baileys ${storeId}] ✅ Sent to ${num}`);
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    console.error(`[WA-Baileys ${storeId}] ❌ Send error:`, e.message);
    return { success: false, reason: e.message };
  }
}

// ─── Disconnect (admin-initiated only) ──────────────────────────────────────

async function disconnectSession(storeId) {
  // Cancel any pending reconnect timer
  if (sessions[storeId]?._reconnectTimer) {
    clearTimeout(sessions[storeId]._reconnectTimer);
  }

  const session = sessions[storeId];
  if (session?.sock) {
    try { await session.sock.logout(); } catch (e) {}
    try { session.sock.end(); } catch (e) {}
  }
  const sessionDir = path.join(AUTH_DIR, storeId);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  sessions[storeId] = { status: 'disconnected', qr: null, phone: null, name: null };
}

// ─── Restore all sessions on server start ───────────────────────────────────

async function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) { fs.mkdirSync(AUTH_DIR, { recursive: true }); return; }
  const dirs = fs.readdirSync(AUTH_DIR);
  console.log(`[WA-Baileys] Found ${dirs.length} session(s) to restore`);

  for (const storeId of dirs) {
    const sessionDir = path.join(AUTH_DIR, storeId);
    if (!fs.statSync(sessionDir).isDirectory()) continue;
    const credsFile = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsFile)) {
      console.log(`[WA-Baileys] Skipping ${storeId} — no creds.json`);
      continue;
    }
    console.log(`[WA-Baileys] Restoring session: ${storeId}`);
    try {
      sessions[storeId] = {
        sock: null, status: 'connecting', qr: null,
        phone: null, name: null, lastConnected: null,
        error: null, retries: 0, startedAt: Date.now(),
        _reconnectTimer: null,
      };
      await createSocket(storeId, sessionDir);
    } catch (e) {
      console.log(`[WA-Baileys] Failed to restore ${storeId}:`, e.message);
      // Don't give up — schedule a retry in 30s
      const sd = sessionDir;
      const sid = storeId;
      sessions[sid].status = 'reconnecting';
      sessions[sid].error = `Restore failed: ${e.message}`;
      sessions[sid]._reconnectTimer = setTimeout(async () => {
        try { await createSocket(sid, sd); } catch (e2) {
          console.log(`[WA-Baileys] Restore retry failed for ${sid}:`, e2.message);
        }
      }, 30000);
    }
    // Stagger session restores to avoid hammering WA servers
    await delay(3000);
  }
}

// ─── Health check — periodic watchdog ───────────────────────────────────────
// Runs every 5 minutes. If a session has creds on disk but is in an error/
// disconnected state (not logged_out), kick off a reconnect. This catches
// edge cases where the reconnect loop gave up or a timer got lost.

function startHealthCheck() {
  setInterval(() => {
    if (!fs.existsSync(AUTH_DIR)) return;
    const dirs = fs.readdirSync(AUTH_DIR);
    for (const storeId of dirs) {
      const sessionDir = path.join(AUTH_DIR, storeId);
      try { if (!fs.statSync(sessionDir).isDirectory()) continue; } catch { continue; }
      const credsFile = path.join(sessionDir, 'creds.json');
      if (!fs.existsSync(credsFile)) continue;

      const s = sessions[storeId];
      if (!s || s.status === 'logged_out') continue;
      // Skip if healthy or actively waiting for QR
      if (s.status === 'connected' || s.status === 'waiting_qr') continue;
      // Skip if connecting/reconnecting but only recently started (within 3 min)
      if ((s.status === 'connecting' || s.status === 'reconnecting') && s.startedAt && (Date.now() - s.startedAt < 180000)) continue;

      // Session has creds but is stale (error, disconnected, stuck reconnecting) — revive it
      console.log(`[WA-Baileys healthcheck] Reviving stale session: ${storeId} (status=${s.status}, age=${s.startedAt ? Math.round((Date.now()-s.startedAt)/1000) : '?'}s)`);
      // Clear any stuck reconnect timer
      if (s._reconnectTimer) clearTimeout(s._reconnectTimer);
      if (s.sock) { try { s.sock.ws.close(); } catch {} try { s.sock.end(); } catch {} }
      sessions[storeId] = {
        sock: null, status: 'connecting', qr: null,
        phone: s?.phone || null, name: s?.name || null,
        lastConnected: s?.lastConnected || null,
        error: null, retries: 0, startedAt: Date.now(),
        _reconnectTimer: null,
      };
      createSocket(storeId, sessionDir).catch(e => {
        console.log(`[WA-Baileys healthcheck] Revive failed for ${storeId}:`, e.message);
      });
    }
  }, 2 * 60 * 1000); // every 2 minutes
}

// Start the watchdog
startHealthCheck();

module.exports = {
  startSession,
  sendMessage,
  disconnectSession,
  getStatus,
  getSession,
  restoreSessions,
};

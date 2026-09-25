// Baileys auth state stored in Postgres instead of the local wa-sessions/
// folder. Render's disk is wiped on every deploy / restart / sleep, which
// logged the super-admin WhatsApp out and forced a new QR scan each time.
// Rows mirror useMultiFileAuthState's files one-to-one (same names), so an
// existing folder can be imported as-is.
const fs = require('fs');
const path = require('path');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const pool = require('../config/db');

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`CREATE TABLE IF NOT EXISTS wa_auth_files(
      session_id TEXT NOT NULL, file TEXT NOT NULL, data TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(session_id, file))`)
      .catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

async function hasDbCreds(sessionId) {
  await ensureTable();
  const r = await pool.query("SELECT 1 FROM wa_auth_files WHERE session_id=$1 AND file='creds.json'", [sessionId]);
  return r.rowCount > 0;
}

async function listDbSessions() {
  await ensureTable();
  const r = await pool.query("SELECT DISTINCT session_id FROM wa_auth_files WHERE file='creds.json'");
  return r.rows.map((x) => x.session_id);
}

async function clearDbSession(sessionId) {
  await ensureTable();
  await pool.query('DELETE FROM wa_auth_files WHERE session_id=$1', [sessionId]);
}

// One-time import of a folder written by useMultiFileAuthState.
async function importDirToDb(sessionId, dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'creds.json'))) return false;
  await ensureTable();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const data = fs.readFileSync(path.join(dir, f), 'utf8');
    await pool.query(`INSERT INTO wa_auth_files(session_id,file,data) VALUES($1,$2,$3)
      ON CONFLICT (session_id,file) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [sessionId, f, data]);
  }
  return true;
}

async function useDbAuthState(sessionId) {
  await ensureTable();
  const cache = new Map();
  const rows = await pool.query('SELECT file,data FROM wa_auth_files WHERE session_id=$1', [sessionId]);
  for (const r of rows.rows) cache.set(r.file, r.data);

  // Writes for the same file are chained so they land in order.
  const pending = new Map();
  const persist = (file, text) => {
    const prev = pending.get(file) || Promise.resolve();
    const next = prev.then(() => (text == null
      ? pool.query('DELETE FROM wa_auth_files WHERE session_id=$1 AND file=$2', [sessionId, file])
      : pool.query(`INSERT INTO wa_auth_files(session_id,file,data) VALUES($1,$2,$3)
          ON CONFLICT (session_id,file) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [sessionId, file, text])
    )).catch((e) => console.log(`[WA-DB ${sessionId}] save ${file} failed:`, e.message));
    pending.set(file, next);
    return next;
  };

  const readData = (name) => {
    const text = cache.get(fixFileName(name));
    if (text == null) return null;
    try { return JSON.parse(text, BufferJSON.reviver); } catch { return null; }
  };
  const writeData = (data, name) => {
    const file = fixFileName(name);
    const text = JSON.stringify(data, BufferJSON.replacer);
    cache.set(file, text);
    return persist(file, text);
  };
  const removeData = (name) => {
    const file = fixFileName(name);
    cache.delete(file);
    return persist(file, null);
  };

  const creds = readData('creds.json') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

module.exports = { useDbAuthState, hasDbCreds, listDbSessions, clearDbSession, importDirToDb };

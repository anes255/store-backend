// ─── Stop desks ────────────────────────────────────────────────────────────
// Which communes a carrier actually has a desk in.
//
// A buyer used to be able to pick "desk" for any commune in their wilaya.
// Plenty of communes have no desk, so the order was accepted and then rejected
// by the carrier at transfer time ("no stop desk in this area"). The desk list
// is pulled from each carrier's own API and cached per store, so the checkout
// can offer only the communes that really have one.
//
// Carrier shapes. NOT yet confirmed against live accounts: Yalidine's path comes
// from third-party integration notes and the EcoTrack paths are candidates.
//   yalidine / guepex  GET {base}/v1/centers?wilaya_id=N   → { data: [...] }
//   ecotrack           GET {base}/get/desks?api_token=...  (tenant-hosted)
//   noest              built-in station table (merchant-agnostic codes)
//   procolis (ZR)      no desk list published — commune-level agency instead
// Anything else, and anything the API refuses, falls back to whatever the
// owner entered by hand in the dashboard.

const pool = require('../config/db');
const { detectCarrier, normalizeConfig, wilayaToCode } = require('./carrierApi');

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS carrier_desks (
    id SERIAL PRIMARY KEY,
    store_id UUID NOT NULL,
    delivery_company_id INTEGER,
    wilaya_code VARCHAR(4) NOT NULL,
    commune VARCHAR(160) NOT NULL,
    name VARCHAR(200),
    address TEXT,
    center_id VARCHAR(64),
    source VARCHAR(20) NOT NULL DEFAULT 'api',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS carrier_desks_lookup
    ON carrier_desks (store_id, delivery_company_id, wilaya_code)`).catch(() => {});
}

const norm = (s) => String(s || '').trim();
const two = (c) => String(c || '').padStart(2, '0').slice(0, 4);

/** Pulls the desk list straight from the carrier. Returns [] when it can't. */
async function fetchDesksFromCarrier(dc) {
  const cfg = normalizeConfig({ ...dc, api_base_url: dc.api_base_url });
  const base = String(cfg.api_base_url || '').replace(/\/+$/, '');
  if (!base) return [];
  const carrier = detectCarrier(base);
  const out = [];

  const get = async (url, headers) => {
    try {
      const r = await fetch(url, { method: 'GET', headers: headers || {}, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    } catch { return null; }
  };

  if (carrier === 'yalidine') {
    // Yalidine/Guepex paginate; 1000 covers the whole country comfortably.
    const headers = { 'X-API-ID': cfg.user_guid || cfg.api_id || '', 'X-API-TOKEN': cfg.api_key || '' };
    const root = /\/v\d+$/.test(base) ? base : base + '/v1';
    const data = await get(`${root}/centers?page_size=1000`, headers);
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    for (const c of rows) {
      const w = two(c.wilaya_id ?? c.wilaya_code ?? wilayaToCode(c.wilaya_name));
      const commune = norm(c.commune_name || c.commune || c.wilaya_name);
      if (!w || !commune) continue;
      out.push({ wilaya_code: w, commune, name: norm(c.name), address: norm(c.address), center_id: String(c.center_id ?? c.id ?? '') });
    }
    return out;
  }

  if (carrier === 'ecotrack') {
    const key = encodeURIComponent(cfg.api_key || '');
    for (const path of ['/get/desks', '/api/v1/get/desks', '/get/stop_desks']) {
      const data = await get(`${base}${path}?api_token=${key}`);
      const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      if (!rows.length) continue;
      for (const d of rows) {
        const w = two(d.wilaya_id ?? d.wilaya_code ?? wilayaToCode(d.wilaya || d.wilaya_name));
        const commune = norm(d.commune || d.commune_name || d.name);
        if (!w || !commune) continue;
        out.push({ wilaya_code: w, commune, name: norm(d.name || d.desk), address: norm(d.address), center_id: String(d.id ?? d.desk_id ?? '') });
      }
      if (out.length) return out;
    }
    return out;
  }

  if (carrier === 'noest') {
    // NOEST publishes fixed station codes; the hint is the desk's own town.
    const { NOEST_STATIONS } = require('./carrierApi');
    if (NOEST_STATIONS) {
      for (const [wid, entry] of Object.entries(NOEST_STATIONS)) {
        for (const st of entry.stations || []) {
          out.push({ wilaya_code: two(wid), commune: norm(st.hint), name: `NOEST ${st.code}`, address: '', center_id: st.code });
        }
      }
    }
    return out;
  }

  return out; // procolis / generic: nothing published
}

/** Refreshes one carrier's desks for a store. Manual entries are kept. */
async function syncDesks(storeId, dc) {
  await ensureTable();
  const desks = await fetchDesksFromCarrier(dc);
  if (!desks.length) return { ok: false, count: 0, reason: 'no_desk_list' };
  await pool.query('DELETE FROM carrier_desks WHERE store_id=$1 AND delivery_company_id=$2 AND source=$3', [storeId, dc.id, 'api']);
  for (const d of desks) {
    await pool.query(
      `INSERT INTO carrier_desks(store_id,delivery_company_id,wilaya_code,commune,name,address,center_id,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,'api')`,
      [storeId, dc.id, d.wilaya_code, d.commune, d.name || null, d.address || null, d.center_id || null]
    ).catch(() => {});
  }
  return { ok: true, count: desks.length };
}

/**
 * Desks for one wilaya. `companyId` null = any carrier the store uses.
 * Returns [] when the carrier publishes no list — the caller decides whether
 * that means "no desks here" or "desks everywhere" (see hasDeskList).
 */
async function listDesks(storeId, wilayaCode, companyId) {
  await ensureTable();
  const p = [storeId, two(wilayaCode)];
  let q = 'SELECT DISTINCT commune, name, address, center_id, delivery_company_id FROM carrier_desks WHERE store_id=$1 AND wilaya_code=$2';
  if (companyId) { p.push(companyId); q += ` AND delivery_company_id=$${p.length}`; }
  q += ' ORDER BY commune';
  const { rows } = await pool.query(q, p);
  return rows;
}

/** Does this carrier have a desk list at all (any wilaya)? */
async function hasDeskList(storeId, companyId) {
  await ensureTable();
  const p = [storeId];
  let q = 'SELECT 1 FROM carrier_desks WHERE store_id=$1';
  if (companyId) { p.push(companyId); q += ` AND delivery_company_id=$${p.length}`; }
  const { rows } = await pool.query(q + ' LIMIT 1', p);
  return rows.length > 0;
}

module.exports = { ensureTable, fetchDesksFromCarrier, syncDesks, listDesks, hasDeskList };

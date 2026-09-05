// ─────────────────────────────────────────────────────────────────────────────
// Carrier API client. Single entry-point used by both tracking and create-order
// flows. Per-host normalisation lives at the top of each function so we always
// hit the correct endpoint regardless of what the admin pasted into the form.
// ─────────────────────────────────────────────────────────────────────────────

const parseJson = (v) => typeof v === 'string'
  ? (() => { try { return JSON.parse(v); } catch { return {}; } })()
  : (v || {});

// Algerian wilaya name → numeric code lookup. Carriers like ZR Express,
// Procolis, NOEST and EcoTrack (incl. DHD) all want the integer wilaya id (1-58),
// not the name. We accept several spelling variants so we don't care
// which form the storefront stored.
const WILAYA_CODES = {
  'adrar':1,'chlef':2,'laghouat':3,'oum el bouaghi':4,'batna':5,'béjaïa':6,'bejaia':6,
  'biskra':7,'béchar':8,'bechar':8,'blida':9,'bouira':10,'tamanrasset':11,'tébessa':12,
  'tebessa':12,'tlemcen':13,'tiaret':14,'tizi ouzou':15,'alger':16,'algiers':16,
  'djelfa':17,'jijel':18,'sétif':19,'setif':19,'saïda':20,'saida':20,'skikda':21,
  'sidi bel abbès':22,'sidi bel abbes':22,'annaba':23,'guelma':24,'constantine':25,
  'médéa':26,'medea':26,'mostaganem':27,"m'sila":28,'msila':28,'mascara':29,
  'ouargla':30,'oran':31,'el bayadh':32,'illizi':33,'bordj bou arréridj':34,
  'bordj bou arreridj':34,'boumerdès':35,'boumerdes':35,'el tarf':36,'tindouf':37,
  'tissemsilt':38,'el oued':39,'khenchela':40,'souk ahras':41,'tipaza':42,'mila':43,
  'aïn defla':44,'ain defla':44,'naâma':45,'naama':45,'aïn témouchent':46,
  'ain temouchent':46,'ghardaïa':47,'ghardaia':47,'relizane':48,'timimoun':49,
  "el m'ghair":49,'bordj badji mokhtar':50,'ouled djellal':51,'béni abbès':52,
  'beni abbes':52,'in salah':53,'in guezzam':54,'touggourt':55,'djanet':56,
  'el mghair':57,'el meniaa':58,
};
function wilayaToCode(input) {
  if (!input) return '';
  const s = String(input).toLowerCase().trim();
  if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';
  // Strip leading "16-" / "16 " / "16 - "
  const stripped = s.replace(/^\s*\d+\s*[-–—.]?\s*/, '').trim();
  return String(WILAYA_CODES[stripped] || WILAYA_CODES[s] || '');
}

// Detect carrier family from base URL host. We use this to:
//   • swap in the canonical tracking/create endpoints when the admin's
//     pasted ones are wrong
//   • use the carrier-specific content-type
//   • walk the carrier's response shape correctly
function detectCarrier(baseUrl) {
  const host = (() => { try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; } })();
  // EcoTrack family is checked FIRST so dhd.ecotrack.dz / yalidex.ecotrack.dz
  // / any-tenant.ecotrack.dz use the EcoTrack endpoint shape, not Procolis.
  if (/noest/.test(host)) return 'noest';
  if (/ecotrack/.test(host)) return 'ecotrack';
  if (/yalidine/.test(host)) return 'yalidine';
  if (/procolis|zr-?express/.test(host)) return 'procolis';
  if (/maystro/.test(host)) return 'maystro';
  if (/yassir/.test(host)) return 'yassir';
  if (/aramex/.test(host)) return 'aramex';
  if (/dhl/.test(host)) return 'dhl';
  if (/fedex/.test(host)) return 'fedex';
  if (/ups/.test(host)) return 'ups';
  return 'generic';
}

// ─── normalizeConfig ────────────────────────────────────────────────────────
// Auto-migrate legacy NOEST configs. Old presets had /api/public/v1 base and
// query_params auth. Real API uses /api/public paths, Bearer header + user_guid
// in body. We fix the base URL and migrate credentials.
function normalizeConfig(cfg) {
  const host = (() => { try { return new URL(cfg.api_base_url || '').host.toLowerCase(); } catch { return ''; } })();
  if (/noest/.test(host)) {
    let patched = { ...cfg };
    // Migrate api_token from query_params → api_key (Bearer)
    if (!patched.api_key || patched.api_auth_type === 'query_params') {
      const q = parseJson(patched.api_query_params);
      if (q.api_token && !patched.api_key) patched.api_key = q.api_token;
      patched.api_auth_type = 'bearer';
    }
    // Fix base URL to origin (all NOEST paths start with /api/public/...)
    try { patched.api_base_url = new URL(patched.api_base_url).origin; } catch {}
    return patched;
  }
  return cfg;
}

// OAuth2 client-credentials cache so we don't fetch a token on every request.
const _oauthCache = new Map(); // key: tokenUrl|clientId, value: { token, expiresAt }
async function getOAuthToken(cfg) {
  const oauth = parseJson(cfg.oauth2_credentials);
  if (!cfg.oauth2_token_url || !oauth.client_id || !oauth.client_secret) {
    return { err: 'OAuth2 credentials missing' };
  }
  const cacheKey = cfg.oauth2_token_url + '|' + oauth.client_id;
  const cached = _oauthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return { token: cached.token };
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: oauth.client_id,
      client_secret: oauth.client_secret,
    });
    const r = await fetch(cfg.oauth2_token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      return { err: 'OAuth2 token request failed: ' + (j.error_description || j.error || ('HTTP ' + r.status)) };
    }
    const ttlMs = Math.max(60_000, ((j.expires_in || 3600) - 60) * 1000);
    _oauthCache.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + ttlMs });
    return { token: j.access_token };
  } catch (e) {
    return { err: 'OAuth2 token fetch failed: ' + e.message };
  }
}

function buildAuthHeaders(cfg) {
  const headersIn = parseJson(cfg.api_headers);
  const headers = { 'Accept': 'application/json' };
  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  return headers;
}

function applyQueryAuth(url, cfg) {
  if (cfg.api_auth_type !== 'query_params') return url;
  const queryIn = parseJson(cfg.api_query_params);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
  if (!params.toString()) return url;
  return url + (url.includes('?') ? '&' : '?') + params.toString();
}

// ─── carrierRequest ─────────────────────────────────────────────────────────
// Used for tracking lookups + list/sync probes. Honours per-carrier overrides
// so callers can rely on it producing the right call shape for known hosts.
async function carrierRequest(rawCfg, trackingNumber, bodyOverride) {
  const cfg = normalizeConfig(rawCfg);
  const tn = trackingNumber || 'TEST00000';
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Language': 'fr,en;q=0.9,ar;q=0.8',
    'User-Agent': 'MakretDZ/1.0 (+https://makretdz.com)',
    ...buildAuthHeaders(cfg),
  };

  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }

  // Per-carrier endpoint normalisation: prefer canonical paths over
  // anything the admin may have pasted. This also fixes the common
  // pattern where the admin picked a preset that's slightly off.
  let path = cfg.api_tracking_endpoint || '';
  let method = (cfg.api_method || cfg.method || 'GET').toUpperCase();
  let body = bodyOverride || undefined;

  if (carrier === 'yalidine') {
    if (tn && tn !== 'TEST00000') path = `/parcels/${encodeURIComponent(tn)}/`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'procolis') {
    path = '/lire';
    method = 'POST';
    body = JSON.stringify({ Colis: tn ? [{ Tracking: tn }] : [] });
  } else if (carrier === 'noest') {
    // NOEST Public API v2.3: POST /api/public/get/trackings/info with JSON body
    const q = parseJson(cfg.api_query_params);
    const userGuid = q.user_guid || '';
    if (tn && tn !== 'TEST00000') {
      path = '/api/public/get/trackings/info';
      method = 'POST';
      body = JSON.stringify({ trackings: [tn] });
    } else {
      // No list-all endpoint — use /api/public/get/wilayas as connectivity test
      path = '/api/public/get/wilayas';
      method = 'GET';
      body = undefined;
    }
  } else if (carrier === 'ecotrack') {
    if (tn && tn !== 'TEST00000') path = `/get/tracking/info?tracking=${encodeURIComponent(tn)}`;
    else path = path || '/get/orders?page=1';
    method = 'GET';
    body = undefined;
    if (/validate\/token/.test(path) && cfg.api_key) {
      path += (path.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);
    }
  } else if (carrier === 'maystro') {
    if (tn && tn !== 'TEST00000') path = `/orders/?display_id=${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'dhl') {
    path = `?trackingNumber=${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'ups') {
    path = `/track/v1/details/${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'fedex') {
    path = '/track/v1/trackingnumbers';
    method = 'POST';
    body = JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }], includeDetailedScans: false });
  } else {
    // Generic fallback: substitute placeholders in admin-provided endpoint.
    path = path.replace(/\{tracking_number\}/g, encodeURIComponent(tn))
               .replace(/\{number\}/g, encodeURIComponent(tn))
               .replace(/\{tn\}/g, encodeURIComponent(tn));
    if (!body && method !== 'GET' && cfg.api_body_template) {
      const headersIn = parseJson(cfg.api_headers);
      let tpl = cfg.api_body_template.replace(/\{tracking_number\}/g, tn);
      for (const [k, v] of Object.entries(headersIn)) tpl = tpl.split('{' + k + '}').join(String(v || ''));
      body = tpl;
    }
  }

  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  if (path) url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  url = applyQueryAuth(url, cfg);
  // EcoTrack (non-NOEST) expects api_token as query param
  const host = (() => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } })();
  if (carrier === 'ecotrack' && !/noest/.test(host) && cfg.api_key && !url.includes('api_token'))
    url += (url.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);

  try {
    console.log(`[carrierRequest] ${carrier} ${method} ${url}`);
    let r = await fetch(url, { method, headers, body, redirect: method === 'POST' ? 'manual' : 'follow', signal: AbortSignal.timeout(15000) });
    if (method === 'POST' && [301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (loc) {
        const redir = loc.startsWith('http') ? loc : new URL(loc, url).href;
        console.log(`[carrierRequest] ${carrier} redirect ${r.status} → ${redir} (re-POSTing)`);
        r = await fetch(redir, { method: 'POST', headers, body, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      }
    }
    const txt = await r.text();
    console.log(`[carrierRequest] ${carrier} ← HTTP ${r.status} | ${txt.slice(0, 200)}`);
    return { ok: r.ok, status: r.status, body: txt, url };
  } catch (e) {
    console.error(`[carrierRequest] ${carrier} ERROR: ${e.message}`);
    return { ok: false, err: e.message, url };
  }
}

// ─── NOEST station codes ────────────────────────────────────────────────────
// NOEST requires `station_code` on the order body when `stop_desk = 1`. The
// codes are merchant-agnostic and follow the pattern `{wilaya:02d}{letter}`.
// Source: official NOEST station list (https://noest-dz.com).
// Each wilaya entry: { default: "main station code", stations: [{code, hint}] }
// where `hint` is a lowercased commune/city substring used to pick the closest
// desk when the wilaya has multiple stations.
const NOEST_STATIONS = {
  1:  { default: '01A', stations: [{ code: '01A', hint: 'adrar' }] },
  2:  { default: '02A', stations: [{ code: '02A', hint: 'chlef' }, { code: '02B', hint: 'tenes' }] },
  3:  { default: '03A', stations: [{ code: '03A', hint: 'laghouat' }, { code: '03B', hint: 'aflou' }] },
  4:  { default: '04B', stations: [{ code: '04B', hint: 'oum el bouaghi' }, { code: '04A', hint: 'ain mlila' }, { code: '04C', hint: 'ain el beida' }] },
  5:  { default: '05A', stations: [{ code: '05A', hint: 'batna' }, { code: '05C', hint: 'oulmi' }, { code: '05B', hint: 'barika' }] },
  6:  { default: '06A', stations: [{ code: '06A', hint: 'bejaia' }, { code: '06B', hint: 'akbou' }, { code: '06C', hint: 'el kseur' }] },
  7:  { default: '07A', stations: [{ code: '07A', hint: 'biskra' }] },
  8:  { default: '08A', stations: [{ code: '08A', hint: 'bechar' }] },
  9:  { default: '09A', stations: [{ code: '09A', hint: 'blida' }, { code: '09B', hint: 'boufarik' }] },
  10: { default: '10A', stations: [{ code: '10A', hint: 'bouira' }, { code: '10B', hint: 'lakhdaria' }] },
  11: { default: '11A', stations: [{ code: '11A', hint: 'tamanrasset' }] },
  12: { default: '12A', stations: [{ code: '12A', hint: 'tebessa' }, { code: '12B', hint: 'ouenza' }] },
  13: { default: '13A', stations: [{ code: '13A', hint: 'tlemcen' }, { code: '13B', hint: 'maghnia' }] },
  14: { default: '14A', stations: [{ code: '14A', hint: 'tiaret' }, { code: '14B', hint: 'frenda' }] },
  15: { default: '15A', stations: [{ code: '15A', hint: 'tizi ouzou' }, { code: '15B', hint: 'azazga' }, { code: '15C', hint: 'draa ben khedda' }] },
  16: { default: '16A', stations: [
    { code: '16A', hint: 'bir mourad rais' }, { code: '16B', hint: 'bab ezzouar' },
    { code: '16C', hint: 'cheraga' },         { code: '16D', hint: 'reghaia' },
    { code: '16E', hint: 'alger centre' },    { code: '16E', hint: 'sacre' },
    { code: '16F', hint: 'baba hassen' },     { code: '16G', hint: 'baraki' },
    { code: '16H', hint: 'bordj el bahri' },  { code: '16I', hint: 'zeralda' },
    { code: '16J', hint: 'birkhadem' },
  ] },
  17: { default: '17A', stations: [{ code: '17A', hint: 'djelfa' }, { code: '17B', hint: 'ain ouassara' }, { code: '17B', hint: 'ain oussera' }] },
  18: { default: '18A', stations: [{ code: '18A', hint: 'jijel' }] },
  19: { default: '19A', stations: [
    { code: '19A', hint: 'setif' }, { code: '19B', hint: 'el eulma' },
    { code: '19C', hint: 'ain oulmene' }, { code: '19RE', hint: 'guidjel' },
  ] },
  20: { default: '20A', stations: [{ code: '20A', hint: 'saida' }] },
  21: { default: '21A', stations: [{ code: '21A', hint: 'skikda' }, { code: '21B', hint: 'azzaba' }] },
  22: { default: '22A', stations: [{ code: '22A', hint: 'sidi bel abbes' }] },
  23: { default: '23A', stations: [{ code: '23A', hint: 'annaba' }, { code: '23B', hint: 'el bouni' }, { code: '23B', hint: 'bouni' }] },
  24: { default: '24A', stations: [{ code: '24A', hint: 'guelma' }] },
  25: { default: '25A', stations: [
    { code: '25A', hint: 'zouaghi' }, { code: '25B', hint: 'ali mendjeli' },
    { code: '25C', hint: 'constantine' },
  ] },
  26: { default: '26A', stations: [{ code: '26A', hint: 'medea' }] },
  27: { default: '27A', stations: [{ code: '27A', hint: 'mostaganem' }, { code: '27B', hint: 'sidi lakhder' }] },
  28: { default: '28A', stations: [{ code: '28A', hint: 'msila' }, { code: '28A', hint: 'm\'sila' }, { code: '28B', hint: 'bousaada' }, { code: '28B', hint: 'bou saada' }] },
  29: { default: '29B', stations: [{ code: '29B', hint: 'mascara' }, { code: '29A', hint: 'mohammadia' }] },
  30: { default: '30A', stations: [{ code: '30A', hint: 'ouargla' }, { code: '30B', hint: 'hassi messaoud' }] },
  31: { default: '31A', stations: [
    { code: '31A', hint: 'maraval' }, { code: '31A', hint: 'oran' },
    { code: '31B', hint: 'bir el djir' }, { code: '31C', hint: 'gambetta' },
    { code: '31C', hint: 'gambita' }, { code: '31D', hint: 'arzew' },
  ] },
  32: { default: '32A', stations: [{ code: '32A', hint: 'el bayadh' }] },
  33: { default: '33A', stations: [{ code: '33A', hint: 'illizi' }] },
  34: { default: '34A', stations: [{ code: '34A', hint: 'bordj bou arreridj' }, { code: '34A', hint: 'bba' }] },
  35: { default: '35A', stations: [
    { code: '35A', hint: 'boumerdes' }, { code: '35B', hint: 'ouled moussa' },
    { code: '35C', hint: 'bordj menaiel' }, { code: '35D', hint: 'dellys' },
  ] },
  36: { default: '36A', stations: [{ code: '36A', hint: 'el tarf' }, { code: '36A', hint: 'el taref' }] },
  37: { default: '37A', stations: [{ code: '37A', hint: 'tindouf' }] },
  38: { default: '38A', stations: [{ code: '38A', hint: 'tissemsilt' }] },
  39: { default: '39A', stations: [{ code: '39A', hint: 'el oued' }] },
  40: { default: '40A', stations: [{ code: '40A', hint: 'khenchela' }] },
  41: { default: '41A', stations: [{ code: '41A', hint: 'souk ahras' }] },
  42: { default: '42A', stations: [{ code: '42A', hint: 'tipaza' }, { code: '42B', hint: 'kolea' }, { code: '42B', hint: 'koléa' }] },
  43: { default: '43A', stations: [
    { code: '43A', hint: 'mila' }, { code: '43B', hint: 'chelghoum' },
    { code: '43C', hint: 'tadjenanet' }, { code: '43D', hint: 'ferdjioua' },
  ] },
  44: { default: '44A', stations: [{ code: '44A', hint: 'ain defla' }, { code: '44B', hint: 'khemis miliana' }] },
  45: { default: '45A', stations: [{ code: '45A', hint: 'mecheria' }, { code: '45A', hint: 'naama' }] },
  46: { default: '46A', stations: [{ code: '46A', hint: 'ain temouchent' }, { code: '46A', hint: 'aïn témouchent' }] },
  47: { default: '47A', stations: [{ code: '47A', hint: 'ghardaia' }] },
  48: { default: '48A', stations: [{ code: '48A', hint: 'relizane' }] },
  49: { default: '49A', stations: [{ code: '49A', hint: 'timimoun' }] },
  51: { default: '51A', stations: [{ code: '51A', hint: 'ouled djellal' }] },
  52: { default: '52A', stations: [{ code: '52A', hint: 'beni abbes' }, { code: '52A', hint: 'béni abbès' }] },
  53: { default: '53A', stations: [{ code: '53A', hint: 'in salah' }] },
  55: { default: '55A', stations: [{ code: '55A', hint: 'touggourt' }] },
  56: { default: '56A', stations: [{ code: '56A', hint: 'djanet' }] },
  58: { default: '58A', stations: [{ code: '58A', hint: 'el meniaa' }] },
};

// Pick the best station_code for a given wilaya + commune. For multi-station
// wilayas (Alger has 10, Sétif has 4, etc.) we match the commune against
// station hints; otherwise we fall back to the wilaya's default station.
function pickNoestStation(wilayaId, communeName) {
  const entry = NOEST_STATIONS[parseInt(wilayaId) || 0];
  if (!entry) return '';
  const c = String(communeName || '').toLowerCase()
    .replace(/é|è|ê|ë/g, 'e').replace(/à|â|ä/g, 'a').replace(/ù|û|ü/g, 'u')
    .replace(/ô|ö/g, 'o').replace(/î|ï/g, 'i').replace(/ç/g, 'c');
  if (c && Array.isArray(entry.stations)) {
    for (const s of entry.stations) {
      if (s.hint && c.includes(s.hint)) return s.code;
    }
  }
  return entry.default;
}

// ─── resolveCommune ─────────────────────────────────────────────────────────
// Fix common commune misspellings (e.g. "Hammadia" → "Hamadia") by fetching
// the carrier's commune list for the wilaya and picking the closest match.
// Returns the corrected name or the original if no good match found.
async function resolveCommune(baseUrl, headers, wilayaCode, communeName, cfg, carrier) {
  try {
    const communesUrl = carrier === 'ecotrack'
      ? baseUrl + '/get/communes/' + wilayaCode + (cfg.api_key ? '?api_token=' + encodeURIComponent(cfg.api_key) : '')
      : baseUrl + '/api/public/get/communes/' + wilayaCode;
    // EcoTrack auth is via api_token query param; strip Authorization to avoid 401.
    const preHeaders = { ...headers };
    if (carrier === 'ecotrack') delete preHeaders['Authorization'];
    const r = await fetch(communesUrl, { method: 'GET', headers: preHeaders, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return communeName;
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { return communeName; }
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.communes) ? data.communes : []));
    if (!arr.length) return communeName;
    const getName = (c) => c.commune || c.name || c.nom || '';
    const normalize = (s) => String(s || '').toLowerCase().trim()
      .replace(/é|è|ê|ë/g, 'e').replace(/à|â|ä/g, 'a').replace(/ù|û|ü/g, 'u')
      .replace(/ô|ö/g, 'o').replace(/î|ï/g, 'i').replace(/ç/g, 'c')
      .replace(/[''`\-_\s]+/g, '')
      .replace(/([bcdfghjklmnpqrstvwxz])\1+/g, '$1');
    const inputNorm = normalize(communeName);
    if (!inputNorm) return communeName;
    // Exact match
    let pick = arr.find(c => normalize(getName(c)) === inputNorm);
    if (!pick) {
      let bestScore = 0;
      for (const c of arr) {
        const cn = normalize(getName(c));
        if (!cn) continue;
        let score = 0;
        if (cn === inputNorm) score = 100;
        else if (cn.startsWith(inputNorm) || inputNorm.startsWith(cn)) score = 85 - Math.abs(cn.length - inputNorm.length);
        else if (cn.includes(inputNorm) || inputNorm.includes(cn)) score = 70 - Math.abs(cn.length - inputNorm.length);
        else {
          const shorter = inputNorm.length < cn.length ? inputNorm : cn;
          const longer  = inputNorm.length < cn.length ? cn : inputNorm;
          let matching = 0;
          for (let i = 0; i < shorter.length; i++) if (longer.includes(shorter[i])) matching++;
          score = (matching / Math.max(longer.length, 1)) * 60;
        }
        if (score > bestScore) { bestScore = score; pick = c; }
      }
      if (bestScore < 30) pick = null;
    }
    return pick ? (getName(pick) || communeName) : communeName;
  } catch { return communeName; }
}

// ─── carrierCreateOrder ─────────────────────────────────────────────────────
// Pushes one of OUR orders into the carrier's system. Returns the carrier's
// tracking number on success so we can persist it and start polling status.
async function carrierCreateOrder(rawCfg, order, items) {
  const cfg = normalizeConfig(rawCfg);
  const carrier = detectCarrier(cfg.api_base_url || '');
  const baseUrl = (cfg.api_base_url || '').replace(/\/$/, '');

  // ── Auth headers ──
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Language': 'fr,en;q=0.9,ar;q=0.8',
    'User-Agent': 'MakretDZ/1.0 (+https://makretdz.com)',
    ...buildAuthHeaders(cfg),
  };
  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }

  // ── Endpoint resolution ──
  // For known carriers, always use the canonical endpoint (ignore stale DB values).
  let path;
  if (carrier === 'yalidine') path = '/parcels/';
  else if (carrier === 'noest') path = '/api/public/create/order';
  else if (carrier === 'procolis') path = '/add_colis';
  else if (carrier === 'ecotrack') path = '/create/order';
  else if (carrier === 'maystro') path = '/orders/';
  else {
    path = (cfg.api_create_endpoint || '').trim();
    if (!path) return { ok: false, err: 'No create-order endpoint configured for this carrier' };
  }

  // ── Build substitution variables ──
  // Render the chosen variant(s) so the delivery company's receipt shows what
  // exactly to ship (color/size/per-unit breakdown), not just the product name.
  const variantStr = (vi) => {
    let v = vi;
    if (v == null) return '';
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
    const cap = (s) => typeof s === 'string' && s.length ? s[0].toUpperCase() + s.slice(1) : s;
    const one = (s) => typeof s === 'string' ? s : (s ? (s.label || s.name || s.value || '') : '');
    if (Array.isArray(v?.per_unit)) {
      return v.per_unit.map((u, idx) => {
        const txt = Array.isArray(u?.selections) ? u.selections.map(one).filter(Boolean).join(' / ') : one(u);
        return txt ? `#${idx + 1}: ${txt}` : '';
      }).filter(Boolean).join(' | ');
    }
    if (v?.label) return String(v.label);
    if (Array.isArray(v?.selections)) return v.selections.map(s => `${s.type ? cap(s.type) + ': ' : ''}${one(s)}`).filter(Boolean).join(' / ');
    if (v?.name || v?.value) return `${v.type ? cap(v.type) + ': ' : ''}${v.name || v.value}`;
    if (typeof v === 'object') return Object.entries(v).filter(([k, val]) => val != null && typeof val !== 'object' && !['type', 'sku', 'price'].includes(k)).map(([k, val]) => `${cap(k)}: ${val}`).join(' / ');
    return '';
  };
  const productList = (items || []).map(i => {
    const vs = variantStr(i.variant_info ?? i.variant);
    return `${i.product_name || i.name || 'Item'}${vs ? ` (${vs})` : ''} ×${i.quantity || 1}`;
  }).join(', ');
  const fullName = (order.customer_name || '').trim();
  const nameParts = fullName.split(/\s+/);
  const totalNum = parseFloat(order.total || 0) || 0;
  const itemCount = (items || []).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0) || 1;
  const weightNum = (items || []).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0) || 1;
  // Lenient detection — accept any value that means "drop at desk/agency".
  // Frontend should send 'desk', but historical data / API callers may use
  // 'stopdesk', 'stop_desk', 'office', 'bureau', etc.
  const shipTypeRaw = String(order.shipping_type || '').toLowerCase().trim();
  let isStopdesk = /^(desk|stop[\s_-]?desk|office|bureau|relais|pickup)$/.test(shipTypeRaw);
  console.log(`[carrierCreateOrder] ${carrier}: shipping_type="${order.shipping_type}" → isStopdesk=${isStopdesk}`);
  const subs = {
    tracking_number: order.tracking_number || '',
    order_id: String(order.order_number || order.id || ''),
    customer_name: fullName,
    customer_firstname: nameParts[0] || fullName,
    customer_lastname: nameParts.slice(1).join(' ') || fullName,
    customer_phone: (order.customer_phone || '').replace(/[^\d+]/g, ''),
    customer_email: order.customer_email || '',
    shipping_address: order.shipping_address || '',
    shipping_city: order.shipping_city || order.shipping_wilaya || '',
    shipping_wilaya: order.shipping_wilaya || '',
    shipping_zip: order.shipping_zip || '',
    wilaya_code: String(order.shipping_wilaya_code || wilayaToCode(order.shipping_wilaya) || (order.shipping_zip ? order.shipping_zip.slice(0, 2).replace(/^0+/, '') : '') || '0'),
    total: String(totalNum),
    subtotal: String(parseFloat(order.subtotal || 0) || 0),
    shipping_cost: String(parseFloat(order.shipping_cost || 0) || 0),
    discount: String(parseFloat(order.discount || 0) || 0),
    currency: order.currency || 'DZD',
    is_stopdesk: isStopdesk ? 'true' : 'false',
    is_stopdesk_int: isStopdesk ? '1' : '0',
    payment_method: order.payment_method || 'cod',
    notes: order.notes || '',
    item_count: String(itemCount),
    product_list: productList,
    weight: String(weightNum),
  };

  // ── Build request body per carrier ──
  // For known carriers, ALWAYS use the canonical body format regardless of
  // what may be stored in the DB (stale presets had wrong field types).
  let body;
  if (carrier === 'noest') {
    // NOEST Public API v2.3 — JSON body with user_guid
    const q = parseJson(cfg.api_query_params);
    const userGuid = q.user_guid || '';
    const noestBody = {
      user_guid: userGuid,
      reference: subs.order_id.padStart(5, '0'),
      client: subs.customer_name,
      phone: subs.customer_phone,
      phone_2: '',
      adresse: subs.shipping_address,
      montant: (subs.payment_method && subs.payment_method !== 'cod')
        ? (parseFloat(subs.shipping_cost) || 0)
        : (parseFloat(subs.total) || parseFloat(subs.subtotal) || 0),
      remarque: subs.notes || '',
      produit: subs.product_list || 'Commande',
      type_id: 1, // 1=Delivery (home or stop_desk). 2=Exchange. 3=Pick-up (forces amount=0, never use for delivery)
      poids: parseFloat(subs.weight) || 0,
      stop_desk: isStopdesk ? 1 : 0,
      stock: 0,
      quantite: String(subs.item_count),
      can_open: 1,
    };
    // Always send wilaya_id + commune (zip_code unreliable on NOEST)
    noestBody.wilaya_id = parseInt(subs.wilaya_code) || 16;
    // Pre-flight: resolve commune name (fix misspellings only)
    const resolvedN = await resolveCommune(baseUrl, headers, noestBody.wilaya_id, subs.shipping_city, cfg, 'noest');
    noestBody.commune = resolvedN || subs.shipping_city;
    // NOEST requires station_code on the body when stop_desk=1. Use the
    // hardcoded NOEST_STATIONS map (sourced from the official NOEST station
    // list) to look up the closest desk for the order's wilaya + commune.
    if (isStopdesk) {
      const code = pickNoestStation(noestBody.wilaya_id, noestBody.commune);
      if (code) {
        noestBody.station_code = code;
      } else {
        // No NOEST desk in this wilaya (e.g. 50, 54, 57) — downgrade to home
        // so the dispatch still succeeds.
        console.log(`[noest] no station for wilaya ${noestBody.wilaya_id} — falling back to home delivery.`);
        noestBody.stop_desk = 0;
      }
    }
    body = JSON.stringify(noestBody);
  } else if (carrier === 'ecotrack') {
    const ecoWilaya = parseInt(subs.wilaya_code) || 16;
    const resolvedE = await resolveCommune(baseUrl, headers, ecoWilaya, subs.shipping_city, cfg, 'ecotrack');
    const ecoBody = {
      reference: subs.order_id,
      nom_client: subs.customer_name,
      telephone: subs.customer_phone,
      telephone_2: '',
      adresse: subs.shipping_address,
      code_wilaya: ecoWilaya,
      commune: resolvedE || subs.shipping_city,
      montant: (subs.payment_method && subs.payment_method !== 'cod')
        ? (parseFloat(subs.shipping_cost) || 0)
        : (parseFloat(subs.total) || parseFloat(subs.subtotal) || 0),
      remarque: subs.notes || subs.product_list,
      produit: subs.product_list || 'Commande',
      stock: 0,
      quantite: String(subs.item_count),
      // EcoTrack canonical is `type_id`; some tenants (incl. DHD) read `type`.
      // Send both so the delivery type is never silently dropped.
      type_id: 1, // 1=Delivery, 2=Exchange, 3=Pickup
      type: 1,
      // Stop-desk flag. DHD/EcoTrack honour `stop_desk` (0/1); we also send the
      // boolean alias used by some tenants so a desk order is never downgraded
      // to home delivery just because of a field-name mismatch.
      stop_desk: isStopdesk ? 1 : 0,
      is_stopdesk: isStopdesk,
      // EcoTrack expects the weight under `poids`; keep `weight` for forks.
      poids: parseFloat(subs.weight) || 1,
      weight: subs.weight,
      can_open: 1,
      fragile: 0,
    };
    body = JSON.stringify(ecoBody);
  } else {
    let tpl = (cfg.api_create_body_template || '').trim();
    if (!tpl) {
      if (carrier === 'yalidine') {
        // Yalidine API: is_stopdesk is a JSON boolean (true/false). When true,
        // we also need to_center_id or stopdesk_id for newer Yalidine endpoints;
        // for the standard create endpoint, is_stopdesk alone is enough and
        // Yalidine routes to the closest desk in the destination commune.
        tpl = '[{"order_id":"{order_id}","firstname":"{customer_firstname}","familyname":"{customer_lastname}","contact_phone":"{customer_phone}","address":"{shipping_address}","to_commune_name":"{shipping_city}","to_wilaya_name":"{shipping_wilaya}","product_list":"{product_list}","price":{total},"do_insurance":false,"declared_value":{total},"freeshipping":false,"is_stopdesk":{is_stopdesk},"has_exchange":0,"product_to_collect":null}]';
      } else if (carrier === 'procolis') {
        // Procolis (ZR Express): TypeLivraison "0"=Domicile, "1"=Stop Desk.
        // Sent as JSON string, not int. is_stopdesk_int substitutes to "0"/"1".
        tpl = '{"Colis":[{"Tracking":"{order_id}","TypeLivraison":"{is_stopdesk_int}","TypeColis":"0","Confrimee":"","Client":"{customer_name}","MobileA":"{customer_phone}","MobileB":"","Adresse":"{shipping_address}","IDWilaya":"{wilaya_code}","Commune":"{shipping_city}","Total":"{total}","Note":"{notes}","TProduit":"{product_list}","id_Externe":"{order_id}","Source":""}]}';
      } else if (carrier === 'maystro') {
        // Maystro: their public API is primarily home-delivery focused, but
        // recent versions accept is_stopdesk / commune_id fields. We send the
        // boolean defensively; unknown fields are silently ignored by Maystro.
        tpl = '{"customer_name":"{customer_name}","customer_phone":"{customer_phone}","destination_text":"{shipping_address}","commune":"{shipping_city}","wilaya":"{shipping_wilaya}","product_price":{total},"products":[{"product_name":"{product_list}","quantity":{item_count},"product_id":""}],"display_id":"{order_id}","note_to_driver":"{notes}","express":false,"is_stopdesk":{is_stopdesk},"source":"api"}';
      }
    }
    if (tpl) {
      let filled = tpl;
      for (const [k, v] of Object.entries(subs)) {
        const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
        filled = filled.split('{' + k + '}').join(safe);
      }
      const headersIn = parseJson(cfg.api_headers);
      for (const [k, v] of Object.entries(headersIn)) {
        const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
        filled = filled.split('{' + k + '}').join(safe);
      }
      body = filled;
    } else {
      body = JSON.stringify(subs);
    }
  }

  // ── Build candidate URLs (primary + fallbacks) ──
  const buildUrl = (p) => {
    let u = baseUrl;
    if (p.startsWith('/api/')) { try { u = new URL(baseUrl).origin; } catch {} }
    u += p.startsWith('/') || p.startsWith('?') ? p : ('/' + p);
    u = applyQueryAuth(u, cfg);
    // EcoTrack (non-NOEST) expects api_token as query param
    const bHost = (() => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } })();
    if (carrier === 'ecotrack' && !/noest/.test(bHost) && cfg.api_key && !u.includes('api_token'))
      u += (u.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);
    return u;
  };

  const fallbacks = {
    noest: ['/api/public/create/order'],
    ecotrack: ['/create/order'],
    yalidine: ['/parcels/'],
    procolis: ['/add_colis'],
    maystro: ['/orders/'],
  };
  const allPaths = [path, ...(fallbacks[carrier] || []).filter(p => p !== path)];

  // ── Execute request with fallback ──
  const doPost = async (postBody) => {
    let r, txt = '', tried = [], finalUrl = '';
    for (const pp of allPaths) {
      const candidateUrl = buildUrl(pp);
      finalUrl = candidateUrl;
      console.log(`[carrierCreateOrder] ${carrier} → POST ${candidateUrl}`);
      r = await fetch(candidateUrl, { method: 'POST', headers, body: postBody, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      if ([301,302,303,307,308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (loc) {
          const redir = loc.startsWith('http') ? loc : new URL(loc, candidateUrl).href;
          console.log(`[carrierCreateOrder] ${carrier} redirect ${r.status} → ${redir} (re-POSTing)`);
          r = await fetch(redir, { method: 'POST', headers, body: postBody, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        }
      }
      txt = await r.text();
      tried.push({ url: candidateUrl, status: r.status, snippet: String(txt).slice(0, 200) });
      console.log(`[carrierCreateOrder] ${carrier} ← HTTP ${r.status} | ${String(txt).slice(0, 200)}`);
      if (r.status === 404 && (!txt.trim() || /^\s*\{\s*"message"\s*:\s*""\s*\}/.test(txt) || /not.?found|no.?route/i.test(txt))) continue;
      break;
    }
    return { r, txt, tried, finalUrl };
  };

  let r, txt = '', tried = [];
  let finalUrl = '';
  try {
    ({ r, txt, tried, finalUrl } = await doPost(body));

    // (Removed: after-failure commune auto-retry. The pre-flight resolver in
    // body builder already fetches & matches communes BEFORE the POST, with a
    // unified scoring/threshold. Duplicating it after-failure was confusing
    // and used a stricter threshold than the pre-flight, leading to misses.)

    // Auto-retry with home delivery ONLY if carrier explicitly says desk is
    // unavailable for this commune/wilaya. We do NOT downgrade on every
    // validation error that merely mentions stop_desk — otherwise desk orders
    // get silently converted to home delivery on minor field issues.
    // NOEST in particular rejects desk orders outright (the order is never
    // created) when the station_code is missing/invalid for the wilaya — so we
    // also match station_code errors here, not just "desk unavailable", to make
    // sure the parcel still gets sent (as home) instead of failing entirely.
    const deskRejected = /desk.*indisponible|desk.*disponible|desk.*not.?available|stop.?desk.*not.?available|stop.?desk.*invalid|aucun.*bureau|no.*stop.?desk|stop.?desk.*unavailable|bureau.*indispo|bureau.*ferm|station[_\s]?code|station.*(invalid|introuvable|requis|required|manquant)|desk.*requis/i.test(txt);
    if (r && (r.status === 422 || r.status === 400) && deskRejected) {
      try {
        {
          const parsed = JSON.parse(body);
          let changed = false;
          if (parsed.stop_desk === 1) { parsed.stop_desk = 0; changed = true; }
          if (parsed.is_stopdesk === true || parsed.is_stopdesk === 'true') { parsed.is_stopdesk = false; changed = true; }
          if (parsed.station_code) { delete parsed.station_code; changed = true; } // NOEST: drop station on home fallback
          if (Array.isArray(parsed) && parsed[0]?.is_stopdesk) { parsed[0].is_stopdesk = false; changed = true; }
          if (parsed.Colis?.[0]?.TypeLivraison === '1') { parsed.Colis[0].TypeLivraison = '0'; changed = true; }
          if (changed) {
            const retryBody = JSON.stringify(parsed);
            console.log(`[carrierCreateOrder] ${carrier} desk delivery rejected (${String(txt).slice(0,120)}), retrying with home delivery`);
            ({ r, txt, tried, finalUrl } = await doPost(retryBody));
            body = retryBody;
            isStopdesk = false; // reflect the actual delivery mode in the result
          }
        }
      } catch {}
    }

    if (!r) return { ok: false, err: 'No endpoint responded', tried };

    let data; try { data = JSON.parse(txt); } catch { data = null; }
    const sentBody = typeof body === 'string' ? body.slice(0, 300) : '';

    // ── Check for auth failures ──
    const blob = (txt || '').toLowerCase();
    const authFail = [
      'invalid token','invalid api','invalid key','invalid credentials',
      'unauthor','authentication failed','access denied','forbidden',
      'wrong token','token invalid','token expir',
      'clé invalide','jeton invalide','token invalide','non autorisé',
      'permission denied','not allowed','login required','jwt expired','bad token',
    ].find(k => blob.includes(k));
    if (authFail) return { ok: false, err: `Credentials rejected: "${authFail}"`, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };

    // ── Friendly translation for the common "commune wrong/disabled" case ──
    // EcoTrack/NOEST return "Commune mal écrite, ou désactivée" when the
    // commune name is wrong OR (more commonly) when the merchant hasn't
    // enabled that commune in their carrier dashboard. The pre-flight
    // resolver already tried to fix misspellings, so if we still get this
    // error the commune is almost certainly disabled in the carrier account.
    // Match BOTH "mal écrite/ecrite" and "désactiv/deactivat/disabled/inactive"
    // because EcoTrack mixes them in one message.
    const looksLikeCommuneError =
      /commune/i.test(txt) && /(d[ée]sactiv|deactivat|disabled|inactive|mal\s*[ée]crit|mispelled|misspelled|invalid\s+commune|wrong\s+commune)/i.test(txt);
    if (looksLikeCommuneError) {
      let parsedB = {};
      try { parsedB = JSON.parse(body); } catch {}
      const cn = parsedB.commune || parsedB.Colis?.[0]?.Commune || subs.shipping_city;
      const wn = subs.shipping_wilaya || ('wilaya ' + (parsedB.wilaya_id || parsedB.code_wilaya || subs.wilaya_code));
      const carrierLabel = carrier === 'noest' ? 'NOEST' : 'EcoTrack/DHD';
      const friendlyCommune = `Commune "${cn}" is not enabled for delivery in your ${carrierLabel} account for ${wn}. Open your ${carrierLabel} dashboard → Communes / Zones de livraison, enable "${cn}", or change the order's commune to one that's already enabled.`;
      return { ok: false, err: friendlyCommune, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };
    }

    // ── Check for explicit failure responses ──
    if (data && data.success === false && data.message) return { ok: false, err: data.message, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.error && typeof data.error === 'string') return { ok: false, err: data.error, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.errors && typeof data.errors === 'object') return { ok: false, err: JSON.stringify(data.errors).slice(0, 300), status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.success === false) return { ok: false, err: data.msg || data.detail || `Carrier rejected (HTTP ${r.status})`, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (!r.ok && r.status >= 400) return { ok: false, err: `HTTP ${r.status}: ${String(txt).slice(0, 200)}`, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };

    // ── Extract tracking number ──
    let tracking = '';

    // 1. Admin-configured path
    if (data && cfg.api_create_tracking_path) {
      let val = data;
      for (const p of cfg.api_create_tracking_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null && typeof val !== 'object') tracking = String(val);
    }

    // 2. Carrier-specific extraction
    if (!tracking && data) {
      if (carrier === 'yalidine') {
        const root = Array.isArray(data) ? data[0] : data;
        if (root && typeof root === 'object') {
          const first = Object.values(root)[0];
          if (first && typeof first === 'object') {
            if (first.success === false) return { ok: false, err: first.message || 'Yalidine rejected the parcel', status: r.status, carrier_response: data, request_url: finalUrl, tried };
            tracking = first.tracking || first.tracking_number || first.label || '';
          }
        }
      } else if (carrier === 'procolis') {
        const arr = data.Colis || data.colis || data;
        if (Array.isArray(arr) && arr[0]) tracking = arr[0].Tracking || arr[0].tracking || arr[0].code || '';
        if (!tracking && data.Tracking) tracking = data.Tracking;
      } else if (carrier === 'noest') {
        // NOEST returns {success:true, tracking:"ECS...", reference:"..."}
        tracking = data.tracking || data.tracking_number || '';
      } else if (carrier === 'ecotrack') {
        tracking = data.tracking || data.tracking_number || '';
        if (!tracking && data.data) tracking = data.data.tracking || data.data.tracking_number || data.data.code || '';
        if (!tracking && data.order) tracking = data.order.tracking || data.order.tracking_number || '';
      } else if (carrier === 'maystro') {
        tracking = data.display_id || data.tracking_id || data.id || '';
      }

      // 3. Generic fallback
      if (!tracking) {
        const pick = (obj) => obj && (obj.tracking || obj.tracking_number || obj.tracking_id || obj.code || obj.parcel_id || obj.shipment_id || '');
        tracking = pick(data) || pick(data?.data) || pick(data?.result) || pick(Array.isArray(data) ? data[0] : null) || '';
      }
    }

    if (tracking) {
      console.log(`[carrierCreateOrder] ${carrier} ✓ TN: ${tracking}`);
      return { ok: true, tracking_number: String(tracking), carrier_response: data || txt, status: r.status, request_url: finalUrl, request_body: sentBody, tried, delivery_mode: isStopdesk ? 'desk' : 'home', shipping_type_seen: order.shipping_type };
    }

    console.log(`[carrierCreateOrder] ${carrier} ✓ accepted (HTTP ${r.status}) — no tracking number in response, will resolve via sync`);
    return { ok: true, tracking_number: '', carrier_response: data || txt, status: r.status, request_url: finalUrl, request_body: sentBody, tried, delivery_mode: isStopdesk ? 'desk' : 'home', shipping_type_seen: order.shipping_type };
  } catch (e) {
    console.error(`[carrierCreateOrder] ${carrier} EXCEPTION:`, e.message);
    return { ok: false, err: e.message, request_url: finalUrl, tried };
  }
}

// Carrier-specific status path resolver. Used by tracking poller so the admin
// doesn't have to know each carrier's exact JSON tree.
function extractStatus(cfg, data) {
  const carrier = detectCarrier(cfg.api_base_url || '');
  const walk = (obj, path) => {
    let v = obj;
    for (const p of String(path).split('.')) { if (v == null) break; v = !isNaN(p) ? v[parseInt(p)] : v[p]; }
    return v;
  };
  const tryPaths = (obj, paths) => {
    for (const p of paths) {
      const v = walk(obj, p);
      if (v != null && typeof v !== 'object') return String(v);
    }
    return null;
  };
  const carrierPaths = {
    yalidine: ['last_status', 'data.0.last_status'],
    noest: ['activity.0.event', 'data.activity.0.event', 'OrderInfo.status', 'data.last_situation'],
    procolis: ['0.Situation', 'Colis.0.Situation'],
    ecotrack: ['data.activity.0.event', 'data.0.activity.0.event', 'data.last_situation', 'data.status', 'status', 'data.0.status'],
    maystro: ['list.0.status_display', 'list.0.status', 'data.status_display'],
    dhl: ['shipments.0.status.description', 'shipments.0.status.statusCode'],
    fedex: ['output.completeTrackResults.0.trackResults.0.latestStatusDetail.description'],
    ups: ['trackResponse.shipment.0.package.0.activity.0.status.description'],
    aramex: ['TrackingResults.0.Value.0.UpdateDescription'],
  };
  const fromCarrier = carrierPaths[carrier] ? tryPaths(data, carrierPaths[carrier]) : null;
  if (fromCarrier) return fromCarrier;
  if (cfg.api_status_path) {
    const v = walk(data, cfg.api_status_path);
    if (v != null && typeof v !== 'object') return String(v);
  }
  // Last-resort: any top-level "status" / "last_status" string.
  if (data && typeof data === 'object') {
    if (typeof data.last_status === 'string') return data.last_status;
    if (typeof data.status === 'string') return data.status;
    if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
      return data[0].last_status || data[0].Situation || data[0].status_display || data[0].status || null;
    }
  }
  return null;
}

// ─── carrierDeleteOrder ─────────────────────────────────────────────────────
// Best-effort cleanup of a test parcel created by the dispatch probe so the
// admin's real carrier account doesn't accumulate fake orders. Each carrier
// has its own delete/cancel endpoint shape; failure here is non-fatal.
async function carrierDeleteOrder(rawCfg, trackingNumber) {
  const cfg = normalizeConfig(rawCfg);
  if (!trackingNumber) return { ok: false, err: 'No tracking number' };
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(cfg) };
  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  let method = 'DELETE';
  let body;
  if (carrier === 'yalidine') {
    url += `/parcels/${encodeURIComponent(trackingNumber)}/`;
  } else if (carrier === 'noest') {
    // NOEST: POST /api/public/delete/order with {user_guid, tracking}
    const q = parseJson(cfg.api_query_params);
    url += '/api/public/delete/order';
    method = 'POST';
    body = JSON.stringify({ user_guid: q.user_guid || '', tracking: trackingNumber });
  } else if (carrier === 'ecotrack') {
    url += `/delete/order?tracking=${encodeURIComponent(trackingNumber)}`;
    if (cfg.api_key) url += '&api_token=' + encodeURIComponent(cfg.api_key);
    method = 'DELETE';
  } else if (carrier === 'procolis') {
    url += '/supprimer';
    method = 'POST';
    body = JSON.stringify({ Colis: [{ Tracking: trackingNumber }] });
  } else if (carrier === 'maystro') {
    url += `/orders/${encodeURIComponent(trackingNumber)}/`;
    method = 'DELETE';
  } else {
    return { ok: false, err: 'No delete endpoint for this carrier' };
  }
  url = applyQueryAuth(url, cfg);
  try {
    let r = await fetch(url, { method, headers, body, redirect: (method === 'POST' || method === 'DELETE') ? 'manual' : 'follow', signal: AbortSignal.timeout(10000) });
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (loc) {
        const redir = loc.startsWith('http') ? loc : new URL(loc, url).href;
        r = await fetch(redir, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      }
    }
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

module.exports = { carrierRequest, carrierCreateOrder, carrierDeleteOrder, detectCarrier, normalizeConfig, extractStatus, wilayaToCode };

// Store access + staff permissions, enforced on the server for every
// authenticated request (called from authMiddleware).
//
// 1. Store ownership: a request that names a store (:sid / :storeId in the
//    URL, or storeId / store_id in the body for the few routes that take it
//    there) only goes through if that store belongs to the caller. Before
//    this, any logged-in owner could read or change another store's data by
//    putting its id in the URL.
// 2. Staff: staff log in with a token that carries the owner's id plus
//    staff_id. Their store_staff row is re-read (briefly cached) on every
//    request, so disabling a member or changing their permissions applies
//    immediately — no waiting for the 30-day token to expire. Each store
//    route needs one of the permissions listed below; anything not listed is
//    denied to staff (owners are never limited by this).
const pool = require('../config/db');

const TTL = 20 * 1000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + TTL });
  if (cache.size > 5000) { for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k); }
  return val;
}
function forgetStaff() { for (const k of cache.keys()) if (k.startsWith('staff:') || k.startsWith('sstores:')) cache.delete(k); }

// Old role templates used different keys — map them onto the current ones.
const ALIASES = {
  view_dashboard: ['dashboard_view'], view_orders: ['orders_view'],
  manage_orders: ['orders_view', 'orders_edit', 'orders_confirm', 'orders_prepare'],
  view_products: ['products_view'], manage_products: ['products_view', 'products_edit', 'stock_manage'],
  view_customers: ['customers_view'], manage_customers: ['customers_view', 'customers_edit'],
  view_analytics: ['analytics_view', 'dashboard_view'], manage_settings: ['settings_view', 'settings_edit'],
  manage_staff: ['staff_manage', 'workers_view', 'workers_manage'], confirm_orders: ['orders_confirm'], prepare_orders: ['orders_prepare'],
  staff_manage: ['workers_view', 'workers_manage'], workers_manage: ['workers_view'], payroll_manage: ['payroll_view', 'payroll_pay'], payroll_pay: ['payroll_view'],
};
function normalizePerms(raw) {
  let p = raw;
  if (typeof p === 'string') { try { p = JSON.parse(p || '[]'); } catch { p = []; } }
  if (!Array.isArray(p)) p = [];
  const out = new Set();
  for (const k of p) { out.add(k); (ALIASES[k] || []).forEach(x => out.add(x)); }
  return out;
}

const ownsStore = (ownerId, sid) => cached(`own:${ownerId}:${sid}`, async () => {
  const r = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND owner_id=$2', [sid, ownerId]);
  return r.rows.length > 0;
});

// The staff member's own row (by staff_id) — used to know who they are.
const staffRow = (staffId) => cached(`staff:${staffId}`, async () => {
  let r;
  try { r = await pool.query('SELECT id,store_id,email,phone,username,is_active,permissions,status,session_version FROM store_staff WHERE id=$1', [staffId]); }
  catch { r = await pool.query('SELECT id,store_id,email,phone,is_active,permissions FROM store_staff WHERE id=$1', [staffId]); }
  return r.rows[0] || null;
});

// "Last seen" for the Workers page (written at most once a minute per worker).
const seen = new Map();
function touchSeen(staffId) {
  const now = Date.now();
  if ((seen.get(staffId) || 0) > now - 60000) return;
  seen.set(staffId, now);
  pool.query('UPDATE store_staff SET last_seen_at=NOW() WHERE id=$1', [staffId]).catch(() => {});
}

// The staff member's row for a given store: the same person can be on
// several of the owner's stores (one row per store, matched by email/phone).
const staffRowForStore = (staffId, sid) => cached(`staff:${staffId}:${sid}`, async () => {
  const me = await staffRow(staffId);
  if (!me) return null;
  if (String(me.store_id) === String(sid)) return me;
  let r = { rows: [] };
  if (me.email) r = await pool.query('SELECT id,store_id,is_active,permissions FROM store_staff WHERE store_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1', [sid, me.email]);
  if (!r.rows.length && me.username) r = await pool.query('SELECT id,store_id,is_active,permissions FROM store_staff WHERE store_id=$1 AND LOWER(username)=LOWER($2) LIMIT 1', [sid, me.username]).catch(() => ({ rows: [] }));
  if (!r.rows.length && me.phone) r = await pool.query('SELECT id,store_id,is_active,permissions FROM store_staff WHERE store_id=$1 AND phone=$2 LIMIT 1', [sid, me.phone]);
  return r.rows[0] || null;
});

// Every store this staff member is (still, actively) assigned to.
const staffStoreIds = (staffId, ownerId) => cached(`sstores:${staffId}:${ownerId}`, async () => {
  const me = await staffRow(staffId);
  if (!me || me.is_active === false) return [];
  const own = (await pool.query('SELECT id FROM stores WHERE owner_id=$1', [ownerId])).rows.map(s => s.id);
  if (!own.length) return [];
  let r = { rows: [] };
  if (me.email) r = await pool.query('SELECT store_id FROM store_staff WHERE LOWER(email)=LOWER($1) AND store_id=ANY($2::uuid[]) AND is_active IS NOT FALSE', [me.email, own]);
  if (!r.rows.length && me.phone) r = await pool.query('SELECT store_id FROM store_staff WHERE phone=$1 AND store_id=ANY($2::uuid[]) AND is_active IS NOT FALSE', [me.phone, own]);
  const ids = r.rows.map(x => String(x.store_id));
  if (!ids.length && own.map(String).includes(String(me.store_id))) ids.push(String(me.store_id));
  return [...new Set(ids)];
});

// ── Which permission each store route needs (staff only) ────────────────────
// [methods, path regex (router path, after /api/<area>), any-of permissions]
// First match wins. `null` permissions = any staff member may use it.
// `false` = never for staff (owner-only).
const ANY = null, OWNER = false;
const RULES = [
  // store itself
  ['GET', /^\/stores\/:sid$/, ANY],
  ['GET', /^\/stores\/:sid\/my-access$/, ANY],
  ['PUT', /^\/stores\/:sid$/, ['settings_edit', 'builder_edit', 'offers_manage', 'about_manage', 'content_manage']],
  ['DELETE|POST', /^\/stores\/:sid(\/cancel-deletion)?$/, OWNER],
  ['GET', /^\/stores\/:sid\/dashboard$/, ['dashboard_view', 'analytics_view', 'orders_view', 'products_view', 'customers_view', 'finances_view']],
  ['GET', /^\/stores\/:sid\/analytics$/, ['analytics_view']],
  ['*', /^\/stores\/:sid\/notifications/, ANY],
  ['*', /^\/stores\/:sid\/(staff|role-templates)/, ['staff_manage']],
  ['GET', /^\/stores\/:sid\/activity-log/, ['staff_manage']],
  ['*', /^\/stores\/:sid\/domains/, ['domains_manage']],
  ['GET', /^\/stores\/:sid\/apps$/, ['apps_view', 'settings_view']],
  ['POST', /^\/stores\/:sid\/apps\/install$/, ['settings_edit']],
  // orders
  ['GET', /^\/stores\/:sid\/orders(\/:oid)?$/, ['orders_view', 'orders_view_assigned']],
  ['GET', /^\/stores\/:sid\/orders-export$/, ['orders_view']],
  ['GET', /^\/stores\/:sid\/abandoned-carts$/, ['abandoned_view', 'orders_view']],
  ['GET', /^\/stores\/:sid\/orders\/:oid\/email-debug$/, ['orders_edit']],
  ['POST', /^\/stores\/:sid\/orders$/, ['orders_edit']],
  ['PATCH', /^\/stores\/:sid\/orders\/:oid\/status$/, ['orders_edit', 'orders_confirm', 'orders_prepare']],
  // workers & payroll (routes/workers.js)
  ['GET', /^\/stores\/:sid\/me$/, ANY],
  ['POST', /^\/stores\/:sid\/orders\/:oid\/log-action$/, ANY],
  ['GET', /^\/stores\/:sid\/orders\/:oid\/timeline$/, ['orders_view', 'orders_view_assigned']],
  ['POST', /^\/stores\/:sid\/orders\/assign$/, ['orders_assign']],
  ['*', /^\/stores\/:sid\/orders\/auto-assign(\/settings)?$/, ['orders_assign']],
  ['GET', /^\/stores\/:sid\/assignable-workers$/, ['orders_assign', 'workers_view', 'workers_manage', 'staff_manage']],
  ['GET', /^\/stores\/:sid\/(workers(\/:wid)?|job-types|worker-roles)$/, ['workers_view', 'workers_manage', 'staff_manage']],
  ['PUT', /^\/stores\/:sid\/workers\/:wid\/compensation$/, ['workers_manage', 'staff_manage', 'payroll_manage']],
  ['*', /^\/stores\/:sid\/(workers|job-types|worker-roles)/, ['workers_manage', 'staff_manage']],
  ['GET', /^\/stores\/:sid\/(performance|worker-activity)$/, ['workers_view', 'workers_manage', 'staff_manage']],
  ['GET', /^\/stores\/:sid\/payroll/, ['payroll_view', 'payroll_manage', 'payroll_pay']],
  ['POST', /^\/stores\/:sid\/payroll\/items\/:iid\/pay$/, ['payroll_pay', 'payroll_manage']],
  ['*', /^\/stores\/:sid\/payroll/, ['payroll_manage']],
  ['POST', /^\/stores\/:sid\/orders\/:oid\/dispatch$/, ['orders_edit', 'orders_prepare']],
  ['PATCH', /^\/stores\/:sid\/orders\/:oid(\/(payment|tracking|archive|restore))?$/, ['orders_edit']],
  ['PATCH', /^\/stores\/:sid\/orders\/bulk-archive$/, ['orders_edit']],
  ['POST', /^\/stores\/:sid\/orders\/:oid\/send-email$/, ['orders_edit']],
  ['DELETE', /^\/stores\/:sid\/orders\/:oid(\/purge)?$/, ['orders_delete']],
  ['POST', /^\/stores\/:sid\/orders\/bulk-delete$/, ['orders_delete']],
  ['GET', /^\/stores\/:sid\/(tracking-orders|track\/:trackingNumber)$/, ['tracking_view', 'orders_view']],
  ['GET', /^\/stores\/:sid\/status-templates$/, ['orders_view', 'settings_view']],
  ['PUT', /^\/stores\/:sid\/status-templates$/, ['settings_edit']],
  // customers
  ['GET', /^\/stores\/:sid\/customers(\/:cid\/orders)?$/, ['customers_view']],
  ['POST', /^\/stores\/:sid\/customers$/, ['customers_edit']],
  ['GET', /^\/stores\/:sid\/blacklist$/, ['customers_blacklist', 'customers_view']],
  ['*', /^\/stores\/:sid\/blacklist/, ['customers_blacklist']],
  // products
  ['GET', /^\/stores\/:sid\/(products|categories)$/, ['products_view', 'products_edit', 'stock_manage', 'orders_edit', 'offers_manage']],
  ['POST', /^\/stores\/:sid\/products$/, ['products_edit']],
  ['PUT', /^\/stores\/:sid\/products\/:pid$/, ['products_edit']],
  ['DELETE', /^\/stores\/:sid\/products\/:pid$/, ['products_delete']],
  ['PATCH', /^\/stores\/:sid\/products\/:pid\/stock$/, ['stock_manage', 'products_edit']],
  ['POST', /^\/stores\/:sid\/categories$/, ['products_edit']],
  ['*', /^\/stores\/:sid\/reviews/, ['reviews_manage']],
  // shipping
  ['GET', /^\/stores\/:sid\/(shipping-wilayas|delivery-companies)$/, ['shipping_manage', 'shipping_partners', 'orders_view', 'tracking_view']],
  ['*', /^\/stores\/:sid\/shipping-wilayas/, ['shipping_manage']],
  ['POST', /^\/stores\/:sid\/delivery-companies\/:did\/(refresh-tracking|sync)$/, ['shipping_partners', 'orders_edit', 'tracking_view']],
  ['*', /^\/stores\/:sid\/delivery-companies/, ['shipping_partners']],
  // money & content
  ['GET', /^\/stores\/:sid\/expenses$/, ['finances_view']],
  ['*', /^\/stores\/:sid\/expenses/, ['finances_edit']],
  ['*', /^\/stores\/:sid\/pages/, ['content_manage']],
  ['PUT', /^\/stores\/:sid\/faqs$/, ['faqs_manage', 'content_manage']],
  // payments (receipts) and messaging
  ['GET', /^\/receipts\/:sid$/, ['orders_view']],
  ['GET', /^\/(wa\/:storeId\/(recent|stats)|whatsapp-qr\/(status|log)\/:storeId)$/, ['settings_view']],
  ['POST', /^\/(whatsapp-qr\/(start|disconnect|send)|email\/:storeId\/send-test)$/, ['settings_edit']],
  ['POST', /^\/cart-recovery\/send$/, ['abandoned_view', 'orders_edit']],
  ['POST', /^\/notify\/order$/, ['orders_edit']],
];
// Owner-account routes (no store in the URL) that a staff token must never
// reach: they act on the owner's own account, billing or store list.
const OWNER_ACCOUNT = [
  ['PUT', /^\/(profile|username|email|password|two-fa)$/],
  ['POST', /^\/(password\/request-2fa|two-fa\/request-2fa|subscription\/pay|stores)$/],
  ['DELETE', /^\/account$/],
];

function ruleFor(method, path) {
  for (const [m, re, perms] of RULES) {
    if ((m === '*' || m.split('|').includes(method)) && re.test(path)) return { perms };
  }
  return null;
}

// Main check. Returns null when allowed, or { status, error } to refuse.
async function checkAccess(req, opts = {}) {
  const u = req.user || {};
  if (u.role === 'platform_admin') return null;
  const isStaffToken = !!u.staff_id || u.role === 'store_staff';
  const staffId = u.staff_id || (u.role === 'store_staff' ? u.id : null);
  const path = req.route?.path || '';
  const method = req.method;

  // Staff: their account must still exist and be active.
  if (isStaffToken) {
    const me = await staffRow(staffId);
    if (!me || me.is_active === false || ['inactive', 'suspended', 'pending'].includes(me.status)) return { status: 401, error: 'Your staff account has been disabled. Contact your store admin.', code: 'STAFF_DISABLED' };
    // Password change, reset or "log out everywhere" bump session_version:
    // tokens issued before that stop working.
    if (me.session_version != null && (parseInt(u.sv) || 0) !== (parseInt(me.session_version) || 0)) return { status: 401, error: 'Your session has ended. Please log in again.', code: 'STAFF_DISABLED' };
    touchSeen(staffId);
    for (const [m, re] of OWNER_ACCOUNT) if (m === method && re.test(path)) return { status: 403, error: 'Only the store owner can do this.' };
  }

  // Which store does this request act on?
  const sid = req.params?.sid || req.params?.storeId || (opts.bodyStore ? (req.body?.storeId || req.body?.store_id) : null);
  if (!sid) return null;
  if (!/^[0-9a-f-]{36}$/i.test(String(sid))) return { status: 400, error: 'Invalid store id' };

  if (!isStaffToken) {
    if (u.role !== 'store_owner') return null; // customers etc. are limited by the route's own role list
    return (await ownsStore(u.id, sid)) ? null : { status: 403, error: 'You do not have access to this store.' };
  }

  // Staff: the store must be one they are assigned to, under their owner.
  if (u.role === 'store_staff') {
    if (String(u.storeId) !== String(sid)) return { status: 403, error: 'You do not have access to this store.' };
  } else if (!(await ownsStore(u.id, sid))) {
    return { status: 403, error: 'You do not have access to this store.' };
  }
  const row = await staffRowForStore(staffId, sid);
  if (!row || row.is_active === false) return { status: 403, error: 'You are not a member of this store.' };
  const perms = normalizePerms(row.permissions);
  req.staffPerms = perms;
  req.staffRowId = row.id;
  const rule = ruleFor(method, path);
  if (!rule) return { status: 403, error: 'Your role does not allow this action.' };
  if (rule.perms === OWNER) return { status: 403, error: 'Only the store owner can do this.' };
  if (rule.perms === ANY) return null;
  if (rule.perms.some(p => perms.has(p))) {
    // Saving store settings without "Edit Store Settings": only the fields
    // that belong to what they may manage (landing pages, offers, about page).
    if (method === 'PUT' && path === '/stores/:sid' && !perms.has('settings_edit')) {
      const allowed = (k) => (perms.has('builder_edit') && /^(landing_|builder|home_|page_builder)/.test(k))
        || (perms.has('offers_manage') && /^(store_coupon|offer|quantity_offer|coupon)/.test(k))
        || ((perms.has('about_manage') || perms.has('content_manage')) && /^(about_|faq)/.test(k));
      const bad = Object.keys(req.body || {}).filter(k => !allowed(k));
      if (bad.length) return { status: 403, error: 'Your role does not allow changing these settings: ' + bad.slice(0, 5).join(', ') };
    }
    return null;
  }
  return { status: 403, error: 'Your role does not allow this action.', missing: rule.perms };
}

module.exports = { checkAccess, ruleFor, normalizePerms, staffRow, staffRowForStore, staffStoreIds, ownsStore, forgetStaff };

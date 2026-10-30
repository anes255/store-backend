// Workers & payroll API — mounted at /api/workers.
//
// A worker is a store_staff row (one per store they work in). Store-scoped
// routes go through authMiddleware, which checks the store belongs to the
// caller and, for staff, the permission each route needs (staffAccess.js).
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');
const { ensureWorkersSchema } = require('../config/workersSchema');
const { forgetStaff, normalizePerms } = require('../middleware/staffAccess');
const { recordOrderAction } = require('../services/workerActions');

const auth = authMiddleware(['store_owner']);
router.use(async (req, res, next) => { try { await ensureWorkersSchema(); } catch {} next(); });

const CURRENCIES = ['DZD', 'USD', 'EUR'];
const RULE_TYPES = { fixed_monthly: null, per_confirmed: 'confirmed', per_prepared: 'prepared', per_completed: 'completed', per_shipped: 'shipped' };
const PAID_ACTIONS = ['confirmed', 'prepared', 'completed', 'shipped'];
const STATUSES = ['active', 'inactive', 'suspended', 'pending'];

const DEFAULT_JOBS = ['Order Confirmer', 'Order Preparer', 'Customer Support', 'Sales', 'Accountant', 'Stock Manager', 'Delivery Manager', 'Manager'];
const DEFAULT_ROLES = [
  { key: 'confirmer', name: 'Confirmation Staff', description: 'Confirm orders and call customers', permissions: ['dashboard_view', 'orders_view_assigned', 'orders_confirm', 'tracking_view'] },
  { key: 'preparer', name: 'Preparation Staff', description: 'Prepare orders and check stock', permissions: ['dashboard_view', 'orders_view_assigned', 'orders_prepare', 'products_view'] },
  { key: 'support', name: 'Support Staff', description: 'Help customers and follow orders', permissions: ['dashboard_view', 'orders_view', 'customers_view', 'customers_edit', 'tracking_view'] },
  { key: 'sales', name: 'Sales Staff', description: 'Create and follow orders', permissions: ['dashboard_view', 'orders_view', 'orders_edit', 'products_view', 'customers_view', 'analytics_view'] },
  { key: 'finance', name: 'Finance Staff', description: 'Costs, analytics and payroll', permissions: ['dashboard_view', 'analytics_view', 'finances_view', 'finances_edit', 'taxes_view', 'payroll_view', 'orders_view'] },
  { key: 'inventory', name: 'Inventory Staff', description: 'Products and stock', permissions: ['dashboard_view', 'products_view', 'products_edit', 'stock_manage'] },
  { key: 'delivery', name: 'Delivery Staff', description: 'Shipping and tracking', permissions: ['dashboard_view', 'orders_view', 'orders_prepare', 'tracking_view', 'shipping_manage', 'shipping_partners'] },
  { key: 'manager', name: 'Manager', description: 'Day-to-day store operations', permissions: ['dashboard_view', 'analytics_view', 'orders_view', 'orders_edit', 'orders_confirm', 'orders_prepare', 'orders_assign', 'products_view', 'products_edit', 'stock_manage', 'customers_view', 'customers_edit', 'tracking_view', 'workers_view', 'payroll_view'] },
];

// ── helpers ────────────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const clean = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const money = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
const fullName = (w) => [w.first_name, w.last_name].filter(Boolean).join(' ') || w.name || '';
const actorId = (req) => req.user?.staff_id || req.user?.id || null;
const originOf = (req) => (process.env.FRONTEND_URL || req.get('origin') || '').replace(/\/$/, '');
const randomPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const b = crypto.randomBytes(14);
  let p = ''; for (let i = 0; i < 12; i++) p += chars[b[i] % chars.length];
  return p;
};
const strongEnough = (p) => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
const parsePerms = (p) => { try { const v = typeof p === 'string' ? JSON.parse(p || '[]') : p; return Array.isArray(v) ? v : []; } catch { return []; } };

async function audit(storeId, req, action, targetType, targetId, details) {
  try {
    await pool.query(
      'INSERT INTO staff_activity_log(store_id, actor_id, actor_name, actor_role, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [storeId, actorId(req), req.user?.name || null, req.user?.staff_id ? (req.user?.staff_role_label || 'Staff') : 'Owner', action, targetType || null, targetId ? String(targetId) : null, details ? JSON.stringify(details) : null]
    );
  } catch (e) { console.log('[workers audit]', e.message); }
}

function thisMonth() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Algiers' }));
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// All rows of the same person under the same owner (one per store).
async function siblingRows(row, ownerId) {
  const r = await pool.query(
    `SELECT s.id, s.store_id FROM store_staff s JOIN stores st ON st.id=s.store_id
     WHERE st.owner_id=$1 AND (s.id=$2 OR ($3::text IS NOT NULL AND LOWER(s.email)=LOWER($3)) OR ($4::text IS NOT NULL AND LOWER(s.username)=LOWER($4)))`,
    [ownerId, row.id, row.email || null, row.username || null]
  );
  return r.rows;
}

async function storeCfg(sid) {
  const r = await pool.query('SELECT config FROM stores WHERE id=$1', [sid]);
  let c = r.rows[0]?.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  return c;
}
async function saveStoreCfg(sid, cfg) { await pool.query('UPDATE stores SET config=$1 WHERE id=$2', [JSON.stringify(cfg), sid]); }

// Roles live in store.config.role_templates (shared with the older staff
// page). The default roles are added once per store.
async function loadRoles(sid) {
  const cfg = await storeCfg(sid);
  let list = Array.isArray(cfg.role_templates) ? cfg.role_templates : [];
  if (!cfg.worker_roles_seeded) {
    const have = new Set(list.map((r) => String(r.name || '').toLowerCase()));
    DEFAULT_ROLES.forEach((d, i) => { if (!have.has(d.name.toLowerCase())) list.push({ id: 'st_def_' + d.key + '_' + Date.now() + i, name: d.name, description: d.description, permissions: d.permissions, scope: 'store', is_default: true }); });
    cfg.role_templates = list; cfg.worker_roles_seeded = true;
    try { await saveStoreCfg(sid, cfg); } catch {}
  }
  return list;
}

async function loadJobTypes(sid) {
  let r = await pool.query('SELECT id,name,is_default FROM worker_job_types WHERE store_id=$1 ORDER BY is_default DESC, name', [sid]);
  if (!r.rows.length) {
    for (const n of DEFAULT_JOBS) { try { await pool.query('INSERT INTO worker_job_types(store_id,name,is_default) VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING', [sid, n]); } catch {} }
    r = await pool.query('SELECT id,name,is_default FROM worker_job_types WHERE store_id=$1 ORDER BY is_default DESC, name', [sid]);
  }
  return r.rows;
}

// Earnings for a month, computed from the rules and the recorded actions.
// Returns { [staffId]: { [currency]: { fixed, commission, lines:[...] } } }.
async function computeEarnings(sid, year, month, staffIds = null) {
  const rules = (await pool.query(
    `SELECT * FROM worker_compensation_rules WHERE store_id=$1 AND is_active=TRUE ${staffIds ? 'AND staff_id = ANY($2::uuid[])' : ''} ORDER BY created_at`,
    staffIds ? [sid, staffIds] : [sid]
  )).rows;
  const counts = (await pool.query(
    `SELECT staff_id, action, COUNT(*)::int AS n FROM worker_order_actions
     WHERE store_id=$1 AND staff_id IS NOT NULL AND action = ANY($4::text[])
       AND created_at >= make_timestamptz($2,$3,1,0,0,0,'Africa/Algiers')
       AND created_at <  make_timestamptz($2,$3,1,0,0,0,'Africa/Algiers') + INTERVAL '1 month'
     GROUP BY staff_id, action`,
    [sid, year, month, PAID_ACTIONS]
  )).rows;
  const cnt = {}; counts.forEach((c) => { (cnt[c.staff_id] = cnt[c.staff_id] || {})[c.action] = c.n; });
  const out = {};
  for (const r of rules) {
    const cur = CURRENCIES.includes(r.currency) ? r.currency : 'DZD';
    const slot = ((out[r.staff_id] = out[r.staff_id] || {})[cur] = out[r.staff_id][cur] || { fixed: 0, commission: 0, lines: [] });
    const amount = parseFloat(r.amount) || 0;
    if (r.rule_type === 'fixed_monthly') {
      slot.fixed += amount;
      slot.lines.push({ rule_id: r.id, type: r.rule_type, label: r.label, rate: amount, count: 1, amount, currency: cur });
    } else {
      const action = RULE_TYPES[r.rule_type];
      const n = action ? (cnt[r.staff_id]?.[action] || 0) : 0;
      slot.commission += n * amount;
      slot.lines.push({ rule_id: r.id, type: r.rule_type, action, label: r.label, rate: amount, count: n, amount: money(n * amount), currency: cur });
    }
  }
  return { earnings: out, counts: cnt };
}

// ── PUBLIC: worker login / password setup ─────────────────────────────────
async function findByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return [];
  const r = await pool.query(
    `SELECT s.*, st.owner_id, st.store_name, st.slug FROM store_staff s JOIN stores st ON st.id=s.store_id
     WHERE LOWER(s.username)=LOWER($1) OR LOWER(s.email)=LOWER($1) OR s.phone=$1
     ORDER BY (s.status='active') DESC, s.created_at`,
    [id]
  );
  return r.rows;
}

async function loginHistory(row, identifier, success, reason, req) {
  try {
    await pool.query('INSERT INTO worker_login_history(staff_id,store_id,identifier,success,reason,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [row?.id || null, row?.store_id || null, String(identifier || '').slice(0, 200), success, reason || null, (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 300)]);
  } catch {}
}

async function buildSession(row, remember) {
  const sib = await siblingRows(row, row.owner_id);
  const ids = sib.map((s) => s.id);
  const stores = (await pool.query(
    `SELECT st.* FROM stores st JOIN store_staff s ON s.store_id=st.id WHERE s.id = ANY($1::uuid[]) AND s.is_active IS NOT FALSE`, [ids]
  )).rows;
  const perms = parsePerms(row.permissions);
  const roleLabel = row.role && !/^(tpl_|st_)/.test(row.role) ? row.role : null;
  const name = fullName(row);
  const token = generateToken({
    id: row.owner_id, role: 'store_owner', name, staff_id: row.id, staff_role: row.role, staff_role_label: roleLabel || row.job_type || 'Staff',
    permissions: perms, scoped_store_id: row.store_id, scoped_store_ids: stores.map((s) => s.id), sv: row.session_version || 0,
  }, remember ? '30d' : '12h');
  return {
    token,
    owner: { id: row.owner_id, name, email: row.email, phone: row.phone, is_staff: true, staff_id: row.id, staff_role: row.role, staff_role_label: roleLabel || row.job_type || 'Staff', job_type: row.job_type, avatar: row.avatar, permissions: perms, scoped_store_id: row.store_id, language: row.language },
    stores: stores.map((s) => ({ ...(s.config || {}), ...s, name: s.store_name, is_live: s.is_published, logo: s.logo_url })),
  };
}

router.post('/login', async (req, res) => {
  try {
    const { identifier, password, remember } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your email or username and password' });
    const rows = await findByIdentifier(identifier);
    const row = rows[0];
    if (!row) { await loginHistory(null, identifier, false, 'unknown', req); return res.status(401).json({ error: 'Wrong email/username or password' }); }
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(row.locked_until) - Date.now()) / 60000);
      await loginHistory(row, identifier, false, 'locked', req);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} min.`, code: 'LOCKED' });
    }
    const ok = await bcrypt.compare(String(password), row.password_hash || '');
    if (!ok) {
      const fails = (row.failed_logins || 0) + 1;
      await pool.query(`UPDATE store_staff SET failed_logins=$1, locked_until=${fails >= 5 ? "NOW() + INTERVAL '15 minutes'" : 'locked_until'} WHERE id=$2`, [fails >= 5 ? 0 : fails, row.id]);
      await loginHistory(row, identifier, false, 'wrong_password', req);
      return res.status(401).json({ error: 'Wrong email/username or password' });
    }
    if (row.status === 'pending') { await loginHistory(row, identifier, false, 'pending', req); return res.status(403).json({ error: 'Finish setting your password from your invitation link first.', code: 'PENDING' }); }
    if (row.status === 'suspended' || row.status === 'inactive' || row.is_active === false) {
      await loginHistory(row, identifier, false, row.status || 'inactive', req);
      return res.status(403).json({ error: row.status === 'suspended' ? 'Your account is suspended. Contact your store admin.' : 'Your account is disabled. Contact your store admin.', code: 'STAFF_DISABLED' });
    }
    await pool.query('UPDATE store_staff SET failed_logins=0, locked_until=NULL, last_login_at=NOW(), last_seen_at=NOW() WHERE id=$1', [row.id]);
    await loginHistory(row, identifier, true, null, req);
    try { await pool.query("INSERT INTO staff_activity_log(store_id,actor_id,actor_name,actor_role,action,target_type,target_id) VALUES($1,$2,$3,'Staff','worker_login','worker',$2)", [row.store_id, row.id, fullName(row)]); } catch {}
    res.json(await buildSession(row, !!remember));
  } catch (e) { console.error('[worker login]', e.message); res.status(500).json({ error: 'Login failed' }); }
});

async function createToken(row, kind, hours) {
  const raw = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO worker_tokens(staff_id,store_id,kind,token_hash,expires_at) VALUES($1,$2,$3,$4,NOW() + ($5 || ' hours')::interval)`, [row.id, row.store_id, kind, sha(raw), String(hours)]);
  return raw;
}

// Invitation / reset messages in the worker's language (their own setting,
// else the store's default language, else English).
const LINK_MSG = {
  en: {
    inviteSubject: (st) => `Welcome to ${st} on MarketDz`, resetSubject: () => 'Reset your MarketDz worker password',
    invite: (st, role, login, link) => `Welcome to MarketDz!
\n
\nStore: ${st}
\nRole: ${role}
\nLogin: ${login}
\n
\nSet your password and log in: ${link}
\n
\nThis link expires in 7 days.`,
    reset: (st, link) => `A password reset was requested for your worker account at ${st}.
\n
\nSet a new password: ${link}
\n
\nThis link expires in 1 hour. If you did not ask for this, ignore this message.`,
    inviteBtn: 'Set Password &amp; Login', resetBtn: 'Set a new password', staff: 'Staff',
  },
  fr: {
    inviteSubject: (st) => `Bienvenue chez ${st} sur MarketDz`, resetSubject: () => 'Réinitialisez votre mot de passe MarketDz',
    invite: (st, role, login, link) => `Bienvenue sur MarketDz !
\n
\nBoutique : ${st}
\nRôle : ${role}
\nIdentifiant : ${login}
\n
\nDéfinissez votre mot de passe et connectez-vous : ${link}
\n
\nCe lien expire dans 7 jours.`,
    reset: (st, link) => `Une réinitialisation du mot de passe a été demandée pour votre compte chez ${st}.
\n
\nDéfinissez un nouveau mot de passe : ${link}
\n
\nCe lien expire dans 1 heure. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.`,
    inviteBtn: 'Définir le mot de passe et se connecter', resetBtn: 'Définir un nouveau mot de passe', staff: 'Équipe',
  },
  ar: {
    inviteSubject: (st) => `مرحبًا بك في ${st} على MarketDz`, resetSubject: () => 'إعادة تعيين كلمة مرور حسابك على MarketDz',
    invite: (st, role, login, link) => `مرحبًا بك في MarketDz!
\n
\nالمتجر: ${st}
\nالدور: ${role}
\nاسم الدخول: ${login}
\n
\nعيّن كلمة المرور وسجّل الدخول: ${link}
\n
\nينتهي هذا الرابط خلال 7 أيام.`,
    reset: (st, link) => `تم طلب إعادة تعيين كلمة المرور لحسابك في ${st}.
\n
\nعيّن كلمة مرور جديدة: ${link}
\n
\nينتهي هذا الرابط خلال ساعة واحدة. إذا لم تطلب ذلك فتجاهل هذه الرسالة.`,
    inviteBtn: 'تعيين كلمة المرور وتسجيل الدخول', resetBtn: 'تعيين كلمة مرور جديدة', staff: 'موظف',
  },
};
async function linkLanguage(row) {
  if (['en', 'fr', 'ar'].includes(row.language)) return row.language;
  try {
    let cfg = (await pool.query('SELECT config FROM stores WHERE id=$1', [row.store_id])).rows[0]?.config || {};
    if (typeof cfg === 'string') cfg = JSON.parse(cfg);
    if (['en', 'fr', 'ar'].includes(cfg.default_language)) return cfg.default_language;
  } catch {}
  return 'en';
}

async function sendLink(row, storeName, link, kind) {
  const sent = [];
  const lng = await linkLanguage(row); const M = LINK_MSG[lng];
  const subject = kind === 'invite' ? M.inviteSubject(storeName) : M.resetSubject();
  const role = row.role && !/^(tpl_|st_)/.test(row.role) ? row.role : (row.job_type || M.staff);
  const text = kind === 'invite' ? M.invite(storeName, role, row.username || row.email, link) : M.reset(storeName, link);
  if (row.email) {
    try {
      const { sendEmail } = require('../services/messaging');
      const html = `<div dir="${lng === 'ar' ? 'rtl' : 'ltr'}" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="color:#f97316">MarketDz</h2><p>${text.split('\n\n')[0]}</p><p style="white-space:pre-line">${text.split('\n\n').slice(1, -2).join('\n')}</p><p><a href="${link}" style="display:inline-block;background:#f97316;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">${kind === 'invite' ? M.inviteBtn : M.resetBtn}</a></p><p style="color:#888;font-size:12px">${text.split('\n\n').slice(-1)[0]}</p></div>`;
      const r = await sendEmail({ to: row.email, subject, html, text });
      if (r?.success) sent.push('email');
    } catch {}
  }
  if (row.phone) {
    try {
      const wa = require('../services/whatsappBaileys');
      const st = wa.getStatus ? wa.getStatus(row.store_id) : null;
      if (st?.connected) { const r = await wa.sendMessage(row.store_id, row.phone, text); if (r?.success) sent.push('whatsapp'); }
    } catch {}
  }
  return sent;
}

router.post('/forgot-password', async (req, res) => {
  const generic = { ok: true, message: 'If an account exists, a reset link has been sent to its email or WhatsApp.' };
  try {
    const rows = await findByIdentifier(req.body?.identifier);
    const row = rows[0];
    if (!row || row.status === 'suspended' || row.status === 'inactive') return res.json(generic);
    // at most one reset every 2 minutes per worker
    const recent = await pool.query("SELECT 1 FROM worker_tokens WHERE staff_id=$1 AND kind='reset' AND created_at > NOW() - INTERVAL '2 minutes'", [row.id]);
    if (recent.rows.length) return res.json(generic);
    const raw = await createToken(row, 'reset', 1);
    const sent = await sendLink(row, row.store_name, `${originOf(req)}/worker/reset?token=${raw}`, 'reset');
    if (!sent.length) console.log('[worker forgot] no channel to reach', row.id);
    res.json(generic);
  } catch (e) { console.error('[worker forgot]', e.message); res.json(generic); }
});

async function tokenRow(raw) {
  if (!raw || String(raw).length < 32) return null;
  const r = await pool.query(
    `SELECT t.*, s.first_name, s.last_name, s.name, s.username, s.email, s.role, s.job_type, s.status, st.store_name, st.owner_id
     FROM worker_tokens t JOIN store_staff s ON s.id=t.staff_id JOIN stores st ON st.id=t.store_id
     WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at > NOW()`, [sha(raw)]);
  return r.rows[0] || null;
}

router.get('/token-info', async (req, res) => {
  try {
    const t = await tokenRow(req.query.token);
    if (!t) return res.status(404).json({ error: 'This link is invalid or has expired. Ask your store admin for a new one.' });
    res.json({ kind: t.kind, name: fullName(t), store: t.store_name, role: t.role && !/^(tpl_|st_)/.test(t.role) ? t.role : t.job_type, login: t.username || t.email });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!strongEnough(password)) return res.status(400).json({ error: 'Use at least 8 characters with letters and numbers.' });
    const t = await tokenRow(token);
    if (!t) return res.status(404).json({ error: 'This link is invalid or has expired. Ask your store admin for a new one.' });
    const row = (await pool.query('SELECT * FROM store_staff WHERE id=$1', [t.staff_id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found' });
    if (row.status === 'suspended' || row.status === 'inactive') return res.status(403).json({ error: 'Your account is disabled. Contact your store admin.' });
    const hash = await bcrypt.hash(String(password), 12);
    const sib = await siblingRows(row, t.owner_id);
    const ids = sib.map((s) => s.id);
    // New password everywhere, end every open session, activate pending accounts.
    await pool.query(
      `UPDATE store_staff SET password_hash=$1, session_version=COALESCE(session_version,0)+1, failed_logins=0, locked_until=NULL,
         status=CASE WHEN status='pending' THEN 'active' ELSE status END,
         is_active=CASE WHEN status='pending' THEN TRUE ELSE is_active END, updated_at=NOW()
       WHERE id = ANY($2::uuid[])`, [hash, ids]);
    await pool.query("UPDATE worker_tokens SET used_at=NOW() WHERE staff_id = ANY($1::uuid[]) AND used_at IS NULL", [ids]);
    forgetStaff();
    try { await pool.query("INSERT INTO staff_activity_log(store_id,actor_id,actor_name,actor_role,action,target_type,target_id) VALUES($1,$2,$3,'Staff',$4,'worker',$2)", [row.store_id, row.id, fullName(row), t.kind === 'invite' ? 'worker_invite_accepted' : 'worker_password_reset']); } catch {}
    res.json({ ok: true, login: row.username || row.email });
  } catch (e) { console.error('[worker reset]', e.message); res.status(500).json({ error: 'Failed' }); }
});

// ── SELF-SERVICE (the logged-in worker) ────────────────────────────────────
router.get('/stores/:sid/me', auth, async (req, res) => {
  try {
    if (!req.user.staff_id) return res.json({ is_staff: false });
    const wid = req.staffRowId;
    const row = (await pool.query('SELECT id,name,first_name,last_name,email,phone,username,avatar,job_type,role,status,last_login_at,language,store_id FROM store_staff WHERE id=$1', [wid])).rows[0];
    const { year, month } = thisMonth();
    const { earnings } = await computeEarnings(req.params.sid, year, month, [wid]);
    const c = (await pool.query(
      `SELECT action,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers')::int AS today,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week,
         COUNT(*) FILTER (WHERE created_at >= make_timestamptz($3,$4,1,0,0,0,'Africa/Algiers'))::int AS month
       FROM worker_order_actions WHERE store_id=$1 AND staff_id=$2 AND created_at >= NOW() - INTERVAL '62 days' GROUP BY action`,
      [req.params.sid, wid, year, month])).rows;
    const counts = {}; c.forEach((x) => { counts[x.action] = x; });
    const assigned = (await pool.query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('new_order','pending') OR status IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE assigned_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers')::int AS today
       FROM orders WHERE store_id=$1 AND assigned_staff_id=$2 AND (is_deleted IS NULL OR is_deleted=FALSE)`, [req.params.sid, wid])).rows[0];
    const recent = (await pool.query(
      'SELECT order_id, order_number, action, new_status, created_at FROM worker_order_actions WHERE store_id=$1 AND staff_id=$2 ORDER BY created_at DESC LIMIT 15', [req.params.sid, wid])).rows;
    const payroll = (await pool.query(
      `SELECT pi.id, pp.year, pp.month, pi.currency, pi.fixed_amount, pi.commission_amount, pi.bonuses, pi.deductions, pi.net_amount, pi.status
       FROM payroll_items pi JOIN payroll_periods pp ON pp.id=pi.period_id WHERE pi.staff_id=$1 ORDER BY pp.year DESC, pp.month DESC LIMIT 12`, [wid])).rows;
    const fx = (await storeCfg(req.params.sid)).fx_rates || null;
    res.json({ is_staff: true, worker: row ? { ...row, full_name: fullName(row) } : null, counts, assigned, earnings: earnings[wid] || {}, recent, payroll, period: { year, month }, fx_rates: fx });
  } catch (e) { console.error('[workers me]', e.message); res.status(500).json({ error: e.message }); }
});

router.patch('/me/profile', auth, async (req, res) => {
  try {
    if (!req.user.staff_id) return res.status(400).json({ error: 'Not a worker account' });
    const me = (await pool.query('SELECT * FROM store_staff WHERE id=$1', [req.user.staff_id])).rows[0];
    if (!me) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const first = b.first_name !== undefined ? clean(b.first_name, 80) : me.first_name;
    const last = b.last_name !== undefined ? clean(b.last_name, 80) : me.last_name;
    const ids = (await siblingRows(me, req.user.id)).map((s) => s.id);
    await pool.query(
      `UPDATE store_staff SET first_name=$1,last_name=$2,name=$3,phone=COALESCE($4,phone),avatar=CASE WHEN $5::boolean THEN $6 ELSE avatar END,language=COALESCE($7,language),updated_at=NOW() WHERE id = ANY($8::uuid[])`,
      [first, last, [first, last].filter(Boolean).join(' ') || me.name, b.phone !== undefined ? clean(b.phone, 30) : null, b.avatar !== undefined, b.avatar || null, ['ar', 'fr', 'en'].includes(b.language) ? b.language : null, ids]);
    forgetStaff();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/me/password', auth, async (req, res) => {
  try {
    if (!req.user.staff_id) return res.status(400).json({ error: 'Not a worker account' });
    const { current_password, new_password } = req.body || {};
    if (!strongEnough(new_password)) return res.status(400).json({ error: 'Use at least 8 characters with letters and numbers.' });
    const me = (await pool.query('SELECT s.*, st.owner_id FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1', [req.user.staff_id])).rows[0];
    if (!me || !(await bcrypt.compare(String(current_password || ''), me.password_hash || ''))) return res.status(401).json({ error: 'Current password is incorrect' });
    const ids = (await siblingRows(me, me.owner_id)).map((s) => s.id);
    await pool.query('UPDATE store_staff SET password_hash=$1, session_version=COALESCE(session_version,0)+1, updated_at=NOW() WHERE id = ANY($2::uuid[])', [await bcrypt.hash(String(new_password), 12), ids]);
    forgetStaff();
    const fresh = (await pool.query('SELECT s.*, st.owner_id, st.store_name, st.slug FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1', [req.user.staff_id])).rows[0];
    await audit(me.store_id, req, 'worker_password_changed', 'worker', me.id, null);
    res.json({ ok: true, ...(await buildSession(fresh, true)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── JOB TYPES & ROLES ──────────────────────────────────────────────────────
router.get('/stores/:sid/job-types', auth, async (req, res) => {
  try { res.json({ job_types: await loadJobTypes(req.params.sid) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stores/:sid/job-types', auth, async (req, res) => {
  try {
    const name = clean(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const r = await pool.query('INSERT INTO worker_job_types(store_id,name) VALUES($1,$2) ON CONFLICT (store_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,is_default', [req.params.sid, name]);
    await audit(req.params.sid, req, 'job_type_created', 'job_type', r.rows[0].id, { name });
    res.json({ job_type: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/stores/:sid/job-types/:jid', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.jid)) return res.status(400).json({ error: 'Bad id' });
    await pool.query('DELETE FROM worker_job_types WHERE id=$1 AND store_id=$2', [req.params.jid, req.params.sid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stores/:sid/worker-roles', auth, async (req, res) => {
  try {
    const roles = await loadRoles(req.params.sid);
    const counts = (await pool.query('SELECT role_template_id, COUNT(*)::int AS n FROM store_staff WHERE store_id=$1 GROUP BY role_template_id', [req.params.sid])).rows;
    const byId = {}; counts.forEach((c) => { byId[c.role_template_id] = c.n; });
    res.json({ roles: roles.map((r) => ({ ...r, workers: byId[r.id] || 0 })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// A staff manager can only hand out permissions they hold themselves.
function permsWithinOwn(req, perms) {
  if (!req.staffPerms) return true;
  return (perms || []).every((p) => req.staffPerms.has(p));
}
router.post('/stores/:sid/worker-roles', auth, async (req, res) => {
  try {
    const { name, description, permissions } = req.body || {};
    if (!clean(name)) return res.status(400).json({ error: 'Name required' });
    const perms = Array.isArray(permissions) ? permissions.map(String) : [];
    if (!permsWithinOwn(req, perms)) return res.status(403).json({ error: 'You can only give permissions you have yourself.' });
    const cfg = await storeCfg(req.params.sid);
    const list = Array.isArray(cfg.role_templates) ? cfg.role_templates : [];
    const role = { id: 'st_' + Date.now(), name: clean(name, 80), description: clean(description, 200) || '', permissions: perms, scope: 'store' };
    list.push(role); cfg.role_templates = list; await saveStoreCfg(req.params.sid, cfg);
    await audit(req.params.sid, req, 'role_created', 'role', role.id, { after: role });
    res.json({ role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/stores/:sid/worker-roles/:rid', auth, async (req, res) => {
  try {
    const cfg = await storeCfg(req.params.sid);
    const list = Array.isArray(cfg.role_templates) ? cfg.role_templates : [];
    const i = list.findIndex((x) => String(x.id) === String(req.params.rid));
    if (i < 0) return res.status(404).json({ error: 'Role not found' });
    const before = list[i];
    const perms = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : before.permissions;
    if (!permsWithinOwn(req, perms)) return res.status(403).json({ error: 'You can only give permissions you have yourself.' });
    list[i] = { ...before, name: clean(req.body?.name, 80) || before.name, description: req.body?.description !== undefined ? (clean(req.body.description, 200) || '') : before.description, permissions: perms };
    cfg.role_templates = list; await saveStoreCfg(req.params.sid, cfg);
    let updated = 0;
    if (req.body?.apply_to_workers) {
      const r = await pool.query('UPDATE store_staff SET permissions=$1, role=$2, updated_at=NOW() WHERE store_id=$3 AND role_template_id=$4', [JSON.stringify(perms), list[i].name, req.params.sid, String(req.params.rid)]);
      updated = r.rowCount; forgetStaff();
    }
    await audit(req.params.sid, req, 'role_updated', 'role', req.params.rid, { before: { name: before.name, permissions: before.permissions }, after: { name: list[i].name, permissions: perms }, workers_updated: updated });
    res.json({ role: list[i], workers_updated: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/stores/:sid/worker-roles/:rid', auth, async (req, res) => {
  try {
    const inUse = (await pool.query('SELECT COUNT(*)::int AS n FROM store_staff WHERE store_id=$1 AND role_template_id=$2', [req.params.sid, String(req.params.rid)])).rows[0].n;
    if (inUse) return res.status(409).json({ error: `${inUse} worker(s) still have this role. Give them another role first.` });
    const cfg = await storeCfg(req.params.sid);
    cfg.role_templates = (Array.isArray(cfg.role_templates) ? cfg.role_templates : []).filter((x) => String(x.id) !== String(req.params.rid));
    await saveStoreCfg(req.params.sid, cfg);
    await audit(req.params.sid, req, 'role_deleted', 'role', req.params.rid, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WORKERS ────────────────────────────────────────────────────────────────
function rulesFromBody(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!(r?.rule_type in RULE_TYPES)) continue;
    const amount = money(r.amount);
    if (!(amount > 0)) continue;
    out.push({ rule_type: r.rule_type, amount, currency: CURRENCIES.includes(r.currency) ? r.currency : 'DZD', label: clean(r.label, 120) });
  }
  return out;
}
async function saveRules(sid, staffId, rules) {
  await pool.query('UPDATE worker_compensation_rules SET is_active=FALSE, updated_at=NOW() WHERE store_id=$1 AND staff_id=$2 AND is_active=TRUE', [sid, staffId]);
  for (const r of rules) {
    await pool.query('INSERT INTO worker_compensation_rules(store_id,staff_id,rule_type,amount,currency,frequency,label) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [sid, staffId, r.rule_type, r.amount, r.currency, r.rule_type === 'fixed_monthly' ? 'monthly' : 'per_action', r.label]);
  }
}

router.get('/stores/:sid/workers', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const { q, job, role, status } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const where = ['s.store_id=$1']; const p = [sid];
    if (q && String(q).trim()) { p.push('%' + String(q).trim() + '%'); where.push(`(s.name ILIKE $${p.length} OR s.first_name ILIKE $${p.length} OR s.last_name ILIKE $${p.length} OR s.email ILIKE $${p.length} OR s.phone ILIKE $${p.length} OR s.username ILIKE $${p.length})`); }
    if (job) { p.push(job); where.push(`s.job_type=$${p.length}`); }
    if (role) { p.push(role); where.push(`s.role_template_id=$${p.length}`); }
    if (status && STATUSES.includes(status)) { p.push(status); where.push(`COALESCE(s.status,'active')=$${p.length}`); }
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM store_staff s WHERE ${where.join(' AND ')}`, p)).rows[0].n;
    p.push(limit, offset);
    const rows = (await pool.query(
      `SELECT s.id,s.name,s.first_name,s.last_name,s.email,s.phone,s.username,s.avatar,s.job_type,s.role,s.role_template_id,COALESCE(s.status,'active') AS status,
              s.last_login_at,s.last_seen_at,s.created_at,
              (SELECT MAX(created_at) FROM worker_order_actions a WHERE a.staff_id=s.id) AS last_action_at
       FROM store_staff s WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.status,'active')='active' DESC, s.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    const ids = rows.map((r) => r.id);
    const { year, month } = thisMonth();
    const { earnings, counts } = ids.length ? await computeEarnings(sid, year, month, ids) : { earnings: {}, counts: {} };
    const handled = ids.length ? (await pool.query(
      `SELECT staff_id, COUNT(DISTINCT order_id)::int AS n FROM worker_order_actions WHERE store_id=$1 AND staff_id = ANY($2::uuid[])
         AND created_at >= make_timestamptz($3,$4,1,0,0,0,'Africa/Algiers') GROUP BY staff_id`, [sid, ids, year, month])).rows : [];
    const handledBy = {}; handled.forEach((h) => { handledBy[h.staff_id] = h.n; });
    const rules = ids.length ? (await pool.query('SELECT staff_id,rule_type,amount,currency FROM worker_compensation_rules WHERE store_id=$1 AND is_active=TRUE AND staff_id = ANY($2::uuid[])', [sid, ids])).rows : [];
    const rulesBy = {}; rules.forEach((r) => { (rulesBy[r.staff_id] = rulesBy[r.staff_id] || []).push({ ...r, amount: parseFloat(r.amount) }); });
    const roles = await loadRoles(sid);
    const roleName = (w) => roles.find((r) => String(r.id) === String(w.role_template_id))?.name || (w.role && !/^(tpl_|st_)/.test(w.role) ? w.role : null);
    const workers = rows.map((w) => ({
      ...w, full_name: fullName(w), role_name: roleName(w),
      online: !!(w.last_seen_at && Date.now() - new Date(w.last_seen_at) < 5 * 60 * 1000),
      orders: handledBy[w.id] || 0, confirmed: counts[w.id]?.confirmed || 0, prepared: counts[w.id]?.prepared || 0,
      shipped: counts[w.id]?.shipped || 0, completed: counts[w.id]?.completed || 0,
      rules: rulesBy[w.id] || [], earnings: earnings[w.id] || {},
      last_activity: [w.last_seen_at, w.last_action_at].filter(Boolean).sort().slice(-1)[0] || null,
    }));
    // Store-wide stats (all workers, not just this page)
    const st = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE COALESCE(status,'active')='active')::int AS active,
              COUNT(*) FILTER (WHERE COALESCE(status,'active')<>'active')::int AS inactive,
              COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '5 minutes')::int AS online,
              COUNT(*) FILTER (WHERE created_at >= make_timestamptz($2,$3,1,0,0,0,'Africa/Algiers'))::int AS new_this_month
       FROM store_staff WHERE store_id=$1`, [sid, year, month])).rows[0];
    const all = await computeEarnings(sid, year, month);
    const payroll = {}; const commissions = {};
    Object.values(all.earnings).forEach((byCur) => Object.entries(byCur).forEach(([cur, e]) => {
      payroll[cur] = money((payroll[cur] || 0) + e.fixed + e.commission); commissions[cur] = money((commissions[cur] || 0) + e.commission);
    }));
    res.json({ workers, total, limit, offset, stats: { ...st, payroll_this_month: payroll, commissions_this_month: commissions }, period: { year, month } });
  } catch (e) { console.error('[workers list]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/stores/:sid/workers/:wid', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    if (!isUuid(wid)) return res.status(400).json({ error: 'Bad id' });
    const w = (await pool.query('SELECT s.*, st.owner_id FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1 AND s.store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const sib = await siblingRows(w, w.owner_id);
    const stores = (await pool.query('SELECT s.id AS worker_id, s.store_id, st.store_name, s.role, s.job_type, COALESCE(s.status,\'active\') AS status FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id = ANY($1::uuid[])', [sib.map((x) => x.id)])).rows;
    const rules = (await pool.query('SELECT id,rule_type,amount,currency,frequency,label,created_at FROM worker_compensation_rules WHERE store_id=$1 AND staff_id=$2 AND is_active=TRUE ORDER BY created_at', [sid, wid])).rows;
    const { year, month } = thisMonth();
    const { earnings, counts } = await computeEarnings(sid, year, month, [wid]);
    const logins = (await pool.query('SELECT success,reason,ip,user_agent,created_at FROM worker_login_history WHERE staff_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 25', [sib.map((x) => x.id)])).rows;
    const payroll = (await pool.query(`SELECT pi.id, pp.year, pp.month, pi.currency, pi.fixed_amount, pi.commission_amount, pi.bonuses, pi.deductions, pi.net_amount, pi.status FROM payroll_items pi JOIN payroll_periods pp ON pp.id=pi.period_id WHERE pi.store_id=$1 AND pi.staff_id=$2 ORDER BY pp.year DESC, pp.month DESC LIMIT 24`, [sid, wid])).rows;
    const recent = (await pool.query('SELECT order_id, order_number, action, previous_status, new_status, created_at FROM worker_order_actions WHERE store_id=$1 AND staff_id=$2 ORDER BY created_at DESC LIMIT 30', [sid, wid])).rows;
    const roles = await loadRoles(sid);
    const { password_hash, owner_id, ...safe } = w;
    res.json({
      worker: { ...safe, full_name: fullName(w), status: w.status || 'active', permissions: parsePerms(w.permissions), role_name: roles.find((r) => String(r.id) === String(w.role_template_id))?.name || (w.role && !/^(tpl_|st_)/.test(w.role) ? w.role : null), online: !!(w.last_seen_at && Date.now() - new Date(w.last_seen_at) < 300000) },
      stores, rules, earnings: earnings[wid] || {}, counts: counts[wid] || {}, logins, payroll, recent, period: { year, month },
    });
  } catch (e) { console.error('[worker get]', e.message); res.status(500).json({ error: e.message }); }
});

async function identifierTaken(ownerId, { username, email }, exceptIds = []) {
  if (username) {
    const r = await pool.query('SELECT 1 FROM store_staff WHERE LOWER(username)=LOWER($1) AND NOT (id = ANY($2::uuid[])) LIMIT 1', [username, exceptIds]);
    if (r.rows.length) return 'This username is already taken.';
  }
  if (email) {
    // the same email in another owner's business would make logins ambiguous
    const r = await pool.query('SELECT 1 FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE LOWER(s.email)=LOWER($1) AND st.owner_id<>$2 LIMIT 1', [email, ownerId]);
    if (r.rows.length) return 'This email is already used by a worker of another business.';
    const r2 = await pool.query('SELECT 1 FROM store_staff WHERE LOWER(email)=LOWER($1) AND NOT (id = ANY($2::uuid[])) LIMIT 1', [email, exceptIds]);
    if (r2.rows.length) return 'A worker with this email already exists.';
  }
  return null;
}

router.post('/stores/:sid/workers', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const b = req.body || {};
    const first = clean(b.first_name, 80), last = clean(b.last_name, 80);
    const phone = clean(b.phone, 30), email = clean(b.email, 200)?.toLowerCase() || null;
    const username = clean(b.username, 80)?.toLowerCase().replace(/[^a-z0-9._-]/g, '') || null;
    if (!first || !last) return res.status(400).json({ error: 'First and last name are required.' });
    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
    if (!email && !username) return res.status(400).json({ error: 'Give the worker an email or a username to log in with.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Email address is not valid.' });
    const invite = !!b.invite;
    if (!invite && !strongEnough(b.password)) return res.status(400).json({ error: 'Temporary password: at least 8 characters with letters and numbers.' });
    if (invite && !email && !phone) return res.status(400).json({ error: 'An invitation needs an email or a phone number.' });
    const taken = await identifierTaken(req.user.id, { username, email });
    if (taken) return res.status(409).json({ error: taken });
    const perms = Array.isArray(b.permissions) ? [...new Set(b.permissions.map(String))] : [];
    if (!permsWithinOwn(req, perms)) return res.status(403).json({ error: 'You can only give permissions you have yourself.' });
    const rules = rulesFromBody(b.compensation);
    // stores: the current one plus any others of this owner the admin picked
    let storeIds = Array.isArray(b.store_ids) && b.store_ids.length ? b.store_ids.filter(isUuid) : [sid];
    if (!storeIds.includes(sid)) storeIds.unshift(sid);
    if (req.user.staff_id) storeIds = [sid]; // staff managers add to their current store only
    const owned = (await pool.query('SELECT id FROM stores WHERE owner_id=$1 AND id = ANY($2::uuid[])', [req.user.id, storeIds])).rows.map((r) => String(r.id));
    const roles = await loadRoles(sid);
    const role = roles.find((r) => String(r.id) === String(b.role_id));
    const hash = await bcrypt.hash(invite ? crypto.randomBytes(24).toString('hex') : String(b.password), 12);
    const status = invite ? 'pending' : 'active';
    const created = [];
    for (const storeId of owned) {
      const r = await pool.query(
        `INSERT INTO store_staff(store_id,name,first_name,last_name,email,phone,username,password_hash,role,role_template_id,permissions,avatar,date_of_birth,address,notes,job_type,status,is_active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [storeId, `${first} ${last}`, first, last, email, phone, username, hash, role?.name || clean(b.role_label, 120) || 'Staff', role ? String(role.id) : null,
          JSON.stringify(perms), typeof b.avatar === 'string' && b.avatar.length < 3_000_000 ? b.avatar : null, b.date_of_birth || null, clean(b.address, 300), clean(b.notes, 1000),
          clean(b.job_type, 120), status, !invite]);
      created.push(r.rows[0]);
      if (rules.length) await saveRules(storeId, r.rows[0].id, rules);
    }
    const main = created.find((c) => String(c.store_id) === String(sid)) || created[0];
    await audit(sid, req, 'worker_created', 'worker', main.id, { after: { name: fullName(main), job: main.job_type, role: main.role, permissions: perms, compensation: rules, stores: owned.length, invite } });
    let invite_link = null, sent = [];
    if (invite) {
      const raw = await createToken(main, 'invite', 24 * 7);
      invite_link = `${originOf(req)}/worker/reset?token=${raw}&invite=1`;
      const storeName = (await pool.query('SELECT store_name FROM stores WHERE id=$1', [sid])).rows[0]?.store_name || 'your store';
      if (b.send_invitation !== false) sent = await sendLink(main, storeName, invite_link, 'invite');
    }
    const { password_hash, ...safe } = main;
    res.json({ worker: { ...safe, full_name: fullName(main) }, stores: owned.length, invite_link, sent, login: { identifier: username || email, url: `${originOf(req)}/worker/login` } });
  } catch (e) { console.error('[worker create]', e.message); res.status(500).json({ error: e.message }); }
});

router.patch('/stores/:sid/workers/:wid', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    if (!isUuid(wid)) return res.status(400).json({ error: 'Bad id' });
    const w = (await pool.query('SELECT * FROM store_staff WHERE id=$1 AND store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const b = req.body || {};
    const self = req.user.staff_id && (await siblingRows(w, req.user.id)).some((x) => String(x.id) === String(req.user.staff_id));
    if (self && ['permissions', 'role_id', 'status', 'job_type'].some((k) => b[k] !== undefined)) return res.status(403).json({ error: 'You cannot change your own role, permissions or status.' });
    if (b.permissions !== undefined && !permsWithinOwn(req, b.permissions)) return res.status(403).json({ error: 'You can only give permissions you have yourself.' });
    const sib = await siblingRows(w, req.user.id);
    const sibIds = sib.map((x) => x.id);
    const before = { name: fullName(w), job: w.job_type, role: w.role, permissions: parsePerms(w.permissions), status: w.status };
    // identity: every store this person works in
    const idSet = []; const idVals = [];
    const setId = (col, val) => { idVals.push(val); idSet.push(`${col}=$${idVals.length}`); };
    if (b.first_name !== undefined || b.last_name !== undefined) {
      const f = b.first_name !== undefined ? clean(b.first_name, 80) : w.first_name;
      const l = b.last_name !== undefined ? clean(b.last_name, 80) : w.last_name;
      if (!f || !l) return res.status(400).json({ error: 'First and last name are required.' });
      setId('first_name', f); setId('last_name', l); setId('name', `${f} ${l}`);
    }
    if (b.phone !== undefined) setId('phone', clean(b.phone, 30));
    if (b.email !== undefined || b.username !== undefined) {
      const email = b.email !== undefined ? clean(b.email, 200)?.toLowerCase() || null : w.email;
      const username = b.username !== undefined ? (clean(b.username, 80)?.toLowerCase().replace(/[^a-z0-9._-]/g, '') || null) : w.username;
      if (!email && !username) return res.status(400).json({ error: 'Keep an email or a username to log in with.' });
      const taken = await identifierTaken(req.user.id, { username: b.username !== undefined ? username : null, email: b.email !== undefined ? email : null }, sibIds);
      if (taken) return res.status(409).json({ error: taken });
      setId('email', email); setId('username', username);
    }
    if (b.avatar !== undefined) setId('avatar', typeof b.avatar === 'string' && b.avatar.length < 3_000_000 ? b.avatar || null : null);
    if (b.date_of_birth !== undefined) setId('date_of_birth', b.date_of_birth || null);
    if (b.address !== undefined) setId('address', clean(b.address, 300));
    if (b.notes !== undefined) setId('notes', clean(b.notes, 1000));
    if (idSet.length) { idVals.push(sibIds); await pool.query(`UPDATE store_staff SET ${idSet.join(',')}, updated_at=NOW() WHERE id = ANY($${idVals.length}::uuid[])`, idVals); }
    // this store only: job, role, permissions, status
    const st = []; const sv = [];
    const setSt = (col, val) => { sv.push(val); st.push(`${col}=$${sv.length}`); };
    if (b.job_type !== undefined) setSt('job_type', clean(b.job_type, 120));
    if (b.role_id !== undefined) {
      const roles = await loadRoles(sid);
      const role = roles.find((r) => String(r.id) === String(b.role_id));
      setSt('role_template_id', role ? String(role.id) : null); setSt('role', role?.name || clean(b.role_label, 120) || 'Staff');
    }
    if (b.permissions !== undefined) setSt('permissions', JSON.stringify([...new Set((b.permissions || []).map(String))]));
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Bad status' });
      setSt('status', b.status); setSt('is_active', b.status === 'active');
      if (b.status !== 'active') st.push('session_version=COALESCE(session_version,0)+1'); // log them out now
    }
    if (st.length) { sv.push(wid); await pool.query(`UPDATE store_staff SET ${st.join(',')}, updated_at=NOW() WHERE id=$${sv.length}`, sv); }
    forgetStaff();
    const after = (await pool.query('SELECT * FROM store_staff WHERE id=$1', [wid])).rows[0];
    await audit(sid, req, b.status !== undefined && b.status !== before.status ? `worker_${b.status === 'active' ? 'enabled' : b.status}` : 'worker_updated', 'worker', wid,
      { before, after: { name: fullName(after), job: after.job_type, role: after.role, permissions: parsePerms(after.permissions), status: after.status } });
    const { password_hash, ...safe } = after;
    res.json({ worker: { ...safe, full_name: fullName(after) } });
  } catch (e) { console.error('[worker update]', e.message); res.status(500).json({ error: e.message }); }
});

router.put('/stores/:sid/workers/:wid/compensation', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    const w = (await pool.query('SELECT * FROM store_staff WHERE id=$1 AND store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (req.user.staff_id && (await siblingRows(w, req.user.id)).some((x) => String(x.id) === String(req.user.staff_id))) return res.status(403).json({ error: 'You cannot change your own salary.' });
    const before = (await pool.query('SELECT rule_type,amount,currency FROM worker_compensation_rules WHERE store_id=$1 AND staff_id=$2 AND is_active=TRUE', [sid, wid])).rows;
    const rules = rulesFromBody(req.body?.rules);
    await saveRules(sid, wid, rules);
    await audit(sid, req, 'compensation_changed', 'worker', wid, { before, after: rules });
    res.json({ ok: true, rules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/workers/:wid/reset-password', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    const w = (await pool.query('SELECT s.*, st.owner_id, st.store_name FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1 AND s.store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const ids = (await siblingRows(w, w.owner_id)).map((x) => x.id);
    if (req.body?.mode === 'link') {
      const raw = await createToken(w, 'reset', 24);
      const link = `${originOf(req)}/worker/reset?token=${raw}`;
      const sent = await sendLink(w, w.store_name, link, 'reset');
      await audit(sid, req, 'worker_reset_link', 'worker', wid, { sent });
      return res.json({ link, sent });
    }
    const pw = randomPassword();
    await pool.query('UPDATE store_staff SET password_hash=$1, session_version=COALESCE(session_version,0)+1, failed_logins=0, locked_until=NULL, updated_at=NOW() WHERE id = ANY($2::uuid[])', [await bcrypt.hash(pw, 12), ids]);
    forgetStaff();
    await audit(sid, req, 'worker_password_reset', 'worker', wid, null);
    res.json({ password: pw, login: w.username || w.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Give an existing worker access to another of the owner's stores (same
// login; job, role and permissions copied, editable there afterwards).
router.post('/stores/:sid/workers/:wid/stores', auth, async (req, res) => {
  try {
    if (req.user.staff_id) return res.status(403).json({ error: 'Only the store owner can give access to other stores.' });
    const { sid, wid } = req.params;
    const target = req.body?.store_id;
    if (!isUuid(target)) return res.status(400).json({ error: 'Pick a store' });
    const owns = (await pool.query('SELECT store_name FROM stores WHERE id=$1 AND owner_id=$2', [target, req.user.id])).rows[0];
    if (!owns) return res.status(403).json({ error: 'You do not own this store.' });
    const w = (await pool.query('SELECT * FROM store_staff WHERE id=$1 AND store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const sib = await siblingRows(w, req.user.id);
    if (sib.some((x) => String(x.store_id) === String(target))) return res.status(409).json({ error: 'Already working in this store.' });
    const r = await pool.query(
      `INSERT INTO store_staff(store_id,name,first_name,last_name,email,phone,username,password_hash,role,role_template_id,permissions,avatar,date_of_birth,address,notes,job_type,status,is_active,session_version)
       SELECT $1,name,first_name,last_name,email,phone,username,password_hash,role,NULL,permissions,avatar,date_of_birth,address,notes,job_type,status,is_active,session_version FROM store_staff WHERE id=$2 RETURNING id`, [target, wid]);
    forgetStaff();
    await audit(sid, req, 'worker_store_added', 'worker', wid, { store: owns.store_name });
    res.json({ ok: true, worker_id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/workers/:wid/revoke-sessions', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    const w = (await pool.query('SELECT s.*, st.owner_id FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1 AND s.store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    await pool.query('UPDATE store_staff SET session_version=COALESCE(session_version,0)+1 WHERE id = ANY($1::uuid[])', [(await siblingRows(w, w.owner_id)).map((x) => x.id)]);
    forgetStaff();
    await audit(sid, req, 'worker_sessions_revoked', 'worker', wid, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/workers/:wid/invite', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    const w = (await pool.query('SELECT s.*, st.store_name FROM store_staff s JOIN stores st ON st.id=s.store_id WHERE s.id=$1 AND s.store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const raw = await createToken(w, 'invite', 24 * 7);
    const link = `${originOf(req)}/worker/reset?token=${raw}&invite=1`;
    const sent = req.body?.send === false ? [] : await sendLink(w, w.store_name, link, 'invite');
    await audit(sid, req, 'worker_invited', 'worker', wid, { sent });
    res.json({ link, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/stores/:sid/workers/:wid', auth, async (req, res) => {
  try {
    const { sid, wid } = req.params;
    const w = (await pool.query('SELECT * FROM store_staff WHERE id=$1 AND store_id=$2', [wid, sid])).rows[0];
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    if (req.user.staff_id && String(req.user.staff_id) === String(wid)) return res.status(403).json({ error: 'You cannot delete yourself.' });
    // History (actions, payroll) is kept; only the account in this store goes.
    await pool.query('UPDATE worker_compensation_rules SET is_active=FALSE WHERE store_id=$1 AND staff_id=$2', [sid, wid]);
    await pool.query('UPDATE orders SET assigned_staff_id=NULL WHERE store_id=$1 AND assigned_staff_id=$2', [sid, wid]);
    await pool.query('DELETE FROM store_staff WHERE id=$1 AND store_id=$2', [wid, sid]);
    forgetStaff();
    await audit(sid, req, 'worker_deleted', 'worker', wid, { before: { name: fullName(w), job: w.job_type, role: w.role } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ORDER ASSIGNMENT / TIMELINE ────────────────────────────────────────────
// Active workers an order can be assigned to (name + job only).
router.get('/stores/:sid/assignable-workers', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, name, first_name, last_name, avatar, job_type FROM store_staff WHERE store_id=$1 AND COALESCE(status,'active')='active' ORDER BY name", [req.params.sid]);
    res.json({ workers: r.rows.map((w) => ({ id: w.id, name: fullName(w), avatar: w.avatar, job_type: w.job_type })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/orders/assign', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const ids = (Array.isArray(req.body?.order_ids) ? req.body.order_ids : []).filter(isUuid).slice(0, 500);
    const staffId = req.body?.staff_id || null;
    if (!ids.length) return res.status(400).json({ error: 'No orders selected' });
    if (staffId) {
      const w = (await pool.query("SELECT id FROM store_staff WHERE id=$1 AND store_id=$2 AND COALESCE(status,'active')='active'", [staffId, sid])).rows[0];
      if (!w) return res.status(400).json({ error: 'Pick an active worker of this store.' });
    }
    const r = await pool.query(`UPDATE orders SET assigned_staff_id=$1, assigned_at=CASE WHEN $1::uuid IS NULL THEN NULL ELSE NOW() END WHERE store_id=$2 AND id = ANY($3::uuid[]) RETURNING id, order_number, status`, [staffId, sid, ids]);
    for (const o of r.rows) await recordOrderAction({ storeId: sid, staffId, order: o, action: staffId ? 'assigned' : 'unassigned', newStatus: o.status, metadata: { by: req.user?.name || null, by_staff: req.user?.staff_id || null } });
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Distribute unassigned new orders between workers (N each, or a total split evenly).
router.post('/stores/:sid/orders/auto-assign', auth, async (req, res) => {
  try {
    const { distribute } = require('../services/orderDistribution');
    const b = req.body || {};
    const r = await distribute(req.params.sid, { workerIds: b.worker_ids, perWorker: b.per_worker, total: b.total, includeCallFailed: !!b.include_call_failed, actor: req.user?.name || null });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Automatic assignment of every new order (store setting).
router.get('/stores/:sid/orders/auto-assign/settings', auth, async (req, res) => {
  try { res.json(await require('../services/orderDistribution').readSettings(req.params.sid)); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/stores/:sid/orders/auto-assign/settings', auth, async (req, res) => {
  try {
    const { isUuid } = require('../services/orderDistribution');
    const b = req.body || {};
    const cfg = await storeCfg(req.params.sid);
    cfg.auto_assign = { enabled: !!b.enabled, worker_ids: (Array.isArray(b.worker_ids) ? b.worker_ids : []).filter(isUuid).slice(0, 200), max_open: Math.max(0, Math.min(10000, parseInt(b.max_open, 10) || 0)) };
    await saveStoreCfg(req.params.sid, cfg);
    await audit(req.params.sid, req, 'auto_assign_updated', 'settings', null, { after: cfg.auto_assign });
    res.json(cfg.auto_assign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/orders/:oid/log-action', auth, async (req, res) => {
  try {
    const action = req.body?.action === 'called' ? 'called' : null;
    if (!action || !isUuid(req.params.oid)) return res.status(400).json({ error: 'Bad request' });
    const o = (await pool.query('SELECT id, order_number, status FROM orders WHERE id=$1 AND store_id=$2', [req.params.oid, req.params.sid])).rows[0];
    if (!o) return res.status(404).json({ error: 'Not found' });
    await recordOrderAction({ storeId: req.params.sid, staffId: req.staffRowId || null, order: o, action, newStatus: o.status });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stores/:sid/orders/:oid/timeline', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.oid)) return res.status(400).json({ error: 'Bad id' });
    const r = await pool.query(
      `SELECT a.action, a.previous_status, a.new_status, a.created_at, a.metadata, a.staff_id, COALESCE(s.name, 'Owner') AS worker
       FROM worker_order_actions a LEFT JOIN store_staff s ON s.id=a.staff_id WHERE a.store_id=$1 AND a.order_id=$2 ORDER BY a.created_at`, [req.params.sid, req.params.oid]);
    res.json({ timeline: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE ────────────────────────────────────────────────────────────
router.get('/stores/:sid/performance', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[req.query.range] || 30;
    const wid = isUuid(req.query.worker) ? req.query.worker : null;
    const p = [sid, days]; let wf = '';
    if (wid) { p.push(wid); wf = ` AND a.staff_id=$${p.length}`; }
    const totals = (await pool.query(
      `SELECT action, COUNT(*)::int AS n FROM worker_order_actions a WHERE a.store_id=$1 AND a.staff_id IS NOT NULL AND a.created_at >= NOW() - ($2 || ' days')::interval${wf} GROUP BY action`, p)).rows;
    const t = {}; totals.forEach((x) => { t[x.action] = x.n; });
    const daily = (await pool.query(
      `SELECT to_char(date_trunc('day', a.created_at AT TIME ZONE 'Africa/Algiers'),'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE action='confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE action='prepared')::int AS prepared,
              COUNT(*) FILTER (WHERE action='completed')::int AS completed, COUNT(*) FILTER (WHERE action='cancelled')::int AS cancelled
       FROM worker_order_actions a WHERE a.store_id=$1 AND a.staff_id IS NOT NULL AND a.created_at >= NOW() - ($2 || ' days')::interval${wf}
       GROUP BY 1 ORDER BY 1`, p)).rows;
    // average minutes between being assigned an order and confirming it
    const avg = (await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (c.created_at - a.created_at))/60)::numeric,1) AS minutes
       FROM worker_order_actions c JOIN LATERAL (SELECT created_at FROM worker_order_actions x WHERE x.order_id=c.order_id AND x.action='assigned' AND x.staff_id=c.staff_id AND x.created_at<=c.created_at ORDER BY x.created_at DESC LIMIT 1) a ON TRUE
       WHERE c.store_id=$1 AND c.action='confirmed' AND c.staff_id IS NOT NULL AND c.created_at >= NOW() - ($2 || ' days')::interval${wf.replace('a.staff_id', 'c.staff_id')}`, p)).rows[0];
    const board = (await pool.query(
      `SELECT a.staff_id, COALESCE(s.name,'—') AS name, s.avatar, s.job_type,
              COUNT(*) FILTER (WHERE action='confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE action='prepared')::int AS prepared,
              COUNT(*) FILTER (WHERE action='completed')::int AS completed, COUNT(*) FILTER (WHERE action='cancelled')::int AS cancelled
       FROM worker_order_actions a LEFT JOIN store_staff s ON s.id=a.staff_id
       WHERE a.store_id=$1 AND a.staff_id IS NOT NULL AND a.created_at >= NOW() - ($2 || ' days')::interval GROUP BY a.staff_id, s.name, s.avatar, s.job_type ORDER BY confirmed DESC, completed DESC LIMIT 50`, [sid, days])).rows;
    const assigned = t.assigned || 0, confirmed = t.confirmed || 0, cancelled = t.cancelled || 0, completed = t.completed || 0;
    const { year, month } = thisMonth();
    const { earnings } = wid ? await computeEarnings(sid, year, month, [wid]) : { earnings: {} };
    res.json({
      range: days, totals: { assigned, confirmed, prepared: t.prepared || 0, completed, cancelled, called: t.called || 0 },
      rates: { confirmation: confirmed + cancelled ? Math.round((confirmed / (confirmed + cancelled)) * 1000) / 10 : null, completion: confirmed ? Math.round((completed / confirmed) * 1000) / 10 : null },
      avg_processing_minutes: avg?.minutes != null ? parseFloat(avg.minutes) : null,
      daily, board, earnings: wid ? earnings[wid] || {} : null,
    });
  } catch (e) { console.error('[performance]', e.message); res.status(500).json({ error: e.message }); }
});

// ── ACTIVITY LOG (orders + account/admin actions) ──────────────────────────
router.get('/stores/:sid/worker-activity', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const p = [sid]; const fa = []; const fb = [];
    if (isUuid(req.query.worker)) { p.push(req.query.worker); fa.push(`a.staff_id=$${p.length}`); fb.push(`l.actor_id=$${p.length}::text`); }
    if (req.query.action) { p.push(String(req.query.action)); fa.push(`a.action=$${p.length}`); fb.push(`l.action=$${p.length}`); }
    if (req.query.from) { p.push(req.query.from); fa.push(`a.created_at >= $${p.length}::date`); fb.push(`l.created_at >= $${p.length}::date`); }
    if (req.query.to) { p.push(req.query.to); fa.push(`a.created_at < $${p.length}::date + 1`); fb.push(`l.created_at < $${p.length}::date + 1`); }
    const wa = fa.length ? ' AND ' + fa.join(' AND ') : '';
    const wb = fb.length ? ' AND ' + fb.join(' AND ') : '';
    const kind = req.query.kind; // orders | account | all
    const parts = [];
    if (kind !== 'account') parts.push(`SELECT 'order' AS kind, a.created_at, a.staff_id::text AS actor_id, COALESCE(s.name, 'Owner') AS actor_name, a.action, 'order' AS target_type, COALESCE(a.order_number, a.order_id::text) AS target, a.order_id::text AS target_id, a.previous_status AS before, a.new_status AS after
       FROM worker_order_actions a LEFT JOIN store_staff s ON s.id=a.staff_id WHERE a.store_id=$1${wa}`);
    if (kind !== 'orders') parts.push(`SELECT 'account' AS kind, l.created_at, l.actor_id AS actor_id, l.actor_name, l.action, l.target_type, l.target_id AS target, l.target_id, NULL AS before, l.details AS after
       FROM staff_activity_log l WHERE l.store_id=$1${wb}`);
    p.push(limit + 1, offset);
    let rows;
    try { rows = (await pool.query(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows; }
    catch (e) { if (kind === 'account') throw e; rows = (await pool.query(`${parts[0]} ORDER BY created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows; }
    res.json({ entries: rows.slice(0, limit), has_more: rows.length > limit });
  } catch (e) { console.error('[worker activity]', e.message); res.status(500).json({ error: e.message }); }
});

// ── PAYROLL ────────────────────────────────────────────────────────────────
async function getPeriod(sid, year, month, create = true) {
  let r = await pool.query('SELECT * FROM payroll_periods WHERE store_id=$1 AND year=$2 AND month=$3', [sid, year, month]);
  if (!r.rows.length && create) r = await pool.query('INSERT INTO payroll_periods(store_id,year,month) VALUES($1,$2,$3) ON CONFLICT (store_id,year,month) DO UPDATE SET updated_at=NOW() RETURNING *', [sid, year, month]);
  return r.rows[0] || null;
}

// (Re)calculate a month. Approved / paid / cancelled items are locked and
// never touched — later corrections go through adjustments.
async function calculatePeriod(sid, year, month) {
  const period = await getPeriod(sid, year, month, true);
  const { earnings, counts } = await computeEarnings(sid, year, month);
  const staff = (await pool.query('SELECT id,name,first_name,last_name,job_type FROM store_staff WHERE store_id=$1', [sid])).rows;
  const byId = {}; staff.forEach((s) => { byId[s.id] = s; });
  // keep names for workers that were deleted since
  const existing = (await pool.query('SELECT * FROM payroll_items WHERE period_id=$1', [period.id])).rows;
  const keep = new Set();
  for (const [staffId, byCur] of Object.entries(earnings)) {
    for (const [cur, e] of Object.entries(byCur)) {
      keep.add(staffId + ':' + cur);
      const ex = existing.find((x) => String(x.staff_id) === String(staffId) && x.currency === cur);
      if (ex?.locked) continue;
      const w = byId[staffId] || {};
      const bonuses = parseFloat(ex?.bonuses) || 0, deductions = parseFloat(ex?.deductions) || 0;
      const net = money(e.fixed + e.commission + bonuses - deductions);
      await pool.query(
        `INSERT INTO payroll_items(period_id,store_id,staff_id,worker_name,job_type,currency,fixed_amount,commission_amount,bonuses,deductions,net_amount,breakdown,counts,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'calculated')
         ON CONFLICT (period_id,staff_id,currency) DO UPDATE SET worker_name=EXCLUDED.worker_name, job_type=EXCLUDED.job_type, fixed_amount=EXCLUDED.fixed_amount,
           commission_amount=EXCLUDED.commission_amount, net_amount=EXCLUDED.net_amount, breakdown=EXCLUDED.breakdown, counts=EXCLUDED.counts, status='calculated', calculated_at=NOW(), updated_at=NOW()
         WHERE payroll_items.locked=FALSE`,
        [period.id, sid, staffId, fullName(w) || ex?.worker_name || '—', w.job_type || ex?.job_type || null, cur, money(e.fixed), money(e.commission), bonuses, deductions, net, JSON.stringify(e.lines), JSON.stringify(counts[staffId] || {})]);
    }
  }
  // drop unlocked items that no longer have any rule
  for (const ex of existing) if (!ex.locked && !keep.has(ex.staff_id + ':' + ex.currency)) await pool.query('DELETE FROM payroll_items WHERE id=$1', [ex.id]);
  await pool.query("UPDATE payroll_periods SET status=CASE WHEN status IN ('approved','paid') THEN status ELSE 'calculated' END, calculated_at=NOW(), updated_at=NOW() WHERE id=$1", [period.id]);
  return period.id;
}

async function periodView(sid, periodId) {
  const items = (await pool.query(
    `SELECT pi.*, s.avatar, s.phone, COALESCE((SELECT SUM(amount) FROM payroll_adjustments a WHERE a.item_id=pi.id),0) AS adjustments,
            COALESCE((SELECT SUM(amount) FROM payroll_payments p WHERE p.item_id=pi.id),0) AS paid
     FROM payroll_items pi LEFT JOIN store_staff s ON s.id=pi.staff_id WHERE pi.period_id=$1 ORDER BY pi.worker_name`, [periodId])).rows;
  const totals = {};
  items.filter((i) => i.status !== 'cancelled').forEach((i) => {
    const t = (totals[i.currency] = totals[i.currency] || { total: 0, paid: 0, pending: 0, commission: 0 });
    const due = (parseFloat(i.net_amount) || 0) + (parseFloat(i.adjustments) || 0);
    t.total = money(t.total + due); t.paid = money(t.paid + (parseFloat(i.paid) || 0)); t.commission = money(t.commission + (parseFloat(i.commission_amount) || 0));
    t.pending = money(t.total - t.paid);
  });
  const cfg = await storeCfg(sid);
  return { items, totals, fx_rates: cfg.fx_rates || null };
}

router.get('/stores/:sid/payroll', auth, async (req, res) => {
  try {
    const sid = req.params.sid;
    const now = thisMonth();
    const year = parseInt(req.query.year) || now.year, month = parseInt(req.query.month) || now.month;
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Bad month' });
    let period = await getPeriod(sid, year, month, false);
    // first visit of a month: calculate it so there is something to review
    if (!period && (req.staffPerms ? req.staffPerms.has('payroll_manage') : true)) { await calculatePeriod(sid, year, month); period = await getPeriod(sid, year, month, false); }
    if (!period) return res.json({ period: { year, month, status: 'draft' }, items: [], totals: {} });
    res.json({ period, ...(await periodView(sid, period.id)) });
  } catch (e) { console.error('[payroll get]', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/calculate', auth, async (req, res) => {
  try {
    const sid = req.params.sid; const now = thisMonth();
    const year = parseInt(req.body?.year) || now.year, month = parseInt(req.body?.month) || now.month;
    const id = await calculatePeriod(sid, year, month);
    await audit(sid, req, 'payroll_calculated', 'payroll', `${year}-${String(month).padStart(2, '0')}`, null);
    const period = (await pool.query('SELECT * FROM payroll_periods WHERE id=$1', [id])).rows[0];
    res.json({ period, ...(await periodView(sid, id)) });
  } catch (e) { console.error('[payroll calc]', e.message); res.status(500).json({ error: e.message }); }
});

async function itemFor(req) {
  if (!isUuid(req.params.iid)) return null;
  return (await pool.query('SELECT * FROM payroll_items WHERE id=$1 AND store_id=$2', [req.params.iid, req.params.sid])).rows[0] || null;
}

router.get('/stores/:sid/payroll/items/:iid', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const period = (await pool.query('SELECT * FROM payroll_periods WHERE id=$1', [item.period_id])).rows[0];
    const adjustments = (await pool.query('SELECT * FROM payroll_adjustments WHERE item_id=$1 ORDER BY created_at', [item.id])).rows;
    const payments = (await pool.query('SELECT * FROM payroll_payments WHERE item_id=$1 ORDER BY paid_at, created_at', [item.id])).rows;
    const worker = (await pool.query('SELECT id,name,first_name,last_name,avatar,phone,email,job_type,role FROM store_staff WHERE id=$1', [item.staff_id])).rows[0] || null;
    const cfg = await storeCfg(req.params.sid);
    res.json({ item, period, adjustments, payments, worker, fx_rates: cfg.fx_rates || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The exact orders behind a commission line.
router.get('/stores/:sid/payroll/items/:iid/orders', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const period = (await pool.query('SELECT year, month FROM payroll_periods WHERE id=$1', [item.period_id])).rows[0];
    const action = PAID_ACTIONS.includes(req.query.action) ? req.query.action : 'confirmed';
    const limit = Math.min(200, parseInt(req.query.limit) || 50), offset = Math.max(0, parseInt(req.query.offset) || 0);
    const base = `FROM worker_order_actions a LEFT JOIN orders o ON o.id=a.order_id
      WHERE a.store_id=$1 AND a.staff_id=$2 AND a.action=$3
        AND a.created_at >= make_timestamptz($4,$5,1,0,0,0,'Africa/Algiers') AND a.created_at < make_timestamptz($4,$5,1,0,0,0,'Africa/Algiers') + INTERVAL '1 month'
        AND ($6::timestamptz IS NULL OR a.created_at <= $6::timestamptz)`;
    // a locked line lists exactly the orders it was calculated from
    const args = [req.params.sid, item.staff_id, action, period.year, period.month, item.locked ? (item.calculated_at || item.approved_at) : null];
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${base}`, args)).rows[0].n;
    const rows = (await pool.query(`SELECT a.order_id, a.order_number, a.created_at, o.customer_name, o.total, o.status ${base} ORDER BY a.created_at LIMIT ${limit} OFFSET ${offset}`, args)).rows;
    res.json({ action, total, orders: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/stores/:sid/payroll/items/:iid', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.locked) return res.status(409).json({ error: 'This payroll is approved and locked. Add an adjustment instead.' });
    const bonuses = req.body?.bonuses !== undefined ? Math.max(0, money(req.body.bonuses)) : parseFloat(item.bonuses) || 0;
    const deductions = req.body?.deductions !== undefined ? Math.max(0, money(req.body.deductions)) : parseFloat(item.deductions) || 0;
    const net = money((parseFloat(item.fixed_amount) || 0) + (parseFloat(item.commission_amount) || 0) + bonuses - deductions);
    const r = await pool.query('UPDATE payroll_items SET bonuses=$1, deductions=$2, net_amount=$3, notes=COALESCE($4,notes), updated_at=NOW() WHERE id=$5 RETURNING *', [bonuses, deductions, net, req.body?.notes !== undefined ? clean(req.body.notes, 500) : null, item.id]);
    await audit(req.params.sid, req, 'payroll_item_edited', 'payroll', item.id, { before: { bonuses: item.bonuses, deductions: item.deductions }, after: { bonuses, deductions } });
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/items/:iid/approve', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status !== 'calculated' && item.status !== 'draft') return res.status(409).json({ error: `Already ${item.status}.` });
    const r = await pool.query("UPDATE payroll_items SET status='approved', locked=TRUE, approved_at=NOW(), approved_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *", [String(req.user?.name || actorId(req)), item.id]);
    await audit(req.params.sid, req, 'payroll_approved', 'payroll', item.id, { worker: item.worker_name, net: item.net_amount, currency: item.currency });
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/approve', auth, async (req, res) => {
  try {
    const now = thisMonth();
    const period = await getPeriod(req.params.sid, parseInt(req.body?.year) || now.year, parseInt(req.body?.month) || now.month, false);
    if (!period) return res.status(404).json({ error: 'Nothing to approve' });
    const r = await pool.query("UPDATE payroll_items SET status='approved', locked=TRUE, approved_at=NOW(), approved_by=$1, updated_at=NOW() WHERE period_id=$2 AND status IN ('calculated','draft') RETURNING id", [String(req.user?.name || actorId(req)), period.id]);
    await pool.query("UPDATE payroll_periods SET status='approved', updated_at=NOW() WHERE id=$1", [period.id]);
    await audit(req.params.sid, req, 'payroll_approved', 'payroll', `${period.year}-${String(period.month).padStart(2, '0')}`, { items: r.rowCount });
    res.json({ ok: true, approved: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/items/:iid/pay', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'paid'].includes(item.status)) return res.status(409).json({ error: 'Approve this payroll before paying it.' });
    const b = req.body || {};
    const amount = money(b.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be more than 0' });
    const method = ['cash', 'bank_transfer', 'ccp', 'baridimob', 'other'].includes(b.method) ? b.method : null;
    if (!method) return res.status(400).json({ error: 'Choose a payment method' });
    await pool.query('INSERT INTO payroll_payments(item_id,store_id,amount,currency,method,reference,paid_at,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8,$9)',
      [item.id, req.params.sid, amount, item.currency, method, clean(b.reference, 120), b.paid_at || null, clean(b.notes, 500), String(req.user?.name || actorId(req))]);
    const sums = (await pool.query('SELECT COALESCE((SELECT SUM(amount) FROM payroll_payments WHERE item_id=$1),0) AS paid, COALESCE((SELECT SUM(amount) FROM payroll_adjustments WHERE item_id=$1),0) AS adj', [item.id])).rows[0];
    const due = (parseFloat(item.net_amount) || 0) + (parseFloat(sums.adj) || 0);
    const fully = (parseFloat(sums.paid) || 0) >= due - 0.009;
    const r = await pool.query(`UPDATE payroll_items SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [fully ? 'paid' : 'approved', item.id]);
    await audit(req.params.sid, req, 'payroll_paid', 'payroll', item.id, { worker: item.worker_name, amount, currency: item.currency, method, fully_paid: fully });
    res.json({ item: r.rows[0], paid: parseFloat(sums.paid), due });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/items/:iid/adjust', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const amount = money(req.body?.amount);
    const reason = clean(req.body?.reason, 500);
    if (!amount || !reason) return res.status(400).json({ error: 'Give an amount (negative to deduct) and a reason' });
    await pool.query('INSERT INTO payroll_adjustments(item_id,store_id,amount,currency,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)', [item.id, req.params.sid, amount, item.currency, reason, String(req.user?.name || actorId(req))]);
    if (item.status === 'paid') await pool.query("UPDATE payroll_items SET status='approved', updated_at=NOW() WHERE id=$1 AND $2 > 0", [item.id, amount]);
    await audit(req.params.sid, req, 'payroll_adjusted', 'payroll', item.id, { amount, currency: item.currency, reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/payroll/items/:iid/cancel', auth, async (req, res) => {
  try {
    const item = await itemFor(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status === 'paid') return res.status(409).json({ error: 'A paid payroll cannot be cancelled. Add an adjustment instead.' });
    await pool.query("UPDATE payroll_items SET status='cancelled', locked=TRUE, updated_at=NOW() WHERE id=$1", [item.id]);
    await audit(req.params.sid, req, 'payroll_cancelled', 'payroll', item.id, { worker: item.worker_name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stores/:sid/payroll/export', auth, async (req, res) => {
  try {
    const now = thisMonth();
    const year = parseInt(req.query.year) || now.year, month = parseInt(req.query.month) || now.month;
    const period = await getPeriod(req.params.sid, year, month, false);
    const items = period ? (await periodView(req.params.sid, period.id)).items : [];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Worker', 'Job', 'Currency', 'Fixed salary', 'Confirmed orders', 'Prepared orders', 'Completed orders', 'Commission', 'Bonuses', 'Deductions', 'Adjustments', 'Net salary', 'Paid', 'Status'];
    const lines = items.map((i) => {
      const bd = Array.isArray(i.breakdown) ? i.breakdown : [];
      const n = (a) => (i.counts && i.counts[a] != null ? i.counts[a] : bd.filter((l) => l.action === a).reduce((s, l) => s + (l.count || 0), 0));
      return [i.worker_name, i.job_type, i.currency, i.fixed_amount, n('confirmed'), n('prepared'), n('completed'), i.commission_amount, i.bonuses, i.deductions, i.adjustments, money((parseFloat(i.net_amount) || 0) + (parseFloat(i.adjustments) || 0)), i.paid, i.status].map(esc).join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${year}-${String(month).padStart(2, '0')}.csv"`);
    res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/stores/:sid/payroll/settings', auth, async (req, res) => {
  try {
    const cfg = await storeCfg(req.params.sid);
    const fx = {};
    for (const c of ['USD', 'EUR']) { const v = parseFloat(req.body?.fx_rates?.[c]); if (v > 0) fx[c] = Math.round(v * 10000) / 10000; }
    cfg.fx_rates = Object.keys(fx).length ? { ...fx, updated_at: new Date().toISOString() } : null;
    await saveStoreCfg(req.params.sid, cfg);
    await audit(req.params.sid, req, 'exchange_rates_updated', 'payroll', null, { after: cfg.fx_rates });
    res.json({ fx_rates: cfg.fx_rates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.computeEarnings = computeEarnings;

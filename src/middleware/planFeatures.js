// =============================================================================
// PLAN FEATURE GATING
// -----------------------------------------------------------------------------
// Reads the store owner's current subscription plan and exposes:
//   • req.planFeatures        — Set of canonical feature keys ("ai_chatbot"…)
//   • req.planLimits          — { max_products, max_orders_month, max_staff }
//   • req.planSlug            — owner's plan slug ('starter', 'pro', etc.)
//
// `requireFeature(key)`  → 402 if the owner's plan doesn't include `key`.
// `enforceQuota({type})` → 402 if a quota would be exceeded.
//
// All numbers default to 0 which means "unlimited" so existing free accounts
// keep working until the super-admin sets explicit limits in the Plans editor.
// =============================================================================
const pool = require('../config/db');

const parseArr = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

// In-memory cache so we don't hit the DB on every gated request. Plans rarely
// change so a 30-second TTL is plenty.
const planCache = new Map(); // slug -> { exp, data }
const PLAN_TTL = 30_000;

async function getPlanBySlug(slug) {
  if (!slug) return null;
  const cached = planCache.get(slug);
  if (cached && cached.exp > Date.now()) return cached.data;
  try {
    const r = await pool.query('SELECT * FROM plans WHERE slug=$1 LIMIT 1', [slug]);
    const row = r.rows[0] || null;
    const data = row ? {
      slug: row.slug,
      feature_keys: parseArr(row.feature_keys),
      max_products: parseInt(row.max_products) || 0,
      max_orders_month: parseInt(row.max_orders_month) || 0,
      max_staff: parseInt(row.max_staff) || 0,
    } : null;
    planCache.set(slug, { exp: Date.now() + PLAN_TTL, data });
    return data;
  } catch { return null; }
}

// Loads the requesting owner's plan + features and stashes them on req.
// Safe to use after authMiddleware(['store_owner']).
async function loadPlanFeatures(req, _res, next) {
  try {
    const ownerId = req.user?.id;
    if (!ownerId) return next();
    const o = await pool.query('SELECT subscription_plan,subscription_status FROM store_owners WHERE id=$1', [ownerId]);
    const slug = o.rows[0]?.subscription_plan || 'free';
    const status = o.rows[0]?.subscription_status || 'active';
    req.planSlug = slug;
    req.planStatus = status;
    const plan = await getPlanBySlug(slug);
    req.planFeatures = new Set(plan?.feature_keys || []);
    req.planLimits = {
      max_products: plan?.max_products || 0,
      max_orders_month: plan?.max_orders_month || 0,
      max_staff: plan?.max_staff || 0,
    };
  } catch {
    req.planFeatures = new Set();
    req.planLimits = { max_products: 0, max_orders_month: 0, max_staff: 0 };
  }
  next();
}

// Hard-block — return HTTP 402 with a clear upgrade hint.
function requireFeature(key) {
  return async (req, res, next) => {
    if (!req.planFeatures) await loadPlanFeatures(req, res, () => {});
    if (req.planFeatures && req.planFeatures.has(key)) return next();
    return res.status(402).json({
      error: 'feature_locked',
      feature: key,
      message: `Your current plan does not include "${key}". Upgrade your subscription to unlock it.`,
    });
  };
}

// Pre-action quota check. Pass `{ type: 'products' | 'orders_month' | 'staff' }`.
function enforceQuota({ type }) {
  return async (req, res, next) => {
    try {
      if (!req.planLimits) await loadPlanFeatures(req, res, () => {});
      const limits = req.planLimits || {};
      const max = limits[`max_${type}`] || 0;
      if (max <= 0) return next(); // 0 = unlimited
      const ownerId = req.user?.id;
      let used = 0;
      if (type === 'products') {
        const q = await pool.query(
          `SELECT COUNT(*)::int AS c FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id=$1)`,
          [ownerId]
        );
        used = q.rows[0]?.c || 0;
      } else if (type === 'orders_month') {
        const q = await pool.query(
          `SELECT COUNT(*)::int AS c FROM orders WHERE store_id IN (SELECT id FROM stores WHERE owner_id=$1) AND created_at > date_trunc('month', NOW())`,
          [ownerId]
        );
        used = q.rows[0]?.c || 0;
      } else if (type === 'staff') {
        const q = await pool.query(
          `SELECT COUNT(*)::int AS c FROM store_staff WHERE store_id IN (SELECT id FROM stores WHERE owner_id=$1)`,
          [ownerId]
        ).catch(() => ({ rows: [{ c: 0 }] }));
        used = q.rows[0]?.c || 0;
      }
      if (used >= max) {
        return res.status(402).json({
          error: 'quota_exceeded',
          quota: type,
          used,
          limit: max,
          message: `Your plan allows ${max} ${type.replace('_', ' ')}. Upgrade to add more.`,
        });
      }
    } catch (e) { /* fail-open so the platform never bricks itself on a quota check */ }
    next();
  };
}

// Helper for routes that just need an inline check.
function hasFeature(req, key) {
  return !!(req.planFeatures && req.planFeatures.has(key));
}

// Bust the cache when plans are edited.
function invalidatePlanCache(slug) {
  if (slug) planCache.delete(slug);
  else planCache.clear();
}

module.exports = {
  loadPlanFeatures,
  requireFeature,
  enforceQuota,
  hasFeature,
  invalidatePlanCache,
};

// Admin API for offers and coupons, and the numbers they generated.
// Mounted under /api/manage, next to products and orders.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { ensurePromotionsSchema } = require('../config/promotionsSchema');
const { forgetPromotions } = require('../services/pricing');

const auth = authMiddleware(['store_owner', 'store_staff']);

const OFFER_TYPES = ['percentage', 'fixed', 'tiered', 'bxgy', 'free_shipping'];
const SCOPES = ['all', 'products', 'variants', 'categories'];
const COUPON_TYPES = ['percent', 'fixed', 'free_shipping'];

const str = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const int = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : 0; };
const bool = (v, dflt = false) => (v === undefined ? dflt : !!v);
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 2000) : []);
// An empty datetime box means "no limit", not 1970.
const when = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// Tiers arrive from the "Buy more & save" editor as rows of boxes; keep the
// ones that say something and sort them so the storefront can show a ladder.
function cleanTiers(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((t) => ({
      quantity: int(t.quantity),
      total_price: t.total_price === '' || t.total_price == null ? null : num(t.total_price),
      discount_type: t.discount_type === 'fixed' ? 'fixed' : 'percent',
      discount_value: num(t.discount_value),
      label: str(t.label, 120) || null,
    }))
    .filter((t) => t.quantity > 0 && (t.total_price != null || t.discount_value > 0))
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 20);
}

function offerFromBody(b = {}) {
  const offer_type = OFFER_TYPES.includes(b.offer_type) ? b.offer_type : 'percentage';
  const scope = SCOPES.includes(b.scope) ? b.scope : 'all';
  return {
    name: str(b.name) || 'Offer',
    internal_name: str(b.internal_name),
    description: str(b.description, 2000),
    offer_type,
    scope,
    product_ids: JSON.stringify(list(b.product_ids)),
    variant_keys: JSON.stringify(list(b.variant_keys)),
    category_ids: JSON.stringify(list(b.category_ids)),
    discount_percent: Math.max(0, Math.min(100, num(b.discount_percent))),
    discount_amount: Math.max(0, num(b.discount_amount)),
    buy_quantity: Math.max(0, int(b.buy_quantity)),
    get_quantity: Math.max(0, int(b.get_quantity)),
    get_discount_percent: b.get_discount_percent == null ? 100 : Math.max(0, Math.min(100, num(b.get_discount_percent))),
    tiers: JSON.stringify(cleanTiers(b.tiers)),
    offer_price: b.offer_price === '' || b.offer_price == null ? null : Math.max(0, num(b.offer_price)),
    min_quantity: Math.max(0, int(b.min_quantity)),
    max_quantity: Math.max(0, int(b.max_quantity)),
    min_order_amount: Math.max(0, num(b.min_order_amount)),
    max_discount: Math.max(0, num(b.max_discount)),
    starts_at: when(b.starts_at),
    ends_at: when(b.ends_at),
    usage_limit: Math.max(0, int(b.usage_limit)),
    usage_per_customer: Math.max(0, int(b.usage_per_customer)),
    priority: int(b.priority),
    status: b.status === 'paused' ? 'paused' : 'active',
    show_on_product: bool(b.show_on_product, true),
    show_on_storefront: bool(b.show_on_storefront, true),
    show_at_checkout: bool(b.show_at_checkout, true),
    badge_text: str(b.badge_text, 80),
  };
}

function couponFromBody(b = {}) {
  const discount_type = COUPON_TYPES.includes(b.discount_type) ? b.discount_type : 'percent';
  return {
    code: String(b.code || '').trim().toUpperCase().slice(0, 60),
    name: str(b.name),
    description: str(b.description, 2000),
    discount_type,
    discount_percent: Math.max(0, Math.min(100, num(b.discount_percent))),
    discount_amount: Math.max(0, num(b.discount_amount)),
    max_discount: Math.max(0, num(b.max_discount)),
    min_order_amount: Math.max(0, num(b.min_order_amount)),
    min_quantity: Math.max(0, int(b.min_quantity)),
    max_quantity: Math.max(0, int(b.max_quantity)),
    product_ids: JSON.stringify(list(b.product_ids)),
    variant_keys: JSON.stringify(list(b.variant_keys)),
    category_ids: JSON.stringify(list(b.category_ids)),
    excluded_product_ids: JSON.stringify(list(b.excluded_product_ids)),
    excluded_category_ids: JSON.stringify(list(b.excluded_category_ids)),
    free_shipping: bool(b.free_shipping) || discount_type === 'free_shipping',
    stackable: bool(b.stackable),
    starts_at: when(b.starts_at),
    ends_at: when(b.ends_at),
    usage_limit: Math.max(0, int(b.usage_limit)),
    usage_per_customer: Math.max(0, int(b.usage_per_customer)),
    status: b.status === 'paused' ? 'paused' : 'active',
  };
}

function insertSql(table, row) {
  const keys = Object.keys(row);
  const cols = keys.join(',');
  const vals = keys.map((k, i) => (/_ids$|_keys$|^tiers$/.test(k) ? `$${i + 2}::jsonb` : `$${i + 2}`)).join(',');
  return { text: `INSERT INTO ${table}(store_id,${cols}) VALUES($1,${vals}) RETURNING *`, keys };
}
function updateSql(table, row) {
  const keys = Object.keys(row);
  const sets = keys.map((k, i) => `${k}=$${i + 3}${/_ids$|_keys$|^tiers$/.test(k) ? '::jsonb' : ''}`).join(',');
  return { text: `UPDATE ${table} SET ${sets}, updated_at=NOW() WHERE id=$2 AND store_id=$1 RETURNING *`, keys };
}

// ── OFFERS ─────────────────────────────────────────────────────────────────
router.get('/stores/:sid/offers', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const { status, type, q } = req.query;
    const p = [req.params.sid];
    let sql = 'SELECT * FROM offers WHERE store_id=$1';
    if (status === 'active' || status === 'paused') { p.push(status); sql += ` AND status=$${p.length}`; }
    if (status === 'scheduled') sql += ' AND starts_at IS NOT NULL AND starts_at > NOW()';
    if (status === 'expired') sql += ' AND ends_at IS NOT NULL AND ends_at < NOW()';
    if (status === 'running') sql += " AND status='active' AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW())";
    if (type && OFFER_TYPES.includes(type)) { p.push(type); sql += ` AND offer_type=$${p.length}`; }
    if (q && String(q).trim()) { p.push(`%${String(q).trim()}%`); sql += ` AND (name ILIKE $${p.length} OR internal_name ILIKE $${p.length})`; }
    sql += ' ORDER BY priority DESC, created_at DESC';
    const r = await pool.query(sql, p);
    res.json({ offers: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/offers', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const row = offerFromBody(req.body);
    const { text, keys } = insertSql('offers', row);
    const r = await pool.query(text, [req.params.sid, ...keys.map((k) => row[k])]);
    forgetPromotions(req.params.sid);
    res.json({ offer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/stores/:sid/offers/:id', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const row = offerFromBody(req.body);
    const { text, keys } = updateSql('offers', row);
    const r = await pool.query(text, [req.params.sid, req.params.id, ...keys.map((k) => row[k])]);
    if (!r.rows.length) return res.status(404).json({ error: 'Offer not found' });
    forgetPromotions(req.params.sid);
    res.json({ offer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/stores/:sid/offers/:id/status', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const status = req.body?.status === 'paused' ? 'paused' : 'active';
    const r = await pool.query('UPDATE offers SET status=$1, updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *', [status, req.params.id, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Offer not found' });
    forgetPromotions(req.params.sid);
    res.json({ offer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/stores/:sid/offers/:id', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    // Redemptions are deliberately left behind: the orders that used this
    // offer keep their own copy, and the figures stay honest.
    const r = await pool.query('DELETE FROM offers WHERE id=$1 AND store_id=$2 RETURNING id', [req.params.id, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Offer not found' });
    forgetPromotions(req.params.sid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COUPONS ────────────────────────────────────────────────────────────────
router.get('/stores/:sid/promo-coupons', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const { status, q } = req.query;
    const p = [req.params.sid];
    let sql = 'SELECT * FROM coupons WHERE store_id=$1';
    if (status === 'active' || status === 'paused') { p.push(status); sql += ` AND status=$${p.length}`; }
    if (status === 'expired') sql += ' AND ends_at IS NOT NULL AND ends_at < NOW()';
    if (status === 'scheduled') sql += ' AND starts_at IS NOT NULL AND starts_at > NOW()';
    if (q && String(q).trim()) { p.push(`%${String(q).trim()}%`); sql += ` AND (code ILIKE $${p.length} OR name ILIKE $${p.length})`; }
    sql += ' ORDER BY created_at DESC';
    const r = await pool.query(sql, p);
    res.json({ coupons: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores/:sid/promo-coupons', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const row = couponFromBody(req.body);
    if (!row.code) return res.status(400).json({ error: 'A coupon needs a code' });
    const { text, keys } = insertSql('coupons', row);
    const r = await pool.query(text, [req.params.sid, ...keys.map((k) => row[k])]);
    forgetPromotions(req.params.sid);
    res.json({ coupon: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That code is already in use' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/stores/:sid/promo-coupons/:id', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const row = couponFromBody(req.body);
    if (!row.code) return res.status(400).json({ error: 'A coupon needs a code' });
    const { text, keys } = updateSql('coupons', row);
    const r = await pool.query(text, [req.params.sid, req.params.id, ...keys.map((k) => row[k])]);
    if (!r.rows.length) return res.status(404).json({ error: 'Coupon not found' });
    forgetPromotions(req.params.sid);
    res.json({ coupon: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That code is already in use' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/stores/:sid/promo-coupons/:id/status', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const status = req.body?.status === 'paused' ? 'paused' : 'active';
    const r = await pool.query('UPDATE coupons SET status=$1, updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *', [status, req.params.id, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Coupon not found' });
    forgetPromotions(req.params.sid);
    res.json({ coupon: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/stores/:sid/promo-coupons/:id', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const r = await pool.query('DELETE FROM coupons WHERE id=$1 AND store_id=$2 RETURNING id', [req.params.id, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Coupon not found' });
    forgetPromotions(req.params.sid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ──────────────────────────────────────────────────────────────
// Everything is read from the redemption rows, which are written once when an
// order is placed. Deleting an offer later does not rewrite history.
const range = (q) => {
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 29 * 86400000);
  const to = q.to ? new Date(q.to) : new Date();
  to.setHours(23, 59, 59, 999);
  return [from.toISOString(), to.toISOString()];
};

router.get('/stores/:sid/promotions/analytics', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const sid = req.params.sid;
    const [from, to] = range(req.query);
    const args = [sid, from, to];

    const offerTotals = (await pool.query(
      `SELECT r.offer_id, COALESCE(o.name, r.offer_name) AS name, COALESCE(o.offer_type, r.offer_type) AS offer_type,
              COUNT(DISTINCT r.order_id)::int AS orders,
              COALESCE(SUM(r.discount_amount),0)::float AS discount,
              COALESCE(SUM(r.order_total),0)::float AS revenue,
              o.usage_limit, o.used_count, o.status
       FROM offer_redemptions r LEFT JOIN offers o ON o.id = r.offer_id
       WHERE r.store_id=$1 AND r.created_at BETWEEN $2 AND $3
       GROUP BY r.offer_id, o.name, r.offer_name, o.offer_type, r.offer_type, o.usage_limit, o.used_count, o.status
       ORDER BY revenue DESC`, args)).rows;

    const couponTotals = (await pool.query(
      `SELECT r.coupon_id, COALESCE(c.code, r.code) AS code, c.name,
              COUNT(*)::int AS uses, COUNT(DISTINCT COALESCE(r.customer_id::text, r.customer_phone))::int AS customers,
              COALESCE(SUM(r.discount_amount),0)::float AS discount,
              COALESCE(SUM(r.order_total),0)::float AS revenue,
              c.usage_limit, c.used_count, c.status
       FROM coupon_redemptions r LEFT JOIN coupons c ON c.id = r.coupon_id
       WHERE r.store_id=$1 AND r.created_at BETWEEN $2 AND $3
       GROUP BY r.coupon_id, c.code, r.code, c.name, c.usage_limit, c.used_count, c.status
       ORDER BY revenue DESC`, args)).rows;

    const byDay = (await pool.query(
      `SELECT d::date AS day,
              COALESCE((SELECT SUM(discount_amount) FROM offer_redemptions WHERE store_id=$1 AND created_at::date = d::date),0)::float AS offer_discount,
              COALESCE((SELECT SUM(discount_amount) FROM coupon_redemptions WHERE store_id=$1 AND created_at::date = d::date),0)::float AS coupon_discount,
              COALESCE((SELECT SUM(order_total) FROM coupon_redemptions WHERE store_id=$1 AND created_at::date = d::date),0)::float AS coupon_revenue
       FROM generate_series($2::date, $3::date, '1 day') d ORDER BY day`, args)).rows;

    const topProducts = (await pool.query(
      `SELECT oi.product_id, MAX(oi.product_name) AS name,
              SUM(oi.quantity)::int AS units,
              COALESCE(SUM(oi.discount_amount),0)::float AS discount,
              COALESCE(SUM(oi.total_price),0)::float AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.store_id=$1 AND o.created_at BETWEEN $2 AND $3 AND COALESCE(oi.discount_amount,0) > 0
       GROUP BY oi.product_id ORDER BY discount DESC LIMIT 10`, args)).rows;

    // How many orders in the window used a promotion at all, against the rest.
    const overall = (await pool.query(
      `SELECT COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE COALESCE(offer_discount,0) + COALESCE(coupon_discount,0) > 0)::int AS promo_orders,
              COALESCE(SUM(total),0)::float AS revenue,
              COALESCE(SUM(total) FILTER (WHERE COALESCE(offer_discount,0) + COALESCE(coupon_discount,0) > 0),0)::float AS promo_revenue,
              COALESCE(SUM(COALESCE(offer_discount,0) + COALESCE(coupon_discount,0)),0)::float AS saved
       FROM orders WHERE store_id=$1 AND created_at BETWEEN $2 AND $3 AND (is_deleted IS NOT TRUE)`, args)).rows[0];

    const promoOrders = overall.promo_orders || 0;
    res.json({
      from, to,
      overall: {
        ...overall,
        // the share of orders that used a promotion
        conversion_rate: overall.orders ? Math.round((promoOrders / overall.orders) * 1000) / 10 : 0,
        avg_order_value: promoOrders ? Math.round((overall.promo_revenue / promoOrders) * 100) / 100 : 0,
      },
      offers: offerTotals.map((o) => ({
        ...o,
        avg_order_value: o.orders ? Math.round((o.revenue / o.orders) * 100) / 100 : 0,
        remaining: o.usage_limit > 0 ? Math.max(0, o.usage_limit - (o.used_count || 0)) : null,
      })),
      coupons: couponTotals.map((c) => ({
        ...c,
        avg_order_value: c.uses ? Math.round((c.revenue / c.uses) * 100) / 100 : 0,
        remaining: c.usage_limit > 0 ? Math.max(0, c.usage_limit - (c.used_count || 0)) : null,
      })),
      by_day: byDay,
      top_products: topProducts,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Who used one coupon, and when.
router.get('/stores/:sid/promo-coupons/:id/redemptions', auth, async (req, res) => {
  try {
    await ensurePromotionsSchema();
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const total = (await pool.query('SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE store_id=$1 AND coupon_id=$2', [req.params.sid, req.params.id])).rows[0].n;
    const rows = (await pool.query(
      `SELECT r.*, o.order_number, o.customer_name FROM coupon_redemptions r
       LEFT JOIN orders o ON o.id = r.order_id
       WHERE r.store_id=$1 AND r.coupon_id=$2 ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [req.params.sid, req.params.id, limit, offset])).rows;
    res.json({ total, redemptions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

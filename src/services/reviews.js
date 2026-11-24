// Everything the review routes need that is not routing: what a shop has
// switched on, whether someone may review, what the overall score is, a
// first pass at spotting junk, and the running totals a product page reads.
const pool = require('../config/db');
const { ensureReviewsSchema } = require('../config/reviewsSchema');

const CRITERIA = ['product_quality', 'description_accuracy', 'packaging', 'delivery_speed', 'value_for_money'];
const STATUSES = ['pending', 'approved', 'rejected', 'hidden', 'reported'];
const REPORT_REASONS = ['spam', 'offensive', 'fake', 'personal_info', 'irrelevant', 'other'];

// ── settings ───────────────────────────────────────────────────────────────
// Defaults are what a shop gets before it touches the settings page, chosen
// so reviews work sensibly out of the box: on, verified badges, photos, no
// forced approval queue for the shop to wade through.
const DEFAULTS = {
  enabled: true,
  verified_badge: true,
  require_approval: false,
  allow_photos: true,
  allow_videos: true,
  allow_seller_replies: true,
  allow_helpful_votes: true,
  allow_editing: true,
  editing_window_hours: 48,
  enable_reports: true,
  ai_moderation: false,
  ai_analytics: false,
  auto_request: false,
  request_delay_days: 2,
  auto_reminder: false,
  reminder_delay_days: 3,
  max_photos: 5,
  max_videos: 1,
  max_video_seconds: 30,
  max_photo_mb: 8,
  max_video_mb: 50,
  // optional, and never conditional on the rating given
  reward_enabled: false,
  reward_points: 0,
  reward_points_photo: 0,
  reward_points_video: 0,
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

async function storeConfig(storeId) {
  const r = await pool.query('SELECT config FROM stores WHERE id=$1', [storeId]);
  let c = r.rows[0]?.config || {};
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  return c;
}

async function getSettings(storeId) {
  await ensureReviewsSchema();
  const cfg = await storeConfig(storeId);
  const s = cfg.reviews || {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (s[k] === undefined) continue;
    out[k] = typeof DEFAULTS[k] === 'boolean' ? !!s[k] : num(s[k], DEFAULTS[k]);
  }
  // The old single switch stays meaningful: a shop that turned on Smart
  // Reviews gets AI moderation without setting it again.
  if (s.ai_moderation === undefined && cfg.smart_reviews) out.ai_moderation = true;
  out.max_photos = Math.max(0, Math.min(10, out.max_photos));
  out.max_videos = Math.max(0, Math.min(3, out.max_videos));
  out.max_video_seconds = Math.max(5, Math.min(300, out.max_video_seconds));
  return out;
}

async function saveSettings(storeId, body = {}) {
  await ensureReviewsSchema();
  const cfg = await storeConfig(storeId);
  const next = { ...(cfg.reviews || {}) };
  for (const k of Object.keys(DEFAULTS)) {
    if (body[k] === undefined) continue;
    next[k] = typeof DEFAULTS[k] === 'boolean' ? !!body[k] : num(body[k], DEFAULTS[k]);
  }
  cfg.reviews = next;
  await pool.query('UPDATE stores SET config=$1::jsonb WHERE id=$2', [JSON.stringify(cfg), storeId]);
  return getSettings(storeId);
}

// ── scoring ────────────────────────────────────────────────────────────────
// The overall is the mean of the criteria that were actually given, to one
// decimal place. It is never read from the request body.
function overallFrom(ratings = {}) {
  const given = CRITERIA.map((k) => Number(ratings[k])).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  if (!given.length) return null;
  return Math.round((given.reduce((a, b) => a + b, 0) / given.length) * 10) / 10;
}

// Clean the five criteria out of a request body: whole stars, 1 to 5, and
// nothing else.
function readCriteria(body = {}) {
  const out = {};
  for (const k of CRITERIA) {
    const v = Math.round(Number(body[`${k}_rating`] ?? body[k]));
    if (Number.isFinite(v) && v >= 1 && v <= 5) out[k] = v;
  }
  return out;
}

const sentimentOf = (overall) => (overall >= 4 ? 'positive' : overall <= 2 ? 'negative' : 'neutral');

// ── who may review ─────────────────────────────────────────────────────────
// A review is tied to the thing that was bought, not just to the product, so
// someone who bought the same item twice may review each one, and the exact
// variant stays attached to what they said.
const digits = (v) => String(v || '').replace(/\D/g, '');

async function eligiblePurchases(storeId, productId, { customerId = null, phone = null } = {}) {
  await ensureReviewsSchema();
  const tail = digits(phone).slice(-9);
  if (!customerId && !tail) return [];
  const r = await pool.query(
    `SELECT oi.id AS order_item_id, oi.order_id, oi.variant_info, oi.product_name,
            o.status, o.created_at, o.customer_id, o.customer_phone,
            (SELECT COUNT(*)::int FROM reviews rv WHERE rv.order_item_id = oi.id) AS reviewed
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.store_id = $1 AND oi.product_id = $2
       AND (o.is_deleted IS NOT TRUE)
       AND ( ($3::uuid IS NOT NULL AND o.customer_id = $3)
          OR ($4::text <> '' AND RIGHT(regexp_replace(COALESCE(o.customer_phone,''), '\\D', '', 'g'), 9) = $4) )
     ORDER BY o.created_at DESC`,
    [storeId, productId, customerId || null, tail]);
  return r.rows;
}

// The purchase a new review should attach to: the most recent one that has
// not been reviewed yet.
async function purchaseToReview(storeId, productId, who) {
  const rows = await eligiblePurchases(storeId, productId, who);
  if (!rows.length) return { ok: false, reason: 'not_purchased' };
  const free = rows.find((x) => !x.reviewed);
  if (!free) return { ok: false, reason: 'already_reviewed', purchases: rows.length };
  return { ok: true, purchase: free, purchases: rows.length };
}

// ── a first pass at junk ───────────────────────────────────────────────────
// Deliberately blunt and deliberately not about the rating: a one-star review
// is not spam, and nothing here may reject a review for being negative. It
// only flags what looks mechanical so a human can look.
const BAD_WORDS = ['viagra', 'casino', 'porn', 'xxx', 'crypto giveaway', 'bitcoin profit', 'fuck', 'shit', 'bitch'];
const URL_RE = /(https?:\/\/|www\.)\S+/i;
const CONTACT_RE = /(\+?\d[\d\s().-]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]+)/;

function spamCheck(text = '', { criteria = {} } = {}) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  const flags = [];
  if (URL_RE.test(t)) flags.push('link');
  if (CONTACT_RE.test(t)) flags.push('contact_details');
  if (BAD_WORDS.some((w) => lower.includes(w))) flags.push('offensive');
  // the same character twenty times over, or the same word on a loop
  if (/(.)\1{14,}/.test(t)) flags.push('repetition');
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size <= Math.ceil(words.length / 4)) flags.push('repetition');
  if (t.length > 40 && t === t.toUpperCase() && /[A-Z]/.test(t)) flags.push('shouting');
  // every criterion at the extreme with nothing written is worth a look
  const vals = Object.values(criteria);
  if (!t && vals.length >= 5 && (vals.every((v) => v === 5) || vals.every((v) => v === 1))) flags.push('no_text');
  return { flags, suspicious: flags.some((f) => f !== 'no_text') };
}

// How often one person may post. A shop's reviews should not be writable in
// bulk from one browser.
async function tooFrequent(storeId, { customerId, phone }) {
  const tail = digits(phone).slice(-9);
  if (!customerId && !tail) return false;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reviews
     WHERE store_id=$1 AND created_at > NOW() - INTERVAL '1 hour'
       AND ( ($2::uuid IS NOT NULL AND customer_id=$2)
          OR ($3::text <> '' AND RIGHT(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), 9) = $3) )`,
    [storeId, customerId || null, tail]);
  return (r.rows[0]?.n || 0) >= 5;
}

// ── the running totals ─────────────────────────────────────────────────────
// Rewritten whenever a review on the product changes. A product page then
// reads one row instead of counting a table.
async function recomputeProductStats(productId) {
  if (!productId) return null;
  await ensureReviewsSchema();
  const r = await pool.query(
    `SELECT store_id,
            COUNT(*)::int AS total,
            ROUND(AVG(COALESCE(overall_rating, rating))::numeric, 1) AS overall,
            ROUND(AVG(product_quality_rating)::numeric, 1) AS product_quality,
            ROUND(AVG(description_accuracy_rating)::numeric, 1) AS description_accuracy,
            ROUND(AVG(packaging_rating)::numeric, 1) AS packaging,
            ROUND(AVG(delivery_speed_rating)::numeric, 1) AS delivery_speed,
            ROUND(AVG(value_for_money_rating)::numeric, 1) AS value_for_money,
            COUNT(*) FILTER (WHERE ROUND(COALESCE(overall_rating, rating)) = 5)::int AS star5,
            COUNT(*) FILTER (WHERE ROUND(COALESCE(overall_rating, rating)) = 4)::int AS star4,
            COUNT(*) FILTER (WHERE ROUND(COALESCE(overall_rating, rating)) = 3)::int AS star3,
            COUNT(*) FILTER (WHERE ROUND(COALESCE(overall_rating, rating)) = 2)::int AS star2,
            COUNT(*) FILTER (WHERE ROUND(COALESCE(overall_rating, rating)) <= 1)::int AS star1,
            COUNT(*) FILTER (WHERE verified_purchase)::int AS verified_count,
            COUNT(*) FILTER (WHERE has_photos)::int AS with_photos,
            COUNT(*) FILTER (WHERE has_video)::int AS with_videos,
            COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) >= 4)::int AS positive,
            COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) = 3)::int AS neutral,
            COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) <= 2)::int AS negative
     FROM reviews WHERE product_id=$1 AND status='approved' GROUP BY store_id`, [productId]);
  const s = r.rows[0];
  if (!s) {
    await pool.query('DELETE FROM product_review_stats WHERE product_id=$1', [productId]);
    return null;
  }
  await pool.query(
    `INSERT INTO product_review_stats(product_id,store_id,total,overall,product_quality,description_accuracy,
       packaging,delivery_speed,value_for_money,star5,star4,star3,star2,star1,verified_count,with_photos,
       with_videos,positive,neutral,negative,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
     ON CONFLICT (product_id) DO UPDATE SET store_id=EXCLUDED.store_id,total=EXCLUDED.total,overall=EXCLUDED.overall,
       product_quality=EXCLUDED.product_quality,description_accuracy=EXCLUDED.description_accuracy,
       packaging=EXCLUDED.packaging,delivery_speed=EXCLUDED.delivery_speed,value_for_money=EXCLUDED.value_for_money,
       star5=EXCLUDED.star5,star4=EXCLUDED.star4,star3=EXCLUDED.star3,star2=EXCLUDED.star2,star1=EXCLUDED.star1,
       verified_count=EXCLUDED.verified_count,with_photos=EXCLUDED.with_photos,with_videos=EXCLUDED.with_videos,
       positive=EXCLUDED.positive,neutral=EXCLUDED.neutral,negative=EXCLUDED.negative,updated_at=NOW()`,
    [productId, s.store_id, s.total, s.overall, s.product_quality, s.description_accuracy, s.packaging,
      s.delivery_speed, s.value_for_money, s.star5, s.star4, s.star3, s.star2, s.star1, s.verified_count,
      s.with_photos, s.with_videos, s.positive, s.neutral, s.negative]);
  return s;
}

async function productStats(productId) {
  await ensureReviewsSchema();
  const r = await pool.query('SELECT * FROM product_review_stats WHERE product_id=$1', [productId]);
  if (r.rows[0]) return r.rows[0];
  return recomputeProductStats(productId);
}

// ── the moderation trail ───────────────────────────────────────────────────
async function logModeration({ reviewId, storeId, action, fromStatus, toStatus, actor, actorStaffId, reason }) {
  try {
    await pool.query(
      `INSERT INTO review_moderation_log(review_id,store_id,action,from_status,to_status,actor,actor_staff_id,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [reviewId, storeId, action, fromStatus || null, toStatus || null, actor || null, actorStaffId || null, reason || null]);
  } catch (e) { console.log('[review log]', e.message); }
}

// `status` is what everything reads now; the two old booleans are kept in
// step so code written before this still behaves.
async function setStatus(reviewId, storeId, status, meta = {}) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status');
  const before = (await pool.query('SELECT status, product_id FROM reviews WHERE id=$1 AND store_id=$2', [reviewId, storeId])).rows[0];
  if (!before) return null;
  const r = await pool.query(
    `UPDATE reviews SET status=$1, is_approved=$2, is_rejected=$3, updated_at=NOW()
     WHERE id=$4 AND store_id=$5 RETURNING *`,
    [status, status === 'approved', status === 'rejected', reviewId, storeId]);
  await logModeration({
    reviewId, storeId, action: meta.action || status, fromStatus: before.status, toStatus: status,
    actor: meta.actor, actorStaffId: meta.actorStaffId, reason: meta.reason,
  });
  await recomputeProductStats(before.product_id);
  return r.rows[0];
}

module.exports = {
  CRITERIA, STATUSES, REPORT_REASONS, DEFAULTS,
  getSettings, saveSettings,
  overallFrom, readCriteria, sentimentOf,
  eligiblePurchases, purchaseToReview,
  spamCheck, tooFrequent,
  recomputeProductStats, productStats,
  logModeration, setStatus,
};

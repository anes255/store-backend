// The dashboard side of reviews, for what the existing routes in orders.js
// do not cover: the statuses beyond approve/reject, seller replies, the
// numbers, and the settings page.
//
// Approve, reject, delete and the moderation list stay where they already
// were; nothing here replaces them.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { ensureReviewsSchema } = require('../config/reviewsSchema');
const R = require('../services/reviews');

const auth = authMiddleware(['store_owner', 'store_staff']);
const actorOf = (req) => req.user?.name || req.user?.full_name || 'Owner';

// ── moderation beyond approve / reject ─────────────────────────────────────
// hide, restore, mark reported — each one writes to the log, so there is a
// record of who did what to a customer's words.
router.patch('/stores/:sid/reviews/:rid/status', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const status = req.body?.status;
    if (!R.STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    const row = await R.setStatus(req.params.rid, req.params.sid, status, {
      actor: actorOf(req), actorStaffId: req.staffRowId || null, reason: req.body?.reason, action: req.body?.action || status,
    });
    if (!row) return res.status(404).json({ error: 'Review not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the shop's reply ───────────────────────────────────────────────────────
// One official reply per review, editable afterwards.
router.put('/stores/:sid/reviews/:rid/response', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const settings = await R.getSettings(req.params.sid);
    if (!settings.allow_seller_replies) return res.status(403).json({ error: 'Replies are turned off' });
    const text = String(req.body?.response || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Write a reply first' });
    const r = await pool.query(
      `UPDATE reviews SET seller_response=$1, seller_response_at=NOW(), seller_response_by=$2, updated_at=NOW()
       WHERE id=$3 AND store_id=$4 RETURNING *`,
      [text, actorOf(req), req.params.rid, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review not found' });
    await R.logModeration({ reviewId: req.params.rid, storeId: req.params.sid, action: 'replied', actor: actorOf(req) });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/stores/:sid/reviews/:rid/response', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const r = await pool.query(
      `UPDATE reviews SET seller_response=NULL, seller_response_at=NULL, seller_response_by=NULL, updated_at=NOW()
       WHERE id=$1 AND store_id=$2 RETURNING id`, [req.params.rid, req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── settings ───────────────────────────────────────────────────────────────
router.get('/stores/:sid/review-settings', auth, async (req, res) => {
  try { res.json(await R.getSettings(req.params.sid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/stores/:sid/review-settings', auth, async (req, res) => {
  try { res.json(await R.saveSettings(req.params.sid, req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the numbers ────────────────────────────────────────────────────────────
const range = (q) => {
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 29 * 86400000);
  const to = q.to ? new Date(q.to) : new Date();
  to.setHours(23, 59, 59, 999);
  return [from.toISOString(), to.toISOString()];
};

router.get('/stores/:sid/review-analytics', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const sid = req.params.sid;
    const [from, to] = range(req.query);
    const args = [sid, from, to];

    const totals = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              ROUND(AVG(COALESCE(overall_rating, rating))::numeric,1) AS overall,
              COUNT(*) FILTER (WHERE verified_purchase)::int AS verified,
              COUNT(*) FILTER (WHERE has_photos)::int AS with_photos,
              COUNT(*) FILTER (WHERE has_video)::int AS with_videos,
              COUNT(*) FILTER (WHERE COALESCE(status,'pending')='pending')::int AS pending,
              COUNT(*) FILTER (WHERE COALESCE(status,'')='reported')::int AS reported,
              COUNT(*) FILTER (WHERE COALESCE(status,'')='hidden')::int AS hidden,
              ROUND(AVG(product_quality_rating)::numeric,1) AS product_quality,
              ROUND(AVG(description_accuracy_rating)::numeric,1) AS description_accuracy,
              ROUND(AVG(packaging_rating)::numeric,1) AS packaging,
              ROUND(AVG(delivery_speed_rating)::numeric,1) AS delivery_speed,
              ROUND(AVG(value_for_money_rating)::numeric,1) AS value_for_money,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) >= 4)::int AS positive,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) = 3)::int AS neutral,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) <= 2)::int AS negative
       FROM reviews WHERE store_id=$1 AND created_at BETWEEN $2 AND $3`, args)).rows[0];

    // Day by day, so the dashboard can show whether a criterion is drifting.
    const byDay = (await pool.query(
      `SELECT d::date AS day,
              COUNT(r.id)::int AS reviews,
              ROUND(AVG(COALESCE(r.overall_rating, r.rating))::numeric,1) AS overall,
              ROUND(AVG(r.product_quality_rating)::numeric,1) AS product_quality,
              ROUND(AVG(r.delivery_speed_rating)::numeric,1) AS delivery_speed
       FROM generate_series($2::date, $3::date, '1 day') d
       LEFT JOIN reviews r ON r.store_id=$1 AND r.created_at::date = d::date
       GROUP BY d ORDER BY d`, args)).rows;

    // Which products the reviews are about.
    const byProduct = (await pool.query(
      `SELECT r.product_id, MAX(p.name) AS name, COUNT(*)::int AS total,
              ROUND(AVG(COALESCE(r.overall_rating, r.rating))::numeric,1) AS overall,
              COUNT(*) FILTER (WHERE r.verified_purchase)::int AS verified,
              COUNT(*) FILTER (WHERE COALESCE(r.overall_rating, r.rating) <= 2)::int AS negative
       FROM reviews r LEFT JOIN products p ON p.id=r.product_id
       WHERE r.store_id=$1 AND r.created_at BETWEEN $2 AND $3
       GROUP BY r.product_id ORDER BY total DESC LIMIT 20`, args)).rows;

    res.json({
      from, to,
      totals: {
        ...totals,
        verified_percent: totals.total ? Math.round((totals.verified / totals.total) * 100) : 0,
        photo_percent: totals.total ? Math.round((totals.with_photos / totals.total) * 100) : 0,
        video_percent: totals.total ? Math.round((totals.with_videos / totals.total) * 100) : 0,
      },
      by_day: byDay,
      by_product: byProduct,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One product's own figures, for the product page in the dashboard.
router.get('/stores/:sid/products/:pid/review-stats', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const s = (await R.productStats(req.params.pid)) || {};
    const words = await keywordsFor(req.params.sid, req.params.pid);
    res.json({ stats: s, ...words });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── what customers keep saying ─────────────────────────────────────────────
// Counted from the reviews themselves, not invented: the words that come up
// most in happy reviews and in unhappy ones. No model is called, so this
// works for every shop and cannot put words in a customer's mouth.
const STOP = new Set(('the a an and or but of to in for with on at is was are be been it this that i we you they my our very really so just not no'
  + ' le la les un une des et ou de du en pour avec sur est sont ce cette je nous vous ils tres pas'
  + ' ال في من على مع هذا هذه هو هي انا نحن جدا لا ليس').split(/\s+/));

async function keywordsFor(storeId, productId = null) {
  const p = [storeId];
  let where = "store_id=$1 AND content IS NOT NULL AND content <> '' AND COALESCE(status,'pending')='approved'";
  if (productId) { p.push(productId); where += ` AND product_id=$${p.length}`; }
  const rows = (await pool.query(
    `SELECT content, COALESCE(overall_rating, rating) AS score FROM reviews WHERE ${where} ORDER BY created_at DESC LIMIT 2000`, p)).rows;

  const tally = (list) => {
    const counts = new Map();
    for (const text of list) {
      const seen = new Set();
      for (const w of String(text).toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
        if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
        seen.add(w);
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word, n]) => ({ word, count: n }));
  };

  const positive = tally(rows.filter((r) => Number(r.score) >= 4).map((r) => r.content));
  const negative = tally(rows.filter((r) => Number(r.score) <= 2).map((r) => r.content));
  return { positive_keywords: positive, negative_keywords: negative, sampled: rows.length };
}

router.get('/stores/:sid/review-keywords', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    res.json(await keywordsFor(req.params.sid, req.query.product_id || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the AI summary ─────────────────────────────────────────────────────────
// Optional, and only ever a summary: the model is given the figures and a
// sample of real reviews and asked to describe them. If it is unavailable,
// a plain summary is written from the same numbers rather than nothing.
router.get('/stores/:sid/review-insights', auth, async (req, res) => {
  try {
    await ensureReviewsSchema();
    const sid = req.params.sid;
    const settings = await R.getSettings(sid);
    const productId = req.query.product_id || null;

    const p = [sid];
    let where = "store_id=$1 AND COALESCE(status,'pending')='approved'";
    if (productId) { p.push(productId); where += ` AND product_id=$${p.length}`; }
    const agg = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              ROUND(AVG(COALESCE(overall_rating, rating))::numeric,1) AS overall,
              ROUND(AVG(product_quality_rating)::numeric,1) AS product_quality,
              ROUND(AVG(description_accuracy_rating)::numeric,1) AS description_accuracy,
              ROUND(AVG(packaging_rating)::numeric,1) AS packaging,
              ROUND(AVG(delivery_speed_rating)::numeric,1) AS delivery_speed,
              ROUND(AVG(value_for_money_rating)::numeric,1) AS value_for_money,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) >= 4)::int AS positive,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) = 3)::int AS neutral,
              COUNT(*) FILTER (WHERE COALESCE(overall_rating, rating) <= 2)::int AS negative
       FROM reviews WHERE ${where}`, p)).rows[0];
    const words = await keywordsFor(sid, productId);

    const named = [
      ['product quality', agg.product_quality], ['description accuracy', agg.description_accuracy],
      ['packaging', agg.packaging], ['delivery speed', agg.delivery_speed], ['value for money', agg.value_for_money],
    ].filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
    const loved = named.slice(0, 3).filter(([, v]) => v >= 4).map(([k, v]) => ({ area: k, score: Number(v) }));
    const problems = named.slice().reverse().filter(([, v]) => v < 4).slice(0, 3).map(([k, v]) => ({ area: k, score: Number(v) }));

    let summary = null;
    if (!agg.total) {
      summary = 'There are no approved reviews to summarise yet.';
    } else {
      summary = `${agg.total} review(s), averaging ${agg.overall} out of 5.`
        + (loved.length ? ` Customers rate ${loved.map((l) => l.area).join(' and ')} most highly.` : '')
        + (problems.length ? ` The weakest area is ${problems[0].area} at ${problems[0].score}.` : '')
        + (words.negative_keywords.length ? ` Words that recur in negative reviews: ${words.negative_keywords.slice(0, 4).map((w) => w.word).join(', ')}.` : '');
      if (settings.ai_analytics) {
        try {
          const chatbot = require('../services/chatbot');
          if (typeof chatbot.summarizeReviews === 'function') {
            const sample = (await pool.query(
              `SELECT COALESCE(overall_rating, rating) AS score, content FROM reviews
               WHERE ${where} AND content IS NOT NULL AND content <> '' ORDER BY created_at DESC LIMIT 40`, p)).rows;
            const ai = await chatbot.summarizeReviews(sample, agg);
            if (ai && String(ai).trim()) summary = String(ai).trim();
          }
        } catch (e) { console.log('[review insights]', e.message); }
      }
    }

    res.json({
      total: agg.total,
      overall: agg.overall,
      sentiment: { positive: agg.positive, neutral: agg.neutral, negative: agg.negative },
      criteria: {
        product_quality: agg.product_quality, description_accuracy: agg.description_accuracy,
        packaging: agg.packaging, delivery_speed: agg.delivery_speed, value_for_money: agg.value_for_money,
      },
      loved, problems,
      positive_keywords: words.positive_keywords,
      negative_keywords: words.negative_keywords,
      summary,
      ai_used: !!settings.ai_analytics,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// What a shopper can do with reviews: read them, write one, say whether one
// was helpful, and report one.
//
// Mounted under /api/store, beside the rest of the storefront. The two
// endpoints that already existed there (GET and POST on a product's reviews)
// now live here, keeping their paths, their shapes and every rule they
// enforced — phone-verified buyers only, one review per purchase, the shop's
// AI moderation score — with the five criteria, media, filters and paging
// added on top.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { ensureReviewsSchema } = require('../config/reviewsSchema');
const R = require('../services/reviews');
const { variantLabel } = require('../utils/variantLabel');

const MAX_TEXT = 1000;
const clean = (v, n = 255) => (v == null ? null : String(v).slice(0, n));
const digits = (v) => String(v || '').replace(/\D/g, '');

const storeBySlug = (slug) => pool.query('SELECT id,config FROM stores WHERE slug=$1', [slug]).then((r) => r.rows[0]);
const productBySlug = (storeId, pslug) =>
  pool.query('SELECT id,name FROM products WHERE store_id=$1 AND (slug=$2 OR id::text=$2)', [storeId, pslug]).then((r) => r.rows[0]);

// Who is asking. A signed-in buyer is their customer id; a guest gets a key
// their browser sends, which is enough to stop one person voting twice
// without pretending it identifies anybody.
function voterKey(req) {
  const cid = req.user?.id || req.body?.customer_id || req.query?.customer_id;
  if (cid) return `c:${cid}`;
  const k = clean(req.get('x-visitor-key') || req.body?.visitor_key || req.query?.visitor_key, 80);
  return k ? `v:${k}` : null;
}

// ── read ───────────────────────────────────────────────────────────────────
// Filters, sorting and paging all happen in SQL: a product with a hundred
// thousand reviews must not send them all to decide which twenty to show.
router.get('/:slug/products/:pslug/reviews', async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.json({ reviews: [], stats: {}, total: 0 });
    const product = await productBySlug(store.id, req.params.pslug);
    if (!product) return res.json({ reviews: [], stats: {}, total: 0 });

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const p = [product.id];
    let where = "r.product_id=$1 AND r.status='approved'";
    const star = parseInt(req.query.star, 10);
    if (star >= 1 && star <= 5) { p.push(star); where += ` AND ROUND(COALESCE(r.overall_rating, r.rating)) = $${p.length}`; }
    if (req.query.verified === '1') where += ' AND r.verified_purchase IS TRUE';
    if (req.query.with_photos === '1') where += ' AND r.has_photos IS TRUE';
    if (req.query.with_videos === '1') where += ' AND r.has_video IS TRUE';

    const sort = {
      recent: 'r.created_at DESC',
      helpful: 'r.helpful_count DESC, r.created_at DESC',
      highest: 'COALESCE(r.overall_rating, r.rating) DESC, r.created_at DESC',
      lowest: 'COALESCE(r.overall_rating, r.rating) ASC, r.created_at DESC',
    }[req.query.sort] || 'r.created_at DESC';

    const total = (await pool.query(`SELECT COUNT(*)::int n FROM reviews r WHERE ${where}`, p)).rows[0].n;
    p.push(limit, offset);
    const rows = (await pool.query(
      `SELECT r.id, r.customer_name, r.rating, r.overall_rating, r.title, r.content, r.created_at,
              r.product_quality_rating, r.description_accuracy_rating, r.packaging_rating,
              r.delivery_speed_rating, r.value_for_money_rating,
              r.verified_purchase, r.variant_label, r.helpful_count, r.has_photos, r.has_video,
              r.seller_response, r.seller_response_at,
              COALESCE((SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind) ORDER BY m.position)
                        FROM review_media m WHERE m.review_id = r.id), '[]'::json) AS media
       FROM reviews r WHERE ${where} ORDER BY ${sort} LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;

    const s = (await R.productStats(product.id)) || {};
    // The old shape (total / avg_rating / r5..r1) is still here, because the
    // product page that shipped before this reads exactly those names.
    const stats = {
      total: s.total || 0,
      avg_rating: s.overall || 0,
      r5: s.star5 || 0, r4: s.star4 || 0, r3: s.star3 || 0, r2: s.star2 || 0, r1: s.star1 || 0,
      overall: s.overall || 0,
      criteria: {
        product_quality: s.product_quality || 0,
        description_accuracy: s.description_accuracy || 0,
        packaging: s.packaging || 0,
        delivery_speed: s.delivery_speed || 0,
        value_for_money: s.value_for_money || 0,
      },
      verified_count: s.verified_count || 0,
      verified_percent: s.total ? Math.round((s.verified_count / s.total) * 100) : 0,
      with_photos: s.with_photos || 0,
      with_videos: s.with_videos || 0,
      sentiment: { positive: s.positive || 0, neutral: s.neutral || 0, negative: s.negative || 0 },
    };
    res.json({ reviews: rows, stats, total, limit, offset });
  } catch (e) { res.json({ reviews: [], stats: {}, total: 0, error: e.message }); }
});

// Can I review this, and which purchase would it attach to?
router.get('/:slug/products/:pslug/reviews/eligibility', async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const product = await productBySlug(store.id, req.params.pslug);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const settings = await R.getSettings(store.id);
    if (!settings.enabled) return res.json({ can_review: false, reason: 'disabled' });
    const who = { customerId: req.query.customer_id || null, phone: req.query.phone || null };
    if (!who.customerId && digits(who.phone).length < 9) return res.json({ can_review: false, reason: 'phone_required' });
    const r = await R.purchaseToReview(store.id, product.id, who);
    res.json({
      can_review: r.ok,
      reason: r.ok ? null : r.reason,
      variant_label: r.ok ? variantLabel(r.purchase.variant_info) : null,
      settings: {
        allow_photos: settings.allow_photos, allow_videos: settings.allow_videos,
        max_photos: settings.max_photos, max_videos: settings.max_videos,
        max_video_seconds: settings.max_video_seconds,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── write ──────────────────────────────────────────────────────────────────
router.post('/:slug/products/:pslug/reviews', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const product = await productBySlug(store.id, req.params.pslug);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const settings = await R.getSettings(store.id);
    if (!settings.enabled) return res.status(403).json({ error: 'Reviews are turned off for this store.', code: 'disabled' });

    const { customer_name, customer_phone, customer_id, title, content } = req.body || {};
    if (!customer_name) return res.status(400).json({ error: 'Name and rating required' });

    // The five criteria, or the single star the old form still sends.
    const criteria = R.readCriteria(req.body);
    let overall = R.overallFrom(criteria);
    if (overall == null) {
      const one = Math.round(Number(req.body.rating));
      if (!Number.isFinite(one) || one < 1 || one > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
      overall = one;
    }

    const phoneDigits = digits(customer_phone);
    if (!customer_id && phoneDigits.length < 9) {
      return res.status(400).json({ error: 'Enter the phone number you used to order this product.', code: 'phone_required' });
    }

    // Verified buyers only, and one review per thing bought.
    const who = { customerId: customer_id || null, phone: customer_phone || null };
    const elig = await R.purchaseToReview(store.id, product.id, who);
    if (!elig.ok) {
      if (elig.reason === 'already_reviewed') return res.status(409).json({ error: 'You have already reviewed this product.', code: 'already_reviewed' });
      return res.status(403).json({ error: 'Only customers who bought this product can review it. Use the phone number from your order.', code: 'not_a_buyer' });
    }
    if (await R.tooFrequent(store.id, who)) {
      return res.status(429).json({ error: 'Too many reviews in a short time. Try again later.', code: 'rate_limited' });
    }

    const text = clean(content, MAX_TEXT);
    const spam = R.spamCheck(text, { criteria });

    // The shop's AI moderation, unchanged: a score out of 100 and a reason,
    // and 70 or more approves on its own.
    let aiScore = null; let aiReason = null; let autoApprove = !settings.require_approval;
    if (settings.ai_moderation) {
      try {
        const chatbot = require('../services/chatbot');
        const mod = await chatbot.moderateReview(text || '', overall);
        aiScore = mod.score; aiReason = mod.reason;
        autoApprove = mod.score >= 70 && !settings.require_approval;
      } catch (e) { console.log('[Review AI Error]', e.message); }
    }
    // Anything that smells mechanical waits for a person — but never because
    // the rating is low.
    if (spam.suspicious) { autoApprove = false; aiReason = aiReason || `flagged: ${spam.flags.join(', ')}`; }

    const status = autoApprove ? 'approved' : 'pending';
    const purchase = elig.purchase;
    const r = await pool.query(
      `INSERT INTO reviews(store_id, product_id, customer_id, customer_name, customer_phone, rating, overall_rating,
         product_quality_rating, description_accuracy_rating, packaging_rating, delivery_speed_rating, value_for_money_rating,
         title, content, status, is_approved, is_rejected, verified_purchase, order_id, order_item_id,
         variant_info, variant_label, sentiment, ai_moderation_score, ai_moderation_reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,TRUE,$17,$18,$19::jsonb,$20,$21,$22,$23)
       RETURNING *`,
      [store.id, product.id, customer_id || purchase.customer_id || null, clean(customer_name, 255), clean(customer_phone, 50),
        Math.round(overall), overall,
        criteria.product_quality ?? null, criteria.description_accuracy ?? null, criteria.packaging ?? null,
        criteria.delivery_speed ?? null, criteria.value_for_money ?? null,
        clean(title, 255), text, status, autoApprove,
        purchase.order_id, purchase.order_item_id,
        purchase.variant_info ? JSON.stringify(purchase.variant_info) : null,
        clean(variantLabel(purchase.variant_info), 200),
        R.sentimentOf(overall), aiScore, aiReason]);

    const review = r.rows[0];
    await R.recomputeProductStats(product.id);
    await R.logModeration({
      reviewId: review.id, storeId: store.id, action: 'submitted', toStatus: status,
      actor: customer_name, reason: spam.flags.length ? spam.flags.join(', ') : null,
    });

    try {
      const { notifyStore } = require('../services/notify');
      notifyStore(store.id, {
        type: 'review',
        title: `New ${Math.round(overall)}★ review: ${product.name || ''}`.trim(),
        message: `${customer_name || ''}${autoApprove ? '' : ' (awaiting approval)'}`,
        link: '/dashboard/smart-reviews?highlight=' + review.id,
      });
    } catch (e) { /* a notification must never fail the review */ }

    res.status(201).json({ ...review, auto_approved: autoApprove, upload_token: review.id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'You have already reviewed this product.', code: 'already_reviewed' });
    res.status(500).json({ error: e.message });
  }
});

// ── the photos and the video ───────────────────────────────────────────────
// Sent as raw bytes straight after the review is created, one request each,
// so a slow upload never costs someone the words they wrote.
const ALLOWED_PHOTO = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);

router.post('/:slug/reviews/:rid/media', express.raw({ type: () => true, limit: '60mb' }), async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const review = (await pool.query('SELECT id, product_id, customer_phone, customer_id, created_at FROM reviews WHERE id=$1 AND store_id=$2',
      [req.params.rid, store.id])).rows[0];
    if (!review) return res.status(404).json({ error: 'Review not found' });
    // Media may only be attached while the review is being written, by the
    // person writing it — not bolted onto someone else's days later.
    if (Date.now() - new Date(review.created_at).getTime() > 15 * 60 * 1000) {
      return res.status(403).json({ error: 'This review can no longer be changed' });
    }

    const settings = await R.getSettings(store.id);
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const isPhoto = ALLOWED_PHOTO.has(mime);
    const isVideo = ALLOWED_VIDEO.has(mime);
    if (!isPhoto && !isVideo) return res.status(415).json({ error: 'That file type is not supported' });
    if (isPhoto && !settings.allow_photos) return res.status(403).json({ error: 'Photos are not allowed' });
    if (isVideo && !settings.allow_videos) return res.status(403).json({ error: 'Videos are not allowed' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file received' });

    const mb = req.body.length / (1024 * 1024);
    if (isPhoto && mb > settings.max_photo_mb) return res.status(413).json({ error: `Photos must be under ${settings.max_photo_mb} MB` });
    if (isVideo && mb > settings.max_video_mb) return res.status(413).json({ error: `Videos must be under ${settings.max_video_mb} MB` });

    const duration = Math.round(Number(req.get('x-duration')) || 0);
    if (isVideo && duration && duration > settings.max_video_seconds) {
      return res.status(413).json({ error: `Videos must be under ${settings.max_video_seconds} seconds` });
    }

    const existing = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE kind='photo')::int AS photos, COUNT(*) FILTER (WHERE kind='video')::int AS videos
       FROM review_media WHERE review_id=$1`, [review.id])).rows[0];
    if (isPhoto && existing.photos >= settings.max_photos) return res.status(409).json({ error: `Up to ${settings.max_photos} photos` });
    if (isVideo && existing.videos >= settings.max_videos) return res.status(409).json({ error: `Up to ${settings.max_videos} video(s)` });

    const kind = isPhoto ? 'photo' : 'video';
    const m = (await pool.query(
      `INSERT INTO review_media(review_id, store_id, kind, mime, size_bytes, duration_seconds, data, position)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [review.id, store.id, kind, mime, req.body.length, isVideo ? duration || null : null, req.body,
        existing.photos + existing.videos])).rows[0];

    await pool.query(
      `UPDATE reviews SET media_count = (SELECT COUNT(*) FROM review_media WHERE review_id=$1),
         has_photos = EXISTS(SELECT 1 FROM review_media WHERE review_id=$1 AND kind='photo'),
         has_video  = EXISTS(SELECT 1 FROM review_media WHERE review_id=$1 AND kind='video')
       WHERE id=$1`, [review.id]);
    await R.recomputeProductStats(review.product_id);

    res.json({ id: m.id, kind, url: `/api/store/${req.params.slug}/review-media/${m.id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serving one file. Public: these sit on a public product page.
router.get('/:slug/review-media/:id', async (req, res) => {
  try {
    await ensureReviewsSchema();
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).end();
    const row = (await pool.query('SELECT mime, data, kind FROM review_media WHERE id=$1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    const buf = row.data;
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    // A video the shopper scrubs through asks for ranges.
    const range = req.headers.range;
    if (range && row.kind === 'video') {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
        if (Number.isNaN(start) || start > end || start >= buf.length) {
          res.setHeader('Content-Range', `bytes */${buf.length}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(buf.subarray(start, end + 1));
      }
    }
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── was this helpful? ──────────────────────────────────────────────────────
router.post('/:slug/reviews/:rid/helpful', express.json(), async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const settings = await R.getSettings(store.id);
    if (!settings.allow_helpful_votes) return res.status(403).json({ error: 'Voting is turned off' });

    const key = voterKey(req);
    if (!key) return res.status(400).json({ error: 'Cannot identify the voter' });
    const helpful = req.body?.helpful !== false;

    const review = (await pool.query('SELECT id FROM reviews WHERE id=$1 AND store_id=$2', [req.params.rid, store.id])).rows[0];
    if (!review) return res.status(404).json({ error: 'Review not found' });

    // One answer per person: voting again changes the answer rather than
    // adding another.
    await pool.query(
      `INSERT INTO review_votes(review_id, store_id, customer_id, voter_key, helpful)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (review_id, voter_key) DO UPDATE SET helpful = EXCLUDED.helpful`,
      [review.id, store.id, req.body?.customer_id || null, key, helpful]);

    const counts = (await pool.query(
      `UPDATE reviews SET
         helpful_count = (SELECT COUNT(*) FROM review_votes WHERE review_id=$1 AND helpful),
         not_helpful_count = (SELECT COUNT(*) FROM review_votes WHERE review_id=$1 AND NOT helpful)
       WHERE id=$1 RETURNING helpful_count, not_helpful_count`, [review.id])).rows[0];
    res.json({ ok: true, ...counts, your_vote: helpful });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── report one ─────────────────────────────────────────────────────────────
router.post('/:slug/reviews/:rid/report', express.json(), async (req, res) => {
  try {
    await ensureReviewsSchema();
    const store = await storeBySlug(req.params.slug);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const settings = await R.getSettings(store.id);
    if (!settings.enable_reports) return res.status(403).json({ error: 'Reporting is turned off' });

    const reason = R.REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : 'other';
    const key = voterKey(req) || `anon:${Date.now()}`;
    const review = (await pool.query('SELECT id, status FROM reviews WHERE id=$1 AND store_id=$2', [req.params.rid, store.id])).rows[0];
    if (!review) return res.status(404).json({ error: 'Review not found' });

    await pool.query(
      `INSERT INTO review_reports(review_id, store_id, customer_id, reporter_key, reason, note)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (review_id, reporter_key) DO NOTHING`,
      [review.id, store.id, req.body?.customer_id || null, key, reason, clean(req.body?.note, 500)]);

    const n = (await pool.query(
      `UPDATE reviews SET report_count = (SELECT COUNT(*) FROM review_reports WHERE review_id=$1)
       WHERE id=$1 RETURNING report_count`, [review.id])).rows[0].report_count;

    // A reported review is flagged for a person to look at. It is not hidden
    // on the strength of a report alone — that would make reporting a way to
    // silence honest criticism.
    if (review.status === 'approved') {
      await pool.query("UPDATE reviews SET status='reported' WHERE id=$1 AND status='approved'", [review.id]);
      await R.logModeration({ reviewId: review.id, storeId: store.id, action: 'reported', fromStatus: 'approved', toStatus: 'reported', reason });
    }
    try {
      const { notifyStore } = require('../services/notify');
      notifyStore(store.id, { type: 'review', title: 'A review was reported', message: reason, link: '/dashboard/smart-reviews?filter=reported' });
    } catch (e) { /* never fail the report over a notification */ }

    res.json({ ok: true, report_count: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

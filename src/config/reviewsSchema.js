// Product reviews.
//
// The `reviews` table already existed with a single 1–5 `rating`. Rather
// than replace it and orphan every review a shop has collected, the five
// criteria are added alongside, and `rating` keeps holding the overall score
// — so old reviews still read correctly and old queries still work.
//
// The overall score is never accepted from the browser: it is the mean of
// the five criteria, worked out on the server and stored so a product page
// can sort and filter on it without recomputing.
const pool = require('./db');

const STATEMENTS = [
  // ── the five criteria, and what links a review to a real purchase ──────
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS product_quality_rating INT`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS description_accuracy_rating INT`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS packaging_rating INT`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS delivery_speed_rating INT`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS value_for_money_rating INT`,
  // the mean of whichever criteria were given, to one decimal place
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS overall_rating NUMERIC(2,1)`,

  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id UUID`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_item_id UUID`,
  // the exact variant bought, frozen: "Black / L" stays "Black / L" even if
  // the product's options are edited afterwards
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS variant_info JSONB`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS variant_label VARCHAR(200)`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verified_purchase BOOLEAN DEFAULT FALSE`,

  // pending | approved | rejected | hidden | reported
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(20)`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_response TEXT`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_response_at TIMESTAMPTZ`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS seller_response_by VARCHAR(200)`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS helpful_count INT DEFAULT 0`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS not_helpful_count INT DEFAULT 0`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS report_count INT DEFAULT 0`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS media_count INT DEFAULT 0`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS has_photos BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS has_video BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment VARCHAR(12)`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

  // The old pair of booleans still drives older code, so `status` is derived
  // from them for rows written before this existed.
  `UPDATE reviews SET status = CASE
      WHEN status IS NOT NULL THEN status
      WHEN is_rejected IS TRUE THEN 'rejected'
      WHEN is_approved IS TRUE THEN 'approved'
      ELSE 'pending' END
   WHERE status IS NULL`,
  `UPDATE reviews SET overall_rating = rating WHERE overall_rating IS NULL AND rating IS NOT NULL`,

  // A product page asks for one product's approved reviews, newest or most
  // helpful first; the dashboard asks for one store's by status.
  `CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_store_status ON reviews(store_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_helpful ON reviews(product_id, status, helpful_count DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_customer ON reviews(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_order_item ON reviews(order_item_id)`,
  // One review per thing bought. A customer who bought the same product
  // twice may review each purchase; they cannot review one purchase twice.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_order_item ON reviews(order_item_id) WHERE order_item_id IS NOT NULL`,

  // ── photos and the one short video ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS review_media(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    store_id UUID,
    kind VARCHAR(10) NOT NULL,              -- photo | video
    mime VARCHAR(100),
    size_bytes BIGINT,
    duration_seconds INT,
    width INT, height INT,
    data BYTEA,                             -- the bytes, served by their own route
    position INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_review_media_review ON review_media(review_id, position)`,

  // ── "was this helpful?", one answer per person per review ─────────────
  `CREATE TABLE IF NOT EXISTS review_votes(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    store_id UUID,
    customer_id UUID,
    voter_key VARCHAR(120) NOT NULL,        -- customer id, or a per-device key for guests
    helpful BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_review_votes ON review_votes(review_id, voter_key)`,

  // ── reports from shoppers ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS review_reports(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    store_id UUID,
    customer_id UUID,
    reporter_key VARCHAR(120),
    reason VARCHAR(40) NOT NULL,            -- spam | offensive | fake | personal_info | irrelevant | other
    note TEXT,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_review_reports_store ON review_reports(store_id, resolved, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_review_reports ON review_reports(review_id, reporter_key)`,

  // ── who moderated what, and why ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS review_moderation_log(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID,
    store_id UUID,
    action VARCHAR(30) NOT NULL,
    from_status VARCHAR(20),
    to_status VARCHAR(20),
    actor VARCHAR(200),
    actor_staff_id UUID,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_review_mod_log ON review_moderation_log(store_id, created_at DESC)`,

  // ── the "how did it go?" message sent after delivery ──────────────────
  `CREATE TABLE IF NOT EXISTS review_requests(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID,
    order_id UUID,
    customer_id UUID,
    customer_phone VARCHAR(50),
    kind VARCHAR(12) NOT NULL DEFAULT 'first',   -- first | reminder
    sent_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_review_requests ON review_requests(order_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_review_requests_store ON review_requests(store_id, sent_at DESC)`,

  // ── the running totals a product page reads ───────────────────────────
  // Counting a million rows on every page view is the thing that makes a
  // review system slow, so the aggregate is kept per product and rewritten
  // whenever a review on it changes.
  `CREATE TABLE IF NOT EXISTS product_review_stats(
    product_id UUID PRIMARY KEY,
    store_id UUID,
    total INT DEFAULT 0,
    overall NUMERIC(2,1) DEFAULT 0,
    product_quality NUMERIC(2,1) DEFAULT 0,
    description_accuracy NUMERIC(2,1) DEFAULT 0,
    packaging NUMERIC(2,1) DEFAULT 0,
    delivery_speed NUMERIC(2,1) DEFAULT 0,
    value_for_money NUMERIC(2,1) DEFAULT 0,
    star5 INT DEFAULT 0, star4 INT DEFAULT 0, star3 INT DEFAULT 0, star2 INT DEFAULT 0, star1 INT DEFAULT 0,
    verified_count INT DEFAULT 0,
    with_photos INT DEFAULT 0,
    with_videos INT DEFAULT 0,
    positive INT DEFAULT 0, neutral INT DEFAULT 0, negative INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_prod_review_stats_store ON product_review_stats(store_id)`,
];

let ready = null;
function ensureReviewsSchema() {
  if (ready) return ready;
  ready = (async () => {
    for (const s of STATEMENTS) {
      try { await pool.query(s); } catch (e) { console.log('[reviews schema]', e.message); }
    }
  })();
  return ready;
}

module.exports = { ensureReviewsSchema };

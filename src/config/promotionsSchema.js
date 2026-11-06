// Offers & coupons.
//
// Two tables hold the rules, two hold what was actually redeemed, and the
// orders themselves carry a frozen copy of the pricing. Editing, pausing or
// deleting an offer must never change what an old order says it cost, so
// nothing here is ever read back to re-price an order that already exists.
//
// Scope (which products an offer or coupon covers) lives in JSONB arrays
// rather than join tables: a store has tens of promotions, not thousands, so
// the whole active set is loaded once per request and matched in memory.
const pool = require('../config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS offers(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    internal_name VARCHAR(200),
    description TEXT,
    -- percentage | fixed | tiered (buy more & save) | bxgy | free_shipping
    offer_type VARCHAR(30) NOT NULL DEFAULT 'percentage',
    -- all | products | variants | categories
    scope VARCHAR(20) NOT NULL DEFAULT 'all',
    product_ids JSONB DEFAULT '[]'::jsonb,
    variant_keys JSONB DEFAULT '[]'::jsonb,
    category_ids JSONB DEFAULT '[]'::jsonb,
    discount_percent NUMERIC(6,2) DEFAULT 0,
    discount_amount NUMERIC(12,2) DEFAULT 0,
    -- buy X get Y
    buy_quantity INT DEFAULT 0,
    get_quantity INT DEFAULT 0,
    get_discount_percent NUMERIC(6,2) DEFAULT 100,
    -- "buy more & save": [{quantity, total_price} | {quantity, discount_type, discount_value}]
    tiers JSONB DEFAULT '[]'::jsonb,
    offer_price NUMERIC(12,2),
    min_quantity INT DEFAULT 0,
    max_quantity INT DEFAULT 0,
    min_order_amount NUMERIC(12,2) DEFAULT 0,
    max_discount NUMERIC(12,2) DEFAULT 0,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    usage_limit INT DEFAULT 0,
    usage_per_customer INT DEFAULT 0,
    used_count INT DEFAULT 0,
    priority INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',          -- active | paused
    show_on_product BOOLEAN DEFAULT TRUE,
    show_on_storefront BOOLEAN DEFAULT TRUE,
    show_at_checkout BOOLEAN DEFAULT TRUE,
    badge_text VARCHAR(80),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_offers_store ON offers(store_id, status)`,

  `CREATE TABLE IF NOT EXISTS coupons(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    code VARCHAR(60) NOT NULL,
    name VARCHAR(200),
    description TEXT,
    discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',  -- percent | fixed | free_shipping
    discount_percent NUMERIC(6,2) DEFAULT 0,
    discount_amount NUMERIC(12,2) DEFAULT 0,
    max_discount NUMERIC(12,2) DEFAULT 0,
    min_order_amount NUMERIC(12,2) DEFAULT 0,
    min_quantity INT DEFAULT 0,
    max_quantity INT DEFAULT 0,
    product_ids JSONB DEFAULT '[]'::jsonb,
    variant_keys JSONB DEFAULT '[]'::jsonb,
    category_ids JSONB DEFAULT '[]'::jsonb,
    excluded_product_ids JSONB DEFAULT '[]'::jsonb,
    excluded_category_ids JSONB DEFAULT '[]'::jsonb,
    free_shipping BOOLEAN DEFAULT FALSE,
    stackable BOOLEAN DEFAULT FALSE,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    usage_limit INT DEFAULT 0,
    usage_per_customer INT DEFAULT 0,
    used_count INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',          -- active | paused
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW())`,
  // One code per store, however it was typed.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_coupons_code ON coupons(store_id, UPPER(code))`,

  // What was actually redeemed. Rows survive the coupon being deleted, so the
  // analytics and the per-customer limits keep working.
  `CREATE TABLE IF NOT EXISTS coupon_redemptions(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID,
    coupon_id UUID,
    code VARCHAR(60),
    order_id UUID,
    customer_id UUID,
    customer_phone VARCHAR(50),
    discount_amount NUMERIC(12,2) DEFAULT 0,
    order_total NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_red_store ON coupon_redemptions(store_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_red_coupon ON coupon_redemptions(coupon_id)`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_red_cust ON coupon_redemptions(coupon_id, customer_phone)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_red_order ON coupon_redemptions(order_id, coupon_id)`,

  `CREATE TABLE IF NOT EXISTS offer_redemptions(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID,
    offer_id UUID,
    offer_name VARCHAR(200),
    offer_type VARCHAR(30),
    order_id UUID,
    customer_id UUID,
    customer_phone VARCHAR(50),
    discount_amount NUMERIC(12,2) DEFAULT 0,
    order_total NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS idx_offer_red_store ON offer_redemptions(store_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_offer_red_offer ON offer_redemptions(offer_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_red_order ON offer_redemptions(order_id, offer_id)`,

  // The frozen copy on the order itself.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_subtotal NUMERIC(12,2)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_discount NUMERIC(12,2) DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount NUMERIC(12,2) DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(60)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS original_unit_price NUMERIC(12,2)`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS offer_id UUID`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS offer_name VARCHAR(200)`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS offer_type VARCHAR(30)`,
];

let ready = null;
function ensurePromotionsSchema() {
  if (ready) return ready;
  ready = (async () => {
    for (const s of STATEMENTS) {
      try { await pool.query(s); } catch (e) { console.log('[promotions schema]', e.message); }
    }
  })();
  return ready;
}

module.exports = { ensurePromotionsSchema };

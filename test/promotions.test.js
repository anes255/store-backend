// The twenty pricing cases the offers & coupons system has to get right.
//
// These run against a real Postgres (a throwaway one), not mocks: the point
// is to prove the SQL, the money arithmetic and the race handling, and none
// of that survives being faked. Point DATABASE_URL at a scratch database:
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/promotions.test.js
//
// It creates its own store, products and promotions, and drops them again.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';

const pool = require('../src/config/db');
const { ensurePromotionsSchema } = require('../src/config/promotionsSchema');
const pricing = require('../src/services/pricing');

let passed = 0, failed = 0;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
function check(name, got, want) {
  if (near(got, want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
}
function checkEq(name, got, want) {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
}

const STORE = '00000000-0000-4000-8000-00000000s101'.replace('s', 'a');
const CAT_A = '00000000-0000-4000-8000-0000000000c1'.replace('c', 'a');
const CAT_B = '00000000-0000-4000-8000-0000000000c2'.replace('c', 'a');
const P1 = '00000000-0000-4000-8000-0000000000p1'.replace('p', 'b'); // 1800, cat A
const P2 = '00000000-0000-4000-8000-0000000000p2'.replace('p', 'b'); // 1000, cat B
const CUSTOMER_PHONE = '0770000000';

async function setup() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stores(
    id UUID PRIMARY KEY, slug TEXT, store_name TEXT, config JSONB DEFAULT '{}'::jsonb,
    currency TEXT DEFAULT 'DZD', free_shipping_enabled BOOLEAN DEFAULT FALSE,
    free_shipping_threshold NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, price NUMERIC, category_id UUID,
    stock_quantity INT, allow_oversell BOOLEAN DEFAULT FALSE, track_inventory BOOLEAN DEFAULT TRUE,
    is_on_sale BOOLEAN DEFAULT FALSE, offer_discount TEXT DEFAULT '',
    quantity_offers JSONB DEFAULT '[]'::jsonb, images JSONB DEFAULT '[]'::jsonb, weight NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id UUID, total NUMERIC,
    offer_discount NUMERIC DEFAULT 0, coupon_discount NUMERIC DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_items(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, product_id UUID,
    product_name TEXT, quantity INT, unit_price NUMERIC, total_price NUMERIC,
    discount_amount NUMERIC DEFAULT 0)`);
  await ensurePromotionsSchema();

  await pool.query('DELETE FROM coupon_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM offer_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM coupons WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);

  await pool.query(`INSERT INTO stores(id,slug,store_name,config,currency) VALUES($1,'t','T','{}'::jsonb,'DZD')`, [STORE]);
  await pool.query(`INSERT INTO products(id,store_id,name,price,category_id,stock_quantity) VALUES($1,$2,'Hoodie',1800,$3,100)`, [P1, STORE, CAT_A]);
  await pool.query(`INSERT INTO products(id,store_id,name,price,category_id,stock_quantity) VALUES($1,$2,'Cap',1000,$3,100)`, [P2, STORE, CAT_B]);
}

const store = () => pool.query('SELECT * FROM stores WHERE id=$1', [STORE]).then((r) => r.rows[0]);
const clearOffers = () => pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]).then(() => pricing.forgetPromotions(STORE));
const clearCoupons = () => pool.query('DELETE FROM coupons WHERE store_id=$1', [STORE]).then(() => pricing.forgetPromotions(STORE));

async function addOffer(o) {
  const row = {
    name: 'Offer', offer_type: 'percentage', scope: 'all', product_ids: '[]', variant_keys: '[]',
    category_ids: '[]', discount_percent: 0, discount_amount: 0, buy_quantity: 0, get_quantity: 0,
    get_discount_percent: 100, tiers: '[]', offer_price: null, min_quantity: 0, max_quantity: 0,
    min_order_amount: 0, max_discount: 0, starts_at: null, ends_at: null, usage_limit: 0,
    usage_per_customer: 0, priority: 0, status: 'active', ...o,
  };
  const keys = Object.keys(row);
  const vals = keys.map((k, i) => (/_ids$|_keys$|^tiers$/.test(k) ? `$${i + 2}::jsonb` : `$${i + 2}`));
  const r = await pool.query(
    `INSERT INTO offers(store_id,${keys.join(',')}) VALUES($1,${vals.join(',')}) RETURNING *`,
    [STORE, ...keys.map((k) => row[k])]);
  pricing.forgetPromotions(STORE);
  return r.rows[0];
}

async function addCoupon(c) {
  const row = {
    code: 'X', name: null, description: null, discount_type: 'percent', discount_percent: 0,
    discount_amount: 0, max_discount: 0, min_order_amount: 0, min_quantity: 0, max_quantity: 0,
    product_ids: '[]', variant_keys: '[]', category_ids: '[]', excluded_product_ids: '[]',
    excluded_category_ids: '[]', free_shipping: false, stackable: false, starts_at: null,
    ends_at: null, usage_limit: 0, usage_per_customer: 0, status: 'active', ...c,
  };
  const keys = Object.keys(row);
  const vals = keys.map((k, i) => (/_ids$|_keys$/.test(k) ? `$${i + 2}::jsonb` : `$${i + 2}`));
  const r = await pool.query(
    `INSERT INTO coupons(store_id,${keys.join(',')}) VALUES($1,${vals.join(',')}) RETURNING *`,
    [STORE, ...keys.map((k) => row[k])]);
  pricing.forgetPromotions(STORE);
  return r.rows[0];
}

const quote = async (opts) => pricing.quoteCart(await store(), { shippingUnits: pricing.toUnits(400), ...opts });

async function run() {
  await setup();

  console.log('\n1. a product with no offer');
  await clearOffers(); await clearCoupons();
  let q = await quote({ items: [{ product_id: P1, quantity: 2 }] });
  check('subtotal', q.subtotal, 3600);
  check('total with 400 shipping', q.total, 4000);
  check('nothing saved', q.saved, 0);

  console.log('\n2. a percentage offer');
  await clearOffers();
  await addOffer({ name: '20% off', offer_type: 'percentage', discount_percent: 20 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }] });
  check('subtotal after 20%', q.subtotal, 2880);
  check('offer discount', q.offer_discount, 720);

  console.log('\n3. a fixed discount');
  await clearOffers();
  await addOffer({ name: '300 off each', offer_type: 'fixed', discount_amount: 300 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }] });
  check('subtotal', q.subtotal, 3000);
  check('discount', q.offer_discount, 600);

  console.log('\n4. buy more & save (the spec ladder: 1800 / 3200 / 4500)');
  await clearOffers();
  await addOffer({
    name: 'Buy more & save', offer_type: 'tiered', scope: 'products',
    product_ids: JSON.stringify([P1]),
    tiers: JSON.stringify([{ quantity: 2, total_price: 3200 }, { quantity: 3, total_price: 4500 }]),
  });
  check('1 item', (await quote({ items: [{ product_id: P1, quantity: 1 }] })).subtotal, 1800);
  check('2 items', (await quote({ items: [{ product_id: P1, quantity: 2 }] })).subtotal, 3200);
  check('3 items', (await quote({ items: [{ product_id: P1, quantity: 3 }] })).subtotal, 4500);
  check('4 items = the 3-tier plus one single', (await quote({ items: [{ product_id: P1, quantity: 4 }] })).subtotal, 6300);
  check('6 items = the 3-tier twice', (await quote({ items: [{ product_id: P1, quantity: 6 }] })).subtotal, 9000);

  console.log('\n5. buy X get Y (buy 2 get 1 free)');
  await clearOffers();
  await addOffer({ name: 'B2G1', offer_type: 'bxgy', buy_quantity: 2, get_quantity: 1, get_discount_percent: 100 });
  check('2 items: nothing free yet', (await quote({ items: [{ product_id: P1, quantity: 2 }] })).subtotal, 3600);
  check('3 items: one free', (await quote({ items: [{ product_id: P1, quantity: 3 }] })).subtotal, 3600);
  check('6 items: two free', (await quote({ items: [{ product_id: P1, quantity: 6 }] })).subtotal, 7200);

  console.log('\n6. a percentage coupon');
  await clearOffers(); await clearCoupons();
  await addCoupon({ code: 'WELCOME10', discount_type: 'percent', discount_percent: 10 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['WELCOME10'] });
  check('coupon discount', q.coupon_discount, 360);
  check('total', q.total, 3640);
  checkEq('code is recorded uppercase', q.coupons[0].code, 'WELCOME10');

  console.log('\n7. a fixed-amount coupon');
  await clearCoupons();
  await addCoupon({ code: 'SUMMER500', discount_type: 'fixed', discount_amount: 500 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['summer500'] });
  check('500 off however it was typed', q.coupon_discount, 500);

  console.log('\n8. an expired coupon');
  await clearCoupons();
  await addCoupon({ code: 'OLD', discount_type: 'percent', discount_percent: 50, ends_at: '2020-01-01T00:00:00Z' });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['OLD'] });
  check('no discount', q.coupon_discount, 0);
  checkEq('reason', q.coupon_errors[0].error, 'expired');

  console.log('\n9. a coupon with a usage limit');
  await clearCoupons();
  const limited = await addCoupon({ code: 'LAST1', discount_type: 'fixed', discount_amount: 200, usage_limit: 1 });
  checkEq('first claim wins', await pricing.claimCoupon(limited.id), true);
  checkEq('second claim refused', await pricing.claimCoupon(limited.id), false);
  pricing.forgetPromotions(STORE);
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['LAST1'] });
  checkEq('and the checkout says so', q.coupon_errors[0].error, 'usage_limit');
  await pricing.releaseCoupon(limited.id);

  console.log('\n10. a minimum-order coupon');
  await clearCoupons();
  await addCoupon({ code: 'MIN5000', discount_type: 'percent', discount_percent: 10, min_order_amount: 5000 });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['MIN5000'] });
  checkEq('refused under the minimum', q.coupon_errors[0].error, 'min_order');
  q = await quote({ items: [{ product_id: P1, quantity: 3 }], couponCodes: ['MIN5000'] });
  check('allowed over it', q.coupon_discount, 540);

  console.log('\n11. a coupon for one product only');
  await clearCoupons();
  await addCoupon({ code: 'HOODIE', discount_type: 'percent', discount_percent: 50, product_ids: JSON.stringify([P1]) });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }, { product_id: P2, quantity: 1 }], couponCodes: ['HOODIE'] });
  check('only the hoodie is discounted', q.coupon_discount, 900);
  q = await quote({ items: [{ product_id: P2, quantity: 1 }], couponCodes: ['HOODIE'] });
  checkEq('cart without it is refused', q.coupon_errors[0].error, 'not_eligible');

  console.log('\n12. a coupon for one category');
  await clearCoupons();
  await addCoupon({ code: 'CATB', discount_type: 'percent', discount_percent: 10, category_ids: JSON.stringify([CAT_B]) });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }, { product_id: P2, quantity: 2 }], couponCodes: ['CATB'] });
  check('10% of the category-B lines only', q.coupon_discount, 200);

  console.log('\n13. a free-shipping coupon');
  await clearCoupons();
  await addCoupon({ code: 'FREESHIP', discount_type: 'free_shipping', free_shipping: true });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['FREESHIP'] });
  check('shipping is zero', q.shipping_cost, 0);
  check('total is the goods alone', q.total, 1800);

  console.log('\n14. an offer and a coupon together');
  await clearOffers(); await clearCoupons();
  await addOffer({ name: '20% off', offer_type: 'percentage', discount_percent: 20 });
  await addCoupon({ code: 'TEN', discount_type: 'percent', discount_percent: 10 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['TEN'] });
  check('offer first', q.offer_discount, 720);
  check('coupon on what is left, not the original', q.coupon_discount, 288);
  check('total', q.total, 2992);
  check('saved', q.saved, 1008);

  console.log('\n15. coupon stacking');
  await clearOffers(); await clearCoupons();
  await addCoupon({ code: 'A10', discount_type: 'percent', discount_percent: 10, stackable: true });
  await addCoupon({ code: 'B10', discount_type: 'percent', discount_percent: 10, stackable: true });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['A10', 'B10'] });
  checkEq('off by default: the second is refused', q.coupon_errors[0].error, 'stacking_disabled');
  check('only one applied', q.coupon_discount, 180);
  await pool.query(`UPDATE stores SET config='{"coupon_stacking":true}'::jsonb WHERE id=$1`, [STORE]);
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['A10', 'B10'] });
  check('on: both, the second on the reduced amount', q.coupon_discount, 342);
  await pool.query(`UPDATE stores SET config='{}'::jsonb WHERE id=$1`, [STORE]);

  console.log('\n16. the price survives a round trip (cart -> checkout -> order)');
  await clearOffers(); await clearCoupons();
  await addOffer({
    name: 'Buy more & save', offer_type: 'tiered', scope: 'products', product_ids: JSON.stringify([P1]),
    tiers: JSON.stringify([{ quantity: 2, total_price: 3200 }]),
  });
  await addCoupon({ code: 'TEN', discount_type: 'percent', discount_percent: 10 });
  const cart = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['TEN'] });
  const checkout = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['TEN'] });
  const atOrder = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['TEN'] });
  check('cart = checkout', cart.total, checkout.total);
  check('checkout = order', checkout.total, atOrder.total);
  check('the figure itself', atOrder.total, 3280);

  console.log('\n17. the snapshot written onto an order');
  const snap = atOrder.snapshot;
  check('snapshot subtotal', snap.subtotal, 3200);
  check('snapshot coupon discount', snap.coupon_discount, 320);
  check('snapshot total', snap.total, 3280);
  checkEq('snapshot names the offer', snap.items[0].offer_name, 'Buy more & save');
  checkEq('snapshot names the coupon', snap.coupons[0].code, 'TEN');

  console.log('\n18. a historical order after its offer and coupon are deleted');
  const orderId = (await pool.query(
    'INSERT INTO orders(store_id,total,offer_discount,coupon_discount) VALUES($1,$2,$3,$4) RETURNING id',
    [STORE, atOrder.total, atOrder.offer_discount, atOrder.coupon_discount])).rows[0].id;
  await pool.query('INSERT INTO coupon_redemptions(store_id,coupon_id,code,order_id,discount_amount,order_total) VALUES($1,$2,$3,$4,$5,$6)',
    [STORE, null, 'TEN', orderId, atOrder.coupon_discount, atOrder.total]);
  await clearOffers(); await clearCoupons();
  const after = (await pool.query('SELECT total,offer_discount,coupon_discount FROM orders WHERE id=$1', [orderId])).rows[0];
  check('total unchanged', after.total, 3280);
  check('offer discount unchanged', after.offer_discount, 400);
  check('coupon discount unchanged', after.coupon_discount, 320);
  const red = (await pool.query('SELECT COUNT(*)::int n FROM coupon_redemptions WHERE order_id=$1', [orderId])).rows[0].n;
  checkEq('the redemption row survives the coupon', red, 1);
  const reQuoted = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['TEN'] });
  check('a fresh cart is priced at full price now', reQuoted.total, 4000);
  check('but the order still says', after.total, 3280);

  console.log('\n19. two buyers racing for the last use');
  await clearCoupons();
  const scarce = await addCoupon({ code: 'ONLYONE', discount_type: 'fixed', discount_amount: 100, usage_limit: 1 });
  const results = await Promise.all([pricing.claimCoupon(scarce.id), pricing.claimCoupon(scarce.id), pricing.claimCoupon(scarce.id)]);
  checkEq('exactly one of the three wins', results.filter(Boolean).length, 1);
  const used = (await pool.query('SELECT used_count FROM coupons WHERE id=$1', [scarce.id])).rows[0].used_count;
  checkEq('and the counter is 1, not 3', used, 1);

  console.log('\n20. the floor, the caps and bad input');
  await clearOffers(); await clearCoupons();
  await addCoupon({ code: 'HUGE', discount_type: 'fixed', discount_amount: 999999 });
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['HUGE'] });
  check('a discount never exceeds the goods', q.coupon_discount, 1800);
  check('and never makes the total negative', q.total, 400);
  await clearCoupons();
  await addCoupon({ code: 'CAPPED', discount_type: 'percent', discount_percent: 50, max_discount: 500 });
  q = await quote({ items: [{ product_id: P1, quantity: 2 }], couponCodes: ['CAPPED'] });
  check('maximum discount is honoured', q.coupon_discount, 500);
  q = await quote({ items: [{ product_id: P1, quantity: 1 }], couponCodes: ['NOPE'] });
  checkEq('an unknown code is just invalid', q.coupon_errors[0].error, 'invalid');
  check('and costs nothing', q.total, 2200);

  console.log('\n21. money arithmetic does not drift');
  await clearOffers(); await clearCoupons();
  await pool.query('UPDATE products SET price=0.07 WHERE id=$1', [P2]);
  await addOffer({ name: '10%', offer_type: 'percentage', discount_percent: 10 });
  q = await quote({ items: [{ product_id: P2, quantity: 3 }], shippingUnits: 0 });
  check('3 x 0.07 less 10%', q.subtotal, 0.19);
  checkEq('and it is a clean number', String(q.subtotal), '0.19');
  await pool.query('UPDATE products SET price=1000 WHERE id=$1', [P2]);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.query('DELETE FROM coupon_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await clearOffers(); await clearCoupons();
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

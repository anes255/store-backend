// The things reported as wrong at checkout: free shipping still charged,
// buy X get Y, and the price a line shows once an offer applies.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/offerbugs.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';

const pool = require('../src/config/db');
const pricing = require('../src/services/pricing');

let passed = 0, failed = 0;
const near = (name, got, want) => {
  if (Math.abs(Number(got) - Number(want)) < 0.005) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};
const eq = (name, got, want) => {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};

const STORE = '00000000-0000-4000-8000-00000000b001'.replace('b', 'a');
const P1 = '00000000-0000-4000-8000-00000000b002'.replace('b', 'a');
const P2 = '00000000-0000-4000-8000-00000000b003'.replace('b', 'a');

async function setup() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stores(
    id UUID PRIMARY KEY, slug TEXT, store_name TEXT, config JSONB DEFAULT '{}'::jsonb,
    currency TEXT DEFAULT 'DZD', free_shipping_enabled BOOLEAN DEFAULT FALSE, free_shipping_threshold NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, price NUMERIC, category_id UUID, stock_quantity INT,
    allow_oversell BOOLEAN DEFAULT FALSE, track_inventory BOOLEAN DEFAULT TRUE, is_on_sale BOOLEAN DEFAULT FALSE,
    offer_discount TEXT DEFAULT '', quantity_offers JSONB DEFAULT '[]'::jsonb, images JSONB DEFAULT '[]'::jsonb, weight NUMERIC DEFAULT 0)`);
  await require('../src/config/promotionsSchema').ensurePromotionsSchema();

  await pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  await pool.query(`INSERT INTO stores(id,slug,store_name,config,currency) VALUES($1,'bugs','B','{}'::jsonb,'DZD')`, [STORE]);
  await pool.query(`INSERT INTO products(id,store_id,name,price,stock_quantity) VALUES($1,$2,'A',1000,100),($3,$2,'B',500,100)`, [P1, STORE, P2]);
  pricing.forgetPromotions(STORE);
}

async function addOffer(o) {
  const row = {
    name: 'O', offer_type: 'percentage', scope: 'all', product_ids: '[]', variant_keys: '[]', category_ids: '[]',
    discount_percent: 0, discount_amount: 0, buy_quantity: 0, get_quantity: 0, get_discount_percent: 100,
    tiers: '[]', offer_price: null, min_quantity: 0, max_quantity: 0, min_order_amount: 0, max_discount: 0,
    starts_at: null, ends_at: null, usage_limit: 0, usage_per_customer: 0, priority: 0, status: 'active', ...o,
  };
  const keys = Object.keys(row);
  const vals = keys.map((k, i) => (/_ids$|_keys$|^tiers$/.test(k) ? `$${i + 2}::jsonb` : `$${i + 2}`));
  const r = await pool.query(`INSERT INTO offers(store_id,${keys.join(',')}) VALUES($1,${vals.join(',')}) RETURNING *`,
    [STORE, ...keys.map((k) => row[k])]);
  pricing.forgetPromotions(STORE);
  return r.rows[0];
}

const store = () => pool.query('SELECT * FROM stores WHERE id=$1', [STORE]).then((r) => r.rows[0]);
const quote = async (items, ship = 400) => pricing.quoteCart(await store(), { items, shippingUnits: pricing.toUnits(ship), checkStock: false });
const clear = () => pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]).then(() => pricing.forgetPromotions(STORE));

async function run() {
  await setup();

  console.log('\nfree shipping on everything');
  await clear();
  await addOffer({ name: 'Free delivery', offer_type: 'free_shipping', scope: 'all' });
  let q = await quote([{ product_id: P1, quantity: 1 }]);
  eq('the quote says shipping is free', q.free_shipping, true);
  near('and charges nothing for it', q.shipping_cost, 0);
  near('total is the goods alone', q.total, 1000);

  console.log('\nfree shipping on one product only');
  await clear();
  await addOffer({ name: 'Free on A', offer_type: 'free_shipping', scope: 'products', product_ids: JSON.stringify([P1]) });
  q = await quote([{ product_id: P1, quantity: 1 }]);
  near('that product: no shipping', q.shipping_cost, 0);
  q = await quote([{ product_id: P2, quantity: 1 }]);
  near('another product: shipping as normal', q.shipping_cost, 400);
  q = await quote([{ product_id: P1, quantity: 1 }, { product_id: P2, quantity: 1 }]);
  near('a cart containing it: free', q.shipping_cost, 0);

  console.log('\nfree shipping with a minimum order');
  await clear();
  await addOffer({ name: 'Free over 2000', offer_type: 'free_shipping', scope: 'all', min_order_amount: 2000 });
  near('under the minimum, shipping stands', (await quote([{ product_id: P1, quantity: 1 }])).shipping_cost, 400);
  near('over it, shipping goes', (await quote([{ product_id: P1, quantity: 2 }])).shipping_cost, 0);

  console.log('\nbuy 3 get 1 free');
  await clear();
  await addOffer({ name: 'B3G1', offer_type: 'bxgy', buy_quantity: 3, get_quantity: 1, get_discount_percent: 100 });
  near('3 of them is full price', (await quote([{ product_id: P1, quantity: 3 }])).subtotal, 3000);
  near('the 4th is free', (await quote([{ product_id: P1, quantity: 4 }])).subtotal, 3000);
  near('8 gets two free', (await quote([{ product_id: P1, quantity: 8 }])).subtotal, 6000);

  console.log('\nwhat a line reports once an offer applies');
  await clear();
  await addOffer({ name: '25% off', offer_type: 'percentage', discount_percent: 25 });
  q = await quote([{ product_id: P1, quantity: 2 }]);
  near('the line total', q.items[0].total_price, 1500);
  near('the unit price it shows', q.items[0].unit_price, 750);
  near('the price before the offer', q.items[0].original_unit_price, 1000);
  near('and the cart subtotal', q.subtotal, 1500);

  console.log('\nseveral coupons at once, when the shop allows it');
  await clear();
  await pool.query(`UPDATE stores SET config='{"coupon_stacking":true}'::jsonb WHERE id=$1`, [STORE]);
  for (const code of ['AAA', 'BBB']) {
    await pool.query(
      `INSERT INTO coupons(store_id,code,discount_type,discount_percent,stackable,status,product_ids,variant_keys,category_ids,excluded_product_ids,excluded_category_ids)
       VALUES($1,$2,'percent',10,TRUE,'active','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb)
       ON CONFLICT DO NOTHING`, [STORE, code]);
  }
  pricing.forgetPromotions(STORE);
  const s = await store();
  q = await pricing.quoteCart(s, { items: [{ product_id: P1, quantity: 1 }], couponCodes: ['AAA', 'BBB'], shippingUnits: pricing.toUnits(400), checkStock: false });
  eq('both are applied', q.coupons.length, 2);
  near('the second works on what is left', q.coupon_discount, 190);
  await pool.query(`UPDATE stores SET config='{}'::jsonb WHERE id=$1`, [STORE]);
  await pool.query('DELETE FROM coupons WHERE store_id=$1', [STORE]);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await clear();
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

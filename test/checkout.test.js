// End to end through the real HTTP routes: quote the cart, check a coupon,
// place the order, and then prove the order keeps its price after the
// promotions behind it are deleted.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/checkout.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const express = require('express');
const pool = require('../src/config/db');
const { ensurePromotionsSchema } = require('../src/config/promotionsSchema');
const pricing = require('../src/services/pricing');

let passed = 0, failed = 0;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const check = (name, got, want, cmp = near) => {
  if (cmp(got, want)) { passed++; console.log(`  ok    ${name}  (${JSON.stringify(got)})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const eq = (name, got, want) => check(name, got, want, (a, b) => String(a) === String(b));

const SLUG = 'promo-e2e';
const STORE = '00000000-0000-4000-8000-0000000000e1';
const P1 = '00000000-0000-4000-8000-0000000000e2';

let server, base;

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stores(
    id UUID PRIMARY KEY, slug TEXT UNIQUE, store_name TEXT, config JSONB DEFAULT '{}'::jsonb,
    currency TEXT DEFAULT 'DZD', free_shipping_enabled BOOLEAN DEFAULT FALSE,
    free_shipping_threshold NUMERIC DEFAULT 0, owner_id UUID, is_published BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, price NUMERIC, category_id UUID,
    stock_quantity INT, allow_oversell BOOLEAN DEFAULT FALSE, track_inventory BOOLEAN DEFAULT TRUE,
    is_on_sale BOOLEAN DEFAULT FALSE, offer_discount TEXT DEFAULT '',
    quantity_offers JSONB DEFAULT '[]'::jsonb, images JSONB DEFAULT '[]'::jsonb, weight NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id UUID, customer_id UUID, order_number INT,
    customer_name TEXT, customer_phone TEXT, customer_email TEXT, shipping_address TEXT,
    shipping_city TEXT, shipping_wilaya TEXT, shipping_zip TEXT, shipping_type TEXT,
    subtotal NUMERIC, shipping_cost NUMERIC, discount NUMERIC, total NUMERIC,
    payment_method TEXT, payment_status TEXT DEFAULT 'pending', notes TEXT,
    notification_preference TEXT, preferred_delivery_company_id UUID, status TEXT,
    is_deleted BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_items(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, product_id UUID,
    product_name TEXT, product_image TEXT, variant_info TEXT, quantity INT,
    unit_price NUMERIC, total_price NUMERIC, weight NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customers(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id UUID, full_name TEXT, email TEXT,
    phone TEXT, address TEXT, city TEXT, wilaya TEXT, total_orders INT DEFAULT 0, total_spent NUMERIC DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS shipping_wilayas(
    id SERIAL PRIMARY KEY, store_id UUID, wilaya_name TEXT,
    desk_delivery_price NUMERIC, home_delivery_price NUMERIC, company_prices JSONB DEFAULT '{}'::jsonb)`);
  // A scratch database may already carry a thinner `orders` from another
  // test file; add what this one needs rather than dropping anyone's table.
  for (const c of [
    'order_number INT', 'customer_name TEXT', 'customer_phone TEXT', 'customer_email TEXT',
    'shipping_address TEXT', 'shipping_city TEXT', 'shipping_wilaya TEXT', 'shipping_zip TEXT',
    'shipping_type TEXT', 'subtotal NUMERIC', 'shipping_cost NUMERIC', 'discount NUMERIC',
    'payment_method TEXT', "payment_status TEXT DEFAULT 'pending'", 'notes TEXT',
    'notification_preference TEXT', 'preferred_delivery_company_id UUID', 'status TEXT',
    'customer_id UUID', 'updated_at TIMESTAMPTZ DEFAULT NOW()',
  ]) { try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`); } catch {} }
  for (const c of [
    'product_image TEXT', 'variant_info TEXT', 'weight NUMERIC DEFAULT 0',
  ]) { try { await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS ${c}`); } catch {} }
  await ensurePromotionsSchema();
}

async function seed() {
  await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM coupon_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM offer_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM coupons WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM customers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM shipping_wilayas WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);

  await pool.query(`INSERT INTO stores(id,slug,store_name,config,currency) VALUES($1,$2,'E2E','{}'::jsonb,'DZD')`, [STORE, SLUG]);
  await pool.query(`INSERT INTO products(id,store_id,name,price,stock_quantity) VALUES($1,$2,'Hoodie',1800,100)`, [P1, STORE]);
  await pool.query(`INSERT INTO shipping_wilayas(store_id,wilaya_name,desk_delivery_price,home_delivery_price) VALUES($1,'Alger',400,600)`, [STORE]);

  await pool.query(
    `INSERT INTO offers(store_id,name,offer_type,scope,product_ids,tiers,status)
     VALUES($1,'Buy more & save','tiered','products',$2::jsonb,$3::jsonb,'active')`,
    [STORE, JSON.stringify([P1]), JSON.stringify([{ quantity: 2, total_price: 3200 }, { quantity: 3, total_price: 4500 }])]);
  await pool.query(
    `INSERT INTO coupons(store_id,code,discount_type,discount_percent,usage_limit,status)
     VALUES($1,'SAVE10','percent',10,2,'active')`, [STORE]);
  pricing.forgetPromotions(STORE);
}

const post = async (path, body) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function run() {
  await schema();
  await seed();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/store', require('../src/routes/storefront'));
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}/api/store/${SLUG}`;

  const cartItems = [{ product_id: P1, quantity: 3 }];
  const where = { shipping_type: 'desk', shipping_wilaya: 'Alger' };

  console.log('\n1. the cart is priced by the server');
  let r = await post('/quote', { items: cartItems, ...where });
  eq('200', r.status, 200);
  check('three at the 3-tier price', r.body.subtotal, 4500);
  check('offer discount', r.body.offer_discount, 900);
  check("Alger's desk rate", r.body.shipping_cost, 400);
  check('total', r.body.total, 4900);

  console.log('\n2. a coupon is checked before it is shown as applied');
  r = await post('/validate-coupon', { code: 'NOPE', items: cartItems, ...where });
  eq('unknown code is refused', r.status, 400);
  eq('with a reason', r.body.reason, 'invalid');

  r = await post('/validate-coupon', { code: 'save10', items: cartItems, ...where });
  eq('a real one is accepted however it is typed', r.status, 200);
  check('10% of what is left after the offer', r.body.discount, 450);
  check('and the quote comes back with it', r.body.quote.total, 4450);

  console.log('\n3. the order charges what the checkout said');
  r = await post('/orders', {
    items: cartItems, ...where, coupon_code: 'SAVE10',
    customer_name: 'Test Buyer', customer_phone: '0770000001', shipping_address: 'Rue 1',
    payment_method: 'cod',
  });
  eq('created', r.status, 201);
  const order = r.body.order || r.body;
  check('subtotal', order.subtotal, 4500);
  check('shipping', order.shipping_cost, 400);
  check('total', order.total, 4450);
  check('offer discount recorded', order.offer_discount, 900);
  check('coupon discount recorded', order.coupon_discount, 450);
  eq('coupon code recorded', order.coupon_code, 'SAVE10');

  const snap = typeof order.pricing_snapshot === 'string' ? JSON.parse(order.pricing_snapshot) : order.pricing_snapshot;
  check('the snapshot agrees', snap.total, 4450);
  eq('and names the offer', snap.items[0].offer_name, 'Buy more & save');

  const items = (await pool.query('SELECT * FROM order_items WHERE order_id=$1', [order.id])).rows;
  check('the line keeps its original price', items[0].original_unit_price, 1800);
  check('and what the offer took off it', items[0].discount_amount, 900);

  const red = (await pool.query('SELECT * FROM coupon_redemptions WHERE order_id=$1', [order.id])).rows;
  eq('the redemption is recorded', red.length, 1);
  check('for the right amount', red[0].discount_amount, 450);
  const offRed = (await pool.query('SELECT * FROM offer_redemptions WHERE order_id=$1', [order.id])).rows;
  eq('and so is the offer', offRed.length, 1);

  const used = (await pool.query(`SELECT used_count FROM coupons WHERE store_id=$1 AND code='SAVE10'`, [STORE])).rows[0];
  eq('the coupon counter moved once', used.used_count, 1);

  console.log('\n4. the last use is the last use');
  await post('/orders', {
    items: [{ product_id: P1, quantity: 1 }], ...where, coupon_code: 'SAVE10',
    customer_name: 'Second Buyer', customer_phone: '0770000002', shipping_address: 'Rue 2', payment_method: 'cod',
  });
  pricing.forgetPromotions(STORE);
  r = await post('/orders', {
    items: [{ product_id: P1, quantity: 1 }], ...where, coupon_code: 'SAVE10',
    customer_name: 'Third Buyer', customer_phone: '0770000003', shipping_address: 'Rue 3', payment_method: 'cod',
  });
  eq('the third buyer is refused', r.status === 400 || r.status === 409, true);
  eq('and told why', r.body.coupon_error, 'usage_limit');
  const after = (await pool.query(`SELECT used_count FROM coupons WHERE store_id=$1 AND code='SAVE10'`, [STORE])).rows[0];
  eq('the counter never passed the limit', after.used_count, 2);

  console.log('\n5. a stock problem stops the order, not the price');
  await pool.query('UPDATE products SET stock_quantity=1 WHERE id=$1', [P1]);
  r = await post('/orders', {
    items: [{ product_id: P1, quantity: 5 }], ...where,
    customer_name: 'Greedy', customer_phone: '0770000004', shipping_address: 'Rue 4', payment_method: 'cod',
  });
  eq('refused', r.status, 400);
  eq('as out of stock', r.body.out_of_stock, true);
  await pool.query('UPDATE products SET stock_quantity=100 WHERE id=$1', [P1]);

  console.log('\n6. the first order still says what it said');
  await pool.query('DELETE FROM offers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM coupons WHERE store_id=$1', [STORE]);
  pricing.forgetPromotions(STORE);
  const kept = (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
  check('total unchanged', kept.total, 4450);
  check('offer discount unchanged', kept.offer_discount, 900);
  check('coupon discount unchanged', kept.coupon_discount, 450);
  const stillThere = (await pool.query('SELECT COUNT(*)::int n FROM coupon_redemptions WHERE order_id=$1', [order.id])).rows[0].n;
  eq('the redemption row outlives the coupon', stillThere, 1);

  r = await post('/quote', { items: cartItems, ...where });
  check('a new cart is now full price', r.body.total, 5800);

  console.log(`\n${passed} passed, ${failed} failed\n`);

  await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM coupon_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM offer_redemptions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM customers WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM shipping_wilayas WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); if (server) server.close(); process.exit(1); });

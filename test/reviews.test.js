// The review system, through its real HTTP routes.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/reviews.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const express = require('express');
const pool = require('../src/config/db');
const { ensureReviewsSchema } = require('../src/config/reviewsSchema');
const R = require('../src/services/reviews');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};
const near = (name, got, want) => {
  if (Math.abs(Number(got) - Number(want)) < 0.051) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};

const SLUG = 'rev-e2e';
const STORE = '00000000-0000-4000-8000-00000000r001'.replace('r', 'a');
const P1 = '00000000-0000-4000-8000-00000000r002'.replace('r', 'a');
const CUST = '00000000-0000-4000-8000-00000000r003'.replace('r', 'a');
const PHONE = '0770112233';
let server, base;

const post = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stores(
    id UUID PRIMARY KEY, slug TEXT UNIQUE, store_name TEXT, config JSONB DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, slug TEXT, price NUMERIC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reviews(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_id UUID, product_id UUID, customer_id UUID,
    customer_name VARCHAR(255) NOT NULL, customer_phone VARCHAR(50),
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5), title VARCHAR(255), content TEXT,
    is_approved BOOLEAN DEFAULT FALSE, is_rejected BOOLEAN DEFAULT FALSE,
    ai_moderation_score INT, ai_moderation_reason TEXT, admin_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  for (const c of ['order_id UUID', 'is_deleted BOOLEAN DEFAULT FALSE', 'status TEXT', 'customer_name TEXT',
    'customer_phone TEXT', 'customer_id UUID', 'delivered_at TIMESTAMPTZ', 'updated_at TIMESTAMPTZ DEFAULT NOW()']) {
    try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  for (const c of ['product_id UUID', 'variant_info TEXT', 'product_name TEXT']) {
    try { await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  // the scratch products table from another suite has no slug column
  for (const c of ['slug TEXT', 'name TEXT', 'price NUMERIC']) {
    try { await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  await ensureReviewsSchema();
}

async function seed() {
  await pool.query('DELETE FROM review_media WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_votes WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_reports WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_moderation_log WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM reviews WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM product_review_stats WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);

  await pool.query(`INSERT INTO stores(id,slug,store_name,config) VALUES($1,$2,'Rev','{}'::jsonb)`, [STORE, SLUG]);
  await pool.query(`INSERT INTO products(id,store_id,name,slug,price) VALUES($1,$2,'Tee','tee',1000)`, [P1, STORE]);
  // two separate purchases of the same product, one of them a variant
  let seq = 10;
  const mk = async (variant) => {
    seq -= 5;
    const o = (await pool.query(
      `INSERT INTO orders(id,store_id,customer_id,customer_name,customer_phone,status,created_at)
       VALUES(gen_random_uuid(),$1,$2,'Samy A',$3,'delivered',NOW() - ($4::int * INTERVAL '1 minute')) RETURNING id`, [STORE, CUST, PHONE, seq])).rows[0];
    await pool.query(
      `INSERT INTO order_items(id,order_id,product_id,product_name,variant_info,quantity,unit_price,total_price)
       VALUES(gen_random_uuid(),$1,$2,'Tee',$3,1,1000,1000)`, [o.id, P1, variant]);
    return o.id;
  };
  await mk(null);
  await mk(JSON.stringify({ selections: [{ value: 'Black' }, { value: 'L' }] }));
}

async function run() {
  await schema();
  await seed();

  const app = express();
  app.use('/api/store', require('../src/routes/reviewsPublic'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/store/${SLUG}`;

  console.log('\n1. only someone who bought it may review');
  let r = await get(`/products/tee/reviews/eligibility?phone=0999999999`);
  eq('a stranger cannot', r.body.can_review, false);
  eq('and is told why', r.body.reason, 'not_purchased');
  r = await get(`/products/tee/reviews/eligibility?phone=${PHONE}`);
  eq('the buyer can', r.body.can_review, true);
  eq('against the variant they bought', r.body.variant_label, 'Black / L');

  console.log('\n2. the overall is the mean of the five, never the browser\'s');
  r = await post('/products/tee/reviews', {
    customer_name: 'Samy A', customer_phone: PHONE,
    product_quality_rating: 5, description_accuracy_rating: 4, packaging_rating: 5,
    delivery_speed_rating: 4, value_for_money_rating: 5,
    overall_rating: 1, rating: 1,          // both ignored
    content: 'Very good quality and exactly as shown in the pictures.',
  });
  eq('created', r.status, 201);
  if (r.status !== 201) console.log('    ->', JSON.stringify(r.body));
  near('overall is 4.6', r.body.overall_rating, 4.6);
  eq('verified purchase', r.body.verified_purchase, true);
  eq('the variant is kept', r.body.variant_label, 'Black / L');
  eq('and the order item it belongs to', !!r.body.order_item_id, true);
  const reviewId = r.body.id;

  console.log('\n3. one review per purchase, not per product');
  r = await post('/products/tee/reviews', {
    customer_name: 'Samy A', customer_phone: PHONE, product_quality_rating: 3, content: 'Second order, fine.',
  });
  eq('the second purchase may be reviewed', r.status, 201);
  r = await post('/products/tee/reviews', {
    customer_name: 'Samy A', customer_phone: PHONE, product_quality_rating: 2, content: 'A third?',
  });
  eq('but there is no third purchase', r.status, 409);
  eq('and it says so', r.body.code, 'already_reviewed');

  console.log('\n4. the product page summary');
  r = await get('/products/tee/reviews');
  eq('both are listed', r.body.total, 2);
  near('average of 4.6 and 3.0', r.body.stats.overall, 3.8);
  eq('verified share', r.body.stats.verified_percent, 100);
  near('the quality criterion', r.body.stats.criteria.product_quality, 4);
  eq('the old field name still works', r.body.stats.avg_rating, r.body.stats.overall);

  console.log('\n5. filters and sorting');
  eq('5-star only', (await get('/products/tee/reviews?star=5')).body.total, 1);
  eq('3-star only', (await get('/products/tee/reviews?star=3')).body.total, 1);
  eq('verified only', (await get('/products/tee/reviews?verified=1')).body.total, 2);
  eq('with photos only', (await get('/products/tee/reviews?with_photos=1')).body.total, 0);
  const high = await get('/products/tee/reviews?sort=highest');
  near('highest first', high.body.reviews[0].overall_rating, 4.6);
  const low = await get('/products/tee/reviews?sort=lowest');
  near('lowest first', low.body.reviews[0].overall_rating, 3);
  const page = await get('/products/tee/reviews?limit=1&offset=1');
  eq('paging returns one', page.body.reviews.length, 1);
  eq('and still reports the total', page.body.total, 2);

  console.log('\n6. was this helpful');
  r = await post(`/reviews/${reviewId}/helpful`, { helpful: true }, { 'x-visitor-key': 'visitor-1' });
  eq('counted', r.body.helpful_count, 1);
  r = await post(`/reviews/${reviewId}/helpful`, { helpful: true }, { 'x-visitor-key': 'visitor-1' });
  eq('the same person cannot vote twice', r.body.helpful_count, 1);
  r = await post(`/reviews/${reviewId}/helpful`, { helpful: true }, { 'x-visitor-key': 'visitor-2' });
  eq('someone else can', r.body.helpful_count, 2);
  r = await post(`/reviews/${reviewId}/helpful`, { helpful: false }, { 'x-visitor-key': 'visitor-2' });
  eq('and may change their mind', r.body.helpful_count, 1);
  eq('the other way is counted too', r.body.not_helpful_count, 1);

  console.log('\n7. reporting flags for a person, it does not silence');
  r = await post(`/reviews/${reviewId}/report`, { reason: 'spam' }, { 'x-visitor-key': 'visitor-9' });
  eq('accepted', r.body.ok, true);
  const after = (await pool.query('SELECT status, report_count FROM reviews WHERE id=$1', [reviewId])).rows[0];
  eq('marked for review', after.status, 'reported');
  eq('counted once', after.report_count, 1);
  await post(`/reviews/${reviewId}/report`, { reason: 'fake' }, { 'x-visitor-key': 'visitor-9' });
  eq('the same person reporting twice is still one', (await pool.query('SELECT report_count FROM reviews WHERE id=$1', [reviewId])).rows[0].report_count, 1);

  console.log('\n8. a shop can hide and restore, and the log remembers');
  await R.setStatus(reviewId, STORE, 'hidden', { actor: 'Owner', action: 'hide' });
  eq('hidden', (await pool.query('SELECT status FROM reviews WHERE id=$1', [reviewId])).rows[0].status, 'hidden');
  eq('and gone from the product page', (await get('/products/tee/reviews')).body.total, 1);
  await R.setStatus(reviewId, STORE, 'approved', { actor: 'Owner', action: 'restore' });
  eq('restored', (await get('/products/tee/reviews')).body.total, 2);
  const log = (await pool.query('SELECT action FROM review_moderation_log WHERE review_id=$1 ORDER BY created_at', [reviewId])).rows;
  eq('every step is on the record', log.length >= 4, true);

  console.log('\n9. a negative review is not spam');
  const honest = R.spamCheck('Arrived four days late and the colour is darker than the photo.', { criteria: { delivery_speed: 1 } });
  eq('not flagged', honest.suspicious, false);
  const junk = R.spamCheck('BUY CHEAP VIAGRA www.spam.example NOW NOW NOW');
  eq('junk is', junk.suspicious, true);

  console.log('\n10. settings are honoured');
  await R.saveSettings(STORE, { require_approval: true });
  await pool.query('DELETE FROM reviews WHERE store_id=$1 AND content=$2', [STORE, 'Second order, fine.']);
  r = await post('/products/tee/reviews', {
    customer_name: 'Samy A', customer_phone: PHONE, product_quality_rating: 5, content: 'Great, thanks.',
  });
  eq('held for approval', r.body.status, 'pending');
  eq('so the page does not show it', (await get('/products/tee/reviews')).body.total, 1);
  await R.saveSettings(STORE, { require_approval: false, enabled: false });
  r = await post('/products/tee/reviews', { customer_name: 'X', customer_phone: PHONE, product_quality_rating: 5 });
  eq('reviews off means no new ones', r.status, 403);
  await R.saveSettings(STORE, { enabled: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.query('DELETE FROM review_media WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_votes WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_reports WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM review_moderation_log WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM reviews WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM product_review_stats WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM products WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); if (server) server.close(); process.exit(1); });

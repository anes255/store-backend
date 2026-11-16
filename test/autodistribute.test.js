// The round that runs on the clock: however many orders came in, split
// evenly between the workers on duty.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/autodistribute.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';

const pool = require('../src/config/db');
const { runStoreDistribution, readDistributeSettings } = require('../src/services/orderDistribution');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};

const STORE = '00000000-0000-4000-8000-0000000000e9';
const W1 = '00000000-0000-4000-8000-0000000000ea';
const W2 = '00000000-0000-4000-8000-0000000000eb';
const W3 = '00000000-0000-4000-8000-0000000000ec';

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stores(
    id UUID PRIMARY KEY, slug TEXT, store_name TEXT, config JSONB DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS store_staff(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, first_name TEXT, last_name TEXT,
    status TEXT DEFAULT 'active', is_active BOOLEAN DEFAULT TRUE)`);
  for (const c of ['assigned_staff_id UUID', 'assigned_at TIMESTAMPTZ', 'is_archived BOOLEAN DEFAULT FALSE',
    'is_deleted BOOLEAN DEFAULT FALSE', 'status TEXT', 'order_number INT', 'created_at TIMESTAMPTZ DEFAULT NOW()']) {
    try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS worker_order_actions(
    id SERIAL PRIMARY KEY, store_id UUID NOT NULL, staff_id UUID, order_id UUID NOT NULL,
    order_number VARCHAR(40), action VARCHAR(30) NOT NULL, previous_status TEXT, new_status TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW())`);
}

async function setup({ workers = 2, settings = {} } = {}) {
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM store_staff WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  const cfg = { auto_distribute: { enabled: true, worker_ids: [], every_minutes: 30, ...settings } };
  await pool.query('INSERT INTO stores(id,slug,store_name,config) VALUES($1,$2,$3,$4::jsonb)', [STORE, 'auto', 'Auto', JSON.stringify(cfg)]);
  const ids = [W1, W2, W3].slice(0, workers);
  for (const [i, id] of ids.entries()) {
    await pool.query(`INSERT INTO store_staff(id,store_id,name,first_name,last_name,status) VALUES($1,$2,$3,$3,'X','active')`, [id, STORE, `W${i + 1}`]);
  }
  return ids;
}

async function arrive(n) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO orders(id,store_id,order_number,status,created_at)
       VALUES(gen_random_uuid(),$1,$2,'new_order', NOW() - ($3::int * INTERVAL '1 second'))`,
      [STORE, Math.floor(Math.random() * 1e6), n - i]);
  }
}

const split = async () => (await pool.query(
  `SELECT assigned_staff_id AS id, COUNT(*)::int n FROM orders
   WHERE store_id=$1 AND assigned_staff_id IS NOT NULL GROUP BY assigned_staff_id ORDER BY 1`, [STORE])).rows;

async function run() {
  await schema();

  console.log('\nthe half hour the shop described: 8 orders, 2 workers');
  await setup({ workers: 2 });
  await arrive(8);
  let r = await runStoreDistribution(STORE, { force: true });
  eq('all eight go out', r.assigned, 8);
  let s = await split();
  eq('four each', s.map((x) => x.n).join('+'), '4+4');

  console.log('\nthe next half hour: 20 orders, same two workers');
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await arrive(20);
  r = await runStoreDistribution(STORE, { force: true });
  eq('all twenty go out', r.assigned, 20);
  s = await split();
  eq('ten each', s.map((x) => x.n).join('+'), '10+10');

  console.log('\na number that will not divide: 7 over 2');
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await arrive(7);
  r = await runStoreDistribution(STORE, { force: true });
  eq('all seven go out', r.assigned, 7);
  s = await split();
  eq('as evenly as seven can be', s.map((x) => x.n).sort().join('+'), '3+4');

  console.log('\nthree workers, 9 orders');
  await setup({ workers: 3 });
  await arrive(9);
  r = await runStoreDistribution(STORE, { force: true });
  s = await split();
  eq('three each', s.map((x) => x.n).join('+'), '3+3+3');

  console.log('\nnothing waiting is not an error');
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  r = await runStoreDistribution(STORE, { force: true });
  eq('nothing handed out', r.assigned, 0);

  console.log('\nthe clock holds it between rounds');
  await setup({ workers: 2 });
  await arrive(4);
  r = await runStoreDistribution(STORE, { force: true });
  eq('the forced round runs', r.assigned, 4);
  await arrive(4);
  r = await runStoreDistribution(STORE);      // not forced, half an hour has not passed
  eq('the next is held back', r, 'null');
  eq('and the new four are still waiting', (await pool.query(
    'SELECT COUNT(*)::int n FROM orders WHERE store_id=$1 AND assigned_staff_id IS NULL', [STORE])).rows[0].n, 4);

  console.log('\nand lets it through once the period is up');
  const past = new Date(Date.now() - 31 * 60000).toISOString();
  await pool.query(`UPDATE stores SET config = jsonb_set(config, '{auto_distribute,last_run_at}', to_jsonb($2::text)) WHERE id=$1`, [STORE, past]);
  r = await runStoreDistribution(STORE);
  eq('the round runs', r.assigned, 4);
  const st = await readDistributeSettings(STORE);
  eq('and the clock was marked', new Date(st.last_run_at).getTime() > Date.now() - 60000, 'true');

  console.log('\nswitched off, nothing happens');
  await setup({ workers: 2, settings: { enabled: false } });
  await arrive(5);
  r = await runStoreDistribution(STORE, { force: true });
  eq('no round', r, 'null');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM store_staff WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM stores WHERE id=$1', [STORE]);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

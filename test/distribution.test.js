// Handing orders out to workers: the split the admin asked for, and never
// the same order to two people.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/distribution.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';

const pool = require('../src/config/db');
const { distribute, waitingCount } = require('../src/services/orderDistribution');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};

const STORE = '00000000-0000-4000-8000-0000000000d1';
const W1 = '00000000-0000-4000-8000-0000000000d2';
const W2 = '00000000-0000-4000-8000-0000000000d3';

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS store_staff(
    id UUID PRIMARY KEY, store_id UUID, name TEXT, first_name TEXT, last_name TEXT,
    status TEXT DEFAULT 'active', is_active BOOLEAN DEFAULT TRUE)`);
  for (const c of ['assigned_staff_id UUID', 'assigned_at TIMESTAMPTZ', 'is_archived BOOLEAN DEFAULT FALSE',
    'is_deleted BOOLEAN DEFAULT FALSE', 'status TEXT', 'order_number INT', 'created_at TIMESTAMPTZ DEFAULT NOW()']) {
    try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  for (const c of ['previous_status TEXT', 'new_status TEXT', "metadata JSONB DEFAULT '{}'::jsonb"]) {
    try { await pool.query(`ALTER TABLE worker_order_actions ADD COLUMN IF NOT EXISTS ${c}`); } catch {}
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS worker_order_actions(
    id SERIAL PRIMARY KEY, store_id UUID NOT NULL, staff_id UUID, order_id UUID NOT NULL,
    order_number VARCHAR(40), action VARCHAR(30) NOT NULL, previous_status TEXT, new_status TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW())`);
}

async function seed(n, { archived = 0 } = {}) {
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM store_staff WHERE store_id=$1', [STORE]);
  await pool.query(`INSERT INTO store_staff(id,store_id,name,first_name,last_name,status) VALUES($1,$2,'A','Ali','B','active'),($3,$2,'C','Cherif','D','active')`, [W1, STORE, W2]);
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO orders(id,store_id,order_number,status,is_archived,created_at)
       VALUES(gen_random_uuid(),$1,$2,'new_order',$3, NOW() - ($4::int * INTERVAL '1 minute'))`,
      [STORE, i + 1, i < archived, i + 1]);
  }
}

const assignedBy = async () => (await pool.query(
  'SELECT assigned_staff_id, COUNT(*)::int n FROM orders WHERE store_id=$1 AND assigned_staff_id IS NOT NULL GROUP BY assigned_staff_id',
  [STORE])).rows;

async function run() {
  await schema();

  console.log('\n8 orders, 2 workers, 4 each');
  await seed(8);
  eq('eight are waiting', await waitingCount(STORE), 8);
  let r = await distribute(STORE, { workerIds: [W1, W2], perWorker: 4 });
  eq('eight handed out', r.assigned, 8);
  const split = await assignedBy();
  eq('two workers got orders', split.length, 2);
  eq('the first got four', split[0].n, 4);
  eq('the second got four', split[1].n, 4);

  const dupes = (await pool.query(
    `SELECT COUNT(*)::int n FROM (
       SELECT id FROM orders WHERE store_id=$1 AND assigned_staff_id IS NOT NULL
       GROUP BY id HAVING COUNT(DISTINCT assigned_staff_id) > 1) x`, [STORE])).rows[0].n;
  eq('no order belongs to two workers', dupes, 0);
  eq('nothing is left waiting', await waitingCount(STORE), 0);

  console.log('\nrunning it again hands out nothing twice');
  r = await distribute(STORE, { workerIds: [W1, W2], perWorker: 4 });
  eq('nothing left to give', r.assigned, 0);
  const still = await assignedBy();
  eq('and the counts did not move', still.reduce((s, x) => s + x.n, 0), 8);

  console.log('\n10 orders split evenly as a total');
  await seed(10);
  r = await distribute(STORE, { workerIds: [W1, W2], total: 10 });
  eq('all ten', r.assigned, 10);
  const even = await assignedBy();
  eq('five each', `${even[0].n}+${even[1].n}`, '5+5');

  console.log('\n10 orders, 2 at a time');
  await seed(10);
  r = await distribute(STORE, { workerIds: [W1, W2], perWorker: 2 });
  eq('only four go out', r.assigned, 4);
  eq('six still waiting', await waitingCount(STORE), 6);

  console.log('\narchived orders are finished business');
  await seed(6, { archived: 3 });
  eq('three are waiting, not six', await waitingCount(STORE), 3);
  r = await distribute(STORE, { workerIds: [W1, W2], perWorker: 5 });
  eq('and only those three go out', r.assigned, 3);

  console.log('\ntwo admins pressing Distribute at the same moment');
  await seed(8);
  const [a, b] = await Promise.all([
    distribute(STORE, { workerIds: [W1, W2], perWorker: 4 }),
    distribute(STORE, { workerIds: [W1, W2], perWorker: 4 }),
  ]);
  eq('between them they hand out eight, not sixteen', a.assigned + b.assigned, 8);
  const after = (await pool.query('SELECT COUNT(*)::int n FROM orders WHERE store_id=$1 AND assigned_staff_id IS NOT NULL', [STORE])).rows[0].n;
  eq('and eight orders are assigned', after, 8);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM orders WHERE store_id=$1', [STORE]);
  await pool.query('DELETE FROM store_staff WHERE store_id=$1', [STORE]);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

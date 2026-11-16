// What a worker is owed, against the actions they really recorded.
//
//   DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
//     node test/payroll.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/postgres';
process.env.PGSSLMODE = 'disable';

const pool = require('../src/config/db');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) { passed++; console.log(`  ok    ${name}  (${got})`); }
  else { failed++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
};

// the same tables the route reads
const ACTION_GROUP = {
  confirmed: ['confirmed'],
  prepared: ['prepared', 'preparing'],
  completed: ['completed'],
  shipped: ['shipped'],
};
const PAID_ACTIONS = ['confirmed', 'prepared', 'preparing', 'completed', 'shipped'];

const STORE = '00000000-0000-4000-8000-0000000000f1';
const WORKER = '00000000-0000-4000-8000-0000000000f2';

async function countsFor(year, month) {
  const acts = (await pool.query(
    `SELECT DISTINCT staff_id, action, order_id FROM worker_order_actions
     WHERE store_id=$1 AND staff_id IS NOT NULL AND action = ANY($4::text[])
       AND created_at >= make_timestamptz($2,$3,1,0,0,0,'Africa/Algiers')
       AND created_at <  make_timestamptz($2,$3,1,0,0,0,'Africa/Algiers') + INTERVAL '1 month'`,
    [STORE, year, month, PAID_ACTIONS])).rows;
  const sets = {};
  for (const a of acts) {
    const byAction = (sets[a.staff_id] = sets[a.staff_id] || {});
    (byAction[a.action] = byAction[a.action] || new Set()).add(String(a.order_id));
  }
  return (staffId, action) => {
    const byAction = sets[staffId] || {};
    const seen = new Set();
    for (const key of (ACTION_GROUP[action] || [action])) for (const id of (byAction[key] || [])) seen.add(id);
    return seen.size;
  };
}

async function run() {
  await pool.query(`CREATE TABLE IF NOT EXISTS worker_order_actions(
    id SERIAL PRIMARY KEY, store_id UUID NOT NULL, staff_id UUID, order_id UUID NOT NULL,
    order_number VARCHAR(40), action VARCHAR(30) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);

  const when = `make_timestamptz(2026,11,1,0,0,0,'Africa/Algiers') + INTERVAL '2 days'`;
  const add = (orderId, action) => pool.query(
    `INSERT INTO worker_order_actions(store_id,staff_id,order_id,action,created_at) VALUES($1,$2,$3,$4,${when})`,
    [STORE, WORKER, orderId, action]);

  // 100 orders this worker prepared. 40 of them someone later marked Ready,
  // which used to be the only thing that counted.
  for (let i = 0; i < 100; i++) {
    const oid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await add(oid, 'preparing');
    if (i < 40) await add(oid, 'prepared');
  }
  // and 7 orders they marked delivered
  for (let i = 0; i < 7; i++) {
    await add(`00000000-0000-4000-8000-${String(500 + i).padStart(12, '0')}`, 'completed');
  }

  const count = await countsFor(2026, 11);

  console.log('\na worker who prepared 100 orders');
  eq('is paid for 100, not 40', count(WORKER, 'prepared'), 100);
  eq('an order marked twice still counts once', count(WORKER, 'prepared'), 100);
  eq('completed orders are counted at all', count(WORKER, 'completed'), 7);
  eq('nothing they did not do', count(WORKER, 'confirmed'), 0);

  console.log('\nand the money that follows from it');
  const rate = 50;
  eq('100 x 50', count(WORKER, 'prepared') * rate, 5000);
  const old = (await pool.query(
    `SELECT COUNT(DISTINCT order_id)::int n FROM worker_order_actions
     WHERE store_id=$1 AND staff_id=$2 AND action='prepared'`, [STORE, WORKER])).rows[0].n;
  eq('the old rule would have paid for', old, 40);

  console.log('\nanother month is another month');
  const other = await countsFor(2026, 10);
  eq('October is empty', other(WORKER, 'prepared'), 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.query('DELETE FROM worker_order_actions WHERE store_id=$1', [STORE]);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

// Spreading orders over workers: "distribute now" (manual, by numbers the
// admin picks) and automatic assignment of new orders (store setting).
const pool = require('../config/db');
const { recordOrderAction } = require('./workerActions');

// Orders a worker still has to handle (not yet out with the carrier / closed).
const OPEN_STATUSES = ['new_order', 'pending', 'confirmed', 'preparing', 'under_preparation', 'ready', 'failed_call_1', 'failed_call_2', 'failed_call_3', 'call_1', 'call_2', 'call_3', 'awaiting_pickup'];
const NEW_STATUSES = ['new_order', 'pending'];
const CALL_FAILED = ['failed_call_1', 'failed_call_2', 'failed_call_3', 'call_1', 'call_2', 'call_3'];

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

async function activeWorkers(storeId, ids) {
  const list = Array.isArray(ids) ? ids.filter(isUuid) : [];
  const r = await pool.query(
    `SELECT id, name, first_name, last_name FROM store_staff WHERE store_id=$1 AND COALESCE(status,'active')='active'${list.length ? ' AND id = ANY($2::uuid[])' : ''} ORDER BY name`,
    list.length ? [storeId, list] : [storeId]);
  return r.rows;
}

async function openCounts(storeId, workerIds) {
  if (!workerIds.length) return {};
  const r = await pool.query(
    `SELECT assigned_staff_id AS id, COUNT(*)::int AS n FROM orders WHERE store_id=$1 AND assigned_staff_id = ANY($2::uuid[]) AND status = ANY($3::text[]) AND (is_deleted IS NOT TRUE) GROUP BY assigned_staff_id`,
    [storeId, workerIds, OPEN_STATUSES]);
  return Object.fromEntries(r.rows.map((x) => [x.id, x.n]));
}

// Hand out unassigned orders, oldest first, round-robin starting with the
// worker who has the least open work. perWorker = N each; total = N split evenly.
async function distribute(storeId, { workerIds, perWorker, total, includeCallFailed = false, actor = null } = {}) {
  const workers = await activeWorkers(storeId, workerIds);
  if (!workers.length) return { error: 'Pick at least one active worker.' };
  const per = Math.max(0, Math.min(500, parseInt(perWorker, 10) || 0));
  const tot = Math.max(0, Math.min(2000, parseInt(total, 10) || 0));
  const limit = per ? per * workers.length : tot;
  if (!limit) return { error: 'Give the number of orders to distribute.' };
  const statuses = includeCallFailed ? [...NEW_STATUSES, ...CALL_FAILED] : NEW_STATUSES;
  const orders = (await pool.query(
    `SELECT id, order_number, status FROM orders WHERE store_id=$1 AND assigned_staff_id IS NULL AND status = ANY($2::text[]) AND (is_deleted IS NOT TRUE) AND (is_archived IS NOT TRUE) ORDER BY created_at ASC LIMIT $3`,
    [storeId, statuses, limit])).rows;
  const open = await openCounts(storeId, workers.map((w) => w.id));
  const queue = [...workers].sort((a, b) => (open[a.id] || 0) - (open[b.id] || 0));
  const perCount = Object.fromEntries(workers.map((w) => [w.id, 0]));
  let i = 0;
  for (const o of orders) {
    // round-robin; with a per-worker number nobody goes over it
    let w = null;
    for (let k = 0; k < queue.length; k++) { const cand = queue[(i + k) % queue.length]; if (!per || perCount[cand.id] < per) { w = cand; i = (i + k + 1) % queue.length; break; } }
    if (!w) break;
    const r = await pool.query('UPDATE orders SET assigned_staff_id=$1, assigned_at=NOW() WHERE id=$2 AND store_id=$3 AND assigned_staff_id IS NULL RETURNING id, order_number, status', [w.id, o.id, storeId]);
    if (!r.rows.length) continue;
    perCount[w.id]++;
    await recordOrderAction({ storeId, staffId: w.id, order: r.rows[0], action: 'assigned', newStatus: r.rows[0].status, metadata: { auto: true, by: actor } });
  }
  const assigned = Object.values(perCount).reduce((a, b) => a + b, 0);
  return { assigned, available: orders.length, workers: workers.map((w) => ({ id: w.id, name: [w.first_name, w.last_name].filter(Boolean).join(' ') || w.name, count: perCount[w.id] })) };
}

// Orders waiting to be handed out. The dialog shows this so "5 and 5" or
// "2 each" can be chosen against a real number.
async function waitingCount(storeId, includeCallFailed = false) {
  const statuses = includeCallFailed ? [...NEW_STATUSES, ...CALL_FAILED] : NEW_STATUSES;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE store_id=$1 AND assigned_staff_id IS NULL AND status = ANY($2::text[]) AND (is_deleted IS NOT TRUE) AND (is_archived IS NOT TRUE)`,
    [storeId, statuses]);
  return r.rows[0]?.n || 0;
}

async function readDistributeSettings(storeId) {
  const r = await pool.query('SELECT config FROM stores WHERE id=$1', [storeId]);
  let c = r.rows[0]?.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  const a = c.auto_distribute || {};
  return {
    enabled: !!a.enabled,
    worker_ids: Array.isArray(a.worker_ids) ? a.worker_ids.filter(isUuid) : [],
    // how often the shop looks at what has come in
    every_minutes: Math.max(1, Math.min(1440, parseInt(a.every_minutes, 10) || 30)),
    include_call_failed: !!a.include_call_failed,
    last_run_at: a.last_run_at || null,
  };
}

async function writeLastRun(storeId, when) {
  const r = await pool.query('SELECT config FROM stores WHERE id=$1', [storeId]);
  let c = r.rows[0]?.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  c.auto_distribute = { ...(c.auto_distribute || {}), last_run_at: when };
  await pool.query('UPDATE stores SET config=$1::jsonb WHERE id=$2', [JSON.stringify(c), storeId]);
}

// Every so often, share out whatever has come in.
//
// The shop sets how often it looks -- half an hour, say. Each time, however
// many orders are waiting are split evenly between the chosen workers: eight
// over two workers is four each, twenty over two is ten each. Nobody is
// handed one order at a time all day, and nobody has to remember to press
// Distribute.
async function runStoreDistribution(storeId, { force = false } = {}) {
  const st = await readDistributeSettings(storeId);
  if (!st.enabled) return null;
  if (!force && st.last_run_at) {
    const due = new Date(st.last_run_at).getTime() + st.every_minutes * 60000;
    if (Date.now() < due) return null;
  }
  const now = new Date().toISOString();
  // The clock is marked before anything is handed out, so a slow run cannot
  // be started twice.
  await writeLastRun(storeId, now);

  const waiting = await waitingCount(storeId, st.include_call_failed);
  if (!waiting) return { assigned: 0, available: 0, workers: [] };
  const workers = await activeWorkers(storeId, st.worker_ids);
  if (!workers.length) return { assigned: 0, available: waiting, workers: [] };

  // `total` splits evenly, which is exactly the rule the shop asked for.
  return distribute(storeId, {
    workerIds: workers.map((w) => w.id),
    total: waiting,
    includeCallFailed: st.include_call_failed,
    actor: 'auto',
  });
}

// Walks the stores that have this switched on. Called on a timer by the
// server, and cheap when nobody uses the feature: one indexed query.
async function runDueDistributions() {
  try {
    const r = await pool.query(
      `SELECT id FROM stores WHERE config -> 'auto_distribute' ->> 'enabled' = 'true' LIMIT 500`);
    for (const row of r.rows) {
      try { await runStoreDistribution(row.id); }
      catch (e) { console.log('[auto-distribute]', row.id, e.message); }
    }
  } catch (e) { console.log('[auto-distribute sweep]', e.message); }
}

async function readSettings(storeId) {
  const r = await pool.query('SELECT config FROM stores WHERE id=$1', [storeId]);
  let c = r.rows[0]?.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  const a = c.auto_assign || {};
  return { enabled: !!a.enabled, worker_ids: Array.isArray(a.worker_ids) ? a.worker_ids.filter(isUuid) : [], max_open: Math.max(0, parseInt(a.max_open, 10) || 0) };
}

// A new order arrived: give it to the chosen worker with the least open work,
// unless every one of them already has max_open open orders.
async function autoAssignNew(storeId, orderId) {
  try {
    const st = await readSettings(storeId);
    if (!st.enabled) return null;
    const workers = await activeWorkers(storeId, st.worker_ids);
    if (!workers.length) return null;
    const open = await openCounts(storeId, workers.map((w) => w.id));
    const pick = workers.filter((w) => !st.max_open || (open[w.id] || 0) < st.max_open).sort((a, b) => (open[a.id] || 0) - (open[b.id] || 0))[0];
    if (!pick) return null;
    const r = await pool.query('UPDATE orders SET assigned_staff_id=$1, assigned_at=NOW() WHERE id=$2 AND store_id=$3 AND assigned_staff_id IS NULL RETURNING id, order_number, status', [pick.id, orderId, storeId]);
    if (!r.rows.length) return null;
    await recordOrderAction({ storeId, staffId: pick.id, order: r.rows[0], action: 'assigned', newStatus: r.rows[0].status, metadata: { auto: true } });
    return pick.id;
  } catch (e) { console.log('[auto-assign]', e.message); return null; }
}

module.exports = { distribute, autoAssignNew, readSettings, waitingCount, readDistributeSettings, runStoreDistribution, runDueDistributions, isUuid };

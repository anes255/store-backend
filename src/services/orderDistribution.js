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
    `SELECT id, order_number, status FROM orders WHERE store_id=$1 AND assigned_staff_id IS NULL AND status = ANY($2::text[]) AND (is_deleted IS NOT TRUE) ORDER BY created_at ASC LIMIT $3`,
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

module.exports = { distribute, autoAssignNew, readSettings, isUuid };

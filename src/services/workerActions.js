// Records what a worker did to an order. These rows are the source of truth
// for commissions: payroll counts actions, it never looks at an order's
// current status. Paid actions (confirmed / prepared / completed / shipped)
// are unique per order, so an order can only ever earn one commission for
// each of them, whoever does it and however often its status flips.
const pool = require('../config/db');

// order status → recorded action
const STATUS_ACTION = {
  confirmed: 'confirmed',
  ready: 'prepared', prepared: 'prepared',
  preparing: 'preparing', under_preparation: 'preparing',
  shipped: 'shipped',
  cancelled: 'cancelled', canceled: 'cancelled', rejected: 'cancelled',
};

async function recordOrderAction({ storeId, staffId = null, order, action, previousStatus = null, newStatus = null, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO worker_order_actions(store_id, staff_id, order_id, order_number, action, previous_status, new_status, metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
      [storeId, staffId, order.id, order.order_number != null ? String(order.order_number) : null, action, previousStatus, newStatus, JSON.stringify(metadata || {})]
    );
  } catch (e) { console.log('[worker action]', e.message); }
}

// Called after an order's status changed from the dashboard.
async function recordStatusChange(req, order, previousStatus, newStatus) {
  if (!order || previousStatus === newStatus) return;
  const action = STATUS_ACTION[newStatus] || 'status_change';
  await recordOrderAction({
    storeId: order.store_id, staffId: req.staffRowId || null, order, action,
    previousStatus, newStatus, metadata: { by: req.user?.name || null },
  });
}

module.exports = { recordOrderAction, recordStatusChange, STATUS_ACTION };

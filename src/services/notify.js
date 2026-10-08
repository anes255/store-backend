// Owner-facing notifications — the dashboard bell and web push — in one place.
//
// Before this, only the storefront's new-order path wrote a notification, so
// status changes, low stock and new customers never reached the owner even
// though Settings -> Notifications has toggles for them.
const pool = require('../config/db');

let colsReady = null;
function ensureCols() {
  if (!colsReady) {
    colsReady = (async () => {
      try { await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image TEXT'); } catch {}
    })();
  }
  return colsReady;
}

// Settings toggle that governs each notification type. Every type is on
// unless the owner switches it off (customer alerts used to be opt-in, so
// most stores never saw anything but new orders).
const TOGGLE = { order: 'notify_orders', status: 'notify_orders', payment: 'notify_orders', stock: 'notify_stock', customer: 'notify_customers', review: 'notify_customers' };

async function storeConfig(storeId) {
  try {
    let c = (await pool.query('SELECT config FROM stores WHERE id=$1', [storeId])).rows[0]?.config || {};
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
    return c;
  } catch { return {}; }
}

async function notifyStore(storeId, { type = 'info', title, message = '', link = '/dashboard/orders', image = null, push = true } = {}) {
  if (!storeId || !title) return;
  try {
    const cfg = await storeConfig(storeId);
    const key = TOGGLE[type];
    const enabled = !key ? true : cfg[key] !== false;
    if (!enabled) return;
    await ensureCols();
    await pool.query(
      'INSERT INTO notifications(store_id,type,title,message,link,image) VALUES($1,$2,$3,$4,$5,$6)',
      [storeId, type, String(title).slice(0, 250), String(message || '').slice(0, 500), link, image || null]
    );
    if (push) {
      try {
        const { sendStorePush } = require('../routes/storeOwner');
        if (typeof sendStorePush === 'function') sendStorePush(storeId, title, message);
      } catch {}
    }
  } catch (e) { console.log('[notify]', e.message); }
}

// Owner-readable label for an order status, for status-change alerts.
const STATUS_LABEL = {
  new_order: 'New', pending: 'Pending', confirmed: 'Confirmed', preparing: 'Preparing', under_preparation: 'Preparing',
  ready: 'Ready', shipped: 'Shipped', out_for_delivery: 'Out for delivery', in_transit: 'In transit', delivered: 'Delivered',
  cancelled: 'Cancelled', returned: 'Returned', delivery_failed: 'Delivery failed',
  failed_call_1: 'Call failed (1)', failed_call_2: 'Call failed (2)', failed_call_3: 'Call failed (3)',
};
const statusLabel = (s) => STATUS_LABEL[s] || String(s || '').replace(/_/g, ' ');

// Stock alert when a product's quantity crosses the low-stock threshold or
// runs out. `prev` is the quantity before the change (null = unknown, e.g. a
// brand-new product). Only the crossing notifies, so repeated edits at the
// same level don't spam the owner.
async function checkStockAlert(storeId, productId, prev) {
  try {
    const p = (await pool.query('SELECT name,stock_quantity,images,track_inventory FROM products WHERE id=$1', [productId])).rows[0];
    if (!p || p.track_inventory === false) return;
    const left = parseInt(p.stock_quantity);
    if (!Number.isFinite(left)) return;
    const cfg = await storeConfig(storeId);
    const lowAt = parseInt(cfg.low_stock_threshold) || 5;
    const before = prev == null || prev === '' ? null : parseInt(prev);
    let title = null;
    if (left <= 0 && (before == null || before > 0)) title = `Out of stock: ${p.name}`;
    else if (left > 0 && left <= lowAt && (before == null || before > lowAt)) title = `Low stock: ${p.name}`;
    if (!title) return;
    let im = p.images; if (typeof im === 'string') { try { im = JSON.parse(im); } catch { im = []; } }
    await notifyStore(storeId, { type: 'stock', title, message: `${left} left`, link: '/dashboard/stock', image: Array.isArray(im) && typeof im[0] === 'string' ? im[0] : null });
  } catch (e) { console.log('[notify stock]', e.message); }
}

module.exports = { notifyStore, statusLabel, checkStockAlert };

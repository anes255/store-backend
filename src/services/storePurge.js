const pool = require('../config/db');

// Store deletion has a cooldown: the owner schedules it (stores.deletion_scheduled_at
// = now + 14 days) and can cancel any time before then. This job permanently
// removes stores whose date has passed.
const COOLDOWN_DAYS = 14;

// Permanently delete one store and every per-store row, in one transaction.
// Each delete runs under a savepoint so a table that does not exist on this
// database cannot abort the whole operation.
async function purgeStore(sid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-check under a row lock so a cancel that lands mid-run wins.
    const st = (await client.query('SELECT id FROM stores WHERE id=$1 AND deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at<=NOW() FOR UPDATE', [sid])).rows[0];
    if (!st) { await client.query('ROLLBACK'); return false; }
    const del = async (sql, params) => { await client.query('SAVEPOINT sp'); try { await client.query(sql, params); await client.query('RELEASE SAVEPOINT sp'); } catch { await client.query('ROLLBACK TO SAVEPOINT sp'); } };
    for (const t of ['payment_receipts','blacklist','message_log','expenses','store_pages','notifications','push_subscriptions','reviews','carts','store_domains','shipping_wilayas','delivery_companies','categories','customers','store_status_templates','coupons','store_staff','activity_log']) {
      await del(`DELETE FROM ${t} WHERE store_id=$1`, [sid]);
    }
    await del('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)', [sid]);
    await del('DELETE FROM orders WHERE store_id=$1', [sid]);
    await del('DELETE FROM products WHERE store_id=$1', [sid]);
    await client.query('DELETE FROM stores WHERE id=$1', [sid]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }
}

async function runStorePurge() {
  try {
    const due = (await pool.query('SELECT id,store_name FROM stores WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at<=NOW()')).rows;
    for (const s of due) {
      try { if (await purgeStore(s.id)) console.log(`[Store Purge] Deleted "${s.store_name}" (${s.id})`); }
      catch (e) { console.log(`[Store Purge] Failed for ${s.id}:`, e.message); }
    }
  } catch (e) { console.log('[Store Purge Error]', e.message); }
}

module.exports = { COOLDOWN_DAYS, purgeStore, runStorePurge };

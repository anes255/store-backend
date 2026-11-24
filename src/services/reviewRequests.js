// "How did it go?" — the message a shop sends after an order arrives.
//
// Sent once, a configured number of days after the order was marked
// delivered, with at most one reminder. The row in review_requests is what
// stops it being sent twice; nothing is ever sent before the delay the shop
// set, and a customer who has already reviewed is left alone.
const pool = require('./../config/db');
const { ensureReviewsSchema } = require('../config/reviewsSchema');
const R = require('./reviews');

const DELIVERED = ['delivered', 'completed', 'livré', 'livre'];

function messageFor(store, order, lang) {
  const name = (order.customer_name || '').split(' ')[0] || '';
  const shop = store.store_name || '';
  const link = `${process.env.STOREFRONT_URL || 'https://store-zeta-bice.vercel.app'}/s/${store.slug}/track`;
  const byLang = {
    ar: `${name} مرحبا، كيف كانت تجربتك مع طلبك من ${shop}؟ رأيك يساعد زبائن آخرين: ${link}`,
    fr: `Bonjour ${name}, comment s'est passée votre commande chez ${shop} ? Votre avis aide les autres clients : ${link}`,
    en: `Hi ${name}, how was your order from ${shop}? Your review helps other shoppers: ${link}`,
  };
  return byLang[lang] || byLang.en;
}

// One pass. Called on a timer; cheap when no shop has this switched on.
async function runReviewRequests() {
  try {
    await ensureReviewsSchema();
    const stores = (await pool.query(
      `SELECT id, slug, store_name, config FROM stores
       WHERE config -> 'reviews' ->> 'auto_request' = 'true' LIMIT 500`)).rows;
    for (const store of stores) {
      try { await runForStore(store); }
      catch (e) { console.log('[review requests]', store.id, e.message); }
    }
  } catch (e) { console.log('[review requests sweep]', e.message); }
}

async function runForStore(store) {
  const settings = await R.getSettings(store.id);
  if (!settings.enabled || !settings.auto_request) return;
  let cfg = store.config || {};
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
  const lang = cfg.default_language || cfg.language || 'ar';

  let messaging = null;
  try { messaging = require('./messaging'); } catch (e) { /* nothing to send with */ }
  if (!messaging) return;

  // The first ask: delivered long enough ago, never asked, nothing reviewed.
  const first = (await pool.query(
    `SELECT o.id, o.customer_name, o.customer_phone, o.customer_email, o.customer_id, o.notification_preference
     FROM orders o
     WHERE o.store_id=$1
       AND LOWER(COALESCE(o.status,'')) = ANY($2::text[])
       AND o.is_deleted IS NOT TRUE
       AND COALESCE(o.delivered_at, o.updated_at, o.created_at) <= NOW() - ($3::int * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM review_requests rq WHERE rq.order_id=o.id AND rq.kind='first')
       AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.order_id=o.id)
     ORDER BY o.created_at DESC LIMIT 50`,
    [store.id, DELIVERED, settings.request_delay_days])).rows;

  for (const order of first) await send(store, order, 'first', lang, messaging);

  if (!settings.auto_reminder) return;
  // One reminder, and only one: a shop that nags is worse than one that
  // never asked.
  const again = (await pool.query(
    `SELECT o.id, o.customer_name, o.customer_phone, o.customer_email, o.customer_id, o.notification_preference
     FROM orders o
     JOIN review_requests rq ON rq.order_id = o.id AND rq.kind='first'
     WHERE o.store_id=$1
       AND rq.sent_at <= NOW() - ($2::int * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM review_requests r2 WHERE r2.order_id=o.id AND r2.kind='reminder')
       AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.order_id=o.id)
     ORDER BY rq.sent_at ASC LIMIT 50`,
    [store.id, settings.reminder_delay_days])).rows;

  for (const order of again) await send(store, order, 'reminder', lang, messaging);
}

async function send(store, order, kind, lang, messaging) {
  const text = messageFor(store, order, lang);
  // The row goes in first: if sending throws halfway, the customer is not
  // messaged again on the next sweep.
  const claim = await pool.query(
    `INSERT INTO review_requests(store_id, order_id, customer_id, customer_phone, kind)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT (order_id, kind) DO NOTHING RETURNING id`,
    [store.id, order.id, order.customer_id || null, order.customer_phone || null, kind]);
  if (!claim.rows.length) return;

  try {
    const channel = (order.notification_preference || 'whatsapp').toLowerCase();
    if (channel === 'email' && order.customer_email && messaging.sendEmail) {
      await messaging.sendEmail(store.id, order.customer_email, 'How was your order?', text);
    } else if (order.customer_phone && messaging.sendWhatsApp) {
      await messaging.sendWhatsApp(store.id, order.customer_phone, text);
    }
  } catch (e) {
    console.log('[review request send]', order.id, e.message);
  }
}

module.exports = { runReviewRequests, runForStore };

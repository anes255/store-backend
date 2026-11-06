// The single place a cart is priced.
//
// The cart page, the checkout page and the order that is finally written all
// call this with the same input and get the same numbers back. Nothing the
// browser sends about money is trusted: prices, offers, coupons, shipping and
// the total are all worked out here from the store's own rows.
//
// Money is handled in integer minor units throughout (1 DZD = 100 units).
// Percentages and repeated additions on floats drift — 0.1 + 0.2 — and a
// storefront that is one unit off on a total looks broken, so every figure
// below is an integer until the very end.
const pool = require('../config/db');
const { ensurePromotionsSchema } = require('../config/promotionsSchema');

// ── money ──────────────────────────────────────────────────────────────────
const toUnits = (v) => Math.round((Number(v) || 0) * 100);
const fromUnits = (u) => Math.round(u) / 100;
// percent of an integer amount, rounded half-up, never negative
const pctOf = (units, percent) => Math.max(0, Math.round((units * (Number(percent) || 0)) / 100));

// ── helpers ────────────────────────────────────────────────────────────────
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const idSet = (v) => new Set(asArray(v).map((x) => String(x)));
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Every word that identifies the variant on a line, so a variant-scoped
// promotion can be matched however the variant was recorded.
function variantWords(variant) {
  let v = variant;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return [lower(variant)].filter(Boolean); } }
  const out = [];
  const walk = (x) => {
    if (x == null) return;
    if (typeof x !== 'object') { out.push(lower(x)); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    ['label', 'name', 'value', 'option', 'sku'].forEach((k) => { if (x[k] != null) out.push(lower(x[k])); });
    if (Array.isArray(x.selections)) x.selections.forEach(walk);
    if (Array.isArray(x.per_unit)) x.per_unit.forEach(walk);
  };
  walk(v);
  return out.filter(Boolean);
}

// ── offer / coupon loading (cached briefly: a storefront hits this hard) ────
const CACHE_TTL = 15 * 1000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + CACHE_TTL });
  if (cache.size > 2000) for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
  return val;
}
function forgetPromotions(storeId) {
  if (!storeId) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.includes(String(storeId))) cache.delete(k);
}

async function liveOffers(storeId) {
  await ensurePromotionsSchema();
  return cached(`offers:${storeId}`, async () => {
    const r = await pool.query(
      `SELECT * FROM offers WHERE store_id=$1 AND status='active'
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY priority DESC, created_at ASC`, [storeId]);
    return r.rows;
  });
}

// Everything the admin set up, running or not — the admin pages need the lot.
async function allOffers(storeId) {
  await ensurePromotionsSchema();
  const r = await pool.query('SELECT * FROM offers WHERE store_id=$1 ORDER BY priority DESC, created_at DESC', [storeId]);
  return r.rows;
}

async function couponByCode(storeId, code) {
  await ensurePromotionsSchema();
  const c = String(code || '').trim();
  if (!c) return null;
  const r = await pool.query('SELECT * FROM coupons WHERE store_id=$1 AND UPPER(code)=UPPER($2) LIMIT 1', [storeId, c]);
  return r.rows[0] || null;
}

// ── which lines a promotion covers ─────────────────────────────────────────
function coversLine(promo, line) {
  const scope = promo.scope || (promo.code ? 'all' : 'all');
  const products = idSet(promo.product_ids);
  const categories = idSet(promo.category_ids);
  const variants = asArray(promo.variant_keys).map(lower).filter(Boolean);
  const exProducts = idSet(promo.excluded_product_ids);
  const exCategories = idSet(promo.excluded_category_ids);

  if (exProducts.has(String(line.product_id))) return false;
  if (line.category_id && exCategories.has(String(line.category_id))) return false;

  // A coupon has no `scope` column: it covers everything unless it names
  // products, categories or variants.
  if (!promo.scope) {
    if (!products.size && !categories.size && !variants.length) return true;
  } else if (scope === 'all') {
    return true;
  }

  if (products.size && products.has(String(line.product_id))) return true;
  if (categories.size && line.category_id && categories.has(String(line.category_id))) return true;
  if (variants.length) {
    const words = variantWords(line.variant);
    if (words.some((w) => variants.includes(w))) return true;
  }
  return false;
}

// ── one offer against one line ─────────────────────────────────────────────
// Returns the discount in minor units for the whole line, plus whether the
// offer makes shipping free. Quantity rules that the line does not meet give
// a zero discount rather than an error: an offer is an opportunity, not a
// requirement.
function offerDiscountForLine(offer, line) {
  const qty = line.quantity;
  const unit = line.unit_units;             // price of one, after variants
  const lineTotal = unit * qty;
  const minQ = parseInt(offer.min_quantity, 10) || 0;
  const maxQ = parseInt(offer.max_quantity, 10) || 0;
  if (minQ && qty < minQ) return { discount: 0, freeShipping: false };
  // A maximum quantity caps how many units the offer pays out on.
  const eligibleQty = maxQ ? Math.min(qty, maxQ) : qty;

  let discount = 0;
  let freeShipping = false;

  switch (offer.offer_type) {
    case 'percentage':
      discount = pctOf(unit * eligibleQty, offer.discount_percent);
      break;

    case 'fixed': {
      // A fixed amount comes off each unit, never below zero.
      const per = Math.min(unit, toUnits(offer.discount_amount));
      discount = per * eligibleQty;
      break;
    }

    case 'free_shipping':
      freeShipping = true;
      break;

    case 'bxgy': {
      const buy = parseInt(offer.buy_quantity, 10) || 0;
      const get = parseInt(offer.get_quantity, 10) || 0;
      if (buy > 0 && get > 0) {
        const sets = Math.floor(eligibleQty / (buy + get));
        const freeUnits = sets * get;
        const pct = offer.get_discount_percent == null ? 100 : Number(offer.get_discount_percent);
        discount = pctOf(unit * freeUnits, pct);
      }
      break;
    }

    case 'tiered': {
      // "Buy more & save": the biggest tier that fits is taken as many times
      // as it fits, then the next one down, and whatever is left is sold at
      // the normal price. Buying 4 with tiers for 1/2/3 pays the 3-tier plus
      // one single.
      const tiers = asArray(offer.tiers)
        .map((t) => ({
          quantity: parseInt(t.quantity, 10) || 0,
          total_price: t.total_price != null && t.total_price !== '' ? toUnits(t.total_price) : null,
          discount_type: t.discount_type || 'percent',
          discount_value: Number(t.discount_value) || 0,
        }))
        .filter((t) => t.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity);
      let left = eligibleQty;
      let charged = 0;
      for (const tier of tiers) {
        while (left >= tier.quantity) {
          if (tier.total_price != null) charged += tier.total_price;
          else if (tier.discount_type === 'fixed') charged += Math.max(0, unit * tier.quantity - toUnits(tier.discount_value));
          else charged += unit * tier.quantity - pctOf(unit * tier.quantity, tier.discount_value);
          left -= tier.quantity;
        }
      }
      charged += unit * left;
      discount = Math.max(0, unit * eligibleQty - charged);
      break;
    }
    default:
      break;
  }

  // An offer price replaces the unit price outright when one is set.
  if (offer.offer_price != null && offer.offer_price !== '') {
    const target = toUnits(offer.offer_price);
    if (target < unit) discount = Math.max(discount, (unit - target) * eligibleQty);
  }

  const cap = toUnits(offer.max_discount);
  if (cap > 0) discount = Math.min(discount, cap);
  return { discount: Math.min(discount, lineTotal), freeShipping };
}

// Offers already stored on the product itself keep working: the sale
// percentage, and the per-product quantity tiers the Offers page writes.
function legacyProductOffer(product) {
  const tiers = asArray(product.quantity_offers)
    .filter((t) => parseInt(t.quantity, 10) > 0)
    .map((t) => ({
      quantity: parseInt(t.quantity, 10),
      total_price: t.total_price != null && t.total_price !== '' ? t.total_price : null,
      discount_type: t.discount_type === 'fixed' ? 'fixed' : 'percent',
      discount_value: Number(t.discount_value) || (() => {
        const m = String(t.label || '').match(/(\d+(?:\.\d+)?)\s*%/);
        return m ? Number(m[1]) : 0;
      })(),
    }));
  if (!tiers.length) return null;
  return {
    id: null,
    name: 'Buy more & save',
    offer_type: 'tiered',
    scope: 'products',
    product_ids: [product.id],
    tiers,
    priority: 0,
    max_discount: 0,
    _legacy: true,
    _freeShipping: asArray(product.quantity_offers).some((t) => t.free_shipping),
  };
}

// ── the quote ──────────────────────────────────────────────────────────────
//
// items: [{ product_id, quantity, variant }]
// Returns every figure the storefront shows, plus `snapshot`, which is what
// gets frozen onto the order.
async function quoteCart(store, {
  items = [], couponCodes = [], shippingUnits = 0, customerId = null, customerPhone = null, checkStock = true,
} = {}) {
  const sid = store.id;
  let cfg = store.config || {};
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
  const allowStoreOversell = cfg.allow_oversell === true;
  const allowStacking = cfg.coupon_stacking === true;

  const errors = [];
  const lines = [];
  let freeShipping = false;

  // 1. the real products, priced from the database
  const wanted = items.filter((it) => it && it.product_id);
  const ids = [...new Set(wanted.map((it) => String(it.product_id)))];
  const prodRows = ids.length
    ? (await pool.query('SELECT * FROM products WHERE store_id=$1 AND id = ANY($2::uuid[])', [sid, ids])).rows
    : [];
  const byId = new Map(prodRows.map((p) => [String(p.id), p]));

  for (const it of wanted) {
    const p = byId.get(String(it.product_id));
    if (!p) { errors.push({ code: 'product_missing', product_id: it.product_id }); continue; }
    const quantity = Math.max(1, parseInt(it.quantity, 10) || 1);

    if (checkStock && p.stock_quantity !== null && p.stock_quantity < quantity
        && !p.allow_oversell && !allowStoreOversell && p.track_inventory !== false) {
      errors.push({ code: 'out_of_stock', product_id: p.id, name: p.name });
      continue;
    }

    // base price, then the variant's own adjustments
    let unit = toUnits(p.price);
    // the sale percentage written on the product
    if (p.is_on_sale && p.offer_discount) {
      const pct = parseFloat(String(p.offer_discount).replace(/[^0-9.]/g, '')) || 0;
      if (pct > 0) unit -= pctOf(unit, pct);
    }
    let vd = it.variant;
    if (typeof vd === 'string') { try { vd = JSON.parse(vd); } catch { vd = null; } }
    if (vd && typeof vd === 'object') {
      if (vd.price != null && Number(vd.price) > 0) unit = toUnits(vd.price);
      else if (vd.price_diff != null) unit += toUnits(vd.price_diff);
      else if (vd.additional_price != null) unit += toUnits(vd.additional_price);
      if (Array.isArray(vd.selections)) for (const sel of vd.selections) if (sel && sel.price_diff != null) unit += toUnits(sel.price_diff);
    }
    unit = Math.max(0, unit);

    lines.push({
      product_id: p.id,
      product: p,
      category_id: p.category_id || null,
      name: p.name,
      quantity,
      variant: it.variant || null,
      base_unit_units: unit,
      unit_units: unit,
      discount_units: 0,
      offer: null,
    });
  }

  // 2. offers — the best one wins per line; they do not pile up, which keeps
  //    the price shown on the product page the price that is charged.
  const offers = await liveOffers(sid);
  const productsSubtotal = lines.reduce((s, l) => s + l.unit_units * l.quantity, 0);

  for (const line of lines) {
    const candidates = [];
    const legacy = legacyProductOffer(line.product);
    if (legacy) candidates.push(legacy);
    for (const o of offers) {
      if (toUnits(o.min_order_amount) > productsSubtotal) continue;
      if (!coversLine(o, line)) continue;
      candidates.push(o);
    }
    let best = null;
    for (const o of candidates) {
      const { discount, freeShipping: fs } = offerDiscountForLine(o, line);
      if (fs || o._freeShipping) freeShipping = true;
      if (discount <= 0) continue;
      const better = !best
        || (Number(o.priority) || 0) > (Number(best.offer.priority) || 0)
        || ((Number(o.priority) || 0) === (Number(best.offer.priority) || 0) && discount > best.discount);
      if (better) best = { offer: o, discount };
    }
    if (best) {
      line.discount_units = best.discount;
      line.offer = best.offer;
    }
  }

  const originalSubtotalUnits = lines.reduce((s, l) => s + l.base_unit_units * l.quantity, 0);
  const subtotalBeforeCouponUnits = lines.reduce((s, l) => s + l.unit_units * l.quantity - l.discount_units, 0);
  const offerDiscountUnits = lines.reduce((s, l) => s + l.discount_units, 0);
  const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);

  // 3. coupons
  const appliedCoupons = [];
  const couponErrors = [];
  let couponDiscountUnits = 0;
  const codes = [...new Set((couponCodes || []).map((c) => String(c || '').trim()).filter(Boolean))];

  for (const code of codes) {
    const coupon = await couponByCode(sid, code);
    if (appliedCoupons.length && !allowStacking) {
      couponErrors.push({ code, error: 'stacking_disabled' });
      continue;
    }
    // With stacking on, every code in play has to agree to share.
    if (appliedCoupons.length && allowStacking
        && (!coupon || !coupon.stackable || !appliedCoupons.every((a) => a.stackable))) {
      couponErrors.push({ code, error: 'not_stackable' });
      continue;
    }
    const check = await validateCoupon({
      store, cfg, coupon, code, lines, subtotalUnits: subtotalBeforeCouponUnits - couponDiscountUnits,
      totalQuantity, customerId, customerPhone, stacking: allowStacking, alreadyApplied: appliedCoupons,
    });
    if (check.error) { couponErrors.push({ code, error: check.error, detail: check.detail }); continue; }
    couponDiscountUnits += check.discount;
    if (check.freeShipping) freeShipping = true;
    appliedCoupons.push({
      id: coupon ? coupon.id : null,
      code: (coupon ? coupon.code : code).toUpperCase(),
      name: coupon ? coupon.name : null,
      discount_type: coupon ? coupon.discount_type : check.type,
      discount: check.discount,
      stackable: coupon ? !!coupon.stackable : false,
      free_shipping: !!check.freeShipping,
      legacy: !coupon,
    });
  }

  // 4. shipping
  let shipUnits = Math.max(0, Math.round(shippingUnits) || 0);
  const freeAbove = toUnits(store.free_shipping_threshold);
  if (store.free_shipping_enabled && freeAbove > 0 && subtotalBeforeCouponUnits >= freeAbove) freeShipping = true;
  if (freeShipping) shipUnits = 0;

  // 5. totals — a discount can never push an order below the shipping cost
  const discountUnits = Math.min(offerDiscountUnits + couponDiscountUnits, originalSubtotalUnits);
  const totalUnits = Math.max(0, subtotalBeforeCouponUnits - couponDiscountUnits + shipUnits);

  const itemsOut = lines.map((l) => ({
    product_id: l.product_id,
    product_name: l.name,
    variant_info: l.variant,
    quantity: l.quantity,
    original_unit_price: fromUnits(l.base_unit_units),
    unit_price: fromUnits(Math.max(0, l.unit_units - Math.round(l.discount_units / l.quantity))),
    line_discount: fromUnits(l.discount_units),
    total_price: fromUnits(l.unit_units * l.quantity - l.discount_units),
    offer_id: l.offer && !l.offer._legacy ? l.offer.id : null,
    offer_name: l.offer ? l.offer.name : null,
    offer_type: l.offer ? l.offer.offer_type : null,
    weight: (parseFloat(l.product.weight) || 0) * l.quantity,
    _product: l.product,
    _unit_units: l.unit_units,
    _discount_units: l.discount_units,
  }));

  const offersUsed = [];
  for (const l of lines) {
    if (!l.offer || l.offer._legacy || !l.discount_units) continue;
    const found = offersUsed.find((o) => String(o.id) === String(l.offer.id));
    if (found) found.discount += l.discount_units;
    else offersUsed.push({ id: l.offer.id, name: l.offer.name, offer_type: l.offer.offer_type, discount: l.discount_units });
  }

  return {
    ok: !errors.length,
    errors,
    coupon_errors: couponErrors,
    items: itemsOut,
    currency: store.currency || cfg.currency || 'DZD',
    original_subtotal: fromUnits(originalSubtotalUnits),
    subtotal: fromUnits(subtotalBeforeCouponUnits),
    offer_discount: fromUnits(offerDiscountUnits),
    coupon_discount: fromUnits(couponDiscountUnits),
    discount: fromUnits(discountUnits),
    saved: fromUnits(offerDiscountUnits + couponDiscountUnits),
    shipping_cost: fromUnits(shipUnits),
    free_shipping: freeShipping,
    total: fromUnits(totalUnits),
    coupons: appliedCoupons.map((c) => ({ ...c, discount: fromUnits(c.discount) })),
    offers_used: offersUsed.map((o) => ({ ...o, discount: fromUnits(o.discount) })),
    // frozen onto the order: what the rules were at the moment of purchase
    snapshot: {
      priced_at: new Date().toISOString(),
      currency: store.currency || cfg.currency || 'DZD',
      original_subtotal: fromUnits(originalSubtotalUnits),
      subtotal: fromUnits(subtotalBeforeCouponUnits),
      offer_discount: fromUnits(offerDiscountUnits),
      coupon_discount: fromUnits(couponDiscountUnits),
      shipping_cost: fromUnits(shipUnits),
      total: fromUnits(totalUnits),
      free_shipping: freeShipping,
      coupons: appliedCoupons.map((c) => ({ id: c.id, code: c.code, name: c.name, discount_type: c.discount_type, discount: fromUnits(c.discount), free_shipping: c.free_shipping })),
      offers: offersUsed.map((o) => ({ id: o.id, name: o.name, offer_type: o.offer_type, discount: fromUnits(o.discount) })),
      items: itemsOut.map((i) => ({
        product_id: i.product_id, product_name: i.product_name, quantity: i.quantity,
        original_unit_price: i.original_unit_price, unit_price: i.unit_price,
        line_discount: i.line_discount, total_price: i.total_price,
        offer_id: i.offer_id, offer_name: i.offer_name, offer_type: i.offer_type,
      })),
    },
    _internal: { lines, appliedCoupons, offersUsed, shipUnits, totalUnits },
  };
}

// ── coupon validation ──────────────────────────────────────────────────────
// Every reason a code can be refused, named, so the checkout can say which.
async function validateCoupon({
  store, cfg, coupon, code, lines, subtotalUnits, totalQuantity, customerId, customerPhone,
}) {
  // Codes from the old Settings → Checkout box and the per-product codes keep
  // working so nobody's printed coupon stops overnight.
  if (!coupon) {
    const legacy = legacyCouponDiscount(cfg, code, subtotalUnits);
    if (legacy) return { discount: legacy.discount, type: legacy.type, freeShipping: false };
    return { error: 'invalid' };
  }
  if (coupon.status !== 'active') return { error: 'disabled' };
  const now = Date.now();
  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) return { error: 'not_started', detail: coupon.starts_at };
  if (coupon.ends_at && new Date(coupon.ends_at).getTime() < now) return { error: 'expired', detail: coupon.ends_at };

  const limit = parseInt(coupon.usage_limit, 10) || 0;
  if (limit > 0 && (parseInt(coupon.used_count, 10) || 0) >= limit) return { error: 'usage_limit' };

  const perCustomer = parseInt(coupon.usage_per_customer, 10) || 0;
  if (perCustomer > 0 && (customerId || customerPhone)) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coupon_redemptions
       WHERE coupon_id=$1 AND ((($2::uuid IS NOT NULL) AND customer_id=$2) OR (($3::text IS NOT NULL) AND customer_phone=$3))`,
      [coupon.id, customerId || null, customerPhone || null]);
    if ((r.rows[0]?.n || 0) >= perCustomer) return { error: 'customer_limit' };
  }

  const eligible = lines.filter((l) => coversLine(coupon, l));
  if (!eligible.length) return { error: 'not_eligible' };

  // A second coupon works on what is left after the first, never on the
  // original price: two 10% codes take 19%, not 20%.
  const eligibleUnits = Math.min(
    eligible.reduce((s, l) => s + l.unit_units * l.quantity - l.discount_units, 0),
    Math.max(0, subtotalUnits));
  const eligibleQty = eligible.reduce((s, l) => s + l.quantity, 0);

  const minOrder = toUnits(coupon.min_order_amount);
  if (minOrder > 0 && subtotalUnits < minOrder) return { error: 'min_order', detail: fromUnits(minOrder) };
  const minQ = parseInt(coupon.min_quantity, 10) || 0;
  if (minQ > 0 && totalQuantity < minQ) return { error: 'min_quantity', detail: minQ };
  const maxQ = parseInt(coupon.max_quantity, 10) || 0;
  if (maxQ > 0 && totalQuantity > maxQ) return { error: 'max_quantity', detail: maxQ };

  let discount = 0;
  if (coupon.discount_type === 'percent') discount = pctOf(eligibleUnits, coupon.discount_percent);
  else if (coupon.discount_type === 'fixed') discount = Math.min(eligibleUnits, toUnits(coupon.discount_amount));

  const cap = toUnits(coupon.max_discount);
  if (cap > 0) discount = Math.min(discount, cap);

  const freeShipping = !!coupon.free_shipping || coupon.discount_type === 'free_shipping';
  if (!discount && !freeShipping) return { error: 'no_discount' };
  return { discount, freeShipping, type: coupon.discount_type, eligible_quantity: eligibleQty };
}

// The store-wide code that used to live in stores.config, plus the extras.
function legacyCouponDiscount(cfg, code, subtotalUnits) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return null;
  const all = [{ active: cfg.store_coupon_active, code: cfg.store_coupon_code, value: parseFloat(cfg.store_coupon_discount_percent) || 0, type: cfg.store_coupon_discount_type }];
  if (Array.isArray(cfg.extra_coupons)) cfg.extra_coupons.forEach((c) => all.push({ active: c.active, code: c.code, value: parseFloat(c.discount) || 0, type: c.discount_type }));
  const hit = all.find((c) => c.active && String(c.code || '').trim().toUpperCase() === upper && c.value > 0);
  if (!hit) return null;
  const discount = hit.type === 'fixed' ? Math.min(subtotalUnits, toUnits(hit.value)) : pctOf(subtotalUnits, hit.value);
  return { discount, type: hit.type === 'fixed' ? 'fixed' : 'percent' };
}

// ── claiming usage, safely ─────────────────────────────────────────────────
// Two customers spending the last use of a coupon at the same moment must not
// both get it. The counter is raised with the limit in the WHERE clause, so
// the database decides who was first; a caller that gets nothing back has
// lost the race and is told the coupon ran out.
async function claimCoupon(couponId) {
  if (!couponId) return true;
  const r = await pool.query(
    `UPDATE coupons SET used_count = COALESCE(used_count,0) + 1, updated_at = NOW()
     WHERE id=$1 AND (usage_limit IS NULL OR usage_limit <= 0 OR COALESCE(used_count,0) < usage_limit)
     RETURNING used_count`, [couponId]);
  return r.rowCount > 0;
}
async function releaseCoupon(couponId) {
  if (!couponId) return;
  try { await pool.query('UPDATE coupons SET used_count = GREATEST(0, COALESCE(used_count,0) - 1) WHERE id=$1', [couponId]); } catch {}
}
async function claimOffer(offerId) {
  if (!offerId) return true;
  const r = await pool.query(
    `UPDATE offers SET used_count = COALESCE(used_count,0) + 1, updated_at = NOW()
     WHERE id=$1 AND (usage_limit IS NULL OR usage_limit <= 0 OR COALESCE(used_count,0) < usage_limit)
     RETURNING used_count`, [offerId]);
  return r.rowCount > 0;
}

module.exports = {
  quoteCart, validateCoupon, couponByCode, liveOffers, allOffers, coversLine,
  offerDiscountForLine, claimCoupon, releaseCoupon, claimOffer, forgetPromotions,
  toUnits, fromUnits, pctOf, variantWords,
};

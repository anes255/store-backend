// ═══ LANDING PAGE TEMPLATE ENGINE ═══
// GPT supplies only the COPY (structured JSON); this renders it into a template
// that is the product of THREE independent axes, so pages don't just look like
// the same layout with a different colour:
//   STYLE PACK (8) — a complete visual personality: its own typography, shapes,
//                    borders, hero treatment, card style, button style.
//   HERO (3) + FLOW (5) — the structure / section order.
//   THEME (designKnowledge) — the colour palette + fonts, chosen per product.
// The AI image is a REAL marketing banner (full-bleed advertising scene with the
// headline overlaid) — the product photo is NEVER pasted on top of it; it is
// shown crisp in its own clean frame, so nothing looks "stuck on".

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5z"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h13v10H3z"/><path d="M16 10h4l1 3v4h-5"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.5 1.1-1a5.5 5.5 0 0 0 0-7.9z"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="18" height="4"/><path d="M12 8v13M5 12v9h14v-9"/><path d="M12 8C12 4 8 4 8 6s4 2 4 2zM12 8c0-4 4-4 4-2s-4 2-4 2z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="9" r="6"/><path d="M9 14l-2 7 5-3 5 3-2-7"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 20A7 7 0 0 1 4 13c0-5 6-9 16-9 0 8-4 16-9 16z"/><path d="M4 20c3-4 6-6 10-7"/></svg>',
  thumb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 11v9H3v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2l-1.5 6a2 2 0 0 1-2 1.5H7"/></svg>',
};
const BENEFIT_ICONS = ['bolt', 'shield', 'star', 'spark', 'heart', 'eye', 'clock', 'sparkles', 'leaf', 'thumb', 'badge', 'gift'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function money(v, cur) { return `${esc(v)} ${esc(cur)}`; }
function offPct(p) { return p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0; }

const TXT = {
  ar: { orderNow: 'اطلب الآن', cod: 'الدفع عند الاستلام', deliver: 'توصيل لكل الولايات', fast: 'توصيل سريع', why: 'لماذا تختار هذا المنتج', features: 'المميزات', faq: 'أسئلة شائعة', howTo: 'كيف تطلب', steps: ['اختر المنتج', 'أدخل معلوماتك', 'استلم وادفع'], stepsD: ['اختر المنتج والكمية التي تناسبك', 'املأ الاسم ورقم الهاتف والولاية', 'يصلك المنتج وتدفع عند الاستلام'], q1: 'كم تستغرق مدة التوصيل؟', a1: 'عادة من 2 إلى 5 أيام حسب الولاية.', q2: 'هل الدفع عند الاستلام متاح؟', a2: 'نعم، تدفع فقط عند استلام المنتج ومعاينته.', q3: 'هل التوصيل متاح لكل الولايات؟', a3: 'نعم، نوصّل إلى كل ولايات الجزائر الـ58.', codTitle: 'الدفع عند الاستلام لكل الولايات', codDesc: 'افحص المنتج عند وصوله ثم ادفع — توصيل سريع وآمن إلى باب منزلك.', getToday: 'احصل عليه اليوم', limited: 'الكمية محدودة — اطلب الآن.', available: 'المتوفر', vsWhy: 'لماذا منتجنا أفضل', us: 'منتجنا', others: 'غيره', offer: 'عرض خاص', save: 'وفّر', trust: ['الدفع عند الاستلام', 'توصيل 58 ولاية', 'منتج أصلي'], trustD: ['ادفع بعد المعاينة', 'إلى باب منزلك', 'جودة مضمونة'], resultTitle: 'شاهد الفرق الحقيقي', before: 'قبل', after: 'بعد', inAction: 'المنتج أثناء الاستعمال' },
  fr: { orderNow: 'Commander', cod: 'Paiement à la livraison', deliver: 'Livraison toutes wilayas', fast: 'Livraison rapide', why: 'Pourquoi choisir ce produit', features: 'Caractéristiques', faq: 'Questions fréquentes', howTo: 'Comment commander', steps: ['Choisissez le produit', 'Vos informations', 'Recevez et payez'], stepsD: ['Choisissez le produit et la quantité', 'Nom, téléphone et wilaya', 'Payez à la réception'], q1: 'Délai de livraison ?', a1: 'En général 2 à 5 jours selon la wilaya.', q2: 'Paiement à la livraison ?', a2: 'Oui, payez à la réception après vérification.', q3: 'Livraison partout ?', a3: 'Oui, vers les 58 wilayas d’Algérie.', codTitle: 'Paiement à la livraison — toutes wilayas', codDesc: 'Vérifiez le produit à la livraison, puis payez. Rapide et sûr.', getToday: 'Commandez aujourd’hui', limited: 'Quantité limitée — commandez maintenant.', available: 'Disponible', vsWhy: 'Pourquoi notre produit', us: 'Nous', others: 'Autres', offer: 'Offre spéciale', save: 'Économisez', trust: ['Paiement à la livraison', 'Livraison 58 wilayas', 'Produit authentique'], trustD: ['Payez après vérification', 'Jusqu’à votre porte', 'Qualité garantie'], resultTitle: 'Voyez la vraie différence', before: 'Avant', after: 'Après', inAction: 'Le produit en situation' },
  en: { orderNow: 'Order now', cod: 'Cash on delivery', deliver: 'Delivery nationwide', fast: 'Fast delivery', why: 'Why choose this product', features: 'Features', faq: 'FAQ', howTo: 'How to order', steps: ['Choose the product', 'Your details', 'Receive & pay'], stepsD: ['Pick the product and quantity', 'Name, phone and wilaya', 'Pay on delivery'], q1: 'How long is delivery?', a1: 'Usually 2–5 days depending on the wilaya.', q2: 'Is cash on delivery available?', a2: 'Yes, pay only when you receive and check it.', q3: 'Do you deliver everywhere?', a3: 'Yes, to all 58 wilayas of Algeria.', codTitle: 'Cash on delivery — nationwide', codDesc: 'Inspect the product on arrival, then pay. Fast and safe to your door.', getToday: 'Get yours today', limited: 'Limited stock — order now.', available: 'Available', vsWhy: 'Why our product', us: 'Ours', others: 'Others', offer: 'Special offer', save: 'Save', trust: ['Cash on delivery', 'Delivery to 58 wilayas', 'Authentic product'], trustD: ['Pay after checking', 'To your door', 'Quality guaranteed'], resultTitle: 'See the real difference', before: 'Before', after: 'After', inAction: 'The product in action' },
};

// ── SHARED PARTS ──
function cta(p, t, big) { return `<button class="lp-btn${big ? ' lp-btn-xl' : ''}" data-order data-add-product="${esc(p.id)}">${esc(t.orderNow)}<span class="lp-cta-note">${money(p.price, p.cur)} • ${esc(t.cod)}</span></button>`; }
function chips(t) { return `<div class="lp-chips"><span class="lp-chip">${ICONS.cash}${esc(t.cod)}</span><span class="lp-chip">${ICONS.truck}${esc(t.deliver)}</span></div>`; }
function pricing(p, center) { const off = offPct(p); return `<div class="lp-pricing"${center ? ' style="justify-content:center"' : ''}><span class="lp-price">${money(p.price, p.cur)}</span>${off ? `<span class="lp-was">${money(p.compare, p.cur)}</span><span class="lp-off">-${off}%</span>` : ''}</div>`; }
function pframe(p, off) { return `<div class="lp-pframe"><div class="lp-pfblob" style="top:-10%;inset-inline-start:-10%"></div>${off ? `<span class="lp-badge">-${off}%</span>` : ''}${p.vTok && p.hasVariants ? p.vTok : `<img src="${p.media}" alt="${esc(p.name)}">`}</div>`; }

// ── HERO VARIANTS (product shown CLEAN — never pasted on the AI scene) ──
function heroCopy(p, t) {
  return `<div><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead">${esc(p.subtitle || p.description || '')}</p>${pricing(p)}${cta(p, t, true)}${chips(t)}</div>`;
}
function heroSplit(p, t, tpl) {
  const off = offPct(p);
  const blob = tpl.decor ? `<div class="lp-blob" style="background:var(--lp-primary);width:340px;height:340px;top:-80px;inset-inline-start:-60px"></div>` : '';
  const media = `<div>${pframe(p, off)}</div>`;
  const cols = tpl.hero === 'splitL' ? media + heroCopy(p, t) : heroCopy(p, t) + media;
  return `<section class="lp-hero">${blob}<div class="lp-wrap"><div class="lp-hero-grid">${cols}</div></div></section>`;
}
function heroCenter(p, t, tpl) {
  const off = offPct(p);
  const blob = tpl.decor ? `<div class="lp-blob" style="background:var(--lp-accent);width:320px;height:320px;top:-70px;right:8%"></div>` : '';
  return `<section class="lp-hero">${blob}<div class="lp-wrap" style="text-align:center;padding:56px 0 62px"><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead" style="margin-inline:auto;text-align:center">${esc(p.subtitle || p.description || '')}</p><div style="display:flex;justify-content:center;margin:18px 0">${pricing(p, true)}</div><div style="display:flex;justify-content:center">${cta(p, t, true)}</div><div style="display:flex;justify-content:center">${chips(t)}</div><div style="max-width:400px;margin:30px auto 0">${pframe(p, off)}</div></div></section>`;
}
function heroBanner(p, t) {
  // Full-bleed AI MARKETING scene + headline overlay (a real ad image), with the
  // clean real-product frame sitting below it — the product is not pasted on it.
  const off = offPct(p);
  const media = `<div style="max-width:360px;margin:-72px auto 0;position:relative;z-index:3">${pframe(p, off)}</div>`;
  return `<section class="lp-hero" style="padding:0"><div class="lp-wrap" style="padding-top:34px"><div class="lp-band" style="min-height:400px">${p.aiImg ? `<img src="${p.aiImg}" alt="">` : ''}<div class="lp-band-in"><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead" style="margin-inline:auto;color:#fff">${esc(p.subtitle || p.description || '')}</p></div></div>${media}<div style="text-align:center;margin-top:18px">${pricing(p, true)}</div><div style="display:flex;justify-content:center;margin-top:6px">${cta(p, t, true)}</div><div style="display:flex;justify-content:center">${chips(t)}</div></div></section>`;
}
function renderHero(tpl, p, t, multi) {
  // Banner hero consumes the hero product's AI image — only used for a SINGLE
  // product so each product's image is never shown twice.
  if (tpl.hero === 'banner' && !multi && p.aiMode === 'scene') return heroBanner(p, t);
  if (tpl.hero === 'center') return heroCenter(p, t, tpl);
  return heroSplit(p, t, tpl);
}

// ── AI MARKETING VISUAL (one per product) ──
// `ba`  → a single before/after image (split composition) with قبل/بعد labels.
// `scene` → a full-width lifestyle campaign band with overlaid copy.
function aiVisual(p, t) {
  if (!p.aiImg) return '';
  if (p.aiMode === 'ba') {
    return `<div class="lp-ba1"><span class="lp-ba1-l">${esc(t.before)}</span><span class="lp-ba1-r">${esc(t.after)}</span><img src="${p.aiImg}" alt=""></div>`;
  }
  return `<div class="lp-band"><img src="${p.aiImg}" alt=""><div class="lp-band-in"><h2 class="lp-h2">${esc(p.headline || p.name)}</h2><p class="lp-lead" style="margin-inline:auto;color:#fff">${esc(p.subtitle || p.description || '')}</p></div></div>`;
}
// A standalone section that showcases the hero product's marketing image.
function resultSection(p, t) {
  if (!p.aiImg) return '';
  const head = p.aiMode === 'ba' ? t.resultTitle : t.inAction;
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(head)}</h2></div>${aiVisual(p, t)}</div></section>`;
}

// ── SECTION RENDERERS ──
function dividerChips(t) { return `<section class="lp-section" style="padding:14px 0"><div class="lp-wrap"><div class="lp-divider"><span class="lp-chip">${ICONS.cash}${esc(t.cod)}</span><span class="lp-chip">${ICONS.truck}${esc(t.fast)}</span></div></div></section>`; }
function trustStrip(t) {
  const ic = [ICONS.cash, ICONS.truck, ICONS.badge];
  const cells = t.trust.map((title, i) => `<div><div class="lp-icn">${ic[i % ic.length]}</div><b>${esc(title)}</b><span>${esc(t.trustD[i] || '')}</span></div>`).join('');
  return `<section class="lp-section" style="padding:30px 0"><div class="lp-wrap"><div class="lp-trust">${cells}</div></div></section>`;
}
function benefits(p, t, tpl) {
  const items = (p.features && p.features.length ? p.features : [p.description]).filter(Boolean).slice(0, 4);
  if (!items.length) return '';
  const cards = items.map((f, i) => {
    const ic = ICONS[BENEFIT_ICONS[(i + (p.icnSeed || 0)) % BENEFIT_ICONS.length]];
    const parts = String(f).split(/[:：]/);
    const title = parts.length > 1 ? parts[0] : f;
    const desc = parts.length > 1 ? parts.slice(1).join(':') : '';
    if (tpl.benefits === 'flat') return `<div class="lp-ben"><div class="lp-icn">${ic}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`;
    return `<div class="lp-card"><div class="lp-icn">${ic}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`;
  }).join('');
  const wrap = tpl.benefits === 'flat' ? 'lp-bens' : 'lp-grid';
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><span class="lp-eyebrow">${esc(t.features)}</span><h2 class="lp-h2">${esc(t.why)}</h2></div><div class="${wrap}">${cards}</div></div></section>`;
}
function featureChecks(p, t, rev) {
  const items = (p.features && p.features.length ? p.features : []).slice(0, 5);
  if (!items.length) return '';
  const media = `<div class="lp-feature-media">${p.vTok && p.hasVariants ? p.vTok : `<div class="lp-pframe" style="aspect-ratio:4/3;box-shadow:none;border:0"><img src="${p.media}" alt="${esc(p.name)}"></div>`}</div>`;
  const copy = `<div><span class="lp-eyebrow">${esc(t.features)}</span><h3 class="lp-h3">${esc(p.headline || p.name)}</h3><ul class="lp-checks">${items.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
  return `<section class="lp-section lp-sec-alt"><div class="lp-wrap"><div class="lp-feature${rev ? ' rev' : ''}">${rev ? media + copy : copy + media}</div></div></section>`;
}
function moodBand(p, t) {
  // The single AI MARKETING image, presented full-width as a real campaign band
  // with the headline overlaid — no product pasted on it.
  if (!p.bandTok3) return '';
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-band"><img src="${p.bandTok3}" alt=""><div class="lp-band-in"><h2 class="lp-h2">${esc(p.headline || p.name)}</h2><p class="lp-lead" style="margin-inline:auto;color:#fff">${esc(p.subtitle || p.description || '')}</p></div></div></div></section>`;
}
function vsTable(p, t) {
  const feats = (p.features && p.features.length ? p.features : []).slice(0, 5);
  if (feats.length < 2) return '';
  const y = `<span class="lp-vmark y">${ICONS.check}</span>`;
  const n = `<span class="lp-vmark n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg></span>`;
  const rows = feats.map(f => { const title = String(f).split(/[:：]/)[0]; return `<div class="lp-vs-row"><span>${esc(title)}</span><span>${y}</span><span>${n}</span></div>`; }).join('');
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.vsWhy)}</h2></div><div class="lp-vs"><div class="lp-vs-row lp-vs-head"><span>${esc(t.features)}</span><span class="us">${esc(t.us)}</span><span>${esc(t.others)}</span></div>${rows}</div></div></section>`;
}
function offerBlock(p, t) {
  const off = offPct(p);
  const save = off ? `<span class="lp-save">${esc(t.save)} ${money(p.compare - p.price, p.cur)}</span>` : '';
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-offer">${save}<h2 class="lp-h2">${esc(p.headline || p.name)}</h2>${pricing(p, true)}<div style="display:flex;justify-content:center;margin-top:10px">${cta(p, t, true)}</div></div></div></section>`;
}
function productShowcase(products, t) {
  // Each product gets its OWN marketing image (before/after or lifestyle band)
  // above a clean photo + info row — so every product is marketed with its image.
  const blocks = products.map((p, i) => {
    const media = p.vTok && p.hasVariants ? p.vTok : `<div class="lp-shot"><img src="${p.media}" alt="${esc(p.name)}"></div>`;
    const feats = (p.features || []).slice(0, 3).map(f => `<li>${esc(f)}</li>`).join('');
    const vis = p.aiImg ? `<div style="margin-bottom:22px">${aiVisual(p, t)}</div>` : '';
    const row = `<div class="lp-feature${i % 2 ? ' rev' : ''}"><div class="lp-feature-media">${media}</div><div><h3 class="lp-h3">${esc(p.name)}</h3><p style="color:var(--lp-muted);margin:8px 0 6px">${esc(p.description || '')}</p>${feats ? `<ul class="lp-checks">${feats}</ul>` : ''}${pricing(p)}${cta(p, t, false)}</div></div>`;
    return `<div class="lp-showitem">${vis}${row}</div>`;
  }).join('');
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.available)}</h2></div>${blocks}</div></section>`;
}
function codBox(t) { return `<section class="lp-section"><div class="lp-wrap"><div class="lp-cod"><div class="lp-cod-ic">${ICONS.truck}</div><div><h3>${esc(t.codTitle)}</h3><p>${esc(t.codDesc)}</p></div></div></div></section>`; }
function steps(t) { return `<section class="lp-section lp-sec-alt"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.howTo)}</h2></div><div class="lp-steps">${t.steps.map((s, i) => `<div class="lp-step"><h3>${esc(s)}</h3><p>${esc(t.stepsD[i])}</p></div>`).join('')}</div></div></section>`; }
function faq(t) { const qs = [[t.q1, t.a1], [t.q2, t.a2], [t.q3, t.a3]]; return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.faq)}</h2></div><div class="lp-faq">${qs.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></section>`; }
function finalCta(p, t) { return `<section class="lp-section"><div class="lp-wrap"><div class="lp-final"><div class="lp-blob" style="background:#fff;width:260px;height:260px;top:-120px;right:-60px;opacity:.12"></div><h2 class="lp-h2">${esc(t.getToday)}</h2><p>${esc(t.limited)}</p><div style="display:flex;justify-content:center;margin-top:14px">${cta(p, t, true)}</div></div></div></section>`; }

// ── FLOWS: distinct section orderings (structural variety) ──
const FLOWS = [
  ['trust', 'benefits', 'feature', 'vs', 'offer', 'cod', 'steps', 'faq', 'final'],
  ['divider', 'benefits', 'offer', 'feature2', 'cod', 'steps', 'faq', 'final'],
  ['divider', 'benefits', 'feature', 'cod', 'steps', 'faq', 'final'],
  ['benefits', 'vs', 'feature2', 'offer', 'cod', 'steps', 'faq', 'final'],
  ['trust', 'feature', 'benefits', 'offer', 'cod', 'faq', 'steps', 'final'],
];
const HEROES = ['splitR', 'splitL', 'center'];
const BENEFIT_STYLES = ['cards', 'flat'];

// ── STYLE PACKS: each is a COMPLETE visual personality layered on the base CSS.
// Selectors use `.ai-lp.lp-pk-<id>` (2 classes) so they outrank the base
// `.ai-lp` rules. Colours still come from the per-product theme variables, so a
// pack + theme combination is what makes every page look genuinely different. ──
const STYLE_PACKS = {
  // 0 — Aurora: soft gradients, rounded, friendly (the refined base look).
  soft: '',
  // 1 — Editorial: magazine. Sharp corners, ruled cards, airy, restrained colour.
  editorial: `
.ai-lp.lp-pk-editorial{--lp-radius:3px;background:#fff;--lp-page:#fff}
.ai-lp.lp-pk-editorial .lp-hero{background:#fff;border-bottom:1px solid var(--lp-line)}
.ai-lp.lp-pk-editorial .lp-eyebrow{background:none;padding:0 0 6px;color:var(--lp-ink);letter-spacing:4px;font-weight:700;border-bottom:2px solid var(--lp-primary);border-radius:0}
.ai-lp.lp-pk-editorial .lp-title{font-weight:800;letter-spacing:-.015em}
.ai-lp.lp-pk-editorial .lp-h2{text-align:start}
.ai-lp.lp-pk-editorial .lp-head{margin-inline:0;text-align:start;max-width:680px}
.ai-lp.lp-pk-editorial .lp-card{background:none;border:0;border-top:2px solid var(--lp-ink);border-radius:0;box-shadow:none;padding:18px 0 4px}
.ai-lp.lp-pk-editorial .lp-card:hover{transform:none;box-shadow:none}
.ai-lp.lp-pk-editorial .lp-icn{background:none;color:var(--lp-primary);width:auto;height:auto;margin-bottom:8px}
.ai-lp.lp-pk-editorial .lp-icn svg{width:30px;height:30px}
.ai-lp.lp-pk-editorial .lp-btn,.ai-lp.lp-pk-editorial .lp-pframe,.ai-lp.lp-pk-editorial .lp-feature-media,.ai-lp.lp-pk-editorial .lp-band{border-radius:3px}
.ai-lp.lp-pk-editorial .lp-pframe{box-shadow:none;border:1px solid var(--lp-line);background:#fafafa}`,
  // 2 — Brutalist: hard borders, offset shadows, uppercase, flat blocks.
  brutal: `
.ai-lp.lp-pk-brutal{--lp-radius:0;--lp-page:#fffdf5;background:#fffdf5}
.ai-lp.lp-pk-brutal .lp-title,.ai-lp.lp-pk-brutal .lp-h2,.ai-lp.lp-pk-brutal .lp-h3{text-transform:uppercase;font-weight:900;letter-spacing:-.01em}
.ai-lp.lp-pk-brutal .lp-hero{background:var(--lp-page)}
.ai-lp.lp-pk-brutal .lp-eyebrow{background:var(--lp-ink);color:#fff;border-radius:0;border:0}
.ai-lp.lp-pk-brutal .lp-card,.ai-lp.lp-pk-brutal .lp-pframe,.ai-lp.lp-pk-brutal .lp-cod,.ai-lp.lp-pk-brutal .lp-offer,.ai-lp.lp-pk-brutal .lp-step,.ai-lp.lp-pk-brutal .lp-faq details,.ai-lp.lp-pk-brutal .lp-vs,.ai-lp.lp-pk-brutal .lp-feature-media,.ai-lp.lp-pk-brutal .lp-band,.ai-lp.lp-pk-brutal .lp-shot{border:2.5px solid var(--lp-ink);border-radius:0;box-shadow:7px 7px 0 var(--lp-ink)}
.ai-lp.lp-pk-brutal .lp-card:hover{transform:translate(-2px,-2px);box-shadow:9px 9px 0 var(--lp-ink)}
.ai-lp.lp-pk-brutal .lp-btn{border-radius:0;border:2.5px solid var(--lp-ink);box-shadow:5px 5px 0 var(--lp-ink);background:var(--lp-accent);color:var(--lp-ink)}
.ai-lp.lp-pk-brutal .lp-btn:hover{transform:translate(-2px,-2px);box-shadow:7px 7px 0 var(--lp-ink);filter:none}
.ai-lp.lp-pk-brutal .lp-icn{border-radius:0;border:2px solid var(--lp-ink);background:var(--lp-accent);color:var(--lp-ink)}
.ai-lp.lp-pk-brutal .lp-chip{border:2px solid var(--lp-ink);border-radius:0;box-shadow:3px 3px 0 var(--lp-ink)}
.ai-lp.lp-pk-brutal .lp-final{border:2.5px solid var(--lp-ink);box-shadow:8px 8px 0 var(--lp-ink)}`,
  // 3 — Minimal: near-monochrome, thin, small radius, lots of air.
  minimal: `
.ai-lp.lp-pk-minimal{--lp-radius:8px;--lp-page:#fafafa;background:#fafafa}
.ai-lp.lp-pk-minimal .lp-hero{background:#fafafa}
.ai-lp.lp-pk-minimal .lp-title{font-weight:700;letter-spacing:-.02em}
.ai-lp.lp-pk-minimal .lp-h2{font-weight:700}
.ai-lp.lp-pk-minimal .lp-eyebrow{background:none;color:var(--lp-muted);letter-spacing:3px;padding:0;border-radius:0}
.ai-lp.lp-pk-minimal .lp-card{background:#fff;border:1px solid #ececec;box-shadow:none}
.ai-lp.lp-pk-minimal .lp-card:hover{transform:none;box-shadow:0 10px 30px -20px rgba(0,0,0,.25)}
.ai-lp.lp-pk-minimal .lp-icn{background:#f3f3f3;color:var(--lp-ink)}
.ai-lp.lp-pk-minimal .lp-btn{background:var(--lp-ink);box-shadow:none}
.ai-lp.lp-pk-minimal .lp-pframe{background:#fff;border:1px solid #ececec;box-shadow:none}
.ai-lp.lp-pk-minimal .lp-pframe .lp-pfblob{display:none}`,
  // 4 — Playful: extra-round, bright accent fills, bouncy.
  playful: `
.ai-lp.lp-pk-playful{--lp-radius:30px}
.ai-lp.lp-pk-playful .lp-title,.ai-lp.lp-pk-playful .lp-h2{font-weight:900}
.ai-lp.lp-pk-playful .lp-hero{background:linear-gradient(180deg,color-mix(in srgb,var(--lp-accent) 16%,var(--lp-page)),var(--lp-page) 70%)}
.ai-lp.lp-pk-playful .lp-eyebrow{background:var(--lp-accent);color:#1a1300}
.ai-lp.lp-pk-playful .lp-card{border-radius:26px;border:0;background:color-mix(in srgb,var(--lp-primary) 7%,#fff);box-shadow:0 14px 34px -22px color-mix(in srgb,var(--lp-primary) 80%,#000)}
.ai-lp.lp-pk-playful .lp-icn{border-radius:18px;background:linear-gradient(135deg,var(--lp-primary),var(--lp-accent));color:#fff}
.ai-lp.lp-pk-playful .lp-btn{border-radius:999px}
.ai-lp.lp-pk-playful .lp-chip{border-radius:999px;border:0;background:color-mix(in srgb,var(--lp-accent) 18%,#fff)}
.ai-lp.lp-pk-playful .lp-pframe{border-radius:34px}
.ai-lp.lp-pk-playful .lp-step{border-radius:24px}`,
  // 5 — Warm/Organic: earthy, soft, generous radius, calm.
  warm: `
.ai-lp.lp-pk-warm{--lp-radius:20px;--lp-page:#f7f1e8;background:#f7f1e8;--lp-line:#e6dccb;--lp-surface:#fffdf8}
.ai-lp.lp-pk-warm .lp-hero{background:linear-gradient(180deg,#efe6d6,#f7f1e8 75%)}
.ai-lp.lp-pk-warm .lp-eyebrow{background:color-mix(in srgb,var(--lp-primary) 14%,#fff);color:var(--lp-primary-d)}
.ai-lp.lp-pk-warm .lp-card{background:#fffdf8;border:1px solid #ece2d2;box-shadow:0 14px 30px -22px rgba(80,60,30,.4)}
.ai-lp.lp-pk-warm .lp-icn{border-radius:50%}
.ai-lp.lp-pk-warm .lp-pframe{background:radial-gradient(120% 120% at 30% 20%,#fff,#f3ead9 75%);border-color:#ece2d2}
.ai-lp.lp-pk-warm .lp-sec-alt{background:#fffdf8!important}`,
  // 6 — Tech: dark hero + bands, glowing accent, mono eyebrow, tight radius.
  tech: `
.ai-lp.lp-pk-tech{--lp-radius:14px}
.ai-lp.lp-pk-tech .lp-hero{background:radial-gradient(120% 90% at 70% 0%,color-mix(in srgb,var(--lp-primary) 32%,#0a0e1a),#070a13);color:#eef2ff}
.ai-lp.lp-pk-tech .lp-hero .lp-title,.ai-lp.lp-pk-tech .lp-hero .lp-h2{color:#fff}
.ai-lp.lp-pk-tech .lp-hero .lp-lead{color:#aeb8d4}
.ai-lp.lp-pk-tech .lp-eyebrow{font-family:ui-monospace,'SFMono-Regular',Menlo,monospace;letter-spacing:2px;background:color-mix(in srgb,var(--lp-accent) 22%,#0a0e1a);color:var(--lp-accent);border:1px solid color-mix(in srgb,var(--lp-accent) 40%,transparent)}
.ai-lp.lp-pk-tech .lp-hero .lp-price{color:#fff}
.ai-lp.lp-pk-tech .lp-card{background:#fff;border:1px solid var(--lp-line);box-shadow:0 1px 0 color-mix(in srgb,var(--lp-primary) 20%,#fff),0 18px 40px -28px rgba(10,14,26,.6)}
.ai-lp.lp-pk-tech .lp-icn{background:color-mix(in srgb,var(--lp-primary) 14%,#fff);box-shadow:0 0 22px -6px color-mix(in srgb,var(--lp-primary) 60%,transparent)}
.ai-lp.lp-pk-tech .lp-btn{box-shadow:0 0 26px -4px color-mix(in srgb,var(--lp-primary) 70%,transparent)}
.ai-lp.lp-pk-tech .lp-pframe{background:radial-gradient(120% 120% at 30% 20%,color-mix(in srgb,var(--lp-primary) 12%,#fff),#fff 72%)}`,
  // 7 — Glass: translucent frosted cards over a soft gradient field.
  glass: `
.ai-lp.lp-pk-glass{background:linear-gradient(160deg,color-mix(in srgb,var(--lp-primary) 12%,var(--lp-page)),color-mix(in srgb,var(--lp-accent) 10%,var(--lp-page)) 60%,var(--lp-page))}
.ai-lp.lp-pk-glass .lp-hero{background:transparent}
.ai-lp.lp-pk-glass .lp-sec-alt{background:transparent!important}
.ai-lp.lp-pk-glass .lp-card,.ai-lp.lp-pk-glass .lp-step,.ai-lp.lp-pk-glass .lp-cod,.ai-lp.lp-pk-glass .lp-offer,.ai-lp.lp-pk-glass .lp-vs,.ai-lp.lp-pk-glass .lp-faq details,.ai-lp.lp-pk-glass .lp-pframe{background:rgba(255,255,255,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.6);box-shadow:0 18px 40px -26px rgba(20,20,50,.4)}
.ai-lp.lp-pk-glass .lp-chip{background:rgba(255,255,255,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.6)}
.ai-lp.lp-pk-glass .lp-icn{background:rgba(255,255,255,.6)}`,
};
const PACK_IDS = Object.keys(STYLE_PACKS); // 8 packs

// Build the 40 templates: 8 style packs × 5 flows, with hero + benefit style
// rotated so every pack appears in several structural forms.
const TEMPLATES = [];
let _tid = 0;
for (const pack of PACK_IDS) for (let f = 0; f < FLOWS.length; f++) {
  const hero = HEROES[_tid % HEROES.length];
  const ben = BENEFIT_STYLES[_tid % BENEFIT_STYLES.length];
  TEMPLATES.push({ id: 't' + _tid, pack, hero, benefits: ben, flow: FLOWS[f], scene: hero === 'banner' ? 'banner' : 'band', decor: (_tid % 2 === 0) });
  _tid++;
}
// Add a banner-hero variant per pack (scene lives in the hero band) for 8 more
// distinct looks → 48 templates total.
for (const pack of PACK_IDS) {
  TEMPLATES.push({ id: 't' + _tid, pack, hero: 'banner', benefits: BENEFIT_STYLES[_tid % 2], flow: FLOWS[_tid % FLOWS.length], scene: 'banner', decor: (_tid % 2 === 0) });
  _tid++;
}

function hashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

// Pick a template from ALL of them by a stable seed — decoupled from the colour
// mood so structure, style pack and palette vary independently.
function pickTemplate(mood, seed) {
  const h = hashStr((mood || '') + '|' + (seed || ''));
  return TEMPLATES[h % TEMPLATES.length];
}

// CSS for a chosen pack (to be injected after the base stylesheet by chatbot.js).
function packCss(packId) { return STYLE_PACKS[packId] || ''; }

// Render the full inner section list for a template.
function renderTemplate(tpl, products, t, multi) {
  const p0 = products[0];
  p0.icnSeed = hashStr(tpl.id);
  const out = [renderHero(tpl, p0, t, multi)];
  // Single product: the hero product's ONE AI marketing image gets a dedicated
  // "see the difference" section right under the hero — unless the banner hero
  // already used it as the backdrop. (Multi: each product's image lives in its
  // showcase block below.)
  if (!multi && !(tpl.hero === 'banner' && p0.aiMode === 'scene')) out.push(resultSection(p0, t));
  let featRev = false;
  let showcaseDone = false;
  for (const key of tpl.flow) {
    switch (key) {
      case 'divider': out.push(dividerChips(t)); break;
      case 'trust': out.push(trustStrip(t)); break;
      case 'benefits': out.push(benefits(p0, t, tpl)); break;
      case 'feature': out.push(featureChecks(p0, t, false)); featRev = true; break;
      case 'feature2': out.push(featureChecks(p0, t, featRev)); featRev = !featRev; break;
      case 'vs': out.push(vsTable(p0, t)); break;
      case 'offer': out.push(offerBlock(p0, t)); break;
      case 'cod': if (multi && !showcaseDone) { out.push(productShowcase(products, t)); showcaseDone = true; } out.push(codBox(t)); break;
      case 'steps': out.push(steps(t)); break;
      case 'faq': out.push(faq(t)); break;
      case 'final': out.push(finalCta(p0, t)); break;
    }
  }
  if (multi && !showcaseDone) out.splice(1, 0, productShowcase(products, t));
  return out.filter(Boolean).join('\n');
}

module.exports = { TEMPLATES, STYLE_PACKS, PACK_IDS, pickTemplate, packCss, renderTemplate, TXT };

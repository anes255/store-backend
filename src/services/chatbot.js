const https = require('https');
// Design intelligence distilled from the ui-ux-pro-max skill (161 category
// palettes + font pairings) — gives each AI page a theme matched to its product.
let designKnowledge = { pickTheme: () => null };
try { designKnowledge = require('../data/designKnowledge'); } catch (e) { console.log('[AI] designKnowledge not loaded:', e.message); }
let landingTemplates = null;
try { landingTemplates = require('./landingTemplates'); } catch (e) { console.log('[AI] landingTemplates not loaded:', e.message); }

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
// Default to a fast, cheap model; override with OPENAI_MODEL (e.g. gpt-4o for best copy)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// AI marketing-image cost controls (gpt-image-1). Cheapest by default; override
// with OPENAI_IMAGE_QUALITY=medium / OPENAI_IMAGE_SIZE=1536x1024 for more polish.
const IMG_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || 'low').toLowerCase();
const IMG_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';

// Cache by store+message combo, not by prompt
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.time > CACHE_TTL) { cache.delete(key); return null; }
  return e.value;
}
function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

// Landing pages embed a costly AI image, so we cache the finished HTML per
// product-set + language for 6h. Identical inputs are then FREE (no GPT copy
// call, no image generation) — the single biggest cost saver. A product edit
// changes the signature and busts the entry automatically.
const landingCache = new Map();
const LANDING_TTL = 6 * 60 * 60 * 1000;
function landingSig(products, store, language) {
  const parts = (products || []).slice(0, 8).map(p => {
    const img = (Array.isArray(p.images) ? p.images : []).filter(Boolean)[0] || p.thumbnail || p.image || '';
    return [p.product_id || p.id, p.name_ar || p.name_en || p.name, p.price, p.compare_at_price || p.compare_price, p.updated_at || '', img ? img.length : 0].join('~');
  });
  return 'lp:' + (language || 'en') + ':' + (store && (store.name || store.store_name) || '') + ':' + parts.join('|');
}
function getLanding(key) {
  const e = landingCache.get(key);
  if (!e) return null;
  if (Date.now() - e.time > LANDING_TTL) { landingCache.delete(key); return null; }
  return e.value;
}
function setLanding(key, value) {
  landingCache.set(key, { value, time: Date.now() });
  if (landingCache.size > 100) landingCache.delete(landingCache.keys().next().value);
}

// Last OpenAI failure reason (status + message), so callers can surface why a
// GPT call fell through instead of silently degrading to another provider.
let lastOpenAIError = null;

// ═══ OPENAI (GPT) — proper chat format ═══
function openaiCall(systemPrompt, messages, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!OPENAI_KEY) return resolve(null);

    const chatMessages = [{ role: 'system', content: systemPrompt }];
    for (const m of messages) {
      chatMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text || m.content || ''
      });
    }

    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages: chatMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      // Large generations (full landing-page HTML) can take a while on gpt-4o.
      timeout: maxTokens > 2000 ? 110000 : (maxTokens > 800 ? 40000 : 12000),
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const text = JSON.parse(d).choices[0].message.content;
            console.log('[AI] OpenAI OK:', text.substring(0, 60));
            lastOpenAIError = null;
            resolve({ text, model: OPENAI_MODEL });
          } catch { resolve(null); }
        } else {
          let msg = String(res.statusCode);
          try { msg = JSON.parse(d).error?.message || msg; } catch {}
          console.log('[AI] OpenAI error:', msg);
          lastOpenAIError = { status: res.statusCode, message: msg };
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { lastOpenAIError = { message: e.message }; resolve(null); });
    req.on('timeout', () => { req.destroy(); lastOpenAIError = { message: 'OpenAI request timed out' }; resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ OPENAI IMAGE GENERATION ═══
// Generates a real image with OpenAI (gpt-image-1, falling back to dall-e-3) and
// returns a data URI ready to embed in <img src="...">. Used to give AI landing
// pages genuine generated visuals.
function openaiImageOnce(model, prompt, size) {
  return new Promise((resolve) => {
    // Each model supports different sizes — normalize wide/tall/square per model.
    const wide = size === '1536x1024' || size === '1792x1024';
    const tall = size === '1024x1536' || size === '1024x1792';
    const useSize = model === 'gpt-image-1'
      ? (wide ? '1536x1024' : tall ? '1024x1536' : '1024x1024')
      : (wide ? '1792x1024' : tall ? '1024x1792' : '1024x1024');
    const payload = { model, prompt: String(prompt).slice(0, 3800), n: 1, size: useSize };
    // gpt-image-1: output compressed WebP so the base64 embedded in the page is
    // ~8x smaller than PNG (a 2.6MB PNG hero becomes ~300KB) — keeps pages fast.
    // Quality is env-tunable (low|medium|high) so cost can be dialed down; default
    // is "low" — visibly fine for a marketing backdrop and the cheapest option
    // (≈4x cheaper than medium at 1024², which is why each page now costs less).
    if (model === 'gpt-image-1') { payload.quality = IMG_QUALITY; payload.output_format = 'webp'; payload.output_compression = 70; }
    else { payload.response_format = 'b64_json'; payload.quality = 'standard'; } // dall-e-3
    const outMime = model === 'gpt-image-1' ? 'image/webp' : 'image/png';
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 90000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { const b64 = JSON.parse(d).data[0].b64_json; return resolve(b64 ? `data:${outMime};base64,${b64}` : null); } catch { return resolve(null); }
        }
        let msg = String(res.statusCode); try { msg = JSON.parse(d).error?.message || msg; } catch {}
        console.log(`[AI] image ${model} error:`, msg);
        resolve({ _err: msg, _status: res.statusCode });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}
async function openaiImage(prompt, size = '1024x1024') {
  if (!OPENAI_KEY) return null;
  const a = await openaiImageOnce('gpt-image-1', prompt, size);
  if (typeof a === 'string') return a;
  // gpt-image-1 may be unavailable (org not verified) — fall back to DALL·E 3.
  const b = await openaiImageOnce('dall-e-3', prompt, size);
  return typeof b === 'string' ? b : null;
}

// Resolve a product image (data URI or http URL) to { buf, mime } for upload.
function imageToBuffer(src) {
  return new Promise((resolve) => {
    if (!src || typeof src !== 'string') return resolve(null);
    const m = src.match(/^data:(image\/(png|jpe?g|webp));base64,(.+)$/i);
    if (m) { try { return resolve({ buf: Buffer.from(m[3], 'base64'), mime: m[1].toLowerCase() }); } catch { return resolve(null); } }
    if (/^https?:\/\//i.test(src)) {
      try {
        const lib = src.startsWith('https') ? https : require('http');
        const req = lib.get(src, { timeout: 20000 }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return resolve(null); }
          const mime = (res.headers['content-type'] || 'image/png').split(';')[0];
          const chunks = []; res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ buf: Buffer.concat(chunks), mime: /image\//.test(mime) ? mime : 'image/png' }));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      } catch { resolve(null); }
    } else resolve(null);
  });
}

// ═══ OPENAI IMAGE EDIT (image-to-image) ═══
// Generates a NEW marketing image that incorporates the REAL product photo, via
// gpt-image-1's edits endpoint — so the product is woven into the scene instead
// of being pasted on top. Returns a data URI or null.
function openaiImageEditOnce(prompt, buf, mime, size) {
  return new Promise((resolve) => {
    if (!OPENAI_KEY || !buf) return resolve(null);
    const useSize = (size === '1536x1024' || size === '1792x1024') ? '1536x1024'
      : (size === '1024x1536' || size === '1024x1792') ? '1024x1536' : '1024x1024';
    const boundary = '----lpedit' + Buffer.from(String(buf.length)).toString('hex').slice(0, 12);
    const ext = /jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : 'png';
    const pre = [];
    const field = (n, v) => pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
    field('model', 'gpt-image-1');
    field('prompt', String(prompt).slice(0, 3800));
    field('size', useSize);
    field('quality', 'medium');
    field('output_format', 'webp');
    field('output_compression', '70');
    field('n', '1');
    pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="product.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`));
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([Buffer.concat(pre), buf, post]);
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/images/edits', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': body.length },
      timeout: 120000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) { try { const b64 = JSON.parse(d).data[0].b64_json; return resolve(b64 ? `data:image/webp;base64,${b64}` : null); } catch { return resolve(null); } }
        let msg = String(res.statusCode); try { msg = JSON.parse(d).error?.message || msg; } catch {}
        console.log('[AI] image edit error:', msg);
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}
async function openaiImageEdit(prompt, src, size = '1536x1024') {
  const ref = await imageToBuffer(src);
  if (!ref) return null;
  return openaiImageEditOnce(prompt, ref.buf, ref.mime, size);
}

// ═══ GROQ — proper chat format ═══
function groqCall(systemPrompt, messages, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!GROQ_KEY) return resolve(null);
    
    const chatMessages = [{ role: 'system', content: systemPrompt }];
    for (const m of messages) {
      chatMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text || m.content || ''
      });
    }

    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: chatMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });
    
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: maxTokens > 800 ? 20000 : 8000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const text = JSON.parse(d).choices[0].message.content;
            console.log('[AI] Groq OK:', text.substring(0, 60));
            resolve({ text, model: 'groq-llama3' });
          } catch { resolve(null); }
        } else {
          console.log('[AI] Groq error:', res.statusCode);
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ GEMINI ═══
function geminiCall(prompt, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!GEMINI_KEY) return resolve(null);
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: maxTokens > 800 ? 20000 : 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve({ text: JSON.parse(d).candidates[0].content.parts[0].text, model: 'gemini' }); } catch { resolve(null); }
        } else { console.log('[AI] Gemini error:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ CHAT — main function ═══
async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  
  if (!message || !message.trim()) return fallback('hello', store);

  // Cache key includes history length — different conversation state = different response
  const histLen = (history || []).length;
  const cacheKey = `${store.name || 'store'}:${histLen}:${message.trim().toLowerCase().substring(0, 60)}`;
  // Only use cache for repeated identical requests (same message at same point in conversation)
  const cached = getCached(cacheKey);
  if (cached) { console.log('[AI] Cache hit'); return cached; }

  const systemPrompt = buildPrompt(store, language);

  // Build conversation history for Groq (proper chat turns)
  const chatHistory = [];
  for (const h of (history || []).slice(-6)) {
    chatHistory.push({ role: h.role === 'user' ? 'user' : 'assistant', text: h.text || h.content || '' });
  }
  // Add current message
  chatHistory.push({ role: 'user', text: message });

  let result = null;

  // Try OpenAI (GPT) first — highest quality
  if (OPENAI_KEY) {
    result = await openaiCall(systemPrompt, chatHistory, 250);
  }

  // Try Groq next (proper chat format)
  if (!result?.text && GROQ_KEY) {
    result = await groqCall(systemPrompt, chatHistory, 250);
  }

  // Try Gemini as final fallback (flat prompt)
  if (!result?.text && GEMINI_KEY) {
    const hist = chatHistory.map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text}`).join('\n');
    result = await geminiCall(`${systemPrompt}\n\n${hist}\n\nBot:`, 250);
  }

  if (result?.text) {
    const response = { response: result.text, model: result.model, suggestedActions: tips(message) };
    setCache(cacheKey, response);
    return response;
  }

  const fb = fallback(message, store);
  const configured = [OPENAI_KEY && 'OpenAI', GROQ_KEY && 'Groq', GEMINI_KEY && 'Gemini'].filter(Boolean);
  fb.debug = configured.length ? 'AI providers failed' : 'Set OPENAI_API_KEY (or GROQ_API_KEY, free at console.groq.com)';
  return fb;
}

function buildPrompt(s, lang) {
  const l = {
    ar: 'STRICT LANGUAGE RULE: You MUST respond ONLY in Modern Standard Arabic. Every word must be Arabic. NEVER use French or English words. NEVER switch language.',
    fr: 'STRICT LANGUAGE RULE: Tu DOIS répondre UNIQUEMENT en français. Chaque mot doit être en français. Ne change JAMAIS de langue. Ne mélange JAMAIS avec l\'anglais ou l\'arabe.',
    en: 'STRICT LANGUAGE RULE: You MUST respond ONLY in English. Every word must be English. NEVER switch to French or Arabic. NEVER mix languages.',
    auto: 'STRICT LANGUAGE RULE: You MUST respond ONLY in English. Every word must be English. NEVER switch languages mid-conversation.'
  };
  const pays = [s.enable_cod && 'Cash on Delivery', s.enable_ccp && 'CCP Transfer', s.enable_baridimob && 'BaridiMob'].filter(Boolean);
  return `You are a professional customer support chatbot for "${s.name || s.store_name}", an online store in Algeria.

${l[lang] || l.en}
YOU MUST MAINTAIN THIS LANGUAGE FOR YOUR ENTIRE RESPONSE. DO NOT SWITCH MID-SENTENCE.

STORE INFORMATION (public, you can share this):
- Store name: ${s.name || s.store_name}
- Currency: ${s.currency || 'DZD'}
- Contact phone: ${s.contact_phone || 'Not available'}
- Payment methods: ${pays.join(', ') || 'Cash on Delivery'}
- Shipping: All 58 wilayas. Desk delivery: 300-800 DZD. Home delivery: 400-1400 DZD. Takes 1-7 days.

${s.products_summary || ''}

CAPABILITIES:
- You CAN tell customers which products are most popular (based on order counts)
- You CAN recommend products based on what the customer describes wanting
- You CAN tell product prices, descriptions, and availability
- You CAN explain shipping rates and payment methods

SECURITY RULES (NEVER violate):
- NEVER reveal store owner personal information (name, email, phone, address)
- NEVER reveal other customers' data (names, phones, orders, addresses)
- NEVER reveal internal business data (revenue, profit margins, total orders count)
- NEVER reveal API keys, passwords, or system configuration
- If asked for private data, politely say "I can only share product and store information"

BEHAVIOR:
- Keep responses to 2-3 sentences maximum
- Be friendly, helpful, and professional
- When a customer describes what they want, recommend matching products from the catalog
- If a product is out of stock, suggest similar alternatives
- Never invent products or prices not in the catalog above`;
}

function tips(m) {
  const s = (m || '').toLowerCase();
  if (s.includes('ship') || s.includes('توصيل')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (s.includes('pay') || s.includes('دفع')) return [{ label: 'Shipping', action: 'shipping_rates' }];
  return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Payment', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallback(msg, store) {
  const m = (msg || '').toLowerCase(), n = store.name || store.store_name || 'Store', c = store.currency || 'DZD';
  let r = `مرحباً! كيف يمكنني مساعدتك في ${n}؟`;
  if (m.includes('ship') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل لجميع 58 ولاية! من 300 ${c}.`;
  else if (m.includes('pay') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob.`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('سلام') || m.includes('مرحبا') || m.includes('bonjour') || m.includes('واش')) r = `مرحباً! 👋 كيف أساعدك في ${n}؟`;
  else if (m.includes('contact') || m.includes('اتصال')) r = `📞 ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 استخدم صفحة تتبع الطلبات.`;
  else if (m.includes('price') || m.includes('سعر') || m.includes('شحال')) r = `💰 تصفح منتجاتنا لمعرفة الأسعار.`;
  else if (m.includes('product') || m.includes('منتج')) r = `🛍️ تصفح كتالوج منتجاتنا للعثور على ما تبحث عنه!`;
  return { response: r, model: 'fallback', suggestedActions: tips(msg) };
}

// AI utilities for admin
async function aiGenerate(prompt, maxTokens = 150) {
  let result = null;
  if (OPENAI_KEY) result = await openaiCall('You are a helpful assistant. Follow instructions exactly.', [{ role: 'user', text: prompt }], maxTokens);
  if (!result?.text && GROQ_KEY) result = await groqCall('You are a helpful assistant. Follow instructions exactly.', [{ role: 'user', text: prompt }], maxTokens);
  if (!result?.text && GEMINI_KEY) result = await geminiCall(prompt, maxTokens);
  return result?.text || null;
}

async function generateProductDescription(name, cat, lang = 'en') {
  const l = {
    ar: 'in Modern Standard Arabic (فصحى). CRITICAL: Use ONLY Arabic letters and characters. Do NOT include ANY Chinese, Japanese, Korean, or other non-Arabic characters. Do NOT mix in English or French words. Every single character must be Arabic script, Arabic punctuation, or standard numbers.',
    fr: 'en français. Use ONLY French text, no other languages.',
    en: 'in English'
  };
  let result = await aiGenerate(`Write a product description (2 sentences) ${l[lang] || l.en} for: ${name} (${cat || 'General'}). Return ONLY the description text, nothing else.`);
  if (result && lang === 'ar') result = sanitizeArabic(result);
  return result;
}

// Strip non-Arabic/non-standard characters that AI sometimes injects into Arabic text
function sanitizeArabic(text) {
  if (!text) return text;
  // Remove CJK characters, random Unicode symbols, and other non-Arabic scripts
  // Keep: Arabic block (0600-06FF, 0750-077F, FB50-FDFF, FE70-FEFF), spaces, numbers, basic punctuation, emoji
  return text.replace(/[⺀-鿿　-〿豈-﫿぀-ゟ゠-ヿ가-힯]/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'in Modern Standard Arabic (فصحى). Use professional, clear Arabic. Do NOT use Algerian dialect. Do NOT include any non-Arabic characters.', fr: 'en français professionnel', en: 'in professional English' };
  let result = await aiGenerate(`Write a WhatsApp cart recovery message (2-3 lines) ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(',')}. Be friendly and urgent. Return ONLY the message text, nothing else.`);
  if (result && lang === 'ar') result = sanitizeArabic(result);
  return result;
}

async function detectFakeOrder(order, hist) {
  let s = 0; const f = [];
  if ((hist.cancelled || 0) >= 5) { s += 50; f.push('Very high cancellations'); }
  else if ((hist.cancelled || 0) >= 3) { s += 30; f.push('High cancellations'); }
  else if ((hist.cancelled || 0) >= 1) { s += 10; f.push('Previous cancellations'); }
  if (order.total > 50000) { s += 15; f.push('High value'); }
  return { score: Math.min(s, 100), level: s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low', flags: f };
}

async function moderateReview(content, rating) {
  if (!content || content.trim().length < 3) {
    return { score: rating >= 3 ? 80 : 40, reason: 'Very short review, rated by stars only', approved: rating >= 3 };
  }

  // Try AI moderation
  const prompt = `You are a review moderator. Analyze this product review and return ONLY a JSON object with:
- "score": 0-100 (100=definitely legitimate, 0=definitely spam/fake/inappropriate)
- "reason": short explanation
- "approved": true/false

Rules: Approve genuine reviews even if negative. Reject spam, gibberish, offensive content, or reviews with personal info (phone/email).

Review (rating: ${rating}/5): "${content.substring(0, 300)}"

Return ONLY the JSON, no other text.`;

  const result = await aiGenerate(prompt, 100);
  if (result) {
    try {
      const clean = result.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return { score: parseInt(parsed.score) || 50, reason: parsed.reason || '', approved: parsed.approved !== false };
    } catch (e) {}
  }

  // Fallback: basic rule-based moderation
  const lower = (content || '').toLowerCase();
  let score = 70;
  const flags = [];
  // Check for spam patterns
  if (/https?:\/\/|www\./i.test(content)) { score -= 30; flags.push('Contains URL'); }
  if (/(\d{8,})|(\w+@\w+\.\w+)/i.test(content)) { score -= 20; flags.push('Contains personal info'); }
  if (content.length < 10 && rating <= 2) { score -= 15; flags.push('Very short negative review'); }
  if (/fuck|shit|damn|ass|bitch/i.test(content)) { score -= 40; flags.push('Profanity'); }
  // Positive signals
  if (content.length > 30) score += 10;
  if (rating >= 4) score += 5;

  score = Math.max(0, Math.min(100, score));
  return { score, reason: flags.length ? flags.join(', ') : 'Basic check passed', approved: score >= 50 };
}

// ═══ AI LANDING PAGE GENERATOR ═══
// Analyzes products and generates a unique page structure, layout, copy, and theme
const LANDING_TEMPLATES = [
  { id: 'magazine', name: 'Magazine', mood: 'editorial, sophisticated', best_for: 'fashion, lifestyle, beauty, home decor' },
  { id: 'bento', name: 'Bento Grid', mood: 'modern, tech-forward', best_for: 'electronics, gadgets, tech accessories, multi-product bundles' },
  { id: 'timeline', name: 'Timeline Journey', mood: 'storytelling, narrative', best_for: 'skincare routines, collections, step-by-step products, kits' },
  { id: 'cards', name: 'Card Gallery', mood: 'clean, browsable', best_for: 'varied catalogs, general products, mixed categories' },
  { id: 'cinematic', name: 'Cinematic', mood: 'immersive, dramatic', best_for: 'luxury, premium products, watches, jewelry, perfume' },
  { id: 'minimal-zen', name: 'Minimal Zen', mood: 'serene, minimal', best_for: 'single hero products, artisan goods, handmade items' },
  { id: 'split-screen', name: 'Split Screen', mood: 'bold, high-contrast', best_for: 'comparisons, before/after, two hero products, sports gear' },
  { id: 'mosaic', name: 'Mosaic Collage', mood: 'creative, artistic', best_for: 'art, photography, prints, creative products, clothing collections' },
  { id: 'storytelling', name: 'Storytelling', mood: 'emotional, narrative', best_for: 'brand story products, heritage items, food, organic goods' },
  { id: 'alternating', name: 'Alternating', mood: 'balanced, classic', best_for: 'general products, e-commerce standard' },
  { id: 'stacked', name: 'Stacked', mood: 'content-focused', best_for: 'detailed products, products needing description space' },
  { id: 'showcase', name: 'Showcase', mood: 'dark, premium', best_for: 'high-end products, limited editions' },
  { id: 'product-hero', name: 'Product Hero', mood: 'conversion-focused, mobile-first', best_for: 'single product pages, COD offers, Landixo-style landing pages, impulse buys' },
];

async function generateLandingPage(products, store, language = 'en') {
  const productSummary = products.slice(0, 8).map((p, i) => {
    const name = p.name_en || p.name_fr || p.name_ar || p.name || 'Product';
    const price = p.price || 0;
    const cat = p.category_name || p.category || 'General';
    const desc = (p.description_en || p.description || '').substring(0, 100);
    const hasImage = !!(p.images?.[0] || p.thumbnail || p.image);
    return `${i + 1}. "${name}" — ${price} ${store.currency || 'DZD'}, category: ${cat}, ${desc ? 'desc: ' + desc : 'no description'}${hasImage ? ', has image' : ''}`;
  }).join('\n');

  const templateList = LANDING_TEMPLATES.map(t => `- ${t.id}: ${t.name} (${t.mood}) — best for: ${t.best_for}`).join('\n');

  const langInstructions = {
    ar: 'CRITICAL: Write ALL text content in clear, natural Modern Standard Arabic (فصحى). Hero title, subtitle, headlines, features, CTA — every single text field MUST be in Arabic. Use ONLY Arabic letters, Arabic punctuation, and standard numbers. Do NOT include ANY Chinese, Japanese, Korean, or other non-Arabic/non-Latin characters. Do NOT mix in English or French words. Do NOT add extra spaces between Arabic letters. Every word must be a real, complete Arabic word.',
    fr: 'Write ALL text content in French. Hero title, subtitle, headlines, features, CTA — everything in French.',
    en: 'Write ALL text content in English.',
  };

  const prompt = `You are an expert landing page designer and copywriter. Analyze these products and generate a complete, unique landing page configuration.

PRODUCTS:
${productSummary}

STORE: "${store.name || store.store_name}" (${store.currency || 'DZD'})

AVAILABLE LAYOUT TEMPLATES:
${templateList}

${langInstructions[language] || langInstructions.en}

YOUR TASK:
1. Analyze the products — what category, price range, target audience, mood
2. Pick the BEST layout template from the list above that matches these products
3. Pick a hero_style: "centered" | "split" | "minimal"
4. Pick an animation_style: "fade" | "slide-up" | "zoom"
5. Generate a color palette that matches the product mood (6 hex colors)
6. Write compelling hero copy (title + subtitle)
7. Write a unique headline, description, and 3 key features for EACH product
8. Write CTA button text
9. Decide which extra sections to show: trust_badges, social_proof, countdown, reviews

Return ONLY valid JSON (no markdown, no backticks):
{
  "layout_style": "template_id",
  "hero_style": "centered|split|minimal",
  "animation_style": "fade|slide-up|zoom",
  "hero_title": "compelling headline",
  "hero_subtitle": "supporting text, 1-2 sentences",
  "cta_text": "action button text",
  "colors": {
    "hero_bg": "#hex",
    "hero_text": "#hex",
    "cta_bg": "#hex",
    "cta_text_color": "#hex",
    "bg_color": "#hex",
    "accent_color": "#hex"
  },
  "show_trust_badges": true,
  "show_social_proof": true,
  "show_countdown": false,
  "show_reviews": true,
  "products": [
    {
      "headline": "attention-grabbing headline",
      "description": "2-3 sentence selling description",
      "features": ["feature 1", "feature 2", "feature 3"]
    }
  ],
  "page_mood": "one word describing the overall mood",
  "reasoning": "1 sentence on why you chose this template"
}`;

  // Extract the first balanced {...} JSON object from raw text
  const extractJson = (raw) => {
    if (!raw) return null;
    const s = raw.replace(/```json|```/g, '');
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  };

  const validLayouts = LANDING_TEMPLATES.map(t => t.id);

  // Try up to 2 times — Arabic generation sometimes returns malformed/empty JSON
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await aiGenerate(prompt, 1500);
    if (!result) continue;
    const clean = extractJson(result);
    if (!clean) { console.log('[AI] Landing: no JSON found, attempt', attempt + 1); continue; }
    try {
      const parsed = JSON.parse(clean);
      if (!validLayouts.includes(parsed.layout_style)) parsed.layout_style = 'alternating';
      // Sanitize Arabic text fields to remove stray non-Arabic characters
      if (language === 'ar') {
        const sanitizeStr = (v) => typeof v === 'string' ? sanitizeArabic(v) : v;
        if (parsed.hero_title) parsed.hero_title = sanitizeStr(parsed.hero_title);
        if (parsed.hero_subtitle) parsed.hero_subtitle = sanitizeStr(parsed.hero_subtitle);
        if (parsed.cta_text) parsed.cta_text = sanitizeStr(parsed.cta_text);
        if (Array.isArray(parsed.products)) {
          parsed.products = parsed.products.map(p => ({
            ...p,
            headline: sanitizeStr(p.headline),
            description: sanitizeStr(p.description),
            features: Array.isArray(p.features) ? p.features.map(sanitizeStr) : p.features,
          }));
        }
      }
      return parsed;
    } catch (e) {
      console.log('[AI] Landing page parse error (attempt', attempt + 1, '):', e.message);
    }
  }
  return null;
}

// ═══ PREMIUM DESIGN-SYSTEM CSS ═══
// A hand-crafted, agency-grade stylesheet injected into EVERY AI landing page.
// GPT only supplies the theme variables (colors + fonts) and semantic markup
// using these classes — this guarantees a polished, professional result every
// time instead of depending on GPT to free-hand good CSS. Everything is scoped
// under .ai-lp so it never leaks into the host app.
const LP_BASE_CSS = `
.ai-lp{--lp-primary:#6366f1;--lp-primary-d:#4338ca;--lp-accent:#f59e0b;--lp-bg:#0b1020;--lp-surface:#ffffff;--lp-ink:#1f2433;--lp-muted:#6b7280;--lp-line:#ece7df;--lp-page:#f7f3ec;--lp-radius:24px;--lp-shadow:0 10px 30px -14px rgba(31,36,51,.16),0 30px 60px -34px rgba(31,36,51,.2);--lp-font-display:'Outfit',system-ui,sans-serif;--lp-font-body:'DM Sans',system-ui,sans-serif;color:var(--lp-ink);font-family:var(--lp-font-body);line-height:1.65;-webkit-font-smoothing:antialiased;background:var(--lp-page);overflow-x:hidden}
.ai-lp *{box-sizing:border-box;margin:0;padding:0}
.ai-lp img{max-width:100%;display:block}
.ai-lp[dir=rtl]{text-align:right}
.ai-lp .lp-wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ai-lp .lp-section{position:relative;padding:64px 0}
.ai-lp .lp-bar{background:linear-gradient(90deg,var(--lp-primary),var(--lp-primary-d));color:#fff;text-align:center;font-weight:700;font-size:14px;letter-spacing:.2px;padding:11px 16px}
.ai-lp .lp-eyebrow{display:inline-block;font-family:var(--lp-font-display);font-weight:800;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--lp-primary);background:color-mix(in srgb,var(--lp-primary) 12%,#fff);padding:7px 14px;border-radius:999px;margin-bottom:16px}
.ai-lp .lp-title{font-family:var(--lp-font-display);font-weight:900;font-size:clamp(30px,6vw,56px);line-height:1.05;letter-spacing:-.02em}
.ai-lp .lp-h2{font-family:var(--lp-font-display);font-weight:850;font-size:clamp(24px,4.5vw,40px);line-height:1.12;letter-spacing:-.01em;text-align:center}
.ai-lp .lp-h3{font-family:var(--lp-font-display);font-weight:800;font-size:20px;line-height:1.2}
.ai-lp .lp-lead{font-size:clamp(16px,2.2vw,20px);color:var(--lp-muted);margin-top:14px;max-width:60ch}
.ai-lp .lp-sub{font-size:16px;color:var(--lp-muted);text-align:center;max-width:56ch;margin:14px auto 0}
.ai-lp .lp-center{text-align:center}
/* HERO */
.ai-lp .lp-hero{position:relative;background:linear-gradient(180deg,color-mix(in srgb,var(--lp-primary) 7%,var(--lp-page)),var(--lp-page) 72%);overflow:hidden}
.ai-lp .lp-hero-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:48px;align-items:center;padding:56px 0 64px}
.ai-lp .lp-hero-img{border-radius:var(--lp-radius);box-shadow:var(--lp-shadow);width:100%;object-fit:cover;aspect-ratio:4/3;background:#eef1f8}
/* HERO STAGE — AI marketing scene background with the REAL product layered in front (like the reference) */
.ai-lp .lp-stage{position:relative;border-radius:28px;overflow:hidden;aspect-ratio:4/5;box-shadow:var(--lp-shadow);background:#eef1f8;border:1px solid var(--lp-line)}
.ai-lp .lp-stage>img.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ai-lp .lp-stage::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0) 40%,rgba(15,18,30,.18))}
.ai-lp .lp-stage>img.prod{position:absolute;left:50%;bottom:6%;transform:translateX(-50%);width:74%;max-height:58%;object-fit:contain;filter:drop-shadow(0 26px 30px rgba(0,0,0,.4));z-index:1}
.ai-lp .lp-stage>.lp-badge{position:absolute;top:16px;inset-inline-end:16px;z-index:2;background:#fff;color:var(--lp-primary-d);font-family:var(--lp-font-display);font-weight:800;font-size:13px;padding:8px 14px;border-radius:999px;box-shadow:var(--lp-shadow)}
/* CLEAN PRODUCT FRAME — real product photo on a soft themed panel (no AI scene behind it) */
.ai-lp .lp-pframe{position:relative;border-radius:28px;overflow:hidden;aspect-ratio:4/5;display:grid;place-items:center;padding:9%;box-shadow:var(--lp-shadow);border:1px solid var(--lp-line);background:radial-gradient(120% 120% at 30% 20%,color-mix(in srgb,var(--lp-primary) 16%,#fff),color-mix(in srgb,var(--lp-accent) 10%,#fff) 70%,#fff)}
.ai-lp .lp-pframe>img{width:90%;height:88%;object-fit:contain;filter:drop-shadow(0 26px 34px rgba(15,18,30,.22));position:relative;z-index:1}
.ai-lp .lp-pframe>.lp-badge{position:absolute;top:16px;inset-inline-end:16px;z-index:2;background:#fff;color:var(--lp-primary-d);font-family:var(--lp-font-display);font-weight:800;font-size:13px;padding:8px 14px;border-radius:999px;box-shadow:var(--lp-shadow)}
.ai-lp .lp-pframe .lp-pfblob{position:absolute;border-radius:50%;filter:blur(50px);opacity:.5;width:55%;height:55%;background:var(--lp-primary)}
/* MOOD BAND — full-width AI lifestyle scene (no product) with overlay copy */
.ai-lp .lp-band{position:relative;border-radius:var(--lp-radius);overflow:hidden;min-height:320px;display:grid;place-items:center;text-align:center;color:#fff;box-shadow:var(--lp-shadow)}
.ai-lp .lp-band>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ai-lp .lp-band::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,11,20,.30),rgba(8,11,20,.66))}
.ai-lp .lp-band .lp-band-in{position:relative;z-index:1;padding:54px 24px;max-width:680px}
.ai-lp .lp-band .lp-h2,.ai-lp .lp-band .lp-lead,.ai-lp .lp-band p,.ai-lp .lp-band .lp-eyebrow{color:#fff}
/* DIVIDER WITH CHIPS (thin rule + centered pills, like the reference) */
.ai-lp .lp-divider{display:flex;align-items:center;justify-content:center;gap:14px;margin:8px 0;color:var(--lp-line)}
.ai-lp .lp-divider::before,.ai-lp .lp-divider::after{content:"";height:1px;flex:1;max-width:140px;background:currentColor}
.ai-lp .lp-divider .lp-chip{margin:0}
/* FLAT BENEFITS (clean, borderless — circular icon + bold title + desc) */
.ai-lp .lp-bens{display:grid;grid-template-columns:1fr 1fr;gap:32px 28px}
.ai-lp .lp-ben{display:flex;flex-direction:column;gap:5px}
.ai-lp .lp-ben .lp-icn{margin-bottom:8px}
.ai-lp .lp-ben h3{font-family:var(--lp-font-display);font-weight:800;font-size:17px;color:var(--lp-ink)}
.ai-lp .lp-ben p{color:var(--lp-muted);font-size:14px}
.ai-lp .lp-pricing{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:22px 0}
.ai-lp .lp-price{font-family:var(--lp-font-display);font-weight:900;font-size:clamp(30px,6vw,46px);color:var(--lp-primary-d)}
.ai-lp .lp-was{font-size:20px;color:var(--lp-muted);text-decoration:line-through}
.ai-lp .lp-off{background:var(--lp-accent);color:#1a1300;font-weight:800;font-size:13px;padding:6px 12px;border-radius:999px}
/* BUTTONS */
.ai-lp .lp-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:10px;font-family:var(--lp-font-display);font-weight:800;font-size:clamp(16px,2.4vw,19px);color:#fff;background:linear-gradient(135deg,var(--lp-primary),var(--lp-primary-d));border:0;cursor:pointer;padding:18px 34px;border-radius:999px;box-shadow:0 14px 30px -10px color-mix(in srgb,var(--lp-primary) 70%,transparent);transition:transform .18s,box-shadow .18s,filter .18s;overflow:hidden;text-align:center;width:auto}
.ai-lp .lp-btn:hover{transform:translateY(-2px);filter:brightness(1.06);box-shadow:0 22px 44px -12px color-mix(in srgb,var(--lp-primary) 75%,transparent)}
.ai-lp .lp-btn:active{transform:translateY(0)}
.ai-lp .lp-btn::after{content:"";position:absolute;top:0;left:-130%;width:60%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);transform:skewX(-18deg);animation:lp-shine 2.4s ease-out 2}
.ai-lp .lp-btn:hover::after{animation:lp-shine 1.1s ease-out 1}
@keyframes lp-shine{0%{left:-130%}100%{left:160%}}
.ai-lp .lp-btn-xl{padding:22px 46px;font-size:clamp(18px,3vw,22px)}
.ai-lp .lp-cta-note{display:block;font-size:13px;color:var(--lp-muted);margin-top:10px;font-weight:600}
/* CHIPS */
.ai-lp .lp-chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.ai-lp .lp-chip{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--lp-line);color:var(--lp-ink);font-weight:700;font-size:13px;padding:9px 14px;border-radius:999px;box-shadow:0 4px 12px -8px rgba(15,23,42,.25)}
.ai-lp .lp-chip svg{width:16px;height:16px;color:var(--lp-primary)}
/* GRID + CARDS */
.ai-lp .lp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
.ai-lp .lp-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ai-lp .lp-card{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:26px;box-shadow:0 6px 24px -16px rgba(15,23,42,.3);transition:transform .2s,box-shadow .2s;height:100%}
.ai-lp .lp-card:hover{transform:translateY(-5px);box-shadow:var(--lp-shadow)}
.ai-lp .lp-icn{width:52px;height:52px;display:grid;place-items:center;border-radius:15px;background:linear-gradient(135deg,color-mix(in srgb,var(--lp-primary) 18%,#fff),color-mix(in srgb,var(--lp-accent) 18%,#fff));color:var(--lp-primary-d);margin-bottom:16px}
.ai-lp .lp-icn svg{width:26px;height:26px}
.ai-lp .lp-card h3{font-family:var(--lp-font-display);font-weight:800;font-size:18px;margin-bottom:8px}
.ai-lp .lp-card p{color:var(--lp-muted);font-size:15px}
/* FEATURE ROWS */
.ai-lp .lp-feature{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:center;margin-top:36px}
.ai-lp .lp-feature.rev>*:first-child{order:2}
.ai-lp .lp-feature-media{border-radius:var(--lp-radius);overflow:hidden;box-shadow:var(--lp-shadow);aspect-ratio:4/3;background:linear-gradient(135deg,color-mix(in srgb,var(--lp-primary) 14%,#fff),color-mix(in srgb,var(--lp-accent) 14%,#fff))}
.ai-lp .lp-feature-media img{width:100%;height:100%;object-fit:cover}
.ai-lp .lp-checks{list-style:none;margin-top:18px;display:grid;gap:12px}
.ai-lp .lp-checks li{display:flex;gap:12px;align-items:flex-start;font-size:16px;font-weight:600}
.ai-lp .lp-checks li::before{content:"";flex:none;width:24px;height:24px;border-radius:50%;background:var(--lp-primary) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center/15px no-repeat;margin-top:1px}
/* SOCIAL PROOF */
.ai-lp .lp-stars{display:inline-flex;gap:3px;color:var(--lp-accent)}
.ai-lp .lp-stars svg{width:20px;height:20px;fill:currentColor}
.ai-lp .lp-quote{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:24px;box-shadow:0 6px 24px -16px rgba(15,23,42,.3)}
.ai-lp .lp-quote p{font-size:15px;color:var(--lp-ink);margin:12px 0 16px}
.ai-lp .lp-who{display:flex;align-items:center;gap:12px}
.ai-lp .lp-ava{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;font-family:var(--lp-font-display);background:linear-gradient(135deg,var(--lp-primary),var(--lp-accent))}
.ai-lp .lp-who b{font-family:var(--lp-font-display);font-size:15px}
.ai-lp .lp-who span{font-size:13px;color:var(--lp-muted)}
/* TRUST */
.ai-lp .lp-trust{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;text-align:center}
.ai-lp .lp-trust>div{padding:22px 14px}
.ai-lp .lp-trust .lp-icn{margin:0 auto 12px}
.ai-lp .lp-trust b{font-family:var(--lp-font-display);display:block;font-size:15px;margin-bottom:4px}
.ai-lp .lp-trust span{font-size:13px;color:var(--lp-muted)}
/* FINAL CTA */
.ai-lp .lp-final{background:linear-gradient(135deg,var(--lp-primary),var(--lp-primary-d));color:#fff;text-align:center;border-radius:var(--lp-radius);padding:56px 24px;box-shadow:var(--lp-shadow);position:relative;overflow:hidden}
.ai-lp .lp-final .lp-h2,.ai-lp .lp-final p{color:#fff}
.ai-lp .lp-final .lp-btn{background:#fff;color:var(--lp-primary-d)}
.ai-lp .lp-final .lp-btn::after{background:linear-gradient(100deg,transparent,rgba(79,70,229,.18),transparent)}
/* SECTION HEAD HELPER */
.ai-lp .lp-head{text-align:center;max-width:660px;margin:0 auto 38px}
/* MARKETING BAND (full-bleed AI lifestyle image + overlay text) */
.ai-lp .lp-band{position:relative;border-radius:var(--lp-radius);overflow:hidden;min-height:360px;display:grid;place-items:center;text-align:center;color:#fff;box-shadow:var(--lp-shadow)}
.ai-lp .lp-band>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ai-lp .lp-band::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(2,6,23,.30),rgba(2,6,23,.70))}
.ai-lp .lp-band-in{position:relative;z-index:1;padding:56px 24px;max-width:680px}
.ai-lp .lp-band .lp-title,.ai-lp .lp-band .lp-h2,.ai-lp .lp-band .lp-lead,.ai-lp .lp-band p{color:#fff}
/* BEFORE / AFTER */
.ai-lp .lp-ba{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.ai-lp .lp-ba figure{position:relative;border-radius:var(--lp-radius);overflow:hidden;box-shadow:var(--lp-shadow);aspect-ratio:3/4;background:#eef1f8}
.ai-lp .lp-ba img{width:100%;height:100%;object-fit:cover}
.ai-lp .lp-ba figcaption{position:absolute;top:12px;inset-inline-start:12px;z-index:1;font-family:var(--lp-font-display);font-weight:800;font-size:13px;color:#fff;padding:6px 14px;border-radius:999px}
.ai-lp .lp-ba .bad figcaption{background:#ef4444}
.ai-lp .lp-ba .good figcaption{background:#16a34a}
/* BEFORE/AFTER — single AI split image with قبل/بعد corner labels */
.ai-lp .lp-ba1{position:relative;border-radius:var(--lp-radius);overflow:hidden;box-shadow:var(--lp-shadow);max-width:780px;margin:0 auto;border:1px solid var(--lp-line);background:#eef1f8}
.ai-lp .lp-ba1>img{width:100%;display:block;aspect-ratio:16/10;object-fit:cover}
.ai-lp .lp-ba1-l,.ai-lp .lp-ba1-r{position:absolute;top:16px;z-index:1;font-family:var(--lp-font-display);font-weight:800;font-size:14px;color:#fff;padding:8px 18px;border-radius:999px;box-shadow:0 6px 18px -6px rgba(0,0,0,.4)}
.ai-lp .lp-ba1-l{inset-inline-start:16px;background:#ef4444}
.ai-lp .lp-ba1-r{inset-inline-end:16px;background:#16a34a}
.ai-lp .lp-showitem{margin-top:40px;padding-top:40px;border-top:1px solid var(--lp-line)}
.ai-lp .lp-showitem:first-child{margin-top:0;padding-top:0;border-top:0}
.ai-lp .lp-showitem .lp-feature{margin-top:0}
/* US vs OTHERS COMPARISON */
.ai-lp .lp-vs{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);overflow:hidden;box-shadow:0 6px 24px -16px rgba(15,23,42,.3);max-width:760px;margin:0 auto}
.ai-lp .lp-vs-row{display:grid;grid-template-columns:1fr 70px 70px;gap:8px;align-items:center;padding:15px 20px;border-bottom:1px solid var(--lp-line)}
.ai-lp .lp-vs-row:last-child{border-bottom:0}
.ai-lp .lp-vs-row>span:first-child{font-size:15px;font-weight:600}
.ai-lp .lp-vs-row>span{text-align:center}
.ai-lp .lp-vs-head{background:color-mix(in srgb,var(--lp-primary) 8%,#fff)}
.ai-lp .lp-vs-head span{font-family:var(--lp-font-display);font-weight:800;font-size:14px}
.ai-lp .lp-vs-head .us{color:var(--lp-primary-d)}
.ai-lp .lp-vmark{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%}
.ai-lp .lp-vmark.y{background:#dcfce7;color:#16a34a}
.ai-lp .lp-vmark.n{background:#fee2e2;color:#ef4444}
.ai-lp .lp-vmark svg{width:16px;height:16px}
/* SPECS / STATS */
.ai-lp .lp-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;text-align:center}
.ai-lp .lp-specs>div{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:18px;padding:22px 12px;box-shadow:0 6px 20px -16px rgba(15,23,42,.3)}
.ai-lp .lp-specs .lp-icn{margin:0 auto 8px;width:46px;height:46px}
.ai-lp .lp-specs b{font-family:var(--lp-font-display);display:block;font-size:24px;color:var(--lp-primary-d);line-height:1.1}
.ai-lp .lp-specs span{font-size:13px;color:var(--lp-muted)}
/* PRICING / OFFER */
.ai-lp .lp-offer{max-width:540px;margin:0 auto;background:var(--lp-surface);border:2px solid color-mix(in srgb,var(--lp-primary) 30%,#fff);border-radius:var(--lp-radius);padding:36px 28px;text-align:center;box-shadow:var(--lp-shadow)}
.ai-lp .lp-offer .lp-pricing{justify-content:center;margin:14px 0 8px}
.ai-lp .lp-save{display:inline-block;background:#dcfce7;color:#166534;font-weight:800;font-size:13px;padding:6px 14px;border-radius:999px;margin-bottom:8px}
/* DELIVERY / COD BOX */
.ai-lp .lp-cod{display:grid;grid-template-columns:auto 1fr;gap:22px;align-items:center;background:linear-gradient(135deg,color-mix(in srgb,var(--lp-primary) 10%,#fff),color-mix(in srgb,var(--lp-accent) 10%,#fff));border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:26px}
.ai-lp .lp-cod-ic{width:84px;height:84px;display:grid;place-items:center;border-radius:22px;background:#fff;color:var(--lp-primary);box-shadow:var(--lp-shadow)}
.ai-lp .lp-cod-ic svg{width:48px;height:48px}
.ai-lp .lp-cod h3{font-family:var(--lp-font-display);font-weight:800;font-size:19px;margin-bottom:6px}
.ai-lp .lp-cod p{color:var(--lp-muted);font-size:15px}
/* HOW TO ORDER STEPS */
.ai-lp .lp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:22px;counter-reset:lp}
.ai-lp .lp-step{position:relative;background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:32px 22px 22px;box-shadow:0 6px 24px -16px rgba(15,23,42,.3)}
.ai-lp .lp-step::before{counter-increment:lp;content:counter(lp);position:absolute;top:-18px;inset-inline-start:22px;width:42px;height:42px;display:grid;place-items:center;border-radius:13px;font-family:var(--lp-font-display);font-weight:900;font-size:19px;color:#fff;background:linear-gradient(135deg,var(--lp-primary),var(--lp-primary-d));box-shadow:0 8px 18px -8px color-mix(in srgb,var(--lp-primary) 70%,transparent)}
.ai-lp .lp-step h3{font-family:var(--lp-font-display);font-weight:800;font-size:17px;margin:4px 0 6px}
.ai-lp .lp-step p{color:var(--lp-muted);font-size:14px}
/* FAQ (native accordion, no JS) */
.ai-lp .lp-faq{display:grid;gap:12px;max-width:760px;margin:0 auto}
.ai-lp .lp-faq details{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:16px;padding:2px 20px;box-shadow:0 6px 24px -18px rgba(15,23,42,.3)}
.ai-lp .lp-faq summary{cursor:pointer;list-style:none;font-family:var(--lp-font-display);font-weight:700;font-size:16px;padding:16px 0;display:flex;justify-content:space-between;align-items:center;gap:12px}
.ai-lp .lp-faq summary::-webkit-details-marker{display:none}
.ai-lp .lp-faq summary::after{content:"+";font-size:24px;color:var(--lp-primary);font-weight:400;transition:transform .2s}
.ai-lp .lp-faq details[open] summary::after{transform:rotate(45deg)}
.ai-lp .lp-faq p{color:var(--lp-muted);font-size:15px;padding:0 0 16px;margin:0}
/* PRODUCT SHOWCASE (real product photo) */
.ai-lp .lp-shot{border-radius:var(--lp-radius);overflow:hidden;background:#fff;border:1px solid var(--lp-line);box-shadow:var(--lp-shadow);aspect-ratio:1/1;display:grid;place-items:center;padding:20px}
.ai-lp .lp-shot img{width:100%;height:100%;object-fit:contain}
/* VARIANT AUTO-CAROUSEL (pure CSS — auto-rotates variant images every 4s) */
.ai-lp .lp-var{position:relative;border-radius:var(--lp-radius);overflow:hidden;background:#fff;border:1px solid var(--lp-line);box-shadow:var(--lp-shadow);aspect-ratio:1/1}
.ai-lp .lp-var-track{display:flex;height:100%;width:calc(var(--m,1)*100%)}
.ai-lp .lp-var-slide{flex:0 0 calc(100%/var(--m,1));height:100%;display:grid;place-items:center;padding:20px}
.ai-lp .lp-var-slide img{width:100%;height:100%;object-fit:contain}
.ai-lp .lp-var-dots{position:absolute;bottom:12px;inset-inline-start:0;width:100%;display:flex;gap:7px;justify-content:center;z-index:2}
.ai-lp .lp-var-dot{width:8px;height:8px;border-radius:50%;background:var(--lp-primary);opacity:.3}
.ai-lp .lp-var-tag{position:absolute;top:12px;inset-inline-start:12px;z-index:2;background:#fff;color:var(--lp-primary-d);font-family:var(--lp-font-display);font-weight:800;font-size:12px;padding:6px 12px;border-radius:999px;box-shadow:var(--lp-shadow)}
@media (prefers-reduced-motion:reduce){.ai-lp .lp-var-track,.ai-lp .lp-var-dot{animation:none!important}}
.ai-lp .lp-tag{display:inline-block;font-family:var(--lp-font-display);font-weight:800;font-size:12px;color:var(--lp-primary-d);background:color-mix(in srgb,var(--lp-accent) 24%,#fff);padding:5px 12px;border-radius:999px;margin-bottom:10px}
/* DECOR + ANIMATION */
.ai-lp .lp-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.5;z-index:0;pointer-events:none}
.ai-lp .lp-section>.lp-wrap{position:relative;z-index:1}
@media (prefers-reduced-motion:no-preference){
 .ai-lp .lp-section,.ai-lp .lp-card,.ai-lp .lp-feature{animation:lp-rise .7s both;animation-timeline:view();animation-range:entry 0% cover 28%}
}
@keyframes lp-rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:none}}
/* RESPONSIVE */
@media (max-width:860px){
 .ai-lp .lp-hero-grid{grid-template-columns:1fr;gap:30px;text-align:center}
 .ai-lp .lp-hero-grid .lp-chips,.ai-lp .lp-hero-grid .lp-pricing{justify-content:center}
 .ai-lp .lp-feature,.ai-lp .lp-grid-2{grid-template-columns:1fr;gap:26px}
 .ai-lp .lp-feature.rev>*:first-child{order:0}
 .ai-lp .lp-cod{grid-template-columns:1fr;text-align:center}
 .ai-lp .lp-cod-ic{margin:0 auto}
 .ai-lp .lp-stage{max-width:420px;margin:0 auto}
 .ai-lp .lp-section{padding:48px 0}
 .ai-lp .lp-btn{width:100%}
}
@media (max-width:480px){
 .ai-lp .lp-bens{gap:26px 18px}
 .ai-lp .lp-ba{gap:12px}
}`.replace(/\n\s*/g, '\n').trim();

// ═══ VARIANT AUTO-CAROUSEL BUILDER ═══
// Builds a PURE-CSS auto-rotating gallery of a product's variant images that
// advances every 4s and loops seamlessly (the buyer page injects HTML via
// dangerouslySetInnerHTML, so <script> would never run — CSS animation only).
// Returns { html, css } with per-instance @keyframes so multiple carousels can
// coexist on one page. `placeholders` maps each slide to a {{Pi}}-style token so
// the heavy image data is injected once, after generation, like other images.
function buildVariantCarousel(tokens, idx) {
  const imgs = (tokens || []).filter(Boolean).slice(0, 6);
  if (imgs.length === 0) return null;
  if (imgs.length === 1) {
    return { html: `<div class="lp-var lp-var-${idx}"><div class="lp-var-track"><div class="lp-var-slide"><img src="${imgs[0]}" alt=""></div></div></div>`, css: `.lp-var-${idx}{--m:1}` };
  }
  const N = imgs.length, M = N + 1, step = 100 / M, total = N * 4; // 4s per variant
  const seq = [...imgs, imgs[0]]; // duplicate first slide → seamless loop
  const slides = seq.map(s => `<div class="lp-var-slide"><img src="${s}" alt=""></div>`).join('');
  let kf = '';
  for (let k = 0; k < N; k++) {
    const start = (k * 100 / N).toFixed(3), end = (k * 100 / N + 80 / N).toFixed(3), x = (k * step).toFixed(3);
    kf += `${start}%,${end}%{transform:translateX(-${x}%)}`;
  }
  kf += `100%{transform:translateX(-${(N * step).toFixed(3)}%)}`;
  const bright = (80 / N).toFixed(3), slot = (100 / N).toFixed(3);
  const dots = imgs.map((_, k) => `<span class="lp-var-dot" style="animation-delay:-${(N - k) * 4}s"></span>`).join('');
  const css =
    `.lp-var-${idx}{--m:${M}}` +
    `@keyframes lp-trk-${idx}{${kf}}` +
    `@keyframes lp-dot-${idx}{0%,${bright}%{opacity:1;transform:scale(1.35)}${slot}%,100%{opacity:.3;transform:scale(1)}}` +
    `.lp-var-${idx} .lp-var-track{animation:lp-trk-${idx} ${total}s infinite}` +
    `.lp-var-${idx} .lp-var-dot{animation:lp-dot-${idx} ${total}s infinite}`;
  const html = `<div class="lp-var lp-var-${idx}"><div class="lp-var-track">${slides}</div><div class="lp-var-dots">${dots}</div></div>`;
  return { html, css };
}

// ═══ FULL AI LANDING PAGE (HTML from scratch, no templates) ═══
// Uses GPT to design a complete, bespoke, conversion-optimized HTML marketing
// page for the given products. GPT picks the theme + writes the content/markup;
// a premium injected stylesheet (LP_BASE_CSS) guarantees the polish. Returns a
// self-contained HTML fragment the buyer renderer mounts directly. The functional
// order form, reviews and footer are still rendered by React around it.
async function generateLandingHTML(products, store, language = 'en', opts = {}) {
  const currency = store.currency || 'DZD';
  // A "regenerate" click means the user wants a DIFFERENT look — bust the cache
  // and salt the seed so a new template + palette is chosen. Otherwise serve an
  // identical, already-generated page for free (skips the GPT copy call AND the
  // paid image) — only rebuilds when a product actually changed.
  const reroll = !!(opts && opts.regenerate);
  const salt = reroll ? String((opts && opts.nonce) || Date.now()) : '';
  const cacheKey = landingSig(products, store, language);
  if (!reroll) { const cached = getLanding(cacheKey); if (cached) return cached; }
  const productLines = products.slice(0, 8).map((p, i) => {
    const name = p.name_ar && language === 'ar' ? p.name_ar : (p.name_fr && language === 'fr' ? p.name_fr : (p.name_en || p.name || 'Product'));
    const price = p.price || 0;
    const compare = p.compare_at_price || p.compare_price || 0;
    const cat = p.category_name || p.category || 'General';
    const desc = (p.description_ar && language === 'ar' ? p.description_ar : (p.description_en || p.description || '')).substring(0, 200);
    const imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
    const img = imgs[0] || p.thumbnail || p.image || '';
    const pid = p.product_id || p.id || '';
    // Product images can be huge base64 blobs. Give the model a SHORT token to
    // reference instead, and inject the real image once after generation — so the
    // page never bloats with repeated multi-KB image data (which broke saves).
    // Gather this product's VARIANT images (each variant can have its own
    // images) for the auto-rotating gallery; fall back to the product's own
    // photo gallery when there are no variant images.
    const variantImgs = [];
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        (Array.isArray(v.images) ? v.images : []).filter(Boolean).forEach(im => variantImgs.push(im));
      }
    }
    const gallery = [...new Set((variantImgs.length ? variantImgs : imgs).filter(Boolean))].slice(0, 6);
    const variantCount = gallery.length;
    return `Product ${i + 1}:
  id: ${pid}
  name: ${name}
  price: ${price} ${currency}${compare && compare > price ? ` (was ${compare} ${currency})` : ''}
  category: ${cat}
  description: ${desc || 'n/a'}
  image_token: ${img ? `{{P${i}}}` : 'none'}
  variants_token: ${variantCount > 1 ? `{{VARIANTS:${i}}} (auto-rotating gallery of ${variantCount} variant images — USE THIS to show the variants)` : (variantCount === 1 ? `{{VARIANTS:${i}}} (single image)` : 'none')}`;
  }).join('\n\n');
  // token -> real image url/data, for post-generation injection
  const productImages = products.slice(0, 8).map(p => {
    const imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
    return imgs[0] || p.thumbnail || p.image || '';
  });
  // Per-product variant image galleries (for the {{VARIANTS:i}} auto-carousel).
  const productVariants = products.slice(0, 8).map(p => {
    const imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
    const vimgs = [];
    if (Array.isArray(p.variants)) for (const v of p.variants) (Array.isArray(v.images) ? v.images : []).filter(Boolean).forEach(im => vimgs.push(im));
    return [...new Set((vimgs.length ? vimgs : imgs).filter(Boolean))].slice(0, 6);
  });

  const langRule = {
    ar: 'Write ALL visible text in clear, natural Modern Standard Arabic (فصحى). Set dir="rtl" on the root wrapper. Use ONLY Arabic letters, Arabic punctuation and standard numbers — NO Chinese/Japanese/Korean characters, no random Latin words.',
    fr: 'Write ALL visible text in natural, persuasive French.',
    en: 'Write ALL visible text in natural, persuasive English.',
  }[language] || 'Write ALL visible text in English.';

  const multi = products.length > 1;
  const productTokens = products.slice(0, 8).map((_, i) => `{{P${i}}}`).join(', ');

  // Pick a theme matched to the product's category (from the ui-ux-pro-max
  // design intelligence) so every page looks different and on-brand — not one
  // fixed look. Seeded by the first product so it's stable per page but varies.
  const p0 = products[0] || {};
  const themeCat = p0.category_name || p0.category || '';
  const themeSeed = (p0.name_ar || p0.name_en || p0.name || '') + (p0.product_id || p0.id || '') + salt;
  const theme = (designKnowledge.pickTheme && designKnowledge.pickTheme(themeCat, themeSeed, language)) || null;
  const arFont = language === 'ar';
  const fontImport = theme
    ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(theme.display).replace(/%20/g, '+')}:wght@600;700;800;900&family=${encodeURIComponent(theme.body).replace(/%20/g, '+')}:wght@400;500;700&display=swap`
    : '';
  const themeBlock = theme ? `
═══ RECOMMENDED THEME (from our design intelligence — chosen for this product's category "${theme.type}") ═══
Use these on the root wrapper and @import the fonts. You may fine-tune shades to fit, but keep this palette family — do NOT default to generic indigo.
--lp-primary:${theme.primary}; --lp-primary-d:${theme.primaryD}; --lp-accent:${theme.accent}; --lp-page:${theme.bg}; --lp-ink:${theme.ink};
Fonts → --lp-font-display:'${theme.display}'; --lp-font-body:'${theme.body}';
@import: <style>@import url('${fontImport}');</style>
` : '';

  const systemPrompt = `You are an elite direct-response designer who builds the clean, premium single-product "COD" (cash-on-delivery) landing pages that top Algerian/MENA brands run on Facebook & Instagram. Your pages look calm, spacious and expensive — soft off-white background, ONE confident accent color, lots of whitespace, big clear Arabic headlines, rounded cards, gentle shadows. NOT loud, NOT cluttered, NOT rainbow.

You output clean semantic HTML that plugs into a PROVIDED premium stylesheet (injected automatically) so you never hand-write CSS — you focus on: art direction (one tasteful theme color + a good font), structure, persuasive truthful Arabic copy, hand-drawn inline-SVG icons, and AI-generated MARKETING imagery.

CRITICAL ABOUT IMAGES: the AI images are MARKETING SCENES (the setting/world around the product) — never a re-drawing of the product itself. The REAL product photo is shown crisp on top of the scene (hero) and in the gallery, so it is never distorted. Scenes show the use-context, benefit or aspiration (e.g. for a dashcam: a calm night highway through a windshield).

DESIGN PRINCIPLES (agency-grade — apply rigorously): strong visual hierarchy (one clear focal point per section); generous whitespace and consistent rhythm; ONE accent color used intentionally; large confident type with a clear scale; alignment to a grid; restrained, purposeful motion; high contrast for readability; every section earns its place. Clean and premium over busy. You never use icon fonts, emoji icons, fake reviews/ratings, or external image URLs.`;

  const prompt = `Build a COMPLETE, clean, premium COD landing page that looks EXACTLY like a professional Algerian Facebook-ad product page (calm, spacious, soft off-white, one accent color, big Arabic headlines, rounded cards — like a top agency made it). ${multi ? 'There are MULTIPLE products — you MUST feature EVERY product below, each with its own real photo, price and order button.' : 'Single hero product — make it the star.'}

STORE: "${store.name || store.store_name}" — currency ${currency}, Algeria (Cash on Delivery, delivery to all 58 wilayas).

PRODUCT(S) (${products.length} total):
${productLines}

LANGUAGE: ${langRule}
${themeBlock}
═══ A DESIGN SYSTEM IS ALREADY INJECTED ═══
A premium stylesheet is added automatically. DO NOT redefine these classes — just USE them. Only thing you set yourself: the theme variables + a Google-font @import + optional tiny <style> flourishes (decorative .lp-blob, colors). Keep it CLEAN: one accent color, generous spacing.

ROOT (first line): set the theme variables and font @import. USE THE RECOMMENDED THEME above (its colors + fonts) — do not fall back to a generic indigo look:
<div class="ai-lp" dir="${language === 'ar' ? 'rtl' : 'ltr'}" style="--lp-primary:${theme ? theme.primary : '#XXXXXX'};--lp-primary-d:${theme ? theme.primaryD : '#XXXXXX'};--lp-accent:${theme ? theme.accent : '#XXXXXX'};--lp-page:${theme ? theme.bg : '#f7f3ec'};--lp-font-display:'${theme ? theme.display : 'DisplayFont'}';--lp-font-body:'${theme ? theme.body : 'BodyFont'}'">
  <style>@import url('${fontImport || "https://fonts.googleapis.com/css2?family=DisplayFont:wght@600;700;800;900&family=BodyFont:wght@400;500;700&display=swap"}');</style>
  ...sections...
</div>

CLASS TOOLKIT (build ONLY from these):
- Section wrapper: <section class="lp-section"><div class="lp-wrap">…</div></section>  · centered heading block: <div class="lp-head"><span class="lp-eyebrow">label</span><h2 class="lp-h2">title</h2><p class="lp-sub">subtitle</p></div>
- HERO with the real product composited over an AI marketing scene (USE THIS for the hero — it is the signature look):
  <section class="lp-hero"><div class="lp-wrap"><div class="lp-hero-grid">
    <div><span class="lp-eyebrow">…</span><h1 class="lp-title">…</h1><p class="lp-lead">…</p><div class="lp-pricing">…</div><button class="lp-btn lp-btn-xl" data-order data-add-product="ID">اطلب الآن<span class="lp-cta-note">price • الدفع عند الاستلام</span></button><div class="lp-chips">…</div></div>
    <div class="lp-stage"><img class="bg" src="{{AI_IMG: a real-life lifestyle/marketing SCENE for this product's world — the SETTING ONLY, do NOT draw the product itself; leave clean space where a product sits}}"><img class="prod" src="{{P0}}" alt="product"></div>
  (the REAL crisp product photo {{P0}} sits on top of the AI scene — this markets it in context without distorting it. Optionally add <span class="lp-badge">-XX%</span> when there is a real discount.)
  </div></div></section>
- Price: <div class="lp-pricing"><span class="lp-price">1200 ${currency}</span><span class="lp-was">1800 ${currency}</span><span class="lp-off">-33%</span></div>
- CTA (ALWAYS this): <button class="lp-btn lp-btn-xl" data-order data-add-product="EXACT_ID">اطلب الآن<span class="lp-cta-note">…</span></button>
- Trust chips (ONLY truthful store facts — COD, delivery to 58 wilayas): <div class="lp-chips"><span class="lp-chip"><svg…/>الدفع عند الاستلام</span><span class="lp-chip"><svg…/>توصيل لكل الولايات</span></div>   · Divider w/ chips: <div class="lp-divider"><span class="lp-chip">الدفع عند الاستلام</span><span class="lp-chip">توصيل سريع</span></div>
- BENEFITS (clean, borderless, 2×2): <div class="lp-bens"><div class="lp-ben"><div class="lp-icn"><svg…/></div><h3>عنوان:</h3><p>وصف قصير</p></div>… (4 benefits)</div>
- BEFORE / AFTER (markets the result — TWO AI images): <div class="lp-ba"><figure class="bad"><figcaption>قبل</figcaption><img src="{{AI_IMG: the WEAK result without this product — e.g. blurry grainy night footage}}"></figure><figure class="good"><figcaption>بعد</figcaption><img src="{{AI_IMG: the GREAT result with this product — e.g. crystal-clear sharp vivid night footage}}"></figure></div>
- US vs OTHERS: <div class="lp-vs"><div class="lp-vs-row lp-vs-head"><span>الميزة</span><span class="us">منتجنا</span><span>غيره</span></div><div class="lp-vs-row"><span>ميزة</span><span><span class="lp-vmark y"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span></span><span><span class="lp-vmark n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg></span></span></div>… (4-5 rows)</div>
- SPECS/stats: <div class="lp-specs"><div><div class="lp-icn"><svg…/></div><b>1080p</b><span>الدقة</span></div>… (3-4)</div>
- FEATURE row (image + checklist): <div class="lp-feature"><div><h3 class="lp-h3">…</h3><ul class="lp-checks"><li>نقطة</li>…</ul></div><div class="lp-feature-media"><img src="{{AI_IMG: in-use marketing scene}}"></div></div> (add class "rev" to alternate)
- OFFER block: <div class="lp-offer"><span class="lp-save">وفّر 2800 ${currency}</span><h2 class="lp-h2">…</h2><div class="lp-pricing">…</div><button class="lp-btn lp-btn-xl" data-order data-add-product="ID">…</button></div>
- COD/DELIVERY box: <div class="lp-cod"><div class="lp-cod-ic"><svg…truck…/></div><div><h3>الدفع عند الاستلام</h3><p>توصيل لكل 58 ولاية…</p></div></div>
- HOW TO ORDER: <div class="lp-steps"><div class="lp-step"><h3>…</h3><p>…</p></div>… (3 steps)</div>
- FAQ (no JS): <div class="lp-faq"><details><summary>سؤال؟</summary><p>جواب</p></details>…</div>
- VARIANT GALLERY (auto-rotates between a product's variant images every 4s): <div class="lp-feature-media">{{VARIANTS:i}}</div>  — i is the product index. Just drop the {{VARIANTS:i}} token where you want the gallery; it expands to a self-contained auto-scrolling carousel. Use it whenever a product's variants_token is provided.
- PRODUCT SHOWCASE card (for EACH product when multiple): a lp-feature row whose media is <div class="lp-feature-media">{{VARIANTS:i}}</div> (its auto-rotating variant gallery — or <div class="lp-shot"><img src="{{Pi}}"></div> if it has no variants_token) and whose text has the product name (lp-h3), 3 lp-checks, a lp-pricing and its own CTA with that product's id.
- FINAL CTA: <section class="lp-section"><div class="lp-wrap"><div class="lp-final"><h2 class="lp-h2">…</h2><p>…</p><button class="lp-btn lp-btn-xl" data-order data-add-product="ID">…</button></div></div></section>

═══ IMAGES — MARKETING, NOT RANDOM ═══
- Real product photos available: ${productTokens || 'none'}. Use each product's token EXACTLY ONCE (hero stage for the single/flagship product; the showcase card for the others). If a product's token is "none", put it inside a lp-stage over an {{AI_IMG}} scene.
- Request EXACTLY ONE {{AI_IMG:...}} per product — its hero lifestyle SCENE. ${multi ? 'One per product (so '+products.length+' total).' : 'Just ONE for the whole page (the hero).'} Do NOT request more than one image per product. The AI image is a MARKETING SCENE / SETTING ONLY — it does NOT contain the product (the real crisp product photo is layered on top). Describe the world around the product: who uses it, the place, lighting, mood, colors matching the theme, with clean empty space where the product will sit — e.g. "a calm night highway seen through a car windshield, city bokeh" (for a dashcam), "a bright modern gym, motivated athlete mid-workout" (for a supplement), "a serene marble bathroom counter, soft morning light" (for skincare). NEVER draw the product itself — keep it recognizable by showing the REAL photo on top. NO text/logos/watermarks. Every OTHER visual = inline SVG, CSS gradient, or the real product gallery ({{VARIANTS:i}}/{{Pi}}).
- VARIANTS: when a product has a variants_token, you MUST show it with {{VARIANTS:i}} (an auto-rotating gallery of its real variant images). Place it in that product's showcase media, and for a single hero product add a section «الألوان/الموديلات المتوفرة» right after the hero containing {{VARIANTS:0}}.
- Every icon = inline SVG. No external image URLs ever.

CHOOSE THE SECTIONS THAT FIT THE PRODUCT — do not force a fixed skeleton. The look stays clean & consistent, but pick the proof/visual style that suits THIS product.

REQUIRED SECTIONS (adapt order/contents to the product):
1) HERO (lp-hero with lp-stage: the REAL product photo {{P0}} layered over an AI marketing scene that fits the product; headline, value prop, price, CTA, trust chips). NO announcement bar at the very top.
2) divider with chips — ONLY true store facts (e.g. الدفع عند الاستلام • توصيل لكل الولايات). No warranty/guarantee unless given in the data.
${multi ? '' : '2b) VARIANTS gallery section «الألوان/الموديلات المتوفرة» with {{VARIANTS:0}} — ONLY if product 1 has a variants_token.\n'}3) BENEFITS (lp-bens, 4 clean benefits with SVG icons specific to this product)
4) A VISUAL-PROOF / feature section that FITS the product — use inline-SVG illustrations, CSS gradient panels, checklists (lp-feature with lp-checks) or the real product gallery ({{VARIANTS:0}}). Do NOT request extra AI images here (only ONE AI image per product, used in the hero).
5) US vs OTHERS comparison (lp-vs) — only with truthful, product-relevant rows
6) SPECS (lp-specs) — only real specs that apply to this product
${multi ? '7) PRODUCT SHOWCASE — one lp-feature card PER product (every product). Each card uses ONLY that product\'s own name/price/benefits/image — see the anti-mix rule.\n8)' : '7) one or two FEATURE rows (lp-feature with an in-use AI scene + checklist)\n8)'} OFFER block (lp-offer) + COD/DELIVERY box (lp-cod)
9) HOW TO ORDER steps (lp-steps)
10) FAQ (lp-faq, 3-4 real questions: delivery time, payment, warranty, returns)
11) FINAL CTA (lp-final)

HARD RULES:
1. Return ONLY raw HTML — no markdown, no \`\`\` fences, no commentary.
2. Root is the single <div class="ai-lp" …>. Do NOT redefine toolkit classes; only theme vars + font @import + tiny flourishes. Keep it CLEAN and spacious.
3. THEME MUST MATCH THE PRODUCT: use the RECOMMENDED THEME palette + fonts above (it is chosen for this product's category). Every page must look visually DIFFERENT and on-brand — never default to a generic indigo/lavender look. ${multi ? 'With multiple products, keep one clean store palette that suits them all.' : ''}
4. NEVER MIX PRODUCTS' INFORMATION. Every headline, benefit, spec, feature, image brief and FAQ must be about the CORRECT product only. ${multi ? 'Each product showcase card must contain ONLY that one product\'s name, price, description, benefits and image token ({{Pi}}/{{VARIANTS:i}} with the SAME index i). Do NOT describe one product with another product\'s features (e.g. never put supplement/creatine claims on a headset).' : 'All copy must match THIS product exactly — never borrow features from unrelated products.'}
5. SHOW THE REAL PRODUCT (never an AI re-drawing of it): the hero lp-stage shows the AI scene as the background with the REAL crisp product photo {{P0}} on top. ${multi ? 'Each product showcase shows its real image via {{VARIANTS:i}} (or {{Pi}}).' : 'Also add a variants/photo gallery via {{VARIANTS:0}} (or {{P0}} in a lp-shot).'} The AI image must be a SCENE only — it must never contain or re-draw the product.
6. NO announcement/top bar. NO testimonials, NO star ratings, NO review quotes, NO invented customer counts or fake numbers. CRITICAL: do NOT invent any promise or claim the seller did not provide — NO warranty/guarantee (e.g. "ضمان سنة" / "1-year guarantee"), NO money-back, NO free gifts, NO specific delivery time, NO certifications, NO fake specs. The ONLY claims allowed are: (a) facts taken directly from the product data above, and (b) the two store facts "الدفع عند الاستلام" (cash on delivery) and "توصيل لكل ولايات الجزائر" (delivery across Algeria). Everything else must come from the real product description. When unsure, leave it out.
7. EVERY CTA is <button class="lp-btn …" data-order data-add-product="EXACT_ID">…</button> using that product's EXACT id. No href/onclick. Real prices; struck-through "was" price + discount badge when present.
8. Each {{Pi}} at most ONCE. EXACTLY ONE {{AI_IMG}} per product (the hero scene) — no more. Inline SVG for all icons/decoration. No external image URLs.
9. Do NOT include the order form, inputs, <html>/<head>/<body>, nav or footer — the host app renders those.

Write rich, persuasive, truthful product-specific Arabic copy (no lorem, no placeholders). Return the HTML now.`;

  // GPT ONLY — the landing page must be generated by OpenAI's GPT, never by any
  // other provider. We do NOT fall back to Groq/Gemini here.
  if (!OPENAI_KEY) return { error: 'no_provider' };
  if (!landingTemplates) return { error: 'provider_failed' };

  // ═══ TEMPLATE RENDER ═══ GPT writes only the COPY (reliable JSON); we render it
  // into one of ~40 polished templates chosen by the product's category/mood.
  // No GPT-authored HTML to break; pages stay light; real product photos are
  // shown crisp in clean frames (never pasted onto an AI scene).
  const copy = await generateLandingPage(products, store, language) || {};
  const tmpl = landingTemplates.pickTemplate(theme ? theme.type : 'general', themeSeed);
  const tt = landingTemplates.TXT[language] || landingTemplates.TXT.en;
  const isMulti = products.length > 1;
  const norm = products.slice(0, 8).map((p, i) => {
    const name = p.name_ar && language === 'ar' ? p.name_ar : (p.name_fr && language === 'fr' ? p.name_fr : (p.name_en || p.name || 'Product'));
    const desc = (p.description_ar && language === 'ar' ? p.description_ar : (p.description_en || p.description || '')).substring(0, 220);
    const c = (copy.products && copy.products[i]) || {};
    return { id: p.product_id || p.id || '', name, cur: currency, price: p.price || 0, compare: p.compare_at_price || p.compare_price || 0, media: `{{P${i}}}`, vTok: `{{VARIANTS:${i}}}`, hasVariants: productVariants[i] && productVariants[i].length > 1, headline: c.headline || name, subtitle: '', description: c.description || desc, features: Array.isArray(c.features) ? c.features : [] };
  });
  if (norm[0]) { norm[0].headline = copy.hero_title || norm[0].headline; norm[0].subtitle = copy.hero_subtitle || norm[0].description; }
  // ONE AI marketing scene per page (setting/world only, NO product drawn) — an
  // aspirational ADVERTISING image, not a plain product photo. The real crisp
  // product photo is composited on top (stage/banner) so it's never distorted.
  // ═══ ONE AI MARKETING IMAGE PER PRODUCT ═══
  // Each product gets its OWN finished ad image — not one image for the whole
  // page. Result-driven categories (cameras, tools, skincare, fitness…) get a
  // BEFORE/AFTER split image (the قبل/بعد device); others get an aspirational
  // lifestyle campaign scene. The real product photo is always shown separately
  // in its own clean frame, never pasted onto the AI image.
  const baMoods = new Set(['tech', 'health', 'home', 'energetic', 'beauty']);
  norm.forEach((np, i) => {
    const src = products[i] || {};
    const cat = src.category_name || src.category || themeCat || '';
    const mood = (designKnowledge.moodFor && designKnowledge.moodFor(cat)) || (theme ? theme.type : 'general');
    let mode = baMoods.has(mood) ? 'ba' : 'scene';
    // A banner-hero backdrop needs a wide lifestyle scene, not a split image.
    if (i === 0 && tmpl.hero === 'banner' && !isMulti) mode = 'scene';
    const subj = np.name || cat || 'this product';
    np.aiMode = mode;
    if (mode === 'ba') {
      np.aiImg = `{{AI_IMG:a single ultra-realistic advertising photograph split down the middle by a jagged torn-paper tear, a clear BEFORE-and-AFTER comparison for ${subj} (category: ${cat || 'general'}). LEFT half = the POOR, frustrating result WITHOUT a good ${subj}: dull, dim, blurry, low quality, disappointing. RIGHT half = the impressive RESULT WITH it: vivid, sharp, bright, crisp, clean, satisfying. show the same real-world scene on both halves with dramatic visible contrast, photorealistic, cinematic lighting; do NOT draw, invent or feature the product/device itself; NO text, captions, numbers, logos or watermark}}`;
    } else {
      np.aiImg = `{{AI_IMG:a complete high-end ADVERTISING / marketing campaign photograph that sells ${subj} (category: ${cat || 'general'}): a real, relatable person actually enjoying the benefit or result in an aspirational real-world setting that fits this product's world, styled like a premium Facebook/Instagram ad creative, cinematic natural lighting, rich on-brand colors, depth and emotion, photorealistic — a finished standalone scene (the real product is shown SEPARATELY, NOT on this image); do NOT draw, invent or feature the actual product, and NO text, captions, logos or watermark}}`;
    }
  });
  const inner = landingTemplates.renderTemplate(tmpl, norm, tt, isMulti);
  const dir = language === 'ar' ? 'rtl' : 'ltr';
  const themeVars = theme ? `--lp-primary:${theme.primary};--lp-primary-d:${theme.primaryD};--lp-accent:${theme.accent};--lp-page:${theme.bg};--lp-ink:${theme.ink};--lp-font-display:'${theme.display}';--lp-font-body:'${theme.body}'` : '';
  let usedModel = 'template-' + tmpl.id + '-' + (tmpl.pack || 'soft');
  const packClass = tmpl.pack && tmpl.pack !== 'soft' ? ` lp-pk-${tmpl.pack}` : '';
  let html = `<div class="ai-lp${packClass}" dir="${dir}"${themeVars ? ` style="${themeVars.replace(/"/g, '&quot;')}"` : ''}>${fontImport ? `<style>@import url('${fontImport}');</style>` : ''}${inner}</div>`;

  // Inject the premium design-system stylesheet as the FIRST child of the .ai-lp
  // wrapper, so the page is guaranteed to look polished regardless of how much
  // CSS the model wrote. The model's own <style> (theme vars / fonts / flourishes)
  // comes after and can fine-tune, but never replaces the core look.
  const packCss = (landingTemplates.packCss && landingTemplates.packCss(tmpl.pack)) || '';
  html = html.replace(/(<div\b[^>]*class="ai-lp[^"]*"[^>]*>)/i, `$1<style>${LP_BASE_CSS}${packCss}</style>`);

  // THEME FALLBACK: if the model didn't set the category palette on the wrapper,
  // apply the recommended theme + font import ourselves so the page is never the
  // default look and always matches the product's category.
  if (theme) {
    const openTag = (html.match(/<div\b[^>]*class="ai-lp[^"]*"[^>]*>/i) || [''])[0];
    if (openTag && !/--lp-primary\s*:/.test(openTag)) {
      const vars = `--lp-primary:${theme.primary};--lp-primary-d:${theme.primaryD};--lp-accent:${theme.accent};--lp-page:${theme.bg};--lp-ink:${theme.ink};--lp-font-display:'${theme.display}';--lp-font-body:'${theme.body}'`;
      let newTag;
      if (/\bstyle="/i.test(openTag)) newTag = openTag.replace(/style="/i, `style="${vars};`);
      else newTag = openTag.replace(/>$/, ` style="${vars}">`);
      html = html.replace(openTag, newTag);
    }
    if (fontImport && !html.includes('fonts.googleapis.com')) {
      html = html.replace(/(<div\b[^>]*class="ai-lp[^"]*"[^>]*>)/i, `$1<style>@import url('${fontImport}');</style>`);
    }
  }

  // Inject the real product image(s) where the model used the short {{Pi}} tokens.
  // The FIRST use of each token gets the real image; any extra uses get a tiny
  // gradient placeholder — so even a big base64 product photo is embedded only
  // ONCE and the page can never bloat enough to break the save.
  const gradientPx = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='12'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23e9e9ef'/%3E%3Cstop offset='1' stop-color='%23d7d7e0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='16' height='12' fill='url(%23g)'/%3E%3C/svg%3E";
  let anyProductImageUsed = false;
  productImages.forEach((img, i) => {
    const tok = `{{P${i}}}`;
    let used = false;
    while (html.includes(tok)) {
      if (img) anyProductImageUsed = true;
      const rep = (!used && img) ? img : gradientPx;
      used = true;
      html = html.replace(tok, () => rep); // function form: avoids $-pattern issues
    }
  });
  // {{AI_HERO}} (legacy) -> first product image or gradient.
  if (html.includes('{{AI_HERO}}')) {
    const heroImg = productImages.find(Boolean) || gradientPx;
    html = html.split('{{AI_HERO}}').join(heroImg);
  }

  // ═══ VARIANT AUTO-CAROUSELS ═══
  // Replace each {{VARIANTS:i}} token with a pure-CSS auto-rotating gallery of
  // that product's variant images (advances every 4s). The per-instance keyframes
  // are collected and injected as one <style> at the top of the page.
  let variantCss = '';
  productVariants.forEach((imgs, i) => {
    const tok = `{{VARIANTS:${i}}}`;
    if (!html.includes(tok)) return;
    const built = buildVariantCarousel(imgs, i);
    if (built) {
      anyProductImageUsed = true;
      if (built.css) variantCss += built.css;
      // Embed the carousel (with real images) on the FIRST use; any extra use
      // gets a lightweight single image so base64 is never duplicated.
      let used = false;
      while (html.includes(tok)) {
        const rep = used ? `<div class="lp-shot"><img src="${imgs[0] || gradientPx}" alt=""></div>` : built.html;
        used = true;
        html = html.replace(tok, () => rep);
      }
    } else {
      // No images for this product — fall back to its main photo / gradient.
      html = html.split(tok).join(`<div class="lp-shot"><img src="${productImages[i] || gradientPx}" alt=""></div>`);
    }
  });
  if (variantCss) html = html.replace(/(<div\b[^>]*class="ai-lp[^"]*"[^>]*>)/i, `$1<style>${variantCss}</style>`);

  // SAFETY NET: if the model forgot to place ANY real product image, inject a
  // clean product gallery near the top so the page always shows the products.
  if (!anyProductImageUsed) {
    const cards = products.slice(0, 8).map((p, i) => {
      const built = buildVariantCarousel(productVariants[i], i);
      if (built && built.css) variantCss += built.css;
      const media = built ? built.html : `<div class="lp-shot"><img src="${productImages[i] || gradientPx}" alt=""></div>`;
      const nm = p.name_ar && language === 'ar' ? p.name_ar : (p.name_fr && language === 'fr' ? p.name_fr : (p.name_en || p.name || ''));
      const pid = p.product_id || p.id || '';
      const price = p.price || 0;
      const cur = store.currency || 'DZD';
      const cta = language === 'ar' ? 'اطلب الآن' : (language === 'fr' ? 'Commander' : 'Order now');
      return `<div class="lp-feature${i % 2 ? ' rev' : ''}"><div class="lp-feature-media">${media}</div><div><h3 class="lp-h3">${nm}</h3><div class="lp-pricing"><span class="lp-price">${price} ${cur}</span></div><button class="lp-btn lp-btn-xl" data-order data-add-product="${pid}">${cta}<span class="lp-cta-note">${price} ${cur}</span></button></div></div>`;
    }).join('');
    const galleryHead = language === 'ar' ? 'منتجاتنا' : (language === 'fr' ? 'Nos produits' : 'Our products');
    const gallery = `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${galleryHead}</h2></div>${cards}</div></section>`;
    // Insert right after the injected base <style> so it appears at the top.
    html = html.replace(/(<div\b[^>]*class="ai-lp[^"]*"[^>]*><style>[\s\S]*?<\/style>)/i, `$1${gallery}`);
    if (variantCss) html = html.replace(/(<div\b[^>]*class="ai-lp[^"]*"[^>]*>)/i, `$1<style>${variantCss}</style>`);
  }

  // ═══ GPT-GENERATED IMAGERY ═══
  // The model places <img src="{{AI_IMG: <prompt> }}"> tokens where it wants
  // bespoke photographic visuals. Generate each one with OpenAI's image model
  // (gpt-image-1 → DALL·E 3) and inject the result. GPT ONLY — no other AI.
  let imageModel = null;
  const aiImgRe = /\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g;
  const wantedPrompts = [];
  let m;
  while ((m = aiImgRe.exec(html)) !== null) {
    const p = (m[1] || '').trim();
    if (p) wantedPrompts.push(p);
  }
  if (wantedPrompts.length && OPENAI_KEY) {
    // ONE image per product — cap accordingly (slow & costly).
    const unique = [...new Set(wantedPrompts)].slice(0, Math.max(1, Math.min(8, products.length)));
    console.log(`[AI] LandingHTML: generating ${unique.length} image(s)…`);
    // Each prompt already fully describes its marketing composition (before/after
    // split or lifestyle scene); we only append shared quality cues here.
    const style = 'professional advertising photography, photorealistic, cinematic natural lighting, premium commercial quality, sharp focus, no text, no captions, no logos, no watermark';
    const results = await Promise.all(unique.map(async (p) => {
      try { const img = await openaiImage(`${p}. ${style}`, IMG_SIZE); if (img) imageModel = 'gpt-image'; return img; }
      catch (e) { console.log('[AI] image error:', e.message); return null; }
    }));
    const okCount = results.filter(Boolean).length;
    console.log(`[AI] LandingHTML: ${okCount}/${unique.length} marketing image(s) generated`);
    const map = {};
    unique.forEach((p, i) => { map[p] = results[i]; if (results[i]) imageModel = imageModel || 'gpt-image'; });
    // Replace every token: the prompt we generated -> data URI; anything we could
    // not generate (or extra duplicates beyond the cap) -> gradient placeholder.
    html = html.replace(/\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g, (_full, raw) => {
      const key = (raw || '').trim();
      return map[key] || gradientPx;
    });
  } else if (wantedPrompts.length) {
    // No key to generate — strip tokens to a gradient so the page still renders.
    html = html.replace(/\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g, () => gradientPx);
  }

  // Final safety net: only if the page is catastrophically large (e.g. the model
  // duplicated a base64 blob many times) do we drop embedded images. Real pages
  // with the product photo + up to 3 generated images stay well under this.
  if (html.length > 32000000) html = html.replace(/<img[^>]*src="data:image\/(png|jpe?g|webp)[^>]*>/g, '');
  // Hand back the chosen theme so the React checkout/order form below the page
  // can match its colours (accent, background, text) instead of the default.
  const themeOut = theme ? { primary: theme.primary, primaryD: theme.primaryD, accent: theme.accent, bg: theme.bg, ink: theme.ink, pack: tmpl.pack } : null;
  const out = { html, model: usedModel || 'ai', imageModel, theme: themeOut };
  // Cache the finished page so re-opening the builder for the same products is free.
  if (html && !reroll) setLanding(cacheKey, out);
  return out;
}

// ═══ TRANSLATE LANDING-PAGE STRINGS (GPT) ═══
// Translates an array of visible UI strings to the target language, preserving
// order, prices, numbers and brand names. Returns a same-length array (or null).
// The storefront caches the result so each language is translated only once.
async function translateTexts(texts, target) {
  if (!OPENAI_KEY) return null;
  if (!Array.isArray(texts) || !texts.length) return [];
  const langName = { ar: 'Arabic (Modern Standard, فصحى)', fr: 'French', en: 'English' }[target] || target;
  const sys = `You are a professional e-commerce translator. Translate each string in the given JSON array into ${langName}. Keep it natural, persuasive and concise. Keep prices, numbers, units, currency codes (DZD/دج) and brand/product names unchanged. Return ONLY a JSON array of strings — same length and same order as the input — with no keys, no extra text, no markdown.`;
  const body = JSON.stringify(texts);
  const r = await openaiCall(sys, [{ role: 'user', text: body }], 4000);
  if (!r?.text) return null;
  let s = r.text.replace(/```json|```/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < 0) return null;
  try { const arr = JSON.parse(s.slice(a, b + 1)); return Array.isArray(arr) ? arr : null; } catch { return null; }
}

// Live check: does the configured OpenAI key actually work right now?
function checkOpenAI() {
  return new Promise((resolve) => {
    if (!OPENAI_KEY) return resolve({ ok: false, reason: 'no_key' });
    const body = JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) return resolve({ ok: true, model: OPENAI_MODEL });
        let msg = String(res.statusCode); try { msg = JSON.parse(d).error?.message || msg; } catch {}
        resolve({ ok: false, status: res.statusCode, error: msg, model: OPENAI_MODEL });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body); req.end();
  });
}

function isConfigured() { return !!(OPENAI_KEY || GROQ_KEY || GEMINI_KEY); }

// Which providers are live + which is the active (preferred) one
function providerStatus() {
  const providers = {
    openai: { configured: !!OPENAI_KEY, model: OPENAI_MODEL },
    groq: { configured: !!GROQ_KEY, model: 'llama-3.1-8b-instant' },
    gemini: { configured: !!GEMINI_KEY, model: 'gemini-2.0-flash' },
  };
  const active = OPENAI_KEY ? 'openai' : GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : null;
  return { configured: isConfigured(), active, providers };
}

module.exports = { chat, detectFakeOrder, isConfigured, providerStatus, checkOpenAI, geminiCall: aiGenerate, generateProductDescription, generateCartRecoveryMessage, moderateReview, generateLandingPage, generateLandingHTML, generateImage: openaiImage, translateTexts };

const express=require('express'),router=express.Router(),pool=require('../config/db');
const chatbot=require('../services/chatbot');
const messaging=require('../services/messaging');

// Version check
router.get('/version',(req,res)=>res.json({version:'ai-v23-2026-06-40templates-cheaper-img'}));

// Quick GET so the frontend can confirm the verify route is deployed.
router.get('/pixels/verify',(req,res)=>res.json({ok:true,info:'POST {type,value} to verify a pixel ID against the vendor in real time.'}));

// WhatsApp diagnostic
router.get('/whatsapp-debug',async(req,res)=>{
  const token=process.env.META_WHATSAPP_TOKEN;
  const phoneId=process.env.META_PHONE_NUMBER_ID;
  const result={token_set:!!token,token_length:token?token.length:0,token_preview:token?token.substring(0,20)+'...':'NOT SET',phone_id_set:!!phoneId,phone_id:phoneId||'NOT SET'};
  if(token&&phoneId){
    try{
      const r=await fetch('https://graph.facebook.com/v21.0/'+phoneId,{headers:{'Authorization':'Bearer '+token}});
      const d=await r.json();
      result.api_check=d.error?{error:d.error.message,code:d.error.code}:{ok:true,display_phone:d.display_phone_number,verified:d.verified_name,quality:d.quality_rating};
    }catch(e){result.api_check={error:e.message};}
  }
  res.json(result);
});

// WhatsApp send test with full debug
router.post('/whatsapp-test',async(req,res)=>{
  const token=process.env.META_WHATSAPP_TOKEN;
  const phoneId=process.env.META_PHONE_NUMBER_ID;
  if(!token||!phoneId)return res.status(400).json({error:'META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID not set on Render'});
  let phone=String(req.body.phone||'').replace(/[\s\-\+\(\)]/g,'');
  if(phone.startsWith('00213'))phone=phone.substring(2);
  else if(phone.startsWith('0'))phone='213'+phone.substring(1);
  else if(!phone.startsWith('213')&&phone.length<=10)phone='213'+phone;
  try{
    const r=await fetch('https://graph.facebook.com/v21.0/'+phoneId+'/messages',{
      method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:'hello_world',language:{code:'en_US'}}})
    });
    const d=await r.json();
    res.json({sent_to:phone,raw_response:d,success:!d.error});
  }catch(e){res.status(500).json({error:e.message});}
});

// Fake order detection — AI-powered
router.post('/detect-fake',async(req,res)=>{try{
  const order=req.body.order||req.body;
  const store_id=req.body.store_id||order.store_id;
  const customer_phone=order.customer_phone||'';
  const order_total=parseFloat(order.total||order.order_total||0);

  let history={cancelled:0,total_orders:0,total_spent:0};
  if(store_id&&customer_phone){
    try{
      const stats=await pool.query(
        "SELECT COUNT(*) FILTER(WHERE status='cancelled') as cancelled, COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_spent FROM orders WHERE store_id=$1 AND customer_phone=$2",
        [store_id,customer_phone]
      );
      if(stats.rows[0]){
        history.cancelled=parseInt(stats.rows[0].cancelled);
        history.total_orders=parseInt(stats.rows[0].total_orders);
        history.total_spent=parseFloat(stats.rows[0].total_spent);
      }
    }catch(e){}
  }

  let isBlacklisted=false;
  if(store_id&&customer_phone){
    try{
      const bl=await pool.query('SELECT id FROM blacklist WHERE store_id=$1 AND phone=$2 AND is_active=TRUE',[store_id,customer_phone]);
      if(bl.rows.length)isBlacklisted=true;
    }catch(e){}
  }

  const result=await chatbot.detectFakeOrder(
    {total:order_total||0,customer_phone,customer_email:req.body.customer_email},
    history
  );

  if(isBlacklisted){result.score=100;result.level='high';result.flags.push('Customer is blacklisted');}

  res.json({fakeScore:result.score,riskLevel:result.level,flags:result.flags,isBlacklisted});
}catch(e){res.status(500).json({error:'Detection failed'});}});

// Cart recovery suggestions
router.post('/cart-recovery/suggest',async(req,res)=>{
  res.json({messages:[
    {sequence:1,delay:'30m',message:'👋 You left items in your cart! Complete your order before they sell out.'},
    {sequence:2,delay:'6h',message:'⏰ Your items are still waiting! Limited stock available.'},
    {sequence:3,delay:'24h',message:'🎁 Last chance! Use code COMEBACK10 for 10% off your cart.'},
  ]});
});

// Send cart recovery message manually
router.post('/cart-recovery/send',async(req,res)=>{try{
  const{store_id,customer_phone,customer_email,message,channel}=req.body;
  
  // Get store config for channel preference
  let ch=channel||'WHATSAPP';
  if(store_id){
    try{
      const s=await pool.query('SELECT config FROM stores WHERE id=$1',[store_id]);
      const cfg=s.rows[0]?.config||{};
      if(cfg.ai_channel)ch=cfg.ai_channel;
    }catch(e){}
  }

  const result=await messaging.sendNotification({
    channel:ch,
    phone:customer_phone,
    email:customer_email,
    message:message||'You left items in your cart! Complete your order now.',
    subject:'Complete your order',
    store_id:store_id,
  });

  // Create admin notification for manual recovery send
  if(store_id){
    const sent=!!(result.whatsapp?.success||result.email?.id);
    const recipient=customer_phone||customer_email||'unknown';
    const chName=ch==='EMAIL'?'Email':'WhatsApp';
    const title=sent?`Manual recovery sent (${chName})`:`Manual recovery failed (${chName})`;
    const msg=sent?`Recovery message sent to ${recipient}`:`Failed to send recovery to ${recipient}`;
    try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'cart_recovery',$2,$3,'/dashboard/cart-recovery')",[store_id,title,msg]);}catch{}
  }

  res.json({sent:true,channel:ch,...result});
}catch(e){res.status(500).json({error:e.message});}});

// Send order notification (called internally or via API)
router.post('/notify/order',async(req,res)=>{try{
  const{store_id,order_id,type}=req.body; // type: 'confirmed','shipped','delivered'
  
  const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[store_id])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const cfg=store.config||{};

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[order_id,store_id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});

  const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
  const channel=cfg.ai_channel||'WHATSAPP';
  let msg='';

  if(type==='confirmed')msg=messaging.orderConfirmationMessage(store.store_name,orderNum,order.total,store.currency||'DZD');
  else if(type==='shipped')msg=messaging.orderShippedMessage(store.store_name,orderNum);
  else if(type==='delivered')msg=messaging.orderDeliveredMessage(store.store_name,orderNum);
  else msg=`Order ${orderNum} update: ${type}`;

  const results={};

  // Send via preferred channel
  if(order.customer_phone){
    if(channel==='WHATSAPP')results.whatsapp=await messaging.sendWhatsApp(order.customer_phone,msg,store_id);
  }

  // Always send email if available and customer has email
  if(order.customer_email){
    let items=[];
    try{items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[order_id])).rows;}catch(e){}
    results.email=await messaging.sendEmail({
      to:order.customer_email,
      subject:`${store.store_name} — Order ${orderNum} ${type}`,
      html:messaging.orderConfirmationHTML(store.store_name,orderNum,order.total,store.currency||'DZD',items),
    });
  }

  res.json({sent:true,channel,results});
}catch(e){console.error('[Notify]',e.message);res.status(500).json({error:e.message});}});

// Get messaging status
router.get('/messaging/status',async(req,res)=>{
  const channels=messaging.getConfiguredChannels();
  const aiConfigured=chatbot.isConfigured();
  res.json({channels,ai:aiConfigured});
});

// AI provider status — confirm which key is set and which provider is active
router.get('/providers',(req,res)=>res.json(chatbot.providerStatus()));

// Live OpenAI key check — actually calls the API to verify the key works
router.get('/openai-check',async(req,res)=>{try{res.json(await chatbot.checkOpenAI());}catch(e){res.status(500).json({ok:false,error:e.message});}});

// TEST AI — send a test message and get response (for admin testing)
router.get('/test',async(req,res)=>{try{
  const aiOk=chatbot.isConfigured();
  const channels=messaging.getConfiguredChannels();
  
  // Test AI chatbot
  let aiResult=null;
  if(aiOk){
    aiResult=await chatbot.chat({message:'Hello, what payment methods do you accept?',store:{name:'Test Store',currency:'DZD',contact_phone:'0555000000',enable_cod:true,enable_ccp:true,enable_baridimob:true},history:[],language:'en'});
  }
  
  res.json({
    status:'ok',
    ai:{configured:aiOk,testResponse:aiResult?.response||'Not configured — add OPENAI_API_KEY',model:aiResult?.model||'none',...chatbot.providerStatus()},
    channels,
    instructions:'To fully test: POST /api/ai/{store-slug}/chatbot with {"message":"hello"} — this tests with real store data'
  });
}catch(e){res.status(500).json({error:e.message});}});

// Test AI chatbot — for admin testing
router.post('/test-chat',async(req,res)=>{try{
  const{message,store_name,history,language}=req.body;
  const testStore={name:store_name||'Test Store',store_name:store_name||'Test Store',currency:'DZD',contact_phone:'0555123456',enable_cod:true,enable_ccp:true,enable_baridimob:true,products_summary:'Products: Test Product 1 (2500 DZD), Test Product 2 (4000 DZD)'};
  const result=await chatbot.chat({message:message||'hello',store:testStore,history:history||[],language:language||'en'});
  res.json({...result,test:true,ai_configured:chatbot.isConfigured()});
}catch(e){console.error('[Test Chat Error]',e);res.status(500).json({error:e.message});}});

// Test send message — for admin testing
router.post('/test-send',async(req,res)=>{try{
  const{channel,phone,email,message,subject}=req.body;
  const ch=(channel||'WHATSAPP').toUpperCase();
  if(ch==='EMAIL'&&!email)return res.status(400).json({error:'Email address required'});
  if(ch!=='EMAIL'&&!phone)return res.status(400).json({error:'Phone number required'});
  const result=await messaging.sendNotification({channel:ch,phone,email,message:message||'Test message',subject:subject||'Test from your store'});
  const chResult=result.whatsapp||result.email||{};
  if(chResult.success===false)return res.status(400).json({error:chResult.reason||'Send failed',details:chResult});
  res.json({...result,test:true,sent:true});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate product description
router.post('/generate-description',async(req,res)=>{try{
  const{product_name,category,language}=req.body;
  const desc=await chatbot.generateProductDescription(product_name||'Product',category,language||'ar');
  res.json({description:desc||'Could not generate description. Please try again.'});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate cart recovery message
router.post('/generate-recovery',async(req,res)=>{try{
  const{store_name,items,language}=req.body;
  const msg=await chatbot.generateCartRecoveryMessage(store_name||'Store',items||['Product'],language||'ar');
  res.json({message:msg||'You left items in your cart! Complete your order now.'});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Moderate a review
router.post('/moderate-review',async(req,res)=>{try{
  const{content,rating}=req.body;
  const result=await chatbot.moderateReview(content||'',rating||5);
  res.json(result);
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate product description (multi-language)
router.post('/generate-description-multi',async(req,res)=>{try{
  const{product_name,category}=req.body;
  const[en,fr,ar]=await Promise.all([
    chatbot.generateProductDescription(product_name||'Product',category,'en'),
    chatbot.generateProductDescription(product_name||'Product',category,'fr'),
    chatbot.generateProductDescription(product_name||'Product',category,'ar'),
  ]);
  res.json({en:en||'',fr:fr||'',ar:ar||''});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ BUYER CHATBOT — MUST be LAST route (/:slug catches everything) ═══
router.post('/:slug/chatbot',async(req,res)=>{try{
  const s=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Store not found'});
  const{message,history,language}=req.body;
  const cfg=s.config||{};
  let productsSummary='';
  try{
    const prods=await pool.query(`SELECT p.name, p.price, p.stock_quantity, p.description,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status!='cancelled') as order_count
      FROM products p WHERE p.store_id=$1 AND p.is_active=TRUE ORDER BY order_count DESC, p.created_at DESC LIMIT 20`,[s.id]);
    if(prods.rows.length){
      productsSummary='PRODUCT CATALOG:\n'+prods.rows.map(p=>{
        let line=`- ${p.name}: ${p.price} ${s.currency||'DZD'}`;
        if(parseInt(p.order_count)>0) line+=` (${p.order_count} orders - popular)`;
        if(p.stock_quantity<=0) line+=' [OUT OF STOCK]';
        else if(p.stock_quantity<=5) line+=` [${p.stock_quantity} left]`;
        if(p.description) line+=` | ${(p.description||'').substring(0,80)}`;
        return line;
      }).join('\n');
    }
  }catch(e){}
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}
  const storeData={name:s.store_name,store_name:s.store_name,currency:s.currency||'DZD',contact_phone:s.contact_phone,enable_cod:pay.cod_enabled,enable_ccp:pay.ccp_enabled,enable_baridimob:pay.baridimob_enabled,enable_bank_transfer:pay.bank_transfer_enabled,products_summary:productsSummary};
  const result=await chatbot.chat({message,store:storeData,history:history||[],language:language||'auto'});
  res.json(result);
}catch(e){console.error('[AI Chat]',e.message);res.status(500).json({error:'Chatbot error'});}});

// ═══════ WHATSAPP BAILEYS (BUILT-IN — no external service needed) ═══════
let _waBaileysAI;function _getWaB(){if(_waBaileysAI!==undefined)return _waBaileysAI;try{_waBaileysAI=require('../services/whatsappBaileys');}catch{_waBaileysAI=null;}return _waBaileysAI;}
const waBaileys=new Proxy({},{get(_,prop){const mod=_getWaB();if(!mod){if(prop==='getStatus')return()=>({connected:false,status:'not_available'});if(prop==='sendMessage')return async()=>({success:false,reason:'WhatsApp service not available'});if(prop==='startSession'||prop==='disconnectSession'||prop==='restoreSessions'||prop==='getSession')return async()=>null;return undefined;}return mod[prop];}});

router.get('/whatsapp-qr/debug', async (req, res) => {
  res.json({ mode: 'built-in', info: 'WhatsApp Baileys runs directly in this backend — no Railway needed.' });
});

router.post('/whatsapp-qr/start', async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    waBaileys.startSession(storeId).catch(e => console.error('[WA start]', e.message));
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = waBaileys.getStatus(storeId);
      if (s.qr || s.connected || s.status === 'error' || s.status === 'logged_out') return res.json(s);
    }
    res.json(waBaileys.getStatus(storeId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp-qr/status/:storeId', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(waBaileys.getStatus(req.params.storeId));
});

router.post('/whatsapp-qr/disconnect', async (req, res) => {
  try {
    const { storeId } = req.body;
    await waBaileys.disconnectSession(storeId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp-qr/send', async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    if (!storeId || !phone) return res.status(400).json({ error: 'storeId and phone required' });
    const data = await waBaileys.sendMessage(storeId, phone, message || 'Hello from your store!');
    try { await pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)', [storeId, 'whatsapp', phone, (message || '').substring(0, 200), data.success ? 'sent' : 'failed', data.reason || null]); } catch (e) {}
    if (data.success) res.json(data); else res.status(400).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp-qr/log/:storeId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM message_log WHERE store_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.storeId]);
    const total = await pool.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='sent') as sent, COUNT(*) FILTER (WHERE status='failed') as failed FROM message_log WHERE store_id=$1", [req.params.storeId]);
    res.json({ messages: r.rows, stats: total.rows[0] });
  } catch (e) { res.json({ messages: [], stats: { total: 0, sent: 0, failed: 0 } }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pixel validation proxy. Browsers can't read cross-origin pixel responses
// (CORS), so the frontend "test" button could only verify format. This route
// fetches the vendor's tracker URL server-side and returns whether the pixel
// is accepted (HTTP 200 / known good response). Works for FB / TikTok / GA4 /
// Snapchat / Google Sheets webhooks.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pixels/verify', async (req, res) => {
  const { type, value } = req.body || {};
  const v = String(value || '').trim();
  if (!type || !v) return res.status(400).json({ ok: false, reason: 'Missing type or value' });

  // Helper: fetch with timeout so a stalled vendor never hangs the request.
  const fetchWithTimeout = async (url, init = {}, ms = 8000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' }); }
    finally { clearTimeout(timer); }
  };

  try {
    // ─── Facebook Pixel ─────────────────────────────────────────────────────
    // Two-step real check:
    //  1) Hit Graph API for the pixel — invalid IDs come back with a clear
    //     "object does not exist" message; valid private pixels say "access
    //     token required". Both are conclusive.
    //  2) Fire an actual PageView event to the public tracker — proves the
    //     pixel route is reachable end-to-end.
    if (type === 'facebook_pixel') {
      if (!/^\d{14,17}$/.test(v)) return res.json({ ok: false, reason: 'Format invalid (need 14–17 digit Pixel ID)' });
      try {
        const r = await fetchWithTimeout(`https://graph.facebook.com/v18.0/${encodeURIComponent(v)}?fields=id`);
        const text = await r.text();
        // Real pixel that's private: error 190/200 "access token required"
        // Non-existent pixel: error 100 "Object with ID does not exist"
        if (/Object with ID|does not exist|cannot be loaded|nonexistent|invalid/i.test(text)) {
          return res.json({ ok: false, reason: 'Meta says this Pixel ID does not exist' });
        }
        // 200 with body or 400 with "access token required" → real pixel
        if (r.status === 200 || /access token/i.test(text)) {
          // Confirm the tracker accepts the event end-to-end
          try {
            const trk = await fetchWithTimeout(`https://www.facebook.com/tr?id=${encodeURIComponent(v)}&ev=PageView&noscript=1&_=${Date.now()}`);
            const trkOk = trk.status === 200 || trk.status === 204;
            return res.json({ ok: trkOk, reason: trkOk ? 'Pixel exists on Meta and tracker accepted the test event' : `Tracker returned ${trk.status}` });
          } catch (e) {
            return res.json({ ok: true, reason: 'Pixel exists on Meta (tracker check skipped: ' + e.message + ')' });
          }
        }
        return res.json({ ok: false, reason: `Meta returned ${r.status} — ID likely invalid` });
      } catch (e) {
        return res.json({ ok: false, reason: e.name === 'AbortError' ? 'Meta timeout' : (e.message || 'Network error') });
      }
    }

    // ─── TikTok Pixel ───────────────────────────────────────────────────────
    // Real check: hit the events.js SDK for the sdkid. The body contains the
    // pixel's config object only when TikTok recognizes the ID; otherwise
    // it returns the bare loader.
    if (type === 'tiktok_pixel') {
      if (!/^[A-Z0-9]{18,24}$/.test(v)) return res.json({ ok: false, reason: 'Format invalid (need 18–24 char TikTok pixel code)' });
      try {
        const r = await fetchWithTimeout(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(v)}&lib=ttq&_=${Date.now()}`);
        const text = await r.text();
        if (r.status !== 200) return res.json({ ok: false, reason: `TikTok returned ${r.status}` });
        // Valid sdkid → body contains the id, often as `"pixel_code":"<id>"` or echoes it inline.
        if (text.includes(v)) return res.json({ ok: true, reason: 'TikTok recognized this Pixel ID and served its config' });
        return res.json({ ok: false, reason: 'TikTok served the loader but did not echo this ID — likely invalid or disabled' });
      } catch (e) {
        return res.json({ ok: false, reason: e.name === 'AbortError' ? 'TikTok timeout' : (e.message || 'Network error') });
      }
    }

    // ─── GA4 ────────────────────────────────────────────────────────────────
    // Real check: the gtag loader for a valid measurement ID embeds the ID
    // in its body and references a stream config; for a non-existent ID it
    // still returns 200 but the body lacks the ID.
    if (type === 'google_analytics') {
      if (!/^G-[A-Z0-9]{6,12}$/.test(v)) return res.json({ ok: false, reason: 'Format invalid (need G-XXXXXXXXXX)' });
      try {
        const r = await fetchWithTimeout(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(v)}&_=${Date.now()}`);
        const text = await r.text();
        if (r.status !== 200) return res.json({ ok: false, reason: `Google returned ${r.status}` });
        if (text.includes(v)) {
          // Also try a Measurement Protocol /collect ping — proves real ingestion.
          try {
            const c = await fetchWithTimeout(`https://www.google-analytics.com/g/collect?v=2&tid=${encodeURIComponent(v)}&en=test_event&_p=${Date.now()}`, { method: 'POST' });
            return res.json({ ok: true, reason: `GA loader recognized the ID and /collect responded ${c.status}` });
          } catch {
            return res.json({ ok: true, reason: 'GA loader recognized the ID' });
          }
        }
        return res.json({ ok: false, reason: 'GA loader did not embed this measurement ID — invalid or unpublished' });
      } catch (e) {
        return res.json({ ok: false, reason: e.name === 'AbortError' ? 'Google timeout' : (e.message || 'Network error') });
      }
    }

    // ─── Snapchat Pixel ─────────────────────────────────────────────────────
    // Snap's tracker silently 200s for any well-formed ID. The only public
    // hint of validity is that the tr.snapchat.com endpoint returns the GIF
    // bytes (~43B). We test reachability + GIF response.
    if (type === 'snapchat_pixel') {
      if (!/^[a-f0-9-]{30,40}$/i.test(v)) return res.json({ ok: false, reason: 'Format invalid (need Snap pixel UUID)' });
      try {
        const r = await fetchWithTimeout(`https://tr.snapchat.com/p?p_id=${encodeURIComponent(v)}&ev=PAGE_VIEW&_=${Date.now()}`);
        const ct = r.headers.get('content-type') || '';
        if (r.status === 200 && /image|gif/i.test(ct)) return res.json({ ok: true, reason: 'Snapchat tracker accepted the test event' });
        return res.json({ ok: false, reason: `Snapchat returned ${r.status}` });
      } catch (e) {
        return res.json({ ok: false, reason: e.name === 'AbortError' ? 'Snap timeout' : (e.message || 'Network error') });
      }
    }

    // ─── Google Sheets webhook ──────────────────────────────────────────────
    // Genuinely POST a test row — only succeeds if the script accepts JSON.
    if (type === 'google_sheets') {
      if (!/^https?:\/\/script\.google\.com\//i.test(v)) return res.json({ ok: false, reason: 'Must be a script.google.com webhook URL' });
      try {
        const r = await fetchWithTimeout(v, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: true, ts: Date.now(), source: 'admin-pixel-verify' }),
        });
        if (r.status >= 200 && r.status < 400) return res.json({ ok: true, reason: 'Sheets webhook accepted the POST' });
        return res.json({ ok: false, reason: `Webhook returned ${r.status}` });
      } catch (e) {
        return res.json({ ok: false, reason: e.name === 'AbortError' ? 'Sheets timeout' : (e.message || 'Network error') });
      }
    }

    return res.status(400).json({ ok: false, reason: 'Unknown pixel type' });
  } catch (e) {
    return res.json({ ok: false, reason: e.message || 'Network error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email integration — status check + per-store test send. Mirrors the WA
// modal's QR/test endpoints so the EmailConfigModal can probe the platform's
// email service and let the admin send a sample.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/email/status', async (req, res) => {
  const ok = !!process.env.RESEND_API_KEY;
  res.json({
    ok,
    message: ok ? 'Email service is configured (Resend).' : 'Email service is not configured. Ask the platform admin to set RESEND_API_KEY.',
    from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
  });
});

// ═══ AI LANDING PAGE GENERATOR ═══
router.post('/generate-landing', async (req, res) => {
  try {
    const { products, store, language } = req.body;
    if (!products || !products.length) return res.status(400).json({ error: 'Products are required' });
    if (!store) return res.status(400).json({ error: 'Store info is required' });

    const result = await chatbot.generateLandingPage(products, store, language || 'en');
    if (!result) return res.status(500).json({ error: 'AI generation failed — check OPENAI_API_KEY (or GROQ_API_KEY / GEMINI_API_KEY)' });

    res.json({ ok: true, landing: result });
  } catch (e) {
    console.error('[AI Landing]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ FULL AI LANDING PAGE — complete bespoke HTML, no templates ═══
router.post('/generate-landing-html', async (req, res) => {
  try {
    const { products, store, language, regenerate, nonce } = req.body;
    if (!products || !products.length) return res.status(400).json({ error: 'Products are required' });
    if (!store) return res.status(400).json({ error: 'Store info is required' });

    const result = await chatbot.generateLandingHTML(products, store, language || 'en', { regenerate, nonce });
    if (!result || !result.html) {
      let reason;
      if (result?.error === 'openai_failed') {
        const status = result.detail?.status;
        const msg = result.detail?.message || 'unknown error';
        if (status === 429) reason = `OpenAI quota exceeded. Your key is valid but the account has no usable credit balance — add prepaid credits at https://platform.openai.com/settings/organization/billing (a card on file is not enough). OpenAI said: ${msg}`;
        else if (status === 401) reason = `OpenAI rejected the key (401). Set a valid OPENAI_API_KEY (starts with "sk-"). OpenAI said: ${msg}`;
        else reason = `OpenAI call failed${status ? ` (${status})` : ''}: ${msg}`;
      } else {
        reason = {
          no_provider: 'No AI key configured on the server. Set OPENAI_API_KEY (and OPENAI_MODEL=gpt-4o) in the backend environment.',
          provider_failed: 'The AI provider did not respond (rate limit or timeout). Try again.',
          no_html: 'The AI returned no usable HTML. Try again, or set OPENAI_MODEL=gpt-4o for better output.',
        }[result?.error] || 'AI full-page generation failed — set OPENAI_API_KEY (gpt-4o recommended via OPENAI_MODEL).';
      }
      return res.status(result?.error === 'no_provider' ? 400 : 502).json({ error: reason });
    }

    res.json({ ok: true, html: result.html, model: result.model, imageModel: result.imageModel, theme: result.theme });
  } catch (e) {
    console.error('[AI Landing HTML]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ GPT IMAGE GENERATOR ═══ (GPT only — replaces any 3rd-party image AI)
// Generates a single bespoke image with OpenAI (gpt-image-1 → DALL·E 3) and
// returns it as a data URI, so the landing builder never depends on puter.js
// or any non-GPT image service.
// ═══ TRANSLATE LANDING-PAGE TEXT (GPT) ═══ used to make AI pages multilingual
router.post('/translate', async (req, res) => {
  try {
    const { texts, target } = req.body || {};
    if (!Array.isArray(texts) || !texts.length || !target) return res.status(400).json({ error: 'texts[] and target are required' });
    if (!chatbot.translateTexts) return res.status(500).json({ error: 'translation not available' });
    const translations = await chatbot.translateTexts(texts.slice(0, 300), target);
    if (!translations) return res.status(502).json({ error: 'translation failed — check OPENAI_API_KEY' });
    res.json({ ok: true, translations });
  } catch (e) {
    console.error('[AI Translate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/generate-image', async (req, res) => {
  try {
    const { prompt, size } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });
    if (!chatbot.generateImage) return res.status(500).json({ error: 'image generation not available' });
    const image = await chatbot.generateImage(String(prompt), size || '1536x1024');
    if (!image) return res.status(502).json({ error: 'GPT image generation failed — check OPENAI_API_KEY has image access (gpt-image-1 / DALL·E 3) and available credit.' });
    res.json({ ok: true, image, model: 'gpt-image' });
  } catch (e) {
    console.error('[AI Image]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/email/:storeId/send-test', async (req, res) => {
  try {
    const { to, subject, html, text } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    const result = await messaging.sendEmail({ to, subject, html, text });
    if (!result.success) return res.status(400).json({ ok: false, error: result.reason || 'Email send failed', details: result });
    // Log so the Recent Activity / message_log shows the test send too.
    try {
      await pool.query(
        'INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)',
        [req.params.storeId, 'email', to, (subject || '').substring(0, 200), 'sent', null]
      );
    } catch {}
    res.json({ ok: true, id: result.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

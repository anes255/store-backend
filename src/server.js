const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const express=require('express'),compression=require('compression'),cookieParser=require('cookie-parser'),rateLimit=require('express-rate-limit');
require('dotenv').config();
const app=express();

app.disable('x-powered-by');

// CORS + baseline security headers — raw headers, first thing
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-store-slug');
  res.setHeader('Access-Control-Allow-Credentials','true');
  // Security headers (hardening against clickjacking, MIME sniffing, info leak)
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection','0');
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
  // Force HTTPS for a year (incl. subdomains). Render terminates TLS, so this
  // is safe and tells browsers to never downgrade to http.
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains; preload');
  // Lock down powerful browser features the API has no business using.
  res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=(), payment=()');
  if(req.method==='OPTIONS')return res.status(204).end();next();
});

app.use(compression());app.use(cookieParser());app.use(express.json({limit:'50mb'}));app.use(express.urlencoded({extended:true,limit:'50mb'}));

// Global API rate limit (per IP)
app.use('/api/',rateLimit({windowMs:15*60*1000,max:1000,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests, please slow down.'}}));
// Strict limiter for auth/credential endpoints to blunt brute-force & abuse
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false,skipSuccessfulRequests:true,message:{error:'Too many attempts. Please try again later.'}});
app.use(['/api/owner/login','/api/owner/register','/api/owner/register/request-otp','/api/owner/register/verify-otp','/api/owner/login/verify-2fa','/api/owner/login/resend-2fa','/api/owner/staff/login','/api/platform/login'],authLimiter);

const pool=require('./config/db');

// Root + health
app.get('/',(req,res)=>res.json({name:'MakretDZ API',status:'running'}));
app.get('/favicon.ico',(req,res)=>res.status(204).end());
app.get('/api/health',(req,res)=>res.json({status:'ok'}));

// Platform info
app.get('/api/platform-info',async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({site_name:s.site_name||'MakretDZ',site_logo:s.logo_url,primary_color:s.primary_color||'#C5A55A',secondary_color:s.secondary_color||'#06B6D4',accent_color:s.accent_color||'#F59E0B',meta_description:s.meta_description,favicon:s.favicon_url,maintenance_mode:s.maintenance_mode,currency:s.currency||'DZD',landing_blocks:s.landing_blocks||'[]',google_client_id:s.google_client_id||'',trial_days:parseInt(s.subscription_trial_days||0,10)||14,trial_enabled:s.subscription_trial_enabled!==false});}catch(e){res.json({site_name:'MakretDZ',landing_blocks:'[]',trial_days:14,trial_enabled:true});}});

// Load routes
const routes=[
  ['/api/platform','./routes/platformAdmin'],
  ['/api/owner','./routes/storeOwner'],
  ['/api/manage','./routes/products'],
  ['/api/manage','./routes/orders'],
  ['/api/store','./routes/storefront'],
  ['/api/ai','./routes/ai'],
  ['/api/payments','./routes/payments'],
];
for(const[path,file]of routes){try{app.use(path,require(file));console.log('✅',path);}catch(e){console.error('❌',file,e.message);}}

// Carrier webhook (public, no auth prefix — accept GET and POST)
app.all('/api/webhook/carrier/:storeId/:carrierId',async(req,res)=>{
  try{
    const merged={...(req.query||{}),...(req.body||{})};
    let tracking=merged.tracking||merged.tracking_number||merged.Tracking||merged.code||merged.parcel_id||merged.order_id||'';
    if(!tracking&&merged.data){
      const d=typeof merged.data==='string'?(()=>{try{return JSON.parse(merged.data);}catch{return{};}})():merged.data;
      tracking=d.tracking||d.tracking_number||d.code||d.order_id||'';
    }
    if(!tracking&&Array.isArray(merged.trackings)&&merged.trackings[0]){
      const t0=merged.trackings[0];tracking=typeof t0==='string'?t0:(t0.tracking||t0.tracking_number||'');
    }
    let status=merged.status||merged.last_status||merged.Situation||merged.event||merged.last_situation||'';
    if(!status&&merged.activity){
      const a=Array.isArray(merged.activity)?merged.activity[0]:merged.activity;
      status=a?.event||a?.status||'';
    }
    if(!tracking){
      const ref=merged.reference||merged.external_id||merged.display_id||'';
      if(ref){
        const match=await pool.query("SELECT tracking_number FROM orders WHERE store_id=$1 AND (external_id=$2 OR tracking_number=$2) LIMIT 1",[req.params.storeId,ref]);
        if(match.rows[0])tracking=match.rows[0].tracking_number||ref;
        else tracking=ref;
      }
    }
    if(!tracking)return res.status(400).json({error:'Missing tracking'});
    const mapSt=(s)=>{const t=String(s||'').toLowerCase().replace(/\s+/g,'_');
      if(/livr[éeè]|deliver|^livred$/.test(t))return'delivered';
      if(/encaiss|^payed$|paiement_pret|paiement_archive/.test(t))return'delivered';
      if(/exp[éeè]di|ship|picked|dispatched|transit|attempt|en_livraison|vers_wilaya|vers_hub|en_hub|en_preparation|ramassage/.test(t))return'shipped';
      if(/received_by_carrier|accepted_by_carrier|pret_a_expedier|pret_a_preparer|stock_en_preparation/.test(t))return'preparing';
      if(/retour|return|suspendu/.test(t))return'returned';
      if(/annul|cancel/.test(t))return'cancelled';
      return'shipped';};
    await pool.query("UPDATE orders SET tracking_status=$1,status=$2,carrier_data=$3::jsonb,tracking_updated_at=NOW(),updated_at=NOW() WHERE store_id=$4 AND tracking_number=$5",
      [String(status).toLowerCase().replace(/\s+/g,'_'),mapSt(status),JSON.stringify(merged),req.params.storeId,tracking]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Error handlers — log full detail server-side, return a generic message so
// internal errors (SQL, stack traces) are never leaked to clients.
app.use((err,req,res,next)=>{console.error(err.stack||err.message);res.status(500).json({error:'Internal server error'});});
app.use((req,res)=>res.status(404).json({error:'Not found',path:req.path}));

// Start
const{initDb}=require('./config/initDb');
const PORT=process.env.PORT||5000;
app.listen(PORT,async()=>{console.log(`🚀 Port ${PORT}`);try{await initDb();}catch(e){console.error(e.message);}
// Restore WhatsApp Baileys sessions (built-in, no Railway needed)
try{const waBaileys=require('./services/whatsappBaileys');waBaileys.restoreSessions().then(()=>console.log('✅ WhatsApp Baileys sessions restored')).catch(e=>console.log('[WA-Baileys] Restore error:',e.message));}catch(e){console.log('[WA-Baileys] Not available:',e.message);}

// ═══ BACK-FILL CARRIER ORDERS (one-time on startup) ═══
(async()=>{try{
  const pool=require('./config/db');
  const pick=(obj,...keys)=>{if(!obj)return'';for(const k of keys){if(obj[k])return String(obj[k]).trim();}return'';};
  // Target ALL orders with carrier_data that have any missing field
  const broken=await pool.query(`SELECT id,carrier_data FROM orders WHERE carrier_data IS NOT NULL AND (
    shipping_wilaya IS NULL OR shipping_wilaya='' OR
    shipping_city IS NULL OR shipping_city='' OR
    customer_name IS NULL OR customer_name='' OR customer_name='(carrier import)' OR
    customer_phone IS NULL OR customer_phone=''
  )`);
  let fixed=0;
  for(const o of broken.rows){
    let cd=o.carrier_data;if(typeof cd==='string')try{cd=JSON.parse(cd);}catch{continue;}
    if(!cd)continue;
    // Also check nested Colis array (EcoTrack/DHD format)
    let cd2=null;if(cd?.Colis&&Array.isArray(cd.Colis))cd2=cd.Colis[0];
    const p=(...keys)=>pick(cd,...keys)||pick(cd2,...keys);
    const name=p('firstname','client','Client','recipient','to_name','customer_name')+(p('familyname')?' '+p('familyname'):'');
    const phone=(p('contact_phone','to_commune_phone','customer_phone','phone','MobileA','client_phone')).replace(/[^\d+]/g,'');
    const wilaya=p('to_wilaya_name','wilaya','Wilaya','shipping_wilaya');
    const commune=p('to_commune_name','commune','Commune','shipping_city');
    const address=p('address','adresse','Adresse','shipping_address','destination_text');
    await pool.query(`UPDATE orders SET
      customer_name=COALESCE(NULLIF(customer_name,''),NULLIF(customer_name,'(carrier import)'),NULLIF($1,'')),
      customer_phone=COALESCE(NULLIF(customer_phone,''),NULLIF($2,'')),
      shipping_wilaya=COALESCE(NULLIF(shipping_wilaya,''),NULLIF($3,'')),
      shipping_city=COALESCE(NULLIF(shipping_city,''),NULLIF($4,'')),
      shipping_address=COALESCE(NULLIF(shipping_address,''),NULLIF($5,''))
      WHERE id=$6`,[name,phone,wilaya,commune,address,o.id]);
    fixed++;
  }
  if(fixed)console.log(`✅ Back-filled ${fixed} carrier orders with missing data`);
}catch(e){console.log('[Carrier backfill]',e.message);}})();

// ═══ ABANDONED CART RECOVERY CRON ═══
const abandonedCartCheck=async()=>{
  try{
    const pool=require('./config/db');
    let messaging;
    try{messaging=require('./services/messaging');}catch(e){/* messaging service unavailable */}

    // Mark regular carts as abandoned + notify admin
    const _cartStores=await pool.query(`SELECT DISTINCT c.store_id,s.config FROM carts c JOIN stores s ON s.id=c.store_id
      WHERE c.is_abandoned=FALSE AND c.is_recovered=FALSE AND (c.checkout_started IS NOT TRUE)`);
    for(const _row of _cartStores.rows){
      let _sc=_row.config||{};if(typeof _sc==='string')try{_sc=JSON.parse(_sc);}catch{_sc={};}
      const _step1=parseInt(_sc.cart_recovery_step1_minutes)||30;
      // Get carts about to be marked abandoned so we can notify
      const newlyAbandoned=await pool.query(`SELECT customer_name,customer_phone,total FROM carts WHERE is_abandoned=FALSE AND is_recovered=FALSE
        AND (checkout_started IS NOT TRUE) AND store_id=$1 AND updated_at < NOW() - INTERVAL '1 minute' * $2`,[_row.store_id,_step1]);
      if(newlyAbandoned.rows.length){
        await pool.query(`UPDATE carts SET is_abandoned=TRUE WHERE is_abandoned=FALSE AND is_recovered=FALSE
          AND (checkout_started IS NOT TRUE) AND store_id=$1 AND updated_at < NOW() - INTERVAL '1 minute' * $2`,[_row.store_id,_step1]);
        for(const ac of newlyAbandoned.rows){
          try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'abandoned_cart',$2,$3,'/dashboard/cart-recovery')",
            [_row.store_id,'🛒 Cart abandoned',`${ac.customer_name||'Anonymous'} (${ac.customer_phone||'no phone'}) left ${parseFloat(ac.total||0).toLocaleString()} DZD in their cart`]);}catch{}
        }
      }
    }

    // Mark checkout carts as abandoned + notify admin
    const _checkoutStores=await pool.query(`SELECT DISTINCT c.store_id,s.config FROM carts c JOIN stores s ON s.id=c.store_id
      WHERE c.is_abandoned=FALSE AND c.is_recovered=FALSE AND c.checkout_started=TRUE`);
    for(const _row of _checkoutStores.rows){
      let _sc=_row.config||{};if(typeof _sc==='string')try{_sc=JSON.parse(_sc);}catch{_sc={};}
      const _delayMin=parseInt(_sc.checkout_recovery_delay_minutes)||60;
      const newlyAbandoned=await pool.query(`SELECT customer_name,customer_phone,total,shipping_wilaya FROM carts WHERE is_abandoned=FALSE AND is_recovered=FALSE
        AND checkout_started=TRUE AND store_id=$1 AND updated_at < NOW() - INTERVAL '1 minute' * $2`,[_row.store_id,_delayMin]);
      if(newlyAbandoned.rows.length){
        await pool.query(`UPDATE carts SET is_abandoned=TRUE WHERE is_abandoned=FALSE AND is_recovered=FALSE
          AND checkout_started=TRUE AND store_id=$1 AND updated_at < NOW() - INTERVAL '1 minute' * $2`,[_row.store_id,_delayMin]);
        for(const ac of newlyAbandoned.rows){
          try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'abandoned_checkout',$2,$3,'/dashboard/cart-recovery')",
            [_row.store_id,'⚠️ Checkout abandoned',`${ac.customer_name||'Anonymous'} (${ac.customer_phone||'no phone'}) abandoned checkout — ${parseFloat(ac.total||0).toLocaleString()} DZD${ac.shipping_wilaya?' — '+ac.shipping_wilaya:''}`]);}catch{}
        }
      }
    }

    // Find abandoned carts that haven't had recovery sent.
    // Include carts that have either a phone or email so we can reach them.
    const carts=await pool.query(`SELECT c.*,s.store_name,s.slug,s.config,s.currency
      FROM carts c JOIN stores s ON s.id=c.store_id
      WHERE c.is_abandoned=TRUE AND c.is_recovered=FALSE AND c.recovery_sent_at IS NULL
      AND (c.customer_phone IS NOT NULL AND c.customer_phone!='')
      LIMIT 10`);

    if(!carts.rows.length)return;
    console.log(`[Cart Recovery] Found ${carts.rows.length} abandoned carts`);

    for(const cart of carts.rows){
      let cfg=cart.config||{};if(typeof cfg==='string')try{cfg=JSON.parse(cfg);}catch{cfg={};}
      const isCheckoutCart=!!cart.checkout_started;
      // Check the appropriate enable flag: checkout_recovery_enabled for checkout carts, cart_recovery_enabled (or legacy ai_cart_recovery) for regular carts
      if(isCheckoutCart){if(!cfg.checkout_recovery_enabled)continue;}
      else{if(!cfg.cart_recovery_enabled&&!cfg.ai_cart_recovery)continue;}

      let items=cart.items;
      if(typeof items==='string')try{items=JSON.parse(items);}catch{items=[];}
      if(!Array.isArray(items)||!items.length)continue;

      const productNames=items.map(i=>i.name||'Product').join(', ');
      const total=parseFloat(cart.total)||0;
      const storeName=cart.store_name||'Our Store';
      const baseUrl=process.env.FRONTEND_URL||'localhost:5173';
      const storeUrl=baseUrl.includes('://')?`${baseUrl}/s/${cart.slug}`:`https://${baseUrl}/s/${cart.slug}`;
      const itemCount=items.reduce((s,i)=>s+(i.quantity||1),0);
      const currency=cart.currency||'DZD';
      const customerName=cart.customer_name||'Valued Customer';

      const isCheckout=isCheckoutCart;
      const recoverUrl=`${storeUrl}/checkout?recover=${encodeURIComponent(cart.customer_phone)}`;
      const linkUrl=isCheckout?recoverUrl:storeUrl;

      // WhatsApp message (Arabic) — checkout abandonment gets a tailored message
      const waMessage=isCheckout
        ?`مرحباً ${customerName} 👋\n\nلاحظنا أنك كنت على وشك إتمام طلبك في ${storeName} لكن لم تكمل العملية.\n\n🛍️ ${productNames}\n💰 المجموع: ${total.toLocaleString()} ${currency}\n📦 ${cart.shipping_wilaya?'ولاية: '+cart.shipping_wilaya:''}\n\nمعلوماتك محفوظة! يمكنك إكمال طلبك بنقرة واحدة:\n\n🔗 ${linkUrl}\n\nشكراً لك على ثقتك بنا ❤️`
        :`مرحباً ${customerName} 👋\n\nلاحظنا أنك تركت بعض المنتجات في سلة التسوق الخاصة بك في ${storeName}:\n\n🛍️ ${productNames}\n💰 المجموع: ${total.toLocaleString()} ${currency}\n\nهل تحتاج مساعدة في إتمام طلبك؟ منتجاتك لا تزال متاحة!\n\n🔗 أكمل طلبك الآن: ${storeUrl}\n\nشكراً لك على ثقتك بنا ❤️`;

      // Email HTML
      const emailHtml=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#333;">Hi ${customerName}! 👋</h2>
        <p style="color:#555;font-size:15px;">${isCheckout
          ?`You were so close to completing your order at <strong>${storeName}</strong>! Your information is saved — just click below to finish.`
          :`We noticed you left some items in your shopping cart at <strong>${storeName}</strong>. Your products are still available!`}</p>
        <div style="background:#f8f8f8;border-radius:12px;padding:16px;margin:20px 0;">
          <p style="font-weight:bold;color:#333;margin:0 0 8px 0;">🛍️ Your cart (${itemCount} item${itemCount>1?'s':''}):</p>
          ${items.map(i=>`<div style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #eee;"><span style="flex:1;color:#333;">${i.name||'Product'} × ${i.quantity||1}</span><span style="font-weight:bold;color:#333;">${((parseFloat(i.price)||0)*(i.quantity||1)).toLocaleString()} ${currency}</span></div>`).join('')}
          <div style="text-align:right;padding:12px 0 0;"><strong style="font-size:18px;color:#7C3AED;">Total: ${total.toLocaleString()} ${currency}</strong></div>
        </div>${isCheckout&&cart.shipping_wilaya?`
        <div style="background:#f0f9ff;border-radius:12px;padding:12px 16px;margin:0 0 20px 0;">
          <p style="font-size:13px;color:#555;margin:0;">📦 Shipping to: <strong>${cart.shipping_wilaya}${cart.shipping_city?', '+cart.shipping_city:''}</strong></p>
        </div>`:''}
        <a href="${linkUrl}" style="display:inline-block;padding:14px 32px;background:#7C3AED;color:#fff;text-decoration:none;border-radius:12px;font-weight:bold;font-size:16px;">${isCheckout?'Complete Your Order →':'Shop Now →'}</a>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you need help, just reply to this email. Thank you for shopping with us! ❤️</p>
      </div>`;

      let waSent=false;
      let emailSent=false;

      // 1) Try WhatsApp via built-in Baileys
      if(cart.customer_phone){
        try{
          const waBaileys=require('./services/whatsappBaileys');
          const status=waBaileys.getStatus(String(cart.store_id));
          if(status.connected){
            const sendResult=await waBaileys.sendMessage(String(cart.store_id),cart.customer_phone,waMessage);
            waSent=!!sendResult.success;
            console.log(`[Cart Recovery] WhatsApp to ${cart.customer_phone}: ${waSent?'SENT':'FAILED'}`);
            try{await pool.query('INSERT INTO message_log(store_id,channel,recipient,message_type,message,status,error) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [cart.store_id,'whatsapp',cart.customer_phone,'cart_recovery',waMessage.substring(0,200),waSent?'sent':'failed',sendResult.reason||null]);}catch{}
          }
        }catch(e){console.log('[Cart Recovery] WA error:',e.message);}
      }

      // 2) Try WhatsApp via Meta Cloud API if Baileys didn't work
      if(!waSent&&cart.customer_phone&&messaging){
        try{
          const waResult=await messaging.sendWhatsApp(cart.customer_phone,waMessage,cart.store_id);
          if(waResult&&waResult.success){waSent=true;console.log(`[Cart Recovery] WhatsApp (Meta) to ${cart.customer_phone}: SENT`);}
        }catch(e){/* ignore */}
      }

      // 3) Send Email if available (always, as a complement or fallback)
      if(cart.customer_email&&messaging){
        try{
          const emailResult=await messaging.sendEmail({
            to:cart.customer_email,
            subject:`${customerName}, you left items in your cart at ${storeName}!`,
            html:emailHtml,
          });
          emailSent=!!(emailResult&&emailResult.id);
          if(emailSent)console.log(`[Cart Recovery] Email to ${cart.customer_email}: SENT`);
          try{await pool.query('INSERT INTO message_log(store_id,channel,recipient,message_type,message,status) VALUES($1,$2,$3,$4,$5,$6)',
            [cart.store_id,'email',cart.customer_email,'cart_recovery','Cart recovery email',emailSent?'sent':'failed']);}catch{}
        }catch(e){console.log('[Cart Recovery] Email error:',e.message);}
      }

      // Mark recovery sent if at least one channel succeeded
      if(waSent||emailSent){
        const channel=waSent?'WhatsApp':'Email';
        await pool.query('UPDATE carts SET recovery_sent_at=NOW() WHERE id=$1',[cart.id]);
        // Notify the store admin
        const notifTitle=isCheckout?'Checkout recovery sent':'Cart recovery sent';
        const notifMsg=`${channel} recovery message sent to ${customerName} (${cart.customer_phone||cart.customer_email}) — ${productNames.substring(0,60)} — ${total.toLocaleString()} ${currency}`;
        try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'cart_recovery',$2,$3,'/dashboard/cart-recovery')",[cart.store_id,notifTitle,notifMsg]);}catch{}
      } else {
        // Notify admin of failed recovery attempt
        try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'cart_recovery',$2,$3,'/dashboard/cart-recovery')",[cart.store_id,'Recovery failed',`Could not reach ${customerName} (${cart.customer_phone||'no phone'}) — ${total.toLocaleString()} ${currency}`,'/dashboard/cart-recovery']);}catch{}
      }
    }
  }catch(e){console.log('[Cart Recovery Error]',e.message);}
};

// Run every 2 minutes so the per-store recovery delay is honored closely
// (an hourly tick made buyers wait up to ~1h past the configured delay).
setInterval(abandonedCartCheck,2*60*1000);
// First run after 30 seconds
setTimeout(abandonedCartCheck,30000);
console.log('✅ Abandoned cart recovery cron started (every 2m, per-store checkout delay / 7d cart threshold)');

// ═══ CARRIER SYNC CRON (every 10 minutes) ═══
const{runFullSync}=require('./services/carrierSync');
setInterval(runFullSync,10*60*1000);
setTimeout(runFullSync,60000);
console.log('✅ Carrier sync cron started (every 10min — syncs orders from carriers + updates tracking)');

// ═══ KEEP-ALIVE PING (prevents Render free-tier shutdown) ═══
const SELF_URL=process.env.RENDER_EXTERNAL_URL||process.env.BACKEND_URL||`http://localhost:${PORT}`;
const keepAlive=()=>{
  fetch(`${SELF_URL}/api/health`).then(r=>r.json()).then(()=>console.log('[Keep-Alive] Ping OK')).catch(e=>console.log('[Keep-Alive] Ping failed:',e.message));
};
// Ping every 14 minutes (Render shuts down after 15 min of inactivity)
setInterval(keepAlive,14*60*1000);
console.log(`✅ Keep-alive ping started (every 14min → ${SELF_URL}/api/health)`);
});
module.exports=app;

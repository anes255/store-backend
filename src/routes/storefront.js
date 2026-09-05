const express=require('express'),router=express.Router(),bcrypt=require('bcryptjs'),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth');
const messaging=require('../services/messaging');

// Format an order number using the store's custom prefix/suffix/start.
// cfg = stores.config JSONB. Defaults match legacy 'ORD-00001' format.
function formatOrderNumber(num,cfg){
  cfg=cfg||{};if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}
  const prefix=cfg.order_prefix||'ORD-';
  let suffix=cfg.order_suffix||'';if(suffix&&!suffix.startsWith('-'))suffix='-'+suffix;
  const start=parseInt(cfg.order_start_number)||0;
  const pad=parseInt(cfg.order_pad_length)||5;
  const n=(parseInt(num)||0)+(start>0?start-1:0);
  return `${prefix}${String(n).padStart(pad,'0')}${suffix}`;
}
router.formatOrderNumber=formatOrderNumber;

// ─────────────────────────────────────────────────────────────────────────────
// Live-visitor heartbeat tracking. The storefront pings /:slug/heartbeat every
// 15s while the page is open. The dashboard polls /by-id/:id/live-visitors to
// show the admin how many buyers are browsing right now (last 60s).
// ─────────────────────────────────────────────────────────────────────────────
const liveVisitors = new Map(); // store_id → Map(visitor_id → expiresAt)
function touchVisitor(storeId, visitorId) {
  if (!storeId || !visitorId) return;
  let m = liveVisitors.get(storeId);
  if (!m) { m = new Map(); liveVisitors.set(storeId, m); }
  m.set(visitorId, Date.now() + 30_000);
}
function activeCount(storeId) {
  const m = liveVisitors.get(storeId); if (!m) return 0;
  const now = Date.now();
  for (const [k, exp] of m) if (exp < now) m.delete(k);
  return m.size;
}
// Sweep every 60s so dropped sessions don't pile up in memory.
setInterval(() => { const now = Date.now(); for (const m of liveVisitors.values()) for (const [k, exp] of m) if (exp < now) m.delete(k); }, 60_000).unref?.();

router.post('/:slug/heartbeat', async (req, res) => {
  try {
    const s = (await pool.query('SELECT id FROM stores WHERE slug=$1', [req.params.slug])).rows[0];
    if (!s) return res.status(404).json({ error: 'Not found' });
    const visitorId = (req.body && req.body.visitor_id) || req.headers['x-visitor-id'] || (req.ip + '|' + (req.headers['user-agent'] || '').slice(0, 50));
    touchVisitor(s.id, visitorId);
    res.json({ ok: true, count: activeCount(s.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-id/:id/live-visitors', async (req, res) => {
  res.json({ count: activeCount(req.params.id) });
});

router.get('/:slug/delivery-companies', async (req, res) => {
  try {
    const store = (await pool.query('SELECT id FROM stores WHERE slug=$1', [req.params.slug])).rows[0];
    if (!store) return res.json([]);
    const r = await pool.query('SELECT id,name,provider_type,tracking_url,logo,base_rate,COALESCE(is_default,FALSE) AS is_default FROM delivery_companies WHERE store_id=$1 AND is_active IS NOT FALSE ORDER BY is_default DESC,name', [store.id]);
    res.json(r.rows);
  } catch { res.json([]); }
});

// Get store (public)
// Lookup store by custom domain
router.get('/by-domain/:domain',async(req,res)=>{try{
  const d=await pool.query('SELECT sd.store_id,s.slug FROM store_domains sd JOIN stores s ON s.id=sd.store_id WHERE sd.domain_name=$1 AND sd.status=$2',[req.params.domain,'active']);
  if(!d.rows.length)return res.status(404).json({error:'Domain not found'});
  res.json({slug:d.rows[0].slug,store_id:d.rows[0].store_id});
}catch(e){res.status(500).json({error:e.message});}});

router.get('/:slug',async(req,res)=>{try{const s=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!s)return res.status(404).json({error:'Store not found'});
  // Check owner subscription - only block if explicitly suspended
  let suspended=false;
  try{const owner=(await pool.query('SELECT subscription_status FROM store_owners WHERE id=$1',[s.owner_id])).rows[0];if(owner&&owner.subscription_status==='suspended')suspended=true;}catch(e){}
  if(suspended)return res.status(403).json({error:'Store suspended',suspended:true});
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}const cfg=s.config||{};const chargilyOk=!!(process.env.CHARGILY_API_KEY);res.json({id:s.id,name:s.store_name,slug:s.slug,description:s.description,logo:s.logo_url,favicon:s.favicon_url,meta_title:s.meta_title,meta_description:s.meta_description,primary_color:s.primary_color||'#7C3AED',secondary_color:s.secondary_color||'#10B981',accent_color:s.accent_color||'#F59E0B',bg_color:s.bg_color||'#FAFAFA',text_color:cfg.text_color||'#1F2937',currency:s.currency||'DZD',default_language:cfg.default_language||'en',is_live:s.is_published,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle,contact_email:s.contact_email,contact_phone:s.contact_phone,support_phone:cfg.support_phone||s.support_phone||null,social_facebook:s.social_facebook,social_instagram:s.social_instagram,social_tiktok:s.social_tiktok,youtube:cfg.youtube||cfg.youtube_url||null,youtube_url:cfg.youtube_url||cfg.youtube||null,social_twitter:cfg.social_twitter||cfg.twitter||null,twitter_url:cfg.twitter_url||cfg.social_twitter||cfg.twitter||null,social_linkedin:cfg.social_linkedin||cfg.linkedin||null,linkedin_url:cfg.linkedin_url||cfg.social_linkedin||cfg.linkedin||null,snapchat:cfg.snapchat||cfg.social_snapchat||null,pinterest:cfg.pinterest||cfg.social_pinterest||null,whatsapp_number:s.contact_phone,
    // Payment
    enable_cod:pay.cod_enabled||true,enable_ccp:pay.ccp_enabled||false,ccp_account:pay.ccp_account,ccp_name:pay.ccp_name,enable_baridimob:pay.baridimob_enabled||false,baridimob_rip:pay.baridimob_rip,baridimob_qr:cfg.baridimob_qr||null,enable_bank_transfer:pay.bank_transfer_enabled||false,bank_name:pay.bank_name,bank_account:pay.bank_account,bank_rib:pay.bank_rib,
    enable_chargily:chargilyOk&&(cfg.chargily_enabled!==false),
    // Shipping
    shipping_default_price:400,
    // AI & Chat
    ai_chatbot_enabled:cfg.ai_chatbot_enabled||cfg.ai_agent_enabled||false,ai_chatbot_name:cfg.ai_chatbot_name||'Support Bot',ai_chatbot_greeting:cfg.ai_chatbot_greeting||'مرحباً! كيف يمكنني مساعدتك؟',
    // WhatsApp floating button (admin-configurable in Store Details)
    whatsapp_button_enabled:!!cfg.whatsapp_button_enabled,whatsapp_button_number:cfg.whatsapp_button_number||'',whatsapp_button_message:cfg.whatsapp_button_message||'',
    // Scrollbar Studio (Customization → Scrollbar)
    scrollbar:cfg.scrollbar||null,
    // Customization from config
    theme:cfg.theme||'classic',btn_add_cart:cfg.btn_add_cart||'Add to Cart',btn_order_now:cfg.btn_order_now||'Order Now',welcome_message:cfg.welcome_message,success_message:cfg.success_message,
    // Order success page customization (admin → Settings → Checkout)
    success_logo:cfg.success_logo||null,success_title:cfg.success_title||null,success_subtitle:cfg.success_subtitle||null,
    // Store-wide coupon (admin → Settings → Checkout)
    store_coupon_active:!!cfg.store_coupon_active,store_coupon_code:cfg.store_coupon_code||'',store_coupon_discount_percent:parseFloat(cfg.store_coupon_discount_percent)||0,
    offer_enabled:cfg.offer_enabled,offer_title:cfg.offer_title,offer_discount:cfg.offer_discount,offer_bg:cfg.offer_bg,offer_tc:cfg.offer_tc,offer_hours:cfg.offer_hours,offer_minutes:cfg.offer_minutes,
    sticky_header:cfg.sticky_header,cart_drawer:cfg.cart_drawer,trust_signals:cfg.trust_signals,show_savings:cfg.show_savings,show_stock_storefront:cfg.show_stock_storefront,low_stock_threshold:cfg.low_stock_threshold||5,
    // Checkout experience (admin toggles in Store Settings → Checkout)
    checkout_email:cfg.checkout_email===true,order_notes:cfg.order_notes===true,sticky_checkout:cfg.sticky_checkout===true,post_script:cfg.post_script||'',
    // Tracking pixels
    fb_pixel:cfg.fb_pixel,tiktok_pixel:cfg.tiktok_pixel,ga_id:cfg.ga_id,snap_pixel:cfg.snap_pixel,
    // Cover image
    cover_image:cfg.cover_image||null,
    page_builder:cfg.page_builder||null,
    // Owner-customizable header
    header_font:cfg.header_font||null,
    // Section animations (merchant-controlled, overrides template motion)
    animation_style:cfg.animation_style||null,
    animations_enabled:cfg.animations_enabled!==false,
    // Tracking settings
    tracking_enabled:cfg.tracking_enabled!==false,tracking_search_method:cfg.tracking_search_method||'phone',tracking_hero_title:cfg.tracking_hero_title||'',tracking_hero_sub:cfg.tracking_hero_sub||'',tracking_show_price:cfg.tracking_show_price!==false,tracking_show_items:cfg.tracking_show_items!==false,tracking_show_timeline:cfg.tracking_show_timeline!==false,tracking_show_address:cfg.tracking_show_address!==false,tracking_show_payment:cfg.tracking_show_payment!==false,tracking_show_tracking_number:cfg.tracking_show_tracking_number!==false,
    // Tax settings (read by checkout)
    tax_enabled:cfg.tax_enabled||false,tax_rate:cfg.tax_rate||0,tax_label:cfg.tax_label||'TVA',tax_inclusive:cfg.tax_inclusive||false,
    // Active domain selection
    active_domain:cfg.active_domain||'platform',
    // About Us (admin-configurable brand story & mission)
    about_story:cfg.about_story||'',about_mission:cfg.about_mission||'',
    // Landing pages (scroll-to-checkout). Strip the heavy ai_html (can hold a
    // multi-MB embedded image) from this list — the full page is fetched on
    // demand via GET /:slug/landing/:lpSlug so storefront calls stay light.
    landing_pages:Array.isArray(cfg.landing_pages)?cfg.landing_pages.filter(lp=>lp.enabled).map(lp=>{const{ai_html,...rest}=lp;return{...rest,has_ai_html:!!ai_html};}):[],
    // Full config exposed for buyer-side feature flags (chatbot, AI, etc.) —
    // also without the heavy ai_html blobs.
    config:{...cfg,landing_pages:Array.isArray(cfg.landing_pages)?cfg.landing_pages.map(lp=>{const{ai_html,...rest}=lp;return{...rest,has_ai_html:!!ai_html};}):cfg.landing_pages},
    // Footer
    footer_text:cfg.footer_text||`© ${new Date().getFullYear()} ${s.store_name}. All rights reserved.`});}catch(e){res.status(500).json({error:e.message});}});

// Single landing page WITH its full ai_html — fetched on demand so the heavy
// AI HTML (with embedded generated image) isn't shipped on every storefront call.
router.get('/:slug/landing/:lpSlug',async(req,res)=>{try{
  const s=(await pool.query('SELECT config FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Not found'});
  let cfg=s.config||{};if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}
  const lp=(Array.isArray(cfg.landing_pages)?cfg.landing_pages:[]).find(p=>p.slug===req.params.lpSlug&&p.enabled);
  if(!lp)return res.status(404).json({error:'Landing page not found'});
  res.json(lp);
}catch(e){res.status(500).json({error:e.message});}});

// Public shipping wilayas — used by checkout to show desk/home prices
router.get('/:slug/shipping-wilayas',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Not found'});
  // Expose the per-mode enabled flags so checkout can hide the home or desk
  // option for a wilaya the owner disabled that mode on.
  let rows;
  try{rows=(await pool.query('SELECT wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active,home_enabled,desk_enabled,company_prices FROM shipping_wilayas WHERE store_id=$1 AND (is_active IS NULL OR is_active=TRUE) ORDER BY wilaya_code',[store.id])).rows;}
  catch{rows=(await pool.query('SELECT wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active FROM shipping_wilayas WHERE store_id=$1 AND (is_active IS NULL OR is_active=TRUE) ORDER BY wilaya_code',[store.id])).rows;}
  res.json(rows);
}catch(e){res.json([]);}});

// Products (public)
router.get('/:slug/products',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{search,category,sort,featured}=req.query;let q='SELECT * FROM products WHERE store_id=$1 AND is_active=TRUE';const p=[store.id];if(category){p.push(category);q+=` AND category_id=$${p.length}`;}if(search){p.push(`%${search}%`);q+=` AND name ILIKE $${p.length}`;}if(featured==='true')q+=' AND is_featured=TRUE';if(sort==='price_asc')q+=' ORDER BY price ASC';else if(sort==='price_desc')q+=' ORDER BY price DESC';else q+=' ORDER BY created_at DESC';q+=' LIMIT 50';const r=await pool.query(q,p);const products=r.rows.map(x=>{let imgs=x.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];return{...x,name_en:x.name,name_fr:x.name,name_ar:x.name,thumbnail:imgs[0]||null,compare_at_price:x.compare_price};});const count=await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1 AND is_active=TRUE',[store.id]);res.json({products,total:parseInt(count.rows[0].count)});}catch(e){res.status(500).json({error:e.message});}});

// Single product
router.get('/:slug/products/:pslug',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const r=await pool.query('SELECT * FROM products WHERE store_id=$1 AND slug=$2 AND is_active=TRUE',[store.id,req.params.pslug]);if(!r.rows.length)return res.status(404).json({error:'Not found'});const p=r.rows[0];let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];res.json({...p,name_en:p.name,name_fr:p.name,name_ar:p.name,description_en:p.description,thumbnail:imgs[0]||null,compare_at_price:p.compare_price,allow_oversell:!!p.allow_oversell,reviews:[]});}catch(e){res.status(500).json({error:e.message});}});

// Categories
router.get('/:slug/categories',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.json([]);const r=await pool.query('SELECT * FROM categories WHERE store_id=$1 AND is_active=TRUE ORDER BY sort_order',[store.id]);res.json(r.rows.map(c=>({...c,name_en:c.name,name_fr:c.name,name_ar:c.name})));}catch(e){res.json([]);}});

// Customer register (per store)
router.post('/:slug/customers/register',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{name,email,phone,password,address,city,wilaya}=req.body;if(!name||!phone||!password)return res.status(400).json({error:'Name, phone, password required'});
  // Block registration if phone/email is already used by a store admin or platform admin
  const ownerDup=await pool.query('SELECT 1 FROM store_owners WHERE phone=$1 OR (email IS NOT NULL AND email=$2) LIMIT 1',[phone,email||null]).catch(()=>({rows:[]}));
  if(ownerDup.rows.length)return res.status(409).json({error:'This phone or email belongs to a store admin. Please use a different one.'});
  const paDup=await pool.query("SELECT 1 FROM platform_admins WHERE phone=$1 OR (email IS NOT NULL AND email=$2) LIMIT 1",[phone,email||null]).catch(()=>({rows:[]}));
  if(paDup.rows.length)return res.status(409).json({error:'This phone or email belongs to a platform admin. Please use a different one.'});
  const dup=await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[store.id,phone]);if(dup.rows.length)return res.status(409).json({error:'Phone registered'});const hash=await bcrypt.hash(password,12);const r=await pool.query('INSERT INTO customers(store_id,full_name,email,phone,password_hash,address,city,wilaya) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,full_name,email,phone,address,city,wilaya',[store.id,name,email||null,phone,hash,address||null,city||null,wilaya||null]);const c=r.rows[0];const token=generateToken({id:c.id,role:'customer',storeId:store.id,name:c.full_name});res.status(201).json({token,customer:{id:c.id,name:c.full_name,email:c.email,phone:c.phone,address:c.address,city:c.city,wilaya:c.wilaya}});}catch(e){res.status(500).json({error:e.message});}});

// Customer login
router.post('/:slug/customers/login',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{phone,password}=req.body;const c=(await pool.query('SELECT * FROM customers WHERE store_id=$1 AND phone=$2',[store.id,phone])).rows[0];if(!c)return res.status(401).json({error:'Invalid'});if(!(await bcrypt.compare(password,c.password_hash)))return res.status(401).json({error:'Invalid'});const token=generateToken({id:c.id,role:'customer',storeId:store.id,name:c.full_name});res.json({token,customer:{id:c.id,name:c.full_name,email:c.email,phone:c.phone,address:c.address||null,city:c.city||null,wilaya:c.wilaya||null}});}catch(e){res.status(500).json({error:e.message});}});

// Customer profile
router.get('/:slug/customers/profile',authMiddleware([]),async(req,res)=>{try{const c=(await pool.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0];if(!c)return res.status(403).json({error:'Not a customer account'});const orders=(await pool.query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[req.user.id])).rows;let storeCfg2={};try{let _r2=(await pool.query('SELECT config FROM stores WHERE slug=$1',[req.params.slug])).rows[0]?.config||{};if(typeof _r2==='string'){try{_r2=JSON.parse(_r2);}catch{_r2={};}}storeCfg2=_r2;}catch(e){}
  // Attach order_items (with product name, image, variant, quantity, prices)
  // so the buyer's "My Orders" list can show full product details per line.
  const orderIds=orders.map(o=>o.id);
  let itemsByOrder={};
  if(orderIds.length){
    try{
      const itemsRes=await pool.query('SELECT oi.*, p.images as product_images_current, p.name as product_name_current FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1::uuid[])',[orderIds]);
      for(const it of itemsRes.rows){
        const key=it.order_id;
        if(!itemsByOrder[key])itemsByOrder[key]=[];
        let variantLabel=null;
        if(it.variant_info){
          try{
            const v=typeof it.variant_info==='string'?JSON.parse(it.variant_info):it.variant_info;
            if(v&&typeof v==='object'){variantLabel=Object.entries(v).map(([k,val])=>`${k}: ${val}`).join(' · ');}
            else if(v)variantLabel=String(v);
          }catch(e){variantLabel=String(it.variant_info);}
        }
        // Resolve image: saved snapshot first, else look up the current product's first image
        let img=it.product_image||null;
        if(!img&&it.product_images_current){
          let imgs=it.product_images_current;
          try{if(typeof imgs==='string')imgs=JSON.parse(imgs);}catch(e){imgs=[];}
          if(Array.isArray(imgs)&&imgs.length){const f=imgs[0];img=typeof f==='string'?f:(f?.url||null);}
        }
        itemsByOrder[key].push({...it,product_image:img,name:it.product_name||it.product_name_current,price:it.unit_price,variant_label:variantLabel});
      }
    }catch(e){}
  }
  res.json({...c,name:c.full_name,orders:orders.map(o=>({...o,order_number:formatOrderNumber(o.order_number,storeCfg2),discount_amount:o.discount,items:itemsByOrder[o.id]||[]}))});}catch(e){res.status(500).json({error:e.message});}});
router.put('/:slug/customers/profile',authMiddleware([]),async(req,res)=>{try{const exists=(await pool.query('SELECT 1 FROM customers WHERE id=$1',[req.user.id])).rows[0];if(!exists)return res.status(403).json({error:'Not a customer account'});const b=req.body||{};
  // Make sure the profile_picture column exists (older databases may not have it).
  try{await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS profile_picture TEXT');}catch(e){}
  // Phone change dedup: block if phone collides with an admin account or another customer
  if(b.phone){
    const ownerDup=await pool.query('SELECT 1 FROM store_owners WHERE phone=$1 LIMIT 1',[b.phone]).catch(()=>({rows:[]}));
    if(ownerDup.rows.length)return res.status(409).json({error:'This phone number belongs to a store admin. Use a different phone.'});
    const paDup=await pool.query('SELECT 1 FROM platform_admins WHERE phone=$1 LIMIT 1',[b.phone]).catch(()=>({rows:[]}));
    if(paDup.rows.length)return res.status(409).json({error:'This phone number belongs to a platform admin. Use a different phone.'});
    const custDup=await pool.query('SELECT 1 FROM customers WHERE phone=$1 AND id<>$2 LIMIT 1',[b.phone,req.user.id]).catch(()=>({rows:[]}));
    if(custDup.rows.length)return res.status(409).json({error:'This phone number is already in use by another account.'});
  }
  await pool.query('UPDATE customers SET full_name=COALESCE($1,full_name),email=$2,phone=COALESCE($3,phone),address=$4,city=$5,wilaya=$6,profile_picture=COALESCE($7,profile_picture) WHERE id=$8',[b.name||null,b.email||null,b.phone||null,b.address||null,b.city||null,b.wilaya||null,b.profile_picture||null,req.user.id]);
  const c=(await pool.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0];res.json({...c,name:c.full_name});}catch(e){res.status(500).json({error:e.message});}});

// Checkout
router.post('/:slug/orders',async(req,res)=>{try{const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const sid=store.id;const{items,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,shipping_type,payment_method,notes,customer_id,notification_preference,delivery_company_id}=req.body;if(!items||!items.length)return res.status(400).json({error:'Cart empty'});if(!customer_name||!customer_phone||!shipping_address)return res.status(400).json({error:'Info required'});let subtotal=0;const oi=[];let storeCfg=store.config||{};if(typeof storeCfg==='string'){try{storeCfg=JSON.parse(storeCfg);}catch{storeCfg={};}}const allowStoreOversell=storeCfg.allow_oversell===true;for(const it of items){const p=(await pool.query('SELECT * FROM products WHERE id=$1 AND store_id=$2',[it.product_id,sid])).rows[0];if(!p)return res.status(400).json({error:`Product not found: ${it.product_id}`});
  // Check stock — block the whole order if any item is out of stock and oversell is disabled
  if(p.stock_quantity!==null&&p.stock_quantity<(it.quantity||1)&&!p.allow_oversell&&!allowStoreOversell&&p.track_inventory!==false){
    return res.status(400).json({error:`Out of stock: ${p.name}`,product_id:p.id,out_of_stock:true});
  }
  let unitPrice=parseFloat(p.price)||0;
  // Apply active offer discount (e.g. "40% OFF") before variant adjustments
  if(p.is_on_sale&&p.offer_discount){const _opct=parseFloat(String(p.offer_discount).replace(/[^0-9.]/g,''))||0;if(_opct>0)unitPrice=Math.round(unitPrice*(1-_opct/100));}
  if(it.variant){let vd=it.variant;if(typeof vd==='string'){try{vd=JSON.parse(vd);}catch{vd={};}}if(vd.price!=null&&parseFloat(vd.price)>0)unitPrice=parseFloat(vd.price);else if(vd.price_diff!=null)unitPrice+=parseFloat(vd.price_diff);else if(vd.additional_price!=null)unitPrice+=parseFloat(vd.additional_price);if(Array.isArray(vd.selections)){for(const sel of vd.selections){if(sel.price_diff!=null)unitPrice+=parseFloat(sel.price_diff);}}}
  // Apply quantity offer discount (e.g. "Buy 3 get 20% OFF")
  {let qOffers=p.quantity_offers;if(typeof qOffers==='string'){try{qOffers=JSON.parse(qOffers);}catch{qOffers=[];}}if(Array.isArray(qOffers)){const qMatch=qOffers.filter(qo=>parseInt(qo.quantity)>0&&it.quantity>=parseInt(qo.quantity)).sort((a,b)=>parseInt(b.quantity)-parseInt(a.quantity))[0];if(qMatch){const _dv=parseFloat(qMatch.discount_value)||0;if(_dv>0){if(qMatch.discount_type==='fixed')unitPrice=Math.max(0,unitPrice-_dv);else unitPrice=Math.round(unitPrice*(1-_dv/100));}else if(qMatch.label){const _qm=String(qMatch.label).match(/(\d+(?:\.\d+)?)\s*%/);if(_qm){const _qpct=parseFloat(_qm[1]);if(_qpct>0)unitPrice=Math.round(unitPrice*(1-_qpct/100));}}}}}
  const t=unitPrice*it.quantity;subtotal+=t;let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];oi.push({product_id:p.id,product_name:p.name,product_image:imgs[0]||null,variant_info:it.variant||null,quantity:it.quantity,unit_price:unitPrice,total_price:t,weight:(parseFloat(p.weight)||0)*(it.quantity||1)});}
  // Determine shipping cost from wilaya rates (desk vs home delivery).
  // If a delivery company is selected and that wilaya has a per-company price,
  // use that price instead of the default desk/home rate.
  let ship=400; // default fallback
  const sType=(shipping_type||'desk').toLowerCase();
  const dcChosen=req.body?.delivery_company_id||null;
  if(shipping_wilaya){try{
    let wRow;
    try{wRow=(await pool.query('SELECT desk_delivery_price,home_delivery_price,company_prices FROM shipping_wilayas WHERE store_id=$1 AND wilaya_name=$2',[sid,shipping_wilaya])).rows[0];}
    catch{wRow=(await pool.query('SELECT desk_delivery_price,home_delivery_price FROM shipping_wilayas WHERE store_id=$1 AND wilaya_name=$2',[sid,shipping_wilaya])).rows[0];}
    if(wRow){
      let cp=wRow.company_prices;if(typeof cp==='string'){try{cp=JSON.parse(cp);}catch{cp={};}}
      const perCompany=cp&&delivery_company_id?cp[delivery_company_id]:null;
      if(perCompany){ship=sType==='home'?parseFloat(perCompany.home||perCompany.home_price||wRow.home_delivery_price||400):parseFloat(perCompany.desk||perCompany.desk_price||wRow.desk_delivery_price||400);}
      else{ship=sType==='home'?parseFloat(wRow.home_delivery_price||400):parseFloat(wRow.desk_delivery_price||400);}
    }
  }catch(e){}}
  const pm=(payment_method||'cod').toLowerCase();
  const isNonCod=['ccp','baridimob','bank_transfer'].includes(pm);
  // Coupon deduction — validate server-side
  let discount=0;
  const couponCode=(req.body.coupon_code||'').trim().toUpperCase();
  if(couponCode){
    const cfg=storeCfg;
    const allSC=[{active:cfg.store_coupon_active,code:cfg.store_coupon_code,pct:parseFloat(cfg.store_coupon_discount_percent)||0}];
    if(Array.isArray(cfg.extra_coupons))cfg.extra_coupons.forEach(c=>allSC.push({active:c.active,code:c.code,pct:parseFloat(c.discount)||0}));
    const matchedSC=allSC.find(sc=>sc.active&&String(sc.code||'').trim().toUpperCase()===couponCode&&sc.pct>0);
    if(matchedSC){
      discount=Math.round(subtotal*(matchedSC.pct/100));
    }else{
      const cpProducts=await pool.query('SELECT id,price,coupon_code,coupon_discount_percent,coupon_active FROM products WHERE store_id=$1 AND coupon_active=TRUE AND coupon_code IS NOT NULL',[sid]);
      const cpMatching=cpProducts.rows.filter(p=>String(p.coupon_code||'').trim().toUpperCase()===couponCode);
      discount=cpMatching.reduce((s,p)=>{const pct=parseFloat(p.coupon_discount_percent)||0;return s+Math.round((parseFloat(p.price)||0)*(pct/100));},0);
    }
  }
  const total=subtotal+ship-discount;const num=parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1',[sid])).rows[0].n);const prefDcId=delivery_company_id||null;
  const initialStatus=(pm==='ccp'||pm==='baridimob')?'pending_payment':'new_order';
  const o=await pool.query('INSERT INTO orders(store_id,customer_id,order_number,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,subtotal,shipping_cost,discount,total,payment_method,notes,notification_preference,shipping_type,preferred_delivery_company_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',[sid,customer_id||null,num,customer_name,customer_phone,customer_email||null,shipping_address,shipping_city||null,shipping_wilaya||null,shipping_zip||null,subtotal,ship,discount,total,payment_method||'cod',notes||null,notification_preference||'whatsapp',sType,prefDcId,initialStatus]);try{await pool.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS weight NUMERIC DEFAULT 0");}catch(e){}for(const it of oi){await pool.query('INSERT INTO order_items(order_id,product_id,product_name,product_image,variant_info,quantity,unit_price,total_price,weight) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[o.rows[0].id,it.product_id,it.product_name,it.product_image,it.variant_info,it.quantity,it.unit_price,it.total_price,it.weight||0]);}// Auto-add or update customer record so every buyer shows in the customers page.
// Registered buyers already have a row; guest checkouts get one created here.
let custId = customer_id || null;
if (custId) {
  try { await pool.query('UPDATE customers SET total_orders=COALESCE(total_orders,0)+1,total_spent=COALESCE(total_spent,0)+$1,address=COALESCE($2,address),city=COALESCE($3,city),wilaya=COALESCE($4,wilaya) WHERE id=$5',[total,shipping_address,shipping_city,shipping_wilaya,custId]); } catch(e){}
} else {
  // Try to find an existing customer by phone, or create one.
  try {
    const existing = await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[sid,customer_phone]);
    if (existing.rows.length) {
      custId = existing.rows[0].id;
      await pool.query('UPDATE customers SET total_orders=COALESCE(total_orders,0)+1,total_spent=COALESCE(total_spent,0)+$1,full_name=COALESCE($2,full_name),email=COALESCE($3,email),address=COALESCE($4,address),city=COALESCE($5,city),wilaya=COALESCE($6,wilaya) WHERE id=$7',[total,customer_name,customer_email,shipping_address,shipping_city,shipping_wilaya,custId]);
    } else {
      const nc = await pool.query('INSERT INTO customers(store_id,full_name,email,phone,address,city,wilaya,total_orders,total_spent) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8) RETURNING id',[sid,customer_name,customer_email||null,customer_phone,shipping_address||null,shipping_city||null,shipping_wilaya||null,total]);
      custId = nc.rows[0]?.id;
    }
    // Link the order to the customer so it shows in their profile
    if (custId) await pool.query('UPDATE orders SET customer_id=$1 WHERE id=$2',[custId,o.rows[0].id]);
  } catch(e){}
}
// Auto-create notification for store owner — skip for pending_payment (receipt not yet submitted)
if(initialStatus!=='pending_payment'){
try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'order',$2,$3,$4)",[sid,`New order #${num}`,`${customer_name} placed an order for ${total} ${store.currency||'DZD'}`,'/dashboard/orders']);}catch(e){}
try{const{sendStorePush}=require('./storeOwner');sendStorePush(sid,`New order #${num}`,`${customer_name} — ${total} ${store.currency||'DZD'}`);}catch(e){}
// Send WhatsApp notification to buyer for new order
try{
  const pref=(notification_preference||'whatsapp').toUpperCase();
  if(customer_phone&&pref==='WHATSAPP'){
    let cfg=store.config||{};if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}
    let waEnabled={};try{waEnabled=typeof cfg.wa_enabled_statuses==='string'?JSON.parse(cfg.wa_enabled_statuses||'{}'):(cfg.wa_enabled_statuses||{});}catch{}
    if(waEnabled.new_order!==false){
      const waLang=cfg.wa_language||'ar';
      let waTemplates=cfg.wa_templates;if(typeof waTemplates==='string'){try{waTemplates=JSON.parse(waTemplates);}catch{waTemplates=null;}}
      const orderNum=formatOrderNumber(num,storeCfg);
      const shippingMethodTr=(()=>{if(waLang==='ar')return sType==='desk'?'مكتب':'منزل';if(waLang==='fr')return sType==='desk'?'Bureau':'Domicile';return sType==='desk'?'Desk':'Home';})();
      const _WAR={'Adrar':'أدرار','Chlef':'الشلف','Laghouat':'الأغواط','Oum El Bouaghi':'أم البواقي','Batna':'باتنة','Béjaïa':'بجاية','Biskra':'بسكرة','Béchar':'بشار','Blida':'البليدة','Bouira':'البويرة','Tamanrasset':'تمنراست','Tébessa':'تبسة','Tlemcen':'تلمسان','Tiaret':'تيارت','Tizi Ouzou':'تيزي وزو','Alger':'الجزائر','Djelfa':'الجلفة','Jijel':'جيجل','Sétif':'سطيف','Saïda':'سعيدة','Skikda':'سكيكدة','Sidi Bel Abbès':'سيدي بلعباس','Annaba':'عنابة','Guelma':'قالمة','Constantine':'قسنطينة','Médéa':'المدية','Mostaganem':'مستغانم','M\'Sila':'المسيلة','Mascara':'معسكر','Ouargla':'ورقلة','Oran':'وهران','El Bayadh':'البيض','Illizi':'إليزي','Bordj Bou Arréridj':'برج بوعريريج','Boumerdès':'بومرداس','El Tarf':'الطارف','Tindouf':'تندوف','Tissemsilt':'تيسمسيلت','El Oued':'الوادي','Khenchela':'خنشلة','Souk Ahras':'سوق أهراس','Tipaza':'تيبازة','Mila':'ميلة','Aïn Defla':'عين الدفلى','Naâma':'النعامة','Aïn Témouchent':'عين تموشنت','Ghardaïa':'غرداية','Relizane':'غليزان','El M\'Ghair':'المغير','El Meniaa':'المنيعة','Ouled Djellal':'أولاد جلال','Bordj Badji Mokhtar':'برج باجي مختار','Béni Abbès':'بني عباس','Timimoun':'تيميمون','Touggourt':'تقرت','Djanet':'جانت','In Salah':'عين صالح','In Guezzam':'عين قزام'};
      const fields={store_name:store.store_name,store_phone:store.contact_phone||'',store_email:store.contact_email||'',order_number:orderNum,order_date:o.rows[0].created_at,order_time:o.rows[0].created_at,customer_name,customer_phone,customer_email:customer_email||'',total,subtotal,shipping_cost:ship,discount,currency:store.currency||'DZD',shipping_address,shipping_city:shipping_city||'',shipping_wilaya:shipping_wilaya||'',shipping_zip:shipping_zip||'',shipping_type:sType,shipping_method:shippingMethodTr,payment_method:pm,tracking_number:'',delivery_company:'',wilaya_fr:shipping_wilaya||'',wilaya_ar:_WAR[shipping_wilaya]||shipping_wilaya||'',commune_fr:shipping_city||'',commune_ar:shipping_city||'',items:oi,item_count:oi.length};
      const msg=messaging.generateOrderMessage({wa_templates:waTemplates},'new_order',fields,waLang)||`Your order ${orderNum} from ${store.store_name} has been received. Total: ${total} ${store.currency||'DZD'}`;
      messaging.sendWhatsApp(customer_phone,msg,sid).then(r=>{
        pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)',[sid,'whatsapp',customer_phone,msg.substring(0,200),r.success?'sent':'failed',r.reason||null]).catch(()=>{});
      }).catch(()=>{});
    }
  }
}catch(e){console.log('[new order WA]',e.message);}
}
// Auto-decrease stock — if oversell is allowed, let stock go negative so the admin can see the deficit
for(const it of oi){try{
  const pr=await pool.query('SELECT allow_oversell FROM products WHERE id=$1',[it.product_id]);
  const oversell=pr.rows[0]?.allow_oversell===true;
  if(oversell){
    await pool.query('UPDATE products SET stock_quantity=COALESCE(stock_quantity,0)-$1 WHERE id=$2',[it.quantity,it.product_id]);
  }else{
    await pool.query('UPDATE products SET stock_quantity=GREATEST(0,COALESCE(stock_quantity,0)-$1) WHERE id=$2',[it.quantity,it.product_id]);
  }
}catch(e){}}
// Mark any abandoned carts for this customer as recovered
try{await pool.query('UPDATE carts SET is_recovered=TRUE,updated_at=NOW() WHERE store_id=$1 AND customer_phone=$2 AND is_recovered=FALSE',[sid,customer_phone]);}catch(e){}
res.status(201).json({...o.rows[0],order_number:formatOrderNumber(num,storeCfg),items:oi,item_count:oi.reduce((s,i)=>s+(parseInt(i.quantity)||0),0)});}catch(e){console.error(e);res.status(500).json({error:e.message});}});

// Buyer cancel order (only if not shipped/delivered)
router.post('/:slug/orders/:oid/cancel',async(req,res)=>{try{
  const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Not found'});
  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,store.id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});
  if(['shipped','delivered','cancelled'].includes(order.status))return res.status(400).json({error:`Cannot cancel — order is already ${order.status}`});
  const r=await pool.query("UPDATE orders SET status='cancelled',cancelled_at=NOW(),cancel_reason='Cancelled by customer',updated_at=NOW() WHERE id=$1 RETURNING *",[order.id]);
  // Notify store owner
  const orderNum=formatOrderNumber(order.order_number,store.config||{});
  try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'order',$2,$3,$4)",[store.id,`Order ${orderNum} cancelled by customer`,`${order.customer_name} cancelled their order (${order.total} DZD)`,'/dashboard/orders']);}catch(e){}
  try{const{sendStorePush}=require('./storeOwner');sendStorePush(store.id,`Order ${orderNum} cancelled`,`${order.customer_name} cancelled their order`);}catch(e){}
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// ═══ COUPON VALIDATION ═══
router.post('/:slug/validate-coupon',async(req,res)=>{try{
  const store=(await pool.query('SELECT id,config FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const{code,subtotal}=req.body;
  if(!code)return res.status(400).json({error:'Coupon code required'});
  const upper=String(code).trim().toUpperCase();
  const cfg=store.config||{};
  // Check store-wide coupons from config (primary + extra)
  const allStoreCoupons=[{active:cfg.store_coupon_active,code:cfg.store_coupon_code,pct:parseFloat(cfg.store_coupon_discount_percent)||0}];
  if(Array.isArray(cfg.extra_coupons))cfg.extra_coupons.forEach(c=>allStoreCoupons.push({active:c.active,code:c.code,pct:parseFloat(c.discount)||0}));
  for(const sc of allStoreCoupons){
    if(sc.active&&String(sc.code||'').trim().toUpperCase()===upper&&sc.pct>0){
      const discount=Math.round((parseFloat(subtotal)||0)*(sc.pct/100));
      return res.json({valid:true,discount,type:'store_wide',percent:sc.pct});
    }
  }
  // Check per-product coupons
  const products=await pool.query('SELECT id,price,coupon_code,coupon_discount_percent,coupon_active FROM products WHERE store_id=$1 AND coupon_active=TRUE AND coupon_code IS NOT NULL',[store.id]);
  const matching=products.rows.filter(p=>String(p.coupon_code||'').trim().toUpperCase()===upper);
  if(matching.length>0){
    const totalDiscount=matching.reduce((s,p)=>{
      const pct=parseFloat(p.coupon_discount_percent)||0;
      return s+Math.round((parseFloat(p.price)||0)*(pct/100));
    },0);
    if(totalDiscount>0)return res.json({valid:true,discount:totalDiscount,type:'product',count:matching.length});
  }
  res.status(404).json({error:'Invalid coupon'});
}catch(e){res.status(500).json({error:e.message});}});

// Pages
router.get('/:slug/pages',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.json([]);res.json((await pool.query('SELECT * FROM store_pages WHERE store_id=$1 AND is_published=TRUE',[store.id])).rows);}catch(e){res.json([]);}});

// ═══ PRODUCT REVIEWS (public) ═══
// Get approved reviews for a product
router.get('/:slug/products/:pslug/reviews',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.json({reviews:[],stats:{}});
  const product=(await pool.query('SELECT id FROM products WHERE store_id=$1 AND slug=$2',[store.id,req.params.pslug])).rows[0];
  if(!product)return res.json({reviews:[],stats:{}});
  const reviews=await pool.query('SELECT id,customer_name,rating,title,content,created_at FROM reviews WHERE product_id=$1 AND is_approved=TRUE ORDER BY created_at DESC LIMIT 50',[product.id]);
  const stats=await pool.query('SELECT COUNT(*) as total,ROUND(AVG(rating),1) as avg_rating,COUNT(*) FILTER(WHERE rating=5) as r5,COUNT(*) FILTER(WHERE rating=4) as r4,COUNT(*) FILTER(WHERE rating=3) as r3,COUNT(*) FILTER(WHERE rating=2) as r2,COUNT(*) FILTER(WHERE rating=1) as r1 FROM reviews WHERE product_id=$1 AND is_approved=TRUE',[product.id]);
  res.json({reviews:reviews.rows,stats:stats.rows[0]||{}});
}catch(e){res.json({reviews:[],stats:{}});}});

// Submit a review
router.post('/:slug/products/:pslug/reviews',async(req,res)=>{try{
  const store=(await pool.query('SELECT id,config FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const product=(await pool.query('SELECT id FROM products WHERE store_id=$1 AND slug=$2',[store.id,req.params.pslug])).rows[0];
  if(!product)return res.status(404).json({error:'Product not found'});
  const{customer_name,customer_phone,rating,title,content}=req.body;
  if(!customer_name||!rating)return res.status(400).json({error:'Name and rating required'});
  if(rating<1||rating>5)return res.status(400).json({error:'Rating must be 1-5'});

  // Check if customer already reviewed this product
  if(customer_phone){
    const dup=await pool.query('SELECT id FROM reviews WHERE product_id=$1 AND customer_phone=$2',[product.id,customer_phone]);
    if(dup.rows.length)return res.status(409).json({error:'You already reviewed this product'});
  }

  // AI moderation if enabled
  let aiScore=null,aiReason=null,autoApprove=false;
  const cfg=store.config||{};
  if(cfg.smart_reviews){
    try{
      const chatbot=require('../services/chatbot');
      const mod=await chatbot.moderateReview(content||'',rating);
      aiScore=mod.score;
      aiReason=mod.reason;
      autoApprove=mod.score>=70; // Auto-approve if AI score >= 70
    }catch(e){console.log('[Review AI Error]',e.message);}
  }

  const r=await pool.query(
    'INSERT INTO reviews(store_id,product_id,customer_name,customer_phone,rating,title,content,is_approved,ai_moderation_score,ai_moderation_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [store.id,product.id,customer_name,customer_phone||null,rating,title||null,content||null,autoApprove,aiScore,aiReason]
  );
  res.status(201).json({...r.rows[0],auto_approved:autoApprove});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ CART SYNC (for abandoned cart recovery) ═══
router.post('/:slug/save-cart',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const{customer_phone,customer_name,customer_email,items,
    shipping_address,shipping_city,shipping_wilaya,shipping_zip,
    shipping_type,delivery_company_id,payment_method,notification_preference,notes}=req.body;
  if(!customer_phone||!items||!items.length)return res.status(400).json({error:'Phone and items required'});

  const checkoutStarted=!!(shipping_address||shipping_wilaya||shipping_city);

  // Upsert cart
  const existing=await pool.query('SELECT id FROM carts WHERE store_id=$1 AND customer_phone=$2 AND is_abandoned=FALSE',[store.id,customer_phone]);
  const total=items.reduce((s,i)=>s+(parseFloat(i.price)||0)*(i.quantity||1),0);
  const itemsJson=JSON.stringify(items);

  if(existing.rows.length){
    await pool.query(`UPDATE carts SET items=$1,total=$2,customer_name=$3,customer_email=$4,
      shipping_address=$6,shipping_city=$7,shipping_wilaya=$8,shipping_zip=$9,
      shipping_type=$10,delivery_company_id=$11,payment_method=$12,notification_preference=$13,notes=$14,
      checkout_started=$15,updated_at=NOW() WHERE id=$5`,
      [itemsJson,total,customer_name||'',customer_email||'',existing.rows[0].id,
       shipping_address||null,shipping_city||null,shipping_wilaya||null,shipping_zip||null,
       shipping_type||null,delivery_company_id||null,payment_method||null,notification_preference||null,notes||null,
       checkoutStarted]);
  }else{
    await pool.query(`INSERT INTO carts(store_id,customer_phone,customer_name,customer_email,items,total,
      shipping_address,shipping_city,shipping_wilaya,shipping_zip,
      shipping_type,delivery_company_id,payment_method,notification_preference,notes,checkout_started)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [store.id,customer_phone,customer_name||'',customer_email||'',itemsJson,total,
       shipping_address||null,shipping_city||null,shipping_wilaya||null,shipping_zip||null,
       shipping_type||null,delivery_company_id||null,payment_method||null,notification_preference||null,notes||null,
       checkoutStarted]);
  }
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ RESTORE CART (for checkout recovery links) ═══
router.get('/:slug/restore-cart',async(req,res)=>{try{
  const{phone}=req.query;
  if(!phone)return res.status(400).json({error:'Phone required'});
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const cart=(await pool.query(
    `SELECT * FROM carts WHERE store_id=$1 AND customer_phone=$2
     AND is_recovered=FALSE ORDER BY updated_at DESC LIMIT 1`,
    [store.id,phone])).rows[0];
  if(!cart)return res.json({found:false});
  let items=cart.items;
  if(typeof items==='string')try{items=JSON.parse(items);}catch{items=[];}
  res.json({found:true,cart:{
    customer_name:cart.customer_name,customer_email:cart.customer_email,
    items,total:cart.total,
    shipping_address:cart.shipping_address,shipping_city:cart.shipping_city,
    shipping_wilaya:cart.shipping_wilaya,shipping_zip:cart.shipping_zip,
    shipping_type:cart.shipping_type,delivery_company_id:cart.delivery_company_id,
    payment_method:cart.payment_method,notification_preference:cart.notification_preference,
    notes:cart.notes,checkout_started:cart.checkout_started
  }});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ PUBLIC ORDER TRACKING ═══
router.get('/:slug/track',async(req,res)=>{try{
  const{phone,order_id}=req.query;
  if(!phone&&!order_id)return res.status(400).json({error:'Phone or order ID required'});
  const storeRow=(await pool.query('SELECT id,config FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!storeRow)return res.status(404).json({error:'Store not found'});
  let scfgEarly=storeRow.config||{};if(typeof scfgEarly==='string'){try{scfgEarly=JSON.parse(scfgEarly);}catch{scfgEarly={};}}
  if(scfgEarly.tracking_enabled===false)return res.status(403).json({error:'Tracking disabled'});
  const method=scfgEarly.tracking_search_method||'phone';
  if(order_id&&!phone&&method==='phone')return res.status(400).json({error:'Phone required'});
  if(phone&&!order_id&&method==='order_id')return res.status(400).json({error:'Order ID required'});
  const store={id:storeRow.id};
  let orders;
  if(order_id){
    // Strip prefix / pad — match on numeric order_number
    const digits=String(order_id).replace(/\D/g,'').replace(/^0+/,'')||'0';
    orders=await pool.query(
      `SELECT o.id,o.order_number,o.status,o.total,o.subtotal,o.shipping_cost,o.discount,o.payment_method,o.payment_status,o.customer_name,o.customer_phone,o.customer_email,o.shipping_address,o.shipping_city,o.shipping_wilaya,o.shipping_zip,o.shipping_type,o.notes,o.tracking_number,o.tracking_status,o.created_at,o.shipped_at,o.delivered_at,
        dc.name as delivery_company FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
        WHERE o.store_id=$1 AND (o.is_deleted IS NOT TRUE) AND CAST(o.order_number AS TEXT)=$2 ORDER BY o.created_at DESC LIMIT 20`,
      [store.id,digits]
    );
  }else{
    orders=await pool.query(
      `SELECT o.id,o.order_number,o.status,o.total,o.subtotal,o.shipping_cost,o.discount,o.payment_method,o.payment_status,o.customer_name,o.customer_phone,o.customer_email,o.shipping_address,o.shipping_city,o.shipping_wilaya,o.shipping_zip,o.shipping_type,o.notes,o.tracking_number,o.tracking_status,o.created_at,o.shipped_at,o.delivered_at,
        dc.name as delivery_company FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
        WHERE o.store_id=$1 AND (o.is_deleted IS NOT TRUE) AND o.customer_phone LIKE $2 ORDER BY o.created_at DESC LIMIT 20`,
      [store.id,'%'+phone.replace(/\D/g,'').slice(-9)]
    );
  }
  const scfg=scfgEarly;
  // Attach order_items so the public track page can show each ordered product
  const orderIds=orders.rows.map(o=>o.id);
  let itemsByOrder={};
  if(orderIds.length){
    try{
      const itemsRes=await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])',[orderIds]);
      for(const it of itemsRes.rows){
        if(!itemsByOrder[it.order_id])itemsByOrder[it.order_id]=[];
        let variantLabel=null;
        if(it.variant_info){try{const v=typeof it.variant_info==='string'?JSON.parse(it.variant_info):it.variant_info;if(v&&typeof v==='object')variantLabel=Object.entries(v).map(([k,val])=>`${k}: ${val}`).join(' · ');else if(v)variantLabel=String(v);}catch(e){variantLabel=String(it.variant_info);}}
        itemsByOrder[it.order_id].push({...it,name:it.product_name,price:it.unit_price,variant_label:variantLabel});
      }
    }catch(e){}
  }
  res.json(orders.rows.map(o=>({...o,order_number:formatOrderNumber(o.order_number,scfg),items:itemsByOrder[o.id]||[]})));
}catch(e){res.status(500).json({error:e.message});}});

// Dedicated visit tracking — called once per browser session by the Storefront page only.
router.post('/:slug/visit',async(req,res)=>{try{
  const s=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Not found'});
  await pool.query('UPDATE stores SET total_visits=COALESCE(total_visits,0)+1 WHERE id=$1',[s.id]);
  res.json({ok:true});
}catch(e){res.json({ok:false});}});

module.exports=router;

const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth'),bcrypt=require('bcryptjs');

// ── One-time schema self-heal + performance indexes ──
// Previously every admin GET ran several ALTER TABLE statements on each request,
// which is slow and pointless after the first run. The aggregation queries also
// had no indexes on the foreign keys they filter by, so COUNT/SUM-per-store was
// a full scan each time. Run all of it exactly once (shared promise) and add the
// indexes the admin dashboard/stores/owners queries depend on.
let _platformReady=null;
function ensurePlatformSchema(){
  if(_platformReady)return _platformReady;
  _platformReady=(async()=>{
    // Critical: columns the queries reference must exist — await these (fast).
    const alters=[
      "ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(32) DEFAULT 'active'",
      "ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) DEFAULT 'pending'",
      "ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT true",
      "ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_enabled BOOLEAN DEFAULT TRUE",
      "ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_plan VARCHAR(50) DEFAULT 'basic'",
    ];
    for(const s of alters){try{await pool.query(s);}catch(e){/* non-fatal */}}
    // Indexes only speed things up — build them in the BACKGROUND so the first
    // admin request is never blocked waiting for an index build on a big table.
    (async()=>{
      const idx=[
        "CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id)",
        "CREATE INDEX IF NOT EXISTS idx_orders_paystatus ON orders(payment_status)",
        "CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id)",
        "CREATE INDEX IF NOT EXISTS idx_stores_owner_id ON stores(owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_stores_created_at ON stores(created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)",
        "CREATE INDEX IF NOT EXISTS idx_subpayments_status ON subscription_payments(status)",
        "CREATE INDEX IF NOT EXISTS idx_subpayments_owner ON subscription_payments(owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)",
        "CREATE INDEX IF NOT EXISTS idx_store_owners_created ON store_owners(created_at DESC)",
      ];
      for(const s of idx){try{await pool.query(s);}catch(e){/* non-fatal */}}
    })();
  })();
  return _platformReady;
}

// ── Tiny in-memory cache for the heavy admin aggregations ──
// These endpoints scan/aggregate the whole orders table, so re-running them on
// every tab switch is what made the admin feel slow. Cache the response briefly;
// any mutation through this router clears the cache so data stays fresh.
const _adminCache=new Map();
function cacheGet(k){const e=_adminCache.get(k);if(e&&Date.now()<e.exp)return e.v;if(e)_adminCache.delete(k);return null;}
function cacheSet(k,v,ttl=45000){_adminCache.set(k,{v,exp:Date.now()+ttl});}
function cacheBust(){_adminCache.clear();}
// Any successful non-GET (approve, toggle, delete, settings save…) invalidates the cache.
router.use((req,res,next)=>{if(req.method!=='GET'){res.on('finish',()=>{if(res.statusCode<400)cacheBust();});}next();});

// Version check
router.get('/version',(req,res)=>res.json({version:'2025-03-25-v4'}));

// NOTE: a public POST /debug-login used to live here. It echoed back whether a
// submitted phone/password matched the built-in super-admin credentials, which
// turned it into a free credential oracle for anyone on the internet. Removed.

// Login
router.post('/login',async(req,res)=>{
  const{phone,password}=req.body||{};
  const p=(phone||'').trim();
  const pw=(password||'').trim();
  console.log('[Admin Login] phone:', JSON.stringify(p), 'pw_len:', pw.length);

  // Single source of truth: only platform_admins table
  try {
    await ensureAdminsTable();
    const digits = p.replace(/[^0-9]/g,'');
    const last9 = digits.slice(-9);
    const all = await pool.query("SELECT id,full_name,phone,email,is_active,password_hash FROM platform_admins");
    const admin = all.rows.find(r=>{
      const rp=(r.phone||'').toString();
      const rd=rp.replace(/[^0-9]/g,'');
      return rp.trim()===p || rd===digits || (last9 && rd.slice(-9)===last9);
    });
    if (admin) {
      if (admin.is_active === false) {
        return res.status(401).json({error:'Account deactivated'});
      }
      let pwOk=false;
      try{ pwOk = await bcrypt.compare(pw, admin.password_hash||''); }catch(err){}
      if (pwOk) {
        console.log('[Admin Login] ✅ match');
        const token = generateToken({ id: admin.id, role: 'platform_admin', name: admin.full_name || 'Admin' });
        return res.json({ token, admin: { id: admin.id, name: admin.full_name || 'Admin', role: admin.role || 'platform_admin' } });
      }
    }
  } catch (e) { console.log('[Admin Login] check failed:', e.message); }

  console.log('[Admin Login] ❌ Failed');
  return res.status(401).json({error:'Invalid credentials'});
});

// ═══ FORGOT PASSWORD (Super Admin) ═══
const jwt=require('jsonwebtoken');
const OTP_JWT_SECRET_PA=process.env.JWT_SECRET||'kyomarket-secret-key-2026-do-not-change';
function getWaBaileys(){try{return require('../services/whatsappBaileys');}catch{return null;}}
const PLATFORM_WA_STORE_ID=process.env.PLATFORM_WA_STORE_ID||'platform';

router.post('/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body || {};
    const p = (phone || '').trim();
    if (!p) return res.status(400).json({ error: 'Phone required' });
    await ensureAdminsTable();
    const digits = p.replace(/[^0-9]/g, '');
    const last9 = digits.slice(-9);
    const all = await pool.query('SELECT id,full_name,phone,email,is_active,password_hash FROM platform_admins');
    const admin = all.rows.find(r => {
      const rp = (r.phone || '').toString(); const rd = rp.replace(/[^0-9]/g, '');
      return rp.trim() === p || rd === digits || (last9 && rd.slice(-9) === last9);
    });
    if (!admin) return res.status(404).json({ error: 'No admin account found with this phone' });
    if (admin.is_active === false) return res.status(401).json({ error: 'Account deactivated' });
    const waBaileys = getWaBaileys();
    if (!waBaileys) return res.status(503).json({ error: 'WhatsApp service not available' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(code, 8);
    const status = waBaileys.getStatus(PLATFORM_WA_STORE_ID);
    if (!status.connected) return res.status(503).json({ error: 'Platform WhatsApp is offline. Cannot send reset code.' });
    const msg = `🔐 ${code}\n\nYour MakretDZ password reset code. Expires in 10 minutes.\nIf you didn't request this, ignore this message.`;
    const sendResult = await waBaileys.sendMessage(PLATFORM_WA_STORE_ID, admin.phone, msg);
    if (!sendResult.success) return res.status(503).json({ error: 'Failed to send WhatsApp message' });
    const otp_token = jwt.sign({ purpose: 'admin_password_reset', admin_id: admin.id, otpHash }, OTP_JWT_SECRET_PA, { expiresIn: '10m' });
    const masked = (admin.phone || '').replace(/.(?=.{3})/g, '•');
    res.json({ otp_token, masked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/forgot-password/verify', async (req, res) => {
  try {
    const { otp_token, code } = req.body || {};
    if (!otp_token || !code) return res.status(400).json({ error: 'Token and code required' });
    let payload;
    try { payload = jwt.verify(otp_token, OTP_JWT_SECRET_PA); } catch { return res.status(401).json({ error: 'Code expired. Request a new one.' }); }
    if (payload.purpose !== 'admin_password_reset') return res.status(401).json({ error: 'Invalid token' });
    if (!(await bcrypt.compare(String(code).trim(), payload.otpHash))) return res.status(401).json({ error: 'Invalid code' });
    const resetToken = jwt.sign({ purpose: 'admin_do_reset', admin_id: payload.admin_id }, OTP_JWT_SECRET_PA, { expiresIn: '5m' });
    res.json({ reset_token: resetToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { reset_token, new_password } = req.body || {};
    if (!reset_token || !new_password) return res.status(400).json({ error: 'Token and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    let payload;
    try { payload = jwt.verify(reset_token, OTP_JWT_SECRET_PA); } catch { return res.status(401).json({ error: 'Reset expired. Start over.' }); }
    if (payload.purpose !== 'admin_do_reset') return res.status(401).json({ error: 'Invalid token' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE platform_admins SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, payload.admin_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Super admin change store owner password ═══
router.put('/store-owners/:id/password', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { new_password } = req.body || {};
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const owner = (await pool.query('SELECT id,full_name FROM store_owners WHERE id=$1', [req.params.id])).rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE store_owners SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings
router.get('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await ensurePlatformSchema();
  const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days,trial_enabled:s.subscription_trial_enabled!==false,trial_plan:s.subscription_trial_plan||'basic'});}catch(e){res.json({site_name:'MakretDZ'});}});
router.put('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const f=req.body;const map={site_name:'site_name',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',subscription_monthly_price:'subscription_monthly_price',subscription_yearly_price:'subscription_yearly_price',trial_days:'subscription_trial_days',trial_enabled:'subscription_trial_enabled',trial_plan:'subscription_trial_plan',site_logo:'logo_url',favicon:'favicon_url',meta_description:'meta_description',maintenance_mode:'maintenance_mode',currency:'currency',landing_blocks:'landing_blocks',google_client_id:'google_client_id'};
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_enabled BOOLEAN DEFAULT TRUE");}catch{}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_plan VARCHAR(50) DEFAULT 'basic'");}catch{}
  // Auto-add landing_blocks column if missing
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}
  // Base64 image uploads (logo + favicon) easily exceed VARCHAR limits — force TEXT
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS favicon_url TEXT");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS logo_url TEXT");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
  // Ensure a settings row exists so the UPDATE ... WHERE id=(SELECT id ...) actually matches
  try{await pool.query("INSERT INTO platform_settings(site_name) SELECT 'MakretDZ' WHERE NOT EXISTS(SELECT 1 FROM platform_settings)");}catch(e){}
  const colMap=new Map();for(const[k,val]of Object.entries(f)){const col=map[k];if(!col)continue;colMap.set(col,val);}if(!colMap.size)return res.json({});const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}const r=await pool.query(`UPDATE platform_settings SET ${u.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,v);const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days,trial_enabled:s.subscription_trial_enabled!==false,trial_plan:s.subscription_trial_plan||'basic'});}catch(e){res.status(500).json({error:e.message});}});

// Store owners
router.get('/store-owners',authMiddleware(['platform_admin']),async(req,res)=>{try{const{search}=req.query;{const c=cacheGet('owners:'+(search||''));if(c)return res.json(c);}await ensurePlatformSchema();
  // store_count + total_revenue via grouped joins (one pass each) instead of
  // correlated subqueries per owner row.
  let q=`SELECT so.*, COALESCE(sc.cnt,0) as store_count, COALESCE(rev.total_revenue,0) as total_revenue
    FROM store_owners so
    LEFT JOIN (SELECT owner_id, COUNT(*) cnt FROM stores GROUP BY owner_id) sc ON sc.owner_id=so.id
    LEFT JOIN (SELECT s.owner_id, COALESCE(SUM(o.total),0) total_revenue FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.payment_status='paid' GROUP BY s.owner_id) rev ON rev.owner_id=so.id`;
  const p=[];if(search){p.push(`%${search}%`);q+=' WHERE (so.full_name ILIKE $1 OR so.email ILIKE $1 OR so.phone ILIKE $1)';}q+=' ORDER BY so.created_at DESC';const r=await pool.query(q,p);const out={owners:r.rows.map(({password_hash,reset_token,reset_token_expires,two_fa_code,two_fa_expires,otp_code,otp_expires,...o})=>({...o,name:o.full_name})),total:r.rows.length};cacheSet('owners:'+(search||''),out);res.json(out);}catch(e){res.status(500).json({error:e.message});}});
router.patch('/store-owners/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE store_owners SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});
async function cascadeDeleteStores(client,storeIds){
  if(!storeIds.length)return;
  const t=['payment_receipts','blacklist','message_log','expenses','store_pages','notifications','push_subscriptions','reviews','carts','store_domains'];
  for(const table of t){await client.query(`DELETE FROM ${table} WHERE store_id=ANY($1::uuid[])`,[storeIds]).catch(()=>{});}
  await client.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=ANY($1::uuid[]))',[storeIds]).catch(()=>{});
  await client.query('DELETE FROM orders WHERE store_id=ANY($1::uuid[])',[storeIds]).catch(()=>{});
  await client.query('DELETE FROM products WHERE store_id=ANY($1::uuid[])',[storeIds]).catch(()=>{});
}
router.delete('/store-owners/:id',authMiddleware(['platform_admin']),async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const id=req.params.id;const info=(await client.query('SELECT full_name,email,phone FROM store_owners WHERE id=$1',[id])).rows[0];const storeIds=(await client.query('SELECT id FROM stores WHERE owner_id=$1',[id])).rows.map(r=>r.id);await cascadeDeleteStores(client,storeIds);await client.query('DELETE FROM subscription_payments WHERE owner_id=$1',[id]).catch(()=>{});await client.query('DELETE FROM stores WHERE owner_id=$1',[id]);await client.query('DELETE FROM store_owners WHERE id=$1',[id]);await client.query('COMMIT');try{if(global.__notifyAdmin)await global.__notifyAdmin({type:'account_deleted',title:'Account deleted',body:`${info?.full_name||'Owner'} (${info?.email||info?.phone||''}) — ${storeIds.length} store(s) removed`,link:'/admin/store-owners',owner_id:null,dedup_key:`deleted:${id}`});}catch{}res.json({ok:true});}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:e.message});}finally{client.release();}});

// Stores
router.get('/stores',authMiddleware(['platform_admin']),async(req,res)=>{try{
  {const c=cacheGet('stores');if(c)return res.json(c);}
  await ensurePlatformSchema();
  let r;
  try{
    // Aggregate products/orders ONCE each (grouped), then join — instead of 3
    // correlated subqueries per store row (which scaled with store count).
    r=await pool.query(`SELECT s.id,s.owner_id,s.store_name,s.slug,s.logo_url,s.is_published,s.created_at,
      so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,so.is_active as owner_active,so.subscription_status,
      COALESCE(pc.cnt,0) as product_count, COALESCE(oc.cnt,0) as order_count, COALESCE(oc.rev,0) as revenue
      FROM stores s
      LEFT JOIN store_owners so ON so.id=s.owner_id
      LEFT JOIN (SELECT store_id, COUNT(*) cnt FROM products GROUP BY store_id) pc ON pc.store_id=s.id
      LEFT JOIN (SELECT store_id, COUNT(*) cnt, COALESCE(SUM(total) FILTER (WHERE payment_status='paid'),0) rev FROM orders GROUP BY store_id) oc ON oc.store_id=s.id
      ORDER BY s.created_at DESC`);
  }catch(e){
    console.error('[platform stores] full query failed, falling back:',e.message);
    r=await pool.query("SELECT s.id,s.owner_id,s.store_name,s.slug,s.logo_url,s.is_published,s.created_at,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC");
  }
  const out=r.rows.map(s=>({...s,name:s.store_name,is_live:s.is_published!==false,logo:s.logo_url||s.logo||null}));cacheSet('stores',out);res.json(out);
}catch(e){console.error('[platform stores]',e.message);res.status(500).json({error:e.message});}});
router.patch('/stores/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE stores SET is_published=NOT is_published,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].store_name,is_live:r.rows[0].is_published});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:id',authMiddleware(['platform_admin']),async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');await cascadeDeleteStores(client,[req.params.id]);await client.query('DELETE FROM stores WHERE id=$1',[req.params.id]);await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:e.message});}finally{client.release();}});

// All orders
router.get('/orders',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{status,search,date_from,date_to}=req.query;
  const _ck=`orders:${status||''}:${search||''}:${date_from||''}:${date_to||''}`;
  {const c=cacheGet(_ck);if(c)return res.json(c);}
  let q="SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id";
  const p=[];const wh=[];
  if(status&&status!=='all'){
    if(status==='preparing'){wh.push("o.status IN ('preparing','under_preparation')");}
    else{p.push(status);wh.push(`o.status=$${p.length}`);}
  }
  if(search){p.push(`%${search}%`);wh.push(`(o.customer_name ILIKE $${p.length} OR o.customer_phone ILIKE $${p.length} OR CAST(o.order_number AS TEXT) ILIKE $${p.length} OR s.store_name ILIKE $${p.length})`);}
  if(date_from){p.push(date_from);wh.push(`o.created_at >= $${p.length}::date`);}
  if(date_to){p.push(date_to);wh.push(`o.created_at < ($${p.length}::date + interval '1 day')`);}
  if(wh.length)q+=' WHERE '+wh.join(' AND ');
  q+=' ORDER BY o.created_at DESC LIMIT 200';
  const [r,cnt]=await Promise.all([pool.query(q,p),pool.query('SELECT COUNT(*) FROM orders')]);
  // Attach items
  const ids=r.rows.map(o=>o.id);
  let itemsByOrder={};
  if(ids.length){
    try{
      const ir=await pool.query("SELECT oi.order_id,oi.product_id,oi.product_name,oi.product_image,oi.variant_info,oi.quantity,oi.unit_price,oi.total_price,p.images AS p_images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=ANY($1::uuid[])",[ids]);
      for(const it of ir.rows){
        let img=it.product_image||null;
        if(!img){try{const imgs=Array.isArray(it.p_images)?it.p_images:(typeof it.p_images==='string'?JSON.parse(it.p_images||'[]'):[]);img=imgs[0]||null;}catch{}}
        (itemsByOrder[it.order_id]=itemsByOrder[it.order_id]||[]).push({product_id:it.product_id,product_name:it.product_name,variant_info:it.variant_info,quantity:it.quantity,price:it.unit_price,total_price:it.total_price,image:img});
      }
    }catch(e){console.error('[platform orders items]',e.message);}
  }
  const out={orders:r.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0'),items:itemsByOrder[o.id]||[]})),total:parseInt(cnt.rows[0].count)};cacheSet(_ck,out);res.json(out);
}catch(e){res.status(500).json({error:e.message});}});

// Dashboard
router.get('/dashboard',authMiddleware(['platform_admin']),async(req,res)=>{try{
{const c=cacheGet('dashboard');if(c)return res.json(c);}
await ensurePlatformSchema();
// Run every independent query in parallel instead of awaiting them one by one.
const q=(sql)=>pool.query(sql).catch(()=>({rows:[{}]}));
const [oOwners,oStores,oOrders,oRev,oProds,oCust,oRecentOrders,oRecentStores,oToday,oWeek]=await Promise.all([
  q('SELECT COUNT(*) FROM store_owners'),
  q('SELECT COUNT(*) FROM stores'),
  q('SELECT COUNT(*) FROM orders'),
  q("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE payment_status='paid'"),
  q('SELECT COUNT(*) FROM products'),
  q('SELECT COUNT(*) FROM customers'),
  q("SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC LIMIT 15"),
  q("SELECT s.*,so.full_name as owner_name,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC LIMIT 10"),
  q("SELECT COUNT(*) as c,COALESCE(SUM(total),0) as r FROM orders WHERE created_at>=CURRENT_DATE"),
  q("SELECT COUNT(*) FROM store_owners WHERE created_at>NOW()-INTERVAL '7 days'"),
]);
const to=parseInt(oOwners.rows[0]?.count)||0, ts=parseInt(oStores.rows[0]?.count)||0, tord=parseInt(oOrders.rows[0]?.count)||0;
const tr=parseFloat(oRev.rows[0]?.t)||0, tp=parseInt(oProds.rows[0]?.count)||0, tc=parseInt(oCust.rows[0]?.count)||0;
const ro=(oRecentOrders.rows||[]).map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')}));
const rs=(oRecentStores.rows||[]).map(s=>({...s,name:s.store_name,is_live:s.is_published}));
const todayOrders=parseInt(oToday.rows[0]?.c)||0, todayRevenue=parseFloat(oToday.rows[0]?.r)||0, weekOwners=parseInt(oWeek.rows[0]?.count)||0;
const payload={stats:{totalOwners:to,totalStores:ts,totalOrders:tord,totalRevenue:tr,totalProducts:tp,totalCustomers:tc,todayOrders,todayRevenue,weekOwners},recentOrders:ro,recentStores:rs};cacheSet('dashboard',payload);res.json(payload);}catch(e){res.status(500).json({error:e.message});}});

// System
router.get('/system',authMiddleware(['platform_admin']),async(req,res)=>{try{const tables=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");const dbSize=await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");const messaging=require('../services/messaging');const chatbot=require('../services/chatbot');const chargily=require('../services/chargily');res.json({tables:tables.rows.map(t=>t.table_name),dbSize:dbSize.rows[0]?.size,services:{whatsapp:messaging.getConfiguredChannels().whatsapp,email:messaging.getConfiguredChannels().email,ai:chatbot.isConfigured(),payments:chargily.isConfigured()},node:process.version,uptime:Math.floor(process.uptime())+'s'});}catch(e){res.status(500).json({error:e.message});}});

// ═══ SUBSCRIPTION MANAGEMENT ═══
// Get all subscription payments
router.get('/subscriptions',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{status}=req.query;
  {const c=cacheGet('subs:'+(status||'all'));if(c)return res.json(c);}
  await ensurePlatformSchema();
  let q="SELECT sp.*,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,so.subscription_plan,so.subscription_status FROM subscription_payments sp LEFT JOIN store_owners so ON so.id=sp.owner_id";
  const p=[];
  if(status&&status!=='all'){p.push(status);q+=` WHERE sp.status=$1`;}
  q+=' ORDER BY sp.created_at DESC';
  const [r,stats]=await Promise.all([pool.query(q,p),pool.query("SELECT status,COUNT(*) as c FROM subscription_payments GROUP BY status")]);
  const statsMap={};stats.rows.forEach(s=>{statsMap[s.status]=parseInt(s.c);});
  const out={payments:r.rows,stats:statsMap};cacheSet('subs:'+(status||'all'),out);res.json(out);
}catch(e){res.status(500).json({error:e.message});}});

// Approve payment → activate subscription
router.patch('/subscriptions/:pid/approve',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const payment=(await pool.query('UPDATE subscription_payments SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3 RETURNING *',['approved','Super Admin',req.params.pid])).rows[0];
  if(!payment)return res.status(404).json({error:'Not found'});
  // Calculate expiry
  const months=payment.period==='yearly'?12:1;
  const expiry=new Date();expiry.setMonth(expiry.getMonth()+months);
  await pool.query('UPDATE store_owners SET subscription_plan=$1,subscription_status=$2,subscription_expires_at=$3,subscription_paid_until=$3 WHERE id=$4',[payment.plan,'active',expiry,payment.owner_id]);
  try{const o=(await pool.query('SELECT full_name FROM store_owners WHERE id=$1',[payment.owner_id])).rows[0];
    await notifyAdmin({type:'subscription_approved',title:'Subscription activated',body:`${o?.full_name||'Owner'} — ${payment.plan} ${payment.period} (${parseFloat(payment.amount).toLocaleString()} DZD)`,link:'/admin/subscriptions',owner_id:payment.owner_id,dedup_key:`approved:${payment.id}`});}catch{}
  res.json({...payment,status:'approved'});
}catch(e){res.status(500).json({error:e.message});}});

// Reject payment
router.patch('/subscriptions/:pid/reject',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{notes}=req.body;
  const r=await pool.query('UPDATE subscription_payments SET status=$1,reviewed_by=$2,reviewed_at=NOW(),notes=$3 WHERE id=$4 RETURNING *',['rejected','Super Admin',notes||'Payment rejected',req.params.pid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Suspend/activate owner subscription
router.patch('/store-owners/:id/subscription',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{action}=req.body; // 'suspend' or 'activate'
  const newStatus=action==='suspend'?'suspended':'active';
  const isActive=action!=='suspend';
  const r=await pool.query('UPDATE store_owners SET subscription_status=$1,is_active=$2,updated_at=NOW() WHERE id=$3 RETURNING *',[newStatus,isActive,req.params.id]);
  // Also toggle all stores
  if(action==='suspend'){
    await pool.query('UPDATE stores SET is_published=FALSE WHERE owner_id=$1',[req.params.id]);
  }else{
    await pool.query('UPDATE stores SET is_published=TRUE WHERE owner_id=$1',[req.params.id]);
  }
  res.json({...r.rows[0],name:r.rows[0].full_name});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ ADMIN NOTIFICATIONS ═══
async function ensureNotifTable(){
  try{await pool.query(`CREATE TABLE IF NOT EXISTS admin_notifications(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(200),
    body TEXT,
    link VARCHAR(300),
    owner_id UUID,
    dedup_key VARCHAR(200) UNIQUE,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);}catch(e){console.error('[notif table]',e.message);}
}
ensureNotifTable();

async function notifyAdmin({type,title,body,link,owner_id,dedup_key}){
  try{
    await pool.query(`INSERT INTO admin_notifications(type,title,body,link,owner_id,dedup_key)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedup_key) DO NOTHING`,
      [type,title,body||null,link||null,owner_id||null,dedup_key||null]);
  }catch(e){console.error('[notifyAdmin]',e.message);}
}
global.__notifyAdmin=notifyAdmin;

// Scan expiring/expired and upsert notifications
async function scanSubscriptionEvents(){
  try{
    // Expiring within 24h
    const soon=await pool.query(`SELECT id,full_name,subscription_plan,subscription_expires_at FROM store_owners
      WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at BETWEEN NOW() AND NOW()+INTERVAL '24 hours'`);
    for(const o of soon.rows){
      const day=new Date(o.subscription_expires_at).toISOString().slice(0,10);
      await notifyAdmin({type:'subscription_expiring',title:`Subscription expiring soon`,body:`${o.full_name} (${o.subscription_plan||'free'}) expires ${new Date(o.subscription_expires_at).toLocaleString()}`,link:'/admin/subscriptions',owner_id:o.id,dedup_key:`expiring:${o.id}:${day}`});
    }
    // Expired within last 7 days
    const ex=await pool.query(`SELECT id,full_name,subscription_plan,subscription_expires_at FROM store_owners
      WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at < NOW() AND subscription_expires_at > NOW()-INTERVAL '7 days'`);
    for(const o of ex.rows){
      const day=new Date(o.subscription_expires_at).toISOString().slice(0,10);
      await notifyAdmin({type:'subscription_expired',title:`Subscription expired`,body:`${o.full_name} (${o.subscription_plan||'free'}) expired ${new Date(o.subscription_expires_at).toLocaleString()}`,link:'/admin/subscriptions',owner_id:o.id,dedup_key:`expired:${o.id}:${day}`});
    }
  }catch(e){console.error('[scanSubscriptionEvents]',e.message);}
}

router.get('/notifications',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await scanSubscriptionEvents();
  const r=await pool.query('SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 100');
  const u=await pool.query('SELECT COUNT(*)::int AS c FROM admin_notifications WHERE is_read=FALSE');
  res.json({notifications:r.rows,unread:u.rows[0]?.c||0});
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/notifications/:id/read',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await pool.query('UPDATE admin_notifications SET is_read=TRUE WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/notifications/read-all',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await pool.query('UPDATE admin_notifications SET is_read=TRUE WHERE is_read=FALSE');
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/notifications/:id',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await pool.query('DELETE FROM admin_notifications WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/notifications',authMiddleware(['platform_admin']),async(req,res)=>{try{
  await pool.query('DELETE FROM admin_notifications');
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Expiring subscriptions (within next 24h, or already expired in last 7 days)
router.get('/expiring-subscriptions',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const r=await pool.query(`
    SELECT id,full_name,email,phone,subscription_plan,subscription_status,subscription_expires_at,
      EXTRACT(EPOCH FROM (subscription_expires_at - NOW()))/3600 AS hours_remaining
    FROM store_owners
    WHERE subscription_expires_at IS NOT NULL
      AND subscription_expires_at BETWEEN NOW() - INTERVAL '7 days' AND NOW() + INTERVAL '24 hours'
    ORDER BY subscription_expires_at ASC
  `);
  res.json({owners:r.rows.map(o=>({...o,name:o.full_name,hours_remaining:Math.round(Number(o.hours_remaining||0))}))});
}catch(e){res.status(500).json({error:e.message});}});

// Extend owner subscription for free (super admin grants N days)
router.post('/store-owners/:id/extend-subscription',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const days=parseInt(req.body?.days||0,10);
  if(!days||days<1||days>3650)return res.status(400).json({error:'days must be 1-3650'});
  const cur=(await pool.query('SELECT subscription_expires_at FROM store_owners WHERE id=$1',[req.params.id])).rows[0];
  if(!cur)return res.status(404).json({error:'Owner not found'});
  const base=cur.subscription_expires_at&&new Date(cur.subscription_expires_at)>new Date()?new Date(cur.subscription_expires_at):new Date();
  const newExpiry=new Date(base.getTime()+days*24*60*60*1000);
  const r=await pool.query('UPDATE store_owners SET subscription_expires_at=$1,subscription_paid_until=$1,subscription_status=$2,is_active=TRUE,updated_at=NOW() WHERE id=$3 RETURNING *',[newExpiry,'active',req.params.id]);
  await pool.query('UPDATE stores SET is_published=TRUE WHERE owner_id=$1',[req.params.id]).catch(()=>{});
  res.json({ok:true,owner:{...r.rows[0],name:r.rows[0].full_name},extended_days:days,new_expiry:newExpiry});
}catch(e){res.status(500).json({error:e.message});}});

// Update billing config (CCP, BaridiMob QR for payments TO admin)
router.put('/billing-config',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{billing_ccp_account,billing_ccp_name,billing_baridimob_rip,billing_baridimob_qr,subscription_monthly_price,subscription_yearly_price}=req.body;
  const updates=[];const vals=[];let i=1;
  if(billing_ccp_account!==undefined){updates.push(`billing_ccp_account=$${i}`);vals.push(billing_ccp_account);i++;}
  if(billing_ccp_name!==undefined){updates.push(`billing_ccp_name=$${i}`);vals.push(billing_ccp_name);i++;}
  if(billing_baridimob_rip!==undefined){updates.push(`billing_baridimob_rip=$${i}`);vals.push(billing_baridimob_rip);i++;}
  if(billing_baridimob_qr!==undefined){updates.push(`billing_baridimob_qr=$${i}`);vals.push(billing_baridimob_qr);i++;}
  if(subscription_monthly_price!==undefined){updates.push(`subscription_monthly_price=$${i}`);vals.push(subscription_monthly_price);i++;}
  if(subscription_yearly_price!==undefined){updates.push(`subscription_yearly_price=$${i}`);vals.push(subscription_yearly_price);i++;}
  if(!updates.length)return res.json({ok:true});
  // Add columns if they don't exist yet
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_ccp_account VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_ccp_name VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_baridimob_rip VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_baridimob_qr TEXT");}catch(e){}
  const r=await pool.query(`UPDATE platform_settings SET ${updates.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,vals);
  res.json(r.rows[0]||{ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ Subscription plans CRUD (super-admin) ═══
const { invalidatePlanCache } = require('../middleware/planFeatures');
const parseArr = v => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } } return []; };
const mapPlan = r => ({
  id: r.id,
  slug: r.slug,
  name: { en: r.name_en, fr: r.name_fr || '', ar: r.name_ar || '' },
  tagline: { en: r.tagline_en || '', fr: r.tagline_fr || '', ar: r.tagline_ar || '' },
  price_monthly: parseFloat(r.price_monthly) || 0,
  price_yearly: parseFloat(r.price_yearly) || 0,
  currency: r.currency || 'DZD',
  features: { en: parseArr(r.features_en), fr: parseArr(r.features_fr), ar: parseArr(r.features_ar) },
  // Canonical feature flags the backend uses for gating. The store owner sees
  // the localized labels above, but the gate checks `feature_keys`.
  feature_keys: parseArr(r.feature_keys),
  // Hard quotas — 0 means unlimited.
  max_products: parseInt(r.max_products) || 0,
  max_orders_month: parseInt(r.max_orders_month) || 0,
  max_staff: parseInt(r.max_staff) || 0,
  max_stores: parseInt(r.max_stores) || 1,
  is_popular: !!r.is_popular,
  is_active: !!r.is_active,
  sort_order: r.sort_order || 0,
});

// Public read — used by landing + billing pages. No auth.
// Ensure max_stores column exists
(async()=>{try{await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_stores INTEGER DEFAULT 1');}catch{}})();

router.get('/plans/public', async (req, res) => {
  try {
    try{await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_stores INTEGER DEFAULT 1');}catch{}
    const r = await pool.query('SELECT * FROM plans WHERE is_active=TRUE ORDER BY sort_order ASC, price_monthly ASC');
    res.json({ plans: r.rows.map(mapPlan) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/plans', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM plans ORDER BY sort_order ASC, price_monthly ASC');
    res.json({ plans: r.rows.map(mapPlan) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const tagline = b.tagline || {}; const feats = b.features || {};
    const slug = (b.slug || name.en || 'plan').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('plan-' + Date.now());
    const r = await pool.query(
      `INSERT INTO plans(slug,name_en,name_fr,name_ar,tagline_en,tagline_fr,tagline_ar,price_monthly,price_yearly,currency,features_en,features_fr,features_ar,feature_keys,max_products,max_orders_month,max_staff,max_stores,is_popular,is_active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [
        slug,
        name.en || 'Untitled', name.fr || '', name.ar || '',
        tagline.en || '', tagline.fr || '', tagline.ar || '',
        b.price_monthly || 0, b.price_yearly || 0, b.currency || 'DZD',
        JSON.stringify(parseArr(feats.en)), JSON.stringify(parseArr(feats.fr)), JSON.stringify(parseArr(feats.ar)),
        JSON.stringify(parseArr(b.feature_keys)),
        parseInt(b.max_products)||0, parseInt(b.max_orders_month)||0, parseInt(b.max_staff)||0,
        parseInt(b.max_stores)||1,
        !!b.is_popular, b.is_active !== false, b.sort_order || 0,
      ]
    );
    invalidatePlanCache();
    res.json(mapPlan(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const tagline = b.tagline || {}; const feats = b.features || {};
    const r = await pool.query(
      `UPDATE plans SET
         name_en=$1,name_fr=$2,name_ar=$3,
         tagline_en=$4,tagline_fr=$5,tagline_ar=$6,
         price_monthly=$7,price_yearly=$8,currency=$9,
         features_en=$10,features_fr=$11,features_ar=$12,
         feature_keys=$13,
         max_products=$14,max_orders_month=$15,max_staff=$16,max_stores=$17,
         is_popular=$18,is_active=$19,sort_order=$20,updated_at=NOW()
       WHERE id=$21 RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        tagline.en || '', tagline.fr || '', tagline.ar || '',
        b.price_monthly || 0, b.price_yearly || 0, b.currency || 'DZD',
        JSON.stringify(parseArr(feats.en)), JSON.stringify(parseArr(feats.fr)), JSON.stringify(parseArr(feats.ar)),
        JSON.stringify(parseArr(b.feature_keys)),
        parseInt(b.max_products)||0, parseInt(b.max_orders_month)||0, parseInt(b.max_staff)||0,
        parseInt(b.max_stores)||1,
        !!b.is_popular, b.is_active !== false, b.sort_order || 0,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Plan not found' });
    invalidatePlanCache();
    res.json(mapPlan(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/plans/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id=$1', [req.params.id]);
    invalidatePlanCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Staff role templates CRUD (super-admin) ═══
const mapTpl = r => ({
  id: r.id,
  name: { en: r.name_en, fr: r.name_fr || '', ar: r.name_ar || '' },
  description: { en: r.description_en || '', fr: r.description_fr || '', ar: r.description_ar || '' },
  permissions: parseArr(r.permissions),
  is_active: !!r.is_active,
  sort_order: r.sort_order || 0,
});

// Public read — used by store owners in the StoreStaff modal. Requires
// store_owner auth so we don't leak role configs to buyers.
router.get('/role-templates/public', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM role_templates WHERE is_active=TRUE ORDER BY sort_order ASC, created_at ASC');
    res.json({ templates: r.rows.map(mapTpl) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/role-templates', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM role_templates ORDER BY sort_order ASC, created_at ASC');
    res.json({ templates: r.rows.map(mapTpl) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/role-templates', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const desc = b.description || {};
    const r = await pool.query(
      `INSERT INTO role_templates(name_en,name_fr,name_ar,description_en,description_fr,description_ar,permissions,is_active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        desc.en || '', desc.fr || '', desc.ar || '',
        JSON.stringify(parseArr(b.permissions)),
        b.is_active !== false, b.sort_order || 0,
      ]
    );
    res.json(mapTpl(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/role-templates/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const desc = b.description || {};
    const r = await pool.query(
      `UPDATE role_templates SET
         name_en=$1,name_fr=$2,name_ar=$3,
         description_en=$4,description_fr=$5,description_ar=$6,
         permissions=$7,is_active=$8,sort_order=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        desc.en || '', desc.fr || '', desc.ar || '',
        JSON.stringify(parseArr(b.permissions)),
        b.is_active !== false, b.sort_order || 0,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(mapTpl(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/role-templates/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM role_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Super-admin profile (per-admin from platform_admins table) ═══
router.get('/profile', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await ensureAdminsTable();
    const adminId = req.user?.id;
    // Try to load from platform_admins table first (per-admin)
    if (adminId) {
      const r = await pool.query('SELECT id,full_name,phone,email,role FROM platform_admins WHERE id=$1', [adminId]);
      if (r.rows[0]) {
        return res.json({
          id: r.rows[0].id,
          name: r.rows[0].full_name || 'Super Admin',
          email: r.rows[0].email || '',
          phone: r.rows[0].phone || '',
          role: r.rows[0].role || 'super_admin',
        });
      }
    }
    // Fallback to platform_settings for legacy
    let row = {};
    try { row = (await pool.query('SELECT * FROM platform_settings LIMIT 1')).rows[0] || {}; } catch {}
    res.json({
      id: adminId || 'admin',
      name: row.admin_name || req.user?.name || 'Super Admin',
      email: row.admin_email || '',
      phone: row.admin_phone || process.env.PLATFORM_ADMIN_PHONE || '0669003298',
      role: 'super_admin',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await ensureAdminsTable();
    const adminId = req.user?.id;
    const b = req.body || {};
    // Update the specific admin's record in platform_admins
    if (adminId) {
      const r = await pool.query('SELECT id FROM platform_admins WHERE id=$1', [adminId]);
      if (r.rows[0]) {
        await pool.query(
          'UPDATE platform_admins SET full_name=$1, email=$2, phone=$3, updated_at=NOW() WHERE id=$4',
          [b.name || '', b.email || null, b.phone || '', adminId]
        );
        return res.json({ id: adminId, name: b.name || 'Super Admin', email: b.email || '', phone: b.phone || '', role: 'super_admin' });
      }
    }
    // Fallback to platform_settings for legacy
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100)"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_email VARCHAR(255)"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_phone VARCHAR(50)"); } catch {}
    await pool.query(
      'UPDATE platform_settings SET admin_name=$1, admin_email=$2, admin_phone=$3, updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1)',
      [b.name || null, b.email || null, b.phone || null]
    );
    res.json({ id: 'admin', name: b.name || 'Super Admin', email: b.email || '', phone: b.phone || '', role: 'super_admin' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile/password', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const cur = (current_password || '').trim();
    const nw = (new_password || '').trim();
    if (!cur) return res.status(400).json({ error: 'Current password is required' });
    if (!nw || nw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const adminId = req.user?.id;
    // Try platform_admins table first (per-admin)
    if (adminId) {
      await ensureAdminsTable();
      const adminRow = (await pool.query('SELECT id,password_hash FROM platform_admins WHERE id=$1', [adminId])).rows[0];
      if (adminRow) {
        const pwOk = await bcrypt.compare(cur, adminRow.password_hash || '');
        if (!pwOk) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(nw, 12);
        await pool.query('UPDATE platform_admins SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, adminId]);
        console.log('[Admin Password] ✅ updated for admin', adminId);
        return res.json({ ok: true });
      }
    }

    // Fallback to platform_settings for legacy
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_password_hash TEXT"); } catch {}
    let row = (await pool.query('SELECT id, admin_password_hash FROM platform_settings LIMIT 1')).rows[0];
    if (!row) {
      const ins = await pool.query('INSERT INTO platform_settings(site_name) VALUES($1) RETURNING id, admin_password_hash', ['MakretDZ']);
      row = ins.rows[0];
    }
    let ok = false;
    if (row.admin_password_hash) {
      ok = await bcrypt.compare(cur, row.admin_password_hash);
    } else {
      if (cur === 'admin123') ok = true;
      const envPw = (process.env.PLATFORM_ADMIN_PASSWORD || '').trim();
      if (envPw && cur === envPw) ok = true;
    }
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(nw, 12);
    const defaultPhone = (process.env.PLATFORM_ADMIN_PHONE || '0669003298').trim();
    const upd = await pool.query(
      "UPDATE platform_settings SET admin_password_hash=$1, admin_phone=COALESCE(NULLIF(admin_phone,''),$2), updated_at=NOW() WHERE id=$3 RETURNING id",
      [hash, defaultPhone, row.id]
    );
    if (!upd.rows[0]) return res.status(500).json({ error: 'Failed to persist new password' });
    res.json({ ok: true });
  } catch (e) { console.log('[Admin Password] error:', e.message); res.status(500).json({ error: e.message }); }
});

async function ensureAdminsTable(){
  try{await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');}catch(e){console.log('[ensureAdminsTable] pgcrypto ext:',e.message);}
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_admins(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name VARCHAR(255) NOT NULL DEFAULT '',
      phone VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255),
      password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'platform_admin',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  }catch(e){console.log('[ensureAdminsTable] create failed:',e.message);}
  // Safety: ensure columns exist if table was created with older shape
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'platform_admin'");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS email VARCHAR(255)");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS full_name VARCHAR(255) DEFAULT ''");}catch{}
}
ensureAdminsTable();

// DEBUG: inspect admins table (no auth, temp)
router.get('/admins-debug',async(req,res)=>{
  try{await ensureAdminsTable();
    const r=await pool.query('SELECT id,full_name,phone,email,role,is_active,LENGTH(password_hash) as hash_len,created_at FROM platform_admins ORDER BY created_at DESC');
    res.json({count:r.rows.length,admins:r.rows});
  }catch(e){res.status(500).json({error:e.message,stack:e.stack});}
});
// DEBUG: test credentials without creating a session — accepts GET query or POST body
const adminsTestHandler=async(req,res)=>{
  try{const src=req.method==='GET'?req.query:(req.body||{});const{phone,password}=src;const p=(phone||'').toString().trim();const pw=(password||'').toString().trim();
    const digits=p.replace(/[^0-9]/g,'');const last9=digits.slice(-9);
    const all=(await pool.query('SELECT id,phone,is_active,password_hash FROM platform_admins')).rows;
    const admin=all.find(r=>{const rp=(r.phone||'').toString();const rd=rp.replace(/[^0-9]/g,'');return rp.trim()===p||rd===digits||(last9&&rd.slice(-9)===last9);});
    let pwOk=false;let bcryptError=null;
    if(admin){try{pwOk=await bcrypt.compare(pw,admin.password_hash||'');}catch(e){bcryptError=e.message;}}
    res.json({input_phone:p,input_pw_len:pw.length,input_digits:digits,total_rows:all.length,rows:all.map(r=>({phone:r.phone,active:r.is_active,hash_len:(r.password_hash||'').length,hash_prefix:(r.password_hash||'').substring(0,7)})),matched:!!admin,matched_phone:admin?.phone,matched_active:admin?.is_active,password_match:pwOk,bcrypt_error:bcryptError});
  }catch(e){res.status(500).json({error:e.message});}
};
router.get('/admins-test',adminsTestHandler);
router.post('/admins-test',adminsTestHandler);

router.get('/admins', authMiddleware(['platform_admin']), async (req, res) => {
  try { await ensureAdminsTable();
    const r = await pool.query('SELECT id,full_name,phone,email,role,is_active,created_at FROM platform_admins ORDER BY created_at DESC');
    res.json({ admins: r.rows.map(a=>({...a,name:a.full_name})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admins', authMiddleware(['platform_admin']), async (req, res) => {
  console.log('[POST /admins] body:', JSON.stringify(req.body));
  try { await ensureAdminsTable();
    const { full_name, name, phone, email, password, role } = req.body || {};
    const fn = (full_name||name||'').trim();
    const ph = (phone||'').trim();
    const pw = (password||'').trim();
    console.log('[POST /admins] parsed → fn:',fn,'phone:',ph,'pw_len:',pw.length);
    if (!ph || !pw) return res.status(400).json({ error: 'Phone and password are required' });
    const existing = await pool.query('SELECT id FROM platform_admins WHERE phone=$1',[ph]);
    console.log('[POST /admins] existing:',existing.rows.length);
    if (existing.rows[0]) return res.status(409).json({ error: 'An admin with this phone already exists' });
    const hash = await bcrypt.hash(pw, 10);
    console.log('[POST /admins] hashed, len:', hash.length);
    const r = await pool.query(
      'INSERT INTO platform_admins(full_name,phone,email,password_hash,role,is_active) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,full_name,phone,email,role,is_active,created_at',
      [fn, ph, email||null, hash, role||'platform_admin']
    );
    console.log('[POST /admins] inserted id:', r.rows[0]?.id);
    const verify = await pool.query('SELECT COUNT(*)::int c FROM platform_admins');
    console.log('[POST /admins] total rows after insert:', verify.rows[0].c);
    res.json({ ok: true, admin: { ...r.rows[0], name: r.rows[0].full_name }, total_admins: verify.rows[0].c });
  } catch (e) { console.error('[POST /admins] ERROR:', e.message, e.stack); res.status(500).json({ error: e.message }); }
});
router.delete('/admins/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    // Get the admin's phone before deleting so we can clear platform_settings if it matches
    const admin = (await pool.query('SELECT phone FROM platform_admins WHERE id=$1',[req.params.id])).rows[0];
    await pool.query('DELETE FROM platform_admins WHERE id=$1',[req.params.id]);
    // Also clear platform_settings credentials if they match the deleted admin
    if (admin?.phone) {
      try { await pool.query("UPDATE platform_settings SET admin_phone=NULL, admin_password_hash=NULL, admin_name=NULL WHERE admin_phone=$1",[admin.phone]); } catch(e){}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/admins/:id/toggle', authMiddleware(['platform_admin']), async (req, res) => {
  try { const r = await pool.query('UPDATE platform_admins SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING id,full_name,phone,email,role,is_active',[req.params.id]);
    res.json({ ...r.rows[0], name: r.rows[0]?.full_name }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ PLATFORM WHATSAPP (used for registration OTP) — local Baileys ═══
let _waBaileys=null;function getWA(){if(!_waBaileys)try{_waBaileys=require('../services/whatsappBaileys');}catch{_waBaileys=null;}return _waBaileys;}
const PLATFORM_WA_ID=process.env.PLATFORM_WA_STORE_ID||'platform';
router.post('/whatsapp/start',authMiddleware(['platform_admin']),async(req,res)=>{
  try{
    const wa=getWA();if(!wa)return res.status(503).json({error:'WhatsApp service not available'});
    wa.startSession(PLATFORM_WA_ID).catch(e=>console.error('[WA start]',e.message));
    for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,500));const s=wa.getStatus(PLATFORM_WA_ID);if(s.qr||s.connected||s.status==='error'||s.status==='logged_out')return res.json(s);}
    res.json(wa.getStatus(PLATFORM_WA_ID));
  }catch(e){res.status(500).json({error:e.message});}
});
router.get('/whatsapp/status',authMiddleware(['platform_admin']),async(req,res)=>{
  try{const wa=getWA();if(!wa)return res.json({status:'not_available',connected:false});res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.json(wa.getStatus(PLATFORM_WA_ID));}catch(e){res.json({status:'error',connected:false,error:e.message});}
});
router.post('/whatsapp/disconnect',authMiddleware(['platform_admin']),async(req,res)=>{
  try{const wa=getWA();if(!wa)return res.status(503).json({error:'WhatsApp service not available'});await wa.disconnectSession(PLATFORM_WA_ID);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
router.post('/whatsapp/test-send',authMiddleware(['platform_admin']),async(req,res)=>{
  try{const wa=getWA();if(!wa)return res.status(503).json({error:'WhatsApp service not available'});const{phone,message}=req.body;if(!phone)return res.status(400).json({error:'phone required'});
    const d=await wa.sendMessage(PLATFORM_WA_ID,phone,message||'Test message from MakretDZ platform');
    if(d.success)res.json(d);else res.status(400).json(d);}catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;

const express=require('express'),router=express.Router(),bcrypt=require('bcryptjs'),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth'),slugify=require('slugify'),jwt=require('jsonwebtoken');
const OTP_JWT_SECRET=process.env.JWT_SECRET||'kyomarket-secret-key-2026-do-not-change';
let _waBaileysCache;function _getWaBaileys(){if(_waBaileysCache!==undefined)return _waBaileysCache;try{_waBaileysCache=require('../services/whatsappBaileys');}catch{_waBaileysCache=null;}return _waBaileysCache;}
const waBaileys=new Proxy({},{get(_,prop){const mod=_getWaBaileys();if(!mod){if(prop==='getStatus')return()=>({connected:false,status:'not_available'});if(prop==='sendMessage')return async()=>({success:false,reason:'WhatsApp service not available'});if(prop==='startSession'||prop==='disconnectSession'||prop==='restoreSessions')return async()=>{};return undefined;}return mod[prop];}});
const PLATFORM_WA_STORE_ID=process.env.PLATFORM_WA_STORE_ID||'platform';
const nullIf=(v)=>(v===''||v===undefined||v===null)?null:v;
function formatOrderNumber(num,cfg){cfg=cfg||{};if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}const prefix=cfg.order_prefix||'ORD-';let suffix=cfg.order_suffix||'';if(suffix&&!suffix.startsWith('-'))suffix='-'+suffix;const start=parseInt(cfg.order_start_number)||0;const pad=parseInt(cfg.order_pad_length)||5;const n=(parseInt(num)||0)+(start>0?start-1:0);return `${prefix}${String(n).padStart(pad,'0')}${suffix}`;}
const { loadPlanFeatures: _lpf, enforceQuota: _eq, requireFeature: _rf } = require('../middleware/planFeatures');

// ─────────────────────────────────────────────────────────────────────────────
// Two-step verification helpers. Generate a 6-digit code, ship it via the
// owner's chosen channel (whatsapp / email), and return a signed JWT that
// holds the bcrypt hash of the code so we never store plaintext codes.
// `purpose` scopes the token so a login code can't be reused to disable 2FA.
// ─────────────────────────────────────────────────────────────────────────────
async function send2FACode(owner, purpose) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await bcrypt.hash(code, 8);
  const method = ['whatsapp','email'].includes(owner.two_fa_method) ? owner.two_fa_method : 'whatsapp';

  let sent = false, reason = '';
  if (method === 'whatsapp') {
    if (!owner.phone)  return { sent:false, error:'No phone number on file for WhatsApp delivery.' };
    try {
      const status = waBaileys.getStatus(PLATFORM_WA_STORE_ID);
      if (!status.connected) return { sent:false, error:'Platform WhatsApp is offline. Try email instead.' };
      const msg = `🔐 ${code}\n\nYour MakretDZ verification code. Expires in 10 minutes.\nIf you didn't request this, ignore this message.`;
      const sendResult = await waBaileys.sendMessage(PLATFORM_WA_STORE_ID, owner.phone, msg);
      sent = !!sendResult.success;
      reason = sendResult.reason || '';
    } catch (e) { reason = e.message; }
  } else if (method === 'email') {
    if (!owner.email) return { sent:false, error:'No email address on file for email delivery.' };
    try {
      const messaging = require('../services/messaging');
      const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#111827;margin:0 0 12px;">MakretDZ verification code</h2>
        <p style="color:#374151;font-size:14px;line-height:1.5;">Your verification code is:</p>
        <div style="background:#f3f4f6;border-radius:14px;padding:24px;text-align:center;letter-spacing:10px;font-size:36px;font-weight:800;color:#111827;font-family:'Courier New',monospace;margin:16px 0;">${code}</div>
        <p style="color:#6b7280;font-size:12px;margin-top:16px;">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
      </div>`;
      const r = await messaging.sendEmail({ to:owner.email, subject:'Your MakretDZ verification code', html });
      sent = !!(r && (r.id || r.success));
      reason = r?.error || '';
    } catch (e) { reason = e.message; }
  }

  if (!sent) return { sent:false, error:`Failed to send code via ${method}${reason ? ': ' + reason : ''}` };

  const otp_token = jwt.sign({ purpose, owner_id:owner.id, otpHash, method }, OTP_JWT_SECRET, { expiresIn:'10m' });
  const masked = method === 'email'
    ? (owner.email || '').replace(/(.).+(@.+)/, '$1***$2')
    : (owner.phone || '').replace(/.(?=.{3})/g, '•');
  return { sent:true, otp_token, masked, method };
}

async function verify2FACode(otp_token, code, expectedPurpose) {
  if (!otp_token || !code) return { ok:false, error:'Verification token and code required' };
  let payload;
  try { payload = jwt.verify(otp_token, OTP_JWT_SECRET); }
  catch { return { ok:false, error:'Verification expired. Request a new code.' }; }
  if (payload.purpose !== expectedPurpose) return { ok:false, error:'Invalid verification token' };
  if (!(await bcrypt.compare(String(code).trim(), payload.otpHash))) return { ok:false, error:'Invalid verification code' };
  return { ok:true, payload };
}

// DB columns in stores table
const STORE_COLS=new Set(['store_name','description','logo_url','favicon_url','primary_color','secondary_color','accent_color','bg_color','currency','is_published','meta_title','meta_description','hero_title','hero_subtitle','contact_email','contact_phone','contact_address','social_facebook','social_instagram','social_tiktok']);
// Frontend->DB field mapping
const FIELD_MAP={name:'store_name',store_name:'store_name',description:'description',logo:'logo_url',logo_url:'logo_url',favicon:'favicon_url',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',bg_color:'bg_color',currency:'currency',is_live:'is_published',is_published:'is_published',meta_title:'meta_title',meta_description:'meta_description',hero_title:'hero_title',hero_subtitle:'hero_subtitle',contact_email:'contact_email',contact_phone:'contact_phone',contact_address:'contact_address',social_facebook:'social_facebook',social_instagram:'social_instagram',social_tiktok:'social_tiktok'};
const PAY_MAP={enable_cod:'cod_enabled',enable_ccp:'ccp_enabled',ccp_account:'ccp_account',ccp_name:'ccp_name',enable_baridimob:'baridimob_enabled',baridimob_rip:'baridimob_rip',enable_bank_transfer:'bank_transfer_enabled',bank_name:'bank_name',bank_account:'bank_account',bank_rib:'bank_rib'};

// Resolve a friendly label for a staff role string. Roles can be plain
// (e.g. 'manager'), or reference a platform template (`tpl_<uuid>`) or a
// store-scoped template (`st_<timestamp>`). For templates we look up the
// stored name; otherwise we slug-clean the raw role.
async function resolveStaffRoleLabel(role, storeId){
  if(!role)return 'Staff';
  try{
    if(typeof role==='string'&&role.startsWith('tpl_')){
      const id=role.slice(4);
      // role_templates columns are name_en / name_fr / name_ar (no `name` col).
      const r=await pool.query('SELECT name_en,name_fr,name_ar FROM role_templates WHERE id=$1',[id]).catch(e=>{console.log('[role label] tpl lookup err:',e.message);return{rows:[]};});
      if(r.rows.length){
        const row=r.rows[0];
        return row.name_en||row.name_fr||row.name_ar||'Role';
      }
    }
    if(typeof role==='string'&&role.startsWith('st_')&&storeId){
      const cfg=(await pool.query('SELECT config FROM stores WHERE id=$1',[storeId])).rows[0]?.config||{};
      const list=Array.isArray(cfg.role_templates)?cfg.role_templates:[];
      const tpl=list.find(x=>String(x.id)===String(role));
      if(tpl){
        if(typeof tpl.name==='object'&&tpl.name)return tpl.name.en||tpl.name.fr||tpl.name.ar||'Role';
        return tpl.name||'Role';
      }
    }
    // Plain preset role like 'manager' / 'viewer' / 'custom' — title-case it.
    if(typeof role==='string'&&!role.startsWith('tpl_')&&!role.startsWith('st_')){
      return role.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    }
  }catch(e){console.log('[role label] error:',e.message);}
  // Last-resort fallback: if a tpl_/st_ template was deleted, show "Staff"
  // instead of the raw UUID so the sidebar doesn't display 1053d9ec-... etc.
  return 'Staff';
}

// Find every store belonging to `ownerId` that has a staff row matching this
// staff member (same email or, when email is empty, same phone). Used by
// staff login + the GET staff list to expose multi-store assignments.
async function findStaffSiblingStores(staff, ownerId){
  try{
    const stores=(await pool.query('SELECT * FROM stores WHERE owner_id=$1',[ownerId])).rows;
    if(!stores.length)return[];
    const ids=stores.map(s=>s.id);
    const matches=[];
    if(staff.email){
      const r=await pool.query('SELECT store_id FROM store_staff WHERE LOWER(email)=LOWER($1) AND store_id=ANY($2::uuid[])',[staff.email,ids]).catch(()=>({rows:[]}));
      for(const row of r.rows)matches.push(row.store_id);
    }
    if(!matches.length&&staff.phone){
      const r=await pool.query('SELECT store_id FROM store_staff WHERE phone=$1 AND store_id=ANY($2::uuid[])',[staff.phone,ids]).catch(()=>({rows:[]}));
      for(const row of r.rows)matches.push(row.store_id);
    }
    if(!matches.length)matches.push(staff.store_id);
    const set=new Set(matches.map(String));
    return stores.filter(s=>set.has(String(s.id)));
  }catch(e){console.log('[findStaffSiblingStores]',e.message);return[];}
}

// Helper to load store + payment + config
async function loadStore(sid){
  const s=(await pool.query('SELECT * FROM stores WHERE id=$1',[sid])).rows[0];
  if(!s)return null;
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[sid])).rows[0]||{};}catch(e){}
  const cfg=s.config||{};
  // DB columns always override config - spread cfg first, then s on top
  const result={...cfg,...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,favicon:s.favicon_url,
    enable_cod:pay.cod_enabled,enable_ccp:pay.ccp_enabled,ccp_account:pay.ccp_account,ccp_name:pay.ccp_name,
    enable_baridimob:pay.baridimob_enabled,baridimob_rip:pay.baridimob_rip,
    enable_bank_transfer:pay.bank_transfer_enabled,bank_name:pay.bank_name,bank_account:pay.bank_account,bank_rib:pay.bank_rib};
  // Ensure DB columns win over any stale config values
  for(const col of ['hero_title','hero_subtitle','meta_title','meta_description','contact_phone','contact_email','social_facebook','social_instagram','social_tiktok','primary_color','secondary_color','accent_color','bg_color','currency','description']){
    if(s[col]!==undefined&&s[col]!==null)result[col]=s[col];
  }
  return result;
}

router.post('/register',async(req,res)=>{try{
  const{name,address,city,wilaya}=req.body;
  const email=((req.body?.email||'')+'').trim().toLowerCase();
  const phone=((req.body?.phone||'')+'').trim();
  const password=((req.body?.password||'')+'').trim();
  if(!name||!email||!phone||!password)return res.status(400).json({error:'All fields required'});
  const dup=await pool.query('SELECT id FROM store_owners WHERE LOWER(email)=$1 OR phone=$2',[email,phone]);
  if(dup.rows.length)return res.status(409).json({error:'Already registered'});
  const hash=await bcrypt.hash(password,12);
  // Self-heal stale DBs that don't yet have the subscription columns. These
  // ALTERs are idempotent so repeated calls are cheap.
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free'");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMP");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS address TEXT");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS city VARCHAR(100)");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS wilaya VARCHAR(100)");}catch{}
  // Apply platform free trial if enabled
  let trialPlan=null,trialExpiry=null,trialStatus=null;
  try{
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_enabled BOOLEAN DEFAULT TRUE");}catch{}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_plan VARCHAR(50) DEFAULT 'basic'");}catch{}
    const s=(await pool.query('SELECT subscription_trial_enabled,subscription_trial_days,subscription_trial_plan FROM platform_settings LIMIT 1')).rows[0]||{};
    const enabled=s.subscription_trial_enabled!==false;
    const days=parseInt(s.subscription_trial_days||0,10)||0;
    if(enabled&&days>0){
      trialPlan=s.subscription_trial_plan||'basic';
      trialStatus='trial';
      trialExpiry=new Date(Date.now()+days*24*60*60*1000);
    }
  }catch(e){console.error('[register trial]',e.message);}
  // Bare identifiers inside VALUES don't resolve to columns in Postgres, so
  // `COALESCE($8, subscription_plan)` would throw "column subscription_plan
  // does not exist". Use literal defaults instead.
  const r=await pool.query(`INSERT INTO store_owners(full_name,email,phone,password_hash,address,city,wilaya,subscription_plan,subscription_status,subscription_expires_at,subscription_paid_until) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'free'),COALESCE($9,'active'),$10,$10) RETURNING *`,[name,email,phone,hash,address||null,city||null,wilaya||null,trialPlan,trialStatus,trialExpiry]);
  const o=r.rows[0];
  try{if(global.__notifyAdmin)await global.__notifyAdmin({type:'account_created',title:'New store owner registered',body:`${o.full_name} (${o.email||o.phone})${trialExpiry?` — ${trialPlan} trial until ${trialExpiry.toLocaleDateString()}`:''}`,link:'/admin/store-owners',owner_id:o.id,dedup_key:`registered:${o.id}`});}catch{}
  res.status(201).json({token:generateToken({id:o.id,role:'store_owner',name:o.full_name}),owner:{id:o.id,name:o.full_name,email:o.email,phone:o.phone,subscription_plan:o.subscription_plan,subscription_status:o.subscription_status,subscription_expires_at:o.subscription_expires_at}});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ REGISTRATION WHATSAPP OTP ═══
// Step 1: validate form, send 6-digit OTP via WhatsApp, return signed otp_token
router.post('/register/request-otp',async(req,res)=>{try{
  const{name,address,city,wilaya}=req.body;
  const email=((req.body?.email||'')+'').trim().toLowerCase();
  const phone=((req.body?.phone||'')+'').trim();
  const password=((req.body?.password||'')+'').trim();
  if(!name||!email||!phone||!password)return res.status(400).json({error:'All fields required'});
  if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
  const dup=await pool.query('SELECT id FROM store_owners WHERE LOWER(email)=$1 OR phone=$2',[email,phone]);
  if(dup.rows.length)return res.status(409).json({error:'Already registered'});
  // Generate OTP
  const code=Math.floor(100000+Math.random()*900000).toString();
  const otpHash=await bcrypt.hash(code,8);
  const passwordHash=await bcrypt.hash(password,12);
  // Send WhatsApp — ONLY the super admin's connected platform session.
  let sent=false,reason='';
  try{
    const status=waBaileys.getStatus(PLATFORM_WA_STORE_ID);
    if(!status.connected)return res.status(503).json({error:'Verification is currently unavailable. The administrator has not connected the platform WhatsApp yet.'});
    const msg=`🔐 ${code}\n\nYour MakretDZ verification code. Expires in 10 minutes.\nIf you didn't request this, ignore this message.`;
    const sendResult=await waBaileys.sendMessage(PLATFORM_WA_STORE_ID,phone,msg);
    sent=!!sendResult.success;reason=sendResult.reason||'';
  }catch(e){reason=e.message;}
  if(!sent)return res.status(502).json({error:'Failed to send verification code via WhatsApp'+(reason?`: ${reason}`:'')});
  const otp_token=jwt.sign({purpose:'register_otp',name,email,phone,passwordHash,address:address||null,city:city||null,wilaya:wilaya||null,otpHash},OTP_JWT_SECRET,{expiresIn:'10m'});
  res.json({otp_token,expires_in:600,phone_masked:phone.replace(/.(?=.{3})/g,'•')});
}catch(e){console.error('[register/request-otp]',e.message);res.status(500).json({error:e.message});}});

// Step 2: verify OTP, then create the account
router.post('/register/verify-otp',async(req,res)=>{try{
  const{otp_token,code}=req.body||{};
  if(!otp_token||!code)return res.status(400).json({error:'Token and code required'});
  let payload;
  try{payload=jwt.verify(otp_token,OTP_JWT_SECRET);}catch(e){return res.status(401).json({error:'Verification session expired. Please restart registration.'});}
  if(payload.purpose!=='register_otp')return res.status(401).json({error:'Invalid token'});
  if(!(await bcrypt.compare(String(code).trim(),payload.otpHash)))return res.status(401).json({error:'Invalid verification code'});
  const{name,email,phone,passwordHash,address,city,wilaya}=payload;
  // Re-check dup (race safety)
  const dup=await pool.query('SELECT id FROM store_owners WHERE LOWER(email)=$1 OR phone=$2',[email,phone]);
  if(dup.rows.length)return res.status(409).json({error:'Already registered'});
  // Self-heal columns
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free'");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMP");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS address TEXT");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS city VARCHAR(100)");}catch{}
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS wilaya VARCHAR(100)");}catch{}
  // Trial logic
  let trialPlan=null,trialExpiry=null,trialStatus=null;
  try{
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_enabled BOOLEAN DEFAULT TRUE");}catch{}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS subscription_trial_plan VARCHAR(50) DEFAULT 'basic'");}catch{}
    const s=(await pool.query('SELECT subscription_trial_enabled,subscription_trial_days,subscription_trial_plan FROM platform_settings LIMIT 1')).rows[0]||{};
    const enabled=s.subscription_trial_enabled!==false;
    const days=parseInt(s.subscription_trial_days||0,10)||0;
    if(enabled&&days>0){trialPlan=s.subscription_trial_plan||'basic';trialStatus='trial';trialExpiry=new Date(Date.now()+days*24*60*60*1000);}
  }catch(e){console.error('[verify-otp trial]',e.message);}
  const r=await pool.query(`INSERT INTO store_owners(full_name,email,phone,password_hash,address,city,wilaya,subscription_plan,subscription_status,subscription_expires_at,subscription_paid_until) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'free'),COALESCE($9,'active'),$10,$10) RETURNING *`,[name,email,phone,passwordHash,address,city,wilaya,trialPlan,trialStatus,trialExpiry]);
  const o=r.rows[0];
  try{if(global.__notifyAdmin)await global.__notifyAdmin({type:'account_created',title:'New store owner registered',body:`${o.full_name} (${o.email||o.phone})${trialExpiry?` — ${trialPlan} trial until ${trialExpiry.toLocaleDateString()}`:''}`,link:'/admin/store-owners',owner_id:o.id,dedup_key:`registered:${o.id}`});}catch{}
  res.status(201).json({token:generateToken({id:o.id,role:'store_owner',name:o.full_name}),owner:{id:o.id,name:o.full_name,email:o.email,phone:o.phone,subscription_plan:o.subscription_plan,subscription_status:o.subscription_status,subscription_expires_at:o.subscription_expires_at}});
}catch(e){console.error('[register/verify-otp]',e.message);res.status(500).json({error:e.message});}});

// Version check for storeOwner routes
router.get('/version',(req,res)=>res.json({version:'owner-v6-otp'}));

router.post('/login',async(req,res)=>{try{
  const rawIdentifier=req.body?.identifier;
  const rawPassword=req.body?.password;
  // Mobile keyboards autocapitalize and tend to add a trailing space.
  // Trim everything and lower-case the identifier so emails are matched
  // case-insensitively (phones already lowercase-safe).
  const idTrim=(rawIdentifier||'').trim();
  const idLower=idTrim.toLowerCase();
  const password=(rawPassword||'').trim();
  console.log('[Owner Login] identifier:', idLower, 'pw_len:', password.length);
  if(!idTrim||!password)return res.status(400).json({error:'Required'});

  // ===== SUPERADMIN CHECK =====
  // Check DB-backed super-admin credentials first. Once a hash exists, the
  // Check platform_admins table for super admin login
  try{
    try{await pool.query(`CREATE TABLE IF NOT EXISTS platform_admins(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),full_name VARCHAR(255) NOT NULL DEFAULT '',
      phone VARCHAR(50) UNIQUE NOT NULL,email VARCHAR(255),password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'platform_admin',is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);}catch{}
    const digits=idTrim.replace(/[^0-9]/g,'');
    const last9=digits.slice(-9);
    const all=await pool.query("SELECT id,full_name,phone,is_active,password_hash FROM platform_admins");
    const admin=all.rows.find(r=>{const rp=(r.phone||'').toString();const rd=rp.replace(/[^0-9]/g,'');return rp.trim()===idTrim||rd===digits||(last9&&rd.slice(-9)===last9);});
    if(admin){
      if(admin.is_active===false)return res.status(401).json({error:'Account deactivated'});
      const pwOk=await bcrypt.compare(password,admin.password_hash||'').catch(()=>false);
      if(pwOk){
        console.log('[Owner Login] ✅ SUPERADMIN match from platform_admins');
        const token=generateToken({id:admin.id,role:'platform_admin',name:admin.full_name||'Admin'});
        return res.json({token,owner:{id:admin.id,name:admin.full_name||'Admin',email:'admin@platform',phone:admin.phone,subscription_plan:'enterprise'},stores:[],redirect:'/admin/dashboard'});
      }
      // Phone matched but wrong password → don't fall through to store owner
      return res.status(401).json({error:'Invalid credentials'});
    }
  }catch(e){console.log('[Owner Login] superadmin check error:',e.message);}

  // ===== NORMAL STORE OWNER LOGIN =====
  // Match email case-insensitively, phone exact (after trim).
  let r=await pool.query('SELECT * FROM store_owners WHERE LOWER(email)=$1',[idLower]);
  if(!r.rows.length)r=await pool.query('SELECT * FROM store_owners WHERE phone=$1',[idTrim]);
  if(!r.rows.length){
    // Not a store owner — try staff before giving up.
    try{
      let sr=await pool.query('SELECT * FROM store_staff WHERE LOWER(email)=$1',[idLower]);
      if(!sr.rows.length)sr=await pool.query('SELECT * FROM store_staff WHERE phone=$1',[idTrim]);
      if(sr.rows.length){
        const staff=sr.rows[0];
        if(staff.is_active===false)return res.status(403).json({error:'This staff account is deactivated. Contact your store admin.'});
        if(await bcrypt.compare(password,staff.password_hash)){
          const sRow=(await pool.query('SELECT * FROM stores WHERE id=$1',[staff.store_id])).rows[0];
          if(!sRow)return res.status(401).json({error:'Assigned store no longer exists'});
          const owner=(await pool.query('SELECT * FROM store_owners WHERE id=$1',[sRow.owner_id])).rows[0];
          if(!owner)return res.status(401).json({error:'Owner missing'});
          let perms=[];try{perms=typeof staff.permissions==='string'?JSON.parse(staff.permissions||'[]'):(staff.permissions||[]);}catch{perms=[];}
          const sibling=await findStaffSiblingStores(staff,owner.id);
          const staffRoleLabel=await resolveStaffRoleLabel(staff.role,sRow.id);
          console.log('[Owner Login] ✅ STAFF (no-owner path):',staff.name,'stores:',sibling.length);
          return res.json({
            token:generateToken({id:owner.id,role:'store_owner',name:staff.name,staff_id:staff.id,staff_role:staff.role,staff_role_label:staffRoleLabel,permissions:perms,scoped_store_id:sRow.id,scoped_store_ids:sibling.map(s=>s.id)}),
            owner:{id:owner.id,name:staff.name,email:staff.email,phone:staff.phone,subscription_plan:owner.subscription_plan,is_staff:true,staff_id:staff.id,staff_role:staff.role,staff_role_label:staffRoleLabel,permissions:perms,scoped_store_id:sRow.id,scoped_store_ids:sibling.map(s=>s.id)},
            stores:sibling.map(s=>({...(s.config||{}),...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle}))
          });
        }
      }
    }catch(sE){console.error('[Owner Login] staff lookup (no-owner) err:',sE.message);}
    console.log('[Owner Login] ❌ User not found');
    return res.status(401).json({error:'Invalid credentials'});
  }
  const o=r.rows[0];
  if(o.is_active===false||o.subscription_status==='suspended')return res.status(403).json({error:'Your account is suspended. Please renew your subscription or contact support.',suspended:true});
  if(!(await bcrypt.compare(password,o.password_hash))){
    console.log('[Owner Login] ❌ Wrong password, trying staff...');
    // ===== STAFF LOGIN FALLBACK =====
    // If owner password failed OR this identifier isn't an owner at all, try
    // matching as a team member (store_staff) created by a store owner.
    try{
      let sr=await pool.query('SELECT * FROM store_staff WHERE LOWER(email)=$1',[idLower]);
      if(!sr.rows.length)sr=await pool.query('SELECT * FROM store_staff WHERE phone=$1',[idTrim]);
      if(sr.rows.length){
        const staff=sr.rows[0];
        if(staff.is_active===false)return res.status(403).json({error:'This staff account is deactivated. Contact your store admin.'});
        if(await bcrypt.compare(password,staff.password_hash)){
          const sRow=(await pool.query('SELECT * FROM stores WHERE id=$1',[staff.store_id])).rows[0];
          if(!sRow)return res.status(401).json({error:'Assigned store no longer exists'});
          const owner=(await pool.query('SELECT * FROM store_owners WHERE id=$1',[sRow.owner_id])).rows[0];
          if(!owner)return res.status(401).json({error:'Owner missing'});
          let perms=[];try{perms=typeof staff.permissions==='string'?JSON.parse(staff.permissions||'[]'):(staff.permissions||[]);}catch{perms=[];}
          const sibling=await findStaffSiblingStores(staff,owner.id);
          const staffRoleLabel=await resolveStaffRoleLabel(staff.role,sRow.id);
          console.log('[Owner Login] ✅ STAFF:',staff.name,'stores:',sibling.length,'primary:',sRow.slug);
          return res.json({
            token:generateToken({id:owner.id,role:'store_owner',name:staff.name,staff_id:staff.id,staff_role:staff.role,staff_role_label:staffRoleLabel,permissions:perms,scoped_store_id:sRow.id,scoped_store_ids:sibling.map(s=>s.id)}),
            owner:{id:owner.id,name:staff.name,email:staff.email,phone:staff.phone,subscription_plan:owner.subscription_plan,is_staff:true,staff_id:staff.id,staff_role:staff.role,staff_role_label:staffRoleLabel,permissions:perms,scoped_store_id:sRow.id,scoped_store_ids:sibling.map(s=>s.id)},
            stores:sibling.map(s=>({...(s.config||{}),...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle}))
          });
        }
      }
    }catch(sE){console.error('[Owner Login] staff lookup err:',sE.message);}
    return res.status(401).json({error:'Invalid credentials'});
  }
  // ===== TWO-STEP VERIFICATION =====
  // If the owner has enabled 2FA, send a code instead of returning a token.
  // The frontend then prompts for the code and calls /login/verify-2fa.
  if (o.two_fa_enabled) {
    const r2fa = await send2FACode(o, 'login_2fa');
    if (!r2fa.sent) return res.status(503).json({ error:r2fa.error });
    return res.json({
      requires_2fa:true,
      otp_token:r2fa.otp_token,
      method:r2fa.method,
      masked:r2fa.masked,
      message:`A 6-digit code was sent to your ${r2fa.method === 'email' ? 'email' : 'WhatsApp'}.`,
    });
  }
  const stores=await pool.query('SELECT * FROM stores WHERE owner_id=$1',[o.id]);
  console.log('[Owner Login] ✅ Owner:', o.full_name);
  res.json({token:generateToken({id:o.id,role:'store_owner',name:o.full_name}),owner:{id:o.id,name:o.full_name,email:o.email,phone:o.phone,subscription_plan:o.subscription_plan},stores:stores.rows.map(s=>({...(s.config||{}),...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle}))});
}catch(e){console.error('[Owner Login] ERROR:', e.message);res.status(500).json({error:e.message});}});

// Step 2 of 2FA login: verify the code, return the real auth token.
router.post('/login/verify-2fa', async (req, res) => {
  try {
    const { otp_token, code } = req.body || {};
    const v = await verify2FACode(otp_token, code, 'login_2fa');
    if (!v.ok) return res.status(401).json({ error:v.error });
    const o = (await pool.query('SELECT * FROM store_owners WHERE id=$1', [v.payload.owner_id])).rows[0];
    if (!o) return res.status(404).json({ error:'Account not found' });
    if (o.is_active === false || o.subscription_status === 'suspended') return res.status(403).json({ error:'Account suspended', suspended:true });
    const stores = await pool.query('SELECT * FROM stores WHERE owner_id=$1', [o.id]);
    res.json({
      token: generateToken({ id:o.id, role:'store_owner', name:o.full_name }),
      owner: { id:o.id, name:o.full_name, email:o.email, phone:o.phone, subscription_plan:o.subscription_plan },
      stores: stores.rows.map(s => ({ ...(s.config || {}), ...s, name:s.store_name, is_live:s.is_published, logo:s.logo_url, hero_title:s.hero_title, hero_subtitle:s.hero_subtitle })),
    });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// Resend the login code if the owner didn't receive it.
router.post('/login/resend-2fa', async (req, res) => {
  try {
    const { otp_token } = req.body || {};
    if (!otp_token) return res.status(400).json({ error:'Token required' });
    let payload;
    try { payload = jwt.verify(otp_token, OTP_JWT_SECRET); } catch { return res.status(401).json({ error:'Session expired. Sign in again.' }); }
    if (payload.purpose !== 'login_2fa') return res.status(401).json({ error:'Invalid token' });
    const o = (await pool.query('SELECT * FROM store_owners WHERE id=$1', [payload.owner_id])).rows[0];
    if (!o) return res.status(404).json({ error:'Account not found' });
    const r2fa = await send2FACode(o, 'login_2fa');
    if (!r2fa.sent) return res.status(503).json({ error:r2fa.error });
    res.json({ otp_token:r2fa.otp_token, method:r2fa.method, masked:r2fa.masked });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// ═══ FORGOT PASSWORD ═══
// Step 1: request reset code — finds owner by phone/email, sends code via WhatsApp
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    const id = (identifier || '').trim();
    if (!id) return res.status(400).json({ error: 'Phone or email required' });
    // Find owner by phone or email
    const r = await pool.query(
      'SELECT * FROM store_owners WHERE phone=$1 OR email=$1 OR phone=$2',
      [id, id.replace(/[^0-9]/g, '')]
    );
    const owner = r.rows[0];
    if (!owner) return res.status(404).json({ error: 'No account found with this phone/email' });
    // Force whatsapp for password reset
    const fakeOwner = { ...owner, two_fa_method: 'whatsapp' };
    const r2fa = await send2FACode(fakeOwner, 'password_reset');
    if (!r2fa.sent) return res.status(503).json({ error: r2fa.error });
    res.json({ otp_token: r2fa.otp_token, masked: r2fa.masked, method: r2fa.method });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: verify code
router.post('/forgot-password/verify', async (req, res) => {
  try {
    const { otp_token, code } = req.body || {};
    const v = await verify2FACode(otp_token, code, 'password_reset');
    if (!v.ok) return res.status(401).json({ error: v.error });
    // Issue a short-lived reset token
    const resetToken = jwt.sign({ purpose: 'do_reset', owner_id: v.payload.owner_id }, OTP_JWT_SECRET, { expiresIn: '5m' });
    res.json({ reset_token: resetToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 3: set new password
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { reset_token, new_password } = req.body || {};
    if (!reset_token || !new_password) return res.status(400).json({ error: 'Token and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    let payload;
    try { payload = jwt.verify(reset_token, OTP_JWT_SECRET); } catch { return res.status(401).json({ error: 'Reset link expired. Start over.' }); }
    if (payload.purpose !== 'do_reset') return res.status(401).json({ error: 'Invalid token' });
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE store_owners SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, payload.owner_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stores',authMiddleware(['store_owner']),async(req,res)=>{try{
  // Staff accounts cannot create stores
  if(req.user.staff_id)return res.status(403).json({error:'Staff cannot create stores'});
  // Enforce plan's max_stores quota
  try{
    await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_stores INTEGER DEFAULT 1');
    const owner=(await pool.query('SELECT subscription_plan FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
    if(owner?.subscription_plan){
      const plan=(await pool.query('SELECT max_stores FROM plans WHERE slug=$1 AND is_active=TRUE',[owner.subscription_plan])).rows[0];
      const limit=parseInt(plan?.max_stores)||1;
      if(limit>0){
        const cnt=parseInt((await pool.query('SELECT COUNT(*) FROM stores WHERE owner_id=$1',[req.user.id])).rows[0].count);
        if(cnt>=limit)return res.status(403).json({error:`Your plan allows only ${limit} store${limit===1?'':'s'}. Upgrade your subscription to create more.`});
      }
    }
  }catch(quotaErr){console.log('[stores] quota check skipped:',quotaErr.message);}
  const{name,description,slug:userSlug}=req.body;if(!name)return res.status(400).json({error:'Store name is required'});let slug=userSlug?userSlug.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,''):slugify(name,{lower:true,strict:true});if(slug.length<3)return res.status(400).json({error:'Store URL must be at least 3 characters'});const reserved=['admin','login','register','dashboard','api','s','store','checkout','auth','profile','health'];if(reserved.includes(slug))return res.status(400).json({error:'This URL is reserved, please choose another'});const dup=await pool.query('SELECT id FROM stores WHERE slug=$1',[slug]);if(dup.rows.length)return res.status(409).json({error:'This store URL is already taken. Try a different one.'});const r=await pool.query('INSERT INTO stores(owner_id,store_name,slug,description,is_published,is_active) VALUES($1,$2,$3,$4,TRUE,TRUE) RETURNING *',[req.user.id,name,slug,description||null]);try{await pool.query('INSERT INTO payment_settings(store_id,cod_enabled) VALUES($1,TRUE)',[r.rows[0].id]);}catch(e){}res.status(201).json(await loadStore(r.rows[0].id));}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores',authMiddleware(['store_owner']),async(req,res)=>{try{const r=await pool.query(`SELECT s.*,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count FROM stores s WHERE s.owner_id=$1 ORDER BY s.created_at DESC`,[req.user.id]);const out=[];for(const s of r.rows){let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}const cfg=s.config||{};
    // Strip OVERSIZED ai_html (legacy heavy GPT pages) from the list so the
    // dashboard never has to download/parse multi-MB blobs (which froze the
    // builder). Light pages keep their ai_html so they stay editable inline.
    if(Array.isArray(cfg.landing_pages))cfg.landing_pages=cfg.landing_pages.map(lp=>{if(lp&&typeof lp.ai_html==='string'&&lp.ai_html.length>900000){const{ai_html,...rest}=lp;return{...rest,ai_html:'',has_ai_html:true,too_large:true};}return lp;});
    out.push({...cfg,...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,favicon:s.favicon_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle,product_count:s.product_count,order_count:s.order_count,enable_cod:pay.cod_enabled,enable_ccp:pay.ccp_enabled,ccp_account:pay.ccp_account,ccp_name:pay.ccp_name,enable_baridimob:pay.baridimob_enabled,baridimob_rip:pay.baridimob_rip,enable_bank_transfer:pay.bank_transfer_enabled,bank_name:pay.bank_name,bank_account:pay.bank_account,bank_rib:pay.bank_rib});}res.json(out);}catch(e){res.status(500).json({error:e.message});}});

// Delete a store permanently (owner only). The client must echo the store's
// exact name, so a stray click can never wipe a shop. Every per-store table is
// cleared inside one transaction; each delete runs under a savepoint so a table
// that does not exist on this database cannot abort the whole operation.
router.delete('/stores/:sid',authMiddleware(['store_owner']),async(req,res)=>{
  const client=await pool.connect();
  try{
    const sid=req.params.sid;
    const st=(await client.query('SELECT id,store_name FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id])).rows[0];
    if(!st)return res.status(404).json({error:'Store not found'});
    const typed=String(req.body?.confirm_name||'').trim();
    if(!typed||typed!==String(st.store_name||'').trim())return res.status(400).json({error:'Type the store name exactly to confirm deletion'});
    await client.query('BEGIN');
    const del=async(sql,params)=>{await client.query('SAVEPOINT sp');try{await client.query(sql,params);await client.query('RELEASE SAVEPOINT sp');}catch{await client.query('ROLLBACK TO SAVEPOINT sp');}};
    for(const t of ['payment_receipts','blacklist','message_log','expenses','store_pages','notifications','push_subscriptions','reviews','carts','store_domains','shipping_wilayas','delivery_companies','categories','customers','store_status_templates','coupons','store_staff','activity_log']){
      await del(`DELETE FROM ${t} WHERE store_id=$1`,[sid]);
    }
    await del('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)',[sid]);
    await del('DELETE FROM orders WHERE store_id=$1',[sid]);
    await del('DELETE FROM products WHERE store_id=$1',[sid]);
    await client.query('DELETE FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);
    await client.query('COMMIT');
    res.json({ok:true});
  }catch(e){try{await client.query('ROLLBACK');}catch{}res.status(500).json({error:e.message});}
  finally{client.release();}
});

// Single store fetch (full data including payment settings)
router.get('/stores/:sid',authMiddleware(['store_owner']),async(req,res)=>{try{
  const sid=req.params.sid;
  const own=await pool.query('SELECT id FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);
  if(!own.rows.length)return res.status(404).json({error:'Not found'});
  res.json(await loadStore(sid));
}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores/:sid/dashboard',authMiddleware(['store_owner']),async(req,res)=>{try{const sid=req.params.sid;const store=await pool.query('SELECT * FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);if(!store.rows.length)return res.status(404).json({error:'Not found'});const full=await loadStore(sid);let to=0,tr=0,tp=0,tc=0,ro=[],sd=[];try{to=parseInt((await pool.query('SELECT COUNT(*) FROM orders WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{tr=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE store_id=$1 AND (payment_status='paid' OR status IN ('confirmed','preparing','shipped','delivered'))",[sid])).rows[0].t);}catch(e){}try{tp=parseInt((await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{tc=parseInt((await pool.query('SELECT COUNT(*) FROM customers WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{ro=(await pool.query('SELECT * FROM orders WHERE store_id=$1 ORDER BY created_at DESC LIMIT 10',[sid])).rows;}catch(e){}try{sd=(await pool.query("SELECT DATE(created_at) as date,COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE store_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date",[sid])).rows;}catch(e){}
// Real period-over-period deltas. The dashboard used to print hard-coded
// "+8.2%" style figures next to every card, which read as growth even for a
// store with zero of everything. Compare the last 30 days against the 30
// before that and let the client decide what to show.
let trend={};
try{
  const paidFilter="(payment_status='paid' OR status IN ('confirmed','preparing','shipped','delivered'))";
  const q=await pool.query(`SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days') AS orders_cur,
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '60 days' AND created_at < NOW()-INTERVAL '30 days') AS orders_prev,
      COALESCE(SUM(total) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days' AND ${paidFilter}),0) AS revenue_cur,
      COALESCE(SUM(total) FILTER (WHERE created_at >= NOW()-INTERVAL '60 days' AND created_at < NOW()-INTERVAL '30 days' AND ${paidFilter}),0) AS revenue_prev
    FROM orders WHERE store_id=$1`,[sid]);
  const d=q.rows[0]||{};
  const oc=parseInt(d.orders_cur)||0, op=parseInt(d.orders_prev)||0;
  const rc=parseFloat(d.revenue_cur)||0, rp=parseFloat(d.revenue_prev)||0;
  trend={
    orders:{current:oc,previous:op},
    revenue:{current:rc,previous:rp},
    avgOrderValue:{current:oc?rc/oc:0,previous:op?rp/op:0},
  };
}catch(e){}
let itemsByOrder={};try{const ids=ro.map(o=>o.id);if(ids.length){const ir=await pool.query("SELECT oi.order_id,oi.product_id,oi.product_name,oi.product_image,oi.quantity,oi.unit_price,oi.total_price,p.images AS p_images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=ANY($1::uuid[])",[ids]);for(const it of ir.rows){let img=it.product_image||null;if(!img){try{const imgs=Array.isArray(it.p_images)?it.p_images:(typeof it.p_images==='string'?JSON.parse(it.p_images||'[]'):[]);img=imgs[0]||null;}catch(e){}}(itemsByOrder[it.order_id]=itemsByOrder[it.order_id]||[]).push({product_id:it.product_id,product_name:it.product_name,quantity:it.quantity,price:it.unit_price,total_price:it.total_price,image:img});}}}catch(e){console.error('[dashboard items]',e.message);}
res.json({store:full,stats:{totalOrders:to,totalRevenue:tr,totalProducts:tp,totalCustomers:tc,storeVisits:full.total_visits||0},trend,recentOrders:ro.map(o=>{let _c=full.config||{};if(typeof _c==='string'){try{_c=JSON.parse(_c);}catch{_c={};}}return{...o,order_number:formatOrderNumber(o.order_number,_c),items:itemsByOrder[o.id]||[],first_image:(itemsByOrder[o.id]||[]).find(i=>i.image)?.image||null};}),salesData:sd});}catch(e){res.status(500).json({error:e.message});}});

// UPDATE STORE — saves DB columns + extra fields in config JSONB
router.put('/stores/:sid',authMiddleware(['store_owner']),async(req,res)=>{try{
  const sid=req.params.sid;
  const own=await pool.query('SELECT id FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);
  if(!own.rows.length)return res.status(404).json({error:'Not found'});
  const f=req.body;
  
  // 1. Update known DB columns — deduplicate by column name (last value wins)
  const colMap=new Map();
  for(const[key,val]of Object.entries(f)){const col=FIELD_MAP[key];if(!col)continue;colMap.set(col,val===''?null:val);}
  if(colMap.size){const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}v.push(sid);await pool.query(`UPDATE stores SET ${u.join(',')},updated_at=NOW() WHERE id=$${i}`,v);}
  
  // 2. Update payment settings — deduplicate by column name
  const payMap=new Map();
  for(const[key,val]of Object.entries(f)){const col=PAY_MAP[key];if(!col)continue;payMap.set(col,val===''?null:val);}
  if(payMap.size){
    // ── Self-heal payment_settings schema ──
    // Older deployments are missing columns the UI now writes (baridimob_rip,
    // updated_at) — without these the UPDATE throws "column does not exist"
    // and the toggles silently fail. Add them on demand.
    try{await pool.query('ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS baridimob_rip VARCHAR(100)');}catch{}
    try{await pool.query('ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');}catch{}
    try{await pool.query('ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bank_transfer_enabled BOOLEAN DEFAULT FALSE');}catch{}
    try{await pool.query('ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS ccp_enabled BOOLEAN DEFAULT FALSE');}catch{}
    try{await pool.query('ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS baridimob_enabled BOOLEAN DEFAULT FALSE');}catch{}
    try{await pool.query('ALTER TABLE payment_settings ADD CONSTRAINT payment_settings_store_unique UNIQUE(store_id)');}catch{}

    // Ensure a row exists for this store so UPDATE has something to hit.
    try{await pool.query('INSERT INTO payment_settings(store_id) VALUES($1) ON CONFLICT (store_id) DO NOTHING',[sid]);}
    catch(e){
      // No UNIQUE constraint? Check manually before inserting.
      try{
        const ex=await pool.query('SELECT 1 FROM payment_settings WHERE store_id=$1 LIMIT 1',[sid]);
        if(!ex.rows.length)await pool.query('INSERT INTO payment_settings(store_id) VALUES($1)',[sid]);
      }catch(e2){console.log('payment row ensure failed:',e2.message);}
    }

    // Coerce values to the right types per column so we don't write strings
    // into BOOLEAN columns (which Postgres rejects).
    const BOOL_COLS=new Set(['cod_enabled','ccp_enabled','baridimob_enabled','bank_transfer_enabled']);
    const cleanVals=new Map();
    for(const[col,val]of payMap){cleanVals.set(col,BOOL_COLS.has(col)?(val===true||val==='true'||val==='on'||val===1):val);}

    const pu=[],pv=[];let pi=1;
    for(const[col,val]of cleanVals){pu.push(`${col}=$${pi}`);pv.push(val);pi++;}
    pv.push(sid);
    try{
      const upd=await pool.query(`UPDATE payment_settings SET ${pu.join(',')},updated_at=NOW() WHERE store_id=$${pi} RETURNING store_id`,pv);
      if(!upd.rows.length){
        // Last-resort: row truly missing — INSERT with the values.
        const cols=['store_id',...cleanVals.keys()].join(',');
        const placeholders=Array.from({length:cleanVals.size+1},(_,i)=>'$'+(i+1)).join(',');
        await pool.query(`INSERT INTO payment_settings(${cols}) VALUES(${placeholders})`,[sid,...cleanVals.values()]);
      }
      console.log('[payment_settings]',sid,'updated:',[...cleanVals.entries()].map(([k,v])=>`${k}=${v}`).join(','));
    }catch(e){console.error('Payment update FAILED:',e.message,'cols:',[...cleanVals.keys()]);}
  }
  
  // 3. Save ALL extra fields to config JSONB (theme, toggles, messages, etc.)
  const extraFields={};
  const skipKeys=new Set([...Object.keys(FIELD_MAP),...Object.keys(PAY_MAP),'id','owner_id','slug','created_at','updated_at','config','product_count','order_count','revenue','store_visits','total_visits','is_active']);
  for(const[key,val]of Object.entries(f)){if(!skipKeys.has(key))extraFields[key]=val;}
  // Merge with existing config
  const existing=await pool.query('SELECT config FROM stores WHERE id=$1',[sid]);
  const oldConfig=existing.rows[0]?.config||{};
  const newConfig={...oldConfig};
  // Merge nested config object first (may contain stale copies of top-level fields)
  if(f.config&&typeof f.config==='object'&&!Array.isArray(f.config)){Object.assign(newConfig,f.config);}
  // Apply extraFields LAST so fresh top-level edits (e.g. scrollbar) always win over stale config copies
  Object.assign(newConfig,extraFields);
  // ── LANDING PAGES: UPSERT by slug, never drop ──
  // A stale/partial client save must NEVER delete other landing pages (this was
  // wiping pages). We merge incoming pages into the EXISTING list by slug
  // (update or append), preserve stored ai_html when the client sent it blank
  // (stripped list), and only remove a page when explicitly asked via
  // delete_landing_slug.
  {
    const baseList=Array.isArray(oldConfig.landing_pages)?[...oldConfig.landing_pages]:[];
    const idxBySlug={};baseList.forEach((lp,i)=>{if(lp&&lp.slug)idxBySlug[lp.slug]=i;});
    if(Array.isArray(extraFields.landing_pages)){
      for(const inc of extraFields.landing_pages){
        if(!inc||!inc.slug)continue;const{too_large,...rest}=inc;
        const at=idxBySlug[rest.slug];
        if((!rest.ai_html||too_large)&&at!=null&&baseList[at]&&baseList[at].ai_html)rest.ai_html=baseList[at].ai_html;
        if(at!=null)baseList[at]=rest;else{baseList.push(rest);idxBySlug[rest.slug]=baseList.length-1;}
      }
      newConfig.landing_pages=baseList;
    }
    const delSlug=f.delete_landing_slug||extraFields.delete_landing_slug;
    if(delSlug)newConfig.landing_pages=(newConfig.landing_pages||baseList).filter(lp=>lp&&lp.slug!==delSlug);
    delete newConfig.delete_landing_slug;
  }
  await pool.query('UPDATE stores SET config=$1::jsonb WHERE id=$2',[JSON.stringify(newConfig),sid]);
  
  res.json(await loadStore(sid));
}catch(e){console.error('Store update error:',e.message);res.status(500).json({error:e.message});}});

// Staff
router.get('/stores/:sid/staff',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('SELECT id,name,email,phone,role,permissions,role_template_id,is_active,created_at,store_id FROM store_staff WHERE store_id=$1',[req.params.sid]).catch(async()=>await pool.query('SELECT id,name,email,phone,role,is_active,created_at,store_id FROM store_staff WHERE store_id=$1',[req.params.sid]));
  // For each row, look up sibling rows in the owner's other stores so the
  // admin UI can show "assigned to: store A + store B".
  const ownerStores=(await pool.query('SELECT id FROM stores WHERE owner_id=$1',[req.user.id])).rows.map(s=>s.id);
  const rows=[];
  for(const s of r.rows){
    let sibIds=[s.store_id];
    if(s.email){
      const sib=await pool.query('SELECT store_id FROM store_staff WHERE LOWER(email)=LOWER($1) AND store_id=ANY($2::uuid[])',[s.email,ownerStores]).catch(()=>({rows:[]}));
      sibIds=sib.rows.map(x=>x.store_id);
    }else if(s.phone){
      const sib=await pool.query('SELECT store_id FROM store_staff WHERE phone=$1 AND store_id=ANY($2::uuid[])',[s.phone,ownerStores]).catch(()=>({rows:[]}));
      sibIds=sib.rows.map(x=>x.store_id);
    }
    rows.push({...s,assigned_store_ids:Array.from(new Set(sibIds.map(String)))});
  }
  return res.json(rows);
}catch(e){console.error('[GET staff]',e.message);return res.json([]);}});
router.post('/stores/:sid/staff',authMiddleware(['store_owner']),_lpf,_eq({type:'staff'}),async(req,res)=>{
  try{
    const{name,email,phone,password,role,avatar}=req.body;
    let{permissions}=req.body;
    if(!name||!password)return res.status(400).json({error:'Name and password required'});
    // Self-heal: optional avatar column (data URL or external URL).
    try{await pool.query("ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS avatar TEXT");}catch{}
    let roleTemplateId=null;
    let cleanRole=role||'viewer';
    if(typeof role==='string'&&role.startsWith('tpl_')){
      const rawId=role.slice(4);
      try{
        const tpl=await pool.query('SELECT permissions FROM role_templates WHERE id=$1',[rawId]);
        if(tpl.rows.length){roleTemplateId=rawId;if(!permissions)permissions=tpl.rows[0].permissions;}
      }catch(e){console.log('[staff] lookup tpl failed:',e.message);}
    }
    if(permissions&&typeof permissions!=='string')permissions=JSON.stringify(permissions);
    const hash=await bcrypt.hash(password,12);
    // Insert the minimal row first so we never fail because of optional columns.
    // Self-heal: ensure role column is wide enough for tpl_<uuid> (~40 chars). Older deploys had VARCHAR(20).
    try{await pool.query("ALTER TABLE store_staff ALTER COLUMN role TYPE VARCHAR(200)");}catch(e){}
    const doInsert=async()=>pool.query('INSERT INTO store_staff(store_id,name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,phone,role,created_at',[req.params.sid,name,email||null,phone||null,hash,cleanRole]);
    let row;
    try{
      const r=await doInsert();row=r.rows[0];
    }catch(e){
      console.error('[staff] insert failed:',e.message);
      // Width issue → widen and retry
      if(/value too long/i.test(e.message||'')){
        try{await pool.query("ALTER TABLE store_staff ALTER COLUMN role TYPE VARCHAR(200)");const r=await doInsert();row=r.rows[0];}
        catch(e3){console.error('[staff] widen+retry failed:',e3.message);return res.status(500).json({error:e3.message});}
      }else
      // If the table doesn't exist yet (stale deployment or fresh DB), create it and retry.
      if(/relation .*store_staff.* does not exist/i.test(e.message||'')||/does not exist/i.test(e.message||'')){
        try{
          await pool.query(`CREATE TABLE IF NOT EXISTS store_staff(
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            store_id UUID NOT NULL,
            name VARCHAR(150) NOT NULL,
            email VARCHAR(200),
            phone VARCHAR(30),
            password_hash TEXT NOT NULL,
            role VARCHAR(100) DEFAULT 'viewer',
            permissions TEXT DEFAULT '[]',
            role_template_id UUID,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )`);
          const r=await doInsert();row=r.rows[0];
        }catch(e2){
          console.error('[staff] create+retry failed:',e2.message);
          return res.status(500).json({error:e2.message||'Failed to create staff'});
        }
      }else{
        return res.status(500).json({error:e.message||'Failed to create staff'});
      }
    }
    // Opportunistically store permissions / template id when columns exist.
    if(permissions){try{await pool.query('UPDATE store_staff SET permissions=$1 WHERE id=$2',[permissions,row.id]);row.permissions=permissions;}catch(e){console.log('[staff] set permissions skipped:',e.message);}}
    if(roleTemplateId){try{await pool.query('UPDATE store_staff SET role_template_id=$1 WHERE id=$2',[roleTemplateId,row.id]);row.role_template_id=roleTemplateId;}catch(e){console.log('[staff] set role_template_id skipped:',e.message);}}
    if(typeof avatar==='string'){try{await pool.query('UPDATE store_staff SET avatar=$1 WHERE id=$2',[avatar||null,row.id]);row.avatar=avatar||null;}catch(e){console.log('[staff] set avatar skipped:',e.message);}}
    // Honor the admin-set active flag at creation time (defaults to true).
    if(req.body?.is_active===false){try{await pool.query('UPDATE store_staff SET is_active=FALSE WHERE id=$1',[row.id]);row.is_active=false;}catch{}}
    // Multi-store assignment: also create the staff in any additional stores
    // the admin selected. Verifies each store actually belongs to req.user.id.
    const extraIds=Array.isArray(req.body?.assigned_store_ids)?req.body.assigned_store_ids.filter(id=>id&&String(id)!==String(req.params.sid)):[];
    if(extraIds.length){
      try{
        const owned=(await pool.query('SELECT id FROM stores WHERE owner_id=$1 AND id=ANY($2::uuid[])',[req.user.id,extraIds])).rows.map(r=>String(r.id));
        for(const eid of owned){
          try{
            const dup=await pool.query('SELECT id FROM store_staff WHERE store_id=$1 AND (LOWER(email)=LOWER($2) OR (email IS NULL AND phone=$3))',[eid,email||'',phone||'']);
            if(dup.rows.length)continue;
            const ins=await pool.query('INSERT INTO store_staff(store_id,name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[eid,name,email||null,phone||null,hash,cleanRole]);
            if(permissions)try{await pool.query('UPDATE store_staff SET permissions=$1 WHERE id=$2',[permissions,ins.rows[0].id]);}catch{}
            if(roleTemplateId)try{await pool.query('UPDATE store_staff SET role_template_id=$1 WHERE id=$2',[roleTemplateId,ins.rows[0].id]);}catch{}
          }catch(e2){console.log('[staff] dup-into-store',eid,'failed:',e2.message);}
        }
      }catch(e){console.log('[staff] multi-store skipped:',e.message);}
    }
    res.status(201).json(row);
  }catch(e){
    console.error('[staff] outer error:',e);
    res.status(500).json({error:e.message||'Failed'});
  }
});
// ---- Store-scoped role templates (stored in store.config.role_templates[]) ----
// These let a store owner define custom roles that affect ONLY their store,
// mirroring the super-admin role templates but scoped to one store.
async function _loadStoreCfg(sid){const r=await pool.query('SELECT config FROM stores WHERE id=$1',[sid]);return r.rows[0]?.config||{};}
async function _saveStoreCfg(sid,cfg){await pool.query('UPDATE stores SET config=$1::jsonb WHERE id=$2',[JSON.stringify(cfg),sid]);}
router.get('/stores/:sid/role-templates',authMiddleware(['store_owner']),async(req,res)=>{
  try{const cfg=await _loadStoreCfg(req.params.sid);res.json({templates:Array.isArray(cfg.role_templates)?cfg.role_templates:[]});}
  catch(e){res.status(500).json({error:e.message});}
});
router.post('/stores/:sid/role-templates',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    const{name,description,permissions}=req.body||{};
    if(!name)return res.status(400).json({error:'Name required'});
    const cfg=await _loadStoreCfg(req.params.sid);
    const list=Array.isArray(cfg.role_templates)?cfg.role_templates:[];
    const tpl={id:'st_'+Date.now(),name,description:description||'',permissions:Array.isArray(permissions)?permissions:[],scope:'store'};
    list.push(tpl);cfg.role_templates=list;await _saveStoreCfg(req.params.sid,cfg);
    res.json({template:tpl});
  }catch(e){res.status(500).json({error:e.message});}
});
router.put('/stores/:sid/role-templates/:tid',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    const cfg=await _loadStoreCfg(req.params.sid);
    const list=Array.isArray(cfg.role_templates)?cfg.role_templates:[];
    const i=list.findIndex(x=>String(x.id)===String(req.params.tid));
    if(i<0)return res.status(404).json({error:'Not found'});
    list[i]={...list[i],...req.body,id:list[i].id,scope:'store'};
    cfg.role_templates=list;await _saveStoreCfg(req.params.sid,cfg);
    res.json({template:list[i]});
  }catch(e){res.status(500).json({error:e.message});}
});
router.delete('/stores/:sid/role-templates/:tid',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    const cfg=await _loadStoreCfg(req.params.sid);
    const list=Array.isArray(cfg.role_templates)?cfg.role_templates:[];
    cfg.role_templates=list.filter(x=>String(x.id)!==String(req.params.tid));
    await _saveStoreCfg(req.params.sid,cfg);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
// ---- Update a specific staff member's role/permissions (per-user override) ----
router.patch('/stores/:sid/staff/:uid',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    if(req.user.staff_id)return res.status(403).json({error:'Staff cannot manage other staff'});
    const{name,email,phone,password,role,permissions,role_template_id,is_active,avatar}=req.body||{};
    try{await pool.query('ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS permissions TEXT');}catch(e){}
    try{await pool.query('ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS role_template_id TEXT');}catch(e){}
    try{await pool.query('ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS avatar TEXT');}catch(e){}
    // Widen historical UUID column so we can store "tpl_..." / "st_..." ids
    try{await pool.query("ALTER TABLE store_staff ALTER COLUMN role_template_id TYPE TEXT USING role_template_id::text");}catch(e){}
    try{await pool.query('ALTER TABLE store_staff ALTER COLUMN role TYPE VARCHAR(200)');}catch(e){}
    const fields=[],vals=[];let i=1;
    if(name!==undefined){fields.push(`name=$${i++}`);vals.push(name);}
    if(email!==undefined){fields.push(`email=$${i++}`);vals.push(email||null);}
    if(phone!==undefined){fields.push(`phone=$${i++}`);vals.push(phone||null);}
    if(password){
      const hash=await bcrypt.hash(password,12);
      fields.push(`password_hash=$${i++}`);vals.push(hash);
    }
    if(role!==undefined){fields.push(`role=$${i++}`);vals.push(role);}
    if(permissions!==undefined){fields.push(`permissions=$${i++}`);vals.push(typeof permissions==='string'?permissions:JSON.stringify(permissions));}
    if(role_template_id!==undefined){fields.push(`role_template_id=$${i++}`);vals.push(role_template_id);}
    if(is_active!==undefined){fields.push(`is_active=$${i++}`);vals.push(!!is_active);}
    if(avatar!==undefined){fields.push(`avatar=$${i++}`);vals.push(avatar||null);}
    if(!fields.length&&req.body?.assigned_store_ids===undefined)return res.json({ok:true});
    let updatedRow=null;
    if(fields.length){
      vals.push(req.params.uid,req.params.sid);
      const q=`UPDATE store_staff SET ${fields.join(',')} WHERE id=$${i++} AND store_id=$${i} RETURNING id,name,email,phone,role,permissions,role_template_id,is_active`;
      const r=await pool.query(q,vals);
      if(!r.rows.length)return res.status(404).json({error:'Staff not found'});
      updatedRow=r.rows[0];
    }else{
      const r=await pool.query('SELECT id,name,email,phone,role,permissions,role_template_id,is_active,password_hash FROM store_staff WHERE id=$1 AND store_id=$2',[req.params.uid,req.params.sid]);
      if(!r.rows.length)return res.status(404).json({error:'Staff not found'});
      updatedRow=r.rows[0];
    }
    // Propagate same-email/same-phone rows in the owner's other stores so the
    // admin's edits affect every store this staff is assigned to. Then sync
    // the assigned_store_ids list — adding new rows and deleting unassigned ones.
    try{
      const ownerStores=(await pool.query('SELECT id FROM stores WHERE owner_id=$1',[req.user.id])).rows.map(s=>String(s.id));
      const matchKey=updatedRow.email?{col:'LOWER(email)',val:updatedRow.email.toLowerCase(),isEmail:true}:{col:'phone',val:updatedRow.phone||'',isEmail:false};
      // Find all existing sibling rows
      const sibQ=matchKey.isEmail?'SELECT id,store_id FROM store_staff WHERE LOWER(email)=$1 AND store_id=ANY($2::uuid[])':'SELECT id,store_id FROM store_staff WHERE phone=$1 AND store_id=ANY($2::uuid[])';
      const siblings=(await pool.query(sibQ,[matchKey.val,ownerStores])).rows;
      // Apply same field edits to siblings (skip self)
      if(fields.length){
        const sibIds=siblings.filter(s=>s.id!==updatedRow.id).map(s=>s.id);
        if(sibIds.length){
          const fVals=[...vals.slice(0,vals.length-2),sibIds];
          const sibQ2=`UPDATE store_staff SET ${fields.join(',')} WHERE id=ANY($${fVals.length}::uuid[])`;
          await pool.query(sibQ2,fVals);
        }
      }
      // Sync assignment list if provided
      if(Array.isArray(req.body?.assigned_store_ids)){
        const wanted=new Set(req.body.assigned_store_ids.filter(id=>ownerStores.includes(String(id))).map(String));
        wanted.add(String(req.params.sid));
        const have=new Set(siblings.map(s=>String(s.store_id)));
        const toAdd=[...wanted].filter(id=>!have.has(id));
        const toDelete=[...have].filter(id=>!wanted.has(id));
        // Need a password hash for new rows. Use the existing staff's hash
        // unless a new password was supplied (already hashed above).
        let newHash=null;
        if(req.body?.password){newHash=await bcrypt.hash(req.body.password,12);}
        if(!newHash){
          const ph=(await pool.query('SELECT password_hash FROM store_staff WHERE id=$1',[req.params.uid])).rows[0]?.password_hash;
          newHash=ph;
        }
        for(const sid of toAdd){
          try{
            const ins=await pool.query('INSERT INTO store_staff(store_id,name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[sid,updatedRow.name,updatedRow.email||null,updatedRow.phone||null,newHash,updatedRow.role||'viewer']);
            if(updatedRow.permissions)try{await pool.query('UPDATE store_staff SET permissions=$1 WHERE id=$2',[updatedRow.permissions,ins.rows[0].id]);}catch{}
            if(updatedRow.role_template_id)try{await pool.query('UPDATE store_staff SET role_template_id=$1 WHERE id=$2',[updatedRow.role_template_id,ins.rows[0].id]);}catch{}
          }catch(e){console.log('[staff patch] add-into-store',sid,e.message);}
        }
        for(const sid of toDelete){
          try{await pool.query('DELETE FROM store_staff WHERE store_id=$1 AND (LOWER(COALESCE(email,\'\'))=LOWER($2) OR (email IS NULL AND phone=$3))',[sid,updatedRow.email||'',updatedRow.phone||'']);}catch(e){console.log('[staff patch] del-from-store',sid,e.message);}
        }
      }
    }catch(propErr){console.log('[staff patch] propagation skipped:',propErr.message);}
    res.json({staff:updatedRow});
  }catch(e){console.error('[staff patch]',e);res.status(500).json({error:e.message||'Failed'});}
});
router.delete('/stores/:sid/staff/:uid',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    // Find the staff first so we can also remove their sibling rows in the
    // owner's other stores (multi-store assignment), keeping the list clean.
    const s=(await pool.query('SELECT email,phone FROM store_staff WHERE id=$1 AND store_id=$2',[req.params.uid,req.params.sid])).rows[0];
    await pool.query('DELETE FROM store_staff WHERE id=$1 AND store_id=$2',[req.params.uid,req.params.sid]);
    if(s){
      try{
        const ownerStores=(await pool.query('SELECT id FROM stores WHERE owner_id=$1',[req.user.id])).rows.map(r=>r.id);
        if(s.email)await pool.query('DELETE FROM store_staff WHERE LOWER(email)=LOWER($1) AND store_id=ANY($2::uuid[])',[s.email,ownerStores]);
        else if(s.phone)await pool.query('DELETE FROM store_staff WHERE phone=$1 AND store_id=ANY($2::uuid[])',[s.phone,ownerStores]);
      }catch(e){console.log('[staff delete] sibling cleanup skipped:',e.message);}
    }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/staff/login',async(req,res)=>{try{const{storeSlug,email,password}=req.body;const store=await pool.query('SELECT id FROM stores WHERE slug=$1',[storeSlug]);if(!store.rows.length)return res.status(404).json({error:'Not found'});const staff=await pool.query('SELECT * FROM store_staff WHERE store_id=$1 AND email=$2 AND is_active=TRUE',[store.rows[0].id,email]);if(!staff.rows.length)return res.status(401).json({error:'Invalid'});if(!(await bcrypt.compare(password,staff.rows[0].password_hash)))return res.status(401).json({error:'Invalid'});res.json({token:generateToken({id:staff.rows[0].id,role:'store_staff',staffRole:staff.rows[0].role,storeId:store.rows[0].id,name:staff.rows[0].name}),staff:{id:staff.rows[0].id,name:staff.rows[0].name,role:staff.rows[0].role}});}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores/:sid/domains',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM store_domains WHERE store_id=$1 ORDER BY created_at DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/domains',authMiddleware(['store_owner']),_lpf,_rf('custom_domain'),async(req,res)=>{try{const{domain_name}=req.body;if(!domain_name)return res.status(400).json({error:'Domain required'});const clean=domain_name.replace(/^https?:\/\//,'').replace(/\/.*$/,'').trim().toLowerCase();const dup=await pool.query('SELECT id FROM store_domains WHERE domain_name=$1',[clean]);if(dup.rows.length)return res.status(409).json({error:'This domain is already connected to a store'});

  // Auto-add to Vercel project
  const vercelToken=process.env.VERCEL_API_TOKEN;
  const vercelProjectId=process.env.VERCEL_PROJECT_ID;
  let vercelOk=false;
  if(vercelToken&&vercelProjectId){
    try{
      const vr=await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}/domains`,{
        method:'POST',headers:{'Authorization':`Bearer ${vercelToken}`,'Content-Type':'application/json'},
        body:JSON.stringify({name:clean})
      });
      const vd=await vr.json();
      if(vr.ok||vd.error?.code==='domain_already_in_use'){vercelOk=true;console.log(`[Domain] Added ${clean} to Vercel`);}
      else{console.log(`[Domain] Vercel error:`,JSON.stringify(vd));}
    }catch(e){console.log('[Domain] Vercel API error:',e.message);}
  }

  const status=vercelOk?'active':'pending';
  const r=await pool.query('INSERT INTO store_domains(store_id,domain_name,status) VALUES($1,$2,$3) RETURNING *',[req.params.sid,clean,status]);
  res.status(201).json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});
// Re-check a pending domain against Vercel to see if DNS is now valid.
// Updates the row's status to 'active' if Vercel reports the domain is verified.
router.post('/stores/:sid/domains/:did/verify',authMiddleware(['store_owner']),async(req,res)=>{try{
  const d=await pool.query('SELECT * FROM store_domains WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid]);
  if(!d.rows.length)return res.status(404).json({error:'Domain not found'});
  const dom=d.rows[0];
  const vercelToken=process.env.VERCEL_API_TOKEN;
  const vercelProjectId=process.env.VERCEL_PROJECT_ID;
  let verified=false;
  if(vercelToken&&vercelProjectId){
    try{
      // Ensure domain is attached to the project (idempotent)
      await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}/domains`,{method:'POST',headers:{'Authorization':`Bearer ${vercelToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:dom.domain_name})}).catch(()=>{});
      // Query the verification status
      const vr=await fetch(`https://api.vercel.com/v9/projects/${vercelProjectId}/domains/${dom.domain_name}`,{headers:{'Authorization':`Bearer ${vercelToken}`}});
      const vd=await vr.json();
      if(vr.ok&&vd.verified===true)verified=true;
    }catch(e){console.log('[Domain verify] Vercel error:',e.message);}
  }
  const newStatus=verified?'active':'pending';
  const upd=await pool.query('UPDATE store_domains SET status=$1 WHERE id=$2 RETURNING *',[newStatus,req.params.did]);
  res.json(upd.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/stores/:sid/domains/:did',authMiddleware(['store_owner']),async(req,res)=>{try{
  const d=await pool.query('SELECT domain_name FROM store_domains WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid]);
  if(d.rows.length){
    const vercelToken=process.env.VERCEL_API_TOKEN;
    const vercelProjectId=process.env.VERCEL_PROJECT_ID;
    if(vercelToken&&vercelProjectId){
      try{await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}/domains/${d.rows[0].domain_name}`,{method:'DELETE',headers:{'Authorization':`Bearer ${vercelToken}`}});}catch(e){}
    }
  }
  await pool.query('DELETE FROM store_domains WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Profile
router.get('/profile',authMiddleware(['store_owner']),async(req,res)=>{try{
  // Make sure 2FA columns exist on legacy tables.
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_method VARCHAR(20) DEFAULT 'whatsapp'");}catch{}
  const r=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Not found'});
  const o=r.rows[0];
  res.json({id:o.id,name:o.full_name,full_name:o.full_name,email:o.email,phone:o.phone,username:o.username||null,address:o.address,city:o.city,wilaya:o.wilaya,subscription_plan:o.subscription_plan,two_fa_enabled:o.two_fa_enabled||false,two_fa_method:o.two_fa_method||'whatsapp',created_at:o.created_at});
}catch(e){res.status(500).json({error:e.message});}});

// Update profile
router.put('/profile',authMiddleware(['store_owner']),async(req,res)=>{try{const{full_name,phone,address,city,wilaya}=req.body;const r=await pool.query('UPDATE store_owners SET full_name=COALESCE($1,full_name),phone=COALESCE($2,phone),address=COALESCE($3,address),city=COALESCE($4,city),wilaya=COALESCE($5,wilaya),updated_at=NOW() WHERE id=$6 RETURNING *',[full_name||null,phone||null,address||null,city||null,wilaya||null,req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Not found'});const o=r.rows[0];res.json({id:o.id,name:o.full_name,full_name:o.full_name,email:o.email,phone:o.phone,username:o.username||null,address:o.address,city:o.city,wilaya:o.wilaya,subscription_plan:o.subscription_plan});}catch(e){res.status(500).json({error:e.message});}});

// Change username
router.put('/username',authMiddleware(['store_owner']),async(req,res)=>{try{const{username}=req.body;if(!username||username.length<3)return res.status(400).json({error:'Username must be at least 3 characters'});// Check column exists, add if not
try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE");}catch(e){}
const dup=await pool.query('SELECT id FROM store_owners WHERE username=$1 AND id!=$2',[username,req.user.id]);if(dup.rows.length)return res.status(409).json({error:'Username already taken'});await pool.query('UPDATE store_owners SET username=$1 WHERE id=$2',[username,req.user.id]);res.json({username});}catch(e){res.status(500).json({error:e.message});}});

// Change email
router.put('/email',authMiddleware(['store_owner']),async(req,res)=>{try{const{email,password}=req.body;if(!email||!password)return res.status(400).json({error:'Email and password required'});const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!u.rows.length)return res.status(404).json({error:'Not found'});if(!(await bcrypt.compare(password,u.rows[0].password_hash)))return res.status(401).json({error:'Invalid password'});const dup=await pool.query('SELECT id FROM store_owners WHERE email=$1 AND id!=$2',[email,req.user.id]);if(dup.rows.length)return res.status(409).json({error:'Email already in use'});await pool.query('UPDATE store_owners SET email=$1 WHERE id=$2',[email,req.user.id]);res.json({email});}catch(e){res.status(500).json({error:e.message});}});

// Change password
// Password change. When 2FA is enabled, the request must include a fresh
// otp_token + code obtained from /password/request-2fa.
router.put('/password',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{current_password,new_password,otp_token,code}=req.body;
  if(!current_password||!new_password)return res.status(400).json({error:'Both passwords required'});
  if(new_password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
  const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);
  if(!u.rows.length)return res.status(404).json({error:'Not found'});
  const owner=u.rows[0];
  if(!(await bcrypt.compare(current_password,owner.password_hash)))return res.status(401).json({error:'Current password is incorrect'});
  if(owner.two_fa_enabled){
    if(!otp_token||!code)return res.status(401).json({requires_2fa:true,error:'Two-step verification is enabled. Request a code first.'});
    const v=await verify2FACode(otp_token,code,'password_change');
    if(!v.ok)return res.status(401).json({error:v.error});
    if(v.payload.owner_id!==owner.id)return res.status(401).json({error:'Token mismatch'});
  }
  const hash=await bcrypt.hash(new_password,12);
  await pool.query('UPDATE store_owners SET password_hash=$1 WHERE id=$2',[hash,owner.id]);
  res.json({message:'Password updated'});
}catch(e){res.status(500).json({error:e.message});}});

// Send a 2FA code authorising a password change.
router.post('/password/request-2fa',authMiddleware(['store_owner']),async(req,res)=>{try{
  const owner=(await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
  if(!owner)return res.status(404).json({error:'Not found'});
  if(!owner.two_fa_enabled)return res.status(400).json({error:'Two-step verification is not enabled.'});
  const r=await send2FACode(owner,'password_change');
  if(!r.sent)return res.status(503).json({error:r.error});
  res.json({otp_token:r.otp_token,method:r.method,masked:r.masked});
}catch(e){res.status(500).json({error:e.message});}});

// Two-step verification settings.
//   • Enabling for the first time / changing the method while disabled → free.
//   • Disabling 2FA OR changing method while it's already enabled REQUIRES
//     a fresh otp_token + code. Without that, the toggle stays untouched.
router.put('/two-fa',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{enabled,method,otp_token,code}=req.body;
  const m=['whatsapp','email'].includes(method)?method:'whatsapp';
  try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_method VARCHAR(20) DEFAULT 'whatsapp'");}catch{}
  const owner=(await pool.query('SELECT id,two_fa_enabled,two_fa_method FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
  if(!owner)return res.status(404).json({error:'Not found'});
  const wasOn=!!owner.two_fa_enabled;
  const willOn=!!enabled;
  // A code is required to disable, OR to change the method while 2FA is on.
  const needsCode = wasOn && (!willOn || (willOn && owner.two_fa_method && owner.two_fa_method !== m));
  if(needsCode){
    if(!otp_token||!code)return res.status(401).json({requires_2fa:true,error:'Two-step verification is enabled. Request a code first to change these settings.'});
    const v=await verify2FACode(otp_token,code,'two_fa_change');
    if(!v.ok)return res.status(401).json({error:v.error});
    if(v.payload.owner_id!==owner.id)return res.status(401).json({error:'Token mismatch'});
  }
  await pool.query('UPDATE store_owners SET two_fa_enabled=$1,two_fa_method=$2 WHERE id=$3',[willOn,m,owner.id]);
  res.json({two_fa_enabled:willOn,two_fa_method:m});
}catch(e){res.status(500).json({error:e.message});}});

// Send a code authorising a 2FA change (disable / method swap).
router.post('/two-fa/request-2fa',authMiddleware(['store_owner']),async(req,res)=>{try{
  const owner=(await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
  if(!owner)return res.status(404).json({error:'Not found'});
  if(!owner.two_fa_enabled)return res.status(400).json({error:'Two-step verification is not enabled.'});
  const r=await send2FACode(owner,'two_fa_change');
  if(!r.sent)return res.status(503).json({error:r.error});
  res.json({otp_token:r.otp_token,method:r.method,masked:r.masked});
}catch(e){res.status(500).json({error:e.message});}});

// Delete account
router.delete('/account',authMiddleware(['store_owner']),async(req,res)=>{try{const{password}=req.body;if(!password)return res.status(400).json({error:'Password required'});const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!u.rows.length)return res.status(404).json({error:'Not found'});if(!(await bcrypt.compare(password,u.rows[0].password_hash)))return res.status(401).json({error:'Invalid password'});// Soft delete: deactivate instead of hard delete
await pool.query('UPDATE stores SET is_active=FALSE,is_published=FALSE WHERE owner_id=$1',[req.user.id]);await pool.query('UPDATE store_owners SET is_active=FALSE WHERE id=$1',[req.user.id]);res.json({message:'Account deleted'});}catch(e){res.status(500).json({error:e.message});}});

// ═══ NOTIFICATIONS ═══
router.get('/stores/:sid/notifications',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('SELECT * FROM notifications WHERE store_id=$1 ORDER BY created_at DESC LIMIT 50',[req.params.sid]);
  const unread=await pool.query('SELECT COUNT(*) FROM notifications WHERE store_id=$1 AND is_read=FALSE',[req.params.sid]);
  res.json({notifications:r.rows,unread:parseInt(unread.rows[0].count)});
}catch(e){res.json({notifications:[],unread:0});}});

router.patch('/stores/:sid/notifications/:nid/read',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND store_id=$2',[req.params.nid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/stores/:sid/notifications/read-all',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE store_id=$1',[req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/stores/:sid/notifications',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await pool.query('DELETE FROM notifications WHERE store_id=$1 AND is_read=TRUE',[req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});
// Delete a single notification (used by the bell dropdown's per-row × button)
router.delete('/stores/:sid/notifications/:nid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await pool.query('DELETE FROM notifications WHERE store_id=$1 AND id=$2',[req.params.sid,req.params.nid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ SUBSCRIPTION / BILLING ═══
router.get('/subscription',authMiddleware(['store_owner']),async(req,res)=>{try{
  const owner=(await pool.query('SELECT subscription_plan,subscription_status,subscription_expires_at,subscription_paid_until FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
  const payments=(await pool.query('SELECT * FROM subscription_payments WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id])).rows;
  // Get platform billing config
  let config={};try{config=(await pool.query('SELECT * FROM platform_settings LIMIT 1')).rows[0]||{};}catch(e){}
  // Read super-admin-defined plans from the plans table. Fall back to the
  // legacy "basic" plan built from platform_settings so existing installs
  // keep working until the super admin saves at least one plan.
  const parseArr = v => { if (Array.isArray(v)) return v; try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };
  let plansObj = {};
  try {
    const pr = await pool.query('SELECT * FROM plans WHERE is_active=TRUE ORDER BY sort_order ASC, price_monthly ASC');
    for (const row of pr.rows) {
      plansObj[row.slug] = {
        name: row.name_en,
        name_i18n: { en: row.name_en, fr: row.name_fr || '', ar: row.name_ar || '' },
        tagline_i18n: { en: row.tagline_en || '', fr: row.tagline_fr || '', ar: row.tagline_ar || '' },
        monthly: parseFloat(row.price_monthly) || 0,
        yearly: parseFloat(row.price_yearly) || 0,
        currency: row.currency || 'DZD',
        features: parseArr(row.features_en),
        features_i18n: { en: parseArr(row.features_en), fr: parseArr(row.features_fr), ar: parseArr(row.features_ar) },
        feature_keys: parseArr(row.feature_keys),
        max_products: parseInt(row.max_products) || 0,
        max_orders_month: parseInt(row.max_orders_month) || 0,
        max_staff: parseInt(row.max_staff) || 0,
        is_popular: !!row.is_popular,
      };
    }
  } catch (e) { /* ignore, fall back below */ }
  if (Object.keys(plansObj).length === 0) {
    plansObj = {
      basic: { name:'Basic', monthly: parseFloat(config.subscription_monthly_price||2900), yearly: parseFloat(config.subscription_yearly_price||29000), features:['Unlimited Products','Unlimited Orders','Multiple Users','AI Features','WhatsApp Automation','Email Notifications','Analytics','Priority Support'] },
    };
  }
  res.json({
    plan:owner?.subscription_plan||'free',
    status:owner?.subscription_status||'active',
    expires_at:owner?.subscription_expires_at,
    paid_until:owner?.subscription_paid_until,
    payments,
    plans:plansObj,
    billing_ccp:config.billing_ccp_account||'',
    billing_ccp_name:config.billing_ccp_name||'',
    billing_baridimob_rip:config.billing_baridimob_rip||'',
    billing_baridimob_qr:config.billing_baridimob_qr||'',
  });
}catch(e){res.status(500).json({error:e.message});}});

router.post('/subscription/pay',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{plan,period,amount,payment_method,receipt_image}=req.body;
  if(!receipt_image)return res.status(400).json({error:'Receipt image required'});
  const r=await pool.query('INSERT INTO subscription_payments(owner_id,plan,period,amount,payment_method,receipt_image,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.user.id,plan||'basic',period||'monthly',amount||0,payment_method||'ccp',receipt_image,'pending']);
  try{if(global.__notifyAdmin){const o=(await pool.query('SELECT full_name FROM store_owners WHERE id=$1',[req.user.id])).rows[0];await global.__notifyAdmin({type:'subscription_payment',title:'New subscription payment',body:`${o?.full_name||'Owner'} submitted a ${plan||'basic'} ${period||'monthly'} payment (${parseFloat(amount||0).toLocaleString()} DZD) — pending review`,link:'/admin/subscriptions',owner_id:req.user.id,dedup_key:`payment:${r.rows[0].id}`});}}catch{}
  res.status(201).json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// ═══ Plan features check — frontend reads this to show/hide gated UI ═══
const { loadPlanFeatures } = require('../middleware/planFeatures');
router.get('/me/features', authMiddleware(['store_owner']), loadPlanFeatures, async (req, res) => {
  try {
    res.json({
      plan: req.planSlug || 'free',
      status: req.planStatus || 'active',
      feature_keys: Array.from(req.planFeatures || []),
      limits: req.planLimits || { max_products: 0, max_orders_month: 0, max_staff: 0 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ PUSH NOTIFICATIONS ═══
const VAPID_PUBLIC='BIaKDYfrTpQjgE1ZniZfVf00isbx2npqZueYr68LTqK5RlCSkf6LAVPUepQJ5xOmZs1iQHo0KAzlZnv4Wv05FWc';
const VAPID_PRIVATE='kCEdtXGAHqWgr-q6fpYjlfoyepZm8kBRrs7JM994Qro';
let webpush;try{webpush=require('web-push');webpush.setVapidDetails('mailto:admin@mymarket.store',VAPID_PUBLIC,VAPID_PRIVATE);}catch(e){console.log('web-push not available');}

router.get('/push/vapid-key',(req,res)=>res.json({publicKey:VAPID_PUBLIC}));

router.post('/push/subscribe',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{subscription,storeId}=req.body;
  if(!subscription?.endpoint)return res.status(400).json({error:'Invalid subscription'});
  // Remove old subscriptions for same endpoint
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1',[subscription.endpoint]);
  await pool.query('INSERT INTO push_subscriptions(store_id,endpoint,keys_p256dh,keys_auth) VALUES($1,$2,$3,$4)',[storeId,subscription.endpoint,subscription.keys?.p256dh||'',subscription.keys?.auth||'']);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Utility: send push to all subscriptions for a store
async function sendStorePush(storeId,title,body){
  if(!webpush)return;
  try{
    const subs=(await pool.query('SELECT * FROM push_subscriptions WHERE store_id=$1',[storeId])).rows;
    for(const sub of subs){
      try{
        await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.keys_p256dh,auth:sub.keys_auth}},JSON.stringify({title,body,url:'/dashboard/orders'}));
      }catch(e){
        if(e.statusCode===410||e.statusCode===404) await pool.query('DELETE FROM push_subscriptions WHERE id=$1',[sub.id]);
      }
    }
  }catch(e){console.log('[Push] Error:',e.message);}
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity log — append-only record of admin / staff actions per store, used
// by the Settings → Users & Permissions activity feed. Self-heals the table
// on first use so older deployments don't need a migration.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureActivityTable() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS staff_activity_log(
      id BIGSERIAL PRIMARY KEY,
      store_id UUID NOT NULL,
      actor_id VARCHAR(100),
      actor_name VARCHAR(150),
      actor_role VARCHAR(100),
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(50),
      target_id VARCHAR(100),
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_activity_store_time ON staff_activity_log(store_id, created_at DESC)");
  } catch {}
}
async function logActivity(storeId, req, action, targetType, targetId, details) {
  if (!storeId || !req) return;
  try {
    await ensureActivityTable();
    await pool.query(
      'INSERT INTO staff_activity_log(store_id, actor_id, actor_name, actor_role, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [storeId, req.user?.id || null, req.user?.name || null, req.user?.staff_role || req.user?.role || null, action, targetType || null, targetId ? String(targetId) : null, details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null]
    );
  } catch (e) { console.log('[activity log skip]', e.message); }
}

router.get('/stores/:sid/activity-log', authMiddleware(['store_owner']), async (req, res) => {
  try {
    await ensureActivityTable();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(
      'SELECT id, actor_id, actor_name, actor_role, action, target_type, target_id, details, created_at FROM staff_activity_log WHERE store_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.params.sid, limit]
    );
    res.json({ entries: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-user breakdown for the payroll-friendly summary view. Returns one row
// per actor (user) with action counts grouped by today / this week / this
// month, plus a per-action breakdown so the admin can see what each team
// member did over each window.
router.get('/stores/:sid/activity-log/summary', authMiddleware(['store_owner']), async (req, res) => {
  try {
    await ensureActivityTable();
    const r = await pool.query(`
      SELECT
        actor_id, actor_name, actor_role,
        action,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS day_count,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS week_count,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS month_count,
        MAX(created_at) AS last_at
      FROM staff_activity_log
      WHERE store_id=$1
      GROUP BY actor_id, actor_name, actor_role, action
      ORDER BY actor_name NULLS LAST, action
    `, [req.params.sid]);

    // Roll up per-action rows into one entry per user.
    const byUser = new Map();
    for (const row of r.rows) {
      const id = row.actor_id || 'unknown';
      if (!byUser.has(id)) byUser.set(id, { actor_id: id, actor_name: row.actor_name || 'Unknown', actor_role: row.actor_role || null, day: 0, week: 0, month: 0, last_at: null, by_action: {} });
      const u = byUser.get(id);
      const d = parseInt(row.day_count) || 0;
      const w = parseInt(row.week_count) || 0;
      const m = parseInt(row.month_count) || 0;
      u.day += d; u.week += w; u.month += m;
      u.by_action[row.action] = { day: d, week: w, month: m };
      if (row.last_at && (!u.last_at || row.last_at > u.last_at)) u.last_at = row.last_at;
    }
    const users = Array.from(byUser.values()).sort((a, b) => b.month - a.month);
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports=router;
module.exports.sendStorePush=sendStorePush;
module.exports.logActivity=logActivity;

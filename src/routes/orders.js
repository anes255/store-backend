const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware}=require('../middleware/auth');
const messaging=require('../services/messaging');
const{carrierRequest,carrierCreateOrder,carrierDeleteOrder,detectCarrier}=require('../services/carrierApi');
const{autoDispatchOrder,ensureSyncCols}=require('../services/carrierSync');
function formatOrderNumber(num,cfg){cfg=cfg||{};if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}const prefix=cfg.order_prefix||'ORD-';let suffix=cfg.order_suffix||'';if(suffix&&!suffix.startsWith('-'))suffix='-'+suffix;const start=parseInt(cfg.order_start_number)||0;const pad=parseInt(cfg.order_pad_length)||5;const n=(parseInt(num)||0)+(start>0?start-1:0);return `${prefix}${String(n).padStart(pad,'0')}${suffix}`;}
// Auto-archive orders older than store-configured days. Per-store, debounced in-memory.
const _lastArchiveRun={};
async function autoArchive(storeId,cfg){
  try{
    const enabled=cfg?.auto_archive!==false; // default on
    if(!enabled)return;
    const days=parseInt(cfg?.auto_archive_days)||30;
    const now=Date.now();
    if(_lastArchiveRun[storeId]&&now-_lastArchiveRun[storeId]<60000)return; // 1-min debounce
    _lastArchiveRun[storeId]=now;
    await pool.query(
      `UPDATE orders SET is_archived=TRUE,archived_at=NOW(),updated_at=NOW()
       WHERE store_id=$1 AND (is_archived IS NULL OR is_archived=FALSE)
       AND (is_deleted IS NULL OR is_deleted=FALSE)
       AND created_at < NOW() - ($2::int || ' days')::interval`,
      [storeId,days]
    );
  }catch(e){console.error('[autoArchive]',e.message);}
}
// Ensure orders.is_archived column exists (idempotent, awaited on first request)
let _archiveColReady=null;
function ensureArchiveCol(){
  if(!_archiveColReady){
    _archiveColReady=(async()=>{
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE');}catch(e){console.error('[orders is_archived]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');}catch(e){console.error('[orders archived_at]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE');}catch(e){console.error('[orders is_deleted]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');}catch(e){console.error('[orders deleted_at]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by UUID');}catch(e){console.error('[orders deleted_by]',e.message);}
    })();
  }
  return _archiveColReady;
}
ensureArchiveCol();

// Orders
router.get('/stores/:sid/orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  // Load store config once for auto-archive + custom order formatting
  let _storeCfg={};try{let _raw=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0]?.config||{};if(typeof _raw==='string'){try{_raw=JSON.parse(_raw);}catch{_raw={};}}_storeCfg=_raw;}catch(e){}
  autoArchive(req.params.sid,_storeCfg).catch(()=>{});
  const{status,search,archived,limit:rawLimit}=req.query;let q='SELECT * FROM orders WHERE store_id=$1';const p=[req.params.sid];
  // Configurable page size — default 500 (was 50, which prevented bulk-delete
  // from operating on more than the visible page). Capped at 2000 to keep the
  // response payload bounded.
  const limit=Math.min(2000,Math.max(1,parseInt(rawLimit)||500));
  // archived: 'only' = archived only, 'all' = active+archived (no deleted), 'vault' = EVERYTHING incl deleted, 'deleted' = only deleted, default = non-archived non-deleted
  if(archived==='vault'){/* no extra filter — all-time archive incl deleted */}
  else if(archived==='deleted')q+=' AND is_deleted=TRUE';
  else if(archived==='only')q+=' AND is_archived=TRUE';
  else if(archived==='all')q+=' AND (is_deleted IS NULL OR is_deleted=FALSE)';
  else q+=' AND (is_archived IS NULL OR is_archived=FALSE) AND (is_deleted IS NULL OR is_deleted=FALSE)';
  // Hide pending-payment orders (CCP/BaridiMob without receipt yet) — they
  // appear only after the buyer uploads their receipt in the second step.
  q+=" AND (status IS NULL OR status<>'pending_payment')";
  if(status&&status!=='all'){
    if(status==='preparing'){q+=` AND status IN ('preparing','under_preparation')`;}
    else{p.push(status);q+=` AND status=$${p.length}`;}
  }
  if(search){p.push(`%${search}%`);q+=` AND (customer_name ILIKE $${p.length} OR customer_phone ILIKE $${p.length} OR CAST(order_number AS TEXT) ILIKE $${p.length})`;}
  const cq=q.replace('SELECT *','SELECT COUNT(*)');q+=' ORDER BY created_at DESC LIMIT '+limit;
  let r,c;
  try{[r,c]=await Promise.all([pool.query(q,p),pool.query(cq,p)]);}
  catch(e){
    // Fallback: if is_archived column still missing, run query without archive filter
    console.error('[orders fallback]',e.message);
    let q2='SELECT * FROM orders WHERE store_id=$1';const p2=[req.params.sid];
    if(status&&status!=='all'){p2.push(status);q2+=` AND status=$${p2.length}`;}
    if(search){p2.push(`%${search}%`);q2+=` AND (customer_name ILIKE $${p2.length} OR customer_phone ILIKE $${p2.length} OR CAST(order_number AS TEXT) ILIKE $${p2.length})`;}
    const cq2=q2.replace('SELECT *','SELECT COUNT(*)');q2+=' ORDER BY created_at DESC LIMIT '+limit;
    [r,c]=await Promise.all([pool.query(q2,p2),pool.query(cq2,p2)]);
  }
  const ids=r.rows.map(o=>o.id);let itemsByOrder={};let receiptByOrder={};
  if(ids.length){try{const ir=await pool.query("SELECT oi.order_id,oi.product_id,oi.product_name,oi.product_image,oi.variant_info,oi.quantity,oi.unit_price,oi.total_price,p.images AS p_images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=ANY($1::uuid[])",[ids]);for(const it of ir.rows){let img=it.product_image||null;if(!img){try{const imgs=Array.isArray(it.p_images)?it.p_images:(typeof it.p_images==='string'?JSON.parse(it.p_images||'[]'):[]);img=imgs[0]||null;}catch(e){}}(itemsByOrder[it.order_id]=itemsByOrder[it.order_id]||[]).push({product_id:it.product_id,product_name:it.product_name,variant_info:it.variant_info,quantity:it.quantity,price:it.unit_price,total_price:it.total_price,image:img});}}catch(e){console.error('[order items join]',e.message);}}
  if(ids.length){try{const pr=await pool.query("SELECT DISTINCT ON (order_id) order_id,receipt_image,payment_method AS receipt_payment_method,status AS receipt_status FROM payment_receipts WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,created_at DESC",[ids]);for(const rc of pr.rows){receiptByOrder[rc.order_id]=rc;}}catch(e){/* payment_receipts table may not exist yet */}}
  let companyNameMap={};const dcIds=[...new Set(r.rows.filter(o=>o.delivery_company_id).map(o=>o.delivery_company_id))];
  if(dcIds.length){try{const dcr=await pool.query('SELECT id,name FROM delivery_companies WHERE id=ANY($1::uuid[])',[dcIds]);for(const dc of dcr.rows)companyNameMap[dc.id]=dc.name;}catch(e){}}
  let prefDcMap={};
  const prefIds=[...new Set(r.rows.map(o=>o.preferred_delivery_company_id).filter(Boolean))];
  if(prefIds.length){try{const dr=await pool.query('SELECT id,name FROM delivery_companies WHERE id=ANY($1::uuid[])',[prefIds]);for(const d of dr.rows)prefDcMap[d.id]=d.name;}catch(e){}}
  res.json({orders:r.rows.map(o=>{
    // For carrier-synced orders with missing data, try to fill from carrier_data
    let cd=o.carrier_data;if(typeof cd==='string')try{cd=JSON.parse(cd);}catch{cd=null;}
    const pick=(obj,...keys)=>{if(!obj)return'';for(const k of keys){if(obj[k])return String(obj[k]).trim();}return'';};
    // Also check nested objects (EcoTrack nests inside Colis[0])
    let cd2=null;if(cd?.Colis&&Array.isArray(cd.Colis))cd2=cd.Colis[0];
    const p=(k1,k2,k3,k4,k5,k6)=>pick(cd,k1,k2,k3,k4,k5,k6)||pick(cd2,k1,k2,k3,k4,k5,k6);
    const filledName=o.customer_name||p('firstname','client','Client','recipient','to_name','customer_name')||(p('familyname')?p('firstname')+' '+p('familyname'):'')||'';
    const filledPhone=o.customer_phone||p('contact_phone','to_commune_phone','phone','MobileA','MobileB','client_phone','customer_phone')||'';
    const filledWilaya=o.shipping_wilaya||p('to_wilaya_name','wilaya','Wilaya','shipping_wilaya','destination_text')||'';
    const filledCity=o.shipping_city||p('to_commune_name','commune','Commune','shipping_city')||'';
    const filledAddress=o.shipping_address||p('address','adresse','Adresse','shipping_address','destination_text')||'';
    // Build a synthetic item from carrier data if no order_items exist
    let items=itemsByOrder[o.id]||[];
    if(!items.length&&cd){
      const prodName=p('product_list','TProduit','produit','product','product_name','designation')||p('Designation','libelle','note','notes','remarque')||'';
      if(prodName)items=[{product_name:prodName,quantity:1,price:o.total||0}];
    }
    return{...o,customer_name:filledName,customer_phone:filledPhone,shipping_wilaya:filledWilaya,shipping_city:filledCity,shipping_address:filledAddress,order_number:formatOrderNumber(o.order_number,_storeCfg),discount_amount:o.discount,payment_method:o.payment_method||null,receipt_image:(receiptByOrder[o.id]||{}).receipt_image||null,items,first_image:(items).find(i=>i.image)?.image||null,delivery_company_name:companyNameMap[o.delivery_company_id]||null,preferred_delivery_company_name:prefDcMap[o.preferred_delivery_company_id]||null};
  }),total:parseInt(c.rows[0].count)});
}catch(e){console.error('[GET orders]',e.message);res.status(500).json({error:e.message});}});

// Archive / unarchive order
router.patch('/stores/:sid/orders/:oid/archive',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const archived=req.body?.archived!==false;
  const r=await pool.query('UPDATE orders SET is_archived=$1,archived_at=CASE WHEN $1 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *',[archived,req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true,is_archived:r.rows[0].is_archived});
}catch(e){res.status(500).json({error:e.message});}});

// Bulk archive
router.patch('/stores/:sid/orders/bulk-archive',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const{ids,archived}=req.body||{};
  if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'ids required'});
  const r=await pool.query('UPDATE orders SET is_archived=$1,archived_at=CASE WHEN $1 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=ANY($2::uuid[]) AND store_id=$3 RETURNING id',[archived!==false,ids,req.params.sid]);
  res.json({ok:true,count:r.rowCount});
}catch(e){res.status(500).json({error:e.message});}});

// Soft-delete order (still kept in vault archive)
router.delete('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const r=await pool.query('UPDATE orders SET is_deleted=TRUE,deleted_at=NOW(),deleted_by=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING id',[req.user?.id||null,req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true});
}catch(e){console.error('[soft delete order]',e.message);res.status(500).json({error:e.message});}});

// Manual order creation (admin / staff). Mirrors the storefront placeOrder
// flow but skips customer-side concerns (no abandoned-cart cleanup, no
// stock decrement on out-of-stock items, no payment redirect).
router.post('/stores/:sid/orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{
  try{
    const sid=req.params.sid;
    const b=req.body||{};
    if(!b.customer_name||!b.customer_phone)return res.status(400).json({error:'Customer name and phone required'});
    if(!Array.isArray(b.items)||!b.items.length)return res.status(400).json({error:'At least one item required'});
    const subtotal=b.items.reduce((s,it)=>s+(parseFloat(it.price)||0)*(parseInt(it.quantity)||1),0);
    const ship=parseFloat(b.shipping_cost)||0;
    const total=subtotal+ship;
    const num=parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1',[sid])).rows[0].n);
    const sType=b.shipping_type==='desk'?'desk':'home';
    const dcId=b.delivery_company_id||null;
    const o=await pool.query(
      'INSERT INTO orders(store_id,order_number,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,subtotal,shipping_cost,discount,total,payment_method,notes,notification_preference,shipping_type,status,delivery_company_id) '+
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
      [sid,num,b.customer_name,b.customer_phone,b.customer_email||null,b.shipping_address||null,b.shipping_city||null,b.shipping_wilaya||null,b.shipping_zip||null,subtotal,ship,0,total,b.payment_method||'cod',b.notes||null,b.notification_preference||'whatsapp',sType,b.status||'new_order',dcId]
    );
    for(const it of b.items){
      try{
        await pool.query(
          'INSERT INTO order_items(order_id,product_id,product_name,product_image,variant_info,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [o.rows[0].id,it.product_id||null,it.name||it.product_name||'Item',it.image||it.product_image||null,it.variant?JSON.stringify(it.variant):null,parseInt(it.quantity)||1,parseFloat(it.price)||0,(parseFloat(it.price)||0)*(parseInt(it.quantity)||1)]
        );
      }catch(e){console.log('[manual order item]',e.message);}
    }
    res.status(201).json(o.rows[0]);
  }catch(e){console.error('[manual order create]',e.message);res.status(500).json({error:e.message||'Failed to create order'});}
});

// Bulk soft-delete
router.post('/stores/:sid/orders/bulk-delete',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const{ids}=req.body||{};
  if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'ids required'});
  await pool.query('UPDATE orders SET is_deleted=TRUE,deleted_at=NOW(),deleted_by=$1,updated_at=NOW() WHERE id=ANY($2::uuid[]) AND store_id=$3',[req.user?.id||null,ids,req.params.sid]);
  res.json({ok:true,count:ids.length});
}catch(e){res.status(500).json({error:e.message});}});

// Restore soft-deleted order from vault
router.patch('/stores/:sid/orders/:oid/restore',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const r=await pool.query('UPDATE orders SET is_deleted=FALSE,deleted_at=NULL,deleted_by=NULL,updated_at=NOW() WHERE id=$1 AND store_id=$2 RETURNING id',[req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Permanent purge (irreversible) — only platform_admin via separate route normally; restricting here to store_owner only
router.delete('/stores/:sid/orders/:oid/purge',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM order_items WHERE order_id=$1',[req.params.oid]);
  await pool.query('DELETE FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Single order with items
router.get('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const o=await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid]);if(!o.rows.length)return res.status(404).json({error:'Not found'});const items=await pool.query('SELECT * FROM order_items WHERE order_id=$1',[req.params.oid]);const order=o.rows[0];let _cfg={};try{let _r=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0]?.config||{};if(typeof _r==='string'){try{_r=JSON.parse(_r);}catch{_r={};}}_cfg=_r;}catch{}res.json({...order,order_number:formatOrderNumber(order.order_number,_cfg),discount_amount:order.discount,items:items.rows});}catch(e){res.status(500).json({error:e.message});}});

// Update status
router.patch('/stores/:sid/orders/:oid/status',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  // Self-heal: audit columns may not exist on older databases. Add every
  // timestamp/audit column the UPDATE below might reference so it doesn't 500.
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20)");}catch{}
  const{status,cancel_reason}=req.body;let extra='';const p=[status,req.params.oid,req.params.sid];if(status==='shipped')extra=',shipped_at=NOW()';if(status==='delivered')extra=",delivered_at=NOW(),payment_status=CASE WHEN payment_method='cod' THEN 'paid' ELSE payment_status END";if(status==='cancelled'){extra=',cancelled_at=NOW()';if(cancel_reason){p.push(cancel_reason);extra+=`,cancel_reason=$${p.length}`;}}if(status==='confirmed'){p.push(String(req.user.id));extra+=`,confirmed_at=NOW(),confirmed_by=$${p.length}`;}if(status==='preparing'){p.push(String(req.user.id));extra+=`,prepared_at=NOW(),prepared_by=$${p.length}`;}const r=await pool.query(`UPDATE orders SET status=$1,updated_at=NOW()${extra} WHERE id=$2 AND store_id=$3 RETURNING *`,p);try{const{notifyStore,statusLabel}=require('../services/notify');const _o=r.rows[0];if(_o&&status!=='new_order')notifyStore(req.params.sid,{type:'status',title:`Order #${_o.order_number} → ${statusLabel(status)}`,message:_o.customer_name||'',link:'/dashboard/orders'});}catch(e){}if(!r.rows.length)return res.status(404).json({error:'Not found'});

  // Send notifications to customer on EVERY status change
  try{
    const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[req.params.sid])).rows[0];
    const order=r.rows[0];
    const pref=(order.notification_preference||'whatsapp').toUpperCase();
    let _sc=store.config||{};if(typeof _sc==='string'){try{_sc=JSON.parse(_sc);}catch{_sc={};}}
    const orderNum=formatOrderNumber(order.order_number,_sc);
    console.log(`[Order ${orderNum}] Status → ${status} | Pref: ${pref} | Phone: ${order.customer_phone} | Email: ${order.customer_email}`);
    
    // Build message for WhatsApp — use configured language + templates
    let cfg=store.config||{};
    if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}
    const waLang=cfg.wa_language||'ar';
    let waTemplates=cfg.wa_templates;
    if(typeof waTemplates==='string'){try{waTemplates=JSON.parse(waTemplates);}catch{waTemplates=null;}}
    const statusKeyMap={pending:'new_order',new_order:'new_order',confirmed:'confirmed',preparing:'under_preparation',under_preparation:'under_preparation',ready:'ready',shipped:'shipped',delivered:'delivered',cancelled:'cancelled',returned:'returned',awaiting:'awaiting',failed_call_1:'failed_call_1',failed_call_2:'failed_call_2',failed_call_3:'failed_call_3',archived:'cancelled'};
    const tplKey=statusKeyMap[status]||status;
    // Load order_items so {product_name}/{product_list}/{variant}/{quantity}
    // can resolve correctly. Loaded once and reused for both WA and email.
    let itemsForSubs = [];
    try { itemsForSubs = (await pool.query('SELECT * FROM order_items WHERE order_id=$1', [order.id])).rows; } catch {}
    // Resolve delivery company name from id if not on the order row
    let dcName=order.delivery_company_name||'';
    if(!dcName&&order.delivery_company_id){try{const dcr=await pool.query('SELECT name FROM delivery_companies WHERE id=$1',[order.delivery_company_id]);dcName=dcr.rows[0]?.name||'';}catch{}}
    // Resolve wilaya/commune names — Arabic fallback map for Algeria's 58 wilayas
    const WILAYA_AR={'Adrar':'أدرار','Chlef':'الشلف','Laghouat':'الأغواط','Oum El Bouaghi':'أم البواقي','Batna':'باتنة','Béjaïa':'بجاية','Biskra':'بسكرة','Béchar':'بشار','Blida':'البليدة','Bouira':'البويرة','Tamanrasset':'تمنراست','Tébessa':'تبسة','Tlemcen':'تلمسان','Tiaret':'تيارت','Tizi Ouzou':'تيزي وزو','Alger':'الجزائر','Djelfa':'الجلفة','Jijel':'جيجل','Sétif':'سطيف','Saïda':'سعيدة','Skikda':'سكيكدة','Sidi Bel Abbès':'سيدي بلعباس','Annaba':'عنابة','Guelma':'قالمة','Constantine':'قسنطينة','Médéa':'المدية','Mostaganem':'مستغانم','M\'Sila':'المسيلة','Mascara':'معسكر','Ouargla':'ورقلة','Oran':'وهران','El Bayadh':'البيض','Illizi':'إليزي','Bordj Bou Arréridj':'برج بوعريريج','Boumerdès':'بومرداس','El Tarf':'الطارف','Tindouf':'تندوف','Tissemsilt':'تيسمسيلت','El Oued':'الوادي','Khenchela':'خنشلة','Souk Ahras':'سوق أهراس','Tipaza':'تيبازة','Mila':'ميلة','Aïn Defla':'عين الدفلى','Naâma':'النعامة','Aïn Témouchent':'عين تموشنت','Ghardaïa':'غرداية','Relizane':'غليزان','El M\'Ghair':'المغير','El Meniaa':'المنيعة','Ouled Djellal':'أولاد جلال','Bordj Badji Mokhtar':'برج باجي مختار','Béni Abbès':'بني عباس','Timimoun':'تيميمون','Touggourt':'تقرت','Djanet':'جانت','In Salah':'عين صالح','In Guezzam':'عين قزام'};
    let wilayaFr=order.shipping_wilaya||'';
    let wilayaAr=WILAYA_AR[wilayaFr]||wilayaFr;
    let communeFr=order.shipping_city||'';
    let communeAr=order.shipping_city||'';
    try{const wr=await pool.query('SELECT wilaya_name,wilaya_name_ar FROM shipping_wilayas WHERE store_id=$1 AND wilaya_name=$2',[req.params.sid,order.shipping_wilaya]);if(wr.rows[0]){wilayaFr=wr.rows[0].wilaya_name||wilayaFr;if(wr.rows[0].wilaya_name_ar)wilayaAr=wr.rows[0].wilaya_name_ar;}}catch{}
    // Translate shipping method
    const shippingMethodTranslated=(()=>{const st=order.shipping_type||'home';if(waLang==='ar')return st==='desk'?'مكتب':'منزل';if(waLang==='fr')return st==='desk'?'Bureau':'Domicile';return st==='desk'?'Desk':'Home';})();
    // Build tracking link — prefer the carrier's own tracking URL so
    // the customer sees real-time status on the carrier's portal.
    const storeSlug=store.slug||'';
    let trackingLink = order.tracking_url || '';
    if (!trackingLink && order.tracking_number) {
      // Try carrier-specific tracking URL first
      let dcTrackUrl = '';
      if (order.delivery_company_id) {
        try {
          const dct = await pool.query('SELECT tracking_url, api_base_url FROM delivery_companies WHERE id=$1', [order.delivery_company_id]);
          const dcRow = dct.rows[0];
          if (dcRow) {
            if (dcRow.tracking_url) {
              dcTrackUrl = dcRow.tracking_url.replace('{tracking_number}', order.tracking_number).replace('{tn}', order.tracking_number);
            } else if (dcRow.api_base_url) {
              try { dcTrackUrl = new URL(dcRow.api_base_url).origin + '/list/t/' + order.tracking_number; } catch {}
            }
          }
        } catch {}
      }
      trackingLink = dcTrackUrl || `${process.env.FRONTEND_URL||'https://'+storeSlug+'.store'}/s/${storeSlug}/track?tn=${order.tracking_number}`;
    }
    const sharedFields = {
      store_name:           store.store_name,
      store_phone:          store.contact_phone || '',
      store_email:          store.contact_email || '',
      order_number:         orderNum,
      order_date:           order.created_at,
      order_time:           order.created_at,
      customer_name:        order.customer_name,
      customer_phone:       order.customer_phone,
      customer_email:       order.customer_email,
      total:                order.total,
      subtotal:             order.subtotal,
      shipping_cost:        order.shipping_cost,
      discount:             order.discount,
      currency:             store.currency || 'DZD',
      shipping_address:     order.shipping_address,
      shipping_city:        communeFr,
      shipping_wilaya:      wilayaFr,
      shipping_zip:         order.shipping_zip,
      shipping_type:        order.shipping_type,
      shipping_method:      shippingMethodTranslated,
      payment_method:       order.payment_method,
      tracking_number:      order.tracking_number,
      tracking_url:         trackingLink,
      tracking_link:        trackingLink,
      wilaya_fr:            wilayaFr,
      wilaya_ar:            wilayaAr,
      commune_fr:           communeFr,
      commune_ar:           communeAr,
      delivery_company:     dcName,
      delivery_company_name:dcName,
      shipping_company:     dcName,
      items:                itemsForSubs,
      item_count:           itemsForSubs.length,
    };
    let msg=messaging.generateOrderMessage({wa_templates:waTemplates},tplKey,sharedFields,waLang);
    // Hoisted so the email-subject path below can also use it.
    const statusLabels={pending:'received',new_order:'received',confirmed:'confirmed',preparing:'being prepared',under_preparation:'being prepared',ready:'ready',shipped:'shipped',delivered:'delivered',cancelled:'cancelled',returned:'returned',awaiting:'awaiting confirmation',failed_call_1:'unreachable (attempt 1)',failed_call_2:'unreachable (attempt 2)',failed_call_3:'unreachable (attempt 3)',archived:'archived'};
    if(!msg){
      msg=`Your order ${orderNum} from ${store.store_name} has been ${statusLabels[status]||status}. Total: ${order.total} ${store.currency||'DZD'}`;
    }

    // Send via preferred channel (WhatsApp). Fire on EVERY status change so
    // the customer sees pending / preparing / failed_call_X / returned etc.
    // Respect the per-status enabled flag the admin configured.
    if(order.customer_phone && pref==='WHATSAPP'){
      let waEnabled={};try{waEnabled=typeof cfg.wa_enabled_statuses==='string'?JSON.parse(cfg.wa_enabled_statuses||'{}'):(cfg.wa_enabled_statuses||{});}catch{}
      const enabledForStatus=waEnabled[tplKey]!==false; // default ON unless explicitly false
      if(enabledForStatus){
        messaging.sendWhatsApp(order.customer_phone,msg,req.params.sid).then(r=>{
          pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)',[req.params.sid,'whatsapp',order.customer_phone,msg.substring(0,200),r.success?'sent':'failed',r.reason||null]).catch(()=>{});
        }).catch(e=>console.log('WA skip:',e.message));
      }
    }
    
    // ── Email notifications (per-status, admin-configurable templates) ──
    // The admin configures email_enabled_statuses, email_templates, and
    // email_subjects in the EmailConfigModal. We send only when the status is
    // enabled (defaults to ON) and substitute the same variables WhatsApp uses.
    if (order.customer_email) {
      let emailEnabled = {};
      try { emailEnabled = typeof cfg.email_enabled_statuses === 'string' ? JSON.parse(cfg.email_enabled_statuses || '{}') : (cfg.email_enabled_statuses || {}); } catch {}
      const emailEnabledForStatus = emailEnabled[tplKey] !== false; // default ON
      if (emailEnabledForStatus) {
        const emailLang = cfg.email_language || waLang || 'fr';
        let emailTemplates = cfg.email_templates;
        let emailSubjects  = cfg.email_subjects;
        if (typeof emailTemplates === 'string') { try { emailTemplates = JSON.parse(emailTemplates); } catch { emailTemplates = null; } }
        if (typeof emailSubjects === 'string')  { try { emailSubjects  = JSON.parse(emailSubjects);  } catch { emailSubjects  = null; } }

        const subjectTpl = emailSubjects?.[emailLang]?.[tplKey] || emailSubjects?.fr?.[tplKey] || emailSubjects?.en?.[tplKey] || `${store.store_name} — Order ${orderNum} ${statusLabels[status] || status}`;
        const bodyTpl    = emailTemplates?.[emailLang]?.[tplKey] || emailTemplates?.fr?.[tplKey] || emailTemplates?.en?.[tplKey] || null;

        // Re-use generateOrderMessage with the SAME enriched payload as WA so
        // every localized variable alias and every {token} resolves identically.
        const subjectFilled = messaging.generateOrderMessage({ wa_templates: { [emailLang]: { [tplKey]: subjectTpl } } }, tplKey, sharedFields, emailLang) || subjectTpl;
        let htmlBody;
        if (bodyTpl) {
          const filled = messaging.generateOrderMessage({ wa_templates: { [emailLang]: { [tplKey]: bodyTpl } } }, tplKey, sharedFields, emailLang) || bodyTpl;
          // Convert plain text newlines to <br> so the HTML renders with line breaks.
          htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;font-size:14px;color:#1f2937;white-space:pre-wrap;">${filled.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div>`;
        } else {
          // No custom template — keep the rich confirmation card. Reuse the
          // items array we already loaded for variable substitution.
          htmlBody = messaging.orderConfirmationHTML(store.store_name, orderNum, order.total, store.currency || 'DZD', itemsForSubs, status);
        }

        console.log(`[Order ${orderNum}] Email → ${order.customer_email} | status: ${status} | enabled: ${emailEnabledForStatus} | template: ${bodyTpl ? 'admin' : 'default'}`);
        messaging.sendEmail({ to: order.customer_email, subject: subjectFilled, html: htmlBody })
          .then(r => {
            pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)', [req.params.sid, 'email', order.customer_email, (subjectFilled || '').substring(0, 200), r.success ? 'sent' : 'failed', r.reason || null]).catch(()=>{});
          })
          .catch(e => console.log('[Email] Error:', e.message));
      } else {
        console.log(`[Order ${orderNum}] Email skipped — admin disabled "${tplKey}" status for email.`);
      }
    } else {
      console.log('[Order] No customer email, skipping');
    }
  }catch(e){console.log('[Order Notification Error]',e.message);}

  // Auto-blacklist on cancellation if enabled
  if(status==='cancelled'){
    try{
      const store=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0];
      const cfg=store?.config||{};
      if(cfg.auto_blacklist){
        const order=r.rows[0];
        const threshold=parseInt(cfg.blacklist_threshold)||3;
        const cnt=parseInt((await pool.query("SELECT COUNT(*) FROM orders WHERE store_id=$1 AND customer_phone=$2 AND status='cancelled'",[req.params.sid,order.customer_phone])).rows[0].count);
        if(cnt>=threshold){
          await pool.query('INSERT INTO blacklist(store_id,phone,name,reason,cancelled_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[req.params.sid,order.customer_phone,order.customer_name,'Auto-blacklisted: exceeded cancellation threshold',cnt]);
        }
      }
    }catch(e){}
  }

  // Only notify admin on cancellations (new orders are notified in storefront.js)
  if(status==='cancelled'){
    try{
      const order=r.rows[0];const _ccfg=store?.config||{};const orderNum=formatOrderNumber(order.order_number,typeof _ccfg==='string'?JSON.parse(_ccfg):_ccfg);
      await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,$2,$3,$4,$5)",[req.params.sid,'order',`Order ${orderNum} cancelled`,`${order.customer_name} — ${order.total} DZD`,'/dashboard/orders']);
      const{sendStorePush}=require('./storeOwner');sendStorePush(req.params.sid,`Order ${orderNum} cancelled`,`${order.customer_name} — ${order.total} DZD`);
    }catch(e){}
  }

  // Append to the per-store activity log for the Settings → Users feed.
  try{const{logActivity}=require('./storeOwner');await logActivity(req.params.sid,req,'order_status_change','order',r.rows[0]?.order_number||req.params.oid,`→ ${status}`);}catch{}

  // Auto-dispatch: if order has a delivery company with auto_dispatch and status is confirmed/preparing/shipped
  if(['confirmed','preparing','shipped'].includes(status)&&r.rows[0]?.delivery_company_id&&!r.rows[0]?.tracking_number){
    try{
      const dcCheck=(await pool.query('SELECT auto_dispatch_enabled FROM delivery_companies WHERE id=$1',[r.rows[0].delivery_company_id])).rows[0];
      if(dcCheck?.auto_dispatch_enabled){
        autoDispatchOrder(req.params.sid,req.params.oid,r.rows[0].delivery_company_id).catch(e=>console.log('[AutoDispatch]',e.message));
      }
    }catch{}
  }

  res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// Debug: check order email status
router.get('/stores/:sid/orders/:oid/email-debug',authMiddleware(['store_owner']),async(req,res)=>{try{
  const o=(await pool.query('SELECT id,order_number,customer_name,customer_phone,customer_email,notification_preference,status FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!o)return res.status(404).json({error:'Order not found'});
  const hasResend=!!process.env.RESEND_API_KEY;
  res.json({order_number:o.order_number,customer_email:o.customer_email||'NOT SET — customer did not enter email at checkout',notification_preference:o.notification_preference,status:o.status,resend_configured:hasResend,will_send_email:!!(o.customer_email&&hasResend)});
}catch(e){res.status(500).json({error:e.message});}});

// Manual send email for an order
router.post('/stores/:sid/orders/:oid/send-email',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{email}=req.body;
  const o=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!o)return res.status(404).json({error:'Order not found'});
  const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[req.params.sid])).rows[0];
  const items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[o.id])).rows;
  let _ecfg=store?.config||{};if(typeof _ecfg==='string'){try{_ecfg=JSON.parse(_ecfg);}catch{_ecfg={};}}
  const orderNum=formatOrderNumber(o.order_number,_ecfg);
  const toEmail=email||o.customer_email;
  if(!toEmail)return res.status(400).json({error:'No email address. Customer did not provide email at checkout.'});
  const result=await messaging.sendEmail({to:toEmail,subject:`${store.store_name} — Order ${orderNum} ${o.status}`,html:messaging.orderConfirmationHTML(store.store_name,orderNum,o.total,store.currency||'DZD',items,o.status)});
  res.json(result);
}catch(e){res.status(500).json({error:e.message});}});

// Payment status
router.patch('/stores/:sid/orders/:oid/payment',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const r=await pool.query('UPDATE orders SET payment_status=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.payment_status,req.params.oid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// Generic order field update — whitelist-guarded. Powers the Quick Action drawer on the Orders page.
router.patch('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  // Make sure any columns we allow editing exist (no-op if already present).
  const migrateCols=[
    ["customer_name","TEXT"],["customer_phone","TEXT"],["customer_email","TEXT"],
    ["shipping_address","TEXT"],["shipping_city","TEXT"],["shipping_wilaya","TEXT"],["shipping_wilaya_code","TEXT"],["shipping_zip","TEXT"],["shipping_type","TEXT"],
    ["billing_name","TEXT"],["billing_street","TEXT"],["billing_city","TEXT"],["billing_zip","TEXT"],["billing_country","TEXT"],
    ["shipping_cost","NUMERIC"],["currency","TEXT"],["tax_total","NUMERIC"],["total","NUMERIC"],["subtotal","NUMERIC"],
    ["discount_code","TEXT"],["discount_total","NUMERIC"],
    ["source","TEXT"],["notes","TEXT"],
    ["tracking_number","TEXT"],["delivery_company_id","UUID"],
    ["processed_at","TIMESTAMP"],["payment_status","TEXT"]
  ];
  for(const[c,t] of migrateCols){try{await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c} ${t}`);}catch(e){}}
  const allowed=new Set(migrateCols.map(m=>m[0]));
  const sets=[];const vals=[];let i=1;
  for(const[k,v] of Object.entries(req.body||{})){
    if(!allowed.has(k))continue;
    sets.push(`${k}=$${i++}`);vals.push(v===''?null:v);
  }
  if(!sets.length)return res.status(400).json({error:'No updatable fields'});
  vals.push(req.params.oid);vals.push(req.params.sid);
  const r=await pool.query(`UPDATE orders SET ${sets.join(',')},updated_at=NOW() WHERE id=$${i++} AND store_id=$${i} RETURNING *`,vals);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Abandoned carts
router.get('/stores/:sid/abandoned-carts',authMiddleware(['store_owner']),async(req,res)=>{try{const carts=await pool.query('SELECT * FROM carts WHERE store_id=$1 AND is_abandoned=TRUE ORDER BY created_at DESC',[req.params.sid]);const stats=await pool.query("SELECT COUNT(*) as total_carts,COUNT(CASE WHEN is_recovered THEN 1 END) as recovered,COALESCE(SUM(CASE WHEN is_recovered THEN total ELSE 0 END),0) as recovered_revenue,COALESCE(SUM(CASE WHEN NOT is_recovered OR is_recovered IS NULL THEN total ELSE 0 END),0) as lost_revenue,COUNT(CASE WHEN checkout_started=TRUE AND NOT is_recovered THEN 1 END) as checkout_abandoned FROM carts WHERE store_id=$1 AND is_abandoned=TRUE",[req.params.sid]);res.json({carts:carts.rows,stats:stats.rows[0]});}catch(e){res.json({carts:[],stats:{total_carts:0,recovered:0,recovered_revenue:0,lost_revenue:0,checkout_abandoned:0}});}});

// Customers
router.get('/stores/:sid/customers',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{search}=req.query;let q='SELECT * FROM customers WHERE store_id=$1';const p=[req.params.sid];if(search){p.push(`%${search}%`);q+=` AND (full_name ILIKE $${p.length} OR phone ILIKE $${p.length})`;}q+=' ORDER BY created_at DESC LIMIT 50';const r=await pool.query(q,p);res.json(r.rows.map(c=>({...c,name:c.full_name})));}catch(e){res.json([]);}});
// Add customer (admin-side)
router.post('/stores/:sid/customers',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{name,phone,email,address,city,wilaya}=req.body;if(!name||!phone)return res.status(400).json({error:'Name and phone required'});const dup=await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[req.params.sid,phone]);if(dup.rows.length)return res.status(409).json({error:'Phone already registered'});const bcrypt=require('bcryptjs');const hash=await bcrypt.hash(phone+'_default',12);const r=await pool.query('INSERT INTO customers(store_id,full_name,phone,email,address,city,wilaya,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[req.params.sid,name,phone,email||null,address||null,city||null,wilaya||null,hash]);res.status(201).json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});
// Customer order history (admin-side)
router.get('/stores/:sid/customers/:cid/orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const r=await pool.query('SELECT id,order_number,status,total,subtotal,shipping_cost,payment_method,created_at FROM orders WHERE store_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 50',[req.params.sid,req.params.cid]);
  // Attach actual product line-items per order so the admin can see what was bought
  const ids=r.rows.map(o=>o.id);let itemsByOrder={};
  if(ids.length){try{
    const ir=await pool.query("SELECT oi.order_id,oi.product_id,oi.product_name,oi.product_image,oi.variant_info,oi.quantity,oi.unit_price,oi.total_price,p.images AS p_images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=ANY($1::uuid[])",[ids]);
    for(const it of ir.rows){let img=it.product_image||null;if(!img){try{const imgs=Array.isArray(it.p_images)?it.p_images:(typeof it.p_images==='string'?JSON.parse(it.p_images||'[]'):[]);img=imgs[0]||null;}catch{}}(itemsByOrder[it.order_id]=itemsByOrder[it.order_id]||[]).push({product_id:it.product_id,product_name:it.product_name,variant_info:it.variant_info,quantity:it.quantity,price:it.unit_price,total_price:it.total_price,image:img});}
  }catch(e){console.error('[customer orders items]',e.message);}}
  res.json(r.rows.map(o=>({...o,items:itemsByOrder[o.id]||[]})));}catch(e){res.json([]);}});

// Shipping wilayas
async function ensureShippingCols(){try{await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS home_enabled BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS desk_enabled BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS company_prices JSONB DEFAULT '{}'::jsonb");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS shipping_mode TEXT DEFAULT 'wilaya'");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS free_shipping_enabled BOOLEAN DEFAULT FALSE");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS free_shipping_threshold NUMERIC DEFAULT 0");}catch(e){}}
ensureShippingCols();
router.get('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{try{await ensureShippingCols();const wr=await pool.query('SELECT * FROM shipping_wilayas WHERE store_id=$1 ORDER BY wilaya_code',[req.params.sid]);const sr=await pool.query('SELECT shipping_mode,free_shipping_enabled,free_shipping_threshold FROM stores WHERE id=$1',[req.params.sid]);const s=sr.rows[0]||{};res.json({wilayas:wr.rows,shipping_mode:s.shipping_mode||'wilaya',free_shipping_enabled:!!s.free_shipping_enabled,free_shipping_threshold:Number(s.free_shipping_threshold||0)});}catch(e){res.json({wilayas:[],shipping_mode:'wilaya',free_shipping_enabled:false,free_shipping_threshold:0});}});
router.post('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{try{const{wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active}=req.body;const r=await pool.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.params.sid,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days||3,is_active!==false]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{const client=await pool.connect();try{await ensureShippingCols();const sid=req.params.sid;const{wilayas,shipping_mode,free_shipping_enabled,free_shipping_threshold}=req.body||{};await client.query('BEGIN');await client.query('UPDATE stores SET shipping_mode=COALESCE($2,shipping_mode),free_shipping_enabled=COALESCE($3,free_shipping_enabled),free_shipping_threshold=COALESCE($4,free_shipping_threshold) WHERE id=$1',[sid,shipping_mode||null,typeof free_shipping_enabled==='boolean'?free_shipping_enabled:null,typeof free_shipping_threshold==='number'?free_shipping_threshold:null]);if(Array.isArray(wilayas)){for(const w of wilayas){const active=w.is_active!==false;const homeOn=w.home_enabled!==false;const deskOn=w.desk_enabled!==false;const cp=JSON.stringify(w.company_prices||{});if(w.id&&!String(w.id).startsWith('local-')){await client.query('UPDATE shipping_wilayas SET wilaya_name=$2,wilaya_code=$3,desk_delivery_price=$4,home_delivery_price=$5,delivery_days=$6,is_active=$7,home_enabled=$8,desk_enabled=$9,company_prices=$10::jsonb WHERE id=$1 AND store_id=$11',[w.id,w.wilaya_name,w.wilaya_code,w.desk_delivery_price||0,w.home_delivery_price||0,w.delivery_days||3,active,homeOn,deskOn,cp,sid]);}else{await client.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active,home_enabled,desk_enabled,company_prices) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING',[sid,w.wilaya_name,w.wilaya_code,w.desk_delivery_price||0,w.home_delivery_price||0,w.delivery_days||3,active,homeOn,deskOn,cp]);}}}await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}finally{client.release();}});
router.put('/stores/:sid/shipping-wilayas/:wid',authMiddleware(['store_owner']),async(req,res)=>{try{await ensureShippingCols();const{wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active,home_enabled,desk_enabled}=req.body;const r=await pool.query('UPDATE shipping_wilayas SET wilaya_name=COALESCE($3,wilaya_name),wilaya_code=COALESCE($4,wilaya_code),desk_delivery_price=COALESCE($5,desk_delivery_price),home_delivery_price=COALESCE($6,home_delivery_price),delivery_days=COALESCE($7,delivery_days),is_active=COALESCE($8,is_active),home_enabled=COALESCE($9,home_enabled),desk_enabled=COALESCE($10,desk_enabled) WHERE id=$1 AND store_id=$2 RETURNING *',[req.params.wid,req.params.sid,wilaya_name||null,wilaya_code||null,desk_delivery_price??null,home_delivery_price??null,delivery_days??null,typeof is_active==='boolean'?is_active:null,typeof home_enabled==='boolean'?home_enabled:null,typeof desk_enabled==='boolean'?desk_enabled:null]);res.json(r.rows[0]||{ok:true});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/shipping-wilayas/:wid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM shipping_wilayas WHERE id=$1 AND store_id=$2',[req.params.wid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// Seed 58 wilayas
router.post('/stores/:sid/shipping-wilayas/seed',authMiddleware(['store_owner']),async(req,res)=>{try{const sid=req.params.sid;const ex=await pool.query('SELECT COUNT(*) FROM shipping_wilayas WHERE store_id=$1',[sid]);if(parseInt(ex.rows[0].count)>10)return res.json({message:'Already seeded'});const w=[['Adrar','01',800,1000,5],['Chlef','02',400,600,2],['Laghouat','03',600,800,3],['Oum El Bouaghi','04',400,600,2],['Batna','05',400,600,2],['Béjaïa','06',400,550,2],['Biskra','07',500,700,3],['Béchar','08',800,1000,5],['Blida','09',300,450,1],['Bouira','10',350,500,2],['Tamanrasset','11',1000,1200,7],['Tébessa','12',500,700,3],['Tlemcen','13',400,600,2],['Tiaret','14',400,600,2],['Tizi Ouzou','15',350,500,2],['Alger','16',300,400,1],['Djelfa','17',500,700,3],['Jijel','18',400,550,2],['Sétif','19',400,550,2],['Saïda','20',500,700,3],['Skikda','21',400,600,2],['Sidi Bel Abbès','22',400,600,2],['Annaba','23',400,600,2],['Guelma','24',400,600,2],['Constantine','25',400,550,2],['Médéa','26',350,500,2],['Mostaganem','27',400,600,2],["M'Sila",'28',500,700,3],['Mascara','29',400,600,2],['Ouargla','30',600,800,4],['Oran','31',400,550,2],['El Bayadh','32',600,800,4],['Illizi','33',1000,1200,7],['Bordj Bou Arréridj','34',400,550,2],['Boumerdès','35',300,450,1],['El Tarf','36',400,600,2],['Tindouf','37',1000,1200,7],['Tissemsilt','38',500,700,3],['El Oued','39',600,800,4],['Khenchela','40',500,700,3],['Souk Ahras','41',400,600,2],['Tipaza','42',300,450,1],['Mila','43',400,600,2],['Aïn Defla','44',400,550,2],['Naâma','45',600,800,4],['Aïn Témouchent','46',400,600,2],['Ghardaïa','47',600,800,4],['Relizane','48',400,600,2],["El M'Ghair",'49',600,800,4],['El Meniaa','50',700,900,5],['Ouled Djellal','51',600,800,4],['Bordj Badji Mokhtar','52',1200,1400,7],['Béni Abbès','53',900,1100,6],['Timimoun','54',900,1100,6],['Touggourt','55',600,800,4],['Djanet','56',1100,1300,7],['In Salah','57',1000,1200,7],['In Guezzam','58',1200,1400,7]];for(const[n,c,d,h,dy]of w){await pool.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[sid,n,c,d,h,dy]);}res.json({message:'58 wilayas seeded'});}catch(e){res.status(500).json({error:e.message});}});

// Delivery companies
router.get('/stores/:sid/delivery-companies',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM delivery_companies WHERE store_id=$1 ORDER BY is_default DESC NULLS LAST,created_at DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/delivery-companies',authMiddleware(['store_owner']),async(req,res)=>{try{
  try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS logo TEXT");}catch{}
  const{name,api_key,base_rate,provider_type,tracking_url,phone,logo,api_base_url,api_auth_type,api_headers,api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path}=req.body;
  const hasApi = !!(api_base_url && api_key);
  const r=await pool.query(`INSERT INTO delivery_companies(
    store_id,name,api_key,base_rate,provider_type,tracking_url,phone,logo,api_base_url,api_auth_type,api_headers,
    api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,
    api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path,
    auto_sync_enabled,auto_dispatch_enabled,is_active
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,TRUE) RETURNING *`,
    [req.params.sid,name,api_key||null,base_rate||0,provider_type||'manual',tracking_url||null,phone||null,logo||null,
     api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),
     JSON.stringify(api_query_params||{}),oauth2_token_url||null,JSON.stringify(oauth2_credentials||{}),
     api_method||'GET',api_body_template||null,api_tracking_endpoint||null,api_status_path||null,
     api_create_endpoint||null,api_create_method||'POST',api_create_body_template||null,api_create_tracking_path||null,
     hasApi,hasApi]);
  // The very first carrier a store adds becomes its default automatically, so
  // buyers always have one pre-selected at checkout without extra setup.
  try{
    const wantDefault = req.body.is_default === true ||
      Number((await pool.query('SELECT COUNT(*)::int AS n FROM delivery_companies WHERE store_id=$1',[req.params.sid])).rows[0].n) === 1;
    if(wantDefault){
      await pool.query('UPDATE delivery_companies SET is_default=FALSE WHERE store_id=$1 AND id<>$2',[req.params.sid,r.rows[0].id]);
      const d=await pool.query('UPDATE delivery_companies SET is_default=TRUE WHERE id=$1 AND store_id=$2 RETURNING *',[r.rows[0].id,req.params.sid]);
      if(d.rows[0])return res.status(201).json(d.rows[0]);
    }
  }catch(err){console.error('[delivery-companies default]',err.message);}
  res.status(201).json(r.rows[0]);
}catch(e){console.error('[delivery-companies POST]',e.message);res.status(500).json({error:e.message});}});

// Mark ONE carrier as the store default. Buyers get it pre-selected at
// checkout; they can still pick any other carrier. Passing {default:false}
// clears the flag, leaving the store with no default.
router.patch('/stores/:sid/delivery-companies/:did/default',authMiddleware(['store_owner']),async(req,res)=>{try{
  const on = req.body?.default !== false;
  await pool.query('UPDATE delivery_companies SET is_default=FALSE WHERE store_id=$1',[req.params.sid]);
  if(!on)return res.json({ok:true,is_default:false});
  const r=await pool.query('UPDATE delivery_companies SET is_default=TRUE WHERE id=$1 AND store_id=$2 RETURNING *',[req.params.did,req.params.sid]);
  if(!r.rows[0])return res.status(404).json({error:'Company not found'});
  res.json(r.rows[0]);
}catch(e){console.error('[delivery-companies default PATCH]',e.message);res.status(500).json({error:e.message});}});
// delivery companies update moved to tracking section below
router.delete('/stores/:sid/delivery-companies/:did',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid]);
  // Deleting the default would leave buyers with nothing pre-selected — hand
  // the flag to the oldest remaining carrier.
  try{await pool.query(`UPDATE delivery_companies SET is_default=TRUE WHERE id=(
    SELECT id FROM delivery_companies WHERE store_id=$1 ORDER BY created_at ASC LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM delivery_companies WHERE store_id=$1 AND is_default)`,[req.params.sid]);}catch{}
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ BLACKLIST CRUD ═══
router.get('/stores/:sid/blacklist',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM blacklist WHERE store_id=$1 ORDER BY created_at DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/blacklist',authMiddleware(['store_owner']),async(req,res)=>{try{const{phone,name,reason}=req.body;if(!phone)return res.status(400).json({error:'Phone required'});const r=await pool.query('INSERT INTO blacklist(store_id,phone,name,reason) VALUES($1,$2,$3,$4) RETURNING *',[req.params.sid,phone,name||'',reason||'Manual']);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/blacklist/:bid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM blacklist WHERE id=$1 AND store_id=$2',[req.params.bid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ═══ EXPENSES CRUD ═══
router.get('/stores/:sid/expenses',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM expenses WHERE store_id=$1 ORDER BY date DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/expenses',authMiddleware(['store_owner']),async(req,res)=>{try{const{description,category,amount,date,status}=req.body;if(!description||!amount)return res.status(400).json({error:'Description and amount required'});const r=await pool.query('INSERT INTO expenses(store_id,description,category,amount,date,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.params.sid,description,category||'Other',amount,date||new Date().toISOString().split('T')[0],status||'Paid']);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/expenses/:eid',authMiddleware(['store_owner']),async(req,res)=>{try{const{description,category,amount,date,status}=req.body;const r=await pool.query('UPDATE expenses SET description=COALESCE($1,description),category=COALESCE($2,category),amount=COALESCE($3,amount),date=COALESCE($4,date),status=COALESCE($5,status) WHERE id=$6 AND store_id=$7 RETURNING *',[description,category,amount,date,status,req.params.eid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/expenses/:eid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM expenses WHERE id=$1 AND store_id=$2',[req.params.eid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ═══ STORE PAGES (FAQs, About) ═══
router.get('/stores/:sid/pages',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM store_pages WHERE store_id=$1 ORDER BY sort_order ASC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/pages',authMiddleware(['store_owner']),async(req,res)=>{try{const{page_type,title,content,is_published,sort_order}=req.body;const r=await pool.query('INSERT INTO store_pages(store_id,page_type,title,content,is_published,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.params.sid,page_type||'faq',title||'',content||'',is_published!==false,sort_order||0]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/pages/:pid',authMiddleware(['store_owner']),async(req,res)=>{try{const{title,content,is_published,sort_order}=req.body;const r=await pool.query('UPDATE store_pages SET title=COALESCE($1,title),content=COALESCE($2,content),is_published=COALESCE($3,is_published),sort_order=COALESCE($4,sort_order) WHERE id=$5 AND store_id=$6 RETURNING *',[title,content,is_published,sort_order,req.params.pid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/pages/:pid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM store_pages WHERE id=$1 AND store_id=$2',[req.params.pid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
// Bulk save FAQs
router.put('/stores/:sid/faqs',authMiddleware(['store_owner']),async(req,res)=>{try{const{faqs}=req.body;await pool.query('DELETE FROM store_pages WHERE store_id=$1 AND page_type=$2',[req.params.sid,'faq']);const results=[];for(let i=0;i<faqs.length;i++){const f=faqs[i];const r=await pool.query('INSERT INTO store_pages(store_id,page_type,title,content,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.sid,'faq',f.q||f.title||'',f.a||f.content||'',i]);results.push(r.rows[0]);}res.json(results);}catch(e){res.status(500).json({error:e.message});}});

// ═══ STOCK INLINE UPDATE ═══
router.patch('/stores/:sid/products/:pid/stock',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{stock_quantity}=req.body;const n=(stock_quantity===null||stock_quantity===undefined||stock_quantity==='')?0:parseInt(stock_quantity);const r=await pool.query('UPDATE products SET stock_quantity=$1 WHERE id=$2 AND store_id=$3 RETURNING id,name,stock_quantity',[Number.isFinite(n)?n:0,req.params.pid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// ═══ ORDER TRACKING ═══

// Assign carrier (and optional tracking number) to order
router.patch('/stores/:sid/orders/:oid/tracking',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{tracking_number,delivery_company_id}=req.body;
  const r=await pool.query(
    `UPDATE orders SET tracking_number=COALESCE(NULLIF($1,''),tracking_number),delivery_company_id=COALESCE($2,delivery_company_id),
     tracking_status=COALESCE(NULLIF($3,''),tracking_status),tracking_updated_at=NOW(),updated_at=NOW() WHERE id=$4 AND store_id=$5 RETURNING *`,
    [tracking_number||'',delivery_company_id||null,tracking_number?'in_transit':'',req.params.oid,req.params.sid]
  );
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Get orders with tracking info
router.get('/stores/:sid/tracking-orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{status}=req.query;
  let _cfg={};try{_cfg=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0]?.config||{};}catch(e){}
  let q=`SELECT o.*,dc.name as company_name,dc.provider_type,dc.api_key as company_api_key,dc.tracking_url
    FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
    WHERE o.store_id=$1
      AND (o.is_deleted IS NOT TRUE)
      AND (
        o.tracking_number IS NOT NULL
        OR o.delivery_company_id IS NOT NULL
        OR o.status IN ('shipped','delivered','returned')
      )`;
  const p=[req.params.sid];
  if(status==='tracked'){q+=' AND (o.tracking_number IS NOT NULL OR o.delivery_company_id IS NOT NULL)';}
  else if(status==='untracked'){q+=' AND o.tracking_number IS NULL AND o.delivery_company_id IS NOT NULL';}
  q+=' ORDER BY o.updated_at DESC LIMIT 200';
  const r=await pool.query(q,p);
  res.json(r.rows.map(o=>({...o,order_number:formatOrderNumber(o.order_number,_cfg)})));
}catch(e){res.status(500).json({error:e.message});}});

// Fetch live tracking — generic for ANY delivery API
router.get('/stores/:sid/track/:trackingNumber',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const param=req.params.trackingNumber;
  // Match by tracking_number OR by external_id OR by order_number — so an
  // order that's been dispatched to a carrier but doesn't have a returned
  // tracking number yet can still be queried using its own ID.
  const order=await pool.query(
    `SELECT o.*,dc.api_key,dc.provider_type,dc.name as company_name,dc.tracking_url,
     dc.api_base_url,dc.api_auth_type,dc.api_headers,dc.api_tracking_endpoint,dc.api_status_path,
     dc.api_query_params,dc.oauth2_token_url,dc.oauth2_credentials,dc.api_method,dc.api_body_template
     FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
     WHERE o.store_id=$1
       AND (o.tracking_number=$2 OR o.external_id=$2 OR o.id::text=$2 OR o.order_number::text=$2)
     LIMIT 1`,[req.params.sid,param]);
  if(!order.rows.length)return res.status(404).json({error:'Tracking not found'});
  const o=order.rows[0];
  // If we matched by something other than the tracking_number, use whichever
  // identifier the carrier API expects (tracking_number first, then any fallback).
  const tn=o.tracking_number||o.external_id||String(o.order_number||o.id);

  // If company has API config, call it via the shared carrierRequest helper
  // (handles bearer / token_prefix / custom_headers / query_params / OAuth2).
  if(o.api_base_url && o.api_tracking_endpoint){
    try{
      console.log(`[Track] ${o.company_name}: ${o.api_method||'GET'} ${o.api_base_url}${o.api_tracking_endpoint}`);
      const cr=await carrierRequest(o,tn);
      const raw=cr.body||'';
      console.log(`[Track] Response ${cr.status}: ${raw.substring(0,300)}`);

      if(cr.ok){
        let data;
        try{data=JSON.parse(raw);}catch{data=null;}
        if(data){
          // Try to extract status from response using api_status_path (e.g. "data.0.last_status" or "status")
          let extractedStatus=null;
          let history=[];
          let extra={};

          if(o.api_status_path){
            try{
              const parts=o.api_status_path.split('.');
              let val=data;
              for(const p of parts){
                if(val==null)break;
                if(!isNaN(p))val=val[parseInt(p)];
                else val=val[p];
              }
              if(typeof val==='string')extractedStatus=val;
            }catch{}
          }

          // Auto-detect common response shapes
          if(!extractedStatus){
            const d=data.data||data.results||data;
            const item=Array.isArray(d)?d[0]:d;
            if(item){
              extractedStatus=item.last_status||item.status||item.current_status||item.state||null;
              history=item.historique||item.history||item.tracking_history||item.events||[];
              if(item.commune_name)extra.destination=item.commune_name;
              if(item.wilaya_name)extra.wilaya=item.wilaya_name;
              if(item.commune)extra.destination=item.commune;
              if(item.wilaya)extra.wilaya=item.wilaya;
            }
          }

          // Normalize history to {status,date,location}
          if(Array.isArray(history)){
            history=history.map(h=>({
              status:h.status||h.label||h.note||h.event||h.description||JSON.stringify(h),
              date:h.date||h.created_at||h.timestamp||h.time||'',
              location:h.centre||h.center||h.location||h.city||'',
            }));
          }

          const normalizedStatus=(extractedStatus||'').toLowerCase().replace(/\s+/g,'_');
          if(extractedStatus){
            await pool.query('UPDATE orders SET tracking_status=$1,tracking_updated_at=NOW() WHERE id=$2',[normalizedStatus,o.id]);
          }

          return res.json({
            provider:o.company_name,tracking_number:tn,status:normalizedStatus||o.tracking_status||'in_transit',
            raw_status:extractedStatus||'',history,...extra,
            last_update:new Date().toISOString(),company:o.company_name,has_api:true
          });
        }
      }

      return res.json({provider:o.company_name,tracking_number:tn,status:o.tracking_status||'unknown',
        error:cr.status===401?'Invalid API credentials (401)':cr.status===404?'Parcel not found (404)':`API error (${cr.status||cr.err||'no response'})`,
        company:o.company_name,has_api:true,api_error:true});
    }catch(e){
      console.error(`[Track] ${o.company_name} API error:`,e.message);
      return res.json({provider:o.company_name,tracking_number:tn,status:o.tracking_status||'unknown',
        error:'API connection failed: '+e.message,company:o.company_name,has_api:true,api_error:true});
    }
  }

  // Manual tracking — return stored status + external tracking URL if set
  const trackUrl=o.tracking_url?(o.tracking_url.replace(/\{tracking_number\}/g,tn).replace(/\{number\}/g,tn)):null;
  res.json({provider:'manual',tracking_number:tn,status:o.tracking_status||'in_transit',
    company:o.company_name||'Unknown',last_update:o.tracking_updated_at,has_api:false,tracking_url:trackUrl});
}catch(e){res.status(500).json({error:e.message});}});

// Test a saved delivery company
// Push an existing order to the carrier's create-order endpoint, save the
// returned tracking number, and flip the order to shipped.
router.post('/stores/:sid/orders/:oid/dispatch',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{ delivery_company_id }=req.body||{};
  // Self-heal in case the cols haven't been added yet
  for(const sql of [
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_endpoint VARCHAR(500)",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_method VARCHAR(10) DEFAULT 'POST'",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_body_template TEXT",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_tracking_path VARCHAR(255)",
  ]) { try { await pool.query(sql); } catch {} }

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});
  const dcId = delivery_company_id || order.delivery_company_id;
  if(!dcId)return res.status(400).json({error:'No delivery company specified'});
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[dcId,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Delivery company not found'});

  const wantedDcId = dcId;

  // Always assign the carrier immediately so the order appears in Tracking Orders.
  if (order.delivery_company_id !== wantedDcId) {
    await pool.query('UPDATE orders SET delivery_company_id=$1,updated_at=NOW() WHERE id=$2',[wantedDcId,order.id]);
    order.delivery_company_id = wantedDcId;
  }

  // Carriers without ANY API → manual mode.
  if(!dc.api_base_url){
    try{await pool.query("UPDATE orders SET delivery_company_id=$1,status='shipped',shipped_at=NOW(),updated_at=NOW() WHERE id=$2",[wantedDcId,order.id]);}catch{}
    return res.json({ok:true,manual:true,message:`${dc.name} is a manual carrier. Order saved — paste the tracking number once you create it on their platform.`});
  }

  if(!order.shipping_city && order.shipping_wilaya){
    order.shipping_city=order.shipping_wilaya;
    try{await pool.query('UPDATE orders SET shipping_city=$1 WHERE id=$2',[order.shipping_city,order.id]);}catch{}
  }
  if(!order.shipping_city){
    return res.json({ok:false,error:`Commune is required by ${dc.name}. Please set the commune/city on this order before dispatching.`});
  }

  // Pull is_fragile from the product too, so orders placed before the column
  // existed still tell the courier the parcel is fragile.
  const items=(await pool.query('SELECT oi.*, (COALESCE(oi.is_fragile,FALSE) OR COALESCE(p.is_fragile,FALSE)) AS is_fragile FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1',[order.id])).rows;
  // For CCP/BaridiMob orders the buyer already paid the product price to the store.
  // The carrier should only collect shipping fees (COD = 0 or shipping only).
  const isPrePaid=['ccp','baridimob','bank_transfer'].includes((order.payment_method||'').toLowerCase());
  const dispatchOrder=isPrePaid?{...order,total:0,subtotal:0}:order;
  console.log(`[dispatch] Order ${order.id} → ${dc.name} (${dc.api_base_url}) | customer: ${order.customer_name} | wilaya: ${order.shipping_wilaya} (${order.shipping_wilaya_code||'no code'}) | city: ${order.shipping_city} | total: ${dispatchOrder.total} (prepaid: ${isPrePaid}) | items: ${items.length}`);
  const result=await carrierCreateOrder(dc,dispatchOrder,items);
  console.log(`[dispatch] Result: ok=${result.ok} tracking=${result.tracking_number||'NONE'} status=${result.status} err=${result.err||'none'} tried=${JSON.stringify(result.tried||[])}`);
  const trimResp = (r) => {
    try {
      if (r == null) return r;
      const s = typeof r === 'string' ? r : JSON.stringify(r);
      return s.length > 4000 ? (s.slice(0, 4000) + '…(truncated)') : r;
    } catch { return String(r).slice(0, 4000); }
  };
  if(!result.ok){
    let errMsg = result.err || 'Carrier rejected the order';
    const respStr = typeof result.carrier_response === 'string' ? result.carrier_response : JSON.stringify(result.carrier_response||{});
    if (result.status === 404 && /^\s*\{\s*"message"\s*:\s*""\s*\}/.test(respStr)) {
      const carrierHost = (() => { try { return new URL(dc.api_base_url).host; } catch { return dc.name; } })();
      errMsg = `${carrierHost} returned 404 with empty message. This usually means: (1) your api_token or user_guid is wrong — re-copy them from your ${dc.name} dashboard, OR (2) the commune "${order.shipping_city}" is not recognized by ${dc.name} — check your account's enabled communes.`;
    }
    console.log(`[dispatch] FAILED: ${errMsg}`);
    return res.json({ok:false,error:errMsg,carrier_response:trimResp(result.carrier_response),carrier_status:result.status,
      debug:{request_url:result.request_url,request_body:result.request_body,tried:result.tried}});
  }
  const tn=result.tracking_number||'';
  try{
    for(const sql of [
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20)",
    ]) { try { await pool.query(sql); } catch {} }
    await pool.query(
      `UPDATE orders SET tracking_number=COALESCE(NULLIF($1,''),tracking_number),delivery_company_id=$2,status='shipped',shipped_at=NOW(),updated_at=NOW(),
       carrier_data=$3::jsonb, external_id=COALESCE(external_id,$4) WHERE id=$5`,
      [tn, wantedDcId, JSON.stringify(result.carrier_response||{}), tn||String(order.order_number||order.id), order.id]
    );
  }catch{}
  try{const{logActivity}=require('./storeOwner');await logActivity(req.params.sid,req,'order_dispatched','order',order.order_number||order.id,JSON.stringify({carrier:dc.name,tracking_number:tn||null}));}catch{}
  // Use the delivery_mode that carrierCreateOrder actually decided (not a
  // separate check that could drift from what was sent to the carrier).
  const actualMode = result.delivery_mode || (order.shipping_type === 'desk' ? 'desk' : 'home');
  console.log(`[dispatch] SUCCESS: Order ${order.id} → ${dc.name} TN: ${tn||'(none)'} shipping_type=${order.shipping_type||'(empty)'} delivery_mode=${actualMode}`);
  res.json({ok:true,tracking_number:tn||null,carrier_response:trimResp(result.carrier_response),
    message:`Order pushed to ${dc.name}`+(tn?` · TN: ${tn}`:' — order auto-configured, tracking syncs automatically')+` · Dispatched as ${actualMode==='desk'?'DESK (Bureau)':'HOME (Domicile)'}`,
    delivery_mode:actualMode,
    debug:{request_url:result.request_url,request_body:result.request_body,tried:result.tried,order_shipping_type:order.shipping_type,shipping_type_seen_by_carrier:result.shipping_type_seen}});
}catch(e){
  // Always return JSON, never let the route propagate to a 502 from Render.
  console.error('[dispatch] uncaught:',e?.message,e?.stack);
  res.status(500).json({ok:false,error:e?.message||'Dispatch failed unexpectedly'});
}});

// ─────────────────────────────────────────────────────────────────────────────
// Pull every shipment / parcel from the carrier into our orders table.
// Used by the Tracking Orders page's "Sync from carrier" button so the admin
// can manage parcels created directly on the carrier's site (e.g. by phone
// agents) alongside the orders our storefront placed.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stores/:sid/delivery-companies/:did/sync',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
    if(!dc)return res.status(404).json({error:'Carrier not found'});
    if(!dc.api_base_url)return res.status(400).json({error:'Carrier has no API configured. Add credentials first.'});

    // Pick the carrier's "list parcels" endpoint based on host.
    const host=(()=>{try{return new URL(dc.api_base_url).host.toLowerCase();}catch{return '';}})();
    let listCfg=dc, body=null;
    if(/noest/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/get/parcels',api_method:'POST'};
    }else if(/ecotrack/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/get/orders?page=1'};
    }else if(/yalidine\.app|yalidine/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/parcels/?page_size=200'};
    }else if(/procolis/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/lire',api_method:'POST',api_body_template:'{"Colis":[]}'};
      body='{"Colis":[]}';
    }else if(/maystro/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/orders/?page_size=200'};
    }else{
      return res.status(400).json({error:`No list-parcels endpoint known for ${host}. Sync supports Yalidine, NOEST, DHD/Procolis and EcoTrack.`});
    }

    // Use carrierRequest to apply the same auth scheme (headers, query params, oauth2).
    const r=await carrierRequest(listCfg,'',body);
    if(r.err)return res.json({ok:false,error:r.err,url:r.url});
    let data=null;try{data=JSON.parse(r.body||'');}catch{}
    if(!data)return res.json({ok:false,error:`Carrier returned non-JSON (HTTP ${r.status}). First 240 chars: ${(r.body||'').slice(0,240)}`});

    // Normalize the parcel list across carriers.
    const flatten=(d)=>{
      if(Array.isArray(d))return d;
      if(d&&typeof d==='object'){
        for(const k of ['data','parcels','results','list','Colis','orders','rows','items'])
          if(Array.isArray(d[k]))return d[k];
        // last resort: any array on root
        for(const v of Object.values(d))if(Array.isArray(v))return v;
      }
      return [];
    };
    const list=flatten(data);
    if(!list.length){
      return res.json({ok:true,synced:0,inserted:0,updated:0,message:'Carrier accepted credentials but returned 0 parcels. Nothing to sync.'});
    }

    // Self-heal columns we use during the upsert.
    for(const sql of [
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(40)",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_id VARCHAR(120)",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(80)",
    ]){try{await pool.query(sql);}catch{}}

    // Map carrier-specific fields → our order shape.
    const pick=(o,...keys)=>{for(const k of keys){if(o&&o[k]!=null&&o[k]!=='')return o[k];}return null;};
    const mapStatus=(s)=>{
      const t=String(s||'').toLowerCase();
      if(/livr[éeè]|deliver|تم التسليم/.test(t))return 'delivered';
      if(/exp[éeè]di|ship|في الطريق/.test(t))return 'shipped';
      if(/retour|return|مرتجع/.test(t))return 'returned';
      if(/annul|cancel|ملغ/.test(t))return 'cancelled';
      if(/transit|center|en cours/.test(t))return 'shipped';
      if(/r[ée]ception|prepar/.test(t))return 'preparing';
      return 'shipped';
    };
    let inserted=0,updated=0;
    for(const p of list){
      const tracking=String(pick(p,'tracking','tracking_number','code','Tracking','parcel_id','id','orderId')||'').trim();
      if(!tracking)continue;
      const phone=String(pick(p,'to_commune_phone','contact_phone','customer_phone','phone','MobileA','client_phone')||'').replace(/[^\d+]/g,'');
      const name=String(pick(p,'firstname','customer_name','client','Client','recipient','to_name')||'').trim()
        +(pick(p,'familyname')?' '+pick(p,'familyname'):'');
      const wilaya=String(pick(p,'to_wilaya_name','wilaya','Wilaya','shipping_wilaya')||'');
      const commune=String(pick(p,'to_commune_name','commune','Commune','shipping_city')||'');
      const address=String(pick(p,'address','adresse','Adresse','shipping_address')||'');
      const total=parseFloat(pick(p,'price','total','montant','Total','order_total'))||0;
      const stRaw=String(pick(p,'last_status','Situation','status','statut','tracking_status')||'');
      const ourStatus=mapStatus(stRaw);
      const createdAt=pick(p,'date_creation','created_at','createdAt','date');
      const externalId=String(pick(p,'order_id','external_id','id','reference','Tracking')||tracking);

      // Upsert by (store_id, tracking_number OR external_id) so re-running sync updates state.
      const existing=(await pool.query('SELECT id FROM orders WHERE store_id=$1 AND (tracking_number=$2 OR external_id=$3) LIMIT 1',[req.params.sid,tracking,externalId])).rows[0];
      if(existing){
        await pool.query(
          `UPDATE orders SET status=$1,tracking_status=$2,delivery_company_id=$3,
           tracking_number=COALESCE(tracking_number,$4),external_id=COALESCE(external_id,$5),updated_at=NOW() WHERE id=$6`,
          [ourStatus,stRaw||null,dc.id,tracking,externalId,existing.id]
        );
        updated++;
      }
      // Unmatched carrier parcels are no longer turned into (blank) orders.
    }
    res.json({ok:true,synced:list.length,inserted,updated,message:`Synced ${list.length} parcels from ${dc.name} (${inserted} new, ${updated} updated).`});
  }catch(e){console.error('[carrier sync]',e.message);res.status(500).json({ok:false,error:e.message||'Sync failed'});}
});

router.post('/stores/:sid/delivery-companies/:did/test',authMiddleware(['store_owner']),async(req,res)=>{try{
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Company not found'});
  if(!dc.api_base_url)return res.json({ok:false,error:'No API Base URL configured.'});

  const host=(()=>{try{return new URL(dc.api_base_url).host.toLowerCase();}catch{return'';}})();
  let probeCfg={...dc,api_headers:typeof dc.api_headers==='string'?dc.api_headers:JSON.stringify(dc.api_headers||{}),api_query_params:typeof dc.api_query_params==='string'?dc.api_query_params:JSON.stringify(dc.api_query_params||{}),oauth2_credentials:typeof dc.oauth2_credentials==='string'?dc.oauth2_credentials:JSON.stringify(dc.oauth2_credentials||{})};
  let probeNumber='ZZ_INVALID_TEST_000000';
  let isCreateProbe=false;
  // EcoTrack-family first so dhd.ecotrack.dz doesnt fall into Procolis branch.
  if(/noest/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/get/parcels',api_method:'POST',api_body_template:''};probeNumber='';isCreateProbe=true;}
  else if(/ecotrack/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/validate/token',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/yalidine/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/parcels/?page=1&page_size=1',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/procolis/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/lire',api_method:'POST',api_body_template:'{"Colis":[]}'};probeNumber='';isCreateProbe=true;}
  else if(/maystro/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/wilayas/',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/yassir/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/account',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/dhl/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'?trackingNumber=ZZTEST00000',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/fedex/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/track/v1/trackingnumbers',api_method:'POST',api_body_template:'{"trackingInfo":[{"trackingNumberInfo":{"trackingNumber":"ZZTEST00000"}}],"includeDetailedScans":false}'};probeNumber='';}
  else if(/ups/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/track/v1/details/ZZTEST00000',api_method:'GET',api_body_template:''};probeNumber='';}
  else if(/aramex/.test(host)){probeCfg={...probeCfg,api_tracking_endpoint:'/json/TrackShipments',api_method:'POST',api_body_template:'{"ClientInfo":{"UserName":"{UserName}","Password":"{Password}","Version":"v1.0","AccountNumber":"{AccountNumber}","AccountPin":"{AccountPin}","AccountEntity":"{AccountEntity}","AccountCountryCode":"{AccountCountryCode}"},"Shipments":[],"GetLastTrackingUpdateOnly":false}'};probeNumber='';}

  const r=await carrierRequest(probeCfg,probeNumber);
  if(r.err){
    let hint=r.err;
    if(/fetch failed|ENOTFOUND|EAI_AGAIN/.test(r.err))hint='DNS failed — '+dc.api_base_url+' is unreachable. Verify the URL.';
    else if(/ECONN|timeout/i.test(r.err))hint='Carrier API did not respond within 15s.';
    return res.json({ok:false,error:hint});
  }
  if(r.status===401||r.status===403)return res.json({ok:false,error:`Authentication failed (HTTP ${r.status}). Your credentials are wrong.`});

  const body=String(r.body||'').trim();
  if(/^<\s*(!doctype|html|head|body)/i.test(body)||/<\/html>/i.test(body))return res.json({ok:false,error:`Endpoint returned HTML, not JSON (HTTP ${r.status}). Wrong URL or endpoint.`});

  let data=null;try{data=JSON.parse(body);}catch{}
  if(!data&&!body)return res.json({ok:false,error:`Empty response (HTTP ${r.status}). Credentials likely wrong.`});

  const flatten=(obj,d=0)=>{if(d>4||obj==null)return'';if(typeof obj==='string')return obj+' ';if(typeof obj!=='object')return'';let o='';for(const v of Array.isArray(obj)?obj:Object.values(obj))o+=flatten(v,d+1);return o;};
  const blob=flatten(data).toLowerCase();
  const authFail=['invalid token','invalid api','invalid key','invalid credentials','unauthor','authentication failed','auth failed','access denied','forbidden','wrong token','token invalid','token expir','token invalide','clé invalide','permission denied','jwt expired','jwt malformed'];
  const matched=authFail.find(k=>blob.includes(k));
  if(matched)return res.json({ok:false,error:`Carrier rejected credentials ("${matched}"). Double-check your API keys.`});
  if(data&&data.success===false)return res.json({ok:false,error:data.message?`Carrier error: ${String(data.message).slice(0,160)}`:'Carrier returned success:false. Credentials likely wrong.'});

  const validationKw=['is required','required field','obligatoire','le champ','must be','validation','missing field','invalid wilaya','invalid commune','adresse','wilaya_id'];
  const valMatched=validationKw.find(k=>blob.includes(k));
  if(isCreateProbe&&valMatched)return res.json({ok:true,message:`✅ Connected to ${dc.name} — credentials verified (carrier returned validation error, proving authentication passed).`});

  if(isCreateProbe){
    const corruptCfg={...probeCfg};
    try{const h=JSON.parse(corruptCfg.api_headers||'{}');for(const k of Object.keys(h))h[k]=h[k]+'_BAD';corruptCfg.api_headers=JSON.stringify(h);}catch{}
    if(corruptCfg.api_key)corruptCfg.api_key+='_BAD';
    try{const q=JSON.parse(corruptCfg.api_query_params||'{}');for(const k of Object.keys(q))q[k]=q[k]+'_BAD';corruptCfg.api_query_params=JSON.stringify(q);}catch{}
    const r2=await carrierRequest(corruptCfg,probeNumber);
    const a=String(r.body||'').replace(/\s+/g,'').slice(0,4000);
    const b=String(r2.body||'').replace(/\s+/g,'').slice(0,4000);
    if(a===b&&r.status===r2.status)return res.json({ok:true,message:`⚠️ ${dc.name}: API responded but can't auto-verify credentials — dispatch a real order to confirm.`});
  }

  // End-to-end dispatch probe — push a real test order, then delete it.
  let dispatchVerdict = '';
  const supportsDispatch = /yalidine|noest|procolis|ecotrack|maystro/.test(host);
  if (supportsDispatch) {
    try {
      const ref = 'TEST_'+Math.random().toString(36).slice(2,8).toUpperCase();
      const realisticOrder = { order_number:ref, customer_name:'API Verify', customer_phone:'0555123456', shipping_address:'Rue Didouche Mourad, Centre Ville', shipping_city:'Alger Centre', shipping_wilaya:'Alger', shipping_wilaya_code:'16', shipping_zip:'16000', total:2000, subtotal:2000, shipping_cost:0, discount:0, shipping_type:'home', payment_method:'cod', notes:'API verification probe — please ignore', currency:'DZD' };
      const realisticItems = [{ product_name:'API Verify Item', quantity:1, unit_price:2000, weight:0.5 }];
      const dispatchCfg = { ...dc, api_create_endpoint: dc.api_create_endpoint || (
        /yalidine/.test(host)?'/parcels/':
        /noest/.test(host)?'/create/order':
        /procolis/.test(host)?'/add_colis':
        /ecotrack/.test(host)?'/create/order':
        /maystro/.test(host)?'/orders/':''
      ), api_create_method: dc.api_create_method || 'POST' };
      if (dispatchCfg.api_create_endpoint) {
        const fullUrl = (dc.api_base_url || '').replace(/\/$/, '') + (dispatchCfg.api_create_endpoint.startsWith('/') ? dispatchCfg.api_create_endpoint : '/' + dispatchCfg.api_create_endpoint);
        const dr = await carrierCreateOrder(dispatchCfg, realisticOrder, realisticItems);
        const drBody = typeof dr.carrier_response === 'string' ? dr.carrier_response : JSON.stringify(dr.carrier_response||{});
        const drBlob = drBody.toLowerCase();
        const drStatus = dr.status || 0;
        const authLooking = /unauthor|forbidden|invalid token|invalid credentials|invalid api|jeton invalide|token invalide|wrong token|access denied/.test(drBlob);
        const realNotFound = drStatus === 404 && /could not be found|route .* not found|no such route|endpoint not found/.test(drBlob);
        if (dr.ok && dr.tracking_number) {
          const del = await carrierDeleteOrder(dispatchCfg, dr.tracking_number).catch(e => ({ ok:false, err:e.message }));
          dispatchVerdict = ` Test parcel ${dr.tracking_number} pushed successfully` + (del.ok ? ' and auto-deleted.' : ` (couldn't auto-delete — remove it manually from ${host}).`);
        } else if (realNotFound) return res.json({ok:false,error:`Auth OK but create-order endpoint not found at ${fullUrl}.`});
        else if (authLooking || drStatus===401 || drStatus===403) return res.json({ok:false,error:`Auth probe OK but carrier rejected credentials when pushing a test order: ${dr.err || drBody.slice(0,160)}`});
        else dispatchVerdict = ` ⚠️ Test order rejected (HTTP ${drStatus}) — this is often test-data-specific. Dispatch a real order to confirm.`;
      }
    } catch(e){ console.log('[saved-test dispatch probe error]', e.message); }
  }

  return res.json({ok:true,message:`✅ ${dc.name} verified.${dispatchVerdict}`});
}catch(e){res.status(500).json({error:e.message});}});

// carrierRequest and carrierCreateOrder are imported from services/carrierApi.js

// Test API config WITHOUT saving — for the form "Test Connection" button.
// Strictly validates that the response actually proves working credentials.
router.post('/stores/:sid/delivery-companies/test-config',authMiddleware(['store_owner']),async(req,res)=>{try{
  const cfg = req.body || {};
  const results={connection:null,tracking:null,status_extraction:null};
  if(!cfg.api_base_url)return res.json({ok:false,error:'API Base URL is required',results});

  const host = (() => { try { return new URL(cfg.api_base_url).host.toLowerCase(); } catch { return ''; } })();

  // ════════════════════════════════════════════════════════════════════════
  // STEP 1 — End-to-end dispatch probe (the only thing that really matters).
  // Push a complete, valid test order to the carrier's create-order endpoint.
  //   • Success (tracking number returned) → carrier accepts our credentials
  //     AND our payload format. We then DELETE the test parcel automatically
  //     so the admin's account stays clean. Return verified.
  //   • Failure → surface the carrier's exact error so the admin knows what
  //     production dispatches will hit. NO MORE "Configuration saved, click
  //     Transfer to verify" — that was useless.
  // ════════════════════════════════════════════════════════════════════════
  let earlyDispatchFailed = null;
  const supportsDispatch = /yalidine|noest|procolis|ecotrack|maystro/.test(host);
  if (supportsDispatch) {
    try {
      const ref = 'TEST_'+Math.random().toString(36).slice(2,8).toUpperCase();
      const realisticOrder = {
        order_number: ref,
        customer_name: 'API Verify',
        customer_phone: '0555123456',
        customer_email: '',
        shipping_address: 'Rue Didouche Mourad, Centre Ville',
        shipping_city: 'Alger Centre',
        shipping_wilaya: 'Alger',
        shipping_wilaya_code: '16',
        shipping_zip: '16000',
        total: 2000, subtotal: 2000, shipping_cost: 0, discount: 0,
        shipping_type: 'home', payment_method: 'cod',
        notes: 'API verification probe — please ignore', currency: 'DZD',
      };
      const realisticItems = [{ product_name: 'API Verify Item', quantity: 1, unit_price: 2000, weight: 0.5 }];
      const dispatchCfg = {
        ...cfg,
        api_create_endpoint: cfg.api_create_endpoint || (
          /yalidine/.test(host) ? '/parcels/' :
          /noest/.test(host) ? '/create/order' :
          /procolis/.test(host) ? '/add_colis' :
          /ecotrack/.test(host) ? '/create/order' :
          /maystro/.test(host) ? '/orders/' : ''
        ),
        api_create_method: cfg.api_create_method || 'POST',
      };

      if (dispatchCfg.api_create_endpoint) {
        const fullUrl = (cfg.api_base_url || '').replace(/\/$/, '') + (dispatchCfg.api_create_endpoint.startsWith('/') ? dispatchCfg.api_create_endpoint : '/' + dispatchCfg.api_create_endpoint);
        const dr = await carrierCreateOrder(dispatchCfg, realisticOrder, realisticItems);
        const drBody = typeof dr.carrier_response === 'string' ? dr.carrier_response : JSON.stringify(dr.carrier_response || {});
        const drBlob = drBody.toLowerCase();
        const drStatus = dr.status || 0;
        const authLooking = /unauthor|forbidden|invalid token|invalid credentials|invalid api|jeton invalide|token invalide|wrong token|access denied|key not found/.test(drBlob);
        const realNotFound = drStatus === 404 && /could not be found|route .* not found|no such route|endpoint not found/.test(drBlob);

        if (dr.ok && dr.tracking_number) {
          const del = await carrierDeleteOrder(dispatchCfg, dr.tracking_number).catch(e => ({ ok:false, err:e.message }));
          const cleanupNote = del.ok
            ? ' Test parcel was deleted automatically.'
            : ` Test parcel was created but couldn't be auto-deleted (HTTP ${del.status || '?'}). Remove it manually from your ${host} dashboard (TN: ${dr.tracking_number}).`;
          return res.json({
            ok: true,
            message: `✅ Verified — pushed a real test order to ${host} successfully (TN: ${dr.tracking_number}). Production orders will dispatch correctly.${cleanupNote}`,
            results: { connection: { ok: true, message: `Test parcel ${dr.tracking_number} created and deleted` } },
            sample: drBody.slice(0, 240),
            url: fullUrl,
            tracking_number: dr.tracking_number,
            cleanup: del,
          });
        }
        const sentUrl = dr.request_url || fullUrl;
        const sentBody = dr.request_body || '';
        if (realNotFound) {
          return res.json({ ok: false, error: `❌ Create-order endpoint not found at ${sentUrl}. Your base URL or endpoint path is wrong — orders will never be pushed.`, sample: drBody.slice(0, 240), url: sentUrl, request_body: sentBody });
        }
        if (authLooking || drStatus === 401 || drStatus === 403) {
          return res.json({ ok: false, error: `❌ Carrier rejected your credentials when we pushed a test order: ${dr.err || drBody.slice(0, 200)}`, sample: drBody.slice(0, 240), url: sentUrl, request_body: sentBody });
        }
        earlyDispatchFailed = { drStatus, err: dr.err, body: drBody.slice(0, 240), url: sentUrl, request_body: sentBody };
      }
    } catch (e) {
      console.log('[test-config dispatch probe]', e.message);
      earlyDispatchFailed = { err: e.message };
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 2 — Tracking-only carriers (DHL, FedEx, UPS, Aramex, Yassir, …).
  // No create-order endpoint to push against, so all we can do is hit an
  // authenticated read endpoint and confirm credentials are accepted.
  // ════════════════════════════════════════════════════════════════════════
  let probeCfg = cfg;
  let probeNumber = 'ZZ_INVALID_TEST_000000';
  let probeNote = '';
  // Carrier-specific authenticated READ endpoint. We prefer endpoints that
  // ALWAYS return data with valid creds (even on empty accounts) and fail
  // with 401 / explicit auth-error message for bad creds. EcoTrack-family
  // is checked first so dhd.ecotrack.dz uses EcoTrack paths, not Procolis.
  let isCreateProbe = false;
  if (/noest/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/get/parcels', api_method: 'POST', api_body_template: '' };
    probeNumber = '';
    isCreateProbe = true;
    probeNote = 'Probed /get/parcels';
  } else if (/ecotrack/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/validate/token', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /validate/token';
  } else if (/yalidine/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/parcels/?page=1&page_size=1', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /parcels list (auth-required)';
  } else if (/procolis/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/lire', api_method: 'POST', api_body_template: '{"Colis":[]}' };
    probeNumber = '';
    probeNote = 'Probed /lire (auth-required)';
    isCreateProbe = true;
  } else if (/maystro/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/wilayas/', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /wilayas (auth-required)';
  } else if (/yassir/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/account', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /account (auth-required)';
  } else if (/dhl/.test(host)) {
    // DHL Track API requires `?trackingNumber=` to return data. We send a
    // dummy tracking number — bad API key → 401, good key → 404 "no shipment
    // found" (proves auth works).
    probeCfg = { ...cfg, api_tracking_endpoint: '?trackingNumber=ZZTEST00000', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /track/shipments (auth-required)';
  } else if (/fedex/.test(host)) {
    // FedEx OAuth flow handled inside carrierRequest. Hit /track/v1/trackingnumbers
    // with a fake tracking number — bad OAuth → 401 from token endpoint (we'll
    // catch that earlier); good OAuth → 200 with no-track-info.
    probeCfg = { ...cfg, api_tracking_endpoint: '/track/v1/trackingnumbers', api_method: 'POST', api_body_template: '{"trackingInfo":[{"trackingNumberInfo":{"trackingNumber":"ZZTEST00000"}}],"includeDetailedScans":false}' };
    probeNumber = '';
    probeNote = 'Probed /track/v1/trackingnumbers (OAuth-required)';
  } else if (/ups/.test(host)) {
    probeCfg = { ...cfg, api_tracking_endpoint: '/track/v1/details/ZZTEST00000', api_method: 'GET', api_body_template: '' };
    probeNumber = '';
    probeNote = 'Probed /track/v1/details (OAuth-required)';
  } else if (/aramex/.test(host)) {
    // Aramex JSON shipment-tracking endpoint — POST with empty Shipments list:
    //   bad creds → "Authentication failed" / "ErrorMessage"
    //   good creds → empty TrackingResults
    probeCfg = { ...cfg, api_tracking_endpoint: '/json/TrackShipments', api_method: 'POST', api_body_template: '{"ClientInfo":{"UserName":"{UserName}","Password":"{Password}","Version":"v1.0","AccountNumber":"{AccountNumber}","AccountPin":"{AccountPin}","AccountEntity":"{AccountEntity}","AccountCountryCode":"{AccountCountryCode}"},"Shipments":[],"GetLastTrackingUpdateOnly":false}' };
    probeNumber = '';
    probeNote = 'Probed /json/TrackShipments (auth-required)';
  }

  // ── Differential auth test ────────────────────────────────────────────
  // Some carriers' "list" endpoints return 200 with empty data regardless
  // of credentials (public/cached responses), which let bogus creds pass
  // verification. To be CERTAIN, we make TWO calls:
  //   1) with the credentials the admin pasted
  //   2) with intentionally-corrupted credentials (suffix _BAD)
  // If both responses are identical, the endpoint isn't validating creds
  // and we cannot honestly say "verified".
  const corruptCreds = (c) => {
    const out = { ...c };
    try {
      const h = JSON.parse(out.api_headers || '{}');
      for (const k of Object.keys(h)) h[k] = String(h[k]) + '_INVALID_PROBE';
      out.api_headers = JSON.stringify(h);
    } catch {}
    try {
      const q = JSON.parse(out.api_query_params || '{}');
      for (const k of Object.keys(q)) q[k] = String(q[k]) + '_INVALID_PROBE';
      out.api_query_params = JSON.stringify(q);
    } catch {}
    if (out.api_key) out.api_key = String(out.api_key) + '_INVALID_PROBE';
    return out;
  };

  // Step 1: hit the auth-probe endpoint (or fallback to fake-tracking lookup).
  const r = await carrierRequest(probeCfg, probeNumber);
  if (r.err) {
    let hint = r.err;
    if (/fetch failed|ENOTFOUND|EAI_AGAIN/.test(r.err)) hint = 'DNS lookup failed — the API base URL host does not exist or is unreachable. Verify the URL with the carrier.';
    else if (/ECONN|timeout/i.test(r.err)) hint = 'Carrier API did not respond within 15s. Check the URL and try again.';
    else if (/CERT|SSL|TLS/i.test(r.err)) hint = 'TLS/SSL handshake failed — invalid certificate on the carrier host.';
    return res.json({ ok:false, error:hint, results:{connection:{ok:false,message:hint}}, url:r.url });
  }
  // If the dispatch probe already ran and got a non-auth response (400/422/200),
  // that PROVES authentication worked (you can't reach validation without auth).
  // Don't trust a 401 from a secondary read endpoint that may be broken/removed.
  const dispatchImpliesAuth = earlyDispatchFailed && earlyDispatchFailed.drStatus && earlyDispatchFailed.drStatus !== 401 && earlyDispatchFailed.drStatus !== 403;
  if ((r.status === 401 || r.status === 403) && !dispatchImpliesAuth) {
    return res.json({ ok:false, error:'Authentication failed (HTTP '+r.status+'). Your credentials are wrong.', results:{connection:{ok:false,status:r.status}}, url:r.url });
  }
  if ((r.status === 401 || r.status === 403) && dispatchImpliesAuth) {
    const dispatchMsg = earlyDispatchFailed.body || '';
    return res.json({
      ok:true,
      message:`✅ Credentials verified — ${host} accepted your token (dispatch endpoint returned HTTP ${earlyDispatchFailed.drStatus}, proving auth works). Note: ${dispatchMsg.slice(0,160) || 'test order was rejected for data reasons, which is normal.'}`,
      results:{connection:{ok:true,status:earlyDispatchFailed.drStatus,message:'Auth confirmed via dispatch probe'}},
      sample: dispatchMsg.slice(0,240),
      url: earlyDispatchFailed.url,
    });
  }

  // Step 2: parse the response body. If it's HTML we hit a generic landing
  // page / wrong path — NOT a real API response. Reject.
  const body = String(r.body || '').trim();
  const looksLikeHtml = /^<\s*(!doctype|html|head|body)/i.test(body) || /<\/html>/i.test(body);
  if (looksLikeHtml) {
    return res.json({ ok:false, error:`The endpoint returned an HTML page, not JSON (HTTP ${r.status}). The base URL or tracking endpoint is wrong — most carrier APIs return JSON.`, results:{connection:{ok:false,status:r.status,message:'HTML response, not API JSON'}}, url:r.url });
  }

  // Try to parse as JSON. Most real carrier APIs return JSON for every response
  // including errors. If it isn't JSON, the endpoint isn't a real API.
  let data = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  if (!data) {
    if (!body) {
      return res.json({ ok:false, error:`Empty response from carrier (HTTP ${r.status}). Endpoint exists but returned nothing — credentials likely wrong or endpoint path incorrect.`, results:{connection:{ok:false,status:r.status}}, url:r.url });
    }
    return res.json({ ok:false, error:`Response is not valid JSON (HTTP ${r.status}). First 120 chars: ${body.slice(0,120)}`, results:{connection:{ok:false,status:r.status}}, url:r.url });
  }

  // Step 3: scan the JSON body for known error indicators. Many carriers return
  // 200 OK with `{"detail":"Invalid token"}` instead of a proper 4xx — we
  // treat those as auth failures.
  const flatten = (obj, depth=0) => {
    if (depth > 4 || obj == null) return '';
    if (typeof obj === 'string') return obj + ' ';
    if (typeof obj !== 'object') return '';
    let out = '';
    for (const v of Array.isArray(obj) ? obj : Object.values(obj)) out += flatten(v, depth+1);
    return out;
  };
  const blob = flatten(data).toLowerCase();
  const authFailKeywords = [
    'invalid token','invalid api','invalid key','invalid credentials','invalid auth',
    'unauthor','authentication failed','auth failed','access denied','forbidden',
    'wrong token','wrong key','token invalid','token expir','clé invalide','jeton invalide',
    'erreur de token','erreur token','token incorrect','non autorisé','non autorise',
    'token invalide','user_guid','utilisateur introuvable','bad token','rate limit',
    'permission denied','not allowed','please login','login required','jwt expired','jwt malformed'
  ];
  const matched = authFailKeywords.find(k => blob.includes(k));
  // Also reject explicit `success:false` payloads at the root.
  if (!matched && data && typeof data === 'object' && data.success === false) {
    return res.json({
      ok:false,
      error:`Carrier returned success:false. ${data.message ? `Reason: "${String(data.message).slice(0,160)}"` : 'Credentials likely wrong.'}`,
      results:{ connection:{ ok:false, status:r.status, message:'success:false in response body' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }
  if (matched) {
    return res.json({
      ok:false,
      error:`Carrier rejected your credentials (response contains "${matched}"). Double-check what you pasted.`,
      results:{ connection:{ ok:false, status:r.status, message:'Carrier reported credential error in response body' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }

  // Step 4: verify the response has a recognisable carrier shape. Real
  // tracking responses contain at least one of:
  //   - a payload key (data / results / list / shipments / output / parcels / trackResponse / Colis / Tracking / TrackingResults / meta / links)
  //   - an error/info key (message / error / detail / errors / status / success)
  //     — those are valid responses for an invalid tracking number, and the
  //     auth-keyword scan above already rejected real credential failures.
  const payloadKeys = ['data','results','list','shipments','output','parcels','trackResponse','Colis','Tracking','TrackingResults','meta','links'];
  const infoKeys    = ['message','error','detail','errors','status','success','code','msg','result'];
  const knownKeys   = [...payloadKeys, ...infoKeys];
  const hasShape = data && typeof data === 'object' && (
    Array.isArray(data) || knownKeys.some(k => Object.prototype.hasOwnProperty.call(data, k))
  );
  if (!hasShape) {
    return res.json({
      ok:false,
      error:`Endpoint responded but the JSON shape doesn't look like a tracking API. Got keys: ${Object.keys(data||{}).slice(0,8).join(', ')||'(none)'}. The base URL or endpoint path is probably wrong.`,
      results:{ connection:{ ok:false, status:r.status, message:'Unrecognised JSON shape' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }
  // If the only key is `message`/`error`/`detail`, surface its value to the
  // admin so they can confirm it's a "not found" response (good — auth works)
  // versus something they need to act on.
  const onlyHasInfo = !payloadKeys.some(k => Object.prototype.hasOwnProperty.call(data, k));
  let infoNote = '';
  if (onlyHasInfo) {
    const v = data.message || data.error || data.detail || data.msg || data.result;
    if (v) infoNote = ` Carrier said: "${String(v).slice(0,160)}"`;
  }

  // Step 5: success diagnostics. Count meaningful items so the admin sees
  // concrete proof the carrier returned real data, not just a shape-valid
  // empty placeholder. We look at ANY array on the root, then any array
  // value of any key (so {wilayas:[...]}, {communes:[...]}, {desks:[...]},
  // {data:[...]}, etc. all count correctly), then fall back to a key count.
  const itemCount = (() => {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') {
      // Find the largest array anywhere at the top level.
      let best = 0;
      for (const v of Object.values(data)) {
        if (Array.isArray(v) && v.length > best) best = v.length;
      }
      if (best > 0) return best;
      // Or the first nested object's key count, as a lower-bound signal.
      for (const v of Object.values(data)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length;
      }
      // Object with only scalar fields → at least it returned data.
      return Object.keys(data).length;
    }
    return 0;
  })();
  results.connection = { ok:true, status:r.status, message:`Real carrier JSON received (HTTP ${r.status})` };
  results.tracking   = { ok:true, status:r.status, message: probeNote ? `${probeNote} · ${itemCount} item${itemCount===1?'':'s'} returned` : (r.ok ? 'Endpoint responded OK' : `Returned ${r.status} — normal for invalid tracking number`) };
  if (cfg.api_status_path && !probeNote) {
    try {
      let val = data;
      for (const p of cfg.api_status_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null) results.status_extraction = { ok:true, value:String(val).slice(0,120), message:`Sample status: "${String(val).slice(0,120)}"` };
      else results.status_extraction = { ok:true, message:'Status path is navigable but empty (expected for invalid tracking number)' };
    } catch { results.status_extraction = { ok:false, message:'Could not walk the status path' }; }
  } else if (probeNote) {
    results.status_extraction = { ok:true, message: itemCount > 0 ? `${itemCount} record${itemCount===1?'':'s'} returned — credentials are working.` : 'Endpoint accepted credentials but returned no records.' };
  }

  // If the probe was an account-scoped endpoint (parcels/orders) and the
  // response carries 0 items AND no recognizable carrier success markers,
  // we can't say credentials are valid — the endpoint might be public/
  // cached or the account may be empty. Surface as a warning, not green.
  const carrierConfirmsAuth = (() => {
    if (!data || typeof data !== 'object') return false;
    // Common positive markers carriers include only on authenticated calls.
    if (data.has_more === true || data.has_more === false) return true;
    if (typeof data.total_data === 'number' || typeof data.total === 'number' || typeof data.count === 'number') return true;
    if (data.success === true) return true;
    if (data.links && typeof data.links === 'object') return true;
    if (data.meta && typeof data.meta === 'object') return true;
    return false;
  })();

  // Recognise carrier-specific validation phrases — these are the GREEN
  // signal for a CREATE probe: it means "auth passed, data is bad" (which
  // is exactly what we expect when we send {} to /create/order).
  const validationKeywords = [
    'is required','required field','required.','obligatoire','le champ','les champs',
    'must be','doit être','validation','validation error','field is missing','missing field',
    'required:','must not be empty','cannot be empty','should not be empty','manquant',
    'invalid wilaya','invalid commune','invalid phone','invalid recipient','client est',
    'mobilea','adresse','wilaya_id','must be a string','must be an integer',
  ];
  const validationMatched = validationKeywords.find(k => blob.includes(k));
  if (isCreateProbe && validationMatched) {
    // Auth confirmed: carrier rejected our payload for DATA reasons, which
    // requires it to have actually authenticated us first.
    results.connection = { ok:true, status:r.status, message:`Authenticated — carrier returned a validation error ("${validationMatched}") which proves it accepted your credentials.` };
    results.tracking   = { ok:true, status:r.status, message:'CREATE endpoint reachable with real auth' };
    return res.json({
      ok:true,
      message:`Credentials verified — ${new URL(cfg.api_base_url).host} authenticated and returned a field-level validation error (expected, since the test payload was empty).`,
      results,
      sample: body.slice(0, 240),
      url:r.url,
    });
  }

  if (probeNote && itemCount === 0 && !carrierConfirmsAuth && !isCreateProbe) {
    return res.json({
      ok: true,
      unverified: true,
      message: `Configuration saved. The endpoint responded but returned 0 records — your account may simply have no parcels yet, or the credentials may be wrong. Click "Transfer" on a real order to confirm.`,
      results: { connection: { ok: true, warning: true, status: r.status, message: 'Empty response, cannot confirm auth — verify via real dispatch' } },
      sample: body.slice(0, 240),
      url: r.url,
    });
  }
  // ── Differential probe (run BEFORE the ambiguous warning) ─────────────
  // If validationMatched was already true we returned earlier. Otherwise
  // re-run the SAME request with intentionally-corrupted credentials and
  // compare. Real auth ALWAYS changes the response when creds change; if
  // the bodies differ, that's our positive proof.
  let differentialPassed = false;
  let differentialDetail = null;
  if (probeNote) {
    try {
      const corrupted = corruptCreds(probeCfg);
      const r2 = await carrierRequest(corrupted, probeNumber);
      const a = String(r.body || '').replace(/\s+/g, '').slice(0, 4000);
      const b = String(r2.body || '').replace(/\s+/g, '').slice(0, 4000);
      const sameStatus = r.status === r2.status;
      const sameBody   = a && a === b;
      differentialDetail = { real_status: r.status, fake_status: r2.status, real_sample: (r.body || '').slice(0, 200), fake_sample: (r2.body || '').slice(0, 200), same: sameStatus && sameBody };
      if (sameStatus && sameBody) {
        // The carrier's API doesn't react to credentials on this endpoint —
        // NOEST is the canonical example: /create/order replies with the same
        // {"message":""} for any creds, so we can't detect auth here. Don't
        // block the save: surface as a yellow informational pass with a clear
        // "real verification happens on dispatch" note. The admin's first
        // Transfer click will then either succeed or surface NOEST's real
        // error using the exact credentials they pasted.
        return res.json({
          ok: true,
          unverified: true,
          message: `Configuration saved. ${new URL(cfg.api_base_url).host} can't be auto-verified — its API returns the same response (${(body || '(empty)').slice(0, 60)}…) for any credentials. Click "Transfer" on a real order to do the actual end-to-end test; if your credentials are wrong, that call will surface the carrier's real error. ${infoNote}`,
          results: { connection: { ok: true, warning: true, status: r.status, message: 'Endpoint cannot differentiate credentials — verify via real dispatch' } },
          sample: body.slice(0, 240),
          differential: differentialDetail,
          url: r.url,
        });
      }
      // Bodies differ → real auth happened. Strength depends on whether the
      // corrupted call also showed an explicit auth error.
      const corruptedBlob = String(r2.body || '').toLowerCase();
      const corruptedRejected = r2.status === 401 || r2.status === 403 || authFailKeywords.some(k => corruptedBlob.includes(k));
      differentialPassed = true;
      results.connection = corruptedRejected
        ? { ok:true, status:r.status, message:`✓ Differential check passed — carrier rejected fake credentials (HTTP ${r2.status}) and accepted yours (HTTP ${r.status}).` }
        : { ok:true, status:r.status, message:`✓ Real and fake credentials produced different responses (real HTTP ${r.status} vs fake HTTP ${r2.status}) — credentials authenticated something on the carrier side.` };
    } catch (e) {
      console.log('[differential probe error]', e.message);
    }
  }

  // For CREATE probes that didn't return validation/auth/differential —
  // we have no automated way to confirm auth, but the credentials are still
  // saved and dispatch will be the real test. Don't block the form.
  if (isCreateProbe && !matched && !validationMatched && !differentialPassed) {
    return res.json({
      ok: true,
      unverified: true,
      message: `Configuration saved. ${new URL(cfg.api_base_url).host} responded but didn't give us a verifiable auth signal (sample: ${body.slice(0, 80)}…). Click "Transfer" on a real order to do the end-to-end test — that's the only authoritative validation for this carrier.`,
      results: { connection: { ok: true, warning: true, status: r.status, message: 'Ambiguous response — verify via real dispatch' } },
      sample: body.slice(0, 240),
      differential: differentialDetail,
      url: r.url,
    });
  }

  // ─── End-to-end dispatch probe ──────────────────────────────────────────
  let dispatchResult = null;
  let createdTracking = null;
  if (!earlyDispatchFailed) try {
    const carrierHost = new URL(cfg.api_base_url).host.toLowerCase();
    const ref = 'TEST_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const realisticOrder = {
      order_number: ref,
      customer_name: 'API Verify',
      customer_phone: '0555123456',
      customer_email: '',
      shipping_address: 'Rue Didouche Mourad, Centre Ville',
      shipping_city: 'Alger Centre',
      shipping_wilaya: 'Alger',
      shipping_wilaya_code: '16',
      shipping_zip: '16000',
      total: 2000,
      subtotal: 2000,
      shipping_cost: 0,
      discount: 0,
      shipping_type: 'home',
      payment_method: 'cod',
      notes: 'API verification probe — please ignore',
      currency: 'DZD',
    };
    const realisticItems = [{ product_name: 'API Verify Item', quantity: 1, unit_price: 2000, weight: 0.5 }];

    const dispatchCfg = {
      ...cfg,
      api_create_endpoint: cfg.api_create_endpoint || (
        /yalidine/.test(carrierHost) ? '/parcels/' :
        /noest/.test(carrierHost) ? '/create/order' :
        /procolis/.test(carrierHost) ? '/add_colis' :
        /ecotrack/.test(carrierHost) ? '/create/order' :
        /maystro/.test(carrierHost) ? '/orders/' : ''
      ),
      api_create_method: cfg.api_create_method || 'POST',
    };

    if (dispatchCfg.api_create_endpoint) {
      const dr = await carrierCreateOrder(dispatchCfg, realisticOrder, realisticItems);
      const drBlob = (typeof dr.carrier_response === 'string' ? dr.carrier_response : JSON.stringify(dr.carrier_response || {})).toLowerCase();
      const drStatus = dr.status || 0;
      const authLooking = /unauthor|forbidden|invalid token|invalid credentials|invalid api|jeton invalide|token invalide|wrong token|access denied/.test(drBlob);
      const notFound = drStatus === 404 && /could not be found|route .* not found|no such route|endpoint not found/.test(drBlob);

      if (dr.ok && dr.tracking_number) {
        createdTracking = dr.tracking_number;
        const del = await carrierDeleteOrder(dispatchCfg, dr.tracking_number).catch(e => ({ ok: false, err: e.message }));
        const cleanupNote = del.ok
          ? ' Test parcel was deleted automatically.'
          : ` Test parcel was created but couldn't be auto-deleted (HTTP ${del.status || '?'}). You may want to remove it from your ${carrierHost} dashboard manually (TN: ${dr.tracking_number}).`;
        dispatchResult = { ok: true, message: `✅ Real test order pushed to ${carrierHost} successfully (TN: ${dr.tracking_number}). Dispatch is fully functional.${cleanupNote}` };
      } else if (notFound) {
        dispatchResult = { ok: false, message: `❌ Create-order endpoint not found at ${carrierHost}${dispatchCfg.api_create_endpoint}. The base URL or endpoint path is wrong.` };
      } else if (authLooking || drStatus === 401 || drStatus === 403) {
        dispatchResult = { ok: false, message: `❌ Carrier rejected the credentials when pushing a test order: ${dr.err || drBlob.slice(0, 160)}` };
      } else {
        dispatchResult = { ok: false, message: `⚠️ Test order rejected (HTTP ${drStatus}): ${dr.err || drBlob.slice(0, 200) || 'empty response'}. This may be test-data-specific — dispatch a real order to confirm.` };
      }
    }
  } catch (e) {
    console.log('[dispatch probe error]', e.message);
    dispatchResult = { ok: false, message: `⚠️ Dispatch probe crashed: ${e.message}` };
  }

  // Auth probe success message
  const authMsg = differentialPassed
    ? `Credentials verified — ${new URL(cfg.api_base_url).host} accepted yours and rejected a deliberately-corrupted version (real ↔ fake responses differ).${infoNote}`
    : probeNote
      ? `Credentials verified — ${new URL(cfg.api_base_url).host} returned ${itemCount} record${itemCount===1?'':'s'} from your account.${infoNote}`
      : `API configuration verified — credentials accepted by ${new URL(cfg.api_base_url).host}.${infoNote}`;

  // Final verdict combines auth probe + dispatch probe + early dispatch probe.
  let finalOk = true;
  let finalMsg = authMsg;
  let finalUnverified = false;
  const effectiveDispatch = dispatchResult || (earlyDispatchFailed ? { ok: false, message: `⚠️ Test order rejected (HTTP ${earlyDispatchFailed.drStatus || '?'}): ${earlyDispatchFailed.err || 'empty response'}. This is often test-data-specific (wilaya/commune restrictions on your account). Save and dispatch a real order to confirm.` } : null);

  if (effectiveDispatch) {
    if (effectiveDispatch.ok) {
      finalMsg = authMsg + ' ' + effectiveDispatch.message;
    } else if (differentialPassed || carrierConfirmsAuth || (probeNote && itemCount > 0)) {
      finalMsg = `✅ ${authMsg} Note: ${effectiveDispatch.message}`;
    } else {
      finalUnverified = true;
      finalMsg = `⚠️ ${effectiveDispatch.message}`;
    }
  }

  res.json({
    ok: finalOk,
    unverified: finalUnverified,
    message: finalMsg,
    results,
    sample: earlyDispatchFailed ? earlyDispatchFailed.body : body.slice(0, 240),
    differential: differentialDetail,
    dispatch_probe: effectiveDispatch,
    request_body: earlyDispatchFailed ? earlyDispatchFailed.request_body : undefined,
    url: earlyDispatchFailed ? earlyDispatchFailed.url : r.url,
  });
}catch(e){console.error('[test-config]',e.message);res.status(500).json({error:e.message});}});

// Test API credentials before saving — accepts raw config from request body
router.post('/stores/:sid/delivery-companies/test-credentials',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{api_base_url,api_auth_type,api_key,api_headers,api_tracking_endpoint,name}=req.body;
  if(!api_base_url)return res.json({ok:false,error:'API Base URL is required'});

  const headers={'Content-Type':'application/json'};
  const parsed=typeof api_headers==='string'?JSON.parse(api_headers||'{}'):(api_headers||{});
  if(api_auth_type==='bearer'&&api_key)headers['Authorization']=`Bearer ${api_key}`;
  else if(api_auth_type==='custom_headers')Object.assign(headers,parsed);

  // Step 1: Test base URL connectivity
  const baseUrl=api_base_url.replace(/\/$/,'');
  console.log(`[TestCreds] ${name||'Company'}: GET ${baseUrl}`);
  try{
    const r=await fetch(baseUrl,{headers,signal:AbortSignal.timeout(10000)});
    const status=r.status;
    if(status===401||status===403)return res.json({ok:false,error:`Authentication failed (HTTP ${status}). Your credentials are incorrect.`,step:'auth'});

    // Step 2: If tracking endpoint provided, test it with a fake tracking number
    if(api_tracking_endpoint){
      const testTN='TEST000000';
      const endpoint=api_tracking_endpoint.replace(/\{tracking_number\}/g,testTN).replace(/\{number\}/g,testTN);
      const trackUrl=baseUrl+(endpoint.startsWith('/')?'':'/')+endpoint;
      console.log(`[TestCreds] Tracking test: GET ${trackUrl}`);
      try{
        const tr=await fetch(trackUrl,{headers,signal:AbortSignal.timeout(10000)});
        const tStatus=tr.status;
        if(tStatus===401||tStatus===403)return res.json({ok:false,error:`Base URL works but tracking endpoint rejected credentials (HTTP ${tStatus}).`,step:'tracking_auth'});
        if(tStatus===404||tStatus===200||tStatus===422||tStatus===400){
          // 404/400 with fake tracking = expected, means endpoint exists and auth works
          return res.json({ok:true,message:`Connected to ${name||'API'}! Base URL and tracking endpoint are reachable. Authentication passed.`,step:'complete'});
        }
        return res.json({ok:true,message:`Connected (HTTP ${tStatus}). Tracking endpoint responded.`,step:'complete'});
      }catch(te){
        return res.json({ok:true,message:`Base URL works but tracking endpoint unreachable: ${te.message}. Check the endpoint path.`,step:'tracking_fail',partial:true});
      }
    }

    return res.json({ok:true,message:`Connected to ${name||'API'} (HTTP ${status}). Add a tracking endpoint to enable live tracking.`,step:'base_only'});
  }catch(e){
    return res.json({ok:false,error:`Cannot reach ${baseUrl}: ${e.message}. Check the URL.`,step:'unreachable'});
  }
}catch(e){res.status(500).json({error:e.message});}});

// Update delivery company — full API config
router.put('/stores/:sid/delivery-companies/:did',authMiddleware(['store_owner']),async(req,res)=>{try{
  try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS logo TEXT");}catch{}
  const{name,api_key,base_rate,provider_type,tracking_url,phone,logo,api_base_url,api_auth_type,api_headers,api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path}=req.body;
  const hasApi = !!(api_base_url && api_key);
  const r=await pool.query(
    `UPDATE delivery_companies SET name=COALESCE($1,name),api_key=$2,base_rate=COALESCE($3,base_rate),
     provider_type=COALESCE($4,provider_type),tracking_url=$5,phone=$6,logo=$7,
     api_base_url=$8,api_auth_type=COALESCE($9,api_auth_type),api_headers=$10::jsonb,
     api_query_params=$11::jsonb,oauth2_token_url=$12,oauth2_credentials=$13::jsonb,
     api_method=COALESCE($14,api_method),api_body_template=$15,
     api_tracking_endpoint=$16,api_status_path=$17,
     api_create_endpoint=$18,api_create_method=COALESCE($19,api_create_method),api_create_body_template=$20,api_create_tracking_path=$21,
     auto_sync_enabled=CASE WHEN $24 THEN TRUE ELSE auto_sync_enabled END,
     auto_dispatch_enabled=CASE WHEN $24 THEN TRUE ELSE auto_dispatch_enabled END
     WHERE id=$22 AND store_id=$23 RETURNING *`,
    [name,api_key||null,base_rate,provider_type||'manual',tracking_url||null,phone||null,logo||null,
     api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),
     JSON.stringify(api_query_params||{}),oauth2_token_url||null,JSON.stringify(oauth2_credentials||{}),
     api_method||'GET',api_body_template||null,
     api_tracking_endpoint||null,api_status_path||null,
     api_create_endpoint||null,api_create_method||'POST',api_create_body_template||null,api_create_tracking_path||null,
     req.params.did,req.params.sid,hasApi]
  );
  if(req.body.is_default===true||req.body.is_default===false){
    try{
      await pool.query('UPDATE delivery_companies SET is_default=FALSE WHERE store_id=$1',[req.params.sid]);
      if(req.body.is_default===true){
        const d=await pool.query('UPDATE delivery_companies SET is_default=TRUE WHERE id=$1 AND store_id=$2 RETURNING *',[req.params.did,req.params.sid]);
        if(d.rows[0])return res.json(d.rows[0]);
      }
    }catch(err){console.error('[delivery-companies default PUT]',err.message);}
  }
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// ═══ REVIEWS CRUD (store owner) ═══
router.get('/stores/:sid/reviews',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{filter}=req.query;
  let q='SELECT r.*,p.name as product_name FROM reviews r LEFT JOIN products p ON p.id=r.product_id WHERE r.store_id=$1';
  if(filter==='pending')q+=' AND r.is_approved=FALSE AND r.is_rejected=FALSE';
  else if(filter==='approved')q+=' AND r.is_approved=TRUE';
  else if(filter==='rejected')q+=' AND r.is_rejected=TRUE';
  q+=' ORDER BY r.created_at DESC LIMIT 100';
  const r=await pool.query(q,[req.params.sid]);
  const stats=await pool.query("SELECT COUNT(*) as total,COUNT(*) FILTER(WHERE is_approved) as approved,COUNT(*) FILTER(WHERE is_rejected) as rejected,COUNT(*) FILTER(WHERE NOT is_approved AND NOT is_rejected) as pending,ROUND(AVG(rating),1) as avg_rating FROM reviews WHERE store_id=$1",[req.params.sid]);
  res.json({reviews:r.rows,stats:stats.rows[0]});
}catch(e){res.json({reviews:[],stats:{}});}});

router.patch('/stores/:sid/reviews/:rid/approve',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('UPDATE reviews SET is_approved=TRUE,is_rejected=FALSE,admin_notes=$1 WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.notes||null,req.params.rid,req.params.sid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/stores/:sid/reviews/:rid/reject',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('UPDATE reviews SET is_rejected=TRUE,is_approved=FALSE,admin_notes=$1 WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.notes||null,req.params.rid,req.params.sid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/stores/:sid/reviews/:rid',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM reviews WHERE id=$1 AND store_id=$2',[req.params.rid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ GOOGLE SHEETS - orders export for frontend sync ═══
router.get('/stores/:sid/orders-export',authMiddleware(['store_owner']),async(req,res)=>{try{
  const orders=await pool.query(`SELECT o.*,
    (SELECT json_agg(json_build_object('product_name',oi.product_name,'quantity',oi.quantity,'unit_price',oi.unit_price))
     FROM order_items oi WHERE oi.order_id=o.id) as items
    FROM orders o WHERE o.store_id=$1 ORDER BY o.created_at DESC LIMIT 500`,[req.params.sid]);
  let _xCfg={};try{let _xr=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0]?.config||{};if(typeof _xr==='string'){try{_xr=JSON.parse(_xr);}catch{_xr={};}}_xCfg=_xr;}catch{}
  const rows=orders.rows.map(o=>{
    let items='';if(o.items&&Array.isArray(o.items))items=o.items.map(i=>`${i.product_name} x${i.quantity}`).join(', ');
    return[formatOrderNumber(o.order_number,_xCfg),o.created_at?new Date(o.created_at).toLocaleString():'',
      o.customer_name||'',o.customer_phone||'',o.customer_email||'',
      o.shipping_address||'',o.shipping_wilaya||'',items,
      o.subtotal||0,o.shipping_cost||0,o.total||0,
      o.payment_method||'',o.payment_status||'',o.status||'',
      o.tracking_number||'',o.notes||''];
  });
  res.json({header:['Order #','Date','Customer','Phone','Email','Address','Wilaya','Items','Subtotal','Shipping','Total','Payment','Pay Status','Status','Tracking','Notes'],rows});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ STATUS TEMPLATES (per-store customization of order statuses) ═══
let _statusTemplatesReady=null;
function ensureStatusTemplatesTable(){
  if(!_statusTemplatesReady){
    _statusTemplatesReady=(async()=>{
      try{await pool.query(`CREATE TABLE IF NOT EXISTS store_status_templates(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL,
        key TEXT NOT NULL,
        label TEXT,
        color TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        notify_customer BOOLEAN DEFAULT TRUE,
        position INT DEFAULT 0,
        is_builtin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(store_id,key)
      )`);}catch(e){console.error('[status_templates table]',e.message);}
    })();
  }
  return _statusTemplatesReady;
}
ensureStatusTemplatesTable();

router.get('/stores/:sid/status-templates',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const r=await pool.query('SELECT * FROM store_status_templates WHERE store_id=$1 ORDER BY position ASC, created_at ASC',[req.params.sid]);
  res.json(r.rows);
}catch(e){console.error('[GET status-templates]',e.message);res.status(500).json({error:e.message});}});

router.put('/stores/:sid/status-templates',authMiddleware(['store_owner']),async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const statuses=Array.isArray(req.body?.statuses)?req.body.statuses:[];
  const sid=req.params.sid;
  await pool.query('DELETE FROM store_status_templates WHERE store_id=$1',[sid]);
  for(let i=0;i<statuses.length;i++){
    const s=statuses[i];
    if(!s||!s.key)continue;
    try{
      await pool.query(
        `INSERT INTO store_status_templates(store_id,key,label,color,enabled,notify_customer,position,is_builtin)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sid,s.key,s.label||s.key,s.color||'#64748b',s.enabled!==false,s.notify_customer!==false,i,!!s.is_builtin]
      );
    }catch(e){console.error('[PUT status-templates row]',s.key,e.message);}
  }
  const r=await pool.query('SELECT * FROM store_status_templates WHERE store_id=$1 ORDER BY position ASC',[sid]);
  res.json({ok:true,statuses:r.rows});
}catch(e){console.error('[PUT status-templates]',e.message);res.status(500).json({error:e.message});}});

// Public (no auth) — used by the buyer TrackOrder page to render localized status labels.
router.get('/public/stores/:sid/status-templates',async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const r=await pool.query('SELECT key,label,color,enabled,notify_customer FROM store_status_templates WHERE store_id=$1 AND enabled=TRUE ORDER BY position ASC',[req.params.sid]);
  res.json(r.rows);
}catch(e){res.json([]);}});

// ═══ AUTO-SYNC & WEBHOOK ENDPOINTS ═══

// Toggle auto-sync for a delivery company
router.patch('/stores/:sid/delivery-companies/:did/auto-sync',authMiddleware(['store_owner']),async(req,res)=>{try{
  await ensureSyncCols();
  const{auto_sync_enabled,auto_dispatch_enabled}=req.body||{};
  const sets=[];const vals=[];let i=1;
  if(typeof auto_sync_enabled==='boolean'){sets.push(`auto_sync_enabled=$${i++}`);vals.push(auto_sync_enabled);}
  if(typeof auto_dispatch_enabled==='boolean'){sets.push(`auto_dispatch_enabled=$${i++}`);vals.push(auto_dispatch_enabled);}
  if(!sets.length)return res.status(400).json({error:'Nothing to update'});
  vals.push(req.params.did);vals.push(req.params.sid);
  const r=await pool.query(`UPDATE delivery_companies SET ${sets.join(',')} WHERE id=$${i++} AND store_id=$${i} RETURNING *`,vals);
  res.json(r.rows[0]||{ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Manual trigger full sync for a carrier
router.post('/stores/:sid/delivery-companies/:did/full-sync',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{syncCarrierOrders,updateTracking}=require('../services/carrierSync');
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Carrier not found'});
  if(!dc.api_base_url)return res.status(400).json({error:'No API configured'});
  const result=await syncCarrierOrders(req.params.sid,dc);
  // Also update tracking for all orders from this carrier (including those with external_id only)
  const orders=(await pool.query(
    "SELECT * FROM orders WHERE store_id=$1 AND delivery_company_id=$2 AND (tracking_number IS NOT NULL OR external_id IS NOT NULL) AND status NOT IN ('delivered','cancelled','returned') LIMIT 50",
    [req.params.sid,dc.id]
  )).rows;
  let trackingUpdated=0;
  for(const o of orders){
    try{const r=await updateTracking(req.params.sid,o,dc);if(r)trackingUpdated++;}catch{}
  }
  res.json({...result,tracking_updated:trackingUpdated});
}catch(e){res.status(500).json({error:e.message});}});

// Webhook endpoint for carriers to push status updates (no auth - uses carrier ID as path)
router.all('/webhook/carrier/:sid/:did',async(req,res)=>{try{
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
      const match=await pool.query("SELECT tracking_number FROM orders WHERE store_id=$1 AND (external_id=$2 OR tracking_number=$2) LIMIT 1",[req.params.sid,ref]);
      if(match.rows[0])tracking=match.rows[0].tracking_number||ref;
      else tracking=ref;
    }
  }
  if(!tracking)return res.status(400).json({error:'Missing tracking number'});
  const mapSt=(s)=>{const t=String(s||'').toLowerCase().replace(/\s+/g,'_');
    if(/livr[éeè]|deliver|^livred$/.test(t))return'delivered';
    if(/encaiss|^payed$|paiement_pret|paiement_archive/.test(t))return'delivered';
    if(/exp[éeè]di|ship|picked|dispatched|transit|attempt|en_livraison|vers_wilaya|vers_hub|en_hub|en_preparation|ramassage/.test(t))return'shipped';
    if(/received_by_carrier|accepted_by_carrier|pret_a_expedier|pret_a_preparer|stock_en_preparation/.test(t))return'preparing';
    if(/retour|return|suspendu/.test(t))return'returned';
    if(/annul|cancel/.test(t))return'cancelled';
    return'shipped';};
  await pool.query(
    "UPDATE orders SET tracking_status=$1,status=$2,carrier_data=$3::jsonb,tracking_updated_at=NOW(),updated_at=NOW() WHERE store_id=$4 AND tracking_number=$5",
    [String(status).toLowerCase().replace(/\s+/g,'_'),mapSt(status),JSON.stringify(merged),req.params.sid,tracking]
  );
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Bulk refresh tracking for all orders of a carrier
router.post('/stores/:sid/delivery-companies/:did/refresh-tracking',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{updateTracking}=require('../services/carrierSync');
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Carrier not found'});
  const orders=(await pool.query(
    "SELECT * FROM orders WHERE store_id=$1 AND delivery_company_id=$2 AND (tracking_number IS NOT NULL OR external_id IS NOT NULL) AND status NOT IN ('delivered','cancelled','returned') LIMIT 100",
    [req.params.sid,dc.id]
  )).rows;
  let updated=0;
  for(const o of orders){try{const r=await updateTracking(req.params.sid,o,dc);if(r)updated++;}catch{}}
  res.json({ok:true,total:orders.length,updated});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ DIAGNOSE — raw request/response dump for debugging carrier integration ═══
router.post('/stores/:sid/delivery-companies/:did/diagnose',authMiddleware(['store_owner']),async(req,res)=>{try{
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Carrier not found'});
  if(!dc.api_base_url)return res.json({error:'No API configured for this carrier'});

  const{detectCarrier,normalizeConfig,wilayaToCode}=require('../services/carrierApi');
  // Auto-migrate legacy NOEST config (query_params → bearer, /api/public/v1 → /api/v1)
  const ncfg=normalizeConfig(dc);
  const carrier=detectCarrier(ncfg.api_base_url||'');
  const parseJson=(v)=>typeof v==='string'?(()=>{try{return JSON.parse(v);}catch{return{};}})():(v||{});
  const steps=[];
  const base=(ncfg.api_base_url||'').replace(/\/$/,'');

  const postWithRedirect=async(url,headers,body,timeout=15000)=>{
    let r=await fetch(url,{method:'POST',headers,body,redirect:'manual',signal:AbortSignal.timeout(timeout)});
    let redirected=null;
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get('location');
      if(loc){
        redirected={from:url,to:loc.startsWith('http')?loc:new URL(loc,url).href,code:r.status};
        r=await fetch(redirected.to,{method:'POST',headers,body,redirect:'follow',signal:AbortSignal.timeout(timeout)});
      }
    }
    return{r,redirected};
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // NOEST EXPRESS — EcoTrack-based diagnosis
  // NOEST runs on the EcoTrack platform (same API as DHD, Conexlog, etc.)
  // Auth: Bearer token. Endpoints: /api/v1/... JSON body.
  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  // NOEST EXPRESS — Public API v2.3 diagnosis
  // Auth: Authorization: Bearer {api_token}   Body: user_guid in JSON
  // Endpoints: /api/public/get/wilayas, /api/public/create/order, etc.
  // ═══════════════════════════════════════════════════════════════════════════
  const isNoest=/noest/i.test(dc.api_base_url||'')||/noest/i.test(ncfg.api_base_url||'');
  if(isNoest){
    const q=parseJson(dc.api_query_params);
    const apiToken=q.api_token||dc.api_key||ncfg.api_key||'';
    const userGuid=q.user_guid||'';
    const origin=(()=>{try{return new URL(dc.api_base_url||base).origin;}catch{return base;}})();
    const noestHeaders={'Authorization':apiToken?'Bearer '+apiToken:'','Content-Type':'application/json','Accept':'application/json'};

    // 0) Config dump
    steps.push({step:'noest_config',diagnosis:'NOEST Public API v2.3 — Bearer token + user_guid in body. All paths: /api/public/...',
      saved_base_url:dc.api_base_url,saved_auth_type:dc.api_auth_type,origin,
      token:apiToken?apiToken.slice(0,8)+'***':'(MISSING)',
      user_guid:userGuid?userGuid.slice(0,8)+'***':'(MISSING)',
    });
    if(!apiToken)steps.push({step:'noest_error',diagnosis:'❌ No api_token. Set your NOEST api_token in the API Key field.'});
    if(!userGuid)steps.push({step:'noest_warning',diagnosis:'⚠️ No user_guid. NOEST requires user_guid for create/delete/validate. Set it in api_query_params: {"user_guid":"your-guid-here"}'});

    // 1) GET /api/public/get/wilayas — connectivity + auth test (no body needed)
    const wilayaUrl=origin+'/api/public/get/wilayas';
    try{
      const r=await fetch(wilayaUrl,{method:'GET',headers:noestHeaders,redirect:'follow',signal:AbortSignal.timeout(10000)});
      const txt=await r.text();
      let parsed;try{parsed=JSON.parse(txt);}catch{}
      let diagnosis='';
      if(r.status===200&&Array.isArray(parsed)){
        diagnosis=`✅ Auth works — returned ${parsed.length} wilayas`;
      }else if(r.status===200&&parsed?.message==='Unauthenticated.'){
        diagnosis='❌ Token rejected (Unauthenticated). Get a fresh api_token from NOEST dashboard.';
      }else if(r.status===401||r.status===403){
        diagnosis=`❌ Auth rejected (HTTP ${r.status}). Token invalid or expired.`;
      }else if(r.status===404){
        diagnosis='❌ 404 — /api/public/get/wilayas not found. NOEST API may have changed.';
      }else{
        diagnosis=`HTTP ${r.status} — ${txt.slice(0,200)}`;
      }
      steps.push({step:'noest_wilayas',url:wilayaUrl,status:r.status,response:txt.slice(0,500),diagnosis});
    }catch(e){steps.push({step:'noest_wilayas',url:wilayaUrl,error:e.message,diagnosis:'Network error: '+e.message});}

    // 2) GET /api/public/fees — pricing test
    try{
      const feesUrl=origin+'/api/public/fees';
      const r=await fetch(feesUrl,{method:'GET',headers:noestHeaders,redirect:'follow',signal:AbortSignal.timeout(10000)});
      const txt=await r.text();
      let parsed;try{parsed=JSON.parse(txt);}catch{}
      steps.push({step:'noest_fees',url:feesUrl,status:r.status,
        response:txt.slice(0,500),
        diagnosis:r.status===200&&parsed?.tarifs?`✅ Fees loaded (${Object.keys(parsed.tarifs?.delivery||{}).length} wilayas)`
          :r.status===200&&parsed?.message==='Unauthenticated.'?'❌ Unauthenticated'
          :`HTTP ${r.status} — ${txt.slice(0,200)}`});
    }catch(e){steps.push({step:'noest_fees',error:e.message});}

    // 2b) Fetch a real commune name from NOEST for the test order
    let testCommune='Alger Centre';
    let testZip='';
    try{
      const cr=await fetch(origin+'/api/public/get/communes/16',{method:'GET',headers:noestHeaders,signal:AbortSignal.timeout(8000)});
      const ct=await cr.text();let ca;try{ca=JSON.parse(ct);}catch{}
      if(Array.isArray(ca)&&ca.length>0){
        const active=ca.find(c=>c.is_active===1)||ca[0];
        testCommune=active.nom||testCommune;
        testZip=active.code_postal||'';
      }
    }catch{}

    // 3) POST /api/public/create/order — test order creation
    const createUrl=origin+'/api/public/create/order';
    const createBody=JSON.stringify({
      user_guid:userGuid,reference:'DIAG_'+Date.now(),
      client:'Test Diagnostic',phone:'0555000000',
      adresse:'123 Rue Test',wilaya_id:16,commune:testCommune,
      montant:1000,produit:'Test Item',type_id:1,
      delivery_type:1,stop_desk:0,can_open:1,poids:0.5
    });
    let createdTracking='';
    try{
      const{r,redirected}=await postWithRedirect(createUrl,noestHeaders,createBody,15000);
      const txt=await r.text();
      let parsed;try{parsed=JSON.parse(txt);}catch{}
      createdTracking=parsed?.tracking||'';
      let diagnosis='';
      if(r.status===200&&parsed?.success&&createdTracking){
        diagnosis=`✅ Order created — tracking: ${createdTracking}`;
      }else if(r.status===200&&parsed?.success===false){
        diagnosis=`❌ Rejected: ${parsed.message||JSON.stringify(parsed).slice(0,200)}`;
      }else if(r.status===422){
        const errs=parsed?.errors||parsed;
        diagnosis=`⚠️ Validation error (422) — ${JSON.stringify(errs).slice(0,300)}`;
      }else if(r.status===401||r.status===403){
        diagnosis=`❌ Auth rejected (${r.status})`;
      }else{
        diagnosis=`HTTP ${r.status} — ${txt.slice(0,200)}`;
      }
      steps.push({step:'noest_create_order',url:createUrl,status:r.status,
        request_body:createBody.slice(0,400),response:txt.slice(0,500),
        tracking:createdTracking||null,redirect:redirected||undefined,diagnosis});
    }catch(e){steps.push({step:'noest_create_order',url:createUrl,error:e.message,diagnosis:'Network error: '+e.message});}

    // 4) Cleanup test order
    if(createdTracking){
      try{
        const delUrl=origin+'/api/public/delete/order';
        const delBody=JSON.stringify({user_guid:userGuid,tracking:createdTracking});
        const dr=await fetch(delUrl,{method:'POST',headers:noestHeaders,body:delBody,signal:AbortSignal.timeout(10000)});
        const dtxt=await dr.text();
        steps.push({step:'noest_cleanup',tracking:createdTracking,url:delUrl,status:dr.status,
          diagnosis:dr.ok?'Cleaned up test order':'Cleanup may have failed'});
      }catch(e){steps.push({step:'noest_cleanup',error:e.message});}
    }

    // 5) carrierCreateOrder production code path
    try{
      const fakeOrder={order_number:'DIAG2_'+Date.now(),customer_name:'Test Diagnostic',customer_phone:'0555000000',
        shipping_address:'123 Rue Test',shipping_city:testCommune,shipping_wilaya:'Alger',shipping_wilaya_code:'16',
        shipping_zip:'16000',total:1000,subtotal:1000,shipping_cost:0,discount:0,shipping_type:'home',
        payment_method:'cod',notes:'Diagnostic',currency:'DZD'};
      const fakeItems=[{product_name:'Test Item',quantity:1,unit_price:1000,weight:1}];
      const result=await carrierCreateOrder(dc,fakeOrder,fakeItems);
      let diagnosis='';
      if(result.ok&&result.tracking_number)diagnosis=`✅ carrierCreateOrder SUCCEEDED — tracking: ${result.tracking_number}`;
      else if(result.ok)diagnosis='⚠️ ok but no tracking number';
      else diagnosis=`❌ carrierCreateOrder FAILED: ${result.err||'unknown'}`;
      steps.push({step:'noest_dispatch_codepath',diagnosis,ok:result.ok,
        tracking_number:result.tracking_number||null,error:result.err||null,
        request_url:result.request_url||null,request_body:(result.request_body||'').slice(0,300),
        tried:result.tried||[]});
      if(result.ok&&result.tracking_number){
        try{await carrierDeleteOrder(dc,result.tracking_number);}catch{}}
    }catch(e){steps.push({step:'noest_dispatch_codepath',error:e.message,diagnosis:'Exception: '+e.message});}

    // 6) Summary
    const wilayaOk=steps.some(s=>s.step==='noest_wilayas'&&s.diagnosis?.includes('✅'));
    const createOk=steps.some(s=>(s.step==='noest_create_order'||s.step==='noest_dispatch_codepath')&&s.diagnosis?.includes('✅'));
    let summary='';
    if(wilayaOk&&createOk)summary='✅ NOEST integration fully working. Auth OK, create order OK.';
    else if(wilayaOk&&!createOk)summary='⚠️ Auth works but create order failed. Check user_guid and order data.';
    else if(!apiToken)summary='❌ No api_token configured. Set it in the API Key field.';
    else summary='❌ Auth failed. Your api_token may be expired or invalid. Get a fresh token from NOEST dashboard (app.noest-dz.com).';

    steps.push({step:'noest_summary',diagnosis:summary});
    return res.json({carrier:'noest',api_base_url:dc.api_base_url,api_auth_type:dc.api_auth_type,
      token_present:!!apiToken,user_guid_present:!!userGuid,summary,steps});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OTHER CARRIERS — existing diagnosis flow
  // ═══════════════════════════════════════════════════════════════════════════

  // Step 1: Token validation (EcoTrack family)
  if(carrier==='ecotrack'){
    let valUrl=base+'/validate/token?api_token='+encodeURIComponent(dc.api_key||'');
    try{
      const r=await fetch(valUrl,{method:'GET',headers:{'Accept':'application/json'},signal:AbortSignal.timeout(10000)});
      const txt=await r.text();
      let diagnosis='';
      if(r.status===200){try{const j=JSON.parse(txt);diagnosis=j.valid===false?'TOKEN INVALID — get a new token from your carrier dashboard':'Token accepted';}catch{diagnosis='Got 200 but non-JSON response';}}
      else diagnosis=`HTTP ${r.status} — token may be invalid or endpoint unavailable`;
      steps.push({step:'token_validation',url:valUrl,status:r.status,response:txt.slice(0,500),diagnosis});
    }catch(e){steps.push({step:'token_validation',url:valUrl,error:e.message,diagnosis:'Network error — is the carrier API reachable?'});}
  }

  // Step 2: List orders probe
  let listUrl=base;
  if(carrier==='ecotrack')listUrl+='/get/orders?page=1';
  else if(carrier==='yalidine')listUrl+='/parcels/?page=1&page_size=1';
  else listUrl+='/get/orders';
  if(carrier==='ecotrack'&&dc.api_key)listUrl+='&api_token='+encodeURIComponent(dc.api_key);
  const listHeaders={'Accept':'application/json'};
  if(dc.api_auth_type==='bearer'&&dc.api_key)listHeaders['Authorization']='Bearer '+dc.api_key;
  else if(dc.api_auth_type==='custom_headers')Object.assign(listHeaders,parseJson(dc.api_headers));
  try{
    const r=await fetch(listUrl,{method:'GET',headers:listHeaders,signal:AbortSignal.timeout(10000)});
    const txt=await r.text();
    let diagnosis='';
    if(r.status===200)diagnosis='API access works — can read orders';
    else if(r.status===401||r.status===403)diagnosis='AUTH FAILED — token rejected. Check your API key.';
    else diagnosis=`Unexpected HTTP ${r.status}`;
    steps.push({step:'list_orders',url:listUrl,status:r.status,response:txt.slice(0,1000),diagnosis});
  }catch(e){steps.push({step:'list_orders',url:listUrl,error:e.message,diagnosis:'Network error'});}

  // Step 3a: Raw fetch create (diagnose the HTTP layer)
  const testRef='DIAG_'+Date.now();
  let createUrl=base+'/create/order/';
  if(carrier==='ecotrack'&&dc.api_key)createUrl+='?api_token='+encodeURIComponent(dc.api_key);
  const createHeaders={'Content-Type':'application/json','Accept':'application/json'};
  if(dc.api_auth_type==='bearer'&&dc.api_key)createHeaders['Authorization']='Bearer '+dc.api_key;
  else if(dc.api_auth_type==='custom_headers')Object.assign(createHeaders,parseJson(dc.api_headers));
  const createBody=JSON.stringify({
    reference:testRef,nom_client:'Test Diagnostic',telephone:'0555000000',telephone_2:'',
    adresse:'123 Rue Test',code_wilaya:16,commune:'Alger Centre',
    montant:1000,remarque:'Diagnostic test — please ignore',produit:'Test Item',
    stock:0,quantite:'1',type:1,stop_desk:0,weight:'1',fragile:0
  });
  try{
    const{r,redirected}=await postWithRedirect(createUrl,createHeaders,createBody);
    const txt=await r.text();
    let diagnosis='';
    if(redirected)diagnosis=`Server redirected (${redirected.code}) from ${redirected.from} to ${redirected.to} — we re-POSTed to the new URL. `;
    if(r.status===200||r.status===201){
      try{
        const j=JSON.parse(txt);
        if(j.tracking||j.tracking_number||j.data?.tracking)diagnosis+='ORDER CREATED SUCCESSFULLY — tracking number received';
        else if(j.error||j.errors)diagnosis+='CARRIER RETURNED ERROR: '+(j.error||JSON.stringify(j.errors).slice(0,200));
        else if(j.success===false)diagnosis+='CARRIER REJECTED: '+(j.message||j.msg||JSON.stringify(j).slice(0,200));
        else diagnosis+='Got 200 but no tracking in response — check response body below';
      }catch{diagnosis+='Got 200 but non-JSON response';}
    }else if(r.status===405){
      diagnosis+='METHOD NOT ALLOWED (405) — the server received a GET instead of POST. This happens when the server redirects and the POST becomes a GET.';
    }else if(r.status===401||r.status===403){
      diagnosis+='AUTH FAILED on create — your token may lack write permissions';
    }else if(r.status===422){
      diagnosis+='VALIDATION ERROR (422) — the carrier rejected the order data. Check the response for which fields are wrong.';
    }else{
      diagnosis+=`HTTP ${r.status} — unexpected response`;
    }
    const step={step:'create_order_raw_fetch',url:createUrl,method:'POST',headers_sent:createHeaders,body_sent:createBody,status:r.status,response:txt.slice(0,3000),diagnosis};
    if(redirected)step.redirect=redirected;
    steps.push(step);
    let parsed;try{parsed=JSON.parse(txt);}catch{}
    const tn=parsed?.tracking||parsed?.tracking_number||parsed?.data?.tracking||'';
    if(tn){
      const delUrl=base+'/delete/order?tracking='+encodeURIComponent(tn)+(dc.api_key?'&api_token='+encodeURIComponent(dc.api_key):'');
      try{
        const dr=await fetch(delUrl,{method:'DELETE',headers:createHeaders,signal:AbortSignal.timeout(10000)});
        const dtxt=await dr.text();
        steps.push({step:'cleanup_raw_test',tracking:tn,url:delUrl,status:dr.status,response:dtxt.slice(0,500),diagnosis:'Cleaned up raw test order'});
      }catch(e){steps.push({step:'cleanup_raw_test',tracking:tn,error:e.message});}
    }
  }catch(e){steps.push({step:'create_order_raw_fetch',url:createUrl,error:e.message,diagnosis:'Network/fetch error: '+e.message});}

  // Step 3b: carrierCreateOrder (EXACT same code path as real dispatch)
  try{
    const fakeOrder={order_number:'DIAG_'+Date.now(),customer_name:'Test Diagnostic',customer_phone:'0555000000',
      shipping_address:'123 Rue Test',shipping_city:'Alger Centre',shipping_wilaya:'Alger',shipping_wilaya_code:'16',
      shipping_zip:'16000',total:1000,subtotal:1000,shipping_cost:0,discount:0,shipping_type:'home',
      payment_method:'cod',notes:'Diagnostic test — please ignore',currency:'DZD'};
    const fakeItems=[{product_name:'Test Item',quantity:1,unit_price:1000,weight:1}];
    const result=await carrierCreateOrder(dc,fakeOrder,fakeItems);
    let diagnosis='';
    if(result.ok&&result.tracking_number)diagnosis=`carrierCreateOrder SUCCEEDED — tracking: ${result.tracking_number}`;
    else if(result.ok&&!result.tracking_number)diagnosis='carrierCreateOrder returned ok:true but NO tracking number — this means we think it worked but carrier may have rejected it silently';
    else diagnosis=`carrierCreateOrder FAILED: ${result.err||'unknown error'}`;
    steps.push({
      step:'create_order_via_carrierCreateOrder',
      diagnosis,
      status:result.status||null,
      ok:result.ok,
      tracking_number:result.tracking_number||null,
      error:result.err||null,
      request_url:result.request_url||null,
      request_body:result.request_body||null,
      response:JSON.stringify(result.carrier_response||{}).slice(0,3000),
      tried:result.tried||[],
    });
    if(result.ok&&result.tracking_number){
      try{
        const del=await carrierDeleteOrder(dc,result.tracking_number);
        steps.push({step:'cleanup_dispatch_test',tracking:result.tracking_number,ok:del.ok,
          response:JSON.stringify(del).slice(0,500),diagnosis:del.ok?'Cleaned up':'Cleanup failed — delete manually from carrier dashboard'});
      }catch(e){steps.push({step:'cleanup_dispatch_test',tracking:result.tracking_number,error:e.message});}
    }
  }catch(e){steps.push({step:'create_order_via_carrierCreateOrder',error:e.message,diagnosis:'carrierCreateOrder threw exception: '+e.message});}

  // Step 4: Get wilayas
  if(carrier==='ecotrack'){
    let wUrl=base+'/get/wilayas';
    if(dc.api_key)wUrl+='?api_token='+encodeURIComponent(dc.api_key);
    try{
      const r=await fetch(wUrl,{method:'GET',headers:listHeaders,signal:AbortSignal.timeout(10000)});
      const txt=await r.text();
      steps.push({step:'get_wilayas',url:wUrl,status:r.status,response:txt.slice(0,500),diagnosis:r.status===200?'Wilayas endpoint works':'Failed to fetch wilayas'});
    }catch(e){steps.push({step:'get_wilayas',url:wUrl,error:e.message});}
  }

  res.json({carrier,api_base_url:dc.api_base_url,api_auth_type:dc.api_auth_type,has_api_key:!!dc.api_key,steps});
}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;

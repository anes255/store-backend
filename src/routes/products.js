const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware}=require('../middleware/auth'),slugify=require('slugify');
const { loadPlanFeatures, enforceQuota } = require('../middleware/planFeatures');

// Helper: convert empty strings to null for UUID fields
const nullIfEmpty = (v) => (v === '' || v === undefined || v === null) ? null : v;

// Helper: normalize quantity offer tiers. A tier is kept as long as it has a
// valid quantity (>0). The label is optional and auto-generated when missing so
// tiers never silently disappear after a save/reload.
const normalizeQuantityOffers = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(q => {
      const quantity = parseInt(q?.quantity) || 0;
      const discount_type = q?.discount_type === 'fixed' ? 'fixed' : 'percent';
      const discount_value = parseFloat(q?.discount_value) || 0;
      const free_shipping = !!q?.free_shipping;
      let label = String(q?.label || '').trim();
      if (!label) {
        const parts = [];
        if (discount_value > 0) parts.push(discount_type === 'fixed' ? `-${discount_value}` : `${discount_value}% OFF`);
        if (free_shipping) parts.push('Free shipping');
        label = parts.join(' + ') || `Buy ${quantity}`;
      }
      return { quantity, label, discount_type, discount_value, free_shipping, highlight: !!q?.highlight };
    })
    .filter(q => q.quantity > 0);
};

// Self-heal: add quantity_offers JSONB column on demand so older deployments
// keep working after this rolls out.
let _qoColReady = null;
function ensureQuantityOffersCol() {
  if (_qoColReady) return _qoColReady;
  _qoColReady = (async () => {
    try { await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity_offers JSONB DEFAULT '[]'::jsonb"); } catch(e) { _qoColReady = null; }
  })();
  return _qoColReady;
}
ensureQuantityOffersCol();

// Self-heal: add offer columns for per-product limited-time offers
let _offerColsReady = null;
function ensureOfferCols() {
  if (_offerColsReady) return _offerColsReady;
  _offerColsReady = (async () => {
    try {
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_on_sale BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_badge_text TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_title TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_discount TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_hours INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_minutes INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS weight NUMERIC DEFAULT 0`);
    } catch(e) { _offerColsReady = null; }
  })();
  return _offerColsReady;
}
ensureOfferCols();

// Get products
router.get('/stores/:sid/products',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{search,category}=req.query;let q='SELECT p.*,c.name as category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.store_id=$1';const params=[req.params.sid];if(search){params.push(`%${search}%`);q+=` AND p.name ILIKE $${params.length}`;}if(category&&category!==''){params.push(category);q+=` AND p.category_id=$${params.length}`;}q+=' ORDER BY p.created_at DESC';const r=await pool.query(q,params);const count=await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1',[req.params.sid]);const products=r.rows.map(p=>{let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];return{...p,name_en:p.name,name_fr:p.name,name_ar:p.name,images:imgs,thumbnail:imgs[0]||null,compare_at_price:p.compare_price};});res.json({products,total:parseInt(count.rows[0].count)});}catch(e){console.error('GET products error:',e.message);res.status(500).json({error:e.message});}});

// Create product — enforces plan product quota
router.post('/stores/:sid/products',authMiddleware(['store_owner','store_staff']),loadPlanFeatures,enforceQuota({type:'products'}),async(req,res)=>{try{await ensureQuantityOffersCol();await ensureOfferCols();const{name_en,description_en,price,compare_at_price,cost_price,sku,barcode,stock_quantity,category_id,images,is_featured,tags,variants,allow_oversell,coupon_code,coupon_discount_percent,coupon_active,quantity_offers,weight}=req.body;const name=name_en||'Product';const slug=slugify(name,{lower:true,strict:true})+'-'+Date.now().toString(36);let imgs=Array.isArray(images)?images:[];const qOffers=normalizeQuantityOffers(quantity_offers);const r=await pool.query('INSERT INTO products(store_id,category_id,name,slug,description,price,compare_price,cost_price,sku,barcode,stock_quantity,images,is_featured,tags,variants,allow_oversell,coupon_code,coupon_discount_percent,coupon_active,quantity_offers,weight) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18,$19,$20::jsonb,$21) RETURNING *',[req.params.sid,nullIfEmpty(category_id),name,slug,description_en||null,price||0,nullIfEmpty(compare_at_price),nullIfEmpty(cost_price),nullIfEmpty(sku),nullIfEmpty(barcode),stock_quantity||0,JSON.stringify(imgs),is_featured||false,tags||[],variants?JSON.stringify(variants):null,!!allow_oversell,nullIfEmpty((coupon_code||'').toString().trim().toUpperCase()),parseFloat(coupon_discount_percent)||0,!!coupon_active,JSON.stringify(qOffers),parseFloat(weight)||0]);const p=r.rows[0];res.status(201).json({...p,name_en:p.name,thumbnail:imgs[0]||null,compare_at_price:p.compare_price});}catch(e){console.error('CREATE product error:',e.message);res.status(500).json({error:e.message});}});

// Update product — FIX: convert empty strings to null for UUID/numeric fields
router.put('/stores/:sid/products/:pid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const f=req.body;const u=[],v=[];let i=1;
// Simple text/number fields
if(f.name_en!==undefined){u.push(`name=$${i}`);v.push(f.name_en);i++;}
if(f.description_en!==undefined){u.push(`description=$${i}`);v.push(f.description_en||null);i++;}
if(f.price!==undefined){u.push(`price=$${i}`);v.push(f.price||0);i++;}
if(f.compare_at_price!==undefined){u.push(`compare_price=$${i}`);v.push(nullIfEmpty(f.compare_at_price));i++;}
if(f.cost_price!==undefined){u.push(`cost_price=$${i}`);v.push(nullIfEmpty(f.cost_price));i++;}
if(f.sku!==undefined){u.push(`sku=$${i}`);v.push(nullIfEmpty(f.sku));i++;}
if(f.barcode!==undefined){u.push(`barcode=$${i}`);v.push(nullIfEmpty(f.barcode));i++;}
if(f.stock_quantity!==undefined){u.push(`stock_quantity=$${i}`);v.push(parseInt(f.stock_quantity)||0);i++;}
if(f.weight!==undefined){await ensureOfferCols();u.push(`weight=$${i}`);v.push(parseFloat(f.weight)||0);i++;}
if(f.category_id!==undefined){u.push(`category_id=$${i}`);v.push(nullIfEmpty(f.category_id));i++;}
if(f.is_active!==undefined){u.push(`is_active=$${i}`);v.push(f.is_active);i++;}
if(f.is_featured!==undefined){u.push(`is_featured=$${i}`);v.push(f.is_featured);i++;}
if(f.track_inventory!==undefined){u.push(`track_inventory=$${i}`);v.push(f.track_inventory);i++;}
if(f.allow_oversell!==undefined){u.push(`allow_oversell=$${i}`);v.push(!!f.allow_oversell);i++;}
if(f.images!==undefined){u.push(`images=$${i}::jsonb`);v.push(JSON.stringify(Array.isArray(f.images)?f.images:[]));i++;}
if(f.tags!==undefined){u.push(`tags=$${i}`);v.push(f.tags||[]);i++;}
if(f.variants!==undefined){u.push(`variants=$${i}::jsonb`);v.push(f.variants?JSON.stringify(f.variants):null);i++;}
if(f.coupon_code!==undefined){u.push(`coupon_code=$${i}`);v.push(nullIfEmpty((f.coupon_code||'').toString().trim().toUpperCase()));i++;}
if(f.coupon_discount_percent!==undefined){u.push(`coupon_discount_percent=$${i}`);v.push(parseFloat(f.coupon_discount_percent)||0);i++;}
if(f.coupon_active!==undefined){u.push(`coupon_active=$${i}`);v.push(!!f.coupon_active);i++;}
if(f.is_on_sale!==undefined){await ensureOfferCols();u.push(`is_on_sale=$${i}`);v.push(!!f.is_on_sale);i++;}
if(f.sale_badge_text!==undefined){u.push(`sale_badge_text=$${i}`);v.push(f.sale_badge_text||'');i++;}
if(f.offer_title!==undefined){u.push(`offer_title=$${i}`);v.push(f.offer_title||'');i++;}
if(f.offer_discount!==undefined){u.push(`offer_discount=$${i}`);v.push(f.offer_discount||'');i++;}
if(f.offer_hours!==undefined){u.push(`offer_hours=$${i}`);v.push(parseInt(f.offer_hours)||0);i++;}
if(f.offer_minutes!==undefined){u.push(`offer_minutes=$${i}`);v.push(parseInt(f.offer_minutes)||0);i++;}
if(f.quantity_offers!==undefined){await ensureQuantityOffersCol();const qOffers=normalizeQuantityOffers(f.quantity_offers);u.push(`quantity_offers=$${i}::jsonb`);v.push(JSON.stringify(qOffers));i++;}
if(!u.length)return res.status(400).json({error:'Nothing to update'});
v.push(req.params.pid,req.params.sid);
const r=await pool.query(`UPDATE products SET ${u.join(',')},updated_at=NOW() WHERE id=$${i} AND store_id=$${i+1} RETURNING *`,v);
if(!r.rows.length)return res.status(404).json({error:'Not found'});
const p=r.rows[0];let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];
res.json({...p,name_en:p.name,images:imgs,thumbnail:imgs[0]||null,compare_at_price:p.compare_price});
}catch(e){console.error('UPDATE product error:',e.message);res.status(500).json({error:e.message});}});

// Delete product
router.delete('/stores/:sid/products/:pid',authMiddleware(['store_owner']),async(req,res)=>{try{
  const old=(await pool.query('SELECT name FROM products WHERE id=$1 AND store_id=$2',[req.params.pid,req.params.sid])).rows[0];
  await pool.query('DELETE FROM products WHERE id=$1 AND store_id=$2',[req.params.pid,req.params.sid]);
  try{const{logActivity}=require('./storeOwner');await logActivity(req.params.sid,req,'product_delete','product',req.params.pid,old?.name||null);}catch{}
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Categories
router.get('/stores/:sid/categories',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const r=await pool.query('SELECT c.*,(SELECT COUNT(*) FROM products WHERE category_id=c.id) as product_count FROM categories c WHERE c.store_id=$1 ORDER BY c.sort_order',[req.params.sid]);res.json(r.rows.map(c=>({...c,name_en:c.name,name_fr:c.name,name_ar:c.name,image:c.image_url})));}catch(e){res.json([]);}});
router.post('/stores/:sid/categories',authMiddleware(['store_owner']),async(req,res)=>{try{const{name_en,image,parent_id}=req.body;const name=name_en||'Category';const slug=slugify(name,{lower:true,strict:true})+'-'+Date.now().toString(36);const r=await pool.query('INSERT INTO categories(store_id,name,slug,image_url,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.sid,name,slug,image||null,nullIfEmpty(parent_id)]);res.status(201).json({...r.rows[0],name_en:r.rows[0].name});}catch(e){res.status(500).json({error:e.message});}});

// Apps
router.get('/stores/:sid/apps',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM store_apps WHERE store_id=$1',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/apps/install',authMiddleware(['store_owner']),async(req,res)=>{try{const{app_name,app_slug}=req.body;const ex=await pool.query('SELECT id,is_active FROM store_apps WHERE store_id=$1 AND app_slug=$2',[req.params.sid,app_slug]);if(ex.rows.length){const r=await pool.query('UPDATE store_apps SET is_active=NOT is_active WHERE id=$1 RETURNING *',[ex.rows[0].id]);return res.json(r.rows[0]);}const r=await pool.query('INSERT INTO store_apps(store_id,app_name,app_slug,is_active) VALUES($1,$2,$3,TRUE) RETURNING *',[req.params.sid,app_name,app_slug]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;

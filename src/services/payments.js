const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware}=require('../middleware/auth');
const chargily=require('../services/chargily');
const messaging=require('../services/messaging');

// ═══════════════════════════════════════════
// CHARGILY PAY — Create checkout
// ═══════════════════════════════════════════
router.post('/chargily/checkout',async(req,res)=>{try{
  const{store_slug,order_id}=req.body;

  const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[store_slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[order_id,store.id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});

  if(!chargily.isConfigured())return res.status(503).json({error:'Online payment not configured'});

  const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
  const baseUrl=req.headers.origin||`https://${req.headers.host}`;

  const result=await chargily.createCheckout({
    amount:order.total,
    currency:'dzd',
    orderId:order.id,
    orderNumber:orderNum,
    storeId:store.id,
    customerName:order.customer_name,
    customerEmail:order.customer_email,
    customerPhone:order.customer_phone,
    successUrl:`${baseUrl}/s/${store.slug}/checkout?status=success&order=${order.id}`,
    failureUrl:`${baseUrl}/s/${store.slug}/checkout?status=failed&order=${order.id}`,
    webhookUrl:`${baseUrl}/api/payments/chargily/webhook`,
    description:`Order ${orderNum} - ${store.store_name}`,
  });

  // Save checkout ID to order
  await pool.query("UPDATE orders SET payment_reference=$1,payment_method='chargily' WHERE id=$2",[result.checkoutId,order.id]);

  res.json({checkoutUrl:result.checkoutUrl,checkoutId:result.checkoutId});
}catch(e){console.error('[Chargily]',e.message);res.status(500).json({error:e.message});}});


// ═══════════════════════════════════════════
// CHARGILY WEBHOOK — Payment confirmation
// ═══════════════════════════════════════════
router.post('/chargily/webhook',express.raw({type:'application/json'}),async(req,res)=>{try{
  const signature=req.headers['signature']||req.headers['x-signature']||'';
  const rawBody=typeof req.body==='string'?req.body:JSON.stringify(req.body);

  // Verify signature
  if(!chargily.verifyWebhookSignature(rawBody,signature)){
    console.warn('[Chargily Webhook] Invalid signature');
    return res.status(400).json({error:'Invalid signature'});
  }

  const event=typeof req.body==='string'?JSON.parse(req.body):req.body;
  console.log('[Chargily Webhook]',event.type,event.data?.id);

  if(event.type==='checkout.paid'||event.type==='checkout.completed'){
    const checkout=event.data;
    const orderId=checkout.metadata?.order_id;
    if(!orderId)return res.json({received:true});

    // Update order as paid
    await pool.query("UPDATE orders SET payment_status='paid',payment_reference=$1,updated_at=NOW() WHERE id=$2",[checkout.id,orderId]);

    // Send confirmation notification
    const order=(await pool.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
    if(order){
      const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[order.store_id])).rows[0];
      if(store&&order.customer_phone){
        const cfg=store.config||{};
        const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
        const msg=messaging.orderConfirmationMessage(store.store_name,orderNum,order.total,store.currency||'DZD');
        const channel=cfg.ai_channel||'WHATSAPP';
        if(channel==='WHATSAPP')await messaging.sendWhatsApp(order.customer_phone,msg);
      }
      // Send email
      if(order.customer_email){
        const store2=(await pool.query('SELECT * FROM stores WHERE id=$1',[order.store_id])).rows[0];
        const items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[orderId])).rows;
        const orderNum2='ORD-'+String(order.order_number).padStart(5,'0');
        await messaging.sendEmail({
          to:order.customer_email,
          subject:`Payment confirmed — ${orderNum2}`,
          html:messaging.orderConfirmationHTML(store2?.store_name||'Store',orderNum2,order.total,store2?.currency||'DZD',items),
        });
      }
    }
  }

  if(event.type==='checkout.failed'){
    const checkout=event.data;
    const orderId=checkout.metadata?.order_id;
    if(orderId)await pool.query("UPDATE orders SET payment_status='failed',updated_at=NOW() WHERE id=$1",[orderId]);
  }

  res.json({received:true});
}catch(e){console.error('[Chargily Webhook Error]',e.message);res.status(500).json({error:e.message});}});


// ═══════════════════════════════════════════
// MANUAL PAYMENT — Receipt upload (CCP / BaridiMob / Bank)
// ═══════════════════════════════════════════

// Upload payment receipt (base64 image)
router.post('/receipt/upload',async(req,res)=>{try{
  const{store_slug,order_id,receipt_image,payment_method,reference_number}=req.body;

  if(!receipt_image)return res.status(400).json({error:'Receipt image required'});

  const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[store_slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[order_id,store.id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});

  // Ensure receipts table exists
  try{await pool.query(`CREATE TABLE IF NOT EXISTS payment_receipts(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES stores(id),
    order_id UUID REFERENCES orders(id),
    payment_method VARCHAR(50),
    reference_number VARCHAR(100),
    receipt_image TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);}catch(e){}

  // Save receipt
  const r=await pool.query(
    'INSERT INTO payment_receipts(store_id,order_id,payment_method,reference_number,receipt_image) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at',
    [store.id,order_id,payment_method||'ccp',reference_number||null,receipt_image]
  );

  // Update order payment status to pending verification
  await pool.query("UPDATE orders SET payment_status='pending_verification',payment_method=$1,payment_reference=$2,updated_at=NOW() WHERE id=$3",
    [payment_method||'ccp',reference_number||r.rows[0].id,order_id]);

  res.json({receipt_id:r.rows[0].id,status:'pending',message:'Receipt uploaded. Will be verified within 24 hours.'});
}catch(e){console.error('[Receipt]',e.message);res.status(500).json({error:e.message});}});

// Review receipt (store owner)
router.patch('/receipt/:rid/review',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{status,notes}=req.body; // status: 'approved' or 'rejected'

  const receipt=await pool.query('SELECT * FROM payment_receipts WHERE id=$1',[req.params.rid]);
  if(!receipt.rows.length)return res.status(404).json({error:'Not found'});
  const r=receipt.rows[0];

  await pool.query('UPDATE payment_receipts SET status=$1,notes=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$4',
    [status,notes||null,req.user.id,req.params.rid]);

  // Update order payment status
  if(status==='approved'){
    await pool.query("UPDATE orders SET payment_status='paid',updated_at=NOW() WHERE id=$1",[r.order_id]);
    
    // Send confirmation
    const order=(await pool.query('SELECT * FROM orders WHERE id=$1',[r.order_id])).rows[0];
    if(order?.customer_phone){
      const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[r.store_id])).rows[0];
      const cfg=store?.config||{};
      const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
      const msg=`✅ تم تأكيد الدفع للطلب ${orderNum}. شكراً!`;
      const channel=cfg.ai_channel||'WHATSAPP';
      if(channel==='WHATSAPP')await messaging.sendWhatsApp(order.customer_phone,msg);
    }
  }else if(status==='rejected'){
    await pool.query("UPDATE orders SET payment_status='failed',updated_at=NOW() WHERE id=$1",[r.order_id]);
  }

  res.json({status,receipt_id:req.params.rid});
}catch(e){res.status(500).json({error:e.message});}});

// Get pending receipts for store
router.get('/receipts/:sid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const r=await pool.query(
    'SELECT pr.*,o.customer_name,o.customer_phone,o.total,o.order_number FROM payment_receipts pr JOIN orders o ON o.id=pr.order_id WHERE pr.store_id=$1 ORDER BY pr.created_at DESC',
    [req.params.sid]
  );
  res.json(r.rows.map(x=>({...x,order_number:'ORD-'+String(x.order_number).padStart(5,'0')})));
}catch(e){res.json([]);}});

// Check Chargily status
router.get('/chargily/status',async(req,res)=>{
  res.json({configured:chargily.isConfigured()});
});

module.exports=router;

const pool=require('./db');
const bcrypt=require('bcryptjs');
const initDb=async()=>{
  try{
    try{await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');}catch(e){console.log('pgcrypto ext:',e.message);}
    const r=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('DB:',r.rows.length,'tables');

    // ═══════ BASE TABLES — create from scratch on fresh DB ═══════
    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_owners(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name VARCHAR(255) NOT NULL DEFAULT '',
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(50) UNIQUE,
      password_hash TEXT NOT NULL,
      address TEXT, city VARCHAR(100), wilaya VARCHAR(100),
      subscription_plan VARCHAR(50) DEFAULT 'free',
      subscription_status VARCHAR(50) DEFAULT 'active',
      subscription_expires_at TIMESTAMPTZ, subscription_paid_until TIMESTAMPTZ,
      username VARCHAR(100), two_fa_enabled BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_owners ready');}catch(e){console.log('store_owners:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS stores(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID REFERENCES store_owners(id) ON DELETE CASCADE,
      store_name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      description TEXT, logo_url TEXT, favicon_url TEXT, banner_url TEXT,
      primary_color VARCHAR(20) DEFAULT '#6366f1',
      secondary_color VARCHAR(20) DEFAULT '#8b5cf6',
      currency VARCHAR(10) DEFAULT 'DZD',
      phone VARCHAR(50), email VARCHAR(255), address TEXT,
      is_published BOOLEAN DEFAULT TRUE, is_active BOOLEAN DEFAULT TRUE,
      shipping_mode VARCHAR(20) DEFAULT 'wilaya',
      free_shipping_enabled BOOLEAN DEFAULT FALSE,
      free_shipping_threshold DECIMAL(12,2) DEFAULT 0,
      config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ stores ready');}catch(e){console.log('stores:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS categories(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, slug VARCHAR(255),
      image_url TEXT, parent_id UUID,
      sort_order INT DEFAULT 0, is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ categories ready');}catch(e){console.log('categories:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS products(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      category_id UUID,
      name VARCHAR(500) NOT NULL, slug VARCHAR(500),
      description TEXT,
      price DECIMAL(12,2) DEFAULT 0, compare_price DECIMAL(12,2), cost_price DECIMAL(12,2),
      sku VARCHAR(100), barcode VARCHAR(100),
      stock_quantity INT DEFAULT 0, allow_oversell BOOLEAN DEFAULT FALSE,
      images JSONB DEFAULT '[]'::jsonb, variants JSONB,
      is_featured BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE,
      tags TEXT[] DEFAULT '{}',
      views_count INT DEFAULT 0, sales_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ products ready');}catch(e){console.log('products:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS customers(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255), phone VARCHAR(50),
      password_hash TEXT,
      address TEXT, city VARCHAR(100), wilaya VARCHAR(100),
      total_orders INT DEFAULT 0, total_spent DECIMAL(12,2) DEFAULT 0,
      is_blocked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ customers ready');}catch(e){console.log('customers:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS orders(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      customer_id UUID,
      order_number INT,
      customer_name VARCHAR(255), customer_phone VARCHAR(50), customer_email VARCHAR(255),
      shipping_address TEXT, shipping_city VARCHAR(100), shipping_wilaya VARCHAR(100),
      shipping_zip VARCHAR(20), shipping_type VARCHAR(20) DEFAULT 'desk',
      subtotal DECIMAL(12,2) DEFAULT 0, shipping_cost DECIMAL(12,2) DEFAULT 0,
      discount DECIMAL(12,2) DEFAULT 0, total DECIMAL(12,2) DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'cod', payment_status VARCHAR(20) DEFAULT 'pending',
      payment_reference VARCHAR(255),
      notification_preference VARCHAR(20) DEFAULT 'whatsapp',
      notes TEXT,
      status VARCHAR(50) DEFAULT 'new',
      tracking_number VARCHAR(255), delivery_company_id UUID,
      tracking_status VARCHAR(50), tracking_updated_at TIMESTAMPTZ,
      is_archived BOOLEAN DEFAULT FALSE, archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ orders ready');}catch(e){console.log('orders:',e.message);}

    // Per-product coupon (admin-defined code that gives % off this product)
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(100)");}catch(e){}
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS coupon_discount_percent DECIMAL(5,2) DEFAULT 0");}catch(e){}
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS coupon_active BOOLEAN DEFAULT FALSE");}catch(e){}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS order_items(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      product_id UUID,
      product_name VARCHAR(500), product_image TEXT,
      variant_info TEXT,
      quantity INT DEFAULT 1,
      unit_price DECIMAL(12,2) DEFAULT 0, total_price DECIMAL(12,2) DEFAULT 0
    )`);console.log('✅ order_items ready');}catch(e){console.log('order_items:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      site_name VARCHAR(255) DEFAULT 'MakretDZ',
      primary_color VARCHAR(20) DEFAULT '#6366f1',
      secondary_color VARCHAR(20) DEFAULT '#8b5cf6',
      accent_color VARCHAR(20) DEFAULT '#f59e0b',
      logo_url TEXT, favicon_url TEXT,
      meta_description TEXT,
      currency VARCHAR(10) DEFAULT 'DZD',
      subscription_monthly_price DECIMAL(12,2) DEFAULT 0,
      subscription_yearly_price DECIMAL(12,2) DEFAULT 0,
      subscription_trial_days INT DEFAULT 7,
      subscription_trial_enabled BOOLEAN DEFAULT TRUE,
      subscription_trial_plan VARCHAR(50) DEFAULT 'basic',
      maintenance_mode BOOLEAN DEFAULT FALSE,
      admin_phone VARCHAR(50), admin_password_hash TEXT, admin_name VARCHAR(100),
      google_client_id VARCHAR(500),
      landing_blocks TEXT DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
      await pool.query("INSERT INTO platform_settings(site_name) SELECT 'MakretDZ' WHERE NOT EXISTS(SELECT 1 FROM platform_settings)");
      console.log('✅ platform_settings ready');}catch(e){console.log('platform_settings:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS delivery_companies(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, api_key TEXT,
      base_rate DECIMAL(12,2) DEFAULT 0,
      provider_type VARCHAR(50) DEFAULT 'manual',
      tracking_url VARCHAR(500), phone VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      api_base_url VARCHAR(500), api_auth_type VARCHAR(50) DEFAULT 'none',
      api_headers JSONB DEFAULT '{}'::jsonb,
      api_tracking_endpoint VARCHAR(500), api_status_path VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ delivery_companies ready');}catch(e){console.log('delivery_companies:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS shipping_wilayas(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      wilaya_name VARCHAR(100) NOT NULL, wilaya_code VARCHAR(10),
      desk_delivery_price DECIMAL(12,2) DEFAULT 0,
      home_delivery_price DECIMAL(12,2) DEFAULT 0,
      delivery_days INT DEFAULT 3,
      is_active BOOLEAN DEFAULT TRUE,
      home_enabled BOOLEAN DEFAULT TRUE,
      desk_enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ shipping_wilayas ready');}catch(e){console.log('shipping_wilayas:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS payment_settings(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE UNIQUE,
      cod_enabled BOOLEAN DEFAULT TRUE,
      ccp_enabled BOOLEAN DEFAULT FALSE, ccp_account VARCHAR(100), ccp_name VARCHAR(255),
      baridimob_enabled BOOLEAN DEFAULT FALSE, baridimob_phone VARCHAR(50),
      bank_transfer_enabled BOOLEAN DEFAULT FALSE, bank_name VARCHAR(255), bank_account VARCHAR(100), bank_rib VARCHAR(100),
      stripe_enabled BOOLEAN DEFAULT FALSE, stripe_public_key TEXT, stripe_secret_key TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ payment_settings ready');}catch(e){console.log('payment_settings:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_apps(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      app_name VARCHAR(255), app_slug VARCHAR(255),
      is_active BOOLEAN DEFAULT TRUE,
      config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_apps ready');}catch(e){console.log('store_apps:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_status_templates(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
      key VARCHAR(50) NOT NULL, label VARCHAR(100),
      color VARCHAR(20), enabled BOOLEAN DEFAULT TRUE,
      notify_customer BOOLEAN DEFAULT FALSE,
      position INT DEFAULT 0, is_builtin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_status_templates ready');}catch(e){console.log('store_status_templates:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS platform_admins(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name VARCHAR(255) NOT NULL DEFAULT '',
      phone VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255), password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'platform_admin',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ platform_admins ready');}catch(e){console.log('platform_admins:',e.message);}

    // ═══ Seed super admin only if platform_admins table is completely empty ═══
    try{
      const SUPER_PHONE='0779452212';
      const SUPER_PW='anesaya';
      const count=await pool.query('SELECT COUNT(*)::int AS c FROM platform_admins');
      if(count.rows[0].c===0){
        const hash=await bcrypt.hash(SUPER_PW,12);
        await pool.query(
          'INSERT INTO platform_admins(full_name,phone,password_hash,role,is_active) VALUES($1,$2,$3,$4,TRUE)',
          ['Super Admin',SUPER_PHONE,hash,'super_admin']
        );
        console.log('✅ super admin seeded:',SUPER_PHONE);
      }
    }catch(e){console.log('super admin seed:',e.message);}

    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb");console.log('✅ config column ready');}catch(e){console.log('config col:',e.message);}
    // Backfill missing brand-asset columns on legacy stores tables.
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS favicon_url TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS logo_url TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_url TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS bg_color VARCHAR(20)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS accent_color VARCHAR(20)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS meta_title VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS meta_description TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS hero_title VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS hero_subtitle TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS contact_address TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS social_facebook VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS social_instagram VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS social_tiktok VARCHAR(500)");}catch(e){}
    // Logos / favicons can be base64 dataURIs that exceed VARCHAR limits — force TEXT.
    try{await pool.query("ALTER TABLE stores ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE stores ALTER COLUMN banner_url TYPE TEXT");}catch(e){}
    console.log('✅ stores brand-asset columns ready');

    try{await pool.query(`CREATE TABLE IF NOT EXISTS payment_receipts(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),order_id UUID REFERENCES orders(id),
      payment_method VARCHAR(50),reference_number VARCHAR(100),receipt_image TEXT,
      status VARCHAR(20) DEFAULT 'pending',reviewed_by UUID,reviewed_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ payment_receipts ready');}catch(e){console.log('payment_receipts:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS blacklist(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      phone VARCHAR(50) NOT NULL,name VARCHAR(255),reason VARCHAR(255),cancelled_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ blacklist ready');}catch(e){console.log('blacklist:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS message_log(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),order_id UUID,
      channel VARCHAR(20),recipient VARCHAR(255),message_type VARCHAR(50),content TEXT,
      status VARCHAR(20) DEFAULT 'sent',external_id VARCHAR(255),error_message TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ message_log ready');}catch(e){console.log('message_log:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS expenses(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      description VARCHAR(500) NOT NULL,category VARCHAR(100) DEFAULT 'Other',amount DECIMAL(12,2) DEFAULT 0,
      date DATE DEFAULT CURRENT_DATE,status VARCHAR(20) DEFAULT 'Paid',created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ expenses ready');}catch(e){console.log('expenses:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_pages(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      page_type VARCHAR(50) DEFAULT 'faq',title TEXT DEFAULT '',content TEXT DEFAULT '',
      is_published BOOLEAN DEFAULT TRUE,sort_order INT DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_pages ready');}catch(e){console.log('store_pages:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS notifications(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      type VARCHAR(50) DEFAULT 'info',title VARCHAR(255) NOT NULL,message TEXT DEFAULT '',
      is_read BOOLEAN DEFAULT FALSE,link VARCHAR(255),created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ notifications ready');}catch(e){console.log('notifications:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS subscription_payments(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_id UUID REFERENCES store_owners(id),
      plan VARCHAR(50) DEFAULT 'basic',period VARCHAR(20) DEFAULT 'monthly',amount DECIMAL(12,2) DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'ccp',receipt_image TEXT,status VARCHAR(20) DEFAULT 'pending',
      reviewed_by VARCHAR(255),reviewed_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ subscription_payments ready');}catch(e){console.log('subscription_payments:',e.message);}

    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'active'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS notification_preference VARCHAR(20) DEFAULT 'whatsapp'");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_type VARCHAR(20) DEFAULT 'desk'");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS preferred_delivery_company_id UUID");}catch(e){}
    // Allow oversell — lets admins keep selling products even when stock is 0
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_oversell BOOLEAN DEFAULT FALSE");}catch(e){}
    // Store staff: ensure the table exists before any ALTERs run (some older deployments
    // never created it, which made staff creation fail).
    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_staff(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID NOT NULL,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(200),
      phone VARCHAR(30),
      password_hash TEXT NOT NULL,
      role VARCHAR(100) DEFAULT 'viewer',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);}catch(e){console.log('store_staff create:',e.message);}
    try{await pool.query("ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'");}catch(e){}
    try{await pool.query("ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS role_template_id UUID");}catch(e){}
    try{await pool.query("ALTER TABLE store_staff ALTER COLUMN role TYPE VARCHAR(200)");}catch(e){console.log('store_staff role widen:',e.message);}
    // Drop legacy valid_role CHECK constraint that rejects template/custom roles
    try{await pool.query("ALTER TABLE store_staff DROP CONSTRAINT IF EXISTS valid_role");}catch(e){}
    try{await pool.query("ALTER TABLE store_staff DROP CONSTRAINT IF EXISTS store_staff_role_check");}catch(e){}

    // ═══ Super-admin-defined staff role templates ═══
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS role_templates(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name_en VARCHAR(100) NOT NULL,
        name_fr VARCHAR(100) DEFAULT '',
        name_ar VARCHAR(100) DEFAULT '',
        description_en VARCHAR(255) DEFAULT '',
        description_fr VARCHAR(255) DEFAULT '',
        description_ar VARCHAR(255) DEFAULT '',
        permissions TEXT DEFAULT '[]',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM role_templates');
      if ((cnt.rows[0]?.c || 0) === 0) {
        await pool.query(
          `INSERT INTO role_templates(name_en,name_fr,name_ar,description_en,description_fr,description_ar,permissions,sort_order) VALUES
           ('Manager','Gérant','مدير','Full store access','Accès complet au magasin','وصول كامل للمتجر',
             '["view_dashboard","view_orders","manage_orders","view_products","manage_products","view_customers","manage_customers","view_analytics","manage_settings","manage_staff"]',1),
           ('Preparer','Préparateur','محضّر','Prepares and ships orders','Prépare et expédie les commandes','تحضير وشحن الطلبات',
             '["view_dashboard","view_orders","prepare_orders","view_products"]',2),
           ('Confirmer','Confirmateur','مؤكِّد','Confirms and validates orders','Confirme les commandes','تأكيد الطلبات',
             '["view_dashboard","view_orders","confirm_orders","view_customers"]',3),
           ('Accountant','Comptable','محاسب','Reads financials only','Accès en lecture aux finances','اطلاع على البيانات المالية',
             '["view_dashboard","view_orders","view_analytics","view_billing"]',4),
           ('Viewer','Observateur','مشاهد','Read-only access','Accès en lecture seule','اطلاع فقط',
             '["view_dashboard","view_orders","view_products","view_customers","view_analytics"]',5)
          `
        );
      }
      console.log('✅ role_templates ready');
    } catch(e){console.log('role_templates:',e.message);}

    // ═══ Super-admin-editable subscription plans ═══
    try{
      await pool.query(`CREATE TABLE IF NOT EXISTS plans(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(50) UNIQUE NOT NULL,
        name_en VARCHAR(100) NOT NULL,
        name_fr VARCHAR(100) DEFAULT '',
        name_ar VARCHAR(100) DEFAULT '',
        tagline_en VARCHAR(255) DEFAULT '',
        tagline_fr VARCHAR(255) DEFAULT '',
        tagline_ar VARCHAR(255) DEFAULT '',
        price_monthly DECIMAL(12,2) DEFAULT 0,
        price_yearly DECIMAL(12,2) DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'DZD',
        features_en TEXT DEFAULT '[]',
        features_fr TEXT DEFAULT '[]',
        features_ar TEXT DEFAULT '[]',
        feature_keys TEXT DEFAULT '[]',
        max_products INTEGER DEFAULT 0,
        max_orders_month INTEGER DEFAULT 0,
        max_staff INTEGER DEFAULT 0,
        is_popular BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      // Backfill columns on existing installs.
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_keys TEXT DEFAULT '[]'");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_products INTEGER DEFAULT 0");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_orders_month INTEGER DEFAULT 0");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_staff INTEGER DEFAULT 0");}catch{}
      // Seed two defaults on empty tables so the landing page isn't blank.
      const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM plans');
      if ((cnt.rows[0]?.c || 0) === 0) {
        await pool.query(
          `INSERT INTO plans(slug,name_en,name_fr,name_ar,tagline_en,tagline_fr,tagline_ar,price_monthly,price_yearly,features_en,features_fr,features_ar,feature_keys,max_products,max_orders_month,max_staff,is_popular,sort_order)
           VALUES
           ('starter','Starter','Débutant','المبتدئ','Perfect to get started','Idéal pour commencer','مثالي للبدء',0,0,
             '["1 store","Up to 50 products","Basic analytics","Email support"]',
             '["1 magasin","Jusqu''à 50 produits","Analyses de base","Support par e-mail"]',
             '["متجر واحد","حتى 50 منتج","تحليلات أساسية","دعم عبر البريد"]',
             '["basic_analytics","email_support"]',50,200,1,FALSE,1),
           ('pro','Pro','Pro','المحترف','For serious sellers','Pour les vendeurs sérieux','للبائعين الجادين',2500,25000,
             '["Unlimited stores","Unlimited products","Advanced analytics","AI features","Priority support","Custom domain"]',
             '["Magasins illimités","Produits illimités","Analyses avancées","Fonctionnalités IA","Support prioritaire","Domaine personnalisé"]',
             '["متاجر غير محدودة","منتجات غير محدودة","تحليلات متقدمة","ميزات الذكاء الاصطناعي","دعم ذو أولوية","نطاق مخصص"]',
             '["basic_analytics","advanced_analytics","ai_chatbot","ai_descriptions","ai_moderation","custom_domain","priority_support","page_builder","abandoned_cart","custom_html","unlimited_products","unlimited_orders","unlimited_staff"]',0,0,0,TRUE,2)
          `
        );
      }
      console.log('✅ plans ready');
    } catch(e){console.log('plans:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      endpoint TEXT NOT NULL,keys_p256dh TEXT,keys_auth TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ push_subscriptions ready');}catch(e){console.log('push_subscriptions:',e.message);}

    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS google_client_id VARCHAR(500)");}catch(e){}

    // ═══ NEW: Order tracking columns ═══
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_company_id UUID");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(50)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_updated_at TIMESTAMPTZ");}catch(e){}
    console.log('✅ order tracking columns ready');

    // ═══ NEW: Delivery companies — flexible API config ═══
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS provider_type VARCHAR(50) DEFAULT 'manual'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS phone VARCHAR(50)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS logo TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS company_prices JSONB DEFAULT '{}'::jsonb");}catch(e){}
    try{await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS wilaya_name_ar VARCHAR(100)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_base_url VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_auth_type VARCHAR(50) DEFAULT 'none'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_headers JSONB DEFAULT '{}'::jsonb");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_tracking_endpoint VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_status_path VARCHAR(255)");}catch(e){}
    // Extra auth-flow columns: query-string params, OAuth2 token URL +
    // client credentials, optional POST body template, HTTP method.
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_query_params JSONB DEFAULT '{}'::jsonb");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS oauth2_token_url VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS oauth2_credentials JSONB DEFAULT '{}'::jsonb");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_method VARCHAR(10) DEFAULT 'GET'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_body_template TEXT");}catch(e){}
    // Create-order endpoint columns: when present, the system pushes new orders
    // to the carrier's platform when the merchant transfers them.
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_endpoint VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_method VARCHAR(10) DEFAULT 'POST'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_body_template TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_tracking_path VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS sync_interval_minutes INT DEFAULT 10");}catch(e){}
    // Default carrier: the one pre-selected for the buyer at checkout. At most
    // one row per store may carry the flag (enforced by a partial unique index).
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS delivery_companies_one_default_per_store ON delivery_companies(store_id) WHERE is_default");}catch(e){}
    // Back-fill: any store with carriers but no default gets its oldest carrier.
    try{await pool.query(`UPDATE delivery_companies d SET is_default=TRUE WHERE d.id IN (
      SELECT DISTINCT ON (store_id) id FROM delivery_companies
      WHERE store_id NOT IN (SELECT store_id FROM delivery_companies WHERE is_default)
      ORDER BY store_id, created_at ASC)`);}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_data JSONB");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(40)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_id VARCHAR(120)");}catch(e){}
    console.log('✅ delivery_companies columns ready');
    // Fragile products: flagged on the product, copied onto each order line,
    // shown on the receipt and passed to the delivery company.
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS is_fragile BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_fragile BOOLEAN DEFAULT FALSE");}catch(e){}
    // Thumbnail shown next to an order notification in the dashboard bell.
    try{await pool.query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image TEXT");}catch(e){}
    // One-off cleanup: hide the empty orders earlier carrier syncs created.
    // Soft delete (is_deleted) so they stay recoverable from the vault view.
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE");}catch(e){}
    try{const r=await pool.query(`UPDATE orders o SET is_deleted=TRUE
      WHERE (o.is_deleted IS NOT TRUE)
        AND (o.source LIKE 'carrier%' OR o.customer_name='(carrier import)')
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id)
        AND (COALESCE(o.customer_phone,'')='' OR o.customer_name='(carrier import)')`);
      if(r.rowCount)console.log('🧹 hid',r.rowCount,'blank carrier-import orders');}catch(e){console.log('blank order cleanup:',e.message);}

    // ═══ NEW: Product reviews table ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS reviews(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      customer_id UUID,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50),
      rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
      title VARCHAR(255),
      content TEXT,
      is_approved BOOLEAN DEFAULT FALSE,
      is_rejected BOOLEAN DEFAULT FALSE,
      ai_moderation_score INT,
      ai_moderation_reason TEXT,
      admin_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ reviews ready');}catch(e){console.log('reviews:',e.message);}

    // ═══ NEW: Carts table for abandoned cart recovery ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS carts(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      customer_phone VARCHAR(50),
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      items JSONB DEFAULT '[]'::jsonb,
      total DECIMAL(12,2) DEFAULT 0,
      is_abandoned BOOLEAN DEFAULT FALSE,
      is_recovered BOOLEAN DEFAULT FALSE,
      recovery_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ carts ready');}catch(e){console.log('carts:',e.message);}
    // Backfill customer_email column
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`);}catch(e){}
    // Checkout-abandonment columns — store form fields so recovery can pre-fill
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS checkout_started BOOLEAN DEFAULT FALSE`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS shipping_address TEXT`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(100)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS shipping_wilaya VARCHAR(100)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS shipping_zip VARCHAR(20)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS shipping_type VARCHAR(20)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS delivery_company_id UUID`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS notification_preference VARCHAR(20)`);}catch(e){}
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS notes TEXT`);}catch(e){}

    // ═══ NEW: Store domains table ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_domains(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      domain_name VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(20) DEFAULT 'pending',
      ssl_status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_domains ready');}catch(e){console.log('store_domains:',e.message);}

    console.log('✅ DB init complete');
  }catch(e){console.error('DB init error:',e.message);}
};

module.exports={initDb};

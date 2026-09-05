/**
 * Chargily Pay Integration for Algeria
 * Supports Edahabia + CIB card payments
 * Docs: https://dev.chargily.com/pay-v2/api-reference
 */
const crypto = require('crypto');

const CHARGILY_API = 'https://pay.chargily.net/api/v2';
const API_KEY = process.env.CHARGILY_API_KEY || '';
const API_SECRET = process.env.CHARGILY_API_SECRET || '';

// Headers for Chargily API
const headers = () => ({
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
});

/**
 * Create a Chargily checkout session
 * @param {Object} opts
 * @param {number} opts.amount - Amount in DZD
 * @param {string} opts.currency - 'dzd' 
 * @param {string} opts.orderId - Your internal order ID
 * @param {string} opts.orderNumber - Display order number
 * @param {string} opts.customerName
 * @param {string} opts.customerEmail
 * @param {string} opts.customerPhone
 * @param {string} opts.successUrl - Redirect after payment
 * @param {string} opts.failureUrl - Redirect on cancel/fail
 * @param {string} opts.webhookUrl - Server webhook for confirmation
 * @param {string} opts.description
 */
async function createCheckout(opts) {
  if (!API_KEY) throw new Error('CHARGILY_API_KEY not configured');

  const body = {
    amount: opts.amount,
    currency: opts.currency || 'dzd',
    success_url: opts.successUrl,
    failure_url: opts.failureUrl,
    webhook_endpoint: opts.webhookUrl || null,
    description: opts.description || `Order ${opts.orderNumber}`,
    locale: 'ar', // Arabic by default, can be 'fr' or 'en'
    metadata: {
      order_id: opts.orderId,
      order_number: opts.orderNumber,
      store_id: opts.storeId,
    },
  };

  // Add customer if email provided
  if (opts.customerEmail) {
    body.customer = {
      name: opts.customerName || 'Customer',
      email: opts.customerEmail,
      phone: opts.customerPhone || null,
    };
  }

  const res = await fetch(`${CHARGILY_API}/checkouts`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Chargily checkout error:', err);
    throw new Error(`Chargily error: ${res.status}`);
  }

  const data = await res.json();
  return {
    checkoutId: data.id,
    checkoutUrl: data.checkout_url,
    status: data.status,
  };
}

/**
 * Verify a Chargily webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Value of 'signature' header
 */
function verifyWebhookSignature(payload, signature) {
  if (!API_SECRET) return false;
  const computed = crypto
    .createHmac('sha256', API_SECRET)
    .update(payload)
    .digest('hex');
  return computed === signature;
}

/**
 * Get checkout status
 * @param {string} checkoutId
 */
async function getCheckoutStatus(checkoutId) {
  if (!API_KEY) throw new Error('CHARGILY_API_KEY not configured');

  const res = await fetch(`${CHARGILY_API}/checkouts/${checkoutId}`, {
    headers: headers(),
  });

  if (!res.ok) throw new Error(`Chargily error: ${res.status}`);
  return await res.json();
}

/**
 * Check if Chargily is configured
 */
function isConfigured() {
  return !!(API_KEY && API_SECRET);
}

module.exports = { createCheckout, verifyWebhookSignature, getCheckoutStatus, isConfigured };

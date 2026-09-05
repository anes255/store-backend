const { google } = require('googleapis');

let sheetsClient = null;
let serviceEmail = '';

function initSheets() {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!key || !email) return false;
  serviceEmail = email;
  try {
    const auth = new google.auth.JWT(email, null, key.replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/spreadsheets']);
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets ready:', email);
    return true;
  } catch (e) {
    console.log('❌ Google Sheets init error:', e.message);
    return false;
  }
}

function getServiceEmail() { return serviceEmail; }
function isConfigured() { return !!sheetsClient; }

async function syncOrders(spreadsheetId, orders, storeName) {
  if (!sheetsClient) throw new Error('Google Sheets not configured');

  const sheetTitle = 'Orders';

  // Check if sheet exists, create if not
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some(s => s.properties.title === sheetTitle);
    if (!exists) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] }
      });
    }
  } catch (e) {
    if (e.code === 403 || e.code === 404) {
      throw new Error('Cannot access spreadsheet. Make sure you shared it with: ' + serviceEmail);
    }
    throw e;
  }

  // Build rows
  const header = ['Order #', 'Date', 'Customer', 'Phone', 'Email', 'Address', 'Wilaya', 'Items', 'Subtotal', 'Shipping', 'Total', 'Payment Method', 'Payment Status', 'Status', 'Tracking #', 'Notes'];
  const rows = orders.map(o => {
    let items = '';
    if (o.items && Array.isArray(o.items)) {
      items = o.items.map(i => `${i.product_name} x${i.quantity}`).join(', ');
    }
    return [
      o.order_number || '', 
      o.created_at ? new Date(o.created_at).toLocaleString() : '',
      o.customer_name || '', o.customer_phone || '', o.customer_email || '',
      o.shipping_address || '', o.shipping_wilaya || '',
      items,
      o.subtotal || 0, o.shipping_cost || 0, o.total || 0,
      o.payment_method || '', o.payment_status || '', o.status || '',
      o.tracking_number || '', o.notes || ''
    ];
  });

  // Clear and write
  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId, range: `${sheetTitle}!A:Z`
  });

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] }
  });

  // Bold header
  try {
    const sheetMeta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const sheet = sheetMeta.data.sheets.find(s => s.properties.title === sheetTitle);
    if (sheet) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            repeatCell: {
              range: { sheetId: sheet.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
              fields: 'userEnteredFormat(textFormat,backgroundColor)'
            }
          }]
        }
      });
    }
  } catch (e) { /* formatting optional */ }

  return { synced: rows.length, sheetTitle };
}

async function appendOrder(spreadsheetId, order) {
  if (!sheetsClient) return;
  const sheetTitle = 'Orders';
  let items = '';
  if (order.items && Array.isArray(order.items)) {
    items = order.items.map(i => `${i.product_name} x${i.quantity}`).join(', ');
  }
  const row = [
    order.order_number || '', new Date(order.created_at || Date.now()).toLocaleString(),
    order.customer_name || '', order.customer_phone || '', order.customer_email || '',
    order.shipping_address || '', order.shipping_wilaya || '',
    items,
    order.subtotal || 0, order.shipping_cost || 0, order.total || 0,
    order.payment_method || '', order.payment_status || '', order.status || '',
    order.tracking_number || '', order.notes || ''
  ];

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetTitle}!A:P`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.log('[Sheets] Append error:', e.message);
  }
}

// Init on load
initSheets();

module.exports = { initSheets, isConfigured, getServiceEmail, syncOrders, appendOrder };

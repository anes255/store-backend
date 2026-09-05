const { Pool } = require('pg');
const fs = require('fs');

// Connection string comes from the environment — never hardcode it here. This
// file previously carried a live Neon password in plaintext, which would have
// been published in full the moment the repo went public.
//   Windows:  set DATABASE_URL=postgresql://...   &&  node import.js
//   bash:     DATABASE_URL='postgresql://...' node import.js
const NEW_DB = process.env.DATABASE_URL || process.env.NEW_DATABASE_URL;
if (!NEW_DB) {
  console.error('DATABASE_URL is not set — refusing to run.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: NEW_DB,
  ssl: { rejectUnauthorized: false }
});

async function importDb() {
  const sql = fs.readFileSync('backup.sql', 'utf8');
  const statements = sql.split('\n').filter(l => l.startsWith('INSERT') || l.startsWith('CREATE') || l.startsWith('ALTER'));

  console.log(`Running ${statements.length} statements...`);
  let ok = 0, fail = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      console.error('SKIP:', e.message.slice(0, 80));
      fail++;
    }
  }
  console.log(`Done. ${ok} ok, ${fail} skipped.`);
  await pool.end();
}

importDb().catch(e => { console.error(e.message); process.exit(1); });

const{Pool}=require('pg');require('dotenv').config();
// Managed Postgres (Neon) needs TLS; a local scratch server for the test
// suite does not speak it at all, so asking for it there fails the connect.
const url=process.env.DATABASE_URL||'';
const isLocal=/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)||process.env.PGSSLMODE==='disable';
const pool=new Pool({connectionString:url,ssl:isLocal?false:{rejectUnauthorized:false},max:10});
pool.on('error',e=>console.error('DB:',e.message));
module.exports=pool;

const{Pool}=require('pg');require('dotenv').config();
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:10});
pool.on('error',e=>console.error('DB:',e.message));
module.exports=pool;

const jwt=require('jsonwebtoken');const crypto=require('crypto');require('dotenv').config();
const pool=require('../config/db');
// SECURITY: never ship a hardcoded fallback secret — the repo is public, so a
// known secret lets anyone forge admin tokens. Require JWT_SECRET in production;
// otherwise fall back to a random per-boot secret (sessions reset on restart).
let SECRET=process.env.JWT_SECRET;
if(!SECRET){
  SECRET=crypto.randomBytes(48).toString('hex');
  console.warn('⚠️  JWT_SECRET is not set — using a random per-boot secret. Set JWT_SECRET in the environment for persistent, secure sessions.');
}
const authMiddleware=(roles=[])=>(req,res,next)=>{(async()=>{try{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Auth required'});const d=jwt.verify(t,SECRET);req.user=d;if(roles.length&&!roles.includes(d.role))return res.status(403).json({error:'Forbidden'});
// For platform_admin tokens from the admins table, verify the admin still exists and is active
if(d.role==='platform_admin'&&d.id&&d.id!=='admin'){try{const r=await pool.query('SELECT is_active FROM platform_admins WHERE id=$1',[d.id]);if(!r.rows.length)return res.status(401).json({error:'Admin account deleted'});if(r.rows[0].is_active===false)return res.status(401).json({error:'Admin account deactivated'});}catch(e){/* table may not exist yet, allow through */}}
next();}catch(e){res.status(401).json({error:'Invalid token'});}})();};
const generateToken=(p,exp='30d')=>jwt.sign(p,SECRET,{expiresIn:exp});
module.exports={authMiddleware,generateToken};

const jwt=require('jsonwebtoken');const crypto=require('crypto');require('dotenv').config();
const pool=require('../config/db');
const{checkAccess}=require('./staffAccess');
// SECURITY: never ship a hardcoded fallback secret — the repo is public, so a
// known secret lets anyone forge admin tokens. Require JWT_SECRET in production;
// otherwise fall back to a random per-boot secret (sessions reset on restart).
let SECRET=process.env.JWT_SECRET;
if(!SECRET){
  SECRET=crypto.randomBytes(48).toString('hex');
  console.warn('⚠️  JWT_SECRET is not set — using a random per-boot secret. Set JWT_SECRET in the environment for persistent, secure sessions.');
}
// opts.bodyStore: the route takes the store id from the body (storeId / store_id)
// instead of the URL — it is checked the same way.
const authMiddleware=(roles=[],opts={})=>(req,res,next)=>{(async()=>{try{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Auth required'});const d=jwt.verify(t,SECRET);req.user=d;if(roles.length&&!roles.includes(d.role))return res.status(403).json({error:'Forbidden'});
// For platform_admin tokens from the admins table, verify the admin still exists and is active
if(d.role==='platform_admin'&&d.id&&d.id!=='admin'){try{const r=await pool.query('SELECT is_active FROM platform_admins WHERE id=$1',[d.id]);if(!r.rows.length)return res.status(401).json({error:'Admin account deleted'});if(r.rows[0].is_active===false)return res.status(401).json({error:'Admin account deactivated'});}catch(e){/* table may not exist yet, allow through */}}
// Store ownership + staff permissions (see staffAccess.js).
try{const deny=await checkAccess(req,opts);if(deny)return res.status(deny.status).json({error:deny.error,code:deny.code,missing_permission:deny.missing});}catch(e){console.error('[access]',e.message);return res.status(500).json({error:'Access check failed'});}
next();}catch(e){res.status(401).json({error:'Invalid token'});}})();};
// OTP codes travel inside a signed (but readable) JWT. A plain bcrypt hash of
// a 6-digit code can be brute-forced offline, so key the hash with the secret.
const otpHash=(code)=>crypto.createHmac('sha256',SECRET).update('otp:'+String(code).trim()).digest('hex');
const otpMatch=(code,h)=>{const a=Buffer.from(otpHash(code)),b=Buffer.from(String(h||''));return a.length===b.length&&crypto.timingSafeEqual(a,b);};
const generateToken=(p,exp='30d')=>jwt.sign(p,SECRET,{expiresIn:exp});
module.exports={otpHash,otpMatch,jwtSecret:SECRET,authMiddleware,generateToken};

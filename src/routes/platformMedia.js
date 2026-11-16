// Files the super admin uploads for the "How to use" guides — videos, mostly.
//
// Images elsewhere in this project are kept as base64 inside a settings
// column. A tutorial video cannot be: /api/platform-info is fetched by every
// visitor who opens the landing page, and a 30 MB string in it would be
// downloaded by all of them. Each file gets a row of its own and a URL, so
// the settings stay small and the browser can cache and seek the video.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

const MAX_BYTES = 64 * 1024 * 1024;
const ALLOWED = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov' };

let ready = null;
function ensureMediaTable() {
  if (ready) return ready;
  ready = (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS platform_media(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mime VARCHAR(100) NOT NULL,
        filename VARCHAR(255),
        size_bytes BIGINT,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
    } catch (e) { console.log('[platform_media]', e.message); }
  })();
  return ready;
}
ensureMediaTable();

// The address this server is reachable at, so the stored URL still works
// when the dashboard and the API are on different hosts.
const publicBase = (req) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
};

// The body arrives as raw bytes rather than base64 JSON: a third smaller on
// the wire, and nothing has to be decoded before it is stored.
router.post('/media', authMiddleware(['platform_admin']),
  express.raw({ type: () => true, limit: MAX_BYTES }),
  async (req, res) => {
    try {
      await ensureMediaTable();
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED.has(mime)) return res.status(415).json({ error: 'That file type is not supported' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file received' });
      if (req.body.length > MAX_BYTES) return res.status(413).json({ error: 'That file is too large' });

      const filename = String(req.headers['x-filename'] || '').slice(0, 255) || null;
      const r = await pool.query(
        'INSERT INTO platform_media(mime, filename, size_bytes, data) VALUES($1,$2,$3,$4) RETURNING id',
        [mime, filename, req.body.length, req.body]);
      const id = r.rows[0].id;
      const ext = EXT[mime] ? `.${EXT[mime]}` : '';
      res.json({
        id,
        url: `${publicBase(req)}/api/platform/media/${id}${ext}`,
        mime,
        size: req.body.length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

// Public, because the people watching the guide are store owners on another
// host. The id is a random uuid, so nothing is guessable.
router.get('/media/:id', async (req, res) => {
  try {
    await ensureMediaTable();
    const id = String(req.params.id).replace(/\.[a-z0-9]+$/i, '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).end();
    const r = await pool.query('SELECT mime, data, size_bytes FROM platform_media WHERE id=$1', [id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });

    const buf = row.data;
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');

    // Players ask for byte ranges to let the viewer scrub; without this the
    // whole file is re-sent on every seek, and some browsers refuse to seek.
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
        if (Number.isNaN(start) || start > end || start >= buf.length) {
          res.setHeader('Content-Range', `bytes */${buf.length}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(buf.subarray(start, end + 1));
      }
    }
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/media/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await ensureMediaTable();
    const r = await pool.query('DELETE FROM platform_media WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// A product image is stored either as a plain URL or as an object
// ({ url } / { src } / …), and the `images` column is sometimes a JSON string.
// Everything that leaves the API goes through here so the browser always gets
// a URL string it can put straight into <img src> — an object there renders
// nothing, which is why cart and checkout thumbnails came out blank.

const imgUrl = (v) => {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    // An image object that was concatenated into a string at some point is
    // not a URL — treat it as missing rather than rendering a broken image.
    if (!s || s.startsWith('[object')) return null;
    if (s.startsWith('{')) { try { return imgUrl(JSON.parse(s)); } catch { return null; } }
    return s;
  }
  if (typeof v === 'object') return imgUrl(v.url || v.src || v.image || v.path || null);
  return null;
};

const toArray = (raw) => {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
  return Array.isArray(a) ? a : [];
};

/** Every usable image URL, in order. */
const imgList = (raw) => toArray(raw).map(imgUrl).filter(Boolean);

/** The first usable image URL, or null. */
const firstImg = (raw) => imgList(raw)[0] || null;

module.exports = { imgUrl, imgList, firstImg };

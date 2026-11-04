// Readable text for an order line's variant_info.
//
// variant_info is stored as JSON in several shapes depending on where the
// order came from: {label, per_unit:[…]}, {selections:[…]}, a single
// {name,type,value}, a plain map, or just a string. Printing it with
// Object.entries gave the buyer "label: black/xl · per_unit: [object Object]".
function one(x) {
  if (x == null) return '';
  if (typeof x !== 'object') return String(x);
  return String(x.label || x.name || x.value || '');
}

function variantLabel(raw) {
  if (raw == null || raw === '') return null;
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return String(raw); } }
  if (v == null || v === '') return null;
  if (typeof v !== 'object') return String(v);
  if (v.label) return String(v.label);
  if (Array.isArray(v.per_unit)) {
    const txt = v.per_unit
      .map((u) => (Array.isArray(u && u.selections) ? u.selections.map(one).filter(Boolean).join(' / ') : one(u)))
      .filter(Boolean).join(', ');
    return txt || null;
  }
  if (Array.isArray(v.selections)) return v.selections.map(one).filter(Boolean).join(' / ') || null;
  if (Array.isArray(v)) return v.map(one).filter(Boolean).join(' / ') || null;
  if (v.name || v.value) return one(v) || null;
  // a plain {color:'black', size:'xl'} map
  const txt = Object.entries(v)
    .filter(([, val]) => val != null && val !== '' && typeof val !== 'object')
    .map(([, val]) => String(val)).join(' / ');
  return txt || null;
}

module.exports = { variantLabel };

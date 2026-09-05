// Design intelligence for the AI landing-page generator (informed by the
// ui-ux-pro-max skill). Maps a product CATEGORY to a fitting colour MOOD and
// picks a palette + font pairing — so every page looks on-brand for its product
// and VARIES between products instead of one fixed indigo look.

// Each palette: primary, primaryD (darker shade), accent, bg (soft surface), ink.
const MOODS = {
  tech: [
    { primary:'#2563EB', primaryD:'#1E40AF', accent:'#06B6D4', bg:'#F4F7FB', ink:'#0F1B2D' },
    { primary:'#4F46E5', primaryD:'#3730A3', accent:'#22D3EE', bg:'#F5F6FC', ink:'#13152E' },
    { primary:'#0EA5E9', primaryD:'#0369A1', accent:'#6366F1', bg:'#F2F8FC', ink:'#0B2536' },
    { primary:'#1E293B', primaryD:'#0F172A', accent:'#38BDF8', bg:'#F4F6F9', ink:'#0F172A' },
  ],
  beauty: [
    { primary:'#DB2777', primaryD:'#9D174D', accent:'#F59E0B', bg:'#FDF4F7', ink:'#3B1226' },
    { primary:'#C026D3', primaryD:'#86198F', accent:'#FB7185', bg:'#FBF4FB', ink:'#3A1130' },
    { primary:'#BE185D', primaryD:'#831843', accent:'#D8B4FE', bg:'#FCF3F6', ink:'#3A1226' },
    { primary:'#A16207', primaryD:'#713F12', accent:'#EC4899', bg:'#FBF7EE', ink:'#3A2A12' },
  ],
  fashion: [
    { primary:'#111827', primaryD:'#000000', accent:'#D946EF', bg:'#F7F6F4', ink:'#111827' },
    { primary:'#7C2D12', primaryD:'#431407', accent:'#F59E0B', bg:'#FAF6F2', ink:'#2A1206' },
    { primary:'#1F2937', primaryD:'#0B0F19', accent:'#E11D48', bg:'#F6F6F7', ink:'#16181D' },
  ],
  luxury: [
    { primary:'#1F2937', primaryD:'#111827', accent:'#CA8A04', bg:'#FAF8F3', ink:'#1A1A1A' },
    { primary:'#4C1D95', primaryD:'#2E1065', accent:'#CA8A04', bg:'#F7F4FB', ink:'#241245' },
    { primary:'#0F172A', primaryD:'#020617', accent:'#B08D2D', bg:'#F8F6F1', ink:'#0F172A' },
  ],
  food: [
    { primary:'#16A34A', primaryD:'#15803D', accent:'#F97316', bg:'#F3FAF4', ink:'#0F2E1A' },
    { primary:'#EA580C', primaryD:'#9A3412', accent:'#16A34A', bg:'#FCF6F1', ink:'#3A1A0A' },
    { primary:'#CA8A04', primaryD:'#854D0E', accent:'#DC2626', bg:'#FBF7EC', ink:'#3A2A0A' },
  ],
  energetic: [
    { primary:'#EA580C', primaryD:'#9A3412', accent:'#22C55E', bg:'#FBF5F1', ink:'#2A1408' },
    { primary:'#DC2626', primaryD:'#991B1B', accent:'#F59E0B', bg:'#FCF4F4', ink:'#2E1111' },
    { primary:'#65A30D', primaryD:'#3F6212', accent:'#F97316', bg:'#F6FAF0', ink:'#1F2A0C' },
    { primary:'#0891B2', primaryD:'#155E75', accent:'#F43F5E', bg:'#F0FAFC', ink:'#0C2B33' },
  ],
  playful: [
    { primary:'#2563EB', primaryD:'#1D4ED8', accent:'#F59E0B', bg:'#F3F7FE', ink:'#13233F' },
    { primary:'#7C3AED', primaryD:'#5B21B6', accent:'#F472B6', bg:'#F7F4FE', ink:'#2A1758' },
    { primary:'#0891B2', primaryD:'#155E75', accent:'#FB923C', bg:'#F0FAFC', ink:'#0C2B33' },
    { primary:'#DB2777', primaryD:'#9D174D', accent:'#22D3EE', bg:'#FDF4F8', ink:'#3A1226' },
  ],
  home: [
    { primary:'#B45309', primaryD:'#78350F', accent:'#0D9488', bg:'#FAF6F0', ink:'#33240F' },
    { primary:'#0F766E', primaryD:'#115E59', accent:'#D97706', bg:'#F0F8F6', ink:'#0C2E2A' },
    { primary:'#57534E', primaryD:'#292524', accent:'#CA8A04', bg:'#F8F6F3', ink:'#292524' },
  ],
  health: [
    { primary:'#0D9488', primaryD:'#0F766E', accent:'#3B82F6', bg:'#F0FAF8', ink:'#0C2E2A' },
    { primary:'#2563EB', primaryD:'#1E40AF', accent:'#14B8A6', bg:'#F3F7FD', ink:'#0F1B2D' },
    { primary:'#16A34A', primaryD:'#166534', accent:'#0EA5E9', bg:'#F2FAF4', ink:'#0F2E1A' },
  ],
  general: [
    { primary:'#6366F1', primaryD:'#4338CA', accent:'#F59E0B', bg:'#F6F4FB', ink:'#1F2433' },
    { primary:'#0EA5E9', primaryD:'#0369A1', accent:'#F43F5E', bg:'#F2F8FC', ink:'#0B2536' },
    { primary:'#7C3AED', primaryD:'#5B21B6', accent:'#10B981', bg:'#F6F4FD', ink:'#241B3A' },
    { primary:'#0F766E', primaryD:'#115E59', accent:'#F59E0B', bg:'#F0F8F6', ink:'#0C2E2A' },
  ],
};

// Extra palette options appended per mood so the same category can still land a
// different on-brand look across products (distilled from the ui-ux-pro-max
// 161-palette system). Kept separate to avoid churning the curated sets above.
const MOODS_EXTRA = {
  tech:     [{ primary:'#6366F1', primaryD:'#4338CA', accent:'#0EA5E9', bg:'#F5F5FC', ink:'#14152B' }, { primary:'#0891B2', primaryD:'#0E7490', accent:'#818CF8', bg:'#F0FAFC', ink:'#0B2530' }],
  beauty:   [{ primary:'#E11D48', primaryD:'#9F1239', accent:'#FBBF24', bg:'#FDF3F4', ink:'#3A1220' }, { primary:'#9333EA', primaryD:'#6B21A8', accent:'#F472B6', bg:'#F9F4FC', ink:'#2E1145' }],
  fashion:  [{ primary:'#0F172A', primaryD:'#020617', accent:'#CA8A04', bg:'#F7F6F4', ink:'#0F172A' }, { primary:'#4A044E', primaryD:'#2E0331', accent:'#F0ABFC', bg:'#FAF5FB', ink:'#2E0331' }],
  luxury:   [{ primary:'#262626', primaryD:'#0A0A0A', accent:'#A16207', bg:'#FAF8F4', ink:'#171717' }, { primary:'#134E4A', primaryD:'#0C3531', accent:'#CA8A04', bg:'#F4F8F6', ink:'#0C3531' }],
  food:     [{ primary:'#B91C1C', primaryD:'#7F1D1D', accent:'#F59E0B', bg:'#FCF4F2', ink:'#3A1212' }, { primary:'#15803D', primaryD:'#166534', accent:'#F97316', bg:'#F2FAF4', ink:'#0F2E1A' }],
  energetic:[{ primary:'#F59E0B', primaryD:'#B45309', accent:'#1D4ED8', bg:'#FBF8F0', ink:'#2A1E08' }, { primary:'#7C3AED', primaryD:'#5B21B6', accent:'#F97316', bg:'#F6F3FE', ink:'#241758' }],
  playful:  [{ primary:'#F43F5E', primaryD:'#BE123C', accent:'#22D3EE', bg:'#FDF4F5', ink:'#3A111B' }, { primary:'#16A34A', primaryD:'#15803D', accent:'#FB923C', bg:'#F1FAF3', ink:'#0F2E1A' }],
  home:     [{ primary:'#9A6A3C', primaryD:'#6B4823', accent:'#0D9488', bg:'#FAF6F0', ink:'#33240F' }, { primary:'#475569', primaryD:'#334155', accent:'#D97706', bg:'#F6F7F9', ink:'#1E293B' }],
  health:   [{ primary:'#0EA5E9', primaryD:'#0369A1', accent:'#22C55E', bg:'#F1F8FD', ink:'#0B2536' }, { primary:'#7C3AED', primaryD:'#5B21B6', accent:'#14B8A6', bg:'#F6F4FD', ink:'#241B3A' }],
  general:  [{ primary:'#DB2777', primaryD:'#9D174D', accent:'#0EA5E9', bg:'#FDF4F8', ink:'#3A1226' }, { primary:'#EA580C', primaryD:'#9A3412', accent:'#0D9488', bg:'#FCF6F1', ink:'#3A1A0A' }],
};
for (const k of Object.keys(MOODS_EXTRA)) { if (MOODS[k]) MOODS[k] = MOODS[k].concat(MOODS_EXTRA[k]); }

// Latin font pairings (display, body) by mood.
const FONTS = {
  tech:     [['Sora','Inter'],['Space Grotesk','Inter'],['Outfit','DM Sans'],['Chivo','Inter'],['Sora','Manrope']],
  beauty:   [['Cormorant Garamond','Jost'],['Marcellus','Mulish'],['Fraunces','Manrope'],['Bodoni Moda','Jost'],['Italiana','Mulish']],
  fashion:  [['Playfair Display','Mulish'],['Outfit','DM Sans'],['Fraunces','Inter'],['Bodoni Moda','Manrope'],['Archivo','Inter']],
  luxury:   [['Playfair Display','Mulish'],['Cormorant Garamond','Jost'],['Marcellus','Manrope'],['Bodoni Moda','Jost'],['Cormorant','Mulish']],
  food:     [['Quicksand','Nunito Sans'],['Poppins','Nunito Sans'],['Fraunces','Mulish'],['Baloo 2','Nunito Sans']],
  energetic:[['Outfit','DM Sans'],['Sora','Inter'],['Poppins','Inter'],['Archivo','Inter'],['Anton','Inter']],
  playful:  [['Poppins','Nunito Sans'],['Quicksand','Mulish'],['Outfit','DM Sans'],['Baloo 2','Nunito Sans'],['Fredoka','Nunito Sans']],
  home:     [['Fraunces','Manrope'],['Marcellus','Mulish'],['Cormorant Garamond','Manrope'],['Spectral','Mulish']],
  health:   [['Manrope','Inter'],['Outfit','DM Sans'],['Sora','Inter'],['Mulish','Inter']],
  general:  [['Outfit','DM Sans'],['Manrope','Inter'],['Sora','Inter'],['Plus Jakarta Sans','Inter'],['Figtree','Inter']],
};
// Arabic display/body fonts (all support Arabic on Google Fonts) — vary per page.
const FONTS_AR = [['Tajawal','Tajawal'],['Cairo','Cairo'],['Almarai','Almarai'],['El Messiri','Cairo'],['Rubik','Tajawal']];

// Category keyword → mood.
const HINTS = [
  ['tech',     ['phone','smartphone','electronic','gadget','tech','camera','dashcam','headset','headphone','earbud','earphone','speaker','audio','watch','smartwatch','drone','laptop','computer','tablet','charger','power','led','screen','keyboard','mouse','console','gaming']],
  ['beauty',   ['beauty','cosmetic','makeup','make-up','skincare','skin','serum','cream','lotion','perfume','fragrance','hair','nail','lipstick','mascara','spa']],
  ['luxury',   ['jewel','jewelry','jewellery','gold','diamond','luxur','ring','necklace','bracelet','earring','premium','elegant']],
  ['fashion',  ['fashion','cloth','clothing','apparel','shoe','sneaker','wear','dress','shirt','tshirt','t-shirt','jacket','coat','bag','handbag','hat','scarf','sunglass','belt']],
  ['food',     ['food','grocery','snack','drink','beverage','coffee','tea','chocolate','honey','spice','restaurant','kitchen','cook','organic']],
  ['energetic',['fitness','gym','sport','workout','training','supplement','protein','creatine','whey','vitamin','muscle','running','yoga','cycling','outdoor']],
  ['home',     ['home','furnitur','decor','decoration','sofa','chair','table','lamp','tool','garden','appliance','vacuum','clean','storage','bedding','curtain']],
  ['playful',  ['kid','kids','toy','toys','baby','child','children','game','play','puzzle','doll','school','student','stationery']],
  ['health',   ['health','medical','care','wellness','pharma','medicine','therapy','massage','dental','elder','senior','pet','dog','cat']],
];

function hashStr(s){let h=0;s=String(s||'');for(let i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))>>>0;}return h;}
function moodFor(category){
  const lc=String(category||'').toLowerCase();
  for(const [mood,words] of HINTS){if(words.some(w=>lc.includes(w)))return mood;}
  return 'general';
}
// Pick a theme matched to the product's category, seeded so it's stable per page
// but different across products.
function pickTheme(category, seed, language){
  const mood=moodFor(category);
  const pals=MOODS[mood]||MOODS.general;
  const h=hashStr((category||'')+'|'+(seed||''));
  const pal=pals[h%pals.length];
  let display, body;
  if(language==='ar'){ const f=FONTS_AR[h%FONTS_AR.length]; display=f[0]; body=f[1]; }
  else { const fl=FONTS[mood]||FONTS.general; const f=fl[h%fl.length]; display=f[0]; body=f[1]; }
  return { ...pal, type:mood, display, body };
}
module.exports = { MOODS, FONTS, FONTS_AR, pickTheme, moodFor };

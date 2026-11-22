/**
 * Pure colour maths and colourway validation for the /oai:config panel.
 * Used by node (server validation, tests) and inlined verbatim into the page
 * (the server strips the `export ` keywords), so: no imports, no Node APIs.
 */
export const COLOUR_TOKENS = ['bg', 'panel', 'panel-hi', 'shadow', 'line', 'text', 'text-dim', 'accent', 'accent-2', 'lcd', 'lcd-bg', 'ok', 'warn', 'hot', 'err', 'info', 'pending'];
export const COLOUR_INTERPS = ['rgb', 'oklab', 'oklch'];
export const COLOUR_HARMONIES = ['analogous', 'triad', 'complementary'];
export const LUT_STOPS = 16;
const HEX = /^#[0-9a-f]{6}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;
export const MAX_COLOURWAYS = 24;

export const normHex = s => { const v = String(s ?? '').trim().toLowerCase().replace(/^([0-9a-f]{6})$/, '#$1'); return HEX.test(v) ? v : null; };
export const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const clamp01 = v => Math.min(1, Math.max(0, v));
export const rgbToHex = rgb => '#' + rgb.map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
const toLin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function rgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(c => clamp01(gam(Math.max(0, c))));
}
export const oklabToOklch = ([L, a, b]) => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360];
export const oklchToOklab = ([L, C, h]) => [L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)];
export const hexToOklch = hex => oklabToOklch(rgbToOklab(hexToRgb(hex)));
export const oklchToHex = lch => rgbToHex(oklabToRgb(oklchToOklab(lch)));

/** Interpolate two hex colours at t in [0,1] (rgb | oklab | oklch with shortest hue path). */
export function mixHex(a, b, t, interp = 'oklab') {
  const A = hexToRgb(a), B = hexToRgb(b), lerp = (x, y) => x + (y - x) * t;
  if (interp === 'rgb') return rgbToHex(A.map((v, i) => lerp(v, B[i])));
  const la = rgbToOklab(A), lb = rgbToOklab(B);
  if (interp === 'oklch') {
    const ca = oklabToOklch(la), cb = oklabToOklch(lb);
    let ha = ca[1] < 1e-4 ? cb[2] : ca[2], hb = cb[1] < 1e-4 ? ha : cb[2];
    let d = hb - ha; if (d > 180) d -= 360; if (d < -180) d += 360;
    return rgbToHex(oklabToRgb(oklchToOklab([lerp(ca[0], cb[0]), lerp(ca[1], cb[1]), (ha + d * t + 360) % 360])));
  }
  return rgbToHex(oklabToRgb(la.map((v, i) => lerp(v, lb[i]))));
}
/** Fill stops[from..to] (inclusive, either order) with a gradient from colour A to colour B. */
export function gradientFill(stops, from, to, a, b, interp = 'oklab') {
  const out = stops.slice(), lo = Math.min(from, to), hi = Math.max(from, to), n = hi - lo;
  for (let i = lo; i <= hi; i++) out[i] = n ? mixHex(a, b, (i - lo) / n, interp) : a;
  return out;
}

/** WCAG 2 relative luminance and contrast ratio. */
export const luminance = hex => { const [r, g, b] = hexToRgb(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** Deterministic PRNG (mulberry32). */
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Jitter hue/lightness of each stop by up to `variation` % (0..100), reproducibly from `seed`. */
export function vary(stops, variation, seed) {
  const v = Math.min(100, Math.max(0, Number(variation) || 0)) / 100;
  if (!v) return stops.slice();
  const r = rng(seed);
  return stops.map(hex => { const [L, C, h] = hexToOklch(hex), dh = (r() - 0.5) * 2 * 60 * v, dl = (r() - 0.5) * 2 * 0.12 * v; return oklchToHex([Math.min(1, Math.max(0, L + dl)), C, (h + dh + 360) % 360]); });
}

/**
 * Harmony-based random LUT in the standard role layout: 0-7 a neutral ramp
 * (shadow .. text) tinted by the base hue, 8 lcd-bg, 9-11 accents, 12 info, 13-15 warn/hot/err.
 */
export function randomLut(harmony = 'analogous', seed = 1) {
  const r = rng(seed), base = r() * 360;
  const offs = harmony === 'triad' ? [0, 120, 240] : harmony === 'complementary' ? [0, 180, 30] : [0, 30, -30];
  const hue = i => (base + offs[i % 3] + 360) % 360, C = 0.12 + r() * 0.1, tint = 0.015 + r() * 0.03;
  const ramp = [0.08, 0.13, 0.19, 0.27, 0.33, 0.48, 0.70, 0.93].map((L, i) => oklchToHex([L, i === 7 ? tint * 0.8 : tint, hue(0)]));
  return [...ramp, oklchToHex([0.14, tint * 1.5, hue(1)]),
    oklchToHex([0.72, C, hue(1)]), oklchToHex([0.86, C, hue(0)]), oklchToHex([0.88, C * 0.9, hue(2)]), oklchToHex([0.82, 0.11, hue(2) + 15]),
    oklchToHex([0.83, 0.15, 75]), oklchToHex([0.71, 0.18, 45]), oklchToHex([0.66, 0.21, 25])];
}

export const DEFAULT_MAP = Object.freeze({ shadow: 0, bg: 1, panel: 2, line: 3, 'panel-hi': 4, 'text-dim': 6, text: 7, 'lcd-bg': 8, 'accent-2': 9, accent: 10, ok: 10, lcd: 11, info: 12, warn: 13, hot: 14, err: 15, pending: 15 });
const cw = stops => ({ stops, map: { ...DEFAULT_MAP }, overrides: {}, variation: 0, seed: 1, interp: 'oklab', harmony: 'analogous' });
export const BUILTIN_COLOURWAYS = Object.freeze({
  'WINAMP LIME': cw(['#020302', '#070907', '#121712', '#243024', '#33432f', '#55684f', '#8aa184', '#d6e8cc', '#041204', '#8fdc1e', '#b8ff3c', '#7dff4f', '#6fd6ff', '#ffb627', '#ff6b2c', '#ff4545']),
  XENOFIELD: cw(['#040108', '#0c0516', '#170c27', '#2b1942', '#3e255b', '#5e4a7c', '#a891c8', '#ecdfff', '#0b0416', '#ff4fa8', '#b6ff3c', '#3cffd0', '#39d0ff', '#ffc04a', '#ff6b9a', '#ff3d5e']),
  'AMBER CRT': cw(['#030200', '#0a0700', '#150e03', '#2b1f08', '#3e2d0c', '#6b5226', '#b8924a', '#ffd79a', '#130a00', '#e08a00', '#ffb000', '#ffc642', '#ffe08a', '#ff8c1a', '#ff6a00', '#ff3b2a']),
  ICE: cw(['#01040a', '#050b14', '#0b1522', '#1a2a3d', '#27405a', '#4f6b88', '#8fb0cf', '#e2f1ff', '#03101c', '#3aa8ff', '#7fd8ff', '#a8f0ff', '#c6b8ff', '#ffd36b', '#ff9a5c', '#ff5a6e']),
  MONO: cw(['#000000', '#0a0a0a', '#161616', '#2a2a2a', '#3b3b3b', '#5e5e5e', '#9c9c9c', '#e8e8e8', '#060606', '#bdbdbd', '#ffffff', '#f0f0f0', '#cfcfcf', '#dedede', '#bfbfbf', '#ff5c5c']),
});

/** Validate one colourway document; returns { cw, error } (cw null when invalid). */
export function sanitizeColourway(doc) {
  const bad = error => ({ cw: null, error });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('Colourway must be an object.');
  if (!Array.isArray(doc.stops) || doc.stops.length < 2 || doc.stops.length > 32) return bad('stops: 2..32 #RRGGBB values.');
  const stops = doc.stops.map(s => typeof s === 'string' && HEX.test(s.toLowerCase()) ? s.toLowerCase() : null);
  if (stops.includes(null)) return bad('stops: only #RRGGBB values.');
  const map = {};
  for (const t of COLOUR_TOKENS) {
    const v = doc.map?.[t] ?? DEFAULT_MAP[t];
    if (!Number.isInteger(v) || v < 0 || v >= stops.length) return bad(`map.${t}: integer stop index 0..${stops.length - 1}.`);
    map[t] = v;
  }
  if (doc.map && Object.keys(doc.map).some(k => !COLOUR_TOKENS.includes(k))) return bad('map: unknown token.');
  const overrides = {};
  for (const [t, v] of Object.entries(doc.overrides ?? {})) {
    if (!COLOUR_TOKENS.includes(t)) return bad(`overrides: unknown token ${String(t).slice(0, 20)}.`);
    if (typeof v !== 'string' || !HEX.test(v.toLowerCase())) return bad(`overrides.${t}: #RRGGBB only.`);
    overrides[t] = v.toLowerCase();
  }
  const variation = doc.variation ?? 0, seed = doc.seed ?? 1;
  if (!Number.isInteger(variation) || variation < 0 || variation > 100) return bad('variation: integer 0..100.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) return bad('seed: integer 0..2147483647.');
  const interp = doc.interp ?? 'oklab', harmony = doc.harmony ?? 'analogous';
  if (!COLOUR_INTERPS.includes(interp)) return bad('interp: rgb | oklab | oklch.');
  if (!COLOUR_HARMONIES.includes(harmony)) return bad('harmony: analogous | triad | complementary.');
  return { cw: { stops, map, overrides, variation, seed, interp, harmony }, error: null };
}
export const colourwayNameOk = n => typeof n === 'string' && NAME.test(n);

/** Final token -> hex table for a colourway (variation, then mapping, then overrides). */
export function resolveColourway(c) {
  const stops = vary(c.stops, c.variation, c.seed), out = {};
  for (const t of COLOUR_TOKENS) out[t] = c.overrides?.[t] ?? stops[c.map?.[t] ?? DEFAULT_MAP[t]] ?? stops[0];
  return out;
}

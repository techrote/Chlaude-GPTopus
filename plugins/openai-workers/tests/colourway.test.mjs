import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as OC from '../scripts/oai-colour.mjs';
import { sanitizeUi, writeUi, readUi, memoryStore } from '../scripts/oai-config-core.mjs';
import { createConfigServer, renderPage, COLOUR_SRC } from '../scripts/oai-config.mjs';

const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'oai-colour-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const clone = c => JSON.parse(JSON.stringify(c));
const LIME = OC.BUILTIN_COLOURWAYS['WINAMP LIME'];

test('hex / OKLab / OKLCH round-trips', () => {
  for (const hex of ['#000000', '#ffffff', '#b8ff3c', '#ff4545', '#6fd6ff', '#123456', '#7f7f7f']) {
    assert.equal(OC.rgbToHex(OC.oklabToRgb(OC.rgbToOklab(OC.hexToRgb(hex)))), hex);
    assert.equal(OC.oklchToHex(OC.hexToOklch(hex)), hex);
  }
  const [L, a, b] = OC.rgbToOklab([1, 1, 1]);
  assert.ok(Math.abs(L - 1) < 1e-4 && Math.abs(a) < 1e-4 && Math.abs(b) < 1e-4);
  assert.equal(OC.normHex(' B8FF3C '), '#b8ff3c');
  assert.equal(OC.normHex('#fff'), null);
  assert.equal(OC.normHex('red'), null);
});

test('mixHex endpoints, rgb midpoint and oklch shortest hue path', () => {
  for (const interp of OC.COLOUR_INTERPS) {
    assert.equal(OC.mixHex('#102030', '#e0d0c0', 0, interp), '#102030');
    assert.equal(OC.mixHex('#102030', '#e0d0c0', 1, interp), '#e0d0c0');
  }
  assert.equal(OC.mixHex('#000000', '#ffffff', 0.5, 'rgb'), '#808080');
  // the oklab midpoint of black and white is perceptual mid-grey (OKLab L = 0.5)
  const mid = OC.hexToOklch(OC.mixHex('#000000', '#ffffff', 0.5, 'oklab'));
  assert.ok(Math.abs(mid[0] - 0.5) < 0.01);
  // red (h~29) -> magenta-ish (h~328) goes the short way through ~358, not through green
  const h = OC.hexToOklch(OC.mixHex('#ff0000', '#ff00ff', 0.5, 'oklch'))[2];
  assert.ok(h > 300 || h < 40, `hue ${h}`);
});

test('gradientFill fills the inclusive range in either order and leaves the rest', () => {
  const stops = Array(16).fill('#777777');
  const g = OC.gradientFill(stops, 10, 4, '#000000', '#ffffff', 'oklab');
  assert.equal(g[4], '#000000'); assert.equal(g[10], '#ffffff');
  assert.equal(g[3], '#777777'); assert.equal(g[11], '#777777');
  const L = g.slice(4, 11).map(x => OC.hexToOklch(x)[0]);
  for (let i = 1; i < L.length; i++) assert.ok(L[i] > L[i - 1]);
  assert.deepEqual(OC.gradientFill(stops, 5, 5, '#123456', '#ffffff')[5], '#123456');
  assert.equal(stops[4], '#777777', 'input not mutated');
});

test('WCAG contrast', () => {
  assert.equal(OC.contrast('#000000', '#ffffff'), 21);
  assert.equal(OC.contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(OC.contrast('#767676', '#ffffff') - 4.54) < 0.01);
  for (const [name, c] of Object.entries(OC.BUILTIN_COLOURWAYS)) {
    const r = OC.resolveColourway(c);
    assert.ok(OC.contrast(r.text, r.bg) >= 4.5 && OC.contrast(r.text, r.panel) >= 4.5, name);
  }
});

test('variation is deterministic, bounded and zero is identity', () => {
  assert.deepEqual(OC.vary(LIME.stops, 0, 5), LIME.stops);
  const a = OC.vary(LIME.stops, 40, 99), b = OC.vary(LIME.stops, 40, 99), c = OC.vary(LIME.stops, 40, 100);
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  for (const x of a) assert.match(x, /^#[0-9a-f]{6}$/);
  assert.deepEqual(OC.randomLut('triad', 7), OC.randomLut('triad', 7));
  for (const h of OC.COLOUR_HARMONIES) {
    const lut = OC.randomLut(h, 12345); assert.equal(lut.length, OC.LUT_STOPS);
    const L = lut.slice(0, 8).map(x => OC.hexToOklch(x)[0]);
    for (let i = 1; i < 8; i++) assert.ok(L[i] > L[i - 1], `${h} neutral ramp ascends`);
    assert.ok(OC.contrast(lut[7], lut[1]) >= 4.5, `${h} text/bg readable`);
  }
});

test('resolveColourway: mapping then overrides', () => {
  const c = clone(LIME); c.map.text = 10; c.overrides.err = '#010203';
  const r = OC.resolveColourway(c);
  assert.equal(r.text, LIME.stops[10]); assert.equal(r.err, '#010203'); assert.equal(r.bg, LIME.stops[1]);
  assert.deepEqual(Object.keys(r), OC.COLOUR_TOKENS);
});

test('sanitizeColourway accepts builtins and refuses bad shapes', () => {
  for (const c of Object.values(OC.BUILTIN_COLOURWAYS)) assert.deepEqual(OC.sanitizeColourway(c).cw, c);
  const bad = (mut, re) => { const c = clone(LIME); mut(c); const r = OC.sanitizeColourway(c); assert.equal(r.cw, null); assert.match(r.error, re); };
  bad(c => { c.stops[3] = 'red'; }, /#RRGGBB/);
  bad(c => { c.stops[3] = '#fff'; }, /#RRGGBB/);
  bad(c => { c.stops[3] = '#ffffff; background:url(x)'; }, /#RRGGBB/);
  bad(c => { c.stops = Array(33).fill('#000000'); }, /2\.\.32/);
  bad(c => { c.stops = ['#000000']; }, /2\.\.32/);
  bad(c => { c.map.text = 16; }, /map\.text/);
  bad(c => { c.map.text = 1.5; }, /map\.text/);
  bad(c => { c.map.text = '3'; }, /map\.text/);
  bad(c => { c.map.__proto__x = 1; }, /unknown token/);
  bad(c => { c.overrides.text = '#12345'; }, /overrides\.text/);
  bad(c => { c.overrides.evil = '#123456'; }, /unknown token/);
  bad(c => { c.variation = 101; }, /variation/);
  bad(c => { c.seed = -1; }, /seed/);
  bad(c => { c.interp = 'hsl'; }, /interp/);
  bad(c => { c.harmony = 'tetrad'; }, /harmony/);
  assert.equal(OC.sanitizeColourway(null).cw, null);
  assert.equal(OC.sanitizeColourway([]).cw, null);
  // upper-case hex normalised; missing optional fields defaulted
  const r = OC.sanitizeColourway({ stops: ['#AABBCC', '#000000'], map: { text: 0, bg: 1, panel: 1, shadow: 1, line: 1, 'panel-hi': 1, 'text-dim': 0, 'lcd-bg': 1, 'accent-2': 0, accent: 0, ok: 0, lcd: 0, info: 0, warn: 0, hot: 0, err: 0, pending: 0 } });
  assert.equal(r.cw.stops[0], '#aabbcc'); assert.equal(r.cw.variation, 0); assert.equal(r.cw.interp, 'oklab');
});

test('UI state: colourway and saved colourways validated server-side', t => {
  const dir = scratch(t);
  assert.equal(writeUi(dir, { colourway: LIME, colourways: { Mine: OC.BUILTIN_COLOURWAYS.ICE } }, {}).ok, true);
  const ui = readUi(dir);
  assert.deepEqual(ui.colourway, LIME); assert.deepEqual(ui.colourways.Mine, OC.BUILTIN_COLOURWAYS.ICE);
  const bad = clone(LIME); bad.stops[0] = 'javascript:';
  assert.match(sanitizeUi({ colourway: bad }).errors.colourway, /#RRGGBB/);
  assert.equal(writeUi(dir, { colourway: bad }, {}).ok, false);
  assert.deepEqual(readUi(dir).colourway, LIME, 'refused write leaves state untouched');
  assert.match(sanitizeUi({ colourways: { XENOFIELD: LIME } }).errors.colourways, /reserved/);
  assert.match(sanitizeUi({ colourways: { '../x': LIME } }).errors.colourways, /Bad/);
  assert.match(sanitizeUi({ colourways: [] }).errors.colourways, /object/);
  const many = Object.fromEntries(Array.from({ length: OC.MAX_COLOURWAYS + 1 }, (_, i) => [`c${i}`, LIME]));
  assert.match(sanitizeUi({ colourways: many }).errors.colourways, /At most/);
  assert.equal(sanitizeUi({}).ui.colourway, undefined);
});

test('server: colourway edits are UI-only (no store writes, no pending marker) and the page inlines the colour module', async t => {
  const dir = scratch(t), store = memoryStore({});
  const { server, token } = createConfigServer({ store, stateDir: dir, usage: async () => { throw new Error('none'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'x-oai-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const c = clone(OC.BUILTIN_COLOURWAYS.XENOFIELD); c.variation = 20; c.seed = 77; c.overrides.text = '#ffffff';
  let r = await post('/api/ui', { ui: { colourway: c, colourways: { 'My Way': c } } });
  assert.equal(r.status, 200);
  assert.equal(existsSync(join(dir, 'config-pending.json')), false);
  assert.deepEqual(store.read(['OPENAI_WORKER_MAX_STEPS']), { OPENAI_WORKER_MAX_STEPS: '' });
  const st = await (await fetch(base + '/api/state', { headers: { 'x-oai-token': token } })).json();
  assert.equal(st.pending, null); assert.deepEqual(st.ui.colourway, c); assert.deepEqual(st.ui.colourways['My Way'], c);
  const bad = clone(c); bad.map.bg = 99;
  r = await post('/api/ui', { ui: { colourway: bad } });
  assert.equal(r.status, 422); assert.match((await r.json()).errors.colourway, /map\.bg/);
  const html = await (await fetch(`${base}/?t=${token}`)).text();
  assert.ok(html.includes('const OC = (() => {')); assert.ok(!html.includes('/*__OAI_COLOUR__*/'));
  const page = readFileSync(new URL('../scripts/oai-config.html', import.meta.url), 'utf8');
  const OCp = new Function(`${COLOUR_SRC}; return OC;`)();
  assert.deepEqual(OCp.resolveColourway(c), OC.resolveColourway(c));
  assert.ok(renderPage(page, 'n').includes('nonce="n"'));
});

test('page CSS: every colour outside the token block derives from tokens', () => {
  const page = readFileSync(new URL('../scripts/oai-config.html', import.meta.url), 'utf8');
  const css = page.slice(page.indexOf('<style'), page.indexOf('</style>'));
  const tokenBlock = css.slice(css.indexOf(':root{'), css.indexOf('/* everything below derives'));
  for (const t of OC.COLOUR_TOKENS) assert.match(tokenBlock, new RegExp(`--c-${t}:#[0-9a-f]{6};`), t);
  const rest = css.replace(tokenBlock, '');
  assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(?:black|white|red|lime|blue|gr[ae]y)(?![-\w])/g), null);
  // defaults in CSS match the WINAMP LIME builtin
  const r = OC.resolveColourway(LIME);
  for (const t of OC.COLOUR_TOKENS) assert.ok(tokenBlock.includes(`--c-${t}:${r[t]};`), t);
});

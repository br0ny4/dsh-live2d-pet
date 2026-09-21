/**
 * Verify the produced Live2D model + the PSD, independently.
 *  - PSD: read back through ag-psd's own reader (stub canvas) and compare every
 *    layer's alpha against the source layer PNG that segment.mjs wrote.
 *  - model3.json / cdi3.json / physics3.json / motion3.json: JSON.parse
 *  - every FileReferences path: must exist on disk
 *  - moc3: magic + size + version
 *  - textures: must decode with sharp, dimensions reported
 * Run: node tools/verify.mjs
 */
import sharp from 'sharp';
import { readPsd, initializeCanvas } from 'ag-psd';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'out');
const MODEL = '/Users/kiana/Downloads/code/dsh-pet/resources/live2d/models/whale-maid';
const PSD = join(OUT, 'whale-maid.psd');

const fail = [];
const ok = [];
const chk = (cond, msg) => (cond ? ok : fail).push(msg);

// ─────────────────────────── 1. PSD round-trip through ag-psd's reader
initializeCanvas(
  (w, h) => ({ width: w, height: h, getContext: () => ({ putImageData() { }, getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4) }) }) }),
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);
const psdBuf = readFileSync(PSD);
const psd = readPsd(psdBuf, { useImageData: true, skipCompositeImageData: false, skipLayerImageData: false });
chk(psd.width === 484 && psd.height === 853, `PSD dimensions ${psd.width}x${psd.height} (expect 484x853)`);
chk(psd.bitsPerChannel === 8, `PSD bit depth ${psd.bitsPerChannel} (expect 8)`);
chk(psd.colorMode === 3, `PSD colour mode ${psd.colorMode} (expect 3 = RGB)`);
chk(psd.children.length === 27, `PSD layer count ${psd.children.length} (expect 27)`);

// ag-psd children[0] = first stored record = BOTTOM layer
const namesBottomUp = psd.children.map(c => c.name);
const namesTopDown = namesBottomUp.slice().reverse();
chk(namesTopDown[0] === 'front hair 2', `top-most PSD layer is "${namesTopDown[0]}" (expect the ahoge = "front hair 2")`);
chk(namesBottomUp[0] === 'back hair', `bottom-most PSD layer is "${namesBottomUp[0]}" (expect "back hair")`);

// compare per-layer alpha to the source PNGs
let cmpOk = 0, cmpBad = [];
for (const layer of psd.children) {
  // map PSD name back to the source layer file name
  const stat = JSON.parse(readFileSync(join(OUT, 'layer-stats.json'), 'utf8'));
  const src = { 'front hair 2': 'ahoge', 'headwear 2': 'bowhair', 'bottomwear 2': 'bottomwear-2' }[layer.name] || layer.name;
  const png = join(OUT, `layer-${src}.png`);
  if (!existsSync(png)) { cmpBad.push(`${layer.name}: no source png (${src})`); continue; }
  const { data: srcData } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = layer.imageData?.data;
  if (!d) { cmpBad.push(`${layer.name}: reader returned no imageData`); continue; }
  let nz = 0, diff = 0;
  for (let i = 0; i < 484 * 853; i++) {
    const a = d[i * 4 + 3]; if (a) nz++;
    if (a !== srcData[i * 4 + 3]) diff++;
  }
  if (diff === 0) cmpOk++; else cmpBad.push(`${layer.name}: ${diff} alpha mismatches vs ${src}.png`);
}
chk(cmpBad.length === 0, `PSD per-layer alpha matches source PNGs for ${cmpOk}/${psd.children.length} layers` + (cmpBad.length ? ` — BAD: ${cmpBad.join('; ')}` : ''));
console.log(`  composited PSD canvas present: ${!!psd.imageData || !!psd.canvas}`);

// ─────────────────────────── 2. model3.json and friends
const m3Path = join(MODEL, 'whale-maid.model3.json');
const m3 = JSON.parse(readFileSync(m3Path, 'utf8'));
ok.push(`model3.json parses (${statSync(m3Path).size} bytes), Version=${m3.Version}`);
const refs = m3.FileReferences;
const refList = [];
const asList = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
refList.push(['Moc', refs.Moc]);
for (const t of asList(refs.Textures)) refList.push(['Texture', t]);
for (const p of asList(refs.Physics)) refList.push(['Physics', p]);
for (const g of asList(refs.Pose)) refList.push(['Pose', g]);
for (const g of asList(refs.DisplayInfo)) refList.push(['DisplayInfo', g]);
for (const [k, v] of Object.entries(refs.Motions || {})) for (const mv of v) refList.push([`Motion.${k}`, mv.File]);
for (const [k, v] of Object.entries(refs.Expressions || {})) refList.push(['Expression', asList(v)[0]?.File ?? v.File]);
let missing = [];
for (const [kind, rel] of refList) {
  const abs = join(MODEL, rel);
  if (!existsSync(abs)) missing.push(`${kind}:${rel}`);
}
chk(missing.length === 0, `all ${refList.length} FileReferences exist on disk` + (missing.length ? ` — MISSING ${missing.join(', ')}` : ''));
console.log('  FileReferences:');
for (const [kind, rel] of refList) {
  const abs = join(MODEL, rel);
  const sz = existsSync(abs) ? statSync(abs).size : -1;
  console.log(`    ${kind.padEnd(12)} ${rel.padEnd(42)} ${sz >= 0 ? sz + ' bytes' : 'MISSING'}`);
}

// ─────────────────────────── 3. moc3
const mocPath = join(MODEL, refs.Moc);
const moc = readFileSync(mocPath);
const magic = moc.toString('ascii', 0, 4);
const mocVer = moc[4];
const endian = moc[5];
chk(magic === 'MOC3', `moc3 magic "${magic}" (expect "MOC3")`);
chk(moc.length > 20000, `moc3 size ${moc.length} bytes (>20 KB)`);
ok.push(`moc3 version byte=${mocVer}, endianness flag=${endian}`);

// ─────────────────────────── 4. textures
const texDir = join(MODEL, refs.Textures[0]).replace(/\/[^/]+$/, '');
for (const t of refs.Textures) {
  const abs = join(MODEL, t);
  const meta = await sharp(abs).metadata();
  chk(meta.width > 0 && meta.height > 0, `texture ${t} decodes: ${meta.width}x${meta.height} ${meta.format} ${meta.channels}ch (${statSync(abs).size} bytes)`);
}
// opaque-pixel check on the atlas
{
  const { data, info } = await sharp(join(MODEL, refs.Textures[0])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let nz = 0; for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] > 8) nz++;
  chk(nz > 1000, `atlas has ${nz} non-transparent pixels of ${info.width * info.height}`);
}

// ─────────────────────────── 5. other json files
for (const f of ['whale-maid.cdi3.json', 'whale-maid.physics3.json', 'whale-maid.idle.motion3.json',
  'whale-maid.blink.motion3.json', 'whale-maid.nod.motion3.json', 'whale-maid.shake.motion3.json',
  'whale-maid.psd2live.json']) {
  const p = join(MODEL, f);
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const keys = Object.keys(j).slice(0, 5).join(',');
    ok.push(`${f} parses (${statSync(p).size} bytes) keys=[${keys}]`);
  } catch (e) { fail.push(`${f} JSON parse FAILED: ${e.message}`); }
}
const cdi = JSON.parse(readFileSync(join(MODEL, 'whale-maid.cdi3.json'), 'utf8'));
const phys = JSON.parse(readFileSync(join(MODEL, 'whale-maid.physics3.json'), 'utf8'));
ok.push(`cdi3: ${(cdi.Parameters || []).length} parameters, ${(cdi.ParameterGroups || []).length} groups`);
ok.push(`physics3: ${(phys.PhysicsSettings || []).length} physics settings`);

console.log('\n================ VERIFY REPORT ================');
for (const l of ok) console.log('  PASS  ' + l);
for (const l of fail) console.log('  FAIL  ' + l);
console.log(`\n${ok.length} passed, ${fail.length} failed`);
process.exitCode = fail.length ? 1 : 0;

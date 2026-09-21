/**
 * Pack the segmented layer PNGs into a psd2live-compliant .psd
 * ===========================================================
 * Reads  : live2d-pipeline/out/layer-*.png  (written by tools/segment.mjs)
 * Writes : live2d-pipeline/out/whale-maid.psd
 *          live2d-pipeline/debug/psd-report.json  (independent re-parse)
 *
 * Spec compliance (docs/PSD_LAYER_SPEC.md):
 *   - 8-bit RGB + alpha, no opaque background layer  -> noBackground: true
 *   - every layer is a plain raster layer (no text/vector/effects)
 *   - layer names use the spec's semantic tags (+ -l/-r side suffixes, variant numbers)
 *
 * Layer ORDER: psd2live's PsdReader.kt walks the PSD record list in reverse and
 * documents PSD storage as "bottom-to-top". ag-psd maps children[0] to the FIRST
 * stored record, therefore children[0] must be the BOTTOM-most layer. The LAYERS
 * array in segment.mjs is top-first, so it is reversed here.
 *
 * Reproduce:  node tools/build-psd.mjs
 */
import sharp from 'sharp';
import { writePsdBuffer } from 'ag-psd';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'out');
const DBG = join(ROOT, 'debug');
const PSD_PATH = join(OUT, 'whale-maid.psd');

const stats = JSON.parse(readFileSync(join(OUT, 'layer-stats.json'), 'utf8'));
const W = stats.W, H = stats.H;

// top-to-bottom (as authored in segment.mjs) → psd name + spec tag + exactness note
const MAP = {
  'ahoge': { psd: 'front hair 2', tag: 'FRONT_HAIR (variant 2)', kind: 'approx' },
  'front hair': { psd: 'front hair', tag: 'FRONT_HAIR', kind: 'approx' },
  'back hair': { psd: 'back hair', tag: 'BACK_HAIR', kind: 'approx' },
  'headwear': { psd: 'headwear', tag: 'HEADWEAR', kind: 'approx' },
  'bowhair': { psd: 'headwear 2', tag: 'HEADWEAR (variant 2)', kind: 'approx' },
  'ears-l': { psd: 'ears-l', tag: 'EARS (char left)', kind: 'approx' },
  'ears-r': { psd: 'ears-r', tag: 'EARS (char right)', kind: 'approx' },
  'face': { psd: 'face', tag: 'FACE', kind: 'approx' },
  'facedetail': { psd: 'facedetail', tag: 'FACE_DETAIL', kind: 'approx' },
  'eyelash-l': { psd: 'eyelash-l', tag: 'EYELASH (char left)', kind: 'approx' },
  'eyelash-r': { psd: 'eyelash-r', tag: 'EYELASH (char right)', kind: 'approx' },
  'irides-l': { psd: 'irides-l', tag: 'IRIDES (char left)', kind: 'approx' },
  'irides-r': { psd: 'irides-r', tag: 'IRIDES (char right)', kind: 'approx' },
  'eyewhite-l': { psd: 'eyewhite-l', tag: 'EYEWHITE (char left)', kind: 'approx' },
  'eyewhite-r': { psd: 'eyewhite-r', tag: 'EYEWHITE (char right)', kind: 'approx' },
  'mouth': { psd: 'mouth', tag: 'MOUTH', kind: 'approx' },
  'neck': { psd: 'neck', tag: 'NECK', kind: 'approx' },
  'neckwear': { psd: 'neckwear', tag: 'NECKWEAR', kind: 'approx' },
  'topwear': { psd: 'topwear', tag: 'TOPWEAR', kind: 'approx' },
  'handwear-l': { psd: 'handwear-l', tag: 'HANDWEAR (char left)', kind: 'approx' },
  'handwear-r': { psd: 'handwear-r', tag: 'HANDWEAR (char right)', kind: 'approx' },
  'bottomwear-2': { psd: 'bottomwear 2', tag: 'BOTTOMWEAR (variant 2) — apron', kind: 'approx' },
  'bottomwear': { psd: 'bottomwear', tag: 'BOTTOMWEAR', kind: 'approx' },
  'legwear-l': { psd: 'legwear-l', tag: 'LEGWEAR (char left)', kind: 'approx' },
  'legwear-r': { psd: 'legwear-r', tag: 'LEGWEAR (char right)', kind: 'approx' },
  'footwear-l': { psd: 'footwear-l', tag: 'FOOTWEAR (char left)', kind: 'approx' },
  'footwear-r': { psd: 'footwear-r', tag: 'FOOTWEAR (char right)', kind: 'approx' },
};

// ── collect layers (top-first order from layer-stats.json), skipping empties
const present = stats.stats.filter(s => s.n > 0);
const entries = [];
for (const s of present) {
  const m = MAP[s.name];
  if (!m) throw new Error(`no PSD mapping for layer "${s.name}"`);
  const png = join(OUT, `layer-${s.name}.png`);
  if (!existsSync(png)) throw new Error(`missing ${png} — run tools/segment.mjs first`);
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  entries.push({ src: s.name, psd: m.psd, tag: m.tag, kind: m.kind, px: s.n, data: new Uint8ClampedArray(data) });
}

// composite = exact source recomposite (segment.mjs asserted it equals the source RGB)
const compPng = join(DBG, 'recomposite.png');
const { data: compData } = await sharp(compPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// ── children[0] must be the BOTTOM layer  → reverse the top-first list
const children = entries.slice().reverse().map(e => ({
  name: e.psd,
  imageData: { data: e.data, width: W, height: H },
}));

const psd = {
  width: W,
  height: H,
  channels: 4,
  bitsPerChannel: 8,
  colorMode: 3,                       // RGB
  imageData: { data: new Uint8ClampedArray(compData), width: W, height: H },
  children,
};

const buf = writePsdBuffer(psd, { noBackground: true, generateThumbnail: false, trimImageData: false });
writeFileSync(PSD_PATH, buf);
console.log(`wrote ${PSD_PATH}  (${buf.length} bytes, ${entries.length} layers)`);

// ─────────────────────────────────────────────────────────── independent re-parse
// Written from scratch (no ag-psd) so the verification does not trust the writer.
function parsePsd(b) {
  const sig = b.toString('ascii', 0, 4);
  const ver = b.readUInt16BE(4), ch = b.readUInt16BE(12);
  const h = b.readUInt32BE(14), w = b.readUInt32BE(18);
  const depth = b.readUInt16BE(22), mode = b.readUInt16BE(24);
  let p = 26;
  const rd32 = () => { const v = b.readUInt32BE(p); p += 4; return v; };
  const cmLen = rd32(); p += cmLen;                              // colour mode data
  const irLen = rd32(); p += irLen;                              // image resources
  const lmLen = rd32();                                          // layer & mask section
  const lmStart = p;
  const layerInfoLen = rd32();
  let layerCount = b.readInt16BE(p); p += 2;
  const globalAlpha = layerCount < 0; if (globalAlpha) layerCount = -layerCount;
  const records = [];
  for (let i = 0; i < layerCount; i++) {
    const top = b.readInt32BE(p), left = b.readInt32BE(p + 4), bottom = b.readInt32BE(p + 8), right = b.readInt32BE(p + 12);
    p += 16;
    const nch = b.readUInt16BE(p); p += 2;
    const chIds = [];
    for (let c = 0; c < nch; c++) { chIds.push(b.readInt16BE(p)); p += 2 + 4; }
    const blendSig = b.toString('ascii', p, p + 4); p += 4;
    const blendKey = b.toString('ascii', p, p + 4); p += 4;
    const opacity = b[p]; p += 1;
    const clipping = b[p]; p += 1;
    const flags = b[p]; p += 1; p += 1;
    const extraLen = rd32(); const extraEnd = p + extraLen;
    const maskLen = rd32(); p += maskLen;
    const blendLen = rd32(); p += blendLen;
    // layer name: Pascal string padded to 4 bytes, then additional-info blocks ('luni' preferred)
    let name = '';
    {
      const nlen = b[p];
      name = b.subarray(p + 1, p + 1 + nlen).toString('latin1');
      p += 1 + nlen; p += (4 - (p % 4)) % 4;
    }
    for (let q = p; q + 12 <= extraEnd;) {
      if (b.toString('ascii', q, q + 4) !== '8BIM') { q++; continue; }
      const key = b.toString('ascii', q + 4, q + 8);
      const blen = b.readUInt32BE(q + 8);
      if (key === 'luni' && blen >= 4) {
        const nchars = b.readUInt32BE(q + 12);
        let s = '';
        for (let k = 0; k < nchars; k++) { const v = b.readUInt16BE(q + 16 + k * 2); if (v) s += String.fromCharCode(v); }
        if (s) name = s;
      }
      q += 12 + blen + (blen % 2);
    }
    p = extraEnd;
    records.push({ name, top, left, bottom, right, nch, chIds: chIds.join(","), blendSig, blendKey, opacity, clipping, hidden: !!(flags & 2) });
  }
  // channel pixel data follows, in the same record order.
  // The exact start is self-validated: only one candidate offset makes the channel
  // table + all channel lengths land exactly on the end of the layer-info section.
  const infoEnd = lmStart + 4 + layerInfoLen;
  const totalChans = records.reduce((a, r) => a + r.nch, 0);
  let dataStarts = null, chanInfo = null;
  for (let cand = p; cand <= p + 64; cand++) {
    let q = cand; const lens = []; let sum = 0, ok = true;
    for (let i = 0; i < layerCount && ok; i++) {
      const row = [];
      for (let c = 0; c < records[i].nch; c++) {
        if (q + 6 > infoEnd) { ok = false; break; }
        const L = b.readUInt32BE(q + 2); q += 6; row.push(L); sum += L;
      }
      lens.push(row);
    }
    if (!ok) continue;
    if (q + sum !== infoEnd) continue;
    chanInfo = lens;
    dataStarts = []; let r = q;
    for (let i = 0; i < layerCount; i++) { dataStarts.push(r); for (const L of lens[i]) r += L; }
    console.log(`  channel table located at ${cand} (probe start ${p}, drift ${cand - p}), data bytes ${sum}`);
    break;
  }
  if (!dataStarts) { chanInfo = records.map(r => new Array(r.nch).fill(0)); dataStarts = records.map(() => p); }
  // layer info, then: global layer mask info (4-byte length + data), then image data
  p = lmStart + 4 + layerInfoLen + (layerInfoLen % 2);
  const globalMaskLen = b.readUInt32BE(p);
  p += 4 + globalMaskLen;
  const imgSection = p;
  const compression = b.readUInt16BE(imgSection);
  // ── decode one RLE channel per layer and hash it: proves the PSD really carries our pixels
  const rleDecode = (off, len, expect) => {
    if (compression !== 1) return null;
    if (!(off >= 0 && len > 0 && off + len <= b.length)) return null;
    const out = Buffer.alloc(expect); let o = 0, q = off, end = off + len;
    while (q < end && o < expect) {
      let n = b.readInt8(q); q++;
      if (n >= 0) { const c = Math.min(n + 1, expect - o); b.copy(out, o, q, q + c); q += c; o += c; }
      else if (n > -128) { const c = Math.min(1 - n, expect - o); out.fill(b[q], o, o + c); q++; o += c; }
      else if (n === -128) { /* no-op */ }
    }
    return o === expect ? out : null;
  };
  const alphaHashes = [];
  for (let i = 0; i < layerCount; i++) {
    const rec = records[i];
    const ai = rec.chIds.split(',').map(Number).indexOf(-1);
    if (ai < 0) { alphaHashes.push(null); continue; }
    let off = dataStarts[i];
    for (let c = 0; c < ai; c++) off += chanInfo[i][c];
    const dec = rleDecode(off, chanInfo[i][ai], rec.right - rec.left === w && rec.bottom - rec.top === h ? w * h : (rec.right - rec.left) * (rec.bottom - rec.top));
    if (!dec) { alphaHashes.push(null); continue; }
    let h32 = 2166136261 >>> 0;
    for (let k = 0; k < dec.length; k++) { h32 ^= dec[k]; h32 = Math.imul(h32, 16777619) >>> 0; }
    alphaHashes.push({ layer: rec.name, alphaNonZero: dec.reduce((a, v) => a + (v ? 1 : 0), 0), fnv1a: h32.toString(16) });
  }
  return { sig, ver, ch, w, h, depth, mode, layerCount, globalAlpha, records, chanInfo, recordOrder: records.map(r => r.name), totalLen: b.length, lmLen, layerInfoLen, compression, alphaHashes };
}
const parsed = parsePsd(buf);
const report = {
  bytes: buf.length,
  header: { signature: parsed.sig, version: parsed.ver, channels: parsed.ch, width: parsed.w, height: parsed.h, depth: parsed.depth, colorMode: parsed.mode },
  layerCount: parsed.layerCount,
  globalAlpha: parsed.globalAlpha,
  fileOrder: parsed.recordOrder,
  alphaChannelDecode: parsed.alphaHashes,
  layerDetails: parsed.records,
  mapping: entries.map(e => ({ psd: e.psd, tag: e.tag, kind: e.kind, srcLayer: e.src, px: e.px })),
};
writeFileSync(join(DBG, 'psd-report.json'), JSON.stringify(report, null, 1));

console.log(`header: ${parsed.sig} v${parsed.ver} ${parsed.w}x${parsed.h} depth=${parsed.depth} mode=${parsed.mode} channels=${parsed.ch}`);
console.log(`layers in file (record order = BOTTOM→TOP): ${parsed.layerCount}`);
console.log('  ' + parsed.recordOrder.join(' | '));
console.log(`psd-report.json written`);

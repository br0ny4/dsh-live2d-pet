/**
 * whale-maid → psd2live-compliant layered PSD
 * ============================================
 * Input : resources/character/whale-maid/character.png  (484x853 RGBA)
 * Output: live2d-pipeline/out/whale-maid.psd  (+ per-layer PNGs + previews)
 *
 * WHY THIS SCRIPT EXISTS IN THIS SHAPE
 * ------------------------------------
 * The supplied `character.png` has a *degraded alpha channel*: large parts of the
 * head/hair sit at alpha 40..140 instead of 255, and the ahoge/headdress are at
 * alpha ~0..85 (see docs/FINDINGS.md). Its RGB is straight (un-premultiplied) and
 * correct, so the silhouette is reconstructed from RGB instead:
 *
 *      ink = 255 - min(r,g,b)                    // 0 on the white paper
 *      background = flood-fill from the border through ink <= T_BG
 *      silhouette = NOT background               // holes filled
 *
 * Segmentation is a STRICT PARTITION of the silhouette: every silhouette pixel is
 * claimed by exactly one layer, so stacking the layers reproduces the source art
 * pixel-exactly (asserted at the end). Rules are colour classification + geometric
 * priors (boxes read off zoomed crops) applied in z-order.
 *
 * One deliberate exception to the strict partition: the `face` layer additionally
 * receives an *inpainted* forehead/cheek oval under the bangs. That layer sits
 * below `front hair`, which is opaque there, so the composite is unchanged while
 * the rig gets a complete face.
 *
 * Reproduce:  node tools/segment.mjs
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = '/Users/kiana/Downloads/code/dsh-pet/resources/character/whale-maid/character.png';
const OUT = join(ROOT, 'out');
const DBG = join(ROOT, 'debug');
mkdirSync(OUT, { recursive: true });
mkdirSync(DBG, { recursive: true });

const T_BG = 9;
const MIN_COMPONENT = 24;

// ─────────────────────────────────────────────────────────── load
const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, N = W * H;
const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N), INK = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  R[i] = data[i * 4]; G[i] = data[i * 4 + 1]; B[i] = data[i * 4 + 2];
  INK[i] = 255 - Math.min(R[i], G[i], B[i]);
}
const idx = (x, y) => y * W + x;
const stackBuf = new Int32Array(N);

// ─────────────────────────────────────────────────────────── 1. silhouette
const isPaper = new Uint8Array(N);
for (let i = 0; i < N; i++) isPaper[i] = INK[i] <= T_BG ? 1 : 0;
const outside = new Uint8Array(N);
{
  let sp = 0;
  const push = (p) => { if (isPaper[p] && !outside[p]) { outside[p] = 1; stackBuf[sp++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp > 0) {
    const p = stackBuf[--sp], x = p % W, y = (p / W) | 0;
    if (x + 1 < W) push(p + 1);
    if (x > 0) push(p - 1);
    if (y + 1 < H) push(p + W);
    if (y > 0) push(p - W);
  }
}
let sil = new Uint8Array(N);
for (let i = 0; i < N; i++) sil[i] = outside[i] ? 0 : 1;

function labelMask(mask) {                     // → {lab, comps}
  const lab = new Int32Array(N).fill(-1); const comps = [];
  for (let s = 0; s < N; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const id = comps.length; let sp = 0; stackBuf[sp++] = s; lab[s] = id;
    let n = 0, minx = W, maxx = -1, miny = H, maxy = -1, sx = 0, sy = 0;
    while (sp > 0) {
      const p = stackBuf[--sp]; const x = p % W, y = (p / W) | 0;
      n++; sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x + 1 < W && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stackBuf[sp++] = p + 1; }
      if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stackBuf[sp++] = p - 1; }
      if (y + 1 < H && mask[p + W] && lab[p + W] < 0) { lab[p + W] = id; stackBuf[sp++] = p + W; }
      if (y > 0 && mask[p - W] && lab[p - W] < 0) { lab[p - W] = id; stackBuf[sp++] = p - W; }
    }
    comps.push({ id, n, minx, maxx, miny, maxy, cx: sx / n, cy: sy / n });
  }
  return { lab, comps };
}
const filterSize = (mask, minSize) => {
  const { lab, comps } = labelMask(mask);
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (lab[i] >= 0 && comps[lab[i]].n >= minSize) out[i] = 1;
  return out;
};
sil = filterSize(sil, MIN_COMPONENT);
{ // fill enclosed holes
  const bg = new Uint8Array(N); for (let i = 0; i < N; i++) bg[i] = sil[i] ? 0 : 1;
  const { lab, comps } = labelMask(bg);
  const touches = new Uint8Array(comps.length);
  for (const c of comps) if (c.minx === 0 || c.miny === 0 || c.maxx === W - 1 || c.maxy === H - 1) touches[c.id] = 1;
  for (let i = 0; i < N; i++) if (bg[i] && lab[i] >= 0 && !touches[lab[i]]) sil[i] = 1;
}
const fillHoles = (mask) => {
  // flood from the bounding-box border outside the mask, inside the bbox
  const { comps } = labelMask(mask);
  if (!comps.length) return mask;
  const x0 = Math.min(...comps.map(c => c.minx)), x1 = Math.max(...comps.map(c => c.maxx));
  const y0 = Math.min(...comps.map(c => c.miny)), y1 = Math.max(...comps.map(c => c.maxy));
  const inv = new Uint8Array(N);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = idx(x, y); if (!mask[i]) inv[i] = 1; }
  const seen = new Uint8Array(N); let sp = 0;
  const push = (p) => { if (inv[p] && !seen[p]) { seen[p] = 1; stackBuf[sp++] = p; } };
  for (let x = x0; x <= x1; x++) { push(idx(x, y0)); push(idx(x, y1)); }
  for (let y = y0; y <= y1; y++) { push(idx(x0, y)); push(idx(x1, y)); }
  while (sp > 0) {
    const p = stackBuf[--sp], x = p % W, y = (p / W) | 0;
    if (x > x0) push(p - 1);
    if (x < x1) push(p + 1);
    if (y > y0) push(p - W);
    if (y < y1) push(p + W);
  }
  const out = Uint8Array.from(mask);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = idx(x, y); if (inv[i] && !seen[i]) out[i] = 1; }
  return out;
};

// ─────────────────────────────────────────────────────────── 2. colour predicates
const isNearWhite = i => INK[i] < 26 && (Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i])) < 26;
// skin: warm and clearly lighter than the hair/cloth; the R-B gap is the key test
const isSkin = i => R[i] > 188 && R[i] - B[i] > 17 && G[i] - B[i] > 3 && R[i] - G[i] < 78;
const isBlush = i => R[i] > 200 && R[i] - G[i] > 33 && R[i] - B[i] > 42;
const isPale = i => Math.min(R[i], G[i], B[i]) > 112;
const isBlue = i => B[i] - R[i] > 12;
// hair vs navy cloth: hair has a distinctly larger green-red / blue-red gap
const hairiness = i => (G[i] - R[i]) + 0.35 * (B[i] - R[i]);

// ─────────────────────────────────────────────────────────── 3. geometry
const inBox = (x, y, b) => x >= b[0] && y >= b[1] && x <= b[2] && y <= b[3];
const BOX = {
  ahoge: [172, 14, 300, 100],
  headdress: [66, 80, 424, 216],
  bowHair: [356, 212, 416, 288],
  flukeV: [10, 286, 116, 366],   // viewer-left  = character RIGHT
  flukeV2: [366, 286, 476, 366],   // viewer-right = character LEFT
  face: [138, 194, 346, 396],
  frontHairZone: [130, 186, 354, 400],
  eyeVL: [150, 270, 218, 346],
  eyeVR: [266, 270, 336, 346],
  mouth: [216, 336, 260, 376],
  neck: [202, 380, 284, 406],
  neckwear: [194, 384, 288, 454],
  blouse: [154, 378, 308, 484],
  corset: [174, 454, 322, 514],
  apron: [138, 488, 342, 664],
  skirt: [46, 580, 440, 740],
  sleeveV: [54, 446, 158, 564],
  sleeveV2: [328, 446, 434, 564],
  handV: [62, 530, 134, 600],
  handV2: [364, 530, 428, 600],
  legV: [164, 710, 244, 814],
  legV2: [238, 710, 318, 814],
  footV: [178, 790, 248, 852],
  footV2: [240, 790, 308, 852],
  torsoCore: [158, 378, 326, 672],
};

// ─────────────────────────────────────────────────────────── 4. derived masks
// flukes: pale blobs inside each fluke box, dilated into their surrounding outline
function paleBlobs(box, minPx = 60, grow = 5) {
  const m = new Uint8Array(N);
  for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
    const i = idx(x, y); if (sil[i] && isPale(i)) m[i] = 1;
  }
  let cur = filterSize(m, minPx);
  for (let s = 0; s < grow; s++) {
    const nxt = Uint8Array.from(cur);
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
      const i = idx(x, y); if (cur[i] || !sil[i]) continue;
      if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) nxt[i] = 1;
    }
    cur = nxt;
  }
  return cur;
}
const flukeV = paleBlobs(BOX.flukeV), flukeV2 = paleBlobs(BOX.flukeV2);

const headdressMask = new Uint8Array(N);
for (let y = BOX.headdress[1]; y <= BOX.headdress[3]; y++) for (let x = BOX.headdress[0]; x <= BOX.headdress[2]; x++) {
  const i = idx(x, y);
  if (sil[i] && isPale(i) && !flukeV[i] && !flukeV2[i]) headdressMask[i] = 1;
}

// eye decomposition: iris blob (holes filled) -> sclera -> upper lash only
function eyeParts(box) {
  const raw = new Uint8Array(N);
  for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
    const i = idx(x, y);
    if (sil[i] && B[i] - R[i] > 10 && INK[i] > 55) raw[i] = 1;   // saturated blue = iris/pupil
  }
  const { lab, comps } = labelMask(raw);
  let best = null; for (const c of comps) if (!best || c.n > best.n) best = c;
  const blob = new Uint8Array(N);
  if (best) for (let i = 0; i < N; i++) if (lab[i] === best.id) blob[i] = 1;
  const iris = fillHoles(blob);
  // centroid of the iris gives the eyelid split line
  let sy = 0, n = 0;
  for (let i = 0; i < N; i++) if (iris[i]) { sy += (i / W) | 0; n++; }
  const cy = n ? sy / n : (box[1] + box[3]) / 2;
  const lash = new Uint8Array(N), white = new Uint8Array(N), low = new Uint8Array(N);
  for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
    const i = idx(x, y); if (!sil[i] || iris[i]) continue;
    if (INK[i] > 190) { if (y < cy) lash[i] = 1; else low[i] = 1; }
  }
  // sclera = bright pixels *inside the eye*, i.e. below the upper lash and above the
  // lower lid in that column. This keeps the surrounding bright face skin out.
  for (let x = box[0]; x <= box[2]; x++) {
    let lashBot = box[1] - 1, eyeBot = box[3] + 1;
    for (let y = box[1]; y <= box[3]; y++) if (lash[idx(x, y)]) lashBot = y;
    for (let y = box[1]; y <= box[3]; y++) if (low[idx(x, y)]) { eyeBot = y; break; }
    if (lashBot < box[1]) continue;
    for (let y = lashBot + 1; y < eyeBot; y++) {
      const i = idx(x, y);
      if (!sil[i] || iris[i]) continue;
      if (INK[i] < 62) white[i] = 1;
    }
  }
  return { iris, lash, white, low, cy };
}
const eyeV = eyeParts(BOX.eyeVL);    // viewer-left  -> character RIGHT  (-r)
const eyeV2 = eyeParts(BOX.eyeVR);    // viewer-right -> character LEFT   (-l)

// ─────────────────────────────────────────────────────────── 5. z-ordered strict partition
const LAYERS = [
  'ahoge',
  'eyelash-l', 'eyelash-r',
  'irides-l', 'irides-r',
  'eyewhite-l', 'eyewhite-r',
  'mouth',
  'facedetail',
  'headwear',
  'ears-l', 'ears-r',
  'bowhair',
  'front hair',
  'face',
  'neckwear',
  'neck',
  'topwear',
  'handwear-l', 'handwear-r',
  'bottomwear-2',       // apron (spec has no apron tag; variant of bottomwear)
  'bottomwear',         // skirt
  'legwear-l', 'legwear-r',
  'footwear-l', 'footwear-r',
  'back hair',
];
const L = Object.fromEntries(LAYERS.map((n, k) => [n, k]));
const layerOf = new Int32Array(N).fill(-1);
const claim = (i, name) => { if (layerOf[i] < 0) layerOf[i] = L[name]; };

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (!sil[i]) continue;
    const h = hairiness(i);
    const inCore = inBox(x, y, BOX.torsoCore);
    const hairH = inCore ? 40 : 12;      // hair threshold: stricter inside the torso

    // ---- front of face
    if (isBlue(i) && INK[i] < 238 && inBox(x, y, BOX.ahoge)) { claim(i, 'ahoge'); continue; }
    if (inBox(x, y, BOX.eyeVL)) {
      if (eyeV.lash[i]) { claim(i, 'eyelash-r'); continue; }
      if (eyeV.iris[i]) { claim(i, 'irides-r'); continue; }
      if (eyeV.white[i]) { claim(i, 'eyewhite-r'); continue; }
      if (eyeV.low[i]) { claim(i, 'facedetail'); continue; }
    }
    if (inBox(x, y, BOX.eyeVR)) {
      if (eyeV2.lash[i]) { claim(i, 'eyelash-l'); continue; }
      if (eyeV2.iris[i]) { claim(i, 'irides-l'); continue; }
      if (eyeV2.white[i]) { claim(i, 'eyewhite-l'); continue; }
      if (eyeV2.low[i]) { claim(i, 'facedetail'); continue; }
    }
    // mouth: lips+interior are the *redder* skin (high R-G) plus the dark inner line
    if (inBox(x, y, BOX.mouth) && ((R[i] - G[i] > 40 && R[i] - B[i] > 45) || INK[i] > 150)) { claim(i, 'mouth'); continue; }
    // neck (claimed before `face`, which would otherwise swallow the chin band)
    if (isSkin(i) && inBox(x, y, BOX.neck) && !inBox(x, y, BOX.mouth)) { claim(i, 'neck'); continue; }
    // ---- head shell
    if (headdressMask[i]) { claim(i, 'headwear'); continue; }
    if (flukeV[i]) { claim(i, 'ears-r'); continue; }
    if (flukeV2[i]) { claim(i, 'ears-l'); continue; }
    if (isBlue(i) && INK[i] < 232 && inBox(x, y, BOX.bowHair)) { claim(i, 'bowhair'); continue; }
    if (isBlush(i) && inBox(x, y, [146, 314, 344, 374])) { claim(i, 'facedetail'); continue; }
    if (isSkin(i) && inBox(x, y, BOX.face)) { claim(i, 'face'); continue; }
    if (isBlue(i) && h > 6 && INK[i] < 240 && inBox(x, y, BOX.frontHairZone)) { claim(i, 'front hair'); continue; }
    // hair on the head shell and the upper drape
    if (isBlue(i) && h > hairH && INK[i] < 240 && y < 470) { claim(i, 'back hair'); continue; }
    if (isNearWhite(i) && y < 470 && (x < 152 || x > 332)) { claim(i, 'back hair'); continue; }
    // ---- body
    if (inBox(x, y, BOX.neckwear)) { claim(i, 'neckwear'); continue; }
    if ((isNearWhite(i) || INK[i] < 70) && inBox(x, y, BOX.blouse)) { claim(i, 'topwear'); continue; }
    if (inBox(x, y, BOX.corset) && h <= 40) { claim(i, 'topwear'); continue; }
    if (inBox(x, y, BOX.sleeveV) || inBox(x, y, BOX.handV)) { if (h <= 40) { claim(i, 'handwear-r'); continue; } }
    if (inBox(x, y, BOX.sleeveV2) || inBox(x, y, BOX.handV2)) { if (h <= 40) { claim(i, 'handwear-l'); continue; } }
    if (inBox(x, y, BOX.apron) && !(isBlue(i) && h > 45)) { claim(i, 'bottomwear-2'); continue; }
    if (inBox(x, y, BOX.skirt) && !(isBlue(i) && h > 45)) { claim(i, 'bottomwear'); continue; }
    if (inBox(x, y, BOX.legV)) { claim(i, 'legwear-r'); continue; }
    if (inBox(x, y, BOX.legV2)) { claim(i, 'legwear-l'); continue; }
    if (inBox(x, y, BOX.footV)) { claim(i, 'footwear-r'); continue; }
    if (inBox(x, y, BOX.footV2)) { claim(i, 'footwear-l'); continue; }
    // ---- remaining hair drape over the dress / sleeves
    if (isBlue(i) && h > 40 && INK[i] < 240 && y < 690) { claim(i, 'back hair'); continue; }
  }
}
for (let i = 0; i < N; i++) if (sil[i] && layerOf[i] < 0) layerOf[i] = L['back hair'];

// ─────────────────────────────────────────────────────────── 6. face underpaint (inpainted forehead)
// Extra pixels ONLY in the `face` PNG; not registered in layerOf, so the strict
// partition / composite assertion below is untouched. `front hair`, the eyes and
// the mouth are all ABOVE `face`, so the rendered composite is unchanged.
const faceExtra = new Uint8Array(N);
{
  const known = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (layerOf[i] === L['face']) known[i] = 1;
  // region the face may extend into: everything above the eyes' claim lines inside the face box
  const cand = new Uint8Array(N);
  for (let y = BOX.face[1]; y <= BOX.face[3]; y++) for (let x = BOX.face[0]; x <= BOX.face[2]; x++) {
    const i = idx(x, y);
    if (!sil[i] || known[i]) continue;
    const k = layerOf[i];
    if (k === L['front hair'] || k === L['facedetail'] || k === L['mouth'] ||
      k === L['eyelash-l'] || k === L['eyelash-r'] || k === L['irides-l'] || k === L['irides-r'] ||
      k === L['eyewhite-l'] || k === L['eyewhite-r'] || k === L['headwear'] ||
      k === L['ears-l'] || k === L['ears-r'] || k === L['bowhair']) cand[i] = 1;
  }
  const hull = fillHoles((() => { const m = Uint8Array.from(known); for (let i = 0; i < N; i++) if (cand[i]) m[i] = 1; return m; })());
  for (let y = BOX.face[1]; y <= BOX.face[3]; y++) for (let x = BOX.face[0]; x <= BOX.face[2]; x++) {
    const i = idx(x, y);
    if (hull[i] && !known[i] && (cand[i] || layerOf[i] < 0)) faceExtra[i] = 1;
  }
}
// colour the underpaint by iterative nearest-skin diffusion
const faceRGB = new Uint8Array(N * 3);
for (let i = 0; i < N; i++) if (layerOf[i] === L['face']) { faceRGB[i * 3] = R[i]; faceRGB[i * 3 + 1] = G[i]; faceRGB[i * 3 + 2] = B[i]; }
{
  let frontier = [];
  for (let i = 0; i < N; i++) if (layerOf[i] === L['face']) frontier.push(i);
  let guard = 0;
  while (frontier.length && guard++ < 400) {
    const next = [];
    for (const p of frontier) {
      const x = p % W, y = (p / W) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) {
        if (q < 0 || !faceExtra[q] || faceRGB[q * 3] || faceRGB[q * 3 + 1] || faceRGB[q * 3 + 2]) continue;
        faceRGB[q * 3] = R[p]; faceRGB[q * 3 + 1] = G[p]; faceRGB[q * 3 + 2] = B[p];
        next.push(q);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  // smooth the diffused field a few times
  for (let it = 0; it < 6; it++) {
    const cp = Uint8Array.from(faceRGB);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y); if (!faceExtra[i]) continue;
      for (let c = 0; c < 3; c++) {
        let s = 0, k = 0;
        for (const q of [i - 1, i + 1, i - W, i + W]) if (layerOf[q] === L['face'] || faceExtra[q]) { s += cp[q * 3 + c]; k++; }
        if (k) faceRGB[i * 3 + c] = Math.round(s / k);
      }
    }
  }
  for (let i = 0; i < N; i++) if (faceExtra[i] && !faceRGB[i * 3] && !faceRGB[i * 3 + 1] && !faceRGB[i * 3 + 2]) {
    faceRGB[i * 3] = 251; faceRGB[i * 3 + 1] = 236; faceRGB[i * 3 + 2] = 225;
  }
}

// ─────────────────────────────────────────────────────────── 7. report, write layers, assert
const stats = [];
for (let k = 0; k < LAYERS.length; k++) {
  let n = 0, minx = W, maxx = -1, miny = H, maxy = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y); if (layerOf[i] !== k) continue;
    n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  stats.push({ name: LAYERS[k], n, bbox: n ? [minx, miny, maxx, maxy] : null });
}
console.log('=== strict partition ===');
let tot = 0, silN = 0;
for (const s of stats) { tot += s.n; console.log(`  ${s.name.padEnd(14)} px=${String(s.n).padStart(7)}  bbox=${s.bbox ? `[${s.bbox.join(',')}]` : '-'}`); }
for (let i = 0; i < N; i++) silN += sil[i];
console.log(`  ${'SILHOUETTE'.padEnd(14)} px=${String(silN).padStart(7)}  (partition total ${tot})`);

for (let k = 0; k < LAYERS.length; k++) {
  if (stats[k].n === 0) continue;
  const buf = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    if (layerOf[i] === k) { buf[i * 4] = R[i]; buf[i * 4 + 1] = G[i]; buf[i * 4 + 2] = B[i]; buf[i * 4 + 3] = 255; }
    else if (k === L['face'] && faceExtra[i]) { buf[i * 4] = faceRGB[i * 3]; buf[i * 4 + 1] = faceRGB[i * 3 + 1]; buf[i * 4 + 2] = faceRGB[i * 3 + 2]; buf[i * 4 + 3] = 255; }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(OUT, `layer-${LAYERS[k]}.png`));
}

// composite assertion (strict partition only)
const comp = Buffer.alloc(N * 4);
for (let k = LAYERS.length - 1; k >= 0; k--) for (let i = 0; i < N; i++) {
  if (layerOf[i] !== k) continue;
  comp[i * 4] = R[i]; comp[i * 4 + 1] = G[i]; comp[i * 4 + 2] = B[i]; comp[i * 4 + 3] = 255;
}
let maxd = 0, sum = 0, cnt = 0;
for (let i = 0; i < N; i++) {
  if (!sil[i]) continue;
  const d = Math.max(Math.abs(comp[i * 4] - R[i]), Math.abs(comp[i * 4 + 1] - G[i]), Math.abs(comp[i * 4 + 2] - B[i]));
  sum += d; cnt++; if (d > maxd) maxd = d;
}
console.log(`\ncomposite vs source (inside silhouette): mean|Δ|=${(sum / cnt).toFixed(4)} max|Δ|=${maxd}   (0 == exact)`);
if (maxd !== 0) { console.error('!! PARTITION IS NOT EXACT'); process.exitCode = 1; }
await sharp(comp, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(DBG, 'recomposite.png'));

// label map + per-layer contact sheet for visual review
const PALETTE = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 0, 255],
[0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 0], [0, 128, 128], [192, 192, 192], [255, 105, 180], [46, 139, 87],
[210, 105, 30], [70, 130, 180], [220, 20, 60], [154, 205, 50], [72, 61, 139], [199, 21, 133], [0, 100, 0], [139, 69, 19],
[255, 215, 0], [95, 158, 160], [255, 0, 0]];
const lab = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  if (layerOf[i] < 0) continue;
  const c = PALETTE[layerOf[i] % PALETTE.length];
  lab[i * 4] = c[0]; lab[i * 4 + 1] = c[1]; lab[i * 4 + 2] = c[2]; lab[i * 4 + 3] = 255;
}
await sharp(lab, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(DBG, 'labelmap.png'));

// contact sheet: each non-empty layer over dark grey, 5 cols
{
  const cols = 5, cell = 190, cw = Math.round(cell * W / H), ch = cell;
  const rows = Math.ceil(LAYERS.filter((n, k) => stats[k].n > 0).length / cols);
  const sheet = Buffer.alloc(cw * cols * ch * rows * 3, 40);
  let n = 0;
  for (let k = 0; k < LAYERS.length; k++) {
    if (!stats[k].n) continue;
    const buf = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) if (layerOf[i] === k || (k === L['face'] && faceExtra[i])) {
      buf[i * 4] = layerOf[i] === k ? R[i] : faceRGB[i * 3];
      buf[i * 4 + 1] = layerOf[i] === k ? G[i] : faceRGB[i * 3 + 1];
      buf[i * 4 + 2] = layerOf[i] === k ? B[i] : faceRGB[i * 3 + 2];
      buf[i * 4 + 3] = 255;
    }
    const small = await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
      .flatten({ background: { r: 40, g: 40, b: 48 } }).resize(cw, ch, { fit: 'fill' }).raw().toBuffer();
    const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 3, d = ((oy + y) * cw * cols + ox + x) * 3;
      sheet[d] = small[s]; sheet[d + 1] = small[s + 1]; sheet[d + 2] = small[s + 2];
    }
    n++;
  }
  await sharp(sheet, { raw: { width: cw * cols, height: ch * rows, channels: 3 } }).png().toFile(join(DBG, 'layers-sheet.png'));
  console.log(`contact sheet: ${n} layers, ${cw * cols}x${ch * rows}, order = ${LAYERS.filter((x, k) => stats[k].n > 0).join(' | ')}`);
}

writeFileSync(join(OUT, 'layer-stats.json'), JSON.stringify({ W, H, order: LAYERS, stats }, null, 1));
console.log(`\nwrote layer PNGs to ${OUT}`);

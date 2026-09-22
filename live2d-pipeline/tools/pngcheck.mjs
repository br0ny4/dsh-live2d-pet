// Minimal independent PNG decoder (Node zlib only) to cross-check sharp's reading.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const SRC = process.argv[2]
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'character', 'whale-maid', 'character.png');
const f = readFileSync(SRC);
let p = 8; const chunks = []; let ihdr = null; const idat = [];
while (p < f.length) {
  const len = f.readUInt32BE(p); const type = f.toString('ascii', p + 4, p + 8);
  const body = f.subarray(p + 8, p + 8 + len);
  if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], color: body[9], comp: body[10], filter: body[11], interlace: body[12] };
  if (type === 'IDAT') idat.push(body);
  chunks.push(type);
  if (type === 'IEND') break;
  p += 12 + len;
}
console.log('chunks:', chunks.join(','));
console.log('IHDR:', JSON.stringify(ihdr));
const raw = zlib.inflateSync(Buffer.concat(idat));
const { w: W, h: H, depth, color } = ihdr;
const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color] * (depth / 8);
const stride = W * bpp;
console.log(`bpp=${bpp} stride=${stride} rawLen=${raw.length} expected=${H * (stride + 1)}`);
const out = Buffer.alloc(H * stride);
let prev = Buffer.alloc(stride);
for (let y = 0; y < H; y++) {
  const ft = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const cur = Buffer.alloc(stride);
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    let v = line[i];
    if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
    else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
    cur[i] = v & 255;
  }
  cur.copy(out, y * stride); prev = cur;
}
// Compare with sharp
const sharp = (await import('sharp')).default;
const { data: sd } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let diff = 0, firstDiff = null;
for (let i = 0; i < W * H * 4; i++) if (sd[i] !== out[i]) { diff++; if (!firstDiff) firstDiff = i; }
console.log(`pixel bytes compared=${W * H * 4} mismatches=${diff}${firstDiff ? ` firstAt=${firstDiff}` : ''}`);
console.log('=> independent decoder ' + (diff === 0 ? 'AGREES with sharp' : 'DISAGREES'));
// alpha histogram from independent decoder
const h = new Array(9).fill(0);
for (let i = 0; i < W * H; i++) h[out[i * 4 + 3] >> 5]++;
console.log('alpha hist (32-buckets) from independent decode:', h.join(','));
// probe ahoge region rows
console.log('\n=== independent decode: probes ===');
for (const [x, y] of [[245, 45], [232, 60], [240, 70], [250, 90], [245, 120], [250, 200], [190, 340], [250, 385], [210, 440], [245, 520], [250, 750], [2, 2]]) {
  const i = (y * W + x) * 4;
  console.log(`  (${x},${y}) rgba(${out[i]},${out[i + 1]},${out[i + 2]},${out[i + 3]})`);
}

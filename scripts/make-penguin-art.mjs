#!/usr/bin/env node
/**
 * make-penguin-art.mjs
 * ---------------------------------------------------------------------------
 * Generates the artwork for "Pip", an ORIGINAL chibi penguin mascot drawn as a
 * three-view anime-style character sheet (front / side / back).
 *
 * Everything is built as SVG strings in "character units": the character's
 * silhouette spans y = 0 (top of the head tuft) to y = 1 (bottom of the feet),
 * and x = 0 is its centre line. A single `translate(...) scale(H)` on the view
 * group turns those units into pixels, so the three views are guaranteed to be
 * built from the very same construction - same head ellipse, same body path,
 * same palette, same outline weight - and only the features differ.
 *
 * Originality: this is a generic round chibi penguin of my own construction
 * (ellipse head + bezier egg body + teardrop flippers). It is not traced from,
 * nor a copy of, any existing mascot, brand character or meme character.
 *
 * Outputs (run: `node scripts/make-penguin-art.mjs`):
 *   resources/characters/penguin/source.png    three-view sheet, white paper
 *   resources/characters/penguin/preview.png   2x downscaled copy (600 tall)
 * plus scratch renders under scratch/ used while iterating (front view, the
 * same view at mascot display size, and the sheet itself).
 *
 * Matte contract (matches scripts/build-character.mjs):
 *   - the paper is pure #ffffff (border min channel 255, saturation 0);
 *   - every pale fill stays inside a dark outline, so a border flood fill at
 *     PAPER_MIN = 250 finds exactly three unflooded blobs - one per view.
 * The script measures and prints all of that on every run.
 * ---------------------------------------------------------------------------
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'characters', 'penguin')
const SCRATCH_DIR = join(ROOT, 'scratch')

// ---------------------------------------------------------------- sheet setup
const SHEET = { w: 1320, h: 1200 }
const CHAR_H = 610 // pixels from the top of the tuft to the sole of the feet
const MIN_MARGIN = 30 // sheet requirement: nothing within 30px of an edge
const MIN_GAP = 40 // sheet requirement: at least 40px of white between views
const LAYOUT_MARGIN = 34 // what the layout solver aims for (>= MIN_MARGIN)

// ------------------------------------------------------------------- palette
// Five colour families, flat fills (no gradients):
//   ink / charcoal  - outline + body
//   cream           - belly + face patch
//   orange          - beak + feet
//   mint            - scarf accent
//   blush           - cheeks
const C = {
  paper: '#ffffff',
  ink: '#12161f', // outline (deliberately darker than the body so it reads)
  body: '#232a36', // near-black head / back
  bodyHi: '#2f3949', // flat rim-light on the charcoal
  cream: '#f9f4ea', // belly + face (kept below 250/250/250 on purpose)
  creamShade: '#ece3d2',
  orange: '#f5a623',
  orangeDeep: '#d9821a',
  mint: '#5ab7a8',
  mintDeep: '#3f9a8c',
  blush: '#f5ab92',
  eye: '#151a24',
  eyeGlow: '#41536b',
}
const OL = 0.0115 // outline half-width in character units (~14px at H=610)

const n = (v) => Number(v.toFixed(4))
const ell = (cx, cy, rx, ry, fill, extra = '') =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${extra ? ' ' + extra : ''}/>`
const circ = (cx, cy, r, fill, extra = '') =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${extra ? ' ' + extra : ''}/>`
const path = (d, fill, extra = '') => `<path d="${d}" fill="${fill}"${extra ? ' ' + extra : ''}/>`

/** Draw shapes as a single inked silhouette: fat ink stroke underneath, flat
 *  fill on top. Gives one clean outer outline and hides internal seams. */
function part(shapes, fill) {
  const ink = `<g fill="${C.ink}" stroke="${C.ink}" stroke-width="${n(OL * 2)}" stroke-linejoin="round" stroke-linecap="round">${shapes.join('')}</g>`
  return ink + `<g fill="${fill}">${shapes.join('')}</g>`
}

// -------------------------------------------------------------------- pieces
// Shared construction. Every view uses these exact numbers.

const HEAD = { cx: 0, cy: 0.295, rx: 0.25, ry: 0.245 } // 0.05 .. 0.54  (49% of H)

const BODY_D =
  'M -0.150 0.470 C -0.185 0.545 -0.196 0.650 -0.188 0.730 ' +
  'C -0.180 0.840 -0.108 0.930 0 0.930 ' +
  'C 0.108 0.930 0.180 0.840 0.188 0.730 ' +
  'C 0.196 0.650 0.185 0.545 0.150 0.470 Z'

// Big friendly eye: tall oval, big specular highlight up-inner, small one low.
const EYE = { dx: 0.107, cy: 0.320, rx: 0.053, ry: 0.070 }

/** One eye at horizontal offset `dx` (signed), `id` must be unique per view. */
function eye(dx, id, { rx = EYE.rx, ry = EYE.ry, cy = EYE.cy } = {}) {
  const cx = dx
  const clip = `${id}-clip`
  return (
    `<clipPath id="${clip}">${ell(cx, cy, rx, ry, '#000')}</clipPath>` +
    ell(cx, cy, rx, ry, C.eye) +
    `<g clip-path="url(#${clip})">` +
    ell(cx, cy + ry * 0.34, rx * 0.92, ry * 0.62, C.eyeGlow, 'opacity="0.55"') +
    `</g>` +
    circ(cx - rx * 0.36, cy - ry * 0.36, rx * 0.44, '#ffffff') +
    circ(cx + rx * 0.34, cy + ry * 0.42, rx * 0.21, '#ffffff', 'opacity="0.92"')
  )
}

/** Rounded triangular beak pointing down (front view). */
const beakFront = () =>
  part(
    [
      path(
        'M -0.050 0.350 C -0.032 0.334 0.032 0.334 0.050 0.350 ' +
          'C 0.043 0.390 0.026 0.422 0 0.436 ' +
          'C -0.026 0.422 -0.043 0.390 -0.050 0.350 Z',
        C.orange,
      ),
      path(
        'M -0.030 0.366 C -0.013 0.375 0.013 0.375 0.030 0.366',
        'none',
        `stroke="${C.orangeDeep}" stroke-width="0.007" stroke-linecap="round"`,
      ),
    ],
    C.orange,
  )

/** Webbed foot: a soft wedge with two toe creases. The local origin is the
 *  ankle and local +y points at the toes, so `rot` decides where they point. */
function foot(x, y, { scale = 1, rot = 0, toes = true, fill = C.orange, crease = C.orangeDeep } = {}) {
  const wedge =
    'M 0 -0.048 C -0.056 -0.032 -0.080 0.012 -0.078 0.044 ' +
    'C -0.076 0.062 -0.060 0.070 -0.040 0.066 ' +
    'L 0.040 0.066 C 0.060 0.070 0.076 0.062 0.078 0.044 ' +
    'C 0.080 0.012 0.056 -0.032 0 -0.048 Z'
  const creases = toes
    ? path('M -0.031 0.006 L -0.037 0.050', 'none', `stroke="${crease}" stroke-width="0.0065" stroke-linecap="round"`) +
      path('M 0.031 0.006 L 0.037 0.050', 'none', `stroke="${crease}" stroke-width="0.0065" stroke-linecap="round"`)
    : ''
  return (
    `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(rot)}) scale(${n(scale)})">` +
    part([path(wedge, fill)], fill) +
    creases +
    `</g>`
  )
}

/** Foot seen from the side: flat sole, toes forward, drawn straight into the
 *  side view's coordinates so its heel always tucks under the belly. */
function sideFoot({ dx = 0, dy = 0, scale = 1, fill = C.orange } = {}) {
  const d =
    'M 0.012 0.886 C 0.072 0.902 0.140 0.928 0.184 0.950 ' +
    'C 0.204 0.960 0.210 0.974 0.196 0.984 ' +
    'C 0.168 0.998 0.118 1.002 0.078 0.996 ' +
    'C 0.038 0.990 0.010 0.966 0.002 0.932 ' +
    'C -0.002 0.912 0.000 0.896 0.012 0.886 Z'
  const creases =
    path('M 0.144 0.944 L 0.140 0.994', 'none', `stroke="${C.orangeDeep}" stroke-width="0.0065" stroke-linecap="round"`) +
    path('M 0.172 0.956 L 0.168 0.998', 'none', `stroke="${C.orangeDeep}" stroke-width="0.0065" stroke-linecap="round"`)
  return `<g transform="translate(${n(dx)} ${n(dy)}) scale(${n(scale)})">${part([path(d, fill)], fill)}${creases}</g>`
}

/** Tiny flipper held a little away from the body. `s` = -1 left, +1 right. */
function flipper(s) {
  const d =
    'M -0.112 0.545 C -0.170 0.592 -0.216 0.648 -0.244 0.696 ' +
    'C -0.264 0.740 -0.312 0.736 -0.316 0.694 ' +
    'C -0.310 0.634 -0.256 0.564 -0.152 0.504 ' +
    'C -0.126 0.510 -0.108 0.526 -0.112 0.545 Z'
  return `<g transform="scale(${s} 1)">${part([path(d, C.body)], C.body)}</g>`
}

/** Head tuft: three soft overlapping lobes, leaning to the left on screen. */
function tuft(s = 1) {
  const shapes = [
    ell(-0.070, 0.064, 0.036, 0.054, C.body, 'transform="rotate(-30 -0.070 0.064)"'),
    ell(-0.028, 0.052, 0.029, 0.050, C.body, 'transform="rotate(-14 -0.028 0.052)"'),
    ell(0.012, 0.044, 0.021, 0.040, C.body, 'transform="rotate(2 0.012 0.044)"'),
  ]
  return `<g transform="scale(${s} 1)">${part(shapes, C.body)}</g>`
}

/** Flat rim-light clipped inside the head/body silhouette (very subtle). */
function rimLight(id, shapes) {
  const clip = `${id}-rim`
  return (
    `<clipPath id="${clip}">${shapes.join('')}</clipPath>` +
    `<g clip-path="url(#${clip})">` +
    ell(-0.085, 0.205, 0.20, 0.135, C.bodyHi, 'opacity="0.5" transform="rotate(-24 -0.085 0.205)"') +
    ell(-0.10, 0.70, 0.10, 0.16, C.bodyHi, 'opacity="0.35" transform="rotate(18 -0.10 0.70)"') +
    `</g>`
  )
}

const headEll = () => ell(HEAD.cx, HEAD.cy, HEAD.rx, HEAD.ry, C.body)

// --------------------------------------------------------------- FRONT VIEW
function frontLayers(id) {
  const faceD =
    'M 0 0.186 C 0.085 0.193 0.163 0.250 0.186 0.325 ' +
    'C 0.198 0.378 0.190 0.422 0.168 0.454 ' +
    'C 0.138 0.494 0.090 0.522 0 0.524 ' +
    'C -0.090 0.522 -0.138 0.494 -0.168 0.454 ' +
    'C -0.190 0.422 -0.198 0.378 -0.186 0.325 ' +
    'C -0.163 0.250 -0.085 0.193 0 0.186 Z'
  const bellyD =
    'M 0 0.500 C 0.098 0.510 0.146 0.598 0.146 0.706 ' +
    'C 0.146 0.828 0.084 0.898 0 0.898 ' +
    'C -0.084 0.898 -0.146 0.828 -0.146 0.706 ' +
    'C -0.146 0.598 -0.098 0.510 0 0.500 Z'
  const scarfD =
    'M -0.164 0.466 C -0.092 0.444 0.092 0.444 0.164 0.466 ' +
    'C 0.174 0.500 0.172 0.534 0.162 0.564 ' +
    'C 0.082 0.590 -0.082 0.590 -0.162 0.564 ' +
    'C -0.172 0.534 -0.174 0.500 -0.164 0.466 Z'
  // the loose end hangs on the character's right (= screen left in a front view)
  const tailD =
    'M -0.142 0.514 C -0.168 0.594 -0.180 0.672 -0.176 0.740 ' +
    'L -0.134 0.708 L -0.094 0.746 ' +
    'C -0.086 0.674 -0.072 0.598 -0.054 0.516 ' +
    'C -0.088 0.526 -0.114 0.521 -0.142 0.514 Z'

  return [
    part([headEll(), path(BODY_D, C.body)], C.body),
    rimLight(id, [headEll(), path(BODY_D, C.body)]),
    tuft(1),
    path(faceD, C.cream),
    path(bellyD, C.cream),
    // cheeks
    ell(-0.140, 0.398, 0.040, 0.027, C.blush, 'opacity="0.75"'),
    ell(0.140, 0.398, 0.040, 0.027, C.blush, 'opacity="0.75"'),
    eye(-EYE.dx, `${id}-L`),
    eye(EYE.dx, `${id}-R`),
    beakFront(),
    foot(-0.105, 0.932, { rot: 7 }),
    foot(0.105, 0.932, { rot: -7 }),
    flipper(-1),
    flipper(1),
    part([path(scarfD, C.mint), path(tailD, C.mint)], C.mint),
    `<g opacity="0.5">${path(
      'M -0.120 0.486 C -0.068 0.472 0.068 0.472 0.120 0.486',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round"`,
    )}</g>`,
    path(
      'M -0.150 0.596 C -0.132 0.606 -0.108 0.610 -0.082 0.606',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.010" stroke-linecap="round" opacity="0.8"`,
    ),
    path(
      'M -0.146 0.644 C -0.146 0.670 -0.150 0.694 -0.158 0.712',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round" opacity="0.7"`,
    ),
  ].join('')
}

// ---------------------------------------------------------------- SIDE VIEW
function sideLayers(id) {
  // Same head, same body; the pale belly wraps around the front (+x).
  const faceD =
    'M -0.010 0.312 C 0.028 0.216 0.084 0.185 0.134 0.186 ' +
    'C 0.180 0.190 0.212 0.236 0.222 0.320 ' +
    'C 0.228 0.394 0.182 0.452 0.126 0.482 ' +
    'C 0.068 0.512 0.004 0.516 -0.012 0.472 ' +
    'C -0.026 0.428 -0.026 0.372 -0.010 0.312 Z'
  const bellyD =
    'M 0.100 0.520 C 0.160 0.590 0.176 0.676 0.162 0.748 ' +
    'C 0.146 0.828 0.092 0.888 0.016 0.904 ' +
    'C -0.030 0.912 -0.050 0.884 -0.034 0.850 ' +
    'C 0.006 0.772 0.026 0.646 0.050 0.532 Z'
  // short, blunt beak pointing right - the way the character faces
  const beakD =
    'M 0.176 0.334 C 0.244 0.332 0.288 0.350 0.308 0.370 ' +
    'C 0.316 0.378 0.316 0.386 0.306 0.392 ' +
    'C 0.286 0.412 0.242 0.428 0.180 0.424 Z'
  const scarfD =
    'M -0.158 0.466 C -0.078 0.444 0.078 0.444 0.158 0.466 ' +
    'C 0.168 0.500 0.166 0.534 0.156 0.564 ' +
    'C 0.078 0.590 -0.078 0.590 -0.156 0.564 ' +
    'C -0.166 0.534 -0.168 0.500 -0.158 0.466 Z'
  const tailD =
    'M 0.026 0.514 C 0.052 0.592 0.066 0.676 0.062 0.744 ' +
    'L 0.104 0.712 L 0.144 0.750 ' +
    'C 0.146 0.678 0.146 0.596 0.152 0.516 ' +
    'C 0.112 0.526 0.058 0.521 0.026 0.514 Z'
  // near flipper lies along the flank instead of sticking out backwards
  const flipD =
    'M 0.063 0.575 C 0.018 0.632 -0.090 0.694 -0.162 0.740 ' +
    'C -0.190 0.764 -0.228 0.746 -0.220 0.704 ' +
    'C -0.198 0.666 -0.082 0.596 0.017 0.515 ' +
    'C 0.038 0.518 0.058 0.545 0.063 0.575 Z'

  return [
    part([headEll(), path(BODY_D, C.body)], C.body),
    rimLight(id, [headEll(), path(BODY_D, C.body)]),
    tuft(1),
    path(faceD, C.cream),
    path(bellyD, C.cream),
    circ(0.142, 0.398, 0.033, C.blush, 'opacity="0.72"'),
    sideFoot({ dx: -0.055, dy: 0.07, scale: 0.93, fill: C.orangeDeep }), // far foot
    part([path(beakD, C.orange)], C.orange),
    path(
      'M 0.200 0.374 C 0.246 0.372 0.282 0.376 0.302 0.378',
      'none',
      `stroke="${C.orangeDeep}" stroke-width="0.007" stroke-linecap="round"`,
    ),
    eye(0.122, `${id}-L`, { rx: 0.043, ry: 0.068, cy: 0.318 }),
    sideFoot({}),
    part([path(flipD, C.body)], C.body),
    part([path(scarfD, C.mint), path(tailD, C.mint)], C.mint),
    `<g opacity="0.5">${path(
      'M -0.108 0.486 C -0.060 0.472 0.060 0.472 0.108 0.486',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round"`,
    )}</g>`,
    path(
      'M 0.052 0.596 C 0.072 0.606 0.096 0.610 0.120 0.606',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.010" stroke-linecap="round" opacity="0.8"`,
    ),
    path(
      'M 0.098 0.644 C 0.098 0.670 0.094 0.692 0.086 0.710',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round" opacity="0.7"`,
    ),
  ].join('')
}

// ---------------------------------------------------------------- BACK VIEW
function backLayers(id) {
  const scarfD =
    'M -0.162 0.470 C -0.086 0.448 0.086 0.448 0.162 0.470 ' +
    'C 0.172 0.504 0.170 0.536 0.160 0.566 ' +
    'C 0.082 0.592 -0.082 0.592 -0.160 0.566 ' +
    'C -0.170 0.536 -0.172 0.504 -0.162 0.470 Z'
  // from behind, the loose end shows on the character's right = screen right
  const tailD =
    'M 0.124 0.512 C 0.156 0.592 0.168 0.674 0.164 0.742 ' +
    'L 0.122 0.710 L 0.080 0.748 ' +
    'C 0.072 0.676 0.060 0.596 0.042 0.514 ' +
    'C 0.076 0.524 0.098 0.519 0.124 0.512 Z'

  return [
    part([headEll(), path(BODY_D, C.body)], C.body),
    rimLight(id, [headEll(), path(BODY_D, C.body)]),
    tuft(-1), // mirrored: the tuft leans to the character's right in 3D
    foot(-0.105, 0.930, { toes: false, scale: 0.94 }),
    foot(0.105, 0.930, { toes: false, scale: 0.94 }),
    flipper(-1),
    flipper(1),
    part([path(scarfD, C.mint), path(tailD, C.mint)], C.mint),
    `<g opacity="0.5">${path(
      'M -0.118 0.490 C -0.066 0.476 0.066 0.476 0.118 0.490',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round"`,
    )}</g>`,
    path(
      'M 0.152 0.642 C 0.152 0.668 0.148 0.690 0.140 0.708',
      'none',
      `stroke="${C.mintDeep}" stroke-width="0.009" stroke-linecap="round" opacity="0.7"`,
    ),
  ].join('')
}

const VIEWS = [
  { id: 'front', label: 'front', build: frontLayers },
  { id: 'side', label: 'side', build: sideLayers },
  { id: 'back', label: 'back', build: backLayers },
]

/** Wrap one view's layers in its character-unit -> pixel transform. */
const viewGroup = (v, tx, ty, h) =>
  `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(h)})">${v.build(v.id)}</g>`

// ------------------------------------------------------- measurement helpers
const ORIGIN_X = 700 // unit origin used for the measuring renders
const ORIGIN_Y = 120
const MEASURE = { w: 1400, h: 1200, h_unit: 700 }

async function inkBox(svg) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels
      // "ink" = anything that is not pure paper
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, maxX, minY, maxY, info }
}

async function measureViews() {
  const out = {}
  for (const v of VIEWS) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MEASURE.w}" height="${MEASURE.h}">` +
      `<rect width="100%" height="100%" fill="${C.paper}"/>` +
      viewGroup(v, ORIGIN_X, ORIGIN_Y, MEASURE.h_unit) +
      `</svg>`
    const box = await inkBox(svg)
    out[v.id] = {
      // convert to character units
      uMin: (box.minX - ORIGIN_X) / MEASURE.h_unit,
      uMax: (box.maxX - ORIGIN_X) / MEASURE.h_unit,
      uTop: (box.minY - ORIGIN_Y) / MEASURE.h_unit,
      uBottom: (box.maxY - ORIGIN_Y) / MEASURE.h_unit,
    }
  }
  return out
}

// ------------------------------------------------------------------ assembly
/** Lay the three views out with equal outer margins and equal gaps: the sheet
 *  is wide enough that both stay above the required minimums. */
function solveLayout(boxes) {
  const widths = VIEWS.map((v) => (boxes[v.id].uMax - boxes[v.id].uMin) * CHAR_H)
  const sum = widths.reduce((a, b) => a + b, 0)
  const gap = (SHEET.w - sum - 2 * LAYOUT_MARGIN) / 2
  if (gap < MIN_GAP) throw new Error(`views do not fit: gap would be ${gap.toFixed(1)}px`)
  const centers = []
  let x = LAYOUT_MARGIN
  VIEWS.forEach((v, i) => {
    centers.push(x + widths[i] / 2)
    x += widths[i] + gap
  })
  return { widths, gap, centers, margin: LAYOUT_MARGIN }
}

function sheetSvg(offsets, layout) {
  const top = (SHEET.h - CHAR_H) / 2 // vertically centred on the same baseline
  const groups = VIEWS.map((v, i) => viewGroup(v, layout.centers[i] + offsets[v.id], top, CHAR_H))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}" height="${SHEET.h}" viewBox="0 0 ${SHEET.w} ${SHEET.h}">` +
    `<rect width="${SHEET.w}" height="${SHEET.h}" fill="${C.paper}"/>` +
    groups.join('') +
    `</svg>`
  )
}

function singleSvg(v, { h = 760, pad = 60 } = {}) {
  const w = Math.round(h * 0.95)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + pad * 2}" viewBox="0 0 ${w} ${h + pad * 2}">` +
    `<rect width="100%" height="100%" fill="${C.paper}"/>` +
    viewGroup(v, w / 2, pad, h) +
    `</svg>`
  )
}

// ----------------------------------------------------------------- landmarks
/** Extreme point of a path made only of M/C segments (used for the flipper). */
function cubicExtreme(segments) {
  let best = null
  for (const seg of segments) {
    for (let i = 0; i <= 60; i++) {
      const t = i / 60
      const mt = 1 - t
      const x = mt * mt * mt * seg[0] + 3 * mt * mt * t * seg[2] + 3 * mt * t * t * seg[4] + t * t * t * seg[6]
      const y = mt * mt * mt * seg[1] + 3 * mt * mt * t * seg[3] + 3 * mt * t * t * seg[5] + t * t * t * seg[7]
      if (!best || x < best.x) best = { x, y }
    }
  }
  return best
}

const FLIPPER_SEGS = [
  [-0.112, 0.545, -0.170, 0.592, -0.216, 0.648, -0.244, 0.696],
  [-0.244, 0.696, -0.264, 0.740, -0.312, 0.736, -0.316, 0.694],
  [-0.316, 0.694, -0.310, 0.634, -0.256, 0.564, -0.152, 0.504],
  [-0.152, 0.504, -0.126, 0.510, -0.108, 0.526, -0.112, 0.545],
]

/** Front-view landmarks in character units, then normalised to the front
 *  view's own silhouette box (0..1, y down) - ready for a motion rig. */
function frontLandmarks(box) {
  const tip = cubicExtreme(FLIPPER_SEGS)
  const footLocal = { x0: -0.080, x1: 0.080, y0: -0.048, y1: 0.066 }
  const rot = (-7 * Math.PI) / 180 // viewer's right foot
  const corners = []
  for (const lx of [footLocal.x0, footLocal.x1])
    for (const ly of [footLocal.y0, footLocal.y1])
      corners.push({
        x: 0.105 + lx * Math.cos(rot) - ly * Math.sin(rot),
        y: 0.932 + lx * Math.sin(rot) + ly * Math.cos(rot),
      })
  const footR = {
    x0: Math.min(...corners.map((c) => c.x)),
    x1: Math.max(...corners.map((c) => c.x)),
    y0: Math.min(...corners.map((c) => c.y)),
    y1: Math.max(...corners.map((c) => c.y)),
  }
  const raw = {
    headTop: { x: 0, y: HEAD.cy - HEAD.ry },
    tuftTop: { x: -0.01, y: 0.004 },
    headBottom: { x: 0, y: HEAD.cy + HEAD.ry },
    eyeL: { x: -EYE.dx, y: EYE.cy, rx: EYE.rx, ry: EYE.ry },
    eyeR: { x: EYE.dx, y: EYE.cy, rx: EYE.rx, ry: EYE.ry },
    beakTop: { x: 0, y: 0.350 },
    beakTip: { x: 0, y: 0.436 },
    beakCentre: { x: 0, y: 0.393 },
    wingTipL: tip,
    wingTipR: { x: -tip.x, y: tip.y },
    wingRootL: { x: -0.112, y: 0.545 },
    wingRootR: { x: 0.112, y: 0.545 },
    footL: { x0: -footR.x1, x1: -footR.x0, y0: footR.y0, y1: footR.y1 },
    footR,
    scarfTop: { x: 0, y: 0.452 },
    scarfBottom: { x: 0, y: 0.590 },
  }
  const nx = (x) => (x - box.uMin) / (box.uMax - box.uMin)
  const ny = (y) => (y - box.uTop) / (box.uBottom - box.uTop)
  const nrm = (p) => {
    const o = { x: +nx(p.x).toFixed(4), y: +ny(p.y).toFixed(4) }
    if (p.rx !== undefined) {
      o.rx = +((p.rx * 2) / (box.uMax - box.uMin)).toFixed(4)
      o.ry = +((p.ry * 2) / (box.uBottom - box.uTop)).toFixed(4)
    }
    if (p.x0 !== undefined) {
      o.x0 = +nx(p.x0).toFixed(4)
      o.x1 = +nx(p.x1).toFixed(4)
      o.y0 = +ny(p.y0).toFixed(4)
      o.y1 = +ny(p.y1).toFixed(4)
    }
    return o
  }
  const out = {}
  for (const [k, v] of Object.entries(raw)) out[k] = nrm(v)
  return { box, landmarks: out }
}

// -------------------------------------------------------------------- checks
/** Flood fill paper from the border exactly like scripts/build-character.mjs,
 *  then report how many separate "character" blobs remain. */
function floodReport(data, w, h, ch) {
  const PAPER = 250
  const seen = new Uint8Array(w * h)
  const stack = []
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (seen[p]) return
    const i = p * ch
    if (data[i] < PAPER || data[i + 1] < PAPER || data[i + 2] < PAPER) return
    seen[p] = 1
    stack.push(p)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  let flooded = 0
  while (stack.length) {
    const p = stack.pop()
    flooded++
    const x = p % w
    const y = (p - x) / w
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  // connected components of everything the fill could not reach
  const comp = new Int32Array(w * h).fill(-1)
  const comps = []
  for (let p = 0; p < w * h; p++) {
    if (seen[p] || comp[p] >= 0) continue
    const id = comps.length
    const q = [p]
    comp[p] = id
    let size = 0
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    while (q.length) {
      const c = q.pop()
      size++
      const x = c % w
      const y = (c - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const nb = [c + 1, c - 1, c + w, c - w]
      for (const nb2 of nb) {
        if (nb2 < 0 || nb2 >= w * h) continue
        if (seen[nb2] || comp[nb2] >= 0) continue
        const nx = nb2 % w
        if (Math.abs(nx - x) > 1) continue
        comp[nb2] = id
        q.push(nb2)
      }
    }
    comps.push({ size, x0, x1, y0, y1 })
  }
  comps.sort((a, b) => b.size - a.size)
  return { flooded, comps }
}

async function verifySheet(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info
  // background statistics on the four border strips
  const strip = 8
  let minC = 255
  let maxSat = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onBorder = x < strip || y < strip || x >= w - strip || y >= h - strip
      if (!onBorder) continue
      const i = (y * w + x) * ch
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      minC = Math.min(minC, r, g, b)
      maxSat = Math.max(maxSat, Math.max(r, g, b) - Math.min(r, g, b))
    }
  }
  // ink bbox overall, and the panels discovered as runs of inked columns
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const colInk = []
  for (let x = 0; x < w; x++) {
    let hit = false
    for (let y = 0; y < h && !hit; y++) {
      const i = (y * w + x) * ch
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) hit = true
    }
    colInk.push(hit)
    if (!hit) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        break
      }
    }
  }
  const panels = []
  let run = null
  for (let x = 0; x <= w; x++) {
    if (x < w && colInk[x]) {
      if (!run) run = { x0: x, x1: x, y0: Infinity, y1: -Infinity }
      else run.x1 = x
    } else if (run) {
      for (let xx = run.x0; xx <= run.x1; xx++) {
        for (let y = 0; y < h; y++) {
          const i = (y * w + xx) * ch
          if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
            if (y < run.y0) run.y0 = y
            if (y > run.y1) run.y1 = y
          }
        }
      }
      panels.push(run)
      run = null
    }
  }
  const { flooded, comps } = floodReport(data, w, h, ch)
  return { w, h, minC, maxSat, minX, maxX, minY, maxY, panels, flooded, comps, data, ch }
}

// ---------------------------------------------------------------------- main
async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(SCRATCH_DIR, { recursive: true })

  // 1. measure each view so the panels can be laid out from real silhouettes
  const boxes = await measureViews()
  const offsets = {}
  for (const v of VIEWS) {
    const b = boxes[v.id]
    offsets[v.id] = -(((b.uMin + b.uMax) / 2) * CHAR_H)
    console.log(
      `[view] ${v.id.padEnd(5)} ${((b.uMax - b.uMin) * CHAR_H).toFixed(0)}x${(
        (b.uBottom - b.uTop) * CHAR_H
      ).toFixed(0)}px  u[${b.uMin.toFixed(3)} .. ${b.uMax.toFixed(3)}]`,
    )
  }
  const layout = solveLayout(boxes)
  console.log(`[layout] margin ${layout.margin}px  gap ${layout.gap.toFixed(1)}px  h ${CHAR_H}px`)

  // 2. the sheet
  const svg = sheetSvg(offsets, layout)
  await writeFile(join(SCRATCH_DIR, 'sheet.svg'), svg)
  const sheet = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
  await writeFile(join(OUT_DIR, 'source.png'), sheet)

  // 3. preview: 2x downscale
  await sharp(sheet)
    .resize({ width: Math.round(SHEET.w / 2), kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(join(OUT_DIR, 'preview.png'))

  // 4. iteration renders
  for (const v of VIEWS) {
    const one = await sharp(Buffer.from(singleSvg(v))).png().toBuffer()
    await writeFile(join(SCRATCH_DIR, `${v.id}.png`), one)
  }
  // the front view at real mascot size (~124 css px wide silhouette), 4x nearest
  const frontBox = boxes.front
  const silW = (frontBox.uMax - frontBox.uMin) * CHAR_H
  const tinyH = Math.round((124 / silW) * CHAR_H)
  const tiny = await sharp(Buffer.from(singleSvg(VIEWS[0], { h: tinyH, pad: 10 })))
    .resize({ width: 620, kernel: 'nearest' })
    .png()
    .toBuffer()
  await writeFile(join(SCRATCH_DIR, 'front-at-124px.png'), tiny)

  // 5. verify the sheet we just wrote
  const v = await verifySheet(sheet)
  const px = (o) => `${o.x0},${o.y0} .. ${o.x1},${o.y1}`
  console.log(`[sheet] ${v.w}x${v.h}`)
  console.log(`[paper] border min channel ${v.minC} (need >= ${250}), max saturation ${v.maxSat}`)
  console.log(`[ink]   overall bbox ${v.minX},${v.minY} .. ${v.maxX},${v.maxY}`)
  console.log(
    `[ink]   margins  left ${v.minX} right ${v.w - 1 - v.maxX} top ${v.minY} bottom ${v.h - 1 - v.maxY}` +
      `   (need >= ${MIN_MARGIN})`,
  )
  v.panels.forEach((p, i) => console.log(`[panel] ${VIEWS[i].id.padEnd(5)} ${px(p)}`))
  const gaps = [v.panels[1].x0 - v.panels[0].x1, v.panels[2].x0 - v.panels[1].x1]
  console.log(`[gap]   front->side ${gaps[0]}px  side->back ${gaps[1]}px   (need >= ${MIN_GAP})`)
  console.log(
    `[flood] paper reachable ${((v.flooded / (v.w * v.h)) * 100).toFixed(1)}%  unflooded blobs ` +
      `${v.comps.length} (expect 3 = one per view)`,
  )
  v.comps.slice(0, 6).forEach((c, i) => {
    console.log(
      `[blob${i}]  ${String(c.size).padStart(7)} px  bbox ${c.x0},${c.y0} .. ${c.x1},${c.y1}`,
    )
  })
  const frontH = v.panels[0].y1 - v.panels[0].y0 + 1
  console.log(`[front] height ${frontH}px = ${((frontH / v.h) * 100).toFixed(1)}% of sheet height`)

  // 6. front-view landmarks for the rig generator
  const { landmarks } = frontLandmarks(boxes.front)
  console.log('[landmarks] front view, normalised to the front silhouette box (0..1, y down):')
  for (const [k, p] of Object.entries(landmarks)) {
    const body =
      p.x0 !== undefined
        ? `box x ${p.x0}..${p.x1}  y ${p.y0}..${p.y1}`
        : `(${p.x}, ${p.y})` + (p.rx ? `  size ${p.rx}x${p.ry}` : '')
    console.log(`  ${k.padEnd(12)} ${body}`)
  }
  // exact pixel positions in source.png, derived from the measured ink box
  const lm = landmarks
  const frontTop = (SHEET.h - CHAR_H) / 2
  const inkLeft = layout.centers[0] + offsets.front + boxes.front.uMin * CHAR_H
  const inkTop = frontTop + boxes.front.uTop * CHAR_H
  const bw = (boxes.front.uMax - boxes.front.uMin) * CHAR_H
  const bh = (boxes.front.uBottom - boxes.front.uTop) * CHAR_H
  const pxf = (p) => `(${Math.round(inkLeft + p.x * bw)}, ${Math.round(inkTop + p.y * bh)})`
  console.log(
    `[landmarks] front view ink box in source.png: x ${inkLeft.toFixed(1)}..${(inkLeft + bw).toFixed(1)}` +
      ` y ${inkTop.toFixed(1)}..${(inkTop + bh).toFixed(1)}`,
  )
  console.log(
    `[landmarks] px in source.png: eyeL ${pxf(lm.eyeL)} eyeR ${pxf(lm.eyeR)} beakTip ${pxf(lm.beakTip)}` +
      ` headTop ${pxf(lm.headTop)} wingTipL ${pxf(lm.wingTipL)}`,
  )
  return v
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

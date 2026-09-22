/**
 * Automatic rig derivation.
 *
 * `puppet.json` for the built-in character was placed by hand, by rendering a
 * debug overlay and nudging ellipses until they sat on the artwork. That does
 * not scale to "let a user drop in their own three-view sheet", so this module
 * derives the same rig from the sprite itself:
 *
 *   eyes      dark blobs in the head band, paired about the vertical centre
 *   beak/mouth a warm-coloured (or dark) blob below the eyes, near the centre
 *   crest     whatever sticks up above the widest part of the head
 *   head      the band from the top of the character down to just under the eyes
 *   torso     the middle band, for breathing
 *   wings     the extreme left/right lobes at torso height
 *   feet      the bottom band
 *
 * Everything it produces is a starting point, not a verdict: the CLI writes the
 * rig next to the sprite and the debug overlay shows exactly where it landed.
 * A `rig.overrides.json` beside a character replaces any influence by name.
 *
 * Detection that fails falls back to proportions borrowed from the built-in
 * character rather than throwing, and says so in `confidence`.
 */

const TAU = Math.PI * 2

/**
 * Blob detection uses an **adaptive** threshold: the darkest `INK_PERCENTILE`
 * of pixels inside the head band count as ink. A fixed luminance cut works for
 * one art style and fails the next — the first character's eyes are mid-blue
 * lashes over bright irises, which a fixed cut missed entirely.
 */
const INK_PERCENTILE = 0.12
/** Fixed fallback when the band is too flat for a percentile to mean anything. */
const INK_MAX = 120
/** A blob smaller than this fraction of the sprite is noise. */
const MIN_BLOB = 0.0004
/** A blob larger than this fraction is a body part, not a feature. */
const MAX_BLOB = 0.05

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function saturation(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

/** Tight bounding box of every pixel with meaningful alpha. */
function contentBounds(rgba, width, height) {
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < 24) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 }
  return { minX, minY, maxX, maxY }
}

/** 4-neighbour connected components over a predicate, with a size floor. */
function components(width, height, predicate, minArea) {
  const seen = new Uint8Array(width * height)
  const found = []
  const stack = new Int32Array(width * height)

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !predicate(start)) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    const pixels = []
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    while (top > 0) {
      const p = stack[--top]
      pixels.push(p)
      const x = p % width
      const y = (p - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const push = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
        const q = ny * width + nx
        if (seen[q] || !predicate(q)) return
        seen[q] = 1
        stack[top++] = q
      }
      push(x - 1, y)
      push(x + 1, y)
      push(x, y - 1)
      push(x, y + 1)
    }
    if (pixels.length >= minArea) {
      found.push({
        area: pixels.length,
        minX, maxX, minY, maxY,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
      })
    }
  }
  return found
}

/** Per-row horizontal extent, used to find the head/torso/feet bands. */
function rowExtents(rgba, width, height) {
  const rows = []
  for (let y = 0; y < height; y++) {
    let minX = width
    let maxX = -1
    let count = 0
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < 24) continue
      count++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    rows.push(maxX < 0 ? null : { minX, maxX, width: maxX - minX + 1, count })
  }
  return rows
}

function influence(name, cx, cy, rx, ry, motion, extra = {}) {
  return {
    name,
    cx: Number(cx.toFixed(4)),
    cy: Number(cy.toFixed(4)),
    rx: Number(rx.toFixed(4)),
    ry: Number(ry.toFixed(4)),
    motion,
    ...extra,
  }
}

/**
 * Derive a rig for one sprite.
 *
 * @param rgba - RGBA buffer of the sprite.
 * @param width - sprite width in pixels.
 * @param height - sprite height in pixels.
 * @returns `{ influences, landmarks, confidence, notes }` — the influences use
 *   the same normalised 0..1 space the renderer expects.
 */
export function deriveRig(rgba, width, height) {
  const bounds = contentBounds(rgba, width, height)
  const notes = []
  const landmarks = { confidence: {} }

  const rows = rowExtents(rgba, width, height)
  const maxRowWidth = Math.max(...rows.filter(Boolean).map((row) => row.width))
  const top = bounds.minY / height
  const bottom = bounds.maxY / height
  const charHeight = (bounds.maxY - bounds.minY + 1) / height
  const cx = (bounds.minX + bounds.maxX) / 2 / width
  const charWidth = (bounds.maxX - bounds.minX + 1) / width

  // ---- eyes: dark blobs, paired about the vertical centre -----------------
  const minArea = Math.max(12, Math.floor(width * height * MIN_BLOB))
  const maxArea = Math.floor(width * height * MAX_BLOB)
  // The eye search runs against an adaptive threshold measured inside the head
  // band only, so a pale character and a dark one are treated the same.
  const bandTop = Math.floor((top + charHeight * 0.08) * height)
  const bandBottom = Math.ceil((top + charHeight * 0.55) * height)
  const histogram = new Array(256).fill(0)
  let bandPixels = 0
  for (let y = bandTop; y < bandBottom; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (rgba[i + 3] < 200) continue
      histogram[Math.round(luminance(rgba[i], rgba[i + 1], rgba[i + 2]))]++
      bandPixels++
    }
  }
  let inkMax = INK_MAX
  if (bandPixels > 500) {
    let seen = 0
    for (let level = 0; level < 256; level++) {
      seen += histogram[level]
      if (seen >= bandPixels * INK_PERCENTILE) {
        inkMax = Math.min(INK_MAX, Math.max(60, level))
        break
      }
    }
  }

  const blobs = components(
    width,
    height,
    (p) => {
      const i = p * 4
      if (rgba[i + 3] < 200) return false
      return luminance(rgba[i], rgba[i + 1], rgba[i + 2]) < inkMax
    },
    minArea,
  ).filter((blob) => blob.area <= maxArea)

  const headBand = blobs.filter((blob) => {
    const v = blob.cy / height
    const u = blob.cx / width
    return v > top + charHeight * 0.08 && v < top + charHeight * 0.55
      && u > cx - charWidth * 0.45 && u < cx + charWidth * 0.45
  })

  let eyeLeft = null
  let eyeRight = null
  if (headBand.length >= 2) {
    const sorted = [...headBand].sort((a, b) => b.area - a.area)
    const left = sorted.filter((blob) => blob.cx < cx * width).sort((a, b) => b.area - a.area)[0]
    const right = sorted.filter((blob) => blob.cx > cx * width).sort((a, b) => b.area - a.area)[0]
    if (left && right) {
      const balance = Math.min(left.area, right.area) / Math.max(left.area, right.area)
      const level = Math.abs(left.cy - right.cy) / height
      if (balance > 0.28 && level < charHeight * 0.1) {
        eyeLeft = left
        eyeRight = right
        landmarks.confidence.eyes = balance > 0.55 ? 'high' : 'low'
      }
    }
  }

  const eyeY = eyeLeft && eyeRight
    ? (eyeLeft.cy + eyeRight.cy) / 2 / height
    : top + charHeight * 0.33
  const eyeSpan = eyeLeft && eyeRight
    ? Math.abs(eyeRight.cx - eyeLeft.cx) / width
    : charWidth * 0.42
  if (eyeLeft === null) notes.push('eye detection fell back to proportions — check the overlay')

  // ---- the head ends a little below the eye line --------------------------
  const headBottom = Math.min(bottom, eyeY + charHeight * 0.18)

  // ---- crest: content above the head's main mass ---------------------------
  const wideRow = rows.findIndex((row) => row !== null && row.width > maxRowWidth * 0.45)
  const crestTop = top
  const crestBottom = Math.max(top + charHeight * 0.02, (wideRow > 0 ? wideRow : bounds.minY) / height)
  const hasCrest = crestBottom - crestTop > charHeight * 0.015

  // ---- torso: the widest band below the head ------------------------------
  const torsoTop = headBottom + charHeight * 0.02
  const torsoBottom = Math.min(bottom, torsoTop + charHeight * 0.3)
  const torsoY = (torsoTop + torsoBottom) / 2

  // ---- wings: the extreme lobes at torso height ---------------------------
  const torsoRows = rows.slice(
    Math.floor(torsoTop * height),
    Math.max(Math.floor(torsoTop * height) + 1, Math.floor(torsoBottom * height)),
  ).filter(Boolean)
  const wingLeft = torsoRows.length ? Math.min(...torsoRows.map((row) => row.minX)) / width : cx - charWidth / 2
  const wingRight = torsoRows.length ? Math.max(...torsoRows.map((row) => row.maxX)) / width : cx + charWidth / 2

  // ---- influences ----------------------------------------------------------
  const influences = []

  if (hasCrest) {
    influences.push(influence('crest', cx, (crestTop + crestBottom) / 2,
      Math.max(0.06, charWidth * 0.16), Math.max(0.03, (crestBottom - crestTop) * 0.9),
      'sway', { amp: 0.018, freq: 1.35, phase: 0.2 }))
  }

  influences.push(influence('head', cx, (top + headBottom) / 2,
    Math.max(0.18, charWidth * 0.52), Math.max(0.12, (headBottom - top) * 0.62),
    'sway', { amp: 0.009, freq: 0.55, phase: 1.1 }))

  influences.push(influence('wingL', Math.max(0.05, wingLeft + charWidth * 0.04), torsoY,
    Math.max(0.06, charWidth * 0.14), Math.max(0.05, (torsoBottom - torsoTop) * 0.5),
    'flap', { amp: 0.012, freq: 1.05, phase: 0.4 }))
  influences.push(influence('wingR', Math.min(0.95, wingRight - charWidth * 0.04), torsoY,
    Math.max(0.06, charWidth * 0.14), Math.max(0.05, (torsoBottom - torsoTop) * 0.5),
    'flap', { amp: 0.012, freq: 1.05, phase: 2.5 }))

  influences.push(influence('torso', cx, torsoY,
    Math.max(0.16, charWidth * 0.34), Math.max(0.1, (torsoBottom - torsoTop) * 0.6),
    'breathe', { amp: 0.008, freq: 0.62, phase: 0 }))

  influences.push(influence('feet', cx, Math.min(0.97, torsoBottom + (bottom - torsoBottom) * 0.55),
    Math.max(0.14, charWidth * 0.34), Math.max(0.05, (bottom - torsoBottom) * 0.6),
    'sway', { amp: 0.006, freq: 0.9, phase: 3.1 }))

  const eyeRx = eyeLeft ? Math.max(0.04, (eyeLeft.w / width) * 0.85) : Math.max(0.05, eyeSpan * 0.28)
  const eyeRy = eyeLeft ? Math.max(0.025, (eyeLeft.h / height) * 0.8) : Math.max(0.03, charHeight * 0.05)
  influences.push(influence('eyeL', eyeLeft ? eyeLeft.cx / width : cx - eyeSpan / 2, eyeY, eyeRx, eyeRy, 'blink'))
  influences.push(influence('eyeR', eyeRight ? eyeRight.cx / width : cx + eyeSpan / 2, eyeY, eyeRx, eyeRy, 'blink'))

  // ---- mouth/beak: warm blob below the eyes, else proportions -------------
  const warm = components(
    width,
    height,
    (p) => {
      const i = p * 4
      if (rgba[i + 3] < 200) return false
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      // Orange-ish: red clearly above blue, and not just grey.
      return r - b > 40 && saturation(r, g, b) > 40
    },
    minArea,
  ).filter((blob) => blob.cy / height > eyeY && blob.cy / height < headBottom + charHeight * 0.2)

  let beak = warm.sort((a, b) => b.area - a.area)[0] || null
  if (beak === null) {
    const dark = blobs
      .filter((blob) => blob.cy / height > eyeY + charHeight * 0.04 && blob.cy / height < headBottom)
      .sort((a, b) => b.area - a.area)[0]
    beak = dark || null
    if (beak === null) notes.push('no beak/mouth found — the talking mouth falls back to proportions')
  }
  const mouthY = beak ? beak.cy / height : eyeY + charHeight * 0.11
  const mouthX = beak ? beak.cx / width : cx
  influences.push(influence('mouth', mouthX, mouthY,
    beak ? Math.max(0.04, (beak.w / width) * 0.7) : Math.max(0.05, charWidth * 0.12),
    beak ? Math.max(0.02, (beak.h / height) * 0.7) : Math.max(0.03, charHeight * 0.04),
    'talk'))

  landmarks.eyes = eyeLeft && eyeRight
    ? { left: { x: eyeLeft.cx / width, y: eyeLeft.cy / height }, right: { x: eyeRight.cx / width, y: eyeRight.cy / height } }
    : null
  landmarks.mouth = { x: mouthX, y: mouthY }
  landmarks.bounds = { top, bottom, left: bounds.minX / width, right: bounds.maxX / width }
  landmarks.confidence.features = eyeLeft && beak ? 'high' : eyeLeft || beak ? 'medium' : 'low'

  return { influences, landmarks, notes }
}

export { TAU }

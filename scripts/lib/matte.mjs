/**
 * Shared matte: turn a reference sheet into a transparent character sprite.
 *
 * Extracted from the character build script so the same code serves both the
 * built-in characters and user uploads. The pipeline is two-stage on purpose:
 *
 *   1. only pixels at or above `PAPER_MIN` seed the border flood fill, which is
 *      what protects white regions *inside* the character (an apron, socks,
 *      lace) — their anti-aliased edges sit below the threshold and stop the
 *      fill;
 *   2. the JPEG ringing just outside the silhouette is not flooded; it gets a
 *      narrow alpha ramp instead, gated on distance from the paper so that
 *      bright artwork far from the edge stays opaque.
 *
 * The distance gate ordering is load-bearing: testing brightness alone erases
 * the character's own white artwork, which is exactly as bright as the paper.
 */
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'

export const MATTE_DEFAULTS = {
  /** Only pixels this bright seed the border flood fill. */
  paperMin: 250,
  /** ...and this unsaturated, so coloured artwork is never mistaken for paper. */
  paperSatMax: 10,
  /** How far the alpha ramp reaches from the paper. Keep it narrow. */
  haloFadeTo: 4,
  /** Ignore slivers narrower than this when splitting a sheet into panels. */
  minPanelWidth: 40,
  /** Merge panels separated by a gap narrower than this. */
  mergeGap: 12,
  /** Blank margin kept around the cropped character. */
  padding: 8,
  /** Width of the sprite the pets inline; about 2x their on-screen size. */
  petWidth: 240,
}

const PAPER_MIN = 250
const PAPER_SAT_MAX = 10
/** Brightness band that may be treated as ringing rather than artwork. */
const HALO_MIN = 226
const HALO_SAT_MAX = 18
const HALO_IN = 250
const HALO_OUT = 232
/**
 * How far the softening reaches from the paper. This must stay *narrow*: the
 * same brightness test that matches JPEG ringing also matches white lace and
 * the thin end of a hair strand, so a wide band eats the character's own light
 * artwork from the inside and renders the whole sprite semi-transparent.
 */
const HALO_FADE_FROM = 0
const HALO_FADE_TO = 4

/** Ignore slivers narrower than this when splitting the sheet into panels. */
const MIN_PANEL_WIDTH = 40
/** Merge panels separated by a gap narrower than this (arms/hat brim overlap). */
const MERGE_GAP = 12
const PADDING = 8
/** Width of the sprite the pets inline; ~2x their on-screen size. */
const PET_WIDTH = 240

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Strict "definitely paper" test, used to find panels and content boxes. */
export function isWhite(r, g, b) {
  if (r < 248 || g < 248 || b < 248) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= 14
}

/** Artwork test for a paper sheet: anything that is not paper. */
export const paperOccupied = (i, pixels) => !isWhite(pixels[i], pixels[i + 1], pixels[i + 2])
/** Artwork test for a pre-cut image: anything meaningfully opaque. */
export const alphaOccupied = (i, pixels) => pixels[i + 3] >= 24

/** Paper: pure white only. Anti-aliased lace edges deliberately fail this. */
export function isPaper(r, g, b) {
  if (r < PAPER_MIN || g < PAPER_MIN || b < PAPER_MIN) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= PAPER_SAT_MAX
}

/** Ringing band: bright and unsaturated, but not pure paper. */
export function isHalo(r, g, b) {
  if (r < HALO_MIN || g < HALO_MIN || b < HALO_MIN) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= HALO_SAT_MAX
}

/** Split the sheet into character panels using empty vertical gaps. */
/**
 * Split a sheet into panels.
 *
 * Works on any channel count, and on either kind of sheet: a white-paper
 * reference sheet (panels separated by empty white columns) or a pre-cut
 * transparent image (panels separated by fully transparent columns). Passing
 * the wrong stride here is what silently merged the three views of a PNG sheet
 * into one panel, so the stride is explicit.
 *
 * @param pixels - raw buffer.
 * @param channels - bytes per pixel in that buffer.
 * @param occupied - predicate over a pixel index: is this pixel artwork?
 */
export function findPanels(pixels, width, height, channels, occupied) {
  const occupancy = new Int32Array(width)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (occupied((row + x) * channels, pixels)) occupancy[x]++
    }
  }

  const panels = []
  let start = -1
  let gap = 0
  for (let x = 0; x < width; x++) {
    if (occupancy[x] > 0) {
      if (start < 0) start = x
      gap = 0
    } else if (start >= 0) {
      gap++
      if (gap >= MERGE_GAP) {
        panels.push([start, x - gap])
        start = -1
        gap = 0
      }
    }
  }
  if (start >= 0) panels.push([start, width - 1])
  return panels.filter(([a, b]) => b - a >= MIN_PANEL_WIDTH)
}

/** Content bounding box inside a column range, using the same predicate. */
export function contentBox(pixels, width, channels, x0, x1, y0, y1, occupied) {
  let minX = x1
  let maxX = x0
  let minY = y1
  let maxY = y0
  for (let y = y0; y < y1; y++) {
    const row = y * width
    for (let x = x0; x < x1; x++) {
      if (!occupied((row + x) * channels, pixels)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, maxX, minY, maxY }
}

/**
 * Border flood fill over pure paper. Returns a Uint8Array where 1 marks the
 * paper region. Starting only from the border, and only from pixels that are
 * unambiguously paper, is what protects the white regions *inside* the
 * character — apron, socks, and the lace headdress.
 */
export function floodBackground(pixels, width, height, channels) {
  const background = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  let top = 0

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (background[p]) return
    // Stride must match the buffer actually handed in: this runs over the
    // repacked RGBA crop, and reading it at 3 bytes per pixel walks off the
    // rows and shreds the matte into stripes.
    const i = p * channels
    if (!isPaper(pixels[i], pixels[i + 1], pixels[i + 2])) return
    background[p] = 1
    stack[top++] = p
  }

  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }

  while (top > 0) {
    const p = stack[--top]
    const x = p % width
    const y = (p - x) / width
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
  return background
}

/** 4-neighbour BFS distance (in pixels, capped) from the nearest paper pixel. */
export function distanceFromPaper(background, width, height, cap) {
  const dist = new Uint8Array(width * height).fill(cap + 1)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  for (let p = 0; p < width * height; p++) {
    if (background[p]) {
      dist[p] = 0
      queue[tail++] = p
    }
  }
  while (head < tail) {
    const p = queue[head++]
    const d = dist[p]
    if (d >= cap) continue
    const x = p % width
    const y = (p - x) / width
    const visit = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
      const q = ny * width + nx
      if (dist[q] <= d + 1) return
      dist[q] = d + 1
      queue[tail++] = q
    }
    visit(x - 1, y)
    visit(x + 1, y)
    visit(x, y - 1)
    visit(x, y + 1)
  }
  return dist
}

/**
 * Alpha for one kept pixel: most artwork is opaque, but the bright band right
 * next to the paper is ringing (or a genuine anti-aliased silhouette edge), so
 * it fades out — aggressively near the paper, not at all far from it.
 */
export function edgeAlpha(value, distance) {
  // The distance gate must come FIRST. Testing brightness alone erases the
  // character's own white artwork — apron, socks, lace — because it is exactly
  // as bright as the paper; only distance from the paper says "artwork".
  if (distance >= HALO_FADE_TO) return 1
  const ramp = (HALO_IN - value) / (HALO_IN - HALO_OUT)
  if (ramp <= 0) return 0
  if (ramp >= 1) return 1
  const fade = (distance - HALO_FADE_FROM) / (HALO_FADE_TO - HALO_FADE_FROM)
  return ramp + (1 - ramp) * fade
}

/** Copy neighbouring foreground colour outward so feathered edges don't go white. */
export function bleedColour(rgba, background, width, height, passes = 6) {
  let frontier = []
  for (let p = 0; p < width * height; p++) if (background[p]) frontier.push(p)

  for (let pass = 0; pass < passes; pass++) {
    const next = []
    for (const p of frontier) {
      const x = p % width
      const y = (p - x) / width
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      const sample = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
        const q = ny * width + nx
        if (background[q]) return
        r += rgba[q * 4]
        g += rgba[q * 4 + 1]
        b += rgba[q * 4 + 2]
        n++
      }
      sample(x - 1, y)
      sample(x + 1, y)
      sample(x, y - 1)
      sample(x, y + 1)
      if (!n) continue
      rgba[p * 4] = Math.round(r / n)
      rgba[p * 4 + 1] = Math.round(g / n)
      rgba[p * 4 + 2] = Math.round(b / n)
      next.push(p)
    }
    for (const p of next) background[p] = 0
    frontier = next
    if (!frontier.length) break
  }
}

/** Feather alpha with two 3x3 box passes so the cutout doesn't alias. */
export function featherAlpha(alpha, width, height) {
  let src = alpha
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Float32Array(src.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= width) continue
            sum += src[ny * width + nx]
            n++
          }
        }
        dst[y * width + x] = sum / n
      }
    }
    src = dst
  }
  return src
}

export function checkerboard(width, height, cell = 16) {
  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2
      const v = on ? 0x66 : 0x4a
      const i = (y * width + x) * 3
      out[i] = v
      out[i + 1] = v + 4
      out[i + 2] = v + 10
    }
  }
  return out
}

export function overlaySvg(width, height, puppet) {
  const parts = []
  // Normalised 0.1 grid: brighter every 0.5.
  for (let i = 1; i < 10; i++) {
    const major = i === 5
    const c = major ? '#ff3b30' : '#00b0ff'
    const w = major ? 2 : 1
    const o = major ? 0.9 : 0.45
    parts.push(`<line x1="${(width * i) / 10}" y1="0" x2="${(width * i) / 10}" y2="${height}" stroke="${c}" stroke-width="${w}" opacity="${o}"/>`)
    parts.push(`<line x1="0" y1="${(height * i) / 10}" x2="${width}" y2="${(height * i) / 10}" stroke="${c}" stroke-width="${w}" opacity="${o}"/>`)
  }
  parts.push(`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#ffd60a" stroke-width="2"/>`)

  const palette = ['#ff2d55', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ff9f0a', '#5ac8fa', '#ff453a']
  const influences = puppet?.influences ?? []
  influences.forEach((inf, index) => {
    const cx = inf.cx * width
    const cy = inf.cy * height
    const rx = inf.rx * width
    const ry = inf.ry * height
    const colour = palette[index % palette.length]
    parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${colour}" fill-opacity="0.18" stroke="${colour}" stroke-width="2"/>`)
    parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${colour}"/>`)
    parts.push(
      `<text x="${cx + 6}" y="${cy - 6}" font-family="monospace" font-size="16" fill="#000" stroke="#fff" stroke-width="3" paint-order="stroke">${inf.name}</text>`,
    )
  })
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`,
  )
}

/**
 * Turn one panel of a reference sheet into a transparent sprite.
 *
 * @param options.source - path to the sheet (any format sharp reads).
 * @param options.panelIndex - which detected panel to use; 0 is the leftmost,
 *   which is where a conventional front view sits.
 * @param options.padding - blank margin kept around the cropped character.
 * @param options.petWidth - width of the small sprite written for the pets.
 * @returns the full-size RGBA sprite, the small pet sprite, and a report.
 */
export async function extractSprite(options) {
  const settings = { ...MATTE_DEFAULTS, ...options }
  // Always RGBA: a JPEG sheet and a pre-cut PNG then take the same code path,
  // and a channel count is never assumed.
  const { data: pixels, info } = await sharp(settings.source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const meta = await sharp(settings.source).metadata()

  // A sheet that is already cut out (a transparent PNG) needs no matte at all —
  // and would defeat the paper test, because it has no white border to flood.
  let transparent = 0
  for (let p = 0; p < width * height; p++) {
    if (pixels[p * 4 + 3] < 128) transparent++
  }
  const preCut = transparent / (width * height) > 0.05
  const occupied = preCut ? alphaOccupied : paperOccupied

  const panels = findPanels(pixels, width, height, 4, occupied)
  const detected = settings.panelRange ? [settings.panelRange.x0, settings.panelRange.x1] : panels[settings.panelIndex]
  if (panels.length === 0 && !settings.panelRange) {
    throw new Error(preCut
      ? 'no character found: the image is fully transparent'
      : 'no character panel found; the sheet background must be white, or supply a pre-cut transparent image')
  }
  if (!settings.panelRange && settings.panelIndex >= panels.length) {
    throw new Error(`panel ${settings.panelIndex} requested but only ${panels.length} found`)
  }
  // An explicit range overrides detection, for art whose frames are packed
  // tightly enough that the between-frame gap is not a full blank column run.
  const [px0, px1] = settings.panelRange
    ? [settings.panelRange.x0, settings.panelRange.x1]
    : panels[settings.panelIndex]
  // An explicit box lets several frames of the same character share one crop.
  // Multi-frame art (an open-eye and a closed-eye idle, say) only lines up if
  // every frame is cut with identical edges; deriving each box independently
  // makes the character jump by however much the two poses differ.
  const box = settings.box
    ? { minX: settings.box.left, maxX: settings.box.left + settings.box.width - 1,
        minY: settings.box.top, maxY: settings.box.top + settings.box.height - 1 }
    : contentBox(pixels, width, 4, px0, px1, 0, height, occupied)

  const left = settings.box ? settings.box.left : Math.max(0, box.minX - settings.padding)
  const top = settings.box ? settings.box.top : Math.max(0, box.minY - settings.padding)
  const right = settings.box ? settings.box.left + settings.box.width : Math.min(width, box.maxX + 1 + settings.padding)
  const bottom = settings.box ? settings.box.top + settings.box.height : Math.min(height, box.maxY + 1 + settings.padding)
  const cropW = right - left
  const cropH = bottom - top

  const rgba = Buffer.alloc(cropW * cropH * 4)
  for (let y = 0; y < cropH; y++) {
    pixels.copy(rgba, y * cropW * 4, (((top + y) * width) + left) * 4, (((top + y) * width) + right) * 4)
  }

  let paper = 0
  let softened = 0
  const alpha = new Float32Array(cropW * cropH)

  if (preCut) {
    // The source alpha already is the matte; only feather it.
    for (let p = 0; p < cropW * cropH; p++) {
      const a = rgba[p * 4 + 3] / 255
      alpha[p] = a
      if (a < 0.5) paper++
      else if (a < 1) softened++
    }
  } else {
    const background = floodBackground(rgba, cropW, cropH, 4)
    const distance = distanceFromPaper(background, cropW, cropH, settings.haloFadeTo)
    for (let p = 0; p < cropW * cropH; p++) {
      if (background[p]) {
        alpha[p] = 0
        paper++
        continue
      }
      const i = p * 4
      const value = Math.min(rgba[i], rgba[i + 1], rgba[i + 2])
      const a = edgeAlpha(value, distance[p])
      alpha[p] = a
      if (a < 1) softened++
    }
    bleedColour(rgba, background, cropW, cropH)
  }

  const feathered = featherAlpha(alpha, cropW, cropH)
  for (let p = 0; p < cropW * cropH; p++) {
    rgba[p * 4 + 3] = Math.max(0, Math.min(255, Math.round(feathered[p] * 255)))
  }

  const pet = await sharp(rgba, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize({ width: settings.petWidth })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toBuffer()

  return {
    rgba,
    width: cropW,
    height: cropH,
    pet,
    petWidth: settings.petWidth,
    petHeight: Math.round((cropH / cropW) * settings.petWidth),
    report: {
      sheet: { width, height, format: meta.format },
      preCut,
      panels,
      panelIndex: settings.panelIndex,
      box: { left, top, width: cropW, height: cropH },
      /** Union-ready box in *source* coordinates, ignoring the padding. */
      sourceBox: { left, top, right, bottom },
      paperPixels: paper,
      softenedPixels: softened,
      totalPixels: cropW * cropH,
    },
  }
}

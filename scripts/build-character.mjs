#!/usr/bin/env node
/**
 * Turn the three-view reference sheet into a single transparent front-view
 * sprite for the desktop pet, and (with --debug) render an overlay that shows
 * where the puppet's motion influences sit.
 *
 * Pipeline
 *   1. find the character columns by scanning for empty (all-white) vertical gaps
 *   2. keep the first panel (the front view) and crop it to its content box
 *   3. remove the background with a border flood fill, so white *inside* the
 *      character (apron, socks, frills, highlights) survives
 *   4. bleed edge colour outward and feather the alpha, so no white halo remains
 *   5. write character.png (+ a checkerboard preview and the debug overlay)
 *
 * Usage:
 *   node scripts/build-character.mjs
 *   node scripts/build-character.mjs --debug
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'resources', 'character', 'whale-maid')
const SOURCE = join(DIR, 'source.jpg')
const OUT_SPRITE = join(DIR, 'character.png')
const OUT_PREVIEW = join(DIR, 'preview.png')
const OUT_DEBUG = join(DIR, 'debug-overlay.png')

/**
 * The sheet's background is *pure* white (measured p50 = 254), which is what
 * makes a two-stage matte possible:
 *
 *  1. Only pixels at or above `PAPER_MIN` seed the flood fill. The character's
 *     white parts — apron, socks, and the scalloped lace headdress — are
 *     anti-aliased against that paper, so their own edge pixels sit below the
 *     threshold and stop the fill from leaking inside them.
 *  2. The JPEG ringing just outside the silhouette lands in the 226–250 band.
 *     Those pixels are not flooded; instead they get an alpha ramp, faded out
 *     with distance so noise far from the art disappears entirely.
 */
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
function isWhite(r, g, b) {
  if (r < 248 || g < 248 || b < 248) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= 14
}

/** Paper: pure white only. Anti-aliased lace edges deliberately fail this. */
function isPaper(r, g, b) {
  if (r < PAPER_MIN || g < PAPER_MIN || b < PAPER_MIN) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= PAPER_SAT_MAX
}

/** Ringing band: bright and unsaturated, but not pure paper. */
function isHalo(r, g, b) {
  if (r < HALO_MIN || g < HALO_MIN || b < HALO_MIN) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= HALO_SAT_MAX
}

/** Split the sheet into character panels using empty vertical gaps. */
function findPanels(rgb, width, height) {
  const occupancy = new Int32Array(width)
  for (let y = 0; y < height; y++) {
    const row = y * width * 3
    for (let x = 0; x < width; x++) {
      const i = row + x * 3
      if (!isWhite(rgb[i], rgb[i + 1], rgb[i + 2])) occupancy[x]++
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

/** Content bounding box inside a column range. */
function contentBox(rgb, width, x0, x1, y0, y1) {
  let minX = x1
  let maxX = x0
  let minY = y1
  let maxY = y0
  for (let y = y0; y < y1; y++) {
    const row = y * width * 3
    for (let x = x0; x < x1; x++) {
      const i = row + x * 3
      if (isWhite(rgb[i], rgb[i + 1], rgb[i + 2])) continue
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
function floodBackground(pixels, width, height, channels) {
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
function distanceFromPaper(background, width, height, cap) {
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
function edgeAlpha(value, distance) {
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
function bleedColour(rgba, background, width, height, passes = 6) {
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
function featherAlpha(alpha, width, height) {
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

function checkerboard(width, height, cell = 16) {
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

function overlaySvg(width, height, puppet) {
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

async function main() {
  await mkdir(DIR, { recursive: true })
  const image = sharp(SOURCE)
  const meta = await image.metadata()
  const { data: rgb, info } = await image.raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  console.log(`source   ${width}x${height} ${meta.format}`)

  const panels = findPanels(rgb, width, height)
  console.log(`panels   ${panels.length} -> ${panels.map(([a, b]) => `${a}-${b}(${b - a}px)`).join(', ')}`)
  if (!panels.length) throw new Error('no character panels found; is the sheet background really white?')

  const [px0, px1] = panels[0]
  const box = contentBox(rgb, width, px0, px1, 0, height)
  const left = Math.max(0, box.minX - PADDING)
  const top = Math.max(0, box.minY - PADDING)
  const right = Math.min(width, box.maxX + 1 + PADDING)
  const bottom = Math.min(height, box.maxY + 1 + PADDING)
  const cropW = right - left
  const cropH = bottom - top
  console.log(`front    crop ${cropW}x${cropH} at (${left},${top})`)

  // Repack the crop into a tight RGBA buffer we can edit in place.
  const rgba = Buffer.alloc(cropW * cropH * 4)
  for (let y = 0; y < cropH; y++) {
    const src = ((top + y) * width + left) * 3
    for (let x = 0; x < cropW; x++) {
      const s = src + x * 3
      const d = (y * cropW + x) * 4
      rgba[d] = rgb[s]
      rgba[d + 1] = rgb[s + 1]
      rgba[d + 2] = rgb[s + 2]
      rgba[d + 3] = 255
    }
  }

  const background = floodBackground(rgba, cropW, cropH, 4)
  const distance = distanceFromPaper(background, cropW, cropH, HALO_FADE_TO)
  let paper = 0
  let softened = 0
  const alpha = new Float32Array(cropW * cropH)
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
  const ratio = ((paper / (cropW * cropH)) * 100).toFixed(1)
  console.log(`matte    paper ${paper} px (${ratio}%), softened ${softened} edge px`)

  bleedColour(rgba, background, cropW, cropH)
  const feathered = featherAlpha(alpha, cropW, cropH)
  for (let p = 0; p < cropW * cropH; p++) {
    rgba[p * 4 + 3] = Math.max(0, Math.min(255, Math.round(feathered[p] * 255)))
  }

  if (process.argv.includes('--debug-alpha')) {
    for (const [px, py] of [[240, 150], [240, 600], [195, 775], [230, 560]]) {
      const q = py * cropW + px
      const hex = rgba.subarray(q * 4, q * 4 + 4)
      console.log(`probe (${px},${py}) rawAlpha=${alpha[q].toFixed(3)} feathered=${feathered[q].toFixed(3)} rgba=[${[...hex].join(',')}]`)
    }
  }

  if (process.argv.includes('--dump-mask')) {
    const maskOut = Buffer.alloc(cropW * cropH * 3)
    for (let q = 0; q < cropW * cropH; q++) {
      const paper = background[q] ? 255 : 0
      const dist = distance[q]
      maskOut[q * 3] = paper
      maskOut[q * 3 + 1] = paper ? 255 : Math.min(255, dist * 51)
      maskOut[q * 3 + 2] = paper ? 255 : 0
    }
    await sharp(maskOut, { raw: { width: cropW, height: cropH, channels: 3 } })
      .png().toFile(join(DIR, 'debug-mask.png'))
    console.log(`mask     -> ${join(DIR, 'debug-mask.png')} (white=paper, green ramp=distance)`)
  }

  await sharp(rgba, { raw: { width: cropW, height: cropH, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(OUT_SPRITE)
  console.log(`sprite   -> ${OUT_SPRITE}`)

  await sharp(checkerboard(cropW, cropH), { raw: { width: cropW, height: cropH, channels: 3 } })
    .composite([{ input: rgba, raw: { width: cropW, height: cropH, channels: 4 } }])
    .png()
    .toFile(OUT_PREVIEW)
  console.log(`preview  -> ${OUT_PREVIEW}`)

  // The size the pets actually render at: the live2d plugin inlines this one,
  // so it is part of the build rather than an ad-hoc step.
  const petPath = join(DIR, 'character-pet.png')
  await sharp(rgba, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize({ width: PET_WIDTH })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toFile(petPath)
  const petBytes = (await readFile(petPath)).length
  console.log(`pet      -> ${petPath} (${PET_WIDTH}px, ${(petBytes / 1024).toFixed(0)} KB)`)

  if (process.argv.includes('--debug')) {
    const puppetPath = join(DIR, 'puppet.json')
    let puppet = null
    if (await exists(puppetPath)) {
      puppet = JSON.parse(await readFile(puppetPath, 'utf8'))
      console.log(`regions  ${puppet.influences?.length ?? 0} influences from puppet.json`)
    } else {
      console.log('regions  (no puppet.json yet — drawing grid only)')
    }
    await sharp(checkerboard(cropW, cropH), { raw: { width: cropW, height: cropH, channels: 3 } })
      .composite([
        { input: rgba, raw: { width: cropW, height: cropH, channels: 4 } },
        { input: overlaySvg(cropW, cropH, puppet), top: 0, left: 0 },
      ])
      .png()
      .toFile(OUT_DEBUG)
    console.log(`debug    -> ${OUT_DEBUG}`)
  }
}

main().catch((error) => {
  console.error(`build-character failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})

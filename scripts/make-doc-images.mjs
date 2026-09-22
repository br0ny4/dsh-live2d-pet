#!/usr/bin/env node
/**
 * Compose the README images.
 *
 * `pet-panel-raw.png` is a real `capturePage()` of the desktop pet window: it
 * carries the window's transparency (88% of it is see-through), which is
 * exactly what we want — drop it on any backdrop and it looks like it is
 * floating on a desktop.
 *
 * Capture fresh raw shots first:
 *
 *   DSH_HOME=$(mktemp -d) node packages/dsh-pet-shell/test/mock-bridge.mjs &
 *   DSH_HOME=<that dir> npx electron packages/dsh-pet-shell --attach-only \
 *     --with-panel --screenshot docs/images/pet-panel-raw.png
 *   DSH_HOME=<that dir> npx electron packages/dsh-pet-shell --attach-only \
 *     --character penguin --with-panel --screenshot docs/images/pet-penguin-raw.png
 *
 * Then:
 *
 *   node scripts/make-doc-images.mjs
 */
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGES = join(ROOT, 'docs', 'images')
const RAW = join(IMAGES, 'pet-panel-raw.png')
const RAW_PENGUIN = join(IMAGES, 'pet-penguin-raw.png')

const WIDTH = 680
const HEIGHT = 1120

/** A calm desktop-ish backdrop: vertical wash plus a soft corner glow. */
function backdrop() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="wash" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#141c31"/>
      <stop offset="0.45" stop-color="#1d2743"/>
      <stop offset="1" stop-color="#2b3a5e"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.78" cy="0.16" r="0.62">
      <stop offset="0" stop-color="#5b7cfa" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#3b4d86" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="warm" cx="0.14" cy="0.92" r="0.55">
      <stop offset="0" stop-color="#7d5bfa" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#wash)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#warm)"/>
</svg>`)
}

async function main() {
  /** Compose one raw capture onto the backdrop; a missing capture is not fatal. */
  async function compose(rawPath, outputName) {
    let raw
    try {
      raw = await readFile(rawPath)
    } catch {
      console.log(`docs/images/${outputName} skipped (no raw capture at ${rawPath})`)
      return
    }
    const composed = await sharp(backdrop())
      .composite([{ input: raw, top: 0, left: 0 }])
      .png({ compressionLevel: 9 })
      .toBuffer()
    await writeFile(join(IMAGES, outputName), composed)
    console.log(`docs/images/${outputName} (${(composed.length / 1024).toFixed(0)} KB)`)
    await rm(rawPath, { force: true })
    await rm(rawPath.replace(/\.png$/, '.nofilter.png'), { force: true })
  }

  await compose(RAW, 'pet-panel.png')
  await compose(RAW_PENGUIN, 'pet-penguin.png')

  // Just the character, for the section about the renderer.
  for (const id of ['whale-maid', 'penguin']) {
    const character = await sharp(join(ROOT, 'resources', 'characters', id, 'character.png'))
      .resize({ width: 300 })
      .png({ compressionLevel: 9 })
      .toBuffer()
    await writeFile(join(IMAGES, `character-${id}.png`), character)
    console.log(`docs/images/character-${id}.png (${(character.length / 1024).toFixed(0)} KB)`)
  }
}

await main()

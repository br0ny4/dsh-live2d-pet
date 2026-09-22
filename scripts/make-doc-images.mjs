#!/usr/bin/env node
/**
 * Compose the README images.
 *
 * `pet-panel-raw.png` is a real `capturePage()` of the desktop pet window: it
 * carries the window's transparency (88% of it is see-through), which is
 * exactly what we want — drop it on any backdrop and it looks like it is
 * floating on a desktop.
 *
 * Capture a fresh raw shot first:
 *
 *   DSH_HOME=$(mktemp -d) node packages/dsh-pet-shell/test/mock-bridge.mjs &
 *   DSH_HOME=<that dir> npx electron packages/dsh-pet-shell \
 *     --attach-only --with-panel --screenshot docs/images/pet-panel-raw.png
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
  let raw
  try {
    raw = await readFile(RAW)
  } catch {
    console.error(`missing ${RAW}\nCapture one first — see the header of this script.`)
    process.exitCode = 1
    return
  }

  const composed = await sharp(backdrop())
    .composite([{ input: raw, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer()

  await writeFile(join(IMAGES, 'pet-panel.png'), composed)
  console.log(`docs/images/pet-panel.png (${(composed.length / 1024).toFixed(0)} KB)`)

  // Just the character, for the section about the renderer.
  const character = await sharp(join(ROOT, 'resources', 'character', 'whale-maid', 'character.png'))
    .resize({ width: 300 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(join(IMAGES, 'character.png'), character)
  console.log(`docs/images/character.png (${(character.length / 1024).toFixed(0)} KB)`)

  // The raw capture and its diagnostic sibling are working files, not docs.
  await rm(RAW, { force: true })
  await rm(RAW.replace(/\.png$/, '.nofilter.png'), { force: true })
}

await main()

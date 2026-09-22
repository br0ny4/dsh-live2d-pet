#!/usr/bin/env node
/**
 * Character CLI — build the built-in characters, and add your own.
 *
 *   node scripts/character.mjs list
 *   node scripts/character.mjs build [--id <id>] [--rerig] [--debug]
 *   node scripts/character.mjs add --from <image> --id <id> [options]
 *
 * `add` is the "bring your own character" path: hand it a reference sheet (a
 * three-view sheet works, the front panel is used) and it runs the same matte
 * and the same rig derivation the built-in characters go through, then writes
 * a debug overlay so you can see where the motion regions landed.
 *
 * A character directory looks like this:
 *
 *   resources/characters/<id>/
 *     character.json      manifest (name, author, licence, which files are what)
 *     source.png          the sheet you supplied, kept for reproducibility
 *     character.png       full-size transparent sprite
 *     character-pet.png   the small sprite the pets inline
 *     puppet.json         motion rig
 *     debug-overlay.png   the rig drawn over the sprite, for review
 *
 * Rig geometry is a starting point, never a verdict — check the overlay. Any
 * influence you want to correct can be replaced wholesale in
 * `rig.overrides.json` beside the manifest.
 */
import { readdir, readFile, writeFile, mkdir, copyFile, access, rm, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { extractSprite, checkerboard, overlaySvg } from './lib/matte.mjs'
import { deriveRig } from './lib/rig.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHARACTERS = join(ROOT, 'resources', 'characters')

const argv = process.argv.slice(2)
const command = argv[0]
const has = (flag) => argv.includes(`--${flag}`)
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Every character directory that has a readable manifest, default first. */
export async function loadCharacters() {
  let entries = []
  try {
    entries = await readdir(CHARACTERS, { withFileTypes: true })
  } catch {
    return []
  }
  const characters = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(CHARACTERS, entry.name, 'character.json')
    if (!(await exists(manifestPath))) continue
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      characters.push({ ...manifest, id: manifest.id || entry.name, dir: join(CHARACTERS, entry.name) })
    } catch (error) {
      console.warn(`skipping ${entry.name}: ${error.message}`)
    }
  }
  characters.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id))
  return characters
}

async function characterById(id) {
  return (await loadCharacters()).find((character) => character.id === id) || null
}

function slug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

async function writeDebug(dir, sprite, width, height, rig) {
  await sharp(checkerboard(width, height), { raw: { width, height, channels: 3 } })
    .composite([
      { input: sprite, raw: { width, height, channels: 4 } },
      { input: overlaySvg(width, height, rig), top: 0, left: 0 },
    ])
    .png()
    .toFile(join(dir, 'debug-overlay.png'))
}

/** Load a rig, letting `rig.overrides.json` replace influences by name. */
async function loadRig(dir, fallback) {
  const rigPath = join(dir, 'puppet.json')
  const overridesPath = join(dir, 'rig.overrides.json')
  const rig = (await exists(rigPath))
    ? JSON.parse(await readFile(rigPath, 'utf8'))
    : fallback
  if (!(await exists(overridesPath))) return rig
  const overrides = JSON.parse(await readFile(overridesPath, 'utf8'))
  const byName = new Map((overrides.influences || []).map((inf) => [inf.name, inf]))
  const merged = (rig.influences || []).map((inf) => (byName.has(inf.name) ? { ...inf, ...byName.get(inf.name) } : inf))
  for (const [name, inf] of byName) {
    if (!merged.some((existing) => existing.name === name)) merged.push(inf)
  }
  return { ...rig, ...overrides, influences: merged }
}

// ---------------------------------------------------------------------------

async function list() {
  const characters = await loadCharacters()
  if (characters.length === 0) {
    console.log('no characters found')
    return
  }
  console.log(`${characters.length} character(s):\n`)
  for (const character of characters) {
    const marker = character.builtin ? 'built-in' : 'user'
    console.log(`  ${character.id.padEnd(16)} ${String(character.name || '').padEnd(20)} ${marker}`)
    if (character.description) console.log(`  ${' '.repeat(16)} ${character.description}`)
  }
}

async function buildOne(id, options) {
  const character = options.manifest || (await characterById(id))
  if (character === null) throw new Error(`unknown character: ${id}`)
  const dir = character.dir
  const sourceName = character.source || (await exists(join(dir, 'source.png')) ? 'source.png' : 'source.jpg')
  const sourcePath = join(dir, sourceName)
  if (!(await exists(sourcePath))) throw new Error(`${id}: missing ${sourceName}`)

  const result = await extractSprite({ source: sourcePath, panelIndex: character.panel ?? 0 })
  await writeFile(join(dir, 'character.png'), await sharp(result.rgba, {
    raw: { width: result.width, height: result.height, channels: 4 },
  }).png({ compressionLevel: 9 }).toBuffer())
  await writeFile(join(dir, 'character-pet.png'), result.pet)

  const rigPath = join(dir, 'puppet.json')
  const wantsRig = options.rerig || !(await exists(rigPath))
  let rig
  let notes = []
  if (wantsRig) {
    const derived = deriveRig(result.rgba, result.width, result.height)
    rig = {
      $comment: 'Motion rig. Derived automatically at import time; see scripts/lib/rig.mjs for how, and edit rig.overrides.json to correct it without losing the derivation.',
      sprite: 'character.png',
      canvas: { width: result.petWidth, height: result.petHeight },
      grid: { cols: 24, rows: 44 },
      influences: derived.influences,
    }
    notes = derived.notes
    await writeFile(rigPath, `${JSON.stringify(rig, null, 2)}\n`)
  } else {
    rig = await loadRig(dir, { influences: [] })
  }

  await writeDebug(dir, result.rgba, result.width, result.height, rig)

  return {
    id,
    dir,
    sprite: { width: result.width, height: result.height },
    pet: { width: result.petWidth, height: result.petHeight },
    rigGenerated: wantsRig,
    influences: rig.influences.length,
    notes,
    report: result.report,
  }
}

function report(result) {
  const { report: detail } = result
  console.log(`\n${result.id}`)
  console.log(`  sheet     ${detail.sheet.width}x${detail.sheet.height} ${detail.sheet.format}${detail.preCut ? ' (pre-cut, alpha matte)' : ' (white paper)'}, ${detail.panels.length} panel(s), used #${detail.panelIndex}`)
  console.log(`  crop      ${detail.box.width}x${detail.box.height}`)
  console.log(`  matte     ${((detail.paperPixels / detail.totalPixels) * 100).toFixed(1)}% paper, ${detail.softenedPixels} softened edge px`)
  console.log(`  sprite    ${result.sprite.width}x${result.sprite.height}`)
  console.log(`  pet       ${result.pet.width}x${result.pet.height}`)
  console.log(`  rig       ${result.rigGenerated ? 'derived' : 'kept existing'} — ${result.influences} influences`)
  for (const note of result.notes) console.log(`  ! ${note}`)
  console.log(`  overlay   ${join(result.dir, 'debug-overlay.png')}  <- check this`)
}

async function add() {
  const from = value('from')
  const id = slug(value('id', ''))
  if (!from) throw new Error('add needs --from <image>')
  if (!id) throw new Error('add needs --id <slug>')

  const sourcePath = resolve(from)
  if (!(await exists(sourcePath))) throw new Error(`no such file: ${sourcePath}`)

  const dir = join(CHARACTERS, id)
  if ((await exists(join(dir, 'character.json'))) && !has('force')) {
    throw new Error(`${id} already exists (pass --force to overwrite)`)
  }
  await mkdir(dir, { recursive: true })

  const extension = extname(sourcePath).toLowerCase() || '.png'
  const sourceName = `source${extension}`
  const destination = join(dir, sourceName)
  if (resolve(destination) === sourcePath) {
    // Re-importing a character from its own stored sheet: removing the
    // destination first would delete the source.
    await chmod(destination, 0o644).catch(() => {})
  } else {
    // A re-import has to survive a read-only destination: copying onto a 0400
    // file fails with EACCES, and an exported sheet is often 0400.
    await rm(destination, { force: true })
    await copyFile(sourcePath, destination)
    await chmod(destination, 0o644)
  }

  const manifest = {
    id,
    name: value('name', id),
    description: value('description', ''),
    author: value('author', ''),
    license: value('license', ''),
    builtin: false,
    order: Number(value('order', 100)),
    source: sourceName,
    sprite: 'character.png',
    pet: 'character-pet.png',
    rig: 'puppet.json',
    panel: Number(value('panel', 0)),
  }
  await writeFile(join(dir, 'character.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const result = await buildOne(id, { manifest: { ...manifest, dir }, rerig: true })
  report(result)
  console.log(`\nNext: launch a pet and pick "${manifest.name}", or check the overlay above and correct`)
  console.log(`the rig in ${join(dir, 'rig.overrides.json')}.`)
}

async function build() {
  const only = value('id')
  const targets = only ? [only] : (await loadCharacters()).map((character) => character.id)
  if (targets.length === 0) throw new Error('no characters to build')
  for (const id of targets) {
    const result = await buildOne(id, { rerig: has('rerig') })
    report(result)
  }
}

const USAGE = `usage:
  node scripts/character.mjs list
  node scripts/character.mjs build [--id <id>] [--rerig]
  node scripts/character.mjs add --from <image> --id <id> [--name "..."] [--author "..."]
                              [--description "..."] [--license "..."] [--panel 0] [--force]
`

try {
  if (command === 'list') await list()
  else if (command === 'build') await build()
  else if (command === 'add') await add()
  else {
    console.log(USAGE)
    process.exitCode = command === undefined || command === '--help' || command === 'help' ? 0 : 1
  }
} catch (error) {
  console.error(`character: ${error.message}`)
  process.exitCode = 1
}

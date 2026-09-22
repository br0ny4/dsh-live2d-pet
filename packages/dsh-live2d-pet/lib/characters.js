/**
 * Character registry.
 *
 * A character is a directory with a `character.json` manifest beside its
 * sprite, pet sprite and rig. Three roots are searched, later ones never
 * shadowing earlier ones:
 *
 *   1. `$DSH_HOME/live2d-pet/characters`  — yours, written at runtime
 *   2. `<this package>/characters`        — the built-ins, copied in at build
 *   3. `<repo>/resources/characters`      — dev fallback, source of truth
 *
 * Root 3 exists because a linked (dev) install has no copied characters yet;
 * a published package never sees it.
 *
 * Only leaf fields are read out of the manifests — never a live object — so the
 * result is plain JSON that can cross the bridge or a package-private RPC.
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

/** Where the pets keep user-supplied characters. */
export function userCharacterRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'live2d-pet', 'characters')
}

/** Every root to search, in priority order, skipping the ones that are absent. */
export function characterRoots() {
  const roots = [userCharacterRoot(), join(PACKAGE_ROOT, 'characters')]
  // packages/dsh-live2d-pet/lib -> repository root
  const repoRoot = join(PACKAGE_ROOT, '..', '..', 'resources', 'characters')
  roots.push(repoRoot)
  return roots.filter((root) => existsSync(root))
}

/** Read one manifest, tolerating a broken one instead of failing the listing. */
async function readManifest(dir, id) {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'character.json'), 'utf8'))
    return {
      id: manifest.id || id,
      name: typeof manifest.name === 'string' ? manifest.name : id,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      author: typeof manifest.author === 'string' ? manifest.author : '',
      license: typeof manifest.license === 'string' ? manifest.license : '',
      builtin: manifest.builtin === true,
      order: Number.isFinite(manifest.order) ? manifest.order : 100,
      sprite: typeof manifest.sprite === 'string' ? manifest.sprite : 'character.png',
      pet: typeof manifest.pet === 'string' ? manifest.pet : 'character-pet.png',
      petBlink: typeof manifest.petBlink === 'string' ? manifest.petBlink : null,
      rig: typeof manifest.rig === 'string' ? manifest.rig : 'puppet.json',
      dir,
      root: dirname(dir),
    }
  } catch {
    return null
  }
}

/**
 * Every usable character, default first.
 *
 * A character id found in a higher-priority root wins outright, so a user can
 * override a built-in by reusing its id.
 */
export async function listCharacters() {
  const byId = new Map()
  for (const root of characterRoots()) {
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      if (byId.has(entry.name)) continue
      const manifest = await readManifest(dir, entry.name)
      if (manifest === null) continue
      if (!existsSync(join(dir, manifest.pet)) || !existsSync(join(dir, manifest.rig))) continue
      byId.set(entry.name, manifest)
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ dir, root, ...rest }) => ({ ...rest, dir, root }))
}

/** One character plus the bytes and rig the pets need to render it. */
export async function loadCharacter(id) {
  const character = (await listCharacters()).find((entry) => entry.id === id)
  if (character === undefined) return null
  try {
    const [sprite, rigText, blink] = await Promise.all([
      readFile(join(character.dir, character.pet)),
      readFile(join(character.dir, character.rig), 'utf8'),
      character.petBlink === null
        ? Promise.resolve(null)
        : readFile(join(character.dir, character.petBlink)).catch(() => null),
    ])
    return {
      manifest: {
        id: character.id,
        name: character.name,
        description: character.description,
        author: character.author,
        license: character.license,
        builtin: character.builtin,
        hasBlinkFrame: character.petBlink !== null,
      },
      rig: JSON.parse(rigText),
      sprite: sprite.toString('base64'),
      // A paired closed-eye frame, when the character ships one. The renderer
      // cross-fades to it instead of squashing the mesh.
      spriteBlink: blink === null ? null : blink.toString('base64'),
      bytes: sprite.length,
    }
  } catch {
    return null
  }
}

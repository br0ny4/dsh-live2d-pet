#!/usr/bin/env node
/**
 * Fetch the Live2D runtime + official free sample models.
 *
 * Everything this script downloads comes from Live2D Inc.'s own distribution
 * points and stays out of version control (see .gitignore):
 *
 *   - Cubism Core (`live2dcubismcore.min.js`)  — https://cubism.live2d.com
 *   - Sample models (Hiyori, Haru, ...)        — https://github.com/Live2D/CubismWebSamples
 *
 * Both are governed by Live2D's own licenses (Cubism SDK Release License and
 * the Free Material License Agreement for the sample models). They may be
 * shipped *inside* an application, but not redistributed as standalone
 * material — which is why we download them per machine instead of vendoring
 * them into the repository.
 *
 * Usage:
 *   node scripts/fetch-live2d-assets.mjs                 # core + all sample models
 *   node scripts/fetch-live2d-assets.mjs --core-only
 *   node scripts/fetch-live2d-assets.mjs --models=Hiyori,Rice
 *   node scripts/fetch-live2d-assets.mjs --list
 */
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'resources', 'live2d')
const CORE_DIR = join(OUT, 'core')
const MODELS_DIR = join(OUT, 'models')

const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
const REPO = 'Live2D/CubismWebSamples'
const BRANCH = 'develop'
const RESOURCES_PREFIX = 'Samples/Resources/'

/** Models that are not characters (shared backdrops / UI images). */
const NON_CHARACTER = new Set(['back_class_normal.png', 'icon_gear.png'])

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  return Number(res.headers.get('content-length') ?? 0)
}

/** Every blob under `Samples/Resources/`, grouped by model directory. */
async function listModelTree() {
  const api = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`
  const res = await fetch(api, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub tree API: ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (!Array.isArray(body.tree)) throw new Error('GitHub tree API returned no tree')

  const models = new Map()
  for (const node of body.tree) {
    if (node.type !== 'blob' || !node.path.startsWith(RESOURCES_PREFIX)) continue
    const relative = node.path.slice(RESOURCES_PREFIX.length)
    const [name, ...rest] = relative.split('/')
    if (!rest.length || NON_CHARACTER.has(name)) continue
    if (!models.has(name)) models.set(name, [])
    models.get(name).push({ path: relative, size: node.size ?? 0 })
  }
  return models
}

async function isModelComplete(name, files) {
  for (const file of files) {
    if (!(await exists(join(MODELS_DIR, file.path)))) return false
  }
  return true
}

/** Rebuild `models/manifest.json` from whatever is on disk. */
async function writeManifest() {
  let entries = []
  try {
    for (const dirent of await readdir(MODELS_DIR, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const dir = join(MODELS_DIR, dirent.name)
      const model3 = (await readdir(dir)).find((f) => f.endsWith('.model3.json'))
      if (!model3) continue
      entries.push({
        id: dirent.name,
        name: dirent.name,
        kind: 'cubism4',
        entry: `${dirent.name}/${model3}`,
      })
    }
  } catch {
    entries = []
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  await writeFile(join(MODELS_DIR, 'manifest.json'), `${JSON.stringify({ models: entries }, null, 2)}\n`)
  return entries
}

async function pool(items, limit, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      try {
        await worker(item)
      } catch (error) {
        console.warn(`  ! ${error.message}`)
      }
    }
  })
  await Promise.all(runners)
}

async function main() {
  await mkdir(CORE_DIR, { recursive: true })

  console.log('Live2D assets')
  console.log(`  source : ${REPO}@${BRANCH} + cubism.live2d.com`)
  console.log(`  target : ${OUT}`)
  console.log('')

  if (!has('--skip-core')) {
    const corePath = join(CORE_DIR, 'live2dcubismcore.min.js')
    const bytes = await download(CORE_URL, corePath)
    console.log(`core    ok  live2dcubismcore.min.js (${(bytes / 1024).toFixed(0)} KB)`)
  }

  if (has('--core-only')) {
    console.log('\nDone (core only).')
    return
  }

  const models = await listModelTree()
  const requested = value('models', null)

  if (has('--list')) {
    console.log('\nAvailable sample models:')
    for (const [name, files] of [...models].sort()) {
      const mb = (files.reduce((n, f) => n + f.size, 0) / 1e6).toFixed(2)
      console.log(`  ${name.padEnd(8)} ${String(files.length).padStart(3)} files  ${mb.padStart(6)} MB`)
    }
    return
  }

  const wanted = requested
    ? requested.split(',').map((s) => s.trim()).filter(Boolean)
    : [...models.keys()].sort()

  console.log('')
  for (const name of wanted) {
    const files = models.get(name)
    if (!files) {
      console.warn(`model   ??  ${name} is not a sample model in this repository`)
      continue
    }
    if (await isModelComplete(name, files)) {
      console.log(`model   ok  ${name} (already present)`)
      continue
    }
    const total = files.reduce((n, f) => n + f.size, 0)
    const started = Date.now()
    let done = 0
    await pool(files, 6, async (file) => {
      const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${RESOURCES_PREFIX}${file.path}`
      await download(url, join(MODELS_DIR, file.path))
      done += 1
      process.stdout.write(`\r  ${name.padEnd(8)} ${done}/${files.length} files ...`)
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(`\r`)
    console.log(`model   ok  ${name} (${(total / 1e6).toFixed(2)} MB in ${seconds}s)`)
  }

  const entries = await writeManifest()
  console.log(`\nmanifest -> ${entries.length} model(s) usable at runtime`)
}

main().catch((error) => {
  console.error(`\nfetch-live2d-assets failed: ${error.message}`)
  process.exitCode = 1
})

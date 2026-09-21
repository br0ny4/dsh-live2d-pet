/**
 * Build the browser half into the module format the DSH client loader expects.
 *
 * Shipped client plugins are not plain ESM: each `lib/client.js` is a
 * self-registering factory handed to `window.__ModuleLoader__`, whose `require`
 * resolves the packages named in `dsh.client.inject` (plus React). Everything
 * else — our own modules, the stylesheet, and the character sprite — is inlined
 * so the bundle has no runtime fetches and no asset URLs to resolve.
 *
 *   node build.mjs
 */
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const OUT = join(ROOT, 'lib', 'client.js')

const SPRITE = join(ROOT, '..', '..', 'resources', 'character', 'whale-maid', 'character-pet.png')
const RIG = join(ROOT, '..', '..', 'resources', 'character', 'whale-maid', 'puppet.json')

async function dataUrl(path, mime) {
  const bytes = await readFile(path)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

const result = await build({
  entryPoints: [join(ROOT, 'src', 'client', 'pet.js')],
  bundle: true,
  format: 'iife',
  globalName: '__dshLive2dPet',
  write: false,
  target: ['chrome120', 'safari17'],
  logLevel: 'warning',
  define: {
    __PET_CSS__: JSON.stringify(await readFile(join(ROOT, 'src', 'client', 'pet.css'), 'utf8')),
    __PET_RIG__: await readFile(RIG, 'utf8'),
    __PET_SPRITE__: JSON.stringify(await dataUrl(SPRITE, 'image/png')),
  },
})

const body = result.outputFiles[0].text

// The loader hands the factory its own `require`; the bundled body reads it
// through the `__dshRequire` free variable and publishes `apply`/`inject` on
// the IIFE global, which becomes the plugin's module exports.
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG.name)},
\tfactory: (__dshRequire) => {
\t\t${body.trim()}
\t\treturn __dshLive2dPet;
\t},
});
`

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, bundle)
console.log(`built ${OUT} (${(Buffer.byteLength(bundle) / 1024).toFixed(0)} KB)`)

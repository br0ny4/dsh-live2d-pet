/**
 * Bundle the renderer.
 *
 * The renderer imports the character engine from the plugin package, which a
 * `file://` page cannot do directly (Chromium blocks cross-origin module loads).
 * Bundling to one classic script keeps the window's webPreferences strict —
 * no `webSecurity: false`, no remote module loading.
 *
 *   node build.mjs
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(ROOT, 'src', 'renderer', 'pet.js')],
  outfile: join(ROOT, 'src', 'renderer', 'bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  logLevel: 'warning',
})

if (result.errors.length > 0) process.exitCode = 1
else console.log('built src/renderer/bundle.js')

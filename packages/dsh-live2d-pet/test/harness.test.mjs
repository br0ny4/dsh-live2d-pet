/**
 * Integration test against a **real harness**.
 *
 * The other two suites never boot `dsh`: the bridge test drives `apply()` with a
 * mock context, and the shell test talks to a mock bridge. That left a whole
 * class of failure invisible — a plugin that loads cleanly, logs nothing wrong,
 * and contributes nothing.
 *
 * That is not hypothetical. The character route used to be registered with
 * `ctx.get('webServer')`, which returns undefined when the plugin activates
 * before the web carrier does. The plugin loaded, the desktop bridge worked, and
 * the in-page pet silently fell back to its bundled character forever, because
 * every request to the route 404'd.
 *
 * This test boots `dsh web` on an ephemeral port in a throwaway DSH_HOME, with
 * this package installed into the profile, and asserts the route actually
 * answers. It skips (successfully) when `dsh` is not on PATH, so it stays usable
 * on a machine that only runs the plugin.
 *
 *   node packages/dsh-live2d-pet/test/harness.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = join(HERE, '..')
const ROUTE = '/dsh-live2d-pet/characters'

let failures = 0
function check(label, condition, extra) {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : `  ${extra}`}`)
}

const hasDsh = spawnSync('dsh', ['--version'], { stdio: 'ignore' }).status === 0
if (!hasDsh) {
  console.log('SKIP  dsh is not on PATH — this test needs a real harness')
  process.exit(0)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-pet-harness-'))
console.log(`home: ${home}\n`)

const env = { ...process.env, DSH_HOME: home }
const run = (args) => spawnSync('dsh', args, { env, encoding: 'utf8', timeout: 180_000 })

try {
  const install = run(['plugin', '--profile', 'web', 'add', PACKAGE])
  check('the package installs into a fresh profile', install.status === 0,
    install.status === 0 ? '' : String(install.stderr || '').slice(-200))

  const harness = spawn('dsh', ['web', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  harness.stdout.on('data', (chunk) => { log += chunk.toString() })
  harness.stderr.on('data', (chunk) => { log += chunk.toString() })

  let port = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && port === null) {
    const match = log.match(/127\.0\.0\.1:(\d+)\/\?token=/)
    if (match) port = Number(match[1])
    else await new Promise((resolve) => setTimeout(resolve, 500))
  }

  try {
    check('the harness booted and printed its URL', port !== null, port === null ? '' : `port=${port}`)
    if (port === null) throw new Error('no harness')

    // The plugin's own log line is the cheapest proof that the web carrier
    // handshake happened at all; the request below is the real proof.
    check('the plugin announced its character route',
      log.includes(`characters served at ${ROUTE}`), '')

    const index = await (await fetch(`http://127.0.0.1:${port}${ROUTE}`)).json()
    check('the character route answers on the harness carrier', index.ok === true)
    check('the built-in characters are listed',
      Array.isArray(index.characters) && index.characters.length >= 2,
      `${index.characters ? index.characters.length : 0} character(s)`)

    const whale = index.characters.find((entry) => entry.id === 'whale-maid')
    check('the index advertises what the payload actually carries',
      whale !== undefined && whale.hasBlinkFrame === true,
      whale ? `hasBlinkFrame=${whale.hasBlinkFrame}` : 'whale-maid missing')

    const one = await (await fetch(`http://127.0.0.1:${port}${ROUTE}/whale-maid`)).json()
    check('a character loads over the harness carrier', one.ok === true)
    check('its rig is present', Array.isArray(one.rig.influences) && one.rig.influences.length >= 9,
      one.rig ? `${one.rig.influences.length} influences` : '')
    check('its paired blink frame is carried too',
      typeof one.spriteBlink === 'string' && one.spriteBlink.length > 1000,
      one.spriteBlink ? `${Math.round(one.spriteBlink.length / 1024)} KB` : 'absent')

    const missing = await fetch(`http://127.0.0.1:${port}${ROUTE}/does-not-exist`)
    check('an unknown character 404s', missing.status === 404, `status=${missing.status}`)

    // The desktop bridge is a separate mechanism and must be up regardless.
    check('the loopback bridge published its discovery file',
      log.includes('desktop bridge on 127.0.0.1'), '')
  } finally {
    harness.kill('SIGKILL')
    await new Promise((resolve) => harness.once('exit', resolve).setTimeout ?? 0)
  }

  if (failures > 0) {
    console.log('\n--- harness log ---')
    console.log(log.split('\n').filter(Boolean).slice(-25).join('\n'))
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

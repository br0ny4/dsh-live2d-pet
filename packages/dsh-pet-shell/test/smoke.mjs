/**
 * End-to-end smoke test for the desktop shell.
 *
 * Starts the mock bridge on a throwaway DSH_HOME, launches the real Electron
 * shell against it in attach-only mode, and asserts on what the shell actually
 * produced: the attach log line, a screenshot of the right size, and a canvas
 * that reports the expected backing-store dimensions.
 *
 * It cannot judge how the character *looks* — that needs eyes on the PNG. What
 * it does catch is the whole wiring: discovery file → SSE → renderer → canvas.
 *
 *   node packages/dsh-pet-shell/test/smoke.mjs
 *   node ... --keep-shot    # print the screenshot path instead of deleting it
 */
import { spawn } from 'node:child_process'
import { readFile, rm, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = join(HERE, '..')

let failures = 0
function check(label, condition, extra) {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : `  ${extra}`}`)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-pet-smoke-'))
const shot = join(home, 'pet.png')
const electron = join(PACKAGE, 'node_modules', '.bin', 'electron')

async function electronBinary() {
  try {
    await stat(electron)
    return electron
  } catch {
    return null
  }
}

const binary = await electronBinary()
if (binary === null) {
  console.error('electron is not installed in packages/dsh-pet-shell — run `pnpm install` first')
  process.exit(1)
}

// The renderer bundle is a build artifact; build it if it is missing.
try {
  await stat(join(PACKAGE, 'src', 'renderer', 'bundle.js'))
} catch {
  console.log('building the renderer bundle first…')
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [join(PACKAGE, 'build.mjs')], { stdio: 'inherit' })
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
  })
}

console.log(`home: ${home}\n`)

// ---- 1. the mock harness --------------------------------------------------
const bridge = spawn(process.execPath, [join(HERE, 'mock-bridge.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bridgeLog = ''
bridge.stdout.on('data', (chunk) => { bridgeLog += chunk.toString() })
bridge.stderr.on('data', (chunk) => { bridgeLog += chunk.toString() })

const discoveryPath = join(home, 'live2d-pet', 'bridge.json')
let discovery = null
for (let i = 0; i < 60 && discovery === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
  } catch {
    /* not written yet */
  }
}
check('mock bridge published its discovery file', discovery !== null,
  discovery && `port=${discovery.port}`)
check('mock bridge state answers over HTTP', await (async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${discovery.port}/v1/state`, {
      headers: { authorization: `Bearer ${discovery.secret}` },
    })
    return (await res.json()).ok === true
  } catch {
    return false
  }
})())

// ---- 2. the real shell ----------------------------------------------------
const shell = spawn(binary, [PACKAGE, '--attach-only', '--screenshot', shot], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let shellLog = ''
shell.stdout.on('data', (chunk) => { shellLog += chunk.toString() })
shell.stderr.on('data', (chunk) => { shellLog += chunk.toString() })

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    shell.kill('SIGKILL')
    resolve('timeout')
  }, 60_000)
  shell.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
})

bridge.kill('SIGKILL')

check('shell attached to the bridge', /attached to bridge pid=\d+/.test(shellLog),
  (shellLog.match(/attached to bridge pid=\d+ port=\d+/) || [''])[0])
check('shell exited cleanly', exitCode === 0, `exit=${exitCode}`)
check('renderer reported a live canvas', /canvas info: \{"w":\d+,"h":\d+/.test(shellLog),
  (shellLog.match(/canvas info: .*/) || [''])[0])

// ---- 3. what it actually drew --------------------------------------------
let png = null
try {
  png = await readFile(shot)
} catch {
  /* missing */
}
check('screenshot was written', png !== null)

if (png !== null) {
  // PNG header: 8-byte signature, then IHDR gives width/height as big-endian u32.
  const signature = png.subarray(0, 8).toString('hex')
  check('screenshot is a real PNG', signature === '89504e470d0a1a0a', signature)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  // 340x560 logical at 2x device pixel ratio.
  check('screenshot has the window geometry', width === 680 && height === 1120, `${width}x${height}`)
  check('screenshot is not blank', png.length > 20_000, `${(png.length / 1024).toFixed(0)} KB`)
}

function report(label, text) {
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length) console.log(`\n--- ${label} ---\n${lines.join('\n')}`)
}
if (failures > 0) {
  report('shell log', shellLog)
  report('bridge log', bridgeLog)
}

if (process.argv.includes('--keep-shot')) {
  console.log(`\nscreenshot: ${shot}`)
} else {
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

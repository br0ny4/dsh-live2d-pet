/**
 * A stand-in for the plugin's Host bridge.
 *
 * Publishes the same discovery file and the same three routes as
 * `dsh-live2d-pet`'s Host half, then walks one session through every phase, so
 * the desktop shell can be developed and smoke-tested without booting a whole
 * harness.
 *
 * Used by `test/smoke.mjs`, and handy by hand while iterating on the renderer:
 *
 *   DSH_HOME=/tmp/pet-dev node packages/dsh-pet-shell/test/mock-bridge.mjs
 *   DSH_HOME=/tmp/pet-dev npx electron packages/dsh-pet-shell --attach-only --dev
 */
import { createServer } from 'node:http'
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.DSH_HOME === undefined) {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-pet-mock-'))
}
const HOME = process.env.DSH_HOME
const SECRET = 'a'.repeat(64)
const SESSION = 'session-1111-2222-3333-abcdef12'
/** How long the scripted phase walk takes; the smoke test waits it out. */
const SCRIPT_MS = 6000

let phase = 'idle'
let detail = ''
let running = false
let revision = 0
const clients = new Set()

function snapshot() {
  return {
    ok: true,
    version: 1,
    revision,
    at: Date.now(),
    waitingAfterMs: 45000,
    focus: SESSION,
    sessions: [{
      id: SESSION,
      title: '桌宠联调',
      cwd: '/Users/kiana/Downloads/code',
      running,
      phase,
      detail,
      updatedAt: Date.now(),
    }],
  }
}

function publish() {
  revision += 1
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of clients) res.write(payload)
}

const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    res.writeHead(401).end('{"ok":false}')
    return
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/v1/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot()))
    return
  }
  if (url.pathname === '/v1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname === '/v1/prompt') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const args = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      console.log(`prompt: session=${args.sessionId} mode=${args.mode} text=${JSON.stringify(args.text)}`)
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, requestId: 'mock-1', sessionId: args.sessionId, mode: args.mode }))
    })
    return
  }
  res.writeHead(404).end('{"ok":false}')
})

const script = [
  { after: 1200, phase: 'thinking', detail: '正在读 src/main/index.js', running: true },
  { after: 2600, phase: 'tool', detail: 'bash', running: true },
  { after: 4200, phase: 'thinking', detail: '正在整理结论', running: true },
  { after: 6000, phase: 'done', detail: '已完成：桌宠外壳接入成功', running: false },
]

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  const dir = join(HOME, 'live2d-pet')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bridge.json'), `${JSON.stringify({
    version: 1,
    name: 'dsh-live2d-pet',
    port,
    secret: SECRET,
    pid: process.pid,
    startedAt: Date.now(),
  }, null, 2)}\n`, { mode: 0o600 })
  console.log(`mock bridge on 127.0.0.1:${port} (home ${HOME})`)

  for (const step of script) {
    setTimeout(() => {
      phase = step.phase
      detail = step.detail
      running = step.running
      publish()
      console.log(`phase -> ${phase} (${detail})`)
    }, step.after)
  }

  // Stay up until killed; the smoke test tears us down.
  if (process.argv.includes('--exit-after-script')) {
    setTimeout(() => process.exit(0), SCRIPT_MS + 2000)
  }
})

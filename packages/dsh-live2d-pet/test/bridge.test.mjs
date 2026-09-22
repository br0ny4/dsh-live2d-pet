/**
 * Verification for the plugin's Host half.
 *
 * Drives `apply(ctx, config)` with a mock Cordis context, so the loopback
 * bridge can be exercised without booting a harness: discovery file, bearer
 * auth, state derivation from the real Host event names and listener
 * signatures, SSE pushes, prompt forwarding, and teardown.
 *
 * Two details the mock must get right, because getting them wrong is how the
 * first version of this bridge shipped broken:
 *   - `session/event`'s listener contract is `(session, event)`; the durable
 *     event carries no session id, so identity comes from the emitting session.
 *   - `agent/error` / `turn/end` must not leave a stale assistant line on
 *     screen — the phase decides which fact the pet shows.
 *
 *   node packages/dsh-live2d-pet/test/bridge.test.mjs
 *   DSH_HOME=/tmp/somewhere node ...    # to put the discovery file elsewhere
 */
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'lib', 'index.js')

/**
 * Always work in a throwaway home. Inheriting `DSH_HOME` would point this test
 * at the developer's real harness — it removes and rewrites `bridge.json`
 * there, which would pull the discovery file out from under a running shell.
 * `PET_TEST_HOME` is the explicit opt-in for debugging against a real one.
 */
process.env.DSH_HOME = process.env.PET_TEST_HOME
  ?? await mkdtemp(join(tmpdir(), 'dsh-pet-test-'))
const HOME = process.env.DSH_HOME
const DISCOVERY = join(HOME, 'live2d-pet', 'bridge.json')

/** Short windows so the stalled/linger transitions are testable in real time. */
const CONFIG = { waitingAfterMs: 400, phaseLingerMs: 600 }

let failures = 0
function check(label, condition, extra) {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : `  ${extra}`}`)
}

const listeners = new Map()
const disposers = []
const promptCalls = []

const ctx = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  },
  get(name) {
    if (name !== 'sessionController') return undefined
    return {
      async prompt(request) {
        promptCalls.push(request)
        return { accepted: true }
      },
    }
  },
  effect(factory) {
    const dispose = factory()
    disposers.push(dispose)
    return dispose
  },
  /**
   * Cordis runs the callback only once every named service is present. The mock
   * knows one service, so a `webServer` injection never fires — which is exactly
   * the profile-without-a-web-carrier case that must stay harmless.
   */
  inject(deps, callback) {
    const names = Array.isArray(deps) ? deps : Object.keys(deps)
    if (!names.every((name) => name === 'sessionController')) return () => {}
    callback(this)
    return () => {}
  },
}

function emit(name, ...args) {
  for (const fn of listeners.get(name) || []) fn(...args)
}

const { apply } = await import(PLUGIN)

console.log(`home: ${HOME}\n`)
await rm(join(HOME, 'live2d-pet'), { recursive: true, force: true })
apply(ctx, CONFIG)

// ---- discovery ------------------------------------------------------------
let bridge = null
for (let i = 0; i < 60 && bridge === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    bridge = JSON.parse(await readFile(DISCOVERY, 'utf8'))
  } catch {
    /* not written yet */
  }
}
check('discovery file published', bridge !== null)
check('discovery advertises a loopback port', bridge && bridge.port > 0, bridge && `port=${bridge.port}`)
check('discovery carries a 64-char secret', bridge && bridge.secret.length === 64)
check('discovery records the pid', bridge && bridge.pid === process.pid)

const base = `http://127.0.0.1:${bridge.port}`
const auth = { authorization: `Bearer ${bridge.secret}` }
const stateOf = async () => (await fetch(`${base}/v1/state`, { headers: auth })).json()

// ---- auth -----------------------------------------------------------------
check('unauthenticated request is refused', (await fetch(`${base}/v1/state`)).status === 401)
check('wrong secret is refused', (await fetch(`${base}/v1/state`, {
  headers: { authorization: 'Bearer nope' },
})).status === 401)
check('unknown route 404s', (await fetch(`${base}/v1/nope`, { headers: auth })).status === 404)

const emptyState = await stateOf()
check('empty state is well formed', emptyState.ok === true && Array.isArray(emptyState.sessions))

// ---- live pushes ----------------------------------------------------------
const sse = await fetch(`${base}/v1/events`, { headers: auth })
const reader = sse.body.getReader()
const decoder = new TextDecoder()
let sseBuffer = ''
let pushes = 0

async function drainPushes(timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const index = sseBuffer.indexOf('\n\n')
    if (index >= 0) {
      const frame = sseBuffer.slice(0, index)
      sseBuffer = sseBuffer.slice(index + 2)
      const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
      if (line) {
        pushes += 1
        JSON.parse(line.slice(6))
      }
      continue
    }
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true }), 60)),
    ])
    if (!chunk.done) sseBuffer += decoder.decode(chunk.value, { stream: true })
  }
}

await drainPushes(300)
check('SSE sends an opening snapshot', pushes >= 1, `pushes=${pushes}`)

// ---- state derivation -----------------------------------------------------
const S = 'session-aaaa-bbbb-cccc-1111'
const session = { id: S }

emit('agent/status', { agent: { id: S }, status: 'running' })
let state = await stateOf()
check('running status reaches the pet', state.sessions[0] && state.sessions[0].phase === 'thinking',
  state.sessions[0] && `phase=${state.sessions[0].phase}`)
check('focused session is reported', state.focus === S)

emit('session/event', session, { type: 'tool/call', seq: 2, data: { name: 'bash' } })
state = await stateOf()
check('tool call becomes the "tool" phase', state.sessions[0].phase === 'tool')
check('tool name is surfaced as detail', state.sessions[0].detail === 'bash')

emit('session/event', session, {
  type: 'assistant/message',
  seq: 3,
  data: { message: { content: [{ type: 'text', text: '正在检查仓库结构' }] } },
})
state = await stateOf()
check('assistant text is captured', state.sessions[0].detail === '正在检查仓库结构')

emit('session/event', session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'error' } } })
state = await stateOf()
check('failed turn shows the error phase', state.sessions[0].phase === 'error')
check('the error replaces the stale assistant line', state.sessions[0].detail !== '正在检查仓库结构',
  `detail=${state.sessions[0].detail}`)

emit('session/event', session, { type: 'turn/start', seq: 5, data: { turn: 2 } })
emit('agent/status', { agent: { id: S }, status: 'idle' })
emit('session/event', session, { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'completed' } } })
state = await stateOf()
check('completed turn shows the done phase', state.sessions[0].phase === 'done',
  `phase=${state.sessions[0].phase}`)

// A running session that goes quiet must read as stalled, not busy.
emit('agent/status', { agent: { id: S }, status: 'running' })
check('a freshly running session reads as thinking', (await stateOf()).sessions[0].phase === 'thinking')
await new Promise((resolve) => setTimeout(resolve, CONFIG.waitingAfterMs + 250))
check('a silent running session decays to "waiting" (搁置)',
  (await stateOf()).sessions[0].phase === 'waiting',
  `phase=${(await stateOf()).sessions[0].phase}`)

// A terminal phase must not stick forever.
emit('agent/status', { agent: { id: S }, status: 'idle' })
emit('session/event', session, { type: 'turn/end', seq: 7, data: { turn: 3, reason: { kind: 'completed' } } })
check('done is visible right after the turn', (await stateOf()).sessions[0].phase === 'done')
await new Promise((resolve) => setTimeout(resolve, CONFIG.phaseLingerMs + 250))
check('done decays back to idle', (await stateOf()).sessions[0].phase === 'idle',
  `phase=${(await stateOf()).sessions[0].phase}`)

emit('agent/error', { agent: { id: S }, turn: 1, step: 1, error: new Error('boom') })
state = await stateOf()
check('agent/error shows the error phase with a message',
  state.sessions[0].phase === 'error' && state.sessions[0].detail === 'boom',
  `detail=${state.sessions[0].detail}`)

const beforePushes = pushes
await drainPushes(300)
check('every transition was pushed over SSE without polling', pushes > beforePushes,
  `${pushes - beforePushes} new push(es)`)

// ---- characters -----------------------------------------------------------
const characterIndex = await (await fetch(`${base}/v1/characters`, { headers: auth })).json()
check('character registry is listed', characterIndex.ok === true && characterIndex.characters.length >= 1,
  `${characterIndex.characters ? characterIndex.characters.length : 0} character(s)`)
check('the built-in character is present',
  characterIndex.characters.some((entry) => entry.id === 'whale-maid' && entry.builtin === true))

const whaleMaid = await (await fetch(`${base}/v1/characters/whale-maid`, { headers: auth })).json()
check('a character loads with its rig', whaleMaid.ok === true && Array.isArray(whaleMaid.rig.influences),
  whaleMaid.rig ? `${whaleMaid.rig.influences.length} influences` : '')
check('the character sprite is real bytes', typeof whaleMaid.sprite === 'string' && whaleMaid.sprite.length > 1000,
  whaleMaid.sprite ? `${Math.round(whaleMaid.sprite.length / 1024)} KB base64` : '')
check('the rig names the motions the renderer drives',
  whaleMaid.rig.influences.some((inf) => inf.motion === 'blink')
  && whaleMaid.rig.influences.some((inf) => inf.motion === 'talk'))

const gugu = await (await fetch(`${base}/v1/characters/gugu`, { headers: auth })).json()
check('the atlas character loads with its playback spec',
  gugu.ok === true && gugu.manifest.kind === 'atlas'
  && typeof gugu.atlas === 'string' && gugu.atlas.length > 10000
  && gugu.animations.idle && gugu.animations.sleep && gugu.grid.cellWidth === 192,
  gugu.ok ? `kind=${gugu.manifest.kind} atlas=${Math.round((gugu.atlas || '').length / 1024)}KB` : '')
check('an atlas character carries no mesh rig',
  gugu.ok && gugu.rig === null && gugu.sprite === null)

const missing = await fetch(`${base}/v1/characters/does-not-exist`, { headers: auth })
check('an unknown character 404s', missing.status === 404, `status=${missing.status}`)
check('characters are behind the same bearer gate',
  (await fetch(`${base}/v1/characters`)).status === 401)

// ---- prompting ------------------------------------------------------------
check('malformed prompt body is rejected',
  (await fetch(`${base}/v1/prompt`, { method: 'POST', headers: auth, body: '{oops' })).status === 400)

const emptyText = await (await fetch(`${base}/v1/prompt`, {
  method: 'POST', headers: auth, body: JSON.stringify({ sessionId: S, text: '   ' }),
})).json()
check('blank prompt is refused', emptyText.ok === false && /为空/.test(emptyText.error))

const noSession = await (await fetch(`${base}/v1/prompt`, {
  method: 'POST', headers: auth, body: JSON.stringify({ sessionId: '', text: 'hi' }),
})).json()
check('prompt without a session is refused', noSession.ok === false)

const posted = await (await fetch(`${base}/v1/prompt`, {
  method: 'POST', headers: auth, body: JSON.stringify({ sessionId: S, text: '跑一下测试', mode: 'queue' }),
})).json()
check('prompt is accepted', posted.ok === true, JSON.stringify(posted))
check('prompt reaches sessionController.prompt', promptCalls.length === 1)
check('prompt carries the session and text',
  promptCalls[0] && promptCalls[0].sessionId === S && promptCalls[0].content[0].text === '跑一下测试')
check('prompt carries a stable requestId', promptCalls[0] && /^dsh-pet-/.test(promptCalls[0].requestId),
  promptCalls[0] && promptCalls[0].requestId)
check('prompt defaults to queue mode', promptCalls[0] && promptCalls[0].mode === 'queue')

await fetch(`${base}/v1/prompt`, {
  method: 'POST', headers: auth, body: JSON.stringify({ sessionId: S, text: '打断', mode: 'steer' }),
})
check('steer mode is forwarded', promptCalls[1] && promptCalls[1].mode === 'steer')

// ---- teardown -------------------------------------------------------------
for (const dispose of disposers) await dispose()
await new Promise((resolve) => setTimeout(resolve, 150))
let stillThere = true
try {
  await readFile(DISCOVERY)
} catch {
  stillThere = false
}
check('discovery file is removed on unload', stillThere === false)

let refused = false
try {
  await fetch(`${base}/v1/state`, { headers: auth })
} catch {
  refused = true
}
check('bridge stops listening after unload', refused)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

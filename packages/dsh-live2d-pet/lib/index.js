/**
 * Host half of `dsh-live2d-pet`.
 *
 * The in-page pet needs nothing from the Host: it renders into `shell.overlay`
 * and prompts through the Client `sessions` service. This half exists for the
 * *other* mode — a desktop pet that lives outside the harness window, as a
 * transparent always-on-top Electron window.
 *
 * A browser page cannot draw outside itself, so the desktop pet needs a way to
 * observe and drive the harness from another process. Rather than reverse
 * engineering the web app's authenticated RPC, this half publishes a small,
 * explicitly-scoped bridge:
 *
 *   loopback HTTP on 127.0.0.1:<ephemeral port>, every request gated by a
 *   per-process random bearer secret, advertised through a 0600 discovery file
 *   under $DSH_HOME/live2d-pet/bridge.json
 *
 * The external shell reads that file, calls `/v1/state` for the current picture
 * and opens `/v1/events` for live pushes, so the pet can show "thinking",
 * "running tool X", "waiting", "done" and "failed" as they happen.
 *
 * Scope and safety notes:
 *   - the socket binds loopback only and refuses any request without the secret;
 *   - the state it exposes is the same session metadata the GUI already shows;
 *   - prompting goes through `sessionController.prompt`, i.e. exactly the path
 *     the browser composer uses, so nothing bypasses approval or policy;
 *   - everything is torn down — server closed, discovery file unlinked — when
 *     the plugin unloads.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listCharacters, loadCharacter, userCharacterRoot } from './characters.js'

/** Same-origin path the in-page pet fetches its characters from. */
const CHARACTER_ROUTE = '/dsh-live2d-pet/characters'

const BRIDGE_VERSION = 1
/** A running session with no event for this long reads as stalled/waiting. */
const DEFAULT_WAITING_AFTER_MS = 45_000
/** How long a terminal phase (done/failed) stays on screen before going idle. */
const DEFAULT_PHASE_LINGER_MS = 20_000

function bridgeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'live2d-pet')
}

/** Coarse visual phase the desktop pet renders. */
function derivePhase(entry, now, waitingAfterMs, phaseLingerMs) {
  if (!entry) return 'idle'
  if (entry.phase === 'error' && now - entry.phaseAt < phaseLingerMs) return 'error'
  if (entry.running) {
    if (now - entry.lastEventAt > waitingAfterMs) return 'waiting'
    return entry.toolName ? 'tool' : 'thinking'
  }
  if (entry.phase === 'done' && now - entry.phaseAt < phaseLingerMs) return 'done'
  return 'idle'
}

export function apply(ctx, config) {
  const waitingAfterMs = Number(config?.waitingAfterMs) > 0 ? Number(config.waitingAfterMs) : DEFAULT_WAITING_AFTER_MS
  const phaseLingerMs = Number(config?.phaseLingerMs) > 0 ? Number(config.phaseLingerMs) : DEFAULT_PHASE_LINGER_MS
  /** Per-session observation, all of it derived from durable host facts. */
  const entries = new Map()
  /** Focused session: whichever session most recently did something. */
  let focus = null
  let revision = 0
  const clients = new Set()

  function entryFor(sessionId) {
    let entry = entries.get(sessionId)
    if (entry === undefined) {
      entry = {
        sessionId,
        running: false,
        toolName: null,
        phase: 'idle',
        phaseAt: 0,
        lastEventAt: 0,
        lastText: '',
        lastError: null,
        turn: 0,
        updatedAt: 0,
        title: '',
        cwd: null,
      }
      entries.set(sessionId, entry)
    }
    return entry
  }

  function publish() {
    revision += 1
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {
        clients.delete(res)
      }
    }
  }

  /** Which fact the pet should put on screen for a given phase. */
  function detailFor(entry, phase) {
    if (phase === 'error') return entry.lastError || entry.toolName || entry.lastText || ''
    if (phase === 'tool' || phase === 'thinking' || phase === 'waiting') {
      return entry.toolName || entry.lastText || ''
    }
    return entry.lastText || entry.lastError || ''
  }

  /** Read only leaf fields; never hand a live Session/Agent object outward. */
  function sessionRows() {
    const now = Date.now()
    const rows = []
    for (const entry of entries.values()) {
      const phase = derivePhase(entry, now, waitingAfterMs, phaseLingerMs)
      rows.push({
        id: String(entry.sessionId),
        title: entry.title,
        cwd: entry.cwd,
        running: entry.running === true,
        phase,
        detail: detailFor(entry, phase),
        updatedAt: entry.updatedAt,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }

  function snapshot() {
    const sessions = sessionRows()
    const focused = focus === null ? sessions[0] || null : sessions.find((row) => row.id === focus) || sessions[0] || null
    return {
      ok: true,
      version: BRIDGE_VERSION,
      revision,
      at: Date.now(),
      waitingAfterMs,
      focus: focused ? focused.id : null,
      sessions,
    }
  }

  // ---- observation -------------------------------------------------------

  ctx.on('agent/status', (payload) => {
    const sessionId = payload && payload.agent ? payload.agent.id : undefined
    if (sessionId === undefined) return
    const entry = entryFor(sessionId)
    entry.running = payload.status === 'running'
    entry.lastEventAt = Date.now()
    if (entry.running) {
      entry.phase = 'thinking'
      entry.toolName = null
    }
    focus = String(sessionId)
    publish()
  })

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    // The listener contract is `(session, event)`: the durable event itself
    // carries no session id, so identity comes from the emitting session.
    const sessionId = (session && session.id) !== undefined ? session.id : event.sessionId
    if (sessionId === undefined) return
    const entry = entryFor(sessionId)
    const now = Date.now()
    entry.lastEventAt = now
    focus = String(sessionId)

    switch (event.type) {
      case 'turn/start':
        entry.running = true
        entry.phase = 'thinking'
        entry.toolName = null
        entry.lastError = null
        entry.turn = Number(event.data && event.data.turn) || entry.turn
        break
      case 'tool/call':
        entry.phase = 'thinking'
        entry.toolName = typeof event.data?.name === 'string' ? event.data.name : null
        break
      case 'assistant/message': {
        const message = event.data && event.data.message
        const content = message && Array.isArray(message.content) ? message.content : []
        let text = ''
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
        }
        if (text !== '') entry.lastText = text.slice(-400)
        entry.toolName = null
        break
      }
      case 'turn/end': {
        const reason = event.data && event.data.reason ? event.data.reason.kind : 'completed'
        entry.turn = Number(event.data && event.data.turn) || entry.turn
        entry.toolName = null
        entry.running = false
        entry.phaseAt = now
        entry.phase = reason === 'completed' ? 'done' : 'error'
        if (reason !== 'completed') entry.lastError = `回合结束：${reason}`
        break
      }
      default:
        break
    }
    publish()
  })

  ctx.on('agent/error', (payload) => {
    const sessionId = payload && payload.agent ? payload.agent.id : undefined
    if (sessionId === undefined) return
    const entry = entryFor(sessionId)
    entry.phase = 'error'
    entry.phaseAt = Date.now()
    entry.toolName = null
    const error = payload.error
    entry.lastError = String((error && error.message) || error || '未知错误').slice(0, 300)
    publish()
  })

  ctx.on('api-session/error', (sessionId, message) => {
    const entry = entryFor(sessionId)
    entry.phase = 'error'
    entry.phaseAt = Date.now()
    entry.lastError = String(message || '').slice(0, 300)
    publish()
  })

  ctx.on('api-session/added', (summary) => {
    if (!summary || summary.sessionId === undefined) return
    const entry = entryFor(summary.sessionId)
    if (typeof summary.updatedAt === 'number') entry.updatedAt = summary.updatedAt
    if (typeof summary.cwd === 'string') entry.cwd = summary.cwd
    publish()
  })

  ctx.on('api-session/activity', (sessionId, updatedAt) => {
    const entry = entryFor(sessionId)
    entry.updatedAt = Number(updatedAt) || Date.now()
    publish()
  })

  // ---- prompting ---------------------------------------------------------

  async function prompt(args) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) return { ok: false, error: 'sessionController 未挂载' }
    const text = typeof args?.text === 'string' ? args.text.trim() : ''
    const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
    const mode = args?.mode === 'steer' ? 'steer' : 'queue'
    if (text === '') return { ok: false, error: '指令为空' }
    if (sessionId === '') return { ok: false, error: '没有选中会话' }
    const requestId = `dsh-pet-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    try {
      await controller.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text }] })
      return { ok: true, requestId, sessionId, mode }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  // ---- character registry -------------------------------------------------

  /** Plain JSON only: the manifest's leaf fields, never a live object. */
  async function characterIndex() {
    const characters = await listCharacters()
    return {
      ok: true,
      characters: characters.map(({ id, name, description, author, license, builtin }) => ({
        id, name, description, author, license, builtin: builtin === true,
      })),
      userRoot: userCharacterRoot(),
    }
  }

  async function characterPayload(id) {
    const character = await loadCharacter(id)
    if (character === null) return { ok: false, error: `unknown character: ${id}` }
    return { ok: true, manifest: character.manifest, rig: character.rig, sprite: character.sprite }
  }

  function sendJson(res, status, body, cacheable) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': cacheable ? 'private, max-age=300' : 'no-store',
    })
    res.end(payload)
  }

  // The in-page pet cannot reach the loopback bridge — a page can only fetch
  // its own origin — so the same two routes are also published on the harness's
  // own web carrier. Same-origin, loopback-bound, and serving nothing but
  // character art, which ships publicly in this package anyway.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: CHARACTER_ROUTE,
      handler: async (req, res) => {
        try {
          const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
          if (path === CHARACTER_ROUTE || path === `${CHARACTER_ROUTE}/`) {
            sendJson(res, 200, await characterIndex(), false)
            return
          }
          const id = decodeURIComponent(path.slice(CHARACTER_ROUTE.length + 1))
          const payload = await characterPayload(id)
          sendJson(res, payload.ok ? 200 : 404, payload, payload.ok)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }, false)
        }
      },
    }), 'live2d-pet: character route')
  }

  // ---- the bridge itself -------------------------------------------------

  const secret = randomBytes(32).toString('hex')
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${secret}`
    const send = (status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
    }
    if (!authorized) {
      send(401, { ok: false, error: 'unauthorized' })
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/state') {
      send(200, snapshot())
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/characters') {
      characterIndex().then(
        (index) => send(200, index),
        (error) => send(200, { ok: false, error: String((error && error.message) || error) }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/characters/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/characters/'.length))
      characterPayload(id).then(
        (payload) => send(payload.ok ? 200 : 404, payload),
        (error) => send(200, { ok: false, error: String((error && error.message) || error) }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/prompt') {
      const chunks = []
      let bytes = 0
      req.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', async () => {
        let args = null
        try {
          args = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          send(400, { ok: false, error: 'bad json' })
          return
        }
        send(200, await prompt(args))
      })
      return
    }
    send(404, { ok: false, error: 'not found' })
  })

  ctx.effect(() => {
    let closed = false
    server.listen(0, '127.0.0.1', async () => {
      if (closed) return
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const dir = bridgeDir()
      const file = join(dir, 'bridge.json')
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, `${JSON.stringify({
          version: BRIDGE_VERSION,
          name: 'dsh-live2d-pet',
          port,
          secret,
          pid: process.pid,
          startedAt: Date.now(),
        }, null, 2)}\n`, { mode: 0o600 })
        console.log(`[dsh-live2d-pet] desktop bridge on 127.0.0.1:${port} (${file})`)
      } catch (error) {
        console.error(`[dsh-live2d-pet] could not publish the discovery file: ${String(error && error.message || error)}`)
      }
    })
    return async () => {
      closed = true
      for (const res of clients) {
        try {
          res.end()
        } catch {
          /* the client is already gone */
        }
      }
      clients.clear()
      await new Promise((resolve) => server.close(resolve))
      await rm(join(bridgeDir(), 'bridge.json'), { force: true })
    }
  }, 'live2d-pet: loopback bridge')
}

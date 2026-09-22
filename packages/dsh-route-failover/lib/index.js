/**
 * dsh-route-failover — keep turns alive when api.deepseek.com is unreachable.
 *
 * Why this exists (measured, not guessed):
 *
 *   - On this network, connections to api.deepseek.com fail in bursty windows
 *     with `ECONNRESET` — fresh sockets, <1s, sometimes 100% of attempts for
 *     minutes. baidu.com in the same second is fine.
 *   - Connecting to the *same IP* with a different TLS SNI completes the
 *     handshake. The reset is selective by SNI, which is the fingerprint of an
 *     SNI-aware middlebox on the path (the route to DeepSeek crosses carrier
 *     boundaries; the local control destinations do not).
 *   - No finite retry budget can absorb that: an outage window can outlast any
 *     backoff schedule, and every failed turn is a lost step.
 *
 * What this plugin does:
 *
 *   1. watches `agent/request-error`; after `threshold` consecutive TRANSPORT
 *      failures on one session it switches that session's model to a fallback
 *      route — normally a LAN/local endpoint that never crosses that path;
 *   2. while a session is degraded it periodically probes api.deepseek.com;
 *      two consecutive healthy probes switch the session back to the route it
 *      had before, so recovery needs no manual action;
 *   3. it never intercepts a failure that is not TRANSPORT — rate limits,
 *      auth errors, quota and so on keep their ordinary semantics.
 *
 * The switch uses `sessionController.selectModel`, the same API the UI uses,
 * so the change is visible in the model selector and recorded normally.
 */

const DEFAULT_FALLBACK = { provider: 'vllm', model: 'qwen3.8-27b' }
const PROBE_URL = 'https://api.deepseek.com/'
const PROBE_TIMEOUT_MS = 5000

export const inject = ['timer']

function pick(value, fallback) {
  return value === undefined ? fallback : value
}

export function apply(ctx, config = {}) {
  const threshold = Math.max(1, Number(config.threshold) || 3)
  const fallback = config.fallback
    && typeof config.fallback.provider === 'string' && typeof config.fallback.model === 'string'
    ? config.fallback
    : DEFAULT_FALLBACK
  const probeIntervalMs = Math.max(5000, Number(config.probeIntervalMs) || 60_000)
  const restore = pick(config.restore, true)

  /** sessionId -> { count, degraded, previous, healthy } */
  const sessions = new Map()
  const controller = ctx.get('sessionController')

  function record(sessionId) {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { count: 0, degraded: false, previous: null, healthy: 0 }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /**
   * The route a session is actually running on, read from its own log: the
   * newest `request/header` event carries the frozen call config. Leaf fields
   * only — nothing live ever leaves this function.
   */
  async function currentRoute(sessionId) {
    if (controller === undefined) return null
    try {
      const inspection = await controller.inspect(sessionId)
      const events = Array.isArray(inspection && inspection.events) ? inspection.events : []
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        const header = event && event.type === 'request/header' && event.data && event.data.header
        if (header && header.config && typeof header.config.provider === 'string' && typeof header.config.model === 'string') {
          return { provider: header.config.provider, model: header.config.model }
        }
      }
    } catch {
      /* a cold session has no log yet; the caller falls back to the default */
    }
    return null
  }

  async function degrade(agent, entry) {
    if (controller === undefined) {
      console.error('[dsh-route-failover] sessionController is not mounted; cannot switch route')
      return
    }
    if (entry.degraded) return
    try {
      entry.previous = (await currentRoute(agent.id)) || entry.previous
      entry.degraded = true
      entry.healthy = 0
      await controller.selectModel({
        sessionId: agent.id,
        provider: fallback.provider,
        model: fallback.model,
      })
      console.log(`[dsh-route-failover] session ${agent.id} degraded to ${fallback.provider}/${fallback.model} after ${entry.count} TRANSPORT failures`)
    } catch (error) {
      console.error(`[dsh-route-failover] could not switch ${agent.id}: ${String((error && error.message) || error)}`)
      entry.degraded = false
    }
  }

  async function restoreSession(sessionId, entry) {
    if (controller === undefined || entry.previous === null) return
    const previous = entry.previous
    try {
      await controller.selectModel({
        sessionId,
        provider: previous.provider,
        model: previous.model,
      })
      entry.degraded = false
      entry.count = 0
      entry.healthy = 0
      console.log(`[dsh-route-failover] session ${sessionId} restored to ${previous.provider}/${previous.model}`)
    } catch (error) {
      console.error(`[dsh-route-failover] could not restore ${sessionId}: ${String((error && error.message) || error)}`)
    }
  }

  async function probePrimary() {
    const controllerProbe = new AbortController()
    const timer = setTimeout(() => controllerProbe.abort(), PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(PROBE_URL, { signal: controllerProbe.signal, redirect: 'follow' })
      return response.status < 500
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- observation --------------------------------------------------------

  ctx.on('agent/request-error', async (payload, next) => {
    const decision = await next()
    if (!payload || !payload.failure || !payload.agent) return decision
    const sessionId = payload.agent.id
    if (sessionId === undefined) return decision

    const entry = record(sessionId)
    if (payload.failure.code === 'TRANSPORT' && !entry.degraded) {
      entry.count += 1
      if (entry.count >= threshold) await degrade(payload.agent, entry)
    } else if (payload.failure.code !== 'TRANSPORT') {
      entry.count = 0
    }
    return decision
  })

  ctx.on('agent/status', (payload) => {
    if (payload && payload.status === 'idle' && payload.agent) {
      const entry = sessions.get(payload.agent.id)
      if (entry && !entry.degraded) entry.count = 0
    }
  })

  // ---- recovery probe ------------------------------------------------------

  if (restore && controller !== undefined) {
    ctx.effect(() => {
      let running = true
      ;(async () => {
        while (running) {
          await new Promise((resolve) => ctx.timeout(resolve, probeIntervalMs))
          if (!running) break
          const degraded = [...sessions.entries()].filter(([, entry]) => entry.degraded)
          if (degraded.length === 0) continue
          const healthy = await probePrimary()
          for (const [sessionId, entry] of degraded) {
            entry.healthy = healthy ? entry.healthy + 1 : 0
            if (entry.healthy >= 2) await restoreSession(sessionId, entry)
          }
        }
      })()
      return () => {
        running = false
      }
    }, 'route-failover: recovery probe')
  }

  console.log(`[dsh-route-failover] armed: ${threshold} TRANSPORT failures -> ${fallback.provider}/${fallback.model}${restore ? ', auto-restore on' : ''}`)
}

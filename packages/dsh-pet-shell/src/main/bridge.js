/**
 * Client for the loopback bridge published by the `dsh-live2d-pet` Host half.
 *
 * The shell never talks to the harness's web app; it reads the discovery file
 * the plugin writes under `$DSH_HOME/live2d-pet/bridge.json`, then speaks the
 * plugin's own tiny HTTP surface. That keeps the shell independent of DSH's
 * authenticated RPC and of any particular harness version.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BRIDGE_VERSION = 1
/** Refuse a discovery file older than this: it belongs to a dead process. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function bridgeFile(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(home, 'live2d-pet', 'bridge.json')
}

/** Read and shape-check the discovery file. Returns null when unusable. */
export async function readDiscovery(home) {
  try {
    const raw = JSON.parse(await readFile(bridgeFile(home), 'utf8'))
    if (raw.version !== BRIDGE_VERSION) return null
    if (typeof raw.port !== 'number' || raw.port <= 0) return null
    if (typeof raw.secret !== 'string' || raw.secret.length < 16) return null
    if (typeof raw.startedAt === 'number' && Date.now() - raw.startedAt > STALE_AFTER_MS) return null
    return raw
  } catch {
    return null
  }
}

async function request(discovery, path, init = {}, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${discovery.secret}`,
        ...(init.headers || {}),
      },
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, error: `bad response (${response.status})` }
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

export const fetchState = (discovery) => request(discovery, '/v1/state')

/** The characters the harness can offer, newest selection included. */
export const fetchCharacters = (discovery) => request(discovery, '/v1/characters')

/** One character's manifest, rig and sprite (base64 PNG). */
export const fetchCharacter = (discovery, id) =>
  request(discovery, `/v1/characters/${encodeURIComponent(id)}`, {}, 8000)

export const sendPrompt = (discovery, args) => request(discovery, '/v1/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(args),
}, 8000)

/** Quick liveness probe used while deciding whether to attach or to spawn. */
export async function probe(discovery) {
  const state = await fetchState(discovery)
  return state && state.ok === true ? state : null
}

/**
 * Follow the bridge's live state feed.
 *
 * @param discovery - discovery record from {@link readDiscovery}.
 * @param onState - called with each pushed snapshot.
 * @param onLost - called when the stream ends, so the caller can re-attach.
 * @returns a stop function.
 */
export function follow(discovery, onState, onLost) {
  const controller = new AbortController()
  let stopped = false

  ;(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/events`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${discovery.secret}` },
      })
      if (!response.ok || !response.body) throw new Error(`bridge stream failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
          if (line) {
            try {
              onState(JSON.parse(line.slice(6)))
            } catch {
              /* a malformed frame is not worth dropping the stream for */
            }
          }
          index = buffer.indexOf('\n\n')
        }
      }
      if (!stopped) onLost('stream ended')
    } catch (error) {
      if (!stopped) onLost(String((error && error.message) || error))
    }
  })()

  return () => {
    stopped = true
    controller.abort()
  }
}

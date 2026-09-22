/**
 * Reproduce the DeepSeek API TRANSPORT failures and capture the real errno.
 *
 * The harness's own retry events record only `message` + `code`, so the
 * underlying cause has never been visible. This drives the exact same call
 * pattern the agent does — a short burst of requests, then an idle gap — with
 * Node's global fetch, and prints `error.cause` for every failure.
 *
 * The keep-alive hypothesis: undici pools sockets, and a middlebox that drops
 * idle connections leaves the pool holding dead sockets. The next burst then
 * fails *fast* (a reset on a reused socket) rather than timing out, and recovers
 * once fresh sockets are opened — which is exactly the "clustered, <1s, then
 * self-heals" signature in the session logs.
 *
 *   DEEPSEEK_KEY=... node /tmp/repro-transport.mjs [rounds] [gapSeconds]
 */
import { readFileSync } from 'node:fs'

const KEY = process.env.DEEPSEEK_KEY || readFileSync('/tmp/dskey.txt', 'utf8').trim()

// The hypothesis under test: pooled keep-alive sockets go stale behind a
// middlebox, and reusing one fails instantly with ECONNRESET. Closing idle
// sockets immediately should remove the failure entirely.
if (process.env.STABLE === '1') {
  const { Agent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }))
  console.log('dispatcher: keep-alive effectively disabled')
}
const ROUNDS = Number(process.argv[2] || 8)
const GAP_SECONDS = Number(process.argv[3] || 12)
const BURST = 3

const body = JSON.stringify({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
})

async function one(label, init = {}) {
  const started = Date.now()
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body,
      ...init,
    })
    await response.text()
    const ms = Date.now() - started
    return { ok: response.ok, status: response.status, ms }
  } catch (error) {
    const cause = error.cause
    return {
      ok: false,
      ms: Date.now() - started,
      message: error.message,
      causeName: cause && cause.name,
      causeCode: cause && cause.code,
      causeMessage: cause && String(cause.message).slice(0, 120),
      errno: cause && cause.errno,
      syscall: cause && cause.syscall,
      address: cause && cause.address,
      port: cause && cause.port,
    }
  }
}

const failures = []
const successes = []
console.log(`burst=${BURST} gap=${GAP_SECONDS}s rounds=${ROUNDS}  (${new Date().toISOString()})\n`)

for (let round = 1; round <= ROUNDS; round++) {
  const results = []
  for (let i = 0; i < BURST; i++) {
    const result = await one(`r${round}-${i}`)
    results.push(result)
    if (result.ok) successes.push(result)
    else failures.push({ round, index: i, ...result })
  }
  const marks = results.map((r) => (r.ok ? `ok${r.status}/${r.ms}ms` : `FAIL/${r.ms}ms`)).join('  ')
  console.log(`round ${String(round).padStart(2)}  ${marks}`)
  for (const r of results) {
    if (!r.ok) {
      console.log(`         cause=${r.causeCode || r.causeName} errno=${r.errno ?? '-'} syscall=${r.syscall ?? '-'} ${r.causeMessage || r.message}`)
    }
  }
  if (round < ROUNDS) await new Promise((resolve) => setTimeout(resolve, GAP_SECONDS * 1000))
}

console.log(`\n${successes.length} ok, ${failures.length} failed of ${successes.length + failures.length}`)
if (failures.length) {
  const codes = {}
  for (const f of failures) {
    const k = `${f.causeCode || f.causeName || 'unknown'}${f.status ? ` (http ${f.status})` : ''}`
    codes[k] = (codes[k] || 0) + 1
  }
  console.log('failure causes:', JSON.stringify(codes, null, 1))
  const firstInBurst = failures.filter((f) => f.index === 0).length
  console.log(`failures on the first request after an idle gap: ${firstInBurst}/${failures.length}`)
  const fast = failures.filter((f) => f.ms < 1000).length
  console.log(`failures faster than 1s: ${fast}/${failures.length}`)
}

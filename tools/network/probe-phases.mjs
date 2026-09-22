/**
 * Phase-precise failure probe for the DeepSeek RST question.
 *
 * Questions this answers:
 *   1. do FRESH connections fail too (ruling stale-pool in/out), and at which
 *      phase — SYN / handshake / TLS / mid-stream?
 *   2. does baidu fail in the same windows (local network) or never (the
 *      deepseek path specifically)?
 *   3. does the failure depend on the TLS SNI? A device that only RSTs flows
 *      carrying `api.deepseek.com` as SNI is inspecting (DPI), not just
 *      load-shedding.
 *
 * Every attempt uses a brand-new socket (undici Agent with keepAliveTimeout 1).
 *
 *   DEEPSEEK_KEY=... node /tmp/probe-phases.mjs [seconds]
 */
import { readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { Agent, setGlobalDispatcher } from 'undici'

const KEY = process.env.DEEPSEEK_KEY || readFileSync('/tmp/dskey.txt', 'utf8').trim()
const SECONDS = Number(process.argv[2] || 180)

setGlobalDispatcher(new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }))

const deepseek = { host: 'api.deepseek.com', port: 443 }
const baidu = { host: 'baidu.com', port: 443 }

/** One HTTPS request with every phase timed; failures carry the failing phase. */
async function attempt(host, port, { sni = null, path = '/', method = 'GET' } = {}) {
  const t0 = performance.now()
  let phase = 'dns'
  try {
    const url = `https://${host}${path}`
    const headers = {
      'user-agent': 'probe/1',
      ...(KEY && host === 'api.deepseek.com'
        ? { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } : {}),
    }
    const body = host === 'api.deepseek.com' && method === 'POST'
      ? JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
      : undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    phase = 'connect'
    const socket = await new Promise((resolve, reject) => {
      const plain = net.connect({ host, port, servername: sni ?? host })
      const started = performance.now()
      plain.once('error', reject)
      plain.once('connect', () => {
        const tlsSocket = tls.connect({ socket: plain, servername: sni ?? host })
        tlsSocket.once('error', reject)
        tlsSocket.once('secureConnect', () => resolve({ tlsSocket, tcpMs: performance.now() - started }))
      })
    })

    phase = 'write'
    const request = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      body ? `Content-Length: ${Buffer.byteLength(body)}` : '',
      'Connection: close',
      '', '',
    ].join('\r\n') + (body || '')
    await new Promise((resolve, reject) => {
      socket.tlsSocket.write(request, (error) => (error ? reject(error) : resolve()))
    })
    socket.tlsSocket.end?.()

    phase = 'read'
    const response = await new Promise((resolve, reject) => {
      const chunks = []
      socket.tlsSocket.on('data', (chunk) => chunks.push(chunk))
      socket.tlsSocket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.tlsSocket.on('error', reject)
    })
    const ms = Math.round(performance.now() - t0)
    const status = Number(String(response.slice(0, 200)).match(/HTTP\/1\.1 (\d+)/)?.[1] ?? 0)
    return { ok: status > 0, status, ms }
  } catch (error) {
    return {
      ok: false,
      phase,
      ms: Math.round(performance.now() - t0),
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      message: String(error.message).slice(0, 90),
    }
  } finally {
    // the per-attempt timer is cleared implicitly by the 8s abort
  }
}

const stats = { deepseek: { ok: 0, fail: 0 }, baidu: { ok: 0, fail: 0 } }
const phases = {}
const sniResults = { same: { ok: 0, fail: 0 }, swapped: { ok: 0, fail: 0 } }
let index = 0

const deadline = performance.now() + SECONDS * 1000
while (performance.now() < deadline) {
  index++
  const t = new Date().toISOString().slice(11, 19)

  const ds = await attempt(deepseek.host, deepseek.port, { method: 'POST', path: '/chat/completions' })
  if (ds.ok) stats.deepseek.ok++
  else {
    stats.deepseek.fail++
    phases[ds.phase] = (phases[ds.phase] || 0) + 1
  }
  console.log(`${t} deepseek ${ds.ok ? `ok ${ds.status}/${ds.ms}ms` : `FAIL @${ds.phase} ${ds.code || ''} ${ds.errno ?? ''} ${ds.message}`}`)

  // SNI fingerprint: same IP, but pretend the hostname is something else. A
  // DPI middlebox keys on the SNI; a plain flow policer does not.
  const swapped = await attempt('116.169.184.167', 443, { sni: 'www.example.com' })
  if (swapped.ok || swapped.status) sniResults.swapped.ok++
  else sniResults.swapped.fail++
  console.log(`${t} sni-swap ${swapped.ok ? `ok ${swapped.status}/${swapped.ms}ms` : `FAIL @${swapped.phase} ${swapped.code || ''} ${swapped.message}`}`)

  if (index % 3 === 0) {
    const bd = await attempt(baidu.host, 443)
    if (bd.ok) stats.baidu.ok++
    else {
      stats.baidu.fail++
      phases[`baidu-${bd.phase}`] = (phases[`baidu-${bd.phase}`] || 0) + 1
    }
    console.log(`${t} baidu    ${bd.ok ? `ok ${bd.status}/${bd.ms}ms` : `FAIL @${bd.phase} ${bd.code || ''} ${bd.message}`}`)
  }

  await new Promise((resolve) => setTimeout(resolve, 400))
}

console.log('\n=== 汇总 ===')
console.log('deepseek :', JSON.stringify(stats.deepseek), '| phases:', JSON.stringify(phases))
console.log('baidu    :', JSON.stringify(stats.baidu))
console.log('SNI 同   :', JSON.stringify(sniResults.same))
console.log('SNI 换   :', JSON.stringify(sniResults.swapped))

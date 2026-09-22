/**
 * SNI-fingerprint v2: is the RST selective by SNI, by IP, or by protocol?
 *
 * Five probes in the same second, each on a fresh socket:
 *   A  api.deepseek.com:443      real SNI, real request   (the failing case)
 *   B  116.169.184.167:443       SNI example.com          (same IP, fake SNI)
 *   C  58.144.195.181:443        real SNI                 (the second A record)
 *   D  116.169.184.167:80        plain HTTP, no TLS       (no SNI at all)
 *   E  baidu.com:443             control
 *
 *   node probe-sni2.mjs [cycles]
 */
import net from 'node:net'
import tls from 'node:tls'

const CYCLES = Number(process.argv[2] || 40)

function rawConnect(host, port, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('timeout'), { phase: 'connect' })) }, timeout)
    socket.once('error', (error) => { clearTimeout(timer); reject(Object.assign(error, { phase: 'connect' })) })
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
  })
}

/** Probe A/B/C: TLS to a host with a chosen SNI. Reports the last phase reached. */
async function tlsProbe(host, port, sni) {
  try {
    const socket = await rawConnect(host, port)
    const wrapped = tls.connect({ socket, servername: sni })
    await new Promise((resolve, reject) => {
      wrapped.once('secureConnect', resolve)
      wrapped.once('error', reject)
    })
    // Handshake complete: send one line and see whether the peer still talks.
    wrapped.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    await new Promise((resolve, reject) => {
      wrapped.once('data', resolve)
      wrapped.once('error', reject)
      wrapped.once('close', () => reject(Object.assign(new Error('closed after handshake'), { phase: 'read' })))
    })
    wrapped.destroy()
    return { ok: true, phase: 'read' }
  } catch (error) {
    // A cert mismatch means the TLS layer worked — the transport is healthy.
    if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      return { ok: true, phase: 'handshake', note: error.code }
    }
    return { ok: false, phase: error.phase || 'tls', code: error.code || '', message: String(error.message).slice(0, 60) }
  }
}

/** Probe D: plain HTTP on port 80 — no TLS, therefore no SNI anywhere. */
async function httpProbe(host, port) {
  try {
    const socket = await rawConnect(host, port)
    socket.write(`GET / HTTP/1.1\r\nHost: api.deepseek.com\r\nConnection: close\r\n\r\n`)
    const data = await new Promise((resolve, reject) => {
      socket.once('data', resolve)
      socket.once('error', reject)
      socket.once('close', () => reject(Object.assign(new Error('closed before data'), { phase: 'read' })))
    })
    socket.destroy()
    return { ok: true, phase: 'read', firstLine: String(data).split('\r\n')[0] }
  } catch (error) {
    return { ok: false, phase: error.phase || 'connect', code: error.code || '', message: String(error.message).slice(0, 60) }
  }
}

const tally = { A: { ok: 0, fail: 0 }, B: { ok: 0, fail: 0 }, C: { ok: 0, fail: 0 }, D: { ok: 0, fail: 0 }, E: { ok: 0, fail: 0 } }

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  const results = {
    A: await tlsProbe('api.deepseek.com', 443, 'api.deepseek.com'),
    B: await tlsProbe('116.169.184.167', 443, 'www.example.com'),
    C: await tlsProbe('58.144.195.181', 443, 'api.deepseek.com'),
    D: await httpProbe('116.169.184.167', 80),
    E: await tlsProbe('baidu.com', 443, 'baidu.com'),
  }
  const line = []
  for (const [key, r] of Object.entries(results)) {
    tally[key][r.ok ? 'ok' : 'fail']++
    line.push(`${key}:${r.ok ? `ok@${r.phase}${r.note ? `(${r.note})` : ''}` : `FAIL@${r.phase} ${r.code}`}`)
  }
  console.log(`c${String(cycle).padStart(2)}  ${line.join('  ')}`)
}

console.log('\n=== 汇总（ok/fail）===')
for (const [key, t] of Object.entries(tally)) console.log(`${key}  ok=${t.ok} fail=${t.fail}`)
process.exit(0)

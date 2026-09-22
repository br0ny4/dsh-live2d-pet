/**
 * Locating and (when necessary) starting a harness.
 *
 * The shell prefers to attach to a harness that is already running — that is
 * the `dsh web` you are already using in a browser. Only when no bridge
 * answers does it start one of its own, on an OS-chosen port and without
 * opening a second browser tab.
 */
import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from './bridge.js'

/** Candidate `dsh` locations, most explicit first. */
async function findDsh(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)

  const pathEntries = (process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of pathEntries) candidates.push(join(dir, 'dsh'))
  candidates.push('/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', join(homedir(), '.local/bin/dsh'))

  // The pnpm dlx shim `dsh` usually resolves to, when the global one is absent.
  try {
    const dlx = join(homedir(), 'Library', 'Caches', 'pnpm', 'dlx')
    for (const entry of await readdir(dlx)) {
      const bin = join(dlx, entry)
      for (const inner of await readdir(bin)) {
        candidates.push(join(bin, inner, 'node_modules', '.bin', 'dsh'))
      }
    }
  } catch {
    /* no pnpm dlx cache present */
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

export async function resolveDsh(explicit) {
  return findDsh(explicit)
}

/**
 * Start `dsh web` on an ephemeral port and wait for its plugin bridge.
 *
 * Readiness is the bridge discovery file naming this child's pid — that proves
 * the profile actually composed the pet plugin, which is a stronger signal than
 * the HTTP server merely answering.
 *
 * @returns the child process plus the discovery record, or a failure reason.
 */
export async function startHarness({ dshPath, profile = 'web', log = () => {}, timeoutMs = 90_000 }) {
  const executable = await resolveDsh(dshPath)
  if (executable === null) {
    return { ok: false, error: '找不到 dsh 可执行文件，请用 --dsh <路径> 指定，或先安装 dsh' }
  }

  const child = spawn(executable, ['--profile', profile, '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_LAUNCHED_BY: 'dsh-pet-shell' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let url = null
  let stderrTail = ''
  const onChunk = (chunk, isError) => {
    const text = chunk.toString()
    if (isError) {
      stderrTail = (stderrTail + text).slice(-2000)
      return
    }
    const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
    if (match && url === null) {
      url = match[0]
      log(`harness web ui: ${url}`)
    }
  }
  child.stdout.on('data', (chunk) => onChunk(chunk, false))
  child.stderr.on('data', (chunk) => onChunk(chunk, true))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ok: false, error: `dsh 退出（code ${child.exitCode}）：${stderrTail.slice(-400)}`, child }
    }
    const discovery = await readDiscovery()
    if (discovery !== null && discovery.pid === child.pid) {
      return { ok: true, child, discovery, url, dshPath: executable }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  child.kill('SIGTERM')
  return {
    ok: false,
    error: `等待桌宠插件桥超时。请确认 dsh-live2d-pet 已装进 "${profile}" profile：dsh plugin --profile ${profile} add dsh-live2d-pet`,
  }
}

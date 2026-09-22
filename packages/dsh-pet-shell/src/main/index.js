/**
 * dsh-pet-shell — the desktop half of the pet.
 *
 * A plugin can only draw inside the harness window. This process puts the same
 * character on the *system* desktop: one frameless, transparent, always-on-top
 * window that ignores mouse events everywhere except on the character itself,
 * so it floats over your other apps without ever blocking a click.
 *
 * Connection policy (the "auto" mode):
 *   1. look for a bridge published by an already-running harness and attach —
 *      this is the `dsh web` you are already using, sessions and all;
 *   2. otherwise start one (`dsh web --port 0`), then attach to that;
 *   3. if the bridge disappears, retry from step 1 and re-spawn when needed.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell as electronShell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDiscovery, probe, fetchState, fetchCharacters, fetchCharacter, sendPrompt, follow } from './bridge.js'
import { startHarness } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARGS = process.argv.slice(1)
const argValue = (name) => {
  const index = ARGS.indexOf(`--${name}`)
  return index >= 0 && ARGS[index + 1] && !ARGS[index + 1].startsWith('--') ? ARGS[index + 1] : undefined
}
const OPTIONS = {
  dshPath: argValue('dsh'),
  profile: argValue('profile') || 'web',
  attachOnly: ARGS.includes('--attach-only'),
  /** Start on this character instead of the remembered one. */
  character: argValue('character'),
}

/** Dev affordance: render the window to a PNG so the pet can be eyeballed headlessly. */
const SHOT = ARGS.includes('--screenshot') ? (argValue('screenshot') || join(app.getPath('temp'), 'dsh-pet-shot.png')) : null

/** Pet window geometry: wide enough for the bubble, tall enough for both. */
const WINDOW = { width: 340, height: 560, margin: 18 }

let petWindow = null
let tray = null
let stopFollowing = null
let connectTimer = null
let ownedHarness = null
let status = { mode: 'starting', detail: '正在寻找 harness…', attachedPid: null, url: null }
let lastState = null
/** The renderer flips this after the character's first painted frame. */
let canvasPainted = false
/** Character selection, persisted beside the app's other state. */
let characterId = null
let characters = []
const characterFile = () => join(app.getPath('userData'), 'character.json')

function log(message) {
  if (ARGS.includes('--dev')) console.log(`[shell] ${message}`)
}

/**
 * Lifecycle events a background resident should report even without `--dev`:
 * which harness it attached to, when it had to start one, and why it failed.
 * Debug chatter stays behind {@link log}.
 */
function notice(message) {
  console.log(`[shell] ${message}`)
}

// ---------------------------------------------------------------------------
// Assets: the same rig and sprite the in-page plugin renders.
// ---------------------------------------------------------------------------

async function readPreferredCharacter() {
  try {
    const saved = JSON.parse(await readFile(characterFile(), 'utf8'))
    return typeof saved.id === 'string' ? saved.id : null
  } catch {
    return null
  }
}

async function writePreferredCharacter(id) {
  try {
    await writeFile(characterFile(), `${JSON.stringify({ id }, null, 2)}\n`)
  } catch (error) {
    log(`could not persist the character choice: ${String((error && error.message) || error)}`)
  }
}

/** Ask the harness which characters it can offer, and push the list out. */
async function refreshCharacters() {
  const discovery = await readDiscovery()
  if (discovery === null) return null
  const index = await fetchCharacters(discovery)
  if (!index || index.ok !== true) return null
  characters = Array.isArray(index.characters) ? index.characters : []
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:characters', characters)
  return characters
}

/** Load one character and hand it to the renderer. */
async function applyCharacter(id) {
  const discovery = await readDiscovery()
  if (discovery === null) return { ok: false, error: '还没有接入 harness' }
  const payload = await fetchCharacter(discovery, id)
  if (!payload || payload.ok !== true) return { ok: false, error: String((payload && payload.error) || '加载失败') }
  characterId = payload.manifest.id
  canvasPainted = false
  notice(`character=${characterId} (${payload.manifest.name})`)
  await writePreferredCharacter(characterId)
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:character', {
      manifest: payload.manifest,
      rig: payload.rig,
      sprite: payload.sprite ? `data:image/png;base64,${payload.sprite}` : null,
      blinkSprite: payload.spriteBlink ? `data:image/png;base64,${payload.spriteBlink}` : null,
      atlas: payload.atlas ? `data:image/png;base64,${payload.atlas}` : null,
      grid: payload.grid,
      animations: payload.animations,
      moodMap: payload.moodMap,
    })
  }
  return { ok: true, id: characterId }
}

// ---------------------------------------------------------------------------
// The pet window
// ---------------------------------------------------------------------------

function createPetWindow() {
  const area = screen.getPrimaryDisplay().workArea

  petWindow = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    x: area.x + area.width - WINDOW.width - WINDOW.margin,
    y: area.y + area.height - WINDOW.height - WINDOW.margin,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(HERE, '..', 'preload', 'pet.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // Float above full-screen apps too, and keep floating across spaces.
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Everything is click-through until the renderer says the cursor is on the pet.
  petWindow.setIgnoreMouseEvents(true, { forward: true })

  petWindow.loadFile(join(HERE, '..', 'renderer', 'index.html'))

  petWindow.webContents.once('did-finish-load', async () => {
    petWindow.webContents.send('pet:status', status)
    if (lastState) petWindow.webContents.send('pet:state', lastState)
    petWindow.showInactive()
    await refreshCharacters()
    await applyCharacter(
      OPTIONS.character || characterId || (characters[0] && characters[0].id) || 'whale-maid',
    )
  })

  // A background resident is otherwise very hard to debug: surface renderer
  // errors in the terminal instead of only in a devtools window nobody opens.
  petWindow.webContents.on('console-message', (event) => {
    const level = event && typeof event.level === 'string' ? event.level : 'info'
    if (level !== 'error' && level !== 'warning' && !ARGS.includes('--dev')) return
    const message = event && typeof event.message === 'string' ? event.message : String(event)
    console.log(`[renderer:${level}] ${message}`)
  })
  petWindow.webContents.on('render-process-gone', (_event, details) => {
    notice(`renderer gone: ${details && details.reason}`)
  })

  petWindow.on('closed', () => {
    petWindow = null
  })

  return petWindow
}

function pushStatus() {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:status', status)
}

function setStatus(patch) {
  status = { ...status, ...patch }
  pushStatus()
  rebuildTray()
}

// ---------------------------------------------------------------------------
// Attach / spawn / reconnect
// ---------------------------------------------------------------------------

function detach() {
  if (stopFollowing) {
    stopFollowing()
    stopFollowing = null
  }
}

async function connect() {
  clearTimeout(connectTimer)
  detach()

  const discovery = await readDiscovery()
  if (discovery !== null) {
    const state = await probe(discovery)
    if (state !== null) {
      lastState = state
      stopFollowing = follow(
        discovery,
        (next) => {
          lastState = next
          if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', next)
        },
        (reason) => {
          setStatus({ mode: 'reconnecting', detail: `连接中断（${reason}），正在重连…` })
          connectTimer = setTimeout(connect, 1500)
        },
      )
      setStatus({
        mode: 'attached',
        detail: `已接入 harness（pid ${discovery.pid}）`,
        attachedPid: discovery.pid,
        url: ownedHarness && ownedHarness.child && ownedHarness.child.pid === discovery.pid ? ownedHarness.url : null,
      })
      notice(`attached to bridge pid=${discovery.pid} port=${discovery.port}`)
      return
    }
  }

  if (OPTIONS.attachOnly) {
    setStatus({ mode: 'detached', detail: '没有找到运行中的 harness（--attach-only）' })
    connectTimer = setTimeout(connect, 4000)
    return
  }

  if (ownedHarness !== null && ownedHarness.child.exitCode === null) {
    setStatus({ mode: 'starting', detail: 'harness 正在启动…' })
    connectTimer = setTimeout(connect, 800)
    return
  }

  setStatus({ mode: 'starting', detail: '没有运行中的 harness，正在启动一个…' })
  notice('no running harness found; starting one')
  const started = await startHarness({ dshPath: OPTIONS.dshPath, profile: OPTIONS.profile, log })
  if (!started.ok) {
    ownedHarness = null
    setStatus({ mode: 'error', detail: started.error })
    connectTimer = setTimeout(connect, 8000)
    return
  }

  ownedHarness = started
  setStatus({ mode: 'starting', detail: 'harness 已就绪，正在接入…', url: started.url, attachedPid: started.discovery.pid })
  connectTimer = setTimeout(connect, 500)
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/** A tray glyph drawn inline, so the shell needs no icon asset on disk. */
const TRAY_ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAADLUlEQVRYhe2W60uTYRjGX/8TdVMTzR1cbrrpdKmlTnd2cyGGaJhoeergttKlUUol5ReLAksiEvOQBMtDOvCA0gkFN9MPak7dkixXzMnojmehqO/e3HT7El3wg5v7fu7nujbejRfD/sttgZ/yymakUm27lqXaGMhS2YxZatsPhFJtM6CeUmXTnlLZ6V43Vly0ZiouWacVl63gJkZF5boU7R7KWl7xjZRZ8XUs88IaHARZxdqorHwt4EDmsjIzR1pmMUvLLXAoyiyrsvIvPI/MxaWfE0Qlpk1xiQm8gei8yS4sXeK6ZZ5eNBcgKJqzCIvnwZsIiudW0wsXyPvYg1964cxYRuEs+ISzsyN/fTD5Z4xyfoERfItBQvjpU/Mnp1PzJ8GXpORNGlzap+S+Y5zM/QBEyIonoKvP4kRaNOHxfDcfabgAyTnjNcmnx4GIzt4V2FJHz4rH850k5YxV4wIkZg8PJGYPAxEdPUvbBu2vlzye7+R49lA/LkCCUv+Jp9QDEYL8YXihW3SCak/nu8gaNOICxMt7rfHyPnCXjDw9nKt+6wTVnuwiL1yAWJluPVamg/2QFAyCTm8Ch+PX9leOatRDM3fuiJXqvuMCxIhfTrPF3eCK+MxXkF0yCC3tM7Bhd2wb2zYcTraEZugMOot2iO5ji7rxP0WWoP1NtKAD9hIn6YJly0/YqQWTFSpvjgFb1OkE1ai3U2gH7bq6kyXowD+EzLRWLZPfCnvhCNtg2fwnwPziOty6/x7YwjbcOdRDs60gaAfturozit96FRcgkt9CP5b6FFwRk/EM4sTPXc5cgc6iHaJ5VNoTisu/YnpyszHyxGPwLc1TGJGovAdSWuJD8CX0pEciwgAYBn4UXtMohdcEviCC1zS073sihdvgH85ttBzlNoJXibu3GpZwl4S5o3DObW4Yp8EexmkAL2EPjbkTi3miYFY9+wirzhwaXQ+HZDUkpi7BI/MtBUfVBAQza0dCmNfhQETVDoUwb/hjhxP4kRlaCZmhNQQxtOAOZEb1VBCjSox5W+QIDY1EU1eTqJp+ElVjCKSprQhUo14gVVMVRFFRvW6M/cv6DclKDiueGEQRAAAAAElFTkSuQmCC'

function rebuildTray() {
  if (tray === null) return
  const menu = Menu.buildFromTemplate([
    { label: `桌宠：${status.detail}`, enabled: false },
    { type: 'separator' },
    {
      label: status.mode === 'attached' ? '重新连接' : '立即连接',
      click: () => connect(),
    },
    {
      label: '打开 Harness 界面',
      enabled: Boolean(status.url),
      click: () => {
        if (status.url) electronShell.openExternal(status.url)
      },
    },
    {
      label: '显示 / 隐藏桌宠',
      click: () => {
        if (petWindow === null) return
        if (petWindow.isVisible()) petWindow.hide()
        else petWindow.showInactive()
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(`DSH 桌宠 — ${status.detail}`)
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON).resize({ width: 16, height: 16 }))
  rebuildTray()
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('pet:send', async (_event, args) => {
  const discovery = await readDiscovery()
  if (discovery === null) return { ok: false, error: '还没有接入 harness' }
  return sendPrompt(discovery, args)
})

ipcMain.handle('pet:refresh', async () => {
  const discovery = await readDiscovery()
  if (discovery === null) return { ok: false, error: '还没有接入 harness' }
  const state = await fetchState(discovery)
  if (state && state.ok) {
    lastState = state
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:state', state)
  }
  return state
})

ipcMain.handle('pet:characters', async () => {
  const list = await refreshCharacters()
  return { ok: list !== null, characters: characters }
})

ipcMain.handle('pet:set-character', async (_event, id) => {
  if (typeof id !== 'string' || id === '') return { ok: false, error: 'no character id' }
  return applyCharacter(id)
})

ipcMain.on('pet:canvas-ready', () => {
  canvasPainted = true
})

ipcMain.on('pet:set-interactive', (_event, interactive) => {
  if (petWindow === null || petWindow.isDestroyed()) return
  petWindow.setIgnoreMouseEvents(!interactive, { forward: true })
})

ipcMain.on('pet:move-by', (_event, delta) => {
  if (petWindow === null || petWindow.isDestroyed()) return
  const [x, y] = petWindow.getPosition()
  petWindow.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy))
})

ipcMain.on('pet:open-harness', () => {
  if (status.url) electronShell.openExternal(status.url)
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A desktop pet is a background resident: closing all windows must not quit.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  characterId = await readPreferredCharacter()
  createPetWindow()
  createTray()
  connect()

  if (SHOT !== null) {
    setTimeout(async () => {
      try {
        if (ARGS.includes('--with-panel')) {
          // Open the bubble the way a click would, and *check* it opened: the
          // synthetic events race the page's own load, so a single dispatch
          // silently does nothing maybe a third of the time.
          for (let attempt = 0; attempt < 5; attempt++) {
            const opened = await petWindow.webContents.executeJavaScript(`(() => {
              const panel = document.getElementById('panel')
              if (panel === null) return false
              if (!panel.hidden) return true
              const pet = document.getElementById('pet')
              for (const type of ['pointerdown', 'pointerup']) {
                pet.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 0, clientY: 0 }))
              }
              return !panel.hidden
            })()`)
            if (opened) break
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
          const ready = await petWindow.webContents.executeJavaScript(
            "!document.getElementById('panel').hidden",
          )
          if (!ready) console.log('[shell] warning: the command panel did not open for the screenshot')
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        // A canvas that has not painted yet captures as a blank window. Wait
        // for the renderer's explicit readiness signal instead of a timer.
        const paintDeadline = Date.now() + 15_000
        while (!canvasPainted && Date.now() < paintDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        if (!canvasPainted) console.log('[shell] warning: canvas never painted; capturing anyway')
        const image = await petWindow.capturePage()
        await writeFile(SHOT, image.toPNG())
        console.log(`screenshot: ${SHOT}`)

        // Same frame with the CSS drop-shadow removed: tells a compositing
        // artefact apart from a rendering bug.
        await petWindow.webContents.executeJavaScript(
          "document.getElementById('character').style.filter = 'none'",
        )
        await new Promise((resolve) => setTimeout(resolve, 400))
        const plain = await petWindow.capturePage()
        await writeFile(SHOT.replace(/\.png$/, '.nofilter.png'), plain.toPNG())

        const info = await petWindow.webContents.executeJavaScript(`(() => {
          const c = document.getElementById('character')
          const r = c.getBoundingClientRect()
          return JSON.stringify({ w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) })
        })()`)
        console.log(`canvas info: ${info}`)
      } catch (error) {
        console.error(`screenshot failed: ${String((error && error.message) || error)}`)
      }
      app.quit()
    }, 5000)
  }
})

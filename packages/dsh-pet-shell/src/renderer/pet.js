/**
 * Renderer for the desktop pet window.
 *
 * Reuses the very same character engine the in-page plugin renders with, so the
 * floating pet and the in-page pet are literally the same character. What is
 * different here is the window contract: the window is transparent and
 * click-through by default, and this script decides — from the sprite's own
 * alpha channel — whether the cursor is actually on the character.
 */
import { createCharacter } from '../../../dsh-live2d-pet/src/client/engine.js'

const QUICK_COMMANDS = ['跑一下测试并告诉我结果', '现在进度怎么样', '把当前改动总结一下']

const el = {
  stage: document.getElementById('stage'),
  pet: document.getElementById('pet'),
  canvas: document.getElementById('character'),
  badge: document.getElementById('badge'),
  panel: document.getElementById('panel'),
  phase: document.getElementById('phase'),
  dot: document.getElementById('dot'),
  session: document.getElementById('session'),
  say: document.getElementById('say'),
  text: document.getElementById('text'),
  quick: document.getElementById('quick'),
  send: document.getElementById('send'),
  mode: document.getElementById('mode'),
  open: document.getElementById('open'),
  note: document.getElementById('note'),
}

const view = {
  assets: null,
  character: null,
  mask: null,
  maskWidth: 0,
  maskHeight: 0,
  state: null,
  status: null,
  target: '',
  steer: false,
  busy: false,
  open: false,
  dragging: null,
  interactive: null,
  speech: '',
}

// ---------------------------------------------------------------------------
// Hit testing: the sprite's alpha channel decides where the window is "solid".
// ---------------------------------------------------------------------------

function buildMask(image) {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  const mask = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]
  view.mask = mask
  view.maskWidth = canvas.width
  view.maskHeight = canvas.height
}

/** Window-space point → is it over opaque character pixels? */
function overCharacter(x, y) {
  if (view.mask === null) return false
  const rect = el.canvas.getBoundingClientRect()
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false
  const u = Math.floor(((x - rect.left) / rect.width) * view.maskWidth)
  const v = Math.floor(((y - rect.top) / rect.height) * view.maskHeight)
  if (u < 0 || v < 0 || u >= view.maskWidth || v >= view.maskHeight) return false
  return view.mask[v * view.maskWidth + u] > 24
}

function overPanel(x, y) {
  if (!view.open) return false
  const rect = el.panel.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function setInteractive(next) {
  if (next === view.interactive) return
  view.interactive = next
  window.dshPet.setInteractive(next)
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const PHASE_TEXT = {
  idle: '待命',
  thinking: '思考中',
  tool: '调用工具',
  waiting: '搁置中',
  done: '刚完成',
  error: '出错了',
}

const MOOD_FOR_PHASE = {
  idle: 'idle',
  thinking: 'thinking',
  tool: 'working',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
}

function focused() {
  const state = view.state
  if (state === null || !Array.isArray(state.sessions) || state.sessions.length === 0) return null
  return state.sessions.find((row) => row.id === state.focus) || state.sessions[0]
}

function render() {
  const row = focused()
  const phase = row ? row.phase : 'idle'

  el.phase.textContent = view.status && view.status.mode !== 'attached'
    ? view.status.detail
    : PHASE_TEXT[phase] || phase
  el.dot.className = `dot is-${phase}`
  el.badge.className = `badge is-${phase}`

  if (view.character) {
    view.character.setMood(MOOD_FOR_PHASE[phase] || 'idle')
    // The mouth moves while text is actually streaming, not merely while busy.
    view.character.setTalking(phase === 'thinking' && Boolean(row && row.detail))
  }

  // Speech bubble carries the newest concrete fact the harness produced.
  const detail = row && row.detail ? String(row.detail).trim() : ''
  const speech = phase === 'idle' ? '' : detail
  if (speech !== view.speech) {
    view.speech = speech
    if (speech === '') {
      el.say.hidden = true
    } else {
      el.say.hidden = false
      el.say.textContent = speech.length > 90 ? `${speech.slice(0, 90)}…` : speech
    }
  }

  const sessions = view.state && Array.isArray(view.state.sessions) ? view.state.sessions : []
  if (sessions.length === 0) {
    el.session.innerHTML = ''
    const option = document.createElement('option')
    option.value = ''
    option.textContent = '（还没有会话）'
    el.session.appendChild(option)
    view.target = ''
  } else {
    if (!sessions.some((s) => s.id === view.target)) {
      view.target = (view.state.focus && sessions.some((s) => s.id === view.state.focus))
        ? view.state.focus
        : sessions[0].id
    }
    el.session.innerHTML = ''
    for (const session of sessions.slice(0, 20)) {
      const option = document.createElement('option')
      option.value = session.id
      const tail = session.id.slice(-8)
      const title = session.title ? ` · ${String(session.title).slice(0, 16)}` : ''
      option.textContent = `${tail}${title}${session.running ? ' ●' : ''}`
      option.selected = session.id === view.target
      el.session.appendChild(option)
    }
  }
}

function setNote(kind, text) {
  if (kind === null) {
    el.note.hidden = true
    return
  }
  el.note.hidden = false
  el.note.className = `note is-${kind}`
  el.note.textContent = text
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

document.addEventListener('mousemove', (event) => {
  if (view.dragging) {
    setInteractive(true)
    return
  }
  setInteractive(overCharacter(event.clientX, event.clientY) || overPanel(event.clientX, event.clientY))
})

el.pet.addEventListener('pointerdown', (event) => {
  el.pet.setPointerCapture(event.pointerId)
  view.dragging = { x: event.screenX, y: event.screenY, moved: false }
})

el.pet.addEventListener('pointermove', (event) => {
  if (!view.dragging) {
    // Eye tracking: normalised position over the sprite.
    const rect = el.canvas.getBoundingClientRect()
    if (view.character) {
      view.character.setPointer(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        (event.clientY - rect.top) / Math.max(1, rect.height),
        true,
      )
    }
    return
  }
  const dx = event.screenX - view.dragging.x
  const dy = event.screenY - view.dragging.y
  if (!view.dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return
  view.dragging.moved = true
  view.dragging.x = event.screenX
  view.dragging.y = event.screenY
  window.dshPet.moveBy(dx, dy)
})

el.pet.addEventListener('pointerup', (event) => {
  const dragging = view.dragging
  view.dragging = null
  if (dragging && !dragging.moved) {
    view.open = !view.open
    el.panel.hidden = !view.open
    setInteractive(view.open || overCharacter(event.clientX, event.clientY))
    if (view.open) {
      window.dshPet.refresh()
      el.text.focus()
    }
  }
})

el.pet.addEventListener('mouseleave', () => {
  if (view.character) view.character.setPointer(0.5, 0.5, false)
})

el.session.addEventListener('change', (event) => {
  view.target = event.target.value
  render()
})

el.mode.addEventListener('click', () => {
  view.steer = !view.steer
  el.mode.textContent = view.steer ? '模式：插话' : '模式：排队'
  el.mode.title = view.steer ? '打断正在执行的回合' : '排在队列后面执行'
  el.send.textContent = view.steer ? '插话打断' : '发送指令'
})

el.open.addEventListener('click', () => window.dshPet.openHarness())

async function send() {
  const text = el.text.value.trim()
  if (text === '' || view.busy) return
  if (view.target === '') {
    setNote('error', '还没有可用的会话')
    return
  }
  view.busy = true
  el.send.disabled = true
  setNote(null)
  const result = await window.dshPet.send({ sessionId: view.target, text, mode: view.steer ? 'steer' : 'queue' })
  view.busy = false
  el.send.disabled = false
  if (result && result.ok) {
    el.text.value = ''
    setNote('ok', `已${view.steer ? '插话' : '排队'}到 ${view.target.slice(-8)}`)
  } else {
    setNote('error', `投递失败：${String((result && result.error) || '未知错误')}`)
  }
}

el.send.addEventListener('click', send)
el.text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    send()
  }
})

for (const command of QUICK_COMMANDS) {
  const button = document.createElement('button')
  button.textContent = command
  button.addEventListener('click', () => {
    el.text.value = command
    el.text.focus()
  })
  el.quick.appendChild(button)
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

window.dshPet.onAssets((assets) => {
  view.assets = assets
  const image = new Image()
  image.onload = () => {
    buildMask(image)
    view.character = createCharacter(el.canvas, { rig: assets.rig, sprite: assets.sprite })
    render()
  }
  image.src = assets.sprite
})

window.dshPet.onState((state) => {
  view.state = state
  render()
})

window.dshPet.onStatus((status) => {
  view.status = status
  render()
})

render()

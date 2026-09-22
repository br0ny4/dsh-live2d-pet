/**
 * Browser half of `dsh-live2d-pet`.
 *
 * Registers one entry in the frame-wide `shell.overlay` slot: a character that
 * floats above the app, can be dragged anywhere, opens a command bubble on
 * click, and sends what you type into the selected session through the Client
 * `sessions` service — the same service the product's own composer uses, so
 * there is no private RPC and no extra port.
 *
 * The character also reads back the session's live state: it bounces while the
 * agent works, opens its mouth while text streams, and shakes when a turn ends
 * in error.
 */
import { createCharacter } from './engine.js'

const React = __dshRequire('react')
const RIG = __PET_RIG__
const SPRITE = __PET_SPRITE__
const CSS = __PET_CSS__

const QUICK_COMMANDS = ['跑一下测试并告诉我结果', '总结这个仓库的架构', '看看当前目录有什么']

/**
 * Same-origin route the Host half publishes. A page can only fetch its own
 * origin, so the desktop bridge (loopback + bearer secret) is unreachable from
 * here by design — the Host half serves the same registry on the app's carrier.
 */
const CHARACTER_ROUTE = '/dsh-live2d-pet/characters'
const CHARACTER_KEY = 'dsh-live2d-pet/character'

/** The character inlined at build time: what renders before the fetch lands. */
const FALLBACK = { id: 'whale-maid', name: 'DeepSeek 鲸鱼娘', rig: RIG, sprite: SPRITE }

function readStoredCharacter() {
  try {
    return window.localStorage.getItem(CHARACTER_KEY) || ''
  } catch {
    return ''
  }
}

function storeCharacter(id) {
  try {
    window.localStorage.setItem(CHARACTER_KEY, id)
  } catch {
    /* private mode, or storage disabled — the choice just does not persist */
  }
}

/** Fetch one character; resolves to a shape the renderer accepts. */
async function fetchCharacter(id) {
  const response = await fetch(`${CHARACTER_ROUTE}/${encodeURIComponent(id)}`)
  const payload = await response.json()
  if (!payload || payload.ok !== true) throw new Error(String((payload && payload.error) || '加载失败'))
  return {
    id: payload.manifest.id,
    name: payload.manifest.name,
    rig: payload.rig,
    sprite: payload.sprite ? `data:image/png;base64,${payload.sprite}` : null,
    blinkSprite: payload.spriteBlink ? `data:image/png;base64,${payload.spriteBlink}` : null,
    atlas: payload.atlas ? `data:image/png;base64,${payload.atlas}` : null,
    grid: payload.grid,
    animations: payload.animations,
    moodMap: payload.moodMap,
  }
}

async function fetchCharacterList() {
  const response = await fetch(CHARACTER_ROUTE)
  const payload = await response.json()
  if (!payload || payload.ok !== true) throw new Error(String((payload && payload.error) || '加载失败'))
  return payload.characters || []
}

/** Shipped plugins inline their stylesheet behind a plugin-tagged <style> tag. */
const STYLE_TAG_ID = 'dsh-live2d-pet/pet.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-live2d-pet'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** One prompt call's identity; also what the session log records as `rpcId`. */
function newRequestId() {
  return `dsh-pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function shortId(id) {
  const text = String(id || '')
  const dash = text.lastIndexOf('-')
  return dash >= 0 ? text.slice(dash + 1, dash + 9) : text.slice(0, 8)
}

/** Read a `RemoteResult` without ever touching live runtime objects wholesale. */
function failureOf(result) {
  if (!result || result.ok === true) return null
  const error = result.error
  if (!error) return '被拒绝，未提供原因'
  if (typeof error === 'string') return error
  return error.message || error.code || '被拒绝'
}

export const inject = ['slots', 'sessions']

export function apply(ctx) {
  const sessions = ctx.sessions

  function Pet(props) {
    // Primitive selectors only: the list store updates on every streamed
    // event, and selecting objects would re-render the pet on each one.
    const currentId = props.useSessions((s) => s.current || '')
    const runningId = props.useSessions((s) => s.ids.find((id) => s.byId[id]?.running) || '')
    const rowsKey = props.useSessions((s) => s.ids
      .map((id) => {
        const row = s.byId[id]
        const title = String((row && (row.displayTitle || row.title)) || '').replace(/[|\n\r]/g, ' ')
        return `${id}|${title}|${row && row.running ? 1 : 0}`
      })
      .join('\n'))

    const rows = React.useMemo(() => rowsKey
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, title, running] = line.split('|')
        return { id, title, running: running === '1' }
      })
      .slice(0, 40), [rowsKey])

    const [characters, setCharacters] = React.useState([])
    const [characterId, setCharacterId] = React.useState(() => readStoredCharacter() || FALLBACK.id)
    const [character, setCharacter] = React.useState(FALLBACK)
    const [open, setOpen] = React.useState(false)
    const [target, setTarget] = React.useState('')
    const [text, setText] = React.useState('')
    const [steer, setSteer] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [note, setNote] = React.useState(null)
    const [pos, setPos] = React.useState(null)

    const canvasRef = React.useRef(null)
    const characterRef = React.useRef(null)
    const dragRef = React.useRef(null)
    const rootRef = React.useRef(null)
    const panelRef = React.useRef(null)
    /**
     * Where the bubble can actually go. It used to open upward and centre on
     * the pet unconditionally, so parking the pet near the top edge put the
     * whole panel above the viewport — the pet looked unresponsive because its
     * controls had opened somewhere the user could not see.
     */
    const [place, setPlace] = React.useState(null)

    // Keep a valid target without clobbering an explicit choice.
    React.useEffect(() => {
      setTarget((current) => {
        if (current && rows.some((row) => row.id === current)) return current
        if (currentId && rows.some((row) => row.id === currentId)) return currentId
        return rows.length ? rows[0].id : ''
      })
    }, [rows, currentId])

    React.useEffect(() => {
      let alive = true
      fetchCharacterList()
        .then((list) => {
          if (alive) setCharacters(list)
        })
        .catch(() => {
          /* no route (older harness, or a non-web carrier): the built-in stays */
        })
      return () => {
        alive = false
      }
    }, [])

    React.useEffect(() => {
      if (characterId === character.id) return undefined
      let alive = true
      fetchCharacter(characterId)
        .then((next) => {
          if (alive) setCharacter(next)
        })
        .catch(() => {
          if (alive) setCharacterId(FALLBACK.id)
        })
      return () => {
        alive = false
      }
    }, [characterId, character.id])

    React.useEffect(() => {
      if (!canvasRef.current) return undefined
      const renderer = createCharacter(canvasRef.current, {
        rig: character.rig,
        sprite: character.sprite,
        blinkSprite: character.blinkSprite,
        atlas: character.atlas,
        grid: character.grid,
        animations: character.animations,
        moodMap: character.moodMap,
      })
      characterRef.current = renderer
      return () => {
        renderer.dispose()
        characterRef.current = null
      }
    }, [character])

    React.useEffect(() => {
      if (!open) return undefined
      /**
       * Place the bubble by explicit coordinates.
       *
       * CSS alone cannot do this: the panel has to open upward when there is
       * room, downward when there is not, and be clamped when the window is
       * shorter than the panel plus the pet — the case where "flip to the other
       * side" still runs off the screen.
       */
      const measure = () => {
        const root = rootRef.current
        const panel = panelRef.current
        if (!root || !panel) return
        const rect = root.getBoundingClientRect()
        const width = panel.offsetWidth || 286
        const height = panel.offsetHeight || 260
        const margin = 8
        const gap = 10
        const roomAbove = rect.top - gap - margin
        const roomBelow = window.innerHeight - rect.bottom - gap - margin
        let top
        if (roomAbove >= height) top = rect.top - gap - height
        else if (roomBelow >= height) top = rect.bottom + gap
        else if (roomAbove >= roomBelow) top = margin
        else top = window.innerHeight - margin - height
        top = Math.max(margin, Math.min(top, window.innerHeight - margin - height))

        const centre = rect.left + rect.width / 2
        let left = centre - width / 2
        left = Math.max(margin, Math.min(left, window.innerWidth - margin - width))

        setPlace({ left: Math.round(left), top: Math.round(top) })
      }
      // The panel must exist before it can be measured: this runs once after
      // the open render, then on every viewport change.
      measure()
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }, [open, pos])

    // A window that shrank can leave the pet outside it; pull it back.
    React.useEffect(() => {
      const clamp = () => {
        setPos((current) => {
          if (current === null) return current
          const size = rootRef.current ? rootRef.current.getBoundingClientRect() : { width: 124, height: 200 }
          const margin = 24
          return {
            x: Math.max(margin - size.width, Math.min(window.innerWidth - margin, current.x)),
            y: Math.max(margin - size.height, Math.min(window.innerHeight - margin, current.y)),
          }
        })
      }
      window.addEventListener('resize', clamp)
      return () => window.removeEventListener('resize', clamp)
    }, [])

    const running = runningId !== '' && runningId === target
    const anyRunning = runningId !== ''

    React.useEffect(() => {
      const character = characterRef.current
      if (!character) return
      character.setTalking(running)
      if (running) character.setMood('working')
      else if (!note || note.kind === 'info') character.setMood('idle')
    }, [running, note])

    // A click is a poke; the character notices even when nothing else happens.
    React.useEffect(() => {
      if (!open) return
      const character = characterRef.current
      if (character) character.react('poke')
    }, [open])

    React.useEffect(() => {
      const character = characterRef.current
      if (!character || !note || note.kind === 'info') return undefined
      character.setMood(note.kind === 'error' ? 'error' : 'done')
      const timer = setTimeout(() => {
        character.setMood('idle')
        setNote((current) => (current === note ? null : current))
      }, note.kind === 'error' ? 2600 : 2200)
      return () => clearTimeout(timer)
    }, [note])

    const send = async () => {
      const value = text.trim()
      if (value === '' || busy) return
      setBusy(true)
      setNote(null)

      let sessionId = target
      try {
        if (sessionId === '') {
          sessionId = await sessions.create()
          setTarget(sessionId)
        }
        const binding = sessions.binding(sessionId)
        if (!binding || !binding.session) {
          setBusy(false)
          setNote({ kind: 'error', text: '这个会话还没准备好，换一个或稍后再试' })
          return
        }
        const result = await binding.session.prompt(
          [{ type: 'text', text: value }],
          steer ? 'steer' : 'queue',
          undefined,
          newRequestId(),
        )
        const failure = failureOf(result)
        setBusy(false)
        if (failure) {
          setNote({ kind: 'error', text: `投递失败：${failure}` })
          return
        }
        setText('')
        setNote({ kind: 'ok', text: `已${steer ? '插话' : '排队'}到 ${shortId(sessionId)}` })
      } catch (error) {
        setBusy(false)
        setNote({ kind: 'error', text: `投递失败：${String((error && error.message) || error)}` })
      }
    }

    const onPointerDown = (event) => {
      const el = event.currentTarget
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        /* a synthetic pointer carries no capturable id */
      }
      // Anchor the drag to the element's *current* box, every time. Anchoring
      // only on the first drag (when `pos` was still null) left the second drag
      // with an undefined origin, so `origin + delta` was NaN and the pet would
      // not move again.
      const root = el.parentElement || el
      const rect = root.getBoundingClientRect()
      dragRef.current = {
        sx: event.clientX,
        sy: event.clientY,
        ox: rect.left,
        oy: rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
      }
    }
    const onPointerMove = (event) => {
      const state = dragRef.current
      if (!state) return
      const dx = event.clientX - state.sx
      const dy = event.clientY - state.sy
      if (!state.moved && Math.abs(dx) + Math.abs(dy) > 4) state.moved = true
      if (!state.moved) return
      // Keep a grabbable sliver on screen rather than clamping to a fixed 60px.
      const margin = 24
      const minX = margin - state.width
      const minY = margin - state.height
      setPos({
        x: Math.max(minX, Math.min(window.innerWidth - margin, state.ox + dx)),
        y: Math.max(minY, Math.min(window.innerHeight - margin, state.oy + dy)),
      })
    }
    const onPointerUp = () => {
      const state = dragRef.current
      dragRef.current = null
      if (state && !state.moved) setOpen((value) => !value)
    }
    const onCanvasMove = (event) => {
      const character = characterRef.current
      if (!character) return
      const rect = event.currentTarget.getBoundingClientRect()
      character.setPointer(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        (event.clientY - rect.top) / Math.max(1, rect.height),
        true,
      )
    }

    const style = pos === null
      ? { right: 24, bottom: 18 }
      : { left: pos.x, top: pos.y }

    const mood = note ? note.kind : running ? 'running' : 'idle'
    const targetRow = rows.find((row) => row.id === target) || null

    const header = React.createElement('div', { className: 'dshl2d-head' },
      React.createElement('span', { className: `dshl2d-dot is-${mood}` }),
      React.createElement('span', null, running ? '执行中' : anyRunning ? '别处执行中' : '待命'),
      React.createElement('select', {
        className: 'dshl2d-sel',
        value: target,
        onChange: (event) => setTarget(event.target.value),
        title: targetRow ? targetRow.title || targetRow.id : '',
      },
        rows.length === 0
          ? React.createElement('option', { value: '' }, '（还没有会话，发送时会新建）')
          : rows.map((row) => React.createElement('option', { key: row.id, value: row.id },
              `${shortId(row.id)}${row.title ? ` · ${row.title.slice(0, 18)}` : ''}${row.running ? ' ●' : ''}`))),
    )

    const characterRow = characters.length > 1
      ? React.createElement('div', { className: 'dshl2d-row' },
          React.createElement('span', { className: 'dshl2d-label' }, '角色'),
          React.createElement('select', {
            className: 'dshl2d-sel',
            value: character.id,
            title: character.name,
            onChange: (event) => {
              storeCharacter(event.target.value)
              setCharacterId(event.target.value)
            },
          }, characters.map((entry) => React.createElement('option', {
            key: entry.id,
            value: entry.id,
          }, entry.name + (entry.builtin ? '' : ' · 自定')))))
      : null

    const panel = React.createElement('div', {
      ref: panelRef,
      className: 'dshl2d-panel',
      // Rendered at the measured spot; the first frame before measurement uses
      // the CSS default and is corrected on the next one.
      style: place === null
        ? { visibility: 'hidden' }
        : { left: `${place.left}px`, top: `${place.top}px` },
    },
      header,
      characterRow,
      React.createElement('textarea', {
        className: 'dshl2d-ta',
        placeholder: '给这个会话下达指令…（⌘/Ctrl + Enter 发送）',
        value: text,
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            send()
          }
        },
      }),
      React.createElement('div', { className: 'dshl2d-quick' },
        QUICK_COMMANDS.map((command) => React.createElement('button', {
          key: command,
          onClick: () => setText(command),
        }, command))),
      React.createElement('div', { className: 'dshl2d-row' },
        React.createElement('button', {
          className: 'dshl2d-btn',
          disabled: busy || text.trim() === '',
          onClick: send,
        }, busy ? '投递中…' : steer ? '插话打断' : '发送指令'),
        React.createElement('button', {
          className: 'dshl2d-btn ghost',
          onClick: () => setSteer((value) => !value),
          title: steer ? '当前：打断正在执行的回合' : '当前：排在队列后面执行',
        }, steer ? '模式：插话' : '模式：排队'),
        React.createElement('button', {
          className: 'dshl2d-btn ghost',
          onClick: () => setOpen(false),
        }, '收起')),
      note ? React.createElement('div', { className: `dshl2d-msg is-${note.kind}` }, note.text) : null,
    )

    return React.createElement('div', { className: 'dshl2d-root', style, ref: rootRef },
      React.createElement('div', {
        className: 'dshl2d-pet',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerLeave: () => characterRef.current && characterRef.current.setPointer(0.5, 0.5, false),
        title: '单击打开指令气泡，拖动可移动',
      },
        React.createElement('canvas', { ref: canvasRef, onPointerMove: onCanvasMove }),
        React.createElement('span', { className: `dshl2d-badge${running ? ' is-running' : ''}` }),
        React.createElement('span', { className: 'dshl2d-hint' }, '点击下达指令'),
      ),
      open ? panel : null,
    )
  }

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'dsh-live2d-pet', order: 60, label: 'Live2D 桌宠' },
    Pet,
  )), 'live2d-pet: overlay entry')
}

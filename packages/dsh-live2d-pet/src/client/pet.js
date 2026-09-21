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

    // Keep a valid target without clobbering an explicit choice.
    React.useEffect(() => {
      setTarget((current) => {
        if (current && rows.some((row) => row.id === current)) return current
        if (currentId && rows.some((row) => row.id === currentId)) return currentId
        return rows.length ? rows[0].id : ''
      })
    }, [rows, currentId])

    React.useEffect(() => {
      if (!canvasRef.current) return undefined
      const character = createCharacter(canvasRef.current, { rig: RIG, sprite: SPRITE })
      characterRef.current = character
      return () => {
        character.dispose()
        characterRef.current = null
      }
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
      if (el.setPointerCapture) el.setPointerCapture(event.pointerId)
      dragRef.current = { sx: event.clientX, sy: event.clientY, moved: false, fresh: pos === null }
    }
    const onPointerMove = (event) => {
      const state = dragRef.current
      if (!state) return
      const dx = event.clientX - state.sx
      const dy = event.clientY - state.sy
      if (!state.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        state.moved = true
        if (state.fresh) {
          const rect = event.currentTarget.getBoundingClientRect()
          state.ox = rect.left
          state.oy = rect.top
        }
      }
      if (!state.moved) return
      setPos({
        x: Math.max(4, Math.min(window.innerWidth - 60, state.ox + dx)),
        y: Math.max(4, Math.min(window.innerHeight - 60, state.oy + dy)),
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

    const panel = React.createElement('div', { className: 'dshl2d-panel' },
      header,
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

    return React.createElement('div', { className: 'dshl2d-root', style },
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

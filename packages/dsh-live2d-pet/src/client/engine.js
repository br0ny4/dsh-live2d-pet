/**
 * Mesh-warp character renderer (WebGL) with a small behaviour layer.
 *
 * The default characters are flat sprites: no layered PSD, therefore no Cubism
 * model. The renderer treats the sprite as a deformable mesh — the rig names
 * elliptical regions (head, wings, torso, feet, eyes, mouth, …) and every
 * vertex of a grid is displaced by the summed influence of the regions covering
 * it. That buys hair sway, wing flapping, breathing, a blink that genuinely
 * closes the eyes, and a mouth that opens while the agent talks — without the
 * Cubism runtime, the Core binary, or an authored `.moc3`.
 *
 * On top of the deformation sits a behaviour layer, because "more expressive"
 * is mostly about *when* things happen rather than how far they move:
 *
 *   moods     idle / thinking / working / waiting / sleeping / done / error
 *   sleep     long idle closes the eyes, slows the breathing, floats a z
 *   poke      clicking the character makes it start and flash an exclamation
 *   drag      the lower body lags behind the window while you move it
 *   look      the eyes follow the cursor, and drift on their own when idle
 *   emblems   small vector marks drawn over the mesh, no sprite sheet needed
 *
 * Why WebGL rather than many `drawImage` calls: a per-cell 2D blit resamples
 * each cell independently, so neighbouring cells never line up and the whole
 * sprite shows a grid of seams. One textured mesh interpolates across cell
 * boundaries by construction.
 *
 * A real Live2D model remains the better answer when one exists; a replacement
 * backend only has to satisfy the public methods at the bottom of this file.
 */

const TAU = Math.PI * 2

/** Mesh resolution: finer than the visible motion, so curves stay smooth. */
const COLS = 24
const ROWS = 44

/** Default idle time before the character falls asleep. */
const SLEEP_AFTER_MS = 120000
/** How long a transient reaction (poke, done, error) stays on screen. */
const REACTION_MS = 900

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uTexBlink;
uniform float uBlinkMix;
void main() {
  vec4 c = mix(texture2D(uTex, vUV), texture2D(uTexBlink, vUV), uBlinkMix);
  // The sprite is straight-alpha; the canvas is premultiplied. Premultiplying
  // here (rather than letting the blender handle colour alone) is what keeps
  // the canvas's own alpha correct, so soft shading stays soft instead of
  // turning into a white haze over the page behind the window.
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}`

/** Smooth 0→1 ramp; used to feather every region edge so the mesh has no seams. */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Region weight at a normalised point: 1 at the centre, 0 past the rim. */
function weightAt(u, v, region) {
  const dx = (u - region.cx) / region.rx
  const dy = (v - region.cy) / region.ry
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d >= 1) return 0
  return smoothstep(1, 0.4, d)
}

/**
 * Mood presets. `waiting` barely moves on purpose, so "stalled / needs you"
 * reads differently from "busy" at a glance; `sleeping` all but stops.
 */
const MOODS = {
  idle: { bob: 1, speed: 1, shake: 0, hop: 0 },
  thinking: { bob: 1.6, speed: 1.7, shake: 0, hop: 0 },
  working: { bob: 1.7, speed: 1.85, shake: 0, hop: 0 },
  waiting: { bob: 0.35, speed: 0.45, shake: 0, hop: 0 },
  sleeping: { bob: 0.22, speed: 0.3, shake: 0, hop: 0 },
  done: { bob: 1.1, speed: 1.2, shake: 0, hop: 1 },
  error: { bob: 0.7, speed: 1.3, shake: 1, hop: 0 },
}

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`shader compile failed: ${log}`)
  }
  return shader
}

export function createCharacter(canvas, options) {
  if (options.animations && options.atlas) {
    return createFrameCharacter(canvas, options)
  }
  const rig = options.rig || { influences: [] }
  const regions = rig.influences || []
  const swayRegions = regions.filter((r) => r.motion === 'sway')
  const flapRegions = regions.filter((r) => r.motion === 'flap')
  const breatheRegions = regions.filter((r) => r.motion === 'breathe')
  const blinkRegions = regions.filter((r) => r.motion === 'blink')
  const talkRegions = regions.filter((r) => r.motion === 'talk')
  /** Where emblems float: the head if the rig names one, else the upper third. */
  const headRegion = regions.find((r) => r.name === 'head')
    || regions.find((r) => r.name === 'hair')
    || { cx: 0.5, cy: 0.22, rx: 0.3, ry: 0.2 }

  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
  })

  let disposed = false
  let raf = 0
  let ready = false
  let sleepAfterMs = SLEEP_AFTER_MS

  const state = {
    mood: 'idle',
    moodSince: 0,
    reaction: null,
    talking: false,
    sleeping: false,
    idleSince: 0,
    pointer: { x: 0.5, y: 0.5, active: false },
    /** Autonomous look target, so an untouched pet still glances around. */
    glance: { x: 0.5, y: 0.5, until: 0 },
    drag: { active: false, vx: 0, vy: 0 },
    blink: 1,
    nextBlinkAt: 1.4,
  }
  let emblemVisible = false

  if (gl === null) {
    // No WebGL — or the canvas already owns a 2D context from a previous
    // character. Either way this backend cannot draw here.
    console.error('[dsh-live2d-pet] mesh backend needs a fresh WebGL canvas')
    const image = new Image()
    image.onload = () => {
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d').drawImage(image, 0, 0)
    }
    image.src = options.sprite
    return {
      setMood() {},
      setTalking() {},
      setPointer() {},
      react() {},
      setDragging() {},
      setSleepAfter() {},
      isSleeping() {
        return false
      },
      dispose() {
        image.onload = null
      },
    }
  }

  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
  }
  gl.useProgram(program)

  const aPos = gl.getAttribLocation(program, 'aPos')
  const aUV = gl.getAttribLocation(program, 'aUV')
  const uTex = gl.getUniformLocation(program, 'uTex')
  const uTexBlink = gl.getUniformLocation(program, 'uTexBlink')
  const uBlinkMix = gl.getUniformLocation(program, 'uBlinkMix')

  // ---- static mesh topology ------------------------------------------------
  const vertexCount = (COLS + 1) * (ROWS + 1)
  const uvs = new Float32Array(vertexCount * 2)
  const positions = new Float32Array(vertexCount * 2)
  const baseU = new Float32Array(vertexCount)
  const baseV = new Float32Array(vertexCount)

  for (let row = 0; row <= ROWS; row++) {
    for (let col = 0; col <= COLS; col++) {
      const index = row * (COLS + 1) + col
      const u = col / COLS
      const v = row / ROWS
      baseU[index] = u
      baseV[index] = v
      uvs[index * 2] = u
      uvs[index * 2 + 1] = v
    }
  }

  const indices = new Uint16Array(COLS * ROWS * 6)
  let cursor = 0
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const a = row * (COLS + 1) + col
      const b = a + 1
      const c = a + (COLS + 1)
      const d = c + 1
      indices[cursor++] = a
      indices[cursor++] = c
      indices[cursor++] = b
      indices[cursor++] = b
      indices[cursor++] = c
      indices[cursor++] = d
    }
  }

  const positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uvBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(aUV)
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0)

  const indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

  // Clamp + no mipmaps: anything else bleeds the sprite's transparent border
  // into the artwork along the mesh edges.
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.uniform1i(uTex, 0)
  gl.uniform1i(uTexBlink, 1)
  // With a paired blink frame the eyes close by swapping art, not by squashing
  // the mesh — a drawn closed eye is simply better than a compressed open one.
  const hasBlinkFrame = typeof options.blinkSprite === 'string' && options.blinkSprite !== ''
  gl.uniform1f(uBlinkMix, 0)

  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const blinkTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, blinkTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  let blinkReady = !hasBlinkFrame
  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    overlay.width = canvas.width
    overlay.height = canvas.height
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    ready = true
  }
  image.src = options.sprite

  if (hasBlinkFrame) {
    const blinkImage = new Image()
    blinkImage.decoding = 'async'
    blinkImage.onload = () => {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, blinkTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, blinkImage)
      gl.activeTexture(gl.TEXTURE0)
      blinkReady = true
    }
    blinkImage.src = options.blinkSprite
  }

  // A canvas that owns a WebGL context can never hand out a 2D one, so the
  // emblem layer is a second, transparent canvas stacked over the character.
  // Drawing emblems into `canvas` itself silently failed on every frame.
  const overlay = canvas.ownerDocument.createElement('canvas')
  overlay.style.position = 'absolute'
  overlay.style.inset = '0'
  overlay.style.width = '100%'
  overlay.style.height = '100%'
  overlay.style.pointerEvents = 'none'
  if (canvas.parentElement !== null) canvas.parentElement.appendChild(overlay)
  const ctx2d = overlay.getContext('2d')

  // ---- emblems -------------------------------------------------------------
  // Drawn in normalised sprite space after the mesh, so they ride the head even
  // as it deforms. Plain vector marks: no sprite sheet, no font dependency for
  // anything but the sleeping z.

  function emblemAnchor(now, index) {
    const float = Math.sin(now / 520 + index) * 0.012
    return {
      x: (headRegion.cx + headRegion.rx * (0.6 + index * 0.18)) * overlay.width,
      y: (headRegion.cy - headRegion.ry * (0.8 + index * 0.24) + float) * overlay.height,
    }
  }

  function drawSleep(now) {
    const size = Math.max(9, overlay.width * 0.09)
    ctx2d.save()
    ctx2d.fillStyle = 'rgba(146,166,214,0.95)'
    ctx2d.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`
    ctx2d.textAlign = 'center'
    for (let i = 0; i < 3; i++) {
      const phase = ((now / 1600) + i * 0.33) % 1
      const anchor = emblemAnchor(now, i)
      ctx2d.globalAlpha = Math.sin(phase * Math.PI) * 0.9
      ctx2d.fillText('z', anchor.x, anchor.y - phase * size * 0.9)
    }
    ctx2d.restore()
  }

  /** A persistent state mark: without it, "thinking" and "idle" look alike. */
  function drawStateMark(now) {
    const anchor = emblemAnchor(now, 0)
    const size = Math.max(10, overlay.width * 0.10)
    ctx2d.save()
    ctx2d.translate(anchor.x, anchor.y)
    if (state.mood === 'waiting') {
      ctx2d.fillStyle = 'rgba(240,170,60,0.95)'
      ctx2d.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`
      ctx2d.textAlign = 'center'
      ctx2d.globalAlpha = 0.75 + Math.sin(now / 420) * 0.25
      ctx2d.fillText('?', 0, 0)
    } else {
      ctx2d.fillStyle = 'rgba(120,150,225,0.9)'
      for (let i = 0; i < 3; i++) {
        const phase = (now / 900 - i * 0.18) % 1
        ctx2d.globalAlpha = Math.max(0.15, Math.sin(phase * Math.PI))
        ctx2d.beginPath()
        ctx2d.arc((i - 1) * size * 0.3, 0, size * 0.09, 0, TAU)
        ctx2d.fill()
      }
    }
    ctx2d.restore()
  }

  function drawMark(kind, age) {
    const anchor = emblemAnchor(state.moodSince === 0 ? 0 : 0, 1)
    const grow = Math.min(1, age / 110)
    const rise = age / REACTION_MS
    const size = Math.max(10, overlay.width * 0.12)
    ctx2d.save()
    ctx2d.globalAlpha = Math.max(0, 1 - Math.max(0, (age - REACTION_MS * 0.55) / (REACTION_MS * 0.45)))
    ctx2d.translate(anchor.x, anchor.y - rise * overlay.height * 0.07)
    ctx2d.scale(grow, grow)

    if (kind === 'poke') {
      ctx2d.fillStyle = '#ffb020'
      ctx2d.strokeStyle = 'rgba(45,32,10,0.5)'
      ctx2d.lineWidth = Math.max(1, size * 0.08)
      ctx2d.beginPath()
      ctx2d.moveTo(-size * 0.08, -size * 0.56)
      ctx2d.lineTo(size * 0.08, -size * 0.56)
      ctx2d.lineTo(size * 0.05, -size * 0.1)
      ctx2d.lineTo(-size * 0.05, -size * 0.1)
      ctx2d.closePath()
      ctx2d.fill()
      ctx2d.stroke()
      ctx2d.beginPath()
      ctx2d.arc(0, size * 0.08, size * 0.095, 0, TAU)
      ctx2d.fill()
      ctx2d.stroke()
    } else if (kind === 'done') {
      ctx2d.fillStyle = '#4fce9b'
      ctx2d.beginPath()
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * TAU - Math.PI / 2
        const radius = i % 2 === 0 ? size * 0.52 : size * 0.17
        const px = Math.cos(angle) * radius
        const py = Math.sin(angle) * radius
        if (i === 0) ctx2d.moveTo(px, py)
        else ctx2d.lineTo(px, py)
      }
      ctx2d.closePath()
      ctx2d.fill()
    } else if (kind === 'error') {
      ctx2d.fillStyle = '#63b3ff'
      ctx2d.beginPath()
      ctx2d.moveTo(0, -size * 0.52)
      ctx2d.bezierCurveTo(size * 0.44, -size * 0.05, size * 0.34, size * 0.44, 0, size * 0.44)
      ctx2d.bezierCurveTo(-size * 0.34, size * 0.44, -size * 0.44, -size * 0.05, 0, -size * 0.52)
      ctx2d.fill()
    } else if (kind === 'wake') {
      ctx2d.strokeStyle = 'rgba(255,206,110,0.95)'
      ctx2d.lineWidth = Math.max(1.5, size * 0.11)
      ctx2d.lineCap = 'round'
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU + Math.PI / 4
        ctx2d.beginPath()
        ctx2d.moveTo(Math.cos(angle) * size * 0.24, Math.sin(angle) * size * 0.24)
        ctx2d.lineTo(Math.cos(angle) * size * 0.48, Math.sin(angle) * size * 0.48)
        ctx2d.stroke()
      }
    }
    ctx2d.restore()
  }

  // ---- per-frame deformation ----------------------------------------------

  function frame(now) {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (!ready) return

    // ---- behaviour ----
    const mood = state.mood
    const preset = MOODS[mood] || MOODS.idle

    if (mood === 'idle' && !state.sleeping && now - state.idleSince > sleepAfterMs) {
      state.sleeping = true
      state.moodSince = now
    }
    if (mood !== 'idle' && state.sleeping) {
      state.sleeping = false
      state.moodSince = now
    }
    if (state.reaction !== null && now - state.moodSince > REACTION_MS) state.reaction = null

    // An untouched pet still looks around: pick a new glance target now and then.
    if (!state.pointer.active && now > state.glance.until) {
      state.glance = {
        x: 0.5 + (Math.random() - 0.5) * 0.55,
        y: 0.5 + (Math.random() - 0.5) * 0.35,
        until: now + 1800 + Math.random() * 3200,
      }
    }
    state.drag.vx *= 0.86
    state.drag.vy *= 0.86

    if (state.sleeping) {
      state.blink = Math.max(0, state.blink - 0.07)
    } else {
      const moodTime = (now - state.moodSince) / 1000
      if (state.blink === 1 && moodTime >= state.nextBlinkAt) {
        state.blink = 0
        state.nextBlinkAt = moodTime + 0.16
        state.moodSince = now
      } else if (state.blink < 1) {
        const closing = moodTime < state.nextBlinkAt
        state.blink = Math.max(0, Math.min(1, state.blink + (closing ? -0.35 : 0.22)))
        if (state.blink >= 1) state.nextBlinkAt = moodTime + 2.4 + Math.random() * 3.4
      }
    }

    const t = now / 1000
    const poke = state.reaction === 'poke'
    const lean = (Math.sin(t * 0.8 * preset.speed) * 0.7 * Math.PI) / 180
    const shake = preset.shake ? (Math.sin(t * 26) * 2.6 * preset.shake) / 240 : 0
    const hop = (preset.hop ? Math.max(0, Math.sin(t * 4.2)) * -7 * preset.hop : 0)
      + (poke ? Math.max(0, Math.sin(((now - state.moodSince) / REACTION_MS) * Math.PI)) * -0.022 : 0)
    const bob = Math.sin(t * 1.55 * preset.speed) * 0.011 * preset.bob
    const cos = Math.cos(lean)
    const sin = Math.sin(lean)
    const pivotX = 0.5
    const pivotY = 0.94
    const talkAmount = state.talking ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 15)) : 0

    // Where the eyes look: the cursor when it is over the pet, else the glance.
    const look = state.pointer.active ? state.pointer : state.glance

    for (let index = 0; index < vertexCount; index++) {
      const u = baseU[index]
      const v = baseV[index]

      let dx = 0
      let dy = 0
      let py = v

      for (const region of swayRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        dx += Math.sin(t * region.freq * TAU + region.phase) * region.amp * w
        // While the window is dragged, the body lags behind the motion.
        if (state.drag.active) dx -= state.drag.vx * 0.0016 * w * (1 - v)
      }
      for (const region of flapRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        dy += Math.sin(t * region.freq * TAU + region.phase) * region.amp * w
        if (state.drag.active) dy -= state.drag.vy * 0.0016 * w
      }
      for (const region of breatheRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        dy += Math.sin(t * region.freq * TAU) * region.amp * w
      }
      // Eyes: squash toward the region centre so the lid actually closes; a poke
      // widens them; the same regions let the eyes follow a target.
      for (const region of blinkRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        if (!hasBlinkFrame) {
          const widen = poke ? 0.2 : 0
          py = region.cy + (py - region.cy) * (1 - w * (1 - state.blink) - w * widen)
        }
        dx += (look.x - 0.5) * region.rx * 0.3 * w
        dy += (look.y - 0.5) * region.ry * 0.25 * w
      }
      // Mouth: open while the agent is streaming an answer.
      for (const region of talkRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        py = region.cy + (py - region.cy) * (1 + w * talkAmount * 0.55)
      }

      const x = u + dx + shake
      const y = py + dy + bob + hop
      const rx = pivotX + (x - pivotX) * cos - (y - pivotY) * sin
      const ry = pivotY + (x - pivotX) * sin + (y - pivotY) * cos
      // UV v grows downward, clip space grows upward.
      positions[index * 2] = rx * 2 - 1
      positions[index * 2 + 1] = 1 - ry * 2
    }

    gl.clear(gl.COLOR_BUFFER_BIT)
    if (hasBlinkFrame) {
      gl.uniform1f(uBlinkMix, blinkReady ? 1 - state.blink : 0)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions)
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
    reportFirstFrame()

    // Emblems live on the overlay canvas; clear it only when it can have
    // content, so the common idle frame costs nothing.
    const busy = state.mood === 'thinking' || state.mood === 'working'
    const stalled = state.mood === 'waiting'
    const wanted = state.sleeping || state.reaction !== null || busy || stalled
    if (emblemVisible !== wanted) {
      emblemVisible = wanted
      ctx2d.clearRect(0, 0, overlay.width, overlay.height)
    }
    if (state.sleeping) drawSleep(now)
    else if (busy || stalled) drawStateMark(now)
    if (state.reaction !== null) drawMark(state.reaction, now - state.moodSince)
  }

  // The screenshot pipeline waits for the first painted frame; a capture that
  // races it comes back blank.
  let firstFrameReported = false
  const reportFirstFrame = () => {
    if (firstFrameReported || !ready) return
    firstFrameReported = true
    if (typeof options.onReady === 'function') options.onReady()
  }

  raf = requestAnimationFrame(frame)

  return {
    setMood(next) {
      if (next === state.mood) return
      state.mood = next
      state.moodSince = performance.now()
      state.idleSince = next === 'idle' ? performance.now() : state.idleSince
      state.sleeping = false
      state.blink = 1
      state.nextBlinkAt = 0.3
    },
    setTalking(next) {
      state.talking = next === true
    },
    /** Pointer position in normalised sprite coordinates, so the eyes follow it. */
    setPointer(x, y, active) {
      state.pointer = { x, y, active: active !== false }
      if (active !== false) state.idleSince = performance.now()
    },
    /** A transient mark: 'poke' | 'done' | 'error' | 'wake'. */
    react(kind) {
      state.reaction = kind
      state.moodSince = performance.now()
      if (kind === 'wake' || kind === 'poke') state.sleeping = false
    },
    /** While the window is being dragged, so the body can lag behind it. */
    setDragging(active, vx = 0, vy = 0) {
      state.drag = { active: active === true, vx, vy }
    },
    setSleepAfter(ms) {
      if (Number.isFinite(ms) && ms > 0) sleepAfterMs = ms
    },
    isSleeping() {
      return state.sleeping
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      image.onload = null
      if (overlay.parentElement !== null) overlay.parentElement.removeChild(overlay)
      gl.deleteBuffer(positionBuffer)
      gl.deleteBuffer(uvBuffer)
      gl.deleteBuffer(indexBuffer)
      gl.deleteTexture(texture)
      gl.deleteTexture(blinkTexture)
      gl.deleteProgram(program)
    },
  }
}

/**
 * Frame-animation backend.
 *
 * Some characters ship as Codex-style sprite atlases — one grid of cells, one
 * row per animation — rather than a static sprite with a deformation rig. The
 * meme characters on the internet basically all come in this form (192x208 per
 * cell, which is *native* resolution for a 124px pet), so this backend plays
 * those rows directly instead of warping a single image.
 *
 * Same public surface as the mesh backend: the UI layers cannot tell them
 * apart, and a character's manifest decides which one it uses.
 */
function createFrameCharacter(canvas, options) {
  const grid = options.grid || { cols: 9, rows: 8, cellWidth: 192, cellHeight: 208 }
  const animations = options.animations || {}
  const moodMap = options.moodMap || { idle: 'idle', thinking: 'working', working: 'working', waiting: 'waiting', done: 'done', error: 'error', sleeping: 'sleep' }
  const reactionMap = options.reactionMap || { poke: 'poke', done: 'done', error: 'error' }

  const sleepAfterMs = options.sleepAfterMs || 120000
  const idleReaction = 'poke'

  const ctx2d = canvas.getContext('2d')
  if (ctx2d === null) {
    // A canvas that already owns a WebGL context can never hand out a 2D one.
    // This is not recoverable here, so say so loudly: failing silently made a
    // character switch look like "it did not switch and does not move".
    console.error('[dsh-live2d-pet] frame backend needs a fresh canvas: this one already has a WebGL context')
    return { setMood() {}, setTalking() {}, setPointer() {}, react() {}, setDragging() {}, setSleepAfter() {}, isSleeping() { return false }, dispose() {} }
  }

  // The emblems ride a second transparent canvas, exactly like the mesh path:
  // clearing and redrawing them must never touch the character itself.
  const overlay = canvas.ownerDocument.createElement('canvas')
  overlay.style.position = 'absolute'
  overlay.style.inset = '0'
  overlay.style.width = '100%'
  overlay.style.height = '100%'
  overlay.style.pointerEvents = 'none'
  if (canvas.parentElement !== null) canvas.parentElement.appendChild(overlay)
  const emblems = overlay.getContext('2d')

  const image = new Image()
  image.decoding = 'async'
  let ready = false
  let disposed = false
  let raf = 0
  let firstFrameReported = false

  const state = {
    mood: 'idle',
    sleeping: false,
    idleSince: 0,
    animation: 'idle',
    frame: 0,
    frameAt: 0,
    reaction: null,
    reactionLoop: 0,
    pointer: { x: 0.5, y: 0.5, active: false },
  }

  function animationFor(mood) {
    return moodMap[mood] || animations.idle ? (moodMap[mood] || 'idle') : 'idle'
  }

  function cell(animation, frameIndex) {
    const spec = animations[animation]
    if (spec === undefined) return { sx: 0, sy: 0 }
    const row = spec.row
    const index = frameIndex % Math.max(1, spec.frames || 1)
    return { sx: index * grid.cellWidth, sy: row * grid.cellHeight }
  }

  function drawFrame(animation, frameIndex) {
    const spec = animations[animation]
    if (spec === undefined) return
    const { sx, sy } = cell(animation, frameIndex)
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
    ctx2d.drawImage(image, sx, sy, grid.cellWidth, grid.cellHeight, 0, 0, canvas.width, canvas.height)
  }

  // ---- the emblem layer, kept small and self-contained ---------------------
  const TAU = Math.PI * 2
  function anchor(now, index) {
    const size = Math.min(canvas.width, canvas.height)
    return {
      x: canvas.width * (0.5 + index * 0.22),
      y: canvas.height * (0.14 + Math.sin(now / 520 + index) * 0.03),
      size,
    }
  }
  function drawEmblems(now) {
    if (emblems === null) return
    emblems.clearRect(0, 0, overlay.width, overlay.height)
    const mood = state.sleeping ? 'sleeping' : state.mood
    if (state.sleeping) {
      const a = anchor(now, 0)
      emblems.fillStyle = 'rgba(146,166,214,0.95)'
      emblems.font = `700 ${a.size * 0.16}px ui-sans-serif, system-ui, sans-serif`
      emblems.textAlign = 'center'
      for (let i = 0; i < 3; i++) {
        const phase = ((now / 1600) + i * 0.33) % 1
        emblems.globalAlpha = Math.sin(phase * Math.PI) * 0.9
        emblems.fillText('z', anchor(now, i).x, anchor(now, i).y - phase * a.size * 0.14)
      }
      emblems.globalAlpha = 1
    } else if (mood === 'thinking' || mood === 'working') {
      const a = anchor(now, 0)
      emblems.fillStyle = 'rgba(120,150,225,0.9)'
      for (let i = 0; i < 3; i++) {
        const phase = (now / 900 - i * 0.18) % 1
        emblems.globalAlpha = Math.max(0.15, Math.sin(phase * Math.PI))
        emblems.beginPath()
        emblems.arc(a.x + (i - 1) * a.size * 0.1, a.y, a.size * 0.03, 0, TAU)
        emblems.fill()
      }
      emblems.globalAlpha = 1
    } else if (mood === 'waiting') {
      const a = anchor(now, 0)
      emblems.fillStyle = 'rgba(240,170,60,0.95)'
      emblems.font = `700 ${a.size * 0.17}px ui-sans-serif, system-ui, sans-serif`
      emblems.textAlign = 'center'
      emblems.globalAlpha = 0.75 + Math.sin(now / 420) * 0.25
      emblems.fillText('?', a.x, a.y)
      emblems.globalAlpha = 1
    } else if (state.reaction === 'poke') {
      const a = anchor(now, 1)
      emblems.fillStyle = '#ffb020'
      emblems.strokeStyle = 'rgba(45,32,10,0.5)'
      emblems.lineWidth = Math.max(1, a.size * 0.02)
      emblems.translate(a.x, a.y)
      emblems.beginPath()
      emblems.moveTo(-a.size * 0.025, -a.size * 0.17)
      emblems.lineTo(a.size * 0.025, -a.size * 0.17)
      emblems.lineTo(a.size * 0.016, -a.size * 0.03)
      emblems.lineTo(-a.size * 0.016, -a.size * 0.03)
      emblems.closePath()
      emblems.fill()
      emblems.stroke()
      emblems.beginPath()
      emblems.arc(0, a.size * 0.02, a.size * 0.03, 0, TAU)
      emblems.fill()
      emblems.stroke()
    } else if (state.reaction === 'error') {
      const a = anchor(now, 1)
      emblems.fillStyle = '#63b3ff'
      emblems.translate(a.x, a.y)
      emblems.beginPath()
      emblems.moveTo(0, -a.size * 0.17)
      emblems.bezierCurveTo(a.size * 0.14, -a.size * 0.02, a.size * 0.11, a.size * 0.14, 0, a.size * 0.14)
      emblems.bezierCurveTo(-a.size * 0.11, a.size * 0.14, -a.size * 0.14, -a.size * 0.02, 0, -a.size * 0.17)
      emblems.fill()
    }
  }

  function frame(now) {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (!ready) return

    // ---- behaviour ----
    if (state.mood === 'idle' && !state.sleeping && now - state.idleSince > sleepAfterMs) {
      state.sleeping = true
    }
    if (state.mood !== 'idle' && state.sleeping) {
      state.sleeping = false
    }

    // A reaction plays its animation for one loop, then the mood takes over.
    if (state.reaction !== null) {
      const spec = animations[reactionMap[state.reaction]]
      const loopMs = ((spec ? spec.frames : 6) / (spec ? spec.fps : 6)) * 1000
      if (now - state.frameAt > loopMs) {
        state.reaction = null
        state.frame = 0
      }
    }

    const target = state.sleeping
      ? (moodMap.sleeping || 'sleep')
      : state.reaction !== null
        ? (reactionMap[state.reaction] || 'idle')
        : animationFor(state.mood)
    const spec = animations[target] || animations.idle
    const fps = spec ? spec.fps : 4
    const frameMs = 1000 / fps

    if (state.animation !== target) {
      state.animation = target
      state.frame = 0
      state.frameAt = now
    } else if (now - state.frameAt >= frameMs) {
      state.frame += 1
      state.frameAt = now
    }

    drawFrame(state.animation, state.frame)
    drawEmblems(now)

    if (!firstFrameReported) {
      firstFrameReported = true
      if (typeof options.onReady === 'function') options.onReady()
    }
  }

  image.onload = () => {
    canvas.width = grid.cellWidth
    canvas.height = grid.cellHeight
    overlay.width = canvas.width
    overlay.height = canvas.height
    ready = true
  }
  image.src = options.atlas
  raf = requestAnimationFrame(frame)

  return {
    setMood(next) {
      if (next === state.mood) return
      state.mood = next
      state.idleSince = next === 'idle' ? performance.now() : state.idleSince
      state.sleeping = false
    },
    setTalking() {},
    setPointer(x, y, active) {
      state.pointer = { x, y, active: active !== false }
      if (active !== false) state.idleSince = performance.now()
    },
    react(kind) {
      state.reaction = kind
      state.frame = 0
      state.frameAt = performance.now()
      if (kind === 'poke') state.sleeping = false
    },
    setDragging() {},
    setSleepAfter(ms) {
      if (Number.isFinite(ms) && ms > 0) options.sleepAfterMs = ms
    },
    isSleeping() {
      return state.sleeping
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      image.onload = null
      if (overlay.parentElement !== null) overlay.parentElement.removeChild(overlay)
    },
  }
}

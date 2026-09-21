/**
 * Mesh-warp character renderer (WebGL).
 *
 * The default character is a single flat sprite: there is no layered PSD behind
 * it and therefore no Cubism model. What this module does instead is treat the
 * sprite as a deformable mesh — the rig in `puppet.json` names elliptical
 * regions (hair, ahoge, whale-fluke ears, skirt, torso, both eyes, mouth) and
 * every vertex of a grid is displaced by the summed influence of the regions
 * covering it.
 *
 * That buys the motions that make a static drawing read as alive — hair sway,
 * ear flapping, breathing, a blink that genuinely closes the eyes, and a mouth
 * that opens while the agent talks — without the Cubism runtime, the Cubism
 * Core binary, or an authored `.moc3`.
 *
 * Why WebGL rather than many `drawImage` calls: a per-cell 2D blit resamples
 * each cell independently, so neighbouring cells never line up and the whole
 * sprite ends up showing a grid of seams. One textured mesh interpolates across
 * cell boundaries by construction, so the deformation stays continuous.
 *
 * A real Live2D model remains the better answer when one exists; a replacement
 * backend only has to satisfy the four methods the UI layers use (`setMood`,
 * `setTalking`, `setPointer`, `dispose`).
 */

const TAU = Math.PI * 2

/** Mesh resolution: finer than the visible motion, so curves stay smooth. */
const COLS = 24
const ROWS = 44

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
void main() {
  vec4 c = texture2D(uTex, vUV);
  // The sprite is straight-alpha; the canvas is premultiplied. Premultiplying
  // here (rather than letting the blender handle colour alone) is what keeps
  // the canvas's own alpha correct, so soft lace and shadows stay soft instead
  // of turning into a white haze over the page behind the window.
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
 * Mood presets: global body motion. `waiting` barely moves on purpose, so
 * "stalled / needs you" reads differently from "busy" at a glance.
 */
const MOODS = {
  idle: { bob: 1, speed: 1, shake: 0, hop: 0 },
  thinking: { bob: 1.6, speed: 1.7, shake: 0, hop: 0 },
  working: { bob: 1.7, speed: 1.85, shake: 0, hop: 0 },
  waiting: { bob: 0.35, speed: 0.45, shake: 0, hop: 0 },
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
  const rig = options.rig
  const regions = rig.influences || []
  const swayRegions = regions.filter((r) => r.motion === 'sway')
  const flapRegions = regions.filter((r) => r.motion === 'flap')
  const breatheRegions = regions.filter((r) => r.motion === 'breathe')
  const blinkRegions = regions.filter((r) => r.motion === 'blink')
  const talkRegions = regions.filter((r) => r.motion === 'talk')

  const gl = canvas.getContext('webgl', {
    alpha: true,
    // Premultiplied output: the shader premultiplies, and the compositor
    // expects it. The separate alpha blend below accumulates coverage correctly
    // across the mesh's triangles — with a single blendFunc the destination
    // alpha becomes srcAlpha squared, which washes soft edges out.
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
  })

  let disposed = false
  let raf = 0
  let ready = false
  let mood = 'idle'
  let moodSince = 0
  let talking = false
  let pointer = { x: 0.5, y: 0.5, active: false }
  let blink = 1
  let nextBlinkAt = 1.4
  let startedAt = 0

  if (gl === null) {
    // No WebGL: still show the character, just without deformation.
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

  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    ready = true
  }
  image.src = options.sprite

  // ---- per-frame deformation ----------------------------------------------

  function frame(now) {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (!ready) return

    if (startedAt === 0) startedAt = now
    const t = (now - startedAt) / 1000
    const preset = MOODS[mood] || MOODS.idle

    // Blink scheduling: a short close, then a fresh random gap.
    const moodTime = (now - moodSince) / 1000
    if (mood === 'idle' || mood === 'waiting') {
      if (moodTime >= nextBlinkAt) {
        if (blink === 1) {
          blink = 0
          nextBlinkAt = moodTime + 0.16
        } else {
          blink = 1
          nextBlinkAt = moodTime + 2.4 + Math.random() * 3.4
          moodSince = now
        }
      }
    } else if (blink !== 1) {
      blink = 1
    }

    // Global body motion, applied after the mesh is deformed. Everything is in
    // normalised sprite units, then rotated about the feet.
    const lean = (Math.sin(t * 0.8 * preset.speed) * 0.7 * Math.PI) / 180
    const shake = preset.shake ? (Math.sin(t * 26) * 2.6 * preset.shake) / 240 : 0
    const hop = preset.hop ? (Math.max(0, Math.sin(t * 4.2)) * -7 * preset.hop) / 423 : 0
    const bob = Math.sin(t * 1.55 * preset.speed) * 0.011 * preset.bob
    const cos = Math.cos(lean)
    const sin = Math.sin(lean)
    const pivotX = 0.5
    const pivotY = 0.94
    const talkAmount = talking ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 15)) : 0

    for (let index = 0; index < vertexCount; index++) {
      const u = baseU[index]
      const v = baseV[index]

      let dx = 0
      let dy = 0
      let py = v

      for (const region of swayRegions) {
        const w = weightAt(u, v, region)
        if (w !== 0) dx += Math.sin(t * region.freq * TAU + region.phase) * region.amp * w
      }
      for (const region of flapRegions) {
        const w = weightAt(u, v, region)
        if (w !== 0) dy += Math.sin(t * region.freq * TAU + region.phase) * region.amp * w
      }
      for (const region of breatheRegions) {
        const w = weightAt(u, v, region)
        if (w !== 0) dy += Math.sin(t * region.freq * TAU) * region.amp * w
      }
      // Eyes: squash toward the region centre so the lid actually closes; the
      // same regions let the eyes follow the cursor.
      for (const region of blinkRegions) {
        const w = weightAt(u, v, region)
        if (w === 0) continue
        py = region.cy + (py - region.cy) * (1 - w * (1 - blink))
        if (pointer.active) dx += (pointer.x - 0.5) * region.rx * 0.25 * w
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
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions)
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
  }

  raf = requestAnimationFrame(frame)

  return {
    setMood(next) {
      if (next === mood) return
      mood = next
      moodSince = performance.now()
      blink = 1
      nextBlinkAt = 0.3
    },
    setTalking(next) {
      talking = next === true
    },
    /** Pointer position in normalised sprite coordinates, so the eyes follow it. */
    setPointer(x, y, active) {
      pointer = { x, y, active: active !== false }
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      image.onload = null
      gl.deleteBuffer(positionBuffer)
      gl.deleteBuffer(uvBuffer)
      gl.deleteBuffer(indexBuffer)
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
    },
  }
}

// The animated backdrop: an aurora/frost-lattice shader quad, a drifting field of
// ice motes, all in one WebGL canvas
// fixed behind the page. Loaded with a dynamic import so three never sits on the
// path to first paint. It reacts to the pointer (parallax, lattice spotlight),
// to scrolling (camera drift), and to the engine: `energy` rises while a sim
// runs and `burst()` flares once when one finishes.
import * as THREE from 'three'

export interface Palette {
  base0: string
  base1: string
  aurora: [string, string, string]
  mote: string
  /** Additive in the dark, normal blending in the light. */
  additive: boolean
  strength: number
}

export const DARK: Palette = {
  base0: '#090b10',
  base1: '#151920',
  aurora: ['#4fc8ea', '#3fd9c2', '#8b7cf6'],
  mote: '#cdf3ff',
  additive: true,
  strength: 1,
}

export const LIGHT: Palette = {
  base0: '#f6f9fc',
  base1: '#e4edf5',
  aurora: ['#6cc4e6', '#79d9c8', '#a5a8f2'],
  mote: '#3f8fb5',
  additive: false,
  strength: 0.55,
}

export interface SceneHandle {
  setEnergy(on: boolean): void
  setPalette(p: Palette): void
  setReduced(reduced: boolean): void
  burst(): void
  destroy(): void
}

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const quadFrag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uSpot;
uniform float uEnergy;
uniform float uBurst;
uniform float uScroll;
uniform float uStrength;
uniform float uLight;
uniform vec3 uBase0;
uniform vec3 uBase1;
uniform vec3 uA0;
uniform vec3 uA1;
uniform vec3 uA2;
varying vec2 vUv;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
// One aurora curtain: a bright lower hem that wanders with time, and a long
// streaked glow rising from it.
float curtain(vec2 uv, float base, float freq, float speed, float t, float seed) {
  float wander = 0.09 * sin(uv.x * freq + t * speed + seed) + 0.22 * (fbm(vec2(uv.x * 1.3 + t * speed * 0.6, seed)) - 0.5);
  float d = uv.y - (base + wander);
  float streak = 0.35 + 0.65 * noise(vec2(uv.x * 34.0 + seed * 7.0 + wander * 20.0, t * 2.5));
  float rise = step(0.0, d) * exp(-d * 4.2) * streak;
  float hem = exp(-abs(d) * 55.0);
  float ends = smoothstep(1.2, 0.2, abs(uv.x + 0.25 * sin(seed + t * 0.2)));
  return (rise * 0.55 + hem * 0.9) * ends;
}

// Distance to the edge of the nearest hexagon: the frost lattice.
float hexEdge(vec2 p) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  g = abs(g);
  return 0.5 - max(dot(g, normalize(r)), g.x);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * uRes) / uRes.y;
  float t = uTime * (0.035 + 0.05 * uEnergy);

  vec3 col = mix(uBase0, uBase1, smoothstep(-0.7, 0.8, -uv.y + 0.2));

  // Aurora: domain-warped fbm ribbons with vertical curtain streaks, heavier
  // toward the top of the page and drifting as the page scrolls.
  vec2 p = uv * vec2(0.9, 1.9) + vec2(0.0, uScroll * 0.12) + uMouse * 0.05;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + 1.3 * t), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t));
  float f = fbm(p + 2.6 * r);
  float band = smoothstep(0.32, 0.78, f);
  float streak = 0.55 + 0.45 * noise(vec2(uv.x * 26.0 + r.y * 9.0, t * 4.0));
  float veil = smoothstep(-0.95, 0.65, uv.y + uScroll * 0.05);
  vec3 aurora = mix(uA0, uA2, clamp(r.x * 1.6 - 0.45, 0.0, 1.0));
  aurora = mix(aurora, uA1, clamp(q.y * 1.5 - 0.6, 0.0, 1.0));
  float glow = band * streak * veil * (0.5 + 0.35 * uEnergy + 0.8 * uBurst) * uStrength;
  col += aurora * glow * (uLight > 0.5 ? 0.5 : 1.2);

  // Three curtains across the upper half, each in its own colour.
  vec2 cu = uv + vec2(uMouse.x * 0.03, uScroll * 0.08);
  float ct = uTime * (0.25 + 0.3 * uEnergy);
  float lift = 0.35 + 0.25 * uEnergy + 0.9 * uBurst;
  vec3 curtains =
    uA0 * curtain(cu, 0.16, 2.3, 0.35, ct, 1.7) +
    uA1 * curtain(cu, 0.02, 3.1, -0.28, ct, 4.1) * 0.7 +
    uA2 * curtain(cu, 0.3, 1.7, 0.22, ct, 7.9) * 0.8;
  col += curtains * lift * uStrength * (uLight > 0.5 ? 0.45 : 1.0);
  // Soft cold bloom near the top centre, like the original CSS bloom.
  col += uA0 * 0.12 * uStrength * exp(-length((uv - vec2(0.0, 0.62)) * vec2(0.8, 2.0)) * 1.4);

  // Frost lattice: invisible at rest, drawn in around the pointer.
  vec2 m = vec2(uSpot.x * 0.5 * uRes.x / uRes.y, uSpot.y * 0.5);
  float spot = exp(-length(uv - m) * 4.5);
  float line = smoothstep(0.022, 0.0, hexEdge(uv * 6.0 + vec2(0.0, uScroll * 0.5)));
  float lattice = line * (0.004 + 0.13 * spot + 0.05 * uBurst) * uStrength;
  col += mix(uA0, vec3(1.0), 0.25) * lattice * (uLight > 0.5 ? -0.6 : 1.0);

  // Vignette and a touch of grain so the gradients never band.
  float vig = 1.0 - (uLight > 0.5 ? 0.08 : 0.38) * dot(uv * 0.85, uv * 0.85);
  col *= vig;
  col += (hash(frag + fract(uTime)) - 0.5) / 255.0 * 3.0;
  gl_FragColor = vec4(col, 1.0);
}
`

const moteVert = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform float uTime;
uniform float uFall;
uniform float uPixel;
varying float vAlpha;
varying float vSeed;
void main() {
  vec3 p = position;
  float speed = 0.12 + aSeed * 0.22;
  p.y = mod(p.y - uFall * speed + 11.0, 22.0) - 11.0;
  p.x += sin(uTime * 0.25 + aSeed * 31.0) * 0.45;
  p.z += cos(uTime * 0.18 + aSeed * 17.0) * 0.35;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixel * (12.0 / -mv.z);
  float twinkle = 0.55 + 0.45 * sin(uTime * (1.2 + aSeed * 2.0) + aSeed * 60.0);
  vAlpha = twinkle * smoothstep(-26.0, -7.0, mv.z) * smoothstep(-1.0, -4.0, mv.z);
  vSeed = aSeed;
}
`

const moteFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = pow(smoothstep(0.5, 0.0, d), 2.6);
  // One mote in eight is a star: a four-point glint.
  float glint = max(
    smoothstep(0.05, 0.0, abs(c.x)) * smoothstep(0.5, 0.0, abs(c.y)),
    smoothstep(0.05, 0.0, abs(c.y)) * smoothstep(0.5, 0.0, abs(c.x))
  ) * step(0.875, vSeed);
  float a = (core + glint * 0.7) * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`

export function createScene(canvas: HTMLCanvasElement, initial: Palette, reducedAtStart: boolean): SceneHandle | null {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: true, powerPreference: 'high-performance' })
  } catch {
    return null
  }
  renderer.autoClear = false
  // Ambient art, not UI: CSS pixels (not retina) and 30 fps. At 2x and 120 Hz the aurora's
  // ~45 noise lookups per pixel held a laptop GPU near 90% on every page.
  const pixel = Math.min(devicePixelRatio || 1, 1)
  renderer.setPixelRatio(pixel)

  let reduced = reducedAtStart
  let palette = initial

  // ---- background quad
  const quadUniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2() },
    uSpot: { value: new THREE.Vector2(0, 4) },
    uEnergy: { value: 0 },
    uBurst: { value: 0 },
    uScroll: { value: 0 },
    uStrength: { value: 1 },
    uLight: { value: 0 },
    uBase0: { value: new THREE.Color() },
    uBase1: { value: new THREE.Color() },
    uA0: { value: new THREE.Color() },
    uA1: { value: new THREE.Color() },
    uA2: { value: new THREE.Color() },
  }
  const bgScene = new THREE.Scene()
  const bgCamera = new THREE.Camera()
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: quadFrag, uniforms: quadUniforms, depthWrite: false, depthTest: false }),
  )
  quad.frustumCulled = false
  bgScene.add(quad)

  // ---- 3D layer
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60)
  camera.position.set(0, 0, 10)

  const COUNT = 1400
  const positions = new Float32Array(COUNT * 3)
  const sizes = new Float32Array(COUNT)
  const seeds = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 34
    positions[i * 3 + 1] = (Math.random() - 0.5) * 22
    positions[i * 3 + 2] = -Math.random() * 22 + 2
    sizes[i] = 1 + Math.pow(Math.random(), 3) * 5
    seeds[i] = Math.random()
  }
  const moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  moteGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  const moteUniforms = {
    uTime: { value: 0 },
    uFall: { value: 0 },
    uPixel: { value: pixel },
    uColor: { value: new THREE.Color() },
    uOpacity: { value: 1 },
  }
  const moteMat = new THREE.ShaderMaterial({
    vertexShader: moteVert, fragmentShader: moteFrag, uniforms: moteUniforms,
    transparent: true, depthWrite: false,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  scene.add(motes)

  function applyPalette(p: Palette): void {
    quadUniforms.uBase0.value.set(p.base0)
    quadUniforms.uBase1.value.set(p.base1)
    quadUniforms.uA0.value.set(p.aurora[0])
    quadUniforms.uA1.value.set(p.aurora[1])
    quadUniforms.uA2.value.set(p.aurora[2])
    quadUniforms.uStrength.value = p.strength
    quadUniforms.uLight.value = p.additive ? 0 : 1
    moteUniforms.uColor.value.set(p.mote)
    moteUniforms.uOpacity.value = p.additive ? 0.85 : 0.5
    const blending = p.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    moteMat.blending = blending
    moteMat.needsUpdate = true
    renderer.setClearColor(p.base0)
  }
  applyPalette(palette)

  function resize(): void {
    const w = canvas.clientWidth || innerWidth
    const h = canvas.clientHeight || innerHeight
    renderer.setSize(w, h, false)
    quadUniforms.uRes.value.set(w * pixel, h * pixel)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()

  // ---- inputs
  // The loop freezes once nothing has happened for a few seconds: every frosted panel re-blurs
  // the backdrop on each frame it changes, which held the GPU busy on an idle page.
  const IDLE_MS = 4000
  let lastInput = performance.now()
  const wake = () => { lastInput = performance.now(); start() }
  const target = new THREE.Vector2()
  const mouse = new THREE.Vector2()
  // The lattice spotlight starts off-screen so nothing is lit until the pointer moves.
  const spotTarget = new THREE.Vector2(0, 4)
  const spot = new THREE.Vector2(0, 4)
  const onPointer = (e: PointerEvent) => {
    target.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1))
    spotTarget.copy(target)
    wake()
  }
  const onLeave = () => { spotTarget.set(target.x, 4); wake() }
  document.documentElement.addEventListener('pointerleave', onLeave)
  addEventListener('pointermove', onPointer, { passive: true })
  let scrollTarget = scrollY / Math.max(innerHeight, 1)
  let scroll = scrollTarget
  const onScroll = () => { scrollTarget = scrollY / Math.max(innerHeight, 1); wake() }
  addEventListener('scroll', onScroll, { passive: true })
  const ro = new ResizeObserver(() => { resize(); if (!raf) render() })
  ro.observe(canvas)

  // ---- loop
  let energyTarget = 0
  let energy = 0
  let burst = 0
  let t = 14 // start far enough in that the aurora has shape on the first frame
  let fall = 0
  let last = 0
  let raf = 0

  function render(): void {
    quadUniforms.uTime.value = t
    quadUniforms.uMouse.value.copy(mouse)
    quadUniforms.uSpot.value.copy(spot)
    quadUniforms.uEnergy.value = energy
    quadUniforms.uBurst.value = burst
    quadUniforms.uScroll.value = scroll
    moteUniforms.uTime.value = t
    moteUniforms.uFall.value = fall

    camera.position.x = mouse.x * 0.9
    camera.position.y = mouse.y * 0.6 - scroll * 1.1
    camera.lookAt(mouse.x * 0.3, -scroll * 1.1, -6)

    renderer.clear()
    renderer.render(bgScene, bgCamera)
    renderer.render(scene, camera)
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame)
    if (last && now - last < 1000 / 30 - 2) return
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60
    last = now
    const k = 1 - Math.exp(-dt * 2.2)
    energy += (energyTarget - energy) * k
    burst = Math.max(0, burst - dt * 0.7)
    mouse.lerp(target, 1 - Math.exp(-dt * 3))
    spot.lerp(spotTarget, 1 - Math.exp(-dt * 8))
    scroll += (scrollTarget - scroll) * (1 - Math.exp(-dt * 6))
    t += dt * (1 + energy * 1.4 + burst * 2.5)
    fall += dt * (1 + energy * 2 + burst * 6)
    render()
    if (now - lastInput > IDLE_MS && !energyTarget && !burst) stop()
  }

  function start(): void {
    if (raf || reduced || document.visibilityState !== 'visible') return
    last = 0
    raf = requestAnimationFrame(frame)
  }
  function stop(): void {
    cancelAnimationFrame(raf)
    raf = 0
  }
  const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
  document.addEventListener('visibilitychange', onVisibility)

  render()
  start()

  return {
    setEnergy(on) { energyTarget = on ? 1 : 0; wake() },
    setPalette(p) { palette = p; applyPalette(p); if (!raf) render() },
    setReduced(r) {
      reduced = r
      if (r) { stop(); render() } else start()
    },
    burst() { if (!reduced) { burst = 1; wake() } },
    destroy() {
      stop()
      removeEventListener('pointermove', onPointer)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      moteGeo.dispose(); moteMat.dispose()
      quad.geometry.dispose(); (quad.material as THREE.Material).dispose()
      renderer.dispose()
    },
  }
}

import * as THREE from 'three'
import { DEG, rng, library, make, hold, pose, bake } from './dsl.js'

// The model library is plain text shipped in the page (see models.txt).
const lib = library(document.getElementById('models').textContent)

const SIZE = 260 // world is SIZE x SIZE units, centred on 0,0
const WATER = 0.2
const ITEMS = ['sword', 'axe', 'torch']
const FOES = ['slime', 'slime', 'goblin', 'spider', 'bat']
const R = rng(1337)

// ---------- renderer, scene, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
const DAY = new THREE.Color('#9cc8e8')
const NIGHT = new THREE.Color('#16204a')
const sky = DAY.clone()
let day = 1
scene.background = sky
scene.fog = new THREE.Fog(sky, 40, 110)
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 200)
const hemi = new THREE.HemisphereLight('#dfefff', '#4a5a30', 1.3)
scene.add(hemi)
const sun = new THREE.DirectionalLight('#fff4dd', 2.2)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 })
scene.add(sun, sun.target)

function resize() {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// ---------- terrain: seeded value noise ----------
const hash = (x, z) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return s - Math.floor(s)
}
const noise = (x, z) => {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  let fx = x - ix
  let fz = z - iz
  fx *= fx * (3 - 2 * fx)
  fz *= fz * (3 - 2 * fz)
  const a = hash(ix, iz)
  const b = hash(ix + 1, iz)
  const c = hash(ix, iz + 1)
  const d = hash(ix + 1, iz + 1)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
function height(x, z) {
  let h = 0
  for (let o = 0, f = 0.015, a = 6; o < 4; o++, f *= 2.1, a *= 0.45) h += (noise(x * f + o * 17, z * f) - 0.5) * a
  const edge = Math.max(Math.abs(x), Math.abs(z)) / (SIZE / 2)
  return h + 1.2 + Math.max(0, edge - 0.8) * 60 // the map's rim rises into hills
}

{
  const seg = 160
  const g = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg).rotateX(-90 * DEG)
  const p = g.attributes.position
  const col = []
  const c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const z = p.getZ(i)
    const h = height(x, z)
    p.setY(i, h)
    const n = noise(x * 0.3, z * 0.3) * 0.08
    if (h < WATER + 0.4) c.set('#d8c890')
    else if (h < 5) c.setRGB(0.3 + n, 0.55 + n, 0.22)
    else c.setRGB(0.48 + n, 0.47 + n, 0.42 + n)
    col.push(c.r, c.g, c.b)
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))
  ground.receiveShadow = true
  scene.add(ground)
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-90 * DEG),
    new THREE.MeshLambertMaterial({ color: '#3a7ab8', transparent: true, opacity: 0.75 })
  )
  water.position.y = WATER
  scene.add(water)
}

// start on dry land near the middle of the map
const home = new THREE.Vector3()
for (let a = 0; height(home.x, home.z) < 2; a += 0.5) home.set(Math.cos(a) * a * 0.3, 0, Math.sin(a) * a * 0.3)

// ---------- scenery: each kind compiled from text in a few seeded variants, then instanced ----------
const trees = [] // colliders: [x, z, radius]
for (const [kind, count, radius] of [
  ['pine', 500, 0.5],
  ['oak', 300, 0.6],
  ['rock', 250, 0.8],
  ['bush', 400, 0],
]) {
  for (let v = 0; v < 4; v++) {
    const m = make(lib, kind, v + 1)
    const mesh = new THREE.InstancedMesh(bake(m), m.mat, count / 4)
    mesh.castShadow = mesh.receiveShadow = true
    const o = new THREE.Object3D()
    for (let i = 0; i < mesh.count; i++) {
      let x, z, h
      do {
        x = (R() - 0.5) * SIZE * 0.9
        z = (R() - 0.5) * SIZE * 0.9
        h = height(x, z)
      } while (h < WATER + 0.5 || Math.hypot(x - home.x, z - home.z) < 6)
      const s = 0.8 + R() * 0.5
      o.position.set(x, h - 0.1, z)
      o.rotation.y = R() * 7
      o.scale.setScalar(s)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
      if (radius) trees.push([x, z, radius * s])
    }
    scene.add(mesh)
  }
}

// ---------- actors ----------
// An actor is a model (compiled from text) plus game state. Player and monsters share it.
class Actor {
  constructor(kind, seed) {
    this.kind = kind
    this.seed = seed
    this.m = make(lib, kind, seed)
    this.g = new THREE.Group()
    this.g.add(this.m.root)
    scene.add(this.g)
    this.pos = this.g.position
    this.vel = new THREE.Vector2() // knockback
    this.dir = 0
    this.speed = 0
    this.time = 0
    this.once = null // one-shot clip: [name, t]
    this.hp = this.maxHp = 1
    this.flash = 0
    this.burn = 0
  }
  play(name) {
    if (this.m.clips[name]) this.once = [name, 0]
  }
  get busy() {
    return this.once && this.once[1] < this.m.clips[this.once[0]].d
  }
  move(dx, dz, dt) {
    let x = this.pos.x + dx + this.vel.x * dt
    let z = this.pos.z + dz + this.vel.y * dt
    for (const [tx, tz, r] of trees) {
      const ex = x - tx
      const ez = z - tz
      const d = Math.hypot(ex, ez)
      if (d < r + 0.4 && d > 0) {
        x = tx + (ex / d) * (r + 0.4)
        z = tz + (ez / d) * (r + 0.4)
      }
    }
    const lim = SIZE / 2 - 25
    this.pos.x = Math.max(-lim, Math.min(lim, x))
    this.pos.z = Math.max(-lim, Math.min(lim, z))
    this.vel.multiplyScalar(Math.max(0, 1 - dt * 6))
  }
  update(dt, run) {
    this.time += dt
    if (this.once) this.once[1] += dt
    const k = Math.min(1, this.speed / run)
    const layers = [
      ['idle', this.time, 1 - k],
      ['walk', this.time * Math.max(0.6, k), k],
    ]
    if (this.once) layers.push([this.once[0], this.once[1], 1])
    pose(this.m, layers)
    this.pos.y = Math.max(WATER - 0.35, height(this.pos.x, this.pos.z))
    this.g.rotation.y = this.dir
    this.flash = Math.max(0, this.flash - dt * 4)
    this.m.mat.emissive.setRGB(this.flash * 0.7 + this.burn * 0.12, this.flash * 0.3 + this.burn * 0.04, this.flash * 0.3)
  }
}

// ---------- HUD ----------
const $ = (id) => document.getElementById(id)
function hud() {
  $('hp').style.width = (Math.max(0, player.hp) / player.maxHp) * 100 + '%'
  $('info').textContent = player.hp > 0 ? `${item ? item.name : ''} · ${player.kills} kills` : `You fell after ${player.kills} kills…`
}

// ---------- player ----------
const player = new Actor('warrior', 1)
player.hp = player.maxHp = 30
player.pos.copy(home)
player.item = 0
player.kills = 0
let item
function equip(i) {
  player.item = (i + ITEMS.length) % ITEMS.length
  const p = hold(lib, player.m, 'handR', ITEMS[player.item])
  item = p.vars
  torchLight.intensity = item.burn ? 30 : 0
  hud()
}
const torchLight = new THREE.PointLight('#ff9a40', 0, 12, 1.5)
scene.add(torchLight)
equip(0)

// ---------- monsters ----------
const foes = []
let seedNext = 100
// More monsters roam at night: 12 by day, up to 22 in the dark.
const crowd = () => 12 + Math.round((1 - day) * 10)
function spawn(f) {
  const kind = FOES[(R() * FOES.length) | 0]
  if (f) {
    scene.remove(f.g)
    foes.splice(foes.indexOf(f), 1)
    if (foes.length >= crowd()) return
  }
  const e = new Actor(kind, seedNext++)
  let x, z
  do {
    const a = R() * 7
    const d = 18 + R() * 30
    x = player.pos.x + Math.cos(a) * d
    z = player.pos.z + Math.sin(a) * d
  } while (height(x, z) < WATER + 0.3 && R() < 0.95)
  e.pos.set(x, 0, z)
  const s = e.m.root.scale.x
  e.hp = e.maxHp = Math.round({ slime: 5, goblin: 8, spider: 7, bat: 4 }[kind] * (0.6 + s * 0.6))
  e.run = { slime: 3, goblin: 4.2, spider: 5, bat: 4.5 }[kind]
  e.dmg = { slime: 1, goblin: 2, spider: 2, bat: 1 }[kind]
  e.reach = 1.2 + s * 0.4
  e.wander = 0
  e.cool = 1
  foes.push(e)
}
for (let i = 0; i < 14; i++) spawn()

// ---------- health bars: two flat planes over each hurt monster, facing the camera ----------
// The bar is a child of the monster's group, so it leaves the scene with it; geometry and the
// four materials are shared, so a kill frees nothing and leaks nothing.
const barGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0) // grows rightwards from x = 0
const barMat = (c) => new THREE.MeshBasicMaterial({ color: c, fog: false, depthTest: false, transparent: true })
const barBack = barMat('#111')
const barFills = ['#e33', '#eb3', '#4d4'].map(barMat)
const barQ = new THREE.Quaternion()
function bars(dt) {
  for (const e of foes) {
    let b = e.bar
    if (!b) {
      if (e.hp >= e.maxHp) continue // hidden until the first hit
      e.g.updateWorldMatrix(false, true)
      const top = new THREE.Box3().setFromObject(e.m.root).max.y - e.pos.y
      const w = 0.5 + e.m.root.scale.x * 0.4
      b = e.bar = new THREE.Group()
      b.position.y = top + 0.35
      b.add(new THREE.Mesh(barGeo, barBack), (b.fill = new THREE.Mesh(barGeo, barFills[2])))
      b.children[0].scale.set(w + 0.08, 0.16, 1)
      b.children[0].position.x = -w / 2 - 0.04
      b.fill.position.x = -w / 2
      b.fill.scale.set(w, 0.09, 1)
      b.children[0].renderOrder = 998
      b.fill.renderOrder = 999
      b.w = w
      b.v = 1
      e.g.add(b)
    }
    const f = Math.max(0, e.hp) / e.maxHp
    b.v += (f - b.v) * Math.min(1, dt * 8) // ease the fill down
    b.visible = e.hp > 0
    b.fill.scale.x = Math.max(0.001, b.v * b.w)
    b.fill.material = barFills[f > 0.6 ? 2 : f > 0.3 ? 1 : 0]
    b.quaternion.copy(barQ.copy(e.g.quaternion).invert()).multiply(camera.quaternion) // billboard
  }
}

// ---------- particles: little cubes for hits ----------
const bits = []
const bitGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12)
function burst(p, color, n = 8) {
  for (let i = 0; i < n; i++) {
    const b = new THREE.Mesh(bitGeo, new THREE.MeshBasicMaterial({ color }))
    b.position.copy(p)
    b.position.y += 0.7
    b.v = new THREE.Vector3(R() * 6 - 3, R() * 5 + 2, R() * 6 - 3)
    b.life = 0.7
    scene.add(b)
    bits.push(b)
  }
}

// ---------- sound: a few synthesized blips ----------
let ac
function beep(f, d = 0.1, type = 'square', vol = 0.06, slide = 0.5) {
  try {
    ac ||= new AudioContext()
    const o = ac.createOscillator()
    const g = ac.createGain()
    o.type = type
    o.frequency.setValueAtTime(f, ac.currentTime)
    o.frequency.exponentialRampToValueAtTime(f * slide, ac.currentTime + d)
    g.gain.setValueAtTime(vol, ac.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + d)
    o.connect(g).connect(ac.destination)
    o.start()
    o.stop(ac.currentTime + d)
  } catch {}
}

// ---------- input: keyboard + touch ----------
const keys = {}
let camYaw = 45 * DEG
addEventListener('keydown', (e) => {
  keys[e.code] = 1
  if (e.code == 'Space' || e.code == 'KeyJ') attack()
  if (e.code == 'KeyF' || e.code == 'Tab') equip(player.item + 1)
  if (e.code.startsWith('Digit')) equip(+e.code[5] - 1)
  if (e.code == 'Tab') e.preventDefault()
})
addEventListener('keyup', (e) => (keys[e.code] = 0))
const stick = { id: null, x: 0, y: 0, ox: 0, oy: 0 }
addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (t.target.id == 'swap') equip(player.item + 1)
    else if (t.target.id == 'hit') attack()
    else if (stick.id == null) Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 })
  }
  $('pad').style.display = 'block'
  $('help').textContent = 'Drag to move'
})
addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches)
    if (t.identifier == stick.id) {
      stick.x = Math.max(-1, Math.min(1, (t.clientX - stick.ox) / 50))
      stick.y = Math.max(-1, Math.min(1, (t.clientY - stick.oy) / 50))
    }
  e.preventDefault()
}, { passive: false })
addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) if (t.identifier == stick.id) Object.assign(stick, { id: null, x: 0, y: 0 })
})

// ---------- combat ----------
function attack() {
  if (player.busy || player.hp <= 0) return
  player.play(item.anim)
  player.struck = false
  beep(180, 0.15, 'sawtooth', 0.04, 0.4)
}
function hurt(e, dmg, from, push) {
  if (e.safe > 0) return
  if (e == player) e.safe = 0.6 // a moment of grace after each hit
  e.hp -= dmg
  e.flash = 1
  const dx = e.pos.x - from.x
  const dz = e.pos.z - from.z
  const d = Math.hypot(dx, dz) || 1
  e.vel.set((dx / d) * push, (dz / d) * push)
  burst(e.pos, e == player ? '#e33' : '#' + (e.m.vars.c || 'fff'), 6 + dmg)
  if (e.hp <= 0) {
    e.play('death')
    e.dead = 0
    if (e != player) {
      player.kills++
      beep(330, 0.3, 'square', 0.05, 0.3)
    } else beep(110, 0.8, 'sawtooth', 0.08, 0.3)
  } else {
    if (!(e == player && e.busy)) e.play('hit') // a hit doesn't cancel the player's swing
    beep(e == player ? 140 : 520, 0.12, 'square', 0.05, 0.5)
  }
  hud()
}

// ---------- main loop ----------
const clock = new THREE.Clock()
const fwd = new THREE.Vector3()
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  if (keys.KeyQ) camYaw += dt * 2
  if (keys.KeyE) camYaw -= dt * 2

  // player movement relative to the camera
  let ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + stick.x
  let iz = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0) + stick.y
  const il = Math.hypot(ix, iz)
  const alive = player.hp > 0
  const run = 6
  if (il > 0.1 && alive) {
    ix /= Math.max(1, il)
    iz /= Math.max(1, il)
    const c = Math.cos(camYaw)
    const s = Math.sin(camYaw)
    const dx = ix * c + iz * s
    const dz = -ix * s + iz * c
    const slow = player.busy ? 0.5 : 1
    player.move(dx * run * slow * dt, dz * run * slow * dt, dt)
    player.dir = Math.atan2(dx, dz)
    player.speed = run * Math.min(1, il) * slow
  } else {
    player.move(0, 0, dt)
    player.speed = 0
  }
  // the blow lands partway through the swing
  if (player.once && player.once[0] == item.anim && !player.struck && player.once[1] > player.m.clips[item.anim].d * 0.45) {
    player.struck = true
    for (const e of foes) {
      if (e.hp <= 0) continue
      const dx = e.pos.x - player.pos.x
      const dz = e.pos.z - player.pos.z
      const d = Math.hypot(dx, dz)
      let a = Math.atan2(dx, dz) - player.dir
      a = Math.atan2(Math.sin(a), Math.cos(a))
      if (d < item.reach + e.m.root.scale.x * 0.4 && Math.abs(a) < 1.2) {
        hurt(e, item.dmg, player.pos, item.push)
        if (item.burn) e.burn = item.burn
      }
    }
  }
  player.update(dt, run)
  player.safe -= dt
  if (!alive && (player.dead += dt) > 3) {
    player.hp = player.maxHp
    player.once = null
    player.pos.copy(home)
    hud()
  }
  if (alive && player.hp < player.maxHp) {
    player.regen = (player.regen || 0) + dt
    if (player.regen > 2) {
      player.regen = 0
      player.hp++
      hud()
    }
  }

  // monsters: wander, chase, attack, die, respawn
  if (foes.length < crowd() && R() < dt) spawn()
  for (const e of [...foes]) {
    if (e.hp <= 0) {
      e.dead += dt
      e.update(dt, e.run)
      e.g.scale.setScalar(Math.max(0.01, Math.min(1, 2.4 - e.dead))) // shrink away, then respawn
      if (e.dead > 3) spawn(e)
      continue
    }
    if (e.burn > 0) {
      e.burn -= dt
      e.burnTick = (e.burnTick || 0) + dt
      if (e.burnTick > 1) {
        e.burnTick = 0
        hurt(e, 1, e.pos, 0)
        if (e.hp <= 0) continue
      }
    }
    const dx = player.pos.x - e.pos.x
    const dz = player.pos.z - e.pos.z
    const d = Math.hypot(dx, dz)
    let tx = 0
    let tz = 0
    let sp = 0
    e.cool -= dt
    if (d > 70) {
      spawn(e)
      continue
    }
    if (alive && d < 12 && !(e.burn > 0 && e.kind != 'slime')) {
      // chase, then attack when close
      if (d > e.reach) {
        tx = dx / d
        tz = dz / d
        sp = e.run
      } else if (e.cool <= 0 && !e.busy) {
        e.play('attack')
        e.cool = 1.8 + R() * 1.5
        e.striking = true
      }
      e.dir = Math.atan2(dx, dz)
    } else {
      // wander, or flee while burning
      e.wander -= dt
      if (e.wander < 0) {
        e.wander = 2 + R() * 3
        e.wa = R() < 0.4 ? null : R() * 7
      }
      if (e.burn > 0) e.wa = Math.atan2(-dx, -dz)
      if (e.wa != null) {
        tx = Math.sin(e.wa)
        tz = Math.cos(e.wa)
        sp = e.run * (e.burn > 0 ? 1.3 : 0.4)
        e.dir = e.wa
      }
    }
    if (e.busy && e.once[0] != 'walk') sp *= 0.3
    // keep monsters from stacking on each other
    for (const o of foes)
      if (o != e && o.hp > 0) {
        const ox = e.pos.x - o.pos.x
        const oz = e.pos.z - o.pos.z
        const od = Math.hypot(ox, oz)
        if (od < 1 && od > 0) {
          tx += (ox / od) * 0.5
          tz += (oz / od) * 0.5
        }
      }
    e.move(tx * sp * dt, tz * sp * dt, dt)
    e.speed = sp
    if (e.striking && e.once && e.once[0] == 'attack' && e.once[1] > e.m.clips.attack.d * 0.5) {
      e.striking = false
      if (d < e.reach + 0.6 && alive) hurt(player, e.dmg, e.pos, 5)
    }
    e.update(dt, e.run)
  }

  for (const b of [...bits]) {
    b.life -= dt
    b.v.y -= 15 * dt
    b.position.addScaledVector(b.v, dt)
    b.scale.setScalar(Math.max(0.01, b.life / 0.7))
    if (b.life <= 0) {
      scene.remove(b)
      bits.splice(bits.indexOf(b), 1)
    }
  }

  // torch light follows the flame
  const flame = player.m.props.handR?.bones.flame
  if (flame) {
    flame.getWorldPosition(torchLight.position)
    torchLight.intensity = (2 + 10 * (1 - day)) * (1 + Math.sin(clock.elapsedTime * 20) * 0.15)
  }

  // day and night: a 3-minute cycle, starting mid-morning
  day = Math.min(1, Math.max(0, Math.cos(clock.elapsedTime / 30 + 0.6) * 0.8 + 0.6))
  sky.lerpColors(NIGHT, DAY, day)
  scene.fog.color.copy(sky)
  sun.intensity = 2.4 * day
  hemi.intensity = 0.5 + day * 0.8

  // camera: a high three-quarter view that trails the player
  const target = player.pos
  fwd.set(Math.sin(camYaw) * 7, 7.5, Math.cos(camYaw) * 7)
  camera.position.lerp(fwd.add(target), clock.elapsedTime < 0.2 ? 1 : Math.min(1, dt * 5))
  camera.lookAt(target.x, target.y + 1, target.z)
  sun.position.set(target.x + 20, target.y + 40, target.z + 10)
  sun.target.position.copy(target)

  bars(dt)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
hud()
frame()

window.game = { player, foes, equip, attack, clock } // for play-testing from the console

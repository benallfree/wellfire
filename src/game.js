import * as THREE from 'three'
import { DEG, rng, library, make, hold, pose, bake } from './compiler.js'
import { score, jukebox } from './music.js'

// The model library is JSON shipped in the page (see models.json).
const lib = library(document.getElementById('models').textContent)

const WATER = 0.2
const ITEMS = ['sword', 'axe', 'torch']
// monster mix and how crowded it gets, per region (meadow, forest, rocky hills, lakes)
const FOES = [
  ['slime', 'slime', 'bat', 'goblin'],
  ['spider', 'spider', 'goblin', 'slime'],
  ['goblin', 'goblin', 'bat', 'spider'],
  ['slime', 'slime', 'slime', 'bat'],
]
const CROWD = [1, 1.3, 1.1, 0.7]
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

// ---------- world: endless, derived from SEED; nothing generated is stored beyond the active radius ----------
// Every function here is pure in (SEED, x, z): the same coordinates give the same ground and the same scenery on
// every visit and every page load. Chunks of CH x CH units are built around the player a couple per frame and thrown
// away when far. The only world state that grows is `seen`, the minimap's revealed cells.
const SEED = 1337
const CH = 40 // chunk size in units
const NEAR = 3 // build chunks within this many chunks of the player (fog ends at 110)
const hash = (x, z, s = SEED) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(s, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const noise = (x, z, s) => {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  let fx = x - ix
  let fz = z - iz
  fx *= fx * (3 - 2 * fx)
  fz *= fz * (3 - 2 * fz)
  const a = hash(ix, iz, s)
  const b = hash(ix + 1, iz, s)
  const c = hash(ix, iz + 1, s)
  const d = hash(ix + 1, iz + 1, s)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
// Regions come from two slow fields: wet (forest, then lakes) and rough (rocky hills).
const wet = (x, z) => noise(x * 0.004, z * 0.004, SEED + 1)
const rough = (x, z) => noise(x * 0.003, z * 0.003, SEED + 2)
const REGIONS = ['meadow', 'forest', 'rocky hills', 'lakes']
const region = (x, z) => (wet(x, z) > 0.66 ? 3 : rough(x, z) > 0.58 ? 2 : wet(x, z) > 0.47 ? 1 : 0)
function height(x, z) {
  let h = 0
  for (let o = 0, f = 0.015, a = 6; o < 4; o++, f *= 2.1, a *= 0.45) h += (noise(x * f, z * f, SEED + 10 + o) - 0.5) * a
  const r = rough(x, z)
  return flatten(x, z, h * (0.6 + r * 1.2) + 2 + Math.max(0, r - 0.5) * 30 - Math.max(0, wet(x, z) - 0.63) * 60)
}
// Ground colour at a point, shared by the terrain mesh and the minimap.
function ground(c, x, z, h = height(x, z)) {
  const n = noise(x * 0.3, z * 0.3, SEED + 3) * 0.08
  const r = region(x, z)
  if (h < WATER + 0.4) c.set('#d8c890')
  else if (h > 5 + (r == 2 ? -2 : 2)) c.setRGB(0.48 + n, 0.47 + n, 0.42 + n)
  else if (r == 1) c.setRGB(0.22 + n, 0.45 + n, 0.18)
  else c.setRGB(0.32 + n, 0.57 + n, 0.23)
  return c
}

// ---------- villages: pick a dry, gentle site near the start and level the ground there ----------
// A village is a circular zone: no weapons inside, and monsters stay out.
let town = null
function flatten(x, z, h) {
  if (!town) return h
  const d = Math.hypot(x - town.x, z - town.z)
  const k = Math.min(1, Math.max(0, (d - town.r) / 8))
  return town.y + (h - town.y) * k * k * (3 - 2 * k)
}
const inTown = (x, z, pad = 0) => Math.hypot(x - town.x, z - town.z) < town.r + pad
{
  const VR = rng(7)
  let best
  let hx = 0
  let hz = 0
  for (let a = 0; height(hx, hz) < 2; a += 0.5) (hx = Math.cos(a) * a * 0.3), (hz = Math.sin(a) * a * 0.3) // the start point
  for (let i = 0; i < 60; i++) {
    const a = VR() * 7
    const d = 27 + VR() * 10
    const x = hx + Math.cos(a) * d
    const z = hz + Math.sin(a) * d
    let lo = 1e9
    let hi = -1e9
    for (let j = 0; j < 8; j++) {
      const y = height(x + Math.cos(j) * 12, z + Math.sin(j) * 12)
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
    const score = hi - lo + (lo < WATER + 1 ? 99 : 0) // flattest dry ring wins
    if (!best || score < best[2]) best = [x, z, score]
  }
  town = { x: best[0], z: best[1], y: height(best[0], best[1]), r: 15, hx, hz }
}

// start on dry land near the origin
const home = new THREE.Vector3()
home.set(town.hx, 0, town.hz) // found before the village levelled its ground (see villages: site)

// Scenery: each kind compiled from the model JSON in four seeded variants. One InstancedMesh per variant is shared
// by every live chunk and refilled from their instance lists whenever a chunk comes or goes.
const KINDS = [
  ['pine', 0.5],
  ['oak', 0.6],
  ['rock', 0.8],
  ['bush', 0],
]
// what grows where, per region: [chance of pine, oak, rock, bush] per candidate spot (the rest stays bare)
const FLORA = [
  [0.02, 0.07, 0.03, 0.14], // meadow
  [0.4, 0.25, 0.03, 0.15], // forest
  [0.12, 0.02, 0.3, 0.06], // rocky hills
  [0.04, 0.08, 0.04, 0.2], // lakes
]
const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
const kit = KINDS.flatMap(([kind]) =>
  [1, 2, 3, 4].map((v) => {
    const m = make(lib, kind, v)
    const mesh = new THREE.InstancedMesh(bake(m), m.mat, 900)
    mesh.castShadow = mesh.receiveShadow = true
    mesh.frustumCulled = false // instances span many chunks
    mesh.count = 0
    scene.add(mesh)
    return mesh
  })
)
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600).rotateX(-90 * DEG),
  new THREE.MeshLambertMaterial({ color: '#3a7ab8', transparent: true, opacity: 0.75 })
)
water.position.y = WATER // one flat sheet that travels with the player: water is the same everywhere
scene.add(water)

const chunks = new Map() // live chunks only, "cx,cz" -> { mesh, inst, trees }
let dirty = false
function grow(cx, cz) {
  const R = rng((hash(cx, cz, SEED + 4) * 4294967296) | 0)
  const x0 = cx * CH
  const z0 = cz * CH
  const seg = 25
  const g = new THREE.PlaneGeometry(CH, CH, seg, seg).rotateX(-90 * DEG).translate(x0 + CH / 2, 0, z0 + CH / 2)
  const p = g.attributes.position
  const col = []
  const c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    const h = height(p.getX(i), p.getZ(i)) // edges sample the same points as the neighbour: seams match
    p.setY(i, h)
    ground(c, p.getX(i), p.getZ(i), h)
    col.push(c.r, c.g, c.b)
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const mesh = new THREE.Mesh(g, groundMat)
  mesh.receiveShadow = true
  scene.add(mesh)
  const inst = kit.map(() => [])
  const trees = [] // colliders: [x, z, radius]
  const o = new THREE.Object3D()
  for (let i = 0; i < 70; i++) {
    const x = x0 + R() * CH
    const z = z0 + R() * CH
    const pick = R()
    const v = (R() * 4) | 0
    const s = 0.8 + R() * 0.5
    const turn = R() * 7
    const h = height(x, z)
    if (h < WATER + 0.5 || Math.hypot(x - home.x, z - home.z) < 6 || inTown(x, z, 3)) continue
    let k = 0
    for (let sum = 0, f = FLORA[region(x, z)]; k < 4 && pick >= (sum += f[k]); k++);
    if (k > 3) continue
    o.position.set(x, h - 0.1, z)
    o.rotation.y = turn
    o.scale.setScalar(s)
    o.updateMatrix()
    inst[k * 4 + v].push(o.matrix.clone())
    if (KINDS[k][1]) trees.push([x, z, KINDS[k][1] * s])
  }
  chunks.set(cx + ',' + cz, { cx, cz, mesh, inst, trees })
  dirty = true
}
function drop(key) {
  const ch = chunks.get(key)
  scene.remove(ch.mesh)
  ch.mesh.geometry.dispose()
  chunks.delete(key)
  dirty = true
}
// Called every frame: drop far chunks, build at most `n` missing ones (nearest first), refill the instances.
function stream(x, z, n = 2) {
  const px = Math.floor(x / CH)
  const pz = Math.floor(z / CH)
  for (const [key, ch] of chunks) if (Math.max(Math.abs(ch.cx - px), Math.abs(ch.cz - pz)) > NEAR + 1) drop(key)
  const want = []
  for (let i = -NEAR; i <= NEAR; i++)
    for (let j = -NEAR; j <= NEAR; j++) if (!chunks.has(px + i + ',' + (pz + j))) want.push([i * i + j * j, px + i, pz + j])
  want.sort((a, b) => a[0] - b[0])
  for (const [, cx, cz] of want.slice(0, n)) grow(cx, cz)
  if (dirty) {
    dirty = false
    kit.forEach((mesh, v) => {
      let k = 0
      for (const ch of chunks.values()) for (const m of ch.inst[v]) if (k < 900) mesh.setMatrixAt(k++, m)
      mesh.count = k
      mesh.instanceMatrix.needsUpdate = true
    })
  }
  water.position.set(x, WATER, z)
}
const blockers = [] // extra colliders: (x, z, actor) => [x, z]
// colliders of the live chunks around a point
function around(x, z) {
  const out = []
  const cx = Math.floor(x / CH)
  const cz = Math.floor(z / CH)
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(chunks.get(cx + i + ',' + (cz + j))?.trees || [])
  return out
}
stream(home.x, home.z, 99)

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
    for (const trees of around(x, z))
      for (const [tx, tz, r] of trees) {
        const ex = x - tx
        const ez = z - tz
        const d = Math.hypot(ex, ez)
        if (d < r + 0.4 && d > 0) {
          x = tx + (ex / d) * (r + 0.4)
          z = tz + (ez / d) * (r + 0.4)
        }
      }
    for (const f of blockers) [x, z] = f(x, z, this)
    this.pos.x = x
    this.pos.z = z
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
    this.pos.y = this.floor ?? Math.max(WATER - 0.35, height(this.pos.x, this.pos.z))
    this.g.rotation.y = this.dir
    this.flash = Math.max(0, this.flash - dt * 4)
    this.m.mat.emissive.setRGB(this.flash * 0.7 + this.burn * 0.12, this.flash * 0.3 + this.burn * 0.04, this.flash * 0.3)
  }
}

// ---------- HUD ----------
const $ = (id) => document.getElementById(id)
function hud() {
  $('hp').style.width = (Math.max(0, player.hp) / player.maxHp) * 100 + '%'
  $('info').textContent = player.hp > 0 ? `${village?.in ? village.name + ' · weapon stowed' : item ? item.name : ''} · ${player.kills} kills` : `You fell after ${player.kills} kills…`
}

// ---------- minimap: turns with the camera, fog of war over ground you haven't been near ----------
// `seen` (revealed 8x8-unit cells) is the remembered state. Pictures of chunks are a small LRU cache rebuilt from
// `seen` plus height() and region(), so the map never reads back WebGL and its memory stays bounded.
const MAP = 160 // canvas pixels
const UPP = 2 // world units per map pixel
const CELL = 8 // reveal cell, in units
const SIGHT = 36 // reveal radius, in units
const seen = new Set()
const tiles = new Map()
const trail = []
const mapc = $('map').getContext('2d')
const FLAT = document.createElement('canvas') // world-aligned, big enough to cover the map at any turn
FLAT.width = FLAT.height = Math.ceil(MAP * 1.42)
const flat = FLAT.getContext('2d')
const tc = new THREE.Color()
function paint(t, i, j) {
  for (let a = 0; a < CELL; a += UPP)
    for (let b = 0; b < CELL; b += UPP) {
      const x = i * CELL + a + 1
      const z = j * CELL + b + 1
      const h = height(x, z)
      ground(tc, x, z, h)
      if (region(x, z) == 1) tc.multiplyScalar(0.65) // forest reads darker on the map
      t.ctx.fillStyle = h < WATER ? (h < WATER - 2 ? '#2a5c94' : '#3a7ab8') : '#' + tc.getHexString()
      t.ctx.fillRect((x - 1 - t.cx * CH) / UPP, (z - 1 - t.cz * CH) / UPP, 1, 1)
    }
}
function tile(cx, cz) {
  const key = cx + ',' + cz
  let t = tiles.get(key)
  if (t) {
    tiles.delete(key) // keep most recently used last
    tiles.set(key, t)
    return t
  }
  const n = CH / CELL
  const cells = []
  for (let i = cx * n; i < cx * n + n; i++) for (let j = cz * n; j < cz * n + n; j++) seen.has(i + ',' + j) && cells.push([i, j])
  if (!cells.length) return
  const cv = document.createElement('canvas')
  cv.width = cv.height = CH / UPP
  t = { cx, cz, cv, ctx: cv.getContext('2d') }
  for (const [i, j] of cells) paint(t, i, j)
  tiles.set(key, t)
  if (tiles.size > 150) tiles.delete(tiles.keys().next().value)
  return t
}
let lastCell
function minimap() {
  const { x, z } = player.pos
  const pi = Math.floor(x / CELL)
  const pj = Math.floor(z / CELL)
  if (lastCell != pi + ',' + pj) {
    lastCell = pi + ',' + pj
    const r = Math.ceil(SIGHT / CELL)
    for (let i = pi - r; i <= pi + r; i++)
      for (let j = pj - r; j <= pj + r; j++) {
        const key = i + ',' + j
        if (seen.has(key) || Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - z) > SIGHT) continue
        seen.add(key)
        const t = tiles.get(Math.floor((i * CELL) / CH) + ',' + Math.floor((j * CELL) / CH))
        if (t) paint(t, i, j)
      }
    const last = trail[trail.length - 1]
    if (!last || Math.hypot(last[0] - x, last[1] - z) > 6) trail.push([x, z]) > 300 && trail.shift()
  }
  // compose the explored ground world-aligned on a larger canvas, then draw it turned with the camera
  const W = FLAT.width
  const sx = (wx) => (wx - x) / UPP + W / 2 // world to flat-canvas pixels
  const sz = (wz) => (wz - z) / UPP + W / 2
  flat.fillStyle = '#0b0f18'
  flat.fillRect(0, 0, W, W)
  const span = Math.ceil((W * UPP) / CH / 2) + 1
  const cx = Math.floor(x / CH)
  const cz = Math.floor(z / CH)
  for (let i = cx - span; i <= cx + span; i++)
    for (let j = cz - span; j <= cz + span; j++) {
      const t = tile(i, j)
      if (t) flat.drawImage(t.cv, Math.round(sx(i * CH)), Math.round(sz(j * CH)))
    }
  flat.fillStyle = '#fff8'
  for (const [a, b] of trail) flat.fillRect(sx(a) - 1, sz(b) - 1, 2, 2)
  flat.fillStyle = '#fd4'
  flat.fillRect(sx(home.x) - 3, sz(home.z) - 3, 6, 6) // the start
  // up on the map is the way the camera looks (the way W walks)
  mapc.save()
  mapc.translate(MAP / 2, MAP / 2)
  mapc.rotate(camYaw)
  mapc.drawImage(FLAT, -W / 2, -W / 2)
  const fx = Math.sin(player.dir)
  const fz = Math.cos(player.dir)
  mapc.fillStyle = '#f33'
  mapc.beginPath()
  mapc.moveTo(fx * 8, fz * 8)
  mapc.lineTo(-fx * 4 + fz * 5, -fz * 4 - fx * 5)
  mapc.lineTo(-fx * 4 - fz * 5, -fz * 4 + fx * 5)
  mapc.fill()
  mapc.restore()
  mapc.fillStyle = '#fff'
  mapc.font = 'bold 11px system-ui'
  mapc.textAlign = 'center'
  mapc.fillText('N', MAP / 2 + Math.sin(camYaw) * 68, MAP / 2 - Math.cos(camYaw) * 68 + 4) // north, on the rim
  $('pos').textContent = `${REGIONS[region(x, z)]} · ${x | 0}, ${z | 0} · ${Math.hypot(x - home.x, z - home.z) | 0} m from start`
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
  if (village?.in) village.stow(1)
  hud()
}
const torchLight = new THREE.PointLight('#ff9a40', 0, 12, 1.5)
scene.add(torchLight)
equip(0)

// ---------- monsters ----------
const foes = []
let seedNext = 100
// More monsters roam at night: 12 by day, up to 22 in the dark, scaled by the region the player is in.
const crowd = () => Math.round((12 + (1 - day) * 10) * CROWD[region(player.pos.x, player.pos.z)])
function spawn(f) {
  if (f) {
    scene.remove(f.g)
    f.m.root.traverse((o) => o.geometry?.dispose()) // each monster's mesh is its own; the bar's is shared
    f.m.mat.dispose()
    foes.splice(foes.indexOf(f), 1)
    if (foes.length >= crowd()) return
  }
  let x, z
  do {
    const a = R() * 7
    const d = 18 + R() * 30
    x = player.pos.x + Math.cos(a) * d
    z = player.pos.z + Math.sin(a) * d
  } while ((height(x, z) < WATER + 0.3 && R() < 0.95) || inTown(x, z, 4))
  const mix = FOES[region(x, z)]
  const kind = mix[(R() * mix.length) | 0]
  const e = new Actor(kind, seedNext++)
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

// ---------- villages: houses round a square, townsfolk, doors into rooms ----------
// Rooms sit deep under the village (the ground hides them). A door fades to black and moves you down into the
// room, where a fixed camera looks in over a low front wall (a cutaway). Walking back out of the door reverses it.
var village
{
  const T = town
  const VR = rng(42)
  const TAU = Math.PI * 2
  const add = (name, seed, x, y, z, ry = 0) => {
    const m = make(lib, name, seed)
    m.root.position.set(x, y, z)
    m.root.rotation.y = ry
    scene.add(m.root)
    return m
  }
  // push (x, z) out of a box of half-size hw x hd centred on (cx, cz), turned by ry
  const box = (x, z, cx, cz, hw, hd, ry = 0) => {
    const c = Math.cos(ry)
    const s = Math.sin(ry)
    let lx = (x - cx) * c - (z - cz) * s
    let lz = (x - cx) * s + (z - cz) * c
    if (Math.abs(lx) >= hw || Math.abs(lz) >= hd) return [x, z]
    if (hw - Math.abs(lx) < hd - Math.abs(lz)) lx = Math.sign(lx) * hw
    else lz = Math.sign(lz) * hd
    return [cx + lx * c + lz * s, cz - lx * s + lz * c]
  }
  const syl = ['Oak', 'Ash', 'Mill', 'Brook', 'Thorn', 'Elm', 'wick', 'by', 'ford', 'ham', 'stead', 'well']
  const name = syl[(VR() * 6) | 0] + syl[6 + ((VR() * 6) | 0)]

  add('plaza', 1, T.x, T.y, T.z).root.scale.set(5.5, 1, 5.5)
  add('well', 1, T.x, T.y, T.z)
  const gate = Math.atan2(home.z - T.z, home.x - T.x) // the main gate faces the start point
  const path = (a, len) => {
    const m = add('path', 1, T.x, T.y - 0.01, T.z, Math.PI / 2 - a)
    m.root.scale.z = len
  }
  path(gate, T.r + 4)
  path(gate + Math.PI, T.r + 4)

  // houses, evenly round the square with the gate between two of them, doors facing the well
  const houses = []
  const n = 5 + ((VR() * 2) | 0)
  for (let i = 0; i < n; i++) {
    const a = gate + ((i + 0.5 + (VR() - 0.5) * 0.3) * TAU) / n
    const r = 9 + VR() * 1.5
    const x = T.x + Math.cos(a) * r
    const z = T.z + Math.sin(a) * r
    const ry = Math.atan2(T.x - x, T.z - z)
    const m = add('house', i + 1, x, T.y, z, ry)
    const { w, d } = m.vars
    const sx = Math.sin(ry)
    const sz = Math.cos(ry)
    path(a + Math.PI, r - d / 2)
    const room = add('room', i + 1, x, T.y - 40 - i * 15, z)
    m.mat.transparent = true
    houses.push({ m, x, z, ry, w, d, out: [x + sx * (d / 2 + 1.4), z + sz * (d / 2 + 1.4)], y: room.root.position.y, rw: room.vars.w, rd: room.vars.d })
  }

  // fence ring with two gates
  {
    const m = make(lib, 'fence', 1)
    const count = Math.floor((TAU * T.r) / 2.1)
    const mesh = new THREE.InstancedMesh(bake(m), m.mat, count)
    mesh.castShadow = true
    const o = new THREE.Object3D()
    let k = 0
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU
      if (Math.abs(Math.sin((a - gate) / 2)) < 0.07 || Math.abs(Math.cos((a - gate) / 2)) < 0.07) continue
      o.position.set(T.x + Math.cos(a) * T.r, T.y, T.z + Math.sin(a) * T.r)
      o.rotation.y = -a - Math.PI / 2
      o.updateMatrix()
      mesh.setMatrixAt(k++, o.matrix)
    }
    mesh.count = k
    scene.add(mesh)
  }

  // townsfolk: the warrior's skeleton in seeded clothes, strolling between doors and the well
  const spots = [...houses.map((h) => [h.out[0] + Math.cos(h.ry) * 1.6, h.out[1] - Math.sin(h.ry) * 1.6]), ...[0, 1, 2, 3].map((i) => [T.x + Math.cos(i * 1.6) * 2.2, T.z + Math.sin(i * 1.6) * 2.2])]
  const folk = []
  for (let i = 0; i < 7; i++) {
    const f = new Actor('villager', 200 + i)
    const [x, z] = spots[i % spots.length]
    f.pos.set(x, 0, z)
    f.goal = spots[(VR() * spots.length) | 0]
    f.wait = VR() * 3
    folk.push(f)
  }

  // colliders: houses (outside), the well, the fence, room walls and furniture (inside), townsfolk, and monsters kept out
  blockers.push((x, z, who) => {
    if (foes.includes(who)) {
      const dx = x - T.x
      const dz = z - T.z
      const d = Math.hypot(dx, dz) || 1
      return d < T.r + 1 ? [T.x + (dx / d) * (T.r + 1), T.z + (dz / d) * (T.r + 1)] : [x, z]
    }
    const h = who.room
    if (h) {
      const gap = Math.abs(x - h.x) < 0.8
      x = Math.max(h.x - h.rw / 2 + 0.35, Math.min(h.x + h.rw / 2 - 0.35, x))
      z = Math.max(h.z - h.rd / 2 + 0.7, Math.min(h.z + h.rd / 2 - (gap ? 0.1 : 0.45), z))
      ;[x, z] = box(x, z, h.x - h.rw / 2 + 0.8, h.z - h.rd / 2 + 1.3, 0.95, 1.4) // bed
      ;[x, z] = box(x, z, h.x + h.rw / 2 - 1.6, h.z + 0.2, 1.1, 1.3) // table and stools
      return box(x, z, h.x + h.rw / 2 - 0.35, h.z - h.rd / 2 + 0.8, 0.6, 0.9) // shelf
    }
    for (const o of houses) [x, z] = box(x, z, o.x, o.z, o.w / 2 + 0.4, o.d / 2 + 0.4, o.ry)
    if (who == player) for (const f of folk) [x, z] = box(x, z, f.pos.x, f.pos.z, 0.45, 0.45)
    const dx = x - T.x
    const dz = z - T.z
    const d = Math.hypot(dx, dz) || 1
    const a = Math.atan2(dz, dx)
    const gap = Math.abs(Math.sin((a - gate) / 2)) < 0.07 || Math.abs(Math.cos((a - gate) / 2)) < 0.07
    let r = Math.max(d, 1.5) // the well
    if (who != player) r = Math.min(r, T.r - 1) // townsfolk stay in
    else if (!gap && Math.abs(d - T.r) < 0.45) r = d < T.r ? T.r - 0.45 : T.r + 0.45 // the fence
    return r == d ? [x, z] : [T.x + (dx / d) * r, T.z + (dz / d) * r]
  })

  // the weapon hangs on the warrior's back inside the village, its longest end down (a torch's flame up)
  const back = new THREE.Object3D()
  const turn = new THREE.Object3D() // aims whichever prop is stowed
  back.position.set(-0.05, 0.62, -0.27)
  back.rotation.set(110 * DEG, 0, 35 * DEG, 'ZYX') // +z points down and back, leaning across the back
  back.add(turn)
  player.m.bones.chest.add(back)
  player.m.bones.back = turn
  const v = new THREE.Vector3()
  function stow(on) {
    const p = hold(lib, player.m, 'back', on ? ITEMS[player.item] : null)
    if (p) {
      // find the prop's far end in its own space, then turn that end to +z
      turn.quaternion.identity()
      p.root.updateMatrixWorld(true)
      const inv = p.root.matrixWorld.clone().invert()
      const far = new THREE.Vector3()
      p.root.traverse((o) => {
        if (!o.isMesh) return
        const a = o.geometry.attributes.position
        const M = inv.clone().multiply(o.matrixWorld)
        for (let i = 0; i < a.count; i++) if (v.fromBufferAttribute(a, i).applyMatrix4(M).length() > far.length()) far.copy(v)
      })
      turn.quaternion.setFromUnitVectors(far.normalize(), v.set(0, 0, p.vars.burn ? -1 : 1))
    }
    if (on) hold(lib, player.m, 'handR', null)
    else equip(player.item)
    torchLight.intensity = 0
  }

  // fade to black, do the move, fade back in
  const veil = document.createElement('div')
  veil.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .25s'
  document.body.appendChild(veil)
  let fading = 0
  const fade = (fn) => {
    if (fading) return
    fading = 1
    veil.style.opacity = 1
    setTimeout(() => {
      fn()
      veil.style.opacity = 0
      setTimeout(() => (fading = 0), 300)
    }, 260)
  }
  const glow = new THREE.PointLight('#ffb070', 0, 16, 1.2)
  scene.add(glow)
  const BLACK = new THREE.Color(0)
  let yaw = 0 // the outdoor camera angle, kept while indoors

  village = {
    name,
    houses,
    folk,
    stow,
    in: false,
    enter(h) {
      fade(() => {
        player.room = h
        player.floor = h.y
        yaw = camYaw
        player.pos.set(h.x, h.y, h.z + h.rd / 2 - 0.9)
        player.vel.set(0, 0)
        player.dir = Math.PI
        glow.position.set(h.x, h.y + 1.2, h.z - h.rd / 2 + 1.2)
      })
    },
    leave() {
      const h = player.room
      fade(() => {
        player.room = player.floor = null
        camYaw = yaw
        player.pos.set(h.out[0], T.y, h.out[1])
        player.vel.set(0, 0)
        player.dir = h.ry
        camera.position.set(h.out[0] + Math.sin(camYaw) * 7, T.y + 7.5, h.out[1] + Math.cos(camYaw) * 7)
      })
    },
    update(dt) {
      const p = player.pos
      const was = this.in
      this.in = player.hp > 0 && inTown(p.x, p.z)
      if (this.in != was) {
        stow(this.in)
        hud()
      }
      const h = player.room
      if (h) {
        if (p.z > h.z + h.rd / 2 - 0.3) this.leave()
        camYaw = 0 // move relative to the room camera
        // a fixed room camera, warm firelight, no sky
        camera.position.set(h.x + (p.x - h.x) * 0.3, h.y + 5.5, h.z + h.rd / 2 + 3.2)
        camera.lookAt(h.x + (p.x - h.x) * 0.3, h.y + 0.6, h.z - 0.4)
        glow.intensity = 30 * (1 + Math.sin(clock.elapsedTime * 13) * 0.08)
        sun.intensity = 0
        hemi.intensity = 0.7
        scene.background = BLACK
      } else {
        glow.intensity = 0
        scene.background = sky
        for (const o of houses) {
          // pressed against the front wall, within the door's width
          const c = Math.cos(o.ry)
          const s = Math.sin(o.ry)
          const lx = (p.x - o.x) * c - (p.z - o.z) * s
          const lz = (p.x - o.x) * s + (p.z - o.z) * c
          if (Math.abs(lx) < 0.6 && lz > 0 && lz < o.d / 2 + 0.5) this.enter(o)
        }
        // a house between the camera and the player fades to see-through
        const ax = camera.position.x
        const az = camera.position.z
        const bx = p.x - ax
        const bz = p.z - az
        for (const o of houses) {
          const t = Math.min(1, Math.max(0, ((o.x - ax) * bx + (o.z - az) * bz) / (bx * bx + bz * bz)))
          const hide = t < 0.98 && Math.hypot(ax + bx * t - o.x, az + bz * t - o.z) < Math.max(o.w, o.d) / 2 + 0.6
          o.m.mat.opacity += ((hide ? 0.25 : 1) - o.m.mat.opacity) * Math.min(1, dt * 8)
        }
      }
      for (const f of folk) {
        const dx = f.goal[0] - f.pos.x
        const dz = f.goal[1] - f.pos.z
        const d = Math.hypot(dx, dz)
        f.speed = 0
        if ((f.wait -= dt) > 0) f.move(0, 0, dt)
        else if (d < 0.6) {
          f.wait = 2 + VR() * 5
          f.goal = spots[(VR() * spots.length) | 0]
        } else {
          f.speed = 1.6
          f.dir = Math.atan2(dx, dz)
          f.move((dx / d) * 1.6 * dt, (dz / d) * 1.6 * dt, dt)
        }
        f.update(dt, 1.6)
      }
    },
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

// ---------- sound: music compiled from the score text, plus a few synthesized blips ----------
const audio = jukebox(score($('score').textContent))
function muteButton() {
  $('mute').className = audio.muted ? 'off' : ''
}
muteButton()
// browsers only allow sound after a user gesture
for (const ev of ['keydown', 'pointerdown', 'touchstart']) addEventListener(ev, audio.start)
$('mute').onclick = () => {
  audio.mute()
  muteButton()
}
function beep(f, d = 0.1, type = 'square', vol = 0.06, slide = 0.5) {
  const ac = audio.ac
  if (!ac || audio.muted) return
  try {
    const o = ac.createOscillator()
    const g = ac.createGain()
    o.type = type
    o.frequency.setValueAtTime(f, ac.currentTime)
    o.frequency.exponentialRampToValueAtTime(f * slide, ac.currentTime + d)
    g.gain.setValueAtTime(vol, ac.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + d)
    o.connect(g).connect(audio.out)
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
  if (e.code == 'KeyM') $('mute').onclick()
})
addEventListener('keyup', (e) => (keys[e.code] = 0))
const stick = { id: null, x: 0, y: 0, ox: 0, oy: 0 }
addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (t.target.id == 'swap') equip(player.item + 1)
    else if (t.target.id == 'hit') attack()
    else if (t.target.id == 'mute') continue
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
  if (player.busy || player.hp <= 0 || village?.in) return
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
const near = { slime: 0, goblin: 0, spider: 0, bat: 0 } // how present each monster kind is, for the music
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
    if (alive && d < 12 && !village.in && !(e.burn > 0 && e.kind != 'slime')) {
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

  // music: each monster kind within 14 units brings in its own part (fast in, slow out); night darkens the rest
  const close = {}
  for (const e of foes) if (e.hp > 0 && alive && Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z) < 14) close[e.kind] = 1
  for (const k in near) near[k] += ((close[k] || 0) - near[k]) * Math.min(1, dt * (close[k] ? 2 : 0.5))
  audio.mood(day, near)

  // camera: a high three-quarter view that trails the player
  const target = player.pos
  fwd.set(Math.sin(camYaw) * 7, 7.5, Math.cos(camYaw) * 7)
  camera.position.lerp(fwd.add(target), clock.elapsedTime < 0.2 ? 1 : Math.min(1, dt * 5))
  camera.lookAt(target.x, target.y + 1, target.z)
  sun.position.set(target.x + 20, target.y + 40, target.z + 10)
  sun.target.position.copy(target)

  stream(target.x, target.z)
  minimap()
  village.update(dt)
  bars(dt)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
hud()
frame()

window.game = { player, foes, equip, attack, clock, audio, village, scene, renderer, world: { SEED, chunks, seen, tiles, height, region, grow, drop } } // for play-testing from the console

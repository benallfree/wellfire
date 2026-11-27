import * as THREE from 'three'
import { DEG, rng, library, make, hold, pose, bake, glow } from './compiler.js'
import { score, jukebox } from './music.js'

// The model library is JSON shipped in the page (see models.json).
const lib = library(document.getElementById('models').textContent)

const WATER = 0.2
const ITEMS = ['sword', 'axe', 'torch', 'wood', 'flint', 'haste', 'potion', 'whistle']
// monster mix and how crowded it gets, per region (meadow, forest, rocky hills, lakes)
const FOES = [
  ['slime', 'slime', 'bat', 'goblin'],
  ['spider', 'spider', 'goblin', 'slime'],
  ['goblin', 'goblin', 'bat', 'spider'],
  ['slime', 'slime', 'slime', 'bat'],
]
const CROWD = [1, 1.3, 1.1, 0.7]
const R = rng(1337)
// habitats: the ground height a creature may stand over. Land kinds stop at the shoreline (ankle-deep at most),
// water kinds keep to water deeper than a swimmer, bats fly anywhere but tire over water (see the monster loop).
const SWIM = WATER - 1 // ground lower than this and the warrior swims
const HABITAT = { eel: (h) => h < SWIM - 0.1, bat: () => 1 }
const onLand = (h) => h > WATER - 0.25

// ---------- renderer, scene, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
const DAY = new THREE.Color('#9cc8e8')
const NIGHT = new THREE.Color('#03050c')
const SUN = new THREE.Color('#fff4dd')
const MOON = new THREE.Color('#5a78c8')
const LITE = new THREE.Color()
const hue = new THREE.Color()
const sky = DAY.clone()
let day = 1
scene.background = sky
scene.fog = new THREE.Fog(sky, 40, 110)
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 200)
const hemi = new THREE.HemisphereLight('#dfefff', '#4a5a30', 1.3)
scene.add(hemi)
const sun = new THREE.DirectionalLight(SUN, 2.2)
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
const smooth = (a, b, v) => ((v = Math.min(1, Math.max(0, (v - a) / (b - a)))), v * v * (3 - 2 * v))
// fBm: `o` octaves of noise, each twice as fine, half as strong and turned (hides the grid), scaled to about 0..1
const fbm = (x, z, s, o = 4) => {
  let t = 0
  let a = 0.5
  for (let i = 0; i < o; i++, [x, z] = [x * 1.6 - z * 1.2, x * 1.2 + z * 1.6], a /= 2) t += noise(x, z, s + i) * a // x2, turned 37deg
  return t / (1 - 2 * a)
}
// Base terrain, before villages or roads level anything (they layer on top in height()). Layers, all from SEED:
// a domain warp so nothing lines up with the noise grid; rolling fBm hills, gentle in meadows and bigger in forests;
// ridged mountain ranges where `rough` is high; lake basins where `wet` is high; and rare winding river valleys.
function terrain(x, z) {
  const u = x + (noise(x * 0.01, z * 0.01, SEED + 20) - 0.5) * 70
  const v = z + (noise(x * 0.01, z * 0.01, SEED + 21) - 0.5) * 70
  const r = rough(x, z)
  const w = wet(x, z)
  const d = Math.hypot(x, z)
  const near = smooth(160, 90, d) // the start: no lakes or rivers, so spawn is on dry land
  const pad = smooth(10, 35, d) // and a flat pad right where you appear
  const hi = smooth(0.5, 0.75, r) * smooth(35, 90, d) // 0 lowland, 1 highland
  let h = 2 + (fbm(u * 0.012, v * 0.012, SEED + 10) - 0.5) * (10 + smooth(0.35, 0.6, w) * 4 + hi * 8) * pad + 2 * near
  h += (fbm(u * 0.035, v * 0.035, SEED + 50, 2) - 0.5) * 10 * pad // knolls small enough to see from the camera
  for (let o = 0, p = u * 0.007, q = v * 0.007, a = 22; o < 3; o++, [p, q] = [p * 1.7 - q * 1.1, p * 1.1 + q * 1.7], a *= 0.4) {
    const n = 1 - Math.abs(noise(p, q, SEED + 30 + o) * 2 - 1) // ridged: sharp crests where noise crosses 0.5
    h += hi * n * n * a
  }
  h -= smooth(0.6, 0.7, w) * 9 * (1 - near) // lake basins
  const m = noise(x * 0.004, z * 0.004, SEED + 22) * 150 // rivers get their own, wider warp so they meander
  const river = Math.max(hi, near, smooth(0.01, 0.07, Math.abs(noise((u + m) * 0.0025, (v - m) * 0.0025, SEED + 40) - 0.5)))
  const bed = WATER - 1.5 + smooth(0.6, 0.7, noise(x * 0.02, z * 0.02, SEED + 23)) * 1.4 // fords: shallow enough to ride
  return bed + (h - bed) * river
}
// Shoreline and lake-bed shaping, after the base terrain: a pure remap of how far ground sits below WATER, so it is
// seam-safe and costs nothing. The first ~0.8 units of depth become a gentle wading shelf, then the bed drops off to
// about 2.5x its base depth, so walking out from any shore goes ankle, knee, waist, then over your head.
const shore = (h, d = WATER - h) => (d > 0 ? WATER - d * (0.7 + smooth(0.8, 2.5, d) * 1.5) : h)
// how deep the water is at a point (0 on dry land); swimming starts past 1 (SWIM), eels live past 1.1
const depth = (x, z) => Math.max(0, WATER - height(x, z))
const wade = (a) => (a.swim || a.cave ? 1 : 1 - Math.min(0.45, depth(a.pos.x, a.pos.z) * 0.4)) // wading slows you, up to about half speed
// water colour by depth: light over the shallows, dark over the deep (bed tint under the water, minimap)
const sea = (c, d) => c.setRGB(0.5, 0.75, 0.7).lerp(mix.setRGB(0.03, 0.12, 0.28), smooth(0, 4, d))
// height difference across 2 units in x and in z: the slope (and, for the minimap, which way the ground faces)
const slope = (x, z) => [height(x + 1, z) - height(x - 1, z), height(x, z + 1) - height(x, z - 1)]
const mix = new THREE.Color()

// start on dry land near the origin
const home = new THREE.Vector3()
for (let a = 0; terrain(home.x, home.z) < 2; a += 0.5) home.set(Math.cos(a) * a * 0.3, 0, Math.sin(a) * a * 0.3)

// ---------- settlements and roads: two more pure layers over the terrain (see docs/world-layers.md) ----------
// Villages sit on a coarse grid of G-unit cells, at most one per cell; roads join villages in neighbouring cells.
// Every answer is a pure function of the cell, cached in maps that are simply cleared when they grow large.
const G = 280
const RW = 2 // road half-width
const SYL = ['Oak', 'Ash', 'Mill', 'Brook', 'Thorn', 'Elm', 'Stone', 'Fox', 'Wil', 'Red', 'wick', 'by', 'ford', 'ham', 'stead', 'well', 'ton', 'dale', 'mere', 'field']
const memo = (f, max = 3000, m = new Map()) => (...a) => {
  const k = a.join()
  if (!m.has(k)) {
    if (m.size > max) m.clear()
    m.set(k, f(...a))
  }
  return m.get(k)
}
// cell (0, 0) is centred on the start; cells are keyed through h2() because hash(x, z) == hash(-x, -z) for odd x, z
const gx = (x) => Math.round((x - home.x) / G)
const gz = (z) => Math.round((z - home.z) / G)
const h2 = (i, j, s) => hash(i * 2, j * 2 + 1, s)
// The village in cell (gi, gj), or null. Cell (0, 0) always has one, 27-37 units from the start.
const site = memo((gi, gj) => {
  const R = rng((h2(gi, gj, SEED + 5) * 4294967296) | 0)
  const first = !gi && !gj
  const r = 12 + R() * 6
  const name = SYL[(R() * 10) | 0] + SYL[10 + ((R() * 10) | 0)]
  const seed = (R() * 1e6) | 0
  if (!first && R() > 0.6) return null
  let best
  for (let i = 0; i < (first ? 60 : 4); i++) {
    const a = R() * 7
    const d = 27 + R() * 10
    const x = home.x + (first ? Math.cos(a) * d : (gi + (R() - 0.5) * 0.6) * G)
    const z = home.z + (first ? Math.sin(a) * d : (gj + (R() - 0.5) * 0.6) * G)
    let lo = 1e9
    let hi = -1e9
    for (let j = 0; j < 8; j++) {
      const y = terrain(x + Math.cos(j) * r, z + Math.sin(j) * r)
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
    const score = hi - lo + (lo < WATER + 1 ? 99 : 0) // flattest dry ring wins
    if (!best || score < best[2]) best = [x, z, score]
    if (!first && score < 6) break
  }
  if (best[2] >= 6 && !first) return null
  const [x, z] = best
  return { k: gi + ',' + gj, gi, gj, x, z, y: terrain(x, z), r, name, seed }
})
function sites(x, z, n = 1) {
  const out = []
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) out.push(site(gx(x) + i, gz(z) + j))
  return out.filter(Boolean)
}
const inTown = (x, z, pad = 0) => sites(x, z).find((t) => Math.hypot(x - t.x, z - t.z) < t.r + pad)
// A road from A's fence to B's: a vertex every ~16 units, bent sideways by seeded noise (straight at both gates).
// Each vertex is [x, z, grade]: the village floor at the ends, dry ground or a causeway between.
function path(A, B, ra, rb, s) {
  const dx = B.x - A.x
  const dz = B.z - A.z
  const L = Math.hypot(dx, dz)
  const len = L - ra - rb
  const n = Math.ceil(len / 16)
  const p = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const o = (noise(t * 2.5, 0, s) - 0.5) * Math.min(60, len * 0.3) * Math.sin(Math.PI * t)
    const x = A.x + (dx * (ra + len * t) - dz * o) / L
    const z = A.z + (dz * (ra + len * t) + dx * o) / L
    p.push([x, z, i == 0 ? A.y : i == n ? B.y : Math.max(WATER + 0.6, terrain(x, z))])
  }
  return p
}
// The roads cell (gi, gj) owns: to villages east, south-west, south and south-east of it, kept when no third
// village is nearer to both ends (a relative-neighbourhood graph: short links, no crossings) and the way is mostly dry.
const links = memo((gi, gj) => {
  const A = site(gi, gj)
  const out = []
  if (!A) return out
  if (!gi && !gj) {
    const H = { x: home.x, z: home.z, y: terrain(home.x, home.z) }
    out.push({ a: 'home', b: A.k, p: path(H, A, 0, A.r - 2, SEED) }) // a spur from the start to the first village
  }
  for (const [di, dj] of [[1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const B = site(gi + di, gj + dj)
    if (!B) continue
    const L = Math.hypot(B.x - A.x, B.z - A.z)
    const far = (C) => Math.hypot(C.x - A.x, C.z - A.z) < L && Math.hypot(C.x - B.x, C.z - B.z) < L
    if (sites((A.x + B.x) / 2, (A.z + B.z) / 2, 2).some((C) => C.k != A.k && C.k != B.k && far(C))) continue
    const p = path(A, B, A.r - 2, B.r - 2, (h2(gi, gj, SEED + 6 + di * 3 + dj) * 1e9) | 0)
    if (p.filter(([x, z]) => terrain(x, z) < WATER + 0.3).length * 4 < p.length) out.push({ a: A.k, b: B.k, p })
  }
  return out
})
// What can shape the ground in chunk (cx, cz): villages within reach and road segments within a road's blend.
const shape = memo((cx, cz) => {
  const x0 = cx * CH
  const z0 = cz * CH
  const m = RW + 5
  const hit = (lx, hx, lz, hz) => lx < x0 + CH + m && hx > x0 - m && lz < z0 + CH + m && hz > z0 - m
  const towns = sites(x0, z0).filter((t) => hit(t.x - t.r - 4, t.x + t.r + 4, t.z - t.r - 4, t.z + t.r + 4))
  const segs = []
  for (let i = -2; i <= 2; i++)
    for (let j = -2; j <= 2; j++)
      for (const { p } of links(gx(x0) + i, gz(z0) + j))
        for (let k = 1; k < p.length; k++) {
          const [ax, az, ay] = p[k - 1]
          const [bx, bz, by] = p[k]
          if (hit(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz))) segs.push([ax, az, ay, bx, bz, by])
        }
  return { towns, segs }
}, 600)
let lx, lz, lv // the last chunk asked about: neighbouring points mostly share it
const at = (x, z) => ((x = Math.floor(x / CH)), (z = Math.floor(z / CH)), x === lx && z === lz ? lv : ((lx = x), (lz = z), (lv = shape(x, z))))
// [distance to the nearest road's centre line, the road's grade there]
function road(x, z) {
  let d = 1e9
  let y = 0
  for (const [ax, az, ay, bx, bz, by] of at(x, z).segs) {
    const ex = bx - ax
    const ez = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)))
    const e = Math.hypot(x - ax - ex * t, z - az - ez * t)
    if (e < d) (d = e), (y = ay + (by - ay) * t)
  }
  return [d, y]
}
// the ground: bare terrain, graded level across nearby roads, then levelled under nearby villages
function height(x, z) {
  const [d, y] = road(x, z)
  let h = y + (shore(terrain(x, z)) - y) * smooth(RW, RW + 4, d)
  for (const t of at(x, z).towns) h = t.y + (h - t.y) * smooth(t.r, t.r + 8, Math.hypot(x - t.x, z - t.z))
  return h
}
// Ground colour at a point, shared by the terrain mesh and the minimap: road dirt, sand by water, then grass, dirt on
// slopes, rock on steep or high ground, snow on peaks. Noise wobbles each boundary so none is a straight contour line.
function ground(c, x, z, h = height(x, z), [gx, gz] = slope(x, z)) {
  const n = noise(x * 0.3, z * 0.3, SEED + 3) * 0.08
  const s = Math.hypot(gx, gz) / 2 + n // rise per unit
  if (road(x, z)[0] < RW) return c.setRGB(0.52 + n, 0.4 + n, 0.25) // road strips: dirt
  if (h < WATER - 0.12) return sea(c, WATER - h).lerp(mix.set('#d8c890'), 0.6 * smooth(1.5, 0, WATER - h)) // sand fading into the deep
  if (h < WATER + 0.06) return c.setRGB(0.95, 0.97, 0.95) // foam where the water meets the shore
  if (h < WATER + 0.4 + n * 4) return c.set('#d8c890')
  c.setRGB(0.32 + n, 0.57 + n, 0.23) // meadow grass, shading into dark forest grass and dry highland grass
  c.lerp(mix.setRGB(0.22 + n, 0.45 + n, 0.18), smooth(0.43, 0.5, wet(x, z)))
  c.lerp(mix.setRGB(0.42 + n, 0.52 + n, 0.25), smooth(0.5, 0.6, rough(x, z)))
  c.lerp(mix.setRGB(0.42 + n, 0.32 + n, 0.21), smooth(0.4, 0.7, s)) // dirt
  c.lerp(mix.setRGB(0.27 + n, 0.26 + n, 0.25 + n), Math.max(smooth(0.65, 0.9, s), smooth(18, 23, h + n * 40))) // rock
  return c.lerp(mix.setRGB(0.8, 0.83, 0.88), smooth(29, 31, h + n * 50) * (1 - smooth(0.9, 1.3, s))) // snow
}

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
  new THREE.MeshLambertMaterial({ color: '#3a7ab8', transparent: true, opacity: 0.6 })
)
water.position.y = WATER // one flat sheet that travels with the player: water is the same everywhere
scene.add(water)

const chunks = new Map() // live chunks only, "cx,cz" -> { mesh, inst, trees }
let dirty = false
// berries (models.json "berrybush", the cluster is the "berries" model): a seeded share of bushes carries a cluster, one more shared InstancedMesh drawn on
// the bush's own matrix. Walk into one while hurt to eat it (heal of your health); it grows back after regrow seconds.
const BERRY = lib.berrybush
const berryKit = (() => {
  const m = make(lib, 'berries', 1)
  const k = new THREE.InstancedMesh(bake(m), m.mat, 900)
  k.frustumCulled = false
  k.count = 0
  scene.add(k)
  return k
})()
// localStorage, wrapped: private windows and blocked storage just start fresh, and a refused save (storage full or
// blocked) says so once instead of losing progress silently
const kept = (k, d) => {
  try {
    return JSON.parse(localStorage[k]) || d
  } catch {
    return d
  }
}
let refused
const keep = (k, v) => {
  const j = JSON.stringify(v)
  try {
    localStorage[k] = j
    if (localStorage[k] != j) throw 0 // read back: some browsers drop a write without an error
  } catch {
    refused ||= setTimeout(() => (($('say').hidden = false), ($('say').innerHTML = "<h2>Can't save</h2><p>The browser's storage is full or blocked, so progress since then is lost on reload</p><small>Space or tap</small>")))
  }
}
// felled trees: chunk key -> { candidate index: when it fell }. A tree regrows after REGROW; old entries are pruned
// on load, so the record stays small however far you roam.
const REGROW = 30 * 60e3
const felled = kept('warriorFelled', {})
for (const k in felled) {
  for (const i in felled[k]) if (Date.now() - felled[k][i] > REGROW) delete felled[k][i]
  if (!Object.keys(felled[k]).length) delete felled[k]
}
// item models, each baked once and shared: tray icons, drops, rocks and caves
const geos = {}
const geo = (k) => (geos[k] ||= bake(make(lib, k, 1)))
const itemMat = glow(new THREE.MeshLambertMaterial({ vertexColors: true }))
// rocks (models.json "rocks"): about perChunk a chunk, weighted by region. A seeded roll gives each a coin or two
// (stage pay) or, rarely, a flint. Struck with the axe a rock breaks up and is gone: its id goes in `felled` with the
// time, like a felled tree, and it grows back after REGROW. Every village has a cave CAVE.near-CAVE.far units out (den()), sealed by a boulder.
const ROCK = lib.rocks
const CAVE = lib.caves
const den = memo((gi, gj) => {
  const T = site(gi, gj)
  const R = rng((h2(gi, gj, SEED + 12) * 4294967296) | 0)
  for (let i = 0; T && i < 20; i++) {
    const a = R() * 7
    const d = CAVE.near + R() * (CAVE.far - CAVE.near)
    const x = T.x + Math.cos(a) * d
    const z = T.z + Math.sin(a) * d
    if (height(x, z) > WATER + 0.5 && !inTown(x, z, 3) && road(x, z)[0] > RW + 1.5) return [x, z]
  }
})
function grow(cx, cz) {
  const R = rng((hash(cx, cz, SEED + 4) * 4294967296) | 0)
  const key = cx + ',' + cz
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
    const [gx, gz] = slope(p.getX(i), p.getZ(i))
    ground(c, p.getX(i), p.getZ(i), h, [gx, gz]).multiplyScalar(Math.min(1.3, Math.max(0.6, 1 - gx * 0.7 - gz * 0.35))) // baked hillshade, lit from the sun's side, so gentle hills read from the camera
    col.push(c.r, c.g, c.b)
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const mesh = new THREE.Mesh(g, groundMat)
  mesh.receiveShadow = true
  scene.add(mesh)
  const inst = kit.map(() => [])
  const trees = [] // colliders: [x, z, radius]
  const berries = [] // { m: the bush's matrix, x, z, i, eaten: when (0: ripe) }
  const o = new THREE.Object3D()
  for (let i = 0; i < 70; i++) {
    const x = x0 + R() * CH
    const z = z0 + R() * CH
    const pick = R()
    const v = (R() * 4) | 0
    const s = 0.8 + R() * 0.5
    const turn = R() * 7
    const h = height(x, z)
    if (h < WATER + 0.5 || Math.hypot(x - home.x, z - home.z) < 6 || inTown(x, z, 3) || road(x, z)[0] < RW + 1.5 || Date.now() - (felled[key]?.[i] || 0) < REGROW) continue
    let k = 0
    for (let sum = 0, f = FLORA[region(x, z)]; k < 4 && pick >= (sum += f[k]); k++);
    if (k > 3 || (h > 17 && k != 2)) continue // above the tree line only boulders
    o.position.set(x, h - 0.1, z)
    o.rotation.y = turn
    o.scale.setScalar(s)
    o.updateMatrix()
    const m = o.matrix.clone()
    inst[k * 4 + v].push(m)
    if (KINDS[k][1]) trees.push(k < 2 ? [x, z, KINDS[k][1] * s, i, k * 4 + v, m, key] : [x, z, KINDS[k][1] * s]) // pines and oaks can be felled (see wood)
    if (k == 3 && hash(cx * 71 + i, cz, SEED + 21) < BERRY.chance) {
      const t = felled[key]?.['b' + i] || 0
      berries.push({ m, x, z, i, eaten: Date.now() - t < BERRY.regrow * 1e3 ? t : 0 })
    }
  }
  const rocks = [] // the ones you can break
  const E = rng((hash(cx, cz, SEED + 13) * 4294967296) | 0)
  for (let i = 0, n = ROCK.perChunk * ROCK.region[region(x0 + CH / 2, z0 + CH / 2)] + E(); i < n - 1; i++) {
    const x = x0 + E() * CH
    const z = z0 + E() * CH
    const c = E()
    if (height(x, z) < WATER + 0.5 || Math.hypot(x - home.x, z - home.z) < 6 || inTown(x, z, 3) || road(x, z)[0] < RW + 1.5) continue
    const id = 'e' + i
    const t = felled[key]?.[id]
    if (t < 9e15 && Date.now() - t < REGROW) continue // broken: gone until it grows back, like a tree (an older save's 9e15 has grown back)
    const g = new THREE.Mesh(geo('rock'), itemMat)
    g.position.set(x, height(x, z) - 0.1, z)
    g.rotation.y = x * 7
    g.scale.setScalar(0.75)
    trees.push((g.col = [x, z, 0.6])) // it's in the way
    Object.assign(g, { k: id, c: c < ROCK.flint ? 'flint' : c < ROCK.flint + ROCK.gold ? 'gold' : 0 })
    mesh.add(g) // goes when the chunk's ground does
    rocks.push(g)
  }
  // a village's cave: a rocky mound whose mouth faces the village, a boulder in it until broken
  const caves = []
  for (const T of sites(x0, z0)) {
    const p = den(T.gi, T.gj)
    if (!p || Math.floor(p[0] / CH) != cx || Math.floor(p[1] / CH) != cz) continue
    const [x, z] = p
    const ry = Math.atan2(T.x - x, T.z - z)
    const fx = Math.sin(ry)
    const fz = Math.cos(ry)
    const c = { T, x, z, ry, mouth: [x + fx * 1.5, z + fz * 1.5] }
    const m = new THREE.Mesh(geo('cave'), itemMat)
    m.position.set(x, height(x, z) - 0.3, z)
    m.rotation.y = ry
    mesh.add(m)
    trees.push([x - fx * 1.2, z - fz * 1.2, 2.2])
    if (!felled.caves?.[T.k]) {
      c.rock = new THREE.Mesh(geo('boulder'), itemMat)
      c.rock.position.set(x + fx * 1.9, height(x + fx * 1.9, z + fz * 1.9) - 0.2, z + fz * 1.9)
      c.rock.rotation.y = ry
      mesh.add(c.rock)
      c.hp = CAVE.hits
      trees.push((c.col = [x + fx * 1.9, z + fz * 1.9, 1.1]))
    }
    caves.push(c)
  }
  chunks.set(key, { cx, cz, mesh, inst, trees, rocks, caves, berries, key })
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
    let k = 0
    for (const ch of chunks.values()) for (const b of ch.berries) if (!b.eaten && k < 900) berryKit.setMatrixAt(k++, b.m)
    berryKit.count = k
    berryKit.instanceMatrix.needsUpdate = true
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
    this.time = this.step = 0 // step: the gait's phase, advanced at the current speed (time * speed jumps when speed changes)
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
    const up = this.alt > 3 // flying: over trees, fences and water
    const w = up || wade(this)
    let x = this.pos.x + dx * w + this.vel.x * dt
    let z = this.pos.z + dz * w + this.vel.y * dt
    if (!up && !this.cave) for (const trees of around(x, z))
      for (const [tx, tz, r] of trees) {
        const ex = x - tx
        const ez = z - tz
        const d = Math.hypot(ex, ez)
        if (d < r + 0.4 && d > 0) {
          x = tx + (ex / d) * (r + 0.4)
          z = tz + (ez / d) * (r + 0.4)
        }
      }
    if (!up) for (const f of blockers) [x, z] = f(x, z, this)
    // a creature never steps (or is knocked) out of its medium: slide along the shore, else stay put
    const fits = this.fits
    this.stuck = 0
    if (fits && !fits(height(x, z))) {
      this.stuck = 1
      this.vel.set(0, 0)
      if (fits(height(x, this.pos.z))) z = this.pos.z
      else if (fits(height(this.pos.x, z))) x = this.pos.x
      else (x = this.pos.x), (z = this.pos.z)
    }
    this.pos.x = x
    this.pos.z = z
    this.vel.multiplyScalar(Math.max(0, 1 - dt * 6))
  }
  update(dt, run) {
    this.time += dt
    if (this.once) this.once[1] += dt
    const k = this.seat ? 0 : Math.min(1, this.speed / run)
    this.step += dt * (this.swim ? 0.6 + k * 0.6 : Math.max(0.6, k))
    const layers = this.alt > 3
      ? [['fly', this.time, 1]]
      : this.swim && this.m.clips.swim
      ? [['swim', this.step, 1]]
      : [
          ['idle', this.time, 1 - k],
          ['walk', this.step, k],
        ]
    if (this.seat) layers.push(['ride', 0, 1]) // sitting on a mount (see mounts)
    if (this.lift) layers.push(['lift', 0, 1]) // an item held over his head
    if (this.once) layers.push([this.once[0], this.once[1], 1])
    pose(this.m, layers)
    // a swimmer floats at the surface, sunk by `swim`; everyone else stands on the ground, wading in up to the waist
    this.pos.y = this.floor ?? (this.swim ? WATER - this.swim : Math.max(WATER - 0.9, height(this.pos.x, this.pos.z)))
    this.g.rotation.y = this.dir
    this.flash = Math.max(0, this.flash - dt * 4)
    this.m.mat.emissive.setRGB(this.flash * 0.7 + this.burn * 0.12, this.flash * 0.3 + this.burn * 0.04, this.flash * 0.3)
  }
}

// ---------- HUD ----------
const $ = (id) => document.getElementById(id)
let gold = 0 // kept in localStorage across reloads
try {
  gold = +localStorage.warriorGold || 0
} catch {}
function hud() {
  $('g').textContent = gold
  $('hp').style.width = (Math.max(0, player.hp) / player.maxHp) * 100 + '%'
  $('info').textContent = player.hp > 0 ? `${player.cave ? 'cave of ' + player.cave.c.T.name : village?.in ? village.name + ' · weapon stowed' : player.swim ? 'swimming · weapon stowed' : item ? item.name : ''} · ${player.kills} kills · ✦ ${done()}/${GOAL}` : `You fell after ${player.kills} kills…`
}
// the tray (models.json "tray"): eight slots, keys 1-8 or a tap, each item taken in hand; Space uses what's in hand (a
// weapon swings, wood and flint are thrown, a potion is drunk, the whistle is blown). The last slot (key 0) opens crafting: recipes (tap one; only in a village; a recipe's
// inputs can include gold, so buying wood or flint is a gold-only recipe), and tapping two slots swaps them (keys still pick). The game
// keeps running while it is open. The bag (counts) and the slot layout are kept in localStorage.
const { recipes: RECIPES, materials: MATS } = lib.tray
// the apothecary's wares: a healing potion and a speed potion (models.json "haste" vars: speed times walking, for time
// seconds, on foot and swimming, not riding; the teal bar). In the shop Space buys a healing potion, and either
// potion's tray slot (key or tap) buys one of that kind
const POTS = ['haste', 'potion']
const HASTE = lib.haste.vars
let haste = 0 // seconds of speed left
const wares = () => POTS.map((k) => `${belt.indexOf(k) + 1} ${lib[k].vars.name} ${RECIPES[k].gold} gold`).join(' · ')
// tray icons are the items' own models, each drawn once at startup into a small picture (models.json tray.icons:
// picture size, camera fov and view direction, per-item turn in degrees and zoom); any item with a model gets one
const ICON = { pack: 'craft' }
{
  const { size, fov, view, turn, zoom } = lib.tray.icons
  const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  const s = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 50)
  r.setSize(size, size)
  cam.add(new THREE.DirectionalLight('#fff', 2))
  s.add(new THREE.HemisphereLight('#fff', '#666', 2), cam)
  for (const k of new Set([...ITEMS, ...lib.tray.slots, ...Object.keys(RECIPES), 'gold', 'sunstone'])) {
    const m = new THREE.Mesh(geo(k), itemMat)
    m.rotation.y = (turn[k] || 0) * DEG
    s.add(m)
    const b = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere())
    cam.position.set(...view).setLength(b.radius / Math.sin((fov * DEG) / 2) / (zoom[k] || 1)).add(b.center)
    cam.lookAt(b.center)
    r.render(s, cam)
    ICON[k] = `<img src="${r.domElement.toDataURL()}">`
    s.remove(m)
  }
  r.forceContextLoss()
}
$('gold').insertAdjacentHTML('afterbegin', ICON.gold)
const belt = kept('warriorSlots', lib.tray.slots).map((k) => (k == 'boat' ? 'haste' : k)) // the boat's slot went to the speed potion
let pick = -1
const place = (k) => belt.includes(k) || belt.push(k)
lib.tray.slots.map(place)
const bag = kept('warriorBag', {})
bag.wood ||= 0
bag.flint ||= 0
delete bag.boat // the boat is gone (older saves)
bag.potion ||= 0
bag.haste ||= 0
bag.whistle ||= 0
bag.sunstone ||= 0
bag.torch ??= 1 // torches: one to start; each beacon keeps the one set in it
// beacons (see the beacons block): site key -> [beam azimuth, beam angle from straight up, locked on the star]
const GOAL = 5
const beacon = kept('warriorBeacons', {})
const done = () => Object.values(beacon).filter((b) => b[2]).length
// each locked beam is a stage (models.json stages): the sky tints, the creatures harden; the last is red
const STAGES = lib.stages
let st = STAGES[Math.min(done(), GOAL - 1)]
DAY.set(st.day), NIGHT.set(st.night), LITE.set(st.light)
const own = (m) => (m == 'gold' ? gold : bag[m])
const has = (r) => Object.keys(r).every((m) => own(m) >= r[m])
function tray() {
  $('tray').innerHTML =
    [...belt, 'pack']
      .map((k, i) => `${k == 'pack' ? `<b class=${bag.sunstone ? 'on' : 'off'}>${ICON.sunstone}<u>${bag.sunstone}</u></b>` : ''}<b data-s=${i} class=${(pick < 0 ? k == ITEMS[player.item] : i == pick) ? 'on' : k in bag && !bag[k] ? 'off' : ''}>${ICON[k] || ''}<i>${k == 'pack' ? 0 : i + 1}</i>${k in bag ? `<u>${bag[k]}</u>` : ''}</b>`)
      .join('')
  $('inv').innerHTML =
    Object.entries(RECIPES)
      .map(([k, r]) => `<b data-r=${k} class=${has(r) && village?.in ? '' : 'off'}>${ICON[k]} ${lib[k].vars.name} = ${Object.entries(r).map(([m, n]) => n + ICON[m]).join(' + ')}</b>`)
      .join('') +
    (village?.in ? '' : '<br>Craft in a village') +
    '<br>tap two slots to swap'
}
const pack = () => (($('inv').hidden ^= 1), (pick = -1), tray())
function slot(i, tap) {
  const k = belt[i]
  if (!(i in belt)) return i == belt.length && pack()
  if (tap && !$('inv').hidden) {
    if (pick >= 0) [belt[i], belt[pick]] = [belt[pick], belt[i]], keep('warriorSlots', belt), (i = -1)
    pick = i
    return tray()
  }
  if (k == 'torch' && !bag.torch) craft()
  if (POTS.includes(k) && player.room?.shop) return craft(k) // in the apothecary a potion's slot buys one
  if (POTS.includes(k) && !bag[k]) say('No potion: buy one at the apothecary')
  if (k == 'whistle' && !bag.whistle) craft('whistle')
  if (ITEMS.includes(k)) equip(ITEMS.indexOf(k), 1)
}
function gain(k, n) {
  bag[k] = (bag[k] || 0) + n
  keep('warriorBag', bag)
  ITEMS[player.item] == k && !bag[k] ? equip(arm) : tray()
  hud()
  ;$('tray').children[k == 'sunstone' ? belt.length : belt.indexOf(k)]?.animate([{ transform: 'scale(1.4)' }, { transform: 'none' }], 300)
}
const say = (t) => (($('tip').textContent = t), $('tip').animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], 2500))
$('tray').onpointerdown = (e) => {
  const b = e.target.closest('b')
  if (b) slot(+b.dataset.s, 1)
}
$('inv').onpointerdown = (e) => {
  const b = e.target.closest('b')
  if (b) craft(b.dataset.r)
}

// ---------- minimap: turns with the camera, fog of war over ground you haven't been near ----------
// `seen` (revealed 8x8-unit cells) is the remembered state. Pictures of chunks are a small LRU cache rebuilt from
// `seen` plus height() and region(), so the map never reads back WebGL and its memory stays bounded.
const MAP = 160 // canvas pixels
const UPP = 2 // world units per map pixel
const CELL = 8 // reveal cell, in units
const SIGHT = 36 // reveal radius, in units
// kept as one string: per explored chunk "cx,cz,mask", the mask's 25 bits its 5x5 cells, in base 36. (Older saves listed
// every cell as "i,j", which filled the browser's storage after an hour or so on the roc; they still load.)
const seen = new Set()
const N = CH / CELL
let old = 0
for (const w of kept('warriorSeen', '').split(' ')) {
  const [a, b, m] = w.split(',')
  if (m == null) w && seen.add(w) && (old = 1)
  else for (let q = parseInt(m, 36), n = 0; q; q >>= 1, n++) q & 1 && seen.add(a * N + ((n / N) | 0) + ',' + (b * N + (n % N)))
}
let saved = old ? -1 : seen.size // an old-style save is rewritten at once
let savedAt = -3e4
// writing it costs more as you explore, so it saves at most every 30 s, and when the page goes away
function saveSeen() {
  const m = {}
  for (const w of seen) {
    const [i, j] = w.split(',')
    const k = Math.floor(i / N) + ',' + Math.floor(j / N)
    m[k] = (m[k] || 0) | (1 << ((i - Math.floor(i / N) * N) * N + (j - Math.floor(j / N) * N)))
  }
  keep('warriorSeen', Object.entries(m).map(([k, q]) => k + ',' + q.toString(36)).join(' '))
  saved = seen.size
  savedAt = performance.now()
}
addEventListener('pagehide', saveSeen)
document.addEventListener('visibilitychange', () => document.hidden && saveSeen())
const tiles = new Map()
// explored chunks (key -> [cx, cz]): the maps walk these instead of every chunk in view, so empty ground costs nothing
const known = new Map()
const know = (key) => {
  const [i, j] = key.split(',')
  const cx = Math.floor((i * CELL) / CH)
  const cz = Math.floor((j * CELL) / CH)
  known.set(cx + ',' + cz, [cx, cz])
  box = [Math.min(box[0], cx), Math.min(box[1], cz), Math.max(box[2], cx + 1), Math.max(box[3], cz + 1)]
}
let box = [1e9, 1e9, -1e9, -1e9] // the explored chunks' bounds: the big map fits them all on one screen
for (const key of seen) key && know(key)
const dots = new Map() // a chunk's one colour, for a map too zoomed out for its picture, or while the picture waits
let built = 0 // pictures made in this draw: a few per draw, so revealing or zooming out never stalls a frame
let lim = 300 // pictures kept: grows to what a map shows
const trail = []
const hint = []
const mapc = $('map').getContext('2d')
const bigc = $('big').getContext('2d')
const bigMap = () => player.cave || ($('big').hidden ^= 1) // underground there's no map
$('map').onpointerdown = $('big').onpointerdown = bigMap
$('say').onpointerdown = () => ($('say').hidden = true)
const FLAT = document.createElement('canvas') // world-aligned, big enough to cover the map at any turn
FLAT.width = FLAT.height = Math.ceil(MAP * 1.42)
const flat = FLAT.getContext('2d')
const tc = new THREE.Color()
function paint(t, i, j) {
  for (let a = 0; a < CELL; a += UPP)
    for (let b = 0; b < CELL; b += UPP) {
      const x = i * CELL + a + 1
      const z = j * CELL + b + 1
      t.ctx.fillStyle = col(x, z)
      t.ctx.fillRect((x - 1 - t.cx * CH) / UPP, (z - 1 - t.cz * CH) / UPP, 1, 1)
    }
}
function col(x, z) {
  const h = height(x, z)
  const g = slope(x, z)
  // relief: ground colour (rock and snow already mark the heights), a little brighter higher up, and hillshade
  // lit from the north-west; water darkens with depth
  if (h < WATER) sea(tc, WATER - h)
  else ground(tc, x, z, h, g).multiplyScalar(Math.min(1.35, Math.max(0.5, 0.9 + h * 0.005 + (g[0] + g[1]) * 0.4)) * (region(x, z) == 1 ? 0.75 : 1)) // forest: darker
  if (h >= WATER && road(x, z)[0] < RW + 1) tc.set('#e0b070') // roads stand out on the map
  if (h >= WATER && inTown(x, z)) tc.set('#d8c49a')
  return '#' + tc.getHexString(THREE.LinearSRGBColorSpace) // no sRGB lift: keeps the map's contrast
}
function tile(cx, cz) {
  const key = cx + ',' + cz
  let t = tiles.get(key)
  if (t) {
    tiles.delete(key) // keep most recently used last
    tiles.set(key, t)
    return t
  }
  if (built++ > 3) return
  const n = CH / CELL
  const cells = []
  for (let i = cx * n; i < cx * n + n; i++) for (let j = cz * n; j < cz * n + n; j++) seen.has(i + ',' + j) && cells.push([i, j])
  if (!cells.length) return
  const cv = document.createElement('canvas')
  cv.width = cv.height = CH / UPP
  t = { cx, cz, cv, ctx: cv.getContext('2d') }
  for (const [i, j] of cells) paint(t, i, j)
  tiles.set(key, t)
  if (tiles.size > lim) tiles.delete(tiles.keys().next().value)
  return t
}
// the explored ground north-up on g (W x H pixels) around (x, z), the player by default, k map pixels per tile pixel; the minimap and the
// big map (N) both draw with it. Returns the villages whose centre you've seen.
function chart(g, W, H, k, x = player.pos.x, z = player.pos.z) {
  const u = k / UPP
  const sx = (wx) => (wx - x) * u + W / 2
  const sz = (wz) => (wz - z) * u + H / 2
  g.fillStyle = g == bigc && player.seat?.alt ? '#0b0f1840' : '#0b0f18' // flying: the world shows through the big map
  g.fillRect(0, 0, W, H)
  const span = Math.ceil(Math.max(W, H) / u / CH / 2) + 1
  const cx = Math.floor(x / CH)
  const cz = Math.floor(z / CH)
  const big = CH * u > 5 // pictures only where a chunk is more than a few pixels across
  let n = 0
  built = 0
  for (const [key, [i, j]] of known) {
    if (Math.abs(i - cx) > span || Math.abs(j - cz) > span) continue
    n++
    const t = big && tile(i, j)
    const a = Math.round(sx(i * CH))
    const b = Math.round(sz(j * CH))
    const w = Math.round(sx(i * CH + CH)) - a
    const h = Math.round(sz(j * CH + CH)) - b
    if (t) g.drawImage(t.cv, a, b, w, h)
    else {
      if (!dots.has(key)) dots.set(key, col(i * CH + CH / 2, j * CH + CH / 2))
      g.fillStyle = dots.get(key)
      g.fillRect(a, b, w, h)
    }
  }
  if (big) lim = Math.max(lim, n + 50)
  g.fillStyle = '#fff8'
  for (const [a, b] of trail) g.fillRect(sx(a) - 1, sz(b) - 1, 2, 2)
  g.fillStyle = '#fd4'
  g.fillRect(sx(home.x) - 3, sz(home.z) - 3, 6, 6) // the start
  const towns = sites(x, z, Math.ceil(Math.max(W, H) / u / G / 2) + 1).filter((t) => seen.has(Math.floor(t.x / CELL) + ',' + Math.floor(t.z / CELL)))
  g.lineWidth = 2
  for (const t of towns) {
    g.strokeStyle = beacon[t.k] ? (beacon[t.k][2] ? '#fd4' : '#f80') : '#6b4a2a' // lit orange, on the star gold
    g.beginPath()
    g.arc(sx(t.x), sz(t.z), t.r * u, 0, 7)
    g.stroke()
  }
  return towns
}
// player arrow, upright village names, north and the star's way on a rim of radius R, around (ox, oy) turned by rot
function marks(g, ox, oy, rot, k, R, towns, q = 1e9, rx = ox, ry = oy) {
  const { x, z } = player.pos
  const u = k / UPP
  g.save()
  g.translate(ox, oy)
  g.rotate(rot)
  const fx = Math.sin(player.dir)
  const fz = Math.cos(player.dir)
  g.fillStyle = '#f33'
  g.beginPath()
  g.moveTo(fx * 8, fz * 8)
  g.lineTo(-fx * 4 + fz * 5, -fz * 4 - fx * 5)
  g.lineTo(-fx * 4 - fz * 5, -fz * 4 + fx * 5)
  g.fill()
  g.restore()
  g.fillStyle = '#fff'
  g.font = 'bold 11px system-ui'
  g.textAlign = 'center'
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  for (const t of towns) {
    let dx = (t.x - x) * u
    let dz = (t.z - z) * u
    const l = Math.hypot(dx, dz) / q
    if (l > 1) (dx /= l), (dz /= l)
    g.fillText(t.name, Math.max(ox - q + 10, Math.min(ox + q - 10, ox + dx * c - dz * s)), oy + dx * s + dz * c + (l > 1 ? 4 : -t.r * u - 3))
  }
  g.fillText('N', rx + s * R, ry - c * R + 4) // north, on the rim round (rx, ry)
  const sl = Math.hypot(STAR.x, STAR.z) / R
  g.fillStyle = '#fd4'
  g.fillText('✦', rx + (STAR.x * c - STAR.z * s) / sl, ry + (STAR.x * s + STAR.z * c) / sl + 4) // the star's way
}
function reveal(x, z, R) {
  const pi = Math.floor(x / CELL)
  const pj = Math.floor(z / CELL)
  const r = Math.ceil(R / CELL)
  for (let i = pi - r; i <= pi + r; i++)
    for (let j = pj - r; j <= pj + r; j++) {
      const key = i + ',' + j
      if (seen.has(key) || Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - z) > R) continue
      seen.add(key)
      know(key)
      const t = tiles.get(Math.floor((i * CELL) / CH) + ',' + Math.floor((j * CELL) / CH))
      if (t) paint(t, i, j)
    }
}
let lastCell
function minimap() {
  $('nav').style.visibility = player.cave ? 'hidden' : '' // underground there's no map, and nothing is revealed
  if (player.cave) return
  const { x, z } = player.pos
  const pi = Math.floor(x / CELL)
  const pj = Math.floor(z / CELL)
  if (lastCell != pi + ',' + pj) {
    lastCell = pi + ',' + pj
    reveal(x, z, SIGHT + (player.seat?.alt || 0) * 1.5)
    seen.size > saved && performance.now() - savedAt > 3e4 && saveSeen()
    const last = trail[trail.length - 1]
    if (!last || Math.hypot(last[0] - x, last[1] - z) > 6) trail.push([x, z]) > 300 && trail.shift()
  }
  const W = FLAT.width
  const towns = chart(flat, W, W, 1)
  // up on the map is the way the camera looks (the way W walks)
  mapc.save()
  mapc.translate(MAP / 2, MAP / 2)
  mapc.rotate(camYaw)
  mapc.drawImage(FLAT, -W / 2, -W / 2)
  mapc.restore()
  marks(mapc, MAP / 2, MAP / 2, camYaw, 1, 68, towns, 58)
  $('pos').textContent = `${REGIONS[region(x, z)]} · ${x | 0}, ${z | 0} · ${Math.hypot(x - home.x, z - home.z) | 0} m from start`
}

// ---------- player ----------
const player = new Actor('warrior', 1)
player.hp = player.maxHp = 30
const W = site(0, 0)
const bed = new THREE.Vector3(W.x, W.y, W.z + 3)
player.pos.copy(bed)
player.dir = Math.PI
player.item = 0
player.kills = 0
player.air = 1
let item
// The torch is a weapon like the sword and axe: taking it in hand (its slot, F or SWAP) lights it (a fire swing: +2
// damage and the burn) and lights the night. Unlit, it's a weak club. A torch burns for FUEL seconds (the orange bar),
// then it's spent and leaves the bag; take another from the slot, or craft one (a wood and a flint). Water douses it.
const FUEL = 90 // a minute and a half: enough for a cave run (the 6×6 maze and its guard) if lit at the mouth
let lit = 0
let arm = 0 // the weapon last in hand: it goes on his back while he holds an item (wood, flint) up in both hands
let fuel = FUEL
function torch() {
  hold(lib, player.m, 'handL', player.lift ? null : 'shield')
  for (const b in player.m.props) if (player.m.props[b].bones.flame) player.m.props[b].bones.flame.visible = b != 'back' && lit > 0
  hud()
}
function light() {
  if (lit || player.swim || ITEMS[player.item] != 'torch' || !bag.torch) return
  lit = 1
  beep(200, 0.25, 'sawtooth', 0.03, 2)
  torch()
}
function equip(i, take) {
  player.item = (i + ITEMS.length) % ITEMS.length
  if (ITEMS[player.item] in bag && !bag[ITEMS[player.item]]) player.item = 0 // none left to hold
  const k = ITEMS[player.item]
  if (k != 'torch') lit = 0
  player.lift = player.item > 2 // anything but a weapon is held up over his head
  if (!player.lift) arm = player.item
  item = hold(lib, player.m, 'handR', k).vars
  if (village?.in || player.swim || (player.seat && k != 'torch')) village.stow(1)
  else village?.sling(player.lift && ITEMS[arm])
  torch()
  tray()
  take && light()
}
const torchLight = new THREE.PointLight('#ff9a40', 0, 14, 1.5)
scene.add(torchLight)
equip(0)

// ---------- mounts: steeds and drakes found in the world, ridden in place of the weapon ----------
// Rules: mounts keep out of villages (the fence turns them away like monsters) and out of water deeper than a wade.
// Monsters chase the rider but their blows land on the mount; enough damage in quick succession (the mount's `grip`)
// throws the rider off. Wild mounts are seeded per chunk and leave when the chunk under them unloads, coming back
// when it is rebuilt; the last mount you rode (`tamed`) stays where you left it. A taken or killed mount's chunk
// never rolls another. Some goblins ride: hit one and it falls off, leaving the mount free to take.
const mounts = []
const MOUNTS = ['steed', 'drake', 'drake', 'steed'] // which kind roams each region
const rolled = new Set() // chunks already rolled for a mount
const gone = new Set() // chunks whose mount was taken or killed
let tamed
const seatAt = new THREE.Vector3()
const fireMats = ['#f60', '#fd4'].map((color) => new THREE.MeshBasicMaterial({ color })) // the torch flame's colours
const fireGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28)
function addMount(kind, seed, x, z) {
  const m = new Actor(kind, seed)
  m.pos.set(x, 0, z)
  m.hp = m.maxHp = m.was = Math.round(m.m.vars.hp)
  m.dir = R() * 7
  m.wander = m.flee = m.cool = m.jolt = m.alt = m.fy = 0
  m.sta = 1
  mounts.push(m)
  return m
}
function dropMount(m) {
  if (m.rider) unseat(m.rider)
  scene.remove(m.g)
  m.m.root.traverse((o) => o.geometry?.dispose())
  m.m.mat.dispose()
  mounts.splice(mounts.indexOf(m), 1)
  rolled.delete(m.home)
}
function seat(r, m) {
  r.seat = m
  m.rider = r
  r.was = r.hp
  if (r == player) {
    ITEMS[player.item] != 'torch' && village.stow(1) // a torch stays in hand on a mount
    if (tamed != m) gone.add(m.home)
    tamed = m
    m.flee = m.jolt = 0
    m.up = 1
  } else {
    r.base = r.run
    r.run = m.m.vars.run * 0.7
    r.reach += 1 // the mount's head is in the way
  }
}
// take the rider off; `from` (a threat's position) makes it a fall, and the mount bolts away from it
function unseat(r, from) {
  const m = r.seat
  r.seat = m.rider = r.floor = null
  if (m.m.vars.fly) (m.leave = 1), (m.flew = m.out = 0) // a roc leaves the moment anyone comes off it, for any reason
  const a = m.dir + Math.PI / 2
  r.pos.x = m.pos.x + Math.sin(a) * 1.3
  r.pos.z = m.pos.z + Math.cos(a) * 1.3
  if (r == player) village.stow(0)
  else (r.run = r.base), (r.reach -= 1)
  m.wander = 4
  m.wa = null
  if (from) {
    r.play('hit')
    r.vel.set(Math.sin(a) * 6, Math.cos(a) * 6)
    m.flee = 3
    m.from = [from.x, from.z]
  }
}
const nearMount = () => !player.cave && mounts.find((m) => !m.rider && !m.leave && m.hp > 0 && Math.hypot(m.pos.x - player.pos.x, m.pos.z - player.pos.z) < 2.2 + m.m.root.scale.x)
function mountUp() {
  if (aim) return (aim = null)
  if (player.cave) return
  if (player.seat) return player.seat.alt ? say('Land first: Space') : unseat(player)
  const m = player.hp > 0 && !village.in && nearMount()
  if (m) seat(player, m), learn('ride')
  hud()
}
// the attack button while riding: the mount's own attack, with damage, reach and cooldown from its model vars
function buck() {
  const m = player.seat
  if (m.m.vars.fly) return m.up ? (m.up = 0) : m.sta > 0.2 ? (m.up = 1) : say(m.m.vars.name + ' is tired')
  if (m.busy || m.cool > 0) return
  m.play('attack')
  m.cool = m.m.vars.cool
  m.striking = true
  if (m.m.vars.burn) beep(90, 0.3, 'sawtooth', 0.05, 0.5)
  // a steed rears with a whinny: a quick squeal up, then a shaking slide down
  else voice([[0, 700], [0.12, 1300], [0.3, 1150], [0.8, 450]], 0.06, { vib: [13, 90], hiss: 0.5 })
}
// riding: turn toward the stick at the mount's turn rate, run along its facing, with a little momentum
function steer(dt, ix, iz, il) {
  const m = player.seat
  const v = m.m.vars
  const run = m.alt > 3 && m.sta ? v.fly : v.run
  let sp = 0
  if (chase) {
    m.dir -= ix * v.turn * 0.8 * dt + drag
    sp = -iz * run * (iz > 0 ? 0.3 : 1) * (m.busy ? 0.4 : 1) // reins: turn on the spot, back up slowly
  } else if (il > 0.1) {
    const c = Math.cos(camYaw)
    const s = Math.sin(camYaw)
    let a = Math.atan2(ix * c + iz * s, -ix * s + iz * c) - m.dir
    a = Math.atan2(Math.sin(a), Math.cos(a))
    m.dir += Math.max(-v.turn * dt, Math.min(v.turn * dt, a))
    sp = run * Math.min(1, il) * Math.max(0.3, 1 - Math.abs(a) / 2.5) * (m.busy ? 0.4 : 1)
  }
  m.speed += (sp - m.speed) * Math.min(1, dt * 3)
  m.move(Math.sin(m.dir) * m.speed * dt, Math.cos(m.dir) * m.speed * dt, dt)
  player.speed = 0
}
// a drake's breath: a short cone of flame bits from the mouth, lit by the torch light
function breathe(m) {
  m.m.bones.mouth.getWorldPosition(seatAt)
  for (let i = 0; i < 24; i++) {
    const b = new THREE.Mesh(fireGeo, fireMats[i & 1])
    const a = m.dir + (R() - 0.5) * m.m.vars.arc * 1.6
    const s = 6 + R() * 5
    b.position.copy(seatAt)
    b.v = new THREE.Vector3(Math.sin(a) * s, 2 + R() * 2, Math.cos(a) * s)
    b.life = 0.65
    scene.add(b)
    bits.push(b)
  }
  torchLight.position.copy(seatAt)
  torchLight.intensity = 25
}
blockers.push((x, z, w) => (mounts.includes(w) && height(x, z) < WATER - 0.2 ? [w.pos.x, w.pos.z] : [x, z])) // no swimming mounts
// the whistle (in hand, Space; crafted in a village): the roc flies to you and lands; ridden, it climbs high and flies fast on
// stamina, out of every creature's reach, and comes down when it runs out. Each call is one flight: when it lands with you, or
// you get off, it flies away, and only the whistle brings it back
function whistle() {
  const v = lib.roc.vars
  if (player.seat || player.cave) return
  voice([[0, 1500], [0.12, 2300], [0.24, 2150]], 0.07)
  voice([[0, 2300], [0.12, 2700], [0.42, 1600]], 0.07, { vib: [9, 50], at: 0.3 })
  let m = mounts.find((m) => m.m.vars.fly && !m.leave)
  if (!m) ((m = addMount('roc', SEED, player.pos.x - Math.sin(player.dir) * 60, player.pos.z - Math.cos(player.dir) * 60)).alt = v.alt / 2), (m.stay = v.stay), gain('whistle', -1) // each new roc costs a whistle (calling one already on its way is free) and stays `stay` seconds from the call
  m.come = m.sta = 1 // a call always brings it fully rested
  voice([[0, 2200], [0.2, 3100], [0.6, 2800], [2.2, 1200]], 0.12, { vib: [6, 40], hiss: 1.2, at: 1 })
  setTimeout(() => say(m.m.vars.name + ' the roc answers'), 1000)
}
function herd(dt) {
  // roll each newly built chunk once for a wild mount (about one chunk in 17)
  for (const [key, ch] of chunks)
    if (!rolled.has(key)) {
      rolled.add(key)
      const r = rng((hash(ch.cx, ch.cz, SEED + 9) * 4294967296) | 0)
      if (gone.has(key) || r() > 0.06) continue
      for (let i = 0; i < 5; i++) {
        const x = (ch.cx + r()) * CH
        const z = (ch.cz + r()) * CH
        if (height(x, z) > WATER + 0.5 && !inTown(x, z, 6)) {
          addMount(MOUNTS[region(x, z)], (r() * 1e6) | 0, x, z).home = key
          break
        }
      }
    }
  for (const m of [...mounts]) {
    const v = m.m.vars
    const r = m.rider
    const lost = m.was - m.hp
    m.was = m.hp
    m.cool -= dt
    if (r == player) {
      m.jolt = Math.max(0, m.jolt + lost - dt) // damage taken recently
      if (m.jolt >= v.grip || m.hp <= 0) unseat(player, player.pos) // thrown
    } else if (r) {
      if (!foes.includes(r)) {
        dropMount(m) // its goblin wandered off and despawned
        continue
      }
      if (r.hp < r.was) unseat(r, player.pos) // knocked off
    } else if (lost > 0) {
      m.flee = 3
      m.from = [player.pos.x, player.pos.z]
    }
    if (m.hp <= 0) {
      m.dead += dt
      m.update(dt, v.run)
      m.g.scale.setScalar(Math.max(0.01, Math.min(1, 2.4 - m.dead)))
      if (m.dead > 3) {
        gone.add(m.home)
        if (tamed == m) tamed = null
        dropMount(m)
      }
      continue
    }
    if (m != tamed && !v.fly && !m.rider && !chunks.has(Math.floor(m.pos.x / CH) + ',' + Math.floor(m.pos.z / CH))) {
      dropMount(m)
      continue
    }
    if (m.rider == player) {
      // steered in steer(); the blow lands partway through the attack clip
      if (m.striking && m.once?.[0] == 'attack' && m.once[1] > m.m.clips.attack.d * v.at) {
        m.striking = false
        if (v.burn) breathe(m)
        crack(m, v.reach + 1, v.arc)
        for (const e of foes) {
          const dx = e.pos.x - m.pos.x
          const dz = e.pos.z - m.pos.z
          let a = Math.atan2(dx, dz) - m.dir
          a = Math.atan2(Math.sin(a), Math.cos(a))
          if (e.hp > 0 && Math.hypot(dx, dz) < v.reach + e.m.root.scale.x * 0.4 && Math.abs(a) < v.arc) {
            hurt(e, v.dmg, m.pos, v.push)
            if (v.burn) e.burn = v.burn
          }
        }
      }
    } else if (m.rider) {
      const g = m.rider // a goblin steers; the mount carries it
      m.pos.x = g.pos.x
      m.pos.z = g.pos.z
      m.dir = g.dir
      m.speed = (g.speed / g.run) * v.run
    } else if (v.fly) {
      // called: fly to you; worn out: fly off and away
      const d = Math.hypot(player.pos.x - m.pos.x, player.pos.z - m.pos.z)
      if (m.leave && d > 150) {
        dropMount(m)
        continue
      }
      m.speed = m.leave ? v.fly / 2 : m.come ? Math.min(v.fly / 2, d * 2) : 0
      if (m.come) m.dir = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z)
      m.move(Math.sin(m.dir) * m.speed * dt, Math.cos(m.dir) * m.speed * dt, dt)
      m.come &&= m.speed > 10
    } else {
      // riderless: bolt from a threat, else graze and amble
      let sp = 0
      let a = m.dir
      if (m.flee > 0) {
        m.flee -= dt
        a = Math.atan2(m.pos.x - m.from[0], m.pos.z - m.from[1])
        sp = v.run * 0.8
      } else if ((m.wander -= dt) < 0) {
        m.wander = 3 + R() * 4
        m.wa = R() < 0.5 ? null : R() * 7
      } else if (m.wa != null) {
        a = m.wa
        sp = v.run * 0.15
      }
      a = Math.atan2(Math.sin(a - m.dir), Math.cos(a - m.dir))
      m.dir += Math.max(-v.turn * dt, Math.min(v.turn * dt, a))
      m.speed = sp
      m.move(Math.sin(m.dir) * sp * dt, Math.cos(m.dir) * sp * dt, dt)
    }
    if (v.fly) {
      // altitude: climb to `alt` while ridden and rested (skim low over water when landed by hand), glide in when called
      const g = Math.max(WATER - 0.9, height(m.pos.x, m.pos.z))
      // its time is up, ridden or not (calling it again doesn't add any): riderless it flies off, ridden it comes down and sets you off
      if ((m.stay -= dt) < 0 && !r && !m.leave) say(v.name + ' grows restless and flies off'), (m.leave = 1)
      if (m.sta <= 0 || m.stay < 0) (m.up = 0), (m.out = r == player) // worn out: it comes down, throws you off and leaves
      const want = r == player ? (m.up ? v.alt : g < WATER && !m.out ? 4 : 0) : m.come ? m.speed : m.leave ? v.alt : 0
      m.alt = Math.max(0, m.alt + Math.max(-v.lift * dt, Math.min(v.lift * dt, want - m.alt)))
      m.sta = Math.min(1, Math.max(0, m.sta + dt * (m.alt > 3 && r ? -1 / v.tire : 1 / v.rest)))
      m.fy = Math.max(g, m.fy + (g + m.alt - m.fy) * Math.min(1, dt * 3))
      m.floor = m.alt ? m.fy : null
      if (r == player && m.alt > 0.3) m.flew = 1 // any take-off counts, even a hop that lands again before climbing high
      // one call, one flight: once it has flown you and lands, it sets you down and leaves (tired or not)
      if ((m.flew || m.stay < 0) && r == player && !m.alt) say(v.name + (m.stay < 0 ? ' grows restless and flies off' : m.out ? ' is worn out and flies off' : ' flies off')), unseat(player, player.pos)
    }
    m.update(dt, v.run)
    if (m.rider) {
      // the rider's hip sits on the saddle socket
      const s = m.rider
      m.g.updateMatrixWorld(true)
      m.m.bones.saddle.getWorldPosition(seatAt)
      s.floor = seatAt.y - s.m.bones.hip.position.y * s.m.root.scale.y
      if (s == player) {
        s.pos.x = seatAt.x
        s.pos.z = seatAt.z
        s.dir = m.dir
      }
    }
  }
  if (player.seat) torchLight.intensity *= 1 - Math.min(1, dt * 6) // the breath's flash fades
  // HUD: the mount's name and health while riding (the hint line by the tray says "R · ride" beside a free one)
  const t = player.seat
  $('rider').hidden = !t
  if (t) {
    $('mbar').hidden = !player.seat
    $('mhp').style.width = (t.m.vars.fly ? t.sta : Math.max(0, t.hp) / t.maxHp) * 100 + '%'
    $('mname').textContent = player.seat ? `${t.m.vars.name} the ${t.m.vars.kind} · ${t.m.vars.fly ? 'Space fly/land · ' : ''}R to get off` : `R · ride ${t.m.vars.name} the ${t.m.vars.kind}`
  }
}

// ---------- monsters ----------
const foes = []
const { nearPay, farPay, payRamp, spawnPad, homeRamp, homeCrowd, homeFierce } = lib.wilds
let seedNext = 100
// how far out from home (the start), 0 there to 1 at homeRamp: near home the wilds are thinner and tamer, so starting
// over after a fall isn't a swarm; the beams' stages scale on top of this
const out = (x, z) => Math.min(1, Math.hypot(x - home.x, z - home.z) / homeRamp)
// More monsters roam at night: 12 by day, up to 22 in the dark, scaled by the region the player is in, the stage and
// the distance from home (homeCrowd of it at home).
const crowd = () => Math.round((12 + (1 - day) * 10) * CROWD[region(player.pos.x, player.pos.z)] * st.crowd * (homeCrowd + (1 - homeCrowd) * out(player.pos.x, player.pos.z)))
function foe(kind, x, z) {
  const e = new Actor(kind, seedNext++)
  e.pos.set(x, 0, z)
  e.fits = HABITAT[kind] || onLand
  if (kind == 'eel') e.swim = 0.1
  const s = e.m.root.scale.x
  // fierceness: homeFierce near home, 1 from homeRamp out; it scales health, damage, how far it spots you and how often it strikes
  const k = (e.fierce = homeFierce + (1 - homeFierce) * out(x, z))
  e.hp = e.maxHp = Math.max(1, Math.round({ slime: 5, goblin: 8, spider: 7, bat: 4, eel: 6 }[kind] * (0.6 + s * 0.6) * st.hp * k))
  e.run = { slime: 3, goblin: 4.2, spider: 5, bat: 4.5, eel: 4.8 }[kind] * st.run
  e.dmg = Math.max(1, Math.round({ slime: 1, goblin: 2, spider: 2, bat: 1, eel: 1 }[kind] * st.dmg * k))
  e.reach = 1.2 + s * 0.4
  e.wander = 0
  e.cool = 1
  foes.push(e)
  return e
}
function spawn(f) {
  if (f) {
    scene.remove(f.g)
    f.m.root.traverse((o) => o.geometry?.dispose()) // each monster's mesh is its own; the bar's is shared
    f.m.mat.dispose()
    foes.splice(foes.indexOf(f), 1)
    if (player.cave || foes.length >= crowd()) return // underground, nothing comes from the surface
  }
  // pick a spot first, then a kind that lives there: eels in deep water (a few at most), the region's mix on dry
  // land; shallows and the village are skipped
  let x, z, h, kind
  const eels = foes.filter((e) => e.kind == 'eel').length
  for (let tries = 0; !kind && tries < 99; tries++) {
    const a = R() * 7
    const d = 18 + R() * 30
    x = player.pos.x + Math.cos(a) * d
    z = player.pos.z + Math.sin(a) * d
    h = height(x, z)
    if (inTown(x, z, spawnPad)) continue
    if (h < SWIM - 0.5) kind = eels < 4 ? 'eel' : null
    else if (h > WATER + 0.3) {
      const mix = FOES[region(x, z)]
      kind = mix[(R() * mix.length) | 0]
    }
  }
  if (!kind) return
  const e = foe(kind, x, z)
  if (kind == 'goblin' && R() < 0.2) seat(e, addMount(MOUNTS[region(x, z)], seedNext++, x, z)) // a goblin rider
}
for (let i = crowd(); i > 0; i--) spawn() // as many as the place calls for: few near home

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
    b.visible = e.hp > 0 && clear(player.pos.x, player.pos.z, e.pos.x, e.pos.z) // (drawn over everything, so hidden behind a cave wall)
    b.fill.scale.x = Math.max(0.001, b.v * b.w)
    b.fill.material = barFills[f > 0.6 ? 2 : f > 0.3 ? 1 : 0]
    b.quaternion.copy(barQ.copy(e.g.quaternion).invert()).multiply(camera.quaternion) // billboard
  }
}

// ---------- villages: houses round a square, townsfolk, doors into rooms ----------
// Each site from the settlement layer is built when the player comes within 150 units and disposed of past 200.
// Rooms sit deep under their village (the ground hides them). A door fades to black and moves you down into the
// room, where a fixed camera looks in over a low front wall (a cutaway). Walking back out of the door reverses it.
var village
{
  const TAU = Math.PI * 2
  const built = new Map() // site key -> built village, only the few near the player
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

  function build(T) {
    const VR = rng(T.seed)
    const parts = [] // compiled models to dispose of
    const add = (name, seed, x, y, z, ry = 0) => {
      const m = make(lib, name, seed)
      m.root.position.set(x, y, z)
      m.root.rotation.y = ry
      scene.add(m.root)
      parts.push(m)
      return m
    }
    // a gate wherever a road leaves (one seeded gate if none does)
    const gates = []
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const { a, b, p } of links(T.gi + i, T.gj + j)) {
          const q = a == T.k ? p[0] : b == T.k ? p[p.length - 1] : null
          if (q) gates.push(Math.atan2(q[1] - T.z, q[0] - T.x))
        }
    if (!gates.length) gates.push(VR() * TAU)
    const gap = (a, w = 0.07) => gates.some((g) => Math.abs(Math.sin((a - g) / 2)) < w)

    add('plaza', 1, T.x, T.y, T.z).root.scale.set(T.r * 0.37, 1, T.r * 0.37)
    add('well', 1, T.x, T.y, T.z)
    const path = (a, len) => (add('path', 1, T.x, T.y - 0.01, T.z, Math.PI / 2 - a).root.scale.z = len)
    for (const g of gates) path(g, T.r) // the road takes over at the gate

    // houses evenly round the square, leaving the gates' paths clear, doors facing the well
    const houses = []
    const n = 5 + (((T.r - 12) / 2) | 0)
    for (let i = 0; i < n; i++) {
      const a = gates[0] + ((i + 0.5 + (VR() - 0.5) * 0.3) * TAU) / n
      const r = T.r * 0.6 + VR() * 1.5
      if (gap(a, 0.22)) continue
      const x = T.x + Math.cos(a) * r
      const z = T.z + Math.sin(a) * r
      const ry = Math.atan2(T.x - x, T.z - z)
      const m = add('house', T.seed + i, x, T.y, z, ry)
      const { w, d } = m.vars
      const sx = Math.sin(ry)
      const sz = Math.cos(ry)
      path(a + Math.PI, r - d / 2)
      const room = add('room', T.seed + i, x, T.y - 40 - i * 15, z)
      m.mat.transparent = true
      houses.push({ m, x, z, ry, w, d, ty: T.y, out: [x + sx * (d / 2 + 1.4), z + sz * (d / 2 + 1.4)], y: room.root.position.y, rw: room.vars.w, rd: room.vars.d })
    }

    // the first house is the apothecary: a big bottle by its door, a shopkeeper inside
    const h = houses[0]
    h.shop = 1
    add('potion', 1, h.out[0] + Math.cos(h.ry) * 1.4, T.y, h.out[1] - Math.sin(h.ry) * 1.4).root.scale.setScalar(4)

    // fence ring, open at the gates
    {
      const m = make(lib, 'fence', 1)
      const count = Math.floor((TAU * T.r) / 2.1)
      const mesh = new THREE.InstancedMesh(bake(m), m.mat, count)
      mesh.castShadow = true
      const o = new THREE.Object3D()
      let k = 0
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU
        if (gap(a)) continue
        o.position.set(T.x + Math.cos(a) * T.r, T.y, T.z + Math.sin(a) * T.r)
        o.rotation.y = -a - Math.PI / 2
        o.updateMatrix()
        mesh.setMatrixAt(k++, o.matrix)
      }
      mesh.count = k
      scene.add(mesh)
      parts.push({ root: mesh, mat: m.mat })
    }

    // townsfolk: the warrior's skeleton in seeded clothes, strolling between doors and the well
    const spots = [...houses.map((h) => [h.out[0] + Math.cos(h.ry) * 1.6, h.out[1] - Math.sin(h.ry) * 1.6]), ...[0, 1, 2, 3].map((i) => [T.x + Math.cos(i * 1.6) * 2.2, T.z + Math.sin(i * 1.6) * 2.2])]
    const v = { T, parts, houses, gap, spots, VR, folk: [] }
    for (let i = 0; i < houses.length + 2; i++) {
      const f = new Actor('villager', T.seed + i)
      const [x, z] = spots[i % spots.length]
      f.pos.set(x, 0, z)
      f.goal = spots[(VR() * spots.length) | 0]
      f.wait = VR() * 3
      f.town = v
      f.i = i
      v.folk.push(f)
      parts.push(f.m)
    }
    v.sage = v.folk[T.seed % v.folk.length] // the one who knows which way the sunstone sleeps
    const f = new Actor('villager', T.seed - 1)
    f.pos.set(h.x, 0, h.z - h.rd / 2 + 0.9)
    f.floor = h.y
    f.goal = [f.pos.x, f.pos.z]
    f.wait = f.keep = Infinity
    v.folk.push(f)
    parts.push(f.m)
    return v
  }
  const TALK = lib.talk
  const told = {}
  const talk = (v, f) => {
    const T = v.T
    const q = den(T.gi, T.gj)
    if (f == v.sage) return !q ? 'No cave lies near here, friend' : got(T) ? 'The sunstone of our cave is found. Any well will take it!' : felled.caves?.[T.k] ? 'The cave is open. Its sunstone lies at the end of the maze, past its guardians. Take a lit torch!' : `A cave lies out in the wilds, ${['north', 'east', 'south', 'west'][Math.round(Math.atan2(q[0] - T.x, T.z - q[1]) / (Math.PI / 2)) & 3]} of ${T.name}. A great boulder seals it: crack it with your axe`
    const k = T.seed + f.i
    const pick = (a, name) => a[k % a.length].replace('@', name)
    if (told[k]) return told[k]
    const role = TALK.roles[f.i % TALK.roles.length]
    let line = pick(TALK.greet, v.T.name)
    if (role == 'mission') line = pick(TALK.mission)
    if (role == 'guide') {
      const t = sites(v.T.x, v.T.z, 2)
        .filter((t) => !beacon[t.k] && !seen.has(Math.floor(t.x / CELL) + ',' + Math.floor(t.z / CELL)))
        .sort((a, b) => Math.hypot(a.x - v.T.x, a.z - v.T.z) - Math.hypot(b.x - v.T.x, b.z - v.T.z))[0]
      if (t) reveal(t.x, t.z, t.r + 12), hint.push([t.x, t.z]), (line = pick(TALK.guide, t.name))
    }
    return (told[k] = line)
  }
  function raze(v) {
    for (const m of v.parts) {
      m.root.removeFromParent()
      m.root.traverse((o) => o.geometry?.dispose())
      m.mat.dispose()
    }
    for (const f of v.folk) scene.remove(f.g)
  }

  // colliders: monsters and mounts kept out of every village; houses, the well, the fence and townsfolk; room walls and furniture
  function fend(v, x, z, who) {
    const T = v.T
    let d = Math.hypot(x - T.x, z - T.z) || 1
    if (d > T.r + 6 && who.town != v) return [x, z]
    if (foes.includes(who) || mounts.includes(who)) return d < T.r + 1 ? [T.x + ((x - T.x) / d) * (T.r + 1), T.z + ((z - T.z) / d) * (T.r + 1)] : [x, z]
    for (const o of v.houses) [x, z] = box(x, z, o.x, o.z, o.w / 2 + 0.4, o.d / 2 + 0.4, o.ry)
    if (who == player) for (const f of v.folk) [x, z] = box(x, z, f.pos.x, f.pos.z, 0.45, 0.45)
    else if (who.town == v)
      for (const f of [...v.folk, player]) {
        // townsfolk keep 0.6 apart (and from you)
        const ex = x - f.pos.x
        const ez = z - f.pos.z
        const e = Math.hypot(ex, ez) / 0.6
        if (f != who && e < 1) (x = f.pos.x + ex / e), (z = f.pos.z + ez / e), (who.bump = -~who.bump)
      }
    const dx = x - T.x
    const dz = z - T.z
    d = Math.hypot(dx, dz) || 1
    let r = Math.max(d, 1.5) // the well
    if (who.town == v) r = Math.min(r, T.r - 1) // townsfolk stay in
    else if (who == player && !v.gap(Math.atan2(dz, dx)) && Math.abs(d - T.r) < 0.45) r = d < T.r ? T.r - 0.45 : T.r + 0.45 // the fence
    return r == d ? [x, z] : [T.x + (dx / d) * r, T.z + (dz / d) * r]
  }
  blockers.push((x, z, who) => {
    if (who.cave) return [x, z]
    const h = who.room
    if (h) {
      const gap = Math.abs(x - h.x) < 0.8
      x = Math.max(h.x - h.rw / 2 + 0.35, Math.min(h.x + h.rw / 2 - 0.35, x))
      z = Math.max(h.z - h.rd / 2 + 0.7, Math.min(h.z + h.rd / 2 - (gap ? 0.1 : 0.45), z))
      ;[x, z] = box(x, z, h.x - h.rw / 2 + 0.8, h.z - h.rd / 2 + 1.3, 0.95, 1.4) // bed
      ;[x, z] = box(x, z, h.x + h.rw / 2 - 1.6, h.z + 0.2, 1.1, 1.3) // table and stools
      if (h.shop) [x, z] = box(x, z, h.x, h.z - h.rd / 2 + 0.9, 0.5, 0.5) // the shopkeeper
      return box(x, z, h.x + h.rw / 2 - 0.35, h.z - h.rd / 2 + 0.8, 0.6, 0.9) // shelf
    }
    for (const v of built.values()) [x, z] = fend(v, x, z, who)
    return [x, z]
  })

  // the weapon hangs on the warrior's back inside a village, its longest end down (a torch's flame up)
  const back = new THREE.Object3D()
  const turn = new THREE.Object3D() // aims whichever prop is stowed
  back.position.set(-0.05, 0.62, -0.27)
  back.rotation.set(110 * DEG, 0, 35 * DEG, 'ZYX') // +z points down and back, leaning across the back
  back.add(turn)
  player.m.bones.chest.add(back)
  player.m.bones.back = turn
  const v3 = new THREE.Vector3()
  function sling(k) {
    const p = hold(lib, player.m, 'back', k)
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
        for (let i = 0; i < a.count; i++) if (v3.fromBufferAttribute(a, i).applyMatrix4(M).length() > far.length()) far.copy(v3)
      })
      turn.quaternion.setFromUnitVectors(far.normalize(), v3.set(0, 0, p.vars.burn ? -1 : 1))
    }
  }
  function stow(on) {
    sling(on && ITEMS[player.lift ? arm : player.item])
    if (on) hold(lib, player.m, 'handR', null), (player.lift = 0), torch()
    else equip(player.item)
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
    fade,
    glow,
    built,
    stow,
    sling,
    in: false,
    name: '',
    chat: 0,
    speak() {
      const [v, f] = this.chat
      learn('talk')
      $('say').hidden = false
      $('say').innerHTML = `<small>${f == v.sage ? 'Sage' : 'Townsfolk'} of ${v.T.name}</small><p>${talk(v, f)}</p><small>Space or tap</small>`
    },
    enter(h) {
      fade(() => {
        player.room = h
        player.floor = h.y
        yaw = camYaw
        player.pos.set(h.x, h.y, h.z + h.rd / 2 - 0.9)
        player.vel.set(0, 0)
        player.dir = Math.PI
        glow.position.set(h.x, h.y + 1.2, h.z - h.rd / 2 + 1.2)
        if (h.shop) say('Apothecary · ' + wares())
      })
    },
    leave() {
      const h = player.room
      fade(() => {
        player.room = player.floor = null
        camYaw = yaw
        player.pos.set(h.out[0], h.ty, h.out[1])
        player.vel.set(0, 0)
        player.dir = h.ry
        camera.position.set(h.out[0] + Math.sin(camYaw) * 7, h.ty + 7.5, h.out[1] + Math.cos(camYaw) * 7)
      })
    },
    update(dt) {
      const p = player.pos
      // stream: build at most one village a frame, dispose of far ones
      const T = sites(p.x, p.z).find((t) => !built.has(t.k) && Math.hypot(t.x - p.x, t.z - p.z) < 150)
      if (T) built.set(T.k, build(T))
      for (const [k, v] of built) if (Math.hypot(v.T.x - p.x, v.T.z - p.z) > 200) raze(v), built.delete(k)
      const here = [...built.values()].find((v) => Math.hypot(p.x - v.T.x, p.z - v.T.z) < v.T.r)
      const was = this.in
      const named = this.name
      this.in = player.hp > 0 && !!here && !player.seat && !player.cave
      this.name = here?.T.name
      if (this.in != was) stow(this.in)
      if (this.in != was || this.name != named) hud()
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
        scene.fog.far = 1e3
        scene.background = BLACK
      } else {
        if (!player.cave) glow.intensity = 0 // (underground it's the sunstone's glow)
        scene.background = sky
        if (here && !player.cave) hemi.intensity = Math.max(hemi.intensity, 0.4) // lamplight: a village needs no torch
        for (const o of here?.houses || []) {
          // pressed against the front wall, within the door's width
          const c = Math.cos(o.ry)
          const s = Math.sin(o.ry)
          const lx = (p.x - o.x) * c - (p.z - o.z) * s
          const lz = (p.x - o.x) * s + (p.z - o.z) * c
          if (this.in && Math.abs(lx) < 0.6 && lz > 0 && lz < o.d / 2 + 0.5) this.enter(o) // on foot only: a rider flying over can't drop in
        }
        // a house between the camera and the player fades to see-through
        const ax = camera.position.x
        const az = camera.position.z
        const bx = p.x - ax
        const bz = p.z - az
        for (const v of built.values())
          for (const o of v.houses) {
            const t = Math.min(1, Math.max(0, ((o.x - ax) * bx + (o.z - az) * bz) / (bx * bx + bz * bz)))
            const hide = t < 0.98 && Math.hypot(ax + bx * t - o.x, az + bz * t - o.z) < Math.max(o.w, o.d) / 2 + 0.6
            o.m.mat.opacity += ((hide ? 0.25 : 1) - o.m.mat.opacity) * Math.min(1, dt * 8)
          }
      }
      let near = ROCK.talk + 1
      this.chat = 0
      for (const v of built.values())
        for (const f of v.folk) {
          const dx = f.goal[0] - f.pos.x
          const dz = f.goal[1] - f.pos.z
          let d = Math.hypot(dx, dz)
          f.speed = 0
          const n = Math.hypot(p.x - f.pos.x, p.z - f.pos.z)
          if (n < near && !f.keep && player.hp > 0 && !player.seat && !player.cave && !title) (near = n), (this.chat = [v, f])
          if ((f.wait -= dt) > 0) f.keep || f.move(0, 0, dt)
          else if (d < 0.6 || f.bump > 299) {
            f.bump = 0 // blocked a while: give up and pick somewhere else
            f.wait = 2 + v.VR() * 5
            f.goal = v.spots[(v.VR() * v.spots.length) | 0]
          } else {
            // bear right round anyone close ahead, so two meeting head-on walk round each other
            let ux = dx / d
            let uz = dz / d
            for (const o of [...v.folk, player]) {
              const ox = o.pos.x - f.pos.x
              const oz = o.pos.z - f.pos.z
              if (o != f && Math.hypot(ox, oz) < 1.2 && ox * ux + oz * uz > 0) ([ux, uz] = [ux + uz, uz - ux]), (f.bump = -~f.bump)
            }
            d = Math.hypot(ux, uz) / 1.6 / dt
            f.speed = 1.6
            f.dir = Math.atan2(ux, uz)
            f.move(ux / d, uz / d, dt)
          }
          f.update(dt, 1.6)
        }
      // the nearest townsfolk stops and turns to you (Space talks)
      const c = !h && this.chat
      if (c) {
        const f = c[1]
        f.wait = Math.max(f.wait, 2)
        f.goal = [f.pos.x, f.pos.z]
        f.dir = Math.atan2(p.x - f.pos.x, p.z - f.pos.z)
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
// ripples: a flat ring on the water that widens and fades
const ripples = []
const ringGeo = new THREE.RingGeometry(0.8, 1, 20).rotateX(-90 * DEG)
function ripple(p, size = 1) {
  const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#e8f4ff', transparent: true, depthWrite: false }))
  r.position.set(p.x, WATER + 0.02, p.z)
  r.size = size
  r.life = 1
  scene.add(r)
  ripples.push(r)
}

// ---------- drops: a kill spills coins, a felled tree logs, a struck rock flint; they bounce, sit spinning, and drift to the player when close ----------
// A kill pays its kind's "gold" var (models.json) x its size x a seeded roll x up to 1.6 at night x its region x how far
// it fell from the nearest village fence (models.json "wilds": nearPay at the fence up to farPay payRamp units out).
const PAY = [1, 1.2, 1.4, 1.1] // per region: meadow, forest, rocky hills, lakes
const wild = (x, z) => nearPay + ((farPay - nearPay) * Math.max(0, Math.min(payRamp, ...sites(x, z).map((t) => Math.hypot(x - t.x, z - t.z) - t.r)))) / payRamp
const drops = []
const coinMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: '#5a3c00' })
function loot(e) {
  const roll = hash(e.seed, player.kills, SEED + 5)
  spill('gold', Math.max(1, Math.round(e.m.vars.gold * (0.6 + e.m.root.scale.x * 0.6) * (0.7 + roll * 0.6) * (1 + (1 - day) * 0.6) * PAY[region(e.pos.x, e.pos.z)] * st.pay * wild(e.pos.x, e.pos.z))), e.pos)
}
function earn(n) {
  gold = Math.max(0, gold + n)
  try {
    localStorage.warriorGold = gold
  } catch {}
  hud()
  tray()
  $('gold').animate([{ transform: 'scale(1.6)', color: n < 0 ? '#f55' : '#fff' }, { transform: 'scale(1)' }], n < 0 ? 900 : 250)
}
// one drop of item k worth n, thrown from q; a tossed one (Space) stays put until you walk onto it
function shed(k, q, v, n = 1, tossed) {
  const c = new THREE.Mesh(geo(k), k == 'gold' ? coinMat : itemMat)
  c.position.copy(q)
  Object.assign(c, { v, k, n, tossed, age: 0, castShadow: true })
  scene.add(c)
  drops.push(c)
}
// n of item k burst out of p, in up to 6 pieces
function spill(k, n, p) {
  const m = Math.min(n, 6)
  for (let i = 0; i < m; i++) {
    const a = R() * 7
    const s = 1.5 + R() * 2.5
    shed(k, { x: p.x, y: p.y + 0.6, z: p.z }, new THREE.Vector3(Math.cos(a) * s, 4 + R() * 3, Math.sin(a) * s), Math.floor(n / m) + (i < n % m))
  }
}
function toss(k) {
  shed(k, player.pos.clone().setY(player.pos.y + 1.2), new THREE.Vector3(Math.sin(player.dir) * 4, 3, Math.cos(player.dir) * 4), 1, 1)
  player.play('jab')
  gain(k, -1)
}
// picking up a sunstone is the big moment: a fanfare, a fountain of sparks and a box that pauses the game
function sunstone() {
  for (let i = 0; i < 8; i++) setTimeout(() => beep(523 * 1.26 ** (i % 4) * (i > 3 ? 2 : 1), 0.6, 'triangle', 0.06, 1), i * 120)
  for (let i = 0; i < 4; i++) burst(player.pos.clone().setY(player.pos.y + i * 0.6), ['#fb4', '#fff', '#f84', '#fe8'][i], 20)
  $('say').hidden = false
  $('say').innerHTML = `<small>✦ ✦ ✦</small><h2>You found a sunstone!</h2><p>Set it in any village well with a torch, and its beam will rise to the star</p><small>Space or tap</small>`
  $('say').animate([{ transform: 'translate(-50%,-50%) scale(.3)', boxShadow: '0 0 0 #fb4' }, { transform: 'translate(-50%,-50%) scale(1.1)', boxShadow: '0 0 80px #fb4' }, { transform: 'translate(-50%,-50%)', boxShadow: '0 0 0 #fb4' }], 900)
}
const lose = (c) => (scene.remove(c), drops.splice(drops.indexOf(c), 1))
function pickups(dt) {
  const p = player.pos
  coinMat.emissive.setRGB(0.35, 0.24, 0).multiplyScalar(0.7 + Math.sin(clock.elapsedTime * 4) * 0.3) // a soft glow pulse
  for (const c of [...drops]) {
    const q = c.position
    const dx = p.x - q.x
    const dy = p.y + 0.8 - q.y
    const dz = p.z - q.z
    const wet = q.y < WATER
    const d = player.swim && wet ? Math.hypot(dx, dz) || 0.01 : Math.hypot(dx, dy, dz) // a swimmer dives for sunk drops at any depth
    c.age += dt
    if (player.hp > 0 && d < (c.tossed ? 1.6 : 3.5) && c.age > (c.tossed ? 1 : 0.5)) {
      // magnet: faster the closer it gets
      const sp = Math.min(d, (5 + (3.5 - d) * 5) * dt) / d
      q.x += dx * sp
      q.y += dy * sp
      q.z += dz * sp
      if (d < 0.6) {
        c.k == 'gold' ? earn(c.n) : gain(c.k, c.n)
        if (c.k == 'sunstone') sunstone()
        beep(1568, 0.06, 'square', 0.03, 1) // ching
        setTimeout(() => beep(2093, 0.3, 'triangle', 0.05, 0.98), 60)
        burst(q.clone().setY(q.y - 0.6), '#fd4', 5)
        lose(c)
        continue
      }
    } else {
      // fall and bounce, then rest on the ground; in water, sink slowly to the bed
      const floor = height(q.x, q.z) + 0.22
      if (wet) c.v.multiplyScalar(1 - Math.min(1, 4 * dt)).y = Math.max(c.v.y - 4 * dt, -1.2)
      else c.v.y -= 15 * dt
      q.addScaledVector(c.v, dt)
      if (!wet && q.y < WATER && floor < WATER) ripple(q, 0.35)
      if (q.y < floor) {
        q.y = floor
        c.v.set(c.v.x * 0.5, Math.abs(c.v.y) > 1.5 ? -c.v.y * 0.4 : 0, c.v.z * 0.5)
      }
    }
    c.rotation.y += dt * 3
    const stay = c.tossed || c.k == 'sunstone' // a sunstone never fades
    c.visible = c.age < 40 || stay || (c.age * 8) & 1 // blink before it goes
    if ((c.age > 45 && !stay) || !chunks.has(Math.floor(q.x / CH) + ',' + Math.floor(q.z / CH))) lose(c)
  }
}

// ---------- wood: the axe (its "chop" var) fells pines and oaks for the tray ----------
// A struck tree leaves its InstancedMesh for a mesh of its own that shakes; three chops and it falls away from you,
// bursts out 3 logs to pick up, and sinks. Its chunk key and candidate index go in `felled`, so grow() skips it until it regrows.
const falling = []
function chop() {
  const p = player.pos
  let t, list
  let best = item.reach + 0.4
  for (const trees of around(p.x, p.z))
    for (const e of trees) {
      const dx = e[0] - p.x
      const dz = e[1] - p.z
      const d = Math.hypot(dx, dz) - e[2]
      if (e[4] != null && d < best && Math.cos(Math.atan2(dx, dz) - player.dir) > 0.4) (best = d), (t = e), (list = trees)
    }
  if (!t) return
  const [x, z, , i, v, m, key] = t
  let f = t.f
  if (!f) {
    const ch = chunks.get(key)
    ch.inst[v].splice(ch.inst[v].indexOf(m), 1)
    dirty = true
    const mesh = new THREE.Mesh(kit[v].geometry, kit[v].material)
    mesh.castShadow = true
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(m).setPosition(0, 0, 0)
    f = t.f = new THREE.Group()
    f.position.setFromMatrixPosition(m)
    f.add(mesh)
    scene.add(f)
    Object.assign(f, { hits: 0, t: -1, ch, key })
    falling.push(f)
  }
  f.hits += item.chop
  f.shake = 1
  burst({ x: x + (p.x - x) * 0.3, y: f.position.y, z: z + (p.z - z) * 0.3 }, '#d8b070', 5) // chips
  beep(110, 0.08, 'square', 0.09, 0.5) // thunk
  beep(70, 0.15, 'triangle', 0.12, 0.7)
  if (f.hits >= 3 && f.t < 0) {
    f.t = 0
    const a = Math.atan2(x - p.x, z - p.z)
    f.ax = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)) // tips away from you
    list.splice(list.indexOf(t), 1)
    ;(felled[key] ||= {})[i] = Date.now()
    keep('warriorFelled', felled)
  }
}
function fells(dt) {
  for (const f of [...falling]) {
    f.shake = Math.max(0, f.shake - dt * 3)
    if (f.t < 0) f.rotation.set(Math.sin(clock.elapsedTime * 50) * 0.05 * f.shake, 0, Math.sin(clock.elapsedTime * 43) * 0.04 * f.shake)
    else {
      f.t += dt
      f.quaternion.setFromAxisAngle(f.ax, Math.min(1.5, f.t * f.t * 2.5))
      if (f.t > 0.8 && !f.paid) {
        f.paid = 1
        spill('wood', 3, f.position)
        splash(0.25) // crash
        beep(55, 0.4, 'sawtooth', 0.06, 0.5)
        burst(f.position, '#7a5230', 10)
      }
      if (f.t > 1.8) f.position.y -= dt * 2
    }
    if (f.t > 2.8 || chunks.get(f.key) != f.ch) {
      scene.remove(f)
      falling.splice(falling.indexOf(f), 1)
    }
  }
}

// ---------- beacons: the goal. Set a torch in five villages' wells and aim each beam at the star ----------
// The star hangs at one fixed direction, as if infinitely far, so the same aim is right from every village. At a
// well, Space sets a torch and a sunstone (from a cave) in the beacon, and you hold the beam at once (Space takes it
// again later, R lets go): turning swings it, W/S tilt it, and the camera looks along it. The beam warms from white to gold as it nears the star and
// locks within LOCK radians. Beams are drawn from anywhere: a far one is moved toward the camera and shrunk by the same
// factor, which leaves its picture unchanged but keeps it inside the camera's range (it is also fattened, to be seen). Parallel beams all meet at their
// vanishing point, the star. The fifth lock starts the light show and the end screen.
const LOCK = 0.07 // the snap zone: a beam within ~4 degrees of the eye snaps onto it and locks
const STAR = new THREE.Vector3().setFromSphericalCoords(1, (50 + hash(3, 4, SEED + 9) * 25) * DEG, hash(5, 6, SEED + 9) * 7)
// a locked beam points exactly at the eye, not merely within LOCK of it (older saves too)
const onStar = (b) => ((b[0] = Math.atan2(STAR.x, STAR.z)), (b[1] = Math.acos(STAR.y)), (b[2] = 1))
const star = new THREE.Mesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({ color: '#fff6c0', fog: false }))
scene.add(star)
const beamGeo = new THREE.CylinderGeometry(1.5, 0.45, 1, 8, 1, true).translate(0, 0.5, 0)
const UP = new THREE.Vector3(0, 1, 0)
const ray = new THREE.Vector3()
const beams = new Map() // site key -> { T, mesh, m }: m is the fire and sunstone, built only near
let aim = null // the site whose beam you hold
let well = null // the site whose well you stand at
let show = 0 // seconds into the light show
const siteAt = (k) => site(...k.split(',').map(Number))
const top = (T) => new THREE.Vector3(T.x, T.y + 3.5, T.z) // the sunstone, over the well's roof
const dir = (b) => ray.setFromSphericalCoords(1, b[1], b[0])
// on load, a saved beam already inside the snap zone locks too (one let go there before the zone grew was saved unlocked)
for (const b of Object.values(beacon)) (b[2] || dir(b).angleTo(STAR) < LOCK) && onStar(b)
keep('warriorBeacons', beacon)
st = STAGES[Math.min(done(), GOAL - 1)]
DAY.set(st.day), NIGHT.set(st.night), LITE.set(st.light)
function craft(k = 'torch') {
  const r = RECIPES[k]
  const e = Object.entries(r)
  const name = lib[k].vars.name.toLowerCase()
  if (!village.in) return say('Craft in a village')
  if (POTS.includes(k) && !player.room?.shop) return say('Buy it at the apothecary')
  if (!has(r)) return say(`A ${name} takes ${e.map(([m, n]) => n + ' ' + m).join(' and ')}: ${MATS[e.find(([m, n]) => !(own(m) >= n))[0]] || 'craft one'}`)
  for (const [m, n] of e) m == 'gold' ? earn(-n) : gain(m, -n)
  place(k)
  keep('warriorSlots', belt)
  gain(k, 1)
  if (POTS.includes(k)) learn('buy')
  if (k == 'torch') fuel = FUEL
  say(`+1 ${name}`)
}
function drink(k) {
  if (!bag[k]) return say('No potion: buy one at the apothecary')
  if (player.hp <= 0) return
  if (k == 'haste') (haste = HASTE.time), burst(player.pos, '#3dc', 14)
  else if (player.hp >= player.maxHp) return say('Already at full health')
  else (player.hp = Math.min(player.maxHp, player.hp + lib.health.potionHeal)), burst(player.pos, '#f45', 14)
  gain(k, -1)
  hud()
  beep(392, 0.4, 'triangle', 0.06, 2)
}
function setTorch() {
  if (!bag.sunstone) return say('A beacon needs a sunstone: ask the townsfolk where one sleeps')
  if (!bag.torch) return craft()
  beacon[well.k] = [player.dir, 1.2, 0]
  keep('warriorBeacons', beacon)
  lit = 0
  fuel = FUEL
  gain('torch', -1)
  gain('sunstone', -1)
  learn('set')
  delete felled.carry
  keep('warriorFelled', felled)
  equip(player.item)
  beep(200, 0.5, 'sawtooth', 0.05, 3)
  aim = well
  say(`${well.name}'s beacon burns · turn and tilt the beam onto the star · R lets go`)
}
// strike what's in front with the axe (or a ridden mount's attack: o, reach, arc): a rock breaks for good and spills
// what it held; a cave's boulder takes CAVE.hits blows, then shatters and opens the cave
function crack(o = player, reach = item.reach + 1, arc = 1.16) {
  const ahead = (p, r = 0) => Math.hypot(p.x - o.pos.x, p.z - o.pos.z) < reach + r && Math.cos(Math.atan2(p.x - o.pos.x, p.z - o.pos.z) - o.dir) > Math.cos(arc)
  for (const ch of chunks.values()) {
    for (const c of ch.caves)
      if (c.rock && ahead(c.rock.position, 1.1)) {
        const p = c.rock.position
        burst(p.clone().setY(p.y + 1), '#9a948a', 10)
        beep(70, 0.3, 'square', 0.08, 0.4)
        c.rock.rotation.z = (R() - 0.5) * 0.15 // it rocks
        learn('crack')
        if (--c.hp > 0) return say(`The boulder cracks · ${c.hp} more`)
        ch.mesh.remove(c.rock)
        c.rock = c.col[2] = 0
        ;(felled.caves ||= {})[c.T.k] = 9e15
        keep('warriorFelled', felled)
        burst(p, '#8a857c', 40)
        return say('The boulder shatters: the cave is open. Light your torch and go in')
      }
    for (const g of ch.rocks)
      if (!g.done && ahead(g.position)) {
        const p = g.position
        g.done = 1
        learn('rock')
        ch.mesh.remove(g) // it breaks up and is gone, and grows back after REGROW like a tree
        g.col[2] = 0
        ;(felled[ch.key] ||= {})[g.k] = Date.now()
        keep('warriorFelled', felled)
        burst(p, '#9a948a', 12)
        beep(110, 0.25, 'square', 0.06, 0.5)
        const [lo, hi] = ROCK.coins
        if (g.c) spill(g.c, g.c == 'gold' ? Math.round((lo + R() * (hi - lo)) * st.pay) : 1, p)
        return
      }
  }
}

// ---------- caves: in at an opened mouth with a lit torch; inside, a dark seeded maze, its sunstone at the far end ----------
// The maze is built at CAVE.depth under the entrance, so the world above carries on unseen: everyone in it stands on
// its floor and meets its walls only, and the surface's spawning, swimming, map, mounts and villages leave them be.
// rough rock, drawn once into a small tiling texture: a base colour mottled with lighter and darker flecks and a few
// cracks; walls, floor and roof each get their own shade
function rock(c) {
  const v = document.createElement('canvas')
  v.width = v.height = 64
  const g = v.getContext('2d')
  const k = new THREE.Color('#' + c)
  g.fillStyle = '#' + k.getHexString()
  g.fillRect(0, 0, 64, 64)
  g.globalAlpha = 0.25 // soft patches
  for (let i = 0; i < 40; i++) {
    g.fillStyle = '#' + k.clone().multiplyScalar(0.6 + R() * 0.8).getHexString()
    g.beginPath()
    g.arc(R() * 64, R() * 64, 3 + R() * 9, 0, 7)
    g.fill()
  }
  g.globalAlpha = 1 // grit
  for (let i = 0; i < 500; i++) {
    g.fillStyle = '#' + k.clone().multiplyScalar(0.7 + R() * 0.6).getHexString()
    g.fillRect(R() * 64, R() * 64, 1 + R() * 2, 1 + R() * 2)
  }
  g.strokeStyle = '#' + k.clone().multiplyScalar(0.45).getHexString()
  g.lineWidth = 0.6
  for (let i = 0; i < 6; i++) { // a few short hairline cracks
    let x = R() * 64
    let y = R() * 64
    g.beginPath()
    g.moveTo(x, y)
    for (let j = 0; j < 3; j++) g.lineTo((x += R() * 12 - 6), (y += R() * 10))
    g.stroke()
  }
  const t = new THREE.CanvasTexture(v)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return new THREE.MeshLambertMaterial({ map: t })
}
const caveRock = rock(CAVE.wallColor)
const caveFloor = rock(CAVE.floorColor)
const caveRoof = rock(CAVE.roofColor)
// the way out: the day (or a moonlit blue) beyond the mouth, unfogged so it shows from deep in, and a little of it spilling in
const mouthMat = new THREE.MeshBasicMaterial({ fog: false, vertexColors: true })
const daylit = new THREE.PointLight(0, 0, 12, 1)
scene.add(daylit)
// a box whose texture tiles every 2 units on each face, rather than stretching across it
function slab(w, h, d) {
  const b = new THREE.BoxGeometry(w, h, d)
  const uv = b.attributes.uv
  for (let i = 0; i < uv.count; i++) {
    const f = (i / 4) | 0 // faces: +x -x +y -y +z -z
    uv.setXY(i, (uv.getX(i) * (f < 2 ? d : w)) / 2, (uv.getY(i) * (f > 1 && f < 4 ? d : h)) / 2)
  }
  return b
}
// the sunstone taken (or, in an older save, its thunder egg cracked)
const got = (T) => {
  const p = den(T.gi, T.gj)
  return felled.gems?.[T.k] || (p && felled[Math.floor(p[0] / CH) + ',' + Math.floor(p[1] / CH)]?.['e' + T.k])
}
// walking into a ripe bush while hurt eats its berries; eaten ones grow back after BERRY.regrow seconds
function berry() {
  const p = player.pos
  const cx = Math.floor(p.x / CH)
  const cz = Math.floor(p.z / CH)
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const b of chunks.get(cx + i + ',' + (cz + j))?.berries || []) {
        if (b.eaten) {
          if (Date.now() - b.eaten > BERRY.regrow * 1e3) (b.eaten = 0), (dirty = true)
          continue
        }
        if (player.cave || player.hp <= 0 || player.hp >= player.maxHp || Math.hypot(b.x - p.x, b.z - p.z) > BERRY.reach) continue
        const n = Math.min(player.maxHp - player.hp, Math.ceil(player.maxHp * BERRY.heal))
        learn('berries')
        player.hp += n
        b.eaten = (felled[cx + i + ',' + (cz + j)] ||= {})['b' + b.i] = Date.now()
        keep('warriorFelled', felled)
        dirty = true
        burst({ x: b.x, y: p.y, z: b.z }, '#c2183a', 10)
        beep(880, 0.12, 'triangle', 0.04, 1.3)
        say(`Berries · +${n} health`)
        hud()
      }
}
let dark // said once per visit to a mouth without a lit torch
const lens = (fov, near) => ((camera.fov = fov), (camera.near = near), camera.updateProjectionMatrix())
function caves() {
  const p = player.pos
  const K = player.cave
  if (!K) {
    let c
    for (const ch of chunks.values()) for (const o of ch.caves) if (!o.rock && Math.hypot(p.x - o.mouth[0], p.z - o.mouth[1]) < 0.9) c = o
    if (!c || player.seat || player.swim || player.hp <= 0 || title) return c || (dark = 0)
    if (lit) return village.fade(() => enter(c))
    dark ||= say('Pitch dark in there: light your torch first') || 1
    return
  }
  if (p.z < K.z - CAVE.cell / 2 - 0.2) return village.fade(leave) // out through the mouth
  if (K.wake && $('say').hidden) (K.wake = 0), say('The cave wakes: everything left down here is coming for you') // once the sunstone box is closed
  const g = K.gem
  if (!g) return
  g.rotation.y += 0.03
  village.glow.intensity = 14 * (1 + Math.sin(clock.elapsedTime * 3) * 0.2)
  if (Math.hypot(p.x - g.position.x, p.z - g.position.z) > 1.4) return (K.said = 0)
  if (bag.sunstone) return K.said ||= say('You can carry only one sunstone: set yours in a well first') || 1 // no hoarding them to keep the world easy
  if (foes.some((e) => e.guard && e.hp > 0)) return K.said ||= say("The sunstone's guard must fall first") || 1
  K.g.remove(g)
  K.gem = 0
  K.wake = 1
  for (const e of foes) if (e.cave) e.hunt = 1 // taking it wakes the cave: every creature left, near or far, comes hunting you
  village.glow.intensity = 0
  ;(felled.gems ||= {})[K.c.T.k] = 9e15
  felled.carry = K.c.T.k // whose it is, so a fall can send it home
  keep('warriorFelled', felled)
  gain('sunstone', 1)
  sunstone()
}
// a cave's creatures stand on its floor and never respawn while you're down there (see spawn), only on your next visit
const KINDS3 = ['goblin', 'spider', 'slime']
const dweller = (kind, x, z) => Object.assign(foe(kind, x, z), { cave: player.cave, floor: CAVE.depth, fits: () => 1, wander: 9 })
// a perfect maze on a size x size grid (recursive backtracker, seeded by the village), the mouth at cell 0,0
function enter(c) {
  const n = CAVE.size
  const S = CAVE.cell
  const H = CAVE.wall
  const R = rng(c.T.seed + 77)
  const L = {} // 'i,j' -> 1 open to the east, 2 open to the south
  const vis = new Set(['0,0'])
  const path = [[0, 0]]
  while (path.length) {
    const [i, j] = path[path.length - 1]
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => i + a >= 0 && i + a < n && j + b >= 0 && j + b < n && !vis.has(i + a + ',' + (j + b)))
    if (!nb.length) {
      path.pop()
      continue
    }
    const [a, b] = nb[(R() * nb.length) | 0]
    const lo = a + b > 0 ? [i, j] : [i + a, j + b]
    L[lo] = (L[lo] || 0) | (a ? 1 : 2)
    vis.add(i + a + ',' + (j + b))
    path.push([i + a, j + b])
  }
  // the far end: the cell most steps from the mouth, and the way there (for the guardians)
  const from = { '0,0': null }
  const q = [[0, 0]]
  let end = [0, 0]
  while (q.length) {
    const [i, j] = (end = q.shift())
    for (const [a, b, open] of [[1, 0, L[[i, j]] & 1], [-1, 0, L[[i - 1, j]] & 1], [0, 1, L[[i, j]] & 2], [0, -1, L[[i, j - 1]] & 2]])
      if (open && !([i + a, j + b] in from)) (from[[i + a, j + b]] = [i, j]), q.push([i + a, j + b])
  }
  const X = c.x
  const Z = c.z
  const y = CAVE.depth
  const at = ([i, j]) => [X + i * S, Z + j * S]
  // walls: [x, z, half width, half depth]; none north of cell 0,0, the way out
  const walls = []
  for (let k = 0; k < n; k++) {
    walls.push([X - S / 2, Z + k * S, 0.3, S / 2 + 0.3])
    if (k) walls.push([X + k * S, Z - S / 2, S / 2 + 0.3, 0.3])
  }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (!(L[[i, j]] & 1)) walls.push([X + i * S + S / 2, Z + j * S, 0.3, S / 2 + 0.3])
      if (!(L[[i, j]] & 2)) walls.push([X + i * S, Z + j * S + S / 2, S / 2 + 0.3, 0.3])
    }
  const g = new THREE.Group()
  for (const [x, z, hw, hd] of walls) {
    const w = new THREE.Mesh(slab(hw * 2, H, hd * 2), caveRock)
    w.position.set(x, y + H / 2, z)
    g.add(w)
  }
  // floor and roof: one sheet each over the whole maze (and the way out), the roof face down
  for (const [m, up] of [[caveFloor, 0], [caveRoof, 1]]) {
    const q = new THREE.PlaneGeometry(n * S + 1, n * S + S).rotateX((up ? 90 : -90) * DEG)
    const uv = q.attributes.uv
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * n * S) / 2, (uv.getY(i) * n * S) / 2)
    const f = new THREE.Mesh(q, m)
    f.position.set(X + ((n - 1) * S) / 2, y + up * H, Z + ((n - 2) * S) / 2)
    g.add(f)
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3 * S, H, 1, 2), mouthMat) // sky down to the horizon, then the ground
  m.geometry.setAttribute('color', new THREE.Float32BufferAttribute([...Array(12).fill(1), 0.4, 0.6, 0.3, 0.4, 0.6, 0.3], 3))
  m.position.set(X, y + H / 2, Z - S)
  g.add(m)
  daylit.position.set(X, y + 1.5, Z - S / 2 - 0.5)
  scene.add(g)
  const K = (player.cave = { c, x: X, z: Z, y, walls, g, from, end })
  learn('goIn')
  for (const e of [...foes]) spawn(e) // the surface's creatures stay up there
  player.floor = y
  player.pos.set(X, y, Z - S / 2 + 0.6)
  player.vel.set(0, 0)
  player.dir = 0
  camYaw = Math.PI
  // the sunstone and its guardians, at the far end and on the way to it
  if (!got(c.T)) {
    const [ex, ez] = at(end)
    K.gem = new THREE.Mesh(geo('sunstone'), itemMat)
    K.gem.position.set(ex, y + 0.9, ez)
    K.gem.scale.setScalar(2)
    g.add(K.gem)
    village.glow.position.set(ex, y + 1.8, ez)
    // its guard, packed into the last two cells: CAVE.guards (+1 a locked beam) led by a boss goblin, all of whom
    // must fall before it can be taken
    const den2 = [end, from[end] || end]
    for (let k = 0; k <= CAVE.guards + done(); k++) {
      const [gx, gz] = at(den2[k % 2])
      const e = dweller(KINDS3[k ? k % 3 : (R() * 3) | 0], gx + R() * 3 - 1.5, gz + R() * 3 - 1.5)
      e.guard = 1
      if (!k) {
        // the boss: a great tinted one of the cave's kinds (picked by the cave's seed), much tougher, hits harder,
        // reaches further, and never shies from a torch
        e.boss = 1
        e.g.scale.setScalar(1.8)
        e.m.mat.color.set(['#c27aff', '#ff7a6a', '#7affc0'][(R() * 3) | 0])
        e.hp = e.maxHp *= 4
        e.dmg *= 2
        e.reach += 0.8
      }
    }
  }
  // and the rest of the maze has CAVE.roamers (+1 a locked beam) of its own, one to a cell, away from the mouth and the den
  const cells = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if ((i || j) && i + ',' + j != end + '' && i + ',' + j != from[end] + '') cells.push([i, j])
  for (let k = 0; k < CAVE.roamers + done() && cells.length; k++) {
    const [gx, gz] = at(cells.splice((R() * cells.length) | 0, 1)[0])
    dweller(KINDS3[k % 3], gx + R() * 2 - 1, gz + R() * 2 - 1)
  }
  hud()
}
function leave() {
  const K = player.cave
  const { mouth, ry } = K.c
  scene.remove(K.g)
  K.g.traverse((o) => o != K.gem && o.geometry?.dispose()) // (the sunstone's model is shared)
  player.cave = player.floor = null
  for (const e of [...foes]) e.cave && spawn(e) // the guardians stay down there; the surface fills up again
  village.glow.intensity = 0
  player.pos.set(mouth[0] + Math.sin(ry) * 7, 0, mouth[1] + Math.cos(ry) * 7) // a few steps out: clear of the mouth (or you'd walk straight back in), and the camera behind you clears the mound
  player.vel.set(0, 0)
  player.dir = ry
  camYaw = ry + Math.PI
  hud()
}
// underground, can a reach from (ax, az) to (bx, bz) get there, or is a wall in the way? (segment against each wall's box)
const clear = (ax, az, bx, bz) =>
  !player.cave?.walls.some(([cx, cz, hw, hd]) => {
    let t0 = 0
    let t1 = 1
    for (const [p, d, c, h] of [[ax, bx - ax, cx, hw], [az, bz - az, cz, hd]]) {
      if (!d) {
        if (Math.abs(p - c) > h) return false
        continue
      }
      const u = (c - h - p) / d
      const v = (c + h - p) / d
      t0 = Math.max(t0, Math.min(u, v))
      t1 = Math.min(t1, Math.max(u, v))
      if (t0 > t1) return false
    }
    return true
  })
// ---------- the hint line, by the tray, always on: what you can do right here (ride, talk, crack the boulder, set the
// sunstone...) or, with nothing at hand, the mission (models.json "hints" holds the words)
const HINT = lib.hints
const far = (o) => Math.hypot(o.x - player.pos.x, o.z - player.pos.z)
const within = (r, f) => [...chunks.values()].some((c) => f(c).some((o) => far(o.position || o) < r))
// the mission, from the save: [what to do, where (for the line's arrow), or nothing]. Until the first beam is on the
// star it goes step by step (find the cave, crack the boulder, go in with a lit torch, find the sunstone and beat its
// guard, take it out and back to the village's well, a torch, set them, aim); after that a cave is only named once
// you're near it (the sage tells the way)
function goal() {
  const p = player.pos
  const K = player.cave
  const T = sites(p.x, p.z, 2)
    .filter((t) => !beacon[t.k]?.[2])
    .sort((a, b) => far(a) - far(b))[0]
  if (done() >= GOAL) return []
  for (const k in beacon) if (!beacon[k][2]) return [HINT.aim.replace('$', siteAt(k).name), top(siteAt(k))]
  if (K) return K.gem ? [foes.some((e) => e.guard && e.hp > 0) && far(K.gem.position) < 12 ? HINT.guard : HINT.find, route(K, K.end)] : [HINT.leave, route(K)]
  if (bag.sunstone) return [bag.torch ? HINT.well.replace('$', T?.name) : HINT.torchFirst, T && top(T)]
  const V = sites(p.x, p.z, 2)
    .filter((t) => den(t.gi, t.gj) && !got(t))
    .sort((a, b) => far(a) - far(b))[0]
  if (!V) return [HINT.explore]
  const [x, z] = den(V.gi, V.gj)
  const ry = Math.atan2(V.x - x, V.z - z)
  const at = { x: x + Math.sin(ry) * 1.5, z: z + Math.cos(ry) * 1.5 }
  const d = far(at)
  if (done() && d > 60) return [HINT.sage.replace('$', V.name)]
  if (!felled.caves?.[V.k]) return [d > 12 ? HINT.findCave.replace('$', V.name) : HINT.boulder, at]
  return [lit ? HINT.goIn : bag.torch ? HINT.light : HINT.torchCave, at]
}
// underground the arrow follows the maze: the doorway to the next cell on the way out (from the mouth cell, out of
// it), or with `e`, on the way to that cell (up toward the mouth until on its path, then down it; in it, the sunstone)
function route(K, e) {
  const S = CAVE.cell
  const c = [Math.round((player.pos.x - K.x) / S), Math.round((player.pos.z - K.z) / S)]
  let n = K.from[c] || [0, -1]
  if (e + '' == c) return K.gem.position
  for (let t = e; t; t = K.from[t]) if (K.from[t] + '' == c) n = t
  return { x: K.x + ((c[0] + n[0]) * S) / 2, z: K.z + ((c[1] + n[1]) * S) / 2 }
}
// a move once made (rode, talked, cracked the boulder...) retires its prompt for good
const learned = kept('warriorLearned', {})
function learn(k) {
  if (!learned[k]) (learned[k] = 1), keep('warriorLearned', learned)
}
// what you can do right where you stand, if you haven't yet: [the move, its words]
function act() {
  const axe = ITEMS[player.item] == 'axe'
  const b = well && beacon[well.k]
  const m = !village.in && nearMount()
  const c = !player.cave && [...chunks.values()].flatMap((c) => c.caves).find((c) => (c.rock ? far(c.rock.position) : far({ x: c.mouth[0], z: c.mouth[1] })) < 4)
  if (player.seat || aim) return []
  return (
    [
      player.room?.shop && ['buy', HINT.buy.replace('$', wares())],
      well && b && !b[2] && ['aimHere', HINT.aimHere],
      well && !b && bag.sunstone && ['set', bag.torch ? HINT.set : HINT.torchFirst],
      village.chat && ['talk', HINT.talk],
      m && ['ride', HINT.ride.replace('$', m.m.vars.name)],
      c && (c.rock ? ['crack', axe ? HINT.crack : HINT.crackAxe] : ['goIn', lit ? HINT.goIn : HINT.lightUp]),
      player.hp < player.maxHp && within(4, (c) => c.berries.filter((b) => !b.eaten)) && ['berries', HINT.berries],
      within(2.5, (c) => c.rocks.filter((r) => !r.done)) && ['rock', axe ? HINT.rock : HINT.rockAxe],
    ].find((h) => h && !learned[h[0]]) || []
  )
}
let hintT = 0
let way = null // where the mission's arrow points
const look = new THREE.Vector3()
function hinting(dt) {
  if ((hintT -= dt) < 0) {
    hintT = 0.25
    const live = !title && player.hp > 0
    const [, a] = live ? act() : []
    const [g = '', at] = live ? goal() : []
    $('hx').textContent = a || g
    $('hint').className = a ? 'act' : ''
    way = !a && g && at
  }
  // the arrow turns to point the way, relative to where the camera looks (up the screen is straight ahead)
  $('way').style.visibility = way ? '' : 'hidden'
  if (way) {
    camera.getWorldDirection(look)
    $('way').style.transform = `rotate(${Math.atan2(look.x, look.z) - Math.atan2(way.x - player.pos.x, way.z - player.pos.z)}rad)`
  }
}
blockers.push((x, z, w) => {
  if (!w.cave) return [x, z]
  for (const [cx, cz, hw, hd] of player.cave?.walls || []) {
    const ax = hw + 0.35 - Math.abs(x - cx)
    const az = hd + 0.35 - Math.abs(z - cz)
    if (ax > 0 && az > 0) ax < az ? (x = cx + Math.sign(x - cx) * (hw + 0.35)) : (z = cz + Math.sign(z - cz) * (hd + 0.35))
  }
  return [x, z]
})
// holding the beam: turn and tilt it
function aiming(dt, ix, iz) {
  const b = beacon[aim.k]
  b[0] -= ix * dt * 0.6 + drag * 0.3
  b[1] = Math.min(1.5, Math.max(0.1, b[1] + iz * dt * 0.4 + tilt * 0.3)) // W/S, a touch drag or the locked mouse up and down
  player.dir = b[0] // the warrior, and so the minimap, face the way the beam points
  player.move(0, 0, dt)
  player.speed = 0
  if (dir(b).angleTo(STAR) > LOCK) return
  onStar(b)
  learn('aimHere')
  keep('warriorBeacons', beacon)
  const n = done()
  for (let i = 0; i < (n < GOAL ? 4 : 8); i++) setTimeout(() => beep(523 * 1.26 ** (i % 4) * (i > 3 ? 2 : 1), 0.6, 'triangle', 0.06, 1), i * 130)
  burst(top(aim), '#fd4', 24)
  say(`${aim.name}'s beam meets the star · ✦ ${n}/${GOAL}`)
  if (n == GOAL) show = 0.01
  else (st = STAGES[n]), setTimeout(() => say(st.say), 2600)
  aim = null
  hud()
}
function shine(dt) {
  const p = player.pos
  const c = camera.position
  const t = clock.elapsedTime
  if (aim || show) {
    // the camera stands behind the sunstone and looks along the beam; in the show, it looks up at the star
    const o = aim ? top(aim) : p.clone().setY(p.y + 3)
    aim ? dir(beacon[aim.k]) : ray.copy(STAR)
    camera.position.lerp(o.clone().addScaledVector(ray, -6).setY(o.y + 1), Math.min(1, dt * 4))
    camera.lookAt(o.addScaledVector(ray, 60))
  }
  star.position.copy(c).addScaledVector(STAR, 150)
  star.visible = !player.cave // underground there's no sky: no eye and no beams, which would cut through the cave walls
  star.scale.setScalar((2.5 + (1 - day) * 1) * (1 + Math.min(show, 3)) * (1 + Math.sin(t * 5) * 0.1))
  star.rotation.y = t
  for (const k in beacon) {
    let o = beams.get(k)
    if (!o) beams.set(k, (o = { T: siteAt(k), mesh: new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })) })), scene.add(o.mesh)
    const { T, mesh } = o
    const b = beacon[k]
    const base = top(T)
    const d = base.distanceTo(c)
    const s = Math.min(1, 12 / d)
    const w = s * Math.max(1, d / 80) * (1 + Math.min(show, 2) * 0.4 * (1 + Math.sin(t * 8))) // far beams fattened to stay visible
    mesh.position.copy(c).lerp(base, s)
    // a locked beam runs to the eye itself, so its tip sits on it from anywhere (the eye is drawn a fixed way off the
    // camera, so a beam merely parallel to it ends beside it); a free one runs 400 along its aim, out past the camera's range
    b[2] ? ray.copy(star.position).sub(mesh.position) : dir(b).multiplyScalar(400)
    mesh.scale.set(w, ray.length(), w)
    mesh.quaternion.setFromUnitVectors(UP, ray.normalize())
    // white until it snaps onto the eye, gold once locked: gold always means locked
    mesh.material.color.setHSL(show ? (t * 0.4 + d * 0.002) % 1 : 0.13, b[2], 0.85 - b[2] * 0.3)
    mesh.material.opacity = b[2] ? 0.7 : 0.45
    mesh.visible = !player.cave
    if (d < 150 && !o.m) scene.add((o.m = make(lib, 'beacon')).root)
    if (d > 170 && o.m) scene.remove(o.m.root), o.m.root.traverse((g) => g.geometry?.dispose()), o.m.mat.dispose(), (o.m = null)
    if (o.m) {
      pose(o.m, [['idle', t, 1]]) // (resets the root too)
      o.m.root.position.set(T.x, T.y + 2.45, T.z)
      o.m.root.updateMatrixWorld()
      o.m.bones.stone.rotation.y = t * 2 // the sunstone turns over the fire
    }
  }
  // the well you stand at, and what it wants
  const T = village.in && !player.room && sites(p.x, p.z).find((t) => Math.hypot(p.x - t.x, p.z - t.z) < 3.5)
  if (well && !T && beacon[well.k] && !beacon[well.k][2]) say(`${well.name}'s beam is not on the star yet: come back and aim it`) // a lit but unaimed beam doesn't count
  well = T || null
  if (!well) aim = null
  if (show) {
    show += dt
    sky.setHSL((t * 0.1) % 1, 0.7, 0.2 + day * 0.3)
    scene.fog.color.copy(sky)
    if (R() < dt * 14) burst(ray.copy(STAR).multiplyScalar(16).add(c).add({ x: R() * 16 - 8, y: R() * 8 - 4, z: R() * 16 - 8 }), new THREE.Color().setHSL(R(), 1, 0.6), 14) // fireworks round the star
    if (show > 4 && show - dt <= 4) {
      const e = document.createElement('div')
      e.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;text-align:center;font-size:20px;line-height:2;background:#0007;text-shadow:0 2px 4px #000'
      e.innerHTML = `<b style="font-size:40px;color:#fd4">✦ The eye is pinned ✦</b>The night goes blind<br>${Object.keys(beacon).filter((k) => beacon[k][2]).map((k) => siteAt(k).name).join(' · ')}<br>${gold} gold · ${player.kills} kills · ${Math.hypot(p.x - home.x, p.z - home.z) | 0} m from where you began<small style="opacity:.7">tap to wander on</small>`
      e.onpointerdown = () => e.remove()
      document.body.append(e)
    }
    if (show > 14) show = 0
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
// a voice: a smooth (sine) note gliding through [seconds, Hz] points, starting `at` seconds from now; vib is
// [rate, depth in Hz] and hiss mixes in breath (noise through a band that follows the note)
function voice(pts, vol, { vib = [0, 0], hiss = 0, at = 0 } = {}) {
  const ac = audio.ac
  if (!ac || audio.muted) return
  try {
    const t = ac.currentTime + at
    const end = t + pts.at(-1)[0]
    const o = ac.createOscillator()
    const g = ac.createGain()
    const lfo = (rate, depth, param) => {
      const l = ac.createOscillator()
      const d = ac.createGain()
      l.frequency.value = rate
      d.gain.value = depth
      l.connect(d).connect(param)
      l.start(t)
      l.stop(end)
    }
    const glide = (p) => pts.map(([s, f], i) => (i ? p.exponentialRampToValueAtTime(f, t + s) : p.setValueAtTime(f, t)))
    glide(o.frequency)
    if (vib[0]) lfo(...vib, o.frequency)
    if (hiss) {
      const n = ac.createBufferSource()
      const b = (n.buffer = ac.createBuffer(1, ((end - t) * ac.sampleRate) | 0, ac.sampleRate)).getChannelData(0)
      for (let i = 0; i < b.length; i++) b[i] = Math.random() * 2 - 1
      const f = ac.createBiquadFilter()
      const h = ac.createGain()
      f.type = 'bandpass'
      f.Q.value = 3
      glide(f.frequency)
      h.gain.value = hiss
      n.connect(f).connect(h).connect(g)
      n.start(t)
    }
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03)
    g.gain.setValueAtTime(vol, t + (end - t) * 0.6)
    g.gain.exponentialRampToValueAtTime(0.0001, end)
    o.connect(g).connect(audio.out)
    o.start(t)
    o.stop(end)
  } catch {}
}
// a splash: half a second of fading noise through a falling low-pass
function splash(vol = 0.3) {
  const ac = audio.ac
  if (!ac || audio.muted) return
  try {
    const n = (ac.sampleRate * 0.5) | 0
    const buf = ac.createBuffer(1, n, ac.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3
    const s = ac.createBufferSource()
    const f = ac.createBiquadFilter()
    const g = ac.createGain()
    s.buffer = buf
    f.frequency.setValueAtTime(2500, ac.currentTime)
    f.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.5)
    g.gain.value = vol
    s.connect(f).connect(g).connect(audio.out)
    s.start()
  } catch {}
}

// ---------- input: keyboard + touch ----------
const keys = {}
let camYaw = 45 * DEG
addEventListener('keydown', (e) => {
  keys[e.code] = 1
  if (e.code == 'Escape' && !$('inv').hidden) pack()
  if (!$('say').hidden) return ['Space', 'KeyJ', 'Escape', 'Enter'].includes(e.code) && ($('say').hidden = true)
  if (e.code == 'Space' || e.code == 'KeyJ') attack()
  if (e.code == 'KeyF' || e.code == 'Tab') equip(player.item + 1, 1)
  if (e.code.startsWith('Digit')) slot(e.code == 'Digit0' ? belt.length : e.code < 'Digit9' ? e.code[5] - 1 : -1) // 1-8 the tray, 0 crafting
  if (e.code == 'Tab') e.preventDefault()
  if (e.code == 'KeyM') $('mute').onclick()
  if (e.code == 'KeyN' || (e.code == 'Escape' && !$('big').hidden)) bigMap()
  if (e.code == 'KeyR') mountUp()
  if (e.code == 'KeyC') first = !first // the chase camera or first person
})
const chase = 1 // (tank controls always; the old free camera is gone)
// first person: C on the surface, always in a cave (never in a house's room). Click to lock the pointer (in the
// chase camera too); then the mouse or trackpad turns you (in first person up-down also tilts the view) and a click
// attacks. Esc lets go.
let first = 0
let pitch = 0
const free = () => !player.room && !title // the mouse can look (not in a house's fixed cutaway room)
const fpNow = () => (first || player.cave) && free()
let drag = 0 // turning from the locked mouse, in radians, used up each frame
let tilt = 0 // and up and down, for tilting a beam
// look with the locked pointer, or by dragging with the button held where the browser won't lock it
addEventListener('pointermove', (e) => (document.pointerLockElement || (e.buttons && e.pointerType == 'mouse' && free())) && ((drag += e.movementX * 0.0025), (pitch = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * 0.0025))), (tilt += e.movementY * 0.0025)))
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (document.pointerLockElement) return attack()
  if (free() && e.pointerType == 'mouse') renderer.domElement.requestPointerLock()
})
addEventListener('keyup', (e) => (keys[e.code] = 0))
const stick = { id: null, x: 0, y: 0, ox: 0, oy: 0 }
addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (!$('say').hidden) $('say').hidden = true
    else if (t.target.id == 'swap') equip(player.item + 1, 1)
    else if (t.target.id == 'hit') attack()
    else if (t.target.id == 'mnt') mountUp()
    else if (t.target.id == 'mute' || t.target.closest('#tray,#nav,#big,#inv')) continue
    else if (stick.id == null) Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 })
  }
  $('pad').style.display = 'block'
  document.body.className = 't'
  $('help').textContent = 'Drag: up/down to walk, sideways to turn'
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
  if (player.seat) return buck()
  if (player.room?.shop) return craft('potion')
  if (well && !beacon[well.k]?.[2] && (beacon[well.k] || bag.sunstone || !village?.chat)) return beacon[well.k] ? (aim = well) : setTorch() // at a well, Space lights or takes the beam
  if (village?.chat) return village.speak()
  const k = ITEMS[player.item]
  if (POTS.includes(k)) return drink(k)
  if (k == 'whistle') return whistle()
  if (player.lift) return player.busy || player.hp <= 0 || toss(k)
  if (player.busy || player.hp <= 0 || village?.in || player.swim) return
  player.play(item.anim)
  player.struck = false
  // chase mode: the swing turns toward the nearest monster in front, so you needn't line up exactly
  let best = 4
  let to = player.dir
  if (chase && !fpNow()) // (in first person you aim yourself)
    for (const e of foes) {
      const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z)
      const t = Math.atan2(e.pos.x - player.pos.x, e.pos.z - player.pos.z)
      const a = t - player.dir
      if (e.hp > 0 && d < best && Math.cos(a) > 0.55) {
        best = d
        to = t
      }
    }
  player.dir = to
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
    if (foes.includes(e)) {
      player.kills++
      loot(e)
      beep(330, 0.3, 'square', 0.05, 0.3)
    } else {
      beep(110, 0.8, 'sawtooth', 0.08, 0.3) // falling costs no gold (it used to take a tenth of the purse)
    }
  } else {
    if (!((e == player || e == player.seat) && e.busy)) e.play('hit') // a hit doesn't cancel the player's swing or mount's attack
    beep(e == player ? 140 : 520, 0.12, 'square', 0.05, 0.5)
  }
  hud()
}

// the big map (N), north-up and zoomed to the trail; see-through while flying, which keeps going under it
function bigDraw() {
  const c = $('big')
  if (c.width != innerWidth || c.height != innerHeight) (c.width = innerWidth), (c.height = innerHeight) // resizing clears and reallocates it
  const W = c.width
  const H = c.height
  // everything explored, you, the start and the guides' hints, all on one screen, centred on the lot
  const { x, z } = player.pos
  let [x0, z0, x1, z1] = box.map((v) => v * CH)
  for (const [a, b] of [[x, z], [home.x, home.z], ...hint]) (x0 = Math.min(x0, a)), (z0 = Math.min(z0, b)), (x1 = Math.max(x1, a)), (z1 = Math.max(z1, b))
  const mx = (x0 + x1) / 2
  const mz = (z0 + z1) / 2
  const k = Math.min(4, (0.45 * UPP) / Math.max((x1 - x0) / 2 / W, (z1 - z0) / 2 / H, 1e-3))
  const u = k / UPP
  c.style.opacity = player.seat?.alt ? 0.8 : 1
  marks(bigc, (x - mx) * u + W / 2, (z - mz) * u + H / 2, 0, k, Math.min(W, H) / 2 - 12, chart(bigc, W, H, k, mx, mz), 1e9, W / 2, H / 2)
}

// ---------- main loop ----------
const clock = new THREE.Clock()
const near = { slime: 0, goblin: 0, spider: 0, bat: 0 } // how present each monster kind is, for the music
const fwd = new THREE.Vector3()
let inRoom = false
let wasFp = false
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const open = !$('big').hidden
  if (open && !player.seat?.alt) return bigDraw(), requestAnimationFrame(frame) // paused, unless flying
  if (!$('say').hidden) return requestAnimationFrame(frame)
  const tank = (chase || player.cave) && !player.room // a house's room keeps its fixed cutaway camera and screen-relative moves; a cave is always steered like this
  const fps = fpNow()
  // first person: a wide (90 degree), close lens, and the head and the left arm and shield hidden so they don't fill
  // the view (the weapon arm stays, so swings show)
  if (fps != wasFp) (wasFp = fps), (pitch = 0), lens(fps ? 90 : 45, fps ? 0.05 : 0.5), (player.m.bones.armL.visible = player.m.bones.head.visible = !fps)
  if (!free() && document.pointerLockElement) document.exitPointerLock()

  // riding: A/D turn (on foot they strafe), W/S walk along the facing, or, in free mode, move relative to the camera
  // in first person the arrows look instead: left/right turn (a mount too), up/down tilt the view
  const arr = !fps || aim
  let ix = (keys.KeyD || (arr && keys.ArrowRight) ? 1 : 0) - (keys.KeyA || (arr && keys.ArrowLeft) ? 1 : 0) + stick.x
  let iz = (keys.KeyS || (arr && keys.ArrowDown) ? 1 : 0) - (keys.KeyW || (arr && keys.ArrowUp) ? 1 : 0) + stick.y
  if (!arr) (drag += ((keys.ArrowRight | 0) - (keys.ArrowLeft | 0)) * 2.2 * dt), (pitch = Math.max(-1.3, Math.min(1.3, pitch + ((keys.ArrowUp | 0) - (keys.ArrowDown | 0)) * 1.5 * dt)))
  const il = Math.hypot(ix, iz)
  const alive = player.hp > 0
  const run = 6 * (haste > 0 ? HASTE.speed : 1) // a speed potion quickens him on foot and swimming
  if (aim) aiming(dt, ix, iz)
  else if (player.seat) {
    steer(dt, ix, iz, il)
    player.dir = player.seat.dir
  } else if (tank && alive) {
    // on foot A/D strafe and the arrows, the (locked) mouse or a touch drag turn (in first person a touch drag strafes)
    const sx = (keys.KeyD | 0) - (keys.KeyA | 0)
    player.dir -= (fps ? 0 : (ix - sx) * 2.8 * dt) + drag
    const f = Math.max(-1, Math.min(1, -iz)) * (iz > 0 ? 0.6 : 1) // backing up is slower
    const r = fps ? -ix : -sx
    const k = run * (player.busy ? 0.5 : 1) * (player.swim ? 0.55 : 1)
    const c = Math.cos(player.dir)
    const s = Math.sin(player.dir)
    player.move((f * s + r * c) * k * dt, (f * c - r * s) * k * dt, dt)
    player.speed = Math.hypot(f, r) * k
  } else if (il > 0.1 && alive) {
    ix /= Math.max(1, il)
    iz /= Math.max(1, il)
    const c = Math.cos(camYaw)
    const s = Math.sin(camYaw)
    const dx = ix * c + iz * s
    const dz = -ix * s + iz * c
    const slow = (player.busy ? 0.5 : 1) * (player.swim ? 0.55 : 1)
    player.move(dx * run * slow * dt, dz * run * slow * dt, dt)
    player.dir = Math.atan2(dx, dz)
    player.speed = run * Math.min(1, il) * slow * wade(player)
  } else {
    player.move(0, 0, dt)
    player.speed = 0
  }
  // swimming: deep water sinks the warrior to his shoulders, stows the weapon and costs breath
  const deep = height(player.pos.x, player.pos.z) < SWIM && !player.room && !player.cave && !player.seat
  if (deep != !!player.swim) {
    if (deep && lit) (lit = 0), say('The water put out your torch')
    player.swim = deep ? 1.25 : 0
    player.once = null // no swing carries into (or out of) the water
    village.stow(deep)
    splash(deep ? 0.35 : 0.15)
    ripple(player.pos, 1.6)
    if (deep) burst({ x: player.pos.x, y: WATER - 0.4, z: player.pos.z }, '#cfe8ff', 14)
    hud()
  }
  if (player.swim && player.speed && (player.wake = (player.wake || 0) + dt) > 0.45) (player.wake = 0), ripple(player.pos, 0.8)
  // breath: 25 s of swimming, refilled in 4 s on land; out of breath costs 1 hp every 2 s
  player.air = Math.min(1, Math.max(0, player.air + (player.swim ? -dt / 25 : dt / 4)))
  if (player.swim && !player.air && alive && (player.choke = (player.choke || 0) + dt) > 2) {
    player.choke = 0
    hurt(player, 1, player.pos, 0)
  }
  $('air').style.width = player.air * 100 + '%'
  $('airbar').style.opacity = player.air < 1 ? 1 : 0
  // the blow lands partway through the swing
  if (player.once && player.once[0] == item.anim && !player.struck && player.once[1] > player.m.clips[item.anim].d * 0.45) {
    player.struck = true
    const fire = item.burn && lit
    if (fire) burst(torchLight.position, '#fa3', 10)
    for (const e of [...foes, ...mounts.filter((m) => !m.rider)]) {
      if (e.hp <= 0) continue
      const dx = e.pos.x - player.pos.x
      const dz = e.pos.z - player.pos.z
      const d = Math.hypot(dx, dz)
      let a = Math.atan2(dx, dz) - player.dir
      a = Math.atan2(Math.sin(a), Math.cos(a))
      if (d < item.reach + e.m.root.scale.x * 0.4 && Math.abs(a) < 1.2 && clear(player.pos.x, player.pos.z, e.pos.x, e.pos.z)) {
        hurt(e, item.dmg + (fire ? 2 : 0), player.pos, item.push)
        if (fire) e.burn = item.burn
      }
    }
    if (item.chop && !player.cave) chop(), crack()
  }
  herd(dt)
  fells(dt)
  player.update(dt, run)
  player.safe -= dt
  // a torch that burns out is spent: one fewer in the bag, and the next one starts fresh
  if (lit && (fuel -= dt) <= 0) (lit = 0), (fuel = FUEL), gain('torch', -1), torch(), say(bag.torch ? 'Your torch burnt out: take another (3)' : 'Your torch burnt out: craft a new one (a wood and a flint)')
  $('fuel').style.width = (fuel / FUEL) * 100 + '%'
  $('fuelbar').style.opacity = lit ? 1 : 0
  haste -= dt
  $('haste').style.width = (haste / HASTE.time) * 100 + '%'
  $('hastebar').style.opacity = haste > 0 ? 1 : 0
  if (!alive && (player.dead += dt) > 3) {
    // fall with a sunstone and it's lost: it goes back to its cave, guard and all, to be won again
    if (bag.sunstone) gain('sunstone', -bag.sunstone), delete felled.gems?.[felled.carry], delete felled.carry, keep('warriorFelled', felled), setTimeout(() => say('You fell, and the sunstone went back to its cave'), 1500) // (after the well's own tip at home)
    player.hp = player.maxHp
    player.air = 1
    player.once = null
    if (player.cave) leave() // a fall underground wakes you at home, the cave left behind
    if (player.seat) unseat(player) // and off whatever you rode (a roc flies away)
    player.pos.copy(bed)
    hud()
  }
  // health comes back fast in a village, barely at all outside (models.json "health", hp a second)
  if (alive && player.hp < player.maxHp && !player.swim) {
    player.regen = (player.regen || 0) + dt * lib.health[village.in ? 'townRegen' : 'fieldRegen']
    if (player.regen > 1) {
      player.regen = 0
      player.hp++
      hud()
    }
  }

  // monsters: wander, chase, attack, die, respawn
  if (!player.cave && foes.length < crowd() && R() < dt) spawn()
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
    // habitat: eels only go for someone in the water; bats tire after 4 s over water and fly back to the last shore;
    // a land creature whose way to the player is water paces the shore, then loses interest for a while
    const wet = height(player.pos.x, player.pos.z) < WATER
    if (e.kind == 'bat') {
      if (height(e.pos.x, e.pos.z) < WATER) e.wet = (e.wet || 0) + dt
      else (e.wet = 0), (e.shore = [e.pos.x, e.pos.z])
    }
    e.bored = (e.bored || 0) - dt
    const barred = d > 0.5 && !e.fits(height(e.pos.x + (dx / d) * 0.8, e.pos.z + (dz / d) * 0.8))
    if (e.wet > 4 && e.shore) {
      tx = e.shore[0] - e.pos.x
      tz = e.shore[1] - e.pos.z
      const l = Math.hypot(tx, tz) || 1
      e.dir = Math.atan2(tx, tz)
      tx /= l
      tz /= l
      sp = e.run * 0.7
    } else if (alive && (e.hunt || d < (lit && e.kind == 'bat' ? 24 : 12) * st.sight * e.fierce * (bag.sunstone ? 2 : 1)) && (!village.in || (st.bold && !player.room)) && !(e.burn > 0 && e.kind != 'slime') && e.bored <= 0 && (e.kind != 'eel' || wet)) {
      // slimes and spiders shy from a lit torch, circling its edge, but dare a rush every few seconds
      if (!st.bold && !e.boss && !e.hunt && !bag.sunstone && lit && d < 7 && (e.kind == 'slime' || e.kind == 'spider') && (e.dare = (e.dare || 0) + dt) % 7 < 5) {
        const k = d < 5 ? -1 : 0
        tx = (dx / d) * k + (dz / d) * 0.7
        tz = (dz / d) * k - (dx / d) * 0.7
        sp = e.run * 0.6
      } else if (barred && d > e.reach) {
        // pace up and down the shore, glaring
        const p = Math.sin(e.time * 1.7) * 0.6
        tx = (dz / d) * p
        tz = (-dx / d) * p
        sp = e.run * 0.5
        if ((e.balk = (e.balk || 0) + dt) > 3 + R() * 2) (e.balk = 0), (e.bored = 5 + R() * 4), (e.wander = 0)
      } else if (d > e.reach) {
        tx = dx / d
        tz = dz / d
        sp = e.run
      } else if (e.cool <= 0 && !e.busy) {
        e.play('attack')
        e.cool = ((1.8 + R() * 1.5) * st.cool) / e.fierce
        e.striking = true
      }
      e.dir = Math.atan2(dx, dz)
    } else {
      // wander, or flee while burning
      e.wander -= dt
      if (e.wander < 0) {
        e.wander = 2 + R() * 3
        e.wa = R() < 0.4 ? null : R() * 7
        if (e.bored > 0) e.wa = Math.atan2(-dx, -dz) + R() - 0.5 // wander off, away from the water's edge
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
    if (e.stuck) e.wander = 0 // walked into the wrong medium: pick another way next frame
    if (e.swim) {
      e.burn = 0 // water puts out a burning eel
      if (sp && R() < dt * 1.5) ripple(e.pos, 0.6)
    }
    if (e.striking && e.once && e.once[0] == 'attack' && e.once[1] > e.m.clips.attack.d * 0.5) {
      e.striking = false
      if (d < e.reach + 0.6 && alive && !village.in && (e.kind != 'eel' || wet) && !(player.seat?.alt > 3) && clear(e.pos.x, e.pos.z, player.pos.x, player.pos.z)) hurt(player.seat || player, e.dmg, e.pos, 5) // a rider's mount takes the blow; no blow lands through a cave wall, or through the fence (monsters never get inside)
    }
    e.update(dt, e.run)
  }

  pickups(dt)
  caves()
  berry()
  hinting(dt)
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
  for (const r of [...ripples]) {
    r.life -= dt
    r.scale.setScalar(r.size * (1.6 - r.life))
    r.material.opacity = r.life * 0.7
    if (r.life <= 0) {
      scene.remove(r)
      r.material.dispose()
      ripples.splice(ripples.indexOf(r), 1)
    }
  }

  // torch light follows the flame, flickering
  const flame = lit && player.m.props.handR?.bones.flame
  const t = clock.elapsedTime
  if (flame) {
    flame.getWorldPosition(torchLight.position)
    torchLight.intensity = (4 + 26 * (1 - day)) * (1 + Math.sin(t * 21) * 0.1 + Math.sin(t * 37) * 0.07)
  } else if (!player.seat) torchLight.intensity = 0

  // day and night: a 3-minute cycle, starting mid-morning. A full night is near-black but for a faint blue moon:
  // the fog closes in and turns black, so only torches, fires, windows, eyes and coins show beyond arm's reach.
  day = Math.min(1, Math.max(0, Math.cos((t - morn) / 30 + 0.6) * 0.8 + 0.6)) * dawn
  dawn += ((title ? 0.15 : 1) - dawn) * Math.min(1, dt / 2)
  for (const [c, k] of [[DAY, 'day'], [NIGHT, 'night'], [LITE, 'light']]) c.lerp(hue.set(st[k]), Math.min(1, dt / 2)) // a new stage fades in
  sky.lerpColors(NIGHT, DAY, day)
  scene.fog.color.copy(sky)
  const fly = player.seat?.alt || 0 // the fog draws back as you climb
  scene.fog.near = 6 + day * 34 + fly
  scene.fog.far = 40 + day * 70 + fly * 1.5
  sun.color.lerpColors(MOON, SUN, day).multiply(LITE)
  hemi.color.set('#dfefff').multiply(LITE)
  sun.intensity = 0.2 + 2.2 * day
  hemi.intensity = 0.03 + day * 1.27
  mouthMat.color.lerpColors(MOON, DAY, day).multiplyScalar(0.3 + day * 1.5) // a glare by day, a dim blue by night
  daylit.color.copy(mouthMat.color)
  daylit.intensity = player.cave ? 6 : 0
  // underground: no sun, no sky, only your torch (and the sunstone's glow); the dark closes in fast
  if (player.cave) (day = 0), (sun.intensity = 0), (hemi.intensity = 0.05), sky.setRGB(0, 0, 0), scene.fog.color.setRGB(0, 0, 0), (scene.fog.near = 3), (scene.fog.far = 18)

  // music: each monster kind within 14 units brings in its own part (fast in, slow out); night darkens the rest
  const close = {}
  for (const e of foes) if (e.hp > 0 && alive && Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z) < 14) close[e.kind] = 1
  for (const k in near) near[k] += ((close[k] || 0) - near[k]) * Math.min(1, dt * (close[k] ? 2 : 0.5))
  audio.mood(day, near)

  // camera: a high three-quarter view that trails the player, pulled back while riding; in chase mode it swings
  // round behind the facing (lagging a little), sits lower, looks a step ahead, and rises over higher ground behind
  const target = player.pos
  const back = player.seat ? 1.35 + player.seat.alt / 15 : 1 * (camera.aspect < 1 ? 1.3 : 1) // and on a tall phone screen
  const snap = clock.elapsedTime < 0.2 || inRoom != !!player.room
  inRoom = !!player.room
  drag = tilt = 0
  if (tank) {
    let a = player.dir + Math.PI - camYaw
    camYaw += Math.atan2(Math.sin(a), Math.cos(a)) * (snap ? 1 : Math.min(1, dt * 4))
    fwd.set(Math.sin(camYaw) * 7 * back, 0, Math.cos(camYaw) * 7 * back).add(target)
    fwd.y = Math.max(target.y + 4.8 * back, height(fwd.x, fwd.z) + 1.5, WATER + 0.6)
  } else fwd.set(Math.sin(camYaw) * 7 * back, 7.5 * back, Math.cos(camYaw) * 7 * back).add(target)
  if (title) {
    const r = 30 / Math.min(1, camera.aspect)
    camera.position.set(W.x + Math.sin(t / 9) * r, W.y + 4, W.z + Math.cos(t / 9) * r)
    camera.lookAt(W.x, W.y + 7, W.z)
    word.position.set(W.x, W.y + 8, W.z).lerp(camera.position, 0.1)
    word.lookAt(camera.position)
    word.rotateY(Math.sin(t / 2) * 0.4)
    fire.children.map((f, i) => (f.scale.y = (5 + i * 0.7) * (0.8 + 0.3 * Math.sin(t * (9 + i) + i * 7))))
    fire.rotation.y = t * 3
    burst(W, new THREE.Color().setHSL(R() * 0.1, 1, 0.55), 2)
    bits.slice(-2).map((b) => b.v.multiply({ x: 0.5, y: 2.4, z: 0.5 }))
    torchLight.position.copy(word.position).lerp(camera.position, 0.15).y -= 3
    torchLight.intensity = 90 * (1 + Math.sin(t * 21) * 0.1 + Math.sin(t * 37) * 0.07)
  } else if (fps && !aim && !show) {
    // first person: just in front of the warrior's face, following his head (he's still drawn, so his arms and
    // weapon swing into view), looking along his facing, tilted by pitch
    // riding, it rides out in front of the mount's head instead (so the neck and head don't fill the view, and a
    // drake's breath flames out below and ahead)
    const fx = Math.sin(player.dir)
    const fz = Math.cos(player.dir)
    const m = player.seat
    const k = m ? m.m.root.scale.x * m.g.scale.x : 0
    ;(m ? m.m.bones.head : player.m.bones.head).getWorldPosition(camera.position)
    camera.position.x += fx * (m ? 1.1 * k : 0.3)
    camera.position.z += fz * (m ? 1.1 * k : 0.3)
    camera.position.y += m ? 0.35 * k : 0
    // underground the camera itself keeps clear of the walls (the body stops 0.35 short, the face reaches further)
    for (const [cx, cz, hw, hd] of player.cave?.walls || []) {
      const ax = hw + 0.2 - Math.abs(camera.position.x - cx)
      const az = hd + 0.2 - Math.abs(camera.position.z - cz)
      if (ax > 0 && az > 0) ax < az ? (camera.position.x = cx + Math.sign(camera.position.x - cx) * (hw + 0.2)) : (camera.position.z = cz + Math.sign(camera.position.z - cz) * (hd + 0.2))
    }
    camera.lookAt(camera.position.x + fx * Math.cos(pitch), camera.position.y + Math.sin(pitch), camera.position.z + fz * Math.cos(pitch))
  } else if (!aim && !show) {
    // (holding a beacon's beam, or in the light show, shine() runs the camera)
    camera.position.lerp(fwd, snap ? 1 : Math.min(1, dt * (tank ? 8 : 5)))
    if (tank) camera.lookAt(target.x - Math.sin(camYaw) * 3, target.y + 0.8, target.z - Math.cos(camYaw) * 3)
    else camera.lookAt(target.x, target.y + 1, target.z)
  }
  sun.position.set(target.x + 20, target.y + 40, target.z + 10)
  sun.target.position.copy(target)
  shine(dt)

  stream(target.x, target.z)
  minimap()
  village.update(dt)
  bars(dt)
  if (open) bigDraw()
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
const word = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 1.2), new THREE.MeshLambertMaterial({ emissive: '#310', fog: false }), 999)
const fire = new THREE.Group()
for (let i = 0; i < 12; i++) {
  const f = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1, 5).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i * 0.011, 1, 0.5), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
  f.position.set(Math.sin(i * 2.4) * (2 - i * 0.15), 0, Math.cos(i * 2.4) * (2 - i * 0.15))
  fire.add(f)
}
fire.position.set(W.x, W.y + 3, W.z)
scene.add(fire)
{
  const c = document.createElement('canvas').getContext('2d')
  c.font = '900 13px serif'
  c.fillText('WELLFIRE', 0, 12)
  const d = c.getImageData(0, 0, 80, 14).data
  let n = 0
  for (let y = 0; y < 14; y++) for (let x = 0; x < 80; x++) if (d[(y * 80 + x) * 4 + 3] > 99) word.setMatrixAt(n, new THREE.Matrix4().makeTranslation(x * 0.3 - 11, 2 - y * 0.3, 0)), word.setColorAt(n++, new THREE.Color().setHSL(0.15 - y * 0.011, 1, 0.55))
  word.count = n
  word.position.set(W.x, W.y + 8, W.z)
  scene.add(word)
}
let dawn = 0.15
let morn = 0
let title = 1
const hide = (o) => ['ui', 'nav', 'tray', 'help', 'mute'].map((k) => ($(k).style.opacity = o))
hide(0)
$('tip').textContent = 'press any key or tap to begin'
document.body.insertAdjacentHTML('beforeend', '<small style="position:fixed;right:6px;bottom:3px;opacity:.5;font:10px system-ui">BUILD_ID</small>') // the build fills in its version and commit, to tell a cached page from the latest
$('tip').style.opacity = 1
for (const ev of ['keydown', 'pointerdown'])
  addEventListener(
    ev,
    (e) => {
      if (!title) return
      title = 0
      morn = clock.elapsedTime
      scene.remove(word, fire)
      hide('')
      $('tip').style.opacity = ''
      audio.start()
      e.stopImmediatePropagation()
      if (!done()) say(`Set torches in ${GOAL} villages' beacons and aim them at the star ✦`)
    },
    true,
  )
hud()
frame()

window.game = { player, foes, mounts, addMount, seat, mountUp, equip, attack, clock, audio, village, scene, camera, renderer, spawn, world: { SEED, WATER, SWIM, chunks, seen, tiles, terrain, height, depth, region, grow, drop, site, sites, links, road, home } } // for play-testing from the console
Object.defineProperty(window.game, 'gold', { get: () => gold, set: (v) => earn(v - gold), enumerable: true })
window.game.drops = drops
Object.assign(window.game, { bag, felled, falling, beacon, STAR, craft, aim: () => aim, well: () => well })

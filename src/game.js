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
const wade = (a) => (a.swim ? 1 : 1 - Math.min(0.45, depth(a.pos.x, a.pos.z) * 0.4)) // wading slows you, up to about half speed
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
// localStorage, wrapped: private windows and blocked storage just start fresh
const kept = (k, d) => {
  try {
    return JSON.parse(localStorage[k]) || d
  } catch {
    return d
  }
}
const keep = (k, v) => {
  try {
    localStorage[k] = JSON.stringify(v)
  } catch {}
}
// felled trees: chunk key -> { candidate index: when it fell }. A tree regrows after REGROW; old entries are pruned
// on load, so the record stays small however far you roam.
const REGROW = 30 * 60e3
const felled = kept('warriorFelled', {})
for (const k in felled) {
  for (const i in felled[k]) if (Date.now() - felled[k][i] > REGROW) delete felled[k][i]
  if (!Object.keys(felled[k]).length) delete felled[k]
}
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
  }
  chunks.set(key, { cx, cz, mesh, inst, trees })
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
    const w = wade(this)
    let x = this.pos.x + dx * w + this.vel.x * dt
    let z = this.pos.z + dz * w + this.vel.y * dt
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
    const k = this.seat || this.boat ? 0 : Math.min(1, this.speed / run)
    const layers = this.swim && this.m.clips.swim
      ? [['swim', this.time * (0.6 + k * 0.6), 1]]
      : [
          ['idle', this.time, 1 - k],
          ['walk', this.time * Math.max(0.6, k), k],
        ]
    if (this.seat || this.boat) layers.push(['ride', 0, 1]) // sitting on a mount (see mounts) or in the boat
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
  $('info').textContent = player.hp > 0 ? `${village?.in ? village.name + ' · weapon stowed' : player.boat ? 'rowing' : player.swim ? 'swimming · weapon stowed' : item ? item.name : ''}${lit ? ` · torch ${Math.ceil((fuel / FUEL) * 100)}%` : ''} · ${player.kills} kills` : `You fell after ${player.kills} kills…`
}
// the tray: the weapons, then every kind of goods (wood now; potions or loot later add a GOODS entry and a use).
// Number keys or a tap pick a slot: a weapon is equipped, goods are used. The bag is kept in localStorage.
const ICON = { sword: '🗡️', axe: '🪓', torch: '🔥', wood: '🪵' }
const GOODS = { wood: () => launch() }
const bag = kept('warriorBag', { wood: 0 })
function tray() {
  $('tray').innerHTML = [...ITEMS, ...Object.keys(GOODS)]
    .map((k, i) => `<b data-s=${i} class=${i == player.item ? 'on' : k in bag && !bag[k] ? 'off' : ''}>${ICON[k]}<i>${i + 1}</i>${k in GOODS ? `<u>${bag[k] || 0}</u>` : ''}</b>`)
    .join('')
}
function slot(i) {
  if (i < ITEMS.length) equip(i)
  else GOODS[Object.keys(GOODS)[i - ITEMS.length]]?.()
}
function gain(k, n) {
  bag[k] = (bag[k] || 0) + n
  keep('warriorBag', bag)
  tray()
  $('tray').children[ITEMS.length + Object.keys(GOODS).indexOf(k)].animate([{ transform: 'scale(1.4)' }, { transform: 'none' }], 300)
}
const say = (t) => (($('tip').textContent = t), $('tip').animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], 2500))
$('tray').onpointerdown = (e) => {
  const b = e.target.closest('b')
  if (b) slot(+b.dataset.s)
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
      const g = slope(x, z)
      // relief: ground colour (rock and snow already mark the heights), a little brighter higher up, and hillshade
      // lit from the north-west; water darkens with depth
      if (h < WATER) sea(tc, WATER - h)
      else ground(tc, x, z, h, g).multiplyScalar(Math.min(1.35, Math.max(0.5, 0.9 + h * 0.005 + (g[0] + g[1]) * 0.4)) * (region(x, z) == 1 ? 0.75 : 1)) // forest: darker
      if (h >= WATER && road(x, z)[0] < RW + 1) tc.set('#e0b070') // roads stand out on the map
      if (h >= WATER && inTown(x, z)) tc.set('#d8c49a')
      t.ctx.fillStyle = '#' + tc.getHexString(THREE.LinearSRGBColorSpace) // no sRGB lift: keeps the map's contrast
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
  // villages whose centre you've seen: a ring on the map, the name upright beside it
  const towns = sites(x, z, 2).filter((t) => seen.has(Math.floor(t.x / CELL) + ',' + Math.floor(t.z / CELL)))
  flat.strokeStyle = '#6b4a2a'
  flat.lineWidth = 2
  for (const t of towns) {
    flat.beginPath()
    flat.arc(sx(t.x), sz(t.z), t.r / UPP, 0, 7)
    flat.stroke()
  }
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
  const c = Math.cos(camYaw)
  const s = Math.sin(camYaw)
  for (const t of towns) {
    const dx = (t.x - x) / UPP
    const dz = (t.z - z) / UPP
    mapc.fillText(t.name, MAP / 2 + dx * c - dz * s, MAP / 2 + dx * s + dz * c - t.r / UPP - 3)
  }
  mapc.fillText('N', MAP / 2 + Math.sin(camYaw) * 68, MAP / 2 - Math.cos(camYaw) * 68 + 4) // north, on the rim
  $('pos').textContent = `${REGIONS[region(x, z)]} · ${x | 0}, ${z | 0} · ${Math.hypot(x - home.x, z - home.z) | 0} m from start`
}

// ---------- player ----------
const player = new Actor('warrior', 1)
player.hp = player.maxHp = 30
player.pos.copy(home)
player.item = 0
player.kills = 0
player.air = 1
let item
// The torch lights the night (T or LIGHT). It burns in the right hand when it's the weapon (a fire swing: +2 damage
// and the burn), else in the left hand in place of the shield, so the sword or axe can fight in its light. Unlit,
// the torch weapon is a weak club. A torch burns for FUEL seconds; relighting a spent one costs a wood. Water douses it.
const FUEL = 150
let lit = 0
let fuel = FUEL
function torch() {
  const w = ITEMS[player.item] == 'torch' && player.m.props.handR
  hold(lib, player.m, 'handL', lit && !w ? 'torch' : 'shield')
  for (const b in player.m.props) if (player.m.props[b].bones.flame) player.m.props[b].bones.flame.visible = b != 'back' && lit > 0
  hud()
}
function light() {
  if (player.swim || player.hp <= 0) return
  if (!lit && fuel <= 0) {
    if (!bag.wood) return say('Your torch is spent: relighting it takes a wood')
    gain('wood', -1)
    fuel = FUEL
  }
  lit ^= 1
  beep(lit ? 200 : 90, 0.25, 'sawtooth', 0.03, lit ? 2 : 0.4)
  torch()
}
function equip(i) {
  player.item = (i + ITEMS.length) % ITEMS.length
  const p = hold(lib, player.m, 'handR', ITEMS[player.item])
  item = p.vars
  if (village?.in || player.seat || player.swim || player.boat) village.stow(1)
  torch()
  tray()
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
  m.wander = m.flee = m.cool = m.jolt = 0
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
    village.stow(1)
    if (tamed != m) gone.add(m.home)
    tamed = m
    m.flee = m.jolt = 0
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
const nearMount = () => mounts.find((m) => !m.rider && m.hp > 0 && Math.hypot(m.pos.x - player.pos.x, m.pos.z - player.pos.z) < 2.2 + m.m.root.scale.x)
function mountUp() {
  if (player.boat) return ashore()
  if (player.seat) return unseat(player)
  if (nearBoat()) return board()
  const m = player.hp > 0 && !village.in && nearMount()
  if (m) seat(player, m)
  hud()
}
// the attack button while riding: the mount's own attack, with damage, reach and cooldown from its model vars
function buck() {
  const m = player.seat
  if (m.busy || m.cool > 0) return
  m.play('attack')
  m.cool = m.m.vars.cool
  m.striking = true
  beep(m.m.vars.burn ? 90 : 150, 0.3, 'sawtooth', 0.05, 0.5)
}
// riding: turn toward the stick at the mount's turn rate, run along its facing, with a little momentum
function steer(dt, ix, iz, il) {
  const m = player.seat
  const v = m.m.vars
  let sp = 0
  if (chase) {
    m.dir -= ix * v.turn * 0.8 * dt + drag
    sp = -iz * v.run * (iz > 0 ? 0.3 : 1) * (m.busy ? 0.4 : 1) // reins: turn on the spot, back up slowly
  } else if (il > 0.1) {
    const c = Math.cos(camYaw)
    const s = Math.sin(camYaw)
    let a = Math.atan2(ix * c + iz * s, -ix * s + iz * c) - m.dir
    a = Math.atan2(Math.sin(a), Math.cos(a))
    m.dir += Math.max(-v.turn * dt, Math.min(v.turn * dt, a))
    sp = v.run * Math.min(1, il) * Math.max(0.3, 1 - Math.abs(a) / 2.5) * (m.busy ? 0.4 : 1)
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
    if (m != tamed && !m.rider && !chunks.has(Math.floor(m.pos.x / CH) + ',' + Math.floor(m.pos.z / CH))) {
      dropMount(m)
      continue
    }
    if (m.rider == player) {
      // steered in steer(); the blow lands partway through the attack clip
      if (m.striking && m.once?.[0] == 'attack' && m.once[1] > m.m.clips.attack.d * v.at) {
        m.striking = false
        if (v.burn) breathe(m)
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
  // HUD: the mount's name and health while riding, or a prompt beside a free one
  const t = player.seat || (player.hp > 0 && !village.in && nearMount())
  $('rider').hidden = !t
  if (t) {
    $('mbar').hidden = !player.seat
    $('mhp').style.width = (Math.max(0, t.hp) / t.maxHp) * 100 + '%'
    $('mname').textContent = player.seat ? `${t.m.vars.name} the ${t.m.vars.kind} · R to get off` : `R · ride ${t.m.vars.name} the ${t.m.vars.kind}`
  }
}

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
    if (inTown(x, z, 4)) continue
    if (h < SWIM - 0.5) kind = eels < 4 ? 'eel' : null
    else if (h > WATER + 0.3) {
      const mix = FOES[region(x, z)]
      kind = mix[(R() * mix.length) | 0]
    }
  }
  if (!kind) return
  const e = new Actor(kind, seedNext++)
  e.pos.set(x, 0, z)
  e.fits = HABITAT[kind] || onLand
  if (kind == 'eel') e.swim = 0.1
  const s = e.m.root.scale.x
  e.hp = e.maxHp = Math.round({ slime: 5, goblin: 8, spider: 7, bat: 4, eel: 6 }[kind] * (0.6 + s * 0.6))
  e.run = { slime: 3, goblin: 4.2, spider: 5, bat: 4.5, eel: 4.8 }[kind]
  e.dmg = { slime: 1, goblin: 2, spider: 2, bat: 1, eel: 1 }[kind]
  e.reach = 1.2 + s * 0.4
  e.wander = 0
  e.cool = 1
  foes.push(e)
  if (kind == 'goblin' && R() < 0.2) seat(e, addMount(MOUNTS[region(x, z)], seedNext++, x, z)) // a goblin rider
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
      v.folk.push(f)
      parts.push(f.m)
    }
    return v
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
    const dx = x - T.x
    const dz = z - T.z
    d = Math.hypot(dx, dz) || 1
    let r = Math.max(d, 1.5) // the well
    if (who.town == v) r = Math.min(r, T.r - 1) // townsfolk stay in
    else if (who == player && !v.gap(Math.atan2(dz, dx)) && Math.abs(d - T.r) < 0.45) r = d < T.r ? T.r - 0.45 : T.r + 0.45 // the fence
    return r == d ? [x, z] : [T.x + (dx / d) * r, T.z + (dz / d) * r]
  }
  blockers.push((x, z, who) => {
    const h = who.room
    if (h) {
      const gap = Math.abs(x - h.x) < 0.8
      x = Math.max(h.x - h.rw / 2 + 0.35, Math.min(h.x + h.rw / 2 - 0.35, x))
      z = Math.max(h.z - h.rd / 2 + 0.7, Math.min(h.z + h.rd / 2 - (gap ? 0.1 : 0.45), z))
      ;[x, z] = box(x, z, h.x - h.rw / 2 + 0.8, h.z - h.rd / 2 + 1.3, 0.95, 1.4) // bed
      ;[x, z] = box(x, z, h.x + h.rw / 2 - 1.6, h.z + 0.2, 1.1, 1.3) // table and stools
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
        for (let i = 0; i < a.count; i++) if (v3.fromBufferAttribute(a, i).applyMatrix4(M).length() > far.length()) far.copy(v3)
      })
      turn.quaternion.setFromUnitVectors(far.normalize(), v3.set(0, 0, p.vars.burn ? -1 : 1))
    }
    if (on) hold(lib, player.m, 'handR', null), torch()
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
    built,
    stow,
    in: false,
    name: '',
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
      this.in = player.hp > 0 && !!here
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
        glow.intensity = 0
        scene.background = sky
        if (here) hemi.intensity = Math.max(hemi.intensity, 0.4) // lamplight: a village needs no torch
        for (const o of here?.houses || []) {
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
        for (const v of built.values())
          for (const o of v.houses) {
            const t = Math.min(1, Math.max(0, ((o.x - ax) * bx + (o.z - az) * bz) / (bx * bx + bz * bz)))
            const hide = t < 0.98 && Math.hypot(ax + bx * t - o.x, az + bz * t - o.z) < Math.max(o.w, o.d) / 2 + 0.6
            o.m.mat.opacity += ((hide ? 0.25 : 1) - o.m.mat.opacity) * Math.min(1, dt * 8)
          }
      }
      for (const v of built.values())
        for (const f of v.folk) {
          const dx = f.goal[0] - f.pos.x
          const dz = f.goal[1] - f.pos.z
          const d = Math.hypot(dx, dz)
          f.speed = 0
          if ((f.wait -= dt) > 0) f.move(0, 0, dt)
          else if (d < 0.6) {
            f.wait = 2 + v.VR() * 5
            f.goal = v.spots[(v.VR() * v.spots.length) | 0]
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

// ---------- gold: a kill spills coins that bounce, sit spinning, and drift to the player when close ----------
// A kill pays its kind's "gold" var (models.json) x its size x a seeded roll x up to 1.6 at night x its region.
const PAY = [1, 1.2, 1.4, 1.1] // per region: meadow, forest, rocky hills, lakes
const coins = []
const coinGeo = bake(make(lib, 'coin', 1))
const coinMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: '#5a3c00' })
function loot(e) {
  const roll = hash(e.seed, player.kills, SEED + 5)
  const g = Math.max(1, Math.round(e.m.vars.gold * (0.6 + e.m.root.scale.x * 0.6) * (0.7 + roll * 0.6) * (1 + (1 - day) * 0.6) * PAY[region(e.pos.x, e.pos.z)]))
  const n = Math.min(g, 6)
  for (let i = 0; i < n; i++) {
    const c = new THREE.Mesh(coinGeo, coinMat)
    const a = R() * 7
    const s = 1.5 + R() * 2.5
    c.castShadow = true
    c.position.set(e.pos.x, e.pos.y + 0.6, e.pos.z)
    c.rotation.y = a
    c.v = new THREE.Vector3(Math.cos(a) * s, 4 + R() * 3, Math.sin(a) * s)
    c.worth = Math.floor(g / n) + (i < g % n)
    c.age = 0
    scene.add(c)
    coins.push(c)
  }
}
function earn(n) {
  gold = Math.max(0, gold + n)
  try {
    localStorage.warriorGold = gold
  } catch {}
  hud()
  $('gold').animate([{ transform: 'scale(1.6)', color: n < 0 ? '#f55' : '#fff' }, { transform: 'scale(1)' }], n < 0 ? 900 : 250)
}
function pickups(dt) {
  const p = player.pos
  coinMat.emissive.setRGB(0.35, 0.24, 0).multiplyScalar(0.7 + Math.sin(clock.elapsedTime * 4) * 0.3) // a soft glow pulse
  for (const c of [...coins]) {
    const q = c.position
    const dx = p.x - q.x
    const dy = p.y + 0.8 - q.y
    const dz = p.z - q.z
    const wet = q.y < WATER
    const d = player.swim && wet ? Math.hypot(dx, dz) || 0.01 : Math.hypot(dx, dy, dz) // a swimmer dives for sunk coins at any depth
    c.age += dt
    if (player.hp > 0 && d < 3.5 && c.age > 0.5) {
      // magnet: faster the closer it gets
      const sp = Math.min(d, (5 + (3.5 - d) * 5) * dt) / d
      q.x += dx * sp
      q.y += dy * sp
      q.z += dz * sp
      if (d < 0.6) {
        earn(c.worth)
        beep(1568, 0.06, 'square', 0.03, 1) // ching
        setTimeout(() => beep(2093, 0.3, 'triangle', 0.05, 0.98), 60)
        burst(q.clone().setY(q.y - 0.6), '#fd4', 5)
        c.age = 99
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
    c.visible = c.age < 40 || (c.age * 8) & 1 // blink before it goes
    if (c.age > 45 || !chunks.has(Math.floor(q.x / CH) + ',' + Math.floor(q.z / CH))) {
      scene.remove(c)
      coins.splice(coins.indexOf(c), 1)
    }
  }
}

// ---------- wood: the axe (its "chop" var) fells pines and oaks for the tray ----------
// A struck tree leaves its InstancedMesh for a mesh of its own that shakes; three chops and it falls away from you,
// pays 3 wood and sinks. Its chunk key and candidate index go in `felled`, so grow() skips it until it regrows.
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
        gain('wood', 3)
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

// ---------- boat: built from BOAT wood at a shore, rowed across water, left where you get out ----------
// In the boat you sit and row (tank steering, about half walking speed, with glide) and cannot attack. Land
// monsters can't reach you and eels can't bite through the hull; bats still can. There is one boat: building
// another moves it. Its place is kept in localStorage.
const BOAT = 10
let boat
const afloat = (h) => h < WATER - 0.3
// the nearest point 1.8-4.2 units from (x, z) whose ground passes `ok`, searching out from straight ahead
function spot(x, z, dir, ok) {
  for (let i = 0; i < 36; i++) {
    const j = i % 9
    const a = dir + ((j + 1) >> 1) * (j & 1 ? 0.45 : -0.45)
    const d = 1.8 + ((i / 9) | 0) * 0.8
    const sx = x + Math.sin(a) * d
    const sz = z + Math.cos(a) * d
    if (ok(height(sx, sz))) return [sx, sz, a]
  }
}
function dock(x, z, dir) {
  if (!boat) {
    boat = make(lib, 'boat', 1)
    scene.add((boat.g = new THREE.Group()).add(boat.root)) // pose() resets the model's root, so it rides in a group
    boat.v = boat.time = 0
  }
  boat.g.position.set(x, WATER, z)
  boat.g.rotation.y = dir
  keep('warriorBoat', [x, z, dir])
}
const docked = kept('warriorBoat')
if (docked) dock(...docked)
addEventListener('pagehide', () => boat && keep('warriorBoat', [boat.g.position.x, boat.g.position.z, boat.g.rotation.y]))
function launch() {
  if (player.boat || player.seat || village.in || player.hp <= 0) return
  if (bag.wood < BOAT) return say(`A boat takes ${BOAT} wood`)
  const s = spot(player.pos.x, player.pos.z, player.dir, afloat)
  if (!s) return say('Stand at the water to launch a boat')
  gain('wood', -BOAT)
  dock(...s)
  splash(0.3)
  ripple(boat.g.position, 2)
  beep(392, 0.12, 'triangle', 0.06, 1)
  setTimeout(() => beep(523, 0.25, 'triangle', 0.06, 1), 120)
}
const nearBoat = () => boat && !player.boat && player.hp > 0 && !village.in && Math.hypot(boat.g.position.x - player.pos.x, boat.g.position.z - player.pos.z) < 4.5 // the launch spot can be 4.2 out
function board() {
  player.boat = 1
  player.once = null
  village.stow(1)
  boat.v = 0
  hud()
}
function ashore() {
  const b = boat.g.position
  const s = spot(b.x, b.z, player.dir, onLand)
  if (!s) return say('Row to a shore to get out')
  player.boat = player.floor = null
  player.pos.set(s[0], 0, s[1])
  village.stow(0)
  dock(b.x, b.z, boat.g.rotation.y)
  hud()
}
function row(dt, ix, iz) {
  const b = boat.g
  b.rotation.y -= ix * 1.4 * dt + drag
  boat.v += (-iz * (iz > 0 ? 1.2 : 3) - boat.v) * Math.min(1, dt * 1.5)
  const x = b.position.x + Math.sin(b.rotation.y) * boat.v * dt
  const z = b.position.z + Math.cos(b.rotation.y) * boat.v * dt
  if (afloat(height(x, z))) b.position.set(x, b.position.y, z)
  else boat.v = 0 // aground
  if (Math.abs(boat.v) > 0.5 && R() < dt * 2) ripple(b.position, 0.9)
  player.dir = b.rotation.y
  player.speed = 0
}
// every frame: the boat bobs and rolls, the oars pull while it moves, the rider sits on the thwart
function boating(dt) {
  if (!boat) return
  const b = boat.g
  b.position.y = WATER - 0.03 + Math.sin(clock.elapsedTime * 2) * 0.04 // the floor (top 0.1) stays above the water
  b.rotation.z = Math.sin(clock.elapsedTime * 1.3) * 0.04
  pose(boat, [['row', (boat.time += dt * Math.abs(boat.v) * 0.5), 1]])
  if (player.boat) {
    player.pos.set(b.position.x, 0, b.position.z)
    player.floor = b.position.y + 0.3 - player.m.bones.hip.position.y * player.m.root.scale.y
  }
  if (!player.seat && (player.boat || nearBoat())) {
    $('rider').hidden = 0
    $('mbar').hidden = 1
    $('mname').textContent = player.boat ? 'R · get out at a shore' : 'R · board the boat'
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
  if (e.code == 'Space' || e.code == 'KeyJ') attack()
  if (e.code == 'KeyF' || e.code == 'Tab') equip(player.item + 1)
  if (e.code.startsWith('Digit')) slot(+e.code[5] - 1)
  if (e.code == 'KeyB') launch()
  if (e.code == 'KeyT') light()
  if (e.code == 'Tab') e.preventDefault()
  if (e.code == 'KeyM') $('mute').onclick()
  if (e.code == 'KeyR') mountUp()
  if (e.code == 'KeyC') chase = !chase // chase camera (tank controls) or the old free camera
})
let chase = 1
let drag = 0 // mouse-drag turning, in radians, used up each frame
addEventListener('pointermove', (e) => e.buttons && e.pointerType == 'mouse' && (drag += e.movementX * 0.006))
addEventListener('keyup', (e) => (keys[e.code] = 0))
const stick = { id: null, x: 0, y: 0, ox: 0, oy: 0 }
addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (t.target.id == 'swap') equip(player.item + 1)
    else if (t.target.id == 'hit') attack()
    else if (t.target.id == 'mnt') mountUp()
    else if (t.target.id == 'lit') light()
    else if (t.target.id == 'mute' || t.target.closest('#tray')) continue
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
  if (player.busy || player.hp <= 0 || village?.in || player.swim || player.boat) return
  player.play(item.anim)
  player.struck = false
  // chase mode: the swing turns toward the nearest monster in front, so you needn't line up exactly
  let best = 4
  let to = player.dir
  if (chase)
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
      beep(110, 0.8, 'sawtooth', 0.08, 0.3)
      if (e == player) earn(-Math.floor(gold * 0.1)) // falling costs a tenth of your purse (a mount's fall doesn't)
    }
  } else {
    if (!((e == player || e == player.seat) && e.busy)) e.play('hit') // a hit doesn't cancel the player's swing or mount's attack
    beep(e == player ? 140 : 520, 0.12, 'square', 0.05, 0.5)
  }
  hud()
}

// ---------- main loop ----------
const clock = new THREE.Clock()
const near = { slime: 0, goblin: 0, spider: 0, bat: 0 } // how present each monster kind is, for the music
const fwd = new THREE.Vector3()
let inRoom = false
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const tank = chase && !player.room // a house's room keeps its fixed cutaway camera and screen-relative moves
  const q = (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0)
  if (!tank) camYaw += q * dt * 2

  // on foot or riding: A/D turn and W/S walk along the facing (Q/E strafe), or, in free mode, move relative to the camera
  let ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + stick.x
  let iz = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0) + stick.y
  const il = Math.hypot(ix, iz)
  const alive = player.hp > 0
  const run = 6
  if (player.boat) row(dt, ix, iz)
  else if (player.seat) {
    steer(dt, ix, iz, il)
    player.dir = player.seat.dir
  } else if (tank && alive) {
    player.dir -= ix * 2.8 * dt + drag
    const f = Math.max(-1, Math.min(1, -iz)) * (iz > 0 ? 0.6 : 1) // backing up is slower
    const r = q * 0.8
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
  const deep = height(player.pos.x, player.pos.z) < SWIM && !player.room && !player.seat && !player.boat
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
      if (d < item.reach + e.m.root.scale.x * 0.4 && Math.abs(a) < 1.2) {
        hurt(e, item.dmg + (fire ? 2 : 0), player.pos, item.push)
        if (fire) e.burn = item.burn
      }
    }
    if (item.chop) chop()
  }
  herd(dt)
  boating(dt)
  fells(dt)
  player.update(dt, run)
  player.safe -= dt
  if (lit && (fuel -= dt) <= 0) (lit = 0), torch(), say('Your torch burnt out')
  if (lit && (fuel | 0) != ((fuel + dt) | 0)) hud()
  if (!alive && (player.dead += dt) > 3) {
    player.hp = player.maxHp
    player.air = 1
    player.once = null
    player.pos.copy(home)
    if (player.boat) (player.boat = player.floor = null), village.stow(0)
    hud()
  }
  if (alive && player.hp < player.maxHp && !player.swim) {
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
    } else if (alive && d < (lit && e.kind == 'bat' ? 24 : 12) && !village.in && !(e.burn > 0 && e.kind != 'slime') && e.bored <= 0 && (e.kind != 'eel' || wet)) {
      // slimes and spiders shy from a lit torch, circling its edge, but dare a rush every few seconds
      if (lit && d < 7 && (e.kind == 'slime' || e.kind == 'spider') && (e.dare = (e.dare || 0) + dt) % 7 < 5) {
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
      if (d < e.reach + 0.6 && alive && (e.kind != 'eel' || wet) && (e.kind == 'bat' || !player.boat)) hurt(player.seat || player, e.dmg, e.pos, 5) // a rider's mount takes the blow
    }
    e.update(dt, e.run)
  }

  pickups(dt)
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
  const flame = lit && (player.m.props.handR?.bones.flame || player.m.props.handL?.bones.flame)
  const t = clock.elapsedTime
  if (flame) {
    flame.getWorldPosition(torchLight.position)
    torchLight.intensity = (4 + 26 * (1 - day)) * (1 + Math.sin(t * 21) * 0.1 + Math.sin(t * 37) * 0.07)
  } else if (!player.seat) torchLight.intensity = 0

  // day and night: a 3-minute cycle, starting mid-morning. A full night is near-black but for a faint blue moon:
  // the fog closes in and turns black, so only torches, fires, windows, eyes and coins show beyond arm's reach.
  day = Math.min(1, Math.max(0, Math.cos(t / 30 + 0.6) * 0.8 + 0.6))
  sky.lerpColors(NIGHT, DAY, day)
  scene.fog.color.copy(sky)
  scene.fog.near = 6 + day * 34
  scene.fog.far = 40 + day * 70
  sun.color.lerpColors(MOON, SUN, day)
  sun.intensity = 0.2 + 2.2 * day
  hemi.intensity = 0.03 + day * 1.27

  // music: each monster kind within 14 units brings in its own part (fast in, slow out); night darkens the rest
  const close = {}
  for (const e of foes) if (e.hp > 0 && alive && Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z) < 14) close[e.kind] = 1
  for (const k in near) near[k] += ((close[k] || 0) - near[k]) * Math.min(1, dt * (close[k] ? 2 : 0.5))
  audio.mood(day, near)

  // camera: a high three-quarter view that trails the player, pulled back while riding; in chase mode it swings
  // round behind the facing (lagging a little), sits lower, looks a step ahead, and rises over higher ground behind
  const target = player.pos
  const back = (player.seat ? 1.35 : 1) * (camera.aspect < 1 ? 1.3 : 1) // and on a tall phone screen
  const snap = clock.elapsedTime < 0.2 || inRoom != !!player.room
  inRoom = !!player.room
  drag = 0
  if (tank) {
    let a = player.dir + Math.PI - camYaw
    camYaw += Math.atan2(Math.sin(a), Math.cos(a)) * (snap ? 1 : Math.min(1, dt * 4))
    fwd.set(Math.sin(camYaw) * 7 * back, 0, Math.cos(camYaw) * 7 * back).add(target)
    fwd.y = Math.max(target.y + 4.8 * back, height(fwd.x, fwd.z) + 1.5, WATER + 0.6)
  } else fwd.set(Math.sin(camYaw) * 7 * back, 7.5 * back, Math.cos(camYaw) * 7 * back).add(target)
  camera.position.lerp(fwd, snap ? 1 : Math.min(1, dt * (tank ? 8 : 5)))
  if (tank) camera.lookAt(target.x - Math.sin(camYaw) * 3, target.y + 0.8, target.z - Math.cos(camYaw) * 3)
  else camera.lookAt(target.x, target.y + 1, target.z)
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

window.game = { player, foes, mounts, addMount, seat, mountUp, equip, attack, clock, audio, village, scene, camera, renderer, spawn, world: { SEED, WATER, SWIM, chunks, seen, tiles, terrain, height, depth, region, grow, drop, site, sites, links, road, home } } // for play-testing from the console
Object.defineProperty(window.game, 'gold', { get: () => gold, set: (v) => earn(v - gold), enumerable: true })
window.game.coins = coins
Object.assign(window.game, { bag, felled, falling, launch, board, ashore, boat: () => boat })

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// The model language compiler ("JIT"): model text in, three.js rigs out.
// The game shipped this before moving to JSON models (src/compiler.js); kept as the baseline for tools/formats.mjs.
// Its language reference is the "model language" section of README.md as of commit dd58400.

export const DEG = Math.PI / 180

// Seeded random numbers (mulberry32): the same seed always builds the same creature.
export function rng(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Split the model text into named blocks: "=name" starts a block, "#" starts a comment.
export function library(text) {
  const lib = {}
  let block
  for (let line of text.split('\n')) {
    line = line.replace(/#.*/, '').trim()
    if (!line) continue
    if (line[0] == '=') lib[line.slice(1)] = block = []
    else block.push(line)
  }
  return lib
}

const SHAPES = {
  box: (a) => new THREE.BoxGeometry(a[0], a[1], a[2]),
  ball: (a, n = 8) => new THREE.SphereGeometry(1, n, (n * 3) >> 2).scale(a[0], a[1], a[2]),
  cyl: (a, n = 6) => new THREE.CylinderGeometry(a[0], a[2], a[1], n),
  lathe: (a, n = 8) => {
    const p = []
    for (let i = 0; i < a.length; i += 2) p.push(new THREE.Vector2(a[i], a[i + 1]))
    return new THREE.LatheGeometry(p, n)
  },
  ext: (a) => {
    const s = new THREE.Shape()
    for (let i = 1; i < a.length; i += 2) s[i > 1 ? 'lineTo' : 'moveTo'](a[i], a[i + 1])
    return new THREE.ExtrudeGeometry(s, { depth: a[0], bevelEnabled: false }).translate(0, 0, -a[0] / 2)
  },
}

const COMMANDS = new Set(['$', 'b', 'S', 'hold', '*', ...Object.keys(SHAPES)])

// Build one model from the library. Returns { root, bones, clips, vars, mat }.
export function make(lib, name, seed = 1, mat) {
  const R = rng(seed * 7919 + name.length)
  const V = { seed }
  const root = new THREE.Group()
  const bones = { root }
  const rest = []
  const geos = {}
  const clips = {}
  const holds = []
  mat ||= new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })

  // A number token: a literal, a variable, an expression over variables, with "a~b" meaning a seeded random in [a, b].
  const num = (t) => {
    if (+t == +t) return +t
    t = t.replace(/(-?[\d.]+)~(-?[\d.]+)/g, (_, a, b) => +a + R() * (b - a))
    return Function(...Object.keys(V), 'return ' + t)(...Object.values(V))
  }
  // "a|b|c" picks one of the options; a variable name gives its value.
  const pick = (t) => {
    t = V[t] ?? t
    if (typeof t != 'string') return t
    const o = t.split('|')
    return o[(R() * o.length) | 0]
  }
  // "arm*" names a mirrored pair: armL (+x, as written) and armR (-x).
  const sides = (n) => (n.endsWith('*') || n.endsWith('^') ? [n.slice(0, -1) + 'L', n.slice(0, -1) + 'R'] : [n])

  let clip
  const run = (line) => {
    if (line[0] == '?') {
      const [p, ...rest] = line.split(' ')
      if (R() < +p.slice(1)) run(rest.join(' '))
      return
    }
    line = line.replace(/\{([^}]+)\}/g, (_, e) => num(e))
    let [cmd, ...a] = line.split(/\s+/)
    const shape = cmd.match(/^([a-z]+)(\d*)(\*?)$/)

    if (clip && !COMMANDS.has(cmd) && !(shape && SHAPES[shape[1]]) && cmd[0] != '@') {
      // A clip channel: bone channel key key key ...
      const k = a.slice(1).map(num)
      const ch = a[0]
      sides(cmd).forEach((b, i) => {
        let kk = k
        if (i) {
          if ('ry rz x'.includes(ch)) kk = kk.map((v) => -v)
          if (cmd.endsWith('^')) kk = kk.map((_, j) => kk[(j + (kk.length >> 1)) % kk.length])
        }
        clip.ch.push([b, ch, kk])
      })
      return
    }
    if (cmd == '*') return (rep = [a[1], num(a[0])]) // keeps any open clip open
    clip = null
    if (cmd[0] == '@') {
      const once = cmd[1] == '!'
      const cn = cmd.slice(once ? 2 : 1)
      clip = { d: num(a[0]), once, ch: [] }
      if (!(common && clips[cn])) clips[cn] = clip // a model's own clip beats the common one

    } else if (cmd == '$') {
      let v = a.slice(1).join(' ')
      try {
        v = v.includes('|') ? pick(v) : num(v)
      } catch {}
      V[a[0]] = v
    } else if (cmd == 'S') root.scale.setScalar(num(a[0]))
    else if (cmd == 'hold') holds.push([a[0], pick(a[1])])
    else if (cmd == 'b') {
      const [n, p, x, y, z, , rx = 0, ry = 0, rz = 0] = a
      const ps = sides(p)
      sides(n).forEach((b, i) => {
        const o = new THREE.Object3D()
        const m = i ? -1 : 1
        o.position.set(num(x) * m, num(y), num(z))
        o.rotation.set(num(rx) * DEG, num(ry) * DEG * m, num(rz) * DEG * m)
        bones[b] = o
        ;(bones[ps[i] || ps[0]] || root).add(o)
        rest.push([o, o.position.clone(), o.rotation.clone(), o.scale.clone()])
      })
    } else if (shape && SHAPES[shape[1]]) {
      const slash = a.indexOf('/')
      const r = slash < 0 ? [0, 0, 0] : a.slice(slash + 1).map(num)
      if (slash >= 0) a = a.slice(0, slash)
      const [b, c, x, y, z, ...p] = a
      const cs = pick(c) + ''
      const color = new THREE.Color('#' + cs.replace('!', '')).multiplyScalar(cs.endsWith('!') ? 3 : 1) // "f60!" glows
      let g = SHAPES[shape[1]](p.map(num), shape[2] ? +shape[2] : undefined)
      g = (g.index ? g.toNonIndexed() : g)
        .rotateX(r[0] * DEG)
        .rotateY(r[1] * DEG)
        .rotateZ(r[2] * DEG)
        .translate(num(x), num(y), num(z))
      for (const k in g.attributes) if (k != 'position') g.deleteAttribute(k)
      const n = g.attributes.position.count
      const col = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const f = 0.9 + 0.1 * (((((i / 3) | 0) * 7919) % 13) / 13) // per-face shade jitter
        col[i * 3] = color.r * f
        col[i * 3 + 1] = color.g * f
        col[i * 3 + 2] = color.b * f
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const copies = shape[3] ? [g, mirror(g)] : [g]
      sides(b).forEach((bn, i) => {
        for (const gg of copies) (geos[bn] ||= []).push(i ? mirror(gg) : gg)
      })
    } else throw Error('model ' + name + ': ' + line)
  }

  // "* n i" repeats the next line n times with variable i = 0..n-1.
  let rep, common
  for (const block of [lib[name], lib.common || []]) {
    for (const line of block) {
      if (rep) {
        const [v, n] = rep
        rep = null
        for (let i = 0; i < n; i++) run(line, (V[v] = i))
      } else run(line)
    }
    common = 1
    clip = null
  }
  rest.push([root, root.position.clone(), root.rotation.clone(), root.scale.clone()])

  for (const b in geos) {
    const g = mergeGeometries(geos[b])
    g.computeVertexNormals()
    const mesh = new THREE.Mesh(g, mat)
    mesh.castShadow = true
    bones[b].add(mesh)
  }
  const m = { name, root, bones, clips, vars: V, mat, rest, props: {} }
  for (const [bone, prop] of holds) hold(lib, m, bone, prop, seed)
  return m
}

// Mirror a geometry across x (and flip the triangles so they still face outwards).
function mirror(g) {
  g = g.clone().scale(-1, 1, 1)
  for (const k in g.attributes) {
    const a = g.attributes[k].array
    const s = g.attributes[k].itemSize
    for (let i = 0; i < a.length; i += s * 3)
      for (let j = 0; j < s; j++) [a[i + s + j], a[i + 2 * s + j]] = [a[i + 2 * s + j], a[i + s + j]]
  }
  return g
}

// Attach a prop model to a bone (a socket). Replaces whatever that bone was holding.
export function hold(lib, m, bone, prop, seed = 1) {
  const old = m.props[bone]
  if (old) old.root.removeFromParent()
  delete m.props[bone]
  if (!prop || !lib[prop]) return
  const p = make(lib, prop, seed, m.mat)
  m.bones[bone].add(p.root)
  return (m.props[bone] = p)
}

// Pose a model from clip layers: [[clipName, time, weight], ...]. Channels add to the rest pose.
export function pose(m, layers) {
  for (const [o, p, r, s] of m.rest) {
    o.position.copy(p)
    o.rotation.copy(r)
    o.scale.copy(s)
  }
  for (const [name, t, w] of layers) {
    const c = m.clips[name]
    if (!c || !w) continue
    const u = c.once ? Math.min(t / c.d, 1) : (t / c.d) % 1
    for (const [b, ch, k] of c.ch) {
      const o = m.bones[b]
      if (!o) continue
      const n = k.length
      const f = c.once ? u * (n - 1) : u * n
      const i = Math.min(f | 0, n - 1)
      const e = f - i
      const s = e * e * (3 - 2 * e)
      const v = (k[i] + (k[c.once ? Math.min(i + 1, n - 1) : (i + 1) % n] - k[i]) * s) * w
      if (ch[0] == 'r') o.rotation[ch[1]] += v * DEG
      else if (ch == 's') o.scale.addScalar(v)
      else if (ch[0] == 's') o.scale[ch[1]] += v
      else o.position[ch] += v
    }
  }
  for (const p of Object.values(m.props)) pose(p, [['idle', layers[0]?.[1] || 0, 1]])
}

// Bake a static model (no animation) into a single geometry, for instancing trees and rocks.
export function bake(m) {
  m.root.updateMatrixWorld(true)
  const gs = []
  m.root.traverse((o) => o.isMesh && gs.push(o.geometry.clone().applyMatrix4(o.matrixWorld)))
  return mergeGeometries(gs)
}

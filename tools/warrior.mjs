// Dev tool, not shipped: writes the warrior's bones and clips into src/models.json (his parts stay hand-written there).
// Poses are written here as absolute joint angles; the legs are solved with planar two-bone IK so the soles stay on the
// ground while the hips drop and shift. The fighting stance is baked into the bones' rest rotations, so every clip
// stores only what moves away from the stance (pose() adds channels to the rest pose, and one-shots on top of
// idle/walk). Run: node tools/warrior.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../src/models.json', import.meta.url)
const lib = JSON.parse(readFileSync(FILE, 'utf8'))
const W = lib.warrior

const HIP = 0.95 // hip bone height at rest
const T = 0.45 // thigh
const S = 0.42 // shin
const ANKLE = 0.08 // ankle above the sole when the foot is flat
const R2D = 180 / Math.PI

// Thigh, knee and foot rx for one leg: hip joint at (hz, HIP + hy), ankle at (fz, ANKLE + lift), foot pitch p
// (degrees, + toe down). rx < 0 swings a limb forward; knee rx > 0 bends it back.
function leg(hy, hz, fz, lift = 0, p = 0) {
  const dz = fz - hz
  const dy = ANKLE + lift - (HIP + hy)
  const D = Math.min(Math.hypot(dz, dy), T + S - 1e-6)
  const phi = Math.atan2(-dz, -dy)
  const alpha = Math.acos((T * T + D * D - S * S) / (2 * T * D))
  const knee = Math.PI - Math.acos((T * T + S * S - D * D) / (2 * T * S))
  const a = (phi - alpha) * R2D
  const k = knee * R2D
  return [a, k, p - a - k]
}

// A pose: { 'bone.ch': value }, plus legs from { hy, hz, L: [fz, lift, pitch], R: [...] }.
function P(o) {
  const out = { ...o }
  delete out.hy, delete out.hz, delete out.L, delete out.R
  if (o.L) {
    const hy = o.hy || 0
    const hz = o.hz || 0
    for (const s of 'LR') {
      const [a, k, f] = leg(hy, hz, ...o[s])
      out['leg' + s + '.rx'] = a
      out['shin' + s + '.rx'] = k
      out['foot' + s + '.rx'] = f
    }
    out['hip.y'] = hy
    out['hip.z'] = hz
  }
  for (const k in out) {
    const [b, ch] = k.split('.')
    if (!b.endsWith('*')) continue
    out[b.slice(0, -1) + 'L.' + ch] = out[k]
    out[b.slice(0, -1) + 'R.' + ch] = MIRROR.includes(ch) ? -out[k] : out[k]
    delete out[k]
  }
  return out
}
const MIRROR = 'ry rz x' // channels a mirrored (*) bone flips on its right side

// ---------- the stance (idle's base) ----------
const STANCE = {
  hy: -0.1,
  hz: 0.02,
  L: [0.2, 0, 0], // torch-side foot forward
  R: [-0.16, 0, 0],
  'leg*.rz': 6,
  'foot*.rz': -6,
  'hip.ry': -12,
  'chest.ry': -8,
  'chest.rx': 10,
  'head.ry': 18,
  'head.rx': -10,
  'cape.rx': 10,
  // weapon arm cocked, elbow bent
  'armR.rx': -25,
  'armR.rz': -12,
  'foreR.rx': -75,
  'handR.rx': 75,
  // torch arm up
  'armL.rx': -20,
  'armL.rz': 15,
  'foreL.rx': -95,
  'handL.rx': 28, // (solved to turn a shield's face forward when the warrior carried one)
  'handL.ry': -76,
  'handL.rz': -102,
}
const base = P(STANCE)

// ---------- clips: lists of absolute poses (missing channels hold the stance) ----------
const clips = {}

// idle: the stance, breathing (the chest rises and rocks, the weapon sways with it and the torch arm sinks and lifts)
clips.idle = {
  duration: 2.4,
  loop: true,
  keys: [P(STANCE), P({ ...STANCE, 'chest.rx': 16, 'chest.y': 0.03, 'head.rx': -16, 'armR.rx': -31, 'armL.rx': -34, 'armL.rz': 22, 'foreR.rx': -83, 'foreL.rx': -108, 'cape.rx': 16 })],
}

// walk: 8 phases; left foot strikes at 0, right at .5. Heel strike, flat, toe off, swing with a high knee.
{
  const n = 8
  const keys = []
  const stride = 0.36
  const foot = (p) => {
    // p in [0,1): 0 heel strike in front, .5 toe off behind, then swing forward
    if (p < 0.5) {
      const u = p / 0.5
      const z = stride - 2 * stride * u
      const pitch = u < 0.15 ? -18 : u > 0.8 ? 30 * ((u - 0.8) / 0.2) : 0
      const lift = u > 0.8 ? 0.06 * ((u - 0.8) / 0.2) : u < 0.15 ? 0.02 : 0
      return [z, lift, pitch]
    }
    const u = (p - 0.5) / 0.5
    return [-stride + 2 * stride * u, 0.1 + 0.12 * Math.sin(Math.PI * u), 25 * (1 - u) - 18 * u]
  }
  for (let i = 0; i < n; i++) {
    const p = i / n
    const s = Math.sin(2 * Math.PI * p) // + while the left leg leads
    const c = Math.cos(2 * Math.PI * p)
    keys.push(
      P({
        hy: -0.07 - 0.035 * Math.abs(c), // dips as each foot lands
        hz: 0.03,
        L: foot(p),
        R: foot((p + 0.5) % 1),
        'leg*.rz': 3,
        'foot*.rz': -3,
        'hip.ry': -8 * c,
        'chest.ry': 12 * c - 4,
        'chest.rx': 12,
        'head.ry': -10 * c + 4,
        'head.rx': -10,
        'cape.rx': 22 + 6 * Math.abs(s),
        'armR.rx': -25 - 10 * c,
        'armR.rz': -10,
        'foreR.rx': -75 - 8 * c,
        'handR.rx': 75,
        'armL.rx': -20 + 20 * c, // the torch arm swings against the left leg
        'armL.rz': 15 + 6 * Math.abs(s),
        'foreL.rx': -95 + 14 * c,
      }),
    )
  }
  clips.walk = { duration: 0.6, loop: true, keys }
}

// swing (sword): wind up high over the right shoulder, cut down across to the left hip, weight onto the front foot
clips.swing = {
  duration: 0.45,
  keys: [
    P(STANCE),
    P({ ...STANCE, hy: -0.08, hz: -0.04, 'hip.ry': -25, 'chest.ry': -35, 'chest.rx': 0, 'head.ry': 40, 'armR.rx': -130, 'armR.rz': -40, 'foreR.rx': -60, 'handR.rx': 150, 'handR.ry': -30, 'armL.rx': -30, 'foreL.rx': -60 }),
    P({ ...STANCE, hy: -0.16, hz: 0.12, 'hip.ry': 5, 'chest.ry': 20, 'chest.rx': 24, 'head.ry': 0, 'head.rx': -20, 'armR.rx': -70, 'armR.rz': 0, 'foreR.rx': -10, 'handR.rx': 100, 'handR.ry': -10, 'armL.rx': -20, 'armL.rz': 30, 'foreL.rx': -40 }),
    P({ ...STANCE, hy: -0.15, hz: 0.1, 'hip.ry': 10, 'chest.ry': 35, 'chest.rx': 22, 'head.ry': -15, 'head.rx': -15, 'armR.rx': -5, 'armR.rz': 45, 'foreR.rx': -25, 'handR.rx': 84, 'handR.ry': -20, 'armL.rx': -15, 'armL.rz': 35, 'foreL.rx': -40 }),
    P(STANCE),
  ],
}

// chop (axe): six keys so the downswing passes through the game's hit moment (45% of the clip). A big overhead lift and a hard downward drive, rising onto the toes then sinking into the knees
clips.chop = {
  duration: 0.7,
  keys: [
    P(STANCE),
    P({ ...STANCE, hy: -0.03, hz: -0.06, 'chest.rx': -18, 'chest.ry': -10, 'head.rx': 10, 'armR.rx': -190, 'armR.rz': -5, 'foreR.rx': -70, 'handR.rx': 118, 'handR.ry': -15, 'armL.rx': -20, 'foreL.rx': -50 }),
    P({ ...STANCE, hy: -0.02, hz: -0.07, 'chest.rx': -22, 'chest.ry': -10, 'head.rx': 12, 'armR.rx': -200, 'armR.rz': -5, 'foreR.rx': -85, 'handR.rx': 128, 'handR.ry': -20, 'armL.rx': -20, 'foreL.rx': -50 }),
    P({ ...STANCE, hy: -0.24, hz: 0.12, 'chest.rx': 35, 'chest.ry': 0, 'head.rx': -30, 'armR.rx': -40, 'armR.rz': 5, 'foreR.rx': -5, 'handR.rx': 42, 'handR.ry': 5, 'armL.rx': -15, 'armL.rz': 30, 'foreL.rx': -45 }),
    P({ ...STANCE, hy: -0.25, hz: 0.12, 'chest.rx': 38, 'chest.ry': 5, 'head.rx': -30, 'armR.rx': -32, 'armR.rz': 10, 'foreR.rx': -10, 'handR.rx': 42, 'handR.ry': 5, 'armL.rx': -15, 'armL.rz': 30, 'foreL.rx': -45 }),
    P(STANCE),
  ],
}

// jab (torch): a lunge, front knee driving forward, arm punching straight out
clips.jab = {
  duration: 0.35,
  keys: [
    P(STANCE),
    P({ ...STANCE, hy: -0.08, hz: -0.06, 'chest.ry': -30, 'head.ry': 30, 'armR.rx': -15, 'armR.rz': -15, 'foreR.rx': -110, 'handR.rx': 153, 'handR.ry': 35 }),
    P({ ...STANCE, hy: -0.17, hz: 0.18, L: [0.3, 0, 0], 'chest.ry': 25, 'chest.rx': 18, 'head.ry': -10, 'armR.rx': -85, 'armR.rz': 5, 'foreR.rx': -5, 'handR.rx': 148, 'handR.ry': -25, 'armL.rx': -20, 'armL.rz': 30, 'foreL.rx': -50 }),
    P(STANCE),
  ],
}

// ride: seated on a mount (laid over idle, replacing common's ride): thighs forward and spread, knees bent, feet
// level, hips square to the saddle; the guard stays up
clips.ride = {
  duration: 1,
  loop: true,
  keys: [P({ ...base, 'leg*.rx': -80, 'leg*.rz': 18, 'shin*.rx': 85, 'foot*.rx': -5, 'foot*.rz': -18, 'hip.ry': 0, 'chest.ry': -5, 'head.ry': 5 })],
}

// lift: an item (wood, flint) held level over the head in both hands, laid over idle/walk
clips.lift = {
  duration: 1,
  loop: true,
  keys: [P({ ...base, 'hip.ry': 0, 'chest.ry': 0, 'chest.rx': 0, 'head.ry': 0, 'arm*.rx': -172, 'arm*.rz': -15, 'fore*.rx': -10, 'handR.rx': 0, 'handR.ry': 10, 'handR.rz': -10 })],
}

// hit: knocked back, the head snaps, the arms fly open, knees buckle and recover
clips.hit = {
  duration: 0.3,
  keys: [
    P(STANCE),
    P({ ...STANCE, hy: -0.16, hz: -0.1, 'chest.rx': -15, 'chest.ry': 10, 'head.rx': -35, 'head.ry': 25, 'armR.rx': -50, 'armR.rz': -35, 'foreR.rx': -30, 'armL.rx': -15, 'armL.rz': 35, 'foreL.rx': -40, 'cape.rx': 25 }),
    P(STANCE),
  ],
}

// death: the knees go, he sags forward, then topples onto his back with arms flung out, legs slack
{
  const slack = {
    'legL.rx': -40,
    'shinL.rx': 50,
    'footL.rx': 20,
    'legR.rx': -15,
    'shinR.rx': 15,
    'footR.rx': 20,
    'hip.y': -0.43,
    'hip.z': 0,
  }
  clips.death = {
    duration: 1.4,
    keys: [
      P(STANCE),
      P({ ...STANCE, hy: -0.3, hz: 0.05, 'chest.rx': 30, 'chest.ry': 0, 'head.rx': 25, 'head.ry': 0, 'armR.rx': -10, 'armR.rz': -10, 'foreR.rx': -20, 'armL.rx': -10, 'armL.rz': 10, 'foreL.rx': -20, 'cape.rx': 0 }),
      P({ ...STANCE, hy: -0.4, hz: 0, 'root.rx': -35, 'root.y': 0.14, 'root.z': -0.2, 'chest.rx': 10, 'chest.ry': 0, 'head.rx': 30, 'head.ry': 0, 'armR.rx': -60, 'armR.rz': -50, 'foreR.rx': -30, 'armL.rx': -60, 'armL.rz': 50, 'foreL.rx': -30, 'cape.rx': -10 }),
      { ...base, ...slack, 'root.rx': -90, 'root.y': 0.3, 'root.z': -0.5, 'chest.rx': -5, 'chest.ry': 0, 'head.rx': 10, 'head.ry': 30, 'armR.rx': -100, 'armR.rz': -70, 'foreR.rx': -15, 'handR.rx': 0, 'armL.rx': -90, 'armL.rz': 70, 'foreL.rx': -20, 'cape.rx': -10 },
      { ...base, ...slack, 'root.rx': -90, 'root.y': 0.27, 'root.z': -0.5, 'chest.rx': -5, 'chest.ry': 0, 'head.rx': 15, 'head.ry': 35, 'armR.rx': -100, 'armR.rz': -75, 'foreR.rx': -10, 'handR.rx': 0, 'armL.rx': -90, 'armL.rz': 75, 'foreL.rx': -15, 'cape.rx': -10 },
    ],
  }
}

// ---------- emit ----------
// The skeleton: [name, parent, position, rotation]; "x*" is a mirrored pair as in the JSON. Rest = this + the stance.
const RIG = [
  ['hip', 'root', [0, HIP, 0]],
  ['chest', 'hip', [0, 0.05, 0]],
  ['head', 'chest', [0, 0.6, 0]],
  ['cape', 'chest', [0, 0.55, -0.16]],
  ['arm*', 'chest', [0.3, 0.52, 0]], // upper arm
  ['fore*', 'arm*', [0, -0.28, 0]], // elbow
  ['hand*', 'fore*', [0, -0.27, 0.02], [-25, 0, 0]], // wrist, the prop socket
  ['leg*', 'hip', [0.12, 0, 0]], // thigh
  ['shin*', 'leg*', [0, -T, 0]], // knee
  ['foot*', 'shin*', [0, -S, 0]], // ankle
]
const r = (ch, v) => (ch[0] == 'r' ? Math.round(v) : Math.round(v * 100) / 100) || 0
const same = (a, b) => a.length == b.length && a.every((v, i) => v == b[i])
const side = (n, s) => (n.endsWith('*') ? n.slice(0, -1) + s : n)

W.bones = []
for (const [name, parent, pos, rot = [0, 0, 0]] of RIG) {
  const rest = (s) => {
    const b = side(name, s)
    const m = s == 'R' && name.endsWith('*') ? -1 : 1
    const p = pos.map((v, i) => r('p', (i ? v : v * m) + (base[b + '.' + 'xyz'[i]] || 0)))
    const q = rot.map((v, i) => r('r', (i ? v * m : v) + (base[b + '.r' + 'xyz'[i]] || 0)))
    return [b, p, q]
  }
  const [bl, pl, ql] = rest('L')
  const [br, pr, qr] = rest('R')
  const entry = (n, pa, p, q) => (q.some((v) => v) ? { name: n, parent: pa, position: p, rotation: q } : { name: n, parent: pa, position: p })
  const mir = (p, q) => [[-p[0] || 0, p[1], p[2]], [q[0], -q[1] || 0, -q[2] || 0]]
  const [mp, mq] = mir(pr, qr)
  if (!name.endsWith('*') || (same(pl, mp) && same(ql, mq))) W.bones.push(entry(name, parent, pl, ql))
  else W.bones.push(entry(bl, side(parent, 'L'), pl, ql), entry(br, side(parent, 'R'), pr, qr))
}

function channels(c) {
  const names = [...new Set(c.keys.flatMap((k) => Object.keys(k)))]
  const ch = {}
  for (const nm of names) {
    const chn = nm.split('.')[1]
    let keys = c.keys.map((k) => r(chn, (nm in k ? k[nm] : (base[nm] ?? 0)) - (base[nm] ?? 0)))
    if (keys.every((v) => v == keys[0])) keys = [keys[0]]
    if (keys.every((v) => Math.abs(v) <= (chn[0] == 'r' ? 5 : 0.02))) continue // too small to see: not worth its bytes
    // a loop of 8 whose odd keys are close to the midpoints of their neighbours keeps only the even 4
    const tol = chn[0] == 'r' ? 3 : 0.015
    if (c.loop && keys.length == 8 && keys.every((v, j) => j % 2 == 0 || Math.abs(v - (keys[j - 1] + keys[(j + 1) % 8]) / 2) <= tol))
      keys = keys.filter((_, j) => j % 2 == 0)
    ch[nm] = keys
  }
  // fold L/R pairs into "*" (mirrored) or "^" (mirrored, half a loop apart)
  const out = []
  const done = new Set()
  for (const nm in ch) {
    if (done.has(nm)) continue
    const [b, chn] = nm.split('.')
    const stem = b.slice(0, -1)
    const L = ch[stem + 'L.' + chn]
    const R = ch[stem + 'R.' + chn]
    if (/[LR]$/.test(b) && L && R) {
      const fr = MIRROR.includes(chn) ? R.map((v) => -v || 0) : R
      const shifted = L.map((_, j) => L[(j + (L.length >> 1)) % L.length])
      const fold = same(L, fr) ? '*' : c.loop && L.length > 1 && same(shifted, fr) ? '^' : ''
      if (fold) {
        out.push({ bone: stem + fold, channel: chn, keys: L })
        done.add(stem + 'L.' + chn), done.add(stem + 'R.' + chn)
        continue
      }
    }
    out.push({ bone: b, channel: chn, keys: ch[nm] })
    done.add(nm)
  }
  return out
}

const kept = W.clips // clips written by hand in models.json (swim) are kept, after the generated ones
W.clips = {}
for (const name in clips) {
  const c = clips[name]
  W.clips[name] = { duration: c.duration, loop: !!c.loop, channels: channels(c) }
}
for (const name in kept) W.clips[name] ||= kept[name]
// keep the warrior's keys in their usual order
lib.warrior = { vars: W.vars, bones: W.bones, parts: W.parts, holds: W.holds, clips: W.clips }
writeFileSync(FILE, JSON.stringify(lib, null, 2) + '\n')
console.log('warrior clips:', Object.entries(W.clips).map(([n, c]) => n + ':' + c.channels.length).join(' '))
console.log('warrior bytes (pretty):', JSON.stringify(lib.warrior, null, 2).length)

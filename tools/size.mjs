// Size report: the shipped game against the 13,312-byte js13k budget, and the model description against mesh exports.
//
//   node tools/size.mjs                      game at surprisal -1 and -9, models at -1
//   SURPRISAL=/path/to/surprisal LEVELS=1 MODEL_LEVEL=1 node tools/size.mjs
//
// Needs a surprisal binary with the "-<level>" CLI (github.com/benallfree/surprisal, newer than 0.0.1-alpha.1).
// Each surprisal run prints a line before and after; a 32 KB file takes about a minute at -1, several at -9.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { library, make } from '../src/compiler.js'

const BUDGET = 13312
const root = new URL('..', import.meta.url).pathname
const out = root + 'dist/size/'
const SURPRISAL = process.env.SURPRISAL || 'surprisal'
const LEVELS = (process.env.LEVELS || '1,9').split(',').map(Number)
const MODEL_LEVEL = +(process.env.MODEL_LEVEL || 1)
const t = () => new Date().toTimeString().slice(0, 8)
const log = (...a) => console.log(t(), ...a)

execFileSync('node', [root + 'tools/build.mjs'], { stdio: 'inherit' })
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// ---------- compressors ----------
const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status == 0
const help = spawnSync(SURPRISAL, ['--help'], { encoding: 'utf8' })
if (help.error || !/-0 \.\.\. -9/.test(help.stdout + help.stderr)) {
  console.error(`${SURPRISAL}: needs a surprisal build with the -0..-9 CLI. Set SURPRISAL=/path/to/surprisal.`)
  process.exit(1)
}
const gzip = (b) => gzipSync(b, { level: 9 }).length
const brotli = (b) =>
  brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } }).length
function zip(file, name) {
  const z = out + name + '.zip'
  execFileSync('zip', ['-9', '-X', '-j', '-q', z, file])
  const deflate = statSync(z).size
  let zopfli = null
  if (have('advzip')) {
    execFileSync('advzip', ['-z', '-4', '-q', z])
    zopfli = statSync(z).size
  }
  return { deflate, zopfli }
}
// Surprisal results are cached by content hash in .cache/, so re-runs only pay for inputs that changed.
const cache = root + '.cache/'
mkdirSync(cache, { recursive: true })
function surprisal(file, name, level) {
  const key = cache + createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) + '.' + level
  if (existsSync(key)) {
    const n = +readFileSync(key, 'utf8')
    log(`surprisal -${level} ${name}: ${n.toLocaleString()} bytes (cached)`)
    return n
  }
  const a = `${out}${name}.${level}.13k`
  log(`surprisal -${level} ${name} (${statSync(file).size.toLocaleString()} bytes) ...`)
  const r = spawnSync(SURPRISAL, [`-${level}`, '-f', '-o', a, file], { encoding: 'utf8' })
  writeFileSync(`${out}${name}.${level}.log`, (r.stdout || '') + (r.stderr || ''))
  if (r.status) throw Error(`surprisal failed, see ${out}${name}.${level}.log`)
  const n = statSync(a).size
  log(`surprisal -${level} ${name}: ${n.toLocaleString()} bytes`)
  writeFileSync(key, String(n))
  return n
}
const fmt = (n) => (n == null ? '–' : n.toLocaleString())
const pct = (n) => ((n / BUDGET) * 100).toFixed(0) + '%'

// ---------- the shipped game ----------
const md = []
const game = root + 'dist/index.html'
const gb = readFileSync(game)
const gz = zip(game, 'index')
const rows = [
  ['raw', gb.length],
  ['gzip -9', gzip(gb)],
  ['zip -9 (Deflate) ✓', gz.deflate],
  ['zip, Zopfli (advzip -4) ✓', gz.zopfli],
  ['Brotli q11', brotli(gb)],
]
for (const l of LEVELS) rows.push([`surprisal -${l}`, surprisal(game, 'index', l)])
md.push(
  `## Shipped game: dist/index.html (game + compiler + model JSON; three.js excluded)`,
  '',
  `| packing | bytes | of 13,312 budget |`,
  `|---|---:|---:|`,
  ...rows.map(([k, v]) => `| ${k} | ${fmt(v)} | ${v == null ? '–' : pct(v)} |`),
  '',
  '✓ = what js13k accepts today.',
  ''
)

// ---------- what's inside the build ----------
const src = (f) => readFileSync(root + 'src/' + f)
const parts = [
  ['model JSON (models.json)', src('models.json')],
  ['compiler + rig runtime (compiler.js)', src('compiler.js')],
  ['game (game.js)', src('game.js')],
  ['page shell (index.html)', src('index.html')],
]
md.push(`## Inside the build (each part compressed on its own)`, '', `| part | raw | gzip -9 | Brotli |`, `|---|---:|---:|---:|`)
for (const [k, b] of parts) md.push(`| ${k} | ${fmt(b.length)} | ${fmt(gzip(b))} | ${fmt(brotli(b))} |`)
md.push('')

// ---------- model JSON vs. the meshes it compiles to ----------
// The characters and props, one seeded variant each: what you would otherwise export from a modeling tool.
const lib = library(src('models.json').toString())
const NAMES = ['warrior', 'sword', 'axe', 'torch', 'club', 'spear', 'slime', 'goblin', 'spider', 'bat']
// The model JSON for just these models, formatted as in src/models.json.
const text = Buffer.from(JSON.stringify(Object.fromEntries(['common', ...NAMES].map((n) => [n, lib[n]])), null, 2) + '\n')
const meshes = []
const animTotal = []
for (const n of NAMES) {
  const m = make(lib, n, 1)
  m.root.updateMatrixWorld(true)
  const bones = []
  const names = new Map(Object.entries(m.bones).map(([k, v]) => [v, k]))
  for (const [k, o] of Object.entries(m.bones))
    bones.push({ name: k, parent: names.get(o.parent) || null, p: o.position.toArray(), r: o.rotation.toArray().slice(0, 3) })
  const parts = []
  m.root.traverse((o) => {
    if (o.isMesh && names.has(o.parent) && !Object.values(m.props).some((p) => p.root == o.parent)) {
      const g = o.geometry
      parts.push({ bone: names.get(o.parent), pos: g.attributes.position.array, col: g.attributes.color.array, geo: g })
    }
  })
  meshes.push({ name: n, bones, parts, clips: m.clips })
}
let verts = 0
for (const m of meshes) for (const p of m.parts) verts += p.pos.length / 3

// JSON, numbers to 3 decimals: a typical hand-rolled or three.js-style export.
const r3 = (v) => Math.round(v * 1000) / 1000
const json = Buffer.from(
  JSON.stringify(
    meshes.map((m) => ({
      name: m.name,
      bones: m.bones.map((b) => ({ ...b, p: b.p.map(r3), r: b.r.map(r3) })),
      meshes: m.parts.map((p) => ({ bone: p.bone, position: [...p.pos].map(r3), color: [...p.col].map((c) => Math.round(c * 255)) })),
      clips: m.clips,
    }))
  )
)
// Binary A: float32 positions + uint8 colors, non-indexed (what the compiler hands the GPU).
// Binary B: indexed and quantized: int16 positions (1 mm), uint8 colors, uint16 indices, as a size-tuned exporter would.
const chunksA = []
const chunksB = []
for (const m of meshes)
  for (const p of m.parts) {
    chunksA.push(Buffer.from(new Float32Array(p.pos).buffer))
    chunksA.push(Buffer.from(Uint8Array.from(p.col, (c) => Math.round(c * 255))))
    const g = p.geo.clone()
    g.deleteAttribute('normal')
    const ig = mergeVertices(g, 1e-4)
    chunksB.push(Buffer.from(Int16Array.from(ig.attributes.position.array, (v) => Math.round(v * 1000)).buffer))
    chunksB.push(Buffer.from(Uint8Array.from(ig.attributes.color.array, (c) => Math.round(c * 255))))
    chunksB.push(Buffer.from(Uint16Array.from(ig.index.array).buffer))
  }
// Bones and clips ride along as compact JSON in both binary exports, so all three carry the same information.
const meta = Buffer.from(JSON.stringify(meshes.map((m) => ({ n: m.name, b: m.bones, c: m.clips }))))
const binA = Buffer.concat([...chunksA, meta])
const binB = Buffer.concat([...chunksB, meta])
// Other ways to write the model description (DSL text, compact JSON, JS calls, YAML) are compared in tools/formats.mjs.
const formats = [
  ['model JSON (what the game ships)', text, 'models-description.json'],
  ['JSON mesh export', json, 'models-mesh.json'],
  ['binary, float32 non-indexed', binA, 'models-f32.bin'],
  ['binary, int16 indexed', binB, 'models-q16.bin'],
]
md.push(
  `## Model JSON vs. mesh exports of the same characters and props`,
  '',
  `${NAMES.length} models, one seeded variant each: ${verts.toLocaleString()} vertices, bones and animation clips included in every format.`,
  '',
  `| format | raw | gzip -9 | Brotli | surprisal -${MODEL_LEVEL} | surprisal ratio |`,
  `|---|---:|---:|---:|---:|---:|`
)
for (const [k, b, f] of formats) {
  writeFileSync(out + f, b)
  const s = surprisal(out + f, f, MODEL_LEVEL)
  md.push(`| ${k} | ${fmt(b.length)} | ${fmt(gzip(b))} | ${fmt(brotli(b))} | ${fmt(s)} | ${((s / b.length) * 100).toFixed(1)}% |`)
}
md.push('')
writeFileSync(out + 'SIZES.md', md.join('\n'))
console.log('\n' + md.join('\n'))
log(`wrote ${out}SIZES.md`)

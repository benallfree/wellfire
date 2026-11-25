// Does a JSON (or JS, or YAML) model file compress better under surprisal than the text DSL?
//
//   node tools/formats.mjs                       write candidates, check fidelity, surprisal -1 on all
//   LEVELS=9 ONLY=txt,compact node tools/formats.mjs   also -9, on just those candidates
//   LEVELS= node tools/formats.mjs               no new surprisal runs: print the table from the cache
//   SURPRISAL=/path/to/surprisal ...             binary to use (needs the -0..-9 CLI)
//
// The baseline is the text DSL the game used before it moved to JSON: tools/formats/models.txt, compiled by
// tools/formats/dsl.js. The game now ships src/models.json (exactly the "pretty" candidate) and src/compiler.js.
//
// Every candidate carries exactly the information in the DSL text. Fidelity is checked, not assumed: each candidate
// is decoded back into DSL text and every model is built with tools/formats/dsl.js for several seeds;
// the meshes, bones, clips, vars and props must match the original bit for bit.
// Surprisal results are cached by content hash in .cache/ (shared with tools/size.mjs).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import * as DSL from './formats/dsl.js'
import * as COMPACT from './formats/compact-compiler.js'
import * as GAME from '../src/compiler.js'

const root = new URL('..', import.meta.url).pathname
const out = root + 'dist/formats/'
const cache = root + '.cache/'
mkdirSync(out, { recursive: true })
mkdirSync(cache, { recursive: true })
const SURPRISAL = process.env.SURPRISAL || 'surprisal'
const LEVELS = (process.env.LEVELS ?? '1').split(',').filter(Boolean).map(Number)
const ONLY = process.env.ONLY?.split(',')
const t = () => new Date().toTimeString().slice(0, 8)
const log = (...a) => console.log(t(), ...a)

// ---------- DSL text -> structure ----------
// { model: { vars: {k: v}, scale, bones: [...], parts: [...], holds: [...], clips: { name: { duration, loop, channels } } } }
// Optional per statement: chance (from "?p"), repeat + var (from a preceding "* n i").
const SHAPES = ['box', 'ball', 'cyl', 'lathe', 'ext']
const val = (t) => (/^-?(\d+\.?\d*|\.\d+)$/.test(t) ? +t : t) // plain numbers become numbers; expressions stay strings

export function parse(text) {
  const models = {}
  let m, clip, rep
  for (let line of text.split('\n')) {
    line = line.replace(/#.*/, '').trim()
    if (!line) continue
    if (line[0] == '=') {
      m = models[line.slice(1)] = {}
      clip = rep = null
      continue
    }
    let chance
    if (line[0] == '?') {
      const i = line.indexOf(' ')
      chance = +line.slice(1, i)
      line = line.slice(i + 1)
    }
    let [cmd, ...a] = line.split(/\s+/)
    const sh = cmd.match(/^([a-z]+)(\d*)(\*?)$/)
    const isShape = sh && SHAPES.includes(sh[1])
    const isCmd = isShape || ['$', 'b', 'S', 'hold', '*'].includes(cmd) || cmd[0] == '@'
    let item, list
    if (cmd == '*') {
      rep = { repeat: +a[0], var: a[1] } // keeps an open clip open, like the compiler
      continue
    }
    if (clip && !isCmd) {
      list = clip.channels
      item = { bone: cmd, channel: a[0], keys: a.slice(1).map(val) }
    } else {
      clip = null // any other statement ends a clip, as in src/dsl.js
      if (cmd[0] == '@') {
        const once = cmd[1] == '!'
        clip = { duration: val(a[0]), loop: !once, channels: [] }
        ;(m.clips ||= {})[cmd.slice(once ? 2 : 1)] = clip
      } else if (cmd == '$') (m.vars ||= {})[a[0]] = val(a.slice(1).join(' '))
      else if (cmd == 'S') m.scale = val(a[0])
      else if (cmd == 'hold') (list = m.holds ||= []), (item = { bone: a[0], model: a[1] })
      else if (cmd == 'b') {
        list = m.bones ||= []
        item = { name: a[0], parent: a[1], position: a.slice(2, 5).map(val) }
        if (a[5] == '/') item.rotation = a.slice(6).map(val)
      } else if (isShape) {
        list = m.parts ||= []
        const s = a.indexOf('/')
        const rot = s < 0 ? null : a.slice(s + 1).map(val)
        if (s >= 0) a = a.slice(0, s)
        // colors stay strings even when all digits ("222"), or "000" would become 0
        item = { shape: sh[1], bone: a[0], color: a[1], position: a.slice(2, 5).map(val), size: a.slice(5).map(val) }
        if (rot) item.rotation = rot
        if (sh[2]) item.segments = +sh[2]
        if (sh[3]) item.mirror = true
      } else throw Error('unknown statement: ' + line)
    }
    if (!item) {
      if (chance != null || rep) throw Error('"?" or "*" on a statement this converter does not carry it on: ' + line)
      continue
    }
    if (chance != null) item.chance = chance
    if (rep) Object.assign(item, rep), (rep = null)
    list.push(item)
  }
  return models
}

// ---------- structure -> DSL text (the round trip back to what src/dsl.js reads) ----------
export function toDSL(models) {
  const L = []
  const pre = (it, s) => (it.repeat != null && L.push(`* ${it.repeat} ${it.var}`), L.push((it.chance != null ? `?${it.chance} ` : '') + s))
  for (const [n, m] of Object.entries(models)) {
    L.push('=' + n)
    for (const [k, v] of Object.entries(m.vars || {})) L.push(`$ ${k} ${v}`)
    if (m.scale != null) L.push('S ' + m.scale)
    for (const b of m.bones || []) pre(b, ['b', b.name, b.parent, ...b.position, ...(b.rotation ? ['/', ...b.rotation] : [])].join(' '))
    for (const p of m.parts || [])
      pre(p, [p.shape + (p.segments || '') + (p.mirror ? '*' : ''), p.bone, p.color, ...p.position, ...p.size, ...(p.rotation ? ['/', ...p.rotation] : [])].join(' '))
    for (const h of m.holds || []) pre(h, `hold ${h.bone} ${h.model}`)
    for (const [cn, c] of Object.entries(m.clips || {})) {
      L.push(`@${c.loop ? '' : '!'}${cn} ${c.duration}`)
      for (const ch of c.channels) pre(ch, [ch.bone, ch.channel, ...ch.keys].join(' '))
    }
  }
  return L.join('\n') + '\n'
}

// ---------- candidates: encode + decode back to the structure ----------
const J = JSON.stringify
const OPT = ['chance', 'repeat', 'var']
const opts = (it) => (OPT.some((k) => it[k] != null) ? [Object.fromEntries(OPT.filter((k) => it[k] != null).map((k) => [k, it[k]]))] : [])
const takeOpts = (a) => (a.length && typeof a.at(-1) == 'object' && !Array.isArray(a.at(-1)) ? [a.slice(0, -1), a.at(-1)] : [a, {}])

// Compact JSON: one positional array per statement per line; optional chance/repeat as a trailing object.
function encodeCompact(models) {
  const lines = ['{']
  const names = Object.keys(models)
  names.forEach((n, i) => {
    const m = models[n]
    const c = {}
    if (m.vars) c.vars = m.vars
    if (m.scale != null) c.scale = m.scale
    if (m.bones) c.bones = m.bones.map((b) => [b.name, b.parent, ...b.position, ...(b.rotation || []), ...opts(b)])
    if (m.parts)
      c.parts = m.parts.map((p) => [p.shape + (p.segments || '') + (p.mirror ? '*' : ''), p.bone, p.color, ...p.position, ...p.size, ...(p.rotation ? ['/', ...p.rotation] : []), ...opts(p)])
    if (m.holds) c.holds = m.holds.map((h) => [h.bone, h.model, ...opts(h)])
    if (m.clips) c.clips = Object.fromEntries(Object.entries(m.clips).map(([k, v]) => [k, [v.duration, v.loop, ...v.channels.map((ch) => [ch.bone, ch.channel, ...ch.keys, ...opts(ch)])]]))
    lines.push(` ${J(n)}: {`)
    const keys = Object.keys(c)
    keys.forEach((k, j) => {
      const end = j < keys.length - 1 ? ',' : ''
      const v = c[k]
      if (Array.isArray(v)) lines.push(`  ${J(k)}: [`, v.map((x) => '   ' + J(x)).join(',\n'), `  ]${end}`)
      else if (k == 'clips') {
        lines.push(`  "clips": {`)
        const cs = Object.entries(v)
        cs.forEach(([cn, [d, loop, ...ch]], q) => lines.push(`   ${J(cn)}: [${d}, ${loop},`, ch.map((x) => '    ' + J(x)).join(',\n') + `]${q < cs.length - 1 ? ',' : ''}`))
        lines.push(`  }${end}`)
      } else lines.push(`  ${J(k)}: ${J(v)}${end}`)
    })
    lines.push(` }${i < names.length - 1 ? ',' : ''}`)
  })
  lines.push('}')
  return lines.join('\n') + '\n'
}
function decodeCompact(text) {
  const models = {}
  for (const [n, c] of Object.entries(JSON.parse(text))) {
    const m = (models[n] = {})
    if (c.vars) m.vars = c.vars
    if (c.scale != null) m.scale = c.scale
    if (c.bones)
      m.bones = c.bones.map((x) => {
        const [a, o] = takeOpts(x)
        const b = { name: a[0], parent: a[1], position: a.slice(2, 5) }
        if (a.length > 5) b.rotation = a.slice(5)
        return { ...b, ...o }
      })
    if (c.parts)
      m.parts = c.parts.map((x) => {
        let [a, o] = takeOpts(x)
        const [, shape, seg, mir] = a[0].match(/^([a-z]+)(\d*)(\*?)$/)
        const s = a.indexOf('/')
        const p = { shape, bone: a[1], color: a[2], position: a.slice(3, 6), size: a.slice(6, s < 0 ? undefined : s) }
        if (s >= 0) p.rotation = a.slice(s + 1)
        if (seg) p.segments = +seg
        if (mir) p.mirror = true
        return { ...p, ...o }
      })
    if (c.holds)
      m.holds = c.holds.map((x) => {
        const [a, o] = takeOpts(x)
        return { bone: a[0], model: a[1], ...o }
      })
    if (c.clips)
      m.clips = Object.fromEntries(
        Object.entries(c.clips).map(([k, [duration, loop, ...chs]]) => [
          k,
          {
            duration,
            loop,
            channels: chs.map((x) => {
              const [a, o] = takeOpts(x)
              return { bone: a[0], channel: a[1], keys: a.slice(2), ...o }
            }),
          },
        ])
      )
  }
  return models
}

// JavaScript calls: one call per DSL statement, the way you'd write the models as code.
const jn = (v) => (typeof v == 'number' ? String(v).replace(/^(-?)0\./, '$1.') : `'${v}'`)
const args = (a) => a.map((v) => (Array.isArray(v) ? `[${v.map(jn).join(', ')}]` : jn(v))).join(', ')
function encodeJS(models) {
  const L = []
  const st = (it, s) => L.push((it.repeat != null ? `repeat(${it.repeat}, '${it.var}'); ` : '') + (it.chance != null ? `chance(${jn(it.chance)}); ` : '') + s)
  for (const [n, m] of Object.entries(models)) {
    if (L.length) L.push('')
    L.push(`model('${n}')`)
    for (const [k, v] of Object.entries(m.vars || {})) L.push(`$(${args([k, v])})`)
    if (m.scale != null) L.push(`scale(${args([m.scale])})`)
    for (const b of m.bones || []) st(b, `bone(${args([b.name, b.parent, ...b.position, ...(b.rotation ? [b.rotation] : [])])})`)
    for (const p of m.parts || []) st(p, `${p.shape}${p.segments || ''}${p.mirror ? 'm' : ''}(${args([p.bone, p.color, ...p.position, ...p.size, ...(p.rotation ? [p.rotation] : [])])})`)
    for (const h of m.holds || []) st(h, `hold(${args([h.bone, h.model])})`)
    for (const [cn, c] of Object.entries(m.clips || {})) {
      L.push(`${c.loop ? 'clip' : 'once'}(${args([cn, c.duration])})`)
      for (const ch of c.channels) st(ch, `key(${args([ch.bone, ch.channel, ...ch.keys])})`)
    }
  }
  return L.join('\n') + '\n'
}
function decodeJS(text) {
  const models = {}
  let m, clip, pend = {}
  const add = (list, it) => (list.push({ ...it, ...pend }), (pend = {}))
  const lib = {
    model: (n) => ((m = models[n] = {}), (clip = null)),
    $: (k, v) => ((m.vars ||= {})[k] = v),
    scale: (v) => (m.scale = v),
    bone: (name, parent, x, y, z, r) => add((m.bones ||= []), { name, parent, position: [x, y, z], ...(r ? { rotation: r } : {}) }),
    hold: (bone, model) => add((m.holds ||= []), { bone, model }),
    clip: (n, d) => ((clip = (m.clips ||= {})[n] = { duration: d, loop: true, channels: [] })),
    once: (n, d) => ((clip = (m.clips ||= {})[n] = { duration: d, loop: false, channels: [] })),
    key: (bone, channel, ...keys) => add(clip.channels, { bone, channel, keys }),
    chance: (p) => (pend.chance = p),
    repeat: (n, v) => Object.assign(pend, { repeat: n, var: v }),
  }
  const shape = (name) => {
    const [, s, seg, mir] = name.match(/^([a-z]+?)(\d*)(m?)$/)
    return (bone, color, x, y, z, ...a) => {
      const r = Array.isArray(a.at(-1)) ? a.pop() : null
      add((m.parts ||= []), { shape: s, bone, color, position: [x, y, z], size: a, ...(r ? { rotation: r } : {}), ...(seg ? { segments: +seg } : {}), ...(mir ? { mirror: true } : {}) })
    }
  }
  const scope = new Proxy({}, { has: (_, k) => typeof k == 'string', get: (_, k) => lib[k] || (SHAPES.includes(String(k).match(/^[a-z]+?(?=\d*m?$)/)?.[0]) ? shape(k) : globalThis[k]) })
  Function('scope', `with (scope) {\n${text}\n}`)(scope)
  return models
}

// YAML: the named-key structure, one flow mapping per statement.
const yn = (v) => String(v).replace(/^(-?)0\./, '$1.')
const ys = (s) =>
  /^[A-Za-z0-9_.][\w.*~|^!+-]*$/.test(s) && !/^[-+]?(\.\d+|\d+\.?\d*)(e[-+]?\d+)?$/i.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) ? s : J(s)
const yv = (v) => (Array.isArray(v) ? `[${v.map(yv).join(', ')}]` : typeof v == 'number' ? yn(v) : typeof v == 'boolean' ? String(v) : ys(v))
const yflow = (o) => `{${Object.entries(o).map(([k, v]) => `${k}: ${yv(v)}`).join(', ')}}`
function encodeYAML(models) {
  const L = []
  for (const [n, m] of Object.entries(models)) {
    L.push(`${ys(n)}:`)
    if (m.vars) L.push('  vars:', ...Object.entries(m.vars).map(([k, v]) => `    ${ys(k)}: ${yv(v)}`))
    if (m.scale != null) L.push(`  scale: ${yv(m.scale)}`)
    for (const k of ['bones', 'parts', 'holds']) if (m[k]) L.push(`  ${k}:`, ...m[k].map((it) => '    - ' + yflow(it)))
    if (m.clips) {
      L.push('  clips:')
      for (const [cn, c] of Object.entries(m.clips))
        L.push(`    ${ys(cn)}:`, `      duration: ${yv(c.duration)}`, `      loop: ${c.loop}`, '      channels:', ...c.channels.map((ch) => '        - ' + yflow(ch)))
    }
  }
  return L.join('\n') + '\n'
}

const CANDIDATES = [
  { key: 'txt', file: 'models.txt', what: 'text DSL (comments stripped)', encode: (m, text) => text.split('\n').map((l) => l.replace(/\s*#.*/, '')).filter((l) => l.trim()).join('\n') + '\n', decode: parse },
  { key: 'compact', file: 'models.compact.json', what: 'JSON, positional array per statement, one per line', encode: encodeCompact, decode: decodeCompact },
  { key: 'min', file: 'models.min.json', what: 'JSON, named keys, minified', encode: (m) => J(m), decode: JSON.parse },
  { key: 'pretty', file: 'models.pretty.json', what: 'JSON, named keys, 2-space indent', encode: (m) => J(m, null, 2) + '\n', decode: JSON.parse },
  { key: 'js', file: 'models.js', what: 'JavaScript, one call per statement', encode: encodeJS, decode: decodeJS },
  { key: 'yaml', file: 'models.yaml', what: 'YAML, named keys, flow mapping per statement', encode: encodeYAML, decode: (t) => YAML.parse(t) },
]

// ---------- fidelity: build every model from the decoded candidate and compare with the original ----------
function fingerprint(text, { library, make } = DSL) {
  const lib = library(text)
  const h = createHash('sha256')
  for (const name of Object.keys(lib)) {
    if (name == 'common') continue
    for (const seed of [1, 2, 3, 7, 42, 1234]) {
      const m = make(lib, name, seed)
      m.root.updateMatrixWorld(true)
      m.root.traverse((o) => {
        h.update(o.matrixWorld.elements.join(','))
        if (o.isMesh) h.update(Buffer.from(o.geometry.attributes.position.array.buffer)).update(Buffer.from(o.geometry.attributes.color.array.buffer))
      })
      h.update(J([Object.keys(m.bones), m.clips, m.vars, Object.keys(m.props)]))
    }
  }
  return h.digest('hex')
}

const src = readFileSync(root + 'tools/formats/models.txt', 'utf8')
const models = parse(src)
const want = fingerprint(src)
let bad = 0
for (const c of CANDIDATES) {
  c.text = c.encode(models, src)
  writeFileSync(out + c.file, c.text)
  const back = c.decode(c.text)
  const same = J(back) == J(models) && fingerprint(toDSL(back)) == want
  c.ok = same
  if (!same) bad++, console.error(`FIDELITY FAIL: ${c.key}`)
}
log(`wrote ${CANDIDATES.length} candidates to dist/formats/ (${Object.keys(models).length} models); fidelity ${bad ? bad + ' FAILED' : 'ok for all'}`)
if (bad) process.exit(1)
// The JSON compilers must build the same models as the DSL compiler, and the game's models.json must be the pretty candidate.
const pretty = CANDIDATES.find((c) => c.key == 'pretty').text
if (fingerprint(CANDIDATES[1].text, COMPACT) != want) console.error('FIDELITY FAIL: tools/formats/compact-compiler.js'), process.exit(1)
if (fingerprint(pretty, GAME) != want) console.error('FIDELITY FAIL: src/compiler.js'), process.exit(1)
if (readFileSync(root + 'src/models.json', 'utf8') != pretty) console.error('src/models.json differs from the pretty candidate (models changed? see docs/json-vs-dsl.md)')
log('src/compiler.js (pretty JSON) and tools/formats/compact-compiler.js build the same models as the DSL compiler')

// ---------- extra rows: compiler + data in one archive (see tools/formats/json-compiler.js) ----------
const read = (f) => readFileSync(root + f, 'utf8')
const T = Object.fromEntries(CANDIDATES.map((c) => [c.key, c.text]))
const extras = [
  { key: 'dsl.js', file: 'dsl.js', what: 'DSL compiler (tools/formats/dsl.js, what the game shipped before)', text: read('tools/formats/dsl.js') },
  { key: 'compact.js', file: 'compact-compiler.js', what: 'the same compiler reading compact JSON', text: read('tools/formats/compact-compiler.js') },
  { key: 'compiler.js', file: 'compiler.js', what: 'the same compiler reading pretty JSON (src/compiler.js, what the game ships)', text: read('src/compiler.js') },
]
extras.push(
  { key: 'dsl.js+txt', file: 'bundle-dsl.txt', what: 'DSL compiler + DSL text, concatenated', text: extras[0].text + '\n' + T.txt },
  { key: 'compact.js+compact', file: 'bundle-compact.txt', what: 'compact compiler + compact JSON, concatenated', text: extras[1].text + '\n' + T.compact },
  { key: 'compiler.js+pretty', file: 'bundle-pretty.txt', what: 'pretty compiler + pretty JSON, concatenated', text: extras[2].text + '\n' + T.pretty }
)
for (const e of extras) writeFileSync(out + e.file, e.text)
const rows = [...CANDIDATES, ...extras]

// ---------- sizes ----------
const gzip = (b) => gzipSync(b, { level: 9 }).length
const brotli = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } }).length
const keyOf = (text, level) => cache + createHash('sha256').update(text).digest('hex').slice(0, 16) + '.' + level
function surprisal(r, level) {
  const k = keyOf(r.text, level)
  if (existsSync(k)) return +readFileSync(k, 'utf8')
  if (!LEVELS.includes(level) || (ONLY && !ONLY.includes(r.key))) return null
  const a = `${out}${r.file}.${level}.13k`
  log(`surprisal -${level} ${r.key} (${r.text.length.toLocaleString()} bytes) ...`)
  const p = spawnSync(SURPRISAL, [`-${level}`, '-f', '-o', a, out + r.file], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (p.status) throw Error(`surprisal failed on ${r.file}`)
  const n = statSync(a).size
  writeFileSync(k, String(n))
  log(`surprisal -${level} ${r.key}: ${n.toLocaleString()} bytes`)
  return n
}
for (const r of rows) {
  r.raw = Buffer.byteLength(r.text)
  r.gz = gzip(r.text)
  r.br = brotli(r.text)
  r.s1 = surprisal(r, 1)
  r.s9 = surprisal(r, 9)
}

const f = (n) => (n == null ? '—' : n.toLocaleString())
const base = rows[0]
const vs = (n, b) => (n == null || b == null ? '' : ` (${n >= b ? '+' : ''}${Math.round((n / b - 1) * 100)}%)`)
const table = [
  '| candidate | raw | gzip -9 | Brotli 11 | surprisal -1 | surprisal -9 |',
  '|---|--:|--:|--:|--:|--:|',
  ...rows.map((r) => `| ${r.key} | ${f(r.raw)} | ${f(r.gz)} | ${f(r.br)} | ${f(r.s1)}${r.key.endsWith('.js') || r.key.includes('+') ? '' : vs(r.s1, base.s1)} | ${f(r.s9)}${r.key.includes('+') || r.key.endsWith('.js') ? '' : vs(r.s9, base.s9)} |`),
].join('\n')
console.log('\n' + table + '\n')
console.log(rows.map((r) => `  ${r.key.padEnd(16)} ${r.what}`).join('\n'))
writeFileSync(out + 'table.md', table + '\n')

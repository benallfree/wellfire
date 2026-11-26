// The js13k baseline: the best-known conventional pipeline, to measure surprisal against.
//   terser (minify + mangle) -> roadroller (context-mixing packer) -> advzip -4 (Zopfli zip)
// Reads dist/index.html (run tools/build.mjs first) and writes dist/roadroller/index.html and dist/roadroller/index.zip.
//   node tools/roadroll.mjs
//   ROADROLLER_O=2 ADVZIP_ITER=1000 node tools/roadroll.mjs
// ROADROLLER_O: roadroller optimization level (0 none, 1 default ~a minute, 2 exhaustive and much slower).
// ADVZIP_ITER: Zopfli iterations for advzip (default 1000).
//
// The page reads the model and score JSON from <script type="application/json"> tags. Here they're inlined into the JS
// as string literals instead, so roadroller packs them together with the code. The `import` lines stay outside the
// packed code: roadroller's output is a direct eval, which still sees the module's imported bindings.
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { minify } from 'terser'
import { Packer } from 'roadroller'

const root = fileURLToPath(new URL('..', import.meta.url))
const t = () => new Date().toTimeString().slice(0, 8)
const log = (s) => console.log(`[${t()}] ${s}`)
const n = (x) => x.toLocaleString()

function fail(msg) {
  console.error(`roadroll: ${msg}`)
  process.exit(1)
}

// Pulls one tag's body out of the built page; fails loudly if the page shape changed.
function cut(html, open, name) {
  const i = html.indexOf(open)
  if (i < 0) fail(`no ${name} block (${open}) in dist/index.html`)
  const s = i + open.length
  const e = html.indexOf('</script>', s)
  return { body: html.slice(s, e), start: i, end: e + '</script>'.length }
}

function replaceOnce(code, from, to, what) {
  const k = code.split(from).length - 1
  if (k !== 1) fail(`expected one ${what} (${from}), found ${k}`)
  return code.replace(from, () => to)
}

export async function roadroll() {
  const level = +(process.env.ROADROLLER_O ?? 1)
  const iter = +(process.env.ADVZIP_ITER ?? 1000)
  const html = readFileSync(root + 'dist/index.html', 'utf8')
  const models = cut(html, '<script type="application/json" id="models">', 'models JSON')
  const score = cut(html, '<script type="application/json" id="score">', 'score JSON')
  const mod = cut(html, '<script type="module">', 'module script')

  // JSON -> minified JSON string literals inside the code
  const lit = (j) => JSON.stringify(JSON.stringify(JSON.parse(j)))
  let code = mod.body
  code = replaceOnce(code, "document.getElementById('models').textContent", lit(models.body), 'models read')
  code = replaceOnce(code, "$('score').textContent", lit(score.body), 'score read')

  log(`terser: ${n(code.length)} bytes of JS (JSON inlined)…`)
  const min = await minify(code, {
    module: true,
    ecma: 2022,
    compress: { passes: 3, unsafe_arrows: true, unsafe_methods: true },
    mangle: true,
  })
  let js = min.code
  // terser hoists the imports to the front; keep them out of the packed code
  const imp = js.match(/^(import[^;]*;)+/)
  if (!imp) fail('no import statements at the start of the minified code')
  const imports = imp[0]
  js = js.slice(imports.length)
  log(`terser: ${n(imports.length + js.length)} bytes`)

  log(`roadroller -O${level}: packing ${n(js.length)} bytes…`)
  const packer = new Packer([{ data: js, type: 'js', action: 'eval' }], {})
  if (level > 0)
    await packer.optimize(level, (info) => {
      const pct = typeof info.passRatio === 'number' ? ` ${(info.passRatio * 100).toFixed(0)}%` : ''
      console.log(`  roadroller pass ${info.pass}${pct}: ${n(info.currentSize)}${info.bestUpdated ? ' <- best' : ''}`)
    })
  const { firstLine, secondLine } = packer.makeDecoder()
  const packed = firstLine + '\n' + secondLine
  log(`roadroller: ${n(packed.length)} bytes`)

  // page shell: the original page minus the JSON tags, with the packed module; whitespace between tags dropped
  const shell = (html.slice(0, models.start) + html.slice(score.end, mod.start)).replace(/>\s+</g, '><').trim()
  const out = shell + '<script type="module">' + imports + packed + '</script>' + html.slice(mod.end).replace(/\s+/g, '')
  const dir = root + 'dist/roadroller/'
  mkdirSync(dir, { recursive: true })
  writeFileSync(dir + 'index.html', out)
  const page = Buffer.byteLength(out)

  log(`advzip -4 -i ${iter}: zipping ${n(page)} bytes…`)
  rmSync(dir + 'index.zip', { force: true })
  const z = spawnSync('advzip', ['-a', '-4', '-i', String(iter), 'index.zip', 'index.html'], { cwd: dir, stdio: 'inherit' })
  if (z.error) fail(z.error.code === 'ENOENT' ? 'advzip not found (brew install advancecomp)' : z.error.message)
  if (z.status !== 0) fail(`advzip failed (exit ${z.status})`)
  const zip = statSync(dir + 'index.zip').size

  const sizes = { raw: Buffer.byteLength(html), terser: imports.length + js.length, roadroller: page, zip }
  log(`dist/roadroller/index.zip: ${n(zip)} bytes, ${((zip / 13312) * 100).toFixed(1)}% of the 13,312-byte budget`)
  return sizes
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await roadroll()

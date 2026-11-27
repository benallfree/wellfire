// Builds dist/index.html: one file holding the game code, the model and music compilers, the model JSON, the score JSON
// and the fonts JSON.
// Comments are dropped on the way (tools/strip.mjs). three.js is loaded from a pinned CDN (see the import map) and is not part of the shipped bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { strip } from './strip.mjs'

// the version and commit this build is from, shown in the corner: <version>-alpha.<commits> · <commit> ('+' for
// uncommitted changes). <version> is package.json's (1.0.0); the alpha number is the commit count on this branch, so
// every deploy from main gets a higher one (CI checks out the full history for it, see .github/workflows/pages.yml)
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
let build = `${version}-alpha · dev`
try {
  const git = (c) => execSync('git ' + c, { encoding: 'utf8' }).trim()
  build = `${version}-alpha.${git('rev-list --count HEAD')} · ${git('rev-parse --short HEAD')}${git('status --porcelain src') ? '+' : ''}`
} catch {}

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
const imports = new Set()
const code = ['compiler.js', 'music.js', 'game.js']
  .map((f) =>
    strip(read(f)) // comments stay in the source and never ship
      .split('\n')
      .filter((l) => {
        if (!l.startsWith('import ')) return true
        if (!l.includes("'./")) imports.add(l)
        return false
      })
      .join('\n')
      .replace(/^export /gm, '')
  )
  .join('\n')
  .replace('BUILD_ID', build)
// fonts.json ships only the glyphs the game can show. The readable font keeps a glyph when its character turns up
// anywhere in the shipped code, page or models (in any case: text is shown in capitals). Village names are built from
// parts in the code and models, so their letters are always kept. The display font keeps only the letters of the
// words the game carves, which are always literals: carve('WELLFIRE', ...).
const fonts = JSON.parse(read('fonts.json'))
const shown = (code + read('index.html') + read('models.json')).toUpperCase()
const carved = [...code.matchAll(/carve\('([^']*)'/g)].map((m) => m[1]).join('')
for (const k in fonts.readable) if (!shown.includes(k)) delete fonts.readable[k]
for (const k in fonts.display) if (!carved.includes(k)) delete fonts.display[k]
const html = read('index.html')
  .replace('<!--MODELS-->', () => read('models.json').trim())
  .replace('<!--FONTS-->', () => JSON.stringify(fonts, null, 2))
  .replace('<!--SCORE-->', () => read('score.json').trim())
  .replace('<!--CODE-->', () => [...imports].join('\n') + '\n' + code.trim()) // functions: no $-patterns
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true })
writeFileSync(new URL('../dist/index.html', import.meta.url), html)
console.log(`built dist/index.html (${html.length.toLocaleString()} bytes; fonts: ${Object.keys(fonts.readable).length} readable glyphs, display ${Object.keys(fonts.display).join('')})`)

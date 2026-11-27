// Builds dist/index.html: one file holding the game code, the model and music compilers, the model JSON and the score JSON.
// Comments are dropped on the way (tools/strip.mjs). three.js is loaded from a pinned CDN (see the import map) and is not part of the shipped bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { strip } from './strip.mjs'

// the commit this build is from (plus '+' for uncommitted changes), shown on the title screen
let build = 'dev'
try {
  build = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() + (execSync('git status --porcelain src', { encoding: 'utf8' }).trim() ? '+' : '')
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
const html = read('index.html')
  .replace('<!--MODELS-->', () => read('models.json').trim())
  .replace('<!--SCORE-->', () => read('score.json').trim())
  .replace('<!--CODE-->', () => [...imports].join('\n') + '\n' + code.trim()) // functions: no $-patterns
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true })
writeFileSync(new URL('../dist/index.html', import.meta.url), html)
console.log(`built dist/index.html (${html.length.toLocaleString()} bytes)`)

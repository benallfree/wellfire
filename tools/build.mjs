// Builds dist/index.html: one file holding the game code, the model compiler and the model JSON.
// three.js is loaded from a pinned CDN (see the import map) and is not part of the shipped bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
const imports = new Set()
const code = ['compiler.js', 'game.js']
  .map((f) =>
    read(f)
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
const html = read('index.html')
  .replace('<!--MODELS-->', () => read('models.json').trim())
  .replace('<!--CODE-->', () => [...imports].join('\n') + '\n' + code.trim()) // functions: no $-patterns
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true })
writeFileSync(new URL('../dist/index.html', import.meta.url), html)
console.log(`built dist/index.html (${html.length.toLocaleString()} bytes)`)

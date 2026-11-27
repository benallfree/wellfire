// Font lab: one master stroke font (polylines on a 5×7 point grid, x 0..4, y 0..6 down, baseline at 6),
// written out in several text formats so surprisal can measure each. Not part of the game.
// Run: node docs/font-lab/make.mjs  (writes the candidates into docs/font-lab/out/)
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = new URL('./out/', import.meta.url)
mkdirSync(dir, { recursive: true })
const write = (name, text) => writeFileSync(new URL(name, dir), text)

// The master: each glyph is a list of strokes, each stroke "x,y x,y ...". Dots are short ticks: canvas skips
// zero-length strokes even with round caps.
const strokes = {
  A: ['0,6 0,1 1,0 3,0 4,1 4,6', '0,3 4,3'],
  B: ['0,6 0,0 3,0 4,1 4,2 3,3 0,3', '3,3 4,4 4,5 3,6 0,6'],
  C: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5'],
  D: ['0,0 3,0 4,1 4,5 3,6 0,6 0,0'],
  E: ['4,0 0,0 0,6 4,6', '0,3 3,3'],
  F: ['4,0 0,0 0,6', '0,3 3,3'],
  G: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3'],
  H: ['0,0 0,6', '4,0 4,6', '0,3 4,3'],
  I: ['1,0 3,0', '2,0 2,6', '1,6 3,6'],
  J: ['2,0 4,0', '3,0 3,5 2,6 1,6 0,5'],
  K: ['0,0 0,6', '4,0 0,4', '1,3 4,6'],
  L: ['0,0 0,6 4,6'],
  M: ['0,6 0,0 2,2 4,0 4,6'],
  N: ['0,6 0,0 4,6 4,0'],
  O: ['1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0'],
  P: ['0,6 0,0 3,0 4,1 4,2 3,3 0,3'],
  Q: ['1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0', '2,4 4,6'],
  R: ['0,6 0,0 3,0 4,1 4,2 3,3 0,3', '2,3 4,6'],
  S: ['4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5'],
  T: ['0,0 4,0', '2,0 2,6'],
  U: ['0,0 0,5 1,6 3,6 4,5 4,0'],
  V: ['0,0 0,3 2,6 4,3 4,0'],
  W: ['0,0 0,6 2,4 4,6 4,0'],
  X: ['0,0 0,1 4,5 4,6', '4,0 4,1 0,5 0,6'],
  Y: ['0,0 2,3 4,0', '2,3 2,6'],
  Z: ['0,0 4,0 4,1 0,5 0,6 4,6'],
  0: ['1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0', '0,5 4,1'],
  1: ['1,1 2,0 2,6', '1,6 3,6'],
  2: ['0,1 1,0 3,0 4,1 4,2 0,6 4,6'],
  3: ['0,1 1,0 3,0 4,1 4,2 3,3 4,4 4,5 3,6 1,6 0,5', '1,3 3,3'],
  4: ['3,6 3,0 0,4 4,4'],
  5: ['4,0 0,0 0,3 3,3 4,4 4,5 3,6 1,6 0,5'],
  6: ['3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3'],
  7: ['0,0 4,0 4,1 1,4 1,6'],
  8: ['1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3'],
  9: ['4,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 1,6'],
  '.': ['2,5 2,6'],
  ',': ['2,5 1,6'],
  '!': ['2,0 2,3', '2,5 2,6'],
  '?': ['0,1 1,0 3,0 4,1 4,2 2,3', '2,5 2,6'],
  ':': ['2,1 2,2', '2,5 2,6'],
  "'": ['2,0 2,1'],
  '-': ['1,3 3,3'],
  '/': ['0,6 4,0'],
  '+': ['2,1 2,5', '0,3 4,3'],
}
const keys = Object.keys(strokes).sort((a, b) => order(a) - order(b))
function order(k) {
  const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?:\'-/+'
  return all.indexOf(k)
}
const pts = (s) => s.split(' ').map((p) => p.split(',').map(Number))
const each = (f) => Object.fromEntries(keys.map((k) => [k, f(strokes[k], k)]))
const pretty = (o) => JSON.stringify(o, null, 2) + '\n'

// 1. Grid strokes: the master as is.
write('strokes.json', pretty(each((s) => s)))

// 2. SVG path data, one string per glyph, absolute M/L with H/V where a segment is straight across or down.
write(
  'svg.json',
  pretty(
    each((s) =>
      s
        .map((st) => {
          const p = pts(st)
          return p
            .map(([x, y], i) => {
              if (!i) return `M${x} ${y}`
              const [px, py] = p[i - 1]
              if (y === py && x !== px) return `H${x}`
              if (x === px && y !== py) return `V${y}`
              if (x === px && y === py) return 'h0'
              return `L${x} ${y}`
            })
            .join('')
        })
        .join(''),
    ),
  ),
)

// 3. Hershey-style nested coordinate arrays, pretty-printed (every number on its own line).
write('hershey.json', pretty(each((s) => s.map(pts))))

// 4. Grid points named like chess squares: columns a-e, rows 0-6.
write('chess.json', pretty(each((s) => s.map((st) => pts(st).map(([x, y]) => 'abcde'[x] + y).join(' ')))))

// 5. Bitmap, 5×7, rasterised from the strokes (Bresenham), rows of # and .
const bitmap = each((s) => {
  const g = [...Array(7)].map(() => [...'.....'])
  for (const st of s) {
    const p = pts(st)
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i]
      const [x0, y0] = p[i ? i - 1 : 0]
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
      for (let t = 0; t <= n; t++) g[Math.round(y0 + ((y1 - y0) * t) / n)][Math.round(x0 + ((x1 - x0) * t) / n)] = '#'
    }
  }
  return g.map((r) => r.join(''))
})
write('bitmap.json', pretty(bitmap))
write('bitmap-space.json', pretty(each((s, k) => bitmap[k].map((r) => r.replace(/\./g, ' ')))))
write('bitmap-01.json', pretty(each((s, k) => bitmap[k].map((r) => r.replace(/\./g, '0').replace(/#/g, '1')))))

// 6. 14-segment display (plus a dot): segment table, then each glyph as segment names.
const segments = {
  a: '0,0 4,0', b: '4,0 4,3', c: '4,3 4,6', d: '0,6 4,6', e: '0,3 0,6', f: '0,0 0,3',
  g1: '0,3 2,3', g2: '2,3 4,3', h: '0,0 2,3', i: '2,0 2,3', j: '4,0 2,3', k: '0,6 2,3',
  l: '2,3 2,6', m: '4,6 2,3', dp: '2,5 2,6',
}
const seg = {
  A: 'a b c e f g1 g2', B: 'a b c d g2 i l', C: 'a d e f', D: 'a b c d i l', E: 'a d e f g1', F: 'a e f g1',
  G: 'a c d e f g2', H: 'b c e f g1 g2', I: 'a d i l', J: 'b c d e', K: 'e f g1 j m', L: 'd e f',
  M: 'b c e f h j', N: 'b c e f h m', O: 'a b c d e f', P: 'a b e f g1 g2', Q: 'a b c d e f m',
  R: 'a b e f g1 g2 m', S: 'a c d f g1 g2', T: 'a i l', U: 'b c d e f', V: 'e f j k', W: 'b c e f k m',
  X: 'h j k m', Y: 'h j l', Z: 'a d j k',
  0: 'a b c d e f j k', 1: 'b c', 2: 'a b d e g1 g2', 3: 'a b c d g2', 4: 'b c f g1 g2', 5: 'a c d f g1 g2',
  6: 'a c d e f g1 g2', 7: 'a b c', 8: 'a b c d e f g1 g2', 9: 'a b c d f g1 g2',
  '.': 'dp', ',': 'k', '!': 'i dp', '?': 'a b g2 l', ':': 'i dp', "'": 'i', '-': 'g1 g2', '/': 'j k', '+': 'g1 g2 i l',
}
write('segments.json', pretty({ segments, glyphs: Object.fromEntries(keys.map((k) => [k, seg[k]])) }))

// Expanded strokes for the segment font, so the preview can draw it with the same code.
const segStrokes = Object.fromEntries(keys.map((k) => [k, seg[k].split(' ').map((n) => segments[n])]))
write('preview-data.js', `window.FONTS = ${JSON.stringify({ strokes, segments: segStrokes, bitmap })}\n`)
console.log('wrote', keys.length, 'glyphs')

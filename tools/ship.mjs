// Builds the game, packs the js13k baseline (terser -> roadroller -> advzip, tools/roadroll.mjs), then compresses
// with surprisal at -3 (--compare), the level the size history is measured at, and compares the two.
//   npm run ship                      build, baseline, surprisal
//   npm run ship -- --baseline        build and baseline only (no surprisal; also `npm run baseline`)
//   SURPRISAL=/path/to/surprisal npm run ship
// Output streams straight through (stdio inherit): surprisal's progress line and the --compare table show live.
// Writes dist/index.13k (overwritten each run) and dist/roadroller/, and prints sizes against the 13,312-byte budget.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { roadroll } from './roadroll.mjs'

const SURPRISAL = process.env.SURPRISAL || '/Volumes/Code/repos/surprisal/bin/surprisal'
const BUDGET = 13312
const root = fileURLToPath(new URL('..', import.meta.url))
const input = 'dist/index.html'
const out = 'dist/index.13k'
const baselineOnly = process.argv.includes('--baseline')

// A bare name (e.g. "surprisal") is looked up on PATH by spawn; a path must exist.
if (!baselineOnly && SURPRISAL.includes('/') && !existsSync(SURPRISAL)) {
  console.error(`surprisal not found at ${SURPRISAL}. Build it, or set SURPRISAL=/path/to/surprisal.`)
  process.exit(1)
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.error) {
    console.error(r.error.code === 'ENOENT' ? `${cmd}: not found. Set SURPRISAL=/path/to/surprisal.` : r.error.message)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`${cmd} failed (${r.signal || 'exit ' + r.status})`)
    process.exit(r.status || 1)
  }
}

const t = () => new Date().toTimeString().slice(0, 8)
const row = (name, size) =>
  `  ${name.padEnd(34)}${size.toLocaleString().padStart(8)}  ${((size / BUDGET) * 100).toFixed(1).padStart(5)}%  ${(BUDGET - size).toLocaleString().padStart(7)} left`

console.log(`[${t()}] building…`)
run(process.execPath, ['tools/build.mjs'])

console.log(`[${t()}] baseline: terser -> roadroller -> advzip…`)
const base = await roadroll()

let size
if (!baselineOnly) {
  const args = ['-3', '--compare', '-f', '-o', out, input]
  console.log(`[${t()}] compressing at -3 (--compare)…  ${SURPRISAL} ${args.join(' ')}`)
  rmSync(root + out, { force: true }) // never report a stale archive
  run(SURPRISAL, args)
  if (!existsSync(root + out)) {
    console.error(`${out} was not written`)
    process.exit(1)
  }
  size = statSync(root + out).size
}

console.log(`\n[${t()}] against the ${BUDGET.toLocaleString()}-byte budget:`)
console.log(row('terser + roadroller + advzip (zip)', base.zip))
if (size !== undefined) {
  console.log(row('surprisal -3 (dist/index.13k)', size))
  const d = base.zip - size
  console.log(`  surprisal is ${Math.abs(d).toLocaleString()} bytes ${d >= 0 ? 'smaller' : 'larger'} (${((size / base.zip) * 100).toFixed(1)}% of the baseline)`)
}

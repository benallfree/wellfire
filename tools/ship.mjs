// Builds the game and compresses it with surprisal at -3 (--compare), the level the size history is measured at.
//   npm run ship
//   SURPRISAL=/path/to/surprisal npm run ship
// Output streams straight through (stdio inherit): surprisal's progress line and the --compare table show live.
// Writes dist/index.13k (overwritten each run) and prints its size against the 13,312-byte budget.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SURPRISAL = process.env.SURPRISAL || '/Volumes/Code/repos/surprisal/bin/surprisal'
const BUDGET = 13312
const root = fileURLToPath(new URL('..', import.meta.url))
const input = 'dist/index.html'
const out = 'dist/index.13k'

// A bare name (e.g. "surprisal") is looked up on PATH by spawn; a path must exist.
if (SURPRISAL.includes('/') && !existsSync(SURPRISAL)) {
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

console.log(`[${t()}] building…`)
run(process.execPath, ['tools/build.mjs'])

const args = ['-3', '--compare', '-f', '-o', out, input]
console.log(`[${t()}] compressing at -3 (--compare)…  ${SURPRISAL} ${args.join(' ')}`)
rmSync(root + out, { force: true }) // never report a stale archive
run(SURPRISAL, args)

if (!existsSync(root + out)) {
  console.error(`${out} was not written`)
  process.exit(1)
}
const size = statSync(root + out).size
const pct = ((size / BUDGET) * 100).toFixed(1)
console.log(
  `[${t()}] ${out}: ${size.toLocaleString()} bytes, ${pct}% of the ${BUDGET.toLocaleString()}-byte budget (${(BUDGET - size).toLocaleString()} left)`
)

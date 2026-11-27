// Finds the lowest surprisal level, from the saved one up, at which the build fits the budget with headroom, and saves it.
//   npm run fit              build once, compress at package.json "size".level; while the archive is over
//                            budget - headroom, step up one level (to -9 at most). Saves the first level that fits.
//   npm run fit -- --down    also, when the saved level fits, step down while lower levels still fit, and save the
//                            lowest that does (faster ships once features are trimmed).
//   SURPRISAL=/path/to/surprisal npm run fit
// Settings live in package.json: "size": { "level": 6, "headroom": 200, "budget": 13312 }.
// Each level writes dist/fit/index-N.13k; the chosen one is copied to dist/index.13k. No roadroller baseline here
// (`npm run ship` still packs it). Surprisal's output streams straight through.
// Each level runs with --stop-at=<budget - headroom>: surprisal gives up (exit 3, no archive) as soon as the archive
// is certain to be over the limit, so an over-budget level costs only the part it took to get there. It never stops
// a level that would fit. A surprisal without --stop-at runs every level to the end.
// If even -9 doesn't fit, package.json is left alone and the exit code is 1.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SURPRISAL = process.env.SURPRISAL || '/Volumes/Code/repos/surprisal/bin/surprisal'
const root = fileURLToPath(new URL('..', import.meta.url))
const pkgPath = root + 'package.json'
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const cfg = pkg.size || {}
const BUDGET = cfg.budget ?? 13312
const HEADROOM = cfg.headroom ?? 200
const LIMIT = BUDGET - HEADROOM
const saved = cfg.level ?? 3
const down = process.argv.includes('--down') || !!process.env.npm_config_down
const input = 'dist/index.html'
const out = 'dist/index.13k'

if (SURPRISAL.includes('/') && !existsSync(SURPRISAL)) {
  console.error(`surprisal not found at ${SURPRISAL}. Build it, or set SURPRISAL=/path/to/surprisal.`)
  process.exit(1)
}

const t = () => new Date().toTimeString().slice(0, 8)

// An older surprisal has no --stop-at (its help doesn't mention it); then every level runs to the end.
const help = spawnSync(SURPRISAL, ['-h'], { encoding: 'utf8' })
const STOP_AT = `${help.stdout}${help.stderr}`.includes('stop-at')
const OVER = 3 // surprisal's exit status when --stop-at's limit is exceeded

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

// runSurprisal runs surprisal with its output streaming through; stderr is also kept, for --stop-at's message.
function runSurprisal(args) {
  return new Promise((resolve) => {
    const p = spawn(SURPRISAL, args, { cwd: root, stdio: ['inherit', 'inherit', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => {
      process.stderr.write(d)
      err = (err + d).slice(-4000)
    })
    p.on('error', (e) => {
      console.error(e.code === 'ENOENT' ? `${SURPRISAL}: not found. Set SURPRISAL=/path/to/surprisal.` : e.message)
      process.exit(1)
    })
    p.on('close', (status, signal) => resolve({ status, signal, err }))
  })
}

const tried = [] // { level, size, secs, stopped? }
async function tryLevel(level) {
  const file = `dist/fit/index-${level}.13k`
  const args = [`-${level}`, '-f', ...(STOP_AT ? [`--stop-at=${LIMIT}`] : []), '-o', file, input]
  console.log(`\n[${t()}] compressing at -${level}…  ${SURPRISAL} ${args.join(' ')}`)
  rmSync(root + file, { force: true }) // never report a stale archive
  const t0 = Date.now()
  const res = await runSurprisal(args)
  if (STOP_AT && res.status === OVER) {
    // "the archive will be at least N bytes, over the L-byte limit (stopped at D/T tokens)", or at the very end
    // "the archive is N bytes, over ..."
    const m = res.err.match(/(?:at least|is) (\d+) bytes, over/)
    const at = res.err.match(/stopped at (\d+\/\d+) tokens/)
    const r = { level, size: m ? +m[1] : LIMIT + 1, secs: (Date.now() - t0) / 1000, stopped: at ? at[1] : '' }
    tried.push(r)
    console.log(`[${t()}] -${level}: over (at least ${r.size.toLocaleString()} bytes${r.stopped ? `, stopped at ${r.stopped} tokens` : ''}; limit ${LIMIT.toLocaleString()})`)
    return false
  }
  if (res.status !== 0) {
    console.error(`${SURPRISAL} failed (${res.signal || 'exit ' + res.status})`)
    process.exit(res.status || 1)
  }
  if (!existsSync(root + file)) {
    console.error(`${file} was not written`)
    process.exit(1)
  }
  const r = { level, size: statSync(root + file).size, secs: (Date.now() - t0) / 1000, file }
  tried.push(r)
  const fits = r.size <= LIMIT
  console.log(`[${t()}] -${level}: ${r.size.toLocaleString()} bytes, ${fits ? 'fits' : 'over'} (limit ${LIMIT.toLocaleString()})`)
  return fits
}

console.log(`[${t()}] saved level -${saved}, budget ${BUDGET.toLocaleString()}, headroom ${HEADROOM}: fit at or under ${LIMIT.toLocaleString()} bytes${down ? ' (--down)' : ''}`)
if (!STOP_AT) console.log(`[${t()}] ${SURPRISAL} has no --stop-at: over-budget levels run to the end`)
console.log(`[${t()}] building…`)
run(process.execPath, ['tools/build.mjs'])
mkdirSync(root + 'dist/fit', { recursive: true })

let chosen
if (await tryLevel(saved)) {
  chosen = saved
  if (down) for (let l = saved - 1; l >= 0 && (await tryLevel(l)); l--) chosen = l
} else {
  for (let l = saved + 1; l <= 9; l++) if (await tryLevel(l)) { chosen = l; break }
}

const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`)
console.log(`\n[${t()}] levels tried (budget ${BUDGET.toLocaleString()}, limit ${LIMIT.toLocaleString()} with ${HEADROOM} headroom):`)
console.log(`  level    bytes  of budget     left    time`)
for (const r of [...tried].sort((a, b) => a.level - b.level))
  console.log(
    `  ${('-' + r.level).padEnd(5)}${((r.stopped !== undefined ? '≥' : '') + r.size.toLocaleString()).padStart(9)}  ${((r.size / BUDGET) * 100).toFixed(1).padStart(8)}%  ${(BUDGET - r.size).toLocaleString().padStart(7)}  ${fmtTime(r.secs).padStart(6)}  ${r.size <= LIMIT ? 'fits' : 'over'}${r.stopped ? ` (stopped at ${r.stopped} tokens)` : ''}${r.level === chosen ? '  <- chosen' : ''}`,
  )

if (chosen === undefined) {
  console.error(`\nNo level up to -9 fits ${LIMIT.toLocaleString()} bytes. package.json left at -${saved}.`)
  process.exit(1)
}

copyFileSync(root + `dist/fit/index-${chosen}.13k`, root + out)
if (chosen === saved) {
  console.log(`\nSaved level -${saved} still fits; package.json unchanged. ${out} is the -${chosen} archive.`)
} else {
  pkg.size = { ...cfg, level: chosen }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`\nSaved level -${saved} -> -${chosen} in package.json. ${out} is the -${chosen} archive.`)
}

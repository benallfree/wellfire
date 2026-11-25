# Shrinking game.js under surprisal: refactors vs stripping

**Question.** `main` at fa730b1 was 13,503 bytes at surprisal -1, 191 over the 13,312 budget, and `src/game.js` is
the biggest share. Can source refactors of `game.js` win that back without dropping features?

**Answer.** No, not meaningfully. Refactors that dedupe code into helpers or golf names make surprisal output
*bigger*. Moving data tables into `models.json` breaks about even. Removing comments is what pays: dropping them from
`game.js` alone saves 2,428 bytes, about 13 times the overage. The build now strips comments (`tools/strip.mjs`) and
the source keeps them.

## How it was measured

- surprisal level 1 (`surprisal -1 -f`), the same binary as the size history (`.cache/surprisal` in the
  surprisal-3d-warrior-2 worktree). It is deterministic, so a one-byte difference is real.
- Every row is `src/game.js` alone, so each run takes about 3 minutes instead of 9. The baseline is `main` fa730b1:
  81,587 raw, **7,388** compressed. That is 0.091 compressed bytes per raw byte, about 55% of the 13,503 full build.
- Refactor rows are cumulative snapshots (each commit measured on top of the ones before), so "Δ" is that commit's
  own change. The golf and stripping rows are each applied alone to the baseline.
- "per KB" is compressed bytes saved per 1,000 raw bytes removed: positive is good, negative means the change cost
  bytes.

## Results

| # | change | raw Δ | compressed Δ | per KB |
|---|---|---:|---:|---:|
| R1 | monster hp/run/dmg maps → each kind's `vars` in models.json | −139 | −13 | 94 |
| R2 | `wrap()` for 5 angle wraps | −142 | +1 | −7 |
| R3 | `clamp()` for 16 `Math.max(Math.min())` pairs | −175 | +7 | −40 |
| R4 | `cut()`/`toss()` list removal, `Actor.free()` disposal | −178 | +24 | −135 |
| R5 | `strike()`: one cone hit for the swing and a mount's attack | −386 | +1 | −3 |
| R6 | gold through `kept()`/`keep()`; `live()` chunk test | −95 | +1 | −11 |
| R7 | `Actor.fade()` dying shrink; `fill()`/`life()` bars | −75 | +14 | −187 |
| R8 | per-region tables (FOES, CROWD, FLORA, MOUNTS, PAY, REGIONS) and name syllables → `world` in models.json | −845 | −92 | 109 |
| G1 | golf: `const { sin, cos, … } = Math`, drop every `Math.` | −1,371 | **+58** | −42 |
| G2 | golf: `player` → `P` (237 uses) | −1,185 | **+20** | −17 |
| D | drop the debug `window.game` block at the end | −528 | −58 | 110 |
| S | **strip comments only** (whitespace and names kept) | −16,055 | **−2,428** | 151 |
| T | Terser, no compress, no mangle, one line, no comments | −31,517 | −1,841 | 58 |

The data moves have a second half: the JSON they add. `models.json` on its own measured 2,842 at `main` and 2,947
with R1 + R8 plus a since-dropped `arc` var (+2,071 raw, **+105**). That is about 0.05 per byte, four times the 0.013
fitted from the size history. That figure came from model geometry, which is very repetitive; a fresh table of
numbers and names costs nearly what it costs as code. **R1 + R8 net out at roughly zero** (−105 in JS, about +100 in
JSON).

## What the compressor rewards

Surprisal charges for what the language model can't predict. That explains every row:

- **Helpers don't pay (R2–R7, +48 together).** After the first `Math.atan2(Math.sin(a), Math.cos(a))` the model
  predicts the next one almost for free, so collapsing five of them saves nearly nothing. The new helper's name and
  definition are fresh tokens, so they cost something. Every helper refactor came out between 0 and +24.
- **Golfing is worse (G1, G2).** `Math.hypot` and `player` are what the model expects to see; `hypot` alone or `P`
  is less likely, so each use costs a little more. Fewer raw bytes, more compressed bytes.
- **Unpredictable content pays (D, S).** A list of names (the debug block) or English prose (comments) is high
  information. Each comment is information the model has to be told, at about 151 compressed bytes per KB, the best
  rate measured.
- **Whitespace is nearly free and helps (S vs T).** Collapsing the code to one line after stripping comments made
  it 587 bytes *worse* than stripping alone (5,547 vs 4,960): normal line breaks and indentation help the model
  predict.

So the hypothesis in the brief holds strongly: readable, idiomatic code compresses better than golfed code under
surprisal. Don't minify, mangle or golf, and don't refactor for size.

## What changed on this branch

1. **R1** and **R8**: the data tables moved to models.json (pretty JSON, named keys, a `world` entry with one object
   per region). Net size effect is about zero. They are kept because the tables are easier to edit there, but
   dropping them would cost nothing either.
2. **R2–R7 not kept.** They are on `claude/gamejs-refactor-helpers-measured` (with their revert) for reference.
3. **Build-time comment stripping.** `tools/strip.mjs` removes `//` and `/* */` comments from `compiler.js`,
   `music.js` and `game.js` on the way into `dist/index.html`. It understands strings, template literals (with
   `${}` nesting) and regex literals. A line that held only a comment goes; a trailing comment is cut with the spaces
   before it; nothing else changes. Checked with acorn: each file's AST is identical before and after, with 0
   comments left. On current `main` sources it removes 16.5 KB from game.js, 3.9 KB from music.js and 1.5 KB from
   compiler.js. The built page goes from 243,111 to 222,265 bytes raw (compressed size not measured).

Played in the browser on the stripped build: walk, sword hits, ride a steed and its attack, enter and leave a house,
chop a tree for +3 wood, light the torch, swim (breath drains), back ashore, launch, board and row the boat. No
console errors. Village, region, monsters and mounts match `main` for the same seed.

## Not measured

Size runs were stopped on Ben's instruction before these finished, so they are **not measured**:

- **The full build.** Neither `main` c29bd93 nor this branch's `dist/index.html` has a surprisal -1 number. That
  means the check that game.js-alone deltas track full-build deltas was never done either.
- **The final branch's game.js**, raw and comment-stripped (whether the leftover data moves stack with stripping).
- **Terser** with compress, with compress and mangle, and the two beautified variants. Only the no-compress,
  no-mangle one-line variant (row T) was measured.
- **`models.json` without the dropped `arc` var.** The +105 above includes it, about 50 raw bytes.

**Estimate only:** game.js stripping saves about 2,430. Comments in music.js and compiler.js are another 5.4 KB raw,
about 800 more at the same rate. So the full build should lose about **3,200 bytes**, from roughly 13,850 on current
`main` (fa730b1's 13,503 plus dark-nights) to about 10,600, around 80% of the budget. To measure, when asked:

```bash
node tools/build.mjs
/Volumes/Code/repos/worktrees/surprisal-3d-warrior/surprisal-3d-warrior-2-0e50b0/.cache/surprisal -1 -f -o /tmp/warrior.13k dist/index.html
```

## Verdict and next steps

- **Refactoring frees about nothing.** The best case is ±10 bytes once the JSON side is counted. Bytes per KB of raw
  removed ranges from −187 to +109, against +151 for deleting comments. Refactor for clarity, never for size.
- **Comment stripping replaces refactoring rather than stacking with it.** It is the single big win, and it now
  runs in the build. Minification works against it under surprisal: whitespace collapse measured worse than
  stripping alone. Terser's compress and mangle modes were not measured, but the golf rows (renaming made it worse)
  point the same way for mangling.
- **The debug block is the next cheap win: about 58 bytes.** Keep `window.game` in the source for play-testing, but
  give the build a way to leave it out of the shipped page (for example, a ship build that drops a marked tail of
  game.js, while `npm start` keeps it).
- **Comments are now free to write.** Since they no longer ship, there's no pressure to trim them.
- **New data belongs where it reads best.** It costs about the same as JSON or as JS.

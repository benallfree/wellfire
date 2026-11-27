# Writing for surprisal: what the measurements say

surprisal is an LLM compressor (a small code model, qwen2.5-coder 0.5B at the levels used here, driving an arithmetic
coder). Its output size is roughly the sum, over every token, of how surprised the model was. That one fact explains
every result below: **predictable text is cheap, fresh information is expensive, and raw byte count barely matters.**

Levels: `-0` to `-9`; higher is slower and smaller. Wellfire ships at whatever level fits (`-6` lately). `-1` is the
quick level for comparisons; it's deterministic, so a one-byte difference between two runs is real. Relative
differences roughly carry across levels (estimate: Wellfire's -6 size is about 0.76 of its -1 size, so scale a -1
delta by about that much).

## Cost per raw byte (rules of thumb)

| content | compressed bytes per raw byte |
|---|---:|
| repetitive pretty-JSON model geometry | ~0.013 |
| model JSON overall (`models.json` packs ~97%) | ~0.02 |
| fresh JSON tables of numbers and names | ~0.05 |
| whole shipped build, comments stripped | ~0.05-0.06 |
| new feature code | ~0.07 |
| game JS with comments | ~0.09 |
| plain JS (older fit) | ~0.12 |
| **identifier plumbing** (hook objects, parameter lists, destructured returns) | **~0.15** |
| **comments** (what stripping saves) | **~0.15** |

Use these to estimate a change from its raw delta. Write the raw delta and the estimate in the commit message, labelled
as an estimate.

## What helped

| change | effect | why |
|---|---|---|
| strip comments at build time (source keeps them) | **−2,428** on game.js alone at -1 (7,388 → 4,960) | comments are English prose, the highest-information text there is |
| drop the debug `window.game` block from the shipped page | −58 | a list of names is high-information |
| pretty JSON models instead of a custom line DSL | ~10% smaller, despite 7× bigger raw | keys tell the model what each number is; JSON syntax is nearly free |
| pretty JSON score instead of a line-based music format | 392 → 265 (score alone, -1), 60% bigger raw | same |
| text models instead of meshes | 11 characters and props: 5.1 KB text → 916 bytes (old DSL, early -1) | a generator yields endless seeded variants; binary is unpredictable |
| leaning on three.js from a CDN | the compiler is ~230 lines | primitives, lathe, extrude, merge, instancing come free and don't count |

## What hurt or did nothing

| change | raw | compressed | per KB removed |
|---|---:|---:|---:|
| `const { sin, cos, … } = Math`, drop every `Math.` | −1,371 | **+58** | −42 |
| rename `player` → `P` (237 uses) | −1,185 | **+20** | −17 |
| `wrap()` helper for 5 angle wraps | −142 | +1 | −7 |
| `clamp()` for 16 `Math.max(Math.min())` pairs | −175 | +7 | −40 |
| list-removal and disposal helpers | −178 | +24 | −135 |
| `strike()`: one cone hit for swing and mount attack | −386 | +1 | −3 |
| six helper refactors together | | **+48** | |
| move per-region tables into models.json | −845 JS | −92 JS, ~+100 JSON | ~0 net |
| Terser, no compress, no mangle, one line (after stripping) | | 587 worse than stripping alone | |
| engine split behind factory APIs (4 modules) | +791 | **+115** | |
| engine split, fragment style (no plumbing) | +95 | **+58** | |

Why: after the first `Math.atan2(Math.sin(a), Math.cos(a))` the model predicts the next one almost free, so a helper
saves nothing and its new name costs something. `hypot` alone or `P` is less likely than `Math.hypot` or `player`, so
each use costs a little more. Line breaks and indentation help prediction, so collapsing them hurts.

## Rules

Do:

- **Readable, idiomatic code with real names.** What the model expects is what's cheap.
- **Comments everywhere; strip them in the build.** Free to write, ~0.15/byte saved by stripping.
- **Pretty JSON with descriptive keys for all data**: models, levels, music, dialog, tuning, item tables. Small
  expressions inside strings are fine (`".25*h"`, `"a~b"`, `"a|b"`, `"{.9+.6*h}"`).
- **Normal whitespace.** Don't collapse lines.
- **Generators over data**: a seeded block that yields many variants beats many stored variants.
- **Keep code near its use.** Moving it away costs even without plumbing.
- **Leave debug-only code out of the ship build** if you can mark it cleanly.
- **Spend the budget on content.** Choose features; cutting a feature is the only big lever (rough costs: a big
  rigged creature ~9-11 KB JSON ≈ 150-250 bytes; a feature's code at ~0.07/byte).

Don't:

- **Minify, mangle, golf, or rename for brevity.**
- **Refactor for size.** Dedup into helpers comes out between −13 and +24 per change. Refactor only for clarity.
- **Invent compact DSLs or positional arrays.** They win under zip by 15-40% and lose under surprisal.
- **Expect moving tables between JS and JSON to save bytes.** Fresh numbers and names cost ~0.05/byte either way.
- **Split into reusable modules with factory APIs** for the shipped page (+0.15/byte of plumbing).
- **Optimize the same file for zip and surprisal at once.** Pretty JSON pushed gzip over 13,312 while shrinking
  surprisal. Pick the measure.

## Context and scale

- Context length barely matters: across 197 js13k entries, a 2K-token and a 32K-token window differed by about 2%
  (root `docs/nollama/compression-dials.md`, via root `docs/surprisal/best-practices.md`).
- The whole game packed 90.7% at 32 KB raw and 95% at 275 KB raw (2026-11-26, root `docs/surprisal/best-practices.md`): the bigger and more regular the build, the better
  the ratio. Early "assume ~90% saved" was the working estimate; use the table above instead.
- Repetition is cheap: the second creature costs far less than the first, the fifth clip less than the second.

## Measuring

- **Measure only when asked**, at the level asked. A size run takes minutes: on 2026-11-27 a -1 run on the 295 KB
  page took ~1.5-3 min on an M1 Max with the GPU free (`docs/refactor-size.md` reported ~9 min for the full build at
  -1 with an older binary); much longer when other runs share the GPU; -6 several minutes; -9 far longer.
- **Never pipe surprisal's output** through `tail`, `head` or `grep`: it hides the progress line, so stuck and working
  look the same. Run it in a visible terminal and let it stream.
- **Compare like with like.** Build both pages, run the same binary and level on each:
  `surprisal -1 -f -o out.13k dist/index.html`. Quote raw bytes too.
- **One file alone is faster** than the whole page for A/B tests of one file, but deltas on a file alone don't always
  match full-build deltas; confirm big decisions on the full page.
- Record results with the commit, the level and the date. Mark anything not measured as an estimate.

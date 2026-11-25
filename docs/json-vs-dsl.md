# JSON vs. the text DSL under surprisal

**Question:** the models started as a custom line-based DSL (`box chest cloth 0 .27 0 .46 .55 .28`). Would JSON pack
smaller under [surprisal](https://github.com/benallfree/surprisal), because a language model knows JSON so well?

**Answer: yes.** Pretty-printed JSON (`JSON.stringify(models, null, 2)`) packs about 10% smaller than the DSL, even
though it is seven times bigger raw. With the compiler included, the JSON bundle is 170 bytes (9.4%) smaller. The game
now ships `src/models.json` and `src/compiler.js`. The old DSL and its compiler live on in `tools/formats/` as the
baseline.

## Results

Measured on the models as of commit dd58400, before the sword and axe grip fix (a few lines changed; rerun
`npm run formats` for current numbers). Surprisal level 1 (0.5B model) on every row. Level 9 (7B model) only for the two rows that finished before the run was
stopped. Every form carries exactly the same models; comments are stripped from the DSL so it isn't penalized for
something JSON can't hold.

| candidate | raw | gzip -9 | Brotli 11 | surprisal -1 | surprisal -9 |
|---|--:|--:|--:|--:|--:|
| DSL text (`txt`) | 5,791 | 2,225 | 2,036 | 1,064 | 889 |
| JSON, positional array per statement, one per line (`compact`) | 9,563 | 2,609 | 2,335 | 1,004 (−6%) | 871 (−2%) |
| JSON, named keys, minified (`min`) | 15,743 | 2,913 | 2,559 | 994 (−7%) | — |
| **JSON, named keys, 2-space indent (`pretty`)** | 41,959 | 3,365 | 2,898 | **962 (−10%)** | — |
| JavaScript, one call per statement (`js`) | 8,697 | 2,492 | 2,251 | 1,008 (−5%) | — |
| YAML, named keys, flow mapping per statement (`yaml`) | 16,480 | 2,911 | 2,558 | 975 (−8%) | — |

Compiler and models in one archive (each compiler builds the same models from its own format):

| bundle | raw | gzip -9 | Brotli 11 | surprisal -1 |
|---|--:|--:|--:|--:|
| DSL compiler alone (`tools/formats/dsl.js`) | 8,991 | 3,726 | 3,336 | 761 |
| compact-JSON compiler alone (`tools/formats/compact-compiler.js`) | 8,646 | 3,649 | 3,262 | 763 |
| pretty-JSON compiler alone (`src/compiler.js`) | 8,447 | 3,513 | 3,153 | 708 |
| DSL compiler + DSL text | 14,783 | 6,020 | 5,371 | 1,799 |
| compact compiler + compact JSON | 18,210 | 6,327 | 5,590 | 1,735 (−64) |
| **pretty compiler + pretty JSON** | 50,407 | 7,077 | 6,072 | **1,629 (−170)** |

The same club in the three main forms:

```text
=club
cyl root 6b4423 0 0 .2 .04 .5 .06 / 90 0 0
ball5 root 7a5230 0 0 .45 .09 .09 .14
```

```json
"club": {
  "parts": [
   ["cyl","root","6b4423",0,0,0.2,0.04,0.5,0.06,"/",90,0,0],
   ["ball5","root","7a5230",0,0,0.45,0.09,0.09,0.14]
  ]
}
```

Pretty JSON writes the same two parts as 48 lines: every key on its own line and every array element on its own line.

## Why

- **Under surprisal the numbers cost bits, the syntax almost doesn't.** Keys, quotes, brackets and indentation repeat
  in a pattern the model picks up within a few entries, so they become nearly free. The bulkier the form, the
  *smaller* it packs here: pretty < YAML < minified < compact < JS calls < DSL. That's the opposite of gzip and Brotli,
  where the DSL wins by 15–40%.
- **Named keys tell the model what each number is.** After `"position": [` or `"size": [` it knows which kind of value
  is coming, which makes the numbers themselves cheaper to predict. In the DSL every number is just the next token in a
  run of eight or eleven.
- **The parser costs nothing either way.** The compilers differ only in how they read a statement. The DSL's
  line-splitting code is ordinary JavaScript that compresses to almost nothing, so dropping it saved nothing (compact
  compiler 763 vs. DSL compiler 761). The pretty-JSON compiler is 53 bytes *smaller* packed (708), most likely because
  destructuring named fields (`{ shape, bone, color, position, size }`) reads more naturally than slicing token arrays.
- **It scales with content.** The compiler is a fixed cost; the 10% saving applies to every model added.

## Caveats

- **Level 9 is thin.** Only the DSL and compact JSON finished at -9, and the gap shrank from 6% to 2%. Pretty JSON was
  not measured at -9, so the 7B model may close part of its lead.
- **Zip-based scoring goes the other way.** Under gzip -9 the whole game is now 13,614 bytes, over the 13,312 budget
  (12,460 with the DSL). Pretty JSON only makes sense when surprisal is the measure.
- **Comments are gone.** JSON has no comments. The old DSL had none in practice, but a hand-written model file loses
  the option.
- **Hand-editing.** `JSON.stringify(..., null, 2)` puts every array element on its own line, which is long to edit by
  hand. A layout with short arrays kept inline would be easier to edit, but it is a different text and wasn't measured.

## Method and fidelity

`node tools/formats.mjs` regenerates every candidate into `dist/formats/` and prints the table. It runs surprisal at
the levels in `LEVELS` (default `1`; `ONLY=txt,compact` limits which candidates) and caches results by content hash in
`.cache/`. `LEVELS= node tools/formats.mjs` prints the table from the cache without running surprisal.

```bash
SURPRISAL=/path/to/surprisal node tools/formats.mjs
```

Fidelity is checked, not assumed. Each candidate is decoded back into DSL text, and every model is built at six seeds
by the DSL compiler and by each JSON compiler. The meshes, vertex colors, bone transforms, clips, variables and held
props must match the original bit for bit, or the script exits with an error. The check was confirmed to fail when a
mirror flag is dropped. The script also warns if `src/models.json` drifts from the pretty candidate generated from
`tools/formats/models.txt`. Once models are edited in JSON directly that warning is expected, and the baseline would
need regenerating from the JSON.

The converter this started from had three faults, fixed here: compact JSON dropped `?` chances and `*` repeats;
all-digit colors such as `222` became numbers (so `000` would have become `0`); and a clip didn't end at a following
`S` or `hold` statement.

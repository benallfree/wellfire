# Build and ship: one HTML file

The shipped artifact is one file, `dist/index.html`. Everything the game needs is inside it except three.js, which a
pinned import map loads from a CDN (it doesn't count toward the budget). There are no binary assets: no textures,
meshes, sounds or images in the repo's shipped path.

## Source layout

```
src/index.html    shell: <style>, HUD markup, the import map, and three placeholders
src/models.json   models + tuning (pretty JSON)
src/score.json    music (pretty JSON)
src/compiler.js   model compiler (ES module: exports DEG, rng, library, make, hold, pose, bake, glow)
src/music.js      music compiler (exports score, jukebox)
src/game.js       the game (imports from ./compiler.js and ./music.js, and `* as THREE from 'three'`)
```

The shell's script area:

```html
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="application/json" id="models">
<!--MODELS-->
</script>
<script type="application/json" id="score">
<!--SCORE-->
</script>
<script type="module">
<!--CODE-->
</script>
```

The game reads its data with `JSON.parse(document.getElementById('models').textContent)`.

Pin an exact three.js version. Wellfire uses r170 (`three@0.170.0`) and `three/addons/utils/BufferGeometryUtils.js`
for `mergeGeometries`. Keep `three` in `devDependencies` too, so Node tools (size reports, the model viewer's tests)
can run the same compiler.

## tools/build.mjs

What it does, in order:

1. Reads `compiler.js`, `music.js`, `game.js` in that order (dependencies first).
2. Strips comments from each (`tools/strip.mjs`).
3. Drops `import` lines: local ones (`'./'`) go entirely, since the files are concatenated into one scope; external
   ones (`three`, `three/addons/...`) are collected into a set and emitted once at the top.
4. Removes `export ` at line starts.
5. Replaces `BUILD_ID` with `<version>-alpha.<commit count> · <short hash>` (+ `+` if `src/` has uncommitted changes),
   from `package.json` and git; falls back to `<version>-alpha · dev` outside git. The game prints it in a small
   corner label so a cached page can be told from the latest.
6. Fills the shell: `<!--MODELS-->`, `<!--SCORE-->` (trimmed JSON as written, pretty) and `<!--CODE-->`.
   Use replacement *functions* (`.replace('<!--CODE-->', () => code)`) so `$&`-style patterns in the code are not
   interpreted.
7. Writes `dist/index.html` and prints its byte count.

Consequences of concatenating into one scope:

- **Top-level names must be unique across all files.** A clash is a `SyntaxError: Identifier 'x' has already been
  declared` that only shows in the browser (or with `node --check` on the extracted script). Check after adding files:
  extract the module script from `dist/index.html` to a `.mjs` and run `node --check` on it.
- Each file must still be a valid ES module on its own for Node tools to import it.

## tools/strip.mjs: comment stripping

A ~70-line scanner, not a regex. It tracks:

- strings (`'` and `"`, with escapes),
- template literals with `${}` nesting (a stack of the brace depth at which each template resumes),
- regex literals (a `/` after one of `(,=:[!&|?{};+-*%<>~^`, at the start, or after `return typeof case in of`),
  including character classes and flags,
- `//` comments (cut with the spaces before them; a line that held only a comment is removed whole) and `/* */`.

Everything else (names, indentation, line breaks) stays exactly as written. Validate a stripper with an AST compare
(acorn): each file's AST must be identical before and after, with zero comments left. Don't add whitespace collapsing
or minification: both measured worse under surprisal.

## Debug handle and cheats

During development expose a handle for the browser console and for automated checks:

```js
window.game = { player, foes, scene, camera, renderer, spawn, world: { SEED, chunks, height, terrain, region, home } }
```

It costs about 58 bytes compressed (a list of names). Options: keep it (Wellfire does, along with Doom-style console
cheats `wfmidas()`, `wfhoard()`… that go through the real `gain`/`earn` functions so HUD and save stay right), or cut
it from the ship build: put it at the end of `game.js` after a marker comment like `// dev only` and have the build
drop everything after the marker unless it's given `--dev` (with `npm start` passing `--dev`). The comment stripper
runs after the cut, or the marker must be something other than a comment.

## Size tooling

`package.json`:

```json
"scripts": {
  "build": "node tools/build.mjs",
  "start": "node tools/build.mjs && node tools/serve.mjs",
  "ship": "node tools/ship.mjs",
  "fit": "node tools/fit.mjs",
  "baseline": "node tools/ship.mjs --baseline"
},
"size": { "level": 6, "headroom": 200, "budget": 13312 }
```

- **`npm run ship`**: build, pack the js13k baseline, compress with surprisal at the saved level with `--compare`,
  then print both sizes against the budget. `npm run ship -N` (npm exposes it as `npm_config_N`) or
  `npm run ship -- -N` uses level N for one run. Output streams live (`spawnSync` with `stdio: 'inherit'`). Writes
  `dist/index.13k`, removing any old one first so a stale archive is never reported.
- **`npm run fit`**: build once, compress at the saved level; while over `budget - headroom`, step up a level (to -9).
  Save the first level that fits to `package.json`. `--down` also steps down while lower levels still fit. Exit 1 and
  leave `package.json` alone if even -9 doesn't fit. Each level writes `dist/fit/index-N.13k`.
- **`npm run baseline`**: the conventional js13k pipeline for comparison: terser (3 compress passes, mangle) →
  roadroller → advzip -4 (Zopfli). The JSON blocks are inlined into the JS as string literals so roadroller packs
  them too; `import` lines stay outside the packed code (roadroller's output is a direct `eval`, which still sees the
  module's imports). Writes a playable `dist/roadroller/index.html` and `dist/roadroller/index.zip`. `ROADROLLER_O`
  (0/1/2) and `ADVZIP_ITER` tune it.
- The surprisal binary path comes from `SURPRISAL` or a default; check it exists and say how to set it if not.
- Write each tool with a header comment listing its usages and flags, print a timestamped line before and after each
  slow step, and fail loudly when the page shape changes (e.g. "expected one `<script type="module">`, found 2").

Baseline for scale: Wellfire's roadroller zip is ~38 KB (286% of budget) where surprisal -6 is ~13.1 KB. Under
surprisal, never feed it minified code: the readable stripped build is the input.

## Serve and preview

`tools/serve.mjs`: a ~20-line `node:http` static server on `127.0.0.1:${PORT || 8713}` that maps `/` to
`dist/index.html` and serves `/dist`, `/src` and `/tools` paths (whitelisted by regex, no `..`). `/tools/viewer.html`
is the model viewer. For the Claude desktop preview, `.claude/launch.json`:

```json
{ "version": "0.0.1", "configurations": [{ "name": "game", "runtimeExecutable": "node", "runtimeArgs": ["tools/serve.mjs"], "port": 8713 }] }
```

When several sessions test at once, give each its own port (`PORT=8729 node tools/serve.mjs`), detached with a log.

## Deploy

GitHub Pages from `main` on every push (`.github/workflows/pages.yml`): checkout with `fetch-depth: 0` (the build ID
counts commits), setup Node, `node tools/build.mjs`, upload `dist`, deploy. The build needs only Node.

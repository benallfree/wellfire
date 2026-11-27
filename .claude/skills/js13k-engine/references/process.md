# How to work on a surprisal-budget game

## Loop

1. Read the relevant reference and the game's section for the system you're touching.
2. Write it inline, with a section header and comments explaining the why.
3. `npm run build`, then check the extracted script parses (`node --check` on the module script) if you added a file
   or top-level names.
4. Play-test in the browser on your own port (`PORT=87xx node tools/serve.mjs`, detached, with a log). Drive it from
   the console through `window.game`, and click/press for real for input changes.
5. Commit with a descriptive message that includes the raw byte delta of the build (`294,354 -> 294,766, +412`).
6. Measure compressed size only when asked.

## Browser checks that caught real bugs

Through the `window.game` handle (player, foes, scene, renderer, world functions):

- **Console errors**: none on load, on the title, after starting, after the action you changed. A thrown error inside
  `frame()` stops the loop: the game "freezes" with no visible error.
- **Determinism**: read a chunk's signature (its instance count and a few heights), teleport 10 km away and back (and
  reload): it must be identical. Same for a built village (house positions and sizes, name, townsfolk count).
- **Seams**: compare heights on all shared edge vertices of the live chunks: zero difference.
- **Memory**: watch `renderer.info.memory.geometries` and `scene.children.length` across teleports, long walks, item
  swaps, entering and leaving interiors and dungeons. Flat means no leak; a climb means something isn't disposed.
- **Frame time**: median and worst over a walk at speed. Chunk building, minimap tiles and new music notes must never
  hitch.
- **Placement**: every scenery instance and actor sits exactly on `height()` (or on its floor).
- If the preview pane is hidden, `requestAnimationFrame` pauses: drive frames with a timer or check in a visible tab.

## Measuring size

- Only when asked, at the level asked. Run surprisal in a visible terminal and let it stream; never pipe it.
- For an A/B: build both pages, run the same binary and level on each, report raw and compressed for both.
- When another surprisal run is using the GPU, yours slows down a lot (it doesn't change the size). Don't stop
  someone else's run.
- Write results down with commit, level and date, and mark estimates as estimates.

## Writing things down

- The README is the manual for the game as it is now (controls, systems, tuning keys, size, deploy).
- Keep a development journal (`docs/postmortem.md` in Wellfire): each feature's design, options weighed, costs and
  checks, written when it was built. It's how the next agent learns why.
- Design notes for a big feature before building it (options weighed, what was chosen and why).
- Commit messages carry the story: what changed for the player, why, the raw byte delta, and what was verified.

## When to cut

The only big lever is features. Rough costs from Wellfire (estimates at ~0.015-0.02 per byte of model JSON and ~0.07
per byte of code): a flying mount with its whistle ~300 bytes, a second rideable creature ~200-250, house interiors
~250, a water monster ~150-180, colour stages ~150, a big map ~70, a title-screen effect ~70. Prose in UI strings
(~2.5 KB in all) trims for maybe 30-50. A dead-code sweep usually finds nothing in a game that's been played.

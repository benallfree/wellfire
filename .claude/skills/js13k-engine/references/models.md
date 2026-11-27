# Models as text: the "language + JIT"

Every model (characters, creatures, props, trees, houses, rooms, coins, icons) is a block of pretty JSON in
`models.json`, compiled at load into three.js objects by a ~230-line compiler shipped in the page. Eleven characters and props
(rigged and animated) were 5.1 KB of text and 916 bytes compressed; a whole roster with houses, rooms, mounts and a flying
roc is ~150 KB pretty and packs to roughly 2-3 KB. Each creature block is a **generator**: a seed gives a different,
repeatable creature, so variety costs nothing extra.

## Why this format

Weighed and rejected: CSG (needs a mesh boolean library), SDF/implicit modelling (raymarcher or marching cubes, slow to
mesh, hard to rig), demoscene operator graphs (near-binary), voxels (grid data). Picked: **primitives with transforms,
mirroring, bones and a few generative tricks**. three.js does the geometry, every part names the bone it rides on, and
the text is what a language model predicts well. Rigid parts on bones (no skinning) mean no weights to store, mirroring
halves most models, and a low-poly look comes for free.

## Format

`models.json` maps a name to a block. `common` holds clips every model inherits unless it defines its own. Other
top-level keys can be tuning tables (`wilds`, `stages`, `hints`…) that the game reads directly.

```json
"goblin": {
  "vars": { "s": ".8~1.1", "skin": "6a8a3a|7a9a4a|5a7a30", "h": ".9~1.2", "gold": 5 },
  "scale": "s",
  "bones": [
    { "name": "hip", "parent": "root", "position": [0, 0.55, 0] },
    { "name": "leg*", "parent": "hip", "position": [0.1, 0, 0] },
    { "name": "head", "parent": "chest", "position": [0, 0.4, 0] }
  ],
  "parts": [
    { "shape": "box", "bone": "chest", "color": "skin", "position": [0, 0.2, 0], "size": [0.4, 0.4, 0.25] },
    { "shape": "ball", "bone": "head", "color": "skin", "position": [0, 0.15, 0], "size": ["0.2*h", "0.18*h", "0.2*h"] },
    { "shape": "cyl", "bone": "head", "color": "skin", "position": [".24*h", 0.25, 0], "size": [0, 0.2, 0.05], "rotation": [0, 0, -70], "mirror": true },
    { "shape": "ball", "bone": "head", "color": "f22!", "position": [0.07, 0.17, 0.17], "size": [0.03, 0.03, 0.02], "mirror": true }
  ],
  "holds": [{ "bone": "handR", "model": "club|spear" }],
  "clips": {
    "walk": { "duration": 0.6, "loop": true, "channels": [{ "bone": "leg^", "channel": "rx", "keys": [30, -30] }] },
    "attack": { "duration": 0.5, "loop": false, "channels": [{ "bone": "armR", "channel": "rx", "keys": [0, -150, 30, 0] }] }
  }
}
```

(Illustrative; real blocks are `JSON.stringify(models, null, 2)`, one array element per line. That expansion is fine:
it compresses well.)

| field | meaning |
|---|---|
| `vars` | variables, evaluated in order. A number; `"a~b"` (seeded uniform in [a, b]); an expression over earlier vars (`".3*s"`); a colour; a name; `"a\|b\|c"` (seeded pick); or a list of option strings, one picked from each and joined (`["Thun\|Ash", "der\|by"]` makes a two-part name). `seed` is predefined. |
| `scale` | whole-model scale (number or expression) |
| `bones[]` | `name`, `parent`, `position`, optional `rotation` in degrees. A name ending `*` is a mirrored pair: `L` at +x as written, `R` at −x with `ry`/`rz` negated; `parent*` resolves per side. |
| `parts[]` | `shape`, `bone`, `color`, `position`, `size`, optional `rotation`, `segments`, `mirror`. `mirror: true` adds the part's mirror image on the same bone (two eyes, one entry). |
| shapes | `box` [w, h, d]; `ball` (ellipsoid) [rx, ry, rz]; `cyl` [rTop, h, rBottom] (cone when rTop is 0); `lathe` [r, y, r, y, …]; `ext` [depth, x, y, x, y, …] (extruded polygon) |
| color | 3- or 6-digit hex, a variable, or a `\|` pick. A trailing `!` makes it self-lit (eyes, flames, windows, coins show in the dark). |
| `holds[]` | `bone`, `model`: attach a prop model to a bone (a socket). `"club\|spear"` picks one per seed. |
| `chance` | on any bone, part, hold or channel: keep it with that probability (optional horns, hats, socks). |
| `repeat` + `var` | on any bone, part, hold or channel: emit it `repeat` times with `var` = 0..n−1. `"{expr}"` inside any string is evaluated, so `"leg{i}*"` and `"{.2-i*.12}"` work (spider legs, eel segments, fence posts). |
| `clips` | `name: { duration, loop, channels }`. A channel: `bone`, `channel` (`rx ry rz` degrees, `x y z` offset, `s` uniform scale offset or `sx sy sz`) and `keys`, evenly spaced and smoothstep-interpolated; loops wrap. `bone*` mirrors (negating `ry`, `rz`, `x`); `bone^` mirrors *and* shifts half a cycle (walk cycles). |

Any number can be an expression over vars (a goblin's ears follow its random head size). Vars also carry **gameplay
data** the game reads from `m.vars`: `"dmg"`, `"reach"`, `"push"`, `"anim": "chop"`, `"chop": 1`, `"gold"`, `"name"`,
`"burn"`, a mount's `"run"`, `"turn"`, `"grip"`, attack timing `"at"`… An item is entirely defined by its block.

## The compiler (`compiler.js`)

Exports `DEG`, `rng`, `library`, `make`, `hold`, `pose`, `bake`, `glow`.

- **`rng(seed)`**: mulberry32, returns a function giving 0..1. Seeded everywhere; `make` seeds with
  `seed * 7919 + name.length`.
- **`make(lib, name, seed = 1, mat)`** walks the block in order (vars, scale, bones, parts, holds, clips), then the
  `common` block for clips the model lacks:
  - `num(t)`: a literal, or `"a~b"` replaced by seeded values, then evaluated with
    `Function(...Object.keys(V), 'return ' + t)(...Object.values(V))` over the vars so far.
  - `pick(t)`: a var's value, or one option of `"a|b|c"`.
  - `sides(name)`: `"arm*"` → `['armL', 'armR']`.
  - `sub(t)`: replaces `{expr}` inside strings.
  - `each(list, f)`: applies `chance` and `repeat`/`var`, substitutes strings, calls `f`.
  - Bones become `Object3D`s under the model's `root`; rest transforms are recorded for posing.
  - Each part: build the three.js geometry, make it non-indexed, rotate, translate into the bone's space, **keep only
    positions**, add per-vertex colours with a small per-face shade jitter (`0.9 + 0.1 * ((face * 7919) % 13) / 13`)
    for the faceted look. Self-lit colours are stored as colour + 2. Mirrored copies scale x by −1 and **swap two
    vertices of every triangle** so faces still point outward.
  - **All parts on one bone merge into one mesh** (`mergeGeometries`, `computeVertexNormals`), sharing one
    flat-shaded `MeshLambertMaterial({ vertexColors: true, flatShading: true })` per model instance, so one monster
    can flash red without the others.
  - Returns `{ name, root, bones, clips, vars, mat, rest, props }`.
- **`glow(material)`**: an `onBeforeCompile` patch after `#include <color_fragment>`:
  `if (vColor.r > 1.9) { totalEmissiveRadiance += vColor - 2.; diffuseColor.rgb *= 0.; }`. One line gives every
  model glowing eyes and windows at night.
- **`hold(lib, m, bone, prop, seed)`**: compiles the prop with the holder's material and parents it to the bone.
  **Disposes of the prop it replaces** (geometry only; the material is the holder's). `prop` null just removes.
- **`pose(m, layers)`**: resets every bone to rest, then for each `[clip, time, weight]` layer adds its channels:
  loops wrap (`(t / d) % 1`), one-shots clamp; smoothstep between keys. Rotations add in degrees × `DEG`; `s` adds to
  all scale axes. Props are posed with their own `idle` (a torch flame flickers that way).
- **`bake(m)`**: `updateMatrixWorld`, clone each mesh's geometry with its world matrix applied, merge into one. Use it
  for static models drawn with `InstancedMesh` (trees, rocks, bushes, coins, items).

Every channel is a **delta on the rest pose**, so the rest pose should be the character's natural stance; clips store
only what moves away from it.

## Using models in the game

- **Characters and creatures**: `make(lib, kind, seed)` per actor; its `root` goes in a `Group` whose position is the
  actor's. Creature stats can scale with the compiled size (`m.root.scale.x`).
- **Scenery**: for each kind, compile 4 seeded variants, `bake` each, one `InstancedMesh` per variant shared by every
  chunk (see chunks-and-scenery.md).
- **Items and drops**: `geo(k)` caches `bake(make(lib, k, 1))` per item; one shared material (with `glow`) for all.
- **Props and sockets**: a socket is just a bone (`handR`, `handL`, `saddle`, and a `back` bone for the slung weapon). Swapping items calls `hold`
  again. A prop's origin sits in the fist; the prop orients itself with a rotated root bone in its own block. An
  odd carry offset (Wellfire once carried a boat over the head) can be a var read into the prop's rest pose.
- **Tray icons** are the item models rendered once at startup: a second small `WebGLRenderer({ alpha: true,
  preserveDrawingBuffer: true })`, a hemisphere light, a camera fitted to each model's bounding sphere
  (`radius / sin(fov / 2) / zoom`) from a view direction, `toDataURL()` into `<img>` tags, then `forceContextLoss()`.
  Size, fov, view and per-item turn and zoom live in `models.json` (`tray.icons`). No image assets.

## Animation conventions

- Blend `idle` and `walk` by speed (`[['idle', time, 1 - k], ['walk', step, k]]`), then lay a one-shot over them
  (`swing`, `chop`, `jab`, `attack`, `hit`, `death`). Advance the gait phase per frame (`step += dt * rate`), never
  `time * speed` (see pitfalls).
- A `common` block with `hit` (root rocks back) and `death` (roll onto the side) serves every creature.
- A `ride` pose in `common` that sets only `leg*`, `foot*`, `arm*`, `chest` ports to any rig with those names.
- Hit timing is a fraction of the clip (the player's blow lands at 45% of the swing; a monster's at 50% of `attack`).
- Looping waves along a chain (an eel, a tail): one channel per segment via `repeat`, keys from phase-shifted sines.

## Hand-made clips from a tool

Wellfire's warrior has three joints per limb and a fighting-stance rest pose; his bones and clips are written into
`models.json` by a dev-only script (`tools/warrior.mjs`) from absolute poses: planar two-bone IK keeps the feet
planted, L/R pairs fold back into `*` and `^` channels where they mirror, curves keep 4 keys instead of 8 where they
can, and channels that never move more than 5° or 2 cm are dropped. Do this when a rig gets complex; keep simpler
models hand-written. Generated JSON compresses just as well as hand-written JSON if it's pretty and regular.

## Dev viewer

`tools/viewer.html` (not shipped) imports the compiler from `../src/` and shows any model, seed list, clip, time list
and held item: `?m=goblin&seeds=1,2,3&clip=walk`, `?m=warrior&clip=swing&t=0.06,0.11,0.17&ry=-30&hold=sword`. Build
one early; it's how you check a model without playing.

## Costs seen

- A big rigged creature with clips: ~9-11 KB pretty JSON (steed 11.2 KB, drake 11.5 KB, roc 10.1 KB) → roughly
  150-250 bytes compressed. A small prop: 0.3-1.5 KB.
- The warrior's IK clips: +20 KB pretty, mostly one-shot keyframes.
- The compiler: ~7.5 KB stripped; a fixed cost.
- Model JSON is the cheapest content there is; code to *use* a model is what costs.

# Chunks, scenery and a world the player can change

The world is cut into square chunks (Wellfire: 40×40 units). Chunks near the player are built a couple per frame and
thrown away when far. A chunk is a ground mesh, instance lists for shared scenery meshes, colliders, and any game
objects that belong to that ground. Wellfire: `src/game.js`, the end of the `settlements and roads` section (`grow`,
`drop`, `stream`, `around`).

## Streaming

```js
const CH = 40   // chunk size in units
const NEAR = 3  // build chunks within this many chunks of the player (fog ends at 110)
const chunks = new Map() // live chunks only: "cx,cz" -> { cx, cz, key, mesh, inst, trees, ... }
let dirty = false        // an instance list changed: refill the shared meshes

function stream(x, z, n = 2) {
  const px = Math.floor(x / CH), pz = Math.floor(z / CH)
  for (const [key, ch] of chunks) if (Math.max(Math.abs(ch.cx - px), Math.abs(ch.cz - pz)) > NEAR + 1) drop(key)
  const want = []
  for (let i = -NEAR; i <= NEAR; i++)
    for (let j = -NEAR; j <= NEAR; j++) if (!chunks.has(px + i + ',' + (pz + j))) want.push([i * i + j * j, px + i, pz + j])
  want.sort((a, b) => a[0] - b[0]) // nearest first
  for (const [, cx, cz] of want.slice(0, n)) grow(cx, cz)
  if (dirty) refill()
}
```

- Called every frame from the loop with the camera target; called once at load with `n = 99` so the start is complete.
- **Hysteresis**: build within `NEAR`, drop beyond `NEAR + 1`, so walking along a chunk edge doesn't thrash.
- Live chunks stay at 49-81. A chunk build was ~0.3 ms bare, ~1.3 ms with slope-sampled colours; at most two per frame
  never showed as a hitch.
- `drop(key)`: remove the mesh from the scene, dispose of its geometry, delete from the map, set `dirty`. Children of
  the chunk mesh (rocks, cave mounds) go with it.

## Building a chunk: `grow(cx, cz)`

1. **Ground mesh**: `PlaneGeometry(CH, CH, 25, 25).rotateX(-90°).translate(x0 + CH/2, 0, z0 + CH/2)`; for every
   vertex set `y = height(x, z)` and a vertex colour from `ground()` × hillshade. One shared
   `MeshLambertMaterial({ vertexColors: true, flatShading: true })`. `receiveShadow`. Edge vertices sample the same
   points as the neighbour's, so seams match.
2. **Scenery**: `R = rng(hash(cx, cz, SEED + 4) * 2^32 | 0)`; 70 candidate spots, each drawing the same values
   (x, z, kind pick, variant, scale, turn) whether or not anything grows. Skip spots under or near water, near home,
   in or near villages, on roads, or felled recently. Pick the kind from the region's `FLORA` weights; nothing but
   boulders above the tree line. Push the instance matrix into `inst[kind * 4 + variant]`, and a collider
   `[x, z, radius]` for solid kinds.
3. **Game objects on this ground**: breakable rocks (their own seeded stream, `SEED + 13`), a village's cave mound
   when the cave's spot falls in this chunk, berry bushes (a seeded share of bushes). Add them as children of the
   chunk mesh so they leave with it, and push their colliders.
4. Store `{ cx, cz, key, mesh, inst, trees, rocks, caves, berries }` and set `dirty`.

## Shared instanced meshes

One `InstancedMesh` per scenery variant (4 variants × 4 kinds = 16), shared by every live chunk:

```js
const kit = KINDS.flatMap(([kind]) => [1, 2, 3, 4].map((v) => {
  const m = make(lib, kind, v)
  const mesh = new THREE.InstancedMesh(bake(m), m.mat, 900)
  mesh.castShadow = mesh.receiveShadow = true
  mesh.frustumCulled = false // instances span many chunks; the bounding sphere is the first instance's
  mesh.count = 0
  scene.add(mesh)
  return mesh
}))
function refill() {
  dirty = false
  kit.forEach((mesh, v) => {
    let k = 0
    for (const ch of chunks.values()) for (const m of ch.inst[v]) if (k < 900) mesh.setMatrixAt(k++, m)
    mesh.count = k
    mesh.instanceMatrix.needsUpdate = true
  })
}
```

Walking adds no draw calls (~40 in all). A second pool can draw a decoration on top of another instance's matrix
(berry clusters on bushes), filtered at refill time (`!b.eaten`).

## Colliders

Each chunk keeps a list of circles `[x, z, r, ...extra]`. `around(x, z)` returns the lists of the 3×3 chunks round a
point; `Actor.move` pushes the mover out of any circle it overlaps (see actors-and-ai.md). Extra fields let a collider
point back to its thing (a tree's candidate index, instance list and matrix, so the axe can fell it).

## Player changes to a generated world

The world regenerates from the seed, so a change is stored as a small keyed set and applied in `grow()` after
generating:

- **Felled trees**: `felled["cx,cz"][candidateIndex] = Date.now()`. `grow()` skips a candidate felled less than
  `REGROW` (30 min) ago. On load, expired entries are pruned, so the record stays small however far you roam.
- **Broken rocks**: same map, key `"e" + index`. **Eaten berries**: `"b" + index`, regrow after `berrybush.regrow`.
- **Opened caves, taken gems**: `felled.caves[siteKey]`, `felled.gems[siteKey]`. Keep non-chunk keys out of the
  pruning loop's way (a string value there crashed load; see pitfalls).
- **Felling in place**: the first hit takes the tree out of its instance list (`inst[v].splice`, `dirty = true`) and
  into a `Mesh` of its own (same geometry and material, matrix copied) so only it shakes and falls. Its collider is
  removed when it falls.

## Things that live and die with chunks

- **Per-chunk rolls**: roll each newly built chunk once for a rare thing (a wild mount, about one chunk in 17), from
  the chunk's own seed (through `h2`). Remember rolled chunks in a set so a chunk isn't rerolled while live; remember
  "taken" chunks so a taken mount never comes back.
- **Leave with the chunk**: a wild mount leaves when the chunk under it unloads (and the chunk rolls it again, same
  seed, when rebuilt); drops vanish when their chunk unloads; a falling tree is removed if its chunk goes.
- **Exceptions are explicit**: the last mount you rode never despawns.

## Bigger set pieces stream on their own radius

A village (houses, rooms, fence, well, townsfolk) is built when the player comes within 150 units of its centre and
disposed of past 200 (meshes, materials, actors), unless the player is inside one of its rooms. At most one is built
per frame. Spawning and collision checks still use the pure `site()` layer, built or not.

## Checks

- Teleport to (10000, 10000) and back: the same chunk (same trees, same heights); a fresh page load gives the same
  signature.
- Zero height difference on all shared edge vertices of the live chunks.
- After teleports to ±10 km and a long walk, `scene.children` and `renderer.info.memory.geometries` stay roughly flat.

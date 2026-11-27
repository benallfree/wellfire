# Saving: only what can't be derived

The world is generated from the seed, so a save holds only **player state and player changes**. Wellfire keeps a
handful of localStorage keys with a common prefix (`warriorGold`, `warriorBag`, `warriorSlots`, `warriorFelled`,
`warriorBeacons`, `warriorEye`, `warriorSeen`, `warriorLearned` (hints already learned), `warriorMute`).

## The two helpers

```js
// read: private windows and blocked storage just start fresh
const kept = (k, d) => {
  try {
    return JSON.parse(localStorage[k]) || d
  } catch {
    return d
  }
}
// write, and read back: some browsers drop a write without an error; a refused save says so once
let refused
const keep = (k, v) => {
  const j = JSON.stringify(v)
  try {
    localStorage[k] = j
    if (localStorage[k] != j) throw 0
  } catch {
    refused ||= setTimeout(() => showBox("Can't save", "The browser's storage is full or blocked, so progress since then is lost on reload"))
  }
}
```

Every storage access goes through these (or its own `try`). Never let a failed save be silent: a full quota once
silently refused a beam's lock after an hour of play.

## What to store

| state | form |
|---|---|
| purse, counts | a number; a bag object `{ wood: 3, torch: 1 }` |
| layout choices | the tray's slot order |
| goals | `{ siteKey: [azimuth, polar angle, locked, eye] }` |
| changes to the world | `felled = { "cx,cz": { candidateIndex: time, "e3": time, "b7": time }, caves: {…}, gems: {…} }` |
| exploration | revealed minimap cells (compact; below) |
| settings | mute |

Not stored: anything generated (terrain, villages, roads, scenery, creatures, caves' mazes), anything that regrows
(pruned), positions of things that respawn.

## Expiry and pruning

Changes that regrow carry a timestamp. On load, delete entries older than the regrow time, and empty chunk keys, so
the record stays small however far you roam. **Skip keys that aren't chunk maps** in that loop (a string value there
— the carried gem's cave key — made `delete str[i]` throw in strict mode and crashed load).

## Compact formats for growing sets

The minimap's revealed cells grow without bound. One `"i,j"` string per 8-unit cell filled the whole origin's ~5 MB
quota after an hour of flying. Now: per explored chunk, `"cx,cz,mask"` where `mask` is its 5×5 cells as bits, written in
base 36, all joined by spaces (~14× smaller). Rules:

- Pick a format proportional to the explored area's *chunks*, not cells.
- **Throttle**: save at most every 30 s, plus on `pagehide` and on `visibilitychange` when hidden.
- Load old formats and rewrite them at once (mark the save "old" so it's written on the first reveal).

## Migrations

Read old shapes forever; fix them up after loading:

```js
const bag = kept('warriorBag', {})
bag.wood ||= 0
delete bag.boat            // an item that no longer exists
bag.torch ??= 1            // a new default, without clobbering an existing 0
const belt = kept('warriorSlots', lib.tray.slots).map((k) => (k == 'boat' ? 'haste' : k)) // a renamed slot
```

And state that implies a later state (five beams on one eye from an older version) is advanced at load.

## Death and saves

Decide explicitly what a fall costs and keep it legible (a toast that says so). A carried quest item can go back where
it came from (remove it from the bag and from `felled.gems`, then save).

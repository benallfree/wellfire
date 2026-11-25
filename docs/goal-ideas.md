# A goal for the warrior: options under the byte budget

The game has no goal or ending yet. This note weighs goals that reuse what is already built and gives a rough byte
price for each. It is a discussion paper: nothing here is built yet.

### How the costs below are estimated

New code is dense and has no comments in the shipped build, so it compresses worse than the 20:1 whole-file average,
which counts pretty-JSON indentation that is nearly free. Tray, wood and boat cost +12.9 KB raw for +1,146 bytes
(about 11:1, comments included). Below, **compressed ≈ raw ÷ 10** for new code with no comments, rounded. Treat
every figure as ±50% until measured. A shared end screen (below) is counted once, not per idea.

### Shared pieces every goal needs

- **End screen**, about 200 raw, **~20 compressed.** One fixed `<div>` added with `insertAdjacentHTML` and inline
  style: a title ("The beacons burn" / "Long live the King"), then the run's numbers from state that already exists:
  kills, gold, villages seen on the minimap, metres from the start, play time from `clock`. A tap or key dismisses it,
  and the world goes on (endless play after the win costs nothing).
- **Progress in the HUD, ~5–10 compressed.** One more term in the existing `#info` template string, for example
  `· 🔥 2/5`, `· 👑 140/500`, `· night 3/7` or `· ◆◆◇◇`. No new element and no CSS. The text updates on the
  existing `hud()` calls.
- **Persistence** is free to reuse: `kept(k, d)` / `keep(k, v)` already wrap localStorage (the tray and felled trees
  use them), and gold is already kept.

## The options

Ordered from tiniest to most ambitious. Compressed costs exclude the shared end screen (~20).

### 1. Survive seven nights. ~250 raw, ~25 compressed

- **Pitch:** last until the seventh dawn.
- **Play:** count each dusk-to-dawn crossing of `day` (the cycle is about 3 minutes). Dying resets the count. The
  win fires at the seventh dawn.
- **Reuses:** the day/night cycle, night crowds, death and respawn.
- **HUD:** `night 3/7`.
- **End screen:** "You saw the seventh dawn", plus kills and gold.
- **Catch:** monsters never spawn in a village and are leashed out of it, so you can wait out every night by the
  well. The goal is either trivial or needs villages made unsafe at night, which costs more and undoes a feature. It
  also ignores the map, the boat and the mounts. With `dark-nights-torch` merged it gets more tense, but the safe
  village still breaks it.

### 2. Buy the crown. ~300 raw, ~35 compressed

- **Pitch:** gather 500 gold and buy the crown at the well of the first village.
- **Play:** gold is already kept across reloads, so this is a goal that spans sessions. Risk and reward already
  exist: night kills pay up to 60% more, regions pay differently (`PAY`), and dying costs a tenth of the purse. At
  500 gold, standing at the start village's well buys the crown. A gold `coin` model scaled onto the warrior's head
  is a nearly free trophy.
- **Reuses:** gold drops, the purse, the death penalty, night and region pay, the start village.
- **HUD:** the purse already shows; add `/500` after it.
- **End screen:** "Long live the King", time, kills, gold spent.
- **Catch:** it is a grind number, with no reason to explore. The cheapest real goal, though.

### 3. Four relics, one per region. ~450 raw, ~45 compressed

- **Pitch:** each region's champion carries a relic. Bring back all four.
- **Play:** on a kill, `loot()` already rolls a seeded number. A small chance (or every 25th kill in that region)
  makes the monster drop the region's relic instead of only coins. Spawning a visibly larger, gold-tinted "champion"
  makes it a hunt, not luck: about 100 raw more using `spawn`'s existing scale and tint vars. Relics kept in
  localStorage. Win when all four are held.
- **Reuses:** regions (meadow, forest, rocky hills, lakes), monster mixes, `loot()`, coins (a recoloured coin can be
  the relic), the tray (a relic slot with a count badge, about 30 raw through `ICON`/`GOODS`).
- **HUD:** `◆◆◇◇`, or the tray badge.
- **End screen:** "The four relics", plus regions travelled and kills.
- **Catch:** it sends you to every region, but not to villages, roads or water.

### 4. Light the beacons (recommended). ~650 raw, ~65 compressed

- **Pitch:** carry the torch to the well of every village you find and light its beacon. Five beacons and the land
  is safe.
- **Play:** standing by a village's well with the torch equipped lights it: no new key, and the walk-up is the
  ceremony. A beacon is the `torch` model scaled up about 3× on the well, plus a warm point light while the village
  is built. The lit set is kept in localStorage by site key (`T.k`). The minimap ring of a lit village turns orange,
  about 40 raw, so the map becomes the progress board. The start village is the tutorial beacon: the first one is
  27–37 units away, so the mechanic teaches itself in the first minute. Five beacons means crossing about five
  280-unit settlement cells by road, steed, drake or boat.
- **Optional twist, ~60 raw:** a beacon will not light while monsters are within 15 units, so each village needs a
  fight at its gate first. This is option 6 in miniature.
- **Reuses:** almost everything. Seeded villages and their names, roads between them, the fog-of-war minimap and its
  village rings, the torch item and tray, mounts and the boat to travel, night. With `dark-nights-torch` merged, lit
  villages become islands of light in pitch-dark nights, which gives the beacons a felt purpose.
- **HUD:** `🔥 2/5`, plus orange rings on the minimap.
- **End screen:** "The beacons burn", the five village names in the order you lit them, kills, gold, distance
  travelled.
- **Catch:** an unlucky seed could put the fifth village across a lake. The boat already solves that, and a lake
  village is a good thing.

### 5. Free the besieged villages. ~1,000 raw, ~100 compressed

- **Pitch:** every village beyond the first is under siege. Break each siege.
- **Play:** a village gets a seeded camp of 6–10 monsters around its fence (`spawn` currently skips towns; this
  adds a per-village spawn pass and a "cleared" flag). Clearing it brings out the townsfolk and marks the village
  freed. Win at N freed.
- **Reuses:** villages, townsfolk, monster spawning, health bars, roads.
- **HUD:** `⚔ 2/5` plus a minimap ring colour.
- **Catch:** spawning is tuned around the player, so camps fight `crowd()` and recycling. More code, and most of the
  fun is in option 4's twist for a tenth of the bytes.

### 6. Slay the Drake Lord in his lair. ~1,200 raw, ~120 compressed

- **Pitch:** far beyond the known villages, a giant goblin on a drake waits in a seeded lair. Find him and kill him.
- **Play:** the lair is a seeded point about 900 units out on dry ground (search like `site()` does). The boss is an
  existing goblin `Actor` at about 2.5× scale with a dark tint, seated on a drake through the existing goblin-rider
  code: hp around 120, double damage, drake breath. He is exempt from despawn and the monster leash. A skull on the
  minimap rim points to the lair, like the `N` marker (about 120 raw). Killing him wins.
- **Reuses:** goblins, drakes and goblin riders, mount knock-offs and breath, health bars, the minimap rim,
  long-distance travel by mount or boat.
- **HUD:** the rim pointer plus `lair 640 m` in the `#pos` line.
- **End screen:** "The Drake Lord has fallen", time, kills, gold, distance.
- **Catch:** the best climax, but the most bytes, and it needs tuning so a fresh warrior can't win in five minutes
  by beelining.

### 7. Sail to the far isle. ~2,000+ raw, ~200+ compressed

- **Pitch:** build a boat and sail to an island in the great lake where the crown lies.
- **Play:** needs a guaranteed seeded lake big enough to hold an island, carved into the terrain layer near a fixed
  point, plus a trophy on the isle. The terrain layer has lakes but no guarantee of one big enough to sail.
- **Reuses:** wood, the boat, water depth, eels (a sea crossing full of eels).
- **Catch:** terrain shaping is the costliest code in the game and every new term touches `height()`. Out of budget
  unless something big goes.

### Combination: beacons call out the Drake Lord. ~1,850 raw, ~185 compressed

Options 4 and 6 together: the fifth beacon wakes the Drake Lord and shows the rim pointer, and his death is the
ending. Exploring first, then a climax. It can also land in two steps: beacons now, the lord later.

## Recommendation

**Light the beacons (option 4), with the "clear the gate first" twist, ~70 compressed with the twist, ~90 with the
end screen.** Reasons:

- **Fun per byte:** it turns the parts already built into a route: roads lead to villages, the minimap remembers
  them, mounts and the boat cover distance, the torch finally has a job by day, and the twist adds a fight at each
  gate. Every system you have paid for gets used on the way to the win.
- **The map is the progress screen:** orange rings on the existing fog-of-war map show what is done and hint at
  what is left, for about 40 raw bytes.
- **It grows into the dark-nights branch:** lit villages are the only light at night.
- **It can grow later:** the Drake Lord (option 6) bolts on afterwards as the fifth beacon's reward.

**Fallback if bytes are tight: buy the crown (option 2), ~55 compressed with the end screen.** It is cheap and ties
gold, night pay and the death penalty together, but it gives no reason to explore.

## Next step

Ben picks an option (and the twist, and N). Then: build it on this branch, measure with surprisal -1, commit, and
wait for approval before merging.

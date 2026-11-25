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

## Ben's variant: aim the beacons at the star. ~1,700 raw, ~170 compressed (plus ~20 end screen)

Option 4 grown into a real quest, from Ben's idea.

- **The star:** one bright star at a fixed, seeded spot in the sky (azimuth and elevation), always in the same place
  however far you walk, like a real star. It is faint by day and blazing at night. It is a sprite kept at a fixed
  direction from the camera, so it never comes closer. About 150 raw.
- **Light a beacon:** at a village's well, with the torch equipped, press the torch's slot to set it in the well. The
  torch is **gone from the tray** (its slot greys out) and a beam of light rises from the well. About 250 raw.
- **Aim the mirror:** standing at the well puts you on the mirror: turning (A/D, drag) swings the beam round, W/S tips
  it up and down. The beam warms from white to gold as it nears the star (hot and cold), and within a few degrees it
  **locks** with a chime and a flash. About 300 raw.
  - The star is at infinity, so the right angle is the same from every village. The first lock is the puzzle; after
    that, the skill is the journey and the torch. A mountain in the way can still make a village awkward.
- **A new torch needs wood + flint:** press 3 with no torch, 1 wood and 1 flint to make one. Flint is a new tray good
  (🪨 with a count badge). Wood comes from felling trees with the axe, as now. About 250 raw with the recipe.
- **Getting flint:** see the open questions. Either a rare drop, or a glint on some rocks that you break with the axe.
  About 100–150 raw.
- **Beams seen from afar:** locked beams are drawn on their own, not as part of the nearby village, and ignore fog.
  Each finished village leaves a gold pillar on the horizon, all leaning into the same star: a landmark and a
  progress bar in one. About 150 raw.
- **Progress:** `✦ 2/5` in the info line. On the minimap a lit village's ring turns orange, and an aimed one turns
  gold. About 80 raw.
- **The light show (win):** the fifth lock makes every beam pulse, the star flares and grows, and the sky flushes
  through colours. Bursts of the existing hit particles rain from the star and the music swells. Then the end screen
  lists the five village names, kills, gold, distance and time. About 350 raw.
- **Saved:** lit and aimed villages (by site key), and the torch count, through `kept`/`keep`.

### Flow

You start with one torch. Light and aim the first village (27–37 units away, so the first minute teaches it). Then
four more villages, each needing a new torch: fell trees for wood, find flint, craft, travel by road, steed, drake or
boat, light, aim. Night is when the star is easiest to see, and when the monsters are thickest.

### Decided (Ben, 2026-11-25)

- **Flint:** glinting rocks. About 1 in 15 of the existing rocks glints, and breaking one with the axe gives flint.
  It uses the felled/regrowth store.
- **Aiming:** turning swings the beam round and W/S tilts it. The beam warms from white to gold and locks within a
  few degrees.
- **Count:** 5 villages, and the start village counts.
- **Star:** fixed (not asked; the simplest choice).

### Open questions as first asked

1. **Flint:** a rare drop from one monster (for example rocky-hills goblins, about 1 in 6), or glinting rocks you
   break with the axe (1 in about 15 of the existing rocks, so it reuses chopping and the felled/regrowth store)?
2. **Aiming:** W/S plus turning at the mirror, as above, or the beam simply follows the camera while you stand there
   (cheaper, but the camera has no pitch today)?
3. **How many villages:** 5? Does the start village count?
4. **The star:** fixed (simplest), or drifting slowly across the sky so that aimed beams need re-aiming (much
   harder, probably not)?

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

## Status

Ben picked the star-beacons variant. It is built on this branch: see "The goal: beacons for the star" in the README.
Changes from the plan made while building it:

- **Aiming camera.** The chase camera pitches about 22° down, so the sky is barely on screen. Holding the mirror, the
  camera looks along the beam, and a `✦` on the minimap rim shows the star's way.
- **The show.** During the light show the camera turns up to the star.
- **Flint rocks.** About one rock in eight glints, not one in fifteen.

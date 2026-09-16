# Screwdom 3D — v2: deep, non-linear levels

Supersedes the tuning constants in CONTRACT.md. The TypeScript contract in
`src/core/types.ts` is UNCHANGED and still binding: `LevelDef`, `GameSnapshot`,
`GameEvent`, the `Game` API and the event ordering all stay exactly as they are.
Only level *shape*, *scale* and the *tuning constants* change.

## 0. Target device — iPhone 17 Pro Max ONLY

6.9", native 2868x1320, **CSS viewport 440 x 956 pt, devicePixelRatio 3**.
Safe areas: ~59 pt top (Dynamic Island), 34 pt bottom (home indicator).
Do not spend effort on other viewports, desktop layouts, landscape, or
low-end GPU fallbacks. Test at 440x956 @3x. Landscape may simply letterbox.

Measured framing at this size: the vertical axis binds, giving
**57.9 CSS px per world unit** with the HUD bars in place. A screw spacing of
0.82 world units is a 47.5 px tap pitch, comfortably over Apple's 44 pt
minimum. That is the budget everything below is derived from.

## 1. Why levels are small today (measured, for context)

- Screw spacing was enforced in flat 2D across *all* layers, so total capacity
  was tied to board area (~34 screws) no matter how many layers existed.
- Layer 0 was a guillotine tiling of the whole board and upper plates shrank as
  difficulty rose, so ~58% of screws sat on the bottom layer and the stack was
  effectively flat. Adding plates/layers gained nothing.
- A modelled deep stack with per-layer spacing reaches 113 screws at 8 layers
  and 182 at 12, while only ~15 screws are visible at any moment.

## 2. The spacing rule — the crux

Two screws A and B must be at least `SCREW_SPACING` apart **unless one is
physically hidden beneath the other's plate**, because a plate only drops once
all of its own screws are gone. Formally, spacing is NOT required iff:

```
(layer(plate(A)) > layer(plate(B)) && plateContainsWorldPoint(plate(A), B.x, B.y))
||
(layer(plate(B)) > layer(plate(A)) && plateContainsWorldPoint(plate(B), A.x, A.y))
```

Screws on the SAME layer always need spacing. Screws on the same plate always
need spacing (the strict `>` handles this). This is provably safe: if plate P
covers screw B, then B is unreachable until P drops, and P drops only after
every screw on P — including A — has been removed. A and B are therefore never
simultaneously tappable, so they can never produce an ambiguous tap.

## 3. New tuning constants

| Constant | Old | New |
|---|---|---|
| `BOARD` x | ±3.0 | ±3.35 |
| `BOARD` y | ±4.2 | ±4.2 |
| `SCREW_SPACING` | 0.9 | 0.82 |
| `SCREW_EDGE_MARGIN` | 0.45 | 0.34 |
| `SCREW_HIT_R` (render) | 0.45 | 0.41 |
| `SCREW_HEAD_R` (render) | 0.25 | 0.23 |
| `LAYER_SPACING` (render) | 0.28 | 0.12 |
| `PLATE_THICKNESS` (render) | 0.22 | 0.10 |
| `VIEW_BOUNDS` x / zMax | 3.4 / 1.8 | 3.7 / 2.0 |

Edge margin 0.34 still keeps a 0.23-radius screw head fully on the plate.
Layer/thickness shrink so a 14-layer stack occupies ~1.8 world units of depth
and still fits the camera frustum; plates become thin overlapping sheets, which
is what the genre actually looks like.

## 4. Level architecture — depth and branching

Replace "guillotine base + shrinking confetti" with **2-4 overlapping towers**.

- A tower is a cluster of plates stacked over roughly the same footprint,
  `towerDepth` layers tall, each plate substantially (but not exactly)
  covering the one below so screws hide underneath.
- Towers occupy overlapping regions of the board and interlock at their edges,
  so some plates bridge two towers. Do not carve the board into disjoint boxes.
- Layers are global (a plate's `layer` is its absolute stacking index) so the
  existing blocking rule works untouched; towers just concentrate their plates
  in different footprints.
- Screws per layer should be roughly uniform, NOT bottom-heavy. Target ≤ 35% of
  all screws on the bottom layer.
- Per-layer (not global) jittered lattices are fine and keep rows tidy; layers
  may use different lattice offsets so screws don't form columns through the
  stack.

## 5. Non-linearity — measured acceptance criteria

"Not linear" means the player always has several places to work, and the level
is not one forced peel order. The generator MUST verify, over its winning
playthrough, for levels above 50:

- `avgReachable` ≥ 8 — mean count of reachable screws per step.
- `minReachable` ≥ 3 outside the final 5 moves — never a single forced tap.
- `avgFronts` ≥ 3 — mean number of *distinct plates* holding a reachable screw.
- No "chokepoint run": no stretch of 4+ consecutive steps with < 3 reachable.

Reject and reseed any level failing these. Expose the stats so tests can assert
them. Scale the thresholds down gracefully for early levels (a 12-screw
tutorial obviously cannot hit avgReachable 8).

## 6. Difficulty curve targets

| Level band | Screws | Layers | Towers | Colours |
|---|---|---|---|---|
| 1-3 | 9-12 | 1-2 | 1 | 3 |
| 4-30 | 12-30 | 3-5 | 1-2 | 3-4 |
| 31-120 | 30-55 | 5-8 | 2 | 4-6 |
| 121-350 | 55-90 | 8-11 | 2-3 | 5-7 |
| 351-700 | 90-125 | 10-13 | 3 | 6-8 |
| 701-1000 | 125-150 | 12-15 | 3-4 | 6-8 |

Screw counts stay multiples of `BOX_CAPACITY` (3). Keep the existing rhythm
(every 25th extreme, every other 10th hard, breathers ending in 4). Early
levels must still *feel* like today's.

Tray and box balance must be retuned for the new scale: a 150-screw level with
5 tray slots and 2 active boxes is not the same game as a 33-screw one. Raising
`BASE_TRAY_SLOTS` and/or `activeBoxCount` on deep levels is allowed and
expected — `types.ts` already carries them per level.

## 7. Budgets

- Generation may take **up to ~2 s per level** (was 50 ms). The user has
  explicitly accepted slower generation in exchange for better levels.
- `npm test` must still finish in a few minutes: sample levels (e.g. every 10th
  plus all band boundaries) rather than all 1000, and provide a separate
  full-sweep script for the complete 1..1000 verification.
- Render: 150 screws + ~40 plates at 60 fps on the target device. Batch or
  instance screw meshes; do not emit 4 draw calls per screw.

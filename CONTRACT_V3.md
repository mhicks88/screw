# Screwdom 3D — v3: a real 3D object you rotate

This supersedes CONTRACT_V2.md. **It replaces the flat-stack game entirely.**
For the first time `src/core/types.ts` changes.

## 0. What was wrong with v1/v2

v1 and v2 modelled the board as a flat stack: 2D plates on integer `layer`s,
"blocked" decided by flattening to 2D, a fixed camera. That is a different
genre variant from the real game. The real game is a **solid 3D assembly with
screws on faces pointing in many directions; you rotate the object to find and
reach them.** That is also the real reason it fits 140+ screws — a solid has
far more working surface than one flat projection, before you count anything
inside it.

Target device is unchanged: **iPhone 17 Pro Max only, CSS viewport 440 x 956 pt,
devicePixelRatio 3.**

## 1. The model

An **assembly**: panels, brackets and plates bolted onto a frame, in nested
shells from the outside in. Removing every screw from a panel frees it; it
falls away and exposes what was behind it — inner shells, struts, interior
panels. Depth now runs in every direction, not just toward the camera.

- The assembly is centred on the origin and fits a **bounding sphere of radius
  3.0** so it stays framed from any angle, with the boxes row and tray row
  unchanged above and below it.
- **The object rotates, not the camera.** Everything belonging to the assembly
  lives under one group whose quaternion the drag gesture drives. The camera,
  lights, box row and tray row stay fixed. This keeps the existing box/tray
  layout and framing working untouched.

## 2. Types — `src/core/types.ts` changes

Unchanged and still binding: `ScrewColor`, `COLOR_HEX`, `ALL_COLORS`,
`BOX_CAPACITY`, tray/box constants, `PlateShape` and its 2D `outline`/`holes`
(a panel is still a 2D outline, now extruded and placed in space), `ScrewState`,
`BoxState`, `GameSnapshot`, `GameEvent`, `ActionResult`, `PowerUpId`,
`POWER_UPS`, `GameApi`. The event stream and its ordering do not change.

Replace the plate/screw geometry:

```ts
export interface Vec3 { x: number; y: number; z: number }
/** Unit quaternion. */
export interface Quat { x: number; y: number; z: number; w: number }

export interface PanelDef {
  id: number;
  /** 2D outline in the panel's own plane (local XY), extruded along local +Z. */
  shape: PlateShape;
  thickness: number;
  /** Panel-local origin in assembly space. */
  position: Vec3;
  /** Orientation of the panel's local frame in assembly space. */
  rotation: Quat;
  color: number;
  material: 'plastic' | 'wood' | 'metal';
  /** Nesting depth, 0 = outermost shell. A hint for tinting and generation. */
  shell: number;
}

export interface ScrewDef {
  id: number;
  panelId: number;
  /** Screw head position in assembly space. */
  position: Vec3;
  /** Unit vector the screw withdraws ALONG (outward from its panel face). */
  axis: Vec3;
  color: ScrewColor;
  hidden: boolean;
}
```

`LevelDef.plates` becomes `LevelDef.panels: PanelDef[]`. `PlateState` becomes
`PanelState` with the same `{ id, dropped, remainingScrews }` shape.
`GameEvent`'s `plateDrop` becomes `panelDrop` with `panelId`. Everything else
in the event stream is identical.

## 3. The blocking rule in 3D

> A screw is **removable** when nothing stands in the way of withdrawing it.

Cast a ray from `screw.position` along `screw.axis`, out to the assembly's
bounding sphere. If it passes through **any panel that has not yet been
removed** (other than the screw's own panel), the screw is blocked. Otherwise
it is removable.

Implement ray-vs-panel by transforming the ray into panel-local space,
intersecting it with the panel's slab (the two planes at local z = 0 and
z = thickness), then running the existing 2D point-in-polygon test (holes
included) on the entry point. Start the ray a hair along the axis so a screw
never blocks itself.

This is the exact 3D generalisation of v2's rule, and it is still true that a
panel only frees when all of its own screws are gone — so a screw on panel P
and a screw blocked by P are never removable at the same time. The v2 spacing
exemption carries over on the same reasoning.

**Removable is not the same as tappable.** The core decides removable. The
renderer decides what is currently on screen and facing the camera. Rotating is
how the player reaches removable screws on faces turned away. The core never
knows the camera orientation.

## 4. Spacing

Two screws need at least `SCREW_SPACING` of 3D separation when the angle
between their axes is **under 90 degrees** — those can be comfortably tappable
from one camera angle, so they must not compete for the same tap. When their
axes differ by 90 degrees or more, no single angle presents both face-on, and
they need only enough separation that the heads do not physically interpenetrate
(2 x `SCREW_HEAD_R`). The v2 coverage exemption still applies on top: screws
that can never be removable simultaneously need no tap separation at all.

Constants carry over: `SCREW_SPACING` 0.82, `SCREW_EDGE_MARGIN` 0.34,
`SCREW_HEAD_R` 0.23, `SCREW_HIT_R` 0.41.

## 5. Rotation and input

- **Free orbit by dragging.** A drag anywhere spins the assembly; a tap without
  a drag over 12 px removes a screw. The existing 12 px threshold already
  separates the two gestures.
- Use quaternion (trackball-style) accumulation so there is no gimbal pinch and
  no roll surprise. A little inertia on release is welcome; it must settle.
- Do not let the object rotate so the player loses orientation entirely — a
  gentle damping is fine, hard axis locks are not.
- Two-finger gestures, zoom and pan are out of scope. One finger rotates.

## 6. Visibility and hinting the player to rotate

Only screws that are removable **and** front-facing (the rotated axis points
somewhat toward the camera) are drawn solid and are hit-testable. This is the
v2 "do not draw covered screws" decision generalised, and it keeps the draw
budget in the same place.

Because screws now hide around the back, the player needs a reason to turn the
object. Provide a cheap affordance: when a removable screw faces away, hint it
(for example a faint marker at the silhouette edge nearest it, or a subtle
count). Keep it quiet — this is a nudge, not a map. Tune it on screenshots.

## 7. Generation

Build machine-like assemblies: a frame, then nested shells of panels, brackets
and struts attached at varied orientations, outer shells covering inner ones.
Panels sit on many faces, not just the six axis-aligned ones.

Everything measurable from v2 carries over and must still hold:

- Deterministic from the level number; solvable by construction via the real
  `Game` and the lazy box-colour queue recorded into `boxQueue`.
- Non-linearity, with `fronts` now meaning **distinct panels holding a removable
  screw**: avgReachable >= 8, minReachable >= 3, avgFronts >= 3, no run of 4+
  steps under 3 reachable, thresholds scaled down for early levels.
- Active boxes open on distinct colours.
- Screw counts are multiples of 3; colour accounting and queue consistency hold.

Size bands, now measured against a solid rather than a board:

| Levels | Screws | Shells | Panels |
|---|---|---|---|
| 1-3 | 9-12 | 1 | 2-4 |
| 4-30 | 12-30 | 1-2 | 4-10 |
| 31-120 | 30-60 | 2-3 | 10-20 |
| 121-350 | 60-100 | 3-4 | 18-32 |
| 351-700 | 100-140 | 4-5 | 28-45 |
| 701-1000 | 140-190 | 5-6 | 40-60 |

Generation budget stays ~2 s per level. `npm test` samples; `npm run sweep`
verifies all 1000.

## 8. What survives untouched

The colour-matched boxes and the tray, the lose condition and the free-hole
continue, all six power-ups, the solvability bot's role, the solver behind
Hint, the whole of `src/ui`, `src/audio`, `src/storage`, the PWA packaging,
level select, saved and resumable boards, and the progress model. Power-ups
keep their semantics; `drill` removes a blocked screw, now meaning one whose
withdrawal path is obstructed.

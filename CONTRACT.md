# Screwdom 3D — module contract

This file is the agreement between the three parts of the codebase. Each part is
built by a different person against `src/core/types.ts` (the single source of
truth for types, constants and the event stream). **Do not change
`src/core/types.ts` without updating this file and telling the others.**

Stack: Vite 7 + TypeScript (strict) + three.js 0.186, vitest for tests, PWA via
vite-plugin-pwa. No frameworks. Target: iPhone Safari (portrait, touch), also
works on desktop with a mouse.

```
src/core/     game rules, level generator, solver       (owner: CORE)
src/render/   three.js scene, input, animations         (owner: RENDER)
src/ui/       menus, HUD, modals, orchestration         (owner: UI)
src/audio/    WebAudio synthesized sound effects        (owner: UI)
src/storage/  progress + settings in localStorage       (owner: UI)
src/main.ts, index.html, vite.config.ts, public/        (owner: UI)
tests/        vitest tests                              (owner: CORE for core tests)
```

## 1. CORE — `src/core/index.ts` must export

```ts
export * from './types';
export const TOTAL_LEVELS: number;                 // 1000
export function generateLevel(level: number): LevelDef;   // deterministic, 1..TOTAL_LEVELS, solvable by construction
export class Game implements GameApi { constructor(level: LevelDef) }
export function plateContainsWorldPoint(plate: PlateDef, x: number, y: number): boolean;
export function plateWorldOutline(plate: PlateDef): Vec2[];   // outline transformed to world coords (for renderer debugging)
export function solveNextMoves(snapshot: GameSnapshot, maxMoves?: number): number[]; // screw ids the solver would remove next (used by hint)
```

Rules are documented at the top of `src/core/types.ts`. Additional details:

- `generateLevel(n)` must be pure/deterministic (same n ⇒ identical LevelDef) and
  fast (< 50 ms typical). Difficulty ramps with n: more plates, layers, colours,
  screws, mystery screws (from ~level 25). Every colour count is a multiple of
  `BOX_CAPACITY`. `boxQueue.length === screws.length / BOX_CAPACITY`.
- Solvable by construction: the generator simulates a full play-through with the
  real `Game` class (a bot that prefers screws matching active boxes, otherwise
  puts screws in the tray, and picks each new box colour lazily to keep the bot
  alive). If the bot loses, retry with a new sub-seed. The chosen queue is stored
  in `boxQueue`.
- Plates: layer 0 is the bottom. Plates on the same layer never overlap. A plate
  above may partially cover one below. Every plate has ≥ 1 screw. Screws are
  placed inside their plate outline with ≥ 0.45 units margin from the edge and
  ≥ 0.9 units apart from other screws on ANY plate (so screw heads never overlap
  visually). The board region is x ∈ [-3, 3], y ∈ [-4.2, 4.2].
- `Game` is authoritative. Every mutating call returns `ActionResult.events` in
  exact causal order (e.g. `screwToBox` → `boxComplete` → `boxSpawn` →
  `screwToBox(from:'tray')` … → `plateDrop` → `screwsUnblocked` → `screwRevealed` → `win`).
- `snapshot()` returns a fresh deep copy.
- `tapScrew` on a blocked screw: `ok:false, reason:'blocked', events:[{type:'blockedTap'}]`.
- `tapScrew` when the tray is full and no box matches: `ok:false, reason:'trayFull'`,
  events `[{type:'lose'}]`, status → 'lost'. (Screw stays on plate.)
- After the LAST screw enters a box: emit `boxComplete`, no `boxSpawn` if the queue
  is exhausted, then `plateDrop` if applicable, then `win`.
- `usePowerUp('hint')` never mutates; returns `hintScrewIds`.
- `continueAfterLose()` = addSlot + status 'playing' (ignores MAX_BONUS_SLOTS cap).

## 2. RENDER — `src/render/renderer.ts` must export

```ts
export interface RendererOptions { onScrewTap: (screwId: number) => void }
export class GameRenderer {
  constructor(container: HTMLElement, options: RendererOptions);
  /** Build the whole scene from a snapshot (level start / restart). Clears any previous level. */
  loadLevel(snapshot: GameSnapshot): void;
  /** Animate events. Safe to call while earlier events are still animating; resolves when these finish. */
  playEvents(events: GameEvent[]): Promise<void>;
  /** Highlight these screws (pulsing glow) until cleared. Empty array clears. */
  setHint(screwIds: number[]): void;
  /** Toggle "drill targeting" mode: all on-plate screws (even blocked) show a crosshair/outline. */
  setTargetingMode(on: boolean): void;
  /** Pixels reserved by HTML overlays; the camera frames the board between them. */
  setInsets(topPx: number, bottomPx: number): void;
  /** Pause/resume the render loop (menus). */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}
```

Layout in world units (portrait): boxes row at y ≈ +5.3 (positions 0..3 spread
horizontally, centred), plates in y ∈ [-4.2, 4.2], tray row at y ≈ -5.3 with up
to `BASE_TRAY_SLOTS + MAX_BONUS_SLOTS` = 8 slots (centred; bonus slots appear
appended to the right, e.g. a little popup/"+"). The camera is a perspective
camera looking down at the board with a slight tilt so layer depth reads;
`setInsets` + `resize` must keep world x ∈ [-3.4, 3.4] and y ∈ [-6.2, 6.2]
visible inside the non-inset area on any phone aspect ratio.

Visual language (match the real game's feel): bright plastic plates (the
`color` in PlateDef) with bevelled edges and a soft drop shadow per layer;
screws are metallic-coloured cylinders with a domed head + Phillips cross,
colour = `COLOR_HEX[color]`; mystery screws are grey with a "?" until
`screwRevealed`; boxes are open-top coloured boxes with three round holes;
the tray is a metal bar with round holes. Blocked screws are drawn normally
(the plate above covers them physically). `blockedTap` → shake the screw and
flash it. Screw flights: screw unscrews (rotate + lift), arcs to its target,
screws in. Box complete: box lid/closes and slides off-screen; new box slides
in from off-screen. Plate drop: plate tilts and falls out of the bottom of the
screen while fading. Win/lose have no scene-side animation beyond a small
confetti burst on win (optional).

Input: pointer events on the canvas, raycast against screw meshes only,
`onScrewTap(screwId)` for ANY on-plate screw (the core decides if it is
blocked). Use `touch-action: none` on the canvas. Tap must feel instant
(≤ 1 frame latency). Ignore drags > 12 px.

Do not access `Game` directly; the renderer only sees snapshots and events.
Keep the internal visual state in sync with the events; `loadLevel` is the
only hard reset.

## 3. UI — owns everything else

`src/main.ts` → `startApp()` from `src/ui/app.ts`. Screens:

- **Main menu**: title, "Play" (continues at the first uncompleted level, or
  the level the player last chose), "Levels", "Settings". No coins, lives,
  shops, leagues, tiers, timers or ads.
- **Level select**: grid of all `TOTAL_LEVELS`, paged in chunks of 50 with
  prev/next; completed levels show a check; every level is playable (no
  locks); shows difficulty tint.
- **Game screen**: renderer canvas fills the viewport. Top bar: back, level
  number + difficulty, progress bar (`removedScrews/totalScrews`), restart.
  Bottom bar: the six power-ups from `POWER_UPS` with icon + name and a
  "FREE" tag; `drill` enters targeting mode (next tapped screw is drilled;
  tap the button again to cancel). Report insets to the renderer.
- **Win modal**: "Level complete", moves, buttons Next / Levels.
- **Lose modal** ("Out of space"): buttons "Add hole (free)" →
  `game.continueAfterLose()`, "Retry", "Levels".
- **Settings**: sound on/off, reset progress (with confirm), "How to play",
  version + install hint ("Share → Add to Home Screen" on iOS).
- Orchestration: on tap → `game.tapScrew(id)` → `renderer.playEvents(events)`;
  play sound effects keyed by event type; on `win`/`lose` show modal after the
  events resolve. Persist progress on win.
- `src/storage/progress.ts`: `loadProgress()/saveProgress()`, shape
  `{ version: 1, currentLevel: number, completed: number[], settings: { sound: boolean } }`.
- `src/audio/sfx.ts`: `play(name)` for `tap | screwOut | screwIn | boxComplete |
  boxSpawn | plateDrop | blocked | win | lose | powerup | click`, all
  synthesized with WebAudio (no asset files). Unlock the AudioContext on first
  user gesture (iOS).
- PWA: `vite.config.ts` with `VitePWA({ registerType: 'autoUpdate', manifest:
  { name: 'Screwdom 3D', short_name: 'Screwdom', display: 'standalone',
  orientation: 'portrait', theme_color, background_color, icons 192/512 } })`,
  `apple-touch-icon` + `apple-mobile-web-app-capable` meta tags in
  `index.html`, `viewport-fit=cover` and safe-area CSS (`env(safe-area-inset-*)`).
  Icons are generated into `public/icons/` by `scripts/make-icons.mjs` (render
  an inline SVG with headless Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  via `playwright-core`, or any other approach that produces real PNGs).
- Styling: `src/ui/styles.css`, mobile-first, big touch targets (≥ 44 px),
  `user-select: none`, no page scroll/bounce, dark background behind the canvas.

## 4. Integration

`npm run build` (tsc + vite) must pass with zero type errors, `npm test` must
pass. Nobody imports across boundaries except: UI imports from `../core` and
`../render/renderer`; RENDER imports from `../core` (types + geometry helpers
only). Keep each file under ~600 lines; split when bigger.

/**
 * Shared game contract for Screwdom 3D.
 *
 * The board is a SOLID 3D ASSEMBLY (CONTRACT_V3): machine-like panels,
 * brackets and struts bolted onto a frame in nested shells, with screws on
 * faces pointing in many directions. The player rotates the object to reach
 * them.
 *
 * Coordinate system (assembly space):
 *   - Right-handed 3D, +x right, +y up, +z toward the camera at identity
 *     rotation. The assembly is centred on the origin and fits inside a
 *     bounding sphere of radius ASSEMBLY_RADIUS, so it stays framed from any
 *     angle with the boxes row above it and the tray row below it.
 *   - THE OBJECT ROTATES, NOT THE CAMERA. Everything belonging to the assembly
 *     lives under one group whose quaternion the drag gesture drives; the
 *     camera, lights, box row and tray row are fixed. The core never knows the
 *     camera orientation.
 *   - A panel is a 2D outline (`PlateShape`, still the source of truth for hit
 *     testing) extruded along its own local +Z from z = 0 to z = `thickness`,
 *     then placed in assembly space by `rotation` (a unit quaternion) and
 *     `position` (the panel-local origin).
 *   - `shell` is the nesting depth: 0 is the outermost shell, higher numbers
 *     are further in. Outer shells cover inner ones.
 *
 * Rules summary:
 *   - Each screw belongs to exactly one panel, sits at a world position on one
 *     of that panel's faces, and withdraws ALONG `axis` (a unit vector, the
 *     outward normal of the face it sits on).
 *   - A screw is BLOCKED when the ray from `position` along `axis` (started a
 *     hair along the axis so a screw never blocks itself) passes through any
 *     panel that has not yet dropped, other than the screw's own panel.
 *     Otherwise it is REACHABLE and may be tapped. Because panels never move,
 *     the set of panels a screw's ray crosses is static: only their dropped
 *     flags change.
 *   - REMOVABLE IS NOT THE SAME AS TAPPABLE. The core decides removable; the
 *     renderer decides what is currently on screen and facing the camera.
 *     Rotating is how the player reaches removable screws on faces turned away.
 *   - Tapping a reachable screw removes it. If an active box of the same colour
 *     has room it flies into that box; otherwise it goes to the first free
 *     tray slot. If the tray is full, the tap is refused with `reason: 'trayFull'`
 *     and the game status becomes 'lost' (the UI offers a free "Add hole" to
 *     continue, or Retry).
 *   - A box holds exactly BOX_CAPACITY (3) screws. When full it is completed and
 *     the next box from the level's `boxQueue` slides into its place. Screws
 *     waiting in the tray that match the new box are moved into it automatically
 *     (oldest tray slot first) — this can chain if the new box fills up.
 *   - When every screw on a panel has been removed the panel falls away, which
 *     may unblock screws behind it (on inner shells, on struts, anywhere its
 *     body used to stand in the way).
 *   - The level is won when all screws are gone.
 *
 * Power-ups (all free & unlimited in this build):
 *   - drill:     remove ANY screw, even one whose withdrawal path is obstructed
 *                (it still needs box/tray room)
 *   - addSlot:   add one temporary tray slot (up to MAX_BONUS_SLOTS per level)
 *   - addBox:    add an extra active box whose colour is chosen to help most
 *                (colour with the most screws in tray+reachable, capped at BOX_CAPACITY per level)
 *   - recolor:   change the colour of the active box that is emptiest to the colour
 *                that is most represented in the tray (or reachable screws). Screws
 *                already in that box are returned to the pool: they are re-hidden
 *                back onto their panels? NO — simpler rule: recolor is only allowed
 *                on an EMPTY active box. If no active box is empty the power-up is
 *                refused with reason 'noEmptyBox'.
 *   - magnet:    pull every reachable screw matching any active box colour into
 *                the boxes at once (as many as fit).
 *   - hint:      returns the list of screws the built-in solver would remove next;
 *                no state change.
 */

export const BOX_CAPACITY = 3;
export const BASE_TRAY_SLOTS = 5;
export const MAX_BONUS_SLOTS = 3;
export const MAX_ACTIVE_BOXES = 4;

/**
 * Every panel of an assembly lies inside this sphere around the origin
 * (CONTRACT_V3 §1), so the object stays framed at any rotation.
 */
export const ASSEMBLY_RADIUS = 3.0;

/** Screw colour ids. Renderer maps these to hex colours (see COLOR_HEX). */
export type ScrewColor =
  | 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'cyan' | 'pink';

export const ALL_COLORS: ScrewColor[] = [
  'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink',
];

export const COLOR_HEX: Record<ScrewColor, number> = {
  red: 0xe8453c,
  blue: 0x3b7df0,
  green: 0x3ec25c,
  yellow: 0xf5c518,
  purple: 0x9b5de5,
  orange: 0xf28c28,
  cyan: 0x2ec4d6,
  pink: 0xf25fa4,
};

export type PlateShapeKind =
  | 'rect' | 'roundedRect' | 'circle' | 'L' | 'T' | 'triangle' | 'hexagon'
  | 'ring' | 'cross' | 'capsule' | 'polygon';

/**
 * A plate shape is always given as a polygon (list of points in plate-local
 * coordinates, counter-clockwise) plus optional holes (for 'ring'). `kind` is a
 * hint for the renderer (e.g. use bevelled/rounded geometry) — the polygon is
 * the source of truth for hit testing, and the renderer MAY simply extrude it.
 */
export interface PlateShape {
  kind: PlateShapeKind;
  /** Outer outline, plate-local coords, CCW. */
  outline: Vec2[];
  /** Optional inner holes (each CW or CCW — renderer/geometry must not care). */
  holes?: Vec2[][];
}

export interface Vec2 { x: number; y: number }

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
  /**
   * Mystery screw: its colour is unknown to the player (rendered grey with '?')
   * until it first becomes reachable. Core exposes `revealed` in ScrewState.
   */
  hidden: boolean;
}

export interface LevelDef {
  /** 1-based level number. */
  level: number;
  /** Seed actually used (after solvability retries). */
  seed: number;
  panels: PanelDef[];
  screws: ScrewDef[];
  /**
   * Full ordered queue of box colours. The first `activeBoxCount` entries are
   * the boxes visible at start; each completed box is replaced by the next
   * entry. Length === totalScrews / BOX_CAPACITY.
   */
  boxQueue: ScrewColor[];
  activeBoxCount: number;
  traySlots: number; // usually BASE_TRAY_SLOTS
  /** Distinct colours used, for the UI. */
  colors: ScrewColor[];
  /** Difficulty label for the UI ('easy' | 'normal' | 'hard' | 'extreme'). */
  difficulty: 'easy' | 'normal' | 'hard' | 'extreme';
}

/* ------------------------------------------------------------------------ */
/* Runtime state                                                             */
/* ------------------------------------------------------------------------ */

export type ScrewLocation = 'plate' | 'tray' | 'box' | 'gone';

export interface ScrewState {
  id: number;
  color: ScrewColor;
  panelId: number;
  location: ScrewLocation;
  /** True when the colour is visible to the player. Always true for non-hidden screws. */
  revealed: boolean;
  /** Withdrawal path obstructed by a panel (only meaningful while location === 'plate'). */
  blocked: boolean;
  /** Tray slot index while location === 'tray'. */
  traySlot?: number;
  /** Box id while location === 'box'. */
  boxId?: number;
  /** Slot index inside the box (0..BOX_CAPACITY-1) while location === 'box'. */
  boxSlot?: number;
}

export interface BoxState {
  id: number;
  color: ScrewColor;
  /** Screw ids in fill order (length <= BOX_CAPACITY). */
  screws: number[];
  /** Which of the visible box positions (0..activeBoxCount-1) this box occupies. */
  position: number;
  /** True once it has BOX_CAPACITY screws (it is removed from `boxes` right after). */
  completed: boolean;
}

export interface PanelState {
  id: number;
  dropped: boolean;
  /** Screws still attached (ids). */
  remainingScrews: number[];
}

export type GameStatus = 'playing' | 'won' | 'lost';

export interface GameSnapshot {
  level: LevelDef;
  status: GameStatus;
  screws: ScrewState[];
  panels: PanelState[];
  /** Active boxes, ordered by `position`. */
  boxes: BoxState[];
  /** Index into level.boxQueue of the next box to spawn. */
  nextBoxIndex: number;
  /** Tray: screw id or null per slot. Length = traySlots + bonusSlots. */
  tray: (number | null)[];
  bonusSlots: number;
  moves: number;
  /** Total screws in the level. */
  totalScrews: number;
  /** Screws already put into boxes (for progress bar). */
  removedScrews: number;
}

/* ------------------------------------------------------------------------ */
/* Events — emitted in order; the renderer animates them sequentially.       */
/* ------------------------------------------------------------------------ */

export type GameEvent =
  /** A screw left its panel and flew into a box. */
  | { type: 'screwToBox'; screwId: number; boxId: number; boxSlot: number; from: 'plate' | 'tray' }
  /** A screw left its panel and went to a tray slot. */
  | { type: 'screwToTray'; screwId: number; traySlot: number }
  /** A box reached capacity and leaves the screen. */
  | { type: 'boxComplete'; boxId: number; position: number }
  /** A new box slides into `position`. */
  | { type: 'boxSpawn'; box: BoxState }
  /** A panel has no screws left and falls away. */
  | { type: 'panelDrop'; panelId: number }
  /** Previously blocked screws are now reachable (may also reveal mystery screws). */
  | { type: 'screwsUnblocked'; screwIds: number[] }
  /** A mystery screw's colour became visible. */
  | { type: 'screwRevealed'; screwId: number; color: ScrewColor }
  /** A tray slot was added by the addSlot power-up. */
  | { type: 'traySlotAdded'; slotIndex: number }
  /** An empty box changed colour (recolor power-up). */
  | { type: 'boxRecolored'; boxId: number; color: ScrewColor }
  /** The player tapped a blocked screw (renderer shakes it, plays a "nope" sound). */
  | { type: 'blockedTap'; screwId: number }
  | { type: 'win' }
  | { type: 'lose'; reason: 'trayFull' };

export type PowerUpId = 'drill' | 'addSlot' | 'addBox' | 'recolor' | 'magnet' | 'hint';

export const POWER_UPS: { id: PowerUpId; name: string; description: string; needsTarget: boolean }[] = [
  { id: 'drill',   name: 'Drill',     description: 'Remove any screw, even a blocked one.', needsTarget: true },
  { id: 'addSlot', name: 'Extra Hole', description: 'Add a temporary slot to the tray.', needsTarget: false },
  { id: 'addBox',  name: 'Magic Box', description: 'Add an extra box for the colour you need most.', needsTarget: false },
  { id: 'recolor', name: 'Repaint',   description: 'Change an empty box to the colour you need most.', needsTarget: false },
  { id: 'magnet',  name: 'Magnet',    description: 'Pull every matching reachable screw into the boxes.', needsTarget: false },
  { id: 'hint',    name: 'Hint',      description: 'Highlight the best screws to remove next.', needsTarget: false },
];

export interface ActionResult {
  ok: boolean;
  /** Why the action was refused (only when ok === false). */
  reason?: 'notPlaying' | 'blocked' | 'trayFull' | 'noSuchScrew' | 'notOnPlate'
         | 'noEmptyBox' | 'maxSlots' | 'maxBoxes' | 'nothingToDo';
  events: GameEvent[];
  /** For 'hint': the screw ids to highlight. */
  hintScrewIds?: number[];
}

/**
 * Public API of the core engine (implemented by src/core/game.ts as `class Game`).
 *
 *   const game = new Game(level);
 *   const res = game.tapScrew(id);     // ActionResult
 *   game.usePowerUp('drill', screwId)  // ActionResult (target optional except for drill)
 *   game.snapshot()                    // GameSnapshot (fresh deep copy every call)
 *   game.reachableScrewIds()           // number[]
 *   game.continueAfterLose()           // adds a bonus slot (same as addSlot) and sets status back to 'playing'
 */
export interface GameApi {
  snapshot(): GameSnapshot;
  tapScrew(screwId: number): ActionResult;
  usePowerUp(id: PowerUpId, targetScrewId?: number): ActionResult;
  reachableScrewIds(): number[];
  continueAfterLose(): ActionResult;
}

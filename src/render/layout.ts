/**
 * World-space layout constants shared by every render module.
 *
 * v3 (CONTRACT_V3.md §1): the board is no longer a flat stack. The assembly is
 * a solid object centred on the origin inside a bounding sphere of radius
 * ASSEMBLY_RADIUS, and it is the OBJECT that rotates — the camera, the lights,
 * the box row at y = +5.3 and the tray row at y = -5.3 are all fixed in world
 * space, which is why the v2 box/tray layout, framing and insets code carries
 * over untouched.
 */

/** CONTRACT_V3 §1: the assembly fits inside this radius so it stays framed from any angle. */
export const ASSEMBLY_RADIUS = 3.0;

/**
 * Per-level zoom (see `GameRenderer.loadLevel`).
 *
 * ASSEMBLY_RADIUS is the radius a level MAY use, not the radius it does use:
 * level 1 is a 1.2-unit object and level 1000 a 2.7-unit one, so framing the
 * constant leaves the first level marooned in an empty screen.
 *
 * The camera cannot simply come closer, because what pins the framing is the
 * box row at y = +5.3 and the tray row at y = -5.3, not the object — moving in
 * would push them off screen. So the OBJECT is scaled up instead: its own
 * bounding sphere is zoomed to fill ASSEMBLY_RADIUS, the camera, lights, boxes
 * and tray never move, and every level ends up the same apparent size. That
 * also keeps the drag gain honest, since the gain is calibrated against the
 * apparent radius.
 */
export const MAX_ASSEMBLY_ZOOM = 2.6;
/** Never zoom out: a full-size level is framed exactly as it is today. */
export const MIN_ASSEMBLY_ZOOM = 1;
/** Guard against a degenerate (near-zero) level radius. */
export const MIN_LEVEL_RADIUS = 0.4;

/** Chamfer applied to every extruded panel (see panelMesh.ts). */
export const PANEL_BEVEL = 0.018;

export const BOX_Y = 5.3;
export const TRAY_Y = -5.3;
/** y where boxes appear from / leave to. */
export const OFFSCREEN_Y = 9.8;

export const BOX_WIDTH = 1.5;
export const BOX_DEPTH = 1.05;
export const BOX_HEIGHT = 0.68;
export const BOX_SLOT_SPACING = 0.5;
export const BOX_HOLE_R = 0.18;

export const TRAY_SLOT_SPACING = 0.72;
export const TRAY_DEPTH = 0.95;
export const TRAY_HEIGHT = 0.3;
export const TRAY_PAD = 0.34;
export const TRAY_HOLE_R = 0.2;

export const SCREW_HEAD_R = 0.23;
export const SCREW_HIT_R = 0.41;

/**
 * Bounding region the camera must keep visible: the boxes/tray rows in y, and
 * the whole bounding sphere of the assembly in x/z (the object can turn any
 * way, so the z extent is now as wide as the x extent).
 */
export const VIEW_BOUNDS = {
  x: 3.7,
  y: 6.2,
  zMin: -ASSEMBLY_RADIUS - 0.25,
  zMax: ASSEMBLY_RADIUS + 0.25,
};

/* ------------------------------------------------------------------------ */
/* Visibility (CONTRACT_V3 §6)                                               */
/* ------------------------------------------------------------------------ */

/**
 * A screw counts as front-facing when its ROTATED axis points at least this
 * much toward the camera. cos 72° lets the player reach a screw well before its
 * face turns fully to camera (so a quarter turn always brings in a new crop),
 * while still hiding anything that would be seen edge-on or from behind.
 *
 * One single threshold, no hysteresis: the tappable set has to be exactly
 * "removable ∩ front-facing" at any resting orientation, and a hysteresis band
 * would make that set depend on how the object got there.
 */
export const FACING_MIN_DOT = 0.31;

/* ------------------------------------------------------------------------ */
/* Depth legibility                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Aerial-perspective tint, matched to the scene clear colour. In v3 it is keyed
 * to the panel's SHELL rather than a stack layer: inner shells sit deeper
 * inside the object and are seen through the holes of the outer ones, so
 * fading them keeps the outer silhouette readable.
 */
export const DEPTH_TINT = 0x161c33;

/** Strongest fog applied to the innermost shell of a deep assembly. */
export const PANEL_DEPTH_FOG = 0.42;
/** Screws are tinted far less: their colour is the core mechanic. */
export const SCREW_DEPTH_FOG = 0.18;

/** Fog amount for a panel/screw on `shell`, 0 = outermost. */
export function shellFogAmount(shell: number, strength: number): number {
  const depth = Math.max(0, shell);
  if (depth === 0) return 0;
  return strength * (1 - Math.exp(-0.5 * depth));
}

/** Horizontal centres for `n` box positions, centred and fitting x ∈ [-3.2, 3.2]. */
export function boxPositionsX(n: number): number[] {
  const count = Math.max(1, n);
  const spacing = Math.min(1.72, 6.4 / count);
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

/**
 * Slot pitch for `n` tray slots. Deep levels raise BASE_TRAY_SLOTS, so the bar
 * tightens its pitch once the default 0.72 would push it off screen.
 */
export function traySlotSpacing(n: number): number {
  const count = Math.max(1, n);
  return Math.min(TRAY_SLOT_SPACING, (2 * VIEW_BOUNDS.x - 0.3 - TRAY_PAD) / count);
}

/** Horizontal centres for `n` tray slots (local to the tray group, centred). */
export function trayPositionsX(n: number): number[] {
  const count = Math.max(1, n);
  const spacing = traySlotSpacing(count);
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

export function trayWidth(n: number): number {
  const count = Math.max(1, n);
  return count * traySlotSpacing(count) + TRAY_PAD;
}

/**
 * Direction of the key light (see scene.ts). Fixed in world space like the
 * camera, so turning the object moves the highlight across it — which is most
 * of what sells the assembly as a solid rather than a picture.
 */
export const KEY_LIGHT = { x: 5.5, y: 7.6, z: 9.0 };

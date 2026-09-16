/**
 * World-space layout constants shared by every render module.
 * Board is in the XY plane (x right, y up), layers stack along +z toward the camera.
 */

export const LAYER_SPACING = 0.28;
export const PLATE_THICKNESS = 0.22;
export const PLATE_BEVEL = 0.04;

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

export const SCREW_HEAD_R = 0.25;
export const SCREW_HIT_R = 0.45;

/** Bounding region the camera must keep visible (contract §2). */
export const VIEW_BOUNDS = { x: 3.4, y: 6.2, zMin: -0.4, zMax: 1.8 };

export function plateBottomZ(layer: number): number {
  return layer * LAYER_SPACING;
}

export function plateTopZ(layer: number): number {
  return layer * LAYER_SPACING + PLATE_THICKNESS;
}

/** Horizontal centres for `n` box positions, centred and fitting x ∈ [-3.2, 3.2]. */
export function boxPositionsX(n: number): number[] {
  const count = Math.max(1, n);
  const spacing = Math.min(1.72, 6.4 / count);
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

/** Horizontal centres for `n` tray slots (local to the tray group, centred). */
export function trayPositionsX(n: number): number[] {
  const count = Math.max(1, n);
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * TRAY_SLOT_SPACING);
}

export function trayWidth(n: number): number {
  return Math.max(1, n) * TRAY_SLOT_SPACING + TRAY_PAD;
}

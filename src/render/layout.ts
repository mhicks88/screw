/**
 * World-space layout constants shared by every render module.
 * Board is in the XY plane (x right, y up), layers stack along +z toward the camera.
 *
 * v2 depth budget (CONTRACT_V2.md §3): levels reach 15 layers, so the per-layer
 * step and the plate thickness shrink to thin overlapping sheets. A 15-layer
 * stack occupies `14 * 0.12 + 0.10 = 1.78` world units, which fits inside
 * VIEW_BOUNDS.zMax = 2.0 together with the screw heads standing on top of it.
 */

export const LAYER_SPACING = 0.12;
export const PLATE_THICKNESS = 0.10;
export const PLATE_BEVEL = 0.022;

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

/** Bounding region the camera must keep visible (contract §2, retuned in v2 §3). */
export const VIEW_BOUNDS = { x: 3.7, y: 6.2, zMin: -0.4, zMax: 2.0 };

/* ------------------------------------------------------------------------ */
/* Depth legibility                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Aerial-perspective tint. Lower layers are lerped toward this colour so the
 * stack reads as depth even though consecutive plates are only 0.12 apart.
 * It matches the scene clear colour, so "deep" reads as "further into the
 * background" rather than "a different, muddier plastic".
 */
export const DEPTH_TINT = 0x161c33;

/** Strongest fog applied to the bottom-most layer of a deep stack. */
export const PLATE_DEPTH_FOG = 0.62;
/**
 * Screws are tinted far less: their colour is the core mechanic and a reachable
 * screw can legitimately sit on layer 0.
 */
export const SCREW_DEPTH_FOG = 0.26;

/**
 * Fog amount for a plate/screw on `layer` inside a stack topped by `maxLayer`.
 *
 * Keyed to the *absolute* number of layers below the top rather than a
 * normalised 0..1, so one layer down always looks one layer down whether the
 * level is 3 deep or 15 deep, and consecutive plates near the top — the ones
 * the player actually reads — differ by a visible step.
 */
export function depthFogAmount(layer: number, maxLayer: number, strength: number): number {
  const depth = Math.max(0, maxLayer - layer);
  if (depth === 0) return 0;
  return strength * (1 - Math.exp(-0.4 * depth));
}

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

/**
 * Slot pitch for `n` tray slots. CONTRACT_V2 §6 expects deep levels to raise
 * BASE_TRAY_SLOTS, so the bar tightens its pitch once the default 0.72 would
 * push it outside VIEW_BOUNDS.x rather than running off the screen.
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
 * Direction of the key light (see scene.ts). Contact shadows are offset along
 * its projection onto the board plane, so the fake shadows agree with the
 * shading on the plate sides.
 */
export const KEY_LIGHT = { x: 5.5, y: 7.6, z: 9.0 };

/** Board-plane offset of a contact shadow cast from `height` above a surface. */
export function contactShadowOffset(height: number): { x: number; y: number } {
  return { x: (-KEY_LIGHT.x / KEY_LIGHT.z) * height, y: (-KEY_LIGHT.y / KEY_LIGHT.z) * height };
}

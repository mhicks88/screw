/**
 * The blocking rule (CONTRACT_V3 §3).
 *
 *   A screw is REMOVABLE iff the ray from its position along its axis, out to
 *   the assembly's bounding sphere, passes through no panel that is still in
 *   place other than its own.
 *
 * Panels never move — they only drop — so the set of panels a screw's ray
 * crosses is STATIC. `computeBlockers` casts every ray once when a level is
 * loaded (BVH-accelerated, a couple of tenths of a millisecond for 190 screws
 * and 60 panels) and the game then answers "is this screw blocked?" in
 * O(blockers) with a dropped-flag lookup, after every move, for every screw.
 * That is the whole reason the rule is affordable.
 */
import { ASSEMBLY_RADIUS, type PanelDef, type ScrewDef, type Vec3 } from './types';
import { PanelBvh, addV3, scaleV3 } from './geometry3';

/**
 * The ray starts a hair along the axis so a screw can never block itself
 * (§3). The screw's own panel is excluded from the query as well, so this is
 * belt and braces — it also keeps a screw from being blocked by a panel it is
 * flush against.
 */
export const RAY_START_OFFSET = 1e-3;

/** Longest a withdrawal ray can be: a chord of the bounding sphere. */
export const RAY_LENGTH = 2 * ASSEMBLY_RADIUS;

export function rayOriginFor(screw: { position: Vec3; axis: Vec3 }): Vec3 {
  return addV3(screw.position, scaleV3(screw.axis, RAY_START_OFFSET));
}

/**
 * For every screw, the INDICES (into `panels`) of the panels its withdrawal
 * ray passes through, excluding its own panel. A screw is blocked whenever any
 * of them is still in place.
 */
export function computeBlockers(
  panels: readonly PanelDef[],
  screws: readonly { panelId: number; position: Vec3; axis: Vec3 }[],
  bvh: PanelBvh = new PanelBvh(panels),
): number[][] {
  const indexById = new Map<number, number>();
  panels.forEach((p, i) => indexById.set(p.id, i));
  return screws.map((s) => {
    const own = indexById.get(s.panelId);
    return bvh.query(rayOriginFor(s), s.axis, RAY_LENGTH, own === undefined ? -1 : own);
  });
}

/** Single-screw version (same rule, for tests and one-off queries). */
export function blockersForScrew(
  panels: readonly PanelDef[],
  screw: { panelId: number; position: Vec3; axis: Vec3 },
  bvh: PanelBvh = new PanelBvh(panels),
): number[] {
  return computeBlockers(panels, [screw], bvh)[0];
}

/**
 * Screws whose ray is clear when `dropped` (by panel index) is taken into
 * account. Used by tests and the sweep to re-derive reachability from scratch,
 * independently of the Game's incremental bookkeeping.
 */
export function reachableScrews(
  screws: readonly ScrewDef[],
  blockers: readonly number[][],
  dropped: (panelIndex: number) => boolean,
): number[] {
  const out: number[] = [];
  screws.forEach((s, i) => {
    if (blockers[i].every(dropped)) out.push(s.id);
  });
  return out;
}

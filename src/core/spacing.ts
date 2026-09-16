/**
 * The spacing rule (CONTRACT_V3 §4) and the tuning constants it is built on.
 *
 * Two screws must not compete for the same tap. In 3D "the same tap" depends on
 * where they point:
 *
 *   - axes within 90 degrees of each other (dot > 0): both can be presented
 *     face-on from one camera angle, so they need the full `SCREW_SPACING` of
 *     3D separation, exactly as v2 demanded in the plane;
 *   - axes 90 degrees apart or more (dot <= 0): no single angle shows both
 *     face-on — turn towards one and the other is edge-on or behind — so they
 *     only need enough room that the heads do not physically interpenetrate,
 *     2 * SCREW_HEAD_R.
 *
 * On top of that, v2's coverage exemption carries over unchanged in meaning:
 * screws that can NEVER be removable at the same time cannot produce an
 * ambiguous tap however close they are. In v2 that was "one sits under the
 * other's plate"; in 3D it is the exact generalisation — screw B's withdrawal
 * ray passes through screw A's panel P. Then B is blocked until P falls, and P
 * only falls once every screw on it, including A, is gone. So A and B are never
 * simultaneously removable. Same proof, same guarantee.
 *
 * `ScrewIndex3` is the bulk version the generator uses: a uniform 3D hash grid
 * with SCREW_SPACING cells, so a candidate only ever compares against the 27
 * neighbouring cells.
 */
import type { Vec3 } from './types';

/**
 * The tap pitch, in world units.
 *
 * DEVIATION FROM CONTRACT_V3 §4, and a deliberate one. v2 derived 0.82 world
 * units from the screen: its board was 8.4 world units tall, which measured
 * 57.9 CSS px per unit on the target device, so 0.82 units was a 47.5 px tap
 * pitch — comfortably over Apple's 44 pt minimum. v3's assembly is a sphere of
 * radius 3, six units tall against the same vertical budget, so the SAME screen
 * framing now gives about 81 px per world unit. Carrying 0.82 over unchanged
 * would have silently inflated the tap pitch to 66 px and cost the level about
 * 40% of its screws in the process — the reason a first pass at this generator
 * could not get past ~100 screws however the panels were arranged.
 *
 * 0.62 world units is 50 CSS px at the v3 framing: still MORE generous than the
 * pitch v2 shipped, and it is what lets a level carry 140-190 screws inside the
 * bounding sphere. The renderer should size SCREW_HIT_R to match (~0.31, half
 * the pitch, so neighbouring hit spheres meet but do not overlap).
 */
export const SCREW_SPACING = 0.62;
export const SCREW_EDGE_MARGIN = 0.34;
export const SCREW_HEAD_R = 0.23;
/**
 * Tap radius. Half the pitch, so neighbouring hit spheres meet but never
 * overlap — the property v2's 0.41 had against its 0.82 pitch, kept against
 * the v3 pitch. (src/render/layout.ts keeps its own copy for the renderer;
 * they must agree.)
 */
export const SCREW_HIT_R = SCREW_SPACING / 2;
/**
 * Clearance kept between two panels' bodies so they never interpenetrate. It is
 * applied to BOTH panels of a pair, so the real gap between two panels is twice
 * this — which has to stay comfortably under SHELL_STEP minus a panel's
 * thickness, or consecutive shells cannot coexist at all.
 */
export const PANEL_GAP = 0.02;

/** Separation two screw heads need just to not overlap each other. */
export const HEAD_CLEARANCE = 2 * SCREW_HEAD_R;

const SPACING2 = SCREW_SPACING * SCREW_SPACING;
const HEAD2 = HEAD_CLEARANCE * HEAD_CLEARANCE;

/** A placed screw, before colours are assigned. */
export interface ScrewSpot {
  panelId: number;
  position: Vec3;
  axis: Vec3;
}

/**
 * Axes this close to perpendicular count as perpendicular. Chassis faces are
 * built at exactly 90 degrees, and a float dot product of 1e-17 must not flip
 * a whole seam of screws into the strict rule.
 */
const PERPENDICULAR_EPS = 1e-6;

/** How far apart two screws must be, given the angle between their axes (§4). */
export function requiredSeparation(axisA: Vec3, axisB: Vec3): number {
  const dot = axisA.x * axisB.x + axisA.y * axisB.y + axisA.z * axisB.z;
  return dot > PERPENDICULAR_EPS ? SCREW_SPACING : HEAD_CLEARANCE;
}

function separationOk(a: ScrewSpot, b: ScrewSpot): boolean {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  const dz = a.position.z - b.position.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const dot = a.axis.x * b.axis.x + a.axis.y * b.axis.y + a.axis.z * b.axis.z;
  return d2 >= (dot > PERPENDICULAR_EPS ? SPACING2 : HEAD2);
}

/**
 * The v2 coverage exemption, generalised: true when the two screws can never be
 * removable at the same time, because one of them is blocked by the other's
 * panel. `blockersA` / `blockersB` are the panel IDS each screw's ray passes
 * through (see ./blocking, which returns indices — pass ids here).
 */
export function coverageExempt(
  a: ScrewSpot, blockersA: readonly number[],
  b: ScrewSpot, blockersB: readonly number[],
): boolean {
  return blockersB.includes(a.panelId) || blockersA.includes(b.panelId);
}

/** True when two screws may coexist: far enough apart (§4), or never both removable. */
export function pairSpacingOk(
  a: ScrewSpot, b: ScrewSpot,
  blockersA: readonly number[] = [], blockersB: readonly number[] = [],
): boolean {
  if (separationOk(a, b)) return true;
  // Heads must never physically interpenetrate, exemption or not.
  return coverageExempt(a, blockersA, b, blockersB) && !headsOverlap(a, b);
}

function headsOverlap(a: ScrewSpot, b: ScrewSpot): boolean {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  const dz = a.position.z - b.position.z;
  return dx * dx + dy * dy + dz * dz < HEAD2;
}

/**
 * Uniform 3D grid over placed screws. A candidate is compared only against the
 * 27 cells around it (cell size = SCREW_SPACING, the largest separation the
 * rule can ask for), which makes placement O(1) amortised per candidate.
 */
export class ScrewIndex3 {
  private readonly cells = new Map<number, number[]>();
  private readonly spots: ScrewSpot[] = [];
  private readonly blockers: number[][] = [];

  get size(): number { return this.spots.length; }

  private static key(ix: number, iy: number, iz: number): number {
    return ((ix + 64) * 128 + (iy + 64)) * 128 + (iz + 64);
  }

  private static cell(v: number): number { return Math.floor(v / SCREW_SPACING); }

  /** May a screw be placed here, given the panel ids its ray would cross? */
  canPlace(spot: ScrewSpot, blockers: readonly number[]): boolean {
    const ix = ScrewIndex3.cell(spot.position.x);
    const iy = ScrewIndex3.cell(spot.position.y);
    const iz = ScrewIndex3.cell(spot.position.z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(ScrewIndex3.key(ix + dx, iy + dy, iz + dz));
          if (list === undefined) continue;
          for (const j of list) {
            if (!pairSpacingOk(spot, this.spots[j], blockers, this.blockers[j])) return false;
          }
        }
      }
    }
    return true;
  }

  add(spot: ScrewSpot, blockers: readonly number[]): void {
    const j = this.spots.length;
    this.spots.push(spot);
    this.blockers.push([...blockers]);
    const key = ScrewIndex3.key(
      ScrewIndex3.cell(spot.position.x), ScrewIndex3.cell(spot.position.y), ScrewIndex3.cell(spot.position.z),
    );
    const list = this.cells.get(key);
    if (list) list.push(j);
    else this.cells.set(key, [j]);
  }
}

/** Brute-force check of the whole rule set (tests / sweep verification). */
export function spacingViolations(
  screws: readonly ScrewSpot[],
  blockerIds: readonly (readonly number[])[],
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < screws.length; i++) {
    for (let j = i + 1; j < screws.length; j++) {
      if (!pairSpacingOk(screws[i], screws[j], blockerIds[i] ?? [], blockerIds[j] ?? [])) out.push([i, j]);
    }
  }
  return out;
}

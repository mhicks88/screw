/**
 * The spacing rule (CONTRACT_V2 §2) and the tuning constants it is built on.
 *
 * Two screws must be `SCREW_SPACING` apart unless one of them is physically
 * hidden beneath the other's plate, because a plate only drops once all of its
 * own screws are gone — so the two are never tappable at the same time and can
 * never produce an ambiguous tap. `pairSpacingOk` is the literal predicate;
 * `ScrewIndex` is the bulk version the generator uses (a uniform grid for the
 * proximity query plus AABB-gated plate coverage tests).
 */
import type { PlateDef } from './types';
import { plateContainsWorldPoint, plateWorldOutline, polygonAabb, type Aabb } from './geometry';

export const BOARD = { minX: -3.35, maxX: 3.35, minY: -4.2, maxY: 4.2 };
export const SCREW_EDGE_MARGIN = 0.34;
export const SCREW_SPACING = 0.82;
export const PLATE_GAP = 0.1;

const SPACING2 = SCREW_SPACING * SCREW_SPACING;

/** A placed screw position, before colours are assigned. */
export interface ScrewSpot { plateId: number; x: number; y: number }

/**
 * CONTRACT_V2 §2: spacing between two screws is NOT required when one of them
 * is hidden beneath the other's plate, because a plate only drops once all of
 * its own screws are gone — so the two are never tappable at the same time.
 * Screws on the same layer (and on the same plate) are never exempt.
 */
export function coverageExempt(a: PlateDef, ax: number, ay: number, b: PlateDef, bx: number, by: number): boolean {
  if (a.layer > b.layer && plateContainsWorldPoint(a, bx, by)) return true;
  if (b.layer > a.layer && plateContainsWorldPoint(b, ax, ay)) return true;
  return false;
}

/** True when two screws may coexist: far enough apart, or covered (§2). */
export function pairSpacingOk(a: PlateDef, ax: number, ay: number, b: PlateDef, bx: number, by: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  if (dx * dx + dy * dy >= SPACING2) return true;
  return coverageExempt(a, ax, ay, b, bx, by);
}

/**
 * Bulk version of `pairSpacingOk` for generation. Screws go into a uniform grid
 * with cell size SCREW_SPACING, so a proximity query only ever scans the 3x3
 * cell block around the candidate; the (rare) close pairs are then resolved
 * with an AABB-gated point-in-plate test. O(1) amortised per candidate.
 */
export class ScrewIndex {
  private readonly aabbs: Aabb[];
  private readonly cells = new Map<number, number[]>();
  private readonly sx: number[] = [];
  private readonly sy: number[] = [];
  private readonly sp: number[] = [];

  constructor(private readonly plates: readonly PlateDef[]) {
    this.aabbs = plates.map((p) => polygonAabb(plateWorldOutline(p)));
  }

  get size(): number { return this.sx.length; }

  private static key(ix: number, iy: number): number { return (ix + 512) * 4096 + (iy + 512); }

  /** Plate `pi` physically covers the world point (AABB pre-filter first). */
  private covers(pi: number, x: number, y: number): boolean {
    const a = this.aabbs[pi];
    if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) return false;
    return plateContainsWorldPoint(this.plates[pi], x, y);
  }

  /** May a screw for plate index `pi` be placed at (x, y)? */
  canPlace(pi: number, x: number, y: number): boolean {
    const layer = this.plates[pi].layer;
    const ix = Math.floor(x / SCREW_SPACING);
    const iy = Math.floor(y / SCREW_SPACING);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(ScrewIndex.key(ix + dx, iy + dy));
        if (list === undefined) continue;
        for (let k = 0; k < list.length; k++) {
          const j = list[k];
          const ddx = this.sx[j] - x;
          const ddy = this.sy[j] - y;
          if (ddx * ddx + ddy * ddy >= SPACING2) continue;
          const qi = this.sp[j];
          const qLayer = this.plates[qi].layer;
          if (qLayer > layer) {
            if (this.covers(qi, x, y)) continue;   // candidate hides under the neighbour's plate
          } else if (layer > qLayer) {
            if (this.covers(pi, this.sx[j], this.sy[j])) continue; // neighbour hides under ours
          }
          return false;
        }
      }
    }
    return true;
  }

  add(pi: number, x: number, y: number): void {
    const j = this.sx.length;
    this.sx.push(x);
    this.sy.push(y);
    this.sp.push(pi);
    const key = ScrewIndex.key(Math.floor(x / SCREW_SPACING), Math.floor(y / SCREW_SPACING));
    const list = this.cells.get(key);
    if (list) list.push(j);
    else this.cells.set(key, [j]);
  }
}

/** Brute-force check of the whole rule set (tests / sweep verification). */
export function spacingViolations(plates: readonly PlateDef[], screws: readonly ScrewSpot[]): [number, number][] {
  const byId = new Map(plates.map((p) => [p.id, p]));
  const out: [number, number][] = [];
  for (let i = 0; i < screws.length; i++) {
    for (let j = i + 1; j < screws.length; j++) {
      const a = screws[i];
      const b = screws[j];
      if (!pairSpacingOk(byId.get(a.plateId)!, a.x, a.y, byId.get(b.plateId)!, b.x, b.y)) out.push([i, j]);
    }
  }
  return out;
}


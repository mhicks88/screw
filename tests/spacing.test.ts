import { describe, expect, it } from 'vitest';
import {
  HEAD_CLEARANCE, SCREW_EDGE_MARGIN, SCREW_HEAD_R, SCREW_SPACING, ScrewIndex3,
  coverageExempt, pairSpacingOk, requiredSeparation, spacingViolations, type ScrewSpot,
} from '../src/core/spacing';
import { normalizeV3, v3 } from '../src/core/geometry3';

const at = (x: number, y: number, z: number, axis = v3(0, 0, 1), panelId = 0): ScrewSpot =>
  ({ panelId, position: v3(x, y, z), axis: normalizeV3(axis) });

describe('the spacing rule (CONTRACT_V3 §4)', () => {
  it('asks for a full tap pitch while the axes are within 90 degrees', () => {
    expect(requiredSeparation(v3(0, 0, 1), v3(0, 0, 1))).toBe(SCREW_SPACING);
    expect(requiredSeparation(v3(0, 0, 1), normalizeV3(v3(1, 0, 1)))).toBe(SCREW_SPACING);   // 45 degrees
    expect(requiredSeparation(v3(0, 0, 1), normalizeV3(v3(1, 0, 0.05)))).toBe(SCREW_SPACING); // just under 90
  });

  it('asks only for head clearance at 90 degrees or more', () => {
    expect(requiredSeparation(v3(0, 0, 1), v3(1, 0, 0))).toBe(HEAD_CLEARANCE);               // exactly 90
    expect(requiredSeparation(v3(0, 0, 1), normalizeV3(v3(1, 0, -0.05)))).toBe(HEAD_CLEARANCE);
    expect(requiredSeparation(v3(0, 0, 1), v3(0, 0, -1))).toBe(HEAD_CLEARANCE);              // back to back
    expect(HEAD_CLEARANCE).toBe(2 * SCREW_HEAD_R);
  });

  it('measures separation in 3D, not in projection', () => {
    expect(pairSpacingOk(at(0, 0, 0), at(0, 0, SCREW_SPACING + 1e-6, v3(0, 0, 1), 1))).toBe(true);
    expect(pairSpacingOk(at(0, 0, 0), at(0, 0, SCREW_SPACING - 0.01, v3(0, 0, 1), 1))).toBe(false);
    const d = SCREW_SPACING / Math.sqrt(3) + 1e-6;
    expect(pairSpacingOk(at(0, 0, 0), at(d, d, d, v3(0, 0, 1), 1))).toBe(true);
  });

  it('lets perpendicular faces put their screws close together, but not through each other', () => {
    const a = at(0, 0, 0, v3(0, 0, 1), 0);
    const b = (dx: number) => at(dx, 0, 0, v3(1, 0, 0), 1);
    expect(pairSpacingOk(a, b(SCREW_SPACING - 0.1))).toBe(true);
    expect(pairSpacingOk(a, b(HEAD_CLEARANCE + 1e-6))).toBe(true);
    expect(pairSpacingOk(a, b(HEAD_CLEARANCE - 0.01))).toBe(false);
  });

  it('exempts screws that can never be removable at the same time (the v2 rule, in 3D)', () => {
    // B sits behind panel 0, which is A's panel: B cannot come out until that
    // panel drops, and that panel only drops once A itself is gone.
    const a = at(0, 0, 0, v3(0, 0, 1), 0);
    // Closer than a tap pitch, but the heads still clear each other.
    const b = at(0.5, 0, -0.3, v3(0, 0, 1), 1);
    expect(coverageExempt(a, [], b, [0])).toBe(true);
    expect(coverageExempt(a, [], b, [7])).toBe(false);
    expect(pairSpacingOk(a, b, [], [0])).toBe(true);
    expect(pairSpacingOk(a, b, [], [7])).toBe(false);
  });

  it('never lets two heads interpenetrate, exemption or not', () => {
    const a = at(0, 0, 0, v3(0, 0, 1), 0);
    const tooClose = at(0.05, 0, -0.05, v3(0, 0, 1), 1);
    expect(pairSpacingOk(a, tooClose, [], [0])).toBe(false);
  });

  it('screws on the same panel are never exempt from each other', () => {
    const a = at(0, 0, 0, v3(0, 0, 1), 3);
    const b = at(0.2, 0, 0, v3(0, 0, 1), 3);
    expect(pairSpacingOk(a, b, [3], [3])).toBe(false);
  });

  it('the placement grid agrees with the brute-force predicate', () => {
    const index = new ScrewIndex3();
    const kept: ScrewSpot[] = [];
    const keptBlockers: number[][] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const axis = normalizeV3(v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1));
      const spot = at(rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2, axis, i % 5);
      const blockers = rnd() < 0.3 ? [(i + 1) % 5] : [];
      const brute = kept.every((k, j) => pairSpacingOk(spot, k, blockers, keptBlockers[j]));
      expect(index.canPlace(spot, blockers)).toBe(brute);
      if (brute) {
        index.add(spot, blockers);
        kept.push(spot);
        keptBlockers.push(blockers);
      }
    }
    expect(kept.length).toBeGreaterThan(20);
    expect(spacingViolations(kept, keptBlockers)).toEqual([]);
    expect(index.size).toBe(kept.length);
  });

  it('the edge margin keeps a whole screw head on the panel', () => {
    expect(SCREW_EDGE_MARGIN).toBeGreaterThan(SCREW_HEAD_R);
  });
});

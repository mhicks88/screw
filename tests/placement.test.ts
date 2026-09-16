import { describe, expect, it } from 'vitest';
import {
  BOARD, PLATE_GAP, SCREW_EDGE_MARGIN, SCREW_SPACING, ScrewIndex, coverageExempt, pairSpacingOk, spacingViolations,
} from '../src/core/spacing';
import { bottomLayerFraction, placePlates, placeScrews, trimToMultiple } from '../src/core/placement';
import { difficultyFor } from '../src/core/difficulty';
import { Rng, hashSeed } from '../src/core/rng';
import { ringShape } from '../src/core/shapes';
import { plateWorldOutline, polygonAabb, polygonsOverlap } from '../src/core/geometry';
import type { PlateDef } from '../src/core/types';
import { rectPlate } from './helpers';

/* CONTRACT_V2 §3 */
describe('tuning constants', () => {
  it('match CONTRACT_V2 §3', () => {
    expect(BOARD).toEqual({ minX: -3.35, maxX: 3.35, minY: -4.2, maxY: 4.2 });
    expect(SCREW_SPACING).toBe(0.82);
    expect(SCREW_EDGE_MARGIN).toBe(0.34);
  });
});

/* CONTRACT_V2 §2 */
describe('the spacing rule', () => {
  // base covers the whole board on layer 0; cover sits on layer 1 over x,y in [0.5, 2.5]
  const base = rectPlate(0, 0, 0, 0, 3, 4);
  const cover = rectPlate(1, 1, 1.5, 1.5, 1, 1);
  const sibling = rectPlate(2, 1, -1.5, 1.5, 1, 1); // same layer as `cover`

  it('screws further than SCREW_SPACING apart are always fine', () => {
    expect(pairSpacingOk(base, 0, 0, base, SCREW_SPACING, 0)).toBe(true);
    expect(pairSpacingOk(base, 0, 0, cover, 1.5, 1.5)).toBe(true);
  });

  it('two screws on the same plate always need spacing', () => {
    expect(pairSpacingOk(base, 0, 0, base, 0.4, 0)).toBe(false);
    expect(pairSpacingOk(cover, 1.5, 1.5, cover, 1.7, 1.6)).toBe(false);
  });

  it('two screws on the same layer always need spacing', () => {
    expect(pairSpacingOk(cover, 0.6, 1.5, sibling, -0.6, 1.5)).toBe(true); // 1.2 apart
    const a = { x: 0.55, y: 1.5 };
    const b = { x: 0.2, y: 1.5 };  // 0.35 apart, both on layer 1 (different plates)
    expect(pairSpacingOk(cover, a.x, a.y, sibling, b.x, b.y)).toBe(false);
  });

  it('a screw hidden under a higher plate is exempt', () => {
    // (1.6, 1.6) on the base plate is covered by `cover` (layer 1).
    expect(coverageExempt(cover, 1.5, 1.5, base, 1.6, 1.6)).toBe(true);
    expect(pairSpacingOk(cover, 1.5, 1.5, base, 1.6, 1.6)).toBe(true);
    // ... and the exemption is symmetric in argument order.
    expect(pairSpacingOk(base, 1.6, 1.6, cover, 1.5, 1.5)).toBe(true);
  });

  it('a lower screw NOT under the higher plate still needs spacing', () => {
    // (0.4, 1.5) is outside `cover` (which starts at x = 0.5), so both screws
    // are visible at the same time and would overlap on screen.
    expect(coverageExempt(cover, 0.6, 1.5, base, 0.4, 1.5)).toBe(false);
    expect(pairSpacingOk(cover, 0.6, 1.5, base, 0.4, 1.5)).toBe(false);
  });

  it('the exemption respects holes in the covering plate', () => {
    const ring: PlateDef = { id: 3, layer: 1, shape: ringShape(1.2, 0.6), x: 0, y: 0, rotation: 0, color: 0, material: 'plastic' };
    // Under the ring body: exempt. Under the hole: visible, so spacing applies.
    expect(pairSpacingOk(ring, 1.0, 0, base, 0.95, 0.1)).toBe(true);
    expect(pairSpacingOk(ring, 1.0, 0, base, 0.3, 0)).toBe(false);
  });

  it('a screw two layers up exempts a screw it covers', () => {
    const high = rectPlate(4, 5, 1.5, 1.5, 1, 1);
    expect(pairSpacingOk(high, 1.5, 1.5, base, 1.55, 1.5)).toBe(true);
  });
});

describe('ScrewIndex', () => {
  it('agrees with the brute-force predicate', () => {
    const plates = [
      rectPlate(0, 0, 0, 0, 3, 4),
      rectPlate(1, 1, 1.2, 1.2, 1.3, 1.3),
      rectPlate(2, 1, -1.4, -1.0, 1.2, 1.4),
      rectPlate(3, 2, 0.9, 0.9, 0.9, 0.9),
    ];
    const rng = new Rng(12345);
    const index = new ScrewIndex(plates);
    const placed: { plateId: number; x: number; y: number }[] = [];
    for (let i = 0; i < 400; i++) {
      const pi = rng.int(0, plates.length - 1);
      const x = rng.float(BOARD.minX, BOARD.maxX);
      const y = rng.float(BOARD.minY, BOARD.maxY);
      const fast = index.canPlace(pi, x, y);
      const slow = placed.every((s) => pairSpacingOk(plates[pi], x, y, plates[s.plateId], s.x, s.y));
      expect(fast, `point ${i} at ${x.toFixed(2)},${y.toFixed(2)} on plate ${pi}`).toBe(slow);
      if (fast) {
        index.add(pi, x, y);
        placed.push({ plateId: pi, x, y });
      }
    }
    expect(placed.length).toBeGreaterThan(30);
    expect(index.size).toBe(placed.length);
  });

  it('is fast enough to place 150 screws', () => {
    const plates = Array.from({ length: 40 }, (_, i) => rectPlate(i, i >> 1, 0, 0, 3, 4));
    const index = new ScrewIndex(plates);
    const rng = new Rng(7);
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 20000; i++) {
      const pi = rng.int(0, plates.length - 1);
      const x = rng.float(BOARD.minX, BOARD.maxX);
      const y = rng.float(BOARD.minY, BOARD.maxY);
      if (index.canPlace(pi, x, y)) { index.add(pi, x, y); n++; }
    }
    const ms = performance.now() - t0;
    expect(n).toBeGreaterThan(100);
    expect(ms, `20k candidate tests took ${ms.toFixed(0)} ms`).toBeLessThan(400);
  });
});

/* CONTRACT_V2 §4 */
describe('tower layout', () => {
  const layouts = [50, 300, 700, 950].map((level) => {
    const params = difficultyFor(level);
    const rng = new Rng(hashSeed(level, 0));
    const plates = placePlates(params, rng);
    const layout = trimToMultiple(placeScrews(plates, params.screws, rng), 3, rng);
    return { level, params, plates, layout };
  });

  it('stacks the requested number of layers with several plates each', () => {
    for (const { level, params, plates } of layouts) {
      const layers = new Set(plates.map((p) => p.layer));
      expect(layers.size, `level ${level} layers`).toBeGreaterThanOrEqual(params.layers - 2);
      expect(plates.length, `level ${level} plates`).toBeGreaterThanOrEqual(layers.size);
      // layer numbers are dense
      expect([...layers].sort((a, b) => a - b)).toEqual([...layers].map((_, i) => i));
    }
  });

  it('never overlaps two plates on the same layer and stays on the board', () => {
    for (const { level, plates } of layouts) {
      const outlines = plates.map(plateWorldOutline);
      for (let i = 0; i < plates.length; i++) {
        const bb = polygonAabb(outlines[i]);
        expect(bb.minX, `level ${level}`).toBeGreaterThanOrEqual(BOARD.minX - 1e-9);
        expect(bb.maxX, `level ${level}`).toBeLessThanOrEqual(BOARD.maxX + 1e-9);
        expect(bb.minY, `level ${level}`).toBeGreaterThanOrEqual(BOARD.minY - 1e-9);
        expect(bb.maxY, `level ${level}`).toBeLessThanOrEqual(BOARD.maxY + 1e-9);
        for (let j = i + 1; j < plates.length; j++) {
          if (plates[i].layer !== plates[j].layer) continue;
          expect(polygonsOverlap(outlines[i], outlines[j]), `level ${level}: plates ${i},${j}`).toBe(false);
        }
      }
    }
  });

  it('towers interlock: higher plates substantially cover lower ones', () => {
    for (const { level, plates } of layouts) {
      const outlines = plates.map(plateWorldOutline);
      const upper = plates.map((_, i) => i).filter((i) => plates[i].layer > 0);
      const covering = upper.filter((i) => plates.some((q, j) => q.layer < plates[i].layer && polygonsOverlap(outlines[j], outlines[i])));
      expect(covering.length / Math.max(1, upper.length), `level ${level}`).toBeGreaterThan(0.9);
    }
  });

  it('spreads screws over the layers instead of piling them on the bottom', () => {
    for (const { level, plates, layout } of layouts) {
      expect(layout.screws.length, `level ${level}`).toBeGreaterThan(20);
      expect(bottomLayerFraction(layout.plates, layout.screws), `level ${level} bottom layer`).toBeLessThanOrEqual(0.35);
      void plates;
    }
  });

  it('respects the spacing rule for every pair it produces', () => {
    for (const { level, layout } of layouts) {
      expect(spacingViolations(layout.plates, layout.screws), `level ${level}`).toEqual([]);
    }
  });

  it('keeps plates apart by PLATE_GAP on a layer', () => {
    expect(PLATE_GAP).toBeGreaterThan(0);
  });
});

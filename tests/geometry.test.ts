import { describe, expect, it } from 'vitest';
import {
  pointInPolygon, pointInShape, polygonsOverlap, polygonDistance, transformPolygon, inverseTransformPoint,
  isCCW, polygonArea, shapeArea, segmentsIntersect,
} from '../src/core/geometry';
import { makeShape, SHAPE_KINDS, ringShape, convexHull } from '../src/core/shapes';
import { Rng } from '../src/core/rng';

const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];

describe('geometry', () => {
  it('point in polygon', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 0 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.99, y: -0.99 }, square)).toBe(true);
  });
  it('point in shape respects holes', () => {
    const ring = ringShape(2, 1);
    expect(pointInShape({ x: 1.5, y: 0 }, ring)).toBe(true);
    expect(pointInShape({ x: 0.2, y: 0 }, ring)).toBe(false);
    expect(pointInShape({ x: 2.5, y: 0 }, ring)).toBe(false);
  });
  it('segment intersection', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(false);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });
  it('polygon overlap: separated, crossing, contained, and distance', () => {
    const far = transformPolygon(square, 5, 0, 0);
    const crossing = transformPolygon(square, 1, 1, 0);
    const inner = transformPolygon(square.map((p) => ({ x: p.x * 0.3, y: p.y * 0.3 })), 0, 0, 0);
    expect(polygonsOverlap(square, far)).toBe(false);
    expect(polygonsOverlap(square, crossing)).toBe(true);
    expect(polygonsOverlap(square, inner)).toBe(true);
    expect(polygonsOverlap(inner, square)).toBe(true);
    expect(polygonDistance(square, far)).toBeCloseTo(3, 6);
    expect(polygonDistance(square, crossing)).toBe(0);
  });
  it('transform and inverse are consistent', () => {
    const pts = transformPolygon(square, 2, -3, 0.7);
    for (let i = 0; i < 4; i++) {
      const back = inverseTransformPoint(pts[i].x, pts[i].y, 2, -3, 0.7);
      expect(back.x).toBeCloseTo(square[i].x, 9);
      expect(back.y).toBeCloseTo(square[i].y, 9);
    }
  });
  it('every shape kind produces a CCW outline with positive area', () => {
    const rng = new Rng(42);
    for (const kind of SHAPE_KINDS) {
      for (let i = 0; i < 5; i++) {
        const s = makeShape(kind, rng.float(0.9, 2.2), rng);
        expect(s.kind).toBe(kind);
        expect(s.outline.length).toBeGreaterThanOrEqual(3);
        expect(isCCW(s.outline)).toBe(true);
        expect(shapeArea(s)).toBeGreaterThan(0.5);
        if (kind === 'ring') expect(s.holes?.length).toBe(1);
        if (kind === 'circle') expect(s.outline.length).toBe(24);
      }
    }
  });
  it('convex hull', () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.5, y: 0.5 }]);
    expect(hull).toHaveLength(4);
    expect(isCCW(hull)).toBe(true);
  });
});

describe('rng', () => {
  it('is deterministic and in range', () => {
    const a = new Rng(7), b = new Rng(7);
    for (let i = 0; i < 100; i++) {
      const v = a.next();
      expect(v).toBe(b.next());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    for (let i = 0; i < 100; i++) {
      const n = a.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(a.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});

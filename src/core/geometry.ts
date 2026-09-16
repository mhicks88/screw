/**
 * 2D polygon geometry. All functions are pure.
 *
 * A panel is still a 2D outline (CONTRACT_V3 §2) — it is extruded along its
 * local +Z and placed in assembly space by a RIGID transform, so distances and
 * angles measured in panel-local coordinates are the same as in assembly space
 * and every function here keeps working unchanged. ./geometry3 is the 3D half:
 * it pulls points and rays into panel-local space and then calls in here.
 */
import type { PlateShape, Vec2 } from './types';

export interface Aabb { minX: number; minY: number; maxX: number; maxY: number }

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distSq = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const dist = (a: Vec2, b: Vec2): number => Math.sqrt(distSq(a, b));

/** Signed area (positive for CCW). */
export function polygonSignedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

export const polygonArea = (poly: readonly Vec2[]): number => Math.abs(polygonSignedArea(poly));
export const isCCW = (poly: readonly Vec2[]): boolean => polygonSignedArea(poly) > 0;

/** Returns a CCW copy of the polygon (reverses it if it is CW). */
export function ensureCCW(poly: readonly Vec2[]): Vec2[] {
  const copy = poly.map((p) => ({ x: p.x, y: p.y }));
  return isCCW(copy) ? copy : copy.reverse();
}

/** Area of a shape = outline area minus hole areas. */
export function shapeArea(shape: PlateShape): number {
  let a = polygonArea(shape.outline);
  for (const h of shape.holes ?? []) a -= polygonArea(h);
  return Math.max(0, a);
}

/** Ray-casting point-in-polygon (works for concave polygons, any winding). */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Point inside the outline and outside every hole. */
export function pointInShape(p: Vec2, shape: PlateShape): boolean {
  if (!pointInPolygon(p, shape.outline)) return false;
  for (const h of shape.holes ?? []) if (pointInPolygon(p, h)) return false;
  return true;
}

/** Rotate (CCW, radians) about the origin then translate by (x, y). */
export function transformPolygon(poly: readonly Vec2[], x: number, y: number, rotation: number): Vec2[] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return poly.map((p) => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c }));
}

/** Inverse of transformPolygon for a single point. */
export function inverseTransformPoint(px: number, py: number, x: number, y: number, rotation: number): Vec2 {
  const dx = px - x;
  const dy = py - y;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

export function polygonAabb(poly: readonly Vec2[]): Aabb {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function aabbsOverlap(a: Aabb, b: Aabb, gap = 0): boolean {
  return a.minX - gap < b.maxX && b.minX - gap < a.maxX && a.minY - gap < b.maxY && b.minY - gap < a.maxY;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) - 1e-12 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-12 &&
    Math.min(a.y, b.y) - 1e-12 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-12
  );
}

/** Segment (a,b) intersects segment (c,d), including touching / collinear overlap. */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + t * abx - p.x, a.y + t * aby - p.y);
}

export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
  );
}

/** Minimum distance from a point to any edge of the polygon outline. */
export function distanceToPolygonEdge(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = pointSegmentDistance(p, poly[j], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

/** Robust polygon overlap: any edge crossing, or one contained in the other. */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  if (!aabbsOverlap(polygonAabb(a), polygonAabb(b))) return false;
  for (let i = 0, i2 = a.length - 1; i < a.length; i2 = i++) {
    for (let j = 0, j2 = b.length - 1; j < b.length; j2 = j++) {
      if (segmentsIntersect(a[i2], a[i], b[j2], b[j])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Distance between two polygons (0 when they overlap or touch). */
export function polygonDistance(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (polygonsOverlap(a, b)) return 0;
  let best = Infinity;
  for (let i = 0, i2 = a.length - 1; i < a.length; i2 = i++) {
    for (let j = 0, j2 = b.length - 1; j < b.length; j2 = j++) {
      const d = segmentSegmentDistance(a[i2], a[i], b[j2], b[j]);
      if (d < best) best = d;
    }
  }
  return best;
}

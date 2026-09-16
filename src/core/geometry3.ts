/**
 * 3D geometry for the assembly (CONTRACT_V3 §3). Pure maths, NO three.js:
 * the core must stay renderer-agnostic and testable in plain node.
 *
 * A panel is still a 2D outline (`PlateShape`) — it is extruded along its own
 * local +Z from z = 0 to z = `thickness` and placed in assembly space by a
 * rigid transform (unit quaternion `rotation`, then translation `position`).
 * Because the transform is rigid, distances and angles are the same in panel
 * space and in assembly space, so the existing 2D polygon code in ./geometry
 * keeps working unchanged once a point has been pulled into panel space.
 *
 * The ray test is the whole blocking rule, so it has to be cheap: a BVH over
 * panel bounding spheres rejects almost everything before any polygon is
 * touched. See `PanelBvh`.
 */
import type { PanelDef, PlateShape, Quat, Vec2, Vec3 } from './types';
import { pointInShape, polygonAabb, segmentsIntersect, type Aabb } from './geometry';

/* ---------------------------------------------------------------- vectors */

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const addV3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const subV3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scaleV3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dotV3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const crossV3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lengthV3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distV3Sq = (a: Vec3, b: Vec3): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
export const distV3 = (a: Vec3, b: Vec3): number => Math.sqrt(distV3Sq(a, b));

export function normalizeV3(a: Vec3): Vec3 {
  const l = lengthV3(a);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 1 };
}

/** Any unit vector perpendicular to `a` (stable for every input direction). */
export function perpendicularTo(a: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(a.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  return normalizeV3(crossV3(a, ref));
}

/** Angle between two vectors, in radians (0..PI). */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = dotV3(normalizeV3(a), normalizeV3(b));
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/* ------------------------------------------------------------ quaternions */

export const QUAT_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return l > 0 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : { ...QUAT_IDENTITY };
}

/** Rotation of `angle` radians about the (not necessarily unit) axis. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalizeV3(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

/** Composition: `quatMul(a, b)` applies b first, then a (same as three.js). */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Inverse of a unit quaternion (its conjugate). */
export function quatInvert(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Rotate a vector by a unit quaternion: v' = q v q*. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz x v); v' = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

/** Rotate a vector by the inverse of a unit quaternion. */
export function quatRotateInv(q: Quat, v: Vec3): Vec3 {
  return quatRotate(quatInvert(q), v);
}

/** Shortest rotation taking unit vector `from` to unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const a = normalizeV3(from);
  const b = normalizeV3(to);
  const d = dotV3(a, b);
  if (d > 1 - 1e-9) return { ...QUAT_IDENTITY };
  if (d < -1 + 1e-9) return quatFromAxisAngle(perpendicularTo(a), Math.PI);
  const c = crossV3(a, b);
  return quatNormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}

/**
 * Quaternion for the orthonormal frame whose local +Z is `normal` and whose
 * local +X is `tangent` projected perpendicular to it. Used to seat a panel on
 * a face: local XY spans the face, local +Z points out of it.
 */
export function quatFromFrame(normal: Vec3, tangent: Vec3): Quat {
  const z = normalizeV3(normal);
  let x = subV3(tangent, scaleV3(z, dotV3(tangent, z)));
  if (lengthV3(x) < 1e-6) x = perpendicularTo(z);
  x = normalizeV3(x);
  const y = crossV3(z, x);
  // Matrix -> quaternion (Shepperd's method, branch on the largest diagonal).
  const m00 = x.x, m10 = x.y, m20 = x.z;
  const m01 = y.x, m11 = y.y, m21 = y.z;
  const m02 = z.x, m12 = z.y, m22 = z.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return quatNormalize(q);
}

/* --------------------------------------------------------- panel transforms */

/** Panel-local point (x, y, z) -> assembly space. */
export function panelToAssembly(panel: PanelDef, local: Vec3): Vec3 {
  return addV3(panel.position, quatRotate(panel.rotation, local));
}

/** Assembly-space point -> panel-local. */
export function assemblyToPanel(panel: PanelDef, world: Vec3): Vec3 {
  return quatRotateInv(panel.rotation, subV3(world, panel.position));
}

/** Assembly-space direction -> panel-local (no translation). */
export function assemblyToPanelDir(panel: PanelDef, dir: Vec3): Vec3 {
  return quatRotateInv(panel.rotation, dir);
}

/** The panel's outward face normal (local +Z) in assembly space. */
export function panelNormal(panel: PanelDef): Vec3 {
  return quatRotate(panel.rotation, { x: 0, y: 0, z: 1 });
}

/** Point on the panel's outer face (local z = thickness) in assembly space. */
export function panelFacePoint(panel: PanelDef, p: Vec2): Vec3 {
  return panelToAssembly(panel, { x: p.x, y: p.y, z: panel.thickness });
}

export interface Sphere { center: Vec3; radius: number }

/** Bounding sphere of the extruded panel, in assembly space. */
export function panelBoundingSphere(panel: PanelDef): Sphere {
  const bb = shapeAabb(panel.shape);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const hx = (bb.maxX - bb.minX) / 2;
  const hy = (bb.maxY - bb.minY) / 2;
  const hz = panel.thickness / 2;
  return {
    center: panelToAssembly(panel, { x: cx, y: cy, z: hz }),
    radius: Math.hypot(hx, hy, hz),
  };
}

/**
 * Distance from the origin to the furthest point of the panel (its outline
 * vertices on both faces). Exact rather than the bounding sphere's estimate,
 * because the assembly's radius budget is tight and a sphere around a big flat
 * panel over-estimates it by more than half a unit.
 */
export function panelMaxRadius(panel: PanelDef): number {
  let best = 0;
  for (const v of panel.shape.outline) {
    for (const z of [0, panel.thickness]) {
      best = Math.max(best, lengthV3(panelToAssembly(panel, { x: v.x, y: v.y, z })));
    }
  }
  return best;
}

function shapeAabb(shape: PlateShape): Aabb {
  return polygonAabb(shape.outline);
}

/* ------------------------------------------------------------------ boxes */

/** Oriented bounding box: centre, three unit axes and the half extents. */
export interface Obb { center: Vec3; axes: [Vec3, Vec3, Vec3]; half: [number, number, number] }

export function panelObb(panel: PanelDef): Obb {
  const bb = shapeAabb(panel.shape);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  return {
    center: panelToAssembly(panel, { x: cx, y: cy, z: panel.thickness / 2 }),
    axes: [
      quatRotate(panel.rotation, { x: 1, y: 0, z: 0 }),
      quatRotate(panel.rotation, { x: 0, y: 1, z: 0 }),
      quatRotate(panel.rotation, { x: 0, y: 0, z: 1 }),
    ],
    half: [(bb.maxX - bb.minX) / 2, (bb.maxY - bb.minY) / 2, panel.thickness / 2],
  };
}

/**
 * Separating-axis test between two oriented boxes, with an optional gap that
 * both boxes are inflated by. Conservative for panels (it uses the outline's
 * bounding box, never less), which is what the generator wants: panels that
 * pass this test definitely do not interpenetrate.
 */
export function obbOverlap(a: Obb, b: Obb, gap = 0): boolean {
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const AbsR: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const EPS = 1e-9;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = dotV3(a.axes[i], b.axes[j]);
      AbsR[i][j] = Math.abs(R[i][j]) + EPS;
    }
  }
  const d = subV3(b.center, a.center);
  const t = [dotV3(d, a.axes[0]), dotV3(d, a.axes[1]), dotV3(d, a.axes[2])];
  const ae = [a.half[0] + gap, a.half[1] + gap, a.half[2] + gap];
  const be = [b.half[0] + gap, b.half[1] + gap, b.half[2] + gap];

  for (let i = 0; i < 3; i++) {
    const ra = ae[i];
    const rb = be[0] * AbsR[i][0] + be[1] * AbsR[i][1] + be[2] * AbsR[i][2];
    if (Math.abs(t[i]) > ra + rb) return false;
  }
  for (let j = 0; j < 3; j++) {
    const ra = ae[0] * AbsR[0][j] + ae[1] * AbsR[1][j] + ae[2] * AbsR[2][j];
    const rb = be[j];
    if (Math.abs(t[0] * R[0][j] + t[1] * R[1][j] + t[2] * R[2][j]) > ra + rb) return false;
  }
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = ae[i1] * AbsR[i2][j] + ae[i2] * AbsR[i1][j];
      const rb = be[j1] * AbsR[i][j2] + be[j2] * AbsR[i][j1];
      const tt = Math.abs(t[i2] * R[i1][j] - t[i1] * R[i2][j]);
      if (tt > ra + rb) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------- ray tests */

export interface Ray { origin: Vec3; dir: Vec3 }

/** Does the ray reach the sphere within [0, maxT]? */
export function raySphere(origin: Vec3, dir: Vec3, s: Sphere, maxT: number): boolean {
  const m = subV3(origin, s.center);
  const b = dotV3(m, dir);
  const c = dotV3(m, m) - s.radius * s.radius;
  if (c <= 0) return true;              // origin inside
  if (b > 0) return false;              // pointing away
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  return t <= maxT;
}

/** Lateral travel inside a slab below which only the entry point is sampled. */
const SLAB_DRIFT = 0.05;

/**
 * CONTRACT_V3 §3: transform the ray into panel-local space, intersect it with
 * the slab at local z in [0, thickness], and run the 2D point-in-polygon test
 * (holes included) on the ENTRY point. Returns the entry distance along the ray
 * (>= 0) or -1 for a miss.
 *
 * Two extra cases the naive version gets wrong, both cheap:
 *   - a ray running parallel to the panel plane never "enters" the slab, so it
 *     is resolved with a 2D segment-vs-outline test instead;
 *   - a ray oblique enough to drift more than SLAB_DRIFT sideways while inside
 *     the slab may enter outside the outline and leave inside it, so the exit
 *     point is sampled too. Panels are thin and screws withdraw along their own
 *     normal, so this practically never fires for a screw's own ray; it keeps
 *     the predicate honest for glancing rays (and can only ever report MORE
 *     obstruction, never less).
 */
export function rayPanelHit(panel: PanelDef, origin: Vec3, dir: Vec3, maxT = Infinity): number {
  const o = assemblyToPanel(panel, origin);
  const d = assemblyToPanelDir(panel, dir);
  const th = panel.thickness;

  if (Math.abs(d.z) < 1e-9) {
    if (o.z < 0 || o.z > th) return -1;
    const far = Number.isFinite(maxT) ? maxT : 1e4;
    const a: Vec2 = { x: o.x, y: o.y };
    const b: Vec2 = { x: o.x + d.x * far, y: o.y + d.y * far };
    if (pointInShape(a, panel.shape)) return 0;
    if (segmentCrossesShape(a, b, panel.shape)) return 0;
    return -1;
  }

  const t0 = (0 - o.z) / d.z;
  const t1 = (th - o.z) / d.z;
  let tEnter = Math.min(t0, t1);
  let tExit = Math.max(t0, t1);
  if (tEnter < 0) tEnter = 0;
  if (tExit > maxT) tExit = maxT;
  if (tEnter > tExit) return -1;

  const entry: Vec2 = { x: o.x + d.x * tEnter, y: o.y + d.y * tEnter };
  if (pointInShape(entry, panel.shape)) return tEnter;

  const drift = Math.hypot(d.x, d.y) * (tExit - tEnter);
  if (drift > SLAB_DRIFT) {
    const exit: Vec2 = { x: o.x + d.x * tExit, y: o.y + d.y * tExit };
    if (pointInShape(exit, panel.shape)) return tEnter;
    if (segmentCrossesShape(entry, exit, panel.shape)) return tEnter;
  }
  return -1;
}

/** True when the 2D segment crosses the outline (holes are solid-free space). */
function segmentCrossesShape(a: Vec2, b: Vec2, shape: PlateShape): boolean {
  const poly = shape.outline;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- BVH */

interface BvhNode {
  min: Vec3; max: Vec3;
  /** Leaf: index range into `order`. Internal: -1. */
  start: number; count: number;
  left: number; right: number;
}

/**
 * Bounding-volume hierarchy over the panels' bounding spheres, so a ray only
 * ever meets a handful of panels. Built once per assembly (panels never move —
 * they only drop, and a dropped panel is filtered by the caller).
 *
 * At 60 panels a query costs ~10 AABB tests plus 1-3 polygon tests, against 60
 * polygon tests for the naive version. That matters because the generator casts
 * one ray per screw candidate, hundreds of times per level.
 */
export class PanelBvh {
  private readonly nodes: BvhNode[] = [];
  private readonly order: number[];
  private readonly spheres: Sphere[];
  private readonly root: number;

  constructor(private readonly panels: readonly PanelDef[]) {
    this.spheres = panels.map(panelBoundingSphere);
    this.order = panels.map((_, i) => i);
    this.root = panels.length ? this.build(0, panels.length) : -1;
  }

  private build(start: number, count: number): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const s = this.spheres[this.order[i]];
      minX = Math.min(minX, s.center.x - s.radius); maxX = Math.max(maxX, s.center.x + s.radius);
      minY = Math.min(minY, s.center.y - s.radius); maxY = Math.max(maxY, s.center.y + s.radius);
      minZ = Math.min(minZ, s.center.z - s.radius); maxZ = Math.max(maxZ, s.center.z + s.radius);
    }
    const node: BvhNode = {
      min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
      start, count, left: -1, right: -1,
    };
    const idx = this.nodes.push(node) - 1;
    if (count <= 2) return idx;
    // Split at the median along the widest axis of the centroid spread.
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    const axis: 'x' | 'y' | 'z' = ex >= ey && ex >= ez ? 'x' : ey >= ez ? 'y' : 'z';
    const slice = this.order.slice(start, start + count)
      .sort((a, b) => this.spheres[a].center[axis] - this.spheres[b].center[axis]);
    for (let i = 0; i < count; i++) this.order[start + i] = slice[i];
    const half = count >> 1;
    node.left = this.build(start, half);
    node.right = this.build(start + half, count - half);
    node.count = -1;
    return idx;
  }

  /**
   * Panel indices whose geometry the ray actually passes through, excluding
   * `skip` and anything `keep` rejects (used for dropped panels). Unordered.
   */
  query(origin: Vec3, dir: Vec3, maxT: number, skip = -1, keep?: (i: number) => boolean): number[] {
    const out: number[] = [];
    if (this.root < 0) return out;
    const inv = {
      x: 1 / (dir.x === 0 ? 1e-30 : dir.x),
      y: 1 / (dir.y === 0 ? 1e-30 : dir.y),
      z: 1 / (dir.z === 0 ? 1e-30 : dir.z),
    };
    const stack = [this.root];
    while (stack.length) {
      const n = this.nodes[stack.pop()!];
      if (!rayAabb(origin, inv, n.min, n.max, maxT)) continue;
      if (n.count < 0) { stack.push(n.left, n.right); continue; }
      for (let i = n.start; i < n.start + n.count; i++) {
        const pi = this.order[i];
        if (pi === skip) continue;
        if (keep && !keep(pi)) continue;
        if (!raySphere(origin, dir, this.spheres[pi], maxT)) continue;
        if (rayPanelHit(this.panels[pi], origin, dir, maxT) >= 0) out.push(pi);
      }
    }
    return out;
  }
}

function rayAabb(o: Vec3, inv: Vec3, min: Vec3, max: Vec3, maxT: number): boolean {
  let t0 = 0;
  let t1 = maxT;
  const lo = [(min.x - o.x) * inv.x, (min.y - o.y) * inv.y, (min.z - o.z) * inv.z];
  const hi = [(max.x - o.x) * inv.x, (max.y - o.y) * inv.y, (max.z - o.z) * inv.z];
  for (let i = 0; i < 3; i++) {
    const a = Math.min(lo[i], hi[i]);
    const b = Math.max(lo[i], hi[i]);
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

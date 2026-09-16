/**
 * Plate shape factories. Every outline is returned CCW and centred near the
 * local origin. Sizes are in world units; "size" in makeShape is the approximate
 * major half-extent of the plate.
 */
import type { PlateShape, PlateShapeKind, Vec2 } from './types';
import { ensureCCW } from './geometry';
import type { Rng } from './rng';

const P = (x: number, y: number): Vec2 => ({ x, y });

/**
 * Minimum arm thickness so that a screw (SCREW_EDGE_MARGIN = 0.34 margin) fits
 * inside any arm of an L / T / cross / ring plate with a little slack.
 */
export const MIN_ARM_THICKNESS = 1.0;

function finish(kind: PlateShapeKind, outline: Vec2[], holes?: Vec2[][]): PlateShape {
  const shape: PlateShape = { kind, outline: ensureCCW(outline) };
  if (holes && holes.length) shape.holes = holes.map(ensureCCW);
  return shape;
}

function arc(cx: number, cy: number, r: number, from: number, to: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return pts;
}

export function rectShape(hw: number, hh: number): PlateShape {
  return finish('rect', [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)]);
}

export function roundedRectShape(hw: number, hh: number, r: number, cornerPts = 4): PlateShape {
  r = Math.min(r, hw * 0.9, hh * 0.9);
  const pts: Vec2[] = [
    ...arc(hw - r, -hh + r, r, -Math.PI / 2, 0, cornerPts),
    ...arc(hw - r, hh - r, r, 0, Math.PI / 2, cornerPts),
    ...arc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, cornerPts),
    ...arc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, cornerPts),
  ];
  return finish('roundedRect', pts);
}

export function circleShape(r: number, n = 24): PlateShape {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(P(r * Math.cos(a), r * Math.sin(a)));
  }
  return finish('circle', pts);
}

/** L shape with overall width w, height h and arm thickness t (centred). */
export function lShape(w: number, h: number, t: number): PlateShape {
  const ox = w / 2, oy = h / 2;
  return finish('L', [P(-ox, -oy), P(w - ox, -oy), P(w - ox, t - oy), P(t - ox, t - oy), P(t - ox, h - oy), P(-ox, h - oy)]);
}

/** T shape: bar of width w on top, stem of height h; both thickness t. */
export function tShape(w: number, h: number, t: number): PlateShape {
  const hh = h / 2, hw = w / 2, ht = t / 2;
  return finish('T', [
    P(-hw, hh), P(-hw, hh - t), P(-ht, hh - t), P(-ht, -hh), P(ht, -hh), P(ht, hh - t), P(hw, hh - t), P(hw, hh),
  ]);
}

/** Equilateral-ish triangle with circumradius r. */
export function triangleShape(r: number): PlateShape {
  const pts: Vec2[] = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
    pts.push(P(r * Math.cos(a), r * Math.sin(a)));
  }
  return finish('triangle', pts);
}

export function hexagonShape(r: number): PlateShape {
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    pts.push(P(r * Math.cos(a), r * Math.sin(a)));
  }
  return finish('hexagon', pts);
}

export function ringShape(outer: number, inner: number, n = 24): PlateShape {
  const o = circleShape(outer, n).outline;
  const i = circleShape(inner, Math.max(12, Math.round(n * 0.75))).outline;
  return finish('ring', o, [i]);
}

/** Plus/cross with total extent s (half-extent) and arm thickness t. */
export function crossShape(s: number, t: number): PlateShape {
  const h = t / 2;
  return finish('cross', [
    P(-h, -s), P(h, -s), P(h, -h), P(s, -h), P(s, h), P(h, h), P(h, s), P(-h, s), P(-h, h), P(-s, h), P(-s, -h), P(-h, -h),
  ]);
}

/** Capsule along x: straight half-length halfLen plus semicircular caps of radius r. */
export function capsuleShape(halfLen: number, r: number, capPts = 8): PlateShape {
  const pts: Vec2[] = [
    ...arc(halfLen, 0, r, -Math.PI / 2, Math.PI / 2, capPts),
    ...arc(-halfLen, 0, r, Math.PI / 2, Math.PI * 1.5, capPts),
  ];
  return finish('capsule', pts);
}

/** Convex hull (Andrew's monotone chain), CCW. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cr = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Random-ish convex polygon with 5..7 vertices, circumradius about r. */
export function randomConvexPolygonShape(r: number, rng: Rng): PlateShape {
  const n = rng.int(5, 7);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + rng.float(-0.3, 0.3)) / n) * Math.PI * 2;
    const rr = r * rng.float(0.75, 1);
    pts.push(P(rr * Math.cos(a), rr * Math.sin(a)));
  }
  const hull = convexHull(pts);
  // recentre on the vertex centroid
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return finish('polygon', hull.map((p) => P(p.x - cx, p.y - cy)));
}

export const SHAPE_KINDS: PlateShapeKind[] = [
  'rect', 'roundedRect', 'circle', 'L', 'T', 'triangle', 'hexagon', 'ring', 'cross', 'capsule', 'polygon',
];

/**
 * Build a randomised shape of the given kind. `size` is the approximate major
 * half-extent (so the plate fits in a 2*size square) and the minor extent is
 * picked at random. See `fittedShape` for the anisotropic version the tower
 * layout uses.
 */
export function makeShape(kind: PlateShapeKind, size: number, rng: Rng): PlateShape {
  const s = Math.max(0.7, size);
  const minor = Math.max(0.6, s * rng.float(0.55, 1));
  return fittedShape(kind, s, minor, rng);
}

/** Scale a polygon anisotropically (done at construction time, so plates stay rigid). */
function scalePoly(poly: readonly Vec2[], sx: number, sy: number): Vec2[] {
  return poly.map((p) => P(p.x * sx, p.y * sy));
}

/**
 * Build a randomised shape of `kind` that roughly fills a 2*hw x 2*hh box.
 * Used by the tower layout, where plate footprints are anisotropic. Every
 * result keeps enough body thickness for a screw with SCREW_EDGE_MARGIN.
 */
export function fittedShape(kind: PlateShapeKind, hw: number, hh: number, rng: Rng): PlateShape {
  // The floor is just enough body for one screw plus its edge margin. It must
  // never inflate a panel the caller sized deliberately: the assembly builder
  // quantises panels to whole screw columns and steps them down when they foul
  // a neighbour, and a silent minimum size defeats both.
  hw = Math.max(0.36, hw);
  hh = Math.max(0.36, hh);
  const small = Math.min(hw, hh);
  const big = Math.max(hw, hh);
  const along = hw >= hh;
  switch (kind) {
    case 'rect': return rectShape(hw, hh);
    // Small corner radii on purpose: a screw needs SCREW_EDGE_MARGIN of clear
    // body, and a fat rounded corner silently costs a panel its corner screws.
    case 'roundedRect': return roundedRectShape(hw, hh, small * rng.float(0.1, 0.24));
    case 'circle': return finish('circle', scalePoly(circleShape(1, 24).outline, hw, hh));
    case 'L': {
      const t = Math.min(2 * small * 0.8, Math.max(MIN_ARM_THICKNESS, small * rng.float(0.95, 1.35)));
      return lShape(2 * hw, 2 * hh, t);
    }
    case 'T': {
      const t = Math.min(2 * small * 0.8, Math.max(MIN_ARM_THICKNESS, small * rng.float(0.95, 1.35)));
      return tShape(2 * hw, 2 * hh, t);
    }
    case 'triangle': return finish('triangle', scalePoly(triangleShape(1).outline, hw * 1.25, hh * 1.25));
    case 'hexagon': return finish('hexagon', scalePoly(hexagonShape(1).outline, hw, hh * 1.06));
    case 'ring': {
      const outer = small;
      const inner = Math.max(0.22, Math.min(outer - MIN_ARM_THICKNESS, outer * rng.float(0.3, 0.46)));
      if (inner < 0.22) return roundedRectShape(hw, hh, small * 0.3);
      const o = scalePoly(circleShape(1, 24).outline, hw, hh);
      const i = scalePoly(circleShape(1, 16).outline, (inner / outer) * hw, (inner / outer) * hh);
      return finish('ring', o, [i]);
    }
    case 'cross': {
      const a = Math.min(small * 0.8, Math.max(MIN_ARM_THICKNESS, small * rng.float(0.9, 1.3)) / 2);
      return finish('cross', [
        P(-a, -hh), P(a, -hh), P(a, -a), P(hw, -a), P(hw, a), P(a, a),
        P(a, hh), P(-a, hh), P(-a, a), P(-hw, a), P(-hw, -a), P(-a, -a),
      ]);
    }
    case 'capsule': {
      const r = Math.min(small, big * 0.85);
      const cap = capsuleShape(Math.max(0.12, big - r), r);
      return along ? cap : finish('capsule', cap.outline.map((p) => P(-p.y, p.x)));
    }
    case 'polygon': {
      const poly = randomConvexPolygonShape(1, rng);
      return finish('polygon', scalePoly(poly.outline, hw * 1.12, hh * 1.12));
    }
  }
}

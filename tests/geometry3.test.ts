import { describe, expect, it } from 'vitest';
import {
  QUAT_IDENTITY, PanelBvh, angleBetween, assemblyToPanel, crossV3, dotV3, lengthV3, normalizeV3,
  obbOverlap, panelBoundingSphere, panelMaxRadius, panelNormal, panelObb, panelToAssembly,
  quatFromAxisAngle, quatFromFrame, quatFromUnitVectors, quatInvert, quatMul, quatRotate, quatRotateInv,
  rayPanelHit, raySphere, v3,
} from '../src/core/geometry3';
import { circleShape, rectShape, ringShape } from '../src/core/shapes';
import type { PanelDef, Vec3 } from '../src/core/types';

const close = (a: Vec3, b: Vec3, eps = 1e-9) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

/** A panel facing `normal`, its local origin at `position`. */
function panel(id: number, position: Vec3, normal: Vec3, hw: number, hh: number, thickness = 0.2): PanelDef {
  return {
    id, shape: rectShape(hw, hh), thickness, position,
    rotation: quatFromUnitVectors(v3(0, 0, 1), normalizeV3(normal)),
    color: 0, material: 'metal', shell: 0,
  };
}

describe('vector and quaternion maths', () => {
  it('rotates about an axis by the right angle and handedness', () => {
    const q = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
    close(quatRotate(q, v3(1, 0, 0)), v3(0, 1, 0));
    close(quatRotate(q, v3(0, 0, 1)), v3(0, 0, 1));
  });

  it('composes in three.js order (b applied first) and inverts', () => {
    const a = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
    const b = quatFromAxisAngle(v3(1, 0, 0), Math.PI / 2);
    const v = v3(0.3, -0.7, 0.2);
    close(quatRotate(quatMul(a, b), v), quatRotate(a, quatRotate(b, v)));
    close(quatRotateInv(a, quatRotate(a, v)), v);
    close(quatRotate(quatMul(a, quatInvert(a)), v), v);
  });

  it('quatFromUnitVectors maps from to to, including the antipodal case', () => {
    const from = normalizeV3(v3(0.3, 0.5, -0.8));
    const to = normalizeV3(v3(-0.2, 0.9, 0.1));
    close(quatRotate(quatFromUnitVectors(from, to), from), to);
    close(quatRotate(quatFromUnitVectors(from, { x: -from.x, y: -from.y, z: -from.z }), from),
      { x: -from.x, y: -from.y, z: -from.z });
    expect(quatFromUnitVectors(from, from)).toEqual(QUAT_IDENTITY);
  });

  it('quatFromFrame builds an orthonormal frame with local +Z on the normal', () => {
    const n = normalizeV3(v3(1, 2, -0.5));
    const q = quatFromFrame(n, v3(0, 1, 0));
    const x = quatRotate(q, v3(1, 0, 0));
    const y = quatRotate(q, v3(0, 1, 0));
    const z = quatRotate(q, v3(0, 0, 1));
    close(z, n);
    expect(dotV3(x, y)).toBeCloseTo(0, 9);
    expect(dotV3(x, z)).toBeCloseTo(0, 9);
    expect(lengthV3(x)).toBeCloseTo(1, 9);
    close(crossV3(x, y), z);
  });

  it('panel space and assembly space are inverses, and the transform is rigid', () => {
    const p = panel(0, v3(0.4, -1.2, 2), v3(1, 1, 0), 1, 0.6);
    const a = { x: 0.3, y: -0.2, z: 0.1 };
    const b = { x: -0.5, y: 0.4, z: 0.2 };
    close(assemblyToPanel(p, panelToAssembly(p, a)), a);
    const dWorld = lengthV3({
      x: panelToAssembly(p, a).x - panelToAssembly(p, b).x,
      y: panelToAssembly(p, a).y - panelToAssembly(p, b).y,
      z: panelToAssembly(p, a).z - panelToAssembly(p, b).z,
    });
    expect(dWorld).toBeCloseTo(lengthV3({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }), 9);
    close(panelNormal(p), normalizeV3(v3(1, 1, 0)));
  });
});

describe('ray vs panel (CONTRACT_V3 §3)', () => {
  const p = panel(0, v3(0, 0, 1), v3(0, 0, 1), 1, 1);

  it('hits a panel straight on and reports the entry distance', () => {
    expect(rayPanelHit(p, v3(0, 0, 0), v3(0, 0, 1))).toBeCloseTo(1, 9);
    expect(rayPanelHit(p, v3(0.9, -0.9, 0), v3(0, 0, 1))).toBeCloseTo(1, 9);
  });

  it('misses beside the outline, behind the ray, and pointing away', () => {
    expect(rayPanelHit(p, v3(1.5, 0, 0), v3(0, 0, 1))).toBe(-1);
    expect(rayPanelHit(p, v3(0, 0, 2), v3(0, 0, 1))).toBe(-1);
    expect(rayPanelHit(p, v3(0, 0, 0), v3(0, 0, -1))).toBe(-1);
  });

  it('misses through a hole and hits the body around it', () => {
    const ring: PanelDef = { ...p, shape: ringShape(1, 0.5) };
    expect(rayPanelHit(ring, v3(0, 0, 0), v3(0, 0, 1))).toBe(-1);
    expect(rayPanelHit(ring, v3(0.8, 0, 0), v3(0, 0, 1))).toBeCloseTo(1, 9);
  });

  it('respects maxT, so a ray that stops short of a panel does not hit it', () => {
    expect(rayPanelHit(p, v3(0, 0, 0), v3(0, 0, 1), 0.5)).toBe(-1);
    expect(rayPanelHit(p, v3(0, 0, 0), v3(0, 0, 1), 1.5)).toBeCloseTo(1, 9);
  });

  it('handles oblique rays and rays that run along the panel plane', () => {
    const oblique = normalizeV3(v3(0.6, 0, 1));
    expect(rayPanelHit(p, v3(-0.5, 0, 0), oblique)).toBeGreaterThan(0);
    // Entering the slab beyond the outline but leaving inside it still counts:
    // the ray does pass through the panel's body.
    const grazing = normalizeV3(v3(-1, 0, 0.25));
    expect(rayPanelHit(p, v3(1.6, 0, 0.8), grazing)).toBeGreaterThanOrEqual(0);
    // Parallel to the plane and outside the slab: never a hit.
    expect(rayPanelHit(p, v3(-2, 0, 3), v3(1, 0, 0))).toBe(-1);
    // Parallel and inside the slab, aimed at the body: a hit.
    expect(rayPanelHit(p, v3(-2, 0, 1.05), v3(1, 0, 0))).toBe(0);
  });

  it('a screw never blocks itself: the ray starts off its own face', () => {
    // A screw seated on this panel's outer face, withdrawing along the normal.
    const seat = panelToAssembly(p, { x: 0.2, y: 0.2, z: p.thickness });
    expect(rayPanelHit(p, { ...seat, z: seat.z + 1e-3 }, v3(0, 0, 1))).toBe(-1);
  });

  it('works the same for a panel at an arbitrary orientation', () => {
    const tilted = panel(1, v3(1, 1, 1), v3(1, 1, 1), 1, 1);
    const n = panelNormal(tilted);
    const start = v3(1 - n.x, 1 - n.y, 1 - n.z);
    expect(rayPanelHit(tilted, start, n)).toBeGreaterThan(0);
    expect(rayPanelHit(tilted, start, { x: -n.x, y: -n.y, z: -n.z })).toBe(-1);
  });
});

describe('bounding volumes and the BVH', () => {
  it('bounding spheres and max radius contain the panel', () => {
    const p = panel(0, v3(0.5, 0, 2), v3(0, 0.3, 1), 1.2, 0.8);
    const s = panelBoundingSphere(p);
    for (const v of p.shape.outline) {
      for (const z of [0, p.thickness]) {
        const w = panelToAssembly(p, { x: v.x, y: v.y, z });
        expect(lengthV3({ x: w.x - s.center.x, y: w.y - s.center.y, z: w.z - s.center.z })).toBeLessThanOrEqual(s.radius + 1e-9);
        expect(lengthV3(w)).toBeLessThanOrEqual(panelMaxRadius(p) + 1e-9);
      }
    }
    expect(raySphere(v3(0, 0, 0), normalizeV3(s.center), s, 10)).toBe(true);
    expect(raySphere(v3(0, 0, 0), normalizeV3({ x: -s.center.x, y: -s.center.y, z: -s.center.z }), s, 10)).toBe(false);
  });

  it('OBB overlap detects real intersections and clears panels that just miss', () => {
    const a = panel(0, v3(0, 0, 0), v3(0, 0, 1), 1, 1, 0.2);
    const b = panel(1, v3(0, 0, 0.1), v3(0, 0, 1), 1, 1, 0.2);
    const far = panel(2, v3(0, 0, 1), v3(0, 0, 1), 1, 1, 0.2);
    const crossing = panel(3, v3(0.5, 0, -0.5), v3(1, 0, 0), 1, 1, 0.2);
    expect(obbOverlap(panelObb(a), panelObb(b))).toBe(true);
    expect(obbOverlap(panelObb(a), panelObb(far))).toBe(false);
    expect(obbOverlap(panelObb(a), panelObb(far), 0.9)).toBe(true);   // inflated
    expect(obbOverlap(panelObb(a), panelObb(crossing))).toBe(true);
  });

  it('BVH queries agree exactly with testing every panel', () => {
    const panels: PanelDef[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 40; i++) {
      const dir = normalizeV3(v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1));
      const p = panel(i, { x: dir.x * (0.5 + rnd() * 2), y: dir.y * (0.5 + rnd() * 2), z: dir.z * (0.5 + rnd() * 2) },
        dir, 0.3 + rnd(), 0.3 + rnd());
      if (rnd() < 0.3) p.shape = circleShape(0.6);
      panels.push(p);
    }
    const bvh = new PanelBvh(panels);
    for (let k = 0; k < 200; k++) {
      const o = v3(rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2);
      const d = normalizeV3(v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1));
      const brute = panels.filter((p) => rayPanelHit(p, o, d, 6) >= 0).map((p) => p.id).sort((a, b) => a - b);
      expect(bvh.query(o, d, 6).sort((a, b) => a - b)).toEqual(brute);
    }
  });

  it('BVH honours skip and keep filters', () => {
    const panels = [panel(0, v3(0, 0, 1), v3(0, 0, 1), 1, 1), panel(1, v3(0, 0, 2), v3(0, 0, 1), 1, 1)];
    const bvh = new PanelBvh(panels);
    expect(bvh.query(v3(0, 0, 0), v3(0, 0, 1), 6).sort()).toEqual([0, 1]);
    expect(bvh.query(v3(0, 0, 0), v3(0, 0, 1), 6, 0)).toEqual([1]);
    expect(bvh.query(v3(0, 0, 0), v3(0, 0, 1), 6, -1, (i) => i === 0)).toEqual([0]);
  });

  it('angleBetween is symmetric and clamped', () => {
    expect(angleBetween(v3(1, 0, 0), v3(0, 1, 0))).toBeCloseTo(Math.PI / 2, 9);
    expect(angleBetween(v3(1, 0, 0), v3(1, 0, 0))).toBeCloseTo(0, 9);
    expect(angleBetween(v3(1, 0, 0), v3(-1, 0, 0))).toBeCloseTo(Math.PI, 9);
  });
});

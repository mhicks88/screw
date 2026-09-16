import * as THREE from 'three';
import type { PanelDef, Vec2 } from '../core/types';
import { ASSEMBLY_RADIUS } from './layout';

/**
 * How deeply buried a blocked screw is — the renderer's own copy of the
 * blocking geometry, used for ONE thing: drill targeting.
 *
 * The core decides removable and the renderer must never second-guess it. But
 * v2's targeting mode showed an x-ray ghost only for screws one plate down —
 * the next thing the player would uncover — and drawing all ~50 buried screws
 * instead turns the drill overlay into soup. That distinction needs the depth,
 * not just the yes/no, so the withdrawal ray is re-cast here against the panels
 * still on the object and the hits are counted (stopping at 2).
 *
 * It only runs while targeting mode is on, and only when the set of live panels
 * has actually changed.
 */
export interface PanelRayTarget {
  id: number;
  def: PanelDef;
  origin: THREE.Vector3;
  /** Inverse of the panel's rotation: world → panel-local. */
  inv: THREE.Quaternion;
}

export function buildRayTargets(panels: readonly PanelDef[]): PanelRayTarget[] {
  return panels.map((def) => ({
    id: def.id,
    def,
    origin: new THREE.Vector3(def.position.x, def.position.y, def.position.z),
    inv: new THREE.Quaternion(def.rotation.x, def.rotation.y, def.rotation.z, def.rotation.w).invert(),
  }));
}

function pointInPoly(x: number, y: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const o = new THREE.Vector3();
const d = new THREE.Vector3();
const hit = new THREE.Vector3();

/**
 * CONTRACT_V3 §3: transform the ray into panel-local space, clip it to the
 * slab between local z = 0 and z = thickness, and run the 2D point-in-polygon
 * test (holes included) on the entry point.
 */
export function rayHitsPanel(p: PanelRayTarget, origin: THREE.Vector3, dir: THREE.Vector3, maxT: number): boolean {
  o.copy(origin).sub(p.origin).applyQuaternion(p.inv);
  d.copy(dir).applyQuaternion(p.inv);
  const th = p.def.thickness;
  let t0: number;
  if (Math.abs(d.z) < 1e-6) {
    if (o.z < 0 || o.z > th) return false;
    t0 = 0;
  } else {
    const ta = -o.z / d.z;
    const tb = (th - o.z) / d.z;
    t0 = Math.min(ta, tb);
    const t1 = Math.max(ta, tb);
    if (t1 < 0 || t0 > maxT) return false;
    t0 = Math.max(0, t0);
  }
  hit.copy(o).addScaledVector(d, t0);
  if (!pointInPoly(hit.x, hit.y, p.def.shape.outline)) return false;
  for (const h of p.def.shape.holes ?? []) if (pointInPoly(hit.x, hit.y, h)) return false;
  return true;
}

const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();

/**
 * How many live panels stand in this screw's way, counted up to `cap`.
 * `ownPanelId` is skipped and the ray starts a hair along the axis, exactly as
 * the core's rule does, so a screw never blocks itself.
 */
export function blockDepth(
  targets: readonly PanelRayTarget[],
  isLive: (panelId: number) => boolean,
  position: THREE.Vector3,
  axis: THREE.Vector3,
  ownPanelId: number,
  cap = 2,
): number {
  rayDir.copy(axis).normalize();
  rayOrigin.copy(position).addScaledVector(rayDir, 0.02);
  const maxT = 2 * ASSEMBLY_RADIUS;
  let n = 0;
  for (const t of targets) {
    if (t.id === ownPanelId || !isLive(t.id)) continue;
    if (rayHitsPanel(t, rayOrigin, rayDir, maxT)) {
      n++;
      if (n >= cap) return n;
    }
  }
  return n;
}

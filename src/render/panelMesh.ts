import * as THREE from 'three';
import type { PanelDef, Vec2 } from '../core/types';
import { DEPTH_TINT, PANEL_BEVEL, PANEL_DEPTH_FOG, shellFogAmount } from './layout';

/**
 * A panel is the 2D `PlateShape` outline EXTRUDED by `thickness` along its own
 * local +Z (z = 0 .. thickness) and placed in assembly space by `position` and
 * `rotation` (CONTRACT_V3 §2).
 *
 * Two things changed from v2's flat plates and both are visual, not structural:
 *
 *  - The side wall used to be a ~1 px sliver seen almost edge-on, so it was
 *    painted nearly black and nobody noticed. On a solid you now look straight
 *    at it half the time, so it gets a proper mid-tone and its own chamfer
 *    highlight — this is most of what makes a panel read as machined stock
 *    rather than as a coloured sticker.
 *  - Both faces are real. Backface culling stays ON (each panel is a closed
 *    solid), the underside is tinted a little darker than the top, and the
 *    lighting rig covers the whole front hemisphere so a face turned toward the
 *    camera is lit whichever way the object has been spun.
 */
export interface PanelVisual {
  id: number;
  shell: number;
  mesh: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>;
  /** Assembly-space direction to push the panel when it detaches. */
  outward: THREE.Vector3;
  /** True once the material has been cloned for a per-panel fade. */
  ownMaterial: boolean;
  dropped: boolean;
}

type MaterialKind = PanelDef['material'];

const sharedMaterials = new Map<MaterialKind, THREE.MeshStandardMaterial>();

function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

/**
 * Build a THREE.Shape from an outline + holes (panel-local coords).
 * The outline is forced counter-clockwise: with backface culling on, a
 * clockwise outline would extrude inside-out and the panel would vanish.
 */
export function shapeFromOutline(outline: readonly Vec2[], holes?: readonly Vec2[][]): THREE.Shape {
  const pts = signedArea(outline) >= 0 ? outline : [...outline].reverse();
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
  if (holes) {
    for (const h of holes) {
      if (h.length >= 3) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    }
  }
  return shape;
}

/**
 * Bake facing tint AND the panel's own colour into vertex colours, so every
 * panel of the same material kind shares one material (fewer programs, no
 * per-panel material churn) while still looking individually coloured.
 */
function bakeColors(geo: THREE.BufferGeometry, base: THREE.Color): void {
  const normal = geo.attributes.normal;
  const n = normal.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const nz = normal.getZ(i);
    let k: number;
    if (nz > 0.86) k = 1.0;             // outward face
    else if (nz > 0.12) k = 1.12;       // top chamfer catches the key light
    else if (nz > -0.12) k = 0.66;      // side wall: a main surface in v3
    else if (nz > -0.86) k = 0.62;      // bottom chamfer
    else k = 0.74;                      // inward face
    colors[i * 3] = base.r * k;
    colors[i * 3 + 1] = base.g * k;
    colors[i * 3 + 2] = base.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Panel colour after the per-shell aerial-perspective tint. */
export function panelColorFor(panel: PanelDef): THREE.Color {
  const c = new THREE.Color(panel.color);
  const fog = shellFogAmount(panel.shell, PANEL_DEPTH_FOG);
  if (fog > 0) {
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s * (1 - 0.3 * fog), hsl.l);
    c.lerp(new THREE.Color(DEPTH_TINT), fog);
  }
  return c;
}

function materialFor(kind: MaterialKind): THREE.MeshStandardMaterial {
  let m = sharedMaterials.get(kind);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.FrontSide,
      roughness: kind === 'metal' ? 0.34 : kind === 'wood' ? 0.78 : 0.47,
      metalness: kind === 'metal' ? 0.52 : 0.04,
      envMapIntensity: kind === 'metal' ? 0.9 : 0.45,
      flatShading: false,
    });
    m.name = `panel-${kind}`;
    sharedMaterials.set(kind, m);
  }
  return m;
}

export function createPanelVisual(panel: PanelDef): PanelVisual {
  const thickness = Math.max(0.03, panel.thickness);
  const bevel = Math.min(PANEL_BEVEL, thickness * 0.22);
  const shape = shapeFromOutline(panel.shape.outline, panel.shape.holes);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.005, thickness - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 1.5,
    bevelOffset: -bevel * 1.5,
    bevelSegments: 2,
    curveSegments: 8,
  });
  // Contract: the solid occupies local z ∈ [0, thickness].
  geometry.translate(0, 0, bevel);
  geometry.computeVertexNormals();
  bakeColors(geometry, panelColorFor(panel));

  const mesh = new THREE.Mesh(geometry, materialFor(panel.material));
  mesh.position.set(panel.position.x, panel.position.y, panel.position.z);
  mesh.quaternion.set(panel.rotation.x, panel.rotation.y, panel.rotation.z, panel.rotation.w);
  mesh.name = `panel-${panel.id}`;
  mesh.userData.panelId = panel.id;
  mesh.frustumCulled = false;

  // Where "away from the assembly" is for this panel: its own centre of mass
  // direction, falling back to its outward face normal for a panel that sits on
  // the axis of the object.
  const outward = new THREE.Vector3(panel.position.x, panel.position.y, panel.position.z);
  if (outward.lengthSq() < 0.04) {
    outward.set(0, 0, 1).applyQuaternion(mesh.quaternion);
  }
  outward.normalize();

  return { id: panel.id, shell: panel.shell, mesh, outward, ownMaterial: false, dropped: false };
}

/**
 * Give this panel a private material so it can fade out on its own.
 * Called once, when the panel detaches.
 */
export function makePanelMaterialUnique(v: PanelVisual): THREE.MeshStandardMaterial {
  if (!v.ownMaterial) {
    v.mesh.material = v.mesh.material.clone();
    v.ownMaterial = true;
  }
  return v.mesh.material;
}

export function disposePanelVisual(v: PanelVisual): void {
  v.mesh.removeFromParent();
  v.mesh.geometry.dispose();
  if (v.ownMaterial) v.mesh.material.dispose();
}

export function disposePanelCaches(): void {
  for (const m of sharedMaterials.values()) m.dispose();
  sharedMaterials.clear();
}

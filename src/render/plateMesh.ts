import * as THREE from 'three';
import type { PlateDef } from '../core/types';
import {
  DEPTH_TINT,
  LAYER_SPACING,
  PLATE_BEVEL,
  PLATE_DEPTH_FOG,
  PLATE_THICKNESS,
  contactShadowOffset,
  depthFogAmount,
} from './layout';

export interface PlateVisual {
  id: number;
  layer: number;
  mesh: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>;
  /** Fake contact shadow dropped onto whatever is below (child of `mesh`). */
  shadow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  dropped: boolean;
}

/**
 * Chamfer geometry. At 0.10 thickness the *silhouette* of the side wall is only
 * ~1 CSS px on the target device, so the readable edge has to come from a wide,
 * shallow top chamfer that catches the key light instead.
 */
const BEVEL_SIZE = 0.05;

/** Build a THREE.Shape from a PlateShape outline + holes (plate-local coords). */
export function shapeFromOutline(outline: { x: number; y: number }[], holes?: { x: number; y: number }[][]): THREE.Shape {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  if (holes) {
    for (const h of holes) {
      if (h.length >= 3) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    }
  }
  return shape;
}

/**
 * Bake a face tint into vertex colours so a 0.10-thick sheet still reads as a
 * solid slab: bright chamfer ring, plain top face, dark side wall and underside.
 * This is the cheapest "stronger edge bevel" available — no extra draw call,
 * and it survives the per-layer depth fog because it multiplies the base colour.
 */
function tintByFacing(geo: THREE.BufferGeometry): void {
  const normal = geo.attributes.normal;
  const n = normal.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const nz = normal.getZ(i);
    let k: number;
    if (nz > 0.86) k = 1.0;            // flat top
    else if (nz > 0.12) k = 1.05;      // top chamfer — a soft, not glassy, lip
    else if (nz > -0.12) k = 0.4;      // side wall
    else k = 0.26;                     // underside
    colors[i * 3] = k;
    colors[i * 3 + 1] = k;
    colors[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}


/**
 * Soft contact shadow as a fading band hugging the plate outline, nudged along
 * the key light.
 *
 * A filled silhouette (the obvious implementation) is wrong here: towers skip
 * layers, so a plate's shadow often floats 2-3 layers above whatever is
 * actually beneath it and then reads as a translucent ghost plate rather than a
 * shadow. A band only ever shows as a halo just outside the plate's own edge,
 * which is exactly the contact cue the stack needs and never invents a shape.
 */
function buildShadowBand(outline: { x: number; y: number }[], width: number, alpha: number, off: { x: number; y: number }): THREE.BufferGeometry {
  const n = outline.length;
  const inner: number[][] = [];
  const outer: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = outline[i];
    const prev = outline[(i - 1 + n) % n];
    const next = outline[(i + 1) % n];
    // Outward normal = normalised sum of the two adjacent edge normals (CCW).
    const e1x = p.x - prev.x, e1y = p.y - prev.y;
    const e2x = next.x - p.x, e2y = next.y - p.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    let nx = e1y / l1 + e2y / l2;
    let ny = -e1x / l1 - e2x / l2;
    const ln = Math.hypot(nx, ny) || 1;
    nx /= ln;
    ny /= ln;
    inner.push([p.x + off.x - nx * 0.07, p.y + off.y - ny * 0.07]);
    outer.push([p.x + off.x + nx * width, p.y + off.y + ny * width]);
  }
  const pos: number[] = [];
  const col: number[] = [];
  const push = (xy: number[], a: number) => {
    pos.push(xy[0], xy[1], 0);
    col.push(0, 0, 0, a);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(inner[i], alpha); push(inner[j], alpha); push(outer[j], 0);
    push(inner[i], alpha); push(outer[j], 0); push(outer[i], 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return geo;
}

/** Plate colour after the per-layer aerial-perspective tint. */
export function plateColorFor(plate: PlateDef, maxLayer: number): THREE.Color {
  const c = new THREE.Color(plate.color);
  const fog = depthFogAmount(plate.layer, maxLayer, PLATE_DEPTH_FOG);
  // Also desaturate slightly with depth: two different reds on layer 1 and 12
  // should not compete for attention.
  if (fog > 0) {
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s * (1 - 0.35 * fog), hsl.l);
    c.lerp(new THREE.Color(DEPTH_TINT), fog);
  }
  return c;
}

/**
 * Extrude the plate outline in local space; the mesh is positioned/rotated so
 * the local origin lands on (plate.x, plate.y) at the plate's layer height.
 */
export function createPlateVisual(plate: PlateDef, maxLayer: number): PlateVisual {
  const shape = shapeFromOutline(plate.shape.outline, plate.shape.holes);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, PLATE_THICKNESS - 2 * PLATE_BEVEL),
    bevelEnabled: true,
    bevelThickness: PLATE_BEVEL,
    bevelSize: BEVEL_SIZE,
    bevelOffset: -BEVEL_SIZE,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geometry.computeVertexNormals();
  tintByFacing(geometry);

  const isMetal = plate.material === 'metal';
  const isWood = plate.material === 'wood';
  const material = new THREE.MeshStandardMaterial({
    color: plateColorFor(plate, maxLayer),
    roughness: isMetal ? 0.34 : isWood ? 0.78 : 0.46,
    metalness: isMetal ? 0.5 : 0.04,
    envMapIntensity: isMetal ? 0.9 : 0.42,
    vertexColors: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(plate.x, plate.y, plate.layer * LAYER_SPACING + PLATE_BEVEL);
  mesh.rotation.z = plate.rotation;
  mesh.name = `plate-${plate.id}`;
  mesh.userData.plateId = plate.id;

  // Contact shadow (see buildShadowBand). It is a child of the plate so it
  // falls away with it.
  const c = Math.cos(-plate.rotation);
  const s = Math.sin(-plate.rotation);
  const world = contactShadowOffset(LAYER_SPACING * 1.4);
  const off = { x: world.x * c - world.y * s, y: world.x * s + world.y * c };
  const shadow = new THREE.Mesh(
    buildShadowBand(plate.shape.outline, 0.17, 1, off),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      // The band's winding depends on the outline's, which the generator owns.
      side: THREE.DoubleSide,
    }),
  );
  // Sit just above the top of the layer below this plate's own bottom face.
  shadow.position.z = -PLATE_BEVEL - (LAYER_SPACING - PLATE_THICKNESS) + 0.004;
  shadow.renderOrder = -1;
  shadow.name = `plate-shadow-${plate.id}`;
  mesh.add(shadow);

  return { id: plate.id, layer: plate.layer, mesh, shadow, dropped: false };
}

export function disposePlateVisual(v: PlateVisual): void {
  v.mesh.removeFromParent();
  v.mesh.geometry.dispose();
  v.mesh.material.dispose();
  v.shadow.geometry.dispose();
  v.shadow.material.dispose();
}

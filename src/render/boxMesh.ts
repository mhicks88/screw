import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLOR_HEX } from '../core/types';
import type { BoxState, ScrewColor } from '../core/types';
import { BOX_DEPTH, BOX_HEIGHT, BOX_HOLE_R, BOX_SLOT_SPACING, BOX_WIDTH, BOX_Y } from './layout';

export interface BoxVisual {
  id: number;
  color: ScrewColor;
  position: number;
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  inset: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  lid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  /** Screw ids in fill order (logical, updated at event dispatch). */
  screws: number[];
}

interface BoxGeometries {
  body: THREE.BufferGeometry;
  lid: THREE.BufferGeometry;
  stripe: THREE.BufferGeometry;
  inset: THREE.BufferGeometry;
  holes: THREE.BufferGeometry;
  rims: THREE.BufferGeometry;
}

let geos: BoxGeometries | null = null;
let stripeMat: THREE.MeshStandardMaterial | null = null;
let holeMat: THREE.MeshStandardMaterial | null = null;
let rimMat: THREE.MeshStandardMaterial | null = null;

const BEVEL = 0.05;

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function boxSlotLocalX(slot: number): number {
  return (slot - 1) * BOX_SLOT_SPACING;
}

/** Local position of a slot on the box top surface. */
export function boxSlotLocal(slot: number): THREE.Vector3 {
  return new THREE.Vector3(boxSlotLocalX(slot), 0, BOX_HEIGHT);
}

/**
 * The box is a solid bevelled block; the three "holes" are dark discs with a
 * light rim on the top face. (Cutting real holes through a bevelled
 * ExtrudeGeometry makes earcut silently fill one of them for this shape.)
 * With the near top-down camera the discs read as holes, and a parked screw's
 * shaft is hidden inside the solid body.
 */
function geometries(): BoxGeometries {
  if (geos) return geos;
  const body = new THREE.ExtrudeGeometry(roundedRect(BOX_WIDTH, BOX_DEPTH, 0.2), {
    depth: BOX_HEIGHT - 2 * BEVEL,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL * 0.9,
    bevelOffset: -BEVEL * 0.9,
    bevelSegments: 3,
    curveSegments: 10,
  });
  body.translate(0, 0, BEVEL);
  body.computeVertexNormals();

  const lid = new THREE.ExtrudeGeometry(roundedRect(BOX_WIDTH + 0.06, BOX_DEPTH + 0.06, 0.22), {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.035,
    bevelOffset: -0.035,
    bevelSegments: 2,
    curveSegments: 10,
  });
  lid.translate(0, 0, 0.04);
  lid.computeVertexNormals();

  const stripe = new THREE.ExtrudeGeometry(roundedRect(BOX_WIDTH + 0.02, BOX_DEPTH + 0.02, 0.21), {
    depth: 0.16,
    bevelEnabled: false,
    curveSegments: 10,
  });

  const inset = new THREE.ShapeGeometry(roundedRect(BOX_WIDTH - 0.26, BOX_DEPTH - 0.26, 0.12), 8);

  const discs: THREE.BufferGeometry[] = [];
  const rings: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new THREE.CircleGeometry(BOX_HOLE_R + 0.03, 28);
    d.translate(boxSlotLocalX(i), 0, 0);
    discs.push(d);
    const r = new THREE.RingGeometry(BOX_HOLE_R + 0.03, BOX_HOLE_R + 0.065, 28);
    r.translate(boxSlotLocalX(i), 0, 0);
    rings.push(r);
  }
  const holes = mergeGeometries(discs, false) ?? discs[0];
  const rims = mergeGeometries(rings, false) ?? rings[0];
  for (const g of discs) if (g !== holes) g.dispose();
  for (const g of rings) if (g !== rims) g.dispose();

  geos = { body, lid, stripe, inset, holes, rims };
  return geos;
}

function materials() {
  stripeMat ??= new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.6,
    metalness: 0.05,
    transparent: true,
    opacity: 0.22,
  });
  holeMat ??= new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.9, metalness: 0.1 });
  rimMat ??= new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0.05,
    transparent: true,
    opacity: 0.35,
  });
  return { stripeMat, holeMat, rimMat };
}

function boxColor(color: ScrewColor): THREE.Color {
  const c = new THREE.Color(COLOR_HEX[color]);
  // Boxes are a touch lighter/softer than the screw metal.
  c.lerp(new THREE.Color(0xffffff), 0.08);
  return c;
}

export function createBoxVisual(state: BoxState, worldX: number): BoxVisual {
  const g = geometries();
  const m = materials();
  const group = new THREE.Group();
  group.name = `box-${state.id}`;
  group.position.set(worldX, BOX_Y, 0);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color),
    roughness: 0.5,
    metalness: 0.03,
    envMapIntensity: 0.4,
  });
  const body = new THREE.Mesh(g.body, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const stripe = new THREE.Mesh(g.stripe, m.stripeMat);
  stripe.position.z = 0.08;
  group.add(stripe);

  const insetMat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color).multiplyScalar(0.72),
    roughness: 0.75,
    metalness: 0.02,
    envMapIntensity: 0.3,
  });
  const inset = new THREE.Mesh(g.inset, insetMat);
  inset.position.z = BOX_HEIGHT + 0.003;
  inset.receiveShadow = true;
  group.add(inset);

  const holes = new THREE.Mesh(g.holes, m.holeMat);
  holes.position.z = BOX_HEIGHT + 0.006;
  group.add(holes);

  const rims = new THREE.Mesh(g.rims, m.rimMat);
  rims.position.z = BOX_HEIGHT + 0.006;
  group.add(rims);

  const lidMat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color).multiplyScalar(0.85),
    roughness: 0.5,
    metalness: 0.03,
    envMapIntensity: 0.4,
  });
  const lid = new THREE.Mesh(g.lid, lidMat);
  lid.visible = false;
  lid.castShadow = true;
  lid.position.z = BOX_HEIGHT + 1.4;
  group.add(lid);

  return {
    id: state.id,
    color: state.color,
    position: state.position,
    group,
    body,
    inset,
    lid,
    screws: [...state.screws],
  };
}

export function setBoxColor(v: BoxVisual, color: ScrewColor): void {
  v.color = color;
  v.body.material.color.copy(boxColor(color));
  v.inset.material.color.copy(boxColor(color).multiplyScalar(0.72));
  v.lid.material.color.copy(boxColor(color).multiplyScalar(0.85));
}

export function disposeBoxVisual(v: BoxVisual): void {
  v.group.removeFromParent();
  v.body.material.dispose();
  v.inset.material.dispose();
  v.lid.material.dispose();
}

export function disposeBoxCaches(): void {
  if (geos) {
    for (const g of Object.values(geos)) g.dispose();
    geos = null;
  }
  stripeMat?.dispose();
  holeMat?.dispose();
  rimMat?.dispose();
  stripeMat = holeMat = rimMat = null;
}

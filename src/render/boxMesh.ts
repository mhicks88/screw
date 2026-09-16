import * as THREE from 'three';
import { COLOR_HEX } from '../core/types';
import type { BoxState, ScrewColor } from '../core/types';
import {
  BOX_DEPTH,
  BOX_HEIGHT,
  BOX_HOLE_R,
  BOX_SLOT_SPACING,
  BOX_WIDTH,
  BOX_Y,
} from './layout';

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

let bodyGeo: THREE.BufferGeometry | null = null;
let lidGeo: THREE.BufferGeometry | null = null;
let floorGeo: THREE.BufferGeometry | null = null;
let floorMat: THREE.MeshStandardMaterial | null = null;
let stripeGeo: THREE.BufferGeometry | null = null;
let stripeMat: THREE.MeshStandardMaterial | null = null;
let insetGeo: THREE.BufferGeometry | null = null;

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

function geometries() {
  if (!bodyGeo) {
    // NOTE: ExtrudeGeometry's bevelled-lid triangulation (earcut) silently
    // fills a hole when a negative bevelOffset is used or when holes come
    // within ~0.05 of each other. So: bevelOffset 0, outline shrunk by the
    // bevel size, holes at shaft radius (the bevel widens their mouth).
    const bs = BEVEL * 0.9;
    const shape = roundedRect(BOX_WIDTH - 2 * bs, BOX_DEPTH - 2 * bs, 0.2 - bs);
    for (let i = 0; i < 3; i++) {
      const hole = new THREE.Path();
      hole.absarc(boxSlotLocalX(i), 0, BOX_HOLE_R, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    bodyGeo = new THREE.ExtrudeGeometry(shape, {
      depth: BOX_HEIGHT - 2 * BEVEL,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: bs,
      bevelOffset: 0,
      bevelSegments: 3,
      curveSegments: 10,
    });
    bodyGeo.translate(0, 0, BEVEL);
    bodyGeo.computeVertexNormals();

    const lidShape = roundedRect(BOX_WIDTH + 0.06, BOX_DEPTH + 0.06, 0.22);
    lidGeo = new THREE.ExtrudeGeometry(lidShape, {
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.035,
      bevelOffset: -0.035,
      bevelSegments: 2,
      curveSegments: 10,
    });
    lidGeo.translate(0, 0, 0.04);
    lidGeo.computeVertexNormals();

    floorGeo = new THREE.PlaneGeometry(BOX_WIDTH - 0.1, BOX_DEPTH - 0.1);
    floorMat = new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.9, metalness: 0.1 });

    // Decorative darker band around the lower body.
    stripeGeo = new THREE.ExtrudeGeometry(roundedRect(BOX_WIDTH + 0.02, BOX_DEPTH + 0.02, 0.21), {
      depth: 0.16,
      bevelEnabled: false,
      curveSegments: 10,
    });
    stripeMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 0.22 });

    // Darker inset panel on the top face (reads as the open mouth of the box).
    const insetShape = roundedRect(BOX_WIDTH - 0.26, BOX_DEPTH - 0.26, 0.12);
    for (let i = 0; i < 3; i++) {
      const hole = new THREE.Path();
      hole.absarc(boxSlotLocalX(i), 0, BOX_HOLE_R + bs + 0.01, 0, Math.PI * 2, true);
      insetShape.holes.push(hole);
    }
    insetGeo = new THREE.ShapeGeometry(insetShape, 10);
  }
  return {
    bodyGeo: bodyGeo!,
    lidGeo: lidGeo!,
    floorGeo: floorGeo!,
    floorMat: floorMat!,
    stripeGeo: stripeGeo!,
    stripeMat: stripeMat!,
    insetGeo: insetGeo!,
  };
}

function boxColor(color: ScrewColor): THREE.Color {
  const c = new THREE.Color(COLOR_HEX[color]);
  // Boxes are a touch lighter/softer than the screw metal.
  c.lerp(new THREE.Color(0xffffff), 0.08);
  return c;
}

export function createBoxVisual(state: BoxState, worldX: number): BoxVisual {
  const g = geometries();
  const group = new THREE.Group();
  group.name = `box-${state.id}`;
  group.position.set(worldX, BOX_Y, 0);

  const mat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color),
    roughness: 0.5,
    metalness: 0.03,
    envMapIntensity: 0.4,
  });
  const body = new THREE.Mesh(g.bodyGeo, mat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const floor = new THREE.Mesh(g.floorGeo, g.floorMat);
  floor.position.z = 0.3;
  group.add(floor);

  const stripe = new THREE.Mesh(g.stripeGeo, g.stripeMat);
  stripe.position.z = 0.08;
  group.add(stripe);

  const insetMat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color).multiplyScalar(0.72),
    roughness: 0.75,
    metalness: 0.02,
    envMapIntensity: 0.3,
  });
  const inset = new THREE.Mesh(g.insetGeo, insetMat);
  inset.position.z = BOX_HEIGHT + 0.004;
  inset.receiveShadow = true;
  group.add(inset);

  const lidMat = new THREE.MeshStandardMaterial({
    color: boxColor(state.color).multiplyScalar(0.85),
    roughness: 0.5,
    metalness: 0.03,
    envMapIntensity: 0.4,
  });
  const lid = new THREE.Mesh(g.lidGeo, lidMat);
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
  bodyGeo?.dispose();
  lidGeo?.dispose();
  floorGeo?.dispose();
  floorMat?.dispose();
  stripeGeo?.dispose();
  stripeMat?.dispose();
  insetGeo?.dispose();
  bodyGeo = lidGeo = floorGeo = stripeGeo = insetGeo = null;
  floorMat = stripeMat = null;
}

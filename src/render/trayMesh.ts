import * as THREE from 'three';
import { TRAY_DEPTH, TRAY_HEIGHT, TRAY_HOLE_R, TRAY_Y, trayPositionsX, trayWidth } from './layout';

export interface TrayVisual {
  group: THREE.Group;
  bar: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  floor: THREE.Mesh;
  slotCount: number;
}

let barMaterial: THREE.MeshStandardMaterial | null = null;
let floorMaterial: THREE.MeshStandardMaterial | null = null;

const BEVEL = 0.04;

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

function buildBarGeometry(slotCount: number): THREE.BufferGeometry {
  const shape = roundedRect(trayWidth(slotCount), TRAY_DEPTH, 0.22);
  for (const x of trayPositionsX(slotCount)) {
    const hole = new THREE.Path();
    hole.absarc(x, 0, TRAY_HOLE_R, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: TRAY_HEIGHT - 2 * BEVEL,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL * 0.9,
    bevelOffset: -BEVEL * 0.9,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geo.translate(0, 0, BEVEL);
  geo.computeVertexNormals();
  return geo;
}

function materials() {
  barMaterial ??= new THREE.MeshStandardMaterial({
    color: 0xaab3c0,
    roughness: 0.38,
    metalness: 0.75,
    envMapIntensity: 1.0,
  });
  floorMaterial ??= new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.9, metalness: 0.1 });
  return { barMaterial, floorMaterial };
}

export function createTrayVisual(slotCount: number): TrayVisual {
  const m = materials();
  const group = new THREE.Group();
  group.name = 'tray';
  group.position.set(0, TRAY_Y, 0);

  const bar = new THREE.Mesh(buildBarGeometry(slotCount), m.barMaterial);
  bar.castShadow = true;
  bar.receiveShadow = true;
  group.add(bar);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(trayWidth(slotCount) - 0.1, TRAY_DEPTH - 0.1), m.floorMaterial);
  floor.position.z = 0.06;
  group.add(floor);

  return { group, bar, floor, slotCount };
}

/** Rebuild the bar for a new slot count (geometry swap). */
export function rebuildTray(v: TrayVisual, slotCount: number): void {
  v.bar.geometry.dispose();
  v.bar.geometry = buildBarGeometry(slotCount);
  v.floor.geometry.dispose();
  v.floor.geometry = new THREE.PlaneGeometry(trayWidth(slotCount) - 0.1, TRAY_DEPTH - 0.1);
  v.slotCount = slotCount;
}

/** World position where a screw sits in tray slot `slot`. */
export function traySlotWorld(v: TrayVisual, slot: number): THREE.Vector3 {
  const xs = trayPositionsX(v.slotCount);
  const x = xs[Math.min(slot, xs.length - 1)] ?? 0;
  return new THREE.Vector3(x, TRAY_Y, TRAY_HEIGHT);
}

export function disposeTrayVisual(v: TrayVisual): void {
  v.group.removeFromParent();
  v.bar.geometry.dispose();
  v.floor.geometry.dispose();
}

export function disposeTrayCaches(): void {
  barMaterial?.dispose();
  floorMaterial?.dispose();
  barMaterial = floorMaterial = null;
}

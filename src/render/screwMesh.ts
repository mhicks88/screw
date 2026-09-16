import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLOR_HEX } from '../core/types';
import type { ScrewColor, ScrewLocation } from '../core/types';
import { SCREW_HEAD_R, SCREW_HIT_R } from './layout';

/** Layer used for invisible raycast targets (camera renders layer 0 only). */
export const HIT_LAYER = 1;
export const MYSTERY_HEX = 0x8a8f98;

export interface ScrewVisual {
  id: number;
  plateId: number;
  color: ScrewColor;
  revealed: boolean;
  location: ScrewLocation;
  group: THREE.Group;
  body: THREE.Mesh;
  cross: THREE.Mesh;
  mystery: THREE.Mesh;
  hit: THREE.Mesh;
  hintRing: THREE.Mesh;
  targetRing: THREE.Mesh;
  /** Layer of the plate the screw sits on (for hit priority). */
  layer: number;
}

interface ScrewGeometryCache {
  body: THREE.BufferGeometry;
  cross: THREE.BufferGeometry;
  hit: THREE.BufferGeometry;
  hintRing: THREE.BufferGeometry;
  targetRing: THREE.BufferGeometry;
  mystery: THREE.BufferGeometry;
}

let geoCache: ScrewGeometryCache | null = null;
const materialCache = new Map<string, THREE.MeshStandardMaterial>();
let crossMaterial: THREE.MeshStandardMaterial | null = null;
let hitMaterial: THREE.MeshBasicMaterial | null = null;
let hintMaterial: THREE.MeshBasicMaterial | null = null;
let targetMaterial: THREE.MeshBasicMaterial | null = null;
let mysteryMaterial: THREE.MeshBasicMaterial | null = null;
let flashMaterialCached: THREE.MeshStandardMaterial | null = null;

/** Height of the head above the screw group's origin (plate surface). */
export const SCREW_HEAD_TOP = 0.2;

function buildGeometries(): ScrewGeometryCache {
  const r = SCREW_HEAD_R;
  // Shaft: goes down into the plate.
  const shaft = new THREE.CylinderGeometry(0.105, 0.085, 0.4, 14, 1);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, -0.2);
  // Head rim: short cylinder sitting on the surface.
  const rim = new THREE.CylinderGeometry(r, r * 0.93, 0.075, 28, 1);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0, 0.0375);
  // Dome: upper hemisphere, flattened.
  const dome = new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  dome.scale(1, 1, 0.5);
  dome.translate(0, 0, 0.075);
  const body = mergeGeometries([shaft, rim, dome], false) ?? dome;
  shaft.dispose();
  rim.dispose();
  if (body !== dome) dome.dispose();
  body.computeVertexNormals();

  // Phillips cross: two dark bars slightly proud of the dome.
  const barA = new THREE.BoxGeometry(0.3, 0.07, 0.05);
  const barB = new THREE.BoxGeometry(0.07, 0.3, 0.05);
  const cross = mergeGeometries([barA, barB], false) ?? barA;
  cross.translate(0, 0, 0.185);
  barA.dispose();
  if (cross !== barA) barB.dispose();

  const hit = new THREE.SphereGeometry(SCREW_HIT_R, 10, 8);
  hit.translate(0, 0, 0.1);

  const hintRing = new THREE.RingGeometry(r + 0.06, r + 0.15, 40);
  const targetRing = new THREE.RingGeometry(r + 0.1, r + 0.145, 40);
  const mystery = new THREE.CircleGeometry(r * 0.72, 24);
  mystery.translate(0, 0, SCREW_HEAD_TOP + 0.012);
  return { body, cross, hit, hintRing, targetRing, mystery };
}

function makeMysteryTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(30,32,40,0.9)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 92px system-ui, -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', size / 2, size / 2 + 6);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function geometries(): ScrewGeometryCache {
  if (!geoCache) geoCache = buildGeometries();
  return geoCache;
}

export function screwMaterial(color: ScrewColor | 'mystery'): THREE.MeshStandardMaterial {
  let m = materialCache.get(color);
  if (!m) {
    if (color === 'mystery') {
      m = new THREE.MeshStandardMaterial({
        color: MYSTERY_HEX,
        roughness: 0.55,
        metalness: 0.45,
        envMapIntensity: 0.8,
      });
    } else {
      m = new THREE.MeshStandardMaterial({
        color: COLOR_HEX[color],
        roughness: 0.32,
        metalness: 0.6,
        envMapIntensity: 1.0,
      });
    }
    materialCache.set(color, m);
  }
  return m;
}

export function flashMaterial(): THREE.MeshStandardMaterial {
  if (!flashMaterialCached) {
    flashMaterialCached = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.3,
    });
  }
  return flashMaterialCached;
}

function sharedMaterials() {
  crossMaterial ??= new THREE.MeshStandardMaterial({ color: 0x23252c, roughness: 0.6, metalness: 0.4 });
  hitMaterial ??= new THREE.MeshBasicMaterial({ visible: false });
  hintMaterial ??= new THREE.MeshBasicMaterial({
    color: 0xfff2a0,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  targetMaterial ??= new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mysteryMaterial ??= new THREE.MeshBasicMaterial({
    map: makeMysteryTexture(),
    transparent: true,
    depthWrite: false,
  });
  return { crossMaterial, hitMaterial, hintMaterial, targetMaterial, mysteryMaterial };
}

export function hintRingMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterials().hintMaterial;
}

export interface ScrewVisualInit {
  id: number;
  plateId: number;
  color: ScrewColor;
  revealed: boolean;
  location: ScrewLocation;
  layer: number;
}

export function createScrewVisual(init: ScrewVisualInit): ScrewVisual {
  const g = geometries();
  const mats = sharedMaterials();
  const group = new THREE.Group();
  group.name = `screw-${init.id}`;

  const body = new THREE.Mesh(g.body, screwMaterial(init.revealed ? init.color : 'mystery'));
  body.castShadow = true;
  body.receiveShadow = false;
  group.add(body);

  const cross = new THREE.Mesh(g.cross, mats.crossMaterial);
  cross.visible = init.revealed;
  group.add(cross);

  const mystery = new THREE.Mesh(g.mystery, mats.mysteryMaterial);
  mystery.visible = !init.revealed;
  mystery.renderOrder = 2;
  group.add(mystery);

  const hit = new THREE.Mesh(g.hit, mats.hitMaterial);
  hit.layers.set(HIT_LAYER);
  hit.userData.screwId = init.id;
  group.add(hit);

  const hintRing = new THREE.Mesh(g.hintRing, mats.hintMaterial);
  hintRing.position.z = 0.02;
  hintRing.visible = false;
  hintRing.renderOrder = 10;
  group.add(hintRing);

  const targetRing = new THREE.Mesh(g.targetRing, mats.targetMaterial);
  targetRing.position.z = 0.02;
  targetRing.visible = false;
  targetRing.renderOrder = 11;
  group.add(targetRing);

  const v: ScrewVisual = {
    id: init.id,
    plateId: init.plateId,
    color: init.color,
    revealed: init.revealed,
    location: init.location,
    group,
    body,
    cross,
    mystery,
    hit,
    hintRing,
    targetRing,
    layer: init.layer,
  };
  setScrewHittable(v, init.location === 'plate');
  return v;
}

/** Only on-plate screws are raycast targets. */
export function setScrewHittable(v: ScrewVisual, on: boolean): void {
  if (on) v.hit.layers.set(HIT_LAYER);
  else v.hit.layers.set(31);
}

/** Show the real colour (after reveal) or the grey mystery look. */
export function applyScrewColor(v: ScrewVisual, color: ScrewColor, revealed: boolean): void {
  v.color = color;
  v.revealed = revealed;
  v.body.material = screwMaterial(revealed ? color : 'mystery');
  v.cross.visible = revealed;
  v.mystery.visible = !revealed;
}

export function disposeScrewVisual(v: ScrewVisual): void {
  v.group.removeFromParent();
  // geometries/materials are shared; nothing else to free per screw
}

/** Free the shared caches (renderer.dispose). */
export function disposeScrewCaches(): void {
  if (geoCache) {
    for (const g of Object.values(geoCache)) g.dispose();
    geoCache = null;
  }
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
  crossMaterial?.dispose();
  crossMaterial = null;
  hitMaterial?.dispose();
  hitMaterial = null;
  hintMaterial?.dispose();
  hintMaterial = null;
  targetMaterial?.dispose();
  targetMaterial = null;
  if (mysteryMaterial) {
    mysteryMaterial.map?.dispose();
    mysteryMaterial.dispose();
    mysteryMaterial = null;
  }
  flashMaterialCached?.dispose();
  flashMaterialCached = null;
}

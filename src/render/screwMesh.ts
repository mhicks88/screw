import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLOR_HEX } from '../core/types';
import type { ScrewColor, ScrewLocation, Vec3 } from '../core/types';
import { DEPTH_TINT, SCREW_DEPTH_FOG, SCREW_HEAD_R, SCREW_HIT_R, shellFogAmount } from './layout';

/** Layer used for invisible raycast targets (camera renders layer 0 only). */
export const HIT_LAYER = 1;
export const MYSTERY_HEX = 0x8a8f98;

/**
 * Screw geometry is authored along LOCAL +Z: the shaft sinks into the panel at
 * -z, the head stands proud up to SCREW_HEAD_TOP, and the Phillips cross faces
 * +z. A screw is then oriented by the quaternion that maps +Z onto its
 * `axis` — the direction it withdraws along (CONTRACT_V3 §2) — so one geometry
 * serves every screw on every face of the assembly.
 */
export const SCREW_HEAD_TOP = 0.15;

/** Reusable +Z basis for axis→quaternion conversions. */
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export interface ScrewVisual {
  id: number;
  panelId: number;
  color: ScrewColor;
  revealed: boolean;
  location: ScrewLocation;
  /** Shell of the panel it sits on (depth tint only). */
  shell: number;
  /** Core's verdict: its withdrawal path is obstructed. */
  blocked: boolean;
  /** Renderer's verdict: the rotated axis points toward the camera. */
  facing: boolean;
  /**
   * Blocked by exactly one live panel — the next thing the player would
   * uncover. Only the drill overlay uses it (see occlusion.ts).
   */
  ghost: boolean;
  /** Resting position, ASSEMBLY space. */
  home: THREE.Vector3;
  /** Withdrawal axis, ASSEMBLY space (unit). */
  axis: THREE.Vector3;
  /** Orientation mapping +Z onto `axis`, ASSEMBLY space. */
  quat: THREE.Quaternion;
  /**
   * Live position. Assembly space while the screw is seated in the instanced
   * field; WORLD space once it detaches for a flight (the assembly may keep
   * rotating under it and must not drag it along).
   */
  pos: THREE.Vector3;
  /** Live orientation while detached (world space). */
  worldQuat: THREE.Quaternion;
  /** Spin about the screw's own axis (unscrewing). */
  spin: number;
  scale: number;
  /** White flash overlay (blocked tap / reveal) while pooled. */
  flash: boolean;
  /** Non-null only while detached (in flight, in the tray, in a box). */
  group: THREE.Group | null;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null;
  mystery: THREE.Mesh | null;
  /** Invisible raycast proxy; present only while the screw is tappable. */
  hit: THREE.Mesh | null;
}

interface ScrewGeometryCache {
  body: THREE.BufferGeometry;
  /** Flat AO ring drawn around a seated screw head (its own neutral batch). */
  contact: THREE.BufferGeometry;
  hit: THREE.BufferGeometry;
  hintRing: THREE.BufferGeometry;
  targetRing: THREE.BufferGeometry;
  mystery: THREE.BufferGeometry;
}

let geoCache: ScrewGeometryCache | null = null;
const materialCache = new Map<string, THREE.MeshStandardMaterial>();
let hitMaterial: THREE.MeshBasicMaterial | null = null;
let hintMaterial: THREE.MeshBasicMaterial | null = null;
let targetMaterial: THREE.MeshBasicMaterial | null = null;
let mysteryMaterial: THREE.MeshBasicMaterial | null = null;
let flashMaterialCached: THREE.MeshStandardMaterial | null = null;
let seatedMaterialCached: THREE.MeshStandardMaterial | null = null;
let ghostMaterialCached: THREE.MeshStandardMaterial | null = null;
let contactMaterialCached: THREE.MeshBasicMaterial | null = null;

/** Quaternion that turns local +Z into `axis`. */
export function quatFromAxis(axis: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromUnitVectors(Z_AXIS, axis);
}

function tintGeometry(geo: THREE.BufferGeometry, r: number, g: number, b: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * A screw is one merged geometry so the whole field is a single draw call.
 * Vertex colours carry the dark Phillips cross; the per-instance colour carries
 * the screw's actual colour.
 */
function buildScrewBody(): THREE.BufferGeometry {
  const r = SCREW_HEAD_R;
  const parts: THREE.BufferGeometry[] = [];

  // Shaft: sinks into the panel along -z.
  const shaft = new THREE.CylinderGeometry(0.098, 0.08, 0.34, 10, 1);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, -0.17);
  // Head rim: short cylinder sitting on the surface.
  const rim = new THREE.CylinderGeometry(r, r * 0.88, 0.055, 20, 1);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0, 0.0275);
  // Dome. Taller than v2's 0.075: nothing sits directly over a removable screw
  // any more, and the extra height is what makes a head read as a head when the
  // face it stands on is seen at a glancing angle.
  const dome = new THREE.SphereGeometry(r, 20, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  dome.scale(1, 1, 0.42);
  dome.translate(0, 0, 0.055);
  // Phillips cross: two dark bars slightly proud of the dome.
  const barA = new THREE.BoxGeometry(0.28, 0.062, 0.04);
  const barB = new THREE.BoxGeometry(0.062, 0.28, 0.04);
  barA.translate(0, 0, 0.128);
  barB.translate(0, 0, 0.128);

  for (const g of [shaft, rim, dome]) tintGeometry(g, 1, 1, 1);
  for (const g of [barA, barB]) tintGeometry(g, 0.15, 0.15, 0.17);
  parts.push(shaft, rim, dome, barA, barB);

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  const out = merged ?? new THREE.SphereGeometry(r, 12, 6);
  out.computeVertexNormals();
  return out;
}

function buildGeometries(): ScrewGeometryCache {
  const r = SCREW_HEAD_R;
  const hit = new THREE.SphereGeometry(SCREW_HIT_R, 8, 6);
  hit.translate(0, 0, 0.06);

  const hintRing = new THREE.RingGeometry(r + 0.06, r + 0.16, 28);
  hintRing.translate(0, 0, SCREW_HEAD_TOP * 0.35);
  const targetRing = new THREE.RingGeometry(r + 0.09, r + 0.14, 24);
  targetRing.translate(0, 0, SCREW_HEAD_TOP * 0.35);
  const mystery = new THREE.CircleGeometry(r * 0.72, 18);
  mystery.translate(0, 0, SCREW_HEAD_TOP + 0.012);

  // Contact ring: a neutral AO seat around the head, in its own batch so the
  // per-instance screw colour does not tint it. It is symmetric (no key-light
  // offset) because the surface it sits on can face any direction now.
  const contact = new THREE.RingGeometry(r * 0.96, r * 1.38, 18);
  contact.translate(0, 0, 0.006);

  return { body: buildScrewBody(), contact, hit, hintRing, targetRing, mystery };
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

export function screwGeometries(): ScrewGeometryCache {
  if (!geoCache) geoCache = buildGeometries();
  return geoCache;
}

/** Per-colour material for *detached* screws (flight / tray / box). */
export function screwMaterial(color: ScrewColor | 'mystery'): THREE.MeshStandardMaterial {
  let m = materialCache.get(color);
  if (!m) {
    if (color === 'mystery') {
      m = new THREE.MeshStandardMaterial({
        color: MYSTERY_HEX,
        roughness: 0.55,
        metalness: 0.45,
        envMapIntensity: 0.8,
        vertexColors: true,
      });
    } else {
      m = new THREE.MeshStandardMaterial({
        color: COLOR_HEX[color],
        roughness: 0.32,
        metalness: 0.6,
        envMapIntensity: 1.0,
        vertexColors: true,
      });
    }
    materialCache.set(color, m);
  }
  return m;
}

/** Shared material for the instanced seated field; colour comes per instance. */
export function seatedScrewMaterial(): THREE.MeshStandardMaterial {
  seatedMaterialCached ??= new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.32,
    metalness: 0.58,
    envMapIntensity: 1.0,
    vertexColors: true,
  });
  return seatedMaterialCached;
}

/** X-ray material for blocked screws shown in drill targeting mode. */
export function ghostScrewMaterial(): THREE.MeshStandardMaterial {
  ghostMaterialCached ??= new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.3,
    envMapIntensity: 0.6,
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthTest: false,
  });
  return ghostMaterialCached;
}

/** Neutral dark ring under a seated screw head. */
export function screwContactMaterial(): THREE.MeshBasicMaterial {
  contactMaterialCached ??= new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return contactMaterialCached;
}

export function flashMaterial(): THREE.MeshStandardMaterial {
  if (!flashMaterialCached) {
    flashMaterialCached = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.3,
      vertexColors: true,
    });
  }
  return flashMaterialCached;
}

function sharedMaterials() {
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
    side: THREE.DoubleSide,
  });
  return { hitMaterial, hintMaterial, targetMaterial, mysteryMaterial };
}

export function hitProxyMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterials().hitMaterial;
}

export function hintRingMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterials().hintMaterial;
}

export function targetRingMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterials().targetMaterial;
}

export function mysteryDecalMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterials().mysteryMaterial;
}

/** The colour a seated screw is drawn with, after the per-shell depth tint. */
export function seatedScrewColor(color: ScrewColor, revealed: boolean, shell: number): THREE.Color {
  const c = new THREE.Color(revealed ? COLOR_HEX[color] : MYSTERY_HEX);
  const fog = shellFogAmount(shell, SCREW_DEPTH_FOG);
  if (fog > 0) c.lerp(new THREE.Color(DEPTH_TINT), fog);
  return c;
}

export interface ScrewVisualInit {
  id: number;
  panelId: number;
  color: ScrewColor;
  revealed: boolean;
  location: ScrewLocation;
  shell: number;
  position: Vec3;
  axis: Vec3;
}

export function createScrewVisual(init: ScrewVisualInit): ScrewVisual {
  const home = new THREE.Vector3(init.position.x, init.position.y, init.position.z);
  const axis = new THREE.Vector3(init.axis.x, init.axis.y, init.axis.z);
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1);
  axis.normalize();
  return {
    id: init.id,
    panelId: init.panelId,
    color: init.color,
    revealed: init.revealed,
    location: init.location,
    shell: init.shell,
    blocked: false,
    facing: false,
    ghost: false,
    home,
    axis,
    quat: quatFromAxis(axis),
    pos: home.clone(),
    worldQuat: new THREE.Quaternion(),
    spin: 0,
    scale: 1,
    flash: false,
    group: null,
    body: null,
    mystery: null,
    hit: null,
  };
}

/** Build the real meshes for a screw that has left the instanced field. */
export function buildLooseScrew(v: ScrewVisual): THREE.Group {
  const g = screwGeometries();
  const group = new THREE.Group();
  group.name = `screw-${v.id}`;
  const body = new THREE.Mesh(g.body, screwMaterial(v.revealed ? v.color : 'mystery'));
  group.add(body);
  const mystery = new THREE.Mesh(g.mystery, mysteryDecalMaterial());
  mystery.visible = !v.revealed;
  mystery.renderOrder = 2;
  group.add(mystery);
  v.group = group;
  v.body = body;
  v.mystery = mystery;
  group.position.copy(v.pos);
  group.quaternion.copy(v.worldQuat);
  group.scale.setScalar(v.scale);
  return group;
}

/** Show the real colour (after reveal) or the grey mystery look. */
export function applyScrewColor(v: ScrewVisual, color: ScrewColor, revealed: boolean): void {
  v.color = color;
  v.revealed = revealed;
  if (v.body) v.body.material = screwMaterial(revealed ? color : 'mystery');
  if (v.mystery) v.mystery.visible = !revealed;
}

export function disposeScrewVisual(v: ScrewVisual): void {
  v.group?.removeFromParent();
  v.group = null;
  v.body = null;
  v.mystery = null;
  v.hit?.removeFromParent();
  v.hit = null;
}

/** Free the shared caches (renderer.dispose). */
export function disposeScrewCaches(): void {
  if (geoCache) {
    for (const g of Object.values(geoCache)) g.dispose();
    geoCache = null;
  }
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
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
  seatedMaterialCached?.dispose();
  seatedMaterialCached = null;
  ghostMaterialCached?.dispose();
  ghostMaterialCached = null;
  contactMaterialCached?.dispose();
  contactMaterialCached = null;
}

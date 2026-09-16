import * as THREE from 'three';
import type { ScrewVisual } from './screwMesh';
import { ASSEMBLY_RADIUS } from './layout';

/**
 * The "there is more around the back" nudge (CONTRACT_V3 §6).
 *
 * Screws hide behind the object now, so a player who has cleared everything
 * facing them needs a reason to turn it — but a map of what is back there would
 * hand them the level. The compromise: every removable screw that is turned
 * away is binned by the direction it lies in ON SCREEN, and each occupied bin
 * gets one faint dash just outside the silhouette. You learn "there is
 * something over to the left", never what or how much exactly.
 *
 * It is deliberately quiet: it brightens when NOTHING in front of you is
 * tappable (the only moment the hint is actually needed) and dims to a
 * background murmur the rest of the time.
 */

/** Angular bins around the silhouette. 14 ≈ 26° apart: readable, never a dial. */
const BINS = 14;
/** Ring radius, just outside the assembly's bounding sphere. */
const RING_R = ASSEMBLY_RADIUS + 0.34;

const DASH_LEN = 0.44;
const DASH_W = 0.085;

const BASE_ALPHA = 0.26;
const STUCK_ALPHA = 0.56;
/**
 * At most this many dashes at once. A ring of fourteen is a compass rose — a
 * map of the level. Two or three is a glance in a direction, which is the whole
 * brief: a nudge, not a map.
 */
const MAX_MARKS = 3;

function dashGeometry(): THREE.BufferGeometry {
  const r = DASH_W / 2;
  const half = DASH_LEN / 2 - r;
  const shape = new THREE.Shape();
  shape.absarc(half, 0, r, -Math.PI / 2, Math.PI / 2, false);
  shape.absarc(-half, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
  return new THREE.ShapeGeometry(shape, 6);
}

export class RotateAffordance {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly counts: number[] = new Array(BINS).fill(0);
  /** Reused bin-index scratch: ranking must not allocate per frame. */
  private readonly order: number[] = Array.from({ length: BINS }, (_, i) => i);
  private readonly camera: THREE.Camera;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private readonly p = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly m = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private enabled = true;
  /** Smoothed per-bin strength so markers fade rather than blink. */
  private readonly level = new Float32Array(BINS);

  constructor(root: THREE.Object3D, camera: THREE.Camera) {
    this.camera = camera;
    this.material = new THREE.MeshBasicMaterial({
      color: 0xbcd4ff,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(dashGeometry(), this.material, BINS);
    this.mesh.name = 'rotate-affordance';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(this.mesh);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.mesh.count = 0;
      this.level.fill(0);
    }
  }

  clear(): void {
    this.mesh.count = 0;
    this.level.fill(0);
    this.counts.fill(0);
  }

  /**
   * @param away      removable screws whose axis points away from the camera
   * @param assemblyQ current assembly rotation (screw homes are assembly-space)
   * @param frontCount how many screws ARE reachable facing the player
   * @param boost     brighten it anyway (the player asked for a hint)
   */
  update(
    away: readonly ScrewVisual[],
    assemblyQ: THREE.Quaternion,
    frontCount: number,
    boost: boolean,
    dtMs: number,
    timeMs: number,
  ): void {
    if (!this.enabled) return;
    this.counts.fill(0);

    const m = this.camera.matrixWorld.elements;
    this.right.set(m[0], m[1], m[2]).normalize();
    this.up.set(m[4], m[5], m[6]).normalize();
    this.fwd.set(m[8], m[9], m[10]).normalize();

    for (const s of away) {
      // Where this screw lies on screen, as a direction from the object's
      // centre: mostly its position, nudged by the way it points so that a
      // screw on the exact back of the object still picks a side.
      this.p.copy(s.home).applyQuaternion(assemblyQ);
      this.a.copy(s.axis).applyQuaternion(assemblyQ);
      const x = this.p.dot(this.right) + 0.55 * ASSEMBLY_RADIUS * this.a.dot(this.right);
      const y = this.p.dot(this.up) + 0.55 * ASSEMBLY_RADIUS * this.a.dot(this.up);
      if (x * x + y * y < 1e-4) continue;
      let bin = Math.floor((Math.atan2(y, x) / (Math.PI * 2)) * BINS + BINS) % BINS;
      if (bin < 0) bin += BINS;
      this.counts[bin]++;
    }

    // Keep only the busiest few directions; everything else stays dark.
    for (let i = 0; i < BINS; i++) this.order[i] = i;
    this.order.sort((a, b) => this.counts[b] - this.counts[a]);
    for (let i = MAX_MARKS; i < BINS; i++) this.counts[this.order[i]] = 0;

    // Smooth: a bin appearing/vanishing as the object turns should fade, and
    // the whole set brightens when the player has nothing left to tap in front.
    const k = 1 - Math.exp(-dtMs / 140);
    const pulse = 0.82 + 0.18 * Math.sin(timeMs / 520);
    const gain = frontCount === 0 || boost ? STUCK_ALPHA : BASE_ALPHA;
    let used = 0;
    for (let i = 0; i < BINS; i++) {
      const n = this.counts[i];
      const target = n === 0 ? 0 : Math.min(1, 0.55 + 0.18 * (n - 1));
      this.level[i] += (target - this.level[i]) * k;
      const v = this.level[i];
      if (v < 0.02) continue;
      const theta = ((i + 0.5) / BINS) * Math.PI * 2;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      this.pos
        .set(0, 0, 0)
        .addScaledVector(this.right, c * RING_R)
        .addScaledVector(this.up, sn * RING_R)
        // Pull it toward the camera so it always clears the silhouette.
        .addScaledVector(this.fwd, ASSEMBLY_RADIUS * 0.75);
      // Dash is authored in local XY; turn it to the bin angle, then into the
      // camera's plane. The camera never moves, so this is the same plane every
      // frame — the object is what turns.
      this.q.setFromAxisAngle(this.zAxis, theta + Math.PI / 2).premultiply(this.camera.quaternion);
      this.scale.set(0.75 + 0.45 * v, 1, 1);
      this.m.compose(this.pos, this.q, this.scale);
      this.mesh.setMatrixAt(used, this.m);
      const alpha = gain * v * pulse;
      this.color.setRGB(alpha, alpha * 1.04, alpha * 1.25);
      this.mesh.setColorAt(used, this.color);
      used++;
    }
    this.mesh.count = used;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}

import * as THREE from 'three';
import type { ScrewVisual } from './screwMesh';
import {
  HIT_LAYER,
  buildLooseScrew,
  ghostScrewMaterial,
  hintRingMaterial,
  hitProxyMaterial,
  mysteryDecalMaterial,
  screwContactMaterial,
  screwGeometries,
  seatedScrewColor,
  seatedScrewMaterial,
  targetRingMaterial,
} from './screwMesh';
import { FACING_MIN_DOT } from './layout';

const FLASH = new THREE.Color(0xffffff);

/**
 * Batched renderer for the screws seated on the assembly.
 *
 * Everything in here lives in ASSEMBLY space and is parented to the rotating
 * group, so a drag moves the whole field (and its raycast proxies) for free.
 *
 * What is drawn (CONTRACT_V3 §6): a screw is solid and tappable only when it is
 * REMOVABLE (the core's `blocked` flag says its withdrawal path is clear) AND
 * FRONT-FACING (its rotated axis points toward the camera). That is v2's "do
 * not draw covered screws" generalised to a solid: a screw on the far side of
 * the object is exactly as unreachable as one under a plate used to be, and it
 * keeps the draw budget in the same place. In drill targeting mode the blocked
 * front-facing screws come back as x-ray ghosts, because drilling one is the
 * whole point of that mode.
 *
 * Bodies, "?" decals, contact rings, ghosts and target rings are five
 * InstancedMeshes regardless of screw count; per-instance matrices now carry
 * the screw's orientation as well as its position.
 */
export class ScrewField {
  private readonly root: THREE.Object3D;
  private readonly screws = new Map<number, ScrewVisual>();

  private bodies: THREE.InstancedMesh | null = null;
  private ghosts: THREE.InstancedMesh | null = null;
  private mystery: THREE.InstancedMesh | null = null;
  private rings: THREE.InstancedMesh | null = null;
  private contacts: THREE.InstancedMesh | null = null;

  /** id -> instance slot in `bodies` (seated screws only). */
  private slotOf = new Map<number, number>();
  private seated: ScrewVisual[] = [];
  /** Removable screws whose axis currently points away from the camera. */
  private away: ScrewVisual[] = [];
  /** Reused scratch lists: flush runs on every rotated frame. */
  private readonly ghostList: ScrewVisual[] = [];
  private readonly proxyList: ScrewVisual[] = [];
  private hitProxies: THREE.Mesh[] = [];
  private freeProxies: THREE.Mesh[] = [];
  private hintRings: THREE.Mesh[] = [];
  private hintIds: number[] = [];

  private targeting = false;
  private dirty = false;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qSpin = new THREE.Quaternion();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(root: THREE.Object3D) {
    this.root = root;
  }

  /** (Re)build the field for a level. */
  build(screws: Iterable<ScrewVisual>): void {
    this.clear();
    let n = 0;
    let hidden = 0;
    for (const s of screws) {
      this.screws.set(s.id, s);
      n++;
      if (!s.revealed) hidden++;
    }
    if (n === 0) return;
    const g = screwGeometries();

    this.contacts = new THREE.InstancedMesh(g.contact, screwContactMaterial(), n);
    this.contacts.name = 'screw-contacts';
    this.contacts.frustumCulled = false;
    this.contacts.count = 0;
    this.contacts.renderOrder = -1;
    this.contacts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.contacts);

    this.bodies = new THREE.InstancedMesh(g.body, seatedScrewMaterial(), n);
    this.bodies.name = 'screw-field';
    this.bodies.frustumCulled = false;
    this.bodies.count = 0;
    this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.bodies);

    this.ghosts = new THREE.InstancedMesh(g.body, ghostScrewMaterial(), n);
    this.ghosts.name = 'screw-ghosts';
    this.ghosts.frustumCulled = false;
    this.ghosts.count = 0;
    this.ghosts.renderOrder = 20;
    this.ghosts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.ghosts);

    this.rings = new THREE.InstancedMesh(g.targetRing, targetRingMaterial(), n);
    this.rings.name = 'screw-target-rings';
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.rings.renderOrder = 21;
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.rings);

    if (hidden > 0) {
      this.mystery = new THREE.InstancedMesh(g.mystery, mysteryDecalMaterial(), hidden);
      this.mystery.name = 'screw-mystery';
      this.mystery.frustumCulled = false;
      this.mystery.count = 0;
      this.mystery.renderOrder = 2;
      this.mystery.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(this.mystery);
    }
    this.dirty = true;
  }

  /** A screw joined/left the seated set, or its blocked/facing state changed. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Recompute which seated screws face the camera, given the camera position
   * expressed in ASSEMBLY space. Returns true if the drawn set changed.
   *
   * O(screws), no allocation: ~190 subtract + normalise + dot per rotated
   * frame, which is nothing next to the draw it decides.
   */
  updateFacing(cameraLocal: THREE.Vector3): boolean {
    let changed = false;
    for (const s of this.screws.values()) {
      if (s.location !== 'plate') {
        if (s.facing) {
          s.facing = false;
          changed = true;
        }
        continue;
      }
      const dot = this.v3.copy(cameraLocal).sub(s.home).normalize().dot(s.axis);
      const facing = dot >= FACING_MIN_DOT;
      if (facing !== s.facing) {
        s.facing = facing;
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** Rebuild the packed instance lists if anything changed. Cheap (O(screws)). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const bodies = this.bodies;
    if (!bodies) return;

    this.seated.length = 0;
    this.away.length = 0;
    this.slotOf.clear();
    const ghostList = this.ghostList;
    ghostList.length = 0;
    for (const s of this.screws.values()) {
      if (s.location !== 'plate' || s.group) continue;
      if (s.blocked) {
        // Only the layer the player is about to uncover: everything deeper
        // would turn the drill overlay into soup.
        if (this.targeting && s.facing && s.ghost) ghostList.push(s);
        continue;
      }
      if (s.facing) this.seated.push(s);
      else this.away.push(s);
    }

    let mi = 0;
    for (let i = 0; i < this.seated.length; i++) {
      const s = this.seated[i];
      this.slotOf.set(s.id, i);
      bodies.setMatrixAt(i, this.poseMatrix(s));
      this.contacts?.setMatrixAt(i, this.poseMatrix(s));
      bodies.setColorAt(i, this.instanceColor(s));
      if (!s.revealed && this.mystery) {
        this.mystery.setMatrixAt(mi++, this.poseMatrix(s));
      }
    }
    bodies.count = this.seated.length;
    bodies.instanceMatrix.needsUpdate = true;
    if (this.contacts) {
      this.contacts.count = this.seated.length;
      this.contacts.instanceMatrix.needsUpdate = true;
    }
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (this.mystery) {
      this.mystery.count = mi;
      this.mystery.instanceMatrix.needsUpdate = true;
    }

    if (this.ghosts) {
      for (let i = 0; i < ghostList.length; i++) {
        this.ghosts.setMatrixAt(i, this.poseMatrix(ghostList[i]));
        this.ghosts.setColorAt(i, this.instanceColor(ghostList[i]));
      }
      this.ghosts.count = ghostList.length;
      this.ghosts.instanceMatrix.needsUpdate = true;
      if (this.ghosts.instanceColor) this.ghosts.instanceColor.needsUpdate = true;
    }

    // Drill target rings sit on every screw the player may currently drill.
    if (this.rings) {
      let ri = 0;
      if (this.targeting) {
        for (const s of this.seated) this.rings.setMatrixAt(ri++, this.poseMatrix(s));
        for (const s of ghostList) this.rings.setMatrixAt(ri++, this.poseMatrix(s));
      }
      this.rings.count = ri;
      this.rings.instanceMatrix.needsUpdate = true;
    }

    let proxies = this.seated;
    if (this.targeting && ghostList.length > 0) {
      this.proxyList.length = 0;
      for (const s of this.seated) this.proxyList.push(s);
      for (const s of ghostList) this.proxyList.push(s);
      proxies = this.proxyList;
    }
    this.syncHitProxies(proxies);
  }

  /** Invisible raycast targets for the currently tappable screws. */
  hitTargets(): THREE.Object3D[] {
    this.flush();
    return this.hitProxies;
  }

  /** Ids the renderer considers tappable right now (removable ∩ front-facing). */
  tappableIds(): number[] {
    this.flush();
    return this.hitProxies.map((p) => p.userData.screwId as number);
  }

  /** How many screws are drawn solid right now (removable ∩ front-facing). */
  seatedCount(): number {
    this.flush();
    return this.seated.length;
  }

  /** Removable screws currently turned away from the camera (rotate affordance). */
  offscreenRemovable(): ScrewVisual[] {
    this.flush();
    return this.away;
  }

  /** Push a pooled screw's pos/spin/scale into its instance (no allocation). */
  setPose(s: ScrewVisual): void {
    if (s.group) {
      s.group.position.copy(s.pos);
      s.group.quaternion.copy(s.worldQuat);
      s.group.scale.setScalar(s.scale);
      return;
    }
    const bodies = this.bodies;
    const slot = this.slotOf.get(s.id);
    if (!bodies || slot === undefined) return;
    bodies.setMatrixAt(slot, this.poseMatrix(s));
    bodies.instanceMatrix.needsUpdate = true;
    if (this.contacts) {
      this.contacts.setMatrixAt(slot, this.poseMatrix(s));
      this.contacts.instanceMatrix.needsUpdate = true;
    }
    const proxy = this.hitProxies[slot];
    if (proxy && proxy.userData.screwId === s.id) proxy.position.copy(s.pos);
  }

  /** Refresh the instance colour (reveal, flash, depth tint). */
  setColor(s: ScrewVisual): void {
    const bodies = this.bodies;
    const slot = this.slotOf.get(s.id);
    if (!bodies || slot === undefined) return;
    bodies.setColorAt(slot, this.instanceColor(s));
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  }

  /**
   * Take a screw out of the batch and give it real meshes so a tween can drive
   * its transform. `worldRoot` receives the group: a screw in flight lives in
   * WORLD space, because the boxes and the tray are fixed there and the player
   * may keep spinning the assembly mid-flight. Idempotent.
   */
  detach(s: ScrewVisual, worldRoot: THREE.Object3D, assemblyMatrix: THREE.Matrix4): THREE.Group {
    if (s.group) return s.group;
    // Freeze the current pose into world space before the parent changes.
    s.pos.applyMatrix4(assemblyMatrix);
    s.worldQuat.setFromRotationMatrix(assemblyMatrix).multiply(this.spunQuat(s));
    const group = buildLooseScrew(s);
    worldRoot.add(group);
    this.dirty = true;
    this.flush();
    return group;
  }

  /** Register a screw created after `build`. */
  track(s: ScrewVisual): void {
    this.screws.set(s.id, s);
    this.dirty = true;
  }

  forget(s: ScrewVisual): void {
    this.screws.delete(s.id);
    this.hintIds = this.hintIds.filter((id) => id !== s.id);
    this.dirty = true;
  }

  setTargeting(on: boolean): void {
    if (this.targeting === on) return;
    this.targeting = on;
    this.dirty = true;
  }

  setHint(ids: number[]): void {
    this.hintIds = [...ids];
    for (let i = this.hintIds.length; i < this.hintRings.length; i++) this.hintRings[i].visible = false;
  }

  /** Ids currently hinted that are not drawn (so the affordance can point at them). */
  hintedIds(): number[] {
    return this.hintIds;
  }

  /** Called once per frame: pulse + position the (few) hint rings. */
  updateHint(timeMs: number): void {
    if (this.hintIds.length === 0) {
      for (const r of this.hintRings) if (r.visible) r.visible = false;
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin((timeMs / 1000) * 7);
    hintRingMaterial().opacity = 0.45 + 0.5 * pulse;
    const k = 1 + 0.12 * pulse;
    let used = 0;
    for (const id of this.hintIds) {
      const s = this.screws.get(id);
      if (!s || s.location !== 'plate' || !s.facing || s.blocked) continue;
      let ring = this.hintRings[used];
      if (!ring) {
        ring = new THREE.Mesh(screwGeometries().hintRing, hintRingMaterial());
        ring.renderOrder = 22;
        ring.frustumCulled = false;
        this.hintRings.push(ring);
        this.root.add(ring);
      }
      ring.visible = true;
      ring.position.copy(s.pos);
      ring.quaternion.copy(s.quat);
      ring.scale.setScalar(k * s.scale);
      used++;
    }
    for (let i = used; i < this.hintRings.length; i++) this.hintRings[i].visible = false;
  }

  clear(): void {
    for (const mesh of [this.bodies, this.ghosts, this.mystery, this.rings, this.contacts]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.bodies = this.ghosts = this.mystery = this.rings = this.contacts = null;
    for (const r of this.hintRings) r.removeFromParent();
    this.hintRings.length = 0;
    this.ghostList.length = 0;
    this.proxyList.length = 0;
    for (const p of [...this.hitProxies, ...this.freeProxies]) p.removeFromParent();
    this.hitProxies.length = 0;
    this.freeProxies.length = 0;
    this.screws.clear();
    this.slotOf.clear();
    this.seated.length = 0;
    this.away.length = 0;
    this.hintIds.length = 0;
    this.targeting = false;
    this.dirty = false;
  }

  dispose(): void {
    this.clear();
  }

  /* ------------------------------------------------------------------ */

  /** Screw orientation including its unscrewing spin, in assembly space. */
  private spunQuat(s: ScrewVisual): THREE.Quaternion {
    this.qSpin.setFromAxisAngle(s.axis, s.spin);
    return this.q.copy(this.qSpin).multiply(s.quat);
  }

  private poseMatrix(s: ScrewVisual): THREE.Matrix4 {
    this.s3.setScalar(s.scale);
    return this.m.compose(s.pos, this.spunQuat(s), this.s3);
  }

  private instanceColor(s: ScrewVisual): THREE.Color {
    if (s.flash) return FLASH;
    return this.color.copy(seatedScrewColor(s.color, s.revealed, s.shell));
  }

  private syncHitProxies(list: ScrewVisual[]): void {
    while (this.hitProxies.length > list.length) {
      const p = this.hitProxies.pop()!;
      p.removeFromParent();
      this.freeProxies.push(p);
    }
    while (this.hitProxies.length < list.length) {
      const p = this.freeProxies.pop() ?? this.makeProxy();
      this.root.add(p);
      this.hitProxies.push(p);
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const p = this.hitProxies[i];
      p.position.copy(s.pos);
      p.quaternion.copy(s.quat);
      p.userData.screwId = s.id;
    }
  }

  private makeProxy(): THREE.Mesh {
    const p = new THREE.Mesh(screwGeometries().hit, hitProxyMaterial());
    p.layers.set(HIT_LAYER);
    p.frustumCulled = false;
    return p;
  }
}

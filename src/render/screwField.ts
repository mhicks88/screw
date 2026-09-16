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

const FLASH = new THREE.Color(0xffffff);

/**
 * Batched renderer for the screws that are resting on plates.
 *
 * At the v2 scale a level holds up to 150 screws, but only the ~15-25 that no
 * plate covers may be drawn at all: with 0.02 units of air between a plate top
 * and the plate above it, a covered screw head would otherwise poke straight
 * through its own lid. Hiding them is therefore both the legibility fix and the
 * performance fix.
 *
 * Everything seated is drawn from a handful of InstancedMeshes (bodies, "?"
 * decals, drill target rings, x-ray ghosts) — four draw calls for the whole
 * board no matter how many screws exist. A screw that has to animate is
 * `detach`ed into an ordinary Group for the duration, and raycast proxies exist
 * only for the small set of screws that are actually tappable right now.
 */
export class ScrewField {
  private readonly root: THREE.Object3D;
  private readonly screws = new Map<number, ScrewVisual>();
  private maxLayer = 0;

  private bodies: THREE.InstancedMesh | null = null;
  private ghosts: THREE.InstancedMesh | null = null;
  private mystery: THREE.InstancedMesh | null = null;
  private rings: THREE.InstancedMesh | null = null;
  private contacts: THREE.InstancedMesh | null = null;

  /** id -> instance slot in `bodies` (seated screws only). */
  private slotOf = new Map<number, number>();
  private seated: ScrewVisual[] = [];
  private hitProxies: THREE.Mesh[] = [];
  private freeProxies: THREE.Mesh[] = [];
  private hintRings: THREE.Mesh[] = [];
  private hintIds: number[] = [];

  private targeting = false;
  private dirty = false;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor(root: THREE.Object3D) {
    this.root = root;
  }

  /** (Re)build the field for a level. `screws` may be mutated afterwards. */
  build(screws: Iterable<ScrewVisual>, maxLayer: number): void {
    this.clear();
    this.maxLayer = maxLayer;
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

  /** A screw joined/left the seated set, or its cover count changed. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Re-anchor the depth tint to a new top layer (as plates are peeled away) and
   * repaint the seated instances. Cheap: colours only, no matrix rewrite.
   */
  setMaxLayer(maxLayer: number): void {
    this.maxLayer = maxLayer;
    const bodies = this.bodies;
    if (!bodies) return;
    for (let i = 0; i < this.seated.length; i++) bodies.setColorAt(i, this.instanceColor(this.seated[i]));
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  }

  /** Rebuild the packed instance lists if anything changed. Cheap (O(screws)). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const bodies = this.bodies;
    if (!bodies) return;

    this.seated.length = 0;
    this.slotOf.clear();
    const ghostList: ScrewVisual[] = [];
    for (const s of this.screws.values()) {
      if (s.location !== 'plate' || s.group) continue;
      if (s.coverCount === 0) this.seated.push(s);
      else if (this.targeting && s.coverCount === 1) ghostList.push(s);
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
        for (const s of this.seated) this.rings.setMatrixAt(ri++, this.ringMatrix(s));
        for (const s of ghostList) this.rings.setMatrixAt(ri++, this.ringMatrix(s));
      }
      this.rings.count = ri;
      this.rings.instanceMatrix.needsUpdate = true;
    }

    this.syncHitProxies(this.targeting ? [...this.seated, ...ghostList] : this.seated);
  }

  /** Invisible raycast targets for the currently tappable screws. */
  hitTargets(): THREE.Object3D[] {
    this.flush();
    return this.hitProxies;
  }

  /** Push a pooled screw's pos/rotZ/scale into its instance (no allocation). */
  setPose(s: ScrewVisual): void {
    if (s.group) {
      s.group.position.copy(s.pos);
      s.group.rotation.z = s.rotZ;
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
   * its transform. Idempotent.
   */
  detach(s: ScrewVisual): THREE.Group {
    if (s.group) return s.group;
    const group = buildLooseScrew(s);
    this.root.add(group);
    this.dirty = true;
    this.flush();
    return group;
  }

  /** Put a still-on-plate screw back into the batch after an animation. */
  reattach(s: ScrewVisual): void {
    const g = s.group;
    if (!g) return;
    s.pos.copy(g.position);
    s.rotZ = g.rotation.z;
    s.scale = g.scale.x;
    g.removeFromParent();
    s.group = null;
    s.body = null;
    s.mystery = null;
    this.dirty = true;
  }

  /** Register a screw created after `build` (never happens today, but cheap). */
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
      if (!s || s.location !== 'plate' || s.coverCount !== 0) continue;
      let ring = this.hintRings[used];
      if (!ring) {
        ring = new THREE.Mesh(screwGeometries().hintRing, hintRingMaterial());
        ring.renderOrder = 22;
        this.hintRings.push(ring);
        this.root.add(ring);
      }
      ring.visible = true;
      ring.position.set(s.pos.x, s.pos.y, s.pos.z + 0.02);
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
    for (const p of [...this.hitProxies, ...this.freeProxies]) p.removeFromParent();
    this.hitProxies.length = 0;
    this.freeProxies.length = 0;
    this.screws.clear();
    this.slotOf.clear();
    this.seated.length = 0;
    this.hintIds.length = 0;
    this.targeting = false;
    this.dirty = false;
  }

  dispose(): void {
    this.clear();
  }

  /* ------------------------------------------------------------------ */

  private poseMatrix(s: ScrewVisual): THREE.Matrix4 {
    this.q.setFromAxisAngle(this.zAxis, s.rotZ);
    this.s3.setScalar(s.scale);
    return this.m.compose(s.pos, this.q, this.s3);
  }

  private ringMatrix(s: ScrewVisual): THREE.Matrix4 {
    this.v3.set(s.pos.x, s.pos.y, s.pos.z + 0.02);
    this.q.identity();
    this.s3.setScalar(1);
    return this.m.compose(this.v3, this.q, this.s3);
  }

  private instanceColor(s: ScrewVisual): THREE.Color {
    if (s.flash) return FLASH;
    return this.color.copy(seatedScrewColor(s.color, s.revealed, s.layer, this.maxLayer));
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
      p.userData.screwId = s.id;
      p.userData.layer = s.layer;
    }
  }

  private makeProxy(): THREE.Mesh {
    const p = new THREE.Mesh(screwGeometries().hit, hitProxyMaterial());
    p.layers.set(HIT_LAYER);
    p.frustumCulled = false;
    return p;
  }
}

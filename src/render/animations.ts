import * as THREE from 'three';
import type { ScrewColor } from '../core/types';
import { Easing, quadBezier } from './tween';
import type { World } from './world';
import { isAlive } from './world';
import type { ScrewVisual } from './screwMesh';
import { applyScrewColor, disposeScrewVisual, flashMaterial, screwMaterial } from './screwMesh';
import type { PanelVisual } from './panelMesh';
import { disposePanelVisual, makePanelMaterialUnique } from './panelMesh';
import type { BoxVisual } from './boxMesh';
import { disposeBoxVisual, setBoxColor } from './boxMesh';
import { rebuildTray } from './trayMesh';
import { BOX_HEIGHT, BOX_Y, OFFSCREEN_Y, boxPositionsX, trayPositionsX, trayWidth } from './layout';

/**
 * Move a screw out of the instanced field into world space.
 *
 * The moment a screw starts to fly it stops belonging to the assembly: the
 * boxes and the tray are fixed in world space and the player may well keep
 * spinning the object while the screw is in the air (CONTRACT_V3 §6). Its pose
 * is frozen through the assembly's current world matrix and it is re-parented
 * to the fixed root, so later rotation cannot drag it around.
 */
export function detachScrew(w: World, s: ScrewVisual): THREE.Group {
  w.rig.assemblyRoot.updateMatrixWorld(true);
  return w.field.detach(s, w.rig.fixedRoot, w.rig.assemblyRoot);
}

export interface FlightOptions {
  from: 'plate' | 'tray';
  delay?: number;
  /** Fired once the screw has unscrewed and lifted off its panel. */
  onLifted?: () => void;
}

/**
 * Unscrew ALONG THE SCREW'S OWN AXIS (v2 always lifted toward +z, which on a
 * solid would push half the screws into the panel they sit on), then arc to the
 * target and screw in. The target is re-read every frame because boxes slide.
 */
export async function flyScrew(
  w: World,
  s: ScrewVisual,
  getTarget: () => THREE.Vector3,
  opts: FlightOptions,
): Promise<void> {
  const gen = w.generation;
  const g = detachScrew(w, s);
  if (opts.delay) await w.tweens.delay(opts.delay);
  if (!isAlive(w, gen)) return;
  if (g.parent !== w.rig.fixedRoot) w.rig.fixedRoot.attach(g);
  // A seated screw is drawn at the level's zoom; the boxes and the tray are
  // fixed world furniture at zoom 1, so the screw eases back to its true size
  // on the way over (imperceptible at zoom 1, which is most levels).
  const startScale = opts.from === 'plate' ? w.rig.assemblyScale : 1;
  g.scale.setScalar(startScale);

  const start = g.position.clone();
  const q0 = g.quaternion.clone();
  // World-space withdrawal direction, sampled ONCE at launch.
  const outAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion).normalize();
  const spinQ = new THREE.Quaternion();
  const fromPlate = opts.from === 'plate';
  const lift = fromPlate ? 0.78 : 0.5;
  await w.tweens.run({
    duration: fromPlate ? 180 : 130,
    ease: Easing.inOutQuad,
    onUpdate: (e, raw) => {
      g.position.copy(start).addScaledVector(outAxis, lift * e);
      spinQ.setFromAxisAngle(outAxis, Math.PI * 4 * raw);
      g.quaternion.copy(spinQ).multiply(q0);
    },
  });
  if (!isAlive(w, gen)) return;
  opts.onLifted?.();

  // From here the screw is a world-space object flying to a world-space slot;
  // it turns to point at the camera (+z) so the head faces the player as it
  // drops into the hole.
  const p0 = g.position.clone();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const qAir = new THREE.Quaternion();
  const qFlat = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const q1 = g.quaternion.clone();
  const dirSign = Math.sign(getTarget().y - p0.y) || 1;
  await w.tweens.run({
    duration: 340,
    ease: Easing.inOutQuad,
    onUpdate: (e) => {
      p2.copy(getTarget());
      p2.z += 0.55;
      p1.lerpVectors(p0, p2, 0.5);
      p1.z = Math.max(p0.z, p2.z) + 2.3;
      quadBezier(p0, p1, p2, e, g.position);
      const k = startScale + (1 - startScale) * Math.min(1, e * 1.25);
      g.scale.setScalar(k);
      qFlat.setFromAxisAngle(xAxis, Math.sin(e * Math.PI) * 0.3 * dirSign);
      qAir.slerpQuaternions(q1, qFlat, Math.min(1, e * 1.4));
      g.quaternion.copy(qAir);
    },
  });
  if (!isAlive(w, gen)) return;

  const s0 = g.position.clone();
  const q2 = g.quaternion.clone();
  const spin2 = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  await w.tweens.run({
    duration: 160,
    ease: Easing.outQuad,
    onUpdate: (e, raw) => {
      g.position.lerpVectors(s0, getTarget(), e);
      spin2.setFromAxisAngle(zAxis, -Math.PI * 3 * raw);
      g.quaternion.copy(spin2).multiply(q2);
      const sq = 1 + 0.1 * Math.sin(raw * Math.PI);
      g.scale.set(sq, sq, 1 / sq);
    },
  });
  if (!isAlive(w, gen)) return;
  g.position.copy(getTarget());
  g.quaternion.identity();
  g.scale.setScalar(1);
  s.pos.copy(g.position);
  s.worldQuat.copy(g.quaternion);
}

/**
 * The panel unbolts, pushes away from the body of the assembly and tumbles out
 * of the bottom of the screen while fading.
 *
 * It is re-parented into world space first (keeping its current world pose), so
 * a panel that comes off while the player is mid-drag falls straight down the
 * screen instead of being whipped around by the rotation it just left.
 *
 * `delay` staggers a batch of panels that free together so the end of a level
 * reads as a collapse rather than as a queue. Nothing waits on this animation
 * (see events.ts), so the delay costs the player nothing.
 */
export async function dropPanel(w: World, pv: PanelVisual, delay = 0): Promise<void> {
  const gen = w.generation;
  const m = pv.mesh;
  if (delay > 0) {
    await w.tweens.delay(delay);
    if (!isAlive(w, gen)) return;
  }
  w.rig.assemblyRoot.updateMatrixWorld(true);
  w.rig.fixedRoot.attach(m);
  const mat = makePanelMaterialUnique(pv);
  mat.transparent = true;
  mat.needsUpdate = true;

  // "Away from the assembly", expressed in world space at the moment it frees.
  const push = pv.outward.clone().applyQuaternion(w.rig.assemblyRoot.quaternion).normalize();
  if (push.z < 0.12) push.z += 0.45; // always come toward the camera a little
  push.normalize();

  const p0 = m.position.clone();
  const q0 = m.quaternion.clone();
  // `attach` preserved the level's zoom in the mesh's own scale; every scale
  // tween below is relative to it.
  const baseScale = m.scale.x;
  const tumbleAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  const tumble = new THREE.Quaternion();
  m.renderOrder = 5;

  // Release pop: the panel unsticks from the body.
  await w.tweens.run({
    duration: 120,
    ease: Easing.outQuad,
    onUpdate: (e) => {
      m.position.copy(p0).addScaledVector(push, 0.3 * e);
      m.scale.setScalar(baseScale * (1 + 0.03 * e));
    },
  });
  if (!isAlive(w, gen)) return;

  const p1 = m.position.clone();
  await w.tweens.run({
    duration: 540,
    ease: Easing.inQuad,
    onUpdate: (e, raw) => {
      m.position.copy(p1).addScaledVector(push, 0.85 * e);
      m.position.y = p1.y + push.y * 0.85 * e - 11 * e;
      tumble.setFromAxisAngle(tumbleAxis, 1.5 * raw);
      m.quaternion.copy(tumble).multiply(q0);
      mat.opacity = 1 - Math.max(0, raw - 0.25) / 0.75;
    },
  });
  if (!isAlive(w, gen)) return;
  disposePanelVisual(pv);
  w.panels.delete(pv.id);
  w.invalidate();
}

/** Side-to-side shake across the screw's own face + white flash (blocked tap). */
export async function shakeScrew(w: World, s: ScrewVisual): Promise<void> {
  const gen = w.generation;
  const home = s.pos.clone();
  // Shake across the face the screw sits on, not along some global axis.
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(s.quat).normalize();
  const flash = flashMaterial();
  s.flash = true;
  w.field.setColor(s);
  if (s.body) s.body.material = flash;
  await w.tweens.run({
    duration: 260,
    ease: Easing.linear,
    onUpdate: (e) => {
      s.pos.copy(home).addScaledVector(side, Math.sin(e * Math.PI * 5) * 0.11 * (1 - e));
      w.field.setPose(s);
      if (e > 0.35 && s.flash) {
        s.flash = false;
        w.field.setColor(s);
        if (s.body && s.body.material === flash) s.body.material = screwMaterial(s.revealed ? s.color : 'mystery');
      }
    },
  });
  s.flash = false;
  if (!isAlive(w, gen)) return;
  s.pos.copy(home);
  w.field.setPose(s);
  w.field.setColor(s);
  applyScrewColor(s, s.color, s.revealed);
}

/** Quick scale bump (unblocked / revealed feedback). */
export function popScrew(w: World, s: ScrewVisual, amount = 0.22, duration = 260, delay = 0): Promise<void> {
  return w.tweens.run({
    duration,
    delay,
    ease: Easing.linear,
    onUpdate: (e) => {
      s.scale = 1 + amount * Math.sin(e * Math.PI);
      w.field.setPose(s);
    },
    onComplete: () => {
      s.scale = 1;
      w.field.setPose(s);
    },
  });
}

/**
 * A screw that has just been uncovered rises a little ALONG ITS OWN AXIS plus
 * the scale bump, so the cue reads the same whether the face it sits on points
 * at the camera or off to the side.
 */
export function riseScrew(w: World, s: ScrewVisual, delay = 0): Promise<void> {
  const home = s.home.clone();
  return w.tweens.run({
    duration: 300,
    delay,
    ease: Easing.linear,
    onUpdate: (e) => {
      const k = Math.sin(e * Math.PI);
      s.scale = 1 + 0.26 * k;
      s.pos.copy(home).addScaledVector(s.axis, 0.11 * k);
      w.field.setPose(s);
    },
    onComplete: () => {
      s.scale = 1;
      s.pos.copy(home);
      w.field.setPose(s);
    },
  });
}

/** Swap grey mystery look to the real colour with a flash + pop. */
export async function revealScrew(w: World, s: ScrewVisual, color: ScrewColor): Promise<void> {
  const gen = w.generation;
  applyScrewColor(s, color, true);
  const flash = flashMaterial();
  s.flash = true;
  w.field.setColor(s);
  if (s.body) s.body.material = flash;
  const pop = popScrew(w, s, 0.35, 300);
  await w.tweens.delay(110);
  if (!isAlive(w, gen)) return;
  s.flash = false;
  w.field.setColor(s);
  w.field.markDirty();
  if (s.body && s.body.material === flash) s.body.material = screwMaterial(s.color);
  await pop;
}

/** New box slides in from above the screen. */
export async function spawnBox(w: World, bv: BoxVisual, targetX: number): Promise<void> {
  const gen = w.generation;
  const g = bv.group;
  g.visible = true;
  g.position.set(targetX, OFFSCREEN_Y, 0);
  await w.tweens.run({
    duration: 330,
    ease: Easing.outBack,
    onUpdate: (e) => {
      g.position.y = OFFSCREEN_Y + (BOX_Y - OFFSCREEN_Y) * e;
      g.position.x = targetX;
    },
  });
  if (!isAlive(w, gen)) return;
  g.position.set(targetX, BOX_Y, 0);
}

/**
 * Bounce, drop the lid, slide off the top of the screen, dispose box + its
 * screws. `onVacated` fires the moment the box starts leaving, so the next box
 * can slide into the same position while this one is still on its way out.
 */
export async function completeBox(w: World, bv: BoxVisual, onVacated?: () => void): Promise<void> {
  const gen = w.generation;
  const g = bv.group;
  const screws: ScrewVisual[] = [];
  for (const id of bv.screws) {
    const sv = w.screws.get(id);
    if (sv?.group) {
      screws.push(sv);
      g.attach(sv.group);
    }
  }
  bv.lid.visible = true;
  // Bounce and the lid coming down run together rather than back to back.
  await Promise.all([
    w.tweens.run({
      duration: 260,
      ease: Easing.linear,
      onUpdate: (e) => {
        const k = 1 + 0.13 * Math.sin(e * Math.PI);
        g.scale.set(k, k, k);
      },
    }),
    w.tweens.run({
      duration: 230,
      ease: Easing.inQuad,
      onUpdate: (e) => {
        bv.lid.position.z = BOX_HEIGHT + 1.4 * (1 - e);
      },
    }),
  ]);
  if (!isAlive(w, gen)) return;
  g.scale.setScalar(1);
  onVacated?.();
  const y0 = g.position.y;
  await w.tweens.run({
    duration: 280,
    ease: Easing.inBack,
    onUpdate: (e) => {
      g.position.y = y0 + (OFFSCREEN_Y + 1 - y0) * e;
    },
  });
  if (!isAlive(w, gen)) return;
  for (const sv of screws) {
    disposeScrewVisual(sv);
    w.field.forget(sv);
    w.screws.delete(sv.id);
  }
  disposeBoxVisual(bv);
  w.boxes.delete(bv.id);
}

/** Move every box to its slot x for the current position count. */
export function layoutBoxes(w: World, animate: boolean): Promise<void> {
  const xs = boxPositionsX(w.boxPositionCount);
  const runs: Promise<void>[] = [];
  for (const bv of w.boxes.values()) {
    const x = xs[Math.min(bv.position, xs.length - 1)] ?? 0;
    const g = bv.group;
    if (!animate || !g.visible) {
      g.position.x = x;
      continue;
    }
    const x0 = g.position.x;
    if (Math.abs(x0 - x) < 1e-4) continue;
    runs.push(
      w.tweens.run({
        duration: 320,
        ease: Easing.outCubic,
        onUpdate: (e) => {
          g.position.x = x0 + (x - x0) * e;
        },
      }),
    );
  }
  return Promise.all(runs).then(() => undefined);
}

export async function recolorBox(w: World, bv: BoxVisual, color: ScrewColor): Promise<void> {
  const gen = w.generation;
  const g = bv.group;
  let swapped = false;
  await w.tweens.run({
    duration: 320,
    ease: Easing.linear,
    onUpdate: (e) => {
      const k = 1 + 0.12 * Math.sin(e * Math.PI);
      g.scale.set(k, k, k);
      if (e > 0.5 && !swapped) {
        swapped = true;
        setBoxColor(bv, color);
      }
    },
  });
  if (!swapped) setBoxColor(bv, color);
  if (!isAlive(w, gen)) return;
  g.scale.setScalar(1);
}

/** Grow the tray bar to `count` slots and shift parked screws to their new x. */
export async function growTray(w: World, count: number): Promise<void> {
  const gen = w.generation;
  const tray = w.tray;
  if (!tray) return;
  const oldCount = tray.slotCount;
  if (count === oldCount) return;
  const ratio = trayWidth(oldCount) / trayWidth(count);
  rebuildTray(tray, count);
  const xs = trayPositionsX(count);
  const runs: Promise<void>[] = [];
  runs.push(
    w.tweens.run({
      duration: 340,
      ease: Easing.outBack,
      onUpdate: (e) => {
        tray.bar.scale.x = ratio + (1 - ratio) * e;
        tray.floor.scale.x = tray.bar.scale.x;
      },
    }),
  );
  w.traySlots.forEach((id, slot) => {
    if (id === null) return;
    const sv = w.screws.get(id);
    if (!sv || sv.location !== 'tray' || !sv.group) return;
    const g = sv.group;
    const x0 = g.position.x;
    const x1 = xs[slot] ?? x0;
    runs.push(
      w.tweens.run({
        duration: 340,
        ease: Easing.outCubic,
        onUpdate: (e) => {
          g.position.x = x0 + (x1 - x0) * e;
        },
      }),
    );
  });
  await Promise.all(runs);
  if (!isAlive(w, gen)) return;
  tray.bar.scale.x = 1;
  tray.floor.scale.x = 1;
}

/** Small "nope" wobble of the tray (lose). */
export function shakeTray(w: World): Promise<void> {
  const tray = w.tray;
  if (!tray) return Promise.resolve();
  const g = tray.group;
  const x0 = g.position.x;
  return w.tweens.run({
    duration: 320,
    ease: Easing.linear,
    onUpdate: (e) => {
      g.position.x = x0 + Math.sin(e * Math.PI * 5) * 0.12 * (1 - e);
    },
    onComplete: () => {
      g.position.x = x0;
    },
  });
}

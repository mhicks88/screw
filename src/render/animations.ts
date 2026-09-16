import * as THREE from 'three';
import type { ScrewColor } from '../core/types';
import { Easing, quadBezier } from './tween';
import type { World } from './world';
import { isAlive } from './world';
import type { ScrewVisual } from './screwMesh';
import { applyScrewColor, disposeScrewVisual, flashMaterial, screwMaterial } from './screwMesh';
import type { PlateVisual } from './plateMesh';
import { disposePlateVisual } from './plateMesh';
import type { BoxVisual } from './boxMesh';
import { disposeBoxVisual, setBoxColor } from './boxMesh';
import { rebuildTray } from './trayMesh';
import { BOX_HEIGHT, BOX_Y, OFFSCREEN_Y, boxPositionsX, trayPositionsX, trayWidth } from './layout';

export interface FlightOptions {
  from: 'plate' | 'tray';
  delay?: number;
  /** Fired once the screw has unscrewed and lifted off its plate. */
  onLifted?: () => void;
}

/** Unscrew (spin + lift), arc to the target, screw in. Target is re-read every frame. */
export async function flyScrew(
  w: World,
  s: ScrewVisual,
  getTarget: () => THREE.Vector3,
  opts: FlightOptions,
): Promise<void> {
  const gen = w.generation;
  const g = s.group;
  if (opts.delay) await w.tweens.delay(opts.delay);
  if (!isAlive(w, gen)) return;
  if (g.parent !== w.rig.boardRoot) w.rig.boardRoot.attach(g);
  g.scale.setScalar(1);

  const start = g.position.clone();
  const rot0 = g.rotation.z;
  const fromPlate = opts.from === 'plate';
  const lift = fromPlate ? 0.75 : 0.5;
  await w.tweens.run({
    duration: fromPlate ? 190 : 140,
    ease: Easing.inOutQuad,
    onUpdate: (e, raw) => {
      g.position.z = start.z + lift * e;
      g.rotation.z = rot0 + Math.PI * 4 * raw;
    },
  });
  if (!isAlive(w, gen)) return;
  opts.onLifted?.();

  const p0 = g.position.clone();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const dirSign = Math.sign(getTarget().y - p0.y) || 1;
  await w.tweens.run({
    duration: 360,
    ease: Easing.inOutQuad,
    onUpdate: (e) => {
      p2.copy(getTarget());
      p2.z += 0.55;
      p1.lerpVectors(p0, p2, 0.5);
      p1.z = Math.max(p0.z, p2.z) + 2.3;
      quadBezier(p0, p1, p2, e, g.position);
      g.rotation.z += 0.1;
      g.rotation.x = Math.sin(e * Math.PI) * 0.3 * dirSign;
    },
  });
  if (!isAlive(w, gen)) return;

  const s0 = g.position.clone();
  const rot1 = g.rotation.z;
  await w.tweens.run({
    duration: 170,
    ease: Easing.outQuad,
    onUpdate: (e, raw) => {
      g.position.lerpVectors(s0, getTarget(), e);
      g.rotation.z = rot1 - Math.PI * 3 * raw;
      g.rotation.x = 0;
      const sq = 1 + 0.1 * Math.sin(raw * Math.PI);
      g.scale.set(sq, sq, 1 / sq);
    },
  });
  if (!isAlive(w, gen)) return;
  g.position.copy(getTarget());
  g.rotation.set(0, 0, 0);
  g.scale.setScalar(1);
}

/** Plate tilts, falls out of the bottom of the screen, fades, and is disposed. */
export async function dropPlate(w: World, pv: PlateVisual): Promise<void> {
  const gen = w.generation;
  const m = pv.mesh;
  const mat = m.material;
  mat.transparent = true;
  mat.needsUpdate = true;
  const y0 = m.position.y;
  const z0 = m.position.z;
  const rx0 = m.rotation.x;
  const rz0 = m.rotation.z;
  const spin = (Math.random() - 0.5) * 0.6;
  await w.tweens.run({
    duration: 640,
    ease: Easing.inQuad,
    onUpdate: (e, raw) => {
      m.position.y = y0 - 10 * e;
      m.position.z = z0 - 1.5 * e;
      m.rotation.x = rx0 - 0.9 * raw;
      m.rotation.z = rz0 + spin * raw;
      mat.opacity = 1 - Math.max(0, raw - 0.3) / 0.7;
      if (raw > 0.45) m.castShadow = false;
    },
  });
  if (!isAlive(w, gen)) return;
  disposePlateVisual(pv);
  w.plates.delete(pv.id);
}

/** Side-to-side shake + white flash (blocked tap). */
export async function shakeScrew(w: World, s: ScrewVisual): Promise<void> {
  const gen = w.generation;
  const g = s.group;
  const x0 = g.position.x;
  const flash = flashMaterial();
  s.body.material = flash;
  await w.tweens.run({
    duration: 260,
    ease: Easing.linear,
    onUpdate: (e) => {
      g.position.x = x0 + Math.sin(e * Math.PI * 5) * 0.11 * (1 - e);
      if (e > 0.35 && s.body.material === flash) s.body.material = screwMaterial(s.revealed ? s.color : 'mystery');
    },
  });
  if (!isAlive(w, gen)) return;
  g.position.x = x0;
  applyScrewColor(s, s.color, s.revealed);
}

/** Quick scale bump (unblocked / revealed feedback). */
export function popScrew(w: World, s: ScrewVisual, amount = 0.22, duration = 260, delay = 0): Promise<void> {
  const g = s.group;
  return w.tweens.run({
    duration,
    delay,
    ease: Easing.linear,
    onUpdate: (e) => {
      const k = 1 + amount * Math.sin(e * Math.PI);
      g.scale.setScalar(k);
    },
    onComplete: () => g.scale.setScalar(1),
  });
}

/** Swap grey mystery look to the real colour with a flash + pop. */
export async function revealScrew(w: World, s: ScrewVisual, color: ScrewColor): Promise<void> {
  const gen = w.generation;
  applyScrewColor(s, color, true);
  const flash = flashMaterial();
  s.body.material = flash;
  const pop = popScrew(w, s, 0.35, 300);
  await w.tweens.delay(110);
  if (!isAlive(w, gen)) return;
  if (s.body.material === flash) s.body.material = screwMaterial(s.color);
  await pop;
}

/** New box slides in from above the screen. */
export async function spawnBox(w: World, bv: BoxVisual, targetX: number): Promise<void> {
  const gen = w.generation;
  const g = bv.group;
  g.visible = true;
  g.position.set(targetX, OFFSCREEN_Y, 0);
  await w.tweens.run({
    duration: 420,
    ease: Easing.outBack,
    onUpdate: (e) => {
      g.position.y = OFFSCREEN_Y + (BOX_Y - OFFSCREEN_Y) * e;
      g.position.x = targetX;
    },
  });
  if (!isAlive(w, gen)) return;
  g.position.set(targetX, BOX_Y, 0);
}

/** Bounce, drop the lid, slide off the top of the screen, dispose box + its screws. */
export async function completeBox(w: World, bv: BoxVisual): Promise<void> {
  const gen = w.generation;
  const g = bv.group;
  const screws: ScrewVisual[] = [];
  for (const id of bv.screws) {
    const sv = w.screws.get(id);
    if (sv) {
      screws.push(sv);
      g.attach(sv.group);
    }
  }
  await w.tweens.run({
    duration: 230,
    ease: Easing.linear,
    onUpdate: (e) => {
      const k = 1 + 0.13 * Math.sin(e * Math.PI);
      g.scale.set(k, k, k);
    },
  });
  if (!isAlive(w, gen)) return;
  g.scale.setScalar(1);
  bv.lid.visible = true;
  await w.tweens.run({
    duration: 200,
    ease: Easing.inQuad,
    onUpdate: (e) => {
      bv.lid.position.z = BOX_HEIGHT + 1.4 * (1 - e);
    },
  });
  if (!isAlive(w, gen)) return;
  await w.tweens.run({
    duration: 130,
    ease: Easing.linear,
    onUpdate: (e) => {
      const k = 1 - 0.08 * Math.sin(e * Math.PI);
      g.scale.set(1 / Math.sqrt(k), 1 / Math.sqrt(k), k);
    },
  });
  if (!isAlive(w, gen)) return;
  g.scale.setScalar(1);
  const y0 = g.position.y;
  await w.tweens.run({
    duration: 340,
    ease: Easing.inBack,
    onUpdate: (e) => {
      g.position.y = y0 + (OFFSCREEN_Y + 1 - y0) * e;
    },
  });
  if (!isAlive(w, gen)) return;
  for (const sv of screws) {
    disposeScrewVisual(sv);
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
    if (!sv || sv.location !== 'tray') return;
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

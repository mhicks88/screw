import type { GameEvent } from '../core/types';
import { BOX_Y, OFFSCREEN_Y, boxPositionsX } from './layout';
import type { World } from './world';
import { boxSlotWorld, trayTargetWorld } from './world';
import { setScrewHittable } from './screwMesh';
import { createBoxVisual } from './boxMesh';
import {
  completeBox,
  dropPlate,
  flyScrew,
  growTray,
  layoutBoxes,
  popScrew,
  recolorBox,
  revealScrew,
  shakeScrew,
  shakeTray,
  spawnBox,
} from './animations';
import * as THREE from 'three';

/**
 * Tracks in-flight animations per resource key ("screw:3", "box:2", "pos:1",
 * "plate:4", "tray") so events only wait for the animations they depend on.
 * This lets consecutive taps overlap while still keeping causal order.
 */
class Scheduler {
  private readonly pending = new Map<string, Set<Promise<void>>>();

  wait(keys: string[]): Promise<void> {
    const ps: Promise<void>[] = [];
    for (const k of keys) {
      const set = this.pending.get(k);
      if (set) ps.push(...set);
    }
    return ps.length ? Promise.all(ps).then(() => undefined) : Promise.resolve();
  }

  register(keys: string[], p: Promise<void>): void {
    const safe = p.then(
      () => undefined,
      () => undefined,
    );
    for (const k of keys) {
      let set = this.pending.get(k);
      if (!set) {
        set = new Set();
        this.pending.set(k, set);
      }
      const s = set;
      s.add(safe);
      void safe.then(() => {
        s.delete(safe);
        if (s.size === 0 && this.pending.get(k) === s) this.pending.delete(k);
      });
    }
  }

  clear(): void {
    this.pending.clear();
  }
}

const FLIGHT_STAGGER_MS = 70;

export class EventPlayer {
  private readonly sched = new Scheduler();
  private readonly w: World;

  constructor(world: World) {
    this.w = world;
  }

  reset(): void {
    this.sched.clear();
  }

  /** Dispatch all events synchronously (logical state first), return when their animations end. */
  play(events: GameEvent[]): Promise<void> {
    const w = this.w;
    const gen = w.generation;
    const created: Promise<void>[] = [];
    let flightIndex = 0;
    let lastPlateDrop: Promise<void> | null = null;

    const go = (
      waitKeys: string[],
      registerKeys: string[],
      fn: () => Promise<void>,
      extra?: Promise<void> | null,
    ): Promise<void> => {
      const deps: Promise<void>[] = [this.sched.wait(waitKeys)];
      if (extra) deps.push(extra);
      const p = Promise.all(deps).then(() => (w.generation === gen ? fn() : undefined));
      this.sched.register(registerKeys, p);
      created.push(p);
      return p;
    };

    for (const ev of events) {
      switch (ev.type) {
        case 'screwToBox': {
          const s = w.screws.get(ev.screwId);
          const b = w.boxes.get(ev.boxId);
          if (!s || !b) break;
          if (ev.from === 'tray') {
            const idx = w.traySlots.indexOf(s.id);
            if (idx >= 0) w.traySlots[idx] = null;
          }
          const from = s.location === 'tray' ? 'tray' : ev.from;
          s.location = 'box';
          setScrewHittable(s, false);
          if (!b.screws.includes(s.id)) b.screws.push(s.id);
          const delay = flightIndex++ * FLIGHT_STAGGER_MS;
          let liftResolve: () => void = () => undefined;
          const lifted = new Promise<void>((r) => (liftResolve = r));
          if (from === 'plate') this.sched.register([`plate:${s.plateId}`], lifted);
          const slot = ev.boxSlot;
          go(
            [`screw:${s.id}`, `box:${b.id}`, 'tray'],
            [`screw:${s.id}`, `boxflights:${b.id}`],
            () => flyScrew(w, s, () => boxSlotWorld(b, slot), { from, delay, onLifted: liftResolve }),
          ).finally(liftResolve);
          break;
        }
        case 'screwToTray': {
          const s = w.screws.get(ev.screwId);
          if (!s) break;
          s.location = 'tray';
          setScrewHittable(s, false);
          while (w.traySlots.length <= ev.traySlot) w.traySlots.push(null);
          w.traySlots[ev.traySlot] = s.id;
          const delay = flightIndex++ * FLIGHT_STAGGER_MS;
          let liftResolve: () => void = () => undefined;
          const lifted = new Promise<void>((r) => (liftResolve = r));
          this.sched.register([`plate:${s.plateId}`], lifted);
          const slot = ev.traySlot;
          go(
            [`screw:${s.id}`, 'tray'],
            [`screw:${s.id}`],
            () => flyScrew(w, s, () => trayTargetWorld(w, slot), { from: 'plate', delay, onLifted: liftResolve }),
          ).finally(liftResolve);
          break;
        }
        case 'boxComplete': {
          const b = w.boxes.get(ev.boxId);
          if (!b) break;
          const posKey = `pos:${ev.position}`;
          go([`box:${b.id}`, `boxflights:${b.id}`, posKey], [`box:${b.id}`, posKey], () => completeBox(w, b));
          break;
        }
        case 'boxSpawn': {
          const state = ev.box;
          if (w.boxes.has(state.id)) break;
          const needed = state.position + 1;
          const grow = needed > w.boxPositionCount;
          if (grow) w.boxPositionCount = needed;
          const xs = boxPositionsX(w.boxPositionCount);
          const x = xs[Math.min(state.position, xs.length - 1)] ?? 0;
          const bv = createBoxVisual(state, x);
          bv.group.visible = false;
          bv.group.position.set(x, OFFSCREEN_Y, 0);
          w.rig.boardRoot.add(bv.group);
          w.boxes.set(bv.id, bv);
          const posKey = `pos:${state.position}`;
          go([posKey], [`box:${bv.id}`, posKey], async () => {
            if (grow) await layoutBoxes(w, true);
            await spawnBox(w, bv, boxPositionsX(w.boxPositionCount)[state.position] ?? x);
          });
          break;
        }
        case 'plateDrop': {
          const pv = w.plates.get(ev.plateId);
          if (!pv || pv.dropped) break;
          pv.dropped = true;
          for (const s of w.screws.values()) {
            if (s.plateId === pv.id && s.location === 'plate') setScrewHittable(s, false);
          }
          lastPlateDrop = go([`plate:${pv.id}`], [`plate:${pv.id}`], () => dropPlate(w, pv));
          break;
        }
        case 'screwsUnblocked': {
          const ids = ev.screwIds;
          go([], [], async () => {
            const runs: Promise<void>[] = [];
            ids.forEach((id, i) => {
              const s = w.screws.get(id);
              if (s && s.location === 'plate') runs.push(popScrew(w, s, 0.2, 260, i * 30));
            });
            await Promise.all(runs);
          }, lastPlateDrop);
          break;
        }
        case 'screwRevealed': {
          const s = w.screws.get(ev.screwId);
          if (!s) break;
          s.color = ev.color;
          s.revealed = true;
          const color = ev.color;
          go([`screw:${s.id}`], [], () => revealScrew(w, s, color), lastPlateDrop);
          break;
        }
        case 'traySlotAdded': {
          while (w.traySlots.length <= ev.slotIndex) w.traySlots.push(null);
          const count = w.traySlots.length;
          go(['tray'], ['tray'], () => growTray(w, count));
          break;
        }
        case 'boxRecolored': {
          const b = w.boxes.get(ev.boxId);
          if (!b) break;
          b.color = ev.color;
          const color = ev.color;
          go([`box:${b.id}`], [`box:${b.id}`], () => recolorBox(w, b, color));
          break;
        }
        case 'blockedTap': {
          const s = w.screws.get(ev.screwId);
          if (!s) break;
          go([`screw:${s.id}`], [`screw:${s.id}`], () => shakeScrew(w, s));
          break;
        }
        case 'win': {
          const all = Promise.all([...created]).then(() => undefined);
          go([], [], async () => {
            await w.effects.confetti(new THREE.Vector3(0, BOX_Y - 1.5, 1.5));
          }, all);
          break;
        }
        case 'lose': {
          go(['tray'], ['tray'], () => shakeTray(w));
          break;
        }
        default:
          break;
      }
    }

    return Promise.all(created).then(() => undefined);
  }
}

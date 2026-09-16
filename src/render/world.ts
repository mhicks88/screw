import * as THREE from 'three';
import type { SceneRig } from './scene';
import type { TweenManager } from './tween';
import type { Effects } from './effects';
import type { ScrewVisual } from './screwMesh';
import type { ScrewField } from './screwField';
import type { PlateVisual } from './plateMesh';
import type { BoxVisual } from './boxMesh';
import { boxSlotLocal } from './boxMesh';
import type { TrayVisual } from './trayMesh';
import { traySlotWorld } from './trayMesh';

/** Mutable visual state of the current level, shared by animations and the event player. */
export interface World {
  rig: SceneRig;
  tweens: TweenManager;
  effects: Effects;
  /** Batched instanced renderer for the screws resting on plates. */
  field: ScrewField;
  screws: Map<number, ScrewVisual>;
  plates: Map<number, PlateVisual>;
  boxes: Map<number, BoxVisual>;
  tray: TrayVisual | null;
  /** Logical tray occupancy (screw id or null per slot), kept in sync with events. */
  traySlots: (number | null)[];
  /** Number of horizontal box positions currently laid out. */
  boxPositionCount: number;
  /** Highest plate layer in the current level (drives the depth tint ramp). */
  maxLayer: number;
  /** Bumped on every loadLevel/dispose so in-flight async animations bail out. */
  generation: number;
  /** Recompute which screws are covered; call after any plate leaves the board. */
  recomputeCover: () => void;
}

export function isAlive(w: World, gen: number): boolean {
  return w.generation === gen;
}

/** World position of a screw resting in `slot` of `box` (box group is unrotated). */
export function boxSlotWorld(box: BoxVisual, slot: number): THREE.Vector3 {
  return boxSlotLocal(slot).add(box.group.position);
}

export function trayTargetWorld(w: World, slot: number): THREE.Vector3 {
  if (!w.tray) return new THREE.Vector3(0, -5.3, 0.3);
  return traySlotWorld(w.tray, slot);
}

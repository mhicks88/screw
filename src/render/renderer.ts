import * as THREE from 'three';
import type { GameEvent, GameSnapshot, LevelDef, ScrewDef } from '../core/types';
import { SceneRig } from './scene';
import { TweenManager } from './tween';
import { Effects } from './effects';
import { InputHandler } from './input';
import { EventPlayer } from './events';
import { Orbit } from './orbit';
import { RotateAffordance } from './affordance';
import type { World } from './world';
import { boxSlotWorld, trayTargetWorld } from './world';
import { createPanelVisual, disposePanelCaches, disposePanelVisual } from './panelMesh';
import { ScrewField } from './screwField';
import { createScrewVisual, disposeScrewCaches, disposeScrewVisual } from './screwMesh';
import { detachScrew } from './animations';
import { createBoxVisual, disposeBoxCaches, disposeBoxVisual } from './boxMesh';
import { createTrayVisual, disposeTrayCaches, disposeTrayVisual } from './trayMesh';
import {
  ASSEMBLY_RADIUS,
  MAX_ASSEMBLY_ZOOM,
  MIN_ASSEMBLY_ZOOM,
  MIN_LEVEL_RADIUS,
  boxPositionsX,
} from './layout';
import { SCREW_HEAD_TOP } from './screwMesh';
import type { PanelRayTarget } from './occlusion';
import { blockDepth, buildRayTargets } from './occlusion';

export interface RendererOptions {
  onScrewTap: (screwId: number) => void;
}

/**
 * Starting orientation: a three-quarter view, so the object reads as a solid
 * the moment the level loads instead of as a flat facade. It is only a seed —
 * everything after this is quaternion accumulation from the drag (orbit.ts).
 */
const START_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(THREE.MathUtils.degToRad(13), THREE.MathUtils.degToRad(-27), 0, 'YXZ'),
);

/**
 * Radius of the level's OWN bounding sphere, from real geometry: every panel
 * corner on both faces, plus every screw head standing proud of its face.
 *
 * Levels vary a lot — about 1.2 units at level 1 against 2.7 at level 1000 —
 * and the renderer zooms each one to fill the frame (layout.ts). Measured from
 * the level definition, so it is the INITIAL size: the object shrinks as panels
 * come off, and re-zooming mid-play would both disorient the player and drift
 * the drag gain under their finger.
 */
function levelBoundingRadius(level: LevelDef): number {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let maxSq = 0;
  for (const panel of level.panels) {
    q.set(panel.rotation.x, panel.rotation.y, panel.rotation.z, panel.rotation.w);
    for (const pt of panel.shape.outline) {
      for (const z of [0, panel.thickness]) {
        p.set(pt.x, pt.y, z).applyQuaternion(q);
        p.x += panel.position.x;
        p.y += panel.position.y;
        p.z += panel.position.z;
        maxSq = Math.max(maxSq, p.lengthSq());
      }
    }
  }
  let max = Math.sqrt(maxSq);
  for (const screw of level.screws) {
    // The head stands SCREW_HEAD_TOP proud along the axis, which on an outward
    // face is the outermost thing on the object.
    const r =
      Math.hypot(
        screw.position.x + screw.axis.x * SCREW_HEAD_TOP,
        screw.position.y + screw.axis.y * SCREW_HEAD_TOP,
        screw.position.z + screw.axis.z * SCREW_HEAD_TOP,
      );
    if (r > max) max = r;
  }
  return max;
}

/**
 * three.js view of the game. Sees only snapshots (loadLevel) and events
 * (playEvents); never touches the Game itself.
 *
 * v3 (CONTRACT_V3): the board is a solid assembly of extruded panels inside a
 * bounding sphere of radius 3, and THE OBJECT ROTATES, NOT THE CAMERA. All of
 * it hangs off `rig.assemblyRoot`, whose quaternion the drag gesture drives;
 * the camera, the lights, the box row and the tray row never move, which is why
 * the v2 framing, insets and box/tray layout still hold.
 *
 * Screws carry a 3D position and an axis; only those the core reports removable
 * AND whose rotated axis points at the camera are drawn solid and hit-tested
 * (§6). Everything else is a rotation away.
 */
export class GameRenderer {
  private readonly container: HTMLElement;
  private readonly options: RendererOptions;
  /** Debug handle for the dev harness; not part of the contract. */
  readonly rig: SceneRig;
  private readonly tweens = new TweenManager();
  private readonly effects: Effects;
  private readonly field: ScrewField;
  private readonly world: World;
  private readonly player: EventPlayer;
  /** Private in spirit; the dev harness and integration checks reach for it. */
  readonly input: InputHandler;
  private readonly orbit: Orbit;
  private readonly affordance: RotateAffordance;
  private lastFrameMs = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  private raf = 0;
  private active = true;
  private disposed = false;
  private targeting = false;
  /** A hint is showing: the rotate markers come up with it, since the screw
   * the solver picked may well be round the back. */
  private hinting = false;
  private pressedId: number | null = null;
  private timeMs = 0;
  /** Camera position expressed in assembly space (drives the facing test). */
  private readonly cameraLocal = new THREE.Vector3();
  private readonly invQuat = new THREE.Quaternion();
  private facingDirty = true;
  /** Radius of the current level's own bounding sphere (before the zoom). */
  private levelRadius = ASSEMBLY_RADIUS;
  /** Ray targets for the drill x-ray depth (occlusion.ts). */
  private rayTargets: PanelRayTarget[] = [];
  private coverDirty = true;
  /** Debug: animation speed multiplier (0 pauses animations). Not part of the contract. */
  timeScale = 1;

  constructor(container: HTMLElement, options: RendererOptions) {
    this.container = container;
    this.options = options;
    this.rig = new SceneRig(container);
    this.effects = new Effects(this.rig.fixedRoot);
    this.field = new ScrewField(this.rig.assemblyRoot);
    this.orbit = new Orbit(this.rig.camera);
    this.orbit.reset(START_ORIENTATION);
    this.rig.assemblyRoot.quaternion.copy(this.orbit.quaternion);
    // Parented to the scene, not to either root: it is a HUD-ish overlay that
    // must survive loadLevel clearing the roots.
    this.affordance = new RotateAffordance(this.rig.scene, this.rig.camera);
    this.world = {
      rig: this.rig,
      tweens: this.tweens,
      effects: this.effects,
      field: this.field,
      screws: new Map(),
      panels: new Map(),
      boxes: new Map(),
      tray: null,
      traySlots: [],
      boxPositionCount: 0,
      generation: 0,
      invalidate: () => {
        this.field.markDirty();
        this.facingDirty = true;
        this.coverDirty = true;
      },
    };
    this.player = new EventPlayer(this.world);
    this.input = new InputHandler({
      canvas: this.rig.canvas,
      camera: this.rig.camera,
      hitTargets: () => this.field.hitTargets(),
      onTap: (id) => this.options.onScrewTap(id),
      onPress: (id) => this.setPressed(id),
      onDragStart: () => this.orbit.begin(),
      onDrag: (dx, dy, dt) => this.orbit.drag(dx, dy, dt),
      onDragEnd: () => this.orbit.end(),
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onWindowResize);
    this.resize();
    this.loop();
  }

  /** Build the whole scene from a snapshot (level start / restart). Clears any previous level. */
  loadLevel(snapshot: GameSnapshot): void {
    const w = this.world;
    this.clearLevel();
    const level = snapshot.level;

    // Fit this level to the frame before anything is built: the zoom is part of
    // the assembly's world matrix, so screws parked in the tray or a box below
    // need it already set when they are placed.
    const radius = levelBoundingRadius(level);
    const zoom = THREE.MathUtils.clamp(
      ASSEMBLY_RADIUS / Math.max(MIN_LEVEL_RADIUS, radius),
      MIN_ASSEMBLY_ZOOM,
      MAX_ASSEMBLY_ZOOM,
    );
    this.levelRadius = radius;
    this.rig.setAssemblyScale(zoom);
    this.affordance.setRadius(radius * zoom);

    const shellOf = new Map<number, number>();
    for (const p of level.panels) shellOf.set(p.id, p.shell);

    const droppedPanels = new Set(snapshot.panels.filter((p) => p.dropped).map((p) => p.id));
    for (const p of level.panels) {
      if (droppedPanels.has(p.id)) continue;
      const pv = createPanelVisual(p);
      w.panels.set(pv.id, pv);
      w.rig.assemblyRoot.add(pv.mesh);
    }

    // Boxes and their positions (fixed world space, unchanged from v2).
    let positions = level.activeBoxCount;
    for (const b of snapshot.boxes) positions = Math.max(positions, b.position + 1);
    w.boxPositionCount = Math.max(1, positions);
    const xs = boxPositionsX(w.boxPositionCount);
    for (const b of snapshot.boxes) {
      if (b.completed) continue;
      const bv = createBoxVisual(b, xs[Math.min(b.position, xs.length - 1)] ?? 0);
      w.boxes.set(bv.id, bv);
      w.rig.fixedRoot.add(bv.group);
    }

    // Tray.
    w.traySlots = [...snapshot.tray];
    w.tray = createTrayVisual(Math.max(1, snapshot.tray.length));
    w.rig.fixedRoot.add(w.tray.group);

    // Screws.
    const defs = new Map<number, ScrewDef>();
    for (const d of level.screws) defs.set(d.id, d);
    for (const st of snapshot.screws) {
      const def = defs.get(st.id);
      if (!def || st.location === 'gone') continue;
      const sv = createScrewVisual({
        id: st.id,
        panelId: st.panelId,
        color: st.color,
        revealed: st.revealed || !def.hidden,
        location: st.location,
        shell: shellOf.get(st.panelId) ?? 0,
        position: def.position,
        axis: def.axis,
      });
      sv.blocked = st.blocked && st.location === 'plate';
      w.screws.set(sv.id, sv);
    }

    this.field.build(w.screws.values());

    // Park the screws that are not on a panel; they always own real meshes and
    // live in world space.
    for (const st of snapshot.screws) {
      const sv = w.screws.get(st.id);
      if (!sv) continue;
      let target: THREE.Vector3 | null = null;
      if (st.location === 'tray') {
        const slot = st.traySlot ?? Math.max(0, w.traySlots.indexOf(st.id));
        target = trayTargetWorld(w, slot);
      } else if (st.location === 'box') {
        const bv = st.boxId !== undefined ? w.boxes.get(st.boxId) : undefined;
        if (!bv) continue;
        const slot = st.boxSlot ?? Math.max(0, bv.screws.indexOf(st.id));
        target = boxSlotWorld(bv, slot);
      }
      if (!target) continue;
      const g = detachScrew(this.world, sv);
      sv.pos.copy(target);
      sv.worldQuat.identity();
      g.position.copy(target);
      g.quaternion.identity();
      // Already home: boxes and the tray are world furniture, at zoom 1.
      g.scale.setScalar(1);
    }

    this.rayTargets = buildRayTargets(level.panels);
    this.coverDirty = true;
    this.affordance.clear();
    this.field.setTargeting(this.targeting);
    this.facingDirty = true;
    this.updateFacing();
  }

  /** Animate events. Safe to call while earlier events are still animating; resolves when these finish. */
  playEvents(events: GameEvent[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.player.play(events);
  }

  /** Highlight these screws (pulsing glow) until cleared. Empty array clears. */
  setHint(screwIds: number[]): void {
    this.hinting = screwIds.length > 0;
    this.field.setHint(screwIds);
  }

  /** Toggle "drill targeting" mode: front-facing screws (even blocked) show a ring. */
  setTargetingMode(on: boolean): void {
    this.targeting = on;
    this.field.setTargeting(on);
    if (on) this.updateGhostDepth();
  }

  /** Pixels reserved by HTML overlays; the camera frames the assembly between them. */
  setInsets(topPx: number, bottomPx: number): void {
    this.rig.setInsets(topPx, bottomPx);
    this.orbit.setRadiusPx(this.rig.assemblyPixelRadius());
    this.facingDirty = true;
  }

  /** Pause/resume rendering (menus). Animations keep advancing so promises resolve. */
  setActive(active: boolean): void {
    this.active = active;
    this.input.enabled = active;
    if (!active) this.orbit.cancel();
    if (active && !this.raf && !this.disposed) this.loop();
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.rig.resize(w, h);
    this.orbit.setRadiusPx(this.rig.assemblyPixelRadius());
    this.facingDirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onWindowResize);
    this.input.dispose();
    this.clearLevel();
    this.affordance.dispose();
    this.field.dispose();
    this.effects.dispose();
    disposeScrewCaches();
    disposePanelCaches();
    disposeBoxCaches();
    disposeTrayCaches();
    this.rig.dispose();
  }

  /* ------------------------------------------------------------------ */

  private clearLevel(): void {
    const w = this.world;
    w.generation++;
    this.tweens.cancelAll(false);
    this.effects.clear();
    this.player.reset();
    for (const s of w.screws.values()) disposeScrewVisual(s);
    for (const p of w.panels.values()) disposePanelVisual(p);
    for (const b of w.boxes.values()) disposeBoxVisual(b);
    if (w.tray) disposeTrayVisual(w.tray);
    this.field.clear();
    this.affordance.clear();
    w.screws.clear();
    w.panels.clear();
    w.boxes.clear();
    w.tray = null;
    w.traySlots = [];
    w.boxPositionCount = 0;
    w.rig.assemblyRoot.clear();
    w.rig.fixedRoot.clear();
    this.pressedId = null;
    this.hinting = false;
    this.levelRadius = ASSEMBLY_RADIUS;
    this.rayTargets = [];
    this.coverDirty = true;
  }

  /**
   * Which of the blocked screws are exactly one panel deep, and so worth
   * showing as an x-ray ghost while the drill is armed. Only runs in targeting
   * mode, and only when the live panel set changed.
   */
  private updateGhostDepth(): void {
    if (!this.coverDirty) return;
    this.coverDirty = false;
    const live = (id: number): boolean => {
      const pv = this.world.panels.get(id);
      return !!pv && !pv.dropped;
    };
    for (const s of this.world.screws.values()) {
      if (s.location !== 'plate' || !s.blocked) {
        s.ghost = false;
        continue;
      }
      s.ghost = blockDepth(this.rayTargets, live, s.home, s.axis, s.panelId) < 2;
    }
    this.field.markDirty();
  }

  /**
   * Which screws face the camera, for the current rotation (CONTRACT_V3 §6).
   *
   * The test runs in ASSEMBLY space — the camera is transformed into it once
   * per rotated frame, and each screw then compares its own (unrotated) axis
   * against the direction to that point. That is one inverse rotation plus a
   * dot product per screw, instead of rotating 190 axes.
   */
  private updateFacing(): void {
    const cam = this.rig.camera;
    this.invQuat.copy(this.rig.assemblyRoot.quaternion).invert();
    // Screw positions are in unzoomed assembly space, so the camera has to come
    // all the way in: un-rotate it, then undo the level's zoom.
    this.cameraLocal
      .copy(cam.position)
      .applyQuaternion(this.invQuat)
      .divideScalar(this.rig.assemblyScale || 1);
    this.field.updateFacing(this.cameraLocal);
    this.facingDirty = false;
  }

  private setPressed(id: number | null): void {
    if (this.pressedId !== null && this.pressedId !== id) {
      const prev = this.world.screws.get(this.pressedId);
      if (prev && prev.location === 'plate') {
        prev.scale = 1;
        this.field.setPose(prev);
      }
    }
    this.pressedId = id;
    if (id !== null) {
      const s = this.world.screws.get(id);
      if (s && s.location === 'plate') {
        s.scale = 0.92;
        this.field.setPose(s);
      }
    }
  }

  private loop = (): void => {
    if (this.disposed) {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = (this.lastFrameMs ? Math.min(100, now - this.lastFrameMs) : 16) * this.timeScale;
    this.lastFrameMs = now;
    this.timeMs += dt;
    this.tweens.update(dt);
    this.effects.update(dt);

    // The object turns; the camera does not.
    if (this.orbit.update(dt) || this.facingDirty) {
      this.rig.assemblyRoot.quaternion.copy(this.orbit.quaternion);
      this.updateFacing();
    }

    if (this.targeting) this.updateGhostDepth();
    this.field.flush();
    this.field.updateHint(this.timeMs);
    this.affordance.update(
      this.field.offscreenRemovable(),
      this.rig.assemblyRoot.quaternion,
      this.rig.assemblyScale,
      this.field.seatedCount(),
      this.hinting,
      dt || 16,
      this.timeMs,
    );
    if (this.active) this.rig.render();
  };
}

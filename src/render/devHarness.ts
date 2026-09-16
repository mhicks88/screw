/**
 * Standalone dev harness for the renderer (open /render-dev.html with `vite`).
 *
 * Uses the real core (generateLevel + Game) when src/core/index.ts exists.
 * `?fake=1` forces the built-in fake game; `?synth=1` (plus optional
 * `shells`/`screws`/`colors`/`seed`/`mono`) builds a CONTRACT_V3-scale synthetic
 * ASSEMBLY by hand — nested shells of panels on a frame, screws on faces
 * pointing every way — which is how the v3 rotation work is verified while the
 * generator is still being rewritten.
 */
import * as THREE from 'three';
import type { GameApi, GameEvent, LevelDef, PowerUpId } from '../core/types';
import { GameRenderer } from './renderer';
import { FakeGame, buildFakeLevel } from './devGame';
import { buildAssemblyLevel, describeLevel } from './devLevels';
import { FACING_MIN_DOT } from './layout';

/* -------------------------------- boot --------------------------------- */

interface CoreModule {
  generateLevel: (n: number) => LevelDef;
  Game: new (level: LevelDef) => GameApi;
}

async function loadCore(): Promise<CoreModule | null> {
  const mods = import.meta.glob('../core/index.ts') as Record<string, () => Promise<unknown>>;
  const loader = mods['../core/index.ts'];
  if (!loader) return null;
  try {
    const m = (await loader()) as Partial<CoreModule>;
    if (typeof m.generateLevel === 'function' && typeof m.Game === 'function') return m as CoreModule;
  } catch (err) {
    console.warn('[harness] real core failed to load, using fake game', err);
  }
  return null;
}

/** Rolling rAF frame-time meter, so "60 fps" is measured and not asserted. */
class FpsMeter {
  private readonly samples: number[] = [];
  private last = 0;
  private raf = 0;
  private readonly cap: number;
  frames = 0;

  constructor(cap = 600) {
    this.cap = cap;
  }

  start(): void {
    if (this.raf) return;
    this.samples.length = 0;
    this.frames = 0;
    this.last = 0;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (this.last) {
        const dt = now - this.last;
        if (dt < 5000) {
          this.samples.push(dt);
          this.frames++;
          if (this.samples.length > this.cap) this.samples.shift();
        }
      }
      this.last = now;
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  stats(): { frames: number; fps: number; meanMs: number; p95Ms: number; maxMs: number } {
    const a = [...this.samples].sort((x, y) => x - y);
    if (a.length === 0) return { frames: 0, fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return {
      frames: a.length,
      fps: Math.round((1000 / mean) * 10) / 10,
      meanMs: Math.round(mean * 100) / 100,
      p95Ms: Math.round(a[Math.floor(a.length * 0.95)] * 100) / 100,
      maxMs: Math.round(a[a.length - 1] * 100) / 100,
    };
  }
}

interface FieldInternals {
  hintRings: THREE.Mesh[];
  hintIds: number[];
  tappableIds(): number[];
  seatedCount(): number;
  offscreenRemovable(): { id: number }[];
}

interface OrbitInternals {
  quaternion: THREE.Quaternion;
  begin(): void;
  drag(dx: number, dy: number, dt: number): void;
  end(): void;
  update(dt: number): boolean;
  reset(q?: THREE.Quaternion): void;
}

interface RendererInternals {
  rig: {
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    canvas: HTMLCanvasElement;
    scene: THREE.Scene;
    assemblyRoot: THREE.Group;
    fixedRoot: THREE.Group;
    assemblyPixelRadius(): number;
  };
  input: { pick(x: number, y: number): number | null };
  field: FieldInternals;
  orbit: OrbitInternals;
  world: {
    screws: Map<number, {
      pos: THREE.Vector3;
      home: THREE.Vector3;
      axis: THREE.Vector3;
      blocked: boolean;
      facing: boolean;
      location: string;
      shell: number;
    }>;
    panels: Map<number, unknown>;
    traySlots: (number | null)[];
    tray: { slotCount: number } | null;
  };
  tweens: { update(dt: number): void; count: number };
  effects: { update(dt: number): void };
}

async function main(): Promise<void> {
  const container = document.getElementById('app')!;
  const status = document.getElementById('status')!;
  const params = new URLSearchParams(location.search);
  const synth = params.has('synth') || params.has('shells') || params.has('screws');
  // `?fake=1` forces the built-in fake game; `?synth=1` uses the deep v2 stack.
  const core = params.get('fake') || synth ? null : await loadCore();
  let levelNo = Number(params.get('level') ?? '1') || 1;
  let deepOpts = {
    shells: Number(params.get('shells') ?? '5') || 5,
    targetScrews: Number(params.get('screws') ?? '162') || 162,
    colors: Number(params.get('colors') ?? '7') || 7,
    seed: Number(params.get('seed') ?? '48879') || 48879,
    traySlots: 8,
    activeBoxCount: 3,
    mono: params.has('mono'),
  };
  let useSynth = synth;
  let level: LevelDef | null = null;
  let game: GameApi;

  const newGame = () => {
    if (useSynth || !core) {
      level = useSynth ? buildAssemblyLevel(deepOpts) : buildFakeLevel();
      game = new FakeGame(level);
    } else {
      level = core.generateLevel(levelNo);
      game = new core.Game(level);
    }
    renderer.loadLevel(game.snapshot());
    const d = describeLevel(level!);
    status.textContent = `${useSynth ? 'synth' : core ? 'core' : 'fake'} · ${d.screws} screws · ${d.panels} panels · ${d.shells} shells · r${d.maxRadius} · ${d.axisSpread} axes`;
  };

  let targeting = false;
  const renderer = new GameRenderer(container, {
    onScrewTap: (id) => {
      const res = targeting ? game.usePowerUp('drill', id) : game.tapScrew(id);
      if (targeting) {
        targeting = false;
        renderer.setTargetingMode(false);
      }
      renderer.setHint([]);
      log(`tap ${id} → ${res.ok ? 'ok' : res.reason} ${res.events.map((e) => e.type).join(',')}`);
      void renderer.playEvents(res.events).then(() => log(`done ${res.events.length} events`));
    },
  });
  const top = document.getElementById('top')!;
  const bottom = document.getElementById('bottom')!;
  renderer.setInsets(top.offsetHeight, bottom.offsetHeight);
  newGame();

  const log = (msg: string) => {
    console.log('[harness]', msg);
    status.textContent = msg;
  };
  const internals = renderer as unknown as RendererInternals;
  const meter = new FpsMeter();
  meter.start();

  /** Bulk-remove every reachable screw whose colour matches an active box. */
  const magnet = (): GameEvent[] => {
    const snap = game.snapshot();
    const byId = new Map(snap.screws.map((s) => [s.id, s]));
    const boxColors = new Set(snap.boxes.map((b) => b.color));
    const ids = game.reachableScrewIds().filter((id) => boxColors.has(byId.get(id)!.color));
    const events: GameEvent[] = [];
    for (const id of ids) events.push(...game.tapScrew(id).events);
    return events;
  };

  /**
   * Drill a whole run of screws at once: the worst-case cascade. The tray is
   * widened first as a separate (un-timed) step so the measurement is about the
   * cascade and not about the harness's own power-up spam.
   */
  const widenTray = (slots: number): GameEvent[] => {
    const events: GameEvent[] = [];
    for (let i = 0; i < slots; i++) events.push(...game.usePowerUp('addSlot').events);
    return events;
  };

  const cascade = (count: number): GameEvent[] => {
    const events: GameEvent[] = [];
    for (let i = 0; i < count; i++) {
      const ids = game.reachableScrewIds();
      if (ids.length === 0) break;
      const res = game.usePowerUp('drill', ids[0]);
      if (!res.ok) break;
      events.push(...res.events);
    }
    return events;
  };

  const bind = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  bind('btn-hint', () => renderer.setHint(game.usePowerUp('hint').hintScrewIds ?? []));
  bind('btn-target', () => {
    targeting = !targeting;
    renderer.setTargetingMode(targeting);
  });
  bind('btn-slot', () => void renderer.playEvents(game.usePowerUp('addSlot').events));
  bind('btn-box', () => void renderer.playEvents(game.usePowerUp('addBox').events));
  bind('btn-recolor', () => void renderer.playEvents(game.usePowerUp('recolor').events));
  bind('btn-restart', () => newGame());
  bind('btn-next', () => {
    levelNo++;
    newGame();
  });
  bind('btn-synth', () => {
    useSynth = !useSynth;
    newGame();
  });
  bind('btn-spin', () => {
    // A quarter turn, driven exactly as a drag would drive it.
    const px = internals.rig.assemblyPixelRadius() * (Math.PI / 2);
    internals.orbit.begin();
    for (let i = 0; i < 12; i++) internals.orbit.drag(px / 12, 0, 16);
    internals.orbit.end();
  });
  bind('btn-magnet', () => {
    const ev = magnet();
    const t0 = performance.now();
    void renderer.playEvents(ev).then(() => log(`magnet ${ev.length} events in ${Math.round(performance.now() - t0)} ms`));
  });
  bind('btn-cascade', () => {
    void renderer.playEvents(widenTray(18));
    const ev = cascade(30);
    const t0 = performance.now();
    void renderer.playEvents(ev).then(() => log(`cascade ${ev.length} events in ${Math.round(performance.now() - t0)} ms`));
  });

  (window as unknown as { __harness: unknown }).__harness = {
    renderer,
    get game() {
      return game;
    },
    get level() {
      return level;
    },
    describe: () => (level ? describeLevel(level) : null),
    tap: (id: number) => {
      const res = game.tapScrew(id);
      return renderer.playEvents(res.events).then(() => res);
    },
    powerUp: (id: PowerUpId, target?: number) => {
      const res = game.usePowerUp(id, target);
      return renderer.playEvents(res.events).then(() => res);
    },
    magnet: () => {
      const ev = magnet();
      const t0 = performance.now();
      return renderer.playEvents(ev).then(() => ({ events: ev.length, ms: Math.round(performance.now() - t0) }));
    },
    widenTray: (n = 18) => renderer.playEvents(widenTray(n)),
    cascade: (n = 30) => {
      const ev = cascade(n);
      const t0 = performance.now();
      return renderer.playEvents(ev).then(() => ({ events: ev.length, ms: Math.round(performance.now() - t0) }));
    },
    /**
     * Run a batch of events on a manually-driven clock and report how long the
     * animation actually takes in tween-time. Wall-clock timing is useless in a
     * software-rasterised harness, where frames take ~400 ms.
     */
    timed: async (kind: 'magnet' | 'cascade', n = 30, drop?: string[]) => {
      const all = kind === 'magnet' ? magnet() : cascade(n);
      const ev = drop ? all.filter((e) => !drop.includes(e.type)) : all;
      renderer.timeScale = 0;
      renderer.setActive(false); // don't fight the software rasteriser for frames
      let done = false;
      const p = renderer.playEvents(ev).then(() => {
        done = true;
      });
      let t = 0;
      while (!done && t < 60000) {
        internals.tweens.update(16);
        internals.effects.update(16);
        t += 16;
        await new Promise((r) => setTimeout(r, 0));
      }
      renderer.timeScale = 1;
      renderer.setActive(true);
      await p;
      const hist: Record<string, number> = {};
      for (const e of ev) hist[e.type] = (hist[e.type] ?? 0) + 1;
      return { events: ev.length, animMs: t, hist };
    },
    snapshot: () => game.snapshot(),
    reachable: () => game.reachableScrewIds(),
    restart: newGame,
    setAssembly: (o: Partial<typeof deepOpts>) => {
      deepOpts = { ...deepOpts, ...o };
      useSynth = true;
      newGame();
    },
    screwShell: (id: number) => internals.world.screws.get(id)?.shell ?? -1,
    /** Hint rings the field is really drawing, with their positions. */
    hintRingState: () => ({
      ids: internals.field.hintIds,
      visible: internals.field.hintRings.filter((r) => r.visible).length,
      rings: internals.field.hintRings.length,
      opacity: internals.field.hintRings[0] ? (internals.field.hintRings[0].material as THREE.MeshBasicMaterial).opacity : null,
    }),
    /**
     * Tray occupancy as the game sees it vs what the renderer has parked in the
     * tray holes, so a stale screw in an empty hole is detectable.
     */
    trayState: () => {
      const logicalIds = internals.world.traySlots.filter((id): id is number => id !== null);
      const drawnIds: number[] = [];
      for (const [id, s] of internals.world.screws) {
        if (s.location === 'tray') drawnIds.push(id);
      }
      const snapTray = game.snapshot().tray.filter((id): id is number => id !== null);
      return {
        logical: snapTray.length,
        rendererTray: logicalIds.length,
        drawn: drawnIds.length,
        drawnNotLogical: drawnIds.filter((id) => !snapTray.includes(id)),
        logicalNotDrawn: snapTray.filter((id) => !drawnIds.includes(id)),
      };
    },
    /** Screws the renderer is actually drawing solid right now. */
    visibleScrews: () => {
      const out: number[] = [];
      for (const [id, s] of internals.world.screws) {
        if (s.location === 'plate' && !s.blocked && s.facing) out.push(id);
      }
      return out;
    },

    /* ----------------------- v3: rotation checks ---------------------- */

    /** Ids the renderer will accept a tap on (its hit proxies). */
    tappable: () => [...internals.field.tappableIds()].sort((a, b) => a - b),

    /** Current assembly orientation. */
    orientation: () => {
      const q = internals.rig.assemblyRoot.quaternion;
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      return {
        quat: { x: q.x, y: q.y, z: q.z, w: q.w },
        eulerDeg: {
          x: Math.round(THREE.MathUtils.radToDeg(e.x)),
          y: Math.round(THREE.MathUtils.radToDeg(e.y)),
          z: Math.round(THREE.MathUtils.radToDeg(e.z)),
        },
      };
    },

    /** Set an exact orientation (degrees, YXZ), for reproducible screenshots. */
    setOrientation: (yawDeg: number, pitchDeg: number, rollDeg = 0) => {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(pitchDeg),
          THREE.MathUtils.degToRad(yawDeg),
          THREE.MathUtils.degToRad(rollDeg),
          'YXZ',
        ),
      );
      internals.orbit.reset(q);
    },

    /** Drive the orbit controller directly (px deltas), as a drag would. */
    spin: (dx: number, dy: number, steps = 8) => {
      internals.orbit.begin();
      for (let i = 0; i < steps; i++) internals.orbit.drag(dx / steps, dy / steps, 16);
      internals.orbit.end();
    },

    radiusPx: () => internals.rig.assemblyPixelRadius(),

    /**
     * CONTRACT_V3 §6, the property v2 established and v3 must keep: when the
     * board is idle the renderer's TAPPABLE set is exactly the core's
     * REMOVABLE set intersected with front-facing. Recomputed here from the
     * level defs and the camera, independently of the renderer's own state.
     */
    checkTappable: () => {
      const snap = game.snapshot();
      const lvl = snap.level;
      const cam = internals.rig.camera;
      internals.rig.assemblyRoot.updateMatrixWorld(true);
      const inv = internals.rig.assemblyRoot.quaternion.clone().invert();
      const camLocal = cam.position.clone().applyQuaternion(inv);
      const defs = new Map(lvl.screws.map((d) => [d.id, d]));
      const removable = new Set(game.reachableScrewIds());
      const expected: number[] = [];
      const facingOnly: number[] = [];
      for (const st of snap.screws) {
        if (st.location !== 'plate') continue;
        const d = defs.get(st.id)!;
        const axis = new THREE.Vector3(d.axis.x, d.axis.y, d.axis.z).normalize();
        const pos = new THREE.Vector3(d.position.x, d.position.y, d.position.z);
        const facing = camLocal.clone().sub(pos).normalize().dot(axis) >= FACING_MIN_DOT;
        if (facing) facingOnly.push(st.id);
        if (facing && removable.has(st.id)) expected.push(st.id);
      }
      expected.sort((a, b) => a - b);
      const actual = [...internals.field.tappableIds()].sort((a, b) => a - b);
      return {
        ok: expected.length === actual.length && expected.every((v, i) => v === actual[i]),
        removable: removable.size,
        frontFacing: facingOnly.length,
        expected: expected.length,
        actual: actual.length,
        missing: expected.filter((id) => !actual.includes(id)),
        extra: actual.filter((id) => !expected.includes(id)),
      };
    },

    /** How many removable screws are hidden round the back right now. */
    behind: () => internals.field.offscreenRemovable().length,
    /**
     * Client-space position of a screw, for synthetic taps. A seated screw's
     * `pos` is in ASSEMBLY space, so it has to go through the assembly's world
     * matrix first — that transform IS the rotation the player drives.
     */
    screenPos: (id: number) => {
      const s = internals.world.screws.get(id);
      if (!s) return null;
      const rig = internals.rig;
      rig.camera.updateMatrixWorld(true);
      rig.assemblyRoot.updateMatrixWorld(true);
      const p = new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z);
      if (s.location === 'plate') p.applyMatrix4(rig.assemblyRoot.matrixWorld);
      p.project(rig.camera);
      const rect = rig.canvas.getBoundingClientRect();
      return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height };
    },
    pickAt: (x: number, y: number) => internals.input.pick(x, y),
    /** Per-object draw-call breakdown of the last rendered frame. */
    drawBreakdown: () => {
      const counts: Record<string, number> = {};
      internals.rig.scene.traverse((o) => {
        const any = o as unknown as { isMesh?: boolean; isPoints?: boolean; visible: boolean; layers: THREE.Layers; name: string; count?: number };
        if (!(any.isMesh || any.isPoints) || !any.visible) return;
        if (!any.layers.test(internals.rig.camera.layers)) return;
        if (typeof any.count === 'number' && any.count === 0) return;
        const key = (any.name || o.type).replace(/[-0-9]+$/, '');
        counts[key] = (counts[key] ?? 0) + 1;
      });
      return counts;
    },
    perf: () => {
      const info = internals.rig.renderer.info;
      return {
        ...meter.stats(),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        pixelRatio: internals.rig.renderer.getPixelRatio(),
        canvas: { w: internals.rig.canvas.width, h: internals.rig.canvas.height },
        tweens: internals.tweens.count,
      };
    },
    resetPerf: () => {
      meter.stop();
      meter.start();
    },
    /**
     * Debug: advance animations by `ms` regardless of wall clock (use with
     * renderer.timeScale = 0). Ticks in 16 ms steps and yields to the event
     * loop between ticks so promise-chained animation phases can start.
     */
    step: async (ms: number) => {
      for (let t = 0; t < ms; t += 16) {
        internals.tweens.update(16);
        internals.effects.update(16);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

void main();

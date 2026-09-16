/**
 * Synthetic 3D assemblies for the renderer dev harness (CONTRACT_V3 §1, §7).
 *
 * The real generator (src/core, owned by CORE) is rewritten for v3 at the same
 * time as this renderer, so the rotation, facing and panel work is developed
 * against these hand-built LevelDefs: nested shells of panels on a frame, plus
 * brackets on tilted faces and struts through the middle, with ~160 screws on
 * faces pointing in every direction.
 *
 * Nothing here ships in the game bundle — only render-dev.html imports it.
 */
import * as THREE from 'three';
import type { LevelDef, PanelDef, PlateShape, Quat, ScrewColor, ScrewDef, Vec2, Vec3 } from '../core/types';
import { ALL_COLORS, ASSEMBLY_RADIUS, BOX_CAPACITY } from '../core/types';

const SCREW_SPACING = 0.82;
const SCREW_EDGE_MARGIN = 0.34;
const SCREW_HEAD_R = 0.23;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ shapes --------------------------------- */

function rect(w: number, h: number): Vec2[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
}

function roundedRect(w: number, h: number, r: number, n = 4): Vec2[] {
  const rr = Math.min(r, Math.min(w, h) / 2 - 0.01);
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - rr, -h / 2 + rr, -Math.PI / 2],
    [w / 2 - rr, h / 2 - rr, 0],
    [-w / 2 + rr, h / 2 - rr, Math.PI / 2],
    [-w / 2 + rr, -h / 2 + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }
  return pts;
}

function hexagon(r: number): Vec2[] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

function lShape(w: number, h: number): Vec2[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 + h * 0.46 },
    { x: -w / 2 + w * 0.44, y: -h / 2 + h * 0.46 },
    { x: -w / 2 + w * 0.44, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
}

type ShapeKind = 'rect' | 'roundedRect' | 'hexagon' | 'L' | 'ring' | 'capsule';

function makeShape(kind: ShapeKind, w: number, h: number): PlateShape {
  switch (kind) {
    case 'rect':
      return { kind: 'rect', outline: rect(w, h) };
    case 'hexagon':
      return { kind: 'hexagon', outline: hexagon(Math.max(w, h) / 2) };
    case 'L':
      return { kind: 'L', outline: lShape(w, h) };
    case 'capsule':
      return { kind: 'capsule', outline: roundedRect(w, h, Math.min(w, h) * 0.48) };
    case 'ring': {
      const r = Math.max(w, h) / 2;
      return {
        kind: 'ring',
        outline: roundedRect(w, h, Math.min(w, h) * 0.3),
        holes: [hexagon(r * 0.42).reverse()],
      };
    }
    default:
      return { kind: 'roundedRect', outline: roundedRect(w, h, Math.min(w, h) * 0.24) };
  }
}

/** Largest |(x, y)| over the outline, for bounding-sphere fitting. */
function outlineRadius(outline: Vec2[]): number {
  let r = 0;
  for (const p of outline) r = Math.max(r, Math.hypot(p.x, p.y));
  return r;
}

/* --------------------------- placement math ---------------------------- */

const ZP = new THREE.Vector3(0, 0, 1);

function quatFacing(dir: THREE.Vector3, roll: number): Quat {
  const q = new THREE.Quaternion().setFromUnitVectors(ZP, dir.clone().normalize());
  q.multiply(new THREE.Quaternion().setFromAxisAngle(ZP, roll));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function toV3(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * The frame's face directions, in three families. Keeping them separate is what
 * makes the result look built rather than grown: big skin panels go on the six
 * faces, brackets on the bevelled corners, straps across the edges.
 */
const AXIS_DIRS: THREE.Vector3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

const CORNER_DIRS: THREE.Vector3[] = [
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1],
  [-1, -1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());

const EDGE_DIRS: THREE.Vector3[] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, -1], [0, -1, -1],
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());

export interface AssemblyOptions {
  level?: number;
  seed?: number;
  shells?: number;
  targetScrews?: number;
  colors?: number;
  activeBoxCount?: number;
  traySlots?: number;
  /** Paint every panel the same hue, to judge shading and shells alone. */
  mono?: boolean;
}

/**
 * Panels are bright plastic, but a machine is not a bag of sweets: one hue per
 * shell family plus a metal frame reads as a built object, where twelve
 * competing hues read as debris.
 */
const SHELL_PALETTE = [
  { skin: 0x3f7fd8, trim: 0x2f63ad },   // outer: blue casing
  { skin: 0xe0952c, trim: 0xc07a1e },   // amber inner casing
  { skin: 0x36ab6e, trim: 0x2b8a58 },   // green gear deck
  { skin: 0xd0475f, trim: 0xa8384c },   // red core
  { skin: 0x8a56d6, trim: 0x6f45ab },
  { skin: 0x2f9fb5, trim: 0x267f92 },
];

const FRAME_COLOR = 0x8b93a6;
const BRACKET_COLOR = 0xa7aebd;

interface PanelBuild {
  def: PanelDef;
  /** World transform helpers, kept so screws can be placed on the face. */
  quat: THREE.Quaternion;
  origin: THREE.Vector3;
  /** Outward normal in assembly space (panel local +Z). */
  normal: THREE.Vector3;
}

/**
 * Build a machine-like assembly: a frame of struts through the middle, then
 * nested shells of panels and brackets bolted onto it, outer shells covering
 * inner ones. Everything fits inside ASSEMBLY_RADIUS.
 */
export function buildAssemblyLevel(opts: AssemblyOptions = {}): LevelDef {
  const shells = Math.max(1, opts.shells ?? 5);
  const target = opts.targetScrews ?? 162;
  const colorCount = opts.colors ?? 7;
  const rng = mulberry32(opts.seed ?? 0xbeef);
  const builds: PanelBuild[] = [];

  /** Raw placement: caller supplies the full local→assembly transform. */
  const pushPanel = (
    shape: PlateShape,
    thickness: number,
    origin: THREE.Vector3,
    quat: THREE.Quaternion,
    shell: number,
    color: number,
    material: PanelDef['material'],
  ): PanelBuild | null => {
    // Reject anything that would poke outside the bounding sphere.
    const corner = new THREE.Vector3();
    for (const p of shape.outline) {
      for (const z of [0, thickness]) {
        corner.set(p.x, p.y, z).applyQuaternion(quat).add(origin);
        if (corner.length() > ASSEMBLY_RADIUS) return null;
      }
    }
    const def: PanelDef = {
      id: builds.length,
      shape,
      thickness,
      position: toV3(origin),
      rotation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
      color,
      material,
      shell,
    };
    const build: PanelBuild = {
      def,
      quat: quat.clone(),
      origin: origin.clone(),
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize(),
    };
    builds.push(build);
    return build;
  };

  /** A panel bolted flat onto a shell face, its outward side pointing along `dir`. */
  const addFacePanel = (
    dir: THREE.Vector3,
    radius: number,
    kind: ShapeKind,
    w: number,
    h: number,
    thickness: number,
    shell: number,
    color: number,
    material: PanelDef['material'],
    roll: number,
  ): PanelBuild | null => {
    const n = dir.clone().normalize();
    const q0 = quatFacing(n, roll);
    const quat = new THREE.Quaternion(q0.x, q0.y, q0.z, q0.w);
    const origin = n.clone().multiplyScalar(radius);
    // Shrink until the far corners fit inside the bounding sphere.
    const far = radius + thickness;
    const maxR = Math.sqrt(Math.max(0.01, ASSEMBLY_RADIUS * ASSEMBLY_RADIUS - far * far));
    const probe = makeShape(kind, w, h);
    const k = Math.min(1, (maxR * 0.96) / Math.max(1e-3, outlineRadius(probe.outline)));
    if (k < 0.42) return null;
    return pushPanel(makeShape(kind, w * k, h * k), thickness, origin, quat, shell, color, material);
  };

  /* ----------------------------- the frame ---------------------------- */
  // Struts crossing the middle: the shells bolt onto them, and they stay
  // visible through the gaps once outer panels come off. A strut lies ACROSS
  // the object (its long local X follows `along`) with its faces — and so the
  // screws on them — pointing sideways.
  const strutSpecs: { along: THREE.Vector3; normal: THREE.Vector3; offset: number }[] = [
    { along: new THREE.Vector3(1, 0, 0), normal: new THREE.Vector3(0, 0, 1), offset: 0.0 },
    { along: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(1, 0, 0), offset: 0.0 },
    { along: new THREE.Vector3(0, 0, 1), normal: new THREE.Vector3(0, 1, 0), offset: 0.0 },
    { along: new THREE.Vector3(1, 1, 0).normalize(), normal: new THREE.Vector3(0, 0, 1), offset: -0.42 },
    { along: new THREE.Vector3(0, 1, 1).normalize(), normal: new THREE.Vector3(1, 0, 0), offset: 0.42 },
  ];
  const basis = new THREE.Matrix4();
  for (const spec of strutSpecs) {
    const x = spec.along.clone().normalize();
    const z = spec.normal.clone().sub(x.clone().multiplyScalar(spec.normal.dot(x))).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    basis.makeBasis(x, y, z);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const th = 0.2;
    const origin = z.clone().multiplyScalar(spec.offset - th / 2);
    pushPanel(makeShape('capsule', 4.3, 0.66), th, origin, quat, shells - 1, FRAME_COLOR, 'metal');
  }

  /* ---------------------------- the shells ---------------------------- */
  const shellRadius = (s: number): number => 2.26 - s * (1.46 / Math.max(1, shells - 1));
  /** Rolls are quantised: machined parts line up with each other. */
  const quantRoll = (r: number): number => Math.round((r * 4) / Math.PI) * (Math.PI / 4);

  for (let s = 0; s < shells; s++) {
    const radius = shellRadius(s);
    const thickness = 0.2 - s * 0.014;
    const pal = SHELL_PALETTE[s % SHELL_PALETTE.length];
    const material: PanelDef['material'] = s % 3 === 2 ? 'metal' : 'plastic';

    // Skin: big panels on the six faces. These are what the player sees first
    // and what has to come off before anything inside is reachable.
    for (const d0 of AXIS_DIRS) {
      // A whisper of tilt keeps it from looking like a rendered cube; more than
      // this and it stops looking assembled.
      const d = d0.clone().addScaledVector(new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5), 0.09).normalize();
      const kind: ShapeKind = s === 0 ? (rng() < 0.3 ? 'ring' : 'roundedRect') : rng() < 0.3 ? 'L' : 'rect';
      const w = (s === 0 ? 3.15 : 2.7) * (0.86 + rng() * 0.2);
      addFacePanel(d, radius + (rng() - 0.5) * 0.06, kind, w, w * (0.76 + rng() * 0.3), thickness, s,
        opts.mono ? 0x3f7fd8 : pal.skin, material, quantRoll(rng() * Math.PI));
    }

    // Brackets on the bevelled corners: smaller, metal, and they are what makes
    // the silhouette read as a machined body instead of a box.
    const corners = [...CORNER_DIRS];
    for (let i = corners.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [corners[i], corners[j]] = [corners[j], corners[i]];
    }
    const cornerCount = s === 0 ? 8 : Math.max(2, 6 - s);
    for (const d of corners.slice(0, cornerCount)) {
      const w = 1.5 * (0.8 + rng() * 0.35);
      addFacePanel(d, radius + 0.02, rng() < 0.45 ? 'hexagon' : 'roundedRect', w, w * (0.8 + rng() * 0.3),
        thickness * 0.85, s, opts.mono ? 0x3f7fd8 : BRACKET_COLOR, 'metal', quantRoll(rng() * Math.PI));
    }

    // Straps across the edges, tying neighbouring faces together.
    const edges = [...EDGE_DIRS];
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }
    const edgeCount = s === 0 ? 6 : Math.max(2, 5 - s);
    for (const d of edges.slice(0, edgeCount)) {
      addFacePanel(d, radius - 0.04, 'capsule', 2.3 * (0.8 + rng() * 0.3), 0.72, thickness * 0.8, s,
        opts.mono ? 0x3f7fd8 : pal.trim, s % 2 === 0 ? 'metal' : 'plastic', quantRoll(rng() * Math.PI));
    }
  }

  /* ----------------------------- screws ------------------------------- */
  interface Placed { pos: THREE.Vector3; axis: THREE.Vector3; panel: number }
  const placed: Placed[] = [];

  /**
   * CONTRACT_V3 §4: two screws need SCREW_SPACING apart only when their axes
   * are within 90° (they could both be tappable from one angle). Beyond that
   * they only need to not physically interpenetrate.
   */
  const spacingOk = (p: THREE.Vector3, axis: THREE.Vector3): boolean => {
    for (const o of placed) {
      const d2 = o.pos.distanceToSquared(p);
      const min = o.axis.dot(axis) > 0 ? SCREW_SPACING : 2 * SCREW_HEAD_R;
      if (d2 < min * min) return false;
    }
    return true;
  };

  const pointInPoly = (x: number, y: number, poly: Vec2[]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  const edgeDistance = (x: number, y: number, poly: Vec2[]): number => {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
    }
    return best;
  };

  const perPanel = new Map<number, number>();
  const maxPerPanel = Math.max(4, Math.ceil(target / Math.max(1, builds.length)) + 7);
  const order = [...builds].sort((a, b) => b.def.shell - a.def.shell || rng() - 0.5);

  for (let pass = 0; pass < 12 && placed.length < target; pass++) {
    for (const b of order) {
      if (placed.length >= target) break;
      if ((perPanel.get(b.def.id) ?? 0) >= maxPerPanel) continue;
      const outline = b.def.shape.outline;
      const holes = b.def.shape.holes ?? [];
      const rOut = outlineRadius(outline);
      // Panels carry screws on BOTH faces: the inner ones point back into the
      // object, so they only become reachable once whatever is behind them has
      // gone, and they are seen through the gaps in the meantime. This is also
      // where the surface area for 190 screws on a 3-unit sphere comes from.
      const backOk = true;
      let tries = 0;
      let added = 0;
      const want = pass === 0 ? 3 : 1;
      while (tries < 220 && added < want && placed.length < target) {
        tries++;
        const lx = (rng() * 2 - 1) * rOut;
        const ly = (rng() * 2 - 1) * rOut;
        if (!pointInPoly(lx, ly, outline)) continue;
        if (edgeDistance(lx, ly, outline) < SCREW_EDGE_MARGIN) continue;
        let inHole = false;
        for (const h of holes) {
          if (pointInPoly(lx, ly, h) || edgeDistance(lx, ly, h) < SCREW_EDGE_MARGIN) inHole = true;
        }
        if (inHole) continue;
        const front = !backOk || rng() > 0.42;
        const localZ = front ? b.def.thickness : 0;
        const pos = new THREE.Vector3(lx, ly, localZ).applyQuaternion(b.quat).add(b.origin);
        const axis = b.normal.clone().multiplyScalar(front ? 1 : -1);
        if (pos.length() > ASSEMBLY_RADIUS - 0.05) continue;
        if (!spacingOk(pos, axis)) continue;
        placed.push({ pos, axis, panel: b.def.id });
        perPanel.set(b.def.id, (perPanel.get(b.def.id) ?? 0) + 1);
        added++;
      }
    }
  }

  // Every panel must carry at least one screw or it would drop immediately.
  const keep = builds.filter((b) => (perPanel.get(b.def.id) ?? 0) > 0);
  const remap = new Map<number, number>();
  keep.forEach((b, i) => remap.set(b.def.id, i));
  const panels = keep.map((b, i) => ({ ...b.def, id: i }));
  for (const s of placed) s.panel = remap.get(s.panel)!;

  // Trim to a multiple of BOX_CAPACITY without emptying a panel.
  const counts = new Map<number, number>();
  for (const s of placed) counts.set(s.panel, (counts.get(s.panel) ?? 0) + 1);
  while (placed.length % BOX_CAPACITY !== 0) {
    const idx = placed.findIndex((s) => (counts.get(s.panel) ?? 0) > 1);
    if (idx < 0) break;
    counts.set(placed[idx].panel, counts.get(placed[idx].panel)! - 1);
    placed.splice(idx, 1);
  }

  const colors = ALL_COLORS.slice(0, Math.max(3, Math.min(8, colorCount)));
  const screws: ScrewDef[] = placed.map((s, i) => ({
    id: i,
    panelId: s.panel,
    position: toV3(s.pos),
    axis: toV3(s.axis),
    color: colors[0],
    hidden: false,
  }));

  // Colour in whole boxes so every colour count is a multiple of BOX_CAPACITY.
  const shuffled = [...screws];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const boxQueue: ScrewColor[] = [];
  for (let i = 0; i < shuffled.length; i += BOX_CAPACITY) {
    const c = colors[Math.floor(rng() * colors.length)];
    for (let k = 0; k < BOX_CAPACITY && i + k < shuffled.length; k++) shuffled[i + k].color = c;
    boxQueue.push(c);
  }
  // A few mystery screws on the inner shells.
  const shellOf = new Map<number, number>();
  for (const p of panels) shellOf.set(p.id, p.shell);
  let mystery = 0;
  for (const s of screws) {
    if (mystery >= 8) break;
    if ((shellOf.get(s.panelId) ?? 0) >= 2 && Math.floor(s.id * 7919) % 11 === 0) {
      s.hidden = true;
      mystery++;
    }
  }

  return {
    level: opts.level ?? 900,
    seed: opts.seed ?? 0xbeef,
    panels,
    screws,
    boxQueue,
    activeBoxCount: opts.activeBoxCount ?? 3,
    traySlots: opts.traySlots ?? 6,
    colors,
    difficulty: 'extreme',
  };
}

/** Quick stats for the harness readout / assertions. */
export function describeLevel(level: LevelDef): {
  screws: number;
  panels: number;
  shells: number;
  maxRadius: number;
  axisSpread: number;
  screwsPerShell: number[];
} {
  const shellOf = new Map<number, number>();
  let maxShell = 0;
  for (const p of level.panels) {
    shellOf.set(p.id, p.shell);
    maxShell = Math.max(maxShell, p.shell);
  }
  const perShell = Array.from({ length: maxShell + 1 }, () => 0);
  let maxRadius = 0;
  const seen = new Set<string>();
  for (const s of level.screws) {
    perShell[shellOf.get(s.panelId) ?? 0]++;
    maxRadius = Math.max(maxRadius, Math.hypot(s.position.x, s.position.y, s.position.z));
    // Coarse axis bucket, to show screws really do point in many directions.
    seen.add(`${Math.round(s.axis.x * 2)},${Math.round(s.axis.y * 2)},${Math.round(s.axis.z * 2)}`);
  }
  return {
    screws: level.screws.length,
    panels: level.panels.length,
    shells: maxShell + 1,
    maxRadius: Math.round(maxRadius * 100) / 100,
    axisSpread: seen.size,
    screwsPerShell: perShell,
  };
}

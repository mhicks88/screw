/**
 * Synthetic level builders for the renderer dev harness.
 *
 * The real generator (src/core, owned by CORE) is being rewritten for
 * CONTRACT_V2 at the same time as this renderer, so the deep-stack work is
 * developed and verified against these hand-built LevelDefs: 2-4 interlocking
 * towers of thin overlapping plates, 12-15 global layers, up to 150 screws,
 * screws-per-layer roughly uniform and only ~15-25 uncovered at any moment.
 *
 * Nothing here ships in the game bundle — only render-dev.html imports it.
 */
import type { LevelDef, PlateDef, PlateShape, ScrewColor, ScrewDef, Vec2 } from '../core/types';
import { ALL_COLORS, BOX_CAPACITY } from '../core/types';
import { plateContainsWorldPoint, plateEdgeDistance, plateWorldAabb } from '../core/geometry';

const BOARD = { x: 3.35, y: 4.2 };
const SCREW_SPACING = 0.82;
const SCREW_EDGE_MARGIN = 0.34;
const PLATE_GAP = 0.06;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.9 };
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

function makeShape(kind: 'rect' | 'roundedRect' | 'hexagon' | 'L', w: number, h: number): PlateShape {
  switch (kind) {
    case 'rect':
      return { kind: 'rect', outline: rect(w, h) };
    case 'hexagon':
      return { kind: 'hexagon', outline: hexagon(Math.max(w, h) / 2) };
    case 'L':
      return { kind: 'L', outline: lShape(w, h) };
    default:
      return { kind: 'roundedRect', outline: roundedRect(w, h, Math.min(w, h) * 0.26) };
  }
}

/** Cheap same-layer overlap rejection: expanded world AABBs must stay apart. */
function aabbOverlaps(a: PlateDef, b: PlateDef): boolean {
  const A = plateWorldAabb(a);
  const B = plateWorldAabb(b);
  return (
    A.minX - PLATE_GAP < B.maxX &&
    A.maxX + PLATE_GAP > B.minX &&
    A.minY - PLATE_GAP < B.maxY &&
    A.maxY + PLATE_GAP > B.minY
  );
}

export interface DeepLevelOptions {
  level?: number;
  seed?: number;
  layers?: number;
  towers?: number;
  targetScrews?: number;
  colors?: number;
  activeBoxCount?: number;
  traySlots?: number;
  /** Paint every plate the same hue, to judge the per-layer depth tint alone. */
  mono?: boolean;
}

const PLATE_PALETTE = [
  0x2f7fe8, 0xe8a828, 0xd94a63, 0x35b073, 0x8a4fd8, 0xdf7a25, 0x2aa6bd, 0x5c6bd0,
  0xc8407c, 0x7ab52c, 0xb88a1a, 0xc44bb0,
];

/**
 * Build a deep, tower-shaped level.
 *
 * Towers are clusters of plates over roughly the same footprint; their
 * footprints overlap so plates interlock at the edges, and every layer index is
 * global so the renderer's blocking rule works untouched.
 */
export function buildDeepLevel(opts: DeepLevelOptions = {}): LevelDef {
  const layers = opts.layers ?? 14;
  const towerCount = opts.towers ?? 3;
  const target = opts.targetScrews ?? 141;
  const colorCount = opts.colors ?? 7;
  const rng = mulberry32(opts.seed ?? 0xbeef);

  const towerCentres: Vec2[] =
    towerCount >= 4
      ? [
          { x: -1.6, y: 2.2 },
          { x: 1.5, y: 1.5 },
          { x: -1.2, y: -1.6 },
          { x: 1.6, y: -2.4 },
        ]
      : towerCount === 3
        ? [
            { x: -1.42, y: 2.35 },
            { x: 1.48, y: 0.15 },
            { x: -1.0, y: -2.4 },
          ]
        : [
            { x: -1.2, y: 1.7 },
            { x: 1.2, y: -1.7 },
          ];

  const plates: PlateDef[] = [];
  const kinds = ['roundedRect', 'rect', 'hexagon', 'roundedRect', 'L'] as const;

  for (let layer = 0; layer < layers; layer++) {
    const shrink = 1 - 0.019 * layer;
    const perLayer: PlateDef[] = [];
    for (let t = 0; t < towerCentres.length; t++) {
      // Each tower skips roughly one layer in four so towers are staggered and
      // the stack is not a set of solid columns.
      if ((layer + t * 2) % 5 === 4) continue;
      const c = towerCentres[t];
      const baseW = (layer === 0 ? 3.3 : 3.0) * shrink;
      const baseH = (layer === 0 ? 3.2 : 2.85) * shrink;
      const w = baseW * (0.88 + rng() * 0.2);
      const h = baseH * (0.88 + rng() * 0.2);
      const kind = layer === 0 ? 'roundedRect' : kinds[Math.floor(rng() * kinds.length)];
      const jitter = layer === 0 ? 0.1 : 0.34;
      const cand: PlateDef = {
        id: plates.length,
        layer,
        shape: makeShape(kind, w, h),
        x: clamp(c.x + (rng() - 0.5) * jitter * 2, -BOARD.x + w / 2, BOARD.x - w / 2),
        y: clamp(c.y + (rng() - 0.5) * jitter * 2, -BOARD.y + h / 2, BOARD.y - h / 2),
        rotation: (rng() - 0.5) * (layer === 0 ? 0.12 : 0.5),
        color: opts.mono ? 0x3f7fd8 : PLATE_PALETTE[(layer * 3 + t * 5) % PLATE_PALETTE.length],
        material: layer % 5 === 3 ? 'metal' : layer % 7 === 5 ? 'wood' : 'plastic',
      };
      if (perLayer.some((p) => aabbOverlaps(p, cand))) continue;
      perLayer.push(cand);
      plates.push(cand);
    }
    // Bridge plate: spans two neighbouring towers so the stack interlocks
    // instead of splitting into disjoint boxes.
    if (layer > 0 && layer % 3 === 1 && towerCentres.length >= 2) {
      const i = Math.floor(rng() * towerCentres.length);
      const j = (i + 1) % towerCentres.length;
      const a = towerCentres[i];
      const b = towerCentres[j];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) * 0.72;
      const cand: PlateDef = {
        id: plates.length,
        layer,
        shape: { kind: 'capsule', outline: roundedRect(len, 0.98 * shrink, 0.44) },
        x: clamp(mx, -BOARD.x + len / 2, BOARD.x - len / 2),
        y: clamp(my, -BOARD.y + 0.6, BOARD.y - 0.6),
        rotation: Math.atan2(b.y - a.y, b.x - a.x),
        color: opts.mono ? 0x3f7fd8 : PLATE_PALETTE[(layer * 7 + 3) % PLATE_PALETTE.length],
        material: 'metal',
      };
      if (!perLayer.some((p) => aabbOverlaps(p, cand))) {
        perLayer.push(cand);
        plates.push(cand);
      }
    }
  }

  /* ----------------------------- screws ------------------------------- */

  const placed: { x: number; y: number; layer: number; plate: PlateDef }[] = [];
  const platesByLayer = new Map<number, PlateDef[]>();
  for (const p of plates) {
    const arr = platesByLayer.get(p.layer) ?? [];
    arr.push(p);
    platesByLayer.set(p.layer, arr);
  }

  /**
   * CONTRACT_V2 §2: two screws only need spacing when they can be reachable at
   * the same time, i.e. when neither is hidden under the other's plate.
   */
  const spacingOk = (x: number, y: number, plate: PlateDef): boolean => {
    for (const o of placed) {
      const dx = o.x - x;
      const dy = o.y - y;
      if (dx * dx + dy * dy >= SCREW_SPACING * SCREW_SPACING) continue;
      const hiddenUnderNew = o.layer < plate.layer && plateContainsWorldPoint(plate, o.x, o.y);
      const hiddenUnderOld = plate.layer < o.layer && plateContainsWorldPoint(o.plate, x, y);
      if (!hiddenUnderNew && !hiddenUnderOld) return false;
    }
    return true;
  };

  const maxPerPlate = Math.max(3, Math.ceil(target / Math.max(1, plates.length)) + 4);
  const order = [...plates].sort((a, b) => b.layer - a.layer || rng() - 0.5);
  const perPlateCount = new Map<number, number>();

  for (let pass = 0; pass < 6 && placed.length < target; pass++) {
    for (const p of order) {
      if (placed.length >= target) break;
      if ((perPlateCount.get(p.id) ?? 0) >= maxPerPlate) continue;
      const aabb = plateWorldAabb(p);
      let tries = 0;
      let added = 0;
      const want = pass === 0 ? 3 : 1;
      while (tries < 260 && added < want && placed.length < target) {
        tries++;
        const x = aabb.minX + rng() * (aabb.maxX - aabb.minX);
        const y = aabb.minY + rng() * (aabb.maxY - aabb.minY);
        if (!plateContainsWorldPoint(p, x, y)) continue;
        if (plateEdgeDistance(p, x, y) < SCREW_EDGE_MARGIN) continue;
        if (!spacingOk(x, y, p)) continue;
        placed.push({ x, y, layer: p.layer, plate: p });
        perPlateCount.set(p.id, (perPlateCount.get(p.id) ?? 0) + 1);
        added++;
      }
    }
  }

  // Every plate must carry at least one screw or it would drop immediately.
  const live = plates.filter((p) => (perPlateCount.get(p.id) ?? 0) > 0);
  const liveIds = new Set(live.map((p) => p.id));
  const keptPlates = plates.filter((p) => liveIds.has(p.id));
  const remap = new Map<number, number>();
  keptPlates.forEach((p, i) => remap.set(p.id, i));
  for (const p of keptPlates) p.id = remap.get(p.id)!;

  // Trim to a multiple of BOX_CAPACITY without emptying a plate.
  const counts = new Map<number, number>();
  for (const s of placed) counts.set(s.plate.id, (counts.get(s.plate.id) ?? 0) + 1);
  while (placed.length % BOX_CAPACITY !== 0) {
    const idx = placed.findIndex((s) => (counts.get(s.plate.id) ?? 0) > 1);
    if (idx < 0) break;
    counts.set(placed[idx].plate.id, counts.get(placed[idx].plate.id)! - 1);
    placed.splice(idx, 1);
  }

  const colors = ALL_COLORS.slice(0, Math.max(3, Math.min(8, colorCount)));
  const screws: ScrewDef[] = placed.map((s, i) => ({
    id: i,
    plateId: s.plate.id,
    x: s.x,
    y: s.y,
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
  // A few mystery screws on the deeper half of the stack.
  const layerOf = new Map<number, number>();
  for (const p of keptPlates) layerOf.set(p.id, p.layer);
  let mystery = 0;
  for (const s of screws) {
    if (mystery >= 8) break;
    if ((layerOf.get(s.plateId) ?? 0) >= 3 && Math.floor(s.id * 7919) % 11 === 0) {
      s.hidden = true;
      mystery++;
    }
  }

  return {
    level: opts.level ?? 900,
    seed: opts.seed ?? 0xbeef,
    plates: keptPlates,
    screws,
    boxQueue,
    activeBoxCount: opts.activeBoxCount ?? 3,
    traySlots: opts.traySlots ?? 6,
    colors,
    difficulty: 'extreme',
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** Quick stats for the harness readout / assertions. */
export function describeLevel(level: LevelDef): {
  screws: number;
  plates: number;
  layers: number;
  bottomLayerFraction: number;
  screwsPerLayer: number[];
} {
  const layerOf = new Map<number, number>();
  let maxLayer = 0;
  for (const p of level.plates) {
    layerOf.set(p.id, p.layer);
    maxLayer = Math.max(maxLayer, p.layer);
  }
  const perLayer = Array.from({ length: maxLayer + 1 }, () => 0);
  for (const s of level.screws) perLayer[layerOf.get(s.plateId) ?? 0]++;
  return {
    screws: level.screws.length,
    plates: level.plates.length,
    layers: maxLayer + 1,
    bottomLayerFraction: level.screws.length ? perLayer[0] / level.screws.length : 0,
    screwsPerLayer: perLayer,
  };
}

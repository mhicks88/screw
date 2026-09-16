/**
 * Geometric layout for generated levels: plates on layers (no same-layer
 * overlap, higher layers overlapping lower ones) and screw positions inside
 * plates with the required margins. Colours are assigned elsewhere.
 */
import type { PlateDef, PlateShapeKind, Vec2 } from './types';
import { Rng } from './rng';
import {
  plateContainsWorldPoint, plateEdgeDistance, plateWorldOutline, polygonAabb, polygonDistance, polygonsOverlap,
  shapeArea, type Aabb,
} from './geometry';
import { MIN_ARM_THICKNESS, capsuleShape, hexagonShape, lShape, makeShape, rectShape, ringShape, roundedRectShape } from './shapes';
import type { DifficultyParams } from './difficulty';

export const BOARD = { minX: -3, maxX: 3, minY: -4.2, maxY: 4.2 };
export const SCREW_EDGE_MARGIN = 0.45;
export const SCREW_SPACING = 0.9;
export const PLATE_GAP = 0.12;

export interface ScrewSpot { plateId: number; x: number; y: number }
export interface Layout { plates: PlateDef[]; screws: ScrewSpot[] }

const PLATE_COLORS = [
  0xf94144, 0xf3722c, 0xf8961e, 0xf9c74f, 0x90be6d, 0x43aa8b, 0x4d96ff, 0x9d4edd,
  0x48cae4, 0xff85a1, 0xffd166, 0x06d6a0, 0x8ecae6, 0xbc6c25, 0xe07a5f, 0x81b29a,
];

const ALL_KINDS: PlateShapeKind[] = [
  'rect', 'roundedRect', 'roundedRect', 'circle', 'L', 'T', 'triangle', 'hexagon', 'ring', 'cross', 'capsule', 'polygon',
];

function fitsBoard(a: Aabb): boolean {
  return a.minX >= BOARD.minX && a.maxX <= BOARD.maxX && a.minY >= BOARD.minY && a.maxY <= BOARD.maxY;
}

function pickRotation(kind: PlateShapeKind, rng: Rng): number {
  if (kind === 'circle' || kind === 'ring') return 0;
  const r = rng.next();
  if (r < 0.35) return rng.float(-0.12, 0.12);
  if (r < 0.6) return Math.PI / 2 + rng.float(-0.12, 0.12);
  return rng.float(0, Math.PI * 2);
}

/** Pyramid distribution of plate counts per layer (layer 0 gets the most, at most 4 tiles). */
export function layerCounts(plates: number, layers: number): number[] {
  layers = Math.max(1, Math.min(layers, plates));
  const weights = Array.from({ length: layers }, (_, l) => layers - l + (l === 0 ? 1 : 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.max(1, Math.floor((plates * w) / wsum)));
  let sum = counts.reduce((a, b) => a + b, 0);
  for (let l = 0; sum < plates; l = (l + 1) % layers) { counts[l]++; sum++; }
  while (sum > plates) {
    const l = counts.indexOf(Math.max(...counts));
    counts[l]--;
    sum--;
  }
  if (layers > 1) {
    while (counts[0] > 4) {
      counts[0]--;
      counts[1]++;
    }
  }
  return counts;
}

interface Tile { minX: number; minY: number; maxX: number; maxY: number }

/** Guillotine partition of the board into `n` tiles separated by PLATE_GAP. */
function partitionBoard(n: number, rng: Rng): Tile[] {
  const inset = 0.08;
  const tiles: Tile[] = [{ minX: BOARD.minX + inset, minY: BOARD.minY + inset, maxX: BOARD.maxX - inset, maxY: BOARD.maxY - inset }];
  while (tiles.length < n) {
    // Split the largest tile along its longer axis.
    let bi = 0, bestArea = -1;
    tiles.forEach((t, i) => {
      const a = (t.maxX - t.minX) * (t.maxY - t.minY);
      if (a > bestArea) { bestArea = a; bi = i; }
    });
    const t = tiles[bi];
    const w = t.maxX - t.minX, h = t.maxY - t.minY;
    const ratio = rng.float(0.38, 0.62);
    const g = PLATE_GAP / 2 + 0.04;
    if (h >= w) {
      const y = t.minY + h * ratio;
      tiles.splice(bi, 1, { ...t, maxY: y - g }, { ...t, minY: y + g });
    } else {
      const x = t.minX + w * ratio;
      tiles.splice(bi, 1, { ...t, maxX: x - g }, { ...t, minX: x + g });
    }
  }
  return tiles;
}

/** Turn a board tile into a big base plate (mostly rounded rectangles). */
function tilePlate(tile: Tile, id: number, color: number, rng: Rng): PlateDef {
  const hw = (tile.maxX - tile.minX) / 2, hh = (tile.maxY - tile.minY) / 2;
  const cx = (tile.minX + tile.maxX) / 2, cy = (tile.minY + tile.maxY) / 2;
  const r = rng.next();
  const squarish = Math.min(hw, hh) / Math.max(hw, hh) > 0.75;
  let shape;
  let rotation = 0;
  if (r < 0.45) shape = roundedRectShape(hw, hh, rng.float(0.25, 0.5));
  else if (r < 0.6) shape = rectShape(hw, hh);
  else if (r < 0.75) {
    shape = lShape(2 * hw, 2 * hh, Math.max(MIN_ARM_THICKNESS, Math.min(hw, hh) * rng.float(1.1, 1.4)));
    rotation = rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    if (rotation === Math.PI / 2 || rotation === -Math.PI / 2) {
      // swap extents so the rotated L still fills the tile
      shape = lShape(2 * hh, 2 * hw, Math.max(MIN_ARM_THICKNESS, Math.min(hw, hh) * rng.float(1.1, 1.4)));
    }
  } else if (r < 0.85 && !squarish) {
    const rad = Math.min(hw, hh);
    shape = capsuleShape(Math.max(hw, hh) - rad, rad);
    rotation = hh > hw ? Math.PI / 2 : 0;
  } else if (squarish && r < 0.93) shape = hexagonShape(Math.min(hw, hh) * 1.12);
  else if (squarish) shape = ringShape(Math.min(hw, hh), Math.max(0.3, Math.min(hw, hh) - MIN_ARM_THICKNESS - 0.2));
  else shape = roundedRectShape(hw, hh, rng.float(0.25, 0.5));
  return { id, layer: 0, shape, x: cx, y: cy, rotation, color, material: rng.chance(0.85) ? 'plastic' : 'wood' };
}

/**
 * Place plates bottom-up. Layer 0 is a guillotine tiling of the board with big
 * base plates (that is where most screws live); higher-layer plates are smaller
 * free shapes that (usually) overlap a lower plate so they block screws.
 */
export function placePlates(params: DifficultyParams, rng: Rng): PlateDef[] {
  const counts = layerCounts(params.plates, params.layers);
  const plates: PlateDef[] = [];
  const outlines: Vec2[][] = [];
  const colors = rng.shuffle([...PLATE_COLORS]);
  const boardW = BOARD.maxX - BOARD.minX, boardH = BOARD.maxY - BOARD.minY;
  for (const tile of partitionBoard(counts[0], rng)) {
    const p = tilePlate(tile, plates.length, colors[plates.length % colors.length], rng);
    const outline = plateWorldOutline(p);
    if (!fitsBoard(polygonAabb(outline))) continue;
    plates.push(p);
    outlines.push(outline);
  }
  counts.forEach((count, layer) => {
    if (layer === 0) return;
    for (let i = 0; i < count; i++) {
      const kind = rng.pick(ALL_KINDS);
      const sizeScale = Math.max(0.8, 1.25 - (layer - 1) * 0.1);
      const size0 = rng.float(params.plateSizeMin, params.plateSizeMax) * sizeScale;
      const rotation = pickRotation(kind, rng);
      const wantOverlap = rng.chance(0.85);
      let placed: PlateDef | undefined;
      let placedOutline: Vec2[] | undefined;
      for (let shrink = 0; shrink < 5 && !placed; shrink++) {
        const shape = makeShape(kind, size0 * Math.pow(0.85, shrink), rng);
        const base: PlateDef = {
          id: plates.length, layer, shape, x: 0, y: 0, rotation,
          color: colors[plates.length % colors.length],
          material: rng.chance(0.85) ? 'plastic' : rng.chance(0.5) ? 'wood' : 'metal',
        };
        const lb = polygonAabb(plateWorldOutline(base));
        const hw = (lb.maxX - lb.minX) / 2, hh = (lb.maxY - lb.minY) / 2;
        const cx = (lb.maxX + lb.minX) / 2, cy = (lb.maxY + lb.minY) / 2;
        if (hw * 2 > boardW || hh * 2 > boardH) continue;
        for (let attempt = 0; attempt < 120 && !placed; attempt++) {
          const x = rng.float(BOARD.minX + hw, BOARD.maxX - hw) - cx;
          const y = rng.float(BOARD.minY + hh, BOARD.maxY - hh) - cy;
          const cand: PlateDef = { ...base, x, y };
          const outline = plateWorldOutline(cand);
          if (!fitsBoard(polygonAabb(outline))) continue;
          let ok = true;
          let overlapsLower = false;
          for (let k = 0; k < plates.length && ok; k++) {
            if (plates[k].layer === layer) {
              if (polygonDistance(outlines[k], outline) < PLATE_GAP) ok = false;
            } else if (plates[k].layer < layer && !overlapsLower && polygonsOverlap(outlines[k], outline)) {
              overlapsLower = true;
            }
          }
          if (!ok) continue;
          if (wantOverlap && !overlapsLower && attempt < 80) continue;
          placed = cand;
          placedOutline = outline;
        }
      }
      if (placed && placedOutline) {
        plates.push(placed);
        outlines.push(placedOutline);
      }
    }
  });
  // Renumber layers compactly (some layers may have ended up empty).
  const used = [...new Set(plates.map((p) => p.layer))].sort((a, b) => a - b);
  for (const p of plates) p.layer = used.indexOf(p.layer);
  return plates;
}

/** One global jittered hex lattice for the whole board (pitch >= SCREW_SPACING). */
function boardLattice(rng: Rng): Vec2[] {
  const pitch = rng.float(SCREW_SPACING + 0.02, SCREW_SPACING + 0.18);
  const rowH = pitch * 0.866;
  const angle = rng.pick([0, 0, Math.PI / 6, Math.PI / 2, rng.float(0, Math.PI)]);
  const c = Math.cos(angle), sn = Math.sin(angle);
  const ox = rng.float(0, pitch), oy = rng.float(0, rowH);
  const radius = Math.hypot(BOARD.maxX - BOARD.minX, BOARD.maxY - BOARD.minY) / 2 + pitch;
  const rows = Math.ceil(radius / rowH), cols = Math.ceil(radius / pitch);
  const out: Vec2[] = [];
  for (let r = -rows; r <= rows; r++) {
    for (let q = -cols; q <= cols; q++) {
      const lx = q * pitch + (r & 1 ? pitch / 2 : 0) + ox - pitch / 2;
      const ly = r * rowH + oy - rowH / 2;
      const x = lx * c - ly * sn;
      const y = lx * sn + ly * c;
      if (x < BOARD.minX || x > BOARD.maxX || y < BOARD.minY || y > BOARD.maxY) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** Lattice points inside a plate (margin respected), in random order. */
function plateCandidates(p: PlateDef, lattice: readonly Vec2[], rng: Rng): Vec2[] {
  const bb = polygonAabb(plateWorldOutline(p));
  const out: Vec2[] = [];
  for (const c of lattice) {
    if (c.x < bb.minX + SCREW_EDGE_MARGIN || c.x > bb.maxX - SCREW_EDGE_MARGIN) continue;
    if (c.y < bb.minY + SCREW_EDGE_MARGIN || c.y > bb.maxY - SCREW_EDGE_MARGIN) continue;
    if (!plateContainsWorldPoint(p, c.x, c.y)) continue;
    if (plateEdgeDistance(p, c.x, c.y) < SCREW_EDGE_MARGIN) continue;
    out.push(c);
  }
  return rng.shuffle(out);
}

/**
 * Place `target` screws over the plates: at least one per plate, the rest by
 * area, using one jittered hex lattice for the board (so screws sit in tidy rows)
 * with the edge margin and the global spacing. Plates that cannot hold a
 * single screw are removed. Result may hold fewer than `target` screws.
 */
export function placeScrews(plates: PlateDef[], target: number, rng: Rng): Layout {
  const spots: ScrewSpot[] = [];
  const areas = plates.map((p) => shapeArea(p.shape));
  const totalArea = areas.reduce((a, b) => a + b, 0);
  const quota = plates.map((_, i) => Math.max(1, Math.round((target * areas[i]) / totalArea)));
  let sum = quota.reduce((a, b) => a + b, 0);
  while (sum > target) {
    const i = quota.indexOf(Math.max(...quota));
    if (quota[i] <= 1) break;
    quota[i]--;
    sum--;
  }
  const spacing2 = SCREW_SPACING * SCREW_SPACING;
  const tooClose = (x: number, y: number) => spots.some((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < spacing2);
  const lattice = boardLattice(rng);
  const cands = plates.map((p) => plateCandidates(p, lattice, rng));
  const tryPlace = (i: number): boolean => {
    const list = cands[i];
    while (list.length) {
      const c = list.pop()!;
      if (tooClose(c.x, c.y)) continue;
      spots.push({ plateId: plates[i].id, x: c.x, y: c.y });
      return true;
    }
    return false;
  };
  const counts = plates.map(() => 0);
  // Pass 1: one screw per plate (top layers first so they always get one).
  const order = plates.map((_, i) => i).sort((a, b) => plates[b].layer - plates[a].layer);
  for (const i of order) if (tryPlace(i)) counts[i]++;
  // Pass 2: fill quotas.
  for (const i of order) while (counts[i] < quota[i] && tryPlace(i)) counts[i]++;
  // Pass 3: spread any shortfall over plates that still have room (round-robin).
  let placedTotal = counts.reduce((a, b) => a + b, 0);
  for (let round = 0; round < 40 && placedTotal < target; round++) {
    let any = false;
    for (const i of order) {
      if (placedTotal >= target) break;
      if (tryPlace(i)) { counts[i]++; placedTotal++; any = true; }
    }
    if (!any) break;
  }
  const keep = plates.filter((_, i) => counts[i] > 0);
  const kept = new Set(keep.map((p) => p.id));
  const screws = spots.filter((s) => kept.has(s.plateId));
  return { plates: keep, screws };
}

/** Remove screws (never the last one of a plate) until the count is a multiple of `m`. */
export function trimToMultiple(layout: Layout, m: number, rng: Rng): Layout {
  const screws = [...layout.screws];
  const perPlate = new Map<number, number>();
  for (const s of screws) perPlate.set(s.plateId, (perPlate.get(s.plateId) ?? 0) + 1);
  let guard = 0;
  while (screws.length % m !== 0 && guard++ < 100) {
    const richest = [...perPlate.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
    if (richest.length === 0) break;
    const pid = rng.pick(richest.slice(0, Math.min(3, richest.length)))[0];
    const idx = screws.map((s, i) => (s.plateId === pid ? i : -1)).filter((i) => i >= 0);
    screws.splice(rng.pick(idx), 1);
    perPlate.set(pid, perPlate.get(pid)! - 1);
  }
  return { plates: layout.plates, screws };
}

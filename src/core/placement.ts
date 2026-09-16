/**
 * Level geometry: the TOWER ARCHITECTURE of CONTRACT_V2 §4.
 *
 * The board is split into 2-4 overlapping tower footprints; every tower stacks
 * a plate on most of the layers in its span, each plate substantially — but not
 * exactly — covering the one below, with occasional "bridge" plates spanning
 * two towers so the towers interlock instead of forming disjoint stacks. Screws
 * are then spread with a roughly uniform per-layer quota (never bottom-heavy)
 * on per-layer jittered lattices, so screws do not line up into vertical
 * columns. The spacing rule itself lives in ./spacing.
 */
import type { PlateDef, PlateShapeKind, Vec2 } from './types';
import { Rng } from './rng';
import {
  aabbsOverlap, plateContainsWorldPoint, plateEdgeDistance, plateWorldOutline, polygonAabb, polygonDistance,
  shapeArea, type Aabb,
} from './geometry';
import { fittedShape } from './shapes';
import type { DifficultyParams } from './difficulty';
import { BOARD, PLATE_GAP, SCREW_EDGE_MARGIN, SCREW_SPACING, ScrewIndex, type ScrewSpot } from './spacing';

export {
  BOARD, PLATE_GAP, SCREW_EDGE_MARGIN, SCREW_SPACING, ScrewIndex, coverageExempt, pairSpacingOk, spacingViolations,
  type ScrewSpot,
} from './spacing';

export interface Layout { plates: PlateDef[]; screws: ScrewSpot[] }

const PLATE_COLORS = [
  0xf94144, 0xf3722c, 0xf8961e, 0xf9c74f, 0x90be6d, 0x43aa8b, 0x4d96ff, 0x9d4edd,
  0x48cae4, 0xff85a1, 0xffd166, 0x06d6a0, 0x8ecae6, 0xbc6c25, 0xe07a5f, 0x81b29a,
];

/** Blocky shapes that fill their footprint (used for most plates). */
const BULK_KINDS: PlateShapeKind[] = ['roundedRect', 'roundedRect', 'rect', 'hexagon', 'capsule', 'polygon', 'circle'];
/** Shapes with holes / concavities — visual variety, used more sparingly. */
const FANCY_KINDS: PlateShapeKind[] = ['L', 'T', 'cross', 'ring', 'triangle'];

/* ---------------------------------------------------------- tower layout */

interface Cell { cx: number; cy: number; hw: number; hh: number }

const BOARD_HX = (BOARD.maxX - BOARD.minX) / 2;
const BOARD_HY = (BOARD.maxY - BOARD.minY) / 2;

function fitsBoard(a: Aabb): boolean {
  return a.minX >= BOARD.minX && a.maxX <= BOARD.maxX && a.minY >= BOARD.minY && a.maxY <= BOARD.maxY;
}

function bands(n: number, horizontal: boolean): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    if (horizontal) out.push({ cx: 0, cy: BOARD.minY + t * 2 * BOARD_HY, hw: BOARD_HX, hh: BOARD_HY / n });
    else out.push({ cx: BOARD.minX + t * 2 * BOARD_HX, cy: 0, hw: BOARD_HX / n, hh: BOARD_HY });
  }
  return out;
}

/**
 * Split the board into `count` tower footprints. Several patterns per count so
 * levels do not all look the same; the plates placed inside them are smaller
 * than their cell and jitter well past its edge, which is what makes towers
 * overlap and interlock.
 */
export function boardCells(count: number, rng: Rng): Cell[] {
  if (count <= 1) return [{ cx: 0, cy: 0, hw: BOARD_HX, hh: BOARD_HY }];
  if (count === 2) return rng.chance(0.75) ? bands(2, true) : bands(2, false);
  if (count === 3) {
    const r = rng.next();
    if (r < 0.5) return bands(3, true);
    const topFirst = r < 0.75;
    const y = topFirst ? 1 : -1;
    return [
      { cx: -BOARD_HX / 2, cy: (y * BOARD_HY) / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
      { cx: BOARD_HX / 2, cy: (y * BOARD_HY) / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
      { cx: 0, cy: (-y * BOARD_HY) / 2, hw: BOARD_HX, hh: BOARD_HY / 2 },
    ];
  }
  if (rng.chance(0.65)) {
    return [
      { cx: -BOARD_HX / 2, cy: BOARD_HY / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
      { cx: BOARD_HX / 2, cy: BOARD_HY / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
      { cx: -BOARD_HX / 2, cy: -BOARD_HY / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
      { cx: BOARD_HX / 2, cy: -BOARD_HY / 2, hw: BOARD_HX / 2, hh: BOARD_HY / 2 },
    ];
  }
  return bands(4, true);
}

interface Slot { tower: number; cell: Cell; fill: number }

/** ~14 sample points inside a plate, used to score how much a candidate covers it. */
function plateSamples(p: PlateDef): Vec2[] {
  const bb = polygonAabb(plateWorldOutline(p));
  const out: Vec2[] = [];
  const nx = 5, ny = 5;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = bb.minX + ((i + 0.5) / nx) * (bb.maxX - bb.minX);
      const y = bb.minY + ((j + 0.5) / ny) * (bb.maxY - bb.minY);
      if (plateContainsWorldPoint(p, x, y)) out.push({ x, y });
    }
  }
  if (out.length === 0) out.push({ x: p.x, y: p.y });
  return out;
}

interface Placed {
  plate: PlateDef; outline: Vec2[]; aabb: Aabb; samples: Vec2[];
  /** Protected plates must keep most of their body uncovered (see placePlates). */
  protect: boolean;
  /** For protected plates: which of their sample points are already covered. */
  covered?: boolean[];
}

function pickKind(layer: number, rng: Rng): PlateShapeKind {
  const fancy = layer === 0 ? 0.12 : 0.28;
  return rng.chance(fancy) ? rng.pick(FANCY_KINDS) : rng.pick(BULK_KINDS);
}

/**
 * Presence matrix [tower][layer]: which towers own a plate on which layer.
 * Towers are staggered (different base/top layers) so the stack is not a set of
 * identical columns, and layers are skipped at random to hit the plate budget.
 */
function towerPresence(towers: number, layers: number, maxPlates: number, rng: Rng): boolean[][] {
  const stagger = Math.max(0, Math.floor(layers * 0.28));
  const base: number[] = [];
  const top: number[] = [];
  for (let t = 0; t < towers; t++) {
    let b = rng.chance(0.5) ? 0 : rng.int(0, stagger);
    let e = rng.chance(0.5) ? layers - 1 : layers - 1 - rng.int(0, stagger);
    if (e - b < Math.min(1, layers - 1)) { b = 0; e = layers - 1; }
    base.push(b);
    top.push(e);
  }
  // Somebody must reach the floor and somebody the ceiling.
  base[rng.int(0, towers - 1)] = 0;
  top[rng.int(0, towers - 1)] = layers - 1;

  const span = base.reduce((n, b, t) => n + (top[t] - b + 1), 0);
  const skip = span > maxPlates ? Math.min(0.45, 1 - maxPlates / span) : 0.1;
  const present: boolean[][] = [];
  for (let t = 0; t < towers; t++) {
    const row: boolean[] = new Array(layers).fill(false);
    for (let l = base[t]; l <= top[t]; l++) row[l] = !rng.chance(skip);
    if (!row.some(Boolean)) row[base[t]] = true;
    present.push(row);
  }
  for (let l = 0; l < layers; l++) {
    if (present.some((row) => row[l])) continue;
    const owners = present.map((_, t) => t).filter((t) => base[t] <= l && l <= top[t]);
    present[owners.length ? rng.pick(owners) : rng.int(0, towers - 1)][l] = true;
  }
  return present;
}

/**
 * Plate layout: 2-4 interlocking towers (CONTRACT_V2 §4). Returns plates sorted
 * by layer; layers are compacted so `layer` is a dense stacking index.
 */
export function placePlates(params: DifficultyParams, rng: Rng): PlateDef[] {
  const towers = Math.max(2, Math.min(4, params.towers));
  const layers = Math.max(1, params.layers);
  const cells = boardCells(towers, rng);
  const present = towerPresence(towers, layers, params.plates, rng);
  const colors = rng.shuffle([...PLATE_COLORS]);
  const placed: Placed[] = [];
  const byLayer: Placed[][] = Array.from({ length: layers }, () => []);
  const protectedPlates: Placed[] = [];
  const protectedLayer: boolean[] = new Array(layers).fill(false);
  const protectBudget = Math.max(2, Math.round(layers * 0.3));

  for (let layer = 0; layer < layers; layer++) {
    const owners = present.map((_, t) => t).filter((t) => present[t][layer]);
    const slots: Slot[] = [];
    // Bridge plate: one wide plate spanning two neighbouring towers, so plates
    // genuinely tie the towers together instead of forming disjoint stacks.
    let bridged: number[] = [];
    if (owners.length >= 2 && layer > 0 && rng.chance(0.3)) {
      const a = rng.int(0, owners.length - 1);
      let b = (a + 1) % owners.length;
      if (owners.length > 2 && rng.chance(0.5)) b = (a + owners.length - 1) % owners.length;
      const ca = cells[owners[a]];
      const cb = cells[owners[b]];
      const minX = Math.min(ca.cx - ca.hw, cb.cx - cb.hw), maxX = Math.max(ca.cx + ca.hw, cb.cx + cb.hw);
      const minY = Math.min(ca.cy - ca.hh, cb.cy - cb.hh), maxY = Math.max(ca.cy + ca.hh, cb.cy + cb.hh);
      slots.push({
        tower: owners[a], fill: rng.float(0.52, 0.66),
        cell: { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2 },
      });
      bridged = [owners[a], owners[b]];
    }
    for (const t of owners) {
      if (bridged.includes(t)) continue;
      slots.push({ tower: t, cell: cells[t], fill: rng.float(0.78, 0.92) });
    }

    for (const slot of rng.shuffle(slots)) {
      const material = rng.chance(0.82) ? 'plastic' : rng.chance(0.55) ? 'wood' : 'metal';
      const color = colors[(slot.tower * 5 + layer * 3) % colors.length];
      let best: Placed | undefined;
      let bestScore = -Infinity;
      for (let shrink = 0; shrink < 5 && !best; shrink++) {
        const kind = shrink === 0 ? pickKind(layer, rng) : rng.pick(BULK_KINDS);
        const f = slot.fill * Math.pow(0.9, shrink);
        const hw = slot.cell.hw * f;
        const hh = slot.cell.hh * f;
        const slackX = slot.cell.hw - hw;
        const slackY = slot.cell.hh - hh;
        const shape = fittedShape(kind, hw, hh, rng);
        const rotAmp = Math.min(0.22, 0.34 / Math.max(hw, hh));
        // Try generous jitter first (that is what interlocks the towers), then
        // tighter placements, and only shrink the plate as a last resort — a
        // shrunken plate holds far fewer screws.
        for (let attempt = 0; attempt < 30; attempt++) {
          const jitter = attempt < 12 ? 1.6 : attempt < 22 ? 0.9 : 0.35;
          const cand: PlateDef = {
            id: placed.length, layer, shape,
            x: slot.cell.cx + rng.float(-1, 1) * slackX * jitter,
            y: slot.cell.cy + rng.float(-1, 1) * slackY * jitter,
            rotation: rng.float(-rotAmp, rotAmp), color, material,
          };
          const outline = plateWorldOutline(cand);
          const aabb = polygonAabb(outline);
          if (!fitsBoard(aabb)) continue;
          let clash = false;
          for (const q of byLayer[layer]) {
            if (!aabbsOverlap(aabb, q.aabb, PLATE_GAP)) continue;
            if (polygonDistance(q.outline, outline) < PLATE_GAP) { clash = true; break; }
          }
          if (clash) continue;
          if (smothers(aabb, cand, protectedPlates)) continue;
          let score = coverageScore(aabb, cand, byLayer, layer);
          if (layer > 0 && score <= 0) continue;
          // Without this the best-coverage candidate always drifts towards the
          // middle of the board, plates crowd and later slots find no room.
          score -= 0.5 * Math.hypot((cand.x - slot.cell.cx) / Math.max(0.25, slackX),
            (cand.y - slot.cell.cy) / Math.max(0.25, slackY));
          if (score > bestScore) { bestScore = score; best = { plate: cand, outline, aabb, samples: [], protect: false }; }
        }
      }
      if (!best) continue;
      smothers(best.aabb, best.plate, protectedPlates, true);
      best.samples = plateSamples(best.plate);
      placed.push(best);
      byLayer[layer].push(best);
      // Keep a handful of plates spread through the stack mostly uncovered, so
      // the level always offers several plates that can be cleared right away
      // (CONTRACT_V2 §5 — this is what stops the level being one peel order).
      if (layer < layers - 1 && protectedPlates.length < protectBudget && !protectedLayer[layer] && rng.chance(0.55)) {
        best.protect = true;
        best.covered = new Array(best.samples.length).fill(false);
        protectedLayer[layer] = true;
        protectedPlates.push(best);
      }
    }

    // A layer with no plate at all would collapse the stack: fall back to a
    // plain plate in a random cell, ignoring the coverage/protection scoring.
    if (byLayer[layer].length === 0) {
      const cell = cells[owners.length ? rng.pick(owners) : rng.int(0, towers - 1)];
      for (let shrink = 0; shrink < 5 && byLayer[layer].length === 0; shrink++) {
        const f = 0.8 * Math.pow(0.85, shrink);
        const shape = fittedShape('roundedRect', cell.hw * f, cell.hh * f, rng);
        for (let attempt = 0; attempt < 20; attempt++) {
          const cand: PlateDef = {
            id: placed.length, layer, shape,
            x: cell.cx + rng.float(-1, 1) * cell.hw * (1 - f),
            y: cell.cy + rng.float(-1, 1) * cell.hh * (1 - f),
            rotation: 0, color: colors[(layer * 3) % colors.length], material: 'plastic',
          };
          const outline = plateWorldOutline(cand);
          const aabb = polygonAabb(outline);
          if (!fitsBoard(aabb)) continue;
          const p: Placed = { plate: cand, outline, aabb, samples: plateSamples(cand), protect: false };
          placed.push(p);
          byLayer[layer].push(p);
          break;
        }
      }
    }
  }

  const plates = placed.map((p, i) => ({ ...p.plate, id: i }));
  return compactLayers(plates);
}

/**
 * A candidate may not bury a protected plate: counting everything already
 * stacked above it, more than half of the protected plate must stay clear.
 * With `commit` the coverage is recorded (the candidate was accepted).
 */
const MAX_PROTECTED_COVER = 0.6;

function smothers(aabb: Aabb, cand: PlateDef, guarded: readonly Placed[], commit = false): boolean {
  const hits: [Placed, number[]][] = [];
  for (const q of guarded) {
    if (q.plate.layer >= cand.layer) continue;
    if (!aabbsOverlap(aabb, q.aabb)) continue;
    const mask = q.covered!;
    const fresh: number[] = [];
    let total = 0;
    for (let i = 0; i < q.samples.length; i++) {
      if (mask[i]) { total++; continue; }
      if (plateContainsWorldPoint(cand, q.samples[i].x, q.samples[i].y)) { fresh.push(i); total++; }
    }
    if (total / q.samples.length > MAX_PROTECTED_COVER) return true;
    if (fresh.length) hits.push([q, fresh]);
  }
  if (commit) for (const [q, fresh] of hits) for (const i of fresh) q.covered![i] = true;
  return false;
}

/**
 * How well a candidate plate covers the two layers directly below it. Covering
 * a plate ALMOST completely is penalised: the point is that screws hide, not
 * that whole plates become unreachable (that is what makes a level linear).
 */
function coverageScore(aabb: Aabb, cand: PlateDef, byLayer: Placed[][], layer: number): number {
  let score = 0;
  let touched = 0;
  for (let l = Math.max(0, layer - 2); l < layer; l++) {
    const weight = l === layer - 1 ? 1 : 0.45;
    for (const q of byLayer[l]) {
      if (!aabbsOverlap(aabb, q.aabb)) continue;
      let hit = 0;
      for (const s of q.samples) if (plateContainsWorldPoint(cand, s.x, s.y)) hit++;
      if (hit === 0) continue;
      const frac = hit / q.samples.length;
      score += weight * (frac <= 0.8 ? frac : 0.8 - (frac - 0.8) * 2.5);
      if (frac >= 0.12) touched++;
    }
  }
  return score + touched * 0.35;
}

/** Renumber layers so they are dense 0..k-1 (order preserved). */
export function compactLayers(plates: PlateDef[]): PlateDef[] {
  const used = [...new Set(plates.map((p) => p.layer))].sort((a, b) => a - b);
  for (const p of plates) p.layer = used.indexOf(p.layer);
  return plates;
}

/* -------------------------------------------------------------- screws */


/** Hex lattice over the board: pitch/angle per layer, offset per variant. */
interface LatticeSpec { pitch: number; rowH: number; angle: number; ox: number; oy: number }

function latticeSpecs(rng: Rng, variants: number): LatticeSpec[] {
  const pitch = rng.float(SCREW_SPACING + 0.005, SCREW_SPACING + 0.075);
  const rowH = pitch * 0.87;
  const angle = rng.pick([0, 0, 0, Math.PI / 6, Math.PI / 2, rng.float(0, Math.PI)]);
  return Array.from({ length: variants }, () => ({ pitch, rowH, angle, ox: rng.float(0, pitch), oy: rng.float(0, rowH) }));
}

function latticePoints(spec: LatticeSpec): Vec2[] {
  const { pitch, rowH, angle, ox, oy } = spec;
  const c = Math.cos(angle), sn = Math.sin(angle);
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

function pointsInPlate(p: PlateDef, bb: Aabb, lattice: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const c of lattice) {
    if (c.x < bb.minX + SCREW_EDGE_MARGIN || c.x > bb.maxX - SCREW_EDGE_MARGIN) continue;
    if (c.y < bb.minY + SCREW_EDGE_MARGIN || c.y > bb.maxY - SCREW_EDGE_MARGIN) continue;
    if (!plateContainsWorldPoint(p, c.x, c.y)) continue;
    if (plateEdgeDistance(p, c.x, c.y) < SCREW_EDGE_MARGIN) continue;
    out.push(c);
  }
  return out;
}

/**
 * Lattice points that fit inside a plate with the edge margin, shuffled. All
 * plates on a layer share the lattice pitch and angle (so rows read as rows),
 * but each plate keeps the phase that fits the most screws — plates are small
 * relative to the pitch, so the phase is worth 30-50% of the capacity.
 */
function plateCandidates(p: PlateDef, bb: Aabb, variants: readonly Vec2[][], rng: Rng): Vec2[] {
  let best: Vec2[] = [];
  for (const lattice of variants) {
    const pts = pointsInPlate(p, bb, lattice);
    if (pts.length > best.length) best = pts;
  }
  return rng.shuffle(best);
}

/**
 * Spread `target` screws over the plates with a roughly uniform per-layer quota
 * (CONTRACT_V2 §4: never bottom-heavy), one screw per plate first, then quota,
 * then a round-robin mop-up. Spacing uses the coverage-exempt rule (§2), so
 * screws hidden under a higher plate may sit as close together as they like.
 */
export function placeScrews(plates: PlateDef[], target: number, rng: Rng, exposedTarget?: number): Layout {
  const layers = [...new Set(plates.map((p) => p.layer))].sort((a, b) => a - b);
  const layerOf = new Map(layers.map((l, i) => [l, i]));
  const idxByLayer: number[][] = layers.map(() => []);
  plates.forEach((p, i) => idxByLayer[layerOf.get(p.layer)!].push(i));

  const outlines = plates.map(plateWorldOutline);
  const aabbs = outlines.map(polygonAabb);
  const areas = plates.map((p) => shapeArea(p.shape));
  // Rough capacity of a plate: usable area (after the edge margin) / lattice cell.
  const cellArea = SCREW_SPACING * SCREW_SPACING * 0.87;
  const capacity = plates.map((p, i) => {
    const bb = aabbs[i];
    const shrink = Math.max(0.15, 1 - (2 * SCREW_EDGE_MARGIN) / Math.max(0.5, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY)));
    return Math.max(1, Math.floor((areas[i] * shrink * shrink) / cellArea));
  });

  // Uniform per-layer quota, clipped by capacity; the slack rolls onwards.
  const layerCap = idxByLayer.map((ids) => ids.reduce((a, i) => a + capacity[i], 0));
  const quotaLayer = new Array(layers.length).fill(0);
  let left = target;
  for (let pass = 0; pass < 6 && left > 0; pass++) {
    const open = layers.map((_, l) => l).filter((l) => quotaLayer[l] < layerCap[l]);
    if (open.length === 0) break;
    const share = Math.max(1, Math.floor(left / open.length));
    for (const l of open) {
      if (left <= 0) break;
      const add = Math.min(share, layerCap[l] - quotaLayer[l], left);
      quotaLayer[l] += add;
      left -= add;
    }
  }

  // Inside a layer, split by plate area (every plate gets at least one).
  const quota = new Array(plates.length).fill(0);
  idxByLayer.forEach((ids, l) => {
    const total = ids.reduce((a, i) => a + areas[i], 0) || 1;
    let rest = quotaLayer[l];
    for (const i of ids) {
      const want = Math.min(capacity[i], Math.max(1, Math.round((quotaLayer[l] * areas[i]) / total)));
      quota[i] = Math.min(want, Math.max(1, rest));
      rest -= quota[i];
    }
    for (let k = 0; k < ids.length && rest > 0; k++) {
      const i = ids[k];
      const add = Math.min(rest, capacity[i] - quota[i]);
      if (add > 0) { quota[i] += add; rest -= add; }
    }
  });

  // Which higher plates can possibly cover a point of plate i (AABB pre-filter).
  const above: number[][] = plates.map((p, i) => plates
    .map((_, j) => j)
    .filter((j) => plates[j].layer > p.layer && aabbsOverlap(aabbs[i], aabbs[j])));
  const isCovered = (i: number, x: number, y: number): boolean => {
    for (const j of above[i]) {
      const a = aabbs[j];
      if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) continue;
      if (plateContainsWorldPoint(plates[j], x, y)) return true;
    }
    return false;
  };

  const LATTICE_VARIANTS = 6;
  const lattices = layers.map(() => latticeSpecs(rng, LATTICE_VARIANTS).map(latticePoints));
  const openList: Vec2[][] = [];   // candidate points reachable from the start
  const hiddenList: Vec2[][] = []; // candidate points that begin under a plate
  plates.forEach((p, i) => {
    const open: Vec2[] = [];
    const hidden: Vec2[] = [];
    for (const c of plateCandidates(p, aabbs[i], lattices[layerOf.get(p.layer)!], rng)) {
      (isCovered(i, c.x, c.y) ? hidden : open).push(c);
    }
    openList.push(open);
    hiddenList.push(hidden);
  });

  /*
   * Non-linearity (CONTRACT_V2 §5) is decided here.
   *
   * Over a whole play-through the mean reachable count equals the mean "lead"
   * of the reveal schedule over the removal schedule (one screw leaves per
   * step), so a level is linear exactly when screws are revealed just in time.
   * Scattering one exposed screw over every plate does NOT help: no plate can
   * be emptied, nothing drops, and the initial burst simply drains away.
   *
   * What works is to pick a BUDGET of whole plates — spread over different
   * layers — and place all of their screws on the part of the plate that is not
   * covered from above. Those plates are clearable from the first move, so
   * several independent peel chains run at once, plate drops keep arriving, and
   * the reachable set keeps a standing backlog instead of collapsing to one
   * forced tap. The budget is an absolute count, so the number of screws visible
   * at once stays in the 15-25 range even on a 150-screw level.
   */
  const topLayer = layers.length - 1;
  const wantOpen = exposedTarget ?? Math.min(24, Math.max(7, Math.round(target * 0.38)));
  const openPlate: boolean[] = new Array(plates.length).fill(false);
  let budget = wantOpen;
  for (const i of idxByLayer[topLayer]) { openPlate[i] = true; budget -= quota[i]; }
  const layerOrder = rng.shuffle(layers.map((_, l) => l).filter((l) => l !== topLayer));
  for (let k = 0, li = 0; budget > 0 && k < plates.length * 3 && layerOrder.length; k++, li++) {
    const l = layerOrder[li % layerOrder.length];
    const choices = idxByLayer[l].filter((i) => !openPlate[i]
      && quota[i] <= budget + 2
      && openList[i].length >= Math.max(1, Math.ceil(quota[i] * 0.8)));
    if (choices.length === 0) continue;
    const i = rng.pick(choices);
    openPlate[i] = true;
    budget -= quota[i];
  }

  const index = new ScrewIndex(plates);
  const spots: ScrewSpot[] = [];
  const counts = plates.map(() => 0);
  const take = (i: number, list: Vec2[]): boolean => {
    while (list.length) {
      const c = list.pop()!;
      if (!index.canPlace(i, c.x, c.y)) continue;
      index.add(i, c.x, c.y);
      spots.push({ plateId: plates[i].id, x: c.x, y: c.y });
      counts[i]++;
      return true;
    }
    return false;
  };
  const tryPlace = (i: number): boolean => (openPlate[i]
    ? take(i, openList[i]) || take(i, hiddenList[i])
    : take(i, hiddenList[i]) || take(i, openList[i]));

  // Pass 1: one screw per plate, highest layers first (they have least room).
  const order = plates.map((_, i) => i).sort((a, b) => plates[b].layer - plates[a].layer);
  for (const i of order) tryPlace(i);
  // Pass 2: fill each plate's quota.
  for (const i of order) while (counts[i] < quota[i] && tryPlace(i)) { /* fill */ }
  // Pass 3: mop up any shortfall, preferring the plates furthest below quota.
  for (let round = 0; round < 60 && spots.length < target; round++) {
    const rank = [...order].sort((a, b) => (counts[a] - quota[a]) - (counts[b] - quota[b]));
    let any = false;
    for (const i of rank) {
      if (spots.length >= target) break;
      if (tryPlace(i)) any = true;
    }
    if (!any) break;
  }

  const keep = plates.filter((_, i) => counts[i] > 0);
  const kept = new Set(keep.map((p) => p.id));
  return { plates: keep, screws: spots.filter((s) => kept.has(s.plateId)) };
}

/**
 * Remove screws (never the last one of a plate) until the count is a multiple of
 * `m` and, if `max` is given, no larger than `max` (the passes above can
 * overshoot slightly because every plate is guaranteed one screw).
 */
export function trimToMultiple(layout: Layout, m: number, rng: Rng, max?: number): Layout {
  const screws = [...layout.screws];
  const perPlate = new Map<number, number>();
  for (const s of screws) perPlate.set(s.plateId, (perPlate.get(s.plateId) ?? 0) + 1);
  const over = () => screws.length % m !== 0 || (max !== undefined && screws.length > max);
  let guard = 0;
  while (over() && guard++ < 400) {
    const richest = [...perPlate.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
    if (richest.length === 0) break;
    const pid = rng.pick(richest.slice(0, Math.min(3, richest.length)))[0];
    const idx = screws.map((s, i) => (s.plateId === pid ? i : -1)).filter((i) => i >= 0);
    screws.splice(rng.pick(idx), 1);
    perPlate.set(pid, perPlate.get(pid)! - 1);
  }
  return { plates: layout.plates, screws };
}

/** Fraction of screws sitting on the bottom layer (CONTRACT_V2 §4 wants <= 0.35). */
export function bottomLayerFraction(plates: readonly PlateDef[], screws: readonly { plateId: number }[]): number {
  if (screws.length === 0) return 0;
  const bottom = Math.min(...plates.map((p) => p.layer));
  const byId = new Map(plates.map((p) => [p.id, p]));
  let n = 0;
  for (const s of screws) if (byId.get(s.plateId)!.layer === bottom) n++;
  return n / screws.length;
}

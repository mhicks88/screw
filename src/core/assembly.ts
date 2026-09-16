/**
 * Assembly geometry: the nested-shell machine of CONTRACT_V3 §7.
 *
 * An assembly is built from the outside in:
 *
 *   shell 0        the outer skin — big panels seated on the tangent planes of
 *                  a sphere of radius R0, each facing outward
 *   shell 1..S-2   inner shells at smaller radii, covered (partly) by the ones
 *                  outside them
 *   shell S-1      the frame: long thin struts across the core at varied angles
 *
 * Panel directions come from a Fibonacci lattice on the sphere that is rotated
 * by a random quaternion per shell and jittered per panel, so panels sit on
 * many different faces instead of the six axis-aligned ones — a box of six
 * squares would look like cardboard and would repeat across 1000 levels.
 * Every panel is checked against every other with an OBB separating-axis test,
 * so no two panels ever interpenetrate.
 *
 * THE ONE STRUCTURAL INVARIANT (this is what makes levels solvable by
 * construction, and it is the exact analogue of v2's layer rule):
 *
 *     a screw's withdrawal ray may only be blocked by panels in a STRICTLY
 *     OUTER shell (smaller `shell` index).
 *
 * Screws that would violate it are not placed. It gives a strict partial order
 * on panels, so at any point in a game the non-dropped panel with the largest
 * shell index that still has screws has all of its screws removable — there is
 * always a legal move, and no deadlock is possible. It is also exactly the
 * premise the §4 spacing exemption needs.
 */
import { ASSEMBLY_RADIUS, type PanelDef, type PlateShapeKind, type Quat, type Vec2, type Vec3 } from './types';
import { Rng } from './rng';
import { distanceToPolygonEdge, pointInShape, polygonAabb } from './geometry';
import {
  PanelBvh, addV3, angleBetween, crossV3, dotV3, lengthV3, normalizeV3, perpendicularTo, subV3, panelFacePoint, panelMaxRadius, panelNormal, panelObb, obbOverlap,
  quatFromAxisAngle, quatFromFrame, quatMul, quatRotate, scaleV3, v3, type Obb,
} from './geometry3';
import { RAY_LENGTH, rayOriginFor } from './blocking';
import { fittedShape } from './shapes';
import { PANEL_GAP, SCREW_EDGE_MARGIN, SCREW_SPACING, ScrewIndex3, type ScrewSpot } from './spacing';
import type { DifficultyParams } from './difficulty';

export { PANEL_GAP, SCREW_EDGE_MARGIN, SCREW_SPACING, ScrewIndex3, coverageExempt, pairSpacingOk, spacingViolations, type ScrewSpot } from './spacing';

/** A built assembly: panels, screw spots and each screw's blocking panel IDS. */
export interface Assembly {
  panels: PanelDef[];
  screws: ScrewSpot[];
  /** Per screw: the ids of the panels its withdrawal ray passes through. */
  blockers: number[][];
}

/**
 * One hue family per shell plus metal fittings: a machine is not a bag of
 * sweets, and twelve competing hues read as debris rather than as a built
 * object. The renderer tints by shell on top of this.
 */
const PANEL_COLORS = [
  0x3f7fd8, 0x2f63ad, 0x4d96ff,
  0xe0952c, 0xc07a1e, 0xf8961e,
  0x36ab6e, 0x2b8a58, 0x90be6d,
  0xd0475f, 0xa8384c, 0xe07a5f,
  0x8a56d6, 0x6f45ab, 0x9d4edd,
  0x2f9fb5, 0x267f92, 0x48cae4,
];
const FRAME_COLOR = 0x8b93a6;
const BRACKET_COLOR = 0xa7aebd;

const MATERIALS: PanelDef['material'][] = ['metal', 'metal', 'plastic', 'plastic', 'wood'];

/** Panel-ish shapes that fill their footprint. */
const BULK_KINDS: PlateShapeKind[] = ['roundedRect', 'roundedRect', 'rect', 'rect'];
/** Bracket-ish shapes with concavities and holes — variety, used more sparingly. */
const FANCY_KINDS: PlateShapeKind[] = ['L', 'T', 'cross', 'ring', 'triangle', 'capsule', 'circle', 'polygon'];
/** Strut shapes for the frame at the core. */
const STRUT_KINDS: PlateShapeKind[] = ['capsule', 'rect', 'roundedRect', 'cross'];
/** Corner brackets: small, chunky, metal. */
const BRACKET_KINDS: PlateShapeKind[] = ['hexagon', 'roundedRect', 'triangle', 'L', 'circle'];
/** Edge straps: long and thin, bridging two faces. */
const STRAP_KINDS: PlateShapeKind[] = ['capsule', 'rect', 'roundedRect'];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PANEL_THICKNESS = 0.07;
/** How far short of its neighbour a panel stops, so faces never touch. */
const FACE_GAP = 0.07;
/**
 * Gap down the seam where a face carries two plates side by side. Wide enough
 * that the screw columns either side of it still clear SCREW_SPACING — they sit
 * on the same face, pointing the same way, so they get no help from §4.
 */
const SEAM_GAP = SCREW_SPACING - 2 * SCREW_EDGE_MARGIN + 0.02;
/**
 * Radial distance between shells, and the single most important number in the
 * file. A panel loses a SCREW_EDGE_MARGIN band all the way round, so its screw
 * capacity collapses as it shrinks — and on a nested chassis a shell's panels
 * are as big as its offset allows. Spreading six shells over the whole radius
 * therefore throws most of the level away: the inner shells end up holding one
 * screw each. Packed 0.13 apart (v2 stacked its plates 0.12 apart, so this is
 * the same machine density) every shell stays nearly full size, which is what
 * makes a 140-190 screw level fit inside a sphere of radius 3 at all.
 */
const SHELL_STEP = 0.13;
/** Screw lattice: columns one pitch apart, rows in hexagonal offset. */
const SCREW_PITCH = SCREW_SPACING * 1.015;
const SCREW_ROW = SCREW_PITCH * 0.874;
/** Nothing may stick out past this; the renderer frames a sphere of ASSEMBLY_RADIUS. */
const MAX_RADIUS = ASSEMBLY_RADIUS - 0.04;

/* ------------------------------------------------------------ directions */

/** Uniform random unit quaternion (Shoemake). */
function randomQuat(rng: Rng): Quat {
  const u1 = rng.next(), u2 = rng.next(), u3 = rng.next();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return {
    x: a * Math.sin(2 * Math.PI * u2),
    y: a * Math.cos(2 * Math.PI * u2),
    z: b * Math.sin(2 * Math.PI * u3),
    w: b * Math.cos(2 * Math.PI * u3),
  };
}

/**
 * The chassis's MOUNTING DIRECTIONS, in three families — this is what makes the
 * result read as a machined assembly rather than a box (CONTRACT_V3 §7):
 *
 *   face    the six big skin panels, on a randomly oriented orthogonal triad
 *   corner  brackets tucked into the eight corner voids between the faces
 *   edge    straps across the twelve edges, tying neighbouring faces together
 *
 * Twenty-six mounting directions means twenty-six screw axes, so there is
 * something facing the player from ANY angle instead of six flat answers, and
 * the corner and edge voids are volume the six faces cannot reach — which is
 * also where a good part of a deep level's screws live.
 *
 * Orthogonal faces are worth a lot more than they look, too: two screws whose
 * axes are 90 degrees apart or more only need head clearance rather than a full
 * tap pitch (§4), so screws down the seam between two square faces do not
 * compete with each other. A set of evenly spread directions at ~60 degrees
 * loses every one of them.
 */
export type Family = 'face' | 'corner' | 'edge';

interface Mount { dir: Vec3; family: Family }

function mountingDirections(faces: number, corners: number, edges: number, rng: Rng): Mount[] {
  const spin = randomQuat(rng);
  const R = (x: number, y: number, z: number) => normalizeV3(quatRotate(spin, v3(x, y, z)));
  const axes = [R(1, 0, 0), R(-1, 0, 0), R(0, 1, 0), R(0, -1, 0), R(0, 0, 1), R(0, 0, -1)];
  const out: Mount[] = [];
  // Keep opposite faces together so even a two-panel tutorial is a closed box.
  const pairs = rng.shuffle([[0, 1], [2, 3], [4, 5]]);
  for (const [a, b] of pairs) { out.push({ dir: axes[a], family: 'face' }); out.push({ dir: axes[b], family: 'face' }); }
  out.length = Math.min(out.length, Math.max(1, faces));
  const k = 1 / Math.sqrt(3);
  const cornerDirs = [
    R(k, k, k), R(-k, k, k), R(k, -k, k), R(k, k, -k),
    R(-k, -k, k), R(-k, k, -k), R(k, -k, -k), R(-k, -k, -k),
  ];
  const h = 1 / Math.SQRT2;
  const edgeDirs = [
    R(h, h, 0), R(h, -h, 0), R(-h, h, 0), R(-h, -h, 0),
    R(h, 0, h), R(h, 0, -h), R(-h, 0, h), R(-h, 0, -h),
    R(0, h, h), R(0, h, -h), R(0, -h, h), R(0, -h, -h),
  ];
  for (const d of rng.shuffle(cornerDirs).slice(0, corners)) out.push({ dir: d, family: 'corner' });
  for (const d of rng.shuffle(edgeDirs).slice(0, edges)) out.push({ dir: d, family: 'edge' });
  return out;
}

/** Angle from each direction to its nearest neighbour (PI when it is alone). */
function neighbourAngles(dirs: readonly Vec3[]): number[] {
  return dirs.map((d, i) => {
    let best = Math.PI;
    dirs.forEach((e, j) => {
      if (i !== j) best = Math.min(best, angleBetween(d, e));
    });
    return best;
  });
}

function median(xs: readonly number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  return a.length ? a[a.length >> 1] : Math.PI;
}

/* -------------------------------------------------------------- panels */

interface Candidate { panel: PanelDef; obb: Obb; family: Family }

/**
 * Where to put the outer shell of skin panels. Two things bound a panel: it has
 * to stop short of the neighbouring face (which grows with the offset t) and it
 * has to stay inside the bounding sphere (which shrinks with t). The best
 * offset is where the two meet — push out and the panels shrink, pull in and
 * they shrink with their own radius.
 */
export function outerOffset(faceGap: number): number {
  const k = Math.min(3, Math.tan(Math.min(faceGap, Math.PI * 0.98) / 2));
  const g = FACE_GAP;
  const c = 0.16;                       // allowance for the panel's own thickness
  const a = 2 * k * k + 1;
  const b = 2 * c - 4 * k * g;
  const d = 2 * g * g + c * c - MAX_RADIUS * MAX_RADIUS;
  let t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * d))) / (2 * a);
  // Screw capacity is a step function of panel size, and out here the bounding
  // sphere is what limits it. Pulling the shell in by a couple of centimetres
  // can buy every outer panel a whole extra column of screws, so snap to the
  // largest offset whose sphere limit still clears the next lattice size.
  const want = extentFor(latticeSpan(sphereCap(t, 1), SCREW_PITCH) + 1, SCREW_PITCH);
  const snapped = Math.sqrt(Math.max(0, MAX_RADIUS * MAX_RADIUS - 2 * want * want)) - 0.16;
  if (snapped > t * 0.9) t = snapped;
  return Math.max(0.55, Math.min(2.35, t));
}

/**
 * Shell offsets, outermost first. See SHELL_STEP: the shells are packed close
 * together so that every one of them stays nearly full size.
 */
export function shellRadii(shells: number, faceGap = Math.PI / 2): number[] {
  // Shallow assemblies are also SMALLER assemblies: a two-shell crust at the
  // full radius would be a big hollow eggshell.
  const outer = Math.min(outerOffset(faceGap), 0.72 + 0.27 * shells);
  const out: number[] = [];
  for (let i = 0; i < shells; i++) out.push(Math.max(0.26, outer - SHELL_STEP * i));
  return out;
}

function latticeSpan(room: number, pitch: number): number {
  const span = 2 * room - 2 * SCREW_EDGE_MARGIN;
  return span < 0 ? -1 : Math.floor(span / pitch + 1e-9);
}

/** Half-extent that fits exactly `n + 1` screw sites at this pitch. */
function extentFor(n: number, pitch: number): number {
  return (n * pitch + 2 * SCREW_EDGE_MARGIN) / 2 + 0.03;
}

/** Largest half-extent at offset `t` that keeps the panel in the sphere. */
function sphereCap(t: number, aspect: number): number {
  const room = MAX_RADIUS * MAX_RADIUS - (t + 0.16) * (t + 0.16);
  return room <= 0 ? 0 : Math.sqrt(room / (1 + aspect * aspect));
}

/**
 * How big a panel may be on mount `i`, in its own tangent frame (x = towards
 * its nearest neighbouring mount, y = across).
 *
 * Between two mounts there is a wall: the plane bisecting the angle between
 * them, at tangential distance `t * tan(angle/2)` from the mount. A panel with
 * half-extents (hw, hh) clears that wall iff
 *
 *     hw * |u.x| + hh * |u.y| <= t * tan(angle/2) - FACE_GAP
 *
 * where u is the wall's bearing in the tangent frame. Solving all of them at
 * once for a given aspect ratio gives the largest panel that fits — much bigger
 * than the isotropic "stay inside tan(angle/2) in every direction" bound,
 * because a panel is a rectangle and it is its corners that collide. Aligning x
 * with the nearest neighbour is what lets its EDGE, not its corner, face the
 * tightest wall.
 */
function faceRoom(
  dirs: readonly Vec3[], offsets: readonly number[], i: number, x: Vec3, y: Vec3, aspect: number, slack: number,
  include: (j: number) => boolean = () => true,
): number {
  const n = dirs[i];
  const ri = offsets[i];
  let scale = Infinity;
  for (let j = 0; j < dirs.length; j++) {
    if (j === i || !include(j)) continue;
    const d = dirs[j];
    const c = dotV3(n, d);
    const sin = Math.sqrt(Math.max(0, 1 - c * c));
    if (sin < 1e-6) continue;                       // parallel or antipodal: no wall
    const proj = subV3(d, scaleV3(n, c));
    const u = scaleV3(proj, 1 / lengthV3(proj));
    // Distance, inside mount i's plane, from its centre to the line where the
    // two panels' planes cross. Panels that stop short of their own crossing
    // line can never meet, whatever radius each of them sits at.
    const wall = (offsets[j] - ri * c) / sin - FACE_GAP + slack;
    if (wall <= 0) return 0;
    const reach = Math.abs(dotV3(u, x)) + aspect * Math.abs(dotV3(u, y));
    if (reach > 1e-6) scale = Math.min(scale, wall / reach);
  }
  return Number.isFinite(scale) ? scale : sphereCap(ri, aspect);
}

/**
 * Candidate panel sizes for a mount, biggest screw capacity first. Sizes are
 * quantised to whole screw columns and rows: capacity is a step function of
 * size, so a panel that has to give way to a neighbour should drop a whole
 * column rather than shrink by a percentage — that loses the column anyway and
 * keeps none of the room it gave up.
 */
function candidateSizes(hwMax: number, hhMax: number, rng: Rng, trim = true, depth = 2): { hw: number; hh: number; sites: number }[] {
  const nw = latticeSpan(hwMax, SCREW_PITCH);
  const nh = latticeSpan(hhMax, SCREW_ROW);
  // Clipping a panel back by a column is variety on a big face and vandalism on
  // a small one, where it is the difference between a bracket with two screws
  // and a bracket with one.
  const nw0 = nw - (trim && nw >= 2 && rng.chance(0.25) ? 1 : 0);
  const nh0 = nh - (trim && nh >= 2 && rng.chance(0.25) ? 1 : 0);
  const out: { hw: number; hh: number; sites: number }[] = [];
  for (let dw = 0; dw <= depth; dw++) {
    for (let dh = 0; dh <= depth; dh++) {
      const a = nw0 - dw;
      const b = nh0 - dh;
      if (a < 0 || b < 0) continue;
      out.push({
        hw: Math.min(hwMax, extentFor(a, SCREW_PITCH)),
        hh: Math.min(hhMax, extentFor(b, SCREW_ROW)),
        sites: (a + 1) * (b + 1),
      });
    }
  }
  return out.sort((x, y) => y.sites - x.sites);
}

/**
 * How many plates to bolt side by side on one face. A seam costs about a screw
 * column, so a face is only split when the plates still hold as many screws
 * between them as the single plate would have — otherwise the extra panel is
 * bought with screws the level needs.
 */
function splitFor(hwMax: number, bias: number, rng: Rng): number {
  const want = Math.floor(bias) + (rng.chance(bias - Math.floor(bias)) ? 1 : 0);
  let split = Math.max(1, Math.min(3, want));
  const whole = latticeSpan(hwMax, SCREW_PITCH) + 1;
  while (split > 1) {
    const sub = (2 * hwMax - (split - 1) * SEAM_GAP) / (2 * split);
    const cols = latticeSpan(sub, SCREW_PITCH) + 1;
    if (sub >= 0.42 && cols >= 1 && split * cols >= whole) break;
    split--;
  }
  return split;
}

function makePanel(
  id: number, shell: number, dir: Vec3, tangent: Vec3, normal: Vec3, offset: number, hw: number, hh: number,
  kind: PlateShapeKind, color: number, material: PanelDef['material'], rng: Rng,
): PanelDef {
  return {
    id,
    shape: fittedShape(kind, hw, hh, rng),
    thickness: PANEL_THICKNESS * rng.float(0.85, 1.15),
    position: scaleV3(dir, offset),
    rotation: quatFromFrame(normal, tangent),
    color,
    material,
    shell,
  };
}

/** Tangent frame of mount `i`: +x towards its nearest neighbour, +y across. */
function faceFrame(dirs: readonly Vec3[], i: number): { x: Vec3; y: Vec3 } {
  const n = dirs[i];
  let best = -1;
  let bestAngle = Infinity;
  for (let j = 0; j < dirs.length; j++) {
    if (j === i) continue;
    const a = angleBetween(n, dirs[j]);
    if (a < bestAngle) { bestAngle = a; best = j; }
  }
  let x = best < 0 ? perpendicularTo(n) : subV3(dirs[best], scaleV3(n, dotV3(dirs[best], n)));
  if (lengthV3(x) < 1e-6) x = perpendicularTo(n);
  x = normalizeV3(x);
  return { x, y: crossV3(n, x) };
}

/** How far out a family sits, as a multiple of the shell offset. */
const FAMILY_REACH: Record<Family, number> = { face: 1, corner: 1.32, edge: 1.24 };
/** Biggest half-extent a bracket or strap may take, before the sphere and the OBB test. */
const FAMILY_CAP: Record<Family, number> = { face: Infinity, corner: 0.95, edge: 1.45 };
/**
 * Brackets and straps are bolted ACROSS the joints between skin panels, so they
 * are allowed to bed into them a little; two skin panels are not.
 */
const FAMILY_BITE: Record<Family, number> = { face: PANEL_GAP, corner: -0.05, edge: -0.05 };

/**
 * Build the chassis: mounting directions, and along each of them a stack of
 * panels at the shell offsets. Panels are sized to meet their neighbours
 * without fouling them, and a few mounts are left off each shell at random —
 * those openings are what lets the player see (and reach) into the machine at
 * the start, and they are where the level's extra "fronts" come from.
 */
export function placePanels(params: DifficultyParams, rng: Rng): PanelDef[] {
  const shells = Math.max(1, params.shells);
  const budget = Math.max(2, params.panels);
  const perShell = budget / shells;
  const faces = Math.max(1, Math.min(6, Math.round(perShell)));
  // Brackets and straps only once the six faces are paid for; they are what
  // fills the corner and edge voids the faces cannot reach.
  const extra = Math.max(0, Math.round(perShell) - 6);
  const corners = Math.min(8, Math.round(extra * 0.55));
  const edges = Math.min(12, extra - corners);
  const mounts = mountingDirections(faces, corners, edges, rng);
  const dirs = mounts.map((m) => m.dir);
  const gaps = neighbourAngles(dirs);
  const frames = dirs.map((_, i) => faceFrame(dirs, i));
  const radii = shellRadii(shells, median(gaps.filter((_, i) => mounts[i].family === 'face')));
  const splitBias = Math.max(1, Math.min(2.6, budget / Math.max(1, mounts.length * shells)));
  const placed: Candidate[] = [];
  let id = 0;

  for (let shell = 0; shell < shells && id < budget; shell++) {
    const isFrame = shells >= 4 && shell === shells - 1;
    const base = radii[shell];
    // The frame at the core: struts across it, at strong angles.
    const offsets = mounts.map((m) => (isFrame ? Math.min(base, 0.62) : base * FAMILY_REACH[m.family]));
    const palette = shell * 3;
    for (const i of rng.shuffle(mounts.map((_, k) => k))) {
      if (id >= budget) break;
      const family = mounts[i].family;
      // Openings: skip a few mounts. The outer skin keeps all of its panels
      // (it is the level's front door), deeper shells are gappier.
      if (shell > 0 && rng.chance(family === 'face' ? 0.1 : 0.18)) continue;
      const t = offsets[i];
      const frame = frames[i];
      let sizes: { hw: number; hh: number; sites: number }[];
      let kind: PlateShapeKind;
      let normal = mounts[i].dir;
      let split = 1;
      let color: number;
      let material: PanelDef['material'];
      if (isFrame) {
        const limit = Math.max(0.45, (shells > 1 ? radii[shells - 2] : 1.2) - 0.14);
        const hw = Math.max(0.4, Math.min(1.05, Math.sqrt(Math.max(0.04, limit * limit - t * t)) * 0.85));
        sizes = [{ hw, hh: Math.max(0.34, Math.min(hw * 0.5, limit * 0.4)), sites: 1 }];
        kind = rng.pick(STRUT_KINDS);
        normal = normalizeV3(quatRotate(
          quatFromAxisAngle(normalizeV3(v3(rng.float(-1, 1), rng.float(-1, 1), rng.float(-1, 1))), rng.float(0, 0.45)),
          mounts[i].dir,
        ));
        color = FRAME_COLOR;
        material = 'metal';
      } else {
        const odd = shell >= 2 || family !== 'face';
        const roomy = t > 1.1;
        const aspect = family === 'edge' ? rng.float(0.42, 0.62)
          : odd && roomy && rng.chance(0.3) ? rng.float(0.55, 0.8) : 1;
        /*
         * Skin panels are bounded analytically against the other skin panels —
         * for an orthogonal chassis that bound is exact, so only a hair of
         * slack is taken for the cases where the neighbour ends up smaller.
         *
         * Brackets and straps are NOT: they sit in the corner and edge voids
         * that the skin cannot reach, and the plane-crossing bound is badly
         * wrong for them (it stops a strap where it would cross a skin panel's
         * infinite plane, ignoring that the panel itself ended long before).
         * They are sized from the bounding sphere and cut back a column at a
         * time by the OBB test, which uses the panels' real extents.
         */
        const exact = family === 'face'
          ? faceRoom(dirs, offsets, i, frame.x, frame.y, aspect, 0, (j) => mounts[j].family === 'face')
          : Math.min(FAMILY_CAP[family], sphereCap(t, aspect));
        if (exact < 0.34) continue;
        const cap = sphereCap(t, aspect);
        const hwMax = Math.min(exact * 1.06, cap);
        if (family === 'face') split = splitFor(hwMax, splitBias, rng);
        sizes = candidateSizes(
          (2 * hwMax - (split - 1) * SEAM_GAP) / (2 * split), hwMax * aspect, rng, odd,
          family === 'face' ? 2 : 4,
        );
        if (sizes.length === 0) continue;
        kind = family === 'edge' ? rng.pick(STRAP_KINDS)
          : family === 'corner' ? rng.pick(BRACKET_KINDS)
          : odd && rng.chance(0.3) ? rng.pick(FANCY_KINDS) : rng.pick(BULK_KINDS);
        color = family === 'face' ? PANEL_COLORS[(palette + (id % 2)) % PANEL_COLORS.length] : BRACKET_COLOR;
        material = family === 'face' ? rng.pick(MATERIALS) : 'metal';
      }
      // A panel that fouls a neighbour is retried a column or a row smaller
      // before it is given up on, which packs the chassis far tighter than
      // plain dart-throwing and keeps the panel budget reachable.
      const seed = rng.int(0, 0x7fffffff);
      const spin = rng.chance(0.5) ? quatFromAxisAngle(mounts[i].dir, Math.PI / 2) : undefined;
      // Plates are cut down in their local X (that is the extent `split` divides
      // up), so they must be shifted apart along that same axis.
      const tangent = spin ? quatRotate(spin, frame.x) : frame.x;
      const group: Candidate[] = [];
      for (const size of sizes) {
        group.length = 0;
        const pitch = 2 * size.hw + SEAM_GAP;
        for (let k = 0; k < split; k++) {
          const shift = (k - (split - 1) / 2) * pitch;
          const cand = makePanel(
            id + k, shell, mounts[i].dir, tangent, normal, t, size.hw, size.hh, kind, color, material, new Rng(seed + k),
          );
          cand.position = addV3(cand.position, scaleV3(tangent, shift));
          if (panelMaxRadius(cand) > MAX_RADIUS) break;
          const cobb = panelObb(cand);
          const bite = FAMILY_BITE[family];
          if (placed.some((c) => obbOverlap(c.obb, cobb, Math.max(bite, FAMILY_BITE[c.family])))) break;
          // A panel with no room for a screw could never be unbolted.
          if (latticePoints(cand, new Rng(seed + k)).length === 0) break;
          group.push({ panel: cand, obb: cobb, family });
        }
        if (group.length === split) break;
      }
      // A plate that will not fit is simply left off — the rest of the face
      // still gets bolted on, and the hole is another way in.
      if (group.length === 0) continue;
      for (const c of group) {
        placed.push(c);
        id++;
      }
    }
  }
  return placed.map((c) => c.panel);
}

/* -------------------------------------------------------------- screws */

/**
 * Screw sites on a panel face: a hexagonal lattice at SCREW_SPACING, clipped to
 * the shape and kept SCREW_EDGE_MARGIN clear of every edge (outline and holes).
 *
 * The lattice's angle and offset are picked by trying a handful at random and
 * keeping whichever fits the most screws. That matters more than it sounds: a
 * badly placed lattice loses a whole row or column on a panel that is only two
 * or three screws wide, and at 190 screws per level the difference between a
 * centred lattice and a fitted one is roughly a factor of two.
 */
export function latticePoints(panel: PanelDef, rng: Rng): Vec2[] {
  const bb = polygonAabb(panel.shape.outline);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const reach = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + SCREW_PITCH;
  const ni = Math.ceil(reach / SCREW_PITCH) + 1;
  const nj = Math.ceil(reach / SCREW_ROW) + 1;
  let best: Vec2[] = [];
  for (let trial = 0; trial < 10; trial++) {
    // Axis-aligned first (panels are sized to fit a whole number of columns and
    // rows, and a grid square with the panel is what a machined part looks
    // like); then a few rotated ones for the odd shapes where that wins.
    const ang = trial < 5 ? 0 : rng.float(0, Math.PI);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ox = trial === 0 ? 0 : rng.float(-SCREW_PITCH / 2, SCREW_PITCH / 2);
    const oy = trial === 0 ? 0 : rng.float(-SCREW_ROW / 2, SCREW_ROW / 2);
    const stagger = trial % 2 === 0 ? 0.5 : 0;
    const out: Vec2[] = [];
    for (let j = -nj; j <= nj; j++) {
      for (let i = -ni; i <= ni; i++) {
        const lx = (i + (j & 1 ? stagger : 0)) * SCREW_PITCH + ox;
        const ly = j * (stagger ? SCREW_ROW : SCREW_PITCH) + oy;
        const p = { x: cx + lx * ca - ly * sa, y: cy + lx * sa + ly * ca };
        if (!pointInShape(p, panel.shape)) continue;
        if (edgeDistance(panel, p) < SCREW_EDGE_MARGIN) continue;
        out.push(p);
      }
    }
    if (out.length > best.length) best = out;
  }
  return best;
}

function edgeDistance(panel: PanelDef, p: Vec2): number {
  let best = distanceToPolygonEdge(p, panel.shape.outline);
  for (const h of panel.shape.holes ?? []) best = Math.min(best, distanceToPolygonEdge(p, h));
  return best;
}

interface PanelScrews {
  candidates: Vec2[];
  /** How many candidates have been tried (successful or not). */
  next: number;
  taken: number;
}

/**
 * Seat screws on the panels' outer faces, pointing along the outward normal.
 *
 * Every panel gets its FIRST screw before any panel gets a second: a panel with
 * no screws could never be unbolted and would block whatever is behind it for
 * good, so it has to be avoided rather than repaired afterwards. After that the
 * panels are filled up, inner shells first, until the level has the screws it
 * needs (with a little slack for `trimScrews` to shape).
 */
export function placeScrews(panels: readonly PanelDef[], target: number, rng: Rng): { screws: ScrewSpot[]; blockers: number[][] } {
  const bvh = new PanelBvh(panels);
  const index = new ScrewIndex3();
  const screws: ScrewSpot[] = [];
  const blockers: number[][] = [];
  const state: PanelScrews[] = panels.map((p) => ({ candidates: rng.shuffle(latticePoints(p, rng)), next: 0, taken: 0 }));
  const cap = Math.max(target + 12, Math.round(target * 1.3));

  const tryPlace = (pi: number, p: Vec2): boolean => {
    const panel = panels[pi];
    const position = panelFacePoint(panel, p);
    const axis = panelNormal(panel);
    const spot: ScrewSpot = { panelId: panel.id, position, axis };
    const hit = bvh.query(rayOriginFor(spot), axis, RAY_LENGTH, pi);
    // Structural invariant: only strictly outer shells may block a screw.
    for (const b of hit) if (panels[b].shell >= panel.shell) return false;
    const ids = hit.map((b) => panels[b].id);
    if (!index.canPlace(spot, ids)) return false;
    index.add(spot, ids);
    screws.push(spot);
    blockers.push(ids);
    return true;
  };

  // Round 1: one screw each, so no panel is left unscrewable.
  for (const pi of rng.shuffle(panels.map((_, i) => i))) {
    const st = state[pi];
    while (st.taken === 0 && st.next < st.candidates.length) {
      if (tryPlace(pi, st.candidates[st.next++])) st.taken++;
    }
  }
  // Round 2: fill up, deepest shells first (they are the scarce ones). Each
  // panel's candidates are consumed once — a site that was refused cannot
  // become free later, since screws are only ever added.
  const byDepth = panels.map((_, i) => i).sort((a, b) => panels[b].shell - panels[a].shell);
  for (const pi of byDepth) {
    if (screws.length >= cap) break;
    const st = state[pi];
    while (st.next < st.candidates.length && screws.length < cap) {
      if (tryPlace(pi, st.candidates[st.next++])) st.taken++;
    }
  }
  return { screws, blockers };
}

/**
 * Trim to exactly `count` screws, taking them off the busiest panels first so
 * the level stays evenly populated and every panel keeps at least one screw.
 */
export function trimScrews(a: Assembly, count: number, rng: Rng): Assembly {
  if (a.screws.length <= count) return a;
  const byPanel = new Map<number, number[]>();
  a.screws.forEach((s, i) => {
    const list = byPanel.get(s.panelId);
    if (list) list.push(i);
    else byPanel.set(s.panelId, [i]);
  });
  for (const list of byPanel.values()) rng.shuffle(list);
  const drop = new Set<number>();
  let remaining = a.screws.length;
  while (remaining > count) {
    let bestPanel = -1;
    let bestLen = 1;
    for (const [pid, list] of byPanel) {
      if (list.length > bestLen) { bestLen = list.length; bestPanel = pid; }
    }
    if (bestPanel < 0) break;
    drop.add(byPanel.get(bestPanel)!.pop()!);
    remaining--;
  }
  const screws: ScrewSpot[] = [];
  const blockers: number[][] = [];
  a.screws.forEach((s, i) => {
    if (drop.has(i)) return;
    screws.push(s);
    blockers.push(a.blockers[i]);
  });
  return { panels: a.panels, screws, blockers };
}

/**
 * Build a whole assembly: the chassis, then its screws, then a clean-up pass.
 *
 * A panel that ended up with no screw at all is DROPPED: it could never be
 * unbolted, so it would stand in the way of whatever is behind it for the whole
 * level. Dropping it afterwards is safe — a panel with no screws is never the
 * `panelOf` side of a §4 coverage exemption, so no exemption depends on it, and
 * removing a panel only ever unblocks rays. Its id is simply filtered out of the
 * blocker lists.
 */
export function buildAssembly(params: DifficultyParams, rng: Rng): Assembly {
  const built = placePanels(params, rng);
  if (built.length < 2) return { panels: [], screws: [], blockers: [] };
  const { screws, blockers } = placeScrews(built, params.screws, rng);
  const used = new Set(screws.map((s) => s.panelId));
  if (used.size === built.length) return { panels: built, screws, blockers };
  const panels = built.filter((p) => used.has(p.id));
  return { panels, screws, blockers: blockers.map((b) => b.filter((id) => used.has(id))) };
}

/** Fraction of screws sitting on the outermost shell (kept honest by §7). */
export function outerShellFraction(panels: readonly PanelDef[], screws: readonly { panelId: number }[]): number {
  if (screws.length === 0) return 0;
  const outer = new Set(panels.filter((p) => p.shell === 0).map((p) => p.id));
  return screws.reduce((n, s) => n + (outer.has(s.panelId) ? 1 : 0), 0) / screws.length;
}

/** Number of distinct shells the panels occupy. */
export function shellCount(panels: readonly PanelDef[]): number {
  return new Set(panels.map((p) => p.shell)).size;
}

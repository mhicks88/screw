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

const PANEL_COLORS = [
  0xf94144, 0xf3722c, 0xf8961e, 0xf9c74f, 0x90be6d, 0x43aa8b, 0x4d96ff, 0x9d4edd,
  0x48cae4, 0xff85a1, 0xffd166, 0x06d6a0, 0x8ecae6, 0xbc6c25, 0xe07a5f, 0x81b29a,
];

const MATERIALS: PanelDef['material'][] = ['metal', 'metal', 'plastic', 'plastic', 'wood'];

/** Panel-ish shapes that fill their footprint. */
const BULK_KINDS: PlateShapeKind[] = ['roundedRect', 'roundedRect', 'rect', 'rect'];
/** Bracket-ish shapes with concavities and holes — variety, used more sparingly. */
const FANCY_KINDS: PlateShapeKind[] = ['L', 'T', 'cross', 'ring', 'triangle', 'capsule', 'circle', 'polygon'];
/** Strut shapes for the frame at the core. */
const STRUT_KINDS: PlateShapeKind[] = ['capsule', 'rect', 'roundedRect', 'cross'];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PANEL_THICKNESS = 0.095;
/** How far short of its neighbour a panel stops, so faces never touch. */
const FACE_GAP = 0.07;
/**
 * Gap down the seam where a face carries two plates side by side. Wide enough
 * that the screw columns either side of it still clear SCREW_SPACING — they sit
 * on the same face, pointing the same way, so they get no help from §4.
 */
const SEAM_GAP = SCREW_SPACING - 2 * SCREW_EDGE_MARGIN + 0.02;
/**
 * Radial distance between shells. Panels are ~0.1 thick and barely tilted, so
 * 0.23 clears them comfortably; keeping the shells close is what keeps the
 * INNER ones big, and a panel's capacity falls off fast as it shrinks (it
 * always loses a SCREW_EDGE_MARGIN band all round). v2 stacked its plates
 * 0.12 apart, so this is still a roomy machine by comparison.
 */
const SHELL_STEP = 0.23;
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
 * The chassis's MOUNTING DIRECTIONS: a randomly oriented orthogonal triad (so
 * the six main faces are never axis-aligned in assembly space), plus edge
 * directions at 45 degrees for bracket faces when more are asked for.
 *
 * Orthogonal faces are worth a lot more than they look. Two screws whose axes
 * are 90 degrees apart or more only need head clearance rather than a full tap
 * pitch (CONTRACT_V3 §4), so screws along the seam between two square faces do
 * not compete with each other — and on a dense assembly that seam is where a
 * large fraction of the screws live. A set of evenly spread directions at ~60
 * degrees loses every one of them.
 */
function mountingDirections(n: number, rng: Rng): Vec3[] {
  const spin = randomQuat(rng);
  const R = (x: number, y: number, z: number) => normalizeV3(quatRotate(spin, v3(x, y, z)));
  const axes = [R(1, 0, 0), R(-1, 0, 0), R(0, 1, 0), R(0, -1, 0), R(0, 0, 1), R(0, 0, -1)];
  if (n <= 6) {
    // Keep opposite faces together so a small chassis is still a closed box.
    const pairs = rng.shuffle([[0, 1], [2, 3], [4, 5]]);
    const out: Vec3[] = [];
    for (const [a, b] of pairs) { out.push(axes[a]); out.push(axes[b]); }
    return out.slice(0, n);
  }
  const k = 1 / Math.SQRT2;
  const diagonals = [
    R(k, k, 0), R(k, -k, 0), R(-k, k, 0), R(-k, -k, 0),
    R(k, 0, k), R(k, 0, -k), R(-k, 0, k), R(-k, 0, -k),
    R(0, k, k), R(0, k, -k), R(0, -k, k), R(0, -k, -k),
  ];
  return [...axes, ...rng.shuffle(diagonals).slice(0, n - 6)];
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

interface Candidate { panel: PanelDef; obb: Obb }

/**
 * Where to put the outer shell. Two things bound a panel's half-extent: it must
 * stop short of its neighbouring face (grows with the offset t) and it must
 * stay inside the bounding sphere (shrinks with t). The best offset is where
 * the two meet — push further out and the panels shrink, pull in and they
 * shrink with their own radius. Solved in closed form from the chassis's
 * typical face gap.
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
 * Shell offsets along the mounting directions, outermost first. Shells sit as
 * close together as panels can be without touching, because the outer shells
 * are where the screws are: a panel loses a fixed SCREW_EDGE_MARGIN band all
 * round, so capacity falls away fast towards the core.
 */
export function shellRadii(shells: number, faceGap = 1.0): number[] {
  // Shallow assemblies are also SMALLER assemblies: a two-shell crust at the
  // full radius would be a big hollow eggshell. The deepest levels are the ones
  // that earn the whole bounding sphere.
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

/**
 * How big a panel may be on face `i` of a shell at offset `t`, in its own
 * tangent frame (x = towards the nearest neighbouring face, y = across).
 *
 * Between faces i and j there is a wall: the plane bisecting the angle between
 * them, at tangential distance `t * tan(angle/2)` from the face centre. A panel
 * with half-extents (hw, hh) clears that wall iff
 *
 *     hw * |u.x| + hh * |u.y| <= t * tan(angle/2) - FACE_GAP
 *
 * where u is the wall's bearing in the tangent frame. Solving all of those at
 * once for a given aspect ratio gives the largest panel that fits — which is
 * much bigger than the isotropic "stay within tan(angle/2) in every direction"
 * bound, because a panel is a rectangle and its corners are what actually
 * collide. Aligning x with the nearest neighbour is what lets its EDGE, not its
 * corner, face the tightest wall.
 */
function faceRoom(
  dirs: readonly Vec3[], i: number, t: number, x: Vec3, y: Vec3, aspect: number,
): number {
  const n = dirs[i];
  let scale = Infinity;
  for (let j = 0; j < dirs.length; j++) {
    if (j === i) continue;
    const d = dirs[j];
    const proj = subV3(d, scaleV3(n, dotV3(d, n)));
    const len = lengthV3(proj);
    if (len < 1e-6) continue;                       // antipodal: no wall
    const u = scaleV3(proj, 1 / len);
    const wall = t * Math.tan(angleBetween(n, d) / 2) - FACE_GAP;
    if (wall <= 0) return 0;
    const reach = Math.abs(dotV3(u, x)) + aspect * Math.abs(dotV3(u, y));
    if (reach > 1e-6) scale = Math.min(scale, wall / reach);
  }
  return Number.isFinite(scale) ? scale : sphereCap(t, aspect);
}

/** Largest half-extent at offset `t` that keeps the panel in the sphere. */
function sphereCap(t: number, aspect: number): number {
  const room = MAX_RADIUS * MAX_RADIUS - (t + 0.16) * (t + 0.16);
  return room <= 0 ? 0 : Math.sqrt(room / (1 + aspect * aspect));
}

/**
 * Candidate panel sizes for a face, biggest screw capacity first. Sizes are
 * quantised to whole screw columns and rows: capacity is a step function of
 * size, so a panel that has to give way to a neighbour should drop a whole
 * column rather than shrink by a percentage — that loses the column anyway and
 * keeps none of the room it gave up.
 */
function candidateSizes(hwMax: number, hhMax: number, rng: Rng, trim = true): { hw: number; hh: number; sites: number }[] {
  const nw = latticeSpan(hwMax, SCREW_PITCH);
  const nh = latticeSpan(hhMax, SCREW_ROW);
  // Clipping a panel back by a column is variety on a big face and vandalism on
  // a small one, where it is the difference between a bracket with two screws
  // and a bracket with one.
  const nw0 = nw;
  const nh0 = nh;
  const out: { hw: number; hh: number; sites: number }[] = [];
  for (let dw = 0; dw <= 2; dw++) {
    for (let dh = 0; dh <= 2; dh++) {
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

function makePanel(
  id: number, shell: number, dir: Vec3, tangent: Vec3, normal: Vec3, offset: number, hw: number, hh: number,
  kind: PlateShapeKind, rng: Rng,
): PanelDef {
  return {
    id,
    shape: fittedShape(kind, hw, hh, rng),
    thickness: PANEL_THICKNESS * rng.float(0.85, 1.25),
    position: scaleV3(dir, offset),
    rotation: quatFromFrame(normal, tangent),
    color: PANEL_COLORS[id % PANEL_COLORS.length],
    material: rng.pick(MATERIALS),
    shell,
  };
}

/** Tangent frame of face `i`: +x towards its nearest neighbour, +y across. */
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

/**
 * Build the chassis: `faces` mounting directions, and along each of them a
 * stack of panels at the shell offsets, each sized to meet its neighbours
 * without touching them. A few faces are left off each shell at random — those
 * openings are what lets the player see (and reach) into the machine at the
 * start, and they are where the level's extra "fronts" come from.
 *
 * Every candidate is checked against every panel already placed with an OBB
 * separating-axis test, so nothing ever interpenetrates.
 */
export function placePanels(params: DifficultyParams, rng: Rng): PanelDef[] {
  const shells = Math.max(1, params.shells);
  const budget = Math.max(2, params.panels);
  // Six square faces carry more screws than any finer subdivision (see
  // mountingDirections); extra bracket faces only appear when the panel budget
  // per shell really calls for them.
  const perShell = budget / shells;
  const faces = Math.max(2, Math.min(6, Math.round(perShell)));
  const dirs = mountingDirections(faces, rng);
  const gaps = neighbourAngles(dirs);
  const frames = dirs.map((_, i) => faceFrame(dirs, i));
  /*
   * Panel faces stay exactly on their mounting direction, so the faces of the
   * chassis meet at exactly 90 degrees. That is worth real screws: at exactly
   * 90 degrees the §4 rule only asks for head clearance, so the screws down
   * each side of a seam do not compete with each other, and a face can be
   * screwed right up to its border. The struts at the core are the exception —
   * they are tilted, and nothing is packed against them.
   */
  const normals = dirs;
  const radii = shellRadii(shells, median(gaps));
  const splitBias = Math.max(1, Math.min(2.6, budget / Math.max(1, faces * shells)));
  const placed: Candidate[] = [];
  let id = 0;

  for (let shell = 0; shell < shells && id < budget; shell++) {
    const isFrame = shells >= 4 && shell === shells - 1;
    // The frame sits well inside the last shell, so the machine has a visible
    // core rather than one more layer of skin.
    const t = isFrame ? Math.min(radii[shell], 0.62) : radii[shell];
    // Openings: skip a few faces. Deeper shells are gappier (they are smaller
    // and more cluttered anyway) and the outer skin keeps most of its panels.
    const skip = shells === 1 ? 0 : shell === 0 ? 0.05 : 0.1;
    for (const i of rng.shuffle(dirs.map((_, k) => k))) {
      if (id >= budget) break;
      if (rng.chance(skip)) continue;
      const frame = frames[i];
      let sizes: { hw: number; hh: number; sites: number }[];
      let kind: PlateShapeKind;
      let normal = normals[i];
      let split = 1;
      if (isFrame) {
        // The frame at the core: long struts across it at strong angles. They
        // have to stay clear of the innermost shell around them.
        const limit = Math.max(0.45, (shells > 1 ? radii[shells - 2] : 1.2) - 0.14);
        const hw = Math.max(0.4, Math.min(1.05, Math.sqrt(Math.max(0.04, limit * limit - t * t)) * 0.85));
        sizes = [{ hw, hh: Math.max(0.34, Math.min(hw * 0.5, limit * 0.4)), sites: 1 }];
        kind = rng.pick(STRUT_KINDS);
        normal = normalizeV3(quatRotate(
          quatFromAxisAngle(normalizeV3(v3(rng.float(-1, 1), rng.float(-1, 1), rng.float(-1, 1))), rng.float(0, 0.45)),
          dirs[i],
        ));
      } else {
        // Squarish panels pack the screw lattice best. The outer shells are
        // where most of a level's screws live, so they are kept full and
        // regular; the deeper, smaller shells carry the odd shapes and the
        // clipped panels that stop the machine looking extruded.
        const odd = shell >= 2;
        const roomy = t > 1.1;
        const aspect = 1;
        // The bisector bound assumes every face claims its whole cell; in
        // practice neighbours are smaller than that, so aim past it and let the
        // OBB test below hand back whatever really does not fit.
        // The wall bound is exact for an orthogonal chassis (the bisector
        // between two square faces is where their panels really would meet), so
        // only a hair of slack is taken for the cases where the neighbour ends
        // up smaller; the OBB test hands back anything that does not fit.
        const exact = faceRoom(dirs, i, t, frame.x, frame.y, aspect);
        if (exact < 0.35) continue;
        const cap = sphereCap(t, aspect);
        const hwMax = Math.min(exact * 1.06, cap);
        // Two plates bolted side by side: a seam costs about one screw column,
        // and buys a second panel, a second thing to unbolt and a window into
        // the shell below once one of them comes off. The decision is taken on
        // the EXACT bound, not the optimistic one — splitting a face that then
        // has to give ground to its neighbour would collapse both plates.
        split = splitFor(hwMax, splitBias, rng);
        sizes = candidateSizes((2 * hwMax - (split - 1) * SEAM_GAP) / (2 * split), hwMax * aspect, rng, odd);
        if (sizes.length === 0) continue;
        kind = 'rect';
      }
      // A panel that fouls a neighbour is retried a column or a row smaller
      // before it is given up on, which packs the chassis far tighter than
      // plain dart-throwing and keeps the panel budget reachable.
      const seed = rng.int(0, 0x7fffffff);
      const spin = rng.chance(0.5) ? quatFromAxisAngle(dirs[i], Math.PI / 2) : undefined;
      const tangent = spin ? quatRotate(spin, frame.x) : frame.x;
      // Plates are cut down in their local X (that is the extent `split` divided
      // up), so they must be shifted apart along that same axis.
      const across = tangent;
      const group: Candidate[] = [];
      for (const size of sizes) {
        group.length = 0;
        const pitch = 2 * size.hw + SEAM_GAP;
        for (let k = 0; k < split; k++) {
          const shift = (k - (split - 1) / 2) * pitch;
          const cand = makePanel(
            id + k, shell, dirs[i], tangent, normal, t, size.hw, size.hh, kind, new Rng(seed + k),
          );
          cand.position = addV3(cand.position, scaleV3(across, shift));
          if (panelMaxRadius(cand) > MAX_RADIUS) break;
          const cobb = panelObb(cand);
          if (placed.some((c) => obbOverlap(c.obb, cobb, PANEL_GAP))) break;
          // A panel with no room for a screw could never be unbolted.
          if (latticePoints(cand, new Rng(seed + k)).length === 0) break;
          group.push({ panel: cand, obb: cobb });
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
      continue;
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

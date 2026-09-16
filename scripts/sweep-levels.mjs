/**
 * Full-sweep verification of the level generator (CONTRACT_V2 §7).
 *
 *   npm run sweep                  # all 1000 levels
 *   npm run sweep -- --every 10    # every 10th level (quick)
 *   npm run sweep -- --from 700 --to 1000
 *   npm run sweep -- --quiet       # per-band summary only
 *
 * Verifies, for every level it visits: determinism (on a subset), the §2
 * spacing rule including the coverage exemption, plate/screw invariants, the
 * §4 layer distribution, the §5 non-linearity statistics (including that the
 * simultaneously active boxes open on distinct colours) and winnability by
 * replaying the proven winning line through the public Game API. Prints
 * per-band statistics and timings at the end.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : Number(v);
}

const outDir = mkdtempSync(join(tmpdir(), 'screwdom-sweep-'));
const outFile = join(outDir, 'core.mjs');
await build({
  entryPoints: [join(root, 'src/core/index.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile: outFile, logLevel: 'error',
});
const core = await import(pathToFileURL(outFile).href);
rmSync(outDir, { recursive: true, force: true });

const {
  TOTAL_LEVELS, BOX_CAPACITY, MAX_ACTIVE_BOXES, BOARD, SCREW_EDGE_MARGIN,
  generateLevel, measureLevel, lastGenerationStats, nonLinearityTargets, difficultyFor,
  pairSpacingOk, winningMoves, plateContainsWorldPoint, plateEdgeDistance, plateWorldOutline,
  polygonAabb, polygonsOverlap, Game,
} = core;

const from = Number(arg('from', 1));
const to = Number(arg('to', TOTAL_LEVELS));
const every = Number(arg('every', 1));
const quiet = arg('quiet', false) === true;
const EPS = 1e-6;

const BANDS = [[1, 3], [4, 30], [31, 120], [121, 350], [351, 700], [701, 1000]];
const bandOf = (n) => BANDS.findIndex(([, hi]) => n <= hi);

const problems = [];
const rows = [];

function check(cond, msg) { if (!cond) problems.push(msg); }

/** Every invariant the generator promises, verified from the outside. */
function verify(def) {
  const n = def.level;
  const tag = `level ${n}`;
  const plateById = new Map(def.plates.map((p) => [p.id, p]));
  check(def.screws.length % BOX_CAPACITY === 0, `${tag}: screws not a multiple of ${BOX_CAPACITY}`);
  check(def.boxQueue.length === def.screws.length / BOX_CAPACITY, `${tag}: boxQueue length`);
  check(def.activeBoxCount >= 1 && def.activeBoxCount <= MAX_ACTIVE_BOXES, `${tag}: activeBoxCount`);
  check(def.plates.length >= 2, `${tag}: fewer than 2 plates`);

  const perColor = new Map();
  for (const s of def.screws) perColor.set(s.color, (perColor.get(s.color) ?? 0) + 1);
  for (const [c, k] of perColor) {
    check(k % BOX_CAPACITY === 0, `${tag}: colour ${c} count ${k}`);
    check(def.boxQueue.filter((q) => q === c).length === k / BOX_CAPACITY, `${tag}: queue count for ${c}`);
  }

  const outlines = def.plates.map(plateWorldOutline);
  for (let i = 0; i < def.plates.length; i++) {
    const bb = polygonAabb(outlines[i]);
    check(bb.minX >= BOARD.minX - EPS && bb.maxX <= BOARD.maxX + EPS
      && bb.minY >= BOARD.minY - EPS && bb.maxY <= BOARD.maxY + EPS, `${tag}: plate ${i} off board`);
    check(def.screws.some((s) => s.plateId === def.plates[i].id), `${tag}: plate ${i} has no screw`);
    for (let j = i + 1; j < def.plates.length; j++) {
      if (def.plates[i].layer !== def.plates[j].layer) continue;
      check(!polygonsOverlap(outlines[i], outlines[j]), `${tag}: plates ${i},${j} overlap on layer ${def.plates[i].layer}`);
    }
  }

  for (let i = 0; i < def.screws.length; i++) {
    const s = def.screws[i];
    const p = plateById.get(s.plateId);
    check(plateContainsWorldPoint(p, s.x, s.y), `${tag}: screw ${i} outside its plate`);
    check(plateEdgeDistance(p, s.x, s.y) >= SCREW_EDGE_MARGIN - EPS, `${tag}: screw ${i} too close to the edge`);
    for (let j = i + 1; j < def.screws.length; j++) {
      const t = def.screws[j];
      if (!pairSpacingOk(p, s.x, s.y, plateById.get(t.plateId), t.x, t.y)) {
        problems.push(`${tag}: screws ${i},${j} violate the spacing rule`);
        break;
      }
    }
    if (s.hidden) {
      const blocked = def.plates.some((q) => q.layer > p.layer && plateContainsWorldPoint(q, s.x, s.y));
      check(blocked, `${tag}: mystery screw ${i} is not blocked at start`);
    }
  }
}

/** Replay the proven winning line through the public Game API only. */
function replay(def) {
  const game = new Game(def);
  for (const id of winningMoves(def)) {
    const r = game.tapScrew(id);
    if (!r.ok) return `refused screw ${id} (${r.reason})`;
  }
  return game.snapshot().status;
}

const t0 = Date.now();
let genTotal = 0;
let slowest = { ms: 0, level: 0 };

for (let n = from; n <= to; n += every) {
  const g0 = Date.now();
  const def = generateLevel(n);
  const ms = Date.now() - g0;
  genTotal += ms;
  if (ms > slowest.ms) slowest = { ms, level: n };

  if (n % 50 === 1 || n === from) {
    const again = generateLevel(n);
    check(JSON.stringify(again) === JSON.stringify(def), `level ${n}: not deterministic`);
  }
  verify(def);
  const stats = measureLevel(def);
  const gen = lastGenerationStats();
  check(Math.abs(stats.avgReachable - gen.avgReachable) < 1e-9, `level ${n}: measureLevel disagrees with the generator`);
  const outcome = replay(def);
  check(outcome === 'won', `level ${n}: replay of the recorded queue ended '${outcome}'`);

  const t = nonLinearityTargets(n);
  check(stats.startBoxColors >= t.startBoxColors,
    `level ${n}: opens with only ${stats.startBoxColors} distinct box colours (wants ${t.startBoxColors})`);
  const meets = stats.avgReachable >= t.avgReachable && stats.minReachable >= t.minReachable
    && stats.avgFronts >= t.avgFronts && stats.maxChokeRun < 4 && stats.startBoxColors >= t.startBoxColors;
  rows.push({ n, def, stats, ms, meets, params: difficultyFor(n) });
  if (!quiet && (every > 1 || n % 25 === 0)) {
    process.stdout.write(`\r  level ${n}  (${rows.length} done, ${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
  }
}
if (!quiet) process.stdout.write('\r' + ' '.repeat(60) + '\r');

const fmt = (v, w, d = 1) => (typeof v === 'number' ? v.toFixed(d) : String(v)).padStart(w);
const head = ['band', 'levels', 'screws', 'layers', 'plates', 'tow', 'bottom%', 'avgReach', 'avgFront', 'minReach', 'peakVis', 'boxCols', 'choke>3', '§5 ok', 'gen ms'];
console.log('\n' + head.map((h, i) => h.padStart(i === 0 ? 10 : 9)).join(''));

for (let b = 0; b < BANDS.length; b++) {
  const rs = rows.filter((r) => bandOf(r.n) === b);
  if (rs.length === 0) continue;
  const agg = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const range = (f) => `${Math.min(...rs.map(f))}-${Math.max(...rs.map(f))}`;
  console.log([
    `${BANDS[b][0]}-${BANDS[b][1]}`.padStart(10),
    String(rs.length).padStart(9),
    range((r) => r.stats.screws).padStart(9),
    range((r) => r.stats.layers).padStart(9),
    range((r) => r.stats.plates).padStart(9),
    range((r) => r.params.towers).padStart(9),
    fmt(agg((r) => r.stats.bottomLayerFraction * 100), 9),
    fmt(agg((r) => r.stats.avgReachable), 9),
    fmt(agg((r) => r.stats.avgFronts), 9),
    fmt(agg((r) => r.stats.minReachable), 9),
    fmt(agg((r) => r.stats.peakReachable), 9),
    `${Math.min(...rs.map((r) => r.stats.startBoxColors))}/${fmt(agg((r) => r.stats.avgBoxColors), 1, 1).trim()}`.padStart(9),
    String(rs.filter((r) => r.stats.maxChokeRun >= 4).length).padStart(9),
    `${Math.round((rs.filter((r) => r.meets).length / rs.length) * 100)}%`.padStart(9),
    fmt(agg((r) => r.ms), 9, 0),
  ].join(''));
}

const worstBottom = rows.reduce((a, r) => (r.stats.bottomLayerFraction > a.stats.bottomLayerFraction ? r : a));
const maxScrews = Math.max(...rows.map((r) => r.stats.screws));
const maxLayers = Math.max(...rows.map((r) => r.stats.layers));
const maxPlates = Math.max(...rows.map((r) => r.stats.plates));
const maxPeak = Math.max(...rows.map((r) => r.stats.peakReachable));
const maxTray = Math.max(...rows.map((r) => r.def.traySlots));
const maxBoxes = Math.max(...rows.map((r) => r.def.activeBoxCount));

console.log(`\nlevels checked : ${rows.length} (${from}..${to} step ${every})`);
console.log(`generation     : total ${(genTotal / 1000).toFixed(1)}s, avg ${(genTotal / rows.length).toFixed(0)} ms, slowest level ${slowest.level} (${slowest.ms} ms)`);
console.log(`maxima         : ${maxScrews} screws, ${maxLayers} layers, ${maxPlates} plates, ${maxPeak} visible at once, ${maxTray} tray slots, ${maxBoxes} active boxes`);
console.log(`bottom layer   : worst ${(worstBottom.stats.bottomLayerFraction * 100).toFixed(1)}% at level ${worstBottom.n} (limit 35%)`);
console.log(`§5 compliance  : ${rows.filter((r) => r.meets).length}/${rows.length} levels meet every non-linearity criterion`);
console.log(`box colours    : every level opens with ${rows.every((r) => r.stats.startBoxColors >= Math.min(r.def.activeBoxCount, r.def.colors.length)) ? 'all-distinct' : 'DUPLICATE'} box colours`
  + ` (worst average over a play-through ${Math.min(...rows.map((r) => r.stats.avgBoxColors)).toFixed(2)})`);
console.log(`wall clock     : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (problems.length) {
  console.log(`\nFAILURES (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nAll invariants hold.');
}

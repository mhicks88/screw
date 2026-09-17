/**
 * Full-sweep verification of the level generator (CONTRACT_V3 §7).
 *
 *   npm run sweep                  # all 1000 levels
 *   npm run sweep -- --every 10    # every 10th level (quick)
 *   npm run sweep -- --from 700 --to 1000
 *   npm run sweep -- --quiet       # per-band summary only
 *
 * Verifies, for every level it visits: determinism (on a subset), the §4
 * spacing rule including the coverage exemption, panel/screw invariants in 3D
 * (inside the bounding sphere, screws on a face of their own panel clear of its
 * edges, panels not interpenetrating), the blocking order that makes a level
 * solvable by construction, the §7 non-linearity statistics (including that the
 * simultaneously active boxes open on distinct colours), the §6 rule that some
 * screws are removable and face-on from EVERY viewing direction, winnability by
 * replaying the proven winning line through the public Game API, and the
 * DIFFICULTY CURVE — the share of GATE_RUNS seeded replays that a naive bot
 * (random matching, random tray choices) wins. Prints per-band statistics and
 * timings at the end, and fails if a deeper band is more forgiving than the one
 * before it.
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
  TOTAL_LEVELS, BOX_CAPACITY, MAX_ACTIVE_BOXES, ASSEMBLY_RADIUS, SCREW_EDGE_MARGIN,
  generateLevel, measureLevel, lastGenerationStats, nonLinearityTargets, difficultyFor, minViewFacing,
  winningMoves, computeBlockers, spacingViolations, shellCount, outerShellFraction,
  assemblyToPanel, panelMaxRadius, panelNormal, panelObb, obbOverlap, dotV3, lengthV3,
  pointInShape, distanceToPolygonEdge, Game, playBot, hashSeed,
} = core;

/** Same proxy the generator gates on: 12 seeded replays by a bot that does not plan. */
const GATE_RUNS = 12;
function naiveWins(def) {
  let wins = 0;
  for (let k = 0; k < GATE_RUNS; k++) {
    if (playBot(new Game(def), hashSeed(def.seed, k + 1), { naive: true }).outcome === 'won') wins++;
  }
  return wins;
}

const from = Number(arg('from', 1));
const to = Number(arg('to', TOTAL_LEVELS));
const every = Number(arg('every', 1));
const quiet = arg('quiet', false) === true;
const EPS = 1e-6;
/** Brackets and straps are bolted over joints, so they may bed into a panel. */
const MAX_BITE = 0.26;

const BANDS = [[1, 3], [4, 30], [31, 120], [121, 350], [351, 700], [701, 1000]];
const bandOf = (n) => BANDS.findIndex(([, hi]) => n <= hi);

const problems = [];
const rows = [];

function check(cond, msg) { if (!cond) problems.push(msg); }

/** Every invariant the generator promises, verified from the outside. */
function verify(def) {
  const n = def.level;
  const tag = `level ${n}`;
  const byId = new Map(def.panels.map((p) => [p.id, p]));
  check(def.screws.length % BOX_CAPACITY === 0, `${tag}: screws not a multiple of ${BOX_CAPACITY}`);
  check(def.boxQueue.length === def.screws.length / BOX_CAPACITY, `${tag}: boxQueue length`);
  check(def.activeBoxCount >= 1 && def.activeBoxCount <= MAX_ACTIVE_BOXES, `${tag}: activeBoxCount`);
  check(def.panels.length >= 2, `${tag}: fewer than 2 panels`);
  check(def.panels.every((p, i) => p.id === i), `${tag}: panel ids are not dense`);
  const shells = [...new Set(def.panels.map((p) => p.shell))].sort((a, b) => a - b);
  check(shells.every((s, i) => s === i), `${tag}: shell indices are not dense`);

  const perColor = new Map();
  for (const s of def.screws) perColor.set(s.color, (perColor.get(s.color) ?? 0) + 1);
  for (const [c, k] of perColor) {
    check(k % BOX_CAPACITY === 0, `${tag}: colour ${c} count ${k}`);
    check(def.boxQueue.filter((q) => q === c).length === k / BOX_CAPACITY, `${tag}: queue count for ${c}`);
  }

  // Panels: inside the bounding sphere, each carrying a screw, not interpenetrating.
  const obbs = def.panels.map(panelObb);
  for (let i = 0; i < def.panels.length; i++) {
    const p = def.panels[i];
    check(panelMaxRadius(p) <= ASSEMBLY_RADIUS + EPS, `${tag}: panel ${i} pokes outside the bounding sphere`);
    check(def.screws.some((s) => s.panelId === p.id), `${tag}: panel ${i} has no screw`);
    for (let j = i + 1; j < def.panels.length; j++) {
      if (obbOverlap(obbs[i], obbs[j], -MAX_BITE)) {
        problems.push(`${tag}: panels ${i},${j} interpenetrate`);
        break;
      }
    }
  }

  // Screws: on a face of their own panel, clear of its edges, unit axis.
  for (let i = 0; i < def.screws.length; i++) {
    const s = def.screws[i];
    const panel = byId.get(s.panelId);
    if (!panel) { problems.push(`${tag}: screw ${i} has no panel`); continue; }
    check(lengthV3(s.position) <= ASSEMBLY_RADIUS + EPS, `${tag}: screw ${i} outside the bounding sphere`);
    check(Math.abs(lengthV3(s.axis) - 1) < 1e-9, `${tag}: screw ${i} axis is not a unit vector`);
    const local = assemblyToPanel(panel, s.position);
    const onFace = Math.abs(local.z - panel.thickness) < 1e-6 || Math.abs(local.z) < 1e-6;
    check(onFace, `${tag}: screw ${i} is not seated on a face`);
    check(Math.abs(Math.abs(dotV3(s.axis, panelNormal(panel))) - 1) < 1e-6, `${tag}: screw ${i} does not withdraw along its face normal`);
    check(pointInShape(local, panel.shape), `${tag}: screw ${i} outside its panel`);
    let edge = distanceToPolygonEdge(local, panel.shape.outline);
    for (const h of panel.shape.holes ?? []) edge = Math.min(edge, distanceToPolygonEdge(local, h));
    check(edge >= SCREW_EDGE_MARGIN - EPS, `${tag}: screw ${i} too close to the edge`);
  }

  // The spacing rule (§4) and the blocking order that makes the level solvable.
  const blockers = computeBlockers(def.panels, def.screws);
  const ids = blockers.map((b) => b.map((k) => def.panels[k].id));
  const bad = spacingViolations(def.screws, ids);
  if (bad.length) problems.push(`${tag}: ${bad.length} screw pairs violate the spacing rule (first ${bad[0]})`);
  def.screws.forEach((s, i) => {
    const own = byId.get(s.panelId);
    for (const pi of blockers[i]) {
      if (def.panels[pi].shell >= own.shell) {
        problems.push(`${tag}: screw ${i} is blocked by an equal or deeper panel — the level may deadlock`);
        break;
      }
    }
    if (s.hidden) check(blockers[i].length > 0, `${tag}: mystery screw ${i} is not blocked at start`);
  });
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
  const opening = minViewFacing(def, new Game(def).reachableScrewIds());
  check(opening > 0, `level ${n}: opens with a viewing direction that has nothing tappable`);
  check(stats.minViewFacing > 0, `level ${n}: some viewing direction has nothing tappable mid-game`);
  const meets = stats.avgReachable >= t.avgReachable && stats.minReachable >= t.minReachable
    && stats.avgFronts >= t.avgFronts && stats.maxChokeRun < 4 && stats.startBoxColors >= t.startBoxColors
    && stats.minViewFacing >= t.minViewFacing;
  rows.push({ n, def, stats, ms, meets, opening, naive: naiveWins(def), params: difficultyFor(n) });
  if (!quiet && (every > 1 || n % 25 === 0)) {
    process.stdout.write(`\r  level ${n}  (${rows.length} done, ${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
  }
}
if (!quiet) process.stdout.write('\r' + ' '.repeat(60) + '\r');

const fmt = (v, w, d = 1) => (typeof v === 'number' ? v.toFixed(d) : String(v)).padStart(w);
const head = ['band', 'levels', 'screws', 'shells', 'panels', 'outer%', 'avgReach', 'avgFront', 'minReach', 'peak', 'minView', 'boxCols', 'choke>3', '§7 ok', 'naive/12', 'gen ms'];
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
    range((r) => r.stats.shells).padStart(9),
    range((r) => r.stats.panels).padStart(9),
    fmt(agg((r) => r.stats.outerShellFraction * 100), 9),
    fmt(agg((r) => r.stats.avgReachable), 9),
    fmt(agg((r) => r.stats.avgFronts), 9),
    fmt(agg((r) => r.stats.minReachable), 9),
    fmt(agg((r) => r.stats.peakReachable), 9, 0),
    `${Math.min(...rs.map((r) => r.stats.minViewFacing))}/${fmt(agg((r) => r.stats.minViewFacing), 1, 1).trim()}`.padStart(9),
    `${Math.min(...rs.map((r) => r.stats.startBoxColors))}/${fmt(agg((r) => r.stats.avgBoxColors), 1, 1).trim()}`.padStart(9),
    String(rs.filter((r) => r.stats.maxChokeRun >= 4).length).padStart(9),
    `${Math.round((rs.filter((r) => r.meets).length / rs.length) * 100)}%`.padStart(9),
    `${fmt(agg((r) => r.naive), 1, 1).trim()}/${Math.max(...rs.map((r) => r.naive))}`.padStart(9),
    fmt(agg((r) => r.ms), 9, 0),
  ].join(''));
}

const worstOuter = rows.reduce((a, r) => (r.stats.outerShellFraction > a.stats.outerShellFraction ? r : a));
const maxScrews = Math.max(...rows.map((r) => r.stats.screws));
const maxShells = Math.max(...rows.map((r) => r.stats.shells));
const maxPanels = Math.max(...rows.map((r) => r.stats.panels));
const maxPeak = Math.max(...rows.map((r) => r.stats.peakReachable));
const maxTray = Math.max(...rows.map((r) => r.def.traySlots));
const maxBoxes = Math.max(...rows.map((r) => r.def.activeBoxCount));
const worstView = rows.reduce((a, r) => (r.stats.minViewFacing < a.stats.minViewFacing ? r : a));

console.log(`\nlevels checked : ${rows.length} (${from}..${to} step ${every})`);
console.log(`generation     : total ${(genTotal / 1000).toFixed(1)}s, avg ${(genTotal / rows.length).toFixed(0)} ms, slowest level ${slowest.level} (${slowest.ms} ms)`);
console.log(`maxima         : ${maxScrews} screws, ${maxShells} shells, ${maxPanels} panels, ${maxPeak} removable at once, ${maxTray} tray slots, ${maxBoxes} active boxes`);
console.log(`outer shell    : worst ${(worstOuter.stats.outerShellFraction * 100).toFixed(1)}% of screws on the skin at level ${worstOuter.n}`);
console.log(`view coverage  : worst ${worstView.stats.minViewFacing} tappable from the least helpful angle (level ${worstView.n}); every level opens with at least ${Math.min(...rows.map((r) => r.opening))}`);
console.log(`§7 compliance  : ${rows.filter((r) => r.meets).length}/${rows.length} levels meet every non-linearity criterion`);
{
  // The curve must not turn back up: past the tutorials, each successive band's
  // mean naive-win rate has to be no higher than the one before it.
  const means = BANDS.map(([, hi], b) => {
    const rs = rows.filter((r) => bandOf(r.n) === b);
    return rs.length ? rs.reduce((a, r) => a + r.naive, 0) / rs.length : null;
  });
  console.log(`difficulty     : mean naive wins per band ${means.map((m) => (m === null ? '-' : m.toFixed(1))).join(' -> ')} (of ${GATE_RUNS})`);
  for (let b = 2; b < means.length; b++) {
    if (means[b] === null || means[b - 1] === null) continue;
    check(means[b] <= means[b - 1] + 0.5,
      `band ${BANDS[b][0]}-${BANDS[b][1]} is MORE forgiving than the band before it (${means[b].toFixed(1)} vs ${means[b - 1].toFixed(1)} naive wins)`);
  }
  const worst = rows.filter((r) => r.n > 100).reduce((a, r) => (r.naive > a.naive ? r : a), { naive: -1 });
  if (worst.naive >= 0) console.log(`               : most forgiving level past 100 is ${worst.n} at ${worst.naive}/${GATE_RUNS}`);
}
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

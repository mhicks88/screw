/**
 * Bounded lookahead used by the 'hint' power-up. Beam search over reachable
 * screws using the real Game rules (cloned games), scoring progress: screws
 * boxed, panels dropped, tray pressure and fresh matching opportunities.
 */
import { BOX_CAPACITY, type GameSnapshot } from './types';
import { Game } from './game';

const BEAM_WIDTH = 4;
const MAX_BRANCH = 14;

function evaluate(g: Game): number {
  const status = g.getStatus();
  if (status === 'lost') return -1e6;
  if (status === 'won') return 1e6;
  const screws = g.peekScrews();
  const boxes = g.peekBoxes();
  let score = 0;
  let trayCount = 0;
  let reachable = 0;
  let matching = 0;
  for (const s of screws) {
    if (s.location === 'gone') score += 12;
    else if (s.location === 'box') score += 9;
    else if (s.location === 'tray') trayCount++;
    else if (!s.blocked) {
      reachable++;
      if (boxes.some((b) => b.color === s.color && b.screws.length < BOX_CAPACITY)) matching++;
    }
  }
  for (const p of g.peekPanels()) if (p.dropped) score += 15;
  score -= trayCount * 8;
  score += reachable * 1.5 + matching * 3;
  return score;
}

/** Static pre-ranking to keep the branching factor bounded. */
function candidates(g: Game): number[] {
  const ids = g.reachableScrewIds();
  if (ids.length <= MAX_BRANCH) return ids;
  const boxes = g.peekBoxes();
  const panels = new Map(g.peekPanels().map((p) => [p.id, p]));
  const screws = new Map(g.peekScrews().map((s) => [s.id, s]));
  const pre = (id: number) => {
    const s = screws.get(id)!;
    let v = boxes.some((b) => b.color === s.color && b.screws.length < BOX_CAPACITY) ? 10 : 0;
    v -= panels.get(s.panelId)!.remainingScrews.length * 0.5;
    return v;
  };
  return [...ids].sort((a, b) => pre(b) - pre(a)).slice(0, MAX_BRANCH);
}

interface Node { game: Game; seq: number[]; score: number }

/**
 * Returns up to `maxMoves` screw ids to remove next. Only screws reachable in
 * the given snapshot are returned (never blocked ones); the sequence stops at
 * the first move that only becomes reachable after a panel drop.
 */
export function solveNextMoves(snapshot: GameSnapshot, maxMoves = 3): number[] {
  if (snapshot.status !== 'playing') return [];
  const root = Game.fromSnapshot(snapshot);
  const reachableNow = new Set(root.reachableScrewIds());
  if (reachableNow.size === 0) return [];
  const depth = Math.max(1, Math.min(maxMoves, 3));
  let beam: Node[] = [{ game: root, seq: [], score: evaluate(root) }];
  let best: Node | undefined;
  for (let d = 0; d < depth; d++) {
    const next: Node[] = [];
    for (const node of beam) {
      if (node.game.getStatus() !== 'playing') continue;
      for (const id of candidates(node.game)) {
        const g = node.game.clone();
        const r = g.tapScrew(id);
        if (!r.ok) continue;
        const n: Node = { game: g, seq: [...node.seq, id], score: evaluate(g) - d * 0.01 };
        next.push(n);
        if (!best || n.score > best.score) best = n;
      }
    }
    if (next.length === 0) break;
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, BEAM_WIDTH);
  }
  if (!best) return [];
  const out: number[] = [];
  for (const id of best.seq) {
    if (!reachableNow.has(id)) break;
    out.push(id);
    if (out.length >= maxMoves) break;
  }
  return out;
}

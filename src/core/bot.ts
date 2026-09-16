/**
 * Bot used to prove levels are winnable (and to gauge difficulty):
 *   1. if a reachable screw matches an active box with room, take it — preferring
 *      the fullest box, and among equals the screw that brings a plate closest to
 *      dropping (clearing a plate out is what keeps new screws arriving, and it
 *      is what a human does);
 *   2. otherwise, if the tray has room, park a reachable screw there. The choice
 *      is human-like but greedy: prefer screws whose plate is nearly empty
 *      (dropping it unblocks things), especially when that plate covers screws
 *      of an active box colour, and prefer colours already accumulating in the
 *      tray (a lazily spawned box of that colour then chains them out). A dose
 *      of randomness keeps play-throughs varied;
 *   3. otherwise it loses.
 * No lookahead on purpose: tray pressure is what makes a level hard, and the
 * generator's lazy box queue is the only thing that rescues the bot.
 *
 * Deterministic for a given seed and level, so replaying with the recorded
 * queue reproduces the exact same play-through.
 */
import { BOX_CAPACITY, type ScrewColor } from './types';
import { Rng } from './rng';
import type { Game } from './game';

export interface BotResult {
  outcome: 'won' | 'lost' | 'stuck';
  steps: number;
  /** Number of screws the bot had to park in the tray. */
  trayUses: number;
  /** Maximum simultaneous tray occupancy. */
  peakTray: number;
  /** With `trace`: reachable screw count before each move (CONTRACT_V2 §5). */
  reachPerStep?: number[];
  /** With `trace`: number of distinct plates holding a reachable screw. */
  frontsPerStep?: number[];
  /** With `trace`: the screw ids tapped, in order (a replayable winning line). */
  picks?: number[];
  /** With `trace`: distinct colours among the simultaneously active boxes. */
  boxColorsPerStep?: number[];
}

export interface BotOptions {
  /**
   * Naive mode: matching screws are picked at random (not fullest box first)
   * and tray choices are uniformly random. Used to estimate how forgiving a
   * level is for a player who does not plan.
   */
  naive?: boolean;
  maxSteps?: number;
  /** Record the per-step reachable/front counts used by the non-linearity gate. */
  trace?: boolean;
}

export function playBot(game: Game, seed: number, opts: BotOptions = {}): BotResult {
  const rng = new Rng(seed);
  const naive = opts.naive === true;
  const maxSteps = opts.maxSteps ?? 5000;
  let steps = 0;
  let trayUses = 0;
  let peakTray = 0;
  const reachPerStep: number[] | undefined = opts.trace ? [] : undefined;
  const frontsPerStep: number[] | undefined = opts.trace ? [] : undefined;
  const picks: number[] | undefined = opts.trace ? [] : undefined;
  const boxColorsPerStep: number[] | undefined = opts.trace ? [] : undefined;
  const finish = (outcome: BotResult['outcome']): BotResult => ({
    outcome, steps, trayUses, peakTray,
    ...(opts.trace ? { reachPerStep, frontsPerStep, picks, boxColorsPerStep } : {}),
  });
  const level = game.level;
  const plateById = new Map(level.plates.map((p) => [p.id, p]));
  const coverMap = game.coverageMap();

  while (steps < maxSteps) {
    if (game.getStatus() !== 'playing') break;
    const reachable = game.reachableScrewIds();
    if (reachable.length === 0) return finish('stuck');
    const screws = game.peekScrews();
    const byId = new Map(screws.map((s) => [s.id, s]));
    const boxes = game.peekBoxes();
    if (reachPerStep && frontsPerStep && boxColorsPerStep) {
      reachPerStep.push(reachable.length);
      const fronts = new Set<number>();
      for (const id of reachable) fronts.add(byId.get(id)!.plateId);
      frontsPerStep.push(fronts.size);
      boxColorsPerStep.push(new Set(boxes.map((b) => b.color)).size);
    }
    const boxRoom = new Map<ScrewColor, number>();
    for (const b of boxes) if (b.screws.length < BOX_CAPACITY) boxRoom.set(b.color, Math.max(boxRoom.get(b.color) ?? -1, b.screws.length));

    // 1. Matching screw → fullest box, preferring screws that bring a plate
    //    closer to dropping (that is what keeps new screws arriving, and it is
    //    what a human does: clear a plate out rather than pick at random).
    let pick = -1;
    let bestScore = -Infinity;
    const plateStates = naive ? undefined : new Map(game.peekPlates().map((p) => [p.id, p]));
    for (const id of reachable) {
      const s = byId.get(id)!;
      const fill = boxRoom.get(s.color) ?? -1;
      if (fill < 0) continue;
      if (naive) { if (pick < 0 || rng.chance(0.5)) pick = id; continue; }
      const left = plateStates!.get(s.plateId)!.remainingScrews.length;
      let hiddenActive = 0;
      for (const cid of coverMap.get(s.plateId) ?? []) {
        const c = byId.get(cid)!;
        if (c.location === 'plate' && boxRoom.has(c.color)) hiddenActive++;
      }
      const score = fill * 2 + 4 / left + (hiddenActive * 1.5) / left + rng.float(0, 0.8);
      if (score > bestScore) { bestScore = score; pick = id; }
    }
    if (pick < 0) {
      // 2. Tray.
      const tray = game.peekTray();
      if (!tray.includes(null)) {
        game.tapScrew(reachable[0]); // refused with trayFull → status 'lost'
        return finish('lost');
      }
      if (naive) {
        pick = rng.pick(reachable);
        trayUses++;
      } else {
      const trayCount = new Map<ScrewColor, number>();
      const remaining = new Map<ScrewColor, number>();
      for (const s of screws) {
        if (s.location === 'tray') trayCount.set(s.color, (trayCount.get(s.color) ?? 0) + 1);
        if (s.location === 'tray' || s.location === 'plate') remaining.set(s.color, (remaining.get(s.color) ?? 0) + 1);
      }
      const plates = new Map(game.peekPlates().map((p) => [p.id, p]));
      let bestScore = -Infinity;
      for (const id of reachable) {
        const s = byId.get(id)!;
        const plate = plates.get(s.plateId)!;
        const left = plate.remainingScrews.length;
        // Screws of an active colour that this plate is currently hiding.
        let hiddenActive = 0;
        for (const cid of coverMap.get(s.plateId) ?? []) {
          const c = byId.get(cid)!;
          if (c.location === 'plate' && boxRoom.has(c.color)) hiddenActive++;
        }
        const layer = plateById.get(s.plateId)!.layer;
        let score = 3 / left + (hiddenActive * 2.5) / left + (trayCount.get(s.color) ?? 0) * 1.2;
        score += (remaining.get(s.color) ?? 0) * 0.15 + layer * 0.2;
        score += rng.float(0, 2);
        if (score > bestScore) { bestScore = score; pick = id; }
      }
      trayUses++;
      }
    }
    picks?.push(pick);
    const r = game.tapScrew(pick);
    steps++;
    if (!r.ok) return finish(game.getStatus() === 'lost' ? 'lost' : 'stuck');
    const occ = game.peekTray().filter((x) => x !== null).length;
    if (occ > peakTray) peakTray = occ;
  }
  const st = game.getStatus();
  return finish(st === 'won' ? 'won' : st === 'lost' ? 'lost' : 'stuck');
}

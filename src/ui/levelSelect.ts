import type { LevelDef } from '../core/types';
import { h, svg, clear } from './dom';
import { ICONS } from './icons';

export type Difficulty = LevelDef['difficulty'];

export const PAGE_SIZE = 50;

export interface LevelSelectOptions {
  total: number;
  /** Synchronous, cached difficulty lookup (may be a little expensive the first time). */
  difficultyOf(level: number): Difficulty;
  onPick(level: number): void;
  onBack(): void;
}

export interface LevelSelectScreen {
  el: HTMLElement;
  /** Re-render for the current progress; jumps to the page containing `currentLevel`. */
  show(currentLevel: number, completed: ReadonlySet<number>): void;
}

export function createLevelSelect(opts: LevelSelectOptions): LevelSelectScreen {
  const pageCount = Math.max(1, Math.ceil(opts.total / PAGE_SIZE));
  let page = 0;
  let current = 1;
  let completed: ReadonlySet<number> = new Set();
  let tintJob = 0;

  const grid = h('div', { class: 'level-grid' });
  const pageLabel = h('div', { class: 'page-label' });
  const meta = h('span', { class: 'meta' });
  const prevBtn = h('button', { class: 'btn ghost', onClick: () => go(page - 1) }, svg(ICONS.chevronLeft), 'Prev');
  const nextBtn = h('button', { class: 'btn ghost', onClick: () => go(page + 1) }, 'Next', svg(ICONS.chevronRight));

  const el = h(
    'section',
    { class: 'screen', id: 'screen-levels' },
    h(
      'header',
      { class: 'page-header' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onClick: opts.onBack }, svg(ICONS.back)),
      h('h1', null, 'Levels'),
      meta,
    ),
    h(
      'div',
      { class: 'legend' },
      legend('easy', 'Easy'),
      legend('normal', 'Normal'),
      legend('hard', 'Hard'),
      legend('extreme', 'Extreme'),
    ),
    grid,
    h('footer', { class: 'pager' }, prevBtn, pageLabel, nextBtn),
  );

  function legend(cls: string, label: string): HTMLElement {
    const dot = h('i');
    dot.style.background = `var(--${cls})`;
    return h('span', null, dot, label);
  }

  function go(p: number): void {
    page = Math.min(pageCount - 1, Math.max(0, p));
    render();
  }

  function render(): void {
    const first = page * PAGE_SIZE + 1;
    const last = Math.min(opts.total, first + PAGE_SIZE - 1);
    pageLabel.replaceChildren(`${first} – ${last}`, h('small', null, `Page ${page + 1} of ${pageCount}`));
    meta.textContent = `${completed.size} / ${opts.total}`;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page >= pageCount - 1;

    clear(grid);
    const tiles: HTMLElement[] = [];
    for (let n = first; n <= last; n++) {
      const done = completed.has(n);
      const tile = h(
        'button',
        {
          class: `level-tile${done ? ' done' : ''}${n === current ? ' current' : ''}`,
          'aria-label': `Level ${n}${done ? ', completed' : ''}`,
          onClick: () => opts.onPick(n),
        },
        String(n),
        done ? h('span', { class: 'check' }, svg(ICONS.check)) : null,
      );
      tiles.push(tile);
      grid.appendChild(tile);
    }
    grid.scrollTop = 0;
    tintLazily(first, tiles);
  }

  /**
   * Difficulty needs generateLevel(n), which can cost a few ms each, so apply
   * the tints in small batches after the grid is on screen. If a single level
   * takes longer than SLOW_MS the rest of the page is left untinted rather
   * than janking the scroll.
   */
  const SLOW_MS = 60;
  function tintLazily(first: number, tiles: HTMLElement[]): void {
    const job = ++tintJob;
    let i = 0;
    const step = (): void => {
      if (job !== tintJob) return;
      const t0 = performance.now();
      while (i < tiles.length && performance.now() - t0 < 8) {
        const n = first + i;
        const tile = tiles[i];
        const t1 = performance.now();
        try {
          tile.classList.add(opts.difficultyOf(n));
        } catch {
          /* generator failed for this level: leave untinted */
        }
        i++;
        if (performance.now() - t1 > SLOW_MS) return; // too slow on this device: stop here
      }
      if (i < tiles.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  return {
    el,
    show(currentLevel, done) {
      current = currentLevel;
      completed = done;
      page = Math.min(pageCount - 1, Math.max(0, Math.floor((currentLevel - 1) / PAGE_SIZE)));
      render();
    },
  };
}

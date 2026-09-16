import type { LevelDef } from '../core/types';
import { h, svg, clear } from './dom';
import { ICONS } from './icons';

export type Difficulty = LevelDef['difficulty'];

export const PAGE_SIZE = 50;

export interface LevelSelectOptions {
  total: number;
  /**
   * Cheap, pure difficulty label for a level number — `difficultyLabelFor(n)`.
   * It must NOT generate a level: generation now costs up to ~2 s and would
   * hang the grid (CONTRACT_V2 §7).
   */
  difficultyOf(level: number): Difficulty;
  onPick(level: number): void;
  onBack(): void;
}

export interface ShowState {
  currentLevel: number;
  completed: ReadonlySet<number>;
  /** Level with a saved in-progress board, if any. */
  resumeLevel?: number | null;
}

export interface LevelSelectScreen {
  el: HTMLElement;
  /** Re-render for the current progress; jumps to the page containing `currentLevel`. */
  show(state: ShowState): void;
  /** Mark the tile that is being built (immediate feedback on tap). */
  setPending(level: number | null): void;
}

export function createLevelSelect(opts: LevelSelectOptions): LevelSelectScreen {
  const pageCount = Math.max(1, Math.ceil(opts.total / PAGE_SIZE));
  let page = 0;
  let current = 1;
  let resume: number | null = null;
  let completed: ReadonlySet<number> = new Set();
  let pending: number | null = null;
  const tiles = new Map<number, HTMLElement>();

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
    tiles.clear();
    for (let n = first; n <= last; n++) {
      const done = completed.has(n);
      const inProgress = resume === n;
      const label = `Level ${n}${done ? ', completed' : ''}${inProgress ? ', in progress' : ''}`;
      // The difficulty tint is a pure function of the level number, so it can be
      // applied while building the tile — no deferred work, no generation.
      const tile = h(
        'button',
        {
          class: `level-tile ${opts.difficultyOf(n)}${done ? ' done' : ''}${n === current ? ' current' : ''}${
            inProgress ? ' resume' : ''
          }${pending === n ? ' pending' : ''}`,
          'aria-label': label,
          onClick: () => {
            setPending(n);
            opts.onPick(n);
          },
        },
        h('span', { class: 'num' }, String(n)),
        done ? h('span', { class: 'check' }, svg(ICONS.check)) : null,
        inProgress && !done ? h('span', { class: 'dot' }) : null,
        h('span', { class: 'spin' }),
      );
      tiles.set(n, tile);
      grid.appendChild(tile);
    }
    grid.scrollTop = 0;
  }

  function setPending(level: number | null): void {
    if (pending !== null) tiles.get(pending)?.classList.remove('pending');
    pending = level;
    if (level !== null) tiles.get(level)?.classList.add('pending');
  }

  return {
    el,
    show(state) {
      current = state.currentLevel;
      completed = state.completed;
      resume = state.resumeLevel ?? null;
      pending = null;
      page = Math.min(pageCount - 1, Math.max(0, Math.floor((state.currentLevel - 1) / PAGE_SIZE)));
      render();
    },
    setPending,
  };
}

import { h, svg, clear } from './dom';
import { ICONS } from './icons';
import { HOW_TO_PLAY } from './howto';

let layer: HTMLElement | null = null;

function getLayer(): HTMLElement {
  if (!layer) {
    layer = h('div', { class: 'modal-layer' });
    (document.getElementById('app') ?? document.body).appendChild(layer);
  }
  return layer;
}

function open(modal: HTMLElement): void {
  const l = getLayer();
  clear(l);
  l.appendChild(modal);
  l.classList.add('show');
}

export function closeModal(): void {
  if (!layer) return;
  layer.classList.remove('show');
  clear(layer);
}

export function isModalOpen(): boolean {
  return !!layer?.classList.contains('show');
}

/** Wrap a handler so the modal closes before it runs. */
const then = (fn: () => void) => () => {
  closeModal();
  fn();
};

export interface WinModalOptions {
  level: number;
  moves: number;
  screws: number;
  isLast: boolean;
  onNext(): void;
  onLevels(): void;
}

export function showWinModal(o: WinModalOptions): void {
  open(
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'stars' }, svg(ICONS.star), svg(ICONS.star), svg(ICONS.star)),
      h('div', { class: 'emblem win' }, svg(ICONS.trophy)),
      h('h2', { class: 'win' }, 'Level complete!'),
      h('p', null, `Level ${o.level} cleared. Nice work!`),
      h(
        'div',
        { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, String(o.moves)), h('span', null, 'Moves')),
        h('div', { class: 'stat' }, h('b', null, String(o.screws)), h('span', null, 'Screws')),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary big block', onClick: then(o.onNext) }, o.isLast ? 'Play again' : 'Next level'),
        h('button', { class: 'btn ghost block', onClick: then(o.onLevels) }, svg(ICONS.grid), 'Levels'),
      ),
    ),
  );
}

export interface LoseModalOptions {
  onAddHole(): void;
  onRetry(): void;
  onLevels(): void;
}

export function showLoseModal(o: LoseModalOptions): void {
  open(
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'emblem lose' }, svg(ICONS.sad)),
      h('h2', { class: 'lose' }, 'Out of space!'),
      h('p', null, 'The tray is full and that screw has nowhere to go. Add a free hole and keep going?'),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { class: 'btn primary big block', onClick: then(o.onAddHole) },
          svg(ICONS.plus),
          'Add hole',
          h('span', { class: 'sub' }, '(free)'),
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn ghost', onClick: then(o.onRetry) }, svg(ICONS.restart), 'Retry'),
          h('button', { class: 'btn ghost', onClick: then(o.onLevels) }, svg(ICONS.grid), 'Levels'),
        ),
      ),
    ),
  );
}

export interface ConfirmOptions {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
}

export function showConfirm(o: ConfirmOptions): void {
  open(
    h(
      'div',
      { class: 'modal' },
      h('h2', null, o.title),
      h('p', null, o.text),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: `btn block ${o.danger ? 'danger' : 'primary'}`, onClick: then(o.onConfirm) }, o.confirmLabel),
        h('button', { class: 'btn ghost block', onClick: closeModal }, 'Cancel'),
      ),
    ),
  );
}

export function showHowToPlay(onClose?: () => void): void {
  open(
    h(
      'div',
      { class: 'modal howto' },
      h('h2', null, 'How to play'),
      h(
        'ol',
        null,
        HOW_TO_PLAY.map((step, i) =>
          h('li', { class: step.free ? 'free' : '' }, h('span', { class: 'n' }, step.free ? '★' : String(i + 1)), step.text),
        ),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary block', onClick: then(onClose ?? (() => {})) }, 'Got it')),
    ),
  );
}

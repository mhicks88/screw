import { POWER_UPS, type PowerUpId, type LevelDef } from '../core/types';
import { h, svg } from './dom';
import { ICONS, POWERUP_ICONS } from './icons';

export interface HudHandlers {
  onBack(): void;
  onRestart(): void;
  onPowerUp(id: PowerUpId): void;
  onCancelTargeting(): void;
}

export interface Hud {
  /** Top bar (back, level, progress, restart). */
  top: HTMLElement;
  /** Bottom bar (power-ups). */
  bottom: HTMLElement;
  /** "Tap a screw to drill" banner. */
  banner: HTMLElement;
  toast: HTMLElement;
  setLevel(level: number, difficulty: LevelDef['difficulty']): void;
  setProgress(removed: number, total: number): void;
  setTargeting(on: boolean): void;
  /** Little bounce on a power-up button when it fires. */
  pulse(id: PowerUpId): void;
  setPowerUpsEnabled(on: boolean): void;
  showToast(text: string): void;
  /** Pixel heights of the overlays (for renderer.setInsets). */
  measure(): { top: number; bottom: number };
}

export function createHud(handlers: HudHandlers): Hud {
  const levelName = h('span', { class: 'name' }, 'Level 1');
  const badge = h('span', { class: 'diff-badge normal' }, 'normal');
  const fill = h('div', { class: 'fill' });
  const count = h('span', { class: 'count' }, h('b', null, '0'), ' / 0');

  const top = h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-row' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back to menu', onClick: handlers.onBack }, svg(ICONS.back)),
      h('div', { class: 'level-title' }, levelName, badge),
      h('button', { class: 'icon-btn', 'aria-label': 'Restart level', onClick: handlers.onRestart }, svg(ICONS.restart)),
    ),
    h('div', { class: 'progress' }, h('div', { class: 'track' }, fill), count),
  );

  const buttons = new Map<PowerUpId, HTMLButtonElement>();
  const powerups = h('div', { class: 'powerups' });
  for (const pu of POWER_UPS) {
    const btn = h(
      'button',
      {
        class: `pu ${pu.id}`,
        'aria-label': `${pu.name} (free): ${pu.description}`,
        title: pu.description,
        onClick: () => handlers.onPowerUp(pu.id),
      },
      h('span', { class: 'ico' }, svg(POWERUP_ICONS[pu.id])),
      h('span', { class: 'name' }, pu.name),
      h('span', { class: 'free' }, 'FREE'),
    );
    buttons.set(pu.id, btn);
    powerups.appendChild(btn);
  }
  const bottom = h('div', { class: 'bottombar' }, powerups);

  const banner = h(
    'div',
    { class: 'banner' },
    svg(POWERUP_ICONS.drill),
    'Tap a screw to drill',
    h('button', { class: 'btn', onClick: handlers.onCancelTargeting }, 'Cancel'),
  );

  const toast = h('div', { class: 'toast' });
  let toastTimer = 0;

  return {
    top,
    bottom,
    banner,
    toast,
    setLevel(level, difficulty) {
      levelName.textContent = `Level ${level}`;
      badge.textContent = difficulty;
      badge.className = `diff-badge ${difficulty}`;
    },
    setProgress(removed, total) {
      const pct = total > 0 ? Math.min(100, (removed / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      count.replaceChildren(h('b', null, String(removed)), ` / ${total}`);
    },
    setTargeting(on) {
      banner.classList.toggle('show', on);
      buttons.get('drill')?.classList.toggle('active', on);
      // Place the banner just under the top bar.
      banner.style.top = `${top.getBoundingClientRect().height + 6}px`;
    },
    pulse(id) {
      const b = buttons.get(id);
      if (!b) return;
      b.classList.remove('pulse');
      void b.offsetWidth; // restart the animation
      b.classList.add('pulse');
    },
    setPowerUpsEnabled(on) {
      for (const b of buttons.values()) b.disabled = !on;
    },
    showToast(text) {
      toast.textContent = text;
      toast.classList.add('show');
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1600);
    },
    measure() {
      return {
        top: Math.round(top.getBoundingClientRect().height),
        bottom: Math.round(bottom.getBoundingClientRect().height),
      };
    },
  };
}

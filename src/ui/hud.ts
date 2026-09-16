import { POWER_UPS, type PowerUpId, type LevelDef } from '../core/types';
import { h, svg, clear } from './dom';
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
  /** Tray occupancy — `slots` is traySlots + bonusSlots, which grows during play. */
  setTray(used: number, slots: number): void;
  setTargeting(on: boolean): void;
  /** Little bounce on a power-up button when it fires. */
  pulse(id: PowerUpId): void;
  setPowerUpsEnabled(on: boolean): void;
  showToast(text: string): void;
  /** Pixel heights of the overlays (for renderer.setInsets). */
  measure(): { top: number; bottom: number };
}

/**
 * How many chunks the progress bar is cut into. A 150-screw level needs coarse
 * chunks to read at a glance; a 12-screw tutorial gets one chunk per box so the
 * bar still visibly moves on every box.
 */
function segmentCount(total: number): number {
  if (total <= 0) return 1;
  const boxes = Math.max(1, Math.round(total / 3));
  if (boxes <= 12) return boxes;
  return 10;
}

export function createHud(handlers: HudHandlers): Hud {
  const levelName = h('span', { class: 'name' }, 'Level 1');
  const badge = h('span', { class: 'diff-badge normal' }, 'normal');
  const track = h('div', { class: 'track' });
  const pct = h('span', { class: 'pct' }, '0%');
  const count = h('span', { class: 'count' }, h('b', null, '0'), ' / 0');
  const trayCount = h('span', { class: 'n' }, h('b', null, '0'), '/0');
  const trayChip = h('span', { class: 'tray-chip' }, svg(POWERUP_ICONS.addSlot), trayCount);

  let segs: HTMLElement[] = [];
  let segTotal = -1;

  function buildSegments(total: number): void {
    const n = segmentCount(total);
    clear(track);
    segs = Array.from({ length: n }, () => {
      const seg = h('span', { class: 'seg' }, h('i'));
      track.appendChild(seg);
      return seg;
    });
    segTotal = total;
  }

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
    h('div', { class: 'progress' }, track, pct, count, trayChip),
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
      if (total !== segTotal) buildSegments(total);
      const done = total > 0 ? Math.max(0, Math.min(1, removed / total)) : 0;
      const n = segs.length;
      for (let i = 0; i < n; i++) {
        const f = Math.max(0, Math.min(1, done * n - i));
        const fill = segs[i].firstElementChild as HTMLElement | null;
        if (fill) fill.style.width = `${f * 100}%`;
        segs[i].classList.toggle('full', f >= 1);
      }
      // Never round up to 100% before the level is actually finished.
      const raw = done * 100;
      const shown = raw >= 100 ? 100 : Math.min(99, Math.floor(raw));
      pct.textContent = `${shown}%`;
      count.replaceChildren(h('b', null, String(removed)), ` / ${total}`);
    },
    setTray(used, slots) {
      trayCount.replaceChildren(h('b', null, String(used)), `/${slots}`);
      const free = slots - used;
      trayChip.classList.toggle('warn', free === 1);
      trayChip.classList.toggle('danger', free <= 0);
      trayChip.setAttribute('aria-label', `Tray: ${used} of ${slots} holes used`);
    },
    setTargeting(on) {
      banner.classList.toggle('show', on);
      buttons.get('drill')?.classList.toggle('active', on);
      // Place the banner just under the top bar.
      banner.style.top = `${top.getBoundingClientRect().height + 8}px`;
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

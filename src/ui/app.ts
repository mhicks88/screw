/**
 * App orchestration: screens, game loop glue between core <-> renderer <-> HUD.
 */
import { Game, generateLevel, TOTAL_LEVELS } from '../core';
import type { ActionResult, GameEvent, LevelDef, PowerUpId } from '../core/types';
import { GameRenderer } from '../render/renderer';
import * as sfx from '../audio/sfx';
import {
  clearProgress,
  defaultProgress,
  firstUncompleted,
  loadProgress,
  markCompleted,
  saveProgress,
  setCurrentLevel,
  type Progress,
} from '../storage/progress';
import './styles.css';
import { h, clear } from './dom';
import { createMenu } from './menu';
import { createLevelSelect, type Difficulty } from './levelSelect';
import { createHud } from './hud';
import { createSettings } from './settings';
import { closeModal, isModalOpen, showConfirm, showHowToPlay, showLoseModal, showWinModal } from './modals';

type ScreenName = 'menu' | 'levels' | 'game' | 'settings';

const HINT_MS = 3000;
const HOWTO_SEEN_KEY = 'screwdom.howto.seen';

const REFUSAL_TEXT: Record<NonNullable<ActionResult['reason']>, string> = {
  notPlaying: '',
  blocked: 'That screw is covered by another plate',
  trayFull: 'The tray is full',
  noSuchScrew: 'No such screw',
  notOnPlate: 'That screw is already off the plate',
  noEmptyBox: 'No empty box to repaint',
  maxSlots: 'The tray is already at its maximum size',
  maxBoxes: 'No room for another box',
  nothingToDo: 'Nothing to do right now',
};

export function startApp(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app root missing');
  clear(root);

  sfx.installAudioUnlock();

  let progress: Progress = loadProgress();
  sfx.setSoundEnabled(progress.settings.sound);

  /* ---------------- state ---------------- */
  let screen: ScreenName = 'menu';
  let renderer: GameRenderer | null = null;
  let game: Game | null = null;
  let levelDef: LevelDef | null = null;
  let levelNumber = progress.currentLevel;
  let targeting = false;
  let hintTimer = 0;
  const soundTimers = new Set<number>();
  const difficultyCache = new Map<number, Difficulty>();

  const difficultyOf = (n: number): Difficulty => {
    let d = difficultyCache.get(n);
    if (!d) {
      d = generateLevel(n).difficulty;
      difficultyCache.set(n, d);
    }
    return d;
  };

  const completedSet = (): Set<number> => new Set(progress.completed);
  const nextLevelToPlay = (): number => {
    // Continue the level the player last chose if it is not done yet, otherwise the first uncompleted.
    if (!progress.completed.includes(progress.currentLevel)) return Math.min(progress.currentLevel, TOTAL_LEVELS);
    return firstUncompleted(progress, TOTAL_LEVELS);
  };

  /* ---------------- screens ---------------- */
  const menu = createMenu({
    onPlay: () => {
      sfx.play('click');
      resumeOrStart(nextLevelToPlay());
    },
    onLevels: () => {
      sfx.play('click');
      showScreen('levels');
    },
    onSettings: () => {
      sfx.play('click');
      showScreen('settings');
    },
  });

  const levels = createLevelSelect({
    total: TOTAL_LEVELS,
    difficultyOf,
    onPick: (n) => {
      sfx.play('click');
      resumeOrStart(n);
    },
    onBack: () => {
      sfx.play('click');
      showScreen('menu');
    },
  });

  const settings = createSettings({
    version: __APP_VERSION__,
    getSound: () => progress.settings.sound,
    setSound: (on) => {
      progress.settings.sound = on;
      sfx.setSoundEnabled(on);
      saveProgress(progress);
      if (on) sfx.play('click');
    },
    onBack: () => {
      sfx.play('click');
      showScreen('menu');
    },
    onHowToPlay: () => {
      sfx.play('click');
      showHowToPlay();
    },
    onResetProgress: () => {
      sfx.play('click');
      showConfirm({
        title: 'Reset progress?',
        text: 'All completed levels will be forgotten. Settings are kept. This cannot be undone.',
        confirmLabel: 'Reset everything',
        danger: true,
        onConfirm: () => {
          const sound = progress.settings.sound;
          clearProgress();
          progress = defaultProgress();
          progress.settings.sound = sound;
          saveProgress(progress);
          levelNumber = 1;
          game = null;
          levelDef = null;
          settings.refresh();
          refreshMenu();
          sfx.play('powerup');
        },
      });
    },
  });

  const hud = createHud({
    onBack: () => {
      sfx.play('click');
      showScreen('menu');
    },
    onRestart: () => {
      sfx.play('click');
      const snap = game?.snapshot();
      if (!snap || snap.moves === 0) {
        startLevel(levelNumber);
        return;
      }
      showConfirm({
        title: 'Restart level?',
        text: 'Every screw goes back to its plate.',
        confirmLabel: 'Restart',
        onConfirm: () => startLevel(levelNumber),
      });
    },
    onPowerUp: (id) => usePowerUp(id),
    onCancelTargeting: () => {
      sfx.play('click');
      setTargeting(false);
    },
  });

  const canvasHost = h('div', { class: 'canvas-host' });
  const gameScreen = h('section', { class: 'screen', id: 'screen-game' }, canvasHost, hud.top, hud.bottom, hud.banner);

  const screens: Record<ScreenName, HTMLElement> = {
    menu: menu.el,
    levels: levels.el,
    game: gameScreen,
    settings: settings.el,
  };
  // The toast lives at the root so it is visible from every screen.
  root.append(menu.el, levels.el, gameScreen, settings.el, hud.toast);

  function refreshMenu(): void {
    menu.update(nextLevelToPlay(), progress.completed.length, TOTAL_LEVELS);
  }

  function showScreen(name: ScreenName): void {
    closeModal();
    setTargeting(false);
    screen = name;
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
    if (name === 'menu') refreshMenu();
    if (name === 'levels') levels.show(levelNumber, completedSet());
    if (name === 'settings') settings.refresh();
    if (name === 'game') {
      ensureRenderer().setActive(!document.hidden);
      requestAnimationFrame(updateInsets);
    } else {
      renderer?.setActive(false);
      clearSoundTimers();
    }
  }

  /* ---------------- renderer ---------------- */
  function ensureRenderer(): GameRenderer {
    if (!renderer) {
      renderer = new GameRenderer(canvasHost, { onScrewTap: handleScrewTap });
      const ro = new ResizeObserver(() => updateInsets());
      ro.observe(hud.top);
      ro.observe(hud.bottom);
    }
    return renderer;
  }

  function updateInsets(): void {
    if (!renderer || screen !== 'game') return;
    const m = hud.measure();
    renderer.setInsets(m.top, m.bottom);
    if (targeting) hud.setTargeting(true); // re-position the banner
  }

  window.addEventListener('resize', () => {
    renderer?.resize();
    updateInsets();
  });
  window.visualViewport?.addEventListener('resize', () => {
    renderer?.resize();
    updateInsets();
  });
  window.addEventListener('orientationchange', () => setTimeout(() => {
    renderer?.resize();
    updateInsets();
  }, 200));
  document.addEventListener('visibilitychange', () => {
    if (!renderer) return;
    renderer.setActive(!document.hidden && screen === 'game');
  });

  /* ---------------- game flow ---------------- */
  function resumeOrStart(n: number): void {
    const snap = game?.snapshot();
    if (game && snap && levelNumber === n && snap.status === 'playing' && snap.moves > 0) {
      showScreen('game');
      syncHud();
      return;
    }
    startLevel(n);
    maybeShowHowTo();
  }

  function startLevel(n: number): void {
    const target = Math.min(TOTAL_LEVELS, Math.max(1, n));
    let def: LevelDef;
    try {
      def = generateLevel(target);
    } catch (err) {
      console.error(`generateLevel(${target}) failed`, err);
      hud.showToast(`Level ${target} could not be built`);
      if (screen !== 'game') showScreen(screen);
      return;
    }
    levelNumber = target;
    levelDef = def;
    difficultyCache.set(levelNumber, levelDef.difficulty);
    game = new Game(levelDef);
    setCurrentLevel(progress, levelNumber);
    clearSoundTimers();
    clearHint();
    showScreen('game');
    const r = ensureRenderer();
    r.loadLevel(game.snapshot());
    hud.setLevel(levelNumber, levelDef.difficulty);
    hud.setPowerUpsEnabled(true);
    syncHud();
  }

  function syncHud(): void {
    if (!game) return;
    const snap = game.snapshot();
    hud.setProgress(snap.removedScrews, snap.totalScrews);
  }

  function handleScrewTap(screwId: number): void {
    if (!game || screen !== 'game' || isModalOpen()) return;
    if (game.snapshot().status !== 'playing') return;
    clearHint();
    let res: ActionResult;
    if (targeting) {
      res = game.usePowerUp('drill', screwId);
      setTargeting(false);
      if (res.ok) {
        sfx.play('powerup');
        hud.pulse('drill');
      }
    } else {
      res = game.tapScrew(screwId);
    }
    applyResult(res);
  }

  function usePowerUp(id: PowerUpId): void {
    if (!game || isModalOpen() || game.snapshot().status !== 'playing') return;
    sfx.play('click');
    if (id === 'drill') {
      setTargeting(!targeting);
      return;
    }
    setTargeting(false);
    clearHint();
    const res = game.usePowerUp(id);
    if (id === 'hint') {
      const ids = res.hintScrewIds ?? [];
      if (!res.ok || ids.length === 0) {
        hud.showToast(res.reason ? REFUSAL_TEXT[res.reason] || 'No hint available' : 'No hint available');
        return;
      }
      hud.pulse('hint');
      sfx.play('powerup');
      ensureRenderer().setHint(ids);
      hintTimer = window.setTimeout(clearHint, HINT_MS);
      return;
    }
    if (res.ok) {
      hud.pulse(id);
      sfx.play('powerup');
    }
    applyResult(res);
  }

  function applyResult(res: ActionResult): void {
    if (!game) return;
    const r = ensureRenderer();
    if (!res.ok && res.events.length === 0) {
      const text = res.reason ? REFUSAL_TEXT[res.reason] : '';
      if (text) hud.showToast(text);
      if (res.reason === 'blocked') sfx.play('blocked');
      return;
    }
    playEventSounds(res.events);
    syncHud();
    const won = res.events.some((e) => e.type === 'win');
    const lost = res.events.some((e) => e.type === 'lose');
    const thisGame = game;
    const done = r.playEvents(res.events);
    if (won || lost) {
      hud.setPowerUpsEnabled(false);
      done.then(() => {
        if (game !== thisGame || screen !== 'game') return;
        if (won) onWin();
        else onLose();
      });
    }
  }

  function onWin(): void {
    if (!game) return;
    const snap = game.snapshot();
    markCompleted(progress, levelNumber);
    sfx.play('win');
    showWinModal({
      level: levelNumber,
      moves: snap.moves,
      screws: snap.totalScrews,
      isLast: levelNumber >= TOTAL_LEVELS,
      onNext: () => {
        sfx.play('click');
        startLevel(levelNumber >= TOTAL_LEVELS ? firstUncompleted(progress, TOTAL_LEVELS) : levelNumber + 1);
      },
      onLevels: () => {
        sfx.play('click');
        showScreen('levels');
      },
    });
  }

  function onLose(): void {
    sfx.play('lose');
    showLoseModal({
      onAddHole: () => {
        if (!game) return;
        const res = game.continueAfterLose();
        hud.setPowerUpsEnabled(true);
        hud.pulse('addSlot');
        sfx.play('powerup');
        applyResult(res);
      },
      onRetry: () => {
        sfx.play('click');
        startLevel(levelNumber);
      },
      onLevels: () => {
        sfx.play('click');
        showScreen('levels');
      },
    });
  }

  function setTargeting(on: boolean): void {
    if (targeting === on) return;
    targeting = on;
    hud.setTargeting(on);
    renderer?.setTargetingMode(on);
  }

  function clearHint(): void {
    if (hintTimer) {
      window.clearTimeout(hintTimer);
      hintTimer = 0;
      renderer?.setHint([]);
    }
  }

  function maybeShowHowTo(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(HOWTO_SEEN_KEY) === '1';
    } catch {
      seen = true;
    }
    if (seen || progress.completed.length > 0) return;
    try {
      localStorage.setItem(HOWTO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    showHowToPlay(() => sfx.play('click'));
  }

  /* ---------------- sounds ---------------- */
  function at(ms: number, name: sfx.SfxName): void {
    if (ms <= 0) {
      sfx.play(name);
      return;
    }
    const id = window.setTimeout(() => {
      soundTimers.delete(id);
      sfx.play(name);
    }, ms);
    soundTimers.add(id);
  }

  function clearSoundTimers(): void {
    for (const id of soundTimers) window.clearTimeout(id);
    soundTimers.clear();
  }

  /** Approximate the renderer's sequential timing so sounds line up with the animation. */
  function playEventSounds(events: GameEvent[]): void {
    let t = 0;
    for (const ev of events) {
      switch (ev.type) {
        case 'screwToBox':
          if (ev.from === 'plate') {
            at(t, 'screwOut');
            at(t + 330, 'screwIn');
            t += 380;
          } else {
            at(t, 'screwIn');
            t += 160;
          }
          break;
        case 'screwToTray':
          at(t, 'screwOut');
          at(t + 330, 'screwIn');
          t += 380;
          break;
        case 'boxComplete':
          at(t, 'boxComplete');
          t += 380;
          break;
        case 'boxSpawn':
          at(t, 'boxSpawn');
          t += 260;
          break;
        case 'plateDrop':
          at(t, 'plateDrop');
          t += 320;
          break;
        case 'screwRevealed':
          at(t, 'tap');
          break;
        case 'blockedTap':
          at(0, 'blocked');
          break;
        case 'traySlotAdded':
        case 'boxRecolored':
          at(t, 'powerup');
          break;
        default:
          break; // win/lose play when their modal opens; screwsUnblocked is silent
      }
    }
  }

  /* ---------------- boot ---------------- */
  showScreen('menu');

  if (import.meta.env.DEV) {
    (window as unknown as { __screwdom: unknown }).__screwdom = {
      get game() {
        return game;
      },
      get renderer() {
        return renderer;
      },
      get progress() {
        return progress;
      },
      /** Same code path as a real tap on the canvas. */
      debugTap: (id: number) => handleScrewTap(id),
      startLevel,
      showScreen,
      usePowerUp,
      difficultyOf,
    };
  }
}

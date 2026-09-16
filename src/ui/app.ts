/**
 * App orchestration: screens, game loop glue between core <-> renderer <-> HUD.
 *
 * Notes (CONTRACT_V2, CONTRACT_V3):
 *  - Levels reach ~190 screws, so a session is long: the board is persisted
 *    after every move and can be resumed from the menu or the level grid.
 *  - Generation costs up to ~2 s and happens in a worker behind a loading
 *    overlay. `generateLevel` is never called to *describe* a level — the level
 *    grid uses the pure `difficultyLabelFor(n)`.
 *  - v3: the board is a solid assembly the player turns with a one-finger drag.
 *    Teaching that gesture once is this file's job (see ./coach); the ongoing
 *    in-scene nudge toward off-screen screws belongs to the renderer.
 */
import { Game, TOTAL_LEVELS, difficultyLabelFor } from '../core';
import type { ActionResult, GameEvent, GameSnapshot, LevelDef, PowerUpId } from '../core/types';
import { GameRenderer } from '../render/renderer';
import * as sfx from '../audio/sfx';
import {
  clearGameState,
  clearProgress,
  defaultProgress,
  firstUncompleted,
  loadGameState,
  loadProgress,
  markCompleted,
  markRotateLearned,
  noteRotateCoachShown,
  saveGameState,
  saveProgress,
  setCurrentLevel,
  shouldShowRotateCoach,
  type Progress,
} from '../storage/progress';
import './styles.css';
import { h, clear } from './dom';
import { createMenu } from './menu';
import { createLevelSelect, type Difficulty } from './levelSelect';
import { createHud } from './hud';
import { createSettings } from './settings';
import { createLoadingOverlay } from './loading';
import { createRotateCoach } from './coach';
import { LevelLoader } from './levelLoader';
import { closeModal, isModalOpen, showConfirm, showHowToPlay, showLoseModal, showWinModal } from './modals';

type ScreenName = 'menu' | 'levels' | 'game' | 'settings';

const HINT_MS = 3000;
const HOWTO_SEEN_KEY = 'screwdom.howto.seen';
/** Debounce for writing the board to localStorage (a 150-screw board is ~50 KB). */
const SAVE_DEBOUNCE_MS = 450;
/** Once the overlay is up, keep it up this long so a fast build does not flicker. */
const MIN_LOADING_MS = 320;
/** Build the next level in the background this long after the current one starts. */
const PREFETCH_DELAY_MS = 1500;
/** Let the board land before asking the player to turn it. */
const ROTATE_COACH_DELAY_MS = 1100;
/** How many times to wait out a modal (the first-run card) before giving up. */
const ROTATE_COACH_RETRIES = 12;

const REFUSAL_TEXT: Record<NonNullable<ActionResult['reason']>, string> = {
  notPlaying: '',
  blocked: 'Something is in the way of that screw',
  trayFull: 'The tray is full',
  noSuchScrew: 'No such screw',
  notOnPlate: 'That screw is already out',
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
  let saveTimer = 0;
  let prefetchTimer = 0;
  /** Bumped on every load request; a stale result is dropped. */
  let loadToken = 0;
  const soundTimers = new Set<number>();
  const loader = new LevelLoader();

  /** Pure, cheap, never generates a level (CONTRACT_V2 §7). */
  const difficultyOf = (n: number): Difficulty => difficultyLabelFor(n);

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
      const r = progress.resume;
      if (r) void openLevel(r.level, 'auto');
      else void openLevel(nextLevelToPlay(), 'new');
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
      void openLevel(n, 'auto');
    },
    onBack: () => {
      sfx.play('click');
      showScreen('menu');
    },
  });

  const settings = createSettings({
    version: __APP_VERSION__,
    getSound: () => progress.settings.sound,
    getResume: () => progress.resume,
    onResume: (n: number) => {
      sfx.play('click');
      void openLevel(n, 'resume');
    },
    onDiscardSaved: () => {
      sfx.play('click');
      showConfirm({
        title: 'Discard saved board?',
        text: 'The level you are part-way through will start from scratch next time. Completed levels are kept.',
        confirmLabel: 'Discard board',
        danger: true,
        onConfirm: () => {
          const discarded = progress.resume?.level ?? null;
          dropSave(true);
          if (discarded === levelNumber && levelDef && game) {
            // The board on screen is the one being discarded: reset it.
            installGame(levelNumber, levelDef, new Game(levelDef));
            showScreen('settings');
          }
          settings.refresh();
          refreshMenu();
        },
      });
    },
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
        text: 'All completed levels and the level you are part-way through will be forgotten. Settings are kept. This cannot be undone.',
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
      leaveGame();
    },
    onRestart: () => {
      sfx.play('click');
      const snap = game?.snapshot();
      if (!snap || snap.moves === 0) {
        restartLevel();
        return;
      }
      showConfirm({
        title: 'Restart level?',
        text: 'Every panel goes back on the model and your saved board for this level is discarded.',
        confirmLabel: 'Restart',
        onConfirm: () => restartLevel(),
      });
    },
    onPowerUp: (id) => usePowerUp(id),
    onCancelTargeting: () => {
      sfx.play('click');
      setTargeting(false);
    },
  });

  const loading = createLoadingOverlay({
    onCancel: () => {
      sfx.play('click');
      cancelLoad();
    },
  });

  const rotateCoach = createRotateCoach({
    onLearned: () => {
      // The player turned the model. Never teach this again, on any device
      // where this progress record travels.
      markRotateLearned(progress);
    },
  });

  const canvasHost = h('div', { class: 'canvas-host' });
  const gameScreen = h(
    'section',
    { class: 'screen', id: 'screen-game' },
    canvasHost,
    hud.top,
    hud.bottom,
    hud.banner,
    rotateCoach.el,
  );
  rotateCoach.watch(canvasHost);

  const screens: Record<ScreenName, HTMLElement> = {
    menu: menu.el,
    levels: levels.el,
    game: gameScreen,
    settings: settings.el,
  };
  // The toast and the loading overlay live at the root so they cover every screen.
  root.append(menu.el, levels.el, gameScreen, settings.el, loading.el, hud.toast);

  function refreshMenu(): void {
    menu.update({
      nextLevel: nextLevelToPlay(),
      completedCount: progress.completed.length,
      total: TOTAL_LEVELS,
      resume: progress.resume,
    });
  }

  function showScreen(name: ScreenName): void {
    closeModal();
    setTargeting(false);
    screen = name;
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
    if (name === 'menu') refreshMenu();
    if (name === 'levels') {
      levels.show({ currentLevel: levelNumber, completed: completedSet(), resumeLevel: progress.resume?.level ?? null });
    }
    if (name === 'settings') settings.refresh();
    if (name === 'game') {
      ensureRenderer().setActive(!document.hidden);
      requestAnimationFrame(updateInsets);
    } else {
      renderer?.setActive(false);
      rotateCoach.hide();
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
    rotateCoach.setBottom(m.bottom + 14);
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
    if (document.hidden) saveNow();
    if (!renderer) return;
    renderer.setActive(!document.hidden && screen === 'game');
  });
  window.addEventListener('pagehide', () => saveNow());

  /* ---------------- persistence ---------------- */
  function saveNow(): void {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (!game) return;
    saveGameState(progress, levelNumber, game.snapshot());
  }

  function scheduleSave(): void {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      if (game) saveGameState(progress, levelNumber, game.snapshot());
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Forget the saved board. By default only when it belongs to the level on
   * screen — there is one save slot, and restarting level 5 must not throw away
   * the board someone left half-finished on level 712.
   */
  function dropSave(any = false): void {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (any || progress.resume === null || progress.resume.level === levelNumber) clearGameState(progress);
  }

  /* ---------------- level loading ---------------- */

  /**
   * `mode`:
   *   'new'    — always build a fresh board.
   *   'resume' — restore the saved board for this level (falls back to 'new').
   *   'auto'   — resume if there is a saved board for this level, else 'new'.
   */
  async function openLevel(n: number, mode: 'new' | 'resume' | 'auto'): Promise<void> {
    const target = Math.min(TOTAL_LEVELS, Math.max(1, Math.floor(n)));
    const token = ++loadToken;

    // Already on this board and mid-play: just go back to it.
    const live = game?.snapshot();
    if (mode !== 'new' && live && levelNumber === target && live.status === 'playing' && live.moves > 0) {
      showScreen('game');
      syncHud();
      return;
    }

    saveNow(); // never lose the board we are leaving
    const saved = mode === 'new' ? null : loadGameState(target);

    if (saved) {
      loading.show(target, difficultyOf(target), 'resume');
      await nextFrame();
      if (token !== loadToken) return;
      let restored: Game | null = null;
      try {
        restored = Game.fromSnapshot(saved);
      } catch (err) {
        console.warn('[resume] saved board could not be restored, starting fresh', err);
        clearGameState(progress);
      }
      if (restored) {
        installGame(target, restored.snapshot().level, restored);
        await nextFrame();
        if (token === loadToken) loading.hide();
        return;
      }
    }

    // A cached level starts instantly; anything else gets the overlay.
    // generateLevel is deterministic, so the LevelDef already in hand for this
    // level is exactly what a rebuild would produce.
    let def = loader.peek(target) ?? (levelDef?.level === target ? levelDef : undefined);
    if (!def) {
      loading.show(target, difficultyOf(target), 'build');
      const t0 = performance.now();
      try {
        def = await loader.request(target);
      } catch (err) {
        console.error(`generateLevel(${target}) failed`, err);
        if (token !== loadToken) return;
        loading.fail(target, () => {
          loading.hide();
          showScreen(screen === 'game' ? 'levels' : screen);
        });
        return;
      }
      if (token !== loadToken) return;
      const wait = MIN_LOADING_MS - (performance.now() - t0);
      if (wait > 0) await delay(wait);
      if (token !== loadToken) return;
    }

    installGame(target, def, new Game(def));
    await nextFrame();
    if (token === loadToken) loading.hide();
    maybeShowHowTo();
  }

  /** Put a freshly built / restored game on screen. */
  function installGame(n: number, def: LevelDef, g: Game): void {
    levelNumber = n;
    levelDef = def;
    game = g;
    setCurrentLevel(progress, levelNumber);
    clearSoundTimers();
    clearHint();
    levels.setPending(null);
    showScreen('game');
    const snap = g.snapshot();
    ensureRenderer().loadLevel(snap);
    hud.setLevel(levelNumber, def.difficulty);
    hud.setPowerUpsEnabled(snap.status === 'playing');
    hud.setProgress(snap.removedScrews, snap.totalScrews);
    hud.setTray(snap.tray.filter((s) => s !== null).length, snap.tray.length);
    schedulePrefetch(levelNumber + 1);
    maybeShowRotateCoach();
  }

  /** Rebuild the same level from the LevelDef we already have — no generation. */
  function restartLevel(): void {
    if (!levelDef) {
      void openLevel(levelNumber, 'new');
      return;
    }
    dropSave();
    installGame(levelNumber, levelDef, new Game(levelDef));
  }

  function cancelLoad(): void {
    loadToken++;
    loading.hide();
    levels.setPending(null);
    if (screen === 'game' && !game) showScreen('menu');
  }

  function schedulePrefetch(n: number): void {
    if (prefetchTimer) window.clearTimeout(prefetchTimer);
    if (n > TOTAL_LEVELS) return;
    prefetchTimer = window.setTimeout(() => {
      prefetchTimer = 0;
      loader.prefetch(n);
    }, PREFETCH_DELAY_MS);
  }

  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
  const delay = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

  /* ---------------- game flow ---------------- */
  function leaveGame(): void {
    const snap = game?.snapshot();
    if (!snap || snap.status !== 'playing' || snap.moves === 0) {
      dropSave();
      showScreen('menu');
      return;
    }
    saveNow();
    showConfirm({
      title: 'Leave this level?',
      text: `Level ${levelNumber} is ${snap.removedScrews} / ${snap.totalScrews} done. Your board is saved — "Resume" on the menu picks it up exactly where you left off.`,
      confirmLabel: 'Save & leave',
      onConfirm: () => showScreen('menu'),
    });
  }

  function syncHud(): void {
    if (!game) return;
    const snap = game.snapshot();
    hud.setProgress(snap.removedScrews, snap.totalScrews);
    hud.setTray(snap.tray.filter((s) => s !== null).length, snap.tray.length);
  }

  function handleScrewTap(screwId: number): void {
    if (!game || screen !== 'game' || isModalOpen() || loading.isVisible()) return;
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
    if (won) dropSave();
    else scheduleSave();
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
    dropSave();
    sfx.play('win');
    showWinModal({
      level: levelNumber,
      moves: snap.moves,
      screws: snap.totalScrews,
      isLast: levelNumber >= TOTAL_LEVELS,
      onNext: () => {
        sfx.play('click');
        void openLevel(levelNumber >= TOTAL_LEVELS ? firstUncompleted(progress, TOTAL_LEVELS) : levelNumber + 1, 'new');
      },
      onLevels: () => {
        sfx.play('click');
        showScreen('levels');
      },
    });
  }

  function onLose(): void {
    sfx.play('lose');
    // A lost board is not resumable; drop it so the menu does not offer it.
    dropSave();
    showLoseModal({
      onAddHole: () => {
        if (!game) return;
        const res = game.continueAfterLose();
        hud.setPowerUpsEnabled(true);
        hud.pulse('addSlot');
        sfx.play('powerup');
        applyResult(res);
        syncHud();
        scheduleSave();
      },
      onRetry: () => {
        sfx.play('click');
        restartLevel();
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

  /**
   * The one-time teach for the drag gesture. Held back until the board has had
   * a moment to settle so it does not fight the level-in animation, and skipped
   * entirely once the player has rotated anything, ever.
   *
   * On the very first level the first-run "How to play" card is up at the same
   * moment, so the mark waits its turn rather than being wasted behind it.
   */
  function maybeShowRotateCoach(attempt = 0): void {
    if (attempt === 0) rotateCoach.hide();
    if (!shouldShowRotateCoach(progress)) return;
    const forLevel = levelNumber;
    window.setTimeout(() => {
      if (screen !== 'game' || levelNumber !== forLevel) return;
      if (!shouldShowRotateCoach(progress)) return;
      if (game?.snapshot().status !== 'playing') return;
      if (isModalOpen() || loading.isVisible()) {
        if (attempt < ROTATE_COACH_RETRIES) maybeShowRotateCoach(attempt + 1);
        return;
      }
      updateInsets();
      rotateCoach.show();
      noteRotateCoachShown(progress);
    }, ROTATE_COACH_DELAY_MS);
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
        case 'panelDrop':
          // The thud lands as the panel unsticks; the fall itself runs ~660 ms
          // (src/render/animations.ts dropPanel), so hold the next cue back.
          at(t, 'panelDrop');
          t += 520;
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
      get levelNumber() {
        return levelNumber;
      },
      /** Same code path as a real tap on the canvas. */
      debugTap: (id: number) => handleScrewTap(id),
      startLevel: (n: number) => openLevel(n, 'new'),
      /**
       * Put a hand-made LevelDef on screen without going near `generateLevel`.
       * Walkthroughs use it to exercise the game screen while the generator is
       * being worked on; nothing in the shipped app calls it.
       */
      loadLevelDef: (def: LevelDef) => {
        loading.hide();
        loadToken++;
        installGame(def.level, def, new Game(def));
      },
      openLevel: (n: number, mode: 'new' | 'resume' | 'auto' = 'auto') => openLevel(n, mode),
      showScreen,
      usePowerUp,
      difficultyOf,
      isLoading: () => loading.isVisible(),
      rotateCoachVisible: () => rotateCoach.isVisible(),
      saveNow,
      loadSaved: (n?: number): GameSnapshot | null => loadGameState(n),
      reloadProgress: () => {
        progress = loadProgress();
        refreshMenu();
        return progress;
      },
    };
  }
}

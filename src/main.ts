import { registerSW } from 'virtual:pwa-register';
import { startApp } from './ui/app';

// Service worker: auto-updates in the background; a reload picks up new versions.
registerSW({
  immediate: true,
  onRegisterError(err: unknown) {
    console.warn('[pwa] service worker registration failed', err);
  },
});

startApp();

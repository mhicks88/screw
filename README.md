# Screwdom 3D (local build)

A from-scratch clone of the *Screwdom 3D* screw-puzzle game that runs entirely on
your phone with no account, no server, no purchases and no leagues. Every level
is open and every power-up is free and unlimited.

- 1000 procedurally generated, deterministic, solvable levels ramping from
  9-screw tutorials to 150-screw stacks up to 15 plates deep.
- Levels are built as 2-4 interlocking towers, so several parts of the board
  are workable at once. Every level is machine-verified to keep at least 3
  distinct plates and 8 screws in play on average, so you always have a choice
  of where to dig.
- Six power-ups, all free and unlimited: Drill, Extra Hole, Magic Box, Repaint,
  Magnet and Hint.
- Three.js rendering with covered screws culled and the rest drawn in two
  instanced batches, so a 150-screw board costs about 151 draw calls.
- WebAudio-synthesized sound, no asset downloads.
- Your board is saved as you play, so you can leave a long level and resume it
  exactly where you were, even after closing the app.
- Tuned specifically for iPhone 17 Pro Max (440x956 pt at 3x).

Level size by band:

| Levels | Screws | Layers | Towers | Tray slots | Boxes |
|---|---|---|---|---|---|
| 1-30 | 9-30 | 1-5 | 1-2 | 5 | 3 |
| 31-120 | 30-54 | 5-8 | 2 | 5-6 | 3 |
| 121-350 | 57-90 | 8-11 | 2-3 | 6-7 | 3 |
| 351-700 | 90-123 | 10-13 | 3 | 7 | 3 |
| 701-1000 | 126-150 | 12-15 | 3-4 | 8 | 4 |

## Run it on your iPhone

### Option A — free HTTPS URL via GitHub Pages (recommended: works offline)

1. Merge this branch into `main`.
2. In the GitHub repo: **Settings → Pages → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) runs the tests, builds,
   and publishes to `https://<your-user>.github.io/screw/`.
4. On the iPhone open that URL in **Safari**, tap **Share → Add to Home Screen
   → Add**. The icon launches full-screen and keeps working with no network.

### Option B — straight from your computer on the same Wi-Fi

```bash
npm install
npm run build
npm run preview      # prints http://<your-computer-ip>:4173
```

Open that address in Safari on the phone and **Add to Home Screen** the same
way. This works immediately, but because it is plain HTTP the browser will not
install the offline cache, so the computer has to keep serving while you play.

Any static HTTPS host also works (Netlify, Vercel, Cloudflare Pages): upload
the `dist/` folder. If the site lives under a sub-path, build with
`VITE_BASE=/that-path/ npm run build`.

## Optional: real native app via Xcode

If you would rather have an `.app` installed through Xcode (free Apple ID is
enough for a 7-day personal signing certificate):

```bash
npm run build
npm i -D @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Screwdom 3D" com.yourname.screwdom --web-dir dist
npx cap add ios
npx cap sync ios
npx cap open ios      # opens Xcode: pick your team, plug in the phone, Run
```

## Development

```bash
npm run dev          # dev server with hot reload (use --host to test on phone)
npm test             # vitest: rules + 139 sampled levels verified solvable (~80 s)
npm run sweep        # verify all 1000 levels and print the stats table (~12 min)
npm run build        # typecheck + production build into dist/
```

Level generation takes roughly half a second and runs in a Web Worker, so the
interface stays responsive; the game shows a loading card while it works.

Code layout is described in `CONTRACT.md`:
`src/core` (rules, generator, solver), `src/render` (three.js scene),
`src/ui` (screens/HUD), `src/audio`, `src/storage`.

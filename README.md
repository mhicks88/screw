# Screwdom 3D (local build)

A from-scratch clone of the *Screwdom 3D* screw-puzzle game that runs entirely on
your phone with no account, no server, no purchases and no leagues. Every level
is open and every power-up is free and unlimited.

- 1000 procedurally generated, deterministic, solvable levels with a smooth
  difficulty ramp (plates, layers, colours, mystery screws).
- Six power-ups: Drill, Extra Hole, Magic Box, Repaint, Magnet, Hint.
- Three.js rendering, WebAudio-synthesized sound, progress saved on-device.
- Ships as a Progressive Web App: open it once, add it to your Home Screen,
  and it works offline like a native app.

## Run it on your iPhone

You need a computer on the same Wi-Fi network as the phone (once, to install).

```bash
npm install
npm run build
npm run preview      # prints a http://<your-computer-ip>:4173 URL
```

1. On the iPhone, open **Safari** and go to the URL printed by `preview`.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch "Screwdom" from the Home Screen. It runs full-screen and offline
   from then on; you can stop the computer.

Any static host also works (the `dist/` folder is plain files), e.g.
GitHub Pages, Netlify, or `python3 -m http.server -d dist`.

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
npm test             # vitest: rules + all 1000 levels verified solvable
npm run build        # typecheck + production build into dist/
```

Code layout is described in `CONTRACT.md`:
`src/core` (rules, generator, solver), `src/render` (three.js scene),
`src/ui` (screens/HUD), `src/audio`, `src/storage`.

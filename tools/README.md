# Dev tools

Nothing in this folder ships in the extension.

| Command | What it does |
| --- | --- |
| `node tools/package.mjs` | Builds `dist/blastblastblast-<version>/` (unpacked, for **Load unpacked**) and `dist/blastblastblast-<version>.zip` (for the Chrome Web Store) with only the runtime files: manifest, popup, shared launcher, shortcut service worker, content script, icons. Older builds in `dist/` are removed. |
| `node tools/perf/check.mjs` | Functional checks on a heavy test page for v1.2.1 (from git) and the working tree: text blasting without reflow, images without network requests, page-anchored marks, iframe click-through, debounced saves, complete teardown and relaunch, plus (new builds) sound with voice caps and mute, silence in background tabs, the G/D/M keys, the blast report and the intro on short windows. `--shots <dir>` saves screenshots. |
| `node tools/perf/run.mjs` | Perf comparison: rapid cannon fire, gun hold-fire, Danger swarm and (new builds) every arsenal weapon against enemy vehicles (`--only arsenal`). Reports frame times, long tasks, layout shift, layout/style/script time and how many sounds the game played (Chrome runs muted). Options: `--cpu 4` (CPU throttling), `--dpr 2`, `--runs 3`, `--only cannon`, `--json out.json`. |
| `node tools/perf/popup-test.mjs` | Popup logic with a mocked `chrome.*` API (restricted pages, friendly errors, launch/remove, shortcut hint). |
| `node tools/perf/e2e.mjs` | End-to-end with the real unpacked extension: clicks the toolbar icon (activeTab), Launch/Remove in the real popup, first-run intro, iframe click-through, the real launch shortcut (including on a chrome:// page), typing into fields inside web components while playing, the blast report, chrome://, PDF and SVG pages. `--ext <dir>` tests another build (e.g. v1.2.1 from `git archive`). |
| `python3 tools/create_icons.py` | Regenerates `icons/*.png`. |

The perf tools need Node 22+ and Google Chrome (set `CHROME_PATH` if it isn't in the default location). They drive headless Chrome over the DevTools protocol and inject `content.js` into an isolated world on a local test page, with a small stand-in for `chrome.storage`.

## Loading the unpacked build

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `dist/blastblastblast-<version>/` (after `node tools/package.mjs`), or the repository root.
3. Pin BlastBlastBlast, open any website and click the icon → **Launch Cannon!**
4. Or press **Alt+Shift+X** (**⌥⇧X** on a Mac) on any website to launch or remove the game. Change it at `chrome://extensions/shortcuts`.

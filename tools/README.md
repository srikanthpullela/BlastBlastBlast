# Dev tools

Nothing in this folder ships in the extension.

| Command | What it does |
| --- | --- |
| `node tools/package.mjs` | Builds `dist/blastblastblast-<version>.zip` with only the runtime files (manifest, popup, content script, icons). |
| `node tools/perf/check.mjs` | Functional checks on a heavy test page for v1.2.1 (from git) and the working tree: text blasting without reflow, images without network requests, page-anchored marks, iframe click-through, debounced saves, complete teardown and relaunch. `--shots <dir>` saves screenshots. |
| `node tools/perf/run.mjs` | Perf comparison: rapid cannon fire, gun hold-fire and Danger swarm. Reports frame times, long tasks, layout shift and layout/style/script time. Options: `--cpu 4` (CPU throttling), `--dpr 2`, `--runs 3`, `--only cannon`, `--json out.json`. |
| `node tools/perf/popup-test.mjs` | Popup logic with a mocked `chrome.*` API (restricted pages, friendly errors, launch/remove). |
| `node tools/perf/e2e.mjs` | End-to-end with the real unpacked extension: clicks the toolbar icon (activeTab), Launch/Remove in the real popup, first-run intro, iframe click-through, chrome:// and PDF pages. `--ext <dir>` tests another build (e.g. v1.2.1 from `git archive`). |
| `python3 tools/create_icons.py` | Regenerates `icons/*.png`. |

The perf tools need Node 22+ and Google Chrome (set `CHROME_PATH` if it isn't in the default location). They drive headless Chrome over the DevTools protocol and inject `content.js` into an isolated world on a local test page, with a small stand-in for `chrome.storage`.

## Loading the unpacked build

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the repository root (the folder with `manifest.json`).
3. Pin BlastBlastBlast, open any website and click the icon → **Launch Cannon!**

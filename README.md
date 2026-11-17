# BlastBlastBlast

A Chrome extension that turns any webpage into a battlefield. Aim with your mouse, click to fire, and watch the page fly apart: letters scatter one by one, images shatter and buttons spin away. End the game and the page is restored.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/blastblastblast/pneepemfpipickddgckiakckipjkimdi)**

## How to play

1. Open any regular website.
2. Click the BlastBlastBlast icon and choose **Launch Cannon!**, or press **Alt+Shift+X** (**⌥⇧X** on a Mac).
3. Move the mouse to aim and click anywhere to fire. Some weapons keep firing while you hold the button.
4. Press **Esc** (or the shortcut again) to end the game and see your blast report.

| Key | Action |
| --- | --- |
| 1–6 | Pick a weapon |
| G / Shift+G | Next / previous weapon |
| D | Danger mode on/off |
| M | Sound on/off |
| Esc | End the game |

You can change the launch shortcut at `chrome://extensions/shortcuts`.

## Weapons

Cannon and Gun are always available. The others unlock as your lifetime score grows.

| Weapon | Unlocks at |
| --- | --- |
| 💣 Cannon | Start |
| 🔫 Gun | Start |
| 🚀 Rockets | 10 points |
| 🔥 Flamethrower | 25 points |
| ⚡ Laser | 50 points |
| 💥 Cluster bomb | 80 points |

## Enemies

- **Soldiers** march in, grab things from the page and run off with them. Stop them before they escape.
- **Enemy tanks** shell the page, and **bombers** fly over dropping bombs.
- **Danger mode** sends in a swarm from every side.

## Privacy

BlastBlastBlast collects nothing and makes no network requests. It runs only on the tab where you launch it, and keeps a few game values on your device: best score, lifetime score, the mute setting and whether you've seen the intro. See the [privacy policy](PRIVACY_POLICY.md).

## Development

The extension is plain JavaScript with no build step.

- **Try it:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder.
- **Package for the store:** `node tools/package.mjs` writes `dist/blastblastblast-<version>.zip` with only the runtime files.
- **Tests and performance checks:** see [tools/README.md](tools/README.md). They need Node 22+ and Google Chrome.

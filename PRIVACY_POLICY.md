# Privacy Policy

**BlastBlastBlast**
**Last Updated:** November 16, 2026

## Overview

BlastBlastBlast ("the Extension") is a Chrome browser extension that turns any webpage into a playful artillery game. When activated, it places a cannon and an arsenal of weapons at the bottom of the current page, lets you blast page content apart with physics-based explosions, and spawns soldiers, enemy tanks and bombers for you to shoot. This privacy policy explains what data the Extension accesses, how it is used, and how it is protected.

## Data Collection

**The Extension does not collect any data.** Specifically, the Extension does **not**:

- Collect, transmit, or store any personally identifiable information (PII)
- Track your browsing history or activity
- Gather usage analytics, telemetry, or crash reports
- Read, copy, or transmit the content of the pages you visit to any server
- Use cookies, fingerprinting, or any tracking technology
- Contact any remote server whatsoever

The Extension runs **entirely within your browser** and is fully self-contained. No information ever leaves your device.

## Data Access

To provide its gameplay, the Extension interacts with the page you are viewing **locally, in memory, only while you are playing**:

### Page Content (Read Locally)

- When you fire the cannon, the Extension reads the positions and contents of nearby on-page elements (text, images, buttons, icons) so it can animate them being scattered or "exploded."
- To animate an image, video frame, or drawing breaking apart, the Extension draws a temporary copy of what is already on screen into the game's own in-memory canvas. The copy is discarded as soon as the animation ends.
- This reading happens **only in your browser's memory at runtime** to render the animation. The content is **never stored, logged, or transmitted** anywhere.
- The Extension only modifies the page **visually and temporarily**: blasted text and elements are hidden, and while the game is running, embedded frames (such as video players) ignore clicks so you can aim over them. Removing the cannon (the "Remove Cannon" button, the Escape key, the Extension's popup, or its keyboard shortcut) restores the page and shows a short end-of-game report that disappears on its own. A normal page reload always returns the page to its original state. The Extension never makes permanent changes to any website.
- Game sound effects are generated in your browser while you play. No audio files are downloaded and nothing is recorded.

### Locally Stored Data

The Extension stores four small, non-personal values in your browser's local storage (`chrome.storage.local`):

- **High score (`cbBest`):** your best score in a single game, shown in the in-game scoreboard.
- **Lifetime score (`cbTotalKills`):** your total score across all games, used to unlock new weapons.
- **Intro shown (`cbIntroSeen`):** which version of the welcome screen you have already seen, so it is only shown again when it has something new to explain.
- **Sound setting (`cbMuted`):** whether you turned the game's sound off.

These values:

- Remain entirely on your device
- Contain no personal or page information
- Are never transmitted to any external server
- Can be cleared at any time by clearing the Extension's storage or removing the Extension

## Data Sharing

**The Extension does not share any data with third parties.** Because the Extension collects no data and contacts no servers, there is nothing to sell, transfer, or disclose. No data is used for advertising, marketing, or profiling.

## Remote Code

The Extension does **not** load or execute any remote code. All JavaScript, CSS, and assets are bundled within the extension package. The Extension does not load, import, or evaluate any external JavaScript, WebAssembly, or dynamically fetched code, and it does not make any network requests.

## Permissions

The Extension requests the following Chrome permissions, each used solely for the purposes described:

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the currently active tab when you click the Extension icon or press its keyboard shortcut, so the game can be injected into the page you are viewing |
| `scripting` | Inject the game's script into the active page on demand; the script adds the game's styles and removes them again when you remove the cannon |
| `storage` | Store your local high score, your lifetime score (for weapon unlocks), which welcome screen you have seen, and whether sound is off |

### Host Permissions

The Extension requests **no host permissions**. It only runs on the active tab when you explicitly click the Extension icon or press its keyboard shortcut (Alt+Shift+X by default, which you can change at `chrome://extensions/shortcuts`), and it does not run automatically on any website. Its background script only listens for that shortcut; it never runs on or reads a page by itself.

## Security

- The Extension operates within Chrome's sandboxed extension environment
- It is injected only on demand, when you click the Extension icon or press its keyboard shortcut
- No network communication of any kind is performed
- No data is persisted beyond the four local values described above

## Children's Privacy

The Extension is not directed at children under 13 and does not knowingly collect any information from children. It collects no information from anyone.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in the "Last Updated" date above. Continued use of the Extension after changes constitutes acceptance of the updated policy.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/srikanthpullela/BlastBlastBlast).

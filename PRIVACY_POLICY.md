# Privacy Policy

**BlastBlastBlast**
**Last Updated:** June 25, 2026

## Overview

BlastBlastBlast ("the Extension") is a Chrome browser extension that turns any webpage into a playful artillery game. When activated, it places a cannon and a gun at the bottom of the current page, lets you blast page content apart with physics-based explosions, and spawns soldiers that try to "steal" page elements for you to shoot. This privacy policy explains what data the Extension accesses, how it is used, and how it is protected.

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
- This reading happens **only in your browser's memory at runtime** to render the animation. The content is **never stored, logged, or transmitted** anywhere.
- The Extension only modifies the page **visually and temporarily**. Removing the cannon (the "Remove Cannon" button or the Escape key) restores the page, and a normal page reload always returns the page to its original state. The Extension never makes permanent changes to any website.

### Locally Stored Data

The Extension stores a single, non-personal value in your browser's local storage (`chrome.storage.local`):

- **High score (`cbBest`):** the best number of soldiers you have blasted, used to display your personal best in the in-game scoreboard.

This value:

- Remains entirely on your device
- Contains no personal or page information — it is just a number
- Is never transmitted to any external server
- Can be cleared at any time by clearing the Extension's storage or removing the Extension

## Data Sharing

**The Extension does not share any data with third parties.** Because the Extension collects no data and contacts no servers, there is nothing to sell, transfer, or disclose. No data is used for advertising, marketing, or profiling.

## Remote Code

The Extension does **not** load or execute any remote code. All JavaScript, CSS, and assets are bundled within the extension package. The Extension does not load, import, or evaluate any external JavaScript, WebAssembly, or dynamically fetched code, and it does not make any network requests.

## Permissions

The Extension requests the following Chrome permissions, each used solely for the purposes described:

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the currently active tab when you click the Extension icon, so the game can be injected into the page you are viewing |
| `scripting` | Inject the game's script and styles into the active page on demand to render the cannon, gun, and effects |
| `storage` | Store your local high score (a single number) in the browser |

### Host Permissions

The Extension requests **no host permissions**. It only runs on the active tab when you explicitly click the Extension icon, and it does not run automatically on any website.

## Security

- The Extension operates within Chrome's sandboxed extension environment
- It is injected only on demand, when you click the Extension icon
- No network communication of any kind is performed
- No data is persisted outside of the single local high-score value in your browser

## Children's Privacy

The Extension is not directed at children under 13 and does not knowingly collect any information from children. It collects no information from anyone.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in the "Last Updated" date above. Continued use of the Extension after changes constitutes acceptance of the updated policy.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/srikanthpullela/BlastBlastBlast).

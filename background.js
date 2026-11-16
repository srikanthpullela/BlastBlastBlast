/* BlastBlastBlast — background service worker.
 *
 * Only handles the keyboard shortcut (Alt+Shift+X by default; users can change
 * it at chrome://extensions/shortcuts). The shortcut launches the game on the
 * current page, or removes it if it is already running. Pressing an extension
 * shortcut grants activeTab for that tab, exactly like clicking the toolbar
 * icon, so this needs no extra permissions. It never runs on or reads a page
 * by itself.
 */
"use strict";

importScripts("launcher.js");

let busy = false;   // ignore repeats while a launch / removal is in progress

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === BBB_COMMAND) toggleFromShortcut(tab);
});

async function toggleFromShortcut(tab) {
  if (busy) return;
  busy = true;
  try {
    if (!tab || tab.id == null) {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return;
    }
    const check = await bbbCheckTab(tab);
    if (!check.ok) {
      await explain(tab, check.message);
      return;
    }
    try {
      if (check.active) await bbbRemoveGame(tab.id);
      else await bbbInjectGame(tab.id, "shortcut");
    } catch (err) {
      await explain(tab, bbbFriendlyError(err, tab.url || ""));
    }
  } finally {
    busy = false;
  }
}

// The popup explains why the game can't run here. If Chrome won't open it,
// flag the toolbar icon instead (the tooltip carries the explanation).
async function explain(tab, message) {
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
    return;
  } catch (e) { /* fall back to the badge */ }
  const tabId = tab.id;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setTitle({ tabId, title: "BlastBlastBlast: " + message });
  } catch (e) { return; }
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "BlastBlastBlast" }).catch(() => {});
  }, 5000);
}

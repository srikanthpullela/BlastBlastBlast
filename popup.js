/* BlastBlastBlast — popup controller
 * Injects the game into the active tab and toggles it on/off. The page checks
 * and the inject / remove calls live in launcher.js (shared with the
 * keyboard shortcut in background.js).
 */
"use strict";

const launchBtn = document.getElementById("launchBtn");
const statusEl = document.getElementById("status");
const shortcutEl = document.getElementById("shortcut");

let cannonActive = false;
let activeTabId = null;
let activeUrl = "";

/** Render the button + status to match current active state. */
function render() {
  if (cannonActive) {
    launchBtn.textContent = "✕ Remove Cannon";
    launchBtn.classList.add("remove");
  } else {
    launchBtn.textContent = "🔥 Launch Cannon!";
    launchBtn.classList.remove("remove");
  }
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

function block(msg) {
  setStatus(msg, true);
  launchBtn.disabled = true;
}

/** Shows the launch shortcut (or how to set one) under the hint. */
async function renderShortcut() {
  const key = await bbbShortcut();
  shortcutEl.textContent = "";
  shortcutEl.append(key ? "Shortcut: " : "No shortcut set · ");
  if (key) {
    const k = document.createElement("kbd");
    k.textContent = key;
    shortcutEl.append(k, " launches on any page · ");
  }
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = key ? "change" : "set one";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  shortcutEl.append(link);
}

/** Get the current active tab. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  renderShortcut();
  let tab = null;
  try { tab = await getActiveTab(); } catch (e) { /* handled below */ }
  if (!tab || tab.id == null) {
    block("No active tab found.");
    return;
  }
  activeUrl = tab.url || tab.pendingUrl || "";
  const check = await bbbCheckTab(tab);
  if (!check.ok) {
    block(check.message);
    return;
  }
  activeTabId = tab.id;
  cannonActive = check.active;
  render();
}

launchBtn.addEventListener("click", async () => {
  if (activeTabId == null) return;
  launchBtn.disabled = true;
  try {
    if (cannonActive) {
      const reportShown = await bbbRemoveGame(activeTabId);
      cannonActive = false;
      setStatus("Cannon removed.");
      // The page now shows the blast report; get out of its way.
      if (reportShown) setTimeout(() => window.close(), 200);
    } else {
      await bbbInjectGame(activeTabId, "popup");
      cannonActive = true;
      setStatus("Cannon deployed! 🎯");
    }
    render();
  } catch (err) {
    console.error(err);
    setStatus(bbbFriendlyError(err, activeUrl), true);
  } finally {
    launchBtn.disabled = false;
  }
});

init();

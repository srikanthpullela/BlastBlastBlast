/* BlastBlastBlast — popup controller
 * Injects the game into the active tab and toggles it on/off.
 */
"use strict";

const launchBtn = document.getElementById("launchBtn");
const statusEl = document.getElementById("status");

let cannonActive = false;
let activeTabId = null;

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

/** Get the current active tab. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Ask the page whether the cannon is currently active (function injection). */
async function probeActive(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__cannonBlastActive,
    });
    return !!(results && results[0] && results[0].result);
  } catch (e) {
    return false;
  }
}

/** Inject content.css + content.js into the page. */
async function injectGame(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
  });
}

/** Tell the running game to tear itself down. */
async function removeGame(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (typeof window.__cannonBlastDestroy === "function") {
        window.__cannonBlastDestroy();
      }
    },
  });
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    setStatus("No active tab found.", true);
    launchBtn.disabled = true;
    return;
  }
  // Restricted pages can't be injected.
  if (/^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com\/webstore)/i.test(tab.url || "")) {
    setStatus("Cannot run on this page.", true);
    launchBtn.disabled = true;
    return;
  }
  activeTabId = tab.id;
  cannonActive = await probeActive(activeTabId);
  render();
}

launchBtn.addEventListener("click", async () => {
  if (activeTabId == null) return;
  launchBtn.disabled = true;
  try {
    if (cannonActive) {
      await removeGame(activeTabId);
      cannonActive = false;
      setStatus("Cannon removed.");
    } else {
      await injectGame(activeTabId);
      cannonActive = true;
      setStatus("Cannon deployed! 🎯");
    }
    render();
  } catch (err) {
    console.error(err);
    setStatus("Failed: " + (err && err.message ? err.message : "unknown error"), true);
  } finally {
    launchBtn.disabled = false;
  }
});

init();

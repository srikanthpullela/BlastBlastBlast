/* BlastBlastBlast — popup controller
 * Injects the game into the active tab and toggles it on/off.
 */
"use strict";

const launchBtn = document.getElementById("launchBtn");
const statusEl = document.getElementById("status");

let cannonActive = false;
let activeTabId = null;
let activeUrl = "";

const MSG_PROTECTED = "Chrome doesn't allow extensions on this page. Open a regular website and try again.";
const MSG_STORE = "Chrome doesn't allow extensions on the Chrome Web Store. Open another site and try again.";
const MSG_FILE = "To play on local files, turn on “Allow access to file URLs” for BlastBlastBlast in chrome://extensions.";
const MSG_PDF = "PDFs open in Chrome's built-in viewer, which can't be blasted. Try a regular web page.";
const MSG_ERROR_PAGE = "This tab is showing an error page. Load a website and try again.";
const MSG_GENERIC = "BlastBlastBlast can't run on this page. Try a regular website.";

// Pages Chrome never lets extensions script.
const BLOCKED_SCHEME = /^(chrome|chrome-untrusted|chrome-search|chrome-extension|chrome-devtools|chrome-error|devtools|edge|brave|opera|vivaldi|about|view-source):/i;
const STORE_URL = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)([/?#]|$)/i;

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

/** Friendly explanation for a page we can't (or couldn't) inject into. */
function restrictionFor(url) {
  if (STORE_URL.test(url)) return MSG_STORE;
  if (BLOCKED_SCHEME.test(url)) return MSG_PROTECTED;
  return null;
}

function friendlyError(err, url) {
  const msg = String((err && err.message) || err || "");
  if (STORE_URL.test(url) || /gallery cannot be scripted/i.test(msg)) return MSG_STORE;
  if (/error page/i.test(msg)) return MSG_ERROR_PAGE;
  if (/^file:/i.test(url)) return MSG_FILE;
  if (/cannot access|cannot be scripted|permission|not allowed|chrome:\/\//i.test(msg)) return MSG_PROTECTED;
  return MSG_GENERIC;
}

/** Get the current active tab. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Ask the page whether the game is running (and whether it is a PDF). Throws if the page can't be scripted. */
async function probePage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ active: !!window.__cannonBlastActive, type: document.contentType }),
  });
  const r = (results && results[0] && results[0].result) || {};
  return { active: !!r.active, pdf: r.type === "application/pdf" };
}

/** Inject the game into the page's top frame (it adds and removes its own styles). */
async function injectGame(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
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
  let tab = null;
  try { tab = await getActiveTab(); } catch (e) { /* handled below */ }
  if (!tab || tab.id == null) {
    block("No active tab found.");
    return;
  }
  activeUrl = tab.url || tab.pendingUrl || "";
  const restricted = restrictionFor(activeUrl);
  if (restricted) {
    block(restricted);
    return;
  }
  if (/^file:/i.test(activeUrl) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    block(MSG_FILE);
    return;
  }
  activeTabId = tab.id;
  try {
    const probe = await probePage(activeTabId);
    if (probe.pdf) {
      block(MSG_PDF);
      return;
    }
    cannonActive = probe.active;
  } catch (err) {
    block(friendlyError(err, activeUrl));
    return;
  }
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
    setStatus(friendlyError(err, activeUrl), true);
  } finally {
    launchBtn.disabled = false;
  }
});

init();

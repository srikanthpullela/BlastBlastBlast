/* BlastBlastBlast — launch logic shared by the popup (popup.js) and the
 * keyboard shortcut (background.js): which pages Chrome lets the game run on,
 * friendly explanations when it can't, and injecting / removing the game in
 * a tab. Clicking the toolbar icon or pressing the shortcut grants activeTab
 * for the current tab; nothing here needs any other permission.
 */
"use strict";

const BBB_COMMAND = "toggle-game";

const BBB_MSG = {
  protected: "Chrome doesn't allow extensions on this page. Open a regular website and try again.",
  store: "Chrome doesn't allow extensions on the Chrome Web Store. Open another site and try again.",
  file: "To play on local files, turn on “Allow access to file URLs” for BlastBlastBlast in chrome://extensions.",
  pdf: "PDFs open in Chrome's built-in viewer, which can't be blasted. Try a regular web page.",
  notHtml: "This is an SVG or XML file, not a web page, so it can't be blasted. Try a regular website.",
  errorPage: "This tab is showing an error page. Load a website and try again.",
  generic: "BlastBlastBlast can't run on this page. Try a regular website.",
};

// Pages Chrome never lets extensions script.
const BBB_BLOCKED_SCHEME = /^(chrome|chrome-untrusted|chrome-search|chrome-extension|chrome-devtools|chrome-error|devtools|edge|brave|opera|vivaldi|about|view-source):/i;
const BBB_STORE_URL = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)([/?#]|$)/i;

/** Friendly explanation for a page Chrome won't let us script, or null. */
function bbbRestrictionFor(url) {
  if (BBB_STORE_URL.test(url)) return BBB_MSG.store;
  if (BBB_BLOCKED_SCHEME.test(url)) return BBB_MSG.protected;
  return null;
}

/** Plain-words version of a scripting error. */
function bbbFriendlyError(err, url) {
  const msg = String((err && err.message) || err || "");
  if (BBB_STORE_URL.test(url) || /gallery cannot be scripted/i.test(msg)) return BBB_MSG.store;
  if (/error page/i.test(msg)) return BBB_MSG.errorPage;
  if (/^file:/i.test(url)) return BBB_MSG.file;
  if (/cannot access|cannot be scripted|permission|not allowed|chrome:\/\//i.test(msg)) return BBB_MSG.protected;
  return BBB_MSG.generic;
}

/** The keyboard shortcut bound to launching the game, e.g. "Alt+Shift+X" or "⌥⇧X" ("" if none). */
async function bbbShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === BBB_COMMAND);
    return (cmd && cmd.shortcut) || "";
  } catch (e) {
    return "";
  }
}

/** Asks the page whether the game is running and what kind of document it is. Throws if Chrome won't let us script it. */
async function bbbProbePage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      active: !!window.__cannonBlastActive,
      type: document.contentType,
      html: document.documentElement instanceof HTMLElement,
    }),
  });
  const r = (results && results[0] && results[0].result) || {};
  return { active: !!r.active, pdf: r.type === "application/pdf", html: r.html !== false };
}

/** Can the game run in this tab? Resolves to { ok: true, active } or { ok: false, message }. */
async function bbbCheckTab(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || "";
  const restricted = bbbRestrictionFor(url);
  if (restricted) return { ok: false, message: restricted };
  if (/^file:/i.test(url) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return { ok: false, message: BBB_MSG.file };
  }
  let probe;
  try {
    probe = await bbbProbePage(tab.id);
  } catch (err) {
    return { ok: false, message: bbbFriendlyError(err, url) };
  }
  if (probe.pdf) return { ok: false, message: BBB_MSG.pdf };
  if (!probe.html) return { ok: false, message: BBB_MSG.notHtml };
  return { ok: true, active: probe.active };
}

/** Injects the game into the tab's top frame. `via` is "popup" or "shortcut". */
async function bbbInjectGame(tabId, via) {
  const info = { shortcut: await bbbShortcut(), via };
  // Same isolated world as content.js: tells the game how it was launched.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (launch) => { self.__cbLaunch = launch; },
    args: [info],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

/** Ends the game. Resolves to true if the page now shows the end-of-game blast report. */
async function bbbRemoveGame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (typeof window.__cannonBlastDestroy === "function" ? !!window.__cannonBlastDestroy() : false),
  });
  return !!(results && results[0] && results[0].result);
}

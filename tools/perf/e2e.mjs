#!/usr/bin/env node
// End-to-end check with the real unpacked extension and Chrome's real
// permission model: loads the extension, "clicks" the toolbar icon
// (Extensions.triggerAction → activeTab), presses Launch in the real popup,
// plays a little, then Remove. Presses the real launch shortcut (a Chrome
// extension command, which grants activeTab the same way). Also checks
// restricted pages, PDFs and SVG files, and whether clicks over a
// cross-origin iframe reach the game. Chrome runs muted.
// Dev-only; not part of the extension.
//
//   node tools/perf/e2e.mjs [--ext <dir>]     (default: the repository root)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHROME_PATH, sleep } from "./cdp.mjs";
import { startServer } from "./server.mjs";
import { ROOT } from "./harness.mjs";

const args = process.argv.slice(2);
const EXT = path.resolve(args.includes("--ext") ? args[args.indexOf("--ext") + 1] : ROOT);

// CDP over --remote-debugging-pipe (required for the Extensions domain).
function launchPiped() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bbb-e2e-"));
  const proc = spawn(CHROME_PATH, [
    "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--mute-audio", "--window-size=1280,800", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const out = proc.stdio[3], inp = proc.stdio[4];
  let nextId = 0, pending = new Map(), listeners = [], chunks = [];
  inp.on("data", (chunk) => {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0) continue;
      chunks.push(chunk.subarray(start, i));
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      chunks = [];
      start = i + 1;
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else listeners.forEach((fn) => fn(msg));
    }
    if (start < chunk.length) chunks.push(chunk.subarray(start));
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++nextId;
    out.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  };
  const close = async () => { proc.kill(); await sleep(300); try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} };
  return { send, on: (fn) => listeners.push(fn), close };
}

async function evaluate(b, sessionId, expression) {
  const r = await b.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}

async function openTab(b, url) {
  const { targetId } = await b.send("Target.createTarget", { url });
  await b.send("Target.activateTarget", { targetId });   // bring it to the front, like a user switching tabs
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  await b.send("Page.enable", {}, sessionId);
  await b.send("Runtime.enable", {}, sessionId);
  await waitFor(() => evaluate(b, sessionId, "document.readyState === 'complete'").catch(() => false), 10000);
  await sleep(500);
  return { targetId, sessionId };
}

// Clicks the toolbar icon for a tab and returns the popup's session.
async function openPopup(b, extId, tab) {
  const before = new Set((await b.send("Target.getTargets")).targetInfos.map((t) => t.targetId));
  // triggerAction needs the *tab* target that hosts the page target.
  const tabs = (await b.send("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
  const page = (await b.send("Target.getTargets")).targetInfos.find((t) => t.targetId === tab.targetId);
  const tabTarget = tabs.find((t) => t.targetId === (page && page.parentId)) || tabs.find((t) => page && t.url === page.url);
  if (!tabTarget) throw new Error("tab target not found");
  await b.send("Extensions.triggerAction", { id: extId, targetId: tabTarget.targetId });
  const popup = await waitFor(async () => (await b.send("Target.getTargets")).targetInfos
    .find((t) => !before.has(t.targetId) && t.url.includes("popup.html")), 5000);
  if (!popup) throw new Error("popup did not open");
  const { sessionId } = await b.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true });
  await b.send("Runtime.enable", {}, sessionId);
  await waitFor(() => evaluate(b, sessionId, "document.readyState === 'complete'").catch(() => false));
  await sleep(600);   // init() probes the page
  return { targetId: popup.targetId, sessionId };
}

const popupState = (b, popup) => evaluate(b, popup.sessionId,
  `({ status: document.getElementById("status").textContent, disabled: document.getElementById("launchBtn").disabled, label: document.getElementById("launchBtn").textContent })`);

async function tabKey(b, tab, digit) {
  for (const type of ["keyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, key: digit, code: "Digit" + digit, windowsVirtualKeyCode: 48 + Number(digit) }, tab.sessionId);
  }
}
const arsenalLabel = (b, tab) => evaluate(b, tab.sessionId,
  `(function(){ var a = document.getElementById("__cb_arsenal"); return a ? a.firstChild.textContent : null; })()`);

// The launch shortcut as Chrome sees it: Alt (Option on Mac) + Shift + X.
async function pressShortcut(b, tab) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, modifiers: 1 | 8, key: "X", code: "KeyX", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 }, tab.sessionId);
  }
}

async function tabEscape(b, tab) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, tab.sessionId);
  }
}

// Types text into whatever has focus in the tab.
async function typeText(b, tab, text) {
  for (const ch of text) {
    const code = /\d/.test(ch) ? "Digit" + ch : "Key" + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: vk }, tab.sessionId);
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk }, tab.sessionId);
  }
}

// Evaluates in the extension's service worker.
async function swEval(b, extId, expression) {
  const sw = (await b.send("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://" + extId));
  if (!sw) throw new Error("service worker not running");
  const { sessionId } = await b.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const r = await b.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  await b.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function tabClick(b, tab, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, tab.sessionId);
  }
}

async function main() {
  const server = await startServer();
  const b = launchPiped();
  const results = [];
  const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
  try {
    const { id: extId } = await b.send("Extensions.loadUnpacked", { path: EXT });
    record("Extension loads unpacked", !!extId, `${path.relative(process.cwd(), EXT) || "."} → ${extId}`);

    // Normal page: launch from the real popup.
    const tab = await openTab(b, `${server.origin}/heavy.html`);
    let popup = await openPopup(b, extId, tab);
    let st = await popupState(b, popup);
    record("Popup ready on a normal page", !st.disabled && /Launch/.test(st.label), JSON.stringify(st));
    await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);
    await sleep(800);
    st = await popupState(b, popup);
    const running = await evaluate(b, tab.sessionId, `!!document.getElementById("__cannon_wrapper")`);
    record("Launch injects the game", running && /Remove/.test(st.label), JSON.stringify(st));

    // First-run intro, then dismiss it (stores cbIntroSeen).
    const intro = await evaluate(b, tab.sessionId, `!!document.getElementById("__cbIntroOk")`);
    if (intro) await evaluate(b, tab.sessionId, `document.getElementById("__cbIntroOk").click()`);
    await sleep(300);
    const stored = { data: await evaluate(b, popup.sessionId, `chrome.storage.local.get(null)`) };
    record("First-run intro shows once and is remembered", intro && stored.data && !!stored.data.cbIntroSeen, JSON.stringify(stored.data));

    // Clicks over the cross-origin iframe should fire the cannon.
    await evaluate(b, tab.sessionId, `document.getElementById("xframe").scrollIntoView({ block: "center" })`);
    await sleep(1200);
    const fr = await evaluate(b, tab.sessionId, `(function(){ var r = document.getElementById("xframe").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const countMarks = `document.querySelectorAll(".__cb_mark").length + [].filter.call(document.documentElement.children, function (e) { return e.style && e.style.zIndex === "2147483644" && e.querySelector("svg"); }).length`;
    const m0 = await evaluate(b, tab.sessionId, countMarks);
    await tabClick(b, tab, fr.x, fr.y);
    await sleep(2200);
    const m1 = await evaluate(b, tab.sessionId, countMarks);
    record("Click over a cross-origin iframe fires the cannon", m1 > m0, `marks ${m0} → ${m1}`);

    // Remove from the popup restores the page and (after playing) shows the
    // blast report; the popup closes so the report is visible.
    await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`).catch(() => {});
    await sleep(700);
    const left = await evaluate(b, tab.sessionId, `document.querySelectorAll("#__cannon_wrapper,#__cb_styles,[data-cb-hidden]").length`);
    const reportShown = await evaluate(b, tab.sessionId, `!!document.getElementById("__cb_report")`);
    const popupOpen = (await b.send("Target.getTargets")).targetInfos.some((t) => t.targetId === popup.targetId);
    record("Remove restores the page, shows the blast report and closes the popup", left === 0 && reportShown && !popupOpen,
      `${left} leftover node(s), report shown: ${reportShown}, popup open: ${popupOpen}`);
    if (popupOpen) await b.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});
    await tabEscape(b, tab);
    await sleep(400);

    // Relaunch on the same page via a fresh popup.
    popup = await openPopup(b, extId, tab);
    await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);
    await sleep(800);
    const again = await evaluate(b, tab.sessionId, `!!document.getElementById("__cannon_wrapper")`);
    record("Relaunch works", again);

    // Weapon unlocks (builds with the arsenal): Rockets need 10 lifetime points.
    if (await arsenalLabel(b, tab) !== null) {
      await tabKey(b, tab, "3");
      await sleep(200);
      const locked = await arsenalLabel(b, tab);
      await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);   // remove (saves stats)
      await sleep(500);
      await evaluate(b, popup.sessionId, `chrome.storage.local.set({ cbTotalKills: 10 })`);
      await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);   // launch again
      await sleep(800);
      await tabKey(b, tab, "3");
      await sleep(200);
      const unlocked = await arsenalLabel(b, tab);
      record("Rockets locked for new players, unlocked at 10 points", /CANNON/.test(locked) && /ROCKETS/.test(unlocked), `${locked} → ${unlocked}`);
    }
    await b.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});

    // The launch shortcut: a real Chrome extension command.
    const cmds = await swEval(b, extId, "chrome.commands.getAll()");
    const cmd = cmds.find((c) => c.name === "toggle-game");
    record("Launch shortcut is registered", !!(cmd && cmd.shortcut), cmd ? `${cmd.shortcut} — ${cmd.description}` : "missing");
    const t2 = await openTab(b, `${server.origin}/heavy.html`);
    // Text fields inside web components (open and closed shadow roots), like many sites' search boxes.
    await evaluate(b, t2.sessionId, `(function () {
      ["open", "closed"].forEach(function (mode) {
        var host = document.createElement("x-field-" + mode), input = document.createElement("input");
        host.attachShadow({ mode: mode }).appendChild(input);
        document.body.prepend(host);
        window["__" + mode + "Field"] = input;
      });
      __openField.focus();
    })()`);
    await pressShortcut(b, t2);
    await sleep(1200);
    const viaKey = await evaluate(b, t2.sessionId, `!!document.getElementById("__cannon_wrapper")`);
    record("Shortcut launches the game on a new page (activeTab, no popup)", viaKey);
    // The game's letter and number keys must not swallow typing in those fields.
    await typeText(b, t2, "dmg2");
    await evaluate(b, t2.sessionId, "__closedField.focus()");
    await typeText(b, t2, "dmg2");
    const typed = await evaluate(b, t2.sessionId, `({ open: __openField.value, closed: __closedField.value,
      weapon: document.getElementById("__cb_arsenal").firstChild.textContent,
      dangerOff: /OFF/.test(document.getElementById("__cb_danger_btn").textContent),
      sound: document.querySelector('button[title*="press M"]').textContent })`);
    await evaluate(b, t2.sessionId, "__closedField.blur()");
    record("Typing in fields inside web components goes to the field, not the game",
      typed.open === "dmg2" && typed.closed === "dmg2" && /CANNON/.test(typed.weapon) && typed.dangerOff && typed.sound === "🔊", JSON.stringify(typed));
    await tabClick(b, t2, 520, 300);
    await sleep(1700);
    await pressShortcut(b, t2);
    await sleep(800);
    const viaKeyOff = await evaluate(b, t2.sessionId, `({ game: !!document.getElementById("__cannon_wrapper"),
      report: (function(){ var h = document.getElementById("__cb_report"); return h ? h.shadowRoot.textContent : ""; })() })`);
    record("Shortcut again removes it and shows the blast report (with the shortcut)", !viaKeyOff.game && /BLAST REPORT/.test(viaKeyOff.report) && viaKeyOff.report.includes(cmd.shortcut),
      Array.from(viaKeyOff.report.replace(/\s+/g, " ")).slice(0, 80).join("") + "…");
    await tabEscape(b, t2);

    // The shortcut on a page Chrome protects explains why instead of failing silently.
    const t3 = await openTab(b, "chrome://version/");
    const before = new Set((await b.send("Target.getTargets")).targetInfos.map((t) => t.targetId));
    await pressShortcut(b, t3);
    await sleep(1500);
    const pop = (await b.send("Target.getTargets")).targetInfos.find((t) => !before.has(t.targetId) && t.url.includes("popup.html"));
    let how = "";
    if (pop) {
      const { sessionId } = await b.send("Target.attachToTarget", { targetId: pop.targetId, flatten: true });
      await b.send("Runtime.enable", {}, sessionId);
      await sleep(600);
      how = "popup: " + await evaluate(b, sessionId, `document.getElementById("status").textContent`);
      await b.send("Target.closeTarget", { targetId: pop.targetId }).catch(() => {});
    } else {
      how = "badge: " + await swEval(b, extId, `chrome.tabs.query({ active: true, lastFocusedWindow: true })
        .then(function (t) { return Promise.all([chrome.action.getBadgeText({ tabId: t[0].id }), chrome.action.getTitle({ tabId: t[0].id })]); })
        .then(function (r) { return r.join(" · "); })`);
    }
    record("Shortcut on a chrome:// page explains why it can't run", /doesn't allow extensions/.test(how), how);

    // Restricted page and PDF: Launch is disabled with a friendly message.
    for (const [name, url, re] of [["chrome:// page", "chrome://version/", /doesn't allow extensions/],
                                    ["PDF viewer", `${server.origin}/doc.pdf`, /PDF/],
                                    ["SVG document", `${server.origin}/logo.svg`, /SVG or XML/]]) {
      const t = await openTab(b, url);
      const p = await openPopup(b, extId, t);
      const s = await popupState(b, p);
      record(`${name}: blocked with a friendly message`, s.disabled && re.test(s.status), s.status);
      await b.send("Target.closeTarget", { targetId: p.targetId }).catch(() => {});
    }
  } finally {
    await b.close();
    await server.close();
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `\n${failed} e2e check(s) failed.` : "\nAll e2e checks pass.");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });

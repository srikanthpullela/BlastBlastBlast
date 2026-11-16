#!/usr/bin/env node
// End-to-end check with the real unpacked extension and Chrome's real
// permission model: loads the extension, "clicks" the toolbar icon
// (Extensions.triggerAction → activeTab), presses Launch in the real popup,
// plays a little, then Remove. Also checks restricted pages and PDFs, and
// whether clicks over a cross-origin iframe reach the game.
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
    "--window-size=1280,800", "about:blank",
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
    record("First-run intro shows once and is remembered", intro && stored.data && stored.data.cbIntroSeen === true, JSON.stringify(stored.data));

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

    // Remove from the popup restores the page.
    await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);
    await sleep(500);
    const left = await evaluate(b, tab.sessionId, `document.querySelectorAll("#__cannon_wrapper,#__cb_styles,[data-cb-hidden]").length`);
    st = await popupState(b, popup);
    record("Remove tears the game down", left === 0 && /Launch/.test(st.label), `${left} leftover node(s); ${st.status}`);
    await b.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});

    // Relaunch on the same page via a fresh popup.
    popup = await openPopup(b, extId, tab);
    await evaluate(b, popup.sessionId, `document.getElementById("launchBtn").click()`);
    await sleep(800);
    const again = await evaluate(b, tab.sessionId, `!!document.getElementById("__cannon_wrapper")`);
    record("Relaunch works", again);
    await b.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});

    // Restricted page and PDF: Launch is disabled with a friendly message.
    for (const [name, url, re] of [["chrome:// page", "chrome://version/", /doesn't allow extensions/],
                                    ["PDF viewer", `${server.origin}/doc.pdf`, /PDF/]]) {
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

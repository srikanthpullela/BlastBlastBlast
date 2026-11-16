// Shared helpers for the perf + functional checks: building the two variants
// (baseline from git, current from the working tree) and driving a page.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./cdp.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// The commit that imported the unmodified v1.2.1 build (first commit adding content.js).
export function defaultBaselineRev() {
  const revs = git(["log", "--diff-filter=A", "--format=%H", "--", "content.js"]).trim().split("\n");
  return revs[revs.length - 1];
}

export function loadVariants(baselineRev) {
  const rev = baselineRev || defaultBaselineRev();
  let baseCss = "";
  try { baseCss = git(["show", `${rev}:content.css`]); } catch {}
  return [
    { name: "v1.2.1", js: git(["show", `${rev}:content.js`]), css: baseCss },
    { name: "current", js: readFileSync(path.join(ROOT, "content.js"), "utf8"), css: "" },
  ];
}

// Installed in the main world before any page script: frame + long-task + layout-shift recorders.
export const PERF_RECORDER = `
  window.__perf = { frames: [], lt: [], ls: [], loaf: [] };
  (function () {
    function f(t) { __perf.frames.push(t); requestAnimationFrame(f); }
    requestAnimationFrame(f);
    function obs(type, fn) { try { new PerformanceObserver(function (l) { l.getEntries().forEach(fn); }).observe({ type: type, buffered: true }); } catch (e) {} }
    obs("longtask", function (e) { __perf.lt.push([e.startTime, e.duration]); });
    obs("layout-shift", function (e) { __perf.ls.push([e.startTime, e.value]); });
    obs("long-animation-frame", function (e) { __perf.loaf.push([e.startTime, e.duration, e.blockingDuration || 0]); });
  })();
`;

// chrome.* stand-ins for the isolated world (the real popup injects with these APIs available).
function chromeShim(introSeen) {
  return `
    var __cbStore = { cbIntroSeen: ${introSeen ? "true" : "false"} };
    globalThis.chrome = {
      runtime: { getManifest: function () { return { version: "test" }; } },
      storage: { local: {
        get: function (keys, cb) { var r = {}; [].concat(keys).forEach(function (k) { if (k in __cbStore) r[k] = __cbStore[k]; }); if (cb) setTimeout(function () { cb(r); }, 0); return Promise.resolve(r); },
        set: function (obj, cb) { Object.assign(__cbStore, obj); window.__cbWrites = (window.__cbWrites || 0) + 1; if (cb) setTimeout(cb, 0); return Promise.resolve(); }
      } }
    };
    if (!chrome.storage) throw new Error("chrome shim not installed");
  `;
}

export async function openPage(browser, url, { cpu = 1, width = 1280, height = 800, dpr = 1 } = {}) {
  const page = await browser.newPage();
  page.errors = [];
  page.on("Runtime.exceptionThrown", (e) => {
    const d = e.exceptionDetails || {};
    page.errors.push((d.exception && d.exception.description) || d.text || "exception");
  });
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error") page.errors.push(e.args.map((a) => a.value || a.description || "").join(" "));
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Performance.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  if (cpu > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_RECORDER });
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
  await page.eval("Promise.all([...document.images].map(i => i.decode().catch(() => {})))");
  await sleep(300);
  return page;
}

// Injects the game into a fresh isolated world (like a content script). Returns the context id.
export async function injectGame(page, variant, { introSeen = true, contextId = null } = {}) {
  if (!contextId) {
    const { frameTree } = await page.send("Page.getFrameTree");
    const world = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "BlastBlastBlast" });
    contextId = world.executionContextId;
    await page.eval(chromeShim(introSeen), contextId);
  }
  if (variant.css) {
    await page.eval(`(function(){ var s = document.createElement("style"); s.setAttribute("data-harness", ""); s.textContent = ${JSON.stringify(variant.css)}; document.documentElement.appendChild(s); })()`);
  }
  await page.eval(variant.js, contextId);
  await sleep(100);
  return contextId;
}

export async function removeHarnessCss(page) {
  await page.eval(`document.querySelectorAll("style[data-harness]").forEach(function (s) { s.remove(); })`);
}

export async function mouse(page, type, x, y, extra = {}) {
  await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" || extra.held ? 1 : 0, clickCount: 1, pointerType: "mouse", ...extra });
}

export async function click(page, x, y) {
  await mouse(page, "mouseMoved", x, y);
  await mouse(page, "mousePressed", x, y);
  await mouse(page, "mouseReleased", x, y);
}

export async function key(page, keyName, code, keyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
}

export async function centerOf(page, selector) {
  return page.eval(`(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}

export function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

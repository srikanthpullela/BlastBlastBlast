#!/usr/bin/env node
// Popup checks with a mocked chrome.* API: restricted pages are blocked up
// front with a friendly message, injection errors are explained, and launch /
// remove call the right APIs. Dev-only; not part of the extension.
//
//   node tools/perf/popup-test.mjs
import { pathToFileURL } from "node:url";
import path from "node:path";
import { launchChrome, sleep } from "./cdp.mjs";
import { ROOT, click } from "./harness.mjs";

const POPUP = pathToFileURL(path.join(ROOT, "popup.html")).href;

// cfg: { url, fileAccess, contentType, probeError, injectError }
function mockChrome(cfg) {
  return `
    window.__calls = [];
    window.__cfg = ${JSON.stringify(cfg)};
    window.chrome = {
      tabs: { query: async function () { return [{ id: 7, url: __cfg.url }]; } },
      extension: { isAllowedFileSchemeAccess: async function () { return !!__cfg.fileAccess; } },
      scripting: {
        insertCSS: async function (o) { __calls.push("insertCSS"); },
        removeCSS: async function (o) { __calls.push("removeCSS"); },
        executeScript: async function (o) {
          if (o.files) {
            __calls.push("inject:" + o.files.join(",") + (o.target.allFrames ? ":allFrames" : ""));
            if (__cfg.injectError) throw new Error(__cfg.injectError);
            __cfg.active = true;
            return [{ result: undefined }];
          }
          var src = String(o.func);
          if (src.indexOf("__cannonBlastDestroy") >= 0) { __calls.push("remove"); __cfg.active = false; return [{}]; }
          __calls.push("probe");
          if (__cfg.probeError) throw new Error(__cfg.probeError);
          return [{ result: { active: !!__cfg.active, type: __cfg.contentType || "text/html", html: __cfg.html !== false } }];
        }
      }
    };
  `;
}

const STORE = /Chrome Web Store/;
const PROTECTED = /doesn't allow extensions on this page/;
const CASES = [
  { name: "New Chrome Web Store", cfg: { url: "https://chromewebstore.google.com/detail/abc" }, status: STORE, disabled: true, calls: [] },
  { name: "Old Web Store URL", cfg: { url: "https://chrome.google.com/webstore/detail/abc" }, status: STORE, disabled: true, calls: [] },
  { name: "chrome:// page", cfg: { url: "chrome://extensions/" }, status: PROTECTED, disabled: true, calls: [] },
  { name: "view-source:", cfg: { url: "view-source:https://example.com/" }, status: PROTECTED, disabled: true, calls: [] },
  { name: "devtools:", cfg: { url: "devtools://devtools/bundled/inspector.html" }, status: PROTECTED, disabled: true, calls: [] },
  { name: "chrome-search: (NTP)", cfg: { url: "chrome-search://local-ntp/local-ntp.html" }, status: PROTECTED, disabled: true, calls: [] },
  { name: "file: without access", cfg: { url: "file:///Users/me/page.html", fileAccess: false }, status: /Allow access to file URLs/, disabled: true, calls: [] },
  { name: "file: with access", cfg: { url: "file:///Users/me/page.html", fileAccess: true }, status: /^$/, disabled: false, calls: ["probe"] },
  { name: "PDF viewer", cfg: { url: "https://example.com/doc.pdf", contentType: "application/pdf" }, status: /PDF/, disabled: true, calls: ["probe"] },
  { name: "SVG / XML document", cfg: { url: "https://example.com/logo.svg", contentType: "image/svg+xml", html: false }, status: /SVG or XML/, disabled: true, calls: ["probe"] },
  { name: "Probe blocked by Chrome", cfg: { url: "https://example.com/", probeError: "Cannot access contents of the page. Extension manifest must request permission to access the respective host." }, status: PROTECTED, disabled: true, calls: ["probe"] },
  { name: "Error page", cfg: { url: "https://down.example/", probeError: "Frame with ID 0 is showing error page" }, status: /error page/, disabled: true, calls: ["probe"] },
  { name: "Launch + remove", cfg: { url: "https://example.com/" }, status: /Cannon removed/, disabled: false, clicks: 2, calls: ["probe", "inject:content.js", "remove"] },
  { name: "Launch fails later", cfg: { url: "https://example.com/", injectError: "Cannot access contents of url \"https://example.com/\"." }, status: PROTECTED, disabled: false, clicks: 1, calls: ["probe", "inject:content.js"] },
];

async function main() {
  const browser = await launchChrome();
  let failed = 0;
  try {
    for (const c of CASES) {
      const page = await browser.newPage();
      await page.send("Page.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: mockChrome(c.cfg) });
      const loaded = page.once("Page.loadEventFired");
      await page.send("Page.navigate", { url: POPUP });
      await loaded;
      await sleep(150);
      for (let i = 0; i < (c.clicks || 0); i++) {
        const r = await page.eval(`(function(){ var b = document.getElementById("launchBtn").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        await click(page, r.x, r.y);
        await sleep(150);
      }
      const st = await page.eval(`({ status: document.getElementById("status").textContent, disabled: document.getElementById("launchBtn").disabled, calls: window.__calls })`);
      const ok = c.status.test(st.status) && st.disabled === c.disabled && JSON.stringify(st.calls) === JSON.stringify(c.calls);
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(26)} "${st.status}" disabled=${st.disabled} calls=${st.calls.join(",") || "-"}`);
      await page.send("Page.close").catch(() => {});
      page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} popup case(s) failed.` : "\nAll popup cases pass.");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });

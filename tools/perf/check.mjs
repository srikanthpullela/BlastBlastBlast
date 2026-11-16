#!/usr/bin/env node
// Functional checks for both builds on the heavy test page: text blasting
// without reflow, framework-owned text, srcset/quote images, page-anchored
// marks, iframe click-through, debounced best score, complete teardown and
// relaunch. Prints a pass/fail table. Dev-only; not part of the extension.
//
//   node tools/perf/check.mjs [--baseline <rev>] [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchChrome, sleep } from "./cdp.mjs";
import { startServer } from "./server.mjs";
import { loadVariants, openPage, injectGame, removeHarnessCss, mouse, click, key, centerOf } from "./harness.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const SHOTS = opt("shots", null);

// Fires at (x, y) and waits until the ball has landed plus `after` ms.
async function blastAt(page, x, y, after = 1500) {
  await mouse(page, "mouseMoved", x, y);
  await sleep(50);
  await mouse(page, "mousePressed", x, y);
  await mouse(page, "mouseReleased", x, y);
  const vp = await page.eval("({ w: innerWidth, h: innerHeight })");
  const flight = Math.max(0.6, Math.min(Math.hypot(x - vp.w / 2, y - (vp.h - 85)) / 440, 1.5));
  await sleep(flight * 1000 + 50 + after);
}

async function screenshot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(data, "base64"));
}

// DOM fingerprint of the page (ignores the ticker text that changes on its own).
const SNAPSHOT = `(function () {
  var html = document.documentElement;
  var body = document.body.cloneNode(true);
  var t = body.querySelector("#ticker"); if (t) t.textContent = "";
  var attrs = [].map.call(html.attributes, function (a) { return a.name + "=" + a.value; }).join(" ");
  return { body: body.outerHTML, htmlAttrs: attrs, htmlChildren: html.children.length,
           text: body.querySelector("#article").textContent };
})()`;

const markCount = `document.querySelectorAll(".__cb_mark").length +
  [].filter.call(document.documentElement.children, function (e) { return e.style && e.style.zIndex === "2147483644" && e.querySelector("svg"); }).length`;

async function newestMarkTop(page) {
  return page.eval(`(function () {
    var m = document.querySelectorAll(".__cb_mark");
    if (m.length) return m[m.length - 1].getBoundingClientRect().top;
    var old = [].filter.call(document.documentElement.children, function (e) { return e.style && e.style.zIndex === "2147483644" && e.querySelector("svg"); });
    return old.length ? old[old.length - 1].getBoundingClientRect().top : null;
  })()`);
}

async function runChecks(browser, server, variant) {
  const out = [];
  const record = (name, pass, detail) => out.push({ name, pass, detail });
  const page = await openPage(browser, `${server.origin}/heavy.html`);
  const before = await page.eval(SNAPSHOT);
  const ctx = await injectGame(page, variant);
  await sleep(300);

  // Iframe click-through: a click over a cross-origin iframe must fire the cannon.
  await page.eval(`document.getElementById("xframe").scrollIntoView({ block: "center" })`);
  await sleep(1200);   // let the out-of-process frame paint
  const fr = await centerOf(page, "#xframe");
  const marks0 = await page.eval(markCount);
  await blastAt(page, fr.x, fr.y, 400);
  const marks1 = await page.eval(markCount);
  record("Click over cross-origin iframe fires", marks1 > marks0, `marks ${marks0} -> ${marks1}`);

  // Images: blasting must not fetch anything (srcset fallback, URL with a quote).
  await page.eval("window.scrollTo(0, 0)");
  await sleep(300);
  const reqBefore = server.count("/img/640x320/1/hero-fallback.png") + server.count("/img/600x300/15/it's-a-quote.png");
  const hero = await centerOf(page, "#hero");
  await blastAt(page, hero.x, hero.y, 150);
  await screenshot(page, `${variant.name}-hero-shatter`);
  await sleep(1800);
  await page.eval(`document.querySelector('img[alt="quote"]').scrollIntoView({ block: "center" })`);
  await sleep(300);
  const quote = await centerOf(page, 'img[alt="quote"]');
  await blastAt(page, quote.x, quote.y, 150);
  await screenshot(page, `${variant.name}-quote-shatter`);
  await sleep(1800);
  const reqAfter = server.count("/img/640x320/1/hero-fallback.png") + server.count("/img/600x300/15/it's-a-quote.png");
  record("Image blasts make no network requests", reqAfter === reqBefore, `requests ${reqBefore} -> ${reqAfter}`);

  // Text: blasting a wrapped paragraph must not reflow it or shift the page.
  await page.eval(`document.querySelectorAll("#article > p")[6].scrollIntoView({ block: "center" })`);
  await sleep(300);
  const para = await page.eval(`(function(){ var p = document.querySelectorAll("#article > p")[6]; var r = p.getBoundingClientRect();
    return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.5, h: r.height, w: r.width, sw: document.documentElement.scrollWidth }; })()`);
  const cls0 = await page.eval("__perf.ls.reduce(function (s, e) { return s + e[1]; }, 0)");
  await blastAt(page, para.x, para.y, 120);
  await screenshot(page, `${variant.name}-text-blast`);
  await sleep(2400);
  await screenshot(page, `${variant.name}-text-after`);
  const para2 = await page.eval(`(function(){ var r = document.querySelectorAll("#article > p")[6].getBoundingClientRect();
    return { h: r.height, w: r.width, sw: document.documentElement.scrollWidth }; })()`);
  const cls1 = await page.eval("__perf.ls.reduce(function (s, e) { return s + e[1]; }, 0)");
  const hidden = await page.eval(`(function(){ var h = window.CSS && CSS.highlights && CSS.highlights.get("cb-blasted");
    return (h ? h.size : 0) + document.querySelectorAll("span[data-cb-scattered]").length; })()`);
  record("Blasted text disappears", hidden > 0, `${hidden} hidden range(s)/char(s)`);
  record("Paragraph keeps its size (no reflow)", Math.abs(para2.h - para.h) < 0.5 && Math.abs(para2.w - para.w) < 0.5,
    `height ${para.h.toFixed(0)} -> ${para2.h.toFixed(0)}px, page width ${para.sw} -> ${para2.sw}px`);
  record("No layout shift from blasting text", cls1 - cls0 < 0.005, `CLS +${(cls1 - cls0).toFixed(3)}`);

  // Framework-owned text nodes keep working after being blasted.
  await page.eval(`document.getElementById("fw").scrollIntoView({ block: "center" })`);
  await sleep(300);
  const fw = await centerOf(page, "#fw-slot");
  await blastAt(page, fw.x, fw.y, 1500);
  const fwErrors = await page.eval("window.__fwErrors.length");
  record("Framework re-renders don't break", fwErrors === 0, `${fwErrors} error(s)`);

  // Marks are anchored to the page.
  await page.eval("window.scrollTo(0, 900)");
  await sleep(300);
  await blastAt(page, 420, 380, 400);
  const top0 = await newestMarkTop(page);
  await page.eval("window.scrollBy(0, 150)");
  await sleep(300);
  const top1 = await newestMarkTop(page);
  record("Blast marks scroll with the page", top0 != null && Math.abs((top0 - top1) - 150) < 2, `mark top ${top0 && top0.toFixed(0)} -> ${top1 && top1.toFixed(0)} after scrolling 150px`);

  const markSize = await page.eval(`(function(){
    var m = document.querySelectorAll(".__cb_mark"); var e = m.length ? m[m.length - 1] : null;
    if (!e) { var old = [].filter.call(document.documentElement.children, function (x) { return x.style && x.style.zIndex === "2147483644" && x.querySelector("svg"); }); e = old.length ? old[old.length - 1] : null; }
    if (!e) return null; var r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  record("Blast marks survive a CSS reset (max-width:100%)", markSize && markSize.w > 20 && markSize.h > 20, markSize ? `newest mark ${markSize.w}x${markSize.h}px` : "no mark");

  // A blast right next to the scrollbar must not make the page scroll sideways.
  const sb0 = await page.eval("({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bar: innerWidth - document.documentElement.clientWidth })");
  await blastAt(page, sb0.cw - 18, 300, 400);
  const sb1 = await page.eval("document.documentElement.scrollWidth");
  record("Blast at the right edge adds no horizontal scroll", sb1 <= sb0.cw, `scrollWidth ${sb0.sw} -> ${sb1} (viewport ${sb0.cw}px, scrollbar ${sb0.bar}px)`);

  const dupGlow = await page.eval(`document.querySelectorAll('[id="__cbGlow"]').length`);
  record("No duplicate element IDs from marks", dupGlow <= 1, `${dupGlow} x #__cbGlow`);

  // Best score writes are debounced: swarm + gun until a few kills happen.
  const dangerBtn = await centerOf(page, "#__cb_danger_btn");
  const modeBtn = await centerOf(page, "#__cb_mode_btn");
  await click(page, dangerBtn.x, dangerBtn.y);
  await click(page, modeBtn.x, modeBtn.y);
  await sleep(3500);
  const t0 = Date.now();
  await mouse(page, "mousePressed", 300, 200);
  while (Date.now() - t0 < 7000) {
    const t = (Date.now() - t0) / 1000;
    await mouse(page, "mouseMoved", 640 + Math.sin(t * 2.1) * 560, 220 + Math.sin(t * 3.3) * 160, { held: true });
    await sleep(16);
  }
  await mouse(page, "mouseReleased", 300, 200);
  await screenshot(page, `${variant.name}-danger`);
  const kills = await page.eval(`(function(){ var m = document.body.parentNode.querySelector("#__cannon_wrapper"); var t = m ? m.textContent : ""; var k = t.match(/🎯\\s*(\\d+)/); return k ? +k[1] : 0; })()`);
  const writes = await page.eval("window.__cbWrites || 0", ctx);
  record("Best score saves are debounced", kills < 3 || writes < kills, `${kills} kill(s), ${writes} storage write(s)`);
  await click(page, dangerBtn.x, dangerBtn.y);
  await click(page, modeBtn.x, modeBtn.y);

  // Teardown restores the page completely.
  await key(page, "Escape", "Escape", 27);
  await sleep(300);
  await removeHarnessCss(page);
  const after = await page.eval(SNAPSHOT);
  const leftovers = await page.eval(`(function(){
    var attrs = document.querySelectorAll("[data-cb-hidden],[data-cb-scattered],[data-cb-done],[data-cb-stolen],[data-cb-blasted]").length;
    var hl = window.CSS && CSS.highlights ? CSS.highlights.size : 0;
    var ifr = getComputedStyle(document.getElementById("xframe")).pointerEvents;
    return { attrs: attrs, highlights: hl, iframePointer: ifr }; })()`);
  record("Esc restores the page DOM", after.body === before.body && after.htmlAttrs === before.htmlAttrs && after.htmlChildren === before.htmlChildren,
    `body ${after.body === before.body ? "identical" : "differs"}, html attrs ${after.htmlAttrs === before.htmlAttrs ? "same" : "differ"}, html children ${before.htmlChildren} -> ${after.htmlChildren}`);
  record("Esc leaves no game attributes/highlights", leftovers.attrs === 0 && leftovers.highlights === 0 && leftovers.iframePointer !== "none",
    `${leftovers.attrs} attribute(s), ${leftovers.highlights} highlight(s), iframe pointer-events ${leftovers.iframePointer}`);
  record("Page text is unchanged after Esc", after.text === before.text, after.text === before.text ? "identical" : "differs");

  // Relaunch on the same page: previously shattered images can be blasted again.
  await page.eval("window.scrollTo(0, 0)");
  await sleep(300);
  await injectGame(page, variant, { contextId: ctx });
  await sleep(300);
  const hero2 = await centerOf(page, "#hero");
  await blastAt(page, hero2.x, hero2.y, 400);
  const heroHidden = await page.eval(`getComputedStyle(document.getElementById("hero")).visibility === "hidden"`);
  record("Relaunch: shattered image can be blasted again", heroHidden, heroHidden ? "hero shattered again" : "hero ignored");
  await key(page, "Escape", "Escape", 27);
  await sleep(200);
  record("No script errors", page.errors.length === 0, page.errors.length ? page.errors.slice(0, 3).join(" | ") : "none");
  await page.send("Page.close").catch(() => {});
  page.close();
  return out;
}

async function main() {
  const variants = loadVariants(opt("baseline"));
  const server = await startServer();
  const table = {};
  try {
    for (const v of variants) {
      const browser = await launchChrome({ headless: !args.includes("--headful"), hideScrollbars: false });
      try { table[v.name] = await runChecks(browser, server, v); } finally { await browser.close(); }
    }
  } finally {
    await server.close();
  }
  const names = Object.keys(table);
  for (let i = 0; i < table[names[0]].length; i++) {
    const row = table[names[0]][i].name;
    console.log(`\n${row}`);
    for (const n of names) {
      const r = table[n][i];
      console.log(`  ${n.padEnd(8)} ${r.pass ? "PASS" : "FAIL"}  ${r.detail}`);
    }
  }
  const failed = table.current.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} check(s) failed for the current build.` : "\nAll checks pass for the current build.");
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });

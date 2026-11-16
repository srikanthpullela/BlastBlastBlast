#!/usr/bin/env node
// Functional checks for both builds on the heavy test page: text blasting
// without reflow, framework-owned text, srcset/quote images, page-anchored
// marks, iframe click-through, debounced best score, complete teardown and
// relaunch; for the current build also sound, keys and the blast report.
// Prints a pass/fail table. Dev-only; not part of the extension.
//
//   node tools/perf/check.mjs [--baseline <rev>] [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchChrome, sleep } from "./cdp.mjs";
import { startServer } from "./server.mjs";
import { loadVariants, openPage, injectGame, removeHarnessCss, mouse, click, key, centerOf, useWeapon } from "./harness.mjs";

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
  var kids = [].filter.call(html.children, function (e) { return e.id !== "__cb_report"; }).length;
  return { body: body.outerHTML, htmlAttrs: attrs, htmlChildren: kids,
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

const REPORT = `(function(){ var h = document.getElementById("__cb_report"); return h && h.shadowRoot ? h.shadowRoot.textContent : null; })()`;
// The first-run intro card: on screen, clear of the score bar, the "pick weapons" hint and the controls.
const INTRO_FIT = `(function () {
  var b = document.getElementById("__cbIntroOk");
  if (!b) return { ok: false, detail: "no intro" };
  var card = b.parentNode, c = card.getBoundingClientRect(), hintEl = card.previousSibling;
  var hint = getComputedStyle(hintEl).display === "none" ? null : hintEl.getBoundingClientRect();
  var mute = document.querySelector('button[title*="press M"]');
  var others = [hint, mute && mute.parentNode.getBoundingClientRect(),
    document.getElementById("__cb_arsenal").getBoundingClientRect(), document.getElementById("__cb_danger_btn").getBoundingClientRect()];
  var hits = others.filter(function (r) { return r && r.top < c.bottom && c.top < r.bottom && r.left < c.right && c.left < r.right; }).length;
  return { ok: c.top >= 0 && c.bottom <= innerHeight && hits === 0,
    detail: "card " + Math.round(c.top) + "–" + Math.round(c.bottom) + (hint ? ", hint at " + Math.round(hint.top) : ", hint hidden") +
      (card.style.zoom ? ", scaled " + card.style.zoom : "") + (hits ? ", covered by " + hits + " element(s)" : "") };
})()`;
const audioStats = (page, ctx) => page.eval("window.__audio ? JSON.parse(JSON.stringify(window.__audio)) : null", ctx);

async function holdFire(page, ms) {
  const t0 = Date.now();
  await mouse(page, "mousePressed", 300, 200);
  while (Date.now() - t0 < ms) {
    const t = (Date.now() - t0) / 1000;
    await mouse(page, "mouseMoved", 640 + Math.sin(t * 2.1) * 560, 220 + Math.sin(t * 3.3) * 160, { held: true });
    await sleep(16);
  }
  await mouse(page, "mouseReleased", 300, 200);
}

async function runChecks(browser, server, variant) {
  const out = [];
  const record = (name, pass, detail) => out.push({ name, pass, detail });
  // Features new in this build: the baseline gets an "n/a" row instead.
  const isNew = variant.name === "current";
  const recordNew = (name, pass, detail) => out.push(isNew ? { name, pass, detail } : { name, pass: true, na: true, detail: "n/a (new feature)" });
  const page = await openPage(browser, `${server.origin}/heavy.html`);
  const before = await page.eval(SNAPSHOT);
  const LAUNCH = { shortcut: "Alt+Shift+X", via: "test" };
  const ctx = await injectGame(page, variant, { audioProbe: true, launch: LAUNCH });
  await sleep(300);
  // The first audio context in a browser session can block the page for ~150 ms while
  // Chrome starts its audio service, so it must exist before the first shot.
  const A0 = await audioStats(page, ctx);
  recordNew("Audio is set up at launch, so the first shot can't stall", A0 && A0.contexts === 1 && A0.sources === 0,
    A0 ? `${A0.contexts} audio context(s) before the first shot` : "no audio probe");

  // Iframe click-through: a click over a cross-origin iframe must fire the cannon.
  await page.eval(`document.getElementById("xframe").scrollIntoView({ block: "center" })`);
  await sleep(1200);   // let the out-of-process frame paint
  const fr = await centerOf(page, "#xframe");
  const marks0 = await page.eval(markCount);
  await blastAt(page, fr.x, fr.y, 400);
  const marks1 = await page.eval(markCount);
  record("Click over cross-origin iframe fires", marks1 > marks0, `marks ${marks0} -> ${marks1}`);
  const A1 = await audioStats(page, ctx);
  recordNew("The first shot is heard (the click resumes the audio)", A1 && A1.sources > 0 && A1.loud > 0,
    A1 ? `${A1.sources} sound source(s), ${A1.loud} loud sample(s) after one shot` : "no audio probe");

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

  // G / Shift+G cycle weapons, D toggles Danger.
  if (isNew) {
    const label = () => page.eval(`document.getElementById("__cb_arsenal").firstChild.textContent`);
    const dangerText = () => page.eval(`document.getElementById("__cb_danger_btn").textContent`);
    const l0 = await label();
    await key(page, "g", "KeyG", 71); await sleep(80);
    const l1 = await label();
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "G", code: "KeyG", windowsVirtualKeyCode: 71, modifiers: 8 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "G", code: "KeyG", windowsVirtualKeyCode: 71, modifiers: 8 });
    await sleep(80);
    const l2 = await label();
    await key(page, "d", "KeyD", 68); await sleep(150);
    const d1 = await dangerText();
    await key(page, "d", "KeyD", 68); await sleep(150);
    const d2 = await dangerText();
    recordNew("Keys: G / Shift+G switch weapons, D toggles Danger", /CANNON/.test(l0) && /GUN/.test(l1) && /CANNON/.test(l2) && /ON/.test(d1) && /OFF/.test(d2),
      `${l0} → G → ${l1} → Shift+G → ${l2}; D → ${d1.replace(/\s+/g, " ")} → D → ${d2.replace(/\s+/g, " ")}`);
  } else recordNew("Keys: G / Shift+G switch weapons, D toggles Danger");

  // Best score writes are debounced: swarm + gun until a few kills happen.
  const dangerBtn = await centerOf(page, "#__cb_danger_btn");
  await click(page, dangerBtn.x, dangerBtn.y);
  await useWeapon(page, 2);
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

  if (isNew) {
    const A = await audioStats(page, ctx);
    recordNew("Sound effects play (synthesized, no files)", A && A.contexts === 1 && A.sources > 50 && A.loud > 5,
      A ? `${A.sources} sound sources in ~12 s of Danger mode, output peak ${A.peak.toFixed(2)}` : "no audio context");
    recordNew("Sound stays capped and doesn't clip in Danger mode", A && A.maxLive <= 90 && A.peak <= 1,
      A ? `at most ${A.maxLive} sources at once, peak ${A.peak.toFixed(2)}` : "no audio");
    // M mutes (nothing new is synthesized) and the choice is saved.
    await key(page, "m", "KeyM", 77);
    await sleep(150);
    const s0 = (await audioStats(page, ctx)).sources;
    await holdFire(page, 1000);
    await sleep(300);
    const s1 = (await audioStats(page, ctx)).sources;
    const stored = await page.eval("__cbStore.cbMuted", ctx);
    const icon = await page.eval(`document.getElementById("__cannon_wrapper").textContent.indexOf("🔇") >= 0`);
    await key(page, "m", "KeyM", 77);
    await sleep(150);
    const stored2 = await page.eval("__cbStore.cbMuted", ctx);
    recordNew("M mutes (and is remembered), M again unmutes", s1 === s0 && stored === true && icon && stored2 === false,
      `${s1 - s0} new sources while muted, saved cbMuted=${stored} then ${stored2}, HUD shows 🔇: ${icon}`);
  } else {
    recordNew("Sound effects play (synthesized, no files)");
    recordNew("Sound stays capped and doesn't clip in Danger mode");
    recordNew("M mutes (and is remembered), M again unmutes");
  }
  await click(page, dangerBtn.x, dangerBtn.y);
  await useWeapon(page, 1);

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
  if (isNew) {
    const rep1 = await page.eval(REPORT);
    await screenshot(page, `${variant.name}-report`);
    recordNew("Exit shows the blast report over the restored page", !!rep1 && /BLAST REPORT/.test(rep1) && /points?/.test(rep1),
      rep1 ? rep1.replace(/\s+/g, " ").slice(0, 110) + "…" : "no report");
    await key(page, "Escape", "Escape", 27);
    await sleep(500);
    const gone = await page.eval(REPORT) === null;
    const after2 = await page.eval(SNAPSHOT);
    recordNew("Esc again closes the report", gone && after2.htmlChildren === before.htmlChildren,
      `report ${gone ? "closed" : "still open"}, html children ${before.htmlChildren} -> ${after2.htmlChildren}`);
    await sleep(1800);
    const A = await audioStats(page, ctx);
    recordNew("Audio stops when the game ends", A && A.closed === A.contexts && A.live === 0, A ? `${A.closed}/${A.contexts} audio context(s) closed, ${A.live} sources left` : "no audio");
  } else {
    recordNew("Exit shows the blast report over the restored page");
    recordNew("Esc again closes the report");
    recordNew("Audio stops when the game ends");
  }

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
  if (isNew) {
    // The page stays usable: a click on it goes through and closes the report.
    const shown = await page.eval(REPORT) !== null;
    const probe = await centerOf(page, "#probe");
    await click(page, probe.x, probe.y);
    await sleep(400);
    const clicks = await page.eval("window.__probeClicks || 0");
    const closed = await page.eval(REPORT) === null;
    recordNew("The report never blocks the page (a click goes through and closes it)", shown && clicks === 1 && closed,
      `report shown: ${shown}, page button clicks: ${clicks}, report closed: ${closed}`);
    // Relaunching while the report is open closes it right away.
    await injectGame(page, variant, { contextId: ctx, launch: LAUNCH });
    await sleep(200);
    await blastAt(page, 500, 300, 200);
    await key(page, "Escape", "Escape", 27);
    await sleep(300);
    const open1 = await page.eval(REPORT) !== null;
    await injectGame(page, variant, { contextId: ctx, launch: LAUNCH });
    await sleep(100);
    const open2 = await page.eval(REPORT) !== null;
    recordNew("Relaunching closes an open report", open1 && !open2, `open before relaunch: ${open1}, after: ${open2}`);
    // It closes by itself after about 10 s.
    await blastAt(page, 520, 320, 200);
    await key(page, "Escape", "Escape", 27);
    await sleep(300);
    const open3 = await page.eval(REPORT) !== null;
    await sleep(10500);
    const open4 = await page.eval(REPORT) !== null;
    recordNew("The report closes by itself after ~10 s", open3 && !open4, `open at 0.3 s: ${open3}, at 10.8 s: ${open4}`);
  } else {
    recordNew("The report never blocks the page (a click goes through and closes it)");
    recordNew("Relaunching closes an open report");
    recordNew("The report closes by itself after ~10 s");
  }
  // The first-run intro fits laptop-sized and small windows.
  if (isNew) {
    const fits = [];
    for (const [w, h] of [[1280, 800], [1280, 640], [800, 500]]) {
      const p = await openPage(browser, `${server.origin}/heavy.html`, { width: w, height: h });
      await injectGame(p, variant, { introSeen: false, launch: LAUNCH });
      await sleep(600);
      fits.push(Object.assign({ size: `${w}x${h}` }, await p.eval(INTRO_FIT)));
      page.errors.push(...p.errors);
      await p.send("Page.close").catch(() => {});
      p.close();
    }
    recordNew("The intro fits short windows (nothing covers its button)", fits.every((f) => f.ok), fits.map((f) => `${f.size}: ${f.detail}`).join("; "));

    // A hidden tab runs no animation frames, but its audio keeps playing: switching tabs
    // while holding the flamethrower must silence it and release the trigger.
    const p = await openPage(browser, `${server.origin}/heavy.html`);
    const pctx = await injectGame(p, variant, { audioProbe: true, launch: LAUNCH });
    await sleep(300);
    await useWeapon(p, 4);
    await mouse(p, "mouseMoved", 420, 320);
    await mouse(p, "mousePressed", 420, 320);
    await sleep(700);
    const firing = await audioStats(p, pctx);
    const other = await browser.newPage();
    await other.send("Page.bringToFront");
    await sleep(2000);
    const hiddenTab = await p.eval("document.visibilityState") === "hidden";
    const away = await audioStats(p, pctx);
    await p.send("Page.bringToFront");
    await sleep(700);
    const back = await audioStats(p, pctx);
    await mouse(p, "mouseReleased", 420, 320);
    page.errors.push(...p.errors);
    for (const t of [other, p]) { await t.send("Page.close").catch(() => {}); t.close(); }
    recordNew("Switching tabs silences the game and releases held fire",
      firing.state === "running" && firing.live > 0 && hiddenTab && away.state === "suspended" && away.live === 0 && back.state === "running" && back.live === 0,
      `flamethrower held: audio ${firing.state}, ${firing.live} live source(s); other tab in front: audio ${away.state}, ${away.live} live; back: audio ${back.state}, ${back.live} live`);
  } else {
    recordNew("The intro fits short windows (nothing covers its button)");
    recordNew("Switching tabs silences the game and releases held fire");
  }
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
      console.log(`  ${n.padEnd(8)} ${r.na ? "n/a " : r.pass ? "PASS" : "FAIL"}  ${r.na ? "" : r.detail}`);
    }
  }
  const failed = table.current.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} check(s) failed for the current build.` : "\nAll checks pass for the current build.");
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });

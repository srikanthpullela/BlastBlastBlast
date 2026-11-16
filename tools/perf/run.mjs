#!/usr/bin/env node
// Perf check: rapid cannon fire, gun hold-fire and Danger swarm on a heavy page,
// v1.2.1 (from git) vs the working tree. Dev-only; not part of the extension.
//
//   node tools/perf/run.mjs [--cpu 4] [--runs 2] [--dpr 2] [--only cannon,gun,danger] [--baseline <rev>] [--json out.json]
import { writeFileSync } from "node:fs";
import { launchChrome, sleep } from "./cdp.mjs";
import { startServer } from "./server.mjs";
import { loadVariants, openPage, injectGame, mouse, click, centerOf, prng } from "./harness.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const CPU = Number(opt("cpu", 1));
const RUNS = Number(opt("runs", 2));
const DPR = Number(opt("dpr", 1));
const ONLY = opt("only", "cannon,gun,danger").split(",");
const HEADFUL = args.includes("--headful");

async function scenarioCannon(page, rand, { seconds = 10, rate = 9 } = {}) {
  const t0 = Date.now(), interval = 1000 / rate;
  for (let k = 0; Date.now() - t0 < seconds * 1000; k++) {
    const wait = t0 + k * interval - Date.now();
    if (wait > 0) await sleep(wait);
    const x = 60 + rand() * 760, y = 90 + rand() * 430;
    await mouse(page, "mouseMoved", x, y);
    await mouse(page, "mousePressed", x, y);
    await mouse(page, "mouseReleased", x, y);
  }
  await sleep(2600);   // let the last balls land and debris settle
}

async function scenarioGun(page, rand, { seconds = 6 } = {}) {
  const btn = await centerOf(page, "#__cb_mode_btn");
  await click(page, btn.x, btn.y);
  await sleep(200);
  const t0 = Date.now();
  let x = 200, y = 200;
  await mouse(page, "mouseMoved", x, y);
  await mouse(page, "mousePressed", x, y);
  while (Date.now() - t0 < seconds * 1000) {
    const t = (Date.now() - t0) / 1000;
    x = 480 + Math.sin(t * 1.7) * 380;
    y = 260 + Math.sin(t * 2.3) * 180;
    await mouse(page, "mouseMoved", x, y, { held: true });
    await sleep(16);
  }
  await mouse(page, "mouseReleased", x, y);
  await click(page, btn.x, btn.y);   // back to cannon
  await sleep(500);
}

async function scenarioDanger(page, rand) {
  const btn = await centerOf(page, "#__cb_danger_btn");
  await click(page, btn.x, btn.y);
  await sleep(4000);                               // swarm arrives
  await scenarioCannon(page, rand, { seconds: 8, rate: 6 });
  await scenarioGun(page, rand, { seconds: 4 });
  await click(page, btn.x, btn.y);
  await sleep(500);
}

const SCENARIOS = { cannon: scenarioCannon, gun: scenarioGun, danger: scenarioDanger };

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0; }

async function measure(page, fn, rand) {
  const m0 = await page.send("Performance.getMetrics");
  const t0 = await page.eval("performance.now()");
  await fn(page, rand);
  const t1 = await page.eval("performance.now()");
  const m1 = await page.send("Performance.getMetrics");
  const perf = await page.eval(`(function(){ var p = window.__perf; return {
      frames: p.frames.filter(function (t) { return t >= ${t0} && t <= ${t1}; }),
      lt: p.lt.filter(function (e) { return e[0] >= ${t0} && e[0] <= ${t1}; }),
      ls: p.ls.filter(function (e) { return e[0] >= ${t0} && e[0] <= ${t1}; }),
      loaf: p.loaf.filter(function (e) { return e[0] >= ${t0} && e[0] <= ${t1}; }) }; })()`);
  const deltas = [];
  for (let i = 1; i < perf.frames.length; i++) deltas.push(perf.frames[i] - perf.frames[i - 1]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const metric = (m, name) => (m.metrics.find((x) => x.name === name) || { value: 0 }).value;
  const diff = (name) => metric(m1, name) - metric(m0, name);
  return {
    seconds: (t1 - t0) / 1000,
    frames: deltas.length,
    p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] || 0,
    over20: deltas.filter((d) => d > 20).length / Math.max(1, deltas.length) * 100,
    over33: deltas.filter((d) => d > 33.4).length / Math.max(1, deltas.length) * 100,
    longTasks: perf.lt.length,
    longTaskMax: Math.max(0, ...perf.lt.map((e) => e[1])),
    longTaskTotal: perf.lt.reduce((s, e) => s + e[1], 0),
    loafOver50: perf.loaf.length,
    loafMax: Math.max(0, ...perf.loaf.map((e) => e[1])),
    cls: perf.ls.reduce((s, e) => s + e[1], 0),
    layouts: diff("LayoutCount"),
    layoutMs: diff("LayoutDuration") * 1000,
    styleMs: diff("RecalcStyleDuration") * 1000,
    scriptMs: diff("ScriptDuration") * 1000,
    taskMs: diff("TaskDuration") * 1000,
  };
}

function median(values) { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

async function main() {
  const variants = loadVariants(opt("baseline"));
  const server = await startServer();
  const browser = await launchChrome({ headless: !HEADFUL });
  const results = {};
  try {
    for (const scen of ONLY) {
      for (let run = 0; run < RUNS; run++) {
        for (const v of variants) {          // alternate variants to cancel out drift
          const page = await openPage(browser, `${server.origin}/heavy.html`, { cpu: CPU, dpr: DPR });
          await page.eval("window.scrollTo(0, 240)");
          await injectGame(page, v);
          await sleep(400);
          const r = await measure(page, SCENARIOS[scen], prng(1000 + run));
          r.errors = page.errors.length;
          if (page.errors.length) process.stderr.write(`  script errors: ${page.errors.slice(0, 3).join(" | ")}\n`);
          ((results[scen] ||= {})[v.name] ||= []).push(r);
          await page.send("Page.close").catch(() => {});
          page.close();
          process.stderr.write(`${scen} ${v.name} run ${run + 1}: p95 ${r.p95.toFixed(1)}ms, long frames ${r.loafOver50} (max ${r.loafMax.toFixed(0)}ms), long tasks ${r.longTasks}, CLS ${r.cls.toFixed(3)}\n`);
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const KEYS = [["frames", 0], ["p50", 1], ["p95", 1], ["p99", 1], ["max", 0], ["over20", 1], ["over33", 1],
    ["longTasks", 0], ["longTaskMax", 0], ["longTaskTotal", 0], ["loafOver50", 0], ["loafMax", 0], ["cls", 3],
    ["layouts", 0], ["layoutMs", 0], ["styleMs", 0], ["scriptMs", 0], ["taskMs", 0], ["errors", 0]];
  console.log(`\nHeadless Chrome, 1280x800 @${DPR}x, CPU throttle ${CPU}x, median of ${RUNS} run(s)\n`);
  for (const scen of Object.keys(results)) {
    console.log(`== ${scen} ==`);
    const names = Object.keys(results[scen]);
    console.log("metric".padEnd(16) + names.map((n) => n.padStart(12)).join(""));
    for (const [k, digits] of KEYS) {
      console.log(k.padEnd(16) + names.map((n) => median(results[scen][n].map((r) => r[k])).toFixed(digits).padStart(12)).join(""));
    }
    console.log("");
  }
  const out = opt("json");
  if (out) writeFileSync(out, JSON.stringify({ cpu: CPU, dpr: DPR, runs: RUNS, results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

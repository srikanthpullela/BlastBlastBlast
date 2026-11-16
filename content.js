/* ============================================================================
 * BlastBlastBlast — content.js
 * Injected on demand into the top frame of the active tab (see popup.js).
 *
 *  - Overlay: fixed full-viewport canvas, SVG tank, Cannon/Gun and Danger
 *    toggles, HUD (kills / best / stolen) and raiding soldiers.
 *  - BLAST_RADIUS is 45px. Blast marks are anchored to the page, so they
 *    scroll with it, and fade out after about 60s.
 *  - Blasted text is hidden with the CSS Custom Highlight API: page text is
 *    never rewritten, so nothing reflows. Flying characters, image fragments
 *    and particles are drawn on the overlay canvas.
 *  - Every frame does its layout reads first, then DOM writes, then canvas
 *    work, so the game never forces extra synchronous layouts.
 *  - Esc / Remove restores the page completely.
 * ========================================================================== */
(function () {
  "use strict";

  // The game runs only in the top frame. While it runs, embedded frames are
  // made click-through (see the style sheet below) so aiming and firing also
  // work over iframes.
  if (window.top !== window) return;
  if (window.__cannonBlastActive) return;
  window.__cannonBlastActive = true;

  var VERSION = "";
  try { VERSION = chrome.runtime.getManifest().version; } catch (e) {}
  console.log("%c[BlastBlastBlast" + (VERSION ? " v" + VERSION : "") + "]%c move to aim · click to fire · Esc to remove",
    "color:#ff6600;font-weight:bold", "color:gray");

  /* ── CONSTANTS ──────────────────────────────────────────────────────────── */
  var GRAVITY         = 150;   // px/s² — particles only
  var BALL_G          = 900;   // px/s² — ball arc curvature
  var BLAST_RADIUS    = 45;    // px — tight, focused blast
  var BALL_R          = 15;    // px cannonball radius
  var SHARD_G         = 95;    // px/s² gravity on flying debris
  var MIN_AIM_DIST    = 60;    // px — cursor must be at least this far to fire
  var MARK_TTL        = 60;    // s before a blast mark starts to fade
  var MARK_FADE       = 10;    // s fade-out
  var MAX_MARKS       = 160;   // older marks fade early beyond this
  var MAX_DEBRIS      = 1400;  // canvas debris (chars + image pieces) alive at once
  var MAX_FLUNG       = 60;    // DOM element clones in flight at once
  var MAX_BLAST_CHARS = 180;   // characters one blast can tear out
  var MAX_JOBS        = 8;     // queued page-destruction jobs
  var HL_NAME         = "cb-blasted";
  var HTML_NS         = "http://www.w3.org/1999/xhtml";

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var gameActive = true;
  var lastTime   = performance.now();
  var animId     = null;
  var balls      = [];
  var bullets    = [];        // straight-line gun bullets
  var bloodDrops = [];        // blood splatters that linger then fade
  var mode       = "cannon";  // "cannon" | "gun"
  var particles  = [];
  var shockwaves = [];
  var mFlashes   = [];
  var floaters   = [];        // floating score / taunt popups
  var craters    = [];
  var debris     = [];        // canvas-drawn flying characters + image pieces
  var flung      = [];        // DOM clones in flight (whole elements, dropped loot)
  var removeList = [];        // long-lived nodes we appended — removed on destroy
  var hiddenList = [];        // page elements we hid with data-cb-hidden
  var hiddenSet  = new WeakSet();
  var scattered  = new WeakSet(); // elements flung whole
  var shattered  = new WeakSet(); // images / videos / canvases shattered
  var stolenSet  = new WeakSet(); // elements carried off by soldiers
  var aimAngle   = -Math.PI / 2.5;
  var shownAngle = NaN;       // barrel angle currently rendered
  var aimPower   = 0;
  var targetX    = 0;         // exact landing point = cursor position
  var targetY    = 0;
  var hasAim     = false;

  // Layout values, refreshed once per frame in readPhase() (or on resize).
  var viewW    = window.innerWidth;
  var viewH    = window.innerHeight;
  var dpr      = window.devicePixelRatio || 1;
  var scrollX0 = window.scrollX;
  var scrollY0 = window.scrollY;
  var docW     = viewW;
  var docH     = viewH;
  var mouseX   = viewW / 2;
  var mouseY   = viewH / 2;

  /* ── CONTINUOUS GUN FIRE ─────────────────────────────────────────────────────
     Holding the mouse down in gun mode auto-fires bullets at a steady rate
     (cannon stays single-shot per click since the arc is deliberately slow). */
  var GUN_FIRE_INTERVAL = 0.06; // sec between auto-fired bullets (~16/sec)
  var gunHeld           = false;
  var gunFireCd         = 0;
  var introActive       = false; // true while the first-launch intro is up — game paused

  /* ── SOLDIER RAID STATE ─────────────────────────────────────────────────── */
  var soldiers          = [];
  var soldierTimer      = 2.0;   // seconds to first spawn
  var SOLDIER_INTERVAL  = 3.2;   // base seconds between spawns (normal)
  var MAX_SOLDIERS      = 6;
  var NORMAL_BURST      = 1;     // soldiers per spawn tick in normal mode
  var SOLDIER_KILL_R    = 78;    // blast radius that kills soldiers

  /* ── DANGER / ALERT MODE ────────────────────────────────────────────────────
     Danger mode is a surge of soldiers swarming in from every direction. It is
     toggled from the Danger button; the timed auto-trigger stays switched off. */
  var DANGER_AFTER_MIN  = 120;   // min sec of normal play before auto warning
  var DANGER_AFTER_MAX  = 180;   // max sec — each cycle picks randomly in [min,max]
  var AUTO_DANGER       = false; // auto-trigger disabled — danger only via the toggle
  var DANGER_WARN       = 12;    // sec warning countdown before the surge
  var DANGER_DURATION   = 15;    // sec the surge lasts
  var DANGER_MAX_SOLDIERS = 24;  // soldier cap during the surge
  var DANGER_INTERVAL   = 0.42;  // base seconds between spawn bursts during surge
  var dangerState       = "normal"; // "normal" | "warning" | "active"
  var dangerTimer       = 0;
  var playTime          = 0;
  var dangerDelay       = 0;
  var dangerForced      = false; // user toggle: keep the surge running
  function nextDangerDelay() { return DANGER_AFTER_MIN + Math.random()*(DANGER_AFTER_MAX - DANGER_AFTER_MIN); }
  dangerDelay = nextDangerDelay();
  var CAMO = ["#4a5d39","#556b2f","#5b6e3a","#46532f"];
  var PLAY_TOP_FRAC     = 0.72;  // soldiers only operate in the top 72% (cannon owns the bottom)
  var clock             = 0;     // animation clock (seconds)
  var score             = 0;     // soldiers blasted this session
  var stolen            = 0;     // loot carried off
  var best              = 0;     // all-time high (chrome.storage)

  /* ── STYLE SHEET (removed again on teardown) ─────────────────────────────── */
  var styleEl = document.createElement("style");
  styleEl.id = "__cb_styles";
  styleEl.setAttribute("data-cb-ui", "1");
  styleEl.textContent = [
    "#__cannon_wrapper,#__cannon_wrapper *{box-sizing:border-box}",
    // Blasted / stolen elements keep their layout box but stop painting.
    "[data-cb-hidden]{visibility:hidden!important}",
    // Embedded frames would swallow the pointer; let it reach the game instead.
    "iframe,frame,embed,object{pointer-events:none!important}",
    "::highlight(" + HL_NAME + "){color:transparent;-webkit-text-fill-color:transparent;text-shadow:none;text-decoration-color:transparent}",
    // Toggle pulse: a ring that only animates transform/opacity (compositor-only).
    ".__cb_toggle::before{content:'';position:absolute;inset:-2px;border-radius:16px;pointer-events:none;" +
      "border:3px solid var(--cb-ring);opacity:0;will-change:transform,opacity;animation:var(--cb-ring-anim)}",
    "@keyframes cbRing{0%{transform:scale(1);opacity:.9}60%,100%{transform:scale(1.09,1.16);opacity:0}}",
    "@keyframes cbRingBig{0%{transform:scale(1);opacity:1}55%,100%{transform:scale(1.16,1.3);opacity:0}}",
    "@keyframes cbVignette{0%,100%{opacity:.7}50%{opacity:1}}",
    "@keyframes cbWiggle{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}",
    "@keyframes cbMarkIn{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}",
    ".__cb_mark{position:absolute;pointer-events:none;animation:cbMarkIn .2s ease-out}",
    ".__cb_mark.__cb_fading{opacity:0;transition:opacity var(--cb-fade,10s) linear}"
  ].join("\n");
  document.documentElement.appendChild(styleEl);
  removeList.push(styleEl);

  /* ── DOM SCAFFOLD ───────────────────────────────────────────────────────── */
  var wrapper = document.createElement("div");
  wrapper.id = "__cannon_wrapper";
  wrapper.setAttribute("data-cb-ui", "1");
  wrapper.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;";
  var ctx = canvas.getContext("2d");

  var tankRect = null;
  function refreshTankRect() { try { tankRect = tank.getBoundingClientRect(); } catch (e) {} }
  function resizeCanvas() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    var newDpr = window.devicePixelRatio || 1;
    var dprChanged = newDpr !== dpr;
    dpr = newDpr;
    canvas.width  = Math.floor(viewW * dpr);
    canvas.height = Math.floor(viewH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    refreshTankRect();
    if (dprChanged || !sprites.ball) buildSprites();
  }

  /* ── CANNON SVG TANK ────────────────────────────────────────────────────── */
  var tank = document.createElement("div");
  tank.id = "__cannon_tank";
  tank.setAttribute("data-cb-ui", "1");
  tank.style.cssText = [
    "position:fixed;bottom:30px;left:50%;transform:translateX(-50%);",
    "width:140px;height:85px;pointer-events:all;z-index:2147483647;",
    "cursor:crosshair;user-select:none;-webkit-user-select:none;",
    "touch-action:none;-webkit-tap-highlight-color:transparent;",
    "filter:drop-shadow(0 4px 18px rgba(0,0,0,0.8)) drop-shadow(0 0 8px rgba(255,140,0,0.25));"
  ].join("");

  (function buildTankSVG() {
    var wheels = "", links = "";
    for (var i = 0; i < 5; i++) {
      var cx = 30 + i*20;
      wheels += '<circle cx="'+cx+'" cy="74" r="8" fill="#1c1c1c" stroke="#000" stroke-width="1.5"/><circle cx="'+cx+'" cy="74" r="3" fill="#2e2e2e"/>';
    }
    for (var j = 0; j < 11; j++) {
      links += '<rect x="'+(18+j*9.4)+'" y="80" width="6" height="4" rx="1" fill="#0d0d0d"/>';
    }
    tank.innerHTML = [
      '<svg width="140" height="85" viewBox="0 0 140 85" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">',
      '<defs>',
      '<linearGradient id="__cbBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#52704f"/><stop offset=".5" stop-color="#3d5a3e"/><stop offset="1" stop-color="#2c3f2c"/></linearGradient>',
      '<linearGradient id="__cbTurret" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#62805e"/><stop offset="1" stop-color="#41603f"/></linearGradient>',
      '<linearGradient id="__cbBarrelGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a6a6a"/><stop offset=".5" stop-color="#3a3a3a"/><stop offset="1" stop-color="#1d1d1d"/></linearGradient>',
      '</defs>',
      '<rect x="12" y="64" width="116" height="20" rx="10" fill="#222" stroke="#000" stroke-width="1.5"/>',
      links, wheels,
      '<path d="M22 64 L22 50 Q22 44 30 44 L112 44 Q120 44 122 52 L126 64 Z" fill="url(#__cbBody)" stroke="#1c2a1c" stroke-width="1.5"/>',
      '<path d="M48 46 Q48 26 70 26 Q92 26 92 46 Z" fill="url(#__cbTurret)" stroke="#1c2a1c" stroke-width="1.5"/>',
      '<circle cx="78" cy="36" r="5" fill="#2c3f2c" stroke="#1c2a1c" stroke-width="1.2"/>',
      '<circle cx="78" cy="36" r="2" fill="#52704f"/>',
      '<g id="__cbBarrel" transform="rotate(-40 70 38)">',
      '<rect x="70" y="33" width="58" height="10" rx="4" fill="url(#__cbBarrelGrad)" stroke="#111" stroke-width="1"/>',
      '<rect x="86" y="31" width="5" height="14" rx="2" fill="#2a2a2a"/>',
      '<rect x="100" y="31" width="5" height="14" rx="2" fill="#2a2a2a"/>',
      '<rect x="124" y="30" width="8" height="16" rx="3" fill="#161616" stroke="#000" stroke-width="1"/>',
      '</g></svg>'
    ].join("");
  }());

  var barrelG = tank.querySelector("#__cbBarrel");

  var closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ Remove Cannon";
  closeBtn.style.cssText = [
    "position:fixed;bottom:122px;left:50%;transform:translateX(-50%);",
    "background:rgba(12,12,12,0.92);color:#ff6600;border:1px solid #ff6600;",
    "border-radius:20px;padding:6px 18px;font-size:12px;font-family:system-ui,sans-serif;",
    "cursor:pointer;z-index:2147483647;pointer-events:all;",
    "opacity:0;transition:opacity 0.18s;letter-spacing:0.5px;"
  ].join("");

  tank.addEventListener("mouseenter", function() { closeBtn.style.opacity = "1"; });
  tank.addEventListener("mouseleave", function() { closeBtn.style.opacity = "0"; });
  closeBtn.addEventListener("click", destroy);
  closeBtn.setAttribute("data-cb-ui", "1");

  // Pulse ring colour + animation for a toggle button (see .__cb_toggle::before).
  function setRing(btn, color, anim) {
    btn.style.setProperty("--cb-ring", color);
    btn.style.setProperty("--cb-ring-anim", anim);
  }

  /* ── WEAPON MODE TOGGLE (sits just left of the cannon) ──────────────────── */
  var modeBtn = document.createElement("button");
  modeBtn.id = "__cb_mode_btn";
  modeBtn.className = "__cb_toggle";
  modeBtn.setAttribute("data-cb-ui", "1");
  modeBtn.style.cssText = [
    "position:fixed;bottom:54px;right:calc(50% + 82px);",
    "background:rgba(14,16,11,0.96);color:#ffd24a;",
    "border:2px solid rgba(255,210,74,0.85);border-radius:16px;",
    "padding:10px 16px;min-width:110px;",
    "font:700 14px system-ui,sans-serif;letter-spacing:.3px;",
    "cursor:pointer;z-index:2147483647;pointer-events:all;",
    "display:flex;flex-direction:column;align-items:center;gap:3px;",
    "box-shadow:0 4px 18px rgba(0,0,0,.5);white-space:nowrap;",
    "transition:transform .18s ease,filter .18s ease,border-color .2s,background .2s;"
  ].join("");

  // Button always shows what you'll switch TO (not current state)
  function renderModeBtn() {
    if (mode === "cannon") {
      modeBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">🔫</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">GUN MODE</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap to switch</span>';
      modeBtn.style.borderColor = "rgba(255,210,74,0.85)";
      modeBtn.style.color = "#ffd24a";
      setRing(modeBtn, "rgba(255,210,74,0.7)", "cbRing 2s ease-out infinite");
    } else {
      modeBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">💣</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">CANNON</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap to switch</span>';
      modeBtn.style.borderColor = "rgba(255,140,30,0.9)";
      modeBtn.style.color = "#ff9a20";
      setRing(modeBtn, "rgba(255,140,30,0.8)", "cbRing 1.4s ease-out infinite");
    }
  }

  // Gun mode shows a crosshair cursor; remember the page's own inline cursor.
  var htmlStyle = document.documentElement.style;
  var origStyleAttr = document.documentElement.getAttribute("style");
  var origCursor = htmlStyle.getPropertyValue("cursor");
  var origCursorPrio = htmlStyle.getPropertyPriority("cursor");
  function restoreCursor() {
    if (origCursor) htmlStyle.setProperty("cursor", origCursor, origCursorPrio);
    else htmlStyle.removeProperty("cursor");
    if (origStyleAttr === null && document.documentElement.getAttribute("style") === "") {
      document.documentElement.removeAttribute("style");
    }
  }
  function setMode(m) {
    mode = m;
    renderModeBtn();
    hasAim = false; aimPower = 0;
    if (mode === "gun") htmlStyle.setProperty("cursor", "crosshair");
    else restoreCursor();
  }
  modeBtn.addEventListener("click", function(e) {
    e.preventDefault(); e.stopPropagation();
    setMode(mode === "cannon" ? "gun" : "cannon");
  });
  modeBtn.addEventListener("mouseenter", function(){ modeBtn.style.transform = "translateY(-4px) scale(1.06)"; modeBtn.style.filter = "brightness(1.15)"; });
  modeBtn.addEventListener("mouseleave", function(){ modeBtn.style.transform = ""; modeBtn.style.filter = ""; });
  renderModeBtn();

  /* ── DANGER MODE TOGGLE (sits just right of the cannon) ─────────────────── */
  var dangerBtn = document.createElement("button");
  dangerBtn.id = "__cb_danger_btn";
  dangerBtn.className = "__cb_toggle";
  dangerBtn.setAttribute("data-cb-ui", "1");
  dangerBtn.style.cssText = [
    "position:fixed;bottom:54px;left:calc(50% + 82px);",
    "background:rgba(14,16,11,0.96);color:#ff6b4a;",
    "border:2px solid rgba(255,107,74,0.8);border-radius:16px;",
    "padding:10px 16px;min-width:110px;",
    "font:700 14px system-ui,sans-serif;letter-spacing:.3px;",
    "cursor:pointer;z-index:2147483647;pointer-events:all;",
    "display:flex;flex-direction:column;align-items:center;gap:3px;",
    "box-shadow:0 4px 18px rgba(0,0,0,.5);white-space:nowrap;",
    "transition:transform .18s ease,filter .18s ease,background .2s,color .2s,border-color .2s;"
  ].join("");
  dangerBtn.addEventListener("mouseenter", function(){ dangerBtn.style.transform = "translateY(-4px) scale(1.06)"; dangerBtn.style.filter = "brightness(1.15)"; });
  dangerBtn.addEventListener("mouseleave", function(){ dangerBtn.style.transform = ""; dangerBtn.style.filter = ""; });
  function renderDangerBtn() {
    if (dangerForced) {
      dangerBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">🔥</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">DANGER ON</span>' +
        '<span style="font-size:10px;opacity:.75;font-weight:600">tap to stop</span>';
      dangerBtn.style.background = "rgba(160,22,14,0.97)";
      dangerBtn.style.color = "#fff";
      dangerBtn.style.borderColor = "rgba(255,80,40,1)";
      dangerBtn.style.boxShadow = "0 6px 28px rgba(200,20,10,.7)";
      setRing(dangerBtn, "rgba(255,50,20,1)", "cbRingBig .9s ease-out infinite");
    } else {
      dangerBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">⚠️</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">DANGER OFF</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap for swarm</span>';
      dangerBtn.style.background = "rgba(14,16,11,0.96)";
      dangerBtn.style.color = "#ff6b4a";
      dangerBtn.style.borderColor = "rgba(255,107,74,0.8)";
      dangerBtn.style.boxShadow = "0 4px 18px rgba(0,0,0,.5)";
      setRing(dangerBtn, "rgba(255,107,74,0.5)", "cbRing 2.5s ease-out infinite");
    }
  }
  dangerBtn.addEventListener("click", function(e) {
    e.preventDefault(); e.stopPropagation();
    dangerForced = !dangerForced;
    if (dangerForced) enterDanger();   // user-triggered surge starts now
    else exitDanger();                 // stop now
    renderDangerBtn();
  });
  renderDangerBtn();

  /* ── ALERT BANNER + DANGER VIGNETTE (non-interactive overlays) ───────────── */
  // The heavy inset shadow is painted once; only the opacity of the outer
  // layer (transition) and of the inner layer (CSS animation) ever changes.
  var dangerVignette = document.createElement("div");
  dangerVignette.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity .4s;";
  var vignetteInner = document.createElement("div");
  vignetteInner.style.cssText = "position:absolute;inset:0;box-shadow:inset 0 0 220px 60px rgba(200,20,10,0.55);";
  dangerVignette.appendChild(vignetteInner);
  var vigMode = "", vigOffTimer = 0;
  function setVignette(m) {
    if (m === vigMode) return;
    vigMode = m;
    clearTimeout(vigOffTimer);
    if (!m) {
      dangerVignette.style.opacity = "0";
      vigOffTimer = setTimeout(function () { if (!vigMode) vignetteInner.style.animation = ""; }, 450);
      return;
    }
    // [outer opacity, pulse period] — matches the old |sin| pulses per state.
    var cfg = m === "forced" ? ["1", ".79s"] : m === "active" ? [".9", ".63s"] : [".4", ".52s"];
    vignetteInner.style.animation = "cbVignette " + cfg[1] + " ease-in-out infinite";
    dangerVignette.style.opacity = cfg[0];
  }

  var alertBanner = document.createElement("div");
  alertBanner.style.cssText = [
    "position:fixed;top:54px;left:50%;transform:translateX(-50%);",
    "display:none;flex-direction:column;align-items:center;gap:2px;",
    "padding:10px 22px;border-radius:14px;pointer-events:none;z-index:2147483647;",
    "background:rgba(120,10,6,0.92);border:1px solid rgba(255,120,90,0.8);",
    "box-shadow:0 6px 26px rgba(180,20,10,0.6);text-align:center;white-space:nowrap;",
    "font-family:system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);"
  ].join("");
  var bannerTitle = document.createElement("span");
  bannerTitle.style.cssText = "font:800 17px/1.1 system-ui,sans-serif;letter-spacing:.5px";
  var bannerSub = document.createElement("span");
  bannerSub.style.cssText = "font:600 12px/1.2 system-ui,sans-serif;opacity:.9";
  alertBanner.appendChild(bannerTitle);
  alertBanner.appendChild(bannerSub);

  // Text nodes are only touched when their content actually changes.
  function setText(el, t) { if (el.__cbText !== t) { el.__cbText = t; el.textContent = t; } }
  var bannerShown = false;
  function showAlertBanner(title, sub) {
    setText(bannerTitle, title);
    setText(bannerSub, sub);
    if (!bannerShown) { bannerShown = true; alertBanner.style.display = "flex"; }
  }
  function hideAlertBanner() {
    if (bannerShown) { bannerShown = false; alertBanner.style.display = "none"; }
  }

  /* ── DANGER STATE MACHINE ───────────────────────────────────────────────── */
  function isDangerActive() { return dangerState === "active"; }

  function enterDanger() {
    dangerState = "active";
    dangerTimer = DANGER_DURATION;
    setVignette(dangerForced ? "forced" : "active");
    shakeScreen();
  }
  function exitDanger() {
    dangerState = "normal";
    playTime = 0;
    dangerTimer = 0;
    dangerDelay = nextDangerDelay();
    setVignette("");
    hideAlertBanner();
  }
  function updateDanger(dt) {
    if (dangerForced) {
      if (dangerState !== "active") enterDanger();
      showAlertBanner("🔥 DANGER SWARM", soldiers.length + " hostiles incoming · blast them!");
      setVignette("forced");
      return;
    }
    if (dangerState === "normal") {
      playTime += dt;
      setVignette("");
      hideAlertBanner();
      if (AUTO_DANGER && playTime >= dangerDelay) { dangerState = "warning"; dangerTimer = DANGER_WARN; shakeScreen(); }
    } else if (dangerState === "warning") {
      dangerTimer -= dt;
      showAlertBanner("⚠️ DANGER MODE INCOMING", "brace for the swarm — " + Math.ceil(dangerTimer) + "s");
      setVignette("warning");
      if (dangerTimer <= 0) enterDanger();
    } else if (dangerState === "active") {
      dangerTimer -= dt;
      showAlertBanner("🔥 DANGER MODE — SURVIVE", "swarm clears in " + Math.ceil(Math.max(0, dangerTimer)) + "s");
      setVignette("active");
      if (dangerTimer <= 0) exitDanger();
    }
  }

  wrapper.appendChild(canvas);
  wrapper.appendChild(tank);
  wrapper.appendChild(closeBtn);
  wrapper.appendChild(modeBtn);
  wrapper.appendChild(dangerBtn);
  wrapper.appendChild(dangerVignette);
  wrapper.appendChild(alertBanner);

  /* ── SCOREBOARD HUD ─────────────────────────────────────────────────────── */
  var hud = document.createElement("div");
  hud.style.cssText = [
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);",
    "display:flex;gap:14px;align-items:center;",
    "padding:6px 14px;border-radius:20px;",
    "background:rgba(18,20,16,0.82);backdrop-filter:blur(6px);",
    "border:1px solid rgba(255,255,255,0.12);",
    "font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    "color:#e8e8e8;letter-spacing:.3px;pointer-events:none;",
    "box-shadow:0 4px 18px rgba(0,0,0,0.4);z-index:2147483647;",
    "white-space:nowrap;user-select:none;"
  ].join("");
  function hudSpan(css) { var s = document.createElement("span"); s.style.cssText = css; hud.appendChild(s); return s; }
  var hudScore = hudSpan("color:#ff6b4a");
  hudSpan("opacity:.35").textContent = "|";
  var hudBest = hudSpan("color:#ffd24a");
  hudSpan("opacity:.35").textContent = "|";
  var hudStolen = hudSpan("color:#9ab37a");
  wrapper.appendChild(hud);

  function renderHUD() {
    setText(hudScore, "🎯 " + score);
    setText(hudBest, "🏆 " + best);
    setText(hudStolen, "🪖 " + stolen);
  }

  // The best score is written at most once every 1.5s (and on exit) instead of
  // on every kill.
  var bestDirty = false, bestTimer = 0;
  function loadBest() {
    try {
      chrome.storage.local.get(["cbBest"], function(r){
        if (r && typeof r.cbBest === "number" && r.cbBest > best) { best = r.cbBest; renderHUD(); }
      });
    } catch(e){}
  }
  function flushBest() {
    if (bestTimer) { clearTimeout(bestTimer); bestTimer = 0; }
    if (!bestDirty) return;
    bestDirty = false;
    try { chrome.storage.local.set({ cbBest: best }); } catch(e){}
  }
  function saveBestSoon() {
    bestDirty = true;
    if (!bestTimer) bestTimer = setTimeout(flushBest, 1500);
  }
  function addScore(n) {
    score += n;
    if (score > best) { best = score; saveBestSoon(); }
    renderHUD();
  }

  /* ── FIRST-LAUNCH INTRO (shown only once, ever) ──────────────────────────── */
  function maybeShowIntro() {
    try {
      chrome.storage.local.get(["cbIntroSeen"], function(r){
        if (gameActive && (!r || !r.cbIntroSeen)) showIntro();
      });
    } catch(e) { showIntro(); }
  }
  function showIntro() {
    introActive = true;
    var ov = document.createElement("div");
    ov.setAttribute("data-cb-ui", "1");
    ov.style.cssText = [
      "position:fixed;inset:0;z-index:2147483646;pointer-events:all;",
      "display:flex;align-items:center;justify-content:center;",
      "background:rgba(0,0,0,0.62);backdrop-filter:blur(3px);font-family:system-ui,sans-serif;"
    ].join("");
    ov.innerHTML =
      '<div style="position:fixed;bottom:120px;left:50%;transform:translateX(-50%);text-align:center;">'+
        '<div style="animation:cbWiggle 1s ease-in-out infinite">'+
        '<div style="background:#ffd24a;color:#111;font-weight:800;font-size:12px;padding:5px 10px;border-radius:9px;margin-bottom:4px">Switch 🔫 Gun &amp; ⚠️ Danger beside the cannon</div>'+
        '<div style="font-size:42px;line-height:1;color:#ffd24a;text-shadow:0 2px 8px rgba(0,0,0,.6)">↓</div>'+
      '</div></div>'+
      '<div style="background:#15171a;color:#eee;max-width:380px;width:86%;border-radius:16px;'+
      'padding:24px 26px;box-shadow:0 20px 60px rgba(0,0,0,0.6);border:1px solid rgba(255,210,74,0.3)">'+
      '<div style="font-size:19px;font-weight:800;color:#ffd24a;margin-bottom:6px">🔥 Welcome to BlastBlastBlast</div>'+
      '<div style="font-size:13px;opacity:.7;margin-bottom:16px">Move to aim · <b>click anywhere to fire</b> · Esc to remove</div>'+
      '<div style="display:flex;gap:10px;margin:10px 0"><div style="font-size:22px">💣</div><div><b>Cannon</b> — arcing blasts. Click anywhere to lob a ball.</div></div>'+
      '<div style="display:flex;gap:10px;margin:10px 0"><div style="font-size:22px">🔫</div><div><b>Gun</b> — switch beside the cannon; <b>hold</b> to rapid-fire bullets.</div></div>'+
      '<div style="display:flex;gap:10px;margin:10px 0"><div style="font-size:22px">⚠️</div><div><b>Danger</b> — toggle a swarm of soldiers from all sides!</div></div>'+
      '<button id="__cbIntroOk" style="margin-top:16px;width:100%;background:#ffd24a;color:#111;border:0;'+
      'border-radius:10px;padding:11px;font-weight:800;font-size:14px;cursor:pointer">Let\u2019s blast! 🚀</button></div>';
    document.documentElement.appendChild(ov);
    removeList.push(ov);
    function highlightToggles(on){
      [modeBtn, dangerBtn].forEach(function(b){
        b.style.opacity = "1";
        b.style.outline = on ? "3px solid #ffd24a" : "";
      });
    }
    highlightToggles(true);
    function dismiss(){ introActive = false; highlightToggles(false); if (ov.parentNode) ov.parentNode.removeChild(ov);
      try { chrome.storage.local.set({ cbIntroSeen: true }); } catch(e){} }
    ov.querySelector("#__cbIntroOk").addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); dismiss(); });
    // Clicking the backdrop both dismisses the intro AND fires — no wasted first click
    ov.addEventListener("click", function(e){ if (e.target === ov) { e.stopPropagation(); dismiss(); beginFire(e.clientX, e.clientY); } });
  }

  /* ── PIVOT / MUZZLE HELPERS ─────────────────────────────────────────────── */
  function getPivot() {
    var r = tankRect || { left: viewW/2 - 70, top: viewH - 115, width: 140, height: 85 };
    return { x: r.left + (70/140)*r.width, y: r.top + (38/85)*r.height };
  }
  function getMuzzle() {
    var p = getPivot(), r = tankRect || { width: 140 };
    var len = (62/140)*r.width;
    return { x: p.x + Math.cos(aimAngle)*len, y: p.y + Math.sin(aimAngle)*len };
  }

  /* ── AIMING ───────────────────────────────────────────────────────────────
     Firing is click-anywhere (onFirePointerDown); the barrel + arc track the
     cursor every frame in applyAim(). The barrel SVG is only rewritten in the
     write phase, and only when its angle actually changed. */

  /* Solve projectile launch from muzzle → target so it lands EXACTLY at target.
     Fixed flight time (scaled by distance) → guaranteed pass-through arc. */
  function solveLaunch(mx, my, tx, ty) {
    var dx = tx - mx, dy = ty - my;
    var dist = Math.hypot(dx, dy);
    var T = Math.max(0.6, Math.min(dist / 440, 1.5)); // flight time (slow-mo feel)
    var vx = dx / T;
    var vy = (dy - 0.5 * BALL_G * T * T) / T;
    return { vx: vx, vy: vy, T: T, dist: dist };
  }

  function aimBarrelToward(mx, my) {
    var p = getPivot();
    var sol = solveLaunch(p.x, p.y, mx, my);
    aimAngle = Math.atan2(sol.vy, sol.vx);
  }

  // CANNON: aim the arc at an arbitrary point (cursor) — drives the live
  // trajectory preview so the user can click anywhere on the page to blast.
  function updateCannonAimTo(mx, my) {
    targetX = Math.max(6, Math.min(viewW - 6, mx));
    targetY = Math.max(6, Math.min(viewH - 6, my));
    var p = getPivot();
    var sol = solveLaunch(p.x, p.y, targetX, targetY);
    aimAngle = Math.atan2(sol.vy, sol.vx);
    aimPower = Math.min(sol.dist / Math.hypot(viewW, viewH), 1);
    hasAim = sol.dist >= MIN_AIM_DIST;
  }

  function writeBarrel() {
    if (Math.abs(aimAngle - shownAngle) < 0.002) return;
    shownAngle = aimAngle;
    barrelG.setAttribute("transform", "rotate(" + (aimAngle * 180 / Math.PI).toFixed(2) + " 70 38)");
  }

  function applyAim() {
    if (mode === "cannon") updateCannonAimTo(mouseX, mouseY);
    else                   aimBarrelToward(mouseX, mouseY);
  }

  function fireAt(x, y) {
    if (mode === "gun") {
      fireGun(x, y);
    } else {
      updateCannonAimTo(x, y);
      fireCannon();
    }
  }

  // Pointer pressed: fire once now; in gun mode begin holding so the bullets
  // keep streaming (updateGunAutoFire) until the pointer is released.
  function beginFire(x, y) {
    if (introActive) return;          // wait until the intro is dismissed
    mouseX = x; mouseY = y;
    fireAt(x, y);
    if (mode === "gun") { gunHeld = true; gunFireCd = GUN_FIRE_INTERVAL; }
  }
  function endFire() { gunHeld = false; }
  function updateGunAutoFire(dt) {
    if (mode !== "gun") { gunHeld = false; return; }
    if (!gunHeld) return;
    gunFireCd -= dt;
    if (gunFireCd <= 0) { fireGun(mouseX, mouseY); gunFireCd = GUN_FIRE_INTERVAL; }
  }

  /* ── FIRE ────────────────────────────────────────────────────────────────── */
  function fireCannon() {
    if (!hasAim) return;
    var m   = getMuzzle();
    var sol = solveLaunch(m.x, m.y, targetX, targetY);
    if (sol.dist < MIN_AIM_DIST) return;

    balls.push({
      x: m.x, y: m.y,
      vx: sol.vx, vy: sol.vy,
      trail: [], spin: 0,
      landX: targetX, landY: targetY,
      T: sol.T, elapsed: 0,
      exploded: false
    });

    spawnMuzzleFlash(m.x, m.y);
    hasAim = false;
    aimPower = 0;
  }

  function spawnMuzzleFlash(x, y) {
    var sparks = [];
    for (var i = 0; i < 10; i++)
      sparks.push({ a: aimAngle + (Math.random()-0.5)*1.1, len: 14+Math.random()*22 });
    mFlashes.push({ x:x, y:y, sparks:sparks, life:0.2, maxLife:0.2 });
  }

  /* ── GUN: straight-line bullets, fired per click, kill soldiers ──────────── */
  function fireGun(mx, my) {
    aimBarrelToward(mx, my);              // align barrel to this shot
    var m = getMuzzle();
    var ang = Math.atan2(my - m.y, mx - m.x);
    var spd = 1600;
    bullets.push({
      x: m.x, y: m.y, px: m.x, py: m.y,
      vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd,
      life: 1.4
    });
    spawnMuzzleFlash(m.x, m.y);
  }

  // shortest distance from point P to segment AB (for fast bullet hit tests)
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx-ax, dy = by-ay, len2 = dx*dx + dy*dy;
    var t = len2 ? ((px-ax)*dx + (py-ay)*dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t*dx, cy = ay + t*dy;
    return Math.hypot(px-cx, py-cy);
  }

  function updateBullets(dt) {
    for (var i = bullets.length-1; i >= 0; i--) {
      var b = bullets[i];
      b.px = b.x; b.py = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.life -= dt;
      var hit = false;
      for (var j = 0; j < soldiers.length; j++) {
        var s = soldiers[j];
        if (s.state === "dead") continue;
        if (segDist(s.x, s.y - 20, b.px, b.py, b.x, b.y) < 15) {
          killSoldier(s);
          hit = true;
          break;
        }
      }
      if (hit) {
        spawnBlood(b.x, b.y, b.vx, b.vy);
        for (var k = 0; k < 6; k++) {
          var a = Math.random()*Math.PI*2, sp = 30+Math.random()*60;
          particles.push({ x:b.x, y:b.y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
            life:0.18, maxLife:0.18, size:0.8+Math.random(), color:"#ffd24a",
            type:"spark", rotation:0, rotSpeed:0 });
        }
        bullets.splice(i, 1);
        continue;
      }
      if (b.life <= 0 || b.x < -40 || b.x > viewW+40 || b.y < -40 || b.y > viewH+40) {
        bullets.splice(i, 1);
      }
    }
  }

  /* ── BLOOD: small drops fly out on a hit, settle, linger, then fade ──────── */
  function spawnBlood(x, y, dirx, diry) {
    var base = Math.atan2(diry, dirx);
    var n = 6 + Math.floor(Math.random()*4);
    for (var i = 0; i < n; i++) {
      var a = base + (Math.random()-0.5)*1.8;
      var sp = 60 + Math.random()*170;
      bloodDrops.push({
        x:x, y:y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp - 40,
        r: 1.2 + Math.random()*2.4,
        settled:false, settleY:0,
        age:0, hold: 2.0 + Math.random()*1.2, fade:0.8,
        hue: Math.random()<0.5 ? "#9e0b0b" : "#c11313"
      });
    }
  }

  function updateBlood(dt) {
    for (var i = bloodDrops.length-1; i >= 0; i--) {
      var d = bloodDrops[i];
      if (!d.settled) {
        d.vy += 620*dt;
        d.x += d.vx*dt; d.y += d.vy*dt;
        d.vx *= 0.99;
        if (d.vy > 30 && Math.random() < 0.06*dt*60) { d.settled = true; d.settleY = d.y; }
      } else {
        d.age += dt;
      }
      if (d.age >= d.hold + d.fade) bloodDrops.splice(i, 1);
    }
  }

  function renderBlood() {
    for (var i = 0; i < bloodDrops.length; i++) {
      var d = bloodDrops[i];
      var alpha = 1;
      if (d.settled && d.age > d.hold) alpha = Math.max(0, 1 - (d.age - d.hold)/d.fade);
      ctx.globalAlpha = alpha * 0.92;
      ctx.fillStyle = d.hue;
      ctx.beginPath();
      if (d.settled) ctx.ellipse(d.x, d.y, d.r*1.4, d.r*0.85, 0, 0, Math.PI*2);
      else           ctx.arc(d.x, d.y, d.r, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function renderBullets() {
    if (!bullets.length) return;
    ctx.save();
    ctx.lineCap = "round";
    for (var i = 0; i < bullets.length; i++) {
      var b = bullets[i];
      var tx = b.x - b.vx*0.016, ty = b.y - b.vy*0.016;  // tracer tail
      // dark outline so the tracer reads on bright backgrounds
      ctx.strokeStyle = "rgba(20,12,0,0.85)";
      ctx.lineWidth = 5.2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      // soft glow halo (a wide translucent stroke instead of a per-frame shadowBlur)
      ctx.strokeStyle = "rgba(255,170,40,0.3)";
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      // glowing core
      ctx.strokeStyle = "rgba(255,150,30,0.95)";
      ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = "#fff6d8";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      // bright head with dark ring
      ctx.fillStyle = "#fff8e0";
      ctx.beginPath(); ctx.arc(b.x, b.y, 2.6, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = "rgba(20,12,0,0.85)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, 3.1, 0, Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }

  // Crosshair reticle drawn at the cursor while in gun mode.
  function renderGunReticle() {
    if (mode !== "gun") return;
    var x = mouseX, y = mouseY, r = 11;
    ctx.save();
    ctx.strokeStyle = "rgba(255,80,60,0.9)";
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x-r-5, y); ctx.lineTo(x-3, y);
    ctx.moveTo(x+3, y);   ctx.lineTo(x+r+5, y);
    ctx.moveTo(x, y-r-5); ctx.lineTo(x, y-3);
    ctx.moveTo(x, y+3);   ctx.lineTo(x, y+r+5);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,80,60,0.9)";
    ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  /* ── BALL UPDATE ─────────────────────────────────────────────────────────── */
  function updateBalls(dt) {
    for (var i = balls.length-1; i >= 0; i--) {
      var b = balls[i];
      if (b.exploded) { balls.splice(i,1); continue; }

      b.vy      += BALL_G * dt;
      b.x       += b.vx * dt;
      b.y       += b.vy * dt;
      b.spin    += dt * 7;
      b.elapsed += dt;

      b.trail.push({ x:b.x, y:b.y });
      if (b.trail.length > 22) b.trail.shift();

      // Explode exactly when flight time elapses → lands precisely at cursor target
      if (b.elapsed >= b.T) {
        b.exploded = true;
        explodeAt(b.landX, b.landY);
        balls.splice(i, 1);
      }
    }
  }

  /* ── EXPLOSION ───────────────────────────────────────────────────────────────
     Visuals happen immediately on the canvas. Destroying page content is a
     "job": readBlast() does every layout read for it at the start of the next
     frame, then applyBlast() does the DOM writes. Reads never follow writes
     within a frame, so a blast costs at most one layout, not one per node. */
  var blastQueue = [];
  var blastResults = [];
  function explodeAt(cx, cy) {
    spawnExplosionParticles(cx, cy);
    createBlastMark(cx, cy);
    shakeScreen();
    // Kill any soldiers caught in the blast (drops their loot as a falling shard)
    for (var si = soldiers.length-1; si >= 0; si--) {
      var sol = soldiers[si];
      if (Math.hypot(sol.x - cx, (sol.y-18) - cy) < SOLDIER_KILL_R) killSoldier(sol);
    }
    if (blastQueue.length < MAX_JOBS) blastQueue.push({ cx: cx, cy: cy });
  }

  function spawnExplosionParticles(cx, cy) {
    for (var i = 0; i < 18; i++) {
      var a = Math.random()*Math.PI*2, spd = 40+Math.random()*140;
      var r = Math.random();
      var type, color, size, life;
      if (r < 0.55)      { type="spark"; color=Math.random()<0.5?"#ffffff":"#ffee44"; size=0.8+Math.random()*1; life=0.14+Math.random()*0.22; }
      else if (r < 0.82) { type="ember"; color=Math.random()<0.5?"#ff8800":"#dd2200"; size=1+Math.random()*1.6; life=0.24+Math.random()*0.36; }
      else               { type="smoke"; color="#2a2a2a";                              size=3+Math.random()*4;  life=0.3+Math.random()*0.4; }
      particles.push({ x:cx, y:cy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd,
        life:life, maxLife:life, size:size, color:color, type:type,
        rotation:Math.random()*Math.PI*2, rotSpeed:(Math.random()-0.5)*10 });
    }
    shockwaves.push({x:cx,y:cy,r:0,maxR:42, life:0.22,maxLife:0.22,w:2.5,color:"255,185,90"});
    shockwaves.push({x:cx,y:cy,r:0,maxR:26, life:0.13,maxLife:0.13,w:1.5,color:"255,255,255"});
    craters.push({ x:cx, y:cy, r:14+Math.random()*5, life:1.0, maxLife:1.0 });
  }

  function distToRect(cx, cy, r) {
    var nx = Math.max(r.left, Math.min(cx, r.right));
    var ny = Math.max(r.top,  Math.min(cy, r.bottom));
    return Math.hypot(nx - cx, ny - cy);
  }

  // Hit-test sample points: centre, ring at R/2, ring at R (unit circle).
  var SAMPLES = [[0, 0]];
  (function () {
    var rings = [0.5, 1];
    for (var rd = 0; rd < rings.length; rd++)
      for (var a = 0; a < 8; a++)
        SAMPLES.push([Math.cos(a / 8 * Math.PI * 2) * rings[rd], Math.sin(a / 8 * Math.PI * 2) * rings[rd]]);
  }());

  /* READ phase of one blast: gathers everything it will destroy. */
  function readBlast(job) {
    var cx = job.cx, cy = job.cy, R = BLAST_RADIUS;
    var res = { cx: cx, cy: cy, atoms: [], media: [], chars: [] };
    var seen = new Set(), atomSeen = new Set(), mediaSeen = new Set();

    // 1) Whole UI atoms (buttons, icons, svg, bg-images) and videos/canvases.
    for (var s = 0; s < SAMPLES.length; s++) {
      var sx = cx + SAMPLES[s][0] * R, sy = cy + SAMPLES[s][1] * R;
      if (sx < 0 || sy < 0 || sx >= viewW || sy >= viewH) continue;
      var stack = document.elementsFromPoint(sx, sy) || [];
      for (var k = 0; k < stack.length && k < 4; k++) {
        var el = stack[k];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        var atom = atomToFling(el, cx, cy);
        if (!atom) continue;
        if (atom.media) {
          if (!mediaSeen.has(atom.el)) { mediaSeen.add(atom.el); res.media.push(atom); }
        } else if (!atomSeen.has(atom.el) && res.atoms.length < 16) {
          atomSeen.add(atom.el); res.atoms.push(atom);
        }
      }
    }

    // 2) Images within reach of the blast.
    var imgs = document.images;
    for (var i = 0; i < imgs.length && res.media.length < 8; i++) {
      var img = imgs[i];
      if (shattered.has(img) || hiddenSet.has(img) || mediaSeen.has(img)) continue;
      var r = img.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > viewH || r.right < 0 || r.left > viewW) continue;
      if (distToRect(cx, cy, r) > R) continue;
      var ics = getComputedStyle(img);
      if (ics.visibility === "hidden") continue;
      mediaSeen.add(img);
      res.media.push({ media: true, el: img, rect: r, cs: ics });
    }
    // Atoms that contain a shattered image are flung whole instead.
    for (var m = res.media.length - 1; m >= 0; m--) {
      for (var a2 = 0; a2 < res.atoms.length; a2++) {
        if (res.atoms[a2].el.contains(res.media[m].el)) { res.media.splice(m, 1); break; }
      }
    }

    // 3) Characters under the blast (text inside flung atoms goes with them).
    res.chars = collectBlastChars(cx, cy, R, res.atoms);
    return res;
  }

  /* WRITE phase of one blast. */
  function applyBlast(res) {
    var a, m;
    for (a = 0; a < res.atoms.length; a++) flingElement(res.atoms[a].el, res.cx, res.cy, res.atoms[a].rect);
    for (m = 0; m < res.media.length; m++) shatterMedia(res.media[m], res.cx, res.cy);
    if (res.chars.length) blastChars(res.chars, res.cx, res.cy);
  }

  var SKIP_ATOM = { html:1, body:1, head:1, script:1, style:1, main:1, section:1, article:1, nav:1, ul:1, ol:1 };
  function atomToFling(el, cx, cy) {
    if (!el || el.nodeType !== 1) return null;
    // Climb out of SVG internals to the <svg> root
    if (el.ownerSVGElement) el = el.ownerSVGElement;
    var tag = el.localName;
    if (SKIP_ATOM[tag]) return null;
    if (el.closest("[data-cb-ui]")) return null;
    if (scattered.has(el) || shattered.has(el) || hiddenSet.has(el)) return null;
    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return null;
    if (rect.width > 240 || rect.height > 180) return null;        // skip big containers
    if (distToRect(cx, cy, rect) > BLAST_RADIUS) return null;      // not actually in blast
    if (tag === "img") return null;                                // handled by the image pass
    if (tag === "video" || tag === "canvas") {
      return { media: true, el: el, rect: rect, cs: getComputedStyle(el) };
    }
    // Decide if this is a "visual atom" worth flinging whole
    var isGraphic = tag === "svg" || tag === "button" || tag === "input" || tag === "select" || tag === "label";
    var cs = getComputedStyle(el);
    var bg = cs.backgroundImage;
    var hasBg = bg && bg !== "none";
    var role = el.getAttribute("role");
    var roleBtn = role === "button" || role === "img";
    var cls = el.getAttribute("class") || "";
    var iconish = /icon|btn|button|logo|avatar|badge|chip|pill|tag\b/i.test(cls);
    if (isGraphic || hasBg || roleBtn || iconish) return { el: el, rect: rect };
    return null;
  }

  function hideEl(el) {
    if (hiddenSet.has(el)) return;
    hiddenSet.add(el);
    hiddenList.push(el);
    el.setAttribute("data-cb-hidden", "");
  }
  function removeNode(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }

  // A detached copy of a page element that can fly around (position:fixed,
  // moved only with compositor-friendly transforms).
  function cloneForFlight(el, left, top, w, h) {
    var clone = el.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("data-cb-hidden");
    var ids = clone.querySelectorAll("[id]");
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
    var cs = clone.style;
    cs.position = "fixed";
    cs.left = left + "px"; cs.top = top + "px";
    cs.width = w + "px"; cs.height = h + "px";
    cs.boxSizing = "border-box";
    cs.margin = "0";
    cs.transform = "none";
    cs.transition = "none";
    cs.pointerEvents = "none";
    cs.zIndex = "2147483646";
    cs.willChange = "transform";
    clone.setAttribute("data-cb-ui", "1");
    var ranges = copyHighlights(el, clone);
    document.documentElement.appendChild(clone);
    return { el: clone, ranges: ranges };
  }

  /* ── ELEMENT SCATTERING — fling whole UI atoms ───────────────────────────── */
  function flingElement(el, cx, cy, rect) {
    if (scattered.has(el) || hiddenSet.has(el)) return;
    scattered.add(el);
    if (flung.length >= MAX_FLUNG) { hideEl(el); return; }   // too much already in the air
    var c = cloneForFlight(el, rect.left, rect.top, rect.width, rect.height);
    hideEl(el);
    var ecx = rect.left + rect.width/2, ecy = rect.top + rect.height/2;
    var ang = Math.atan2(ecy - cy, ecx - cx);
    var dist = Math.hypot(ecx - cx, ecy - cy);
    var force = (1 - Math.min(dist / BLAST_RADIUS, 1)) * 480 + 150 + Math.random()*120;
    flung.push({
      el: c.el, ranges: c.ranges, x: ecx, y: ecy, ox: ecx, oy: ecy,
      vx: Math.cos(ang) * force + (Math.random()-0.5)*150,
      vy: Math.sin(ang) * force - 200 - Math.random()*170,
      rotation: 0, rotSpeed: (Math.random()-0.5)*420,
      life: 1.3 + Math.random()*0.9, fade: 0.4, fading: false
    });
  }

  function updateFlung(dt) {
    for (var i = flung.length-1; i >= 0; i--) {
      var s = flung[i];
      s.vy += SHARD_G * dt;
      s.vx *= 0.997;
      s.x  += s.vx * dt;
      s.y  += s.vy * dt;
      s.rotation += s.rotSpeed * dt;
      s.life -= dt;
      if (s.life <= 0) {
        removeNode(s.el);
        dropRanges(s.ranges);
        flung.splice(i, 1);
        continue;
      }
      s.el.style.transform = "translate3d(" + (s.x-s.ox).toFixed(1) + "px," + (s.y-s.oy).toFixed(1) + "px,0) rotate(" + s.rotation.toFixed(1) + "deg)";
      if (!s.fading && s.life <= s.fade) {
        s.fading = true;
        s.el.style.transition = "opacity 0.3s";
        s.el.style.opacity = "0";
      }
    }
  }

  /* ── TEXT BLASTING ───────────────────────────────────────────────────────────
     Characters inside the blast are found with caret hit-tests along a few
     scanlines, measured with a Range (reads only), then hidden by adding
     StaticRanges to a CSS Custom Highlight whose style makes them transparent.
     Text nodes are never split or replaced: no reflow, no layout shift, and
     framework-owned nodes (React/Vue) stay intact. Browsers without the API
     fall back to wrapping only the blasted runs in transparent spans. */
  var hlSupported = !!(window.CSS && CSS.highlights && typeof window.Highlight === "function" &&
                       typeof window.StaticRange === "function");
  var hl = null;
  var textStates = new WeakMap();   // Text -> { len, bits, count, ranges }
  var measRange = document.createRange();
  var segmenter = null;
  try { segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch (e) {}
  var SKIP_TEXT_PARENT = { script:1, style:1, noscript:1, textarea:1, option:1, select:1, title:1, template:1 };

  function isSpaceCode(c) {
    return c <= 32 || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200D) ||
           c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 ||
           c === 0xFEFF || c === 0x00AD;
  }

  function ensureHighlight() {
    if (hl) return;
    hl = new Highlight();
    try { hl.priority = 1000; } catch (e) {}
    CSS.highlights.set(HL_NAME, hl);
  }

  function textStateFor(node, create) {
    var st = textStates.get(node);
    if (st && st.len !== node.length) {   // the page rewrote this text — start over
      dropRanges(st.ranges);
      textStates.delete(node);
      st = null;
    }
    if (!st && create) {
      st = { len: node.length, bits: new Uint8Array(node.length), count: 0, ranges: [] };
      textStates.set(node, st);
    }
    return st || null;
  }

  function dropRanges(ranges) {
    if (!hl || !ranges) return;
    for (var i = 0; i < ranges.length; i++) hl.delete(ranges[i]);
    ranges.length = 0;
  }

  function caretAt(x, y) {
    var node = null, off = 0;
    try {
      if (document.caretPositionFromPoint) {
        var p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; off = p.offset; }
      } else if (document.caretRangeFromPoint) {
        var cr = document.caretRangeFromPoint(x, y);
        if (cr) { node = cr.startContainer; off = cr.startOffset; }
      }
    } catch (e) { return null; }
    if (!node || node.nodeType !== 3) return null;
    return { node: node, off: off };
  }

  function collectBlastChars(cx, cy, R, atoms) {
    var wins = new Map();   // Text -> [lo, hi] offsets worth measuring
    function addWin(n, lo, hi) {
      var w = wins.get(n);
      if (!w) wins.set(n, [lo, hi]);
      else { if (lo < w[0]) w[0] = lo; if (hi > w[1]) w[1] = hi; }
    }
    // Caret probes at the chord ends + centre of each scanline across the blast.
    for (var y = cy - R + 3; y <= cy + R - 3; y += 7) {
      if (y < 0 || y >= viewH) continue;
      var dy = y - cy, half = Math.sqrt(Math.max(0, R * R - dy * dy));
      var prev = null;
      for (var k = -1; k <= 1; k++) {
        var x = Math.max(0, Math.min(viewW - 1, cx + k * half));
        var c = caretAt(x, y);
        if (!c) { prev = null; continue; }
        addWin(c.node, c.off - 2, c.off + 2);
        if (prev && prev.node !== c.node) bridgeWindows(prev, c, addWin);
        prev = c;
      }
    }

    var out = [], R2 = R * R, styleCache = new Map();
    wins.forEach(function (w, node) {
      if (out.length >= MAX_BLAST_CHARS) return;
      var parent = node.parentElement;
      if (!parent || SKIP_TEXT_PARENT[parent.localName] || parent.namespaceURI !== HTML_NS) return;
      if (parent.closest("[data-cb-hidden],[data-cb-ui],[data-cb-blasted]")) return;
      for (var a = 0; a < atoms.length; a++) if (atoms[a].el.contains(node)) return;
      var st = textStateFor(node, false);
      var data = node.data, len = data.length;
      var lo = Math.max(0, w[0]), hi = Math.min(len, w[1]);
      if (hi <= lo) return;
      forEachCluster(data, lo, hi, function (i, n) {
        if (out.length >= MAX_BLAST_CHARS) return;
        if (isSpaceCode(data.charCodeAt(i))) return;
        if (st && st.bits[i]) return;
        measRange.setStart(node, i);
        measRange.setEnd(node, i + n);
        var rect = measRange.getBoundingClientRect();
        if (rect.width < 0.5 || rect.height < 0.5) return;
        var px = rect.left + rect.width / 2 - cx, py = rect.top + rect.height / 2 - cy;
        if (px * px + py * py > R2) return;
        var sty = styleCache.get(parent);
        if (!sty) { sty = textStyle(parent); styleCache.set(parent, sty); }
        out.push({ node: node, i: i, n: n, rect: rect, style: sty });
      });
    });
    return out;
  }

  // Text between two caret hits on the same scanline (e.g. "a <b>bold</b> word").
  function bridgeWindows(a, b, addWin) {
    var first = a, last = b;
    if (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_PRECEDING) { first = b; last = a; }
    addWin(first.node, first.off - 2, first.off + 80);
    addWin(last.node, last.off - 80, last.off + 2);
    var tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    tw.currentNode = first.node;
    for (var i = 0, n; i < 8 && (n = tw.nextNode()) && n !== last.node; i++) addWin(n, 0, 80);
  }

  // Calls fn(offset, length) for each grapheme cluster starting in [lo, hi).
  function forEachCluster(data, lo, hi, fn) {
    if (segmenter) {
      var base = Math.max(0, lo - 6);
      var it = segmenter.segment(data.slice(base, Math.min(data.length, hi + 6)))[Symbol.iterator]();
      for (var step = it.next(); !step.done; step = it.next()) {
        var off = base + step.value.index;
        if (off >= hi) break;
        if (off >= lo) fn(off, step.value.segment.length);
      }
      return;
    }
    for (var i = lo; i < hi; i++) {
      var c = data.charCodeAt(i), n = (c >= 0xD800 && c <= 0xDBFF && i + 1 < data.length) ? 2 : 1;
      fn(i, n);
      i += n - 1;
    }
  }

  function isTransparentColor(c) { return !c || c === "transparent" || /,\s*0\)$/.test(c); }
  function textStyle(el) {
    var cs = getComputedStyle(el);
    var color = cs.webkitTextFillColor;
    if (isTransparentColor(color)) color = cs.color;
    if (isTransparentColor(color)) color = null;    // invisible text: hide it, nothing flies
    var font = (cs.fontStyle && cs.fontStyle !== "normal" ? cs.fontStyle + " " : "") +
               (cs.fontVariant === "small-caps" ? "small-caps " : "") +
               cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    return { font: font, color: color, tt: cs.textTransform };
  }

  var measureCtx = document.createElement("canvas").getContext("2d");
  var ascentCache = new Map();
  function fontAscent(font, h) {
    var a = ascentCache.get(font);
    if (a === undefined) {
      measureCtx.font = font;
      var m = measureCtx.measureText("Hg");
      a = m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : -1;
      ascentCache.set(font, a);
    }
    return a > 0 ? a : h * 0.8;
  }

  /* Flying characters are drawn from a glyph atlas: each (font, colour, char)
     is rasterized once, upright, and every frame only draws rotated copies of
     it. Calling fillText with a new rotation every frame makes Chrome
     re-rasterize and upload the glyphs each frame, which stalls the frame. */
  var ATLAS_SIZE = 1024;   // device pixels
  var atlas = null;
  function newAtlas() {
    var c = document.createElement("canvas");
    c.width = c.height = ATLAS_SIZE;
    atlas = { c: c, ctx: c.getContext("2d"), x: 1, y: 1, rowH: 0, map: new Map(), dpr: dpr };
  }
  function glyphFor(ch, font, color) {
    if (!atlas || atlas.dpr !== dpr) newAtlas();
    var key = font + "\n" + color + "\n" + ch;
    var g = atlas.map.get(key);
    if (g !== undefined) return g;
    var x = atlas.ctx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.font = font;
    var m = x.measureText(ch), pad = 2;
    var asc = m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : m.actualBoundingBoxAscent;
    var desc = m.fontBoundingBoxDescent > 0 ? m.fontBoundingBoxDescent : m.actualBoundingBoxDescent;
    var left = Math.max(0, m.actualBoundingBoxLeft || 0);
    var right = Math.max(m.width, m.actualBoundingBoxRight || 0);
    var wCss = left + right + pad * 2, hCss = asc + desc + pad * 2;
    var w = Math.ceil(wCss * dpr), h = Math.ceil(hCss * dpr);
    if (!(w > 0 && h > 0) || w > 256 || h > 256) { atlas.map.set(key, null); return null; }  // huge glyph: fillText
    if (atlas.x + w > ATLAS_SIZE) { atlas.x = 1; atlas.y += atlas.rowH + 1; atlas.rowH = 0; }
    if (atlas.y + h > ATLAS_SIZE) { newAtlas(); return glyphFor(ch, font, color); }
    x.setTransform(dpr, 0, 0, dpr, atlas.x, atlas.y);
    x.textAlign = "left";
    x.textBaseline = "alphabetic";
    x.fillStyle = color;
    x.fillText(ch, pad + left, pad + asc);
    // dx/dy place the slot so the glyph is centred like textAlign:center on the baseline.
    g = { c: atlas.c, sx: atlas.x, sy: atlas.y, sw: w, sh: h, w: wCss, h: hCss,
          dx: -m.width / 2 - pad - left, dy: -pad - asc };
    atlas.x += w + 1;
    if (h > atlas.rowH) atlas.rowH = h;
    atlas.map.set(key, g);
    return g;
  }

  // WRITE phase for characters: hide them and launch canvas copies.
  function blastChars(chars, cx, cy) {
    var touched = new Map();
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      var st = textStateFor(c.node, true);
      if (st.bits[c.i]) continue;
      for (var k = 0; k < c.n; k++) st.bits[c.i + k] = 1;
      st.count++;
      var t = touched.get(c.node);
      if (!t) { t = { st: st, runs: [] }; touched.set(c.node, t); }
      t.runs.push([c.i, c.i + c.n]);
      if (c.style.color && debris.length < MAX_DEBRIS) spawnCharDebris(c, cx, cy);
    }
    touched.forEach(function (t, node) {
      if (hlSupported) highlightRuns(node, t.st);
      else fallbackHide(node, t.runs);
    });
  }

  // Rebuild this node's ranges from its bitset; whitespace between blasted
  // characters joins runs so the highlight stays small.
  function highlightRuns(node, st) {
    ensureHighlight();
    dropRanges(st.ranges);
    var bits = st.bits, data = node.data, len = st.len, start = -1, last = -1;
    for (var i = 0; i <= len; i++) {
      if (i < len && bits[i]) { if (start < 0) start = i; last = i; continue; }
      if (start >= 0 && (i === len || !isSpaceCode(data.charCodeAt(i)))) {
        var r = new StaticRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: last + 1 });
        hl.add(r);
        st.ranges.push(r);
        start = -1;
      }
    }
  }

  // Fallback without the Highlight API: wrap just the blasted runs in
  // transparent spans (spaces and line breaks are left untouched).
  var fbOriginal = new Map();   // original Text -> its original data
  var fbCreated = [];           // nodes we inserted
  function fallbackHide(node, runs) {
    if (!fbOriginal.has(node)) fbOriginal.set(node, node.data);
    runs.sort(function (a, b) { return a[0] - b[0]; });
    for (var r = runs.length - 1; r >= 0; r--) {
      var a = runs[r][0], b = runs[r][1];
      if (b < node.length) fbCreated.push(node.splitText(b));
      var mid = node.splitText(a);
      var span = document.createElement("span");
      span.setAttribute("data-cb-blasted", "");
      span.style.cssText = "color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;";
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
      fbCreated.push(span);
    }
  }

  // Flying copies of an element keep the holes already blasted into its text.
  function copyHighlights(orig, clone) {
    if (!hl) return null;
    var ranges = null;
    var wa = document.createTreeWalker(orig, NodeFilter.SHOW_TEXT);
    var wb = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    var ta, tb;
    while ((ta = wa.nextNode()) && (tb = wb.nextNode())) {
      var st = textStates.get(ta);
      if (!st || !st.ranges.length || st.len !== ta.length) continue;
      for (var i = 0; i < st.ranges.length; i++) {
        var r = new StaticRange({ startContainer: tb, startOffset: st.ranges[i].startOffset,
                                  endContainer: tb, endOffset: st.ranges[i].endOffset });
        hl.add(r);
        (ranges || (ranges = [])).push(r);
      }
    }
    return ranges;
  }

  // Characters still showing in an element (blasted ones don't count).
  function visibleTextLength(el, cap) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), t, total = 0;
    while ((t = w.nextNode())) {
      var p = t.parentElement;
      if (!p || SKIP_TEXT_PARENT[p.localName] || p.hasAttribute("data-cb-blasted")) continue;
      var data = t.data, st = textStateFor(t, false), word = false;
      for (var i = 0; i < data.length; i++) {
        if (isSpaceCode(data.charCodeAt(i))) { if (word) { total++; word = false; } continue; }
        if (st && st.bits[i]) continue;
        total++; word = true;
      }
      if (total > cap) break;
    }
    return total;
  }

  function spawnCharDebris(c, cx, cy) {
    var r = c.rect, px = r.left + r.width / 2, py = r.top + r.height / 2;
    var dist  = Math.hypot(px - cx, py - cy);
    var force = (1 - Math.min(dist / BLAST_RADIUS, 1)) * 640 + Math.random() * 180;
    var ang   = Math.atan2(py - cy, px - cx);
    var data = c.node.data, ch = data.substr(c.i, c.n), tt = c.style.tt;
    if (tt === "uppercase") ch = ch.toUpperCase();
    else if (tt === "lowercase") ch = ch.toLowerCase();
    else if (tt === "capitalize" && (c.i === 0 || isSpaceCode(data.charCodeAt(c.i - 1)))) ch = ch.toUpperCase();
    debris.push({
      t: 0, ch: ch, font: c.style.font, color: c.style.color, g: glyphFor(ch, c.style.font, c.style.color),
      base: fontAscent(c.style.font, r.height) - r.height / 2,
      x: px, y: py,
      vx: Math.cos(ang) * force + (Math.random()-0.5) * 200,
      vy: Math.sin(ang) * force - 260 - Math.random() * 250,
      rot: 0, rs: (Math.random()-0.5) * 560 * Math.PI / 180,
      life: 1.2 + Math.random() * 1.0, fade: 0.35
    });
  }

  /* ── IMAGE / VIDEO / CANVAS SHATTERING (4×4 grid on the game canvas) ───────
     The element is drawn once into a snapshot canvas (exactly what is on
     screen: currentSrc, object-fit, no new network request), then 16 pieces of
     that snapshot fly on the overlay canvas. */
  function shatterMedia(m, cx, cy) {
    var el = m.el, rect = m.rect;
    if (shattered.has(el)) return;
    shattered.add(el);
    var snap = snapshotMedia(el, rect, m.cs || getComputedStyle(el));
    hideEl(el);
    if (!snap) return;
    var G = 4, pw = rect.width / G, ph = rect.height / G, k = snap.scale;
    for (var row = 0; row < G; row++) {
      for (var col = 0; col < G; col++) {
        if (debris.length >= MAX_DEBRIS) return;
        var pcx = rect.left + col * pw + pw / 2, pcy = rect.top + row * ph + ph / 2;
        var dist = Math.hypot(pcx - cx, pcy - cy);
        var f = (1 - Math.min(dist / BLAST_RADIUS, 1)) * 560 + Math.random() * 140;
        var a = Math.atan2(pcy - cy, pcx - cx);
        debris.push({
          t: 1, src: snap.canvas, sx: col * pw * k, sy: row * ph * k, sw: pw * k, sh: ph * k, w: pw, h: ph,
          x: pcx, y: pcy,
          vx: Math.cos(a) * f + (Math.random()-0.5) * 160,
          vy: Math.sin(a) * f - 210 - Math.random() * 200,
          rot: 0, rs: (Math.random()-0.5) * 440 * Math.PI / 180,
          life: 1.4 + Math.random() * 0.9, fade: 0.3
        });
      }
    }
  }

  function posOffset(v, free) {
    if (!v) return free / 2;
    if (v.charAt(v.length - 1) === "%") return free * parseFloat(v) / 100;
    return parseFloat(v) || 0;
  }

  function snapshotMedia(el, rect, cs) {
    var tag = el.localName, iw = 0, ih = 0;
    if (tag === "img") {
      if (!el.complete) return null;
      iw = el.naturalWidth; ih = el.naturalHeight;
    } else if (tag === "video") {
      if (el.readyState < 2) return null;
      iw = el.videoWidth; ih = el.videoHeight;
    } else if (tag === "canvas") {
      iw = el.width; ih = el.height;
    } else return null;
    var bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    var br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    var pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
    var pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    var bx = bl + pl, by = bt + pt;
    var bw = rect.width - bl - br - pl - pr, bh = rect.height - bt - bb - pt - pb;
    if (bw <= 0 || bh <= 0) return null;
    if (!iw || !ih) { iw = bw; ih = bh; }               // e.g. SVG without intrinsic size
    var fit = cs.objectFit || "fill", w = bw, h = bh;
    if (fit === "contain" || fit === "cover" || fit === "scale-down") {
      var s = fit === "cover" ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
      if (fit === "scale-down") s = Math.min(s, 1);
      w = iw * s; h = ih * s;
    } else if (fit === "none") { w = iw; h = ih; }
    var pos = (cs.objectPosition || "50% 50%").split(" ");
    var ox = bx + posOffset(pos[0], bw - w), oy = by + posOffset(pos[1], bh - h);
    var scale = Math.min(dpr, 2, 2048 / Math.max(rect.width, rect.height));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(rect.width * scale));
    c.height = Math.max(1, Math.round(rect.height * scale));
    var x = c.getContext("2d");
    x.scale(scale, scale);
    x.beginPath(); x.rect(bx, by, bw, bh); x.clip();
    try { x.drawImage(el, ox, oy, w, h); } catch (e) { return null; }   // broken / not decodable
    return { canvas: c, scale: scale };
  }

  /* ── CANVAS DEBRIS (flying characters + image pieces) ───────────────────── */
  function updateDebris(dt) {
    var j = 0;
    for (var i = 0; i < debris.length; i++) {
      var d = debris[i];
      d.vy += SHARD_G * dt;
      d.vx *= 0.997;
      d.x  += d.vx * dt;
      d.y  += d.vy * dt;
      d.rot += d.rs * dt;
      d.life -= dt;
      if (d.life > 0 && d.y < viewH + 400) debris[j++] = d;
    }
    debris.length = j;
  }

  function renderDebris() {
    if (!debris.length) return;
    var lastFont = "", lastFill = "";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (var i = 0; i < debris.length; i++) {
      var d = debris[i];
      if (d.x < -120 || d.x > viewW + 120 || d.y < -120 || d.y > viewH + 120) continue;
      var c = Math.cos(d.rot) * dpr, s = Math.sin(d.rot) * dpr;
      ctx.setTransform(c, s, -s, c, d.x * dpr, d.y * dpr);
      ctx.globalAlpha = d.life < d.fade ? Math.max(0, d.life / d.fade) : 1;
      if (d.t === 0) {
        var g = d.g;
        if (g) {
          ctx.drawImage(g.c, g.sx, g.sy, g.sw, g.sh, g.dx, d.base + g.dy, g.w, g.h);
        } else {
          if (d.font !== lastFont) { ctx.font = d.font; lastFont = d.font; }
          if (d.color !== lastFill) { ctx.fillStyle = d.color; lastFill = d.color; }
          ctx.fillText(d.ch, 0, d.base);
        }
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.35)"; lastFill = "";
        ctx.fillRect(-d.w / 2 + 1, -d.h / 2 + 2, d.w, d.h);
        ctx.drawImage(d.src, d.sx, d.sy, d.sw, d.sh, -d.w / 2, -d.h / 2, d.w, d.h);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  /* ── PRE-RENDERED SPRITES (instead of per-frame shadowBlur / gradients) ─── */
  var sprites = {};
  function spriteCanvas(cssSize, draw) {
    var c = document.createElement("canvas");
    c.width = c.height = Math.max(1, Math.ceil(cssSize * dpr));
    var x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, cssSize * dpr / 2, cssSize * dpr / 2);   // origin = centre
    draw(x, cssSize / 2);
    return c;
  }
  function radialSprite(stops) {
    return spriteCanvas(64, function (x, r) {
      var g = x.createRadialGradient(0, 0, 0, 0, 0, r);
      for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fill();
    });
  }
  function buildSprites() {
    // Cannonball + its glow (shadowBlur is in device pixels, like the original).
    var ext = BALL_R + 60 / dpr;
    sprites.ballExt = ext;
    sprites.ball = spriteCanvas(ext * 2, function (x) {
      x.shadowColor = "rgba(255,100,0,1)"; x.shadowBlur = 38;
      var g = x.createRadialGradient(-BALL_R*0.3, -BALL_R*0.3, 1, 0, 0, BALL_R);
      g.addColorStop(0,"#ffffff"); g.addColorStop(0.28,"#ffdd00");
      g.addColorStop(0.62,"#ff5500"); g.addColorStop(1,"#8a1400");
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, BALL_R, 0, Math.PI*2); x.fill();
    });
    sprites.smoke  = radialSprite([[0, "rgba(50,50,50,0.7)"], [1, "rgba(12,12,12,0)"]]);
    sprites.crater = radialSprite([[0, "rgba(12,5,1,1)"], [0.6, "rgba(30,12,3,0.5)"], [1, "rgba(0,0,0,0)"]]);
    sprites.flash  = radialSprite([[0, "rgba(255,255,215,1)"], [0.5, "rgba(255,155,15,0.8)"], [1, "rgba(255,55,0,0)"]]);
    sprites.glow   = {};
  }
  function glowSprite(hex) {
    var s = sprites.glow[hex];
    if (!s) s = sprites.glow[hex] = radialSprite([[0, hexA(hex, 0.75)], [0.35, hexA(hex, 0.35)], [1, hexA(hex, 0)]]);
    return s;
  }

  function hexA(hex, a) {
    var n=parseInt(hex.slice(1),16);
    return "rgba("+((n>>16)&255)+","+(((n>>8)&255))+","+(n&255)+","+a+")";
  }

  /* ── PARTICLE UPDATE ─────────────────────────────────────────────────────── */
  function updateParticles(dt) {
    for (var i = particles.length-1; i >= 0; i--) {
      var p = particles[i];
      if (p.type === "smoke") { p.vy -= GRAVITY*0.35*dt; p.vx *= 0.96; }
      else { p.vy += GRAVITY*0.2*dt; p.vx *= 0.98; p.vy *= 0.99; }
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.rotation += p.rotSpeed*dt; p.life -= dt;
      if (p.life <= 0) particles.splice(i,1);
    }
    for (var j = shockwaves.length-1; j >= 0; j--) {
      var sw = shockwaves[j];
      sw.life -= dt; sw.r = sw.maxR*(1 - sw.life/sw.maxLife);
      if (sw.life <= 0) shockwaves.splice(j,1);
    }
    for (var k = mFlashes.length-1; k >= 0; k--) { mFlashes[k].life-=dt; if(mFlashes[k].life<=0) mFlashes.splice(k,1); }
    for (var l = floaters.length-1; l >= 0; l--) { floaters[l].life-=dt; floaters[l].y-=28*dt; if(floaters[l].life<=0) floaters.splice(l,1); }
    for (var m = craters.length-1;  m >= 0; m--) { craters[m].life-=dt;  if(craters[m].life<=0)  craters.splice(m,1); }
  }

  /* ── RENDERING ───────────────────────────────────────────────────────────── */
  function renderCraters() {
    for (var i = 0; i < craters.length; i++) {
      var c = craters[i];
      ctx.globalAlpha = Math.min(c.life/c.maxLife, 1) * 0.42;
      ctx.drawImage(sprites.crater, c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  function renderTrajectoryPreview() {
    if (mode !== "cannon" || !hasAim) return;
    var m = getMuzzle();
    var sol = solveLaunch(m.x, m.y, targetX, targetY);
    if (sol.dist < MIN_AIM_DIST) return;
    var x = m.x, y = m.y, vx = sol.vx, vy = sol.vy;
    var T = sol.T, dt = T / 46;  // ~46 dots along the arc
    ctx.save();
    for (var step = 1; step <= 46; step++) {
      vy += BALL_G * dt;
      x  += vx * dt;
      y  += vy * dt;
      var t = step / 46;
      if (x >= 0 && x <= viewW && y >= 0 && y <= viewH) {
        var alpha = 0.9 - t * 0.55, dotR = 2.5 + t * 2.5;
        var gg = Math.floor(t < 0.5 ? 140 + t * 230 : 255 - t * 120);
        ctx.beginPath();
        ctx.fillStyle  = "rgba(255," + Math.min(gg, 255) + ",0," + alpha + ")";
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // ✕ crosshair exactly at the cursor target = blast point
    ctx.strokeStyle = "rgba(255,40,0,0.95)"; ctx.lineWidth = 3;
    var xs = 11;
    ctx.beginPath(); ctx.moveTo(targetX-xs, targetY-xs); ctx.lineTo(targetX+xs, targetY+xs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(targetX+xs, targetY-xs); ctx.lineTo(targetX-xs, targetY+xs); ctx.stroke();
    ctx.beginPath(); ctx.arc(targetX, targetY, 16, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(255,40,0,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    renderPowerRing();
  }

  function renderPowerRing() {
    var p=getPivot(), R=64;
    var start=-Math.PI*0.75, end=start+Math.PI*1.5*aimPower;
    var col = aimPower<0.5 ? "rgb("+(Math.floor(70+aimPower*370))+",218,50)"
                           : "rgb(255,"+(Math.floor(218-(aimPower-0.5)*400))+",28)";
    ctx.save();
    ctx.lineCap="round";
    ctx.lineWidth=6;
    ctx.strokeStyle="rgba(255,255,255,0.1)";
    ctx.beginPath(); ctx.arc(p.x,p.y,R,start,start+Math.PI*1.5); ctx.stroke();
    ctx.strokeStyle=col;
    ctx.globalAlpha=0.25; ctx.lineWidth=13;           // glow halo (was shadowBlur)
    ctx.beginPath(); ctx.arc(p.x,p.y,R,start,end); ctx.stroke();
    ctx.globalAlpha=1; ctx.lineWidth=6;
    ctx.beginPath(); ctx.arc(p.x,p.y,R,start,end); ctx.stroke();
    ctx.font="bold 13px system-ui,sans-serif";
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.lineWidth=3; ctx.strokeStyle="rgba(0,0,0,0.6)";
    var label = Math.round(aimPower*100)+"%";
    ctx.strokeText(label, p.x, p.y-R-15);
    ctx.fillStyle=col;
    ctx.fillText(label, p.x, p.y-R-15);
    ctx.restore();
  }

  function renderBalls() {
    var ext = sprites.ballExt;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      // Fire trail
      for (var t2 = 0; t2 < b.trail.length; t2++) {
        var tt = t2/b.trail.length, tp = b.trail[t2];
        var rad = BALL_R*(0.22+tt*0.78), alpha = tt*0.65;
        var col2 = tt>0.75 ? "rgba(255,255,200,"+alpha+")" : tt>0.45 ? "rgba(255,165,25,"+alpha+")" : "rgba(255,70,0,"+(alpha*0.55)+")";
        ctx.beginPath(); ctx.fillStyle=col2; ctx.arc(tp.x,tp.y,rad,0,Math.PI*2); ctx.fill();
      }
      // Glowing ball (pre-rendered)
      ctx.drawImage(sprites.ball, b.x - ext, b.y - ext, ext * 2, ext * 2);
      // Spin spot
      var sx=b.x+Math.cos(b.spin)*BALL_R*0.38, sy=b.y+Math.sin(b.spin)*BALL_R*0.38;
      ctx.beginPath(); ctx.fillStyle="rgba(65,12,0,0.5)";
      ctx.arc(sx,sy,BALL_R*0.3,0,Math.PI*2); ctx.fill();
    }
  }

  function renderParticles() {
    for (var i=0; i<particles.length; i++) {
      var p=particles[i], t=Math.max(p.life/p.maxLife,0);
      ctx.globalAlpha = t;
      if (p.type==="spark") {
        var spd2=Math.hypot(p.vx,p.vy), ang2=Math.atan2(p.vy,p.vx);
        var len=Math.min(spd2*0.02,13)+p.size;
        var c=Math.cos(ang2)*dpr, s=Math.sin(ang2)*dpr;
        ctx.setTransform(c, s, -s, c, p.x*dpr, p.y*dpr);
        ctx.fillStyle=p.color;
        ctx.fillRect(-len/2,-p.size/2,len,Math.max(p.size*0.55,1));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else if (p.type==="ember") {
        var er=p.size*(0.45+t*0.55), G=er+6;
        ctx.drawImage(glowSprite(p.color), p.x-G, p.y-G, G*2, G*2);
        ctx.fillStyle=p.color;
        ctx.beginPath(); ctx.arc(p.x,p.y,er,0,Math.PI*2); ctx.fill();
      } else {
        ctx.globalAlpha=t*0.3;
        var gw=p.size*(1+(1-t)*0.6);
        ctx.drawImage(sprites.smoke, p.x-gw, p.y-gw, gw*2, gw*2);
      }
    }
    ctx.globalAlpha = 1;
    for (var j=0; j<shockwaves.length; j++) {
      var sw=shockwaves[j], st=sw.life/sw.maxLife;
      ctx.globalAlpha=st;
      ctx.lineWidth=sw.w*st; ctx.strokeStyle="rgba("+sw.color+","+st+")";
      ctx.beginPath(); ctx.arc(sw.x,sw.y,sw.r,0,Math.PI*2); ctx.stroke();
    }
    for (var k=0; k<mFlashes.length; k++) {
      var mf=mFlashes[k], mt=mf.life/mf.maxLife;
      ctx.globalAlpha=mt;
      var fr=14+(1-mt)*20;
      ctx.drawImage(sprites.flash, mf.x-fr, mf.y-fr, fr*2, fr*2);
      ctx.strokeStyle="rgba(255,205,90,"+mt+")"; ctx.lineWidth=2;
      ctx.beginPath();
      for (var sp=0; sp<mf.sparks.length; sp++) {
        var spk=mf.sparks[sp];
        ctx.moveTo(mf.x,mf.y);
        ctx.lineTo(mf.x+Math.cos(spk.a)*spk.len, mf.y+Math.sin(spk.a)*spk.len);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ── FLOATING POPUPS (score, taunts) drawn on canvas — cheap & smooth ────── */
  function spawnFloater(x, y, text, color, size) {
    floaters.push({ x:x, y:y, text:text, color:color||"#ffd24a",
      size:size||15, life:1.1, maxLife:1.1 });
  }
  function renderFloaters() {
    for (var i=0; i<floaters.length; i++) {
      var f=floaters[i], t=Math.max(f.life/f.maxLife,0);
      ctx.save();
      ctx.globalAlpha = t;
      ctx.font = "800 "+f.size+"px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  /* ── SCREEN SHAKE ────────────────────────────────────────────────────────── */
  // Intensity-based: shakeScreen() bumps a magnitude that decays in the loop.
  var shakeMag = 0;
  function shakeScreen(amount) {
    shakeMag = Math.min(shakeMag + (amount || 8), 14);
  }
  function applyShake(dt) {
    if (shakeMag > 0.3) {
      canvas.style.transform = "translate(" + ((Math.random()-0.5)*2*shakeMag).toFixed(1) + "px,"
                                            + ((Math.random()-0.5)*2*shakeMag).toFixed(1) + "px)";
      shakeMag *= Math.max(0, 1 - Math.min(1, dt * 9));
    } else if (shakeMag !== 0) {
      shakeMag = 0;
      canvas.style.transform = "";
    }
  }

  /* ── BLAST MARKS ─────────────────────────────────────────────────────────────
     A few scorch-mark variants are rendered once (same design as the old SVG
     marks, without per-mark SVG filters). Each blast stamps one, rotated, into
     a small canvas inside a page-anchored layer, so marks scroll with the
     content they burned. They fade after MARK_TTL and are then removed. */
  var markVariants = [];
  var marksLayer = null;
  var marks = [];
  var marksCheckAt = 0;

  function buildMarkVariant() {
    var R = 22 + Math.random()*8;
    var half = Math.ceil(R * 2 + 6);           // cracks reach ~1.9R from the centre
    var c = document.createElement("canvas");
    c.width = c.height = Math.ceil(half * 2 * dpr);
    var x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, half * dpr, half * dpr);
    var glow = 5 * dpr;                        // = SVG feGaussianBlur stdDeviation 2.5
    // scorched rim
    x.globalAlpha = 0.55; x.strokeStyle = "#200a00"; x.lineWidth = 9;
    x.beginPath(); x.arc(0, 0, R*1.1, 0, Math.PI*2); x.stroke();
    // glowing ember core
    x.globalAlpha = 1;
    var eg = x.createRadialGradient(0, 0, 0, 0, 0, R*0.9);
    eg.addColorStop(0, "rgba(255,102,0,0.65)"); eg.addColorStop(0.55, "rgba(255,34,0,0.22)"); eg.addColorStop(1, "rgba(255,0,0,0)");
    x.save(); x.shadowColor = "rgba(255,80,0,0.6)"; x.shadowBlur = glow;
    x.fillStyle = eg; x.beginPath(); x.arc(0, 0, R*0.9, 0, Math.PI*2); x.fill(); x.restore();
    // charred hole
    var hg = x.createRadialGradient(0, 0, 0, 0, 0, R);
    hg.addColorStop(0, "rgba(0,0,0,0.97)"); hg.addColorStop(0.42, "rgba(13,4,0,0.86)");
    hg.addColorStop(0.74, "rgba(26,8,0,0.58)"); hg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = hg; x.beginPath(); x.arc(0, 0, R, 0, Math.PI*2); x.fill();
    // cracks
    var nc = 6 + Math.floor(Math.random()*4);
    for (var i = 0; i < nc; i++) {
      var baseA = (i/nc)*Math.PI*2 + (Math.random()-0.5)*0.55;
      var len = R*(0.8 + Math.random()*0.8);
      var px = 0, py = 0, segs = 2 + Math.floor(Math.random()*2), branches = [];
      x.beginPath(); x.moveTo(0, 0);
      for (var s = 0; s < segs; s++) {
        var sa = baseA + (Math.random()-0.5)*0.28;
        var sl = (len/segs)*(0.65+Math.random()*0.5);
        px += Math.cos(sa)*sl; py += Math.sin(sa)*sl;
        x.lineTo(px, py);
        if (Math.random() > 0.5) branches.push([px, py, px+Math.cos(sa+0.85)*sl*0.28, py+Math.sin(sa+0.85)*sl*0.28]);
      }
      x.lineCap = "round"; x.globalAlpha = 0.88; x.strokeStyle = "#070707"; x.lineWidth = 1 + Math.random()*1.1;
      x.stroke();
      x.lineCap = "butt"; x.globalAlpha = 0.6; x.strokeStyle = "#080808"; x.lineWidth = 0.9;
      for (var b = 0; b < branches.length; b++) {
        x.beginPath(); x.moveTo(branches[b][0], branches[b][1]); x.lineTo(branches[b][2], branches[b][3]); x.stroke();
      }
    }
    // debris specks
    for (var d = 0; d < 16; d++) {
      var da = Math.random()*Math.PI*2, dr = R*(0.5+Math.random()*0.75);
      var gr = Math.floor(15+Math.random()*45);
      x.globalAlpha = 0.45+Math.random()*0.5; x.fillStyle = "rgb("+gr+","+gr+","+gr+")";
      x.beginPath(); x.arc(Math.cos(da)*dr, Math.sin(da)*dr, 0.8+Math.random()*2.2, 0, Math.PI*2); x.fill();
    }
    // glowing embers
    x.shadowColor = "#ff4400"; x.shadowBlur = glow; x.fillStyle = "#ff4400";
    for (var e = 0; e < 5; e++) {
      var ea = Math.random()*Math.PI*2, er = R*(0.4+Math.random()*0.55);
      x.globalAlpha = 0.3+Math.random()*0.45;
      x.beginPath(); x.arc(Math.cos(ea)*er, Math.sin(ea)*er, 2+Math.random()*3, 0, Math.PI*2); x.fill();
    }
    return { c: c, half: half, dpr: dpr };
  }
  function pickMarkVariant() {
    // Grow the variant pool lazily so no single blast pays for all of them.
    if (markVariants.length < 6 && (!markVariants.length || Math.random() < 0.5)) markVariants.push(buildMarkVariant());
    return markVariants[Math.floor(Math.random()*markVariants.length)];
  }

  function createBlastMark(cx, cy) {
    var v = pickMarkVariant();
    if (!marksLayer) {
      marksLayer = document.createElement("div");
      marksLayer.setAttribute("data-cb-ui", "1");
      marksLayer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483644;";
      document.documentElement.appendChild(marksLayer);
      removeList.push(marksLayer);
    }
    // Page coordinates, clipped to the document so marks never grow the page.
    var docX = cx + scrollX0, docY = cy + scrollY0, half = v.half;
    var L = Math.max(0, docX - half), T = Math.max(0, docY - half);
    var Rr = Math.min(docW, docX + half), B = Math.min(docH, docY + half);
    var w = Math.floor(Rr - L), h = Math.floor(B - T);
    if (w < 4 || h < 4) return;
    var c = document.createElement("canvas");
    c.className = "__cb_mark";
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    c.style.cssText = "left:" + L.toFixed(1) + "px;top:" + T.toFixed(1) + "px;width:" + w + "px;height:" + h + "px;" +
                      "transform-origin:" + (docX - L).toFixed(1) + "px " + (docY - T).toFixed(1) + "px;";
    var x = c.getContext("2d");
    var ang = Math.random()*Math.PI*2, k = dpr / v.dpr;
    var cs = Math.cos(ang)*k, sn = Math.sin(ang)*k;
    x.setTransform(cs, sn, -sn, cs, (docX - L)*dpr, (docY - T)*dpr);
    x.drawImage(v.c, -half * v.dpr, -half * v.dpr);
    marksLayer.appendChild(c);
    marks.push({ el: c, born: clock, removeAt: 0 });
    var live = 0;
    for (var i = marks.length - 1; i >= 0; i--) {
      if (marks[i].removeAt) continue;
      if (++live > MAX_MARKS) fadeMark(marks[i], 1);
    }
  }
  function fadeMark(m, secs) {
    m.removeAt = clock + secs;
    m.el.style.setProperty("--cb-fade", secs + "s");
    m.el.classList.add("__cb_fading");
  }
  function updateMarks() {
    if (clock < marksCheckAt) return;
    marksCheckAt = clock + 0.5;
    for (var i = marks.length - 1; i >= 0; i--) {
      var m = marks[i];
      if (!m.removeAt) { if (clock - m.born >= MARK_TTL) fadeMark(m, MARK_FADE); }
      else if (clock >= m.removeAt) { removeNode(m.el); marks.splice(i, 1); }
    }
  }

  /* ── SOLDIER RAID MODULE ─────────────────────────────────────────────────── */
  function isGone(el) {
    return hiddenSet.has(el) || scattered.has(el) || stolenSet.has(el) || !!el.closest("[data-cb-hidden]");
  }

  // True only if the element actually shows something a soldier could carry.
  // Uses no innerText (which forces layout); blasted characters don't count.
  function hasVisibleContent(el, cs) {
    try {
      var tag = el.localName;
      if (tag === "img" || tag === "svg" || tag === "video" || tag === "canvas" || tag === "picture") return true;
      if (el.querySelector("img:not([data-cb-hidden]),svg:not([data-cb-hidden]),video:not([data-cb-hidden]),canvas:not([data-cb-hidden]),picture")) return true;
      if (tag === "input") {
        var ty = (el.getAttribute("type")||"").toLowerCase();
        if (ty === "submit" || ty === "button" || ty === "image") return true;
        return !!(el.value && el.value.trim());
      }
      cs = cs || getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      var n = visibleTextLength(el, 200);
      return n >= 1 && n <= 200 && parseFloat(cs.fontSize) >= 6;
    } catch(e) { return false; }
  }

  var DECOYS = ["📦","💰","⭐","🔑","💎","📱","🏆","🎁","🛡️","📜"];
  // Builds a synthetic loot item the soldier conjures when the page has nothing to steal.
  function makeDecoy() {
    var span = document.createElement("div");
    span.textContent = DECOYS[Math.floor(Math.random()*DECOYS.length)];
    span.setAttribute("data-cb-ui", "1");
    span.style.cssText = [
      "position:fixed;left:0;top:0;width:34px;height:34px;margin:0;",
      "font-size:28px;line-height:34px;text-align:center;",
      "pointer-events:none;z-index:2147483646;will-change:transform;",
      "filter:drop-shadow(0 2px 3px rgba(0,0,0,0.4));"
    ].join("");
    document.documentElement.appendChild(span);
    return { clone: span, w: 34, h: 34, decoy: true, ranges: null };
  }

  /* Loot candidates come from a pool that is rebuilt in small time slices
     during the read phase (≈1ms per frame), instead of scanning the whole page
     with getBoundingClientRect/getComputedStyle every time a soldier spawns.
     Pool entries are stored in page coordinates so scrolling doesn't stale them. */
  var LOOT_TAGS = { a:1, button:1, img:1, svg:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, input:1, select:1,
    textarea:1, li:1, td:1, th:1, code:1, pre:1, strong:1, em:1, b:1, i:1, label:1, p:1, span:1,
    figure:1, video:1, blockquote:1, dt:1, dd:1, summary:1, caption:1, small:1, mark:1, time:1,
    cite:1, q:1, div:1 };
  var NO_DESCEND = { svg:1, script:1, style:1, template:1, noscript:1, iframe:1, video:1, canvas:1,
    select:1, textarea:1, object:1, embed:1, head:1 };
  var lootPool = [], lootScan = null, lootPoolAt = -1, lootPoolScrollY = 0;

  function lootPoolStale() {
    return lootPoolAt < 0 || clock - lootPoolAt > 1.5 || Math.abs(scrollY0 - lootPoolScrollY) > viewH * 0.5;
  }
  function stepLootScan(budgetMs) {
    if (!document.body) return;
    if (!lootScan) {
      if (!lootPoolStale()) return;
      lootScan = { next: document.body.firstElementChild, items: [], sy: scrollY0 };
    }
    var t0 = performance.now(), n = 0, el = lootScan.next;
    while (el) {
      if ((++n & 31) === 0 && performance.now() - t0 > budgetMs) break;
      var skipKids = considerLoot(el, lootScan.items);
      el = nextElementInBody(el, skipKids);
    }
    lootScan.next = el;
    if (!el) {
      lootPool = lootScan.items;
      lootPoolAt = clock;
      lootPoolScrollY = lootScan.sy;
      lootScan = null;
    }
  }
  function nextElementInBody(el, skipKids) {
    if (!skipKids && el.firstElementChild) return el.firstElementChild;
    while (el && el !== document.body) {
      if (el.nextElementSibling) return el.nextElementSibling;
      el = el.parentElement;
    }
    return null;
  }
  // Adds el to the pool if it is a visible, carry-sized atom near the viewport.
  // Returns true when its subtree should be skipped.
  function considerLoot(el, items) {
    var tag = el.localName;
    if (hiddenSet.has(el)) return true;
    var skip = NO_DESCEND[tag] === 1;
    if (!LOOT_TAGS[tag] && el.getAttribute("role") !== "button") return skip;
    if (scattered.has(el) || stolenSet.has(el) || items.length >= 800) return skip;
    if (el.childElementCount > 6) return skip;          // prefer leaf-ish atoms
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width > 420 || r.height > 320) return skip;
    if (r.bottom < -viewH * 0.5 || r.top > viewH * 1.5 || r.right < 10 || r.left > viewW - 10) return skip;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1) return skip;
    if (!hasVisibleContent(el, cs)) return skip;
    items.push({ el: el, x: r.left + scrollX0, y: r.top + scrollY0, w: r.width, h: r.height });
    return skip;
  }

  // Picks a random target from the pool (no layout reads).
  function pickLoot() {
    var playBottom = viewH * PLAY_TOP_FRAC;
    var z = cannonZone();
    var pref = [];  // ideal: real atoms in the top play area
    var any  = [];  // fallback: any real visible element on screen
    for (var i = 0; i < lootPool.length; i++) {
      var it = lootPool[i], el = it.el;
      if (!el.isConnected || isGone(el)) continue;
      var left = it.x - scrollX0, top = it.y - scrollY0;
      if (top + it.h < 10 || top > viewH - 10 || left + it.w < 10 || left > viewW - 10) continue;
      var cx = left + it.w/2, cy = top + it.h/2;
      if (Math.hypot(cx - z.x, cy - z.y) < z.r + 20) continue; // unreachable behind the cannon
      var item = { el: el, cx: cx, cy: cy, w: it.w, h: it.h };
      if (cy <= playBottom && it.w <= 220 && it.h <= 120) pref.push(item);
      else any.push(item);
      if (pref.length + any.length > 200) break;
    }
    if (pref.length) return pref[Math.floor(Math.random()*pref.length)];
    if (any.length)  return any[Math.floor(Math.random()*any.length)];
    return null;
  }

  // Returns false when no target is known yet (pool still being built).
  function spawnSoldier(danger) {
    if (introActive) return true;
    var cap = danger ? DANGER_MAX_SOLDIERS : MAX_SOLDIERS;
    if (soldiers.length >= cap) return true;
    var loot = pickLoot();
    if (!loot && (lootScan || lootPoolStale())) return false;
    var tgX, tgY, lootEl = null, wantDecoy = false;
    if (loot) {
      tgX = loot.cx; tgY = loot.cy; lootEl = loot.el;
    } else {
      // Blank page — no real content. Soldier marches to a random spot and grabs a decoy.
      wantDecoy = true;
      tgX = viewW * (0.2 + Math.random()*0.6);
      tgY = viewH * (0.18 + Math.random()*0.42);
    }
    var sideMax = viewH * PLAY_TOP_FRAC;
    var sx, sy;
    if (danger) {
      // SWARM: pour in from every edge (the cannon zone still keeps them at bay).
      var dEdge = Math.floor(Math.random()*4);
      if      (dEdge === 0) { sx = Math.random()*viewW; sy = -34; }
      else if (dEdge === 1) { sx = -34;                 sy = Math.random()*viewH*0.95; }
      else if (dEdge === 2) { sx = viewW+34;            sy = Math.random()*viewH*0.95; }
      else                  { sx = Math.random()*viewW; sy = viewH+34; }
    } else {
      // Normal: only from the front — top edge, or upper part of the side edges.
      var edge = Math.floor(Math.random()*3);
      if      (edge === 0) { sx = tgX;      sy = -34; }
      else if (edge === 1) { sx = -34;      sy = -20 + Math.random()*(sideMax+20); }
      else                 { sx = viewW+34; sy = -20 + Math.random()*(sideMax+20); }
    }
    soldiers.push({
      state: "approach", x: sx, y: sy,
      tgX: tgX, tgY: tgY, lootEl: lootEl, wantDecoy: wantDecoy, tRect: null, targetBad: false,
      speed: (danger ? 82 : 64) + Math.random()*46, facing: 1, phase: Math.random()*6,
      grabTimer: 0, loot: null, taunt: null, tauntT: 0, retargetCd: 0.25,
      color: CAMO[Math.floor(Math.random()*CAMO.length)]
    });
    return true;
  }

  // Forbidden circle around the cannon (bottom-center) — soldiers never enter it.
  function cannonZone() {
    var r = Math.max(150, Math.min(viewW, viewH) * 0.30);
    return { x: viewW/2, y: viewH + 12, r: r };
  }

  function moveToward(s, tx, ty, dt) {
    var dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy) || 1;
    var step = s.speed * dt;
    if (d > step) { s.x += dx/d*step; s.y += dy/d*step; }
    else          { s.x = tx; s.y = ty; }
    var z = cannonZone();
    var zx = s.x - z.x, zy = s.y - z.y, zd = Math.hypot(zx, zy);
    if (zd < z.r) {
      if (zd < 0.001) { zx = 0; zy = -1; zd = 1; }
      s.x = z.x + zx/zd * z.r;
      s.y = z.y + zy/zd * z.r;
    }
    if (Math.abs(dx) > 1) s.facing = dx >= 0 ? 1 : -1;
    s.phase += s.speed * dt * 0.09;
    return d;
  }

  // Flee only through the top / left / right edges — never down past the cannon.
  function nearestEdgeExit(s) {
    var dl = s.x, dr = viewW - s.x, dtop = s.y;
    var m = Math.min(dl, dr, dtop);
    if (m === dtop) return { x: s.x,      y: -40 };
    if (m === dl)   return { x: -40,      y: Math.min(s.y, viewH*0.6) };
    return                 { x: viewW+40, y: Math.min(s.y, viewH*0.6) };
  }

  var TAUNTS = ["Yoink! 😝","Mine now! 🤣","Too slow! 🐌","Thanks! 😜","Bye-bye! 👋","Ha-ha! 🤪","Free stuff! 🤑","Easy! 😎","Can't catch me! 🏃","Sooo shiny! ✨"];
  function soldierTaunt(s) {
    s.taunt  = TAUNTS[Math.floor(Math.random()*TAUNTS.length)];
    s.tauntT = 2.4;
  }

  function retarget(s) {
    var np = pickLoot();
    if (np) { s.lootEl = np.el; s.tgX = np.cx; s.tgY = np.cy; s.tRect = null; s.targetBad = false; s.state = "approach"; return true; }
    return false;
  }

  // Uses the rect read for this soldier's target in the read phase.
  function soldierGrab(s) {
    if (s.wantDecoy) { s.loot = makeDecoy(); return; }
    var el = s.lootEl, rect = s.tRect;
    if (!el || !el.isConnected || isGone(el) || s.targetBad || !rect || rect.width < 5 || rect.height < 5) {
      if (!retarget(s)) s.loot = makeDecoy();
      return;
    }
    stolenSet.add(el);
    var c = cloneForFlight(el, 0, 0, rect.width, rect.height);
    hideEl(el);
    s.loot = { clone: c.el, w: rect.width, h: rect.height, ranges: c.ranges };
  }

  function positionLoot(s) {
    if (!s.loot) return;
    var x = s.x - s.loot.w/2, y = s.y - 46 - s.loot.h;
    // cheeky wobble while carried overhead
    s.loot.clone.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0) rotate(" +
      (Math.sin(clock*9 + s.phase)*7).toFixed(1) + "deg)";
  }

  function killSoldier(s) {
    if (s.state === "dead") return;
    for (var k = 0; k < 16; k++) {
      var a = Math.random()*Math.PI*2, spd = 50+Math.random()*150, rr = Math.random();
      var type, color, size, life;
      if (rr < 0.4)      { type="ember"; color=s.color;        size=1.5+Math.random()*2;  life=0.3+Math.random()*0.4; }
      else if (rr < 0.7) { type="spark"; color="#ffdd55";      size=0.8+Math.random()*1.2; life=0.15+Math.random()*0.2; }
      else               { type="ember"; color="#caa472";      size=1.5+Math.random()*1.5; life=0.25+Math.random()*0.35; }
      particles.push({ x:s.x, y:s.y-20, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-60,
        life:life, maxLife:life, size:size, color:color, type:type,
        rotation:0, rotSpeed:(Math.random()-0.5)*12 });
    }
    shockwaves.push({x:s.x,y:s.y-20,r:0,maxR:34,life:0.16,maxLife:0.16,w:2,color:"255,210,120"});
    if (s.loot && s.loot.clone) {
      // The carried loot drops and tumbles away. It keeps left/top 0 and stays
      // positioned by transform only (no layout change, so no layout shift).
      var lw = s.loot.w, lh = s.loot.h;
      var ccx = s.x, ccy = s.y - 46 - lh/2;
      flung.push({ el:s.loot.clone, ranges:s.loot.ranges, x:ccx, y:ccy, ox:lw/2, oy:lh/2,
        vx:(Math.random()-0.5)*180, vy:-150-Math.random()*100,
        rotation:0, rotSpeed:(Math.random()-0.5)*300, life:1.6+Math.random()*0.6, fade:0.4, fading:false });
      s.loot = null;
    }
    // Ragdoll death animation: pop up, get knocked back, topple and fade out.
    s.state    = "dead";
    s.deadTimer = 0;
    s.deadDur   = 1.2;
    s.dvx       = (s.facing > 0 ? -1 : 1) * (40 + Math.random()*50);
    s.dvy       = -160 - Math.random()*70;
    s.rot       = 0;
    s.rotSpeed  = (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random()*120);
    spawnFloater(s.x, s.y - 44, "+1 💥", "#ffd24a", 16);
    addScore(1);
  }

  function escapeSoldier(s) {
    // Soldier got away — loot stays stolen (original hidden); remove the carried clone.
    if (s.loot) { removeNode(s.loot.clone); dropRanges(s.loot.ranges); }
    s.loot = null;
    stolen++;
    var fx = Math.max(30, Math.min(viewW-30, s.x));
    var fy = Math.max(40, Math.min(viewH-40, s.y));
    spawnFloater(fx, fy, "😡 GOT AWAY!", "#ff5544", 16);
    renderHUD();
  }

  // READ phase: refresh target rects (so soldiers follow scrolling content)
  // and re-validate targets every 0.25s.
  function readSoldiers(dt) {
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i];
      if ((s.state !== "approach" && s.state !== "grab") || s.wantDecoy || !s.lootEl) { s.tRect = null; continue; }
      var el = s.lootEl;
      if (s.state === "approach") {
        s.retargetCd -= dt;
        if (s.retargetCd <= 0) {
          s.retargetCd = 0.25;
          s.targetBad = !el.isConnected || isGone(el) || !hasVisibleContent(el);
        }
        if (!el.isConnected || isGone(el)) { s.tRect = null; continue; }
      } else if (!el.isConnected) { s.tRect = null; continue; }
      var r = el.getBoundingClientRect();
      s.tRect = (r.width >= 2 && r.height >= 2) ? r : null;
    }
  }

  function updateSoldiers(dt) {
    updateDanger(dt);
    var danger = isDangerActive();
    var interval = danger ? DANGER_INTERVAL : SOLDIER_INTERVAL;
    var cap = danger ? DANGER_MAX_SOLDIERS : MAX_SOLDIERS;
    soldierTimer -= dt;
    if (soldierTimer <= 0) {
      soldierTimer = interval * (0.6 + Math.random()*0.6);
      var burst = danger ? (2 + Math.floor(Math.random()*3)) : NORMAL_BURST;
      for (var b = 0; b < burst && soldiers.length < cap; b++) {
        if (!spawnSoldier(danger)) { soldierTimer = 0.15; break; }   // targets not known yet — retry shortly
      }
    }
    for (var i = soldiers.length-1; i >= 0; i--) {
      var s = soldiers[i];
      if (s.tauntT > 0) s.tauntT -= dt;
      if (s.state === "dead") {
        s.deadTimer += dt;
        s.dvy += 560*dt;
        s.x += s.dvx*dt; s.y += s.dvy*dt;
        s.rot += s.rotSpeed*dt;
        s.rotSpeed *= 0.96;
        if (s.deadTimer >= s.deadDur) { soldiers.splice(i, 1); }
        continue;
      }
      if (s.state === "approach") {
        // If a blast removed/scattered our target while marching, retarget to a
        // real visible element (or retreat) — never walk to an empty spot.
        if (!s.wantDecoy && s.targetBad) {
          if (!retarget(s)) { var ex0 = nearestEdgeExit(s); s.exitX = ex0.x; s.exitY = ex0.y; s.state = "flee"; continue; }
        }
        if (s.tRect) { s.tgX = s.tRect.left + s.tRect.width/2; s.tgY = s.tRect.top + s.tRect.height/2; }
        var d = moveToward(s, s.tgX, s.tgY, dt);
        if (d < 10) { s.state = "grab"; s.grabTimer = 0.9; } // long enough for the victory dance
      } else if (s.state === "grab") {
        s.grabTimer -= dt;
        if (!s.loot) {
          soldierGrab(s);
          if (s.loot) soldierTaunt(s);   // cheeky speech bubble the moment it's grabbed
        }
        if (s.state === "grab" && s.grabTimer <= 0) {
          var ex = nearestEdgeExit(s);
          s.exitX = ex.x; s.exitY = ex.y; s.state = "flee";
        }
      } else if (s.state === "flee") {
        moveToward(s, s.exitX, s.exitY, dt);
        if (s.x < -36 || s.x > viewW+36 || s.y < -36 || s.y > viewH+36) {
          escapeSoldier(s);
          soldiers.splice(i, 1);
          continue;
        }
      }
      positionLoot(s);
    }
  }

  // Pulsing red box around any element a soldier is currently coming to steal.
  function renderLootTargets() {
    var pulse = 0.5 + 0.5*Math.sin(clock*7);
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i];
      if (s.state !== "approach" && s.state !== "grab") continue;
      var r = s.tRect;
      if (!r) continue;
      var x = r.left-4, y = r.top-4, w = r.width+8, h = r.height+8;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6,4]);
      ctx.lineDashOffset = -clock*22;
      ctx.strokeStyle = "rgba(255,70,55," + (0.55 + 0.4*pulse) + ")";
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      var c = 7;
      ctx.strokeStyle = "rgba(255,120,90," + (0.7 + 0.3*pulse) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y+c); ctx.lineTo(x, y); ctx.lineTo(x+c, y);
      ctx.moveTo(x+w-c, y); ctx.lineTo(x+w, y); ctx.lineTo(x+w, y+c);
      ctx.moveTo(x+w, y+h-c); ctx.lineTo(x+w, y+h); ctx.lineTo(x+w-c, y+h);
      ctx.moveTo(x+c, y+h); ctx.lineTo(x, y+h); ctx.lineTo(x, y+h-c);
      ctx.stroke();
      var label = s.state === "grab" ? "STEALING" : "TARGET";
      ctx.font = "700 9px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      var tw = ctx.measureText(label).width + 8;
      var ty = y-13 < 2 ? y+h+2 : y-13;
      ctx.fillStyle = "rgba(200,30,25,0.9)";
      roundRectPath(x, ty, tw, 12, 3); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x+4, ty+6.5);
      ctx.restore();
    }
  }

  // Draws a soldier centered so feet rest at (0,0); caller sets transform/facing.
  function drawSoldierBody(s, legSwing, armSwing, dead) {
    var skin = "#d2a877", boot = "#23291a", dark = "#2c3522";
    if (!dead) {
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.beginPath(); ctx.ellipse(0, 1, 11, 3, 0, 0, Math.PI*2); ctx.fill();
    }
    // ── legs (with boots) ──
    ctx.lineCap = "round";
    ctx.strokeStyle = dark; ctx.lineWidth = 4.2;
    var lx = -3 + legSwing, rx = 3 - legSwing;
    ctx.beginPath(); ctx.moveTo(-1.5,-13); ctx.lineTo(lx, -1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( 1.5,-13); ctx.lineTo(rx, -1); ctx.stroke();
    ctx.fillStyle = boot;
    roundRectPath(lx-3, -2, 6, 3, 1.2); ctx.fill();
    roundRectPath(rx-3, -2, 6, 3, 1.2); ctx.fill();
    // ── torso (camo) + tactical vest ──
    ctx.fillStyle = s.color;
    roundRectPath(-6.5, -29, 13, 17, 3.5); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.18)";          // vest panel
    roundRectPath(-5, -26, 10, 9, 2); ctx.fill();
    ctx.fillStyle = "#caa14a";                    // belt
    ctx.fillRect(-6.5, -14.5, 13, 2.4);
    // backpack
    ctx.fillStyle = "#3a3022";
    roundRectPath(-9.5, -26, 4.5, 11, 2); ctx.fill();
    // ── arms ──
    if (s.loot && !dead) {
      // both arms up holding loot
      ctx.strokeStyle = s.color; ctx.lineWidth = 3.6;
      ctx.beginPath(); ctx.moveTo(3,-25); ctx.lineTo(7,-35); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-3,-25); ctx.lineTo(-7,-35); ctx.stroke();
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(7,-35,1.8,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(-7,-35,1.8,0,Math.PI*2); ctx.fill();
    } else if (!dead) {
      // marching arm + slung rifle
      ctx.strokeStyle = s.color; ctx.lineWidth = 3.6;
      ctx.beginPath(); ctx.moveTo(2,-25); ctx.lineTo(7+armSwing*0.5,-18); ctx.stroke();
      ctx.strokeStyle = "#1c2026"; ctx.lineWidth = 2.6; // rifle
      ctx.beginPath(); ctx.moveTo(2,-23); ctx.lineTo(17,-27); ctx.stroke();
      ctx.fillStyle = "#1c2026";
      roundRectPath(13,-29,3,5,1); ctx.fill();        // muzzle/sight
    } else {
      // dead: limp dangling arms
      ctx.strokeStyle = s.color; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(3,-25); ctx.lineTo(12,-23); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-3,-25); ctx.lineTo(-12,-21); ctx.stroke();
    }
    // ── neck + head ──
    ctx.fillStyle = skin;
    ctx.fillRect(-1.6,-31,3.2,3);
    ctx.beginPath(); ctx.arc(0, -34, 4.6, 0, Math.PI*2); ctx.fill();
    if (dead) {
      ctx.strokeStyle = "#3a2a1a"; ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-2.8,-35.6); ctx.lineTo(-1.2,-34); ctx.moveTo(-1.2,-35.6); ctx.lineTo(-2.8,-34);
      ctx.moveTo(1.2,-35.6);  ctx.lineTo(2.8,-34);  ctx.moveTo(2.8,-35.6);  ctx.lineTo(1.2,-34);
      ctx.stroke();
    }
    // ── helmet (drawn last, unless knocked off when dead) ──
    if (!dead) {
      ctx.fillStyle = "#37432a";
      ctx.beginPath(); ctx.arc(0, -35, 5.4, Math.PI, 0); ctx.fill();
      ctx.fillRect(-6, -35.4, 12, 2);                 // brim
      ctx.fillStyle = "rgba(255,255,255,0.12)";       // highlight
      ctx.beginPath(); ctx.arc(-1.5, -37, 2, Math.PI, 0); ctx.fill();
    }
  }

  function renderSoldiers() {
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i], f = s.facing;

      // ── DEAD: physical ragdoll — pop up, spin, fall, fade ──
      if (s.state === "dead") {
        var p = s.deadTimer / s.deadDur;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p*p);
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rot * Math.PI/180);
        ctx.scale(f, 1);
        drawSoldierBody(s, 6, 0, true);
        ctx.restore();
        // knocked-off helmet arcs away on its own trajectory
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p);
        var hx = s.x + s.dvx*0.5*p*1.2;
        var hy = s.y - 34 - 120*p + 260*p*p;
        ctx.translate(hx, hy);
        ctx.rotate((s.rot*1.6) * Math.PI/180);
        ctx.fillStyle = "#37432a";
        ctx.beginPath(); ctx.arc(0,0,5.2,Math.PI,0); ctx.fill();
        ctx.fillRect(-6,-0.4,12,2);
        ctx.restore();
        continue;
      }

      var legSwing = Math.sin(s.phase) * 5;
      var armSwing = Math.cos(s.phase) * 4;
      var bob = Math.abs(Math.cos(s.phase)) * 1.4;
      var wiggle = 0;
      if (s.state === "grab") {
        // victory dance: excited hops + body wiggle while yanking the loot
        bob += Math.abs(Math.sin(clock*13 + s.phase)) * 6;
        wiggle = Math.sin(clock*17 + s.phase) * 0.14;
      } else if (s.state === "flee" && s.loot) {
        // gleeful skipping while running off with the goods
        bob += Math.abs(Math.sin(clock*11 + s.phase)) * 3;
      }
      ctx.save();
      ctx.translate(s.x, s.y - bob);
      if (wiggle) ctx.rotate(wiggle);
      ctx.scale(f, 1);
      drawSoldierBody(s, legSwing, armSwing, false);
      ctx.restore();
      renderTauntBubble(s);
    }
  }

  // Cheeky speech bubble that follows a soldier for a couple of seconds.
  function renderTauntBubble(s) {
    if (!s.taunt || s.tauntT <= 0) return;
    var a = Math.min(1, s.tauntT / 0.4);
    var pop = s.tauntT > 2.15 ? 1 + (2.4 - s.tauntT)*2 : 1;
    var bx = s.x + s.facing*30, by = s.y - 64 - (s.loot ? s.loot.h : 0);
    by = Math.max(20, by);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = "700 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    var tw = ctx.measureText(s.taunt).width;
    var w = tw + 14, h = 20;
    bx = Math.max(w/2 + 4, Math.min(viewW - w/2 - 4, bx));
    ctx.translate(bx, by); ctx.scale(pop, pop); ctx.translate(-bx, -by);
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.4;
    roundRectPath(bx - w/2, by - h/2, w, h, 9);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx - s.facing*6, by + h/2 - 1);
    ctx.lineTo(bx - s.facing*14, by + h/2 + 8);
    ctx.lineTo(bx - s.facing*1, by + h/2 - 1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(s.taunt, bx, by + 0.5);
    ctx.restore();
  }

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y,   x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x,   y+h, r);
    ctx.arcTo(x,   y+h, x,   y,   r);
    ctx.arcTo(x,   y,   x+w, y,   r);
    ctx.closePath();
  }

  /* ── GAME LOOP ───────────────────────────────────────────────────────────────
     1. READ   — every layout read of the frame (scroll, blast hit-tests and
                 measurements, soldier targets, a slice of the loot scan).
     2. WRITE  — DOM writes (blasted elements/text, barrel angle).
     3. SIMULATE + RENDER — physics and canvas drawing; DOM writes here are
                 transforms/new overlay nodes only, never followed by reads. */
  function readPhase(dt) {
    scrollX0 = window.scrollX;
    scrollY0 = window.scrollY;
    var de = document.documentElement;
    docW = Math.max(de.scrollWidth, viewW);
    docH = Math.max(de.scrollHeight, viewH);
    for (var j = 0; j < 2 && blastQueue.length; j++) blastResults.push(readBlast(blastQueue.shift()));
    readSoldiers(dt);
    if (!introActive) stepLootScan(blastResults.length ? 0.5 : 1.0);
  }

  function writePhase() {
    var results = blastResults;
    blastResults = [];
    for (var i = 0; i < results.length; i++) applyBlast(results[i]);
    writeBarrel();
  }

  // One frame of the game. An unexpected error on an unusual page is logged
  // once and the game keeps running instead of freezing.
  var loopErrorLogged = false;
  function gameLoop(ts) {
    if (!gameActive) return;
    animId = requestAnimationFrame(gameLoop);
    try {
      frame(ts);
    } catch (e) {
      if (!loopErrorLogged) { loopErrorLogged = true; console.error("[BlastBlastBlast]", e); }
    }
  }

  function frame(ts) {
    var dt = Math.max(0, Math.min((ts-lastTime)/1000, 0.05));
    lastTime = ts;
    clock += dt;
    readPhase(dt);
    applyAim();                 // barrel/trajectory once per frame (decoupled from pointermove)
    updateGunAutoFire(dt);      // hold-to-fire: stream bullets while pointer held in gun mode
    writePhase();
    applyShake(dt);
    ctx.clearRect(0, 0, viewW, viewH);
    updateBalls(dt);
    updateBullets(dt);
    updateBlood(dt);
    updateParticles(dt);
    updateDebris(dt);
    updateFlung(dt);
    updateSoldiers(dt);
    updateMarks();
    renderCraters();
    renderDebris();
    renderBlood();
    renderTrajectoryPreview();
    renderLootTargets();
    renderSoldiers();
    renderBalls();
    renderBullets();
    renderGunReticle();
    renderParticles();
    renderFloaters();
  }

  /* ── START ───────────────────────────────────────────────────────────────── */
  document.documentElement.appendChild(wrapper);
  removeList.push(wrapper);
  resizeCanvas();
  renderHUD();
  loadBest();
  maybeShowIntro();
  // Keys must reach the page, not an embedded frame that had focus.
  try {
    var ae = document.activeElement;
    if (ae && /^(iframe|frame|embed|object)$/.test(ae.localName)) ae.blur();
  } catch (e) {}
  animId = requestAnimationFrame(gameLoop);

  /* ── EVENTS ──────────────────────────────────────────────────────────────── */
  function onResize() { resizeCanvas(); }
  window.addEventListener("resize", onResize);
  function onEscKey(e){ if (e.key === "Escape" || e.keyCode === 27) destroy(); }
  window.addEventListener("keydown", onEscKey, true);

  // Pointer move only records the cursor; the aim math runs once per frame.
  function onGlobalMove(e) { mouseX = e.clientX; mouseY = e.clientY; }
  window.addEventListener("pointermove", onGlobalMove, true);

  // BOTH MODES: intercept clicks anywhere so the page never reacts; each click fires.
  function isOwnUI(e) { return e.target && e.target.closest && e.target.closest("[data-cb-ui]"); }
  function onFirePointerDown(e) {
    if (isOwnUI(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    beginFire(e.clientX, e.clientY);
  }
  function onFirePointerUp() { endFire(); }
  function onClickBlock(e) {
    if (isOwnUI(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }
  window.addEventListener("pointerdown", onFirePointerDown, true);
  window.addEventListener("pointerup",   onFirePointerUp, true);
  window.addEventListener("pointercancel", onFirePointerUp, true);
  window.addEventListener("blur",        onFirePointerUp, true);
  window.addEventListener("mousedown",  onClickBlock, true);
  window.addEventListener("click",      onClickBlock, true);
  window.addEventListener("contextmenu", onClickBlock, true);
  window.addEventListener("pagehide",   flushBest, true);

  /* ── TEARDOWN — restores the page completely ─────────────────────────────── */
  function destroy() {
    if (!gameActive) return;
    gameActive = false;
    gunHeld = false;
    if (animId) cancelAnimationFrame(animId);
    flushBest();
    clearTimeout(vigOffTimer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onEscKey, true);
    window.removeEventListener("pointermove", onGlobalMove, true);
    window.removeEventListener("pointerdown", onFirePointerDown, true);
    window.removeEventListener("pointerup",   onFirePointerUp, true);
    window.removeEventListener("pointercancel", onFirePointerUp, true);
    window.removeEventListener("blur",        onFirePointerUp, true);
    window.removeEventListener("mousedown",  onClickBlock, true);
    window.removeEventListener("click",      onClickBlock, true);
    window.removeEventListener("contextmenu", onClickBlock, true);
    window.removeEventListener("pagehide",   flushBest, true);
    restoreCursor();

    // Blasted text: drop the highlight (or undo the fallback spans).
    try { if (hl) CSS.highlights.delete(HL_NAME); } catch (e) {}
    hl = null;
    for (var c = fbCreated.length - 1; c >= 0; c--) removeNode(fbCreated[c]);
    fbOriginal.forEach(function (data, node) { node.data = data; });

    // Hidden / flung / shattered / stolen elements come back.
    for (var i = 0; i < hiddenList.length; i++) hiddenList[i].removeAttribute("data-cb-hidden");
    var left = document.querySelectorAll("[data-cb-hidden]");
    for (var l = 0; l < left.length; l++) left[l].removeAttribute("data-cb-hidden");

    // Our own nodes: flying clones, carried loot, marks, overlay, styles.
    for (var f = 0; f < flung.length; f++) removeNode(flung[f].el);
    for (var s = 0; s < soldiers.length; s++) if (soldiers[s].loot) removeNode(soldiers[s].loot.clone);
    for (var r = 0; r < removeList.length; r++) removeNode(removeList[r]);
    flung.length = soldiers.length = bullets.length = bloodDrops.length = debris.length = marks.length = 0;
    hiddenList.length = removeList.length = fbCreated.length = 0;
    fbOriginal.clear();
    lootPool = []; lootScan = null;

    window.__cannonBlastActive = false;
    delete window.__cannonBlastDestroy;
  }

  window.__cannonBlastDestroy = destroy;
}());

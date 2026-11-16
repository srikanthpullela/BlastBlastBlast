/* ============================================================================
 * CANNON BLAST — content.js  v5 (2026-06-24)
 * - Trajectory dots hidden when off-screen; arc passes through freely
 * - cbScattered flag prevents same chars from re-exploding
 * - BLAST_RADIUS=65, no root transform shake, ball never exits top
 * - Blast marks are permanent until cannon is removed
 * ========================================================================== */
(function () {
  "use strict";

  /* ── FRAME DETECTION ──────────────────────────────────────────────────────
     The game itself only runs in the TOP frame. Every sub-frame (ads, video
     embeds like YouTube / Dailymotion, etc.) instead runs a lightweight
     forwarder that relays pointer activity up to the top frame so aiming and
     firing keep working even while the cursor is hovering an iframe. */
  var IS_TOP = false;
  try { IS_TOP = (window.top === window.self); } catch (e) { IS_TOP = false; }

  if (!IS_TOP) {
    if (window.__cbFrameBridge) return;
    window.__cbFrameBridge = true;

    var cbActive = false;

    function cbPostUp(kind, x, y) {
      try { window.parent.postMessage({ __cbFrame: true, kind: kind, x: x, y: y }, "*"); } catch (e) {}
    }
    function cbChildOffset(src) {
      var ifr = document.getElementsByTagName("iframe");
      for (var i = 0; i < ifr.length; i++) {
        var w = null; try { w = ifr[i].contentWindow; } catch (e2) {}
        if (w && w === src) {
          var r = ifr[i].getBoundingClientRect();
          return { x: r.left + (ifr[i].clientLeft || 0), y: r.top + (ifr[i].clientTop || 0) };
        }
      }
      return null;
    }
    function cbBroadcastDown(msg) {
      var ifr = document.getElementsByTagName("iframe");
      for (var i = 0; i < ifr.length; i++) {
        try { ifr[i].contentWindow.postMessage(msg, "*"); } catch (e3) {}
      }
    }
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d) return;
      if (d.__cbControl) {            // activation state from above — relay further down
        cbActive = !!d.active;
        cbBroadcastDown(d);
        return;
      }
      if (d.__cbFrame) {             // a descendant's coords — translate to our space & bubble up
        if (d.kind === "escape") { try { window.parent.postMessage(d, "*"); } catch (e4) {} return; }
        var off = cbChildOffset(e.source);
        if (!off) return;
        cbPostUp(d.kind, d.x + off.x, d.y + off.y);
      }
    }, true);

    window.addEventListener("pointermove", function (e) {
      if (cbActive) cbPostUp("move", e.clientX, e.clientY);
    }, true);
    window.addEventListener("pointerdown", function (e) {
      if (!cbActive) return;
      e.preventDefault(); e.stopImmediatePropagation();
      cbPostUp("down", e.clientX, e.clientY);
    }, true);
    window.addEventListener("pointerup", function (e) {
      if (cbActive) cbPostUp("up", e.clientX, e.clientY);
    }, true);
    window.addEventListener("pointercancel", function (e) {
      if (cbActive) cbPostUp("up", e.clientX, e.clientY);
    }, true);
    window.addEventListener("keydown", function (e) {
      if (cbActive && (e.key === "Escape" || e.keyCode === 27)) {
        try { window.parent.postMessage({ __cbFrame: true, kind: "escape" }, "*"); } catch (e5) {}
      }
    }, true);
    function cbBlock(e) { if (cbActive) { e.preventDefault(); e.stopImmediatePropagation(); } }
    window.addEventListener("mousedown", cbBlock, true);
    window.addEventListener("click", cbBlock, true);
    window.addEventListener("contextmenu", cbBlock, true);
    return;
  }

  if (window.__cannonBlastActive) return;
  window.__cannonBlastActive = true;
  console.log("%c[Cannon Blast v15]%c toggles beside cannon · no blast flash · smoother frames · double raids · taunting looters", "color:#ff6600;font-weight:bold","color:gray");

  /* ── CONSTANTS ──────────────────────────────────────────────────────────── */
  var GRAVITY      = 150;    // px/s² — particles only
  var BALL_G       = 900;    // px/s² — ball arc curvature
  var MAX_POWER    = 800;    // px/s (legacy, ring only)
  var MAX_DRAG     = 180;    // px drag → full power (legacy)
  var BLAST_RADIUS = 45;     // px — tight, focused blast
  var BALL_R       = 15;     // px cannonball radius
  var MIN_TRAVEL   = 100;    // px before collision can trigger (legacy)
  var SHARD_G      = 95;     // px/s² gravity on flying chars
  var MIN_AIM_DIST = 60;     // px — cursor must be at least this far to fire

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var gameActive = true;
  var lastTime   = performance.now();
  var animId     = null;
  var balls      = [];
  var bullets    = [];        // straight-line gun bullets
  var bloodDrops = [];        // blood splatters that linger then fade
  var mode       = "cannon";  // "cannon" | "gun"
  var mouseX     = window.innerWidth/2;
  var mouseY     = window.innerHeight/2;
  var particles  = [];
  var shockwaves = [];
  var mFlashes   = [];
  var floaters   = [];        // floating score / taunt popups
  var craters    = [];
  var shards     = [];        // flying chars / image pieces
  var restoreList = [];       // {el, prop, value} — restored on destroy
  var removeList  = [];       // DOM nodes we appended — removed on destroy
  var aiming     = false;
  var aimAngle   = -Math.PI / 2.5;
  var aimPower   = 0;
  var targetX    = 0;        // exact landing point = cursor position
  var targetY    = 0;
  var hasAim     = false;

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
     After a stretch of continuous play a "danger mode" kicks in: a short
     warning countdown, then a surge of soldiers swarming in from every
     direction, then back to normal. Can also be forced on via a top toggle. */
  var DANGER_AFTER_MIN  = 120;   // min sec of normal play before auto warning
  var DANGER_AFTER_MAX  = 180;   // max sec — each cycle picks randomly in [min,max]
  var AUTO_DANGER       = false; // auto-trigger disabled — danger only via the toggle
  var DANGER_WARN       = 12;    // sec warning countdown before the surge
  var DANGER_DURATION   = 15;    // sec the surge lasts
  var DANGER_MAX_SOLDIERS = 24;  // soldier cap during the surge
  var DANGER_INTERVAL   = 0.42;  // base seconds between spawn bursts during surge
  var dangerState       = "normal"; // "normal" | "warning" | "active"
  var dangerTimer       = 0;     // counts down through warning / active phases
  var playTime          = 0;     // seconds of continuous normal play
  var dangerDelay       = 0;     // randomized 2–3 min wait for the current cycle
  var dangerForced      = false; // user toggle: keep the surge running
  function nextDangerDelay() { return DANGER_AFTER_MIN + Math.random()*(DANGER_AFTER_MAX - DANGER_AFTER_MIN); }
  dangerDelay = nextDangerDelay();
  var CAMO = ["#4a5d39","#556b2f","#5b6e3a","#46532f"];
  var PLAY_TOP_FRAC     = 0.72;  // soldiers only operate in the top 72% (cannon owns the bottom)
  var clock             = 0;     // animation clock (seconds) for pulsing highlights
  var score             = 0;     // soldiers blasted this session
  var stolen            = 0;     // loot carried off
  var best              = 0;     // all-time high (chrome.storage)

  /* ── DOM SCAFFOLD ───────────────────────────────────────────────────────── */
  var wrapper = document.createElement("div");
  wrapper.id = "__cannon_wrapper";
  wrapper.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;";
  var ctx = canvas.getContext("2d");

  var tankRect = null;
  function refreshTankRect() { try { tankRect = tank.getBoundingClientRect(); } catch (e) {} }
  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    refreshTankRect();
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

  /* ── BUTTON ANIMATION STYLES ───────────────────────────────────────────── */
  (function injectBtnStyles() {
    var s = document.createElement("style");
    s.id = "__cb_btn_styles";
    s.setAttribute("data-cb-ui","1");
    // Pulse animations only touch box-shadow — transform is free for smooth hover via JS
    s.textContent = [
      "@keyframes cbModePulse{0%,100%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 0 rgba(255,210,74,.7)}60%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 8px rgba(255,210,74,0)}}",
      "@keyframes cbGunPulse{0%,100%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 0 rgba(255,140,30,.8)}60%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 9px rgba(255,140,30,0)}}",
      "@keyframes cbDangerOff{0%,100%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 0 rgba(255,107,74,.5)}60%{box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 0 7px rgba(255,107,74,0)}}",
      "@keyframes cbDangerOn{0%,100%{box-shadow:0 6px 28px rgba(200,20,10,.7),0 0 0 0 rgba(255,50,20,1)}55%{box-shadow:0 6px 28px rgba(200,20,10,.7),0 0 0 14px rgba(255,50,20,0)}}",
    ].join("");
    document.documentElement.appendChild(s);
    removeList.push(s);
  }());

  /* ── WEAPON MODE TOGGLE (sits just left of the cannon) ──────────────────── */
  var modeBtn = document.createElement("button");
  modeBtn.id = "__cb_mode_btn";
  modeBtn.setAttribute("data-cb-ui", "1");
  modeBtn.style.cssText = [
    // use right: so no transform needed for positioning — hover transform is clean
    "position:fixed;bottom:54px;right:calc(50% + 82px);",
    "background:rgba(14,16,11,0.96);color:#ffd24a;",
    "border:2px solid rgba(255,210,74,0.85);border-radius:16px;",
    "padding:10px 16px;min-width:110px;",
    "font:700 14px system-ui,sans-serif;letter-spacing:.3px;",
    "cursor:pointer;z-index:2147483647;pointer-events:all;",
    "display:flex;flex-direction:column;align-items:center;gap:3px;",
    "box-shadow:0 4px 18px rgba(0,0,0,.5);white-space:nowrap;",
    "transition:transform .18s ease,filter .18s ease,border-color .2s,background .2s;",
    "animation:cbModePulse 2s ease-in-out infinite;",
  ].join("");

  // Button always shows what you'll switch TO (not current state)
  function renderModeBtn() {
    if (mode === "cannon") {
      // currently cannon → button offers Gun
      modeBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">🔫</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">GUN MODE</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap to switch</span>';
      modeBtn.style.animation = "cbModePulse 2s ease-in-out infinite";
      modeBtn.style.borderColor = "rgba(255,210,74,0.85)";
      modeBtn.style.color = "#ffd24a";
    } else {
      // currently gun → button offers Cannon
      modeBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">💣</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">CANNON</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap to switch</span>';
      modeBtn.style.animation = "cbGunPulse 1.4s ease-in-out infinite";
      modeBtn.style.borderColor = "rgba(255,140,30,0.9)";
      modeBtn.style.color = "#ff9a20";
    }
  }
  function setMode(m) {
    mode = m;
    renderModeBtn();
    aiming = false; hasAim = false; aimPower = 0;
    document.documentElement.style.cursor = (mode === "gun") ? "crosshair" : "";
    broadcastControl();
  }
  modeBtn.addEventListener("click", function(e) {
    e.preventDefault(); e.stopPropagation();
    setMode(mode === "cannon" ? "gun" : "cannon");
  });
  // Smooth hover via JS transform — doesn't conflict with box-shadow pulse animation
  modeBtn.addEventListener("mouseenter", function(){ modeBtn.style.transform = "translateY(-4px) scale(1.06)"; modeBtn.style.filter = "brightness(1.15)"; });
  modeBtn.addEventListener("mouseleave", function(){ modeBtn.style.transform = ""; modeBtn.style.filter = ""; });
  renderModeBtn();

  function fadeUI(btn){ /* buttons always visible beside cannon */ }
  fadeUI(modeBtn);

  /* ── DANGER MODE TOGGLE (sits just right of the cannon) ─────────────────── */
  var dangerBtn = document.createElement("button");
  dangerBtn.id = "__cb_danger_btn";
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
    "transition:transform .18s ease,filter .18s ease,background .2s,color .2s,border-color .2s;",
    "animation:cbDangerOff 2.5s ease-in-out infinite;",
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
      dangerBtn.style.animation = "cbDangerOn 0.9s ease-in-out infinite";
    } else {
      dangerBtn.innerHTML =
        '<span style="font-size:28px;line-height:1.1">⚠️</span>' +
        '<span style="font-size:13px;font-weight:800;letter-spacing:.5px">DANGER OFF</span>' +
        '<span style="font-size:10px;opacity:.6;font-weight:600">tap for swarm</span>';
      dangerBtn.style.background = "rgba(14,16,11,0.96)";
      dangerBtn.style.color = "#ff6b4a";
      dangerBtn.style.borderColor = "rgba(255,107,74,0.8)";
      dangerBtn.style.animation = "cbDangerOff 2.5s ease-in-out infinite";
    }
  }
  dangerBtn.addEventListener("click", function(e) {
    e.preventDefault(); e.stopPropagation();
    dangerForced = !dangerForced;
    if (dangerForced) {
      enterDanger();                 // user-triggered surge starts now
    } else {
      exitDanger();                  // stop now; auto-mode waits the full DANGER_AFTER again
    }
    renderDangerBtn();
  });
  renderDangerBtn();
  fadeUI(dangerBtn);

  /* ── ALERT BANNER + DANGER VIGNETTE (non-interactive overlays) ───────────── */
  var dangerVignette = document.createElement("div");
  dangerVignette.style.cssText = [
    "position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:0;",
    "transition:opacity .4s;box-shadow:inset 0 0 220px 60px rgba(200,20,10,0.55);"
  ].join("");

  var alertBanner = document.createElement("div");
  alertBanner.style.cssText = [
    "position:fixed;top:54px;left:50%;transform:translateX(-50%);",
    "display:none;flex-direction:column;align-items:center;gap:2px;",
    "padding:10px 22px;border-radius:14px;pointer-events:none;z-index:2147483647;",
    "background:rgba(120,10,6,0.92);border:1px solid rgba(255,120,90,0.8);",
    "box-shadow:0 6px 26px rgba(180,20,10,0.6);text-align:center;white-space:nowrap;",
    "font-family:system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);"
  ].join("");

  function showAlertBanner(title, sub) {
    alertBanner.innerHTML =
      '<span style="font:800 17px/1.1 system-ui,sans-serif;letter-spacing:.5px">' + title + '</span>' +
      '<span style="font:600 12px/1.2 system-ui,sans-serif;opacity:.9">' + sub + '</span>';
    alertBanner.style.display = "flex";
  }
  function hideAlertBanner() { alertBanner.style.display = "none"; }

  /* ── DANGER STATE MACHINE ───────────────────────────────────────────────── */
  function isDangerActive() { return dangerState === "active"; }

  function enterDanger() {
    dangerState = "active";
    dangerTimer = DANGER_DURATION;
    dangerVignette.style.opacity = "1";
    shakeScreen();
  }
  function exitDanger() {
    dangerState = "normal";
    playTime = 0;
    dangerTimer = 0;
    dangerDelay = nextDangerDelay();   // pick a fresh 2–3 min wait for the next cycle
    dangerVignette.style.opacity = "0";
    hideAlertBanner();
  }
  function updateDanger(dt) {
    if (dangerForced) {
      if (dangerState !== "active") enterDanger();
      var n = soldiers.length;
      showAlertBanner("🔥 DANGER SWARM", n + " hostiles incoming · blast them!");
      dangerVignette.style.opacity = (0.7 + 0.3*Math.abs(Math.sin(clock*4))).toFixed(2);
      return;
    }
    if (dangerState === "normal") {
      playTime += dt;
      dangerVignette.style.opacity = "0";
      hideAlertBanner();
      if (AUTO_DANGER && playTime >= dangerDelay) { dangerState = "warning"; dangerTimer = DANGER_WARN; shakeScreen(); }
    } else if (dangerState === "warning") {
      dangerTimer -= dt;
      showAlertBanner("⚠️ DANGER MODE INCOMING", "brace for the swarm — " + Math.ceil(dangerTimer) + "s");
      dangerVignette.style.opacity = (0.15 + 0.25*Math.abs(Math.sin(clock*6))).toFixed(2);
      if (dangerTimer <= 0) enterDanger();
    } else if (dangerState === "active") {
      dangerTimer -= dt;
      showAlertBanner("🔥 DANGER MODE — SURVIVE", "swarm clears in " + Math.ceil(Math.max(0,dangerTimer)) + "s");
      dangerVignette.style.opacity = (0.55 + 0.35*Math.abs(Math.sin(clock*5))).toFixed(2);
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
  wrapper.appendChild(hud);

  function renderHUD() {
    hud.innerHTML =
      '<span style="color:#ff6b4a">🎯 ' + score + '</span>' +
      '<span style="opacity:.35">|</span>' +
      '<span style="color:#ffd24a">🏆 ' + best + '</span>' +
      '<span style="opacity:.35">|</span>' +
      '<span style="color:#9ab37a">🪖 ' + stolen + '</span>';
  }

  function loadBest() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["cbBest"], function(r){
          if (r && typeof r.cbBest === "number") { best = r.cbBest; renderHUD(); }
        });
      }
    } catch(e){}
  }
  function saveBest() {
    try {
      if (chrome && chrome.storage && chrome.storage.local)
        chrome.storage.local.set({ cbBest: best });
    } catch(e){}
  }
  function addScore(n) {
    score += n;
    if (score > best) { best = score; saveBest(); }
    renderHUD();
  }

  document.documentElement.appendChild(wrapper);
  resizeCanvas();
  renderHUD();
  loadBest();
  maybeShowIntro();

  /* ── FIRST-LAUNCH INTRO (shown only once, ever) ──────────────────────────── */
  function maybeShowIntro() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["cbIntroSeen"], function(r){
          if (!r || !r.cbIntroSeen) showIntro();
        });
      } else { showIntro(); }
    } catch(e) { /* ignore */ }
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
      '<div style="position:fixed;bottom:120px;left:50%;transform:translateX(-50%);text-align:center;animation:cbWiggle 1s ease-in-out infinite">'+
        '<div style="background:#ffd24a;color:#111;font-weight:800;font-size:12px;padding:5px 10px;border-radius:9px;margin-bottom:4px">Switch 🔫 Gun &amp; ⚠️ Danger beside the cannon</div>'+
        '<div style="font-size:42px;line-height:1;color:#ffd24a;text-shadow:0 2px 8px rgba(0,0,0,.6)">↓</div>'+
      '</div>'+
      '<style>@keyframes cbWiggle{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}'+
      '@keyframes cbGlow{0%,100%{box-shadow:0 0 0 0 rgba(255,210,74,.9),0 4px 14px rgba(0,0,0,.4)}50%{box-shadow:0 0 0 8px rgba(255,210,74,0),0 4px 14px rgba(0,0,0,.4)}}</style>'+
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
    // Pull the toggles to full opacity + blinking glow so the arrow lands on
    // clearly visible buttons (they fade to .28 once the intro closes).
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
    var r = tankRect || tank.getBoundingClientRect();
    return { x: r.left + (70/140)*r.width, y: r.top + (38/85)*r.height };
  }
  function getMuzzle() {
    var p = getPivot(), r = tankRect || tank.getBoundingClientRect();
    var len = (62/140)*r.width;
    return { x: p.x + Math.cos(aimAngle)*len, y: p.y + Math.sin(aimAngle)*len };
  }

  /* ── AIMING ───────────────────────────────────────────────────────────────
     Firing is click-anywhere (handled by onFirePointerDown); the barrel + arc
     track the cursor every frame in applyAim(). The old drag-on-tank input was
     removed — the tank is just UI now (data-cb-ui), so clicking it never fires. */
  var dragStartX = 0, dragStartY = 0, dragMoved = false;
  var MIN_DRAG_PX = 12; // legacy, unused

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

  // Rotate the barrel to track the cursor even when NOT dragging
  function aimBarrelToward(mx, my) {
    var p = getPivot();
    var sol = solveLaunch(p.x, p.y, mx, my);
    aimAngle = Math.atan2(sol.vy, sol.vx);
    barrelG.setAttribute("transform", "rotate(" + (aimAngle * 180 / Math.PI) + " 70 38)");
  }

  // CANNON: aim the arc at an arbitrary point (cursor) — drives the live
  // trajectory preview so the user can click anywhere on the page to blast.
  function updateCannonAimTo(mx, my) {
    targetX = Math.max(6, Math.min(window.innerWidth  - 6, mx));
    targetY = Math.max(6, Math.min(window.innerHeight - 6, my));
    var p = getPivot();
    var sol = solveLaunch(p.x, p.y, targetX, targetY);
    aimAngle = Math.atan2(sol.vy, sol.vx);
    aimPower = Math.min(sol.dist / Math.hypot(window.innerWidth, window.innerHeight), 1);
    hasAim = sol.dist >= MIN_AIM_DIST;
    barrelG.setAttribute("transform", "rotate(" + (aimAngle * 180 / Math.PI) + " 70 38)");
  }

  // Unified "fire toward this point" used by both local clicks and iframe-forwarded clicks.
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
        var bx = s.x, by = s.y - 20;       // soldier body center
        if (segDist(bx, by, b.px, b.py, b.x, b.y) < 15) {
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
      if (b.life <= 0 || b.x < -40 || b.x > window.innerWidth+40 || b.y < -40 || b.y > window.innerHeight+40) {
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
      ctx.save();
      ctx.globalAlpha = alpha * 0.92;
      ctx.fillStyle = d.hue;
      ctx.beginPath();
      if (d.settled) {
        // settled splat: a flattened pool
        ctx.ellipse(d.x, d.y, d.r*1.4, d.r*0.85, 0, 0, Math.PI*2);
      } else {
        ctx.arc(d.x, d.y, d.r, 0, Math.PI*2);
      }
      ctx.fill();
      ctx.restore();
    }
  }

  function renderBullets() {
    for (var i = 0; i < bullets.length; i++) {
      var b = bullets[i];
      var tx = b.x - b.vx*0.016, ty = b.y - b.vy*0.016;  // tracer tail
      ctx.save();
      ctx.lineCap = "round";
      // dark outline so the tracer reads on bright backgrounds
      ctx.strokeStyle = "rgba(20,12,0,0.85)";
      ctx.lineWidth = 5.2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      // glowing core
      ctx.shadowColor = "rgba(255,180,40,1)"; ctx.shadowBlur = 8;
      ctx.strokeStyle = "rgba(255,150,30,0.95)";
      ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = "#fff6d8";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.shadowBlur = 0;
      // bright head with dark ring
      ctx.fillStyle = "#fff8e0";
      ctx.beginPath(); ctx.arc(b.x, b.y, 2.6, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = "rgba(20,12,0,0.85)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, 3.1, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }
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

  /* ── ELEMENT UNDER POINT ─────────────────────────────────────────────────── */
  function elementUnder(x, y) {
    var prev = wrapper.style.display;
    wrapper.style.display = "none";
    var el = document.elementFromPoint(x, y);
    wrapper.style.display = prev;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.closest && el.closest("#__cannon_wrapper")) return null;
    // Skip full-viewport overlays
    try {
      var cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "absolute") {
        var r = el.getBoundingClientRect();
        if (r.width > window.innerWidth*0.85 && r.height > window.innerHeight*0.85) return null;
      }
    } catch(e2) {}
    return el;
  }

  /* ── EXPLOSION ───────────────────────────────────────────────────────────── */
  // Heavy DOM destruction (scatter/shatter) is throttled to one blast per frame
  // via scatterQueue + processScatterQueue() in the game loop. This keeps rapid
  // clicking / many simultaneous landings in danger mode from piling multiple
  // synchronous DOM-scatter passes into a single frame (the millisecond freezes).
  var scatterQueue = [];
  function explodeAt(cx, cy) {
    spawnExplosionParticles(cx, cy);
    createBlastMark(cx, cy);
    shakeScreen();
    // Kill any soldiers caught in the blast (drops their loot as a falling shard)
    for (var si = soldiers.length-1; si >= 0; si--) {
      var sol = soldiers[si];
      if (Math.hypot(sol.x - cx, (sol.y-18) - cy) < SOLDIER_KILL_R) killSoldier(sol);
    }
    if (scatterQueue.length < 10) scatterQueue.push({ cx: cx, cy: cy });
  }

  function processScatterQueue() {
    if (!scatterQueue.length) return;
    // Spread the three heavy DOM passes of one blast across three frames —
    // a single frame never pays for scatter + shatter + text all at once,
    // which is what caused the millisecond freezes right after a blast.
    var b = scatterQueue[0];
    b.step = (b.step || 0) + 1;
    if      (b.step === 1) scatterElementsNearPoint(b.cx, b.cy); // buttons, icons, svg, bg-images
    else if (b.step === 2) shatterImagesNear(b.cx, b.cy);        // <img> → fragments
    else { scatterTextNearPoint(b.cx, b.cy); scatterQueue.shift(); } // text → chars, done
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
    // (full-screen white flash removed — it caused a jarring strobe on every blast)
    craters.push({ x:cx, y:cy, r:14+Math.random()*5, life:1.0, maxLife:1.0 });
  }

  /* ── PERMANENT BLAST MARK ────────────────────────────────────────────────── */
  var BLAST_MARK_TTL = 60000;  // ms before each blast mark fades away (≈1 min)
  var markTimers = [];
  function createBlastMark(cx, cy) {
    var R  = 22 + Math.random()*8;
    var sz = R*2 + 30;
    var hf = sz/2;

    var cracks = "", debris = "", embers = "";
    var nc = 6 + Math.floor(Math.random()*4);
    for (var i = 0; i < nc; i++) {
      var baseA = (i/nc)*Math.PI*2 + (Math.random()-0.5)*0.55;
      var len   = R*(0.8 + Math.random()*0.8);
      var x = hf, y = hf;
      var pts = "M"+x.toFixed(1)+","+y.toFixed(1);
      var segs = 2 + Math.floor(Math.random()*2);
      for (var s = 0; s < segs; s++) {
        var sa = baseA + (Math.random()-0.5)*0.28;
        var sl = (len/segs)*(0.65+Math.random()*0.5);
        x += Math.cos(sa)*sl; y += Math.sin(sa)*sl;
        pts += " L"+x.toFixed(1)+","+y.toFixed(1);
        if (Math.random() > 0.5) {
          var bx = x+Math.cos(sa+0.85)*sl*0.28, by = y+Math.sin(sa+0.85)*sl*0.28;
          cracks += '<path d="M'+x.toFixed(1)+','+y.toFixed(1)+' L'+bx.toFixed(1)+','+by.toFixed(1)+'" stroke="#080808" stroke-width="0.9" opacity="0.6"/>';
        }
      }
      cracks += '<path d="'+pts+'" stroke="#070707" stroke-width="'+(1+Math.random()*1.1).toFixed(1)+'" stroke-linecap="round" fill="none" opacity="0.88"/>';
    }
    for (var d = 0; d < 16; d++) {
      var da = Math.random()*Math.PI*2, dr = R*(0.5+Math.random()*0.75);
      var gr = Math.floor(15+Math.random()*45);
      debris += '<circle cx="'+(hf+Math.cos(da)*dr).toFixed(1)+'" cy="'+(hf+Math.sin(da)*dr).toFixed(1)+'" r="'+(0.8+Math.random()*2.2).toFixed(1)+'" fill="rgb('+gr+','+gr+','+gr+')" opacity="'+(0.45+Math.random()*0.5).toFixed(2)+'"/>';
    }
    for (var e = 0; e < 5; e++) {
      var ea = Math.random()*Math.PI*2, er = R*(0.4+Math.random()*0.55);
      embers += '<circle cx="'+(hf+Math.cos(ea)*er).toFixed(1)+'" cy="'+(hf+Math.sin(ea)*er).toFixed(1)+'" r="'+(2+Math.random()*3).toFixed(1)+'" fill="#ff4400" opacity="'+(0.3+Math.random()*0.45).toFixed(2)+'" filter="url(#__cbGlow)"/>';
    }

    var uid  = "__cbm"+Date.now()+"_"+Math.floor(Math.random()*9999);
    var seed = Math.floor(Math.random()*99);
    var svg  = [
      '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 '+sz+' '+sz+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">',
      '<defs>',
      '<radialGradient id="'+uid+'h" cx="50%" cy="50%" r="50%">',
      '<stop offset="0%" stop-color="#000000" stop-opacity="0.97"/>',
      '<stop offset="42%" stop-color="#0d0400" stop-opacity="0.86"/>',
      '<stop offset="74%" stop-color="#1a0800" stop-opacity="0.58"/>',
      '<stop offset="100%" stop-color="#000000" stop-opacity="0"/>',
      '</radialGradient>',
      '<radialGradient id="'+uid+'e" cx="50%" cy="50%" r="50%">',
      '<stop offset="0%" stop-color="#ff6600" stop-opacity="0.65"/>',
      '<stop offset="55%" stop-color="#ff2200" stop-opacity="0.22"/>',
      '<stop offset="100%" stop-color="#ff0000" stop-opacity="0"/>',
      '</radialGradient>',
      '<filter id="__cbGlow" x="-100%" y="-100%" width="300%" height="300%">',
      '<feGaussianBlur stdDeviation="2.5" result="b"/>',
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      '</filter>',
      '</defs>',
      '<circle cx="'+hf+'" cy="'+hf+'" r="'+(R*1.1).toFixed(1)+'" fill="none" stroke="#200a00" stroke-width="9" opacity="0.55"/>',
      '<circle cx="'+hf+'" cy="'+hf+'" r="'+(R*0.9).toFixed(1)+'" fill="url(#'+uid+'e)" filter="url(#__cbGlow)"/>',
      '<circle cx="'+hf+'" cy="'+hf+'" r="'+R.toFixed(1)+'" fill="url(#'+uid+'h)"/>',
      cracks, debris, embers,
      '</svg>'
    ].join("");

    var mark = document.createElement("div");
    mark.style.cssText = [
      "position:fixed;",
      "left:"+(cx-hf)+"px;top:"+(cy-hf)+"px;",
      "width:"+sz+"px;height:"+sz+"px;",
      "pointer-events:none;z-index:2147483644;",
      "transform:scale(0);opacity:1;",
      "transition:transform 0.2s cubic-bezier(0.15,1.5,0.4,1), opacity 10s linear;"
    ].join("");
    mark.innerHTML = svg;
    document.documentElement.appendChild(mark);
    removeList.push(mark);   // safety net: also removed when cannon is destroyed
    requestAnimationFrame(function() { mark.style.transform = "scale(1)"; });
    // After ~60s the mark slowly fades over 10s, then is removed — clearing the
    // area so the user can see what's underneath again.
    var fadeT = setTimeout(function(){ mark.style.opacity = "0"; }, BLAST_MARK_TTL);
    var killT = setTimeout(function(){ if (mark.parentNode) mark.parentNode.removeChild(mark); }, BLAST_MARK_TTL + 10000);
    markTimers.push(fadeT); markTimers.push(killT);
  }

  /* ── ELEMENT SCATTERING — fling whole UI atoms (buttons, icons, svg, bg-images) ── */
  function scatterElementsNearPoint(cx, cy) {
    // Sample points across the blast circle and collect whatever is actually there
    var samples = [[0, 0]];
    var ringDefs = [BLAST_RADIUS * 0.5, BLAST_RADIUS];
    for (var rd = 0; rd < ringDefs.length; rd++) {
      var rr = ringDefs[rd];
      for (var a = 0; a < 8; a++) {
        var ang = (a / 8) * Math.PI * 2;
        samples.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
      }
    }
    // Our overlay (wrapper + canvas) is pointer-events:none, so elementsFromPoint
    // already skips it — no need to toggle display (which forced a full reflow).
    var seen = [], candidates = [];
    for (var s = 0; s < samples.length; s++) {
      var sxp = cx + samples[s][0], syp = cy + samples[s][1];
      if (sxp < 0 || syp < 0 || sxp > window.innerWidth || syp > window.innerHeight) continue;
      var stack = document.elementsFromPoint(sxp, syp) || [];
      for (var k = 0; k < stack.length && k < 4; k++) { // only top few layers
        var el = stack[k];
        if (!el || seen.indexOf(el) !== -1) continue;
        seen.push(el);
        var atom = atomToFling(el, cx, cy);
        if (atom) candidates.push(atom);
      }
    }
    // All geometry was read above; now do the DOM writes in one batch (visibility:hidden
    // + position:fixed clones don't move other elements, so cached rects stay valid).
    for (var c = 0; c < candidates.length && c < 24; c++) flingElement(candidates[c].el, cx, cy, candidates[c].rect);
  }

  function atomToFling(el, cx, cy) {
    if (!el || el.nodeType !== 1) return null;
    // Climb out of SVG internals to the <svg> root
    if (el.ownerSVGElement) { el = el.ownerSVGElement; }
    var tag = el.tagName;
    if (["HTML","BODY","SCRIPT","STYLE","HEAD","MAIN","SECTION","ARTICLE","NAV","UL","OL"].indexOf(tag) !== -1) return null;
    if (el.closest && el.closest("#__cannon_wrapper")) return null;
    if (el.dataset && (el.dataset.cbScattered || el.dataset.cbDone)) return null;
    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return null;
    if (rect.width > 240 || rect.height > 180) return null;        // skip big containers
    var nx = Math.max(rect.left, Math.min(cx, rect.right));
    var ny = Math.max(rect.top,  Math.min(cy, rect.bottom));
    if (Math.hypot(nx - cx, ny - cy) > BLAST_RADIUS) return null;   // not actually in blast
    if (tag === "IMG") return null;                                // handled by shatter
    // Decide if this is a "visual atom" worth flinging whole
    var isGraphic = (tag==="SVG"||tag==="BUTTON"||tag==="INPUT"||tag==="SELECT"||
                     tag==="VIDEO"||tag==="CANVAS"||tag==="LABEL");
    var bg = "none";
    try { bg = getComputedStyle(el).backgroundImage; } catch(e) {}
    var hasBg = bg && bg !== "none";
    var role = el.getAttribute && el.getAttribute("role");
    var roleBtn = role === "button" || role === "img";
    var cls = (typeof el.className === "string") ? el.className : "";
    var iconish = /icon|btn|button|logo|avatar|badge|chip|pill|tag\b/i.test(cls);
    if (isGraphic || hasBg || roleBtn || iconish) return { el: el, rect: rect };
    return null;
  }

  function flingElement(el, cx, cy, rect) {
    if (el.dataset && (el.dataset.cbScattered || el.dataset.cbDone)) return;
    rect = rect || el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    if (el.dataset) el.dataset.cbScattered = "1";
    restoreList.push({ el: el, prop: "visibility", value: el.style.visibility });

    var clone = el.cloneNode(true);
    clone.removeAttribute("id");
    clone.style.position   = "fixed";
    clone.style.left       = rect.left + "px";
    clone.style.top        = rect.top  + "px";
    clone.style.width      = rect.width  + "px";
    clone.style.height     = rect.height + "px";
    clone.style.margin     = "0";
    clone.style.transform  = "none";
    clone.style.transition = "none";
    clone.style.pointerEvents = "none";
    clone.style.zIndex     = "2147483646";
    document.documentElement.appendChild(clone);
    removeList.push(clone);
    el.style.visibility = "hidden";

    var ecx = rect.left + rect.width/2, ecy = rect.top + rect.height/2;
    var ang = Math.atan2(ecy - cy, ecx - cx);
    var dist = Math.hypot(ecx - cx, ecy - cy);
    var force = (1 - Math.min(dist / BLAST_RADIUS, 1)) * 480 + 150 + Math.random()*120;
    shards.push({
      el: clone, x: ecx, y: ecy, ox: ecx, oy: ecy,
      vx: Math.cos(ang) * force + (Math.random()-0.5)*150,
      vy: Math.sin(ang) * force - 200 - Math.random()*170,
      rotation: 0, rotSpeed: (Math.random()-0.5)*420,
      life: 1.3 + Math.random()*0.9, fade: 0.4
    });
  }

  /* ── TEXT SCATTERING — Range API gives exact pixel position of every character ── */
  var TEXT_SKIP_TAGS = ["HTML","BODY","MAIN","SECTION","ARTICLE","NAV","HEADER","FOOTER",
                        "ASIDE","SCRIPT","STYLE","NOSCRIPT","TEXTAREA"];
  function scatterTextNearPoint(cx, cy) {
    // Only scan text inside elements actually under the blast — walking the whole
    // document's text nodes on every shot is what made blasting stutter.
    var samples = [[0, 0]];
    var rings = [BLAST_RADIUS * 0.5, BLAST_RADIUS, BLAST_RADIUS + 28];
    for (var rd = 0; rd < rings.length; rd++) {
      for (var a = 0; a < 8; a++) {
        var ang = (a / 8) * Math.PI * 2;
        samples.push([Math.cos(ang) * rings[rd], Math.sin(ang) * rings[rd]]);
      }
    }
    // Overlay is pointer-events:none, so elementsFromPoint already skips it.
    var roots = [];
    for (var s = 0; s < samples.length; s++) {
      var sxp = cx + samples[s][0], syp = cy + samples[s][1];
      if (sxp < 0 || syp < 0 || sxp > window.innerWidth || syp > window.innerHeight) continue;
      var stack = document.elementsFromPoint(sxp, syp) || [];
      for (var k = 0; k < stack.length && k < 4; k++) {
        var el = stack[k];
        if (!el || el.nodeType !== 1) continue;
        if (el.closest && el.closest("#__cannon_wrapper")) continue;
        if (TEXT_SKIP_TAGS.indexOf(el.tagName) !== -1) continue;
        if (roots.indexOf(el) === -1) roots.push(el);
      }
    }

    var nodes = [], seen = [];
    for (var ri = 0; ri < roots.length && nodes.length < 240; ri++) {
      var root = roots[ri];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var par = node.parentElement;
        if (!par || par.closest("#__cannon_wrapper")) continue;
        if (["SCRIPT","STYLE","NOSCRIPT","TEXTAREA"].indexOf(par.tagName) !== -1) continue;
        if (!(node.textContent || "").trim()) continue;
        if (seen.indexOf(node) !== -1) continue;
        seen.push(node); nodes.push(node);
        if (nodes.length >= 240) break;
      }
    }
    for (var ni = 0; ni < nodes.length; ni++) {
      processTextNode(nodes[ni], cx, cy);
    }
  }

  function processTextNode(textNode, cx, cy) {
    var text = textNode.textContent;
    if (!text.trim()) return;

    // Coarse check: bounding box of whole text node
    var coarseRange = document.createRange();
    coarseRange.selectNode(textNode);
    var bbox = coarseRange.getBoundingClientRect();
    if (!bbox || bbox.width < 1) return;
    var nx = Math.max(bbox.left, Math.min(cx, bbox.right));
    var ny = Math.max(bbox.top,  Math.min(cy, bbox.bottom));
    if (Math.hypot(nx - cx, ny - cy) > BLAST_RADIUS + 30) return;

    var parent = textNode.parentElement;
    if (!parent) return;
    // Skip text inside any already-scattered element (whole atom flung, or prior char blast)
    if (parent.closest("[data-cb-scattered]")) return;

    var cs         = getComputedStyle(parent);
    var fontSize   = cs.fontSize   || "14px";
    var fontFamily = cs.fontFamily || "system-ui,sans-serif";
    var fontWeight = cs.fontWeight || "400";
    var color      = cs.color      || "#000";

    // Fine pass: measure every character using Range — no measurer div needed
    var toFly = [];
    var inBlastIdx = {};
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      try {
        var cr = document.createRange();
        cr.setStart(textNode, i);
        cr.setEnd(textNode, i + 1);
        var rect = cr.getBoundingClientRect();
        if (!rect || rect.width < 0.5 || rect.height < 0.5) continue;
        var px = rect.left + rect.width  / 2;
        var py = rect.top  + rect.height / 2;
        if (Math.hypot(px - cx, py - cy) <= BLAST_RADIUS) {
          toFly.push({ idx: i, ch: ch, rect: rect, px: px, py: py });
          inBlastIdx[i] = true;
        }
      } catch(e) {}
    }

    if (!toFly.length) return;

    // Replace the text node with per-char spans:
    //   - chars in blast radius → visibility:hidden (flying div takes their place)
    //   - other chars           → visible, text unchanged
    var frag = document.createDocumentFragment();
    var allSpans = [];
    for (var ci = 0; ci < text.length; ci++) {
      var sp = document.createElement("span");
      sp.style.cssText = "display:inline;white-space:pre;";
      sp.textContent = (text[ci] === " ") ? "\u00A0" : text[ci];
      if (inBlastIdx[ci]) {
        sp.style.visibility = "hidden";
        sp.dataset.cbScattered = "1"; // won't scatter again in future shots
      }
      frag.appendChild(sp);
      allSpans.push(sp);
    }
    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(frag, textNode);
      restoreList.push({ type: "textnode", parent: parent, spans: allSpans, origText: text });
    }

    // Create a flying div for each in-blast character
    for (var fi = 0; fi < toFly.length; fi++) {
      var item = toFly[fi];
      var charEl = document.createElement("div");
      charEl.style.cssText = [
        "position:fixed;",
        "left:"+item.rect.left+"px;top:"+item.rect.top+"px;",
        "width:"+(item.rect.width||8)+"px;height:"+(item.rect.height||14)+"px;",
        "font-size:"+fontSize+";font-family:"+fontFamily+";font-weight:"+fontWeight+";",
        "color:"+color+";line-height:1;text-align:center;",
        "pointer-events:none;z-index:2147483646;",
        "white-space:pre;overflow:visible;"
      ].join("");
      charEl.textContent = item.ch;
      document.documentElement.appendChild(charEl);
      removeList.push(charEl);

      var dist  = Math.hypot(item.px - cx, item.py - cy);
      var force = (1 - Math.min(dist / BLAST_RADIUS, 1)) * 640 + Math.random() * 180;
      var ang   = Math.atan2(item.py - cy, item.px - cx);
      shards.push({
        el: charEl, x: item.px, y: item.py, ox: item.px, oy: item.py,
        vx: Math.cos(ang) * force + (Math.random()-0.5) * 200,
        vy: Math.sin(ang) * force - 260 - Math.random() * 250,
        rotation: 0, rotSpeed: (Math.random()-0.5) * 560,
        life: 1.2 + Math.random() * 1.0, fade: 0.35
      });
    }
  }

  /* ── IMAGE SHATTERING (4×4 grid) ────────────────────────────────────────── */
  function shatterImagesNear(cx, cy) {
    var imgs = document.querySelectorAll("img");
    var targets = [];
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.closest("#__cannon_wrapper")) continue;
      if (img.dataset && img.dataset.cbDone) continue;  // already shattered
      var rect = img.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      var nearX = Math.max(rect.left, Math.min(cx, rect.right));
      var nearY = Math.max(rect.top,  Math.min(cy, rect.bottom));
      if (Math.hypot(nearX-cx, nearY-cy) > BLAST_RADIUS) continue;
      targets.push({ img: img, rect: rect });
    }
    // Writes after all reads — keeps layout from thrashing between images.
    for (var t = 0; t < targets.length; t++) {
      targets[t].img.dataset.cbDone = "1";
      shatterImage(targets[t].img, targets[t].rect, cx, cy);
    }
  }

  function shatterImage(img, rect, cx, cy) {
    var G = 4, pw = rect.width/G, ph = rect.height/G;
    restoreList.push({ el: img, prop: "visibility", value: img.style.visibility });
    img.style.visibility = "hidden";
    for (var row = 0; row < G; row++) {
      for (var col = 0; col < G; col++) {
        var piece = document.createElement("div");
        var px = rect.left+col*pw, py = rect.top+row*ph;
        piece.style.cssText = [
          "position:fixed;left:"+px+"px;top:"+py+"px;",
          "width:"+pw+"px;height:"+ph+"px;",
          "background-image:url('"+img.src+"');",
          "background-size:"+rect.width+"px "+rect.height+"px;",
          "background-position:-"+(col*pw)+"px -"+(row*ph)+"px;",
          "background-repeat:no-repeat;",
          "pointer-events:none;z-index:2147483646;",
          "box-shadow:0 1px 4px rgba(0,0,0,0.5);"
        ].join("");
        document.documentElement.appendChild(piece);
        removeList.push(piece);
        var pcx=px+pw/2, pcy=py+ph/2;
        var dist=Math.hypot(pcx-cx,pcy-cy);
        var f=(1-Math.min(dist/BLAST_RADIUS,1))*560+Math.random()*140;
        var a=Math.atan2(pcy-cy,pcx-cx);
        shards.push({el:piece,x:pcx,y:pcy,ox:pcx,oy:pcy,
          vx:Math.cos(a)*f+(Math.random()-0.5)*160,
          vy:Math.sin(a)*f-210-Math.random()*200,
          rotation:0,rotSpeed:(Math.random()-0.5)*440,
          life:1.4+Math.random()*0.9,fade:0.3});
      }
    }
  }

  /* ── SHARD PHYSICS ───────────────────────────────────────────────────────── */
  var stoggle = false;
  function updateShards(dt) {
    if (!shards.length) return;
    var throttle = shards.length > 60;
    stoggle = !stoggle;
    var udt = throttle ? (stoggle ? 0 : dt*2) : dt;
    for (var i = shards.length-1; i >= 0; i--) {
      var s = shards[i];
      if (udt > 0) {
        s.vy += SHARD_G * udt;
        s.vx *= 0.997;
        s.x  += s.vx * udt;
        s.y  += s.vy * udt;
        s.rotation += s.rotSpeed * udt;
        s.life -= udt;
        s.el.style.transform = "translate("+(s.x-s.ox).toFixed(1)+"px,"+(s.y-s.oy).toFixed(1)+"px) rotate("+s.rotation.toFixed(1)+"deg)";
        if (s.life <= s.fade) {
          s.el.style.transition = "opacity 0.3s";
          s.el.style.opacity = "0";
        }
      }
      if (s.life <= 0) {
        if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
        shards.splice(i, 1);
      }
    }
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
      var c = craters[i], a = Math.min(c.life/c.maxLife,1)*0.42;
      var g = ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,c.r);
      g.addColorStop(0,"rgba(12,5,1,"+a+")");
      g.addColorStop(0.6,"rgba(30,12,3,"+(a*0.5)+")");
      g.addColorStop(1,"rgba(0,0,0,0)");
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(c.x,c.y,c.r,0,Math.PI*2); ctx.fill();
    }
  }

  function renderTrajectoryPreview() {
    if (mode !== "cannon" || !hasAim) return;
    var m = getMuzzle();
    var sol = solveLaunch(m.x, m.y, targetX, targetY);
    if (sol.dist < MIN_AIM_DIST) return;
    var x = m.x, y = m.y, vx = sol.vx, vy = sol.vy;
    var T = sol.T, dt = T / 46;  // ~46 dots along the arc
    ctx.save();
    // no per-dot shadowBlur — glowy shadows on 46 dots every frame cost more
    // than the entire rest of the render pass
    for (var step = 1; step <= 46; step++) {
      vy += BALL_G * dt;
      x  += vx * dt;
      y  += vy * dt;
      var t = step / 46;
      var onScreen = (x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight);
      if (onScreen) {
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
    renderPowerRing(m);
  }

  function renderPowerRing(m) {
    var p=getPivot(), R=64;
    var start=-Math.PI*0.75, end=start+Math.PI*1.5*aimPower;
    var col = aimPower<0.5 ? "rgb("+(Math.floor(70+aimPower*370))+",218,50)"
                           : "rgb(255,"+(Math.floor(218-(aimPower-0.5)*400))+",28)";
    ctx.save();
    ctx.lineWidth=6; ctx.lineCap="round";
    ctx.strokeStyle="rgba(255,255,255,0.1)";
    ctx.beginPath(); ctx.arc(p.x,p.y,R,start,start+Math.PI*1.5); ctx.stroke();
    ctx.strokeStyle=col; ctx.shadowColor=col; ctx.shadowBlur=14;
    ctx.beginPath(); ctx.arc(p.x,p.y,R,start,end); ctx.stroke();
    ctx.fillStyle=col; ctx.font="bold 13px system-ui,sans-serif";
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.shadowColor="rgba(0,0,0,0.9)"; ctx.shadowBlur=5;
    ctx.fillText(Math.round(aimPower*100)+"%", p.x, p.y-R-15);
    ctx.restore();
  }

  function renderBalls() {
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      // Fire trail
      for (var t2 = 0; t2 < b.trail.length; t2++) {
        var tt = t2/b.trail.length, tp = b.trail[t2];
        var rad = BALL_R*(0.22+tt*0.78), alpha = tt*0.65;
        var col2 = tt>0.75 ? "rgba(255,255,200,"+alpha+")" : tt>0.45 ? "rgba(255,165,25,"+alpha+")" : "rgba(255,70,0,"+(alpha*0.55)+")";
        ctx.beginPath(); ctx.fillStyle=col2; ctx.arc(tp.x,tp.y,rad,0,Math.PI*2); ctx.fill();
      }
      // Glowing ball
      ctx.save();
      ctx.shadowColor="rgba(255,100,0,1)"; ctx.shadowBlur=38;
      var g2 = ctx.createRadialGradient(b.x-BALL_R*0.3,b.y-BALL_R*0.3,1,b.x,b.y,BALL_R);
      g2.addColorStop(0,"#ffffff"); g2.addColorStop(0.28,"#ffdd00");
      g2.addColorStop(0.62,"#ff5500"); g2.addColorStop(1,"#8a1400");
      ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(b.x,b.y,BALL_R,0,Math.PI*2); ctx.fill();
      ctx.restore();
      // Spin spot
      var sx=b.x+Math.cos(b.spin)*BALL_R*0.38, sy=b.y+Math.sin(b.spin)*BALL_R*0.38;
      ctx.beginPath(); ctx.fillStyle="rgba(65,12,0,0.5)";
      ctx.arc(sx,sy,BALL_R*0.3,0,Math.PI*2); ctx.fill();
    }
  }

  function hexA(hex, a) {
    var n=parseInt(hex.slice(1),16);
    return "rgba("+((n>>16)&255)+","+(((n>>8)&255))+","+(n&255)+","+a+")";
  }

  function renderParticles() {
    for (var i=0; i<particles.length; i++) {
      var p=particles[i], t=Math.max(p.life/p.maxLife,0);
      ctx.save();
      if (p.type==="spark") {
        var spd2=Math.hypot(p.vx,p.vy), ang2=Math.atan2(p.vy,p.vx);
        var len=Math.min(spd2*0.02,13)+p.size;
        ctx.translate(p.x,p.y); ctx.rotate(ang2);
        ctx.fillStyle=hexA(p.color,t);
        ctx.fillRect(-len/2,-p.size/2,len,Math.max(p.size*0.55,1));
      } else if (p.type==="ember") {
        ctx.globalAlpha=t; ctx.fillStyle=p.color;
        ctx.shadowColor=p.color; ctx.shadowBlur=8;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.size*(0.45+t*0.55),0,Math.PI*2); ctx.fill();
      } else {
        ctx.globalAlpha=t*0.3;
        var gw=p.size*(1+(1-t)*0.6);
        var g3=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,gw);
        g3.addColorStop(0,"rgba(50,50,50,0.7)"); g3.addColorStop(1,"rgba(12,12,12,0)");
        ctx.fillStyle=g3; ctx.beginPath(); ctx.arc(p.x,p.y,gw,0,Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }
    for (var j=0; j<shockwaves.length; j++) {
      var sw=shockwaves[j], st=sw.life/sw.maxLife;
      ctx.save(); ctx.globalAlpha=st;
      ctx.lineWidth=sw.w*st; ctx.strokeStyle="rgba("+sw.color+","+st+")";
      ctx.beginPath(); ctx.arc(sw.x,sw.y,sw.r,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }
    for (var k=0; k<mFlashes.length; k++) {
      var mf=mFlashes[k], mt=mf.life/mf.maxLife;
      ctx.save(); ctx.globalAlpha=mt;
      var fr=14+(1-mt)*20;
      var gf=ctx.createRadialGradient(mf.x,mf.y,0,mf.x,mf.y,fr);
      gf.addColorStop(0,"rgba(255,255,215,1)"); gf.addColorStop(0.5,"rgba(255,155,15,0.8)"); gf.addColorStop(1,"rgba(255,55,0,0)");
      ctx.fillStyle=gf; ctx.beginPath(); ctx.arc(mf.x,mf.y,fr,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="rgba(255,205,90,"+mt+")"; ctx.lineWidth=2;
      for (var sp=0; sp<mf.sparks.length; sp++) {
        var spk=mf.sparks[sp];
        ctx.beginPath(); ctx.moveTo(mf.x,mf.y);
        ctx.lineTo(mf.x+Math.cos(spk.a)*spk.len, mf.y+Math.sin(spk.a)*spk.len); ctx.stroke();
      }
      ctx.restore();
    }
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
  // Intensity-based: shakeScreen() just bumps a magnitude that decays in the game
  // loop. Rapid blasts no longer stack overlapping setTimeout chains (which caused
  // the jittery, "shaking the screen" feel in danger mode).
  var shakeTimers = [];
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

  /* ── SOLDIER RAID MODULE ─────────────────────────────────────────────────── */
  // True only if the element actually shows something a soldier could carry.
  function hasVisibleContent(el) {
    try {
      var tag = el.tagName;
      if (tag === "IMG" || tag === "SVG" || tag === "svg" || tag === "VIDEO" ||
          tag === "CANVAS" || tag === "PICTURE") return true;
      if (el.querySelector && el.querySelector("img,svg,video,canvas,picture")) return true;
      if (tag === "INPUT") {
        var ty = (el.getAttribute("type")||"").toLowerCase();
        if (ty === "submit" || ty === "button" || ty === "image") return true;
        return !!(el.value && el.value.trim());
      }
      var cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      // innerText ignores visibility:hidden chars (blasted text), so a box whose
      // text was destroyed reads as empty — soldiers won't target an empty spot.
      var txt = ((el.innerText != null ? el.innerText : el.textContent) || "").replace(/\s+/g, " ").trim();
      if (txt.length >= 1 && txt.length <= 200) {
        // make sure that text is actually painted (not transparent/zero-size font)
        if (parseFloat(cs.fontSize) >= 6) return true;
      }
      return false;
    } catch(e) { return false; }
  }

  var DECOYS = ["📦","💰","⭐","🔑","💎","📱","🏆","🎁","🛡️","📜"];
  // Builds a synthetic loot item the soldier conjures when the page has nothing to steal.
  function makeDecoy() {
    var span = document.createElement("div");
    span.textContent = DECOYS[Math.floor(Math.random()*DECOYS.length)];
    span.style.cssText = [
      "position:fixed;left:0;top:0;width:34px;height:34px;margin:0;",
      "font-size:28px;line-height:34px;text-align:center;",
      "pointer-events:none;z-index:2147483646;will-change:left,top;",
      "filter:drop-shadow(0 2px 3px rgba(0,0,0,0.4));"
    ].join("");
    document.documentElement.appendChild(span);
    removeList.push(span);
    return { clone: span, w: 34, h: 34, decoy: true };
  }

  function pickLoot() {
    // Broad sweep: soldiers may grab nearly anything visible — links, images,
    // headings, list items, table cells, videos, figures, plain divs with text…
    var sel = "a,button,img,svg,h1,h2,h3,h4,h5,h6,input,select,textarea,li,td,th," +
              "[role=button],code,pre,strong,em,b,i,label,p,span,figure,video," +
              "blockquote,dt,dd,summary,caption,small,mark,time,cite,q,div";
    var all, i;
    try { all = document.body.querySelectorAll(sel); } catch(e){ return null; }
    var playBottom = window.innerHeight * PLAY_TOP_FRAC;
    var z = cannonZone();
    var pref = [];  // ideal: real atoms in the top play area
    var any  = [];  // fallback: any real visible element on the page (so we never decoy when content exists)
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest("#__cannon_wrapper")) continue;
      if (el.dataset && (el.dataset.cbScattered || el.dataset.cbStolen)) continue;
      if (el.children && el.children.length > 6) continue; // prefer leaf-ish atoms
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 420 || r.height > 320) continue;
      if (r.bottom < 10 || r.top > window.innerHeight-10 || r.right < 10 || r.left > window.innerWidth-10) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1) continue;
      if (!hasVisibleContent(el)) continue;              // skip empty wrappers / shadows / backgrounds
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      if (Math.hypot(cx - z.x, cy - z.y) < z.r + 20) continue; // unreachable behind the cannon
      var item = { el: el, cx: cx, cy: cy, w: r.width, h: r.height };
      if (cy <= playBottom && r.width <= 220 && r.height <= 120) pref.push(item);
      else any.push(item);
      if (pref.length + any.length > 200) break;
    }
    if (pref.length) return pref[Math.floor(Math.random()*pref.length)];
    if (any.length)  return any[Math.floor(Math.random()*any.length)];
    return null; // truly nothing on the page → caller falls back to a decoy
  }

  function spawnSoldier(danger) {
    if (introActive) return;          // no raids until the player starts
    var cap = danger ? DANGER_MAX_SOLDIERS : MAX_SOLDIERS;
    if (soldiers.length >= cap) return;
    var loot = pickLoot();
    var tgX, tgY, lootEl = null, wantDecoy = false;
    if (loot) {
      tgX = loot.cx; tgY = loot.cy; lootEl = loot.el;
    } else {
      // Blank page — no real content. Soldier marches to a random spot and grabs a decoy.
      wantDecoy = true;
      tgX = window.innerWidth  * (0.2 + Math.random()*0.6);
      tgY = window.innerHeight * (0.18 + Math.random()*0.42);
    }
    var sideMax = window.innerHeight * PLAY_TOP_FRAC; // how far down the side soldiers may enter
    var sx, sy;
    if (danger) {
      // SWARM: pour in from every edge (the cannon zone still keeps them at bay).
      var dEdge = Math.floor(Math.random()*4);
      if      (dEdge === 0) { sx = Math.random()*window.innerWidth;   sy = -34; }                    // top
      else if (dEdge === 1) { sx = -34;                  sy = Math.random()*window.innerHeight*0.95; } // left, full height
      else if (dEdge === 2) { sx = window.innerWidth+34; sy = Math.random()*window.innerHeight*0.95; } // right, full height
      else                  { sx = Math.random()*window.innerWidth;   sy = window.innerHeight+34; }    // bottom
    } else {
      // Normal: only from the front — top edge, or upper part of the side edges.
      var edge = Math.floor(Math.random()*3);
      if      (edge === 0) { sx = tgX;                   sy = -34; }                              // top
      else if (edge === 1) { sx = -34;                   sy = -20 + Math.random()*(sideMax+20); } // left (upper 70%)
      else                 { sx = window.innerWidth+34;  sy = -20 + Math.random()*(sideMax+20); } // right (upper 70%)
    }
    soldiers.push({
      state: "approach", x: sx, y: sy,
      tgX: tgX, tgY: tgY, lootEl: lootEl, wantDecoy: wantDecoy,
      speed: (danger ? 82 : 64) + Math.random()*46, facing: 1, phase: Math.random()*6,
      grabTimer: 0, loot: null, taunt: null, tauntT: 0,
      color: CAMO[Math.floor(Math.random()*CAMO.length)]
    });
  }

  // Forbidden circle around the cannon (bottom-center) — soldiers never enter it.
  function cannonZone() {
    var r = Math.max(150, Math.min(window.innerWidth, window.innerHeight) * 0.30);
    return { x: window.innerWidth/2, y: window.innerHeight + 12, r: r };
  }

  function moveToward(s, tx, ty, dt) {
    var dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy) || 1;
    var step = s.speed * dt;
    if (d > step) { s.x += dx/d*step; s.y += dy/d*step; }
    else          { s.x = tx; s.y = ty; }
    // Keep clear of the cannon: push back out to the zone boundary if breached.
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
    var dl = s.x, dr = window.innerWidth - s.x, dtop = s.y;
    var m = Math.min(dl, dr, dtop);
    if (m === dtop) return { x: s.x,                  y: -40 };
    if (m === dl)   return { x: -40,                  y: Math.min(s.y, window.innerHeight*0.6) };
    return                 { x: window.innerWidth+40,  y: Math.min(s.y, window.innerHeight*0.6) };
  }

  var TAUNTS = ["Yoink! 😝","Mine now! 🤣","Too slow! 🐌","Thanks! 😜","Bye-bye! 👋","Ha-ha! 🤪","Free stuff! 🤑","Easy! 😎","Can't catch me! 🏃","Sooo shiny! ✨"];
  function soldierTaunt(s) {
    s.taunt  = TAUNTS[Math.floor(Math.random()*TAUNTS.length)];
    s.tauntT = 2.4;
  }

  function soldierGrab(s) {
    var el = s.lootEl;
    var invalid = !el || !el.parentNode ||
        (el.dataset && (el.dataset.cbScattered || el.dataset.cbStolen)) ||
        !hasVisibleContent(el);
    // Decoy ONLY when this soldier was spawned on a blank page. Otherwise, if its
    // target vanished, retarget to another real element before conjuring a decoy.
    if (s.wantDecoy) { s.loot = makeDecoy(); return; }
    if (invalid) {
      var repl = pickLoot();
      if (repl) { el = s.lootEl = repl.el; }
      else { s.loot = makeDecoy(); return; }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) {
      var repl2 = pickLoot();
      if (repl2) { el = s.lootEl = repl2.el; rect = el.getBoundingClientRect(); }
      else { s.loot = makeDecoy(); return; }
    }
    if (el.dataset) el.dataset.cbStolen = "1";
    restoreList.push({ el: el, prop: "visibility", value: el.style.visibility });

    var clone = el.cloneNode(true);
    clone.removeAttribute("id");
    clone.style.position = "fixed";
    clone.style.left = "0px"; clone.style.top = "0px";
    clone.style.width = rect.width + "px";
    clone.style.height = rect.height + "px";
    clone.style.margin = "0";
    clone.style.transform = "none";
    clone.style.transition = "none";
    clone.style.pointerEvents = "none";
    clone.style.zIndex = "2147483646";
    clone.style.willChange = "left,top";
    document.documentElement.appendChild(clone);
    removeList.push(clone);
    el.style.visibility = "hidden";
    s.loot = { clone: clone, w: rect.width, h: rect.height };
  }

  function positionLoot(s) {
    if (!s.loot) return;
    var c = s.loot.clone;
    c.style.left = (s.x - s.loot.w/2).toFixed(1) + "px";
    c.style.top  = (s.y - 46 - s.loot.h).toFixed(1) + "px";
    // cheeky wobble while carried overhead
    c.style.transform = "rotate(" + (Math.sin(clock*9 + s.phase)*7).toFixed(1) + "deg)";
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
      var c = s.loot.clone;
      var lx = s.x - s.loot.w/2, ly = s.y - 46 - s.loot.h;
      c.style.left = lx + "px"; c.style.top = ly + "px";
      var ccx = lx + s.loot.w/2, ccy = ly + s.loot.h/2;
      shards.push({ el:c, x:ccx, y:ccy, ox:ccx, oy:ccy,
        vx:(Math.random()-0.5)*180, vy:-150-Math.random()*100,
        rotation:0, rotSpeed:(Math.random()-0.5)*300, life:1.6+Math.random()*0.6, fade:0.4 });
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
    if (s.loot && s.loot.clone && s.loot.clone.parentNode) {
      s.loot.clone.parentNode.removeChild(s.loot.clone);
    }
    s.loot = null;
    stolen++;
    var fx = Math.max(30, Math.min(window.innerWidth-30, s.x));
    var fy = Math.max(40, Math.min(window.innerHeight-40, s.y));
    spawnFloater(fx, fy, "😡 GOT AWAY!", "#ff5544", 16);
    renderHUD();
  }

  function updateSoldiers(dt) {
    updateDanger(dt);
    var danger = isDangerActive();
    var interval = danger ? DANGER_INTERVAL : SOLDIER_INTERVAL;
    var cap = danger ? DANGER_MAX_SOLDIERS : MAX_SOLDIERS;
    soldierTimer -= dt;
    if (soldierTimer <= 0) {
      soldierTimer = interval * (0.6 + Math.random()*0.6);
      // In danger mode spawn a burst from several directions at once.
      var burst = danger ? (2 + Math.floor(Math.random()*3)) : NORMAL_BURST; // normal: 2 at a time
      for (var b = 0; b < burst && soldiers.length < cap; b++) spawnSoldier(danger);
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
        if (!s.wantDecoy) {
          s.retargetCd = (s.retargetCd || 0) - dt;
          if (s.retargetCd <= 0) {
            s.retargetCd = 0.25;
            var le = s.lootEl;
            var bad = !le || !le.parentNode || (le.dataset && (le.dataset.cbScattered || le.dataset.cbStolen)) || !hasVisibleContent(le);
            if (bad) {
              var np = pickLoot();
              if (np) { s.lootEl = np.el; s.tgX = np.cx; s.tgY = np.cy; }
              else { s.exitX = nearestEdgeExit(s).x; s.exitY = nearestEdgeExit(s).y; s.state = "flee"; continue; }
            }
          }
        }
        var d = moveToward(s, s.tgX, s.tgY, dt);
        if (d < 10) { s.state = "grab"; s.grabTimer = 0.9; } // long enough for the victory dance
      } else if (s.state === "grab") {
        s.grabTimer -= dt;
        if (!s.loot) {
          soldierGrab(s);
          if (s.loot) soldierTaunt(s);   // cheeky speech bubble the moment it's grabbed
        }
        if (s.grabTimer <= 0) {
          var ex = nearestEdgeExit(s);
          s.exitX = ex.x; s.exitY = ex.y; s.state = "flee";
        }
      } else if (s.state === "flee") {
        moveToward(s, s.exitX, s.exitY, dt);
        if (s.x < -36 || s.x > window.innerWidth+36 || s.y < -36 || s.y > window.innerHeight+36) {
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
      var el = s.lootEl;
      if (!el || !el.parentNode) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var x = r.left-4, y = r.top-4, w = r.width+8, h = r.height+8;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6,4]);
      ctx.lineDashOffset = -clock*22;
      ctx.strokeStyle = "rgba(255,70,55," + (0.55 + 0.4*pulse) + ")";
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      // corner brackets
      var c = 7;
      ctx.strokeStyle = "rgba(255,120,90," + (0.7 + 0.3*pulse) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y+c); ctx.lineTo(x, y); ctx.lineTo(x+c, y);
      ctx.moveTo(x+w-c, y); ctx.lineTo(x+w, y); ctx.lineTo(x+w, y+c);
      ctx.moveTo(x+w, y+h-c); ctx.lineTo(x+w, y+h); ctx.lineTo(x+w-c, y+h);
      ctx.moveTo(x+c, y+h); ctx.lineTo(x, y+h); ctx.lineTo(x, y+h-c);
      ctx.stroke();
      // tiny tag
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
    // shadow (skip when dead/airborne)
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
    // eyes
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
        ctx.globalAlpha = Math.max(0, 1 - p*p);          // fade out toward the end
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rot * Math.PI/180);
        ctx.scale(f, 1);
        drawSoldierBody(s, 6, 0, true);
        ctx.restore();
        // knocked-off helmet arcs away on its own trajectory
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p);
        var hx = s.x + s.dvx*0.5*p*1.2;
        var hy = s.y - 34 - 120*p + 260*p*p;             // up then down
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
    var a = Math.min(1, s.tauntT / 0.4);          // quick fade at the end
    var pop = s.tauntT > 2.15 ? 1 + (2.4 - s.tauntT)*2 : 1; // pop-in scale
    var bx = s.x + s.facing*30, by = s.y - 64 - (s.loot ? s.loot.h : 0);
    by = Math.max(20, by);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = "700 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    var tw = ctx.measureText(s.taunt).width;
    var w = tw + 14, h = 20;
    bx = Math.max(w/2 + 4, Math.min(window.innerWidth - w/2 - 4, bx));
    ctx.translate(bx, by); ctx.scale(pop, pop); ctx.translate(-bx, -by);
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.4;
    roundRectPath(bx - w/2, by - h/2, w, h, 9);
    ctx.fill(); ctx.stroke();
    // little tail pointing at the soldier
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

  /* ── GAME LOOP ───────────────────────────────────────────────────────────── */
  function gameLoop(ts) {
    if (!gameActive) return;
    var dt = Math.min((ts-lastTime)/1000, 0.05);
    lastTime = ts;
    clock += dt;
    applyAim();                 // compute barrel/trajectory once per frame (decoupled from mousemove)
    updateGunAutoFire(dt);      // hold-to-fire: stream bullets while pointer held in gun mode
    processScatterQueue();      // at most one heavy DOM-scatter pass per frame
    applyShake(dt);             // decaying, non-stacking screen shake
    ctx.clearRect(0,0,window.innerWidth,window.innerHeight);
    updateBalls(dt);
    updateBullets(dt);
    updateBlood(dt);
    updateParticles(dt);
    updateShards(dt);
    updateSoldiers(dt);
    renderCraters();
    renderBlood();
    renderTrajectoryPreview();
    renderLootTargets();
    renderSoldiers();
    renderBalls();
    renderBullets();
    renderGunReticle();
    renderParticles();
    renderFloaters();
    animId = requestAnimationFrame(gameLoop);
  }
  animId = requestAnimationFrame(gameLoop);

  /* ── MISC EVENTS ─────────────────────────────────────────────────────────── */
  function onResize() { resizeCanvas(); }
  window.addEventListener("resize", onResize);
  function onEscKey(e){ if (e.key === "Escape" || e.keyCode === 27) destroy(); }
  window.addEventListener("keydown", onEscKey, true);
  document.addEventListener("keydown", onEscKey, true);

  // Pointer move only records the cursor; the actual aim math runs once per
  // frame in applyAim() so fast mouse movement can't thrash layout / jank.
  function onGlobalMove(e) { mouseX = e.clientX; mouseY = e.clientY; }
  window.addEventListener("pointermove", onGlobalMove, true);

  function applyAim() {
    if (mode === "cannon") updateCannonAimTo(mouseX, mouseY);
    else                   aimBarrelToward(mouseX, mouseY);
  }

  // BOTH MODES: intercept clicks anywhere so the page never reacts; each click fires.
  function isOwnUI(e) { return e.target && e.target.closest && e.target.closest("[data-cb-ui]"); }
  function onFirePointerDown(e) {
    if (isOwnUI(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    beginFire(e.clientX, e.clientY);
  }
  function onFirePointerUp(e) { endFire(); }
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

  /* ── IFRAME BRIDGE (top frame) ─────────────────────────────────────────────
     Receives pointer coords forwarded up from sub-frames (already translated
     into this frame's coordinate space, one hop per call) and feeds them into
     the game so aiming/firing work while the cursor is over an iframe. */
  function cbTopChildOffset(src) {
    var ifr = document.getElementsByTagName("iframe");
    for (var i = 0; i < ifr.length; i++) {
      var w = null; try { w = ifr[i].contentWindow; } catch (e2) {}
      if (w && w === src) {
        var r = ifr[i].getBoundingClientRect();
        return { x: r.left + (ifr[i].clientLeft || 0), y: r.top + (ifr[i].clientTop || 0) };
      }
    }
    return null;
  }
  function onFrameMessage(e) {
    var d = e.data;
    if (!d || !d.__cbFrame) return;
    if (d.kind === "escape") { destroy(); return; }
    var off = cbTopChildOffset(e.source);
    if (!off) return;
    var x = d.x + off.x, y = d.y + off.y;
    mouseX = x; mouseY = y;        // aim is applied once per frame in applyAim()
    if (d.kind === "down") beginFire(x, y);
    else if (d.kind === "up") endFire();
  }
  window.addEventListener("message", onFrameMessage, true);

  // Tell every sub-frame the game is active + which weapon mode is current.
  // Re-broadcast periodically so iframes that load late also get wired up.
  function broadcastControl() {
    var msg = { __cbControl: true, active: gameActive, mode: mode };
    var ifr = document.getElementsByTagName("iframe");
    for (var i = 0; i < ifr.length; i++) {
      try { ifr[i].contentWindow.postMessage(msg, "*"); } catch (e) {}
    }
  }
  var cbBroadcastTimer = setInterval(broadcastControl, 1000);
  broadcastControl();

  /* ── TEARDOWN ────────────────────────────────────────────────────────────── */
  function destroy() {
    if (!gameActive) return;
    gameActive = false;
    gunHeld = false;
    broadcastControl();                 // tell sub-frames to stop forwarding/blocking
    if (cbBroadcastTimer) clearInterval(cbBroadcastTimer);
    if (animId) cancelAnimationFrame(animId);
    soldiers.length = 0;
    bullets.length = 0;
    bloodDrops.length = 0;
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onEscKey, true);
    document.removeEventListener("keydown", onEscKey, true);
    window.removeEventListener("pointermove", onGlobalMove, true);
    window.removeEventListener("pointerdown", onFirePointerDown, true);
    window.removeEventListener("pointerup",   onFirePointerUp, true);
    window.removeEventListener("pointercancel", onFirePointerUp, true);
    window.removeEventListener("blur",        onFirePointerUp, true);
    window.removeEventListener("mousedown",  onClickBlock, true);
    window.removeEventListener("click",      onClickBlock, true);
    window.removeEventListener("contextmenu", onClickBlock, true);
    window.removeEventListener("message", onFrameMessage, true);
    document.documentElement.style.cursor = "";
    shakeTimers.forEach(function(t){ clearTimeout(t); });
    markTimers.forEach(function(t){ clearTimeout(t); });
    document.documentElement.style.transform = "";

    for (var i=0; i<restoreList.length; i++) {
      var entry = restoreList[i];
      try {
        if (entry.prop === "visibility") {
          entry.el.style.visibility = entry.value || "";
        } else if (entry.prop === "cbDone") {
          delete entry.el.dataset.cbDone;
        } else if (entry.type === "textnode") {
          // Restore: replace our per-char spans with the original text node
          var par2 = entry.parent;
          var firstSpan = entry.spans[0];
          if (firstSpan && firstSpan.parentNode === par2) {
            var restored = document.createTextNode(entry.origText);
            par2.insertBefore(restored, firstSpan);
            for (var si2 = 0; si2 < entry.spans.length; si2++) {
              try { par2.removeChild(entry.spans[si2]); } catch(e5){}
            }
          }
        }
      } catch(e2) {}
    }
    for (var j=0; j<removeList.length; j++) {
      try { if(removeList[j].parentNode) removeList[j].parentNode.removeChild(removeList[j]); } catch(e3){}
    }
    for (var k=0; k<shards.length; k++) {
      try { if(shards[k].el.parentNode) shards[k].el.parentNode.removeChild(shards[k].el); } catch(e4){}
    }
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    window.__cannonBlastActive = false;
    delete window.__cannonBlastDestroy;
  }

  window.__cannonBlastDestroy = destroy;
}());

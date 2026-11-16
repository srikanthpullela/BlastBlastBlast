/* ============================================================================
 * BlastBlastBlast — content.js
 * Injected on demand into the top frame of the active tab from the popup or
 * the keyboard shortcut (see launcher.js).
 *
 *  - Overlay: fixed full-viewport canvas, SVG tank, arsenal (Cannon, Gun,
 *    Rockets, Flamethrower, Laser, Cluster bomb; keys 1–6) and Danger toggle,
 *    HUD (score / best / stolen), raiding soldiers, enemy tanks and bombers.
 *  - Cannon BLAST_RADIUS is 45px. Blast marks are anchored to the page, so they
 *    scroll with it, and fade out after about 60s.
 *  - Blasted text is hidden with the CSS Custom Highlight API: page text is
 *    never rewritten, so nothing reflows. Flying characters, image fragments
 *    and particles are drawn on the overlay canvas.
 *  - Every frame does its layout reads first, then DOM writes, then canvas
 *    work, so the game never forces extra synchronous layouts.
 *  - Sounds are synthesized with Web Audio (no files); M or 🔊 mutes.
 *  - Esc / Remove restores the page completely, then shows a short blast
 *    report that closes by itself (or on Esc / any click).
 * ========================================================================== */
(function () {
  "use strict";

  // The game runs only in the top frame. While it runs, embedded frames are
  // made click-through (see the style sheet below) so aiming and firing also
  // work over iframes.
  if (window.top !== window) return;
  if (!(document.documentElement instanceof HTMLElement)) return;   // SVG / XML documents
  if (window.__cannonBlastActive) return;
  window.__cannonBlastActive = true;
  if (typeof window.__cbCloseReport === "function") window.__cbCloseReport(true);

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
  var mode       = "cannon";  // weapon id from WEAPONS
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

  /* ── ARSENAL ─────────────────────────────────────────────────────────────────
     Cannon and Gun are the classic weapons. The others unlock with lifetime
     score (kept on-device as cbTotalKills). Keys 1–6 pick a weapon. */
  var WEAPONS = [
    { id: "cannon",  icon: "💣", name: "CANNON",       unlock: 0  },
    { id: "gun",     icon: "🔫", name: "GUN",          unlock: 0  },
    { id: "rocket",  icon: "🚀", name: "ROCKETS",      unlock: 10 },
    { id: "flame",   icon: "🔥", name: "FLAMETHROWER", unlock: 25 },
    { id: "laser",   icon: "⚡", name: "LASER",        unlock: 50 },
    { id: "cluster", icon: "💥", name: "CLUSTER BOMB", unlock: 80 }
  ];
  var ROCKET_COOLDOWN  = 0.45;  // s between rockets (hold to keep firing)
  var CLUSTER_COOLDOWN = 0.8;   // s between cluster bombs
  var FLAME_RANGE      = 330;   // px the flame stream reaches
  var rockets    = [];
  var bomblets   = [];          // cluster sub-munitions
  var flames     = [];          // flamethrower particles
  var laserBeam  = null;        // { x0, y0, x1, y1 } while the laser fires
  var weaponCd   = 0;           // rocket / cluster cooldown
  var flameBurnT = 0;
  var laserCarveT = 0, lastCarve = null;
  var totalBase  = 0;           // lifetime score from earlier sessions
  var unlocksKnown = false;     // stored progress loaded (avoid announcing old unlocks)

  /* ── ENEMY VEHICLES ──────────────────────────────────────────────────────── */
  var enemies     = [];         // tanks and bombers
  var enemyShots  = [];         // tank shells (arcs) and bomber bombs (drops)
  var tankTimer   = 45;         // s until the first enemy tank
  var bomberTimer = 75;         // s until the first bomber

  /* ── COMBOS ──────────────────────────────────────────────────────────────── */
  var comboCount = 0, comboT = 0;
  var COMBO_WINDOW = 1.1;       // s between kills to keep a combo going

  // Layout values, refreshed once per frame in readPhase() (or on resize).
  var viewW    = window.innerWidth;
  var viewH    = window.innerHeight;
  var dpr      = window.devicePixelRatio || 1;
  var scrollX0 = window.scrollX;
  var scrollY0 = window.scrollY;
  // Scrollable document area and the marks layer origin, in viewport coordinates.
  var docMinX = 0, docMaxX = viewW, docMinY = 0, docMaxY = viewH;
  var layerX = 0, layerY = 0;
  var rtlRoot = false;
  try { rtlRoot = getComputedStyle(document.documentElement).direction === "rtl"; } catch (e) {}
  var mouseX   = viewW / 2;
  var mouseY   = viewH / 2;

  /* ── CONTINUOUS GUN FIRE ─────────────────────────────────────────────────────
     Holding the mouse down in gun mode auto-fires bullets at a steady rate
     (cannon stays single-shot per click since the arc is deliberately slow). */
  var GUN_FIRE_INTERVAL = 0.06; // sec between auto-fired bullets (~16/sec)
  var held              = false; // pointer is held down (gun, rockets, flame, laser keep firing)
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
  var score             = 0;     // points this session
  var stolen            = 0;     // loot carried off
  var best              = 0;     // all-time high (chrome.storage)
  var bestBefore        = 0;     // stored best when this game started

  // How the game was launched (set by launcher.js just before injecting).
  var launchInfo = window.__cbLaunch || {};
  try { delete window.__cbLaunch; } catch (e) {}

  // Numbers for the end-of-game blast report.
  var stats = { firstShotAt: 0, shots: 0, hits: 0, soldiers: 0, tanks: 0, bombers: 0,
                letters: 0, pieces: 0, bestCombo: 0, used: {}, unlocked: [] };
  // Each cannonball, bullet, rocket or cluster bomb counts as one shot; it hits
  // if it takes down (or damages) an enemy. Flamethrower and laser don't count.
  function newShot() { stats.shots++; return { hit: false }; }
  function markHit(shot) { if (shot && !shot.hit) { shot.hit = true; stats.hits++; } }

  /* ── SOUND ───────────────────────────────────────────────────────────────────
     Every sound is synthesized with Web Audio: no audio files, no network. The
     audio context is created when the game starts, before it is on screen:
     the first one in a browser session can block for ~150 ms while Chrome
     starts its audio service, which would freeze the first shot. It starts
     playing on the first click or key press (browsers require a user
     gesture), which doesn't block. One-shot sounds are rate-limited per kind and capped
     (MAX_VOICES) so rapid fire and Danger mode stay light; the flamethrower,
     laser and bomber engines are single looping voices. M or 🔊 mutes, and the
     choice is remembered on this device (cbMuted). */
  var sfx = (function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = null, out = null, noise = null;
    var muted = false, voices = 0, lastAt = {}, loops = {}, resumeAt = -1e9;
    var VOLUME = 0.6, MAX_VOICES = 14, HARD_CAP = 20;
    // Minimum seconds between two sounds of the same kind.
    var GAP = { gun: 0.04, boom: 0.06, blast: 0.045, hit: 0.03, tink: 0.06, shatter: 0.1, rocket: 0.08,
                whistle: 0.12, zap: 0.15, escape: 0.3, alert: 0.4, siren: 1, chime: 0.1, ui: 0.03 };
    // These still play when MAX_VOICES are busy (up to HARD_CAP).
    var IMPORTANT = { blast: 1, boom: 1, chime: 1, alert: 1, siren: 1, ui: 1 };
    var NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093];

    // Builds the context and the master chain. Without a click on the page yet, it starts suspended.
    function create() {
      if (ac) return true;
      if (!AC) return false;
      try { ac = new AC({ latencyHint: "interactive" }); } catch (e) { AC = null; return false; }
      try {
        var comp = ac.createDynamicsCompressor();
        comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 5;
        comp.attack.value = 0.003; comp.release.value = 0.2;
        out = ac.createGain();
        out.gain.value = VOLUME;
        out.connect(comp);
        comp.connect(ac.destination);
        noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);   // 1 s of white noise, looped with random offsets
        var d = noise.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) {
        var bad = ac;
        ac = null; AC = null;
        bad.close()["catch"](function () {});
        return false;
      }
      return true;
    }
    // On a click or key press: let the sound play.
    function start() {
      if (muted || !create()) return;
      if (ac.state === "suspended") {
        resumeAt = performance.now();
        ac.resume()["catch"](function () {});
      }
    }
    // Sounds scheduled while a resume we just asked for is starting up play as soon as it has.
    function live() {
      if (muted || !ac) return false;
      return ac.state === "running" || (ac.state === "suspended" && performance.now() - resumeAt < 300);
    }
    function pan(x) { return x == null ? 0 : Math.max(-0.75, Math.min(0.75, (x / viewW) * 1.5 - 0.75)); }

    // A voice: its sources → one gain → stereo pan → master. Freed when its last source ends.
    function voice(x) {
      var g = ac.createGain(), v = { g: g, nodes: [g], pending: 0 };
      if (ac.createStereoPanner && x != null) {
        var p = ac.createStereoPanner();
        p.pan.value = pan(x);
        g.connect(p); p.connect(out); v.nodes.push(p);
      } else {
        g.connect(out);
      }
      voices++;
      return v;
    }
    function run(v, src, t0, t1, offset) {
      v.nodes.push(src);
      v.pending++;
      src.onended = function () {
        if (--v.pending > 0) return;
        voices--;
        for (var i = 0; i < v.nodes.length; i++) { try { v.nodes[i].disconnect(); } catch (e) {} }
      };
      src.start(t0, offset || 0);
      src.stop(t1);
    }
    function envelope(param, t, peak, attack, decay) {
      param.setValueAtTime(0.0001, t);
      param.exponentialRampToValueAtTime(peak, t + attack);
      param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    // Filtered noise burst whose filter sweeps from f0 to f1.
    function hiss(v, t, type, f0, f1, q, peak, attack, decay) {
      var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noise; s.loop = true;
      f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
      envelope(g.gain, t, peak, attack, decay);
      s.connect(f); f.connect(g); g.connect(v.g);
      v.nodes.push(f, g);
      run(v, s, t, t + attack + decay + 0.02, Math.random() * 0.9);
    }
    // Oscillator whose pitch glides from f0 to f1.
    function tone(v, t, type, f0, f1, peak, attack, decay) {
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
      envelope(g.gain, t, peak, attack, decay);
      o.connect(g); g.connect(v.g);
      v.nodes.push(g);
      run(v, o, t, t + attack + decay + 0.02);
    }

    var SOUNDS = {
      // Cannon / cluster / tank fire: a deep thump with a puff of air. k = size.
      boom: function (v, t, k) {
        tone(v, t, "sine", 160, 42, Math.min(1, 0.85 * k), 0.004, 0.3);
        hiss(v, t, "lowpass", 1500, 260, 0.7, Math.min(0.9, 0.5 * k), 0.003, 0.22);
      },
      // Explosion; k from 0.5 (bomblet) to 1.8 (vehicle).
      blast: function (v, t, k) {
        var d = 0.32 + 0.42 * k;
        hiss(v, t, "lowpass", 700 + 800 * Math.min(k, 1.5), 90, 0.8, Math.min(1, 0.5 + 0.35 * k), 0.005, d);
        tone(v, t, "sine", 92, 30, Math.min(1, 0.45 + 0.35 * k), 0.005, 0.22 + 0.22 * k);
        if (k >= 1.3) hiss(v, t + 0.06, "bandpass", 420, 120, 0.9, 0.45, 0.02, d);   // rumbling tail
      },
      gun: function (v, t) {
        hiss(v, t, "highpass", 1900, 700, 0.7, 0.42, 0.001, 0.07);
        tone(v, t, "square", 900, 120, 0.1, 0.001, 0.045);
      },
      rocket: function (v, t) {
        hiss(v, t, "bandpass", 320, 2600, 1.6, 0.55, 0.03, 0.42);
        tone(v, t, "sawtooth", 110, 55, 0.1, 0.01, 0.3);
      },
      zap: function (v, t) { tone(v, t, "sine", 1700, 420, 0.12, 0.003, 0.13); },
      // A soldier goes down.
      hit: function (v, t) {
        hiss(v, t, "lowpass", 700, 200, 0.8, 0.45, 0.002, 0.09);
        tone(v, t, "triangle", 260, 110, 0.2, 0.005, 0.14);
      },
      // Bullet on armour.
      tink: function (v, t) {
        tone(v, t, "square", 2200 + Math.random() * 500, 1700, 0.06, 0.001, 0.05);
        hiss(v, t, "highpass", 3200, 2600, 0.8, 0.12, 0.001, 0.04);
      },
      // An image or video breaking apart.
      shatter: function (v, t) {
        hiss(v, t, "highpass", 2600, 1700, 0.6, 0.3, 0.002, 0.28);
        for (var i = 0; i < 3; i++) {
          var f = 2200 + Math.random() * 2600;
          tone(v, t + i * 0.035, "sine", f, f * 0.8, 0.05, 0.002, 0.12);
        }
      },
      // Falling bomb / incoming shell; k = seconds until impact.
      whistle: function (v, t, k) { tone(v, t, "sine", 1500, 420, 0.06, 0.06, Math.max(0.3, k)); },
      // A soldier got away with the loot.
      escape: function (v, t) {
        tone(v, t, "triangle", 392, 370, 0.12, 0.01, 0.16);
        tone(v, t + 0.17, "triangle", 330, 262, 0.12, 0.01, 0.3);
      },
      // Enemy vehicle incoming.
      alert: function (v, t) {
        tone(v, t, "square", 880, 880, 0.06, 0.005, 0.09);
        tone(v, t + 0.16, "square", 880, 880, 0.06, 0.005, 0.09);
      },
      siren: function (v, t) {
        for (var i = 0; i < 3; i++) {
          tone(v, t + i * 0.36, "sawtooth", 620, 900, 0.06, 0.02, 0.16);
          tone(v, t + i * 0.36 + 0.18, "sawtooth", 900, 620, 0.06, 0.02, 0.16);
        }
      },
      // Rising notes: combos (k = combo size), unlocks, the blast report.
      chime: function (v, t, k) {
        for (var i = 0; i < k; i++) {
          var f = NOTES[Math.min(i, NOTES.length - 1)];
          tone(v, t + i * 0.07, "triangle", f, f, 0.14, 0.005, 0.2);
        }
      },
      ui: function (v, t) { tone(v, t, "sine", 1100, 700, 0.06, 0.002, 0.05); }
    };

    function play(name, x, k) {
      if (!live()) return;
      var t = ac.currentTime;
      if (t - (lastAt[name] || -1) < (GAP[name] || 0)) return;
      if (voices >= HARD_CAP || (voices >= MAX_VOICES && !IMPORTANT[name])) return;
      lastAt[name] = t;
      try { SOUNDS[name](voice(x), t, k == null ? 1 : k); } catch (e) {}
    }

    // Continuous sounds. Each returns { g, level, p?, srcs, nodes }.
    var LOOPS = {
      flame: function () {
        var s = ac.createBufferSource(), f = ac.createBiquadFilter(), body = ac.createBiquadFilter();
        var g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
        s.buffer = noise; s.loop = true;
        f.type = "lowpass"; f.frequency.value = 1100; f.Q.value = 0.6;
        body.type = "peaking"; body.frequency.value = 280; body.gain.value = 9; body.Q.value = 1;
        g.gain.value = 0;
        lfo.frequency.value = 7; lg.gain.value = 0.07;      // flicker
        lfo.connect(lg); lg.connect(g.gain);
        s.connect(f); f.connect(body); body.connect(g); g.connect(out);
        s.start(0, Math.random() * 0.9); lfo.start();
        return { g: g, level: 0.4, srcs: [s, lfo], nodes: [s, f, body, g, lfo, lg] };
      },
      laser: function () {
        var o1 = ac.createOscillator(), o2 = ac.createOscillator(), vib = ac.createOscillator();
        var vg = ac.createGain(), f = ac.createBiquadFilter(), g = ac.createGain();
        o1.type = "sawtooth"; o1.frequency.value = 196;
        o2.type = "square"; o2.frequency.value = 393;
        vib.frequency.value = 11; vg.gain.value = 9;         // wobble
        vib.connect(vg); vg.connect(o1.frequency); vg.connect(o2.frequency);
        f.type = "lowpass"; f.frequency.value = 2400; f.Q.value = 7;
        g.gain.value = 0;
        o1.connect(f); o2.connect(f); f.connect(g); g.connect(out);
        o1.start(); o2.start(); vib.start();
        return { g: g, level: 0.09, srcs: [o1, o2, vib], nodes: [o1, o2, vib, vg, f, g] };
      },
      bomber: function () {
        var o1 = ac.createOscillator(), o2 = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
        o1.type = o2.type = "sawtooth";
        o1.frequency.value = 58; o2.frequency.value = 61.5;   // two engines beating
        f.type = "lowpass"; f.frequency.value = 380;
        g.gain.value = 0;
        o1.connect(f); o2.connect(f); f.connect(g);
        var L = { g: g, level: 0.12, srcs: [o1, o2], nodes: [o1, o2, f, g] };
        if (ac.createStereoPanner) { L.p = ac.createStereoPanner(); g.connect(L.p); L.p.connect(out); L.nodes.push(L.p); }
        else g.connect(out);
        o1.start(); o2.start();
        return L;
      }
    };
    // Starts or stops a continuous sound; x pans it.
    function loop(name, on, x) {
      var L = loops[name];
      if (on && live()) {
        if (!L) {
          try { L = loops[name] = LOOPS[name](); } catch (e) { return; }
          L.g.gain.setTargetAtTime(L.level, ac.currentTime, 0.03);
        }
        if (L.p && x != null) L.p.pan.setTargetAtTime(pan(x), ac.currentTime, 0.1);
      } else if (L) {
        stopLoop(name);
      }
    }
    function stopLoop(name) {
      var L = loops[name];
      if (!L) return;
      delete loops[name];
      try {
        var t = ac.currentTime;
        L.g.gain.cancelScheduledValues(t);
        L.g.gain.setTargetAtTime(0, t, 0.04);
        for (var i = 0; i < L.srcs.length; i++) L.srcs[i].stop(t + 0.25);
        L.srcs[0].onended = function () {
          for (var j = 0; j < L.nodes.length; j++) { try { L.nodes[j].disconnect(); } catch (e) {} }
        };
      } catch (e) {}
    }
    function stopLoops() { for (var k in loops) stopLoop(k); }

    function setMuted(m) {
      muted = !!m;
      if (muted) stopLoops();
      if (out && ac) out.gain.setTargetAtTime(muted ? 0 : VOLUME, ac.currentTime, 0.02);
      // While muted, pause the context (after the fade) so it uses no CPU; start() resumes it.
      if (muted) setTimeout(function () {
        if (muted && ac && ac.state === "running") ac.suspend()["catch"](function () {});
      }, 120);
    }
    // Ends all sound; the context closes once the last notes have rung out.
    function shutdown(afterMs) {
      stopLoops();
      var a = ac;
      ac = null;
      if (a) setTimeout(function () { a.close()["catch"](function () {}); }, afterMs || 0);
    }

    return { create: create, start: start, play: play, loop: loop, setMuted: setMuted,
             muted: function () { return muted; }, shutdown: shutdown };
  }());

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
    ".__cb_mark{position:absolute;pointer-events:none;animation:cbMarkIn .2s ease-out;max-width:none!important;max-height:none!important;" +
      "min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;box-sizing:content-box!important}",
    ".__cb_mark.__cb_fading{opacity:0;transition:opacity var(--cb-fade,10s) linear}",
    // Arsenal panel (left of the cannon). `all:unset` keeps page button styles out.
    "#__cb_arsenal{position:fixed;bottom:50px;right:calc(50% + 82px);z-index:2147483647;pointer-events:all;" +
      "display:flex;flex-direction:column;align-items:center;gap:5px;padding:7px 8px 8px;" +
      "background:rgba(14,16,11,.96);border:2px solid rgba(255,210,74,.85);border-radius:16px;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.5);color:#ffd24a;font:800 11px/1.1 system-ui,sans-serif;" +
      "letter-spacing:.4px;white-space:nowrap;user-select:none;-webkit-user-select:none;transition:transform .18s ease,filter .18s ease}",
    "#__cb_arsenal:hover{transform:translateY(-3px);filter:brightness(1.1)}",
    "#__cb_arsenal .__cb_grid{display:grid;grid-template-columns:repeat(3,36px);gap:5px}",
    "#__cb_arsenal .__cb_chip{all:unset;box-sizing:border-box;position:relative;display:flex;align-items:center;" +
      "justify-content:center;width:36px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.16);" +
      "background:rgba(255,255,255,.06);font:19px/1 system-ui,'Apple Color Emoji','Segoe UI Emoji',sans-serif;" +
      "cursor:pointer;transition:transform .12s ease,background .15s,border-color .15s}",
    "#__cb_arsenal .__cb_chip:hover{transform:translateY(-2px) scale(1.07);background:rgba(255,255,255,.14)}",
    "#__cb_arsenal .__cb_chip.__cb_on{border:2px solid #ffd24a;background:rgba(255,210,74,.22)}",
    "#__cb_arsenal .__cb_chip.__cb_on::before{content:'';position:absolute;inset:-4px;border-radius:12px;" +
      "border:2px solid rgba(255,210,74,.75);pointer-events:none;will-change:transform,opacity;animation:cbRing 1.6s ease-out infinite}",
    "#__cb_arsenal .__cb_chip.__cb_locked{opacity:.42;cursor:not-allowed;filter:grayscale(.7)}",
    "#__cb_arsenal .__cb_k{position:absolute;left:3px;top:2px;font:700 8px/1 system-ui,sans-serif;color:#fff;opacity:.55}",
    "#__cb_arsenal .__cb_lock{display:none;position:absolute;right:-4px;bottom:-5px;font-size:11px}",
    "#__cb_arsenal .__cb_chip.__cb_locked .__cb_lock{display:block}",
    "#__cb_arsenal .__cb_chip.__cb_new{animation:cbChipNew .6s ease-out 3}",
    "@keyframes cbChipNew{0%,100%{transform:scale(1)}40%{transform:scale(1.35)}}"
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

  /* ── ARSENAL (weapon picker, sits just left of the cannon) ───────────────── */
  var arsenal = document.createElement("div");
  arsenal.id = "__cb_arsenal";
  arsenal.setAttribute("data-cb-ui", "1");
  var arsenalLabel = document.createElement("div");
  arsenal.appendChild(arsenalLabel);
  var chipGrid = document.createElement("div");
  chipGrid.className = "__cb_grid";
  arsenal.appendChild(chipGrid);
  var chips = WEAPONS.map(function (w, i) {
    var b = document.createElement("button");
    b.className = "__cb_chip";
    b.setAttribute("data-weapon", w.id);
    b.setAttribute("data-cb-ui", "1");
    b.innerHTML = '<span class="__cb_k">' + (i + 1) + '</span>' + w.icon + '<span class="__cb_lock">🔒</span>';
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      selectWeapon(w.id);
    });
    chipGrid.appendChild(b);
    return b;
  });

  function weaponById(id) {
    for (var i = 0; i < WEAPONS.length; i++) if (WEAPONS[i].id === id) return WEAPONS[i];
    return null;
  }
  function totalScore() { return totalBase + score; }
  function isUnlocked(w) { return totalScore() >= w.unlock; }

  function renderArsenal() {
    var cur = weaponById(mode);
    setText(arsenalLabel, cur.icon + " " + cur.name);
    for (var i = 0; i < chips.length; i++) {
      var w = WEAPONS[i], c = chips[i], open = isUnlocked(w);
      c.classList.toggle("__cb_on", w.id === mode);
      c.classList.toggle("__cb_locked", !open);
      var title = w.name + " · key " + (i + 1) + (open ? "" : " · unlocks at " + w.unlock + " points");
      if (c.title !== title) c.title = title;
    }
  }

  // Gun-style weapons show a crosshair cursor; remember the page's own inline cursor.
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
  function isLobbed(m) { return m === "cannon" || m === "cluster"; }
  function selectWeapon(id) {
    var w = weaponById(id);
    if (!w || id === mode) return;
    if (!isUnlocked(w)) {
      spawnFloater(viewW / 2 - 170, viewH - 175, "🔒 " + w.name + ": " + (w.unlock - totalScore()) + " more points", "#ffd24a", 14);
      return;
    }
    mode = id;
    held = false;
    hasAim = false; aimPower = 0;
    laserBeam = null; lastCarve = null;
    renderArsenal();
    if (isLobbed(mode)) restoreCursor();
    else htmlStyle.setProperty("cursor", "crosshair");
    sfx.start();
    sfx.play("ui");
  }
  // G / Shift+G: next / previous unlocked weapon.
  function cycleWeapon(dir) {
    var i = WEAPONS.indexOf(weaponById(mode)), n = WEAPONS.length;
    for (var step = 1; step < n; step++) {
      var w = WEAPONS[(i + dir * step + n * 2) % n];
      if (isUnlocked(w)) { selectWeapon(w.id); return; }
    }
  }
  renderArsenal();

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
  function toggleDanger() {
    sfx.start();
    dangerForced = !dangerForced;
    if (dangerForced) enterDanger();   // user-triggered surge starts now
    else exitDanger();                 // stop now
    renderDangerBtn();
  }
  dangerBtn.addEventListener("click", function(e) {
    e.preventDefault(); e.stopPropagation();
    toggleDanger();
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
    tankTimer = Math.min(tankTimer, 3);       // the swarm brings vehicles right away
    bomberTimer = Math.min(bomberTimer, 7);
    setVignette(dangerForced ? "forced" : "active");
    shakeScreen();
    sfx.play("siren");
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
  wrapper.appendChild(arsenal);
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
  hudSpan("opacity:.35").textContent = "|";
  // Sound on/off (M). The HUD ignores the pointer; only this button takes clicks.
  var muteBtn = document.createElement("button");
  muteBtn.setAttribute("data-cb-ui", "1");
  muteBtn.style.cssText = "all:unset;pointer-events:auto;cursor:pointer;margin:-4px -6px -4px -6px;padding:3px 6px;" +
    "border-radius:10px;font:15px/1 system-ui,'Apple Color Emoji','Segoe UI Emoji',sans-serif;";
  muteBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggleMute(); });
  hud.appendChild(muteBtn);
  wrapper.appendChild(hud);

  function renderHUD() {
    setText(hudScore, "🎯 " + score);
    setText(hudBest, "🏆 " + best);
    setText(hudStolen, "🪖 " + stolen);
  }
  function renderMute() {
    var m = sfx.muted();
    setText(muteBtn, m ? "🔇" : "🔊");
    muteBtn.title = (m ? "Sound off" : "Sound on") + " · press M";
    muteBtn.setAttribute("aria-label", m ? "Turn sound on" : "Turn sound off");
  }
  function toggleMute() {
    var m = !sfx.muted();
    sfx.setMuted(m);
    if (!m) { sfx.start(); sfx.play("ui"); }
    renderMute();
    spawnFloater(viewW / 2, bannerShown ? 124 : 64, m ? "🔇 Sound off" : "🔊 Sound on", "#ffd24a", 14);
    try { chrome.storage.local.set({ cbMuted: m }); } catch (e) {}
  }
  renderMute();

  /* ── SCORE, LIFETIME PROGRESS, UNLOCKS, COMBOS ───────────────────────────────
     Best score and lifetime score are written at most once every 1.5s (and on
     exit) instead of on every kill. Lifetime score unlocks the new weapons;
     players from before it existed start from their best score. */
  var statsDirty = false, statsTimer = 0;
  function loadStats() {
    try {
      chrome.storage.local.get(["cbBest", "cbTotalKills", "cbMuted"], function(r){
        r = r || {};
        var storedBest = typeof r.cbBest === "number" ? r.cbBest : 0;
        var storedTotal = typeof r.cbTotalKills === "number" ? r.cbTotalKills : 0;
        bestBefore = storedBest;
        if (storedBest > best) best = storedBest;
        if (r.cbMuted === true) { sfx.setMuted(true); renderMute(); }
        totalBase = Math.max(storedTotal, storedBest);
        unlocksKnown = true;
        markUnlocked();
        renderArsenal();
        renderHUD();
      });
    } catch(e){ unlocksKnown = true; }
  }
  function flushStats() {
    if (statsTimer) { clearTimeout(statsTimer); statsTimer = 0; }
    if (!statsDirty) return;
    statsDirty = false;
    try { chrome.storage.local.set({ cbBest: best, cbTotalKills: totalScore() }); } catch(e){}
  }
  function saveStatsSoon() {
    statsDirty = true;
    if (!statsTimer) statsTimer = setTimeout(flushStats, 1500);
  }
  function addScore(n) {
    score += n;
    if (score > best) best = score;
    saveStatsSoon();
    renderHUD();
    announceUnlocks();
  }

  // Weapons already unlocked when the game starts are not announced again.
  var announced = {};
  function markUnlocked() {
    WEAPONS.forEach(function (w) { if (isUnlocked(w)) announced[w.id] = true; });
  }
  function announceUnlocks() {
    if (!unlocksKnown) return;
    for (var i = 0; i < WEAPONS.length; i++) {
      var w = WEAPONS[i];
      if (announced[w.id] || !isUnlocked(w)) continue;
      announced[w.id] = true;
      renderArsenal();
      spawnFloater(viewW / 2, viewH * 0.32, w.icon + " " + w.name + " UNLOCKED! · press " + (i + 1), "#ffd24a", 24, 2.6);
      stats.unlocked.push(w);
      sfx.play("chime", null, 7);
      chips[i].classList.remove("__cb_new");
      void chips[i].offsetWidth;   // restart the pop animation
      chips[i].classList.add("__cb_new");
      shakeScreen(6);
    }
  }

  // Kills close together build a combo with bonus points.
  var COMBO_NAMES = ["", "", "DOUBLE KILL!", "TRIPLE KILL!", "MULTI KILL!", "RAMPAGE!", "UNSTOPPABLE!"];
  function registerKill(x, y) {
    comboCount = comboT > 0 ? comboCount + 1 : 1;
    comboT = COMBO_WINDOW;
    if (comboCount > stats.bestCombo) stats.bestCombo = comboCount;
    if (comboCount < 2) return;
    sfx.play("chime", null, Math.min(comboCount + 1, 6));
    var name = COMBO_NAMES[Math.min(comboCount, COMBO_NAMES.length - 1)];
    var bonus = Math.min(comboCount - 1, 5);
    spawnFloater(Math.max(90, Math.min(viewW - 90, x)), Math.max(70, y - 70), name + " +" + bonus, "#ff9a20", 20 + Math.min(comboCount, 6) * 2, 1.5);
    addScore(bonus);
  }

  /* ── FIRST-LAUNCH INTRO (shown once; again once when it gains new content) ── */
  var INTRO_VERSION = 3;   // 2 = arsenal + enemy vehicles, 3 = sound, keys, launch shortcut, blast report
  function escHtml(t) {
    return String(t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function maybeShowIntro() {
    try {
      chrome.storage.local.get(["cbIntroSeen"], function(r){
        if (gameActive && (!r || !(r.cbIntroSeen >= INTRO_VERSION))) showIntro(!!(r && r.cbIntroSeen));
      });
    } catch(e) { showIntro(false); }
  }
  // The card sits between the score bar and the "pick weapons" hint, which points at the
  // controls beside the cannon. In a short window the hint goes (the controls are outlined
  // anyway) and, if needed, the card is scaled down so its button is never covered or cut off.
  var INTRO_TOP = 46, HINT_BOTTOM = 170;
  function fitIntro(ov) {
    var hint = ov.firstChild, card = hint.nextSibling;
    var h = card.offsetHeight, below = HINT_BOTTOM + hint.offsetHeight + 8;
    if (h <= viewH - INTRO_TOP - below) { ov.style.paddingBottom = below + "px"; return; }
    hint.style.display = "none";
    below = HINT_BOTTOM;
    ov.style.paddingBottom = below + "px";
    var room = viewH - INTRO_TOP - below;
    if (h > room) card.style.zoom = Math.max(0.6, room / h).toFixed(3);
  }
  function showIntro(returning) {
    introActive = true;
    var ov = document.createElement("div");
    ov.setAttribute("data-cb-ui", "1");
    ov.style.cssText = [
      "position:fixed;inset:0;z-index:2147483646;pointer-events:all;box-sizing:border-box;padding:" + INTRO_TOP + "px 10px;",
      "display:flex;align-items:center;justify-content:center;",
      "background:rgba(0,0,0,0.62);backdrop-filter:blur(3px);font-family:system-ui,sans-serif;"
    ].join("");
    var row = function (icon, html) {
      return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0"><div style="font-size:20px;min-width:50px;white-space:nowrap;text-align:center">' + icon + '</div><div>' + html + '</div></div>';
    };
    ov.innerHTML =
      '<div style="position:fixed;bottom:' + HINT_BOTTOM + 'px;left:50%;transform:translateX(-50%);text-align:center;pointer-events:none">'+
        '<div style="animation:cbWiggle 1s ease-in-out infinite">'+
        '<div style="background:#ffd24a;color:#111;font-weight:800;font-size:12px;padding:5px 10px;border-radius:9px;margin-bottom:4px">Pick weapons (keys 1–6) &amp; ⚠️ Danger beside the cannon</div>'+
        '<div style="font-size:42px;line-height:1;color:#ffd24a;text-shadow:0 2px 8px rgba(0,0,0,.6)">↓</div>'+
      '</div></div>'+
      '<div style="background:#15171a;color:#eee;max-width:430px;width:88%;flex:none;border-radius:16px;font-size:13px;line-height:1.35;'+
      'padding:18px 22px;box-shadow:0 20px 60px rgba(0,0,0,0.6);border:1px solid rgba(255,210,74,0.3)">'+
      '<div style="font-size:19px;font-weight:800;color:#ffd24a;margin-bottom:6px">' +
        (returning ? '🆕 New in BlastBlastBlast' : '🔥 Welcome to BlastBlastBlast') + '</div>'+
      '<div style="font-size:13px;opacity:.7;margin-bottom:12px">Move to aim · <b>click anywhere to fire</b> · Esc to remove</div>'+
      row('💣🔫', '<b>Cannon &amp; Gun</b> — the classics: click to lob a ball, <b>hold</b> to rapid-fire.') +
      row('🚀🔥', '<b>Rockets &amp; Flamethrower</b> — unlock them by scoring points. Hold to keep firing.') +
      row('⚡💥', '<b>Laser &amp; Cluster bombs</b> — carve lines through text, or split one bomb into six.') +
      row('🛡️✈️', '<b>Enemy tanks &amp; bombers</b> attack the page. Several hits take them down!') +
      row('⚠️', '<b>Danger</b> — toggle a swarm of soldiers and vehicles from all sides.') +
      row('⌨️🔊', '<b>Keys</b> — 1–6 or G weapons · D Danger · M sound · Esc ends with your blast report' +
        (launchInfo.shortcut ? ' · <b>' + escHtml(launchInfo.shortcut) + '</b> launches on any page' : '') + '.') +
      '<button id="__cbIntroOk" style="margin-top:10px;width:100%;background:#ffd24a;color:#111;border:0;'+
      'border-radius:10px;padding:11px;font-weight:800;font-size:14px;cursor:pointer">Let\u2019s blast! 🚀</button></div>';
    document.documentElement.appendChild(ov);
    removeList.push(ov);
    fitIntro(ov);
    function highlightToggles(on){
      [arsenal, dangerBtn].forEach(function(b){
        b.style.opacity = "1";
        b.style.outline = on ? "3px solid #ffd24a" : "";
      });
    }
    highlightToggles(true);
    function dismiss(){ introActive = false; highlightToggles(false); if (ov.parentNode) ov.parentNode.removeChild(ov);
      try { chrome.storage.local.set({ cbIntroSeen: INTRO_VERSION }); } catch(e){} }
    ov.querySelector("#__cbIntroOk").addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); dismiss(); });
    // Clicking the backdrop both dismisses the intro AND fires — no wasted first click
    ov.addEventListener("click", function(e){ if (e.target === ov) { e.stopPropagation(); dismiss(); beginFire(e.clientX, e.clientY); endFire(); } });
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

  // Rockets, flame and laser point the barrel straight at the cursor.
  function aimDirect(mx, my) {
    var p = getPivot();
    aimAngle = Math.atan2(my - p.y, mx - p.x);
  }

  function applyAim() {
    if (isLobbed(mode))   updateCannonAimTo(mouseX, mouseY);
    else if (mode === "gun") aimBarrelToward(mouseX, mouseY);
    else                  aimDirect(mouseX, mouseY);
  }

  function fireAt(x, y) {
    if (mode === "gun") {
      fireGun(x, y);
    } else if (mode === "rocket") {
      if (weaponCd <= 0) fireRocket(x, y);
    } else if (mode === "cluster") {
      if (weaponCd <= 0) { updateCannonAimTo(x, y); fireCannon("cluster"); }
    } else if (mode === "cannon") {
      updateCannonAimTo(x, y);
      fireCannon("ball");
    }
    // flame and laser fire continuously while held (updateWeapons)
  }

  // Pointer pressed: fire once now; gun, rockets, flame and laser keep firing
  // (updateWeapons) until the pointer is released.
  function beginFire(x, y) {
    if (introActive) return;          // wait until the intro is dismissed
    mouseX = x; mouseY = y;
    sfx.start();
    stats.used[mode] = true;
    if (!stats.firstShotAt) stats.firstShotAt = performance.now();
    fireAt(x, y);
    held = true;
    if (mode === "gun") gunFireCd = GUN_FIRE_INTERVAL;
  }
  function endFire() { held = false; laserBeam = null; lastCarve = null; }

  function updateWeapons(dt) {
    if (weaponCd > 0) weaponCd -= dt;
    if (introActive) { held = false; return; }
    if (mode === "gun") {
      if (!held) return;
      gunFireCd -= dt;
      if (gunFireCd <= 0) { fireGun(mouseX, mouseY); gunFireCd = GUN_FIRE_INTERVAL; }
    } else if (mode === "rocket") {
      if (held && weaponCd <= 0) fireRocket(mouseX, mouseY);
    } else if (mode === "flame") {
      if (held) fireFlame(dt);
    } else if (mode === "laser") {
      if (held) fireLaser(dt); else laserBeam = null;
    }
  }

  /* ── FIRE ────────────────────────────────────────────────────────────────── */
  function fireCannon(kind) {
    if (!hasAim) return;
    var m   = getMuzzle();
    var sol = solveLaunch(m.x, m.y, targetX, targetY);
    if (sol.dist < MIN_AIM_DIST) return;

    balls.push({
      kind: kind || "ball", shot: newShot(),
      x: m.x, y: m.y,
      vx: sol.vx, vy: sol.vy,
      trail: [], spin: 0,
      landX: targetX, landY: targetY,
      T: sol.T, elapsed: 0,
      exploded: false
    });

    spawnMuzzleFlash(m.x, m.y);
    sfx.play("boom", m.x, kind === "cluster" ? 0.8 : 1);
    hasAim = false;
    aimPower = 0;
    if (kind === "cluster") weaponCd = CLUSTER_COOLDOWN;
  }

  /* ── ROCKETS: fast, straight, big blast at the cursor ───────────────────── */
  function fireRocket(tx, ty) {
    aimDirect(tx, ty);
    var m = getMuzzle();
    var dx = tx - m.x, dy = ty - m.y, dist = Math.hypot(dx, dy);
    if (dist < 40) return;
    rockets.push({ x: m.x, y: m.y, tx: tx, ty: ty, ang: Math.atan2(dy, dx), speed: 420,
                   dist: dist, traveled: 0, smokeT: 0, shot: newShot() });
    spawnMuzzleFlash(m.x, m.y);
    sfx.play("rocket", m.x);
    shakeScreen(3);
    weaponCd = ROCKET_COOLDOWN;
  }
  function rocketBlast(x, y, shot) {
    explodeAt(x, y, { r: 70, killR: 112, mark: 1.45, shake: 12, particles: 1.7, dmg: 5, shot: shot });
  }
  function updateRockets(dt) {
    for (var i = rockets.length - 1; i >= 0; i--) {
      var r = rockets[i];
      r.speed = Math.min(r.speed + 2200 * dt, 1600);
      var step = r.speed * dt, ca = Math.cos(r.ang), sa = Math.sin(r.ang);
      if (r.traveled + step >= r.dist) { rocketBlast(r.tx, r.ty, r.shot); rockets.splice(i, 1); continue; }
      r.traveled += step;
      r.x += ca * step; r.y += sa * step;
      // A rocket that meets an enemy vehicle on the way explodes on it.
      var hitE = enemyNear(r.x, r.y, 4);
      if (hitE) { rocketBlast(r.x, r.y, r.shot); rockets.splice(i, 1); continue; }
      r.smokeT -= dt;
      if (r.smokeT <= 0) {
        r.smokeT = 0.016;
        particles.push({ x: r.x - ca * 12, y: r.y - sa * 12, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30,
          life: 0.55, maxLife: 0.55, size: 3 + Math.random() * 3, color: "#2a2a2a", type: "smoke", rotation: 0, rotSpeed: 0 });
      }
    }
  }
  function renderRockets() {
    for (var i = 0; i < rockets.length; i++) {
      var r = rockets[i], c = Math.cos(r.ang) * dpr, s = Math.sin(r.ang) * dpr;
      ctx.setTransform(c * 1.45, s * 1.45, -s * 1.45, c * 1.45, r.x * dpr, r.y * dpr);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(glowSprite("#ff9a20"), -30, -9, 20, 18);      // exhaust
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#d8dde2";
      ctx.fillRect(-12, -2.6, 16, 5.2);                            // body
      ctx.fillStyle = "#c62d1f";
      ctx.beginPath(); ctx.moveTo(4, -2.6); ctx.lineTo(10, 0); ctx.lineTo(4, 2.6); ctx.closePath(); ctx.fill();  // nose
      ctx.fillStyle = "#59636b";
      ctx.beginPath(); ctx.moveTo(-12, -2.6); ctx.lineTo(-15, -6); ctx.lineTo(-8, -2.6); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-12, 2.6); ctx.lineTo(-15, 6); ctx.lineTo(-8, 2.6); ctx.closePath(); ctx.fill();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── FLAMETHROWER: hold to spray fire; burns text and soldiers at the tip ── */
  function fireFlame(dt) {
    var m = getMuzzle();
    var dx = mouseX - m.x, dy = mouseY - m.y, d = Math.hypot(dx, dy) || 1;
    var range = Math.min(d, FLAME_RANGE), ux = dx / d, uy = dy / d;
    var tipX = m.x + ux * range, tipY = m.y + uy * range;
    var base = Math.atan2(uy, ux);
    for (var k = 0; k < 4 && flames.length < 260; k++) {
      var a = base + (Math.random() - 0.5) * 0.3, sp = 470 + Math.random() * 160;
      var life = range / sp * (0.85 + Math.random() * 0.3);
      flames.push({ x: m.x + ux * 6, y: m.y + uy * 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                    life: life, maxLife: life, size: 5 + Math.random() * 4 });
    }
    flameBurnT -= dt;
    if (flameBurnT <= 0) {
      flameBurnT = 0.11;
      explodeAt(tipX + (Math.random() - 0.5) * 14, tipY + (Math.random() - 0.5) * 14,
        { r: 24, killR: 36, mark: Math.random() < 0.2 ? 0.5 : 0, shake: 0, particles: 0, burn: true, dmg: 0 });
    }
    for (var i = soldiers.length - 1; i >= 0; i--) {
      var s = soldiers[i];
      if (s.state !== "dead" && segDist(s.x, s.y - 20, m.x, m.y, tipX, tipY) < 16) killSoldier(s);
    }
    hurtEnemiesOnSegment(m.x, m.y, tipX, tipY, 10, 3.5 * dt);
  }
  function updateFlames(dt) {
    var j = 0;
    for (var i = 0; i < flames.length; i++) {
      var f = flames[i];
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.vx *= 0.985; f.vy = f.vy * 0.985 - 30 * dt;
      f.life -= dt;
      if (f.life > 0) flames[j++] = f;
    }
    flames.length = j;
  }
  var FLAME_COLORS = ["#4a2a1c", "#c4260c", "#e8480f", "#ff7a14", "#ffa628", "#ffd75a", "#fff1a8"];
  function renderFlames() {
    if (!flames.length) return;
    for (var i = 0; i < flames.length; i++) {
      var f = flames[i], t = f.life / f.maxLife;          // 1 at the nozzle → 0 at the tip
      var r = f.size * (2 - t);
      ctx.globalAlpha = t < 0.15 ? t / 0.15 * 0.5 : 0.95;
      ctx.drawImage(glowSprite(FLAME_COLORS[Math.min(FLAME_COLORS.length - 1, Math.floor(t * FLAME_COLORS.length))]),
                    f.x - r, f.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  /* ── LASER: hold to burn a beam to the cursor; sweeping carves the text ─── */
  function fireLaser(dt) {
    var m = getMuzzle();
    if (!laserBeam) sfx.play("zap", mouseX);
    laserBeam = { x0: m.x, y0: m.y, x1: mouseX, y1: mouseY };
    laserCarveT -= dt;
    var moved = lastCarve ? Math.hypot(mouseX - lastCarve.x, mouseY - lastCarve.y) : 1e9;
    if (moved >= 10 || laserCarveT <= 0) {
      laserCarveT = 0.08;
      lastCarve = { x: mouseX, y: mouseY };
      explodeAt(mouseX, mouseY, { r: 14, killR: 20, mark: 0, shake: 0, particles: 0, burn: true, dmg: 0 });
    }
    for (var i = soldiers.length - 1; i >= 0; i--) {
      var s = soldiers[i];
      if (s.state !== "dead" && segDist(s.x, s.y - 20, m.x, m.y, mouseX, mouseY) < 11) killSoldier(s);
    }
    hurtEnemiesOnSegment(m.x, m.y, mouseX, mouseY, 6, 6 * dt);
    if (Math.random() < 0.7) {
      var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 120;
      particles.push({ x: mouseX, y: mouseY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.2, maxLife: 0.2,
        size: 0.8 + Math.random(), color: Math.random() < 0.5 ? "#ffffff" : "#8fe8ff", type: "spark", rotation: 0, rotSpeed: 0 });
    }
  }
  function renderLaser() {
    var b = laserBeam;
    if (!b) return;
    var flick = 0.85 + Math.random() * 0.3;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,150,255,0.25)"; ctx.lineWidth = 13 * flick;
    ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
    ctx.strokeStyle = "rgba(30,170,255,0.9)"; ctx.lineWidth = 5 * flick;
    ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
    ctx.strokeStyle = "#f2fdff"; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(glowSprite("#8fe8ff"), b.x1 - 16, b.y1 - 16, 32, 32);
    ctx.restore();
  }

  /* ── CLUSTER BOMB: lobbed like the cannon, bursts into six bomblets ──────── */
  function burstCluster(x, y, shot) {
    explodeAt(x, y, { r: 30, killR: 50, mark: 0.55, shake: 5, particles: 0.6, dmg: 2, shot: shot });
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.5, sp = 120 + Math.random() * 120;
      bomblets.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 170 - Math.random() * 80,
                      fuse: 0.42 + Math.random() * 0.3, blink: Math.random() * 6, shot: shot });
    }
  }
  function updateBomblets(dt) {
    for (var i = bomblets.length - 1; i >= 0; i--) {
      var b = bomblets[i];
      b.vy += BALL_G * 0.8 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.fuse -= dt; b.blink += dt * 18;
      if (b.fuse <= 0) {
        bomblets.splice(i, 1);
        explodeAt(Math.max(4, Math.min(viewW - 4, b.x)), Math.max(4, Math.min(viewH - 4, b.y)),
          { r: 34, killR: 62, mark: 0.65, shake: 4, particles: 0.7, dmg: 2, shot: b.shot });
      }
    }
  }
  function renderBomblets() {
    for (var i = 0; i < bomblets.length; i++) {
      var b = bomblets[i];
      ctx.fillStyle = "#2b2b2b";
      ctx.beginPath(); ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = Math.sin(b.blink) > 0 ? "#ff3b2f" : "#5a1410";
      ctx.beginPath(); ctx.arc(b.x, b.y - 1, 1.6, 0, Math.PI * 2); ctx.fill();
    }
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
      life: 1.4, shot: newShot()
    });
    spawnMuzzleFlash(m.x, m.y);
    sfx.play("gun", m.x);
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
          markHit(b.shot);
          hit = true;
          break;
        }
      }
      if (!hit) {
        var e = enemyOnSegment(b.px, b.py, b.x, b.y, 2);
        if (e) {
          markHit(b.shot);
          sfx.play("tink", b.x);
          hitEnemy(e, 0.5);
          for (var q = 0; q < 4; q++) {
            var qa = Math.random()*Math.PI*2, qs = 60+Math.random()*90;
            particles.push({ x:b.x, y:b.y, vx:Math.cos(qa)*qs, vy:Math.sin(qa)*qs, life:0.16, maxLife:0.16,
              size:0.8+Math.random(), color:"#fff3c4", type:"spark", rotation:0, rotSpeed:0 });
          }
          bullets.splice(i, 1);
          continue;
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

  // Reticle drawn at the cursor for the straight-shooting weapons.
  var RETICLE_COLORS = { gun: "rgba(255,80,60,0.9)", rocket: "rgba(255,170,40,0.95)",
                         flame: "rgba(255,120,30,0.9)", laser: "rgba(110,220,255,0.95)" };
  function renderGunReticle() {
    var color = RETICLE_COLORS[mode];
    if (!color || introActive) return;
    var x = mouseX, y = mouseY, r = mode === "rocket" ? 14 : 11;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x-r-5, y); ctx.lineTo(x-3, y);
    ctx.moveTo(x+3, y);   ctx.lineTo(x+r+5, y);
    ctx.moveTo(x, y-r-5); ctx.lineTo(x, y-3);
    ctx.moveTo(x, y+3);   ctx.lineTo(x, y+r+5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI*2); ctx.fill();
    if (mode === "rocket" && weaponCd > 0) {          // reload indicator
      ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - weaponCd / ROCKET_COOLDOWN)); ctx.stroke();
    }
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
        if (b.kind === "cluster") burstCluster(b.landX, b.landY, b.shot);
        else explodeAt(b.landX, b.landY, { shot: b.shot });
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
  // o (all optional): r page radius, killR soldier radius, mark scale (0 = none),
  // shake amount (0 = none), particles scale (0 = none), dmg to enemy vehicles,
  // burn (text turns to embers), enemy (fired by an enemy: no points),
  // shot (the player's shot this blast belongs to, for accuracy).
  function explodeAt(cx, cy, o) {
    o = o || {};
    var r = o.r || BLAST_RADIUS;
    var killR = o.killR || SOLDIER_KILL_R;
    var ps = o.particles === undefined ? 1 : o.particles;
    if (ps) {
      spawnExplosionParticles(cx, cy, ps);
      sfx.play("blast", cx, ps);
    }
    if (o.mark !== 0) createBlastMark(cx, cy, o.mark || 1);
    if (o.shake !== 0) shakeScreen(o.shake);
    // Kill any soldiers caught in the blast (drops their loot as a falling shard)
    var killed = 0;
    for (var si = soldiers.length-1; si >= 0; si--) {
      var sol = soldiers[si];
      if (sol.state !== "dead" && Math.hypot(sol.x - cx, (sol.y-18) - cy) < killR) { killSoldier(sol, !o.enemy); killed++; }
    }
    if (!o.enemy && damageEnemiesAt(cx, cy, killR * 0.75, o.dmg === undefined ? 3 : o.dmg)) killed++;
    if (killed) markHit(o.shot);
    if (blastQueue.length < MAX_JOBS) blastQueue.push({ cx: cx, cy: cy, r: r, burn: !!o.burn });
  }

  function spawnExplosionParticles(cx, cy, scale) {
    scale = scale || 1;
    var n = Math.round(18 * scale);
    for (var i = 0; i < n; i++) {
      var a = Math.random()*Math.PI*2, spd = (40+Math.random()*140) * Math.sqrt(scale);
      var r = Math.random();
      var type, color, size, life;
      if (r < 0.55)      { type="spark"; color=Math.random()<0.5?"#ffffff":"#ffee44"; size=0.8+Math.random()*1; life=0.14+Math.random()*0.22; }
      else if (r < 0.82) { type="ember"; color=Math.random()<0.5?"#ff8800":"#dd2200"; size=1+Math.random()*1.6; life=0.24+Math.random()*0.36; }
      else               { type="smoke"; color="#2a2a2a";                              size=3+Math.random()*4;  life=0.3+Math.random()*0.4; }
      particles.push({ x:cx, y:cy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd,
        life:life, maxLife:life, size:size, color:color, type:type,
        rotation:Math.random()*Math.PI*2, rotSpeed:(Math.random()-0.5)*10 });
    }
    shockwaves.push({x:cx,y:cy,r:0,maxR:42*scale, life:0.22,maxLife:0.22,w:2.5,color:"255,185,90"});
    shockwaves.push({x:cx,y:cy,r:0,maxR:26*scale, life:0.13,maxLife:0.13,w:1.5,color:"255,255,255"});
    craters.push({ x:cx, y:cy, r:(14+Math.random()*5)*Math.min(scale, 1.6), life:1.0, maxLife:1.0 });
  }

  function distToRect(cx, cy, r) {
    var nx = Math.max(r.left, Math.min(cx, r.right));
    var ny = Math.max(r.top,  Math.min(cy, r.bottom));
    return Math.hypot(nx - cx, ny - cy);
  }

  // Hit-test sample points: centre, ring at R/2, ring at R (unit circle).
  // Small blasts (flame, laser) only need the centre and the outer ring.
  var SAMPLES = [[0, 0]], SAMPLES_SMALL = [[0, 0]];
  (function () {
    var rings = [0.5, 1];
    for (var rd = 0; rd < rings.length; rd++)
      for (var a = 0; a < 8; a++) {
        var p = [Math.cos(a / 8 * Math.PI * 2) * rings[rd], Math.sin(a / 8 * Math.PI * 2) * rings[rd]];
        SAMPLES.push(p);
        if (rings[rd] === 1) SAMPLES_SMALL.push(p);
      }
  }());

  /* READ phase of one blast: gathers everything it will destroy. */
  function readBlast(job) {
    var cx = job.cx, cy = job.cy, R = job.r || BLAST_RADIUS;
    var res = { cx: cx, cy: cy, r: R, burn: job.burn, atoms: [], media: [], chars: [] };
    var seen = new Set(), atomSeen = new Set(), mediaSeen = new Set();
    var samples = R < 30 ? SAMPLES_SMALL : SAMPLES;

    // 1) Whole UI atoms (buttons, icons, svg, bg-images) and videos/canvases.
    for (var s = 0; s < samples.length; s++) {
      var sx = cx + samples[s][0] * R, sy = cy + samples[s][1] * R;
      if (sx < 0 || sy < 0 || sx >= viewW || sy >= viewH) continue;
      var stack = document.elementsFromPoint(sx, sy) || [];
      for (var k = 0; k < stack.length && k < 4; k++) {
        var el = stack[k];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        var atom = atomToFling(el, cx, cy, R);
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
    // Bigger blasts may tear out more characters (scaled by area).
    var cap = Math.round(Math.max(40, Math.min(360, MAX_BLAST_CHARS * (R * R) / (BLAST_RADIUS * BLAST_RADIUS))));
    res.chars = collectBlastChars(cx, cy, R, res.atoms, cap);
    return res;
  }

  /* WRITE phase of one blast. */
  function applyBlast(res) {
    var a, m;
    for (a = 0; a < res.atoms.length; a++) flingElement(res.atoms[a].el, res.cx, res.cy, res.atoms[a].rect, res.r);
    for (m = 0; m < res.media.length; m++) shatterMedia(res.media[m], res.cx, res.cy, res.r);
    if (res.chars.length) blastChars(res.chars, res.cx, res.cy, res.r, res.burn);
  }

  var SKIP_ATOM = { html:1, body:1, head:1, script:1, style:1, main:1, section:1, article:1, nav:1, ul:1, ol:1 };
  function atomToFling(el, cx, cy, R) {
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
    if (distToRect(cx, cy, rect) > R) return null;                 // not actually in blast
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
  function flingElement(el, cx, cy, rect, R) {
    if (scattered.has(el) || hiddenSet.has(el)) return;
    scattered.add(el);
    stats.pieces++;
    if (flung.length >= MAX_FLUNG) { hideEl(el); return; }   // too much already in the air
    var c = cloneForFlight(el, rect.left, rect.top, rect.width, rect.height);
    hideEl(el);
    var ecx = rect.left + rect.width/2, ecy = rect.top + rect.height/2;
    var ang = Math.atan2(ecy - cy, ecx - cx);
    var dist = Math.hypot(ecx - cx, ecy - cy);
    var force = (1 - Math.min(dist / R, 1)) * 480 + 150 + Math.random()*120;
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

  function collectBlastChars(cx, cy, R, atoms, cap) {
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
      if (out.length >= cap) return;
      var parent = node.parentElement;
      if (!parent || SKIP_TEXT_PARENT[parent.localName] || parent.namespaceURI !== HTML_NS) return;
      if (parent.closest("[data-cb-hidden],[data-cb-ui],[data-cb-blasted]")) return;
      for (var a = 0; a < atoms.length; a++) if (atoms[a].el.contains(node)) return;
      var st = textStateFor(node, false);
      var data = node.data, len = data.length;
      var lo = Math.max(0, w[0]), hi = Math.min(len, w[1]);
      if (hi <= lo) return;
      forEachCluster(data, lo, hi, function (i, n) {
        if (out.length >= cap) return;
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
  function blastChars(chars, cx, cy, R, burn) {
    var touched = new Map();
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      var st = textStateFor(c.node, true);
      if (st.bits[c.i]) continue;
      for (var k = 0; k < c.n; k++) st.bits[c.i + k] = 1;
      st.count++;
      stats.letters++;
      var t = touched.get(c.node);
      if (!t) { t = { st: st, runs: [] }; touched.set(c.node, t); }
      t.runs.push([c.i, c.i + c.n]);
      if (c.style.color && debris.length < MAX_DEBRIS) spawnCharDebris(c, cx, cy, R, burn);
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
      if (b > node.length || a >= b) continue;
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

  // burn: flame/laser — the character glows like an ember and floats up.
  function spawnCharDebris(c, cx, cy, R, burn) {
    var r = c.rect, px = r.left + r.width / 2, py = r.top + r.height / 2;
    var dist  = Math.hypot(px - cx, py - cy);
    var force = (1 - Math.min(dist / R, 1)) * 640 + Math.random() * 180;
    var ang   = Math.atan2(py - cy, px - cx);
    var data = c.node.data, ch = data.substr(c.i, c.n), tt = c.style.tt;
    if (tt === "uppercase") ch = ch.toUpperCase();
    else if (tt === "lowercase") ch = ch.toLowerCase();
    else if (tt === "capitalize" && (c.i === 0 || isSpaceCode(data.charCodeAt(c.i - 1)))) ch = ch.toUpperCase();
    var color = burn ? (Math.random() < 0.5 ? "#ff7a1a" : "#ffb02e") : c.style.color;
    debris.push({
      t: 0, ch: ch, font: c.style.font, color: color, g: glyphFor(ch, c.style.font, color),
      base: fontAscent(c.style.font, r.height) - r.height / 2,
      x: px, y: py,
      vx: burn ? (Math.random()-0.5) * 90 : Math.cos(ang) * force + (Math.random()-0.5) * 200,
      vy: burn ? -60 - Math.random() * 110 : Math.sin(ang) * force - 260 - Math.random() * 250,
      rot: 0, rs: (Math.random()-0.5) * (burn ? 180 : 560) * Math.PI / 180,
      life: burn ? 0.5 + Math.random() * 0.4 : 1.2 + Math.random() * 1.0, fade: burn ? 0.45 : 0.35
    });
  }

  /* ── IMAGE / VIDEO / CANVAS SHATTERING (4×4 grid on the game canvas) ───────
     The element is drawn once into a snapshot canvas (exactly what is on
     screen: currentSrc, object-fit, no new network request), then 16 pieces of
     that snapshot fly on the overlay canvas. */
  function shatterMedia(m, cx, cy, R) {
    var el = m.el, rect = m.rect;
    if (shattered.has(el)) return;
    shattered.add(el);
    stats.pieces++;
    sfx.play("shatter", rect.left + rect.width / 2);
    var snap = snapshotMedia(el, rect, m.cs || getComputedStyle(el));
    hideEl(el);
    if (!snap) return;
    var G = 4, pw = rect.width / G, ph = rect.height / G, k = snap.scale;
    for (var row = 0; row < G; row++) {
      for (var col = 0; col < G; col++) {
        if (debris.length >= MAX_DEBRIS) return;
        var pcx = rect.left + col * pw + pw / 2, pcy = rect.top + row * ph + ph / 2;
        var dist = Math.hypot(pcx - cx, pcy - cy);
        var f = (1 - Math.min(dist / R, 1)) * 560 + Math.random() * 140;
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
    ctx.textAlign = "start";
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
    if (!isLobbed(mode) || !hasAim || introActive) return;
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
      if (b.kind === "cluster") {
        ctx.fillStyle = "#2d2d2d";
        ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R * 0.85, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#d8321f"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R * 0.55, b.spin, b.spin + Math.PI); ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.drawImage(glowSprite("#ffcc33"), b.x - 6, b.y - BALL_R - 6, 12, 12);   // fuse spark
        ctx.globalAlpha = 1;
        continue;
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
  function spawnFloater(x, y, text, color, size, life) {
    life = life || 1.1;
    floaters.push({ x:x, y:y, text:text, color:color||"#ffd24a",
      size:size||15, life:life, maxLife:life });
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

  function createBlastMark(cx, cy, scale) {
    var v = pickMarkVariant();
    scale = scale || 1;
    if (!marksLayer) return;
    // Clip the mark to the scrollable document area (viewport coordinates) so
    // it never grows the page, then place it relative to the marks layer.
    var half = v.half * scale;
    var L = Math.max(docMinX, cx - half), T = Math.max(docMinY, cy - half);
    var Rr = Math.min(docMaxX, cx + half), B = Math.min(docMaxY, cy + half);
    var w = Math.floor(Rr - L), h = Math.floor(B - T);
    if (w < 4 || h < 4) return;
    var c = document.createElement("canvas");
    c.className = "__cb_mark";
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    c.style.cssText = "left:" + (L - layerX).toFixed(1) + "px;top:" + (T - layerY).toFixed(1) + "px;" +
                      "width:" + w + "px!important;height:" + h + "px!important;" +
                      "transform-origin:" + (cx - L).toFixed(1) + "px " + (cy - T).toFixed(1) + "px;";
    var x = c.getContext("2d");
    var ang = Math.random()*Math.PI*2, k = dpr / v.dpr * scale;
    var cs = Math.cos(ang)*k, sn = Math.sin(ang)*k;
    x.setTransform(cs, sn, -sn, cs, (cx - L)*dpr, (cy - T)*dpr);
    x.drawImage(v.c, -v.half * v.dpr, -v.half * v.dpr);
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

  // credit: false when an enemy shell killed the soldier (no points for the player).
  function killSoldier(s, credit) {
    if (s.state === "dead") return;
    sfx.play("hit", s.x);
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
    if (credit === false) return;
    stats.soldiers++;
    spawnFloater(s.x, s.y - 44, "+1 💥", "#ffd24a", 16);
    addScore(1);
    registerKill(s.x, s.y - 44);
  }

  function escapeSoldier(s) {
    // Soldier got away — loot stays stolen (original hidden); remove the carried clone.
    if (s.loot) { removeNode(s.loot.clone); dropRanges(s.loot.ranges); }
    s.loot = null;
    stolen++;
    sfx.play("escape", s.x);
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

  /* ── ENEMY VEHICLES ──────────────────────────────────────────────────────────
     Tanks roll in, park and shell the page; bombers fly over dropping bombs.
     Both take several hits (HP bar) and are worth extra points. They show up
     now and then in normal play and often in Danger mode. */
  function spawnTank() {
    var fromLeft = Math.random() < 0.5;
    var y = viewH * (0.14 + Math.random() * 0.34);
    enemies.push({ kind: "tank", x: fromLeft ? -46 : viewW + 46, y: y, dir: fromLeft ? 1 : -1,
      speed: 46 + Math.random() * 20, hp: 8, maxHp: 8, radius: 26, state: "drive",
      stopX: viewW * (0.12 + Math.random() * 0.76), fireT: 1, shots: 0,
      turret: fromLeft ? 0.5 : Math.PI - 0.5, aimX: 0, aimY: 0, hitT: 0, wheel: 0, recoil: 0 });
    spawnFloater(fromLeft ? 110 : viewW - 110, y - 46, "⚠️ ENEMY TANK!", "#ff5544", 16, 1.6);
    sfx.play("alert");
  }
  function spawnBomber() {
    var fromLeft = Math.random() < 0.5;
    var y = 48 + Math.random() * Math.min(110, viewH * 0.16);
    enemies.push({ kind: "bomber", x: fromLeft ? -70 : viewW + 70, y: y, dir: fromLeft ? 1 : -1,
      speed: 150 + Math.random() * 40, hp: 3, maxHp: 3, radius: 28, dropT: 0.5,
      bombs: 5 + Math.floor(Math.random() * 3), hitT: 0, prop: 0 });
    spawnFloater(fromLeft ? 130 : viewW - 130, y + 34, "✈️ BOMBER INCOMING!", "#ff5544", 16, 1.6);
    sfx.play("alert");
  }
  function countEnemies(kind) {
    var n = 0;
    for (var i = 0; i < enemies.length; i++) if (enemies[i].kind === kind) n++;
    return n;
  }
  function enemyCY(e) { return e.kind === "tank" ? e.y - 6 : e.y; }

  function updateEnemies(dt) {
    var danger = isDangerActive();
    if (!introActive) {
      tankTimer -= dt;
      if (tankTimer <= 0) {
        tankTimer = danger ? 8 + Math.random() * 6 : 45 + Math.random() * 25;
        if (countEnemies("tank") < (danger ? 3 : 1)) spawnTank();
      }
      bomberTimer -= dt;
      if (bomberTimer <= 0) {
        bomberTimer = danger ? 12 + Math.random() * 8 : 70 + Math.random() * 30;
        if (countEnemies("bomber") < 1) spawnBomber();
      }
    }
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i];
      if (e.hitT > 0) e.hitT -= dt;
      if (e.kind === "tank") updateTank(e, dt);
      else if (updateBomber(e, dt)) enemies.splice(i, 1);   // flew off-screen
    }
    updateEnemyShots(dt);
  }

  function updateTank(e, dt) {
    if (e.recoil > 0) e.recoil = Math.max(0, e.recoil - dt * 6);
    if (e.state === "drive") {
      var dx = e.stopX - e.x;
      if (Math.abs(dx) < 2) {
        e.state = "fire"; e.fireT = 0.8 + Math.random() * 0.6; pickTankTarget(e);
      } else {
        var step = (dx > 0 ? 1 : -1) * Math.min(Math.abs(dx), e.speed * dt);
        e.x += step; e.dir = step > 0 ? 1 : -1; e.wheel += step;
      }
      return;
    }
    // Swing the turret toward the target, then fire.
    var want = Math.atan2(e.aimY - (e.y - 12), e.aimX - e.x);
    var diff = Math.atan2(Math.sin(want - e.turret), Math.cos(want - e.turret));
    e.turret += Math.max(-2.5 * dt, Math.min(2.5 * dt, diff));
    e.fireT -= dt;
    if (e.fireT <= 0 && Math.abs(diff) < 0.1) {
      fireTankShell(e);
      e.shots++;
      e.fireT = 2.3 + Math.random() * 1.4;
      pickTankTarget(e);
      if (e.shots % 3 === 0) { e.state = "drive"; e.stopX = viewW * (0.12 + Math.random() * 0.76); }
    }
  }
  function pickTankTarget(e) {
    e.aimX = Math.max(30, Math.min(viewW - 30, e.x + (Math.random() - 0.5) * 520));
    e.aimY = Math.max(e.y + 50, Math.min(viewH * PLAY_TOP_FRAC, e.y + 70 + Math.random() * 260));
  }
  function fireTankShell(e) {
    var mx = e.x + Math.cos(e.turret) * 26, my = e.y - 12 + Math.sin(e.turret) * 26;
    var sol = solveLaunch(mx, my, e.aimX, e.aimY);
    enemyShots.push({ kind: "shell", x: mx, y: my, vx: sol.vx, vy: sol.vy, T: sol.T, t: 0, tx: e.aimX, ty: e.aimY });
    e.recoil = 1;
    sfx.play("boom", mx, 0.6);
    sfx.play("whistle", e.aimX, sol.T);
    mFlashes.push({ x: mx, y: my, life: 0.16, maxLife: 0.16,
      sparks: [{ a: e.turret, len: 18 }, { a: e.turret - 0.45, len: 11 }, { a: e.turret + 0.45, len: 11 }] });
  }
  function updateBomber(e, dt) {
    e.x += e.dir * e.speed * dt;
    e.prop += dt * 40;
    e.dropT -= dt;
    if (e.dropT <= 0 && e.bombs > 0 && e.x > 40 && e.x < viewW - 40) {
      e.dropT = 0.42 + Math.random() * 0.25;
      e.bombs--;
      var bombTy = Math.min(viewH * PLAY_TOP_FRAC, e.y + 120 + Math.random() * viewH * 0.4);
      enemyShots.push({ kind: "bomb", x: e.x, y: e.y + 8, vx: e.dir * e.speed * 0.55, vy: 30, ty: bombTy });
      sfx.play("whistle", e.x, Math.sqrt(2 * Math.max(10, bombTy - e.y) / 520));
    }
    return (e.dir > 0 && e.x > viewW + 90) || (e.dir < 0 && e.x < -90);
  }
  function updateEnemyShots(dt) {
    for (var i = enemyShots.length - 1; i >= 0; i--) {
      var s = enemyShots[i];
      if (s.kind === "shell") {
        s.vy += BALL_G * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.t += dt;
        if (s.t >= s.T) {
          enemyShots.splice(i, 1);
          explodeAt(s.tx, s.ty, { r: 40, killR: 60, mark: 0.9, shake: 5, particles: 0.9, enemy: true });
        }
      } else {
        s.vy += 520 * dt; s.vx *= 0.99; s.x += s.vx * dt; s.y += s.vy * dt;
        if (s.y >= s.ty) {
          enemyShots.splice(i, 1);
          explodeAt(Math.max(6, Math.min(viewW - 6, s.x)), s.ty, { r: 36, killR: 56, mark: 0.8, shake: 4, particles: 0.8, enemy: true });
        }
      }
    }
  }

  function enemyNear(x, y, pad) {
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (Math.hypot(e.x - x, enemyCY(e) - y) < e.radius + pad) return e;
    }
    return null;
  }
  function enemyOnSegment(ax, ay, bx, by, pad) {
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (segDist(e.x, enemyCY(e), ax, ay, bx, by) < e.radius + pad) return e;
    }
    return null;
  }
  function hurtEnemiesOnSegment(ax, ay, bx, by, pad, dmg) {
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i];
      if (segDist(e.x, enemyCY(e), ax, ay, bx, by) < e.radius + pad) hitEnemy(e, dmg);
    }
  }
  function damageEnemiesAt(x, y, R, dmg) {
    if (!dmg) return 0;
    var n = 0;
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i], d = Math.hypot(e.x - x, enemyCY(e) - y);
      if (d < R + e.radius) { hitEnemy(e, d < e.radius ? dmg : dmg * 0.6); n++; }
    }
    return n;
  }
  function hitEnemy(e, dmg) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    e.hitT = 0.1;
    if (e.hp <= 0) destroyEnemy(e);
  }
  function destroyEnemy(e) {
    var idx = enemies.indexOf(e);
    if (idx >= 0) enemies.splice(idx, 1);
    var tank = e.kind === "tank", pts = tank ? 5 : 3, cy = enemyCY(e);
    if (tank) stats.tanks++; else stats.bombers++;
    sfx.play("boom", e.x, 1.3);
    for (var k = 0; k < 3; k++) spawnExplosionParticles(e.x + (Math.random() - 0.5) * 44, cy + (Math.random() - 0.5) * 24, 1.2);
    explodeAt(e.x, cy, { r: 52, killR: 80, mark: tank ? 1.2 : 0.8, shake: 14, particles: 1.4, dmg: 4 });
    spawnFloater(e.x, cy - 44, "+" + pts + (tank ? " 🔥 TANK DOWN!" : " ✈️ BOMBER DOWN!"), "#ffd24a", 18, 1.6);
    addScore(pts);
    registerKill(e.x, cy - 44);
  }

  function renderEnemies() {
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.kind === "tank") drawEnemyTank(e); else drawBomber(e);
      drawHpBar(e);
    }
    for (var j = 0; j < enemyShots.length; j++) {
      var s = enemyShots[j];
      ctx.globalAlpha = 0.85;
      ctx.drawImage(glowSprite("#ff3b2f"), s.x - 10, s.y - 10, 20, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = s.kind === "shell" ? "#3a0d08" : "#222222";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.kind === "shell" ? 4.8 : 4.4, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawEnemyTank(e) {
    var flash = e.hitT > 0;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.ellipse(0, 10, 31, 5, 0, 0, Math.PI * 2); ctx.fill();
    // tracks + road wheels
    ctx.fillStyle = "#1c1c1c"; roundRectPath(-29, -2, 58, 12, 6); ctx.fill();
    ctx.fillStyle = "#3b3b3b";
    for (var w = -21; w <= 21; w += 10.5) { ctx.beginPath(); ctx.arc(w, 4, 3.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#0c0c0c";
    var off = ((e.wheel % 6) + 6) % 6;
    for (var t = -28 + off; t < 27; t += 6) ctx.fillRect(t, 8.4, 3, 1.6);
    // hull
    ctx.fillStyle = flash ? "#ffffff" : "#7d2a1f";
    ctx.beginPath(); ctx.moveTo(-27, -2); ctx.lineTo(-22, -12); ctx.lineTo(22, -12); ctx.lineTo(28, -2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#3d120c"; ctx.lineWidth = 1.2; ctx.stroke();
    // barrel (absolute angle), drawn under the turret dome
    ctx.save();
    ctx.translate(0, -12); ctx.rotate(e.turret);
    ctx.fillStyle = "#2a2a2a"; ctx.fillRect(5 - e.recoil * 4, -2.2, 22, 4.4);
    ctx.fillStyle = "#141414"; ctx.fillRect(24 - e.recoil * 4, -3, 4, 6);
    ctx.restore();
    ctx.fillStyle = flash ? "#ffffff" : "#9a3a2c";
    ctx.beginPath(); ctx.arc(0, -12, 10, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = "#3d120c"; ctx.stroke();
    // star emblem
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    for (var p = 0; p < 10; p++) {
      var ang = -Math.PI / 2 + p * Math.PI / 5, rad = p % 2 ? 1.6 : 3.8;
      ctx.lineTo(e.dir * 12 + Math.cos(ang) * rad, -7 + Math.sin(ang) * rad);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function drawBomber(e) {
    var flash = e.hitT > 0, body = flash ? "#ffffff" : "#4a535c", dark = flash ? "#ffffff" : "#363d44";
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.dir, 1);
    ctx.fillStyle = dark;     // tail fin + stabiliser
    ctx.beginPath(); ctx.moveTo(-24, -2); ctx.lineTo(-33, -15); ctx.lineTo(-27, -15); ctx.lineTo(-17, -3); ctx.closePath(); ctx.fill();
    ctx.fillRect(-32, -1.5, 12, 3);
    ctx.fillStyle = body;     // fuselage
    ctx.beginPath(); ctx.ellipse(0, 0, 31, 7.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark;     // wing
    ctx.beginPath(); ctx.moveTo(-6, 1); ctx.lineTo(10, 1); ctx.lineTo(4, 9); ctx.lineTo(-14, 9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#9fd3ff";  // cockpit
    ctx.beginPath(); ctx.ellipse(17, -3, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c62d1f";  // roundel
    ctx.beginPath(); ctx.arc(-8, -1, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(225,225,225,0.55)";   // spinning propeller
    ctx.beginPath(); ctx.ellipse(32, 0, 1.6, 2 + 8 * Math.abs(Math.sin(e.prop)), 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawHpBar(e) {
    var w = 40, x = e.x - w / 2, y = e.kind === "tank" ? e.y - 38 : e.y - 26;
    var f = Math.max(0, e.hp / e.maxHp);
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(x - 1, y - 1, w + 2, 6);
    ctx.fillStyle = f > 0.5 ? "#5fd35f" : f > 0.25 ? "#ffcc33" : "#ff4d3d";
    ctx.fillRect(x, y, w * f, 4);
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
      ctx.textAlign = "left";
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
    var sw = Math.max(de.scrollWidth, de.clientWidth), sh = Math.max(de.scrollHeight, de.clientHeight);
    docMinX = rtlRoot ? de.clientWidth - sw - scrollX0 : -scrollX0;
    docMaxX = docMinX + sw;
    docMinY = -scrollY0;
    docMaxY = docMinY + sh;
    if (marksLayer) { var lr = marksLayer.getBoundingClientRect(); layerX = lr.left; layerY = lr.top; }
    var jobs = hlSupported ? 2 : 1;   // the span fallback splits text nodes, so one blast per frame
    for (var j = 0; j < jobs && blastQueue.length; j++) blastResults.push(readBlast(blastQueue.shift()));
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

  function updateSoundLoops() {
    var bomber = null;
    for (var i = 0; i < enemies.length && !bomber; i++) if (enemies[i].kind === "bomber") bomber = enemies[i];
    sfx.loop("flame", mode === "flame" && held && !introActive);
    sfx.loop("laser", !!laserBeam);
    sfx.loop("bomber", !!bomber, bomber && bomber.x);
  }

  function frame(ts) {
    var dt = Math.max(0, Math.min((ts-lastTime)/1000, 0.05));
    lastTime = ts;
    clock += dt;
    readPhase(dt);
    applyAim();                 // barrel/trajectory once per frame (decoupled from pointermove)
    updateWeapons(dt);          // hold-to-fire weapons (gun, rockets, flame, laser)
    writePhase();
    applyShake(dt);
    ctx.clearRect(0, 0, viewW, viewH);
    if (comboT > 0) comboT -= dt;
    updateBalls(dt);
    updateRockets(dt);
    updateBomblets(dt);
    updateBullets(dt);
    updateFlames(dt);
    updateBlood(dt);
    updateParticles(dt);
    updateDebris(dt);
    updateFlung(dt);
    updateSoldiers(dt);
    updateEnemies(dt);
    updateMarks();
    updateSoundLoops();
    renderCraters();
    renderDebris();
    renderBlood();
    renderTrajectoryPreview();
    renderLootTargets();
    renderSoldiers();
    renderEnemies();
    renderBalls();
    renderRockets();
    renderBomblets();
    renderBullets();
    renderFlames();
    renderLaser();
    renderGunReticle();
    renderParticles();
    renderFloaters();
  }

  /* ── START ───────────────────────────────────────────────────────────────── */
  document.documentElement.appendChild(wrapper);
  removeList.push(wrapper);
  marksLayer = document.createElement("div");
  marksLayer.setAttribute("data-cb-ui", "1");
  marksLayer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483644;";
  document.documentElement.appendChild(marksLayer);
  removeList.push(marksLayer);
  resizeCanvas();
  renderHUD();
  sfx.create();     // now, while nothing is animating yet (see SOUND)
  loadStats();
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
  // Esc exits; 1–6 / G (Shift+G back) pick a weapon, D toggles Danger, M mutes.
  // Other keys, and keys typed into fields, are left to the page.
  function onKey(e) {
    if (e.key === "Escape" || e.keyCode === 27) { destroy(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !e.key || e.key.length !== 1) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/.test(t.localName || ""))) return;
    var k = e.key.toLowerCase(), idx = "123456".indexOf(k);
    if (idx >= 0) selectWeapon(WEAPONS[idx].id);
    else if (k === "g") cycleWeapon(e.shiftKey ? -1 : 1);
    else if (k === "d") toggleDanger();
    else if (k === "m") toggleMute();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  window.addEventListener("keydown", onKey, true);

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
  window.addEventListener("pagehide",   flushStats, true);

  /* ── BLAST REPORT (end-of-game card) ─────────────────────────────────────────
     Shown when the player exits (Esc, Remove, the popup or the shortcut) after
     playing. The page is already restored underneath and stays fully usable:
     the card closes on Esc, ✕, any click on the page, or by itself after
     REPORT_SECONDS (hovering it pauses the timer). It lives in a shadow root
     so page styles can't reach it. */
  var REPORT_SECONDS = 10;
  var RANKS = [[0, "Rookie"], [5, "Gunner"], [15, "Demolition expert"], [30, "Page wrecker"],
               [60, "Chaos commander"], [100, "Legend of the blast"]];
  var REPORT_CSS = [
    ":host{all:initial}",
    ".card{box-sizing:border-box;position:relative;overflow:hidden;width:min(380px,calc(100vw - 24px));padding:14px 16px 16px;",
      "background:#15171a;color:#eee;border:1px solid rgba(255,210,74,.35);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.55);",
      "font:13px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;cursor:default}",
    ".x{all:unset;position:absolute;top:8px;right:10px;width:24px;height:24px;border-radius:8px;text-align:center;line-height:24px;",
      "font-size:14px;color:#aaa;cursor:pointer}",
    ".x:hover{background:rgba(255,255,255,.1);color:#fff}",
    ".top{display:flex;align-items:center;gap:8px;padding-right:28px}",
    ".title{font-weight:800;font-size:14px;letter-spacing:.6px;color:#ffd24a}",
    ".rank{font-size:11.5px;font-weight:700;color:#ff9a20;background:rgba(255,154,32,.13);border-radius:999px;padding:2px 8px}",
    ".score{display:flex;align-items:baseline;gap:6px;margin:6px 0 10px}",
    ".pts{font-size:34px;font-weight:800;line-height:1;color:#fff}",
    ".unit{font-size:13px;color:#aaa}",
    ".best{margin-left:auto;font-size:12px;font-weight:700;color:#9a9a9a}",
    ".best.new{color:#ffd24a}",
    ".grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}",
    ".tile{background:rgba(255,255,255,.06);border-radius:10px;padding:7px 8px;min-width:0}",
    ".v{font-size:16px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".l{font-size:10.5px;color:#9a9a9a;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".line{margin-top:9px;font-size:12px;color:#c8c8c8}",
    ".unlock{color:#ffd24a;font-weight:700}",
    ".foot{margin-top:9px;font-size:11px;color:#8a8a8a}",
    "kbd{font:600 11px/1 system-ui,sans-serif;color:#eee;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);",
      "border-radius:5px;padding:1px 5px}",
    ".bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.06)}",
    ".fill{height:100%;background:linear-gradient(90deg,#ff6a00,#ffd24a);transform-origin:left center}"
  ].join("");

  function fmtTime(sec) { var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
  function el(parent, tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  // Returns true if the card was shown.
  function showReport() {
    if (!stats.firstShotAt && !score) return false;           // launched and left without playing
    var host = document.createElement("div");
    host.id = "__cb_report";
    host.setAttribute("data-cb-ui", "1");
    host.style.cssText = "all:initial!important;display:block!important;position:fixed!important;left:50%!important;" +
      "bottom:24px!important;transform:translateX(-50%)!important;z-index:2147483647!important;" +
      "visibility:visible!important;opacity:1!important;pointer-events:auto!important;";
    var root = host.attachShadow({ mode: "open" });
    try {
      var sheet = new CSSStyleSheet();     // adopted sheets aren't blocked by a page's style CSP
      sheet.replaceSync(REPORT_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      el(root, "style", null, REPORT_CSS);
    }
    var card = el(root, "div", "card");
    card.setAttribute("role", "status");
    var x = el(card, "button", "x", "✕");
    x.title = "Close (Esc)";
    x.setAttribute("aria-label", "Close the blast report");

    var rank = RANKS[0][1];
    for (var r = 0; r < RANKS.length; r++) if (score >= RANKS[r][0]) rank = RANKS[r][1];
    var top = el(card, "div", "top");
    el(top, "span", "title", "💥 BLAST REPORT");
    el(top, "span", "rank", rank);

    var sc = el(card, "div", "score");
    el(sc, "span", "pts", String(score));
    el(sc, "span", "unit", score === 1 ? "point" : "points");
    var newBest = score > 0 && score > bestBefore;
    el(sc, "span", newBest ? "best new" : "best", newBest ? "🏆 New best!" : "🏆 Best " + best);

    var grid = el(card, "div", "grid");
    function tile(icon, value, label) {
      var t = el(grid, "div", "tile");
      el(t, "div", "v", icon + " " + value);
      el(t, "div", "l", label);
    }
    var secs = Math.max(1, Math.round((performance.now() - (stats.firstShotAt || performance.now())) / 1000));
    tile("🪖", stats.soldiers, stats.soldiers === 1 ? "soldier" : "soldiers");
    if (stats.tanks) tile("🛡️", stats.tanks, stats.tanks === 1 ? "tank" : "tanks");
    if (stats.bombers) tile("✈️", stats.bombers, stats.bombers === 1 ? "bomber" : "bombers");
    if (stats.letters) tile("🔤", stats.letters, stats.letters === 1 ? "letter" : "letters");
    if (stats.pieces) tile("🖼️", stats.pieces, "images & icons");
    if (stats.shots >= 5) tile("🎯", Math.round(stats.hits / stats.shots * 100) + "%", "accuracy");
    if (stats.bestCombo >= 2) tile("⚡", "×" + stats.bestCombo, "best combo");
    if (stolen) tile("😡", stolen, "stolen");
    tile("⏱️", fmtTime(secs), "time");

    var used = WEAPONS.filter(function (w) { return stats.used[w.id]; }).map(function (w) { return w.icon; });
    if (used.length) el(card, "div", "line", "Weapons: " + used.join(" "));
    if (stats.unlocked.length) {
      el(card, "div", "line unlock", "🔓 Unlocked: " + stats.unlocked.map(function (w) { return w.icon + " " + w.name.charAt(0) + w.name.slice(1).toLowerCase(); }).join(" · "));
    }
    var foot = el(card, "div", "foot", "Play again: click the BlastBlastBlast icon");
    if (launchInfo.shortcut) {
      foot.appendChild(document.createTextNode(" or press "));
      el(foot, "kbd", null, launchInfo.shortcut);
    }
    var fill = el(el(card, "div", "bar"), "div", "fill");
    document.documentElement.appendChild(host);

    var closed = false, timer = null, barAnim = null;
    function close(now) {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", onReportKey, true);
      window.removeEventListener("pointerdown", onReportDown, true);
      if (window.__cbCloseReport === close) window.__cbCloseReport = null;
      clearTimeout(timer);
      try { if (barAnim) barAnim.cancel(); } catch (e) {}
      if (now === true || !card.animate) { removeNode(host); return; }
      card.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 160, easing: "ease-in", fill: "forwards" })
        .onfinish = function () { removeNode(host); };
      setTimeout(function () { removeNode(host); }, 400);      // if the animation can't run (hidden tab)
    }
    function onReportKey(e) { if (e.key === "Escape" || e.keyCode === 27) close(); }
    function onReportDown(e) {
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) < 0) close();                     // clicks on the page close it and go through
    }
    x.addEventListener("click", function (e) { e.stopPropagation(); close(); });
    window.__cbCloseReport = close;
    // Listen from the next task, so the Esc / click that ended the game doesn't also close the card.
    setTimeout(function () {
      if (closed) return;
      window.addEventListener("keydown", onReportKey, true);
      window.addEventListener("pointerdown", onReportDown, true);
    }, 0);

    if (card.animate) {
      card.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }],
                   { duration: 220, easing: "cubic-bezier(.2,.9,.3,1.15)" });
      barAnim = fill.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
                             { duration: REPORT_SECONDS * 1000, easing: "linear", fill: "forwards" });
      barAnim.onfinish = function () { close(); };
      host.addEventListener("mouseenter", function () { if (!closed) barAnim.pause(); });
      host.addEventListener("mouseleave", function () { if (!closed) barAnim.play(); });
    } else {
      timer = setTimeout(close, REPORT_SECONDS * 1000);
    }
    return true;
  }

  /* ── TEARDOWN — restores the page completely ─────────────────────────────── */
  // Returns true if the blast report is now showing.
  function destroy() {
    if (!gameActive) return false;
    gameActive = false;
    held = false;
    if (animId) cancelAnimationFrame(animId);
    flushStats();
    clearTimeout(vigOffTimer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointermove", onGlobalMove, true);
    window.removeEventListener("pointerdown", onFirePointerDown, true);
    window.removeEventListener("pointerup",   onFirePointerUp, true);
    window.removeEventListener("pointercancel", onFirePointerUp, true);
    window.removeEventListener("blur",        onFirePointerUp, true);
    window.removeEventListener("mousedown",  onClickBlock, true);
    window.removeEventListener("click",      onClickBlock, true);
    window.removeEventListener("contextmenu", onClickBlock, true);
    window.removeEventListener("pagehide",   flushStats, true);
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
    rockets.length = bomblets.length = flames.length = enemies.length = enemyShots.length = 0;
    laserBeam = null;
    hiddenList.length = removeList.length = fbCreated.length = 0;
    fbOriginal.clear();
    lootPool = []; lootScan = null;

    // The page is back to normal; now show how it went.
    var reported = false;
    try { reported = showReport(); } catch (e) {}
    if (reported) sfx.play("chime", null, score > bestBefore && score > 0 ? 7 : 4);
    sfx.shutdown(reported ? 1800 : 0);

    window.__cannonBlastActive = false;
    delete window.__cannonBlastDestroy;
    return reported;
  }

  window.__cannonBlastDestroy = destroy;
}());

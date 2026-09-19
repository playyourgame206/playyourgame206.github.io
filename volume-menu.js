/**
 * Play Centre - Pull-Down Volume Control Menu
 * A master audio volume controller that drops down from the top of the page
 * when you tap the tab hanging from the top edge, or swipe down on it.
 * The level runs 0-1000%: 100% is normal volume, anything above is boost,
 * and 1000% is ten times normal with a limiter to keep it from clipping.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // State & Persistence
  // -------------------------------------------------------------------------
  const STORAGE_KEY_VOL = 'andy_master_pct';        // 0-1000, 100 = normal
  const STORAGE_KEY_MUTE = 'andy_master_muted';
  const LEVEL_KEY_VOL = 'andy_master_level';        // previous 0-100 scale (10 = normal)
  const LEGACY_KEY_VOL = 'andy_master_volume';      // oldest 0-300% scale
  const NORMAL = 100;    // 100% = gain 1.0
  const MAX_LEVEL = 1000; // gain 10.0
  const ULTRA = 500;     // above this the level is shown as "ultra"

  let currentVol = 80; // 0 to 1000 (%)
  // Where the pull tab hangs from the top edge. Default is top-centre; a page
  // that keeps its own HUD there sets data-position="top-right" on its
  // <script> tag and gets a smaller tab in the top-right corner instead.
  const scriptTag = document.currentScript;
  const TAB_POSITION = (scriptTag && scriptTag.getAttribute('data-position')) === 'top-right' ? 'top-right' : 'top';
  let isMuted = false;
  let isOpen = false;

  try {
    const savedV = localStorage.getItem(STORAGE_KEY_VOL);
    if (savedV !== null) {
      const parsed = parseInt(savedV, 10);
      if (!isNaN(parsed)) currentVol = Math.max(0, Math.min(MAX_LEVEL, parsed));
    } else {
      // migrate older saves: the 0-100 level scale (x10), or the first 0-300% scale (as is)
      const level = parseInt(localStorage.getItem(LEVEL_KEY_VOL), 10);
      const legacy = parseInt(localStorage.getItem(LEGACY_KEY_VOL), 10);
      if (!isNaN(level)) currentVol = Math.max(0, Math.min(MAX_LEVEL, level * 10));
      else if (!isNaN(legacy)) currentVol = Math.max(0, Math.min(MAX_LEVEL, legacy));
    }
    const savedM = localStorage.getItem(STORAGE_KEY_MUTE);
    if (savedM !== null) {
      isMuted = savedM === 'true';
    }
  } catch (e) {
    // localStorage may be restricted in some iframe contexts
  }

  function getEffectiveVolume() {
    return isMuted ? 0 : currentVol / NORMAL;
  }

  function isBoosted() {
    return !isMuted && currentVol > NORMAL;
  }

  function isUltraBoosted() {
    return !isMuted && currentVol > ULTRA;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY_VOL, String(currentVol));
      localStorage.setItem(STORAGE_KEY_MUTE, String(isMuted));
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Web Audio & Media Master Volume Interception (gain 0-10x, soft limiter while boosted)
  // -------------------------------------------------------------------------
  const activeGainNodes = new Set();
  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

  if (OrigAudioContext) {
    const origConnect = AudioNode.prototype.connect;

    // At normal level or below the games' audio goes master gain -> destination
    // and sounds exactly as they wrote it. While boosted, the signal is scaled
    // down by 10 so it fits the shaper's -1..1 input, then the shaper applies
    // tanh(10x): ten times gain for quiet sounds, smoothly flattening towards
    // full scale for loud ones, so nothing ever hard-clips. Unlike a
    // DynamicsCompressor it adds no makeup gain and no lookahead delay, so the
    // loudness is continuous across the normal/boost boundary.
    function masterGainValue() {
      const eff = getEffectiveVolume();
      return isBoosted() ? eff / 10 : eff;
    }
    function routeMaster(ctx) {
      const boosted = isBoosted();
      if (ctx.__andyBoostWired === boosted) return;
      const mg = ctx.__andyMasterGain, shaper = ctx.__andyLimiter;
      try { mg.disconnect(); } catch (e) {}
      try { shaper.disconnect(); } catch (e) {}
      if (boosted) {
        origConnect.call(mg, shaper);
        origConnect.call(shaper, ctx.destination);
      } else {
        origConnect.call(mg, ctx.destination);
      }
      ctx.__andyBoostWired = boosted;
    }
    let shaperCurve = null;
    function getShaperCurve() {
      if (!shaperCurve) {
        const N = 8192;
        shaperCurve = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const x = (i / (N - 1)) * 2 - 1;
          shaperCurve[i] = Math.tanh(10 * x);
        }
      }
      return shaperCurve;
    }

    function ensureMasterGain(ctx) {
      if (!ctx.__andyMasterGain) {
        try {
          // Master Gain Node: 0-1000% maps to gain 0.0 - 10.0
          const mg = ctx.createGain();
          mg.gain.setValueAtTime(masterGainValue(), ctx.currentTime);

          // Soft limiter for the boost range (see routeMaster)
          const shaper = ctx.createWaveShaper();
          shaper.curve = getShaperCurve();
          shaper.oversample = '2x';

          ctx.__andyMasterGain = mg;
          ctx.__andyLimiter = shaper;
          ctx.__andyBoostWired = null;
          routeMaster(ctx);
          activeGainNodes.add(mg);
        } catch (e) {
          return ctx.destination;
        }
      }
      return ctx.__andyMasterGain;
    }
    window.__andyRouteMaster = routeMaster;
    window.__andyMasterGainValue = masterGainValue;

    AudioNode.prototype.connect = function (destination, outputIndex, inputIndex) {
      if (destination && this.context && destination === this.context.destination) {
        const mg = ensureMasterGain(this.context);
        return origConnect.call(this, mg, outputIndex, inputIndex);
      }
      return origConnect.apply(this, arguments);
    };
  }

  function applyMasterVolume() {
    const eff = getEffectiveVolume();
    activeGainNodes.forEach(function (gain) {
      try {
        if (!gain.context || gain.context.state === 'closed') {
          activeGainNodes.delete(gain);   // finished contexts would otherwise pile up forever
          return;
        }
        gain.gain.setValueAtTime(window.__andyMasterGainValue ? window.__andyMasterGainValue() : eff, gain.context.currentTime);
        if (window.__andyRouteMaster) window.__andyRouteMaster(gain.context);
      } catch (e) {}
    });

    // Update standard HTML <audio> and <video> elements (HTML5 media elements cap at 1.0)
    document.querySelectorAll('audio, video').forEach(function (media) {
      try {
        media.volume = Math.min(1, eff);
      } catch (e) {}
    });

    // Dispatch event for any custom listeners
    window.dispatchEvent(
      new CustomEvent('andy:volumechange', {
        detail: {
          level: currentVol,
          volume: currentVol,
          muted: isMuted,
          effective: eff,
          boosted: isBoosted(),
          ultra: isUltraBoosted()
        }
      })
    );
  }

  // Preview test sound chime. It plays through the same master gain (and, when
  // boosted, the same limiter) that the games get, so what you hear is what
  // the games will sound like. One context is reused: browsers cap how many
  // can exist at once, and a fresh one per click stops working after a few.
  let chimeCtx = null;
  function playTestChime() {
    const eff = getEffectiveVolume();
    if (eff <= 0.001) return;
    try {
      const Actx = window.AudioContext || window.webkitAudioContext;
      if (!Actx) return;
      if (!chimeCtx || chimeCtx.state === 'closed') chimeCtx = new Actx();
      const ctx = chimeCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const master = ctx.destination;

      // 3-note cheerful arcade arpeggio (C5 -> E5 -> G5)
      const notes = [
        { f: 523.25, t: 0, d: 0.12 },
        { f: 659.25, t: 0.09, d: 0.12 },
        { f: 783.99, t: 0.18, d: 0.28 }
      ];

      notes.forEach(function (n) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.f, now + n.t);
        g.gain.setValueAtTime(0.0001, now + n.t);
        g.gain.exponentialRampToValueAtTime(0.5, now + n.t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
        osc.connect(g);
        g.connect(master);
        osc.start(now + n.t);
        osc.stop(now + n.t + n.d + 0.05);
      });

    } catch (e) {}
  }

  // Short single tick while the slider is being dragged, so the new level is
  // audible as it changes (throttled so a fast drag does not machine-gun).
  let lastTick = 0;
  function playTick() {
    const eff = getEffectiveVolume();
    if (eff <= 0.001) return;
    const t = Date.now();
    if (t - lastTick < 140) return;
    lastTick = t;
    try {
      const Actx = window.AudioContext || window.webkitAudioContext;
      if (!Actx) return;
      if (!chimeCtx || chimeCtx.state === 'closed') chimeCtx = new Actx();
      const ctx = chimeCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(783.99, now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.45, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // DOM & CSS Injection
  // -------------------------------------------------------------------------
  const STYLES = `
    /* Andy Play Centre Swipe-up Volume Menu */
    #andy-vol-trigger {
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99990;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: calc(4px + env(safe-area-inset-top, 0px)) 18px 6px;
      background: rgba(14, 18, 34, 0.88);
      border: 1px solid rgba(0, 242, 254, 0.4);
      border-top: none;
      border-radius: 0 0 16px 16px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 4px 20px rgba(0, 242, 254, 0.2);
      transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.2s, box-shadow 0.2s, border-color 0.2s;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    #andy-vol-trigger:hover {
      background: rgba(22, 28, 54, 0.95);
      border-color: #00f2fe;
      box-shadow: 0 6px 25px rgba(0, 242, 254, 0.4);
      transform: translateX(-50%) translateY(2px);
    }
    /* corner variant for pages that keep their own HUD at the top centre */
    #andy-vol-trigger.andy-pos-top-right {
      left: auto;
      right: 12px;
      transform: none;
      padding: calc(2px + env(safe-area-inset-top, 0px)) 12px 6px;
      border-radius: 0 0 14px 14px;
    }
    #andy-vol-trigger.andy-pos-top-right:hover {
      transform: translateY(2px);
    }
    #andy-vol-trigger.andy-pos-top-right .andy-pill { display: none; }
    #andy-vol-trigger.andy-pos-top-right .andy-arrow { display: none; }
    #andy-vol-trigger.andy-pos-top-right .andy-trigger-content { font-size: 11px; }
    #andy-vol-trigger.andy-trigger-boosted {
      border-color: #ffd60a;
      box-shadow: 0 4px 22px rgba(255, 214, 10, 0.45);
      background: rgba(26, 20, 10, 0.92);
    }
    #andy-vol-trigger.andy-trigger-ultra {
      border-color: #ff0055;
      box-shadow: 0 4px 24px rgba(255, 0, 85, 0.55), 0 0 10px rgba(255, 214, 10, 0.4);
      background: rgba(36, 8, 20, 0.95);
    }
    #andy-vol-trigger .andy-pill {
      width: 42px;
      height: 4px;
      border-radius: 99px;
      background: rgba(0, 242, 254, 0.7);
      order: 2;
      margin: 4px 0 0;
      transition: background 0.2s, width 0.2s;
    }
    #andy-vol-trigger.andy-trigger-boosted .andy-pill {
      background: #ffd60a;
    }
    #andy-vol-trigger.andy-trigger-ultra .andy-pill {
      background: #ff0055;
    }
    #andy-vol-trigger:hover .andy-pill {
      background: #00f2fe;
      width: 50px;
    }
    #andy-vol-trigger.andy-trigger-boosted:hover .andy-pill {
      background: #ffd60a;
    }
    #andy-vol-trigger.andy-trigger-ultra:hover .andy-pill {
      background: #ff0055;
    }
    #andy-vol-trigger .andy-trigger-content {
      order: 1;
      display: flex;
      align-items: center;
      gap: 7px;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      text-transform: uppercase;
    }
    #andy-vol-trigger .andy-arrow {
      color: #00f2fe;
      font-size: 10px;
      animation: andy-bounce 1.6s ease-in-out infinite;
    }
    #andy-vol-trigger.andy-trigger-boosted .andy-arrow {
      color: #ffd60a;
    }
    #andy-vol-trigger.andy-trigger-ultra .andy-arrow {
      color: #ff0055;
    }
    @keyframes andy-bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(3px); }
    }
    #andy-vol-trigger .andy-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 99px;
      background: rgba(0, 242, 254, 0.15);
      color: #00f2fe;
      border: 1px solid rgba(0, 242, 254, 0.3);
      font-variant-numeric: tabular-nums;
      transition: all 0.2s;
    }
    #andy-vol-trigger.andy-trigger-boosted .andy-badge {
      background: rgba(255, 214, 10, 0.22);
      color: #ffd60a;
      border-color: #ffd60a;
      box-shadow: 0 0 10px rgba(255, 214, 10, 0.5);
    }
    #andy-vol-trigger.andy-trigger-ultra .andy-badge {
      background: rgba(255, 0, 85, 0.25);
      color: #ff3377;
      border-color: #ff0055;
      box-shadow: 0 0 12px rgba(255, 0, 85, 0.7);
    }

    /* Dim Backdrop */
    #andy-vol-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 7, 15, 0.65);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      z-index: 99998;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.28s ease;
    }
    #andy-vol-backdrop.andy-open {
      opacity: 1;
      pointer-events: auto;
    }

    /* Bottom Sheet */
    #andy-vol-sheet {
      position: fixed;
      top: 0;
      left: 50%;
      width: 100%;
      max-width: 500px;
      max-height: 100vh;
      overflow-y: auto;
      transform: translate(-50%, -105%);
      z-index: 99999;
      background: rgba(14, 18, 36, 0.96);
      border: 1.5px solid rgba(0, 242, 254, 0.4);
      border-top: none;
      border-radius: 0 0 24px 24px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7), 0 2px 24px rgba(0, 242, 254, 0.25);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      color: #ffffff;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      padding: calc(14px + env(safe-area-inset-top, 0px)) 24px 10px;
      transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s, box-shadow 0.25s;
      box-sizing: border-box;
      touch-action: none;
    }
    #andy-vol-sheet.andy-open {
      transform: translate(-50%, 0);
    }
    #andy-vol-sheet.andy-sheet-boosted {
      border-color: rgba(255, 214, 10, 0.65);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.75), 0 2px 30px rgba(255, 214, 10, 0.3);
    }
    #andy-vol-sheet.andy-sheet-ultra {
      border-color: rgba(255, 0, 85, 0.75);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.8), 0 2px 34px rgba(255, 0, 85, 0.4);
    }

    /* Sheet drag handle zone (sits along the bottom edge of the dropped sheet) */
    .andy-sheet-grabber {
      width: 100%;
      padding: 10px 0 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: grab;
      touch-action: none;
    }
    .andy-sheet-grabber:active { cursor: grabbing; }
    .andy-sheet-bar {
      width: 48px;
      height: 5px;
      border-radius: 99px;
      background: rgba(255, 255, 255, 0.35);
      transition: background 0.2s, width 0.2s;
    }
    .andy-sheet-grabber:hover .andy-sheet-bar {
      background: #00f2fe;
      width: 58px;
    }
    #andy-vol-sheet.andy-sheet-boosted .andy-sheet-bar {
      background: rgba(255, 214, 10, 0.7);
    }
    #andy-vol-sheet.andy-sheet-ultra .andy-sheet-bar {
      background: rgba(255, 0, 85, 0.85);
    }

    /* Header */
    .andy-sheet-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .andy-sheet-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #ffffff;
      text-transform: uppercase;
    }
    .andy-sheet-title-icon {
      font-size: 1.4rem;
      filter: drop-shadow(0 0 8px rgba(0, 242, 254, 0.6));
    }
    .andy-sheet-close-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #cdd6f4;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .andy-sheet-close-btn:hover {
      background: rgba(255, 46, 136, 0.25);
      border-color: #ff2e88;
      color: #ffffff;
      transform: scale(1.08);
    }

    /* Volume Level Card */
    .andy-vol-display-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
    }
    .andy-vol-display-card.andy-card-boosted {
      background: rgba(255, 214, 10, 0.06);
      border-color: rgba(255, 214, 10, 0.35);
      box-shadow: 0 0 20px rgba(255, 214, 10, 0.12);
    }
    .andy-vol-display-card.andy-card-ultra {
      background: rgba(255, 0, 85, 0.08);
      border-color: rgba(255, 0, 85, 0.5);
      box-shadow: 0 0 24px rgba(255, 0, 85, 0.25);
    }
    .andy-vol-info {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .andy-vol-number {
      font-size: 2.2rem;
      font-weight: 900;
      color: #00f2fe;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 0 16px rgba(0, 242, 254, 0.4);
      line-height: 1;
      transition: color 0.2s, text-shadow 0.2s;
    }
    .andy-vol-number.andy-num-boosted {
      color: #ffd60a;
      text-shadow: 0 0 18px rgba(255, 214, 10, 0.7), 0 0 30px rgba(255, 46, 136, 0.4);
    }
    .andy-vol-number.andy-num-ultra {
      color: #ff0055;
      text-shadow: 0 0 20px rgba(255, 0, 85, 0.9), 0 0 35px rgba(255, 214, 10, 0.6);
    }
    .andy-vol-status-wrap {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .andy-vol-status-text {
      font-size: 0.82rem;
      color: #9aa3c7;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .andy-vol-boost-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.7rem;
      font-weight: 800;
      color: #ffd60a;
      background: rgba(255, 214, 10, 0.15);
      border: 1px solid rgba(255, 214, 10, 0.4);
      padding: 2px 7px;
      border-radius: 99px;
      width: fit-content;
      animation: andy-pulse-boost 1.6s ease-in-out infinite;
    }
    .andy-vol-boost-badge.andy-badge-ultra {
      color: #ffffff;
      background: linear-gradient(135deg, #ff0055, #ff5500);
      border-color: #ffd60a;
      box-shadow: 0 0 14px rgba(255, 0, 85, 0.7);
      animation: andy-pulse-ultra 1.2s ease-in-out infinite;
    }
    @keyframes andy-pulse-boost {
      0%, 100% { transform: scale(1); box-shadow: 0 0 6px rgba(255, 214, 10, 0.3); }
      50% { transform: scale(1.04); box-shadow: 0 0 12px rgba(255, 214, 10, 0.6); }
    }
    @keyframes andy-pulse-ultra {
      0%, 100% { transform: scale(1); box-shadow: 0 0 10px rgba(255, 0, 85, 0.6); }
      50% { transform: scale(1.06); box-shadow: 0 0 20px rgba(255, 214, 10, 0.8); }
    }

    .andy-header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .andy-action-btn {
      padding: 8px 13px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.06);
      color: #ffffff;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .andy-action-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.3);
      transform: translateY(-1px);
    }
    .andy-action-btn.andy-is-muted {
      background: rgba(255, 46, 136, 0.2);
      border-color: #ff2e88;
      color: #ff85b6;
      box-shadow: 0 0 14px rgba(255, 46, 136, 0.35);
    }
    .andy-ultra-btn {
      background: linear-gradient(135deg, rgba(255, 0, 85, 0.2), rgba(255, 214, 10, 0.25));
      border: 1px solid #ff0055;
      color: #ff3377;
      font-weight: 800;
      box-shadow: 0 0 14px rgba(255, 0, 85, 0.35);
    }
    .andy-ultra-btn:hover {
      background: linear-gradient(135deg, #ff0055, #ffd60a);
      color: #06121f;
      box-shadow: 0 0 24px rgba(255, 0, 85, 0.7);
      transform: translateY(-2px) scale(1.03);
    }
    .andy-ultra-btn.andy-ultra-active {
      background: linear-gradient(135deg, #ff0055, #ffd60a);
      color: #06121f;
      border-color: #ffffff;
      box-shadow: 0 0 24px rgba(255, 0, 85, 0.85);
    }

    /* Slider Container */
    .andy-slider-wrap {
      margin-bottom: 16px;
    }
    .andy-slider-row {
      display: flex;
      align-items: center;
      gap: 12px;
      position: relative;
    }
    .andy-slider-icon {
      font-size: 1.25rem;
      color: #9aa3c7;
      user-select: none;
      min-width: 24px;
      text-align: center;
    }
    .andy-slider-track-wrap {
      position: relative;
      width: 100%;
      display: flex;
      align-items: center;
      padding-top: 14px;
    }
    .andy-range-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 12px;
      border-radius: 99px;
      outline: none;
      cursor: pointer;
      transition: background 0.1s;
      z-index: 2;
    }
    .andy-range-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #ffffff;
      border: 3px solid #00f2fe;
      box-shadow: 0 0 16px rgba(0, 242, 254, 0.8);
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
    }
    .andy-range-slider.andy-slider-boosted::-webkit-slider-thumb {
      border-color: #ffd60a;
      box-shadow: 0 0 20px rgba(255, 214, 10, 1), 0 0 10px rgba(255, 46, 136, 0.7);
    }
    .andy-range-slider.andy-slider-ultra::-webkit-slider-thumb {
      border-color: #ff0055;
      box-shadow: 0 0 22px rgba(255, 0, 85, 1), 0 0 12px rgba(255, 214, 10, 0.9);
    }
    .andy-range-slider::-webkit-slider-thumb:hover {
      transform: scale(1.18);
    }
    .andy-range-slider::-moz-range-thumb {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #ffffff;
      border: 3px solid #00f2fe;
      box-shadow: 0 0 16px rgba(0, 242, 254, 0.8);
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
    }
    .andy-range-slider.andy-slider-boosted::-moz-range-thumb {
      border-color: #ffd60a;
      box-shadow: 0 0 20px rgba(255, 214, 10, 1);
    }
    .andy-range-slider.andy-slider-ultra::-moz-range-thumb {
      border-color: #ff0055;
      box-shadow: 0 0 22px rgba(255, 0, 85, 1);
    }

    /* Slider Notches for 100% and 200% marks */
    .andy-notch {
      position: absolute;
      top: 9px;
      bottom: -4px;
      width: 2px;
      background: rgba(255, 255, 255, 0.35);
      z-index: 1;
      pointer-events: none;
    }
    .andy-notch-label {
      position: absolute;
      top: -3px;
      transform: translateX(-50%);
      font-size: 0.65rem;
      font-weight: 700;
      color: #9aa3c7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      pointer-events: none;
    }
    .andy-notch-100 { left: 10%; }
    .andy-notch-200 { left: 50%; }

    /* Quick Presets Grid */
    .andy-presets-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .andy-presets-label {
      font-size: 0.75rem;
      font-weight: 700;
      color: #9aa3c7;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .andy-presets-boost-tag {
      font-size: 0.72rem;
      font-weight: 800;
      color: #ff3377;
      letter-spacing: 0.5px;
    }
    .andy-presets-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 6px;
      margin-bottom: 16px;
    }
    .andy-preset-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 8px 3px;
      color: #cdd6f4;
      font-size: 0.8rem;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
      transition: all 0.18s;
      font-variant-numeric: tabular-nums;
    }
    .andy-preset-btn:hover {
      background: rgba(0, 242, 254, 0.12);
      border-color: #00f2fe;
      color: #ffffff;
      transform: translateY(-1px);
    }
    .andy-preset-btn.andy-active {
      background: rgba(0, 242, 254, 0.22);
      border-color: #00f2fe;
      color: #00f2fe;
      box-shadow: 0 0 12px rgba(0, 242, 254, 0.4);
    }
    .andy-preset-btn.andy-preset-boost {
      border-color: rgba(255, 214, 10, 0.4);
      color: #ffd60a;
    }
    .andy-preset-btn.andy-preset-boost:hover {
      background: rgba(255, 214, 10, 0.18);
      border-color: #ffd60a;
      color: #ffffff;
    }
    .andy-preset-btn.andy-preset-boost.andy-active {
      background: linear-gradient(135deg, rgba(255, 214, 10, 0.35), rgba(255, 46, 136, 0.35));
      border-color: #ffd60a;
      color: #ffd60a;
      box-shadow: 0 0 14px rgba(255, 214, 10, 0.6);
    }
    .andy-preset-btn.andy-preset-ultra {
      border-color: rgba(255, 0, 85, 0.5);
      color: #ff3377;
    }
    .andy-preset-btn.andy-preset-ultra:hover {
      background: rgba(255, 0, 85, 0.25);
      border-color: #ff0055;
      color: #ffffff;
    }
    .andy-preset-btn.andy-preset-ultra.andy-active {
      background: linear-gradient(135deg, #ff0055, #ffd60a);
      border-color: #ffffff;
      color: #06121f;
      box-shadow: 0 0 16px rgba(255, 0, 85, 0.85);
    }

    /* Test Sound & Swipe Hint Row */
    .andy-footer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .andy-test-btn {
      padding: 10px 18px;
      border-radius: 12px;
      background: linear-gradient(135deg, #00f2fe, #4facfe);
      border: none;
      color: #06121f;
      font-size: 0.85rem;
      font-weight: 800;
      letter-spacing: 0.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      box-shadow: 0 4px 16px rgba(0, 242, 254, 0.35);
    }
    .andy-test-btn:hover {
      transform: scale(1.04);
      box-shadow: 0 6px 22px rgba(0, 242, 254, 0.55);
    }
    .andy-test-btn.andy-test-boosted {
      background: linear-gradient(135deg, #ffd60a, #ff2e88);
      box-shadow: 0 4px 18px rgba(255, 214, 10, 0.45);
    }
    .andy-test-btn.andy-test-ultra {
      background: linear-gradient(135deg, #ff0055, #ffd60a);
      box-shadow: 0 4px 20px rgba(255, 0, 85, 0.65);
    }
    .andy-test-btn:active {
      transform: scale(0.96);
    }
    .andy-swipe-hint {
      font-size: 0.76rem;
      color: #7b84a9;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    @media (max-width: 480px) {
      #andy-vol-sheet {
        border-radius: 0 0 20px 20px;
        padding: calc(12px + env(safe-area-inset-top, 0px)) 16px 8px;
      }
      .andy-vol-number { font-size: 1.8rem; }
      .andy-presets-grid { gap: 4px; }
      .andy-preset-btn { font-size: 0.72rem; padding: 7px 2px; }
      .andy-action-btn { padding: 7px 9px; font-size: 0.75rem; }
    }
  `;

  function injectDOM() {
    // Inject CSS
    const styleEl = document.createElement('style');
    styleEl.id = 'andy-vol-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    // Inject Bottom Trigger Tab
    const triggerEl = document.createElement('div');
    triggerEl.id = 'andy-vol-trigger';
    if (TAB_POSITION === 'top-right') triggerEl.classList.add('andy-pos-top-right');
    triggerEl.setAttribute('role', 'button');
    triggerEl.setAttribute('aria-label', 'Open volume control menu (or swipe down)');
    triggerEl.innerHTML = `
      <div class="andy-pill"></div>
      <div class="andy-trigger-content">
        <span class="andy-arrow">▼</span>
        <span id="andy-trigger-icon">🔊</span>
        <span>Volume</span>
        <span class="andy-badge" id="andy-trigger-pct">${isMuted ? 'Muted' : currentVol + '%'}</span>
      </div>
    `;
    document.body.appendChild(triggerEl);

    // Inject Backdrop
    const backdropEl = document.createElement('div');
    backdropEl.id = 'andy-vol-backdrop';
    document.body.appendChild(backdropEl);

    // Inject Bottom Sheet
    const sheetEl = document.createElement('div');
    sheetEl.id = 'andy-vol-sheet';
    sheetEl.setAttribute('role', 'dialog');
    sheetEl.setAttribute('aria-modal', 'true');
    sheetEl.setAttribute('aria-label', 'Sound and Volume Controls');
    sheetEl.innerHTML = `
      <div class="andy-sheet-header">
        <div class="andy-sheet-title">
          <span class="andy-sheet-title-icon" id="andy-title-icon">🔊</span>
          <span>Sound & Volume</span>
        </div>
        <button class="andy-sheet-close-btn" id="andy-close-btn" title="Close menu">✕</button>
      </div>

      <div class="andy-vol-display-card" id="andy-vol-card">
        <div class="andy-vol-info">
          <div class="andy-vol-number" id="andy-vol-num">${isMuted ? '0%' : currentVol + '%'}</div>
          <div class="andy-vol-status-wrap">
            <div class="andy-vol-status-text" id="andy-vol-status">${isMuted ? 'Muted' : 'Level'}</div>
            <div class="andy-vol-boost-badge" id="andy-boost-badge" style="display: ${isBoosted() ? 'inline-flex' : 'none'};">⚡ BOOSTED</div>
          </div>
        </div>
        <div class="andy-header-actions">
          <button class="andy-action-btn andy-ultra-btn" id="andy-ultra-btn" title="Jump to the maximum level (ten times normal)">
            <span>💥</span>
            <span>Max</span>
          </button>
          <button class="andy-action-btn ${isMuted ? 'andy-is-muted' : ''}" id="andy-mute-toggle">
            <span id="andy-mute-btn-icon">${isMuted ? '🔇' : '🔊'}</span>
            <span id="andy-mute-btn-text">${isMuted ? 'Unmute' : 'Mute'}</span>
          </button>
        </div>
      </div>

      <div class="andy-slider-wrap">
        <div class="andy-slider-row">
          <span class="andy-slider-icon" id="andy-slider-icon-left">🔈</span>
          <div class="andy-slider-track-wrap">
            <div class="andy-notch andy-notch-100"></div>
            <div class="andy-notch-label andy-notch-100">Normal</div>
            <div class="andy-notch andy-notch-200"></div>
            <div class="andy-notch-label andy-notch-200">Ultra</div>
            <input
              type="range"
              min="0"
              max="1000"
              value="${currentVol}"
              class="andy-range-slider ${isUltraBoosted() ? 'andy-slider-ultra' : (isBoosted() ? 'andy-slider-boosted' : '')}"
              id="andy-vol-slider"
              aria-label="Volume (0% to 1000%, 100% is normal)"
            />
          </div>
          <span class="andy-slider-icon" id="andy-slider-icon-right">💥</span>
        </div>
      </div>

      <div class="andy-presets-header">
        <div class="andy-presets-label">Quick Presets</div>
        <div class="andy-presets-boost-tag">Boost zone (101% - 1000%) 💥</div>
      </div>
      <div class="andy-presets-grid">
        <button class="andy-preset-btn" data-val="0">Mute</button>
        <button class="andy-preset-btn" data-val="50">50%</button>
        <button class="andy-preset-btn" data-val="100">100%</button>
        <button class="andy-preset-btn andy-preset-boost" data-val="250">250% ⚡</button>
        <button class="andy-preset-btn andy-preset-boost" data-val="500">500% 🔥</button>
        <button class="andy-preset-btn andy-preset-ultra" data-val="1000">1000% 💥</button>
      </div>

      <div class="andy-footer-row">
        <button class="andy-test-btn ${isUltraBoosted() ? 'andy-test-ultra' : (isBoosted() ? 'andy-test-boosted' : '')}" id="andy-test-sound-btn">
          <span>🎵</span>
          <span>Test Sound</span>
        </button>
        <div class="andy-swipe-hint">
          <span>▲ Swipe up to close</span>
        </div>
      </div>
      <div class="andy-sheet-grabber" id="andy-sheet-grabber" title="Swipe up to close">
        <div class="andy-sheet-bar"></div>
      </div>
    `;
    document.body.appendChild(sheetEl);

    bindEvents();
    updateUI();
  }

  // -------------------------------------------------------------------------
  // UI Sync & Helper functions
  // -------------------------------------------------------------------------
  function getVolumeIcon(pct, muted) {
    if (muted || pct === 0) return '🔇';
    if (pct <= 35) return '🔈';
    if (pct <= 70) return '🔉';
    if (pct <= NORMAL) return '🔊';
    if (pct <= ULTRA) return '⚡';
    return '💥';
  }

  function updateSliderBackground(sliderEl) {
    if (!sliderEl) return;
    const val = isMuted ? 0 : currentVol; // 0 to 1000
    const pos = val / 10, nPos = NORMAL / 10, uPos = ULTRA / 10; // % of the bar width
    const rest = `rgba(255,255,255,0.12) ${pos}%, rgba(255,255,255,0.12) 100%`;

    if (val <= NORMAL) {
      // Normal range: Cyan to Blue
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe ${pos}%, ${rest})`;
    } else if (val <= ULTRA) {
      // Boost: Neon Gold
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe ${nPos}%, #ffd60a ${pos}%, ${rest})`;
    } else {
      // Ultra: Fiery Hot Pink & Crimson
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe ${nPos}%, #ffd60a ${uPos}%, #ff0055 ${pos}%, ${rest})`;
    }
  }

  function updateUI() {
    const slider = document.getElementById('andy-vol-slider');
    const volNum = document.getElementById('andy-vol-num');
    const volStatus = document.getElementById('andy-vol-status');
    const volCard = document.getElementById('andy-vol-card');
    const boostBadge = document.getElementById('andy-boost-badge');
    const ultraBtn = document.getElementById('andy-ultra-btn');
    const muteBtn = document.getElementById('andy-mute-toggle');
    const muteIcon = document.getElementById('andy-mute-btn-icon');
    const muteText = document.getElementById('andy-mute-btn-text');
    const trigger = document.getElementById('andy-vol-trigger');
    const triggerPct = document.getElementById('andy-trigger-pct');
    const triggerIcon = document.getElementById('andy-trigger-icon');
    const titleIcon = document.getElementById('andy-title-icon');
    const sheet = document.getElementById('andy-vol-sheet');
    const testBtn = document.getElementById('andy-test-sound-btn');

    const boosted = isBoosted();
    const ultra = isUltraBoosted();
    const icon = getVolumeIcon(currentVol, isMuted);

    if (slider) {
      slider.value = currentVol;
      slider.classList.toggle('andy-slider-boosted', boosted && !ultra);
      slider.classList.toggle('andy-slider-ultra', ultra);
      updateSliderBackground(slider);
    }
    if (volNum) {
      volNum.textContent = isMuted ? '0%' : currentVol + '%';
      volNum.classList.toggle('andy-num-boosted', boosted && !ultra);
      volNum.classList.toggle('andy-num-ultra', ultra);
      if (isMuted) {
        volNum.style.color = '#ff2e88';
      } else if (!boosted) {
        volNum.style.color = '#00f2fe';
      }
    }
    if (volStatus) {
      if (isMuted) {
        volStatus.textContent = 'Muted';
      } else if (currentVol === 0) {
        volStatus.textContent = 'Silent';
      } else if (currentVol === MAX_LEVEL) {
        volStatus.textContent = 'MAX · 10× normal';
      } else if (ultra) {
        volStatus.textContent = 'Ultra boost · ' + (currentVol / NORMAL).toFixed(1) + '× normal';
      } else if (boosted) {
        volStatus.textContent = 'Boost · ' + (currentVol / NORMAL).toFixed(1) + '× normal';
      } else if (currentVol === NORMAL) {
        volStatus.textContent = 'Normal';
      } else {
        volStatus.textContent = 'Quiet';
      }
    }
    if (boostBadge) {
      boostBadge.style.display = boosted ? 'inline-flex' : 'none';
      boostBadge.classList.toggle('andy-badge-ultra', ultra);
      if (currentVol === MAX_LEVEL) {
        boostBadge.textContent = '💥 MAXIMUM · 1000%';
      } else if (ultra) {
        boostBadge.textContent = `🔥 ULTRA · ${currentVol}%`;
      } else {
        boostBadge.textContent = `⚡ BOOST · ${currentVol}%`;
      }
    }
    if (volCard) {
      volCard.classList.toggle('andy-card-boosted', boosted && !ultra);
      volCard.classList.toggle('andy-card-ultra', ultra);
    }
    if (sheet) {
      sheet.classList.toggle('andy-sheet-boosted', boosted && !ultra);
      sheet.classList.toggle('andy-sheet-ultra', ultra);
    }
    if (trigger) {
      trigger.classList.toggle('andy-trigger-boosted', boosted && !ultra);
      trigger.classList.toggle('andy-trigger-ultra', ultra);
    }
    if (ultraBtn) {
      ultraBtn.classList.toggle('andy-ultra-active', !isMuted && currentVol === MAX_LEVEL);
    }
    if (testBtn) {
      testBtn.classList.toggle('andy-test-boosted', boosted && !ultra);
      testBtn.classList.toggle('andy-test-ultra', ultra);
    }
    if (muteBtn) {
      if (isMuted) {
        muteBtn.classList.add('andy-is-muted');
        muteIcon.textContent = '🔇';
        muteText.textContent = 'Unmute';
      } else {
        muteBtn.classList.remove('andy-is-muted');
        muteIcon.textContent = '🔊';
        muteText.textContent = 'Mute';
      }
    }
    if (triggerPct) {
      if (isMuted) {
        triggerPct.textContent = 'Muted';
        triggerPct.style.color = '#ff85b6';
      } else if (ultra) {
        triggerPct.textContent = `💥 ${currentVol}%`;
        triggerPct.style.color = '#ff0055';
      } else if (boosted) {
        triggerPct.textContent = `⚡ ${currentVol}%`;
        triggerPct.style.color = '#ffd60a';
      } else {
        triggerPct.textContent = `${currentVol}%`;
        triggerPct.style.color = '#00f2fe';
      }
    }
    if (triggerIcon) triggerIcon.textContent = icon;
    if (titleIcon) titleIcon.textContent = icon;

    // Update preset button active states
    document.querySelectorAll('.andy-preset-btn').forEach(function (btn) {
      const v = parseInt(btn.getAttribute('data-val'), 10);
      if (isMuted) {
        btn.classList.toggle('andy-active', v === 0);
      } else {
        btn.classList.toggle('andy-active', v === currentVol);
      }
    });
  }

  function setVolume(val) {
    currentVol = Math.max(0, Math.min(MAX_LEVEL, Math.round(val)));
    if (isMuted && currentVol > 0) {
      isMuted = false;
    }
    saveSettings();
    applyMasterVolume();
    updateUI();
  }

  function toggleMute() {
    isMuted = !isMuted;
    saveSettings();
    applyMasterVolume();
    updateUI();
  }

  function toggleMax() {
    if (isMuted || currentVol !== MAX_LEVEL) {
      isMuted = false;
      setVolume(MAX_LEVEL);
      playTestChime();
    } else {
      // Toggle back to normal
      setVolume(NORMAL);
      playTestChime();
    }
  }

  function openMenu() {
    isOpen = true;
    const sheet = document.getElementById('andy-vol-sheet');
    const backdrop = document.getElementById('andy-vol-backdrop');
    const trigger = document.getElementById('andy-vol-trigger');
    if (sheet) sheet.classList.add('andy-open');
    if (backdrop) backdrop.classList.add('andy-open');
    if (trigger) trigger.style.opacity = '0';
  }

  function closeMenu() {
    isOpen = false;
    const sheet = document.getElementById('andy-vol-sheet');
    const backdrop = document.getElementById('andy-vol-backdrop');
    const trigger = document.getElementById('andy-vol-trigger');
    if (sheet) {
      sheet.classList.remove('andy-open');
      sheet.style.transform = ''; // Clear manual drag transforms
    }
    if (backdrop) backdrop.classList.remove('andy-open');
    if (trigger) trigger.style.opacity = '1';
  }

  // -------------------------------------------------------------------------
  // Gestures & Interaction Event Listeners
  // -------------------------------------------------------------------------
  function bindEvents() {
    const trigger = document.getElementById('andy-vol-trigger');
    const backdrop = document.getElementById('andy-vol-backdrop');
    const closeBtn = document.getElementById('andy-close-btn');
    const muteBtn = document.getElementById('andy-mute-toggle');
    const ultraBtn = document.getElementById('andy-ultra-btn');
    const slider = document.getElementById('andy-vol-slider');
    const testBtn = document.getElementById('andy-test-sound-btn');
    const grabber = document.getElementById('andy-sheet-grabber');
    const sheet = document.getElementById('andy-vol-sheet');

    // Trigger click
    if (trigger) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        openMenu();
      });
    }

    // Backdrop click
    if (backdrop) {
      backdrop.addEventListener('click', closeMenu);
    }

    // Close button click
    if (closeBtn) {
      closeBtn.addEventListener('click', closeMenu);
    }

    // Mute toggle click
    if (muteBtn) {
      muteBtn.addEventListener('click', function () {
        toggleMute();
        if (!isMuted) playTestChime();
      });
    }

    // Max button
    if (ultraBtn) {
      ultraBtn.addEventListener('click', function () {
        toggleMax();
      });
    }

    // Slider input & change (0 - 1000)
    if (slider) {
      slider.addEventListener('input', function () {
        setVolume(this.value);
        playTick();
      });
      slider.addEventListener('change', function () {
        playTestChime();
      });
    }

    // Presets
    document.querySelectorAll('.andy-preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const val = parseInt(this.getAttribute('data-val'), 10);
        if (val === 0) {
          isMuted = true;
          saveSettings();
          applyMasterVolume();
          updateUI();
        } else {
          isMuted = false;
          setVolume(val);
          playTestChime();
        }
      });
    });

    // Test Sound button
    if (testBtn) {
      testBtn.addEventListener('click', function () {
        if (isMuted) {
          isMuted = false;
          updateUI();
          saveSettings();
          applyMasterVolume();
        }
        playTestChime();
      });
    }

    // Escape key closes menu
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) {
        closeMenu();
      }
    });

    // -----------------------------------------------------------------------
    // Gesture 1: SWIPE DOWN ON THE PULL TAB (Touch & Mouse)
    // Only a touch that begins on the tab counts, so the games' own touch
    // controls never open this by accident.
    // -----------------------------------------------------------------------
    let touchStartY = null;
    let touchStartX = null;
    let isTrackingSwipeUp = false;

    window.addEventListener(
      'touchstart',
      function (e) {
        if (isOpen) return;
        const touch = e.touches[0];
        if (e.target.closest && e.target.closest('#andy-vol-trigger')) {
          touchStartY = touch.clientY;
          touchStartX = touch.clientX;
          isTrackingSwipeUp = true;
        }
      },
      { passive: true }
    );

    window.addEventListener(
      'touchmove',
      function (e) {
        if (!isTrackingSwipeUp || touchStartY === null) return;
        const touch = e.touches[0];
        const dy = touch.clientY - touchStartY; // positive when swiping DOWN
        const dx = Math.abs(touch.clientX - touchStartX);

        // If swiping downwards by more than 35px and predominantly vertical
        if (dy > 35 && dy > dx) {
          isTrackingSwipeUp = false;
          openMenu();
        }
      },
      { passive: true }
    );

    window.addEventListener(
      'touchend',
      function () {
        isTrackingSwipeUp = false;
        touchStartY = null;
      },
      { passive: true }
    );

    // Mouse drag-down support on trigger
    let mouseStartY = null;
    if (trigger) {
      trigger.addEventListener('mousedown', function (e) {
        mouseStartY = e.clientY;
      });
      window.addEventListener('mousemove', function (e) {
        if (mouseStartY !== null && !isOpen) {
          if (e.clientY - mouseStartY > 30) {
            mouseStartY = null;
            openMenu();
          }
        }
      });
      window.addEventListener('mouseup', function () {
        mouseStartY = null;
      });
    }

    // -----------------------------------------------------------------------
    // Gesture 2: SWIPE UP ON SHEET TO CLOSE
    // -----------------------------------------------------------------------
    let sheetStartY = null;
    let sheetCurrentDy = 0;

    function onSheetDragStart(clientY) {
      sheetStartY = clientY;
      sheetCurrentDy = 0;
      sheet.style.transition = 'none';
    }

    function onSheetDragMove(clientY) {
      if (sheetStartY === null) return;
      const dy = clientY - sheetStartY;
      if (dy < 0) {
        // Dragging upwards
        sheetCurrentDy = dy;
        sheet.style.transform = `translate(-50%, ${dy}px)`;
      }
    }

    function onSheetDragEnd() {
      if (sheetStartY === null) return;
      sheet.style.transition = '';
      if (sheetCurrentDy < -75) {
        closeMenu();
      } else {
        sheet.style.transform = '';
      }
      sheetStartY = null;
      sheetCurrentDy = 0;
    }

    // Touch events for drag-up on sheet grabber and header
    const dragTargets = [grabber, sheet.querySelector('.andy-sheet-header')];
    dragTargets.forEach(function (el) {
      if (!el) return;
      el.addEventListener(
        'touchstart',
        function (e) {
          onSheetDragStart(e.touches[0].clientY);
        },
        { passive: true }
      );
      el.addEventListener(
        'touchmove',
        function (e) {
          onSheetDragMove(e.touches[0].clientY);
        },
        { passive: true }
      );
      el.addEventListener('touchend', onSheetDragEnd, { passive: true });
    });
  }

  // -------------------------------------------------------------------------
  // Init on DOM ready
  // -------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDOM);
  } else {
    injectDOM();
  }

  // Initial volume application
  applyMasterVolume();

  // Expose API on window for scripts or games
  window.AndyVolume = {
    getVolume: function () { return currentVol; },
    setVolume: setVolume,
    isMuted: function () { return isMuted; },
    setMuted: function (m) { isMuted = !!m; saveSettings(); applyMasterVolume(); updateUI(); },
    isBoosted: isBoosted,
    isUltra: isUltraBoosted,
    max: function () { toggleMax(); },
    ultra300: function () { toggleMax(); },
    open: openMenu,
    close: closeMenu,
    toggle: function () { if (isOpen) closeMenu(); else openMenu(); },
    playTestSound: playTestChime
  };
})();

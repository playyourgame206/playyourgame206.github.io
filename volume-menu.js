/**
 * Play Centre - Swipe-Up Volume Control Menu
 * Provides a persistent master audio volume controller accessible by swiping up
 * from the bottom of the page (or tapping/clicking the bottom pull handle).
 * Supports up to 300% Ultra Volume Overdrive with studio-grade limiter compression.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // State & Persistence
  // -------------------------------------------------------------------------
  const STORAGE_KEY_VOL = 'andy_master_volume';
  const STORAGE_KEY_MUTE = 'andy_master_muted';

  let currentVol = 80; // 0 to 300%
  // Where the pull tab lives. Default is bottom-centre; a page whose own UI owns
  // the bottom edge (the Windows taskbar games) sets data-position="top-right"
  // on its <script> tag and gets a small tab hanging from the top corner.
  const scriptTag = document.currentScript;
  const TAB_POSITION = (scriptTag && scriptTag.getAttribute('data-position')) === 'top-right' ? 'top-right' : 'bottom';
  let isMuted = false;
  let isOpen = false;

  try {
    const savedV = localStorage.getItem(STORAGE_KEY_VOL);
    if (savedV !== null) {
      const parsed = parseInt(savedV, 10);
      if (!isNaN(parsed)) currentVol = Math.max(0, Math.min(300, parsed));
    }
    const savedM = localStorage.getItem(STORAGE_KEY_MUTE);
    if (savedM !== null) {
      isMuted = savedM === 'true';
    }
  } catch (e) {
    // localStorage may be restricted in some iframe contexts
  }

  function getEffectiveVolume() {
    return isMuted ? 0 : currentVol / 100;
  }

  function isBoosted() {
    return !isMuted && currentVol > 100;
  }

  function isUltraBoosted() {
    return !isMuted && currentVol > 200;
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY_VOL, String(currentVol));
      localStorage.setItem(STORAGE_KEY_MUTE, String(isMuted));
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Web Audio & Media Master Volume Interception (Supports up to 300% Gain with Limiter)
  // -------------------------------------------------------------------------
  const activeGainNodes = new Set();
  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

  if (OrigAudioContext) {
    const origConnect = AudioNode.prototype.connect;

    // At 100% or below the games' audio goes master gain -> destination and
    // sounds exactly as they wrote it. The limiter is only wired in while the
    // volume is boosted above 100%, where it stops the extra gain clipping.
    function routeMaster(ctx) {
      const boosted = isBoosted();
      if (ctx.__andyBoostWired === boosted) return;
      const mg = ctx.__andyMasterGain, compressor = ctx.__andyCompressor;
      try { mg.disconnect(); } catch (e) {}
      try { compressor.disconnect(); } catch (e) {}
      if (boosted) {
        origConnect.call(mg, compressor);
        origConnect.call(compressor, ctx.destination);
      } else {
        origConnect.call(mg, ctx.destination);
      }
      ctx.__andyBoostWired = boosted;
    }

    function ensureMasterGain(ctx) {
      if (!ctx.__andyMasterGain) {
        try {
          // Master Gain Node for 0% - 300% amplification (0.0 to 3.0x gain)
          const mg = ctx.createGain();
          mg.gain.setValueAtTime(getEffectiveVolume(), ctx.currentTime);

          // Studio Dynamics Compressor / Limiter prevents harsh digital clipping at 300%
          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-4, ctx.currentTime);
          compressor.knee.setValueAtTime(8, ctx.currentTime);
          compressor.ratio.setValueAtTime(12, ctx.currentTime);
          compressor.attack.setValueAtTime(0.002, ctx.currentTime);
          compressor.release.setValueAtTime(0.1, ctx.currentTime);

          ctx.__andyMasterGain = mg;
          ctx.__andyCompressor = compressor;
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
        gain.gain.setValueAtTime(eff, gain.context.currentTime);
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
          volume: currentVol,
          muted: isMuted,
          effective: eff,
          boosted: currentVol > 100,
          ultra: currentVol > 200
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
        g.gain.exponentialRampToValueAtTime(0.24, now + n.t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
        osc.connect(g);
        g.connect(master);
        osc.start(now + n.t);
        osc.stop(now + n.t + n.d + 0.05);
      });

    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // DOM & CSS Injection
  // -------------------------------------------------------------------------
  const STYLES = `
    /* Andy Play Centre Swipe-up Volume Menu */
    #andy-vol-trigger {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99990;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 6px 18px 4px;
      background: rgba(14, 18, 34, 0.88);
      border: 1px solid rgba(0, 242, 254, 0.4);
      border-bottom: none;
      border-radius: 16px 16px 0 0;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 -4px 20px rgba(0, 242, 254, 0.2);
      transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.2s, box-shadow 0.2s, border-color 0.2s;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    #andy-vol-trigger:hover {
      background: rgba(22, 28, 54, 0.95);
      border-color: #00f2fe;
      box-shadow: 0 -6px 25px rgba(0, 242, 254, 0.4);
      transform: translateX(-50%) translateY(-2px);
    }
    /* corner variant: hangs from the top edge, out of the way of a bottom taskbar */
    #andy-vol-trigger.andy-pos-top-right {
      bottom: auto;
      top: 0;
      left: auto;
      right: 12px;
      transform: none;
      padding: 4px 12px 6px;
      border: 1px solid rgba(0, 242, 254, 0.4);
      border-top: none;
      border-radius: 0 0 14px 14px;
      box-shadow: 0 4px 20px rgba(0, 242, 254, 0.2);
      touch-action: none;
    }
    #andy-vol-trigger.andy-pos-top-right:hover {
      transform: translateY(2px);
      box-shadow: 0 6px 25px rgba(0, 242, 254, 0.4);
    }
    #andy-vol-trigger.andy-pos-top-right .andy-pill { display: none; }
    #andy-vol-trigger.andy-pos-top-right .andy-arrow { display: none; }
    #andy-vol-trigger.andy-pos-top-right .andy-trigger-content { font-size: 11px; }
    #andy-vol-trigger.andy-trigger-boosted {
      border-color: #ffd60a;
      box-shadow: 0 -4px 22px rgba(255, 214, 10, 0.45);
      background: rgba(26, 20, 10, 0.92);
    }
    #andy-vol-trigger.andy-trigger-ultra {
      border-color: #ff0055;
      box-shadow: 0 -4px 24px rgba(255, 0, 85, 0.55), 0 0 10px rgba(255, 214, 10, 0.4);
      background: rgba(36, 8, 20, 0.95);
    }
    #andy-vol-trigger .andy-pill {
      width: 42px;
      height: 4px;
      border-radius: 99px;
      background: rgba(0, 242, 254, 0.7);
      margin-bottom: 4px;
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
      50% { transform: translateY(-3px); }
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
      bottom: 0;
      left: 50%;
      width: 100%;
      max-width: 500px;
      transform: translate(-50%, 105%);
      z-index: 99999;
      background: rgba(14, 18, 36, 0.96);
      border: 1.5px solid rgba(0, 242, 254, 0.4);
      border-bottom: none;
      border-radius: 24px 24px 0 0;
      box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.7), 0 -2px 24px rgba(0, 242, 254, 0.25);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      color: #ffffff;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      padding: 14px 24px calc(24px + env(safe-area-inset-bottom, 0px));
      transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s, box-shadow 0.25s;
      box-sizing: border-box;
      touch-action: none;
    }
    #andy-vol-sheet.andy-open {
      transform: translate(-50%, 0);
    }
    #andy-vol-sheet.andy-sheet-boosted {
      border-color: rgba(255, 214, 10, 0.65);
      box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.75), 0 -2px 30px rgba(255, 214, 10, 0.3);
    }
    #andy-vol-sheet.andy-sheet-ultra {
      border-color: rgba(255, 0, 85, 0.75);
      box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.8), 0 -2px 34px rgba(255, 0, 85, 0.4);
    }

    /* Sheet drag handle zone */
    .andy-sheet-grabber {
      width: 100%;
      padding: 4px 0 10px;
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
    .andy-notch-100 { left: 33.33%; }
    .andy-notch-200 { left: 66.66%; }
    .andy-notch-300 { right: 0; transform: translateX(50%); }

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
        border-radius: 20px 20px 0 0;
        padding: 12px 16px calc(20px + env(safe-area-inset-bottom, 0px));
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
    triggerEl.setAttribute('aria-label', 'Open volume control menu (or swipe up)');
    triggerEl.innerHTML = `
      <div class="andy-pill"></div>
      <div class="andy-trigger-content">
        <span class="andy-arrow">▲</span>
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
      <div class="andy-sheet-grabber" id="andy-sheet-grabber" title="Swipe down to close">
        <div class="andy-sheet-bar"></div>
      </div>
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
            <div class="andy-vol-status-text" id="andy-vol-status">${isMuted ? 'Muted' : (currentVol > 200 ? '300% Ultra' : (currentVol > 100 ? 'Super Loud' : 'Active'))}</div>
            <div class="andy-vol-boost-badge" id="andy-boost-badge" style="display: ${isBoosted() ? 'inline-flex' : 'none'};">⚡ BOOSTED</div>
          </div>
        </div>
        <div class="andy-header-actions">
          <button class="andy-action-btn andy-ultra-btn" id="andy-ultra-btn" title="Instantly boost volume to 300%">
            <span>💥</span>
            <span>300% Max</span>
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
            <div class="andy-notch-label andy-notch-100">100%</div>
            <div class="andy-notch andy-notch-200"></div>
            <div class="andy-notch-label andy-notch-200">200%</div>
            <input
              type="range"
              min="0"
              max="300"
              value="${currentVol}"
              class="andy-range-slider ${isUltraBoosted() ? 'andy-slider-ultra' : (isBoosted() ? 'andy-slider-boosted' : '')}"
              id="andy-vol-slider"
              aria-label="Volume level (0% to 300%)"
            />
          </div>
          <span class="andy-slider-icon" id="andy-slider-icon-right">💥</span>
        </div>
      </div>

      <div class="andy-presets-header">
        <div class="andy-presets-label">Quick Presets</div>
        <div class="andy-presets-boost-tag">Overdrive Zone (101% - 300%) 💥</div>
      </div>
      <div class="andy-presets-grid">
        <button class="andy-preset-btn ${isMuted || currentVol === 0 ? 'andy-active' : ''}" data-val="0">Mute</button>
        <button class="andy-preset-btn ${!isMuted && currentVol === 50 ? 'andy-active' : ''}" data-val="50">50%</button>
        <button class="andy-preset-btn ${!isMuted && currentVol === 100 ? 'andy-active' : ''}" data-val="100">100%</button>
        <button class="andy-preset-btn andy-preset-boost ${!isMuted && currentVol === 150 ? 'andy-active' : ''}" data-val="150">150% ⚡</button>
        <button class="andy-preset-btn andy-preset-boost ${!isMuted && currentVol === 200 ? 'andy-active' : ''}" data-val="200">200% 🔥</button>
        <button class="andy-preset-btn andy-preset-ultra ${!isMuted && currentVol === 300 ? 'andy-active' : ''}" data-val="300">300% 💥</button>
      </div>

      <div class="andy-footer-row">
        <button class="andy-test-btn ${isUltraBoosted() ? 'andy-test-ultra' : (isBoosted() ? 'andy-test-boosted' : '')}" id="andy-test-sound-btn">
          <span>🎵</span>
          <span>Test Sound</span>
        </button>
        <div class="andy-swipe-hint">
          <span>▼ Swipe down to close</span>
        </div>
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
    if (pct <= 100) return '🔊';
    if (pct <= 200) return '⚡';
    return '💥';
  }

  function updateSliderBackground(sliderEl) {
    if (!sliderEl) return;
    const val = isMuted ? 0 : currentVol; // 0 to 300
    const pctOf300 = (val / 300) * 100; // 0% to 100% of the bar width

    if (val <= 100) {
      // Normal range: Cyan to Blue
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe ${pctOf300}%, rgba(255,255,255,0.12) ${pctOf300}%, rgba(255,255,255,0.12) 100%)`;
    } else if (val <= 200) {
      // 101% - 200%: Neon Gold
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe 33%, #ffd60a ${pctOf300}%, rgba(255,255,255,0.12) ${pctOf300}%, rgba(255,255,255,0.12) 100%)`;
    } else {
      // 201% - 300%: Fiery Hot Pink & Crimson
      sliderEl.style.background = `linear-gradient(to right, #00f2fe 0%, #4facfe 33%, #ffd60a 66%, #ff0055 ${pctOf300}%, rgba(255,255,255,0.12) ${pctOf300}%, rgba(255,255,255,0.12) 100%)`;
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
      } else if (currentVol === 300) {
        volStatus.textContent = 'MAX 300% OVERDRIVE';
      } else if (ultra) {
        volStatus.textContent = '300% Ultra Boost';
      } else if (boosted) {
        volStatus.textContent = 'Super Loud Boost';
      } else {
        volStatus.textContent = 'Active Normal';
      }
    }
    if (boostBadge) {
      boostBadge.style.display = boosted ? 'inline-flex' : 'none';
      boostBadge.classList.toggle('andy-badge-ultra', ultra);
      if (currentVol === 300) {
        boostBadge.textContent = '💥 300% MAXIMUM OVERDRIVE';
      } else if (ultra) {
        boostBadge.textContent = `🔥 ${currentVol}% ULTRA BOOST`;
      } else {
        boostBadge.textContent = `⚡ ${currentVol}% BOOSTED`;
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
      ultraBtn.classList.toggle('andy-ultra-active', !isMuted && currentVol === 300);
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
    currentVol = Math.max(0, Math.min(300, Math.round(val)));
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

  function toggleUltra300() {
    if (isMuted || currentVol !== 300) {
      isMuted = false;
      setVolume(300);
      playTestChime();
    } else {
      // Toggle back to 100%
      setVolume(100);
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

    // Ultra 300% button
    if (ultraBtn) {
      ultraBtn.addEventListener('click', function () {
        toggleUltra300();
      });
    }

    // Slider input & change (0 - 300)
    if (slider) {
      slider.addEventListener('input', function () {
        setVolume(this.value);
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
    // Gesture 1: SWIPE UP ON THE PULL TAB (Touch & Mouse)
    // Only a touch that begins on the tab counts. The 3D games put their touch
    // joysticks along the bottom of the screen, so a bottom-edge zone opened
    // this menu every time someone pushed forward.
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
        const dy = touch.clientY - touchStartY; // negative when swiping UP
        const dx = Math.abs(touch.clientX - touchStartX);

        // If swiping upwards by more than 35px and predominantly vertical
        if (dy < -35 && Math.abs(dy) > dx) {
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

    // Mouse drag-up support on trigger
    let mouseStartY = null;
    if (trigger) {
      trigger.addEventListener('mousedown', function (e) {
        mouseStartY = e.clientY;
      });
      window.addEventListener('mousemove', function (e) {
        if (mouseStartY !== null && !isOpen) {
          if (mouseStartY - e.clientY > 30) {
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
    // Gesture 2: SWIPE DOWN ON SHEET TO CLOSE
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
      if (dy > 0) {
        // Dragging downwards
        sheetCurrentDy = dy;
        sheet.style.transform = `translate(-50%, ${dy}px)`;
      }
    }

    function onSheetDragEnd() {
      if (sheetStartY === null) return;
      sheet.style.transition = '';
      if (sheetCurrentDy > 75) {
        closeMenu();
      } else {
        sheet.style.transform = '';
      }
      sheetStartY = null;
      sheetCurrentDy = 0;
    }

    // Touch events for drag-down on sheet grabber and header
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
    ultra300: function () { toggleUltra300(); },
    open: openMenu,
    close: closeMenu,
    toggle: function () { if (isOpen) closeMenu(); else openMenu(); },
    playTestSound: playTestChime
  };
})();

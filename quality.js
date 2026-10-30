// Graphics quality for the Play Centre's 3D games (Coin Collector, Laundry
// Simulator, PC Builder), so they also run well on slower devices: old
// tablets, cheap phones, Chromebooks, laptops without a real graphics card.
//
// Three levels:
//   High    what the games always did: soft 2048px shadows, antialiasing,
//           physically based materials, 1080 lines (or the screen's pixels).
//   Medium  720 lines, plain 1024px shadows.
//   Low     540 lines, no shadows, no antialiasing, simple (Lambert) shading.
//
// The default is Auto. Auto starts from a guess about the device (software
// rendering, a low-end mobile GPU, two CPU cores...) and then watches the
// frame rate while the game runs: below 40 fps for a few seconds it steps a
// level down and says so in a small message; after a long stretch at a solid
// 60 fps it tries a level up again, and gives up on that if the game slows
// straight back down. The player can also pin a level in the settings menu.
// The choice is kept in localStorage and shared by all three games, since a
// device that is slow in one game is slow in the others too.
//
// Two things cannot change while the game runs, so they follow the level in
// force when the page loaded: antialiasing (fixed when the renderer is made)
// and Lambert materials (meshes are made with them). Auto remembers the level
// it settled on, so the next visit starts there with both applied.
//
// Not used on the Raspberry Pi arcade (?pi=1), where pi-mode.js already
// makes its own, harsher cuts. "?quality=low|medium|high|auto" in the URL
// overrides the saved choice, for testing or a kiosk link.
//
// Loads after three.js and pi-mode.js and before the game's own script. A game:
//   1. makes its renderer with AndyQuality.rendererOptions({...}),
//   2. after setting up its renderer and shadow light calls AndyQuality.setup({
//        renderer, scene, shadowLight, setRenderHeight(lines|null) })
//      where setRenderHeight(null) means the game's normal resolution,
//   3. has <select id="graphics-select"> and <small id="graphics-hint"> in its
//      settings menu; setup() fills and wires them.
window.AndyQuality = (function () {
  'use strict';
  const KEY = 'andyGraphics';
  const LEVELS = ['low', 'medium', 'high'];
  const PRESETS = {
    high:   { height: null, shadows: true,  shadowSize: 2048, softShadows: true,  antialias: true,  lambert: false },
    medium: { height: 720,  shadows: true,  shadowSize: 1024, softShadows: false, antialias: true,  lambert: false },
    low:    { height: 540,  shadows: false, shadowSize: 512,  softShadows: false, antialias: false, lambert: true }
  };
  const LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  // Frame-rate watching, in Auto
  const SLOW_MS = 25;        // median frame slower than this (40 fps) is too slow
  const FAST_MS = 17.5;      // median frame faster than this (57 fps) is solid
  const WINDOW_MS = 2000;    // one measurement
  const SLOW_WINDOWS = 2;    // this many slow windows in a row: step down
  const FAST_WINDOWS = 10;   // this many fast windows in a row: try a step up
  const SETTLE_MS = 5000;    // ignore frames this long after a change (shaders compile)
  const BOUNCE_MS = 30000;   // a step down this soon after a step up: stop trying up

  const piMode = !!(window.PiMode && PiMode.on);
  const urlLevel = new URLSearchParams(location.search).get('quality');

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && typeof d === 'object') return d;
    } catch (e) {}
    return {};
  }
  function store() {
    try { localStorage.setItem(KEY, JSON.stringify({ mode, auto: autoLevel })); } catch (e) {}
  }

  // A first guess at the device, before any frame has been timed.
  function guess() {
    let gpu = '';
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) {}
    // Drawn by the CPU: no GPU at all, or the browser isn't using it
    if (/SwiftShader|llvmpipe|softpipe|Software|Microsoft Basic Render/i.test(gpu)) return 'low';
    // Low-end or old mobile and laptop GPUs
    if (/VideoCore|Mali-4|Mali-T|Mali-G[1-5]\d\b|Adreno \(TM\) [1-5]\d\d\b|PowerVR|Tegra|Intel\(R\) HD Graphics( [2-5]\d\d\d| \d{3})?\b(?! 6)/i.test(gpu)) return 'medium';
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (cores <= 2 || mem <= 2) return 'medium';
    return 'high';
  }

  const saved = load();
  let mode = LEVELS.indexOf(saved.mode) >= 0 || saved.mode === 'auto' ? saved.mode : 'auto';
  if (urlLevel && (LEVELS.indexOf(urlLevel) >= 0 || urlLevel === 'auto')) mode = urlLevel;
  let ceiling = mode === 'auto' ? guess() : mode;  // highest level Auto will try
  let autoLevel = LEVELS.indexOf(saved.auto) >= 0 ? saved.auto : ceiling;
  if (LEVELS.indexOf(autoLevel) > LEVELS.indexOf(ceiling)) ceiling = autoLevel;
  let level = mode === 'auto' ? autoLevel : mode;
  if (piMode) level = 'low';
  const loadLevel = level;  // antialiasing and materials follow this one

  // --- Renderer creation ---
  let lambertInstalled = false;
  function rendererOptions(opts) {
    if (piMode) return opts;
    if (PRESETS[loadLevel].lambert && !lambertInstalled && window.PiMode && PiMode.useLambertMaterials) {
      PiMode.useLambertMaterials();
      lambertInstalled = true;
    }
    return Object.assign({ powerPreference: 'high-performance' }, opts, { antialias: PRESETS[loadLevel].antialias });
  }

  // --- Applying a level to a running game ---
  let game = null;        // { renderer, scene, shadowLight, setRenderHeight }
  let applied = null;     // preset in force
  let changedAt = 0;

  function apply(lv) {
    level = lv;
    const p = PRESETS[lv];
    if (!game) return;
    const r = game.renderer, light = game.shadowLight;
    if (game.setRenderHeight) game.setRenderHeight(p.height);
    const shadowsChanged = !applied || applied.shadows !== p.shadows ||
      applied.softShadows !== p.softShadows || applied.shadowSize !== p.shadowSize;
    if (shadowsChanged) {
      r.shadowMap.enabled = p.shadows;
      r.shadowMap.type = p.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      if (light) {
        light.castShadow = p.shadows;
        light.shadow.mapSize.set(p.shadowSize, p.shadowSize);
        if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; }
      }
      // Shaders are built for a shadow type; have them rebuilt
      if (applied && game.scene) {
        game.scene.traverse(function (o) {
          const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
          ms.forEach(function (m) { m.needsUpdate = true; });
        });
      }
    }
    applied = p;
    changedAt = performance.now();
    updateHint();
  }

  // Player's choice from the settings menu (or a game calling set()).
  function set(choice) {
    if (piMode) return;
    if (choice !== 'auto' && LEVELS.indexOf(choice) < 0) return;
    mode = choice;
    if (mode === 'auto') {
      ceiling = guess();
      if (LEVELS.indexOf(autoLevel) > LEVELS.indexOf(ceiling)) ceiling = autoLevel;
      resetWatch();
      apply(autoLevel);
    } else {
      apply(mode);
    }
    store();
    if (select) select.value = mode;
  }

  // --- Watching the frame rate (Auto only) ---
  let frames = [], windowStart = 0, lastFrame = 0;
  let slowRun = 0, fastRun = 0, lastUp = -Infinity, fps = 0;
  function resetWatch() { frames = []; slowRun = 0; fastRun = 0; windowStart = 0; }

  function tick(now) {
    requestAnimationFrame(tick);
    if (lastFrame) {
      const dt = now - lastFrame;
      if (dt > 300) { resetWatch(); }   // tab hidden, a hitch: not the GPU's steady state
      else { frames.push(dt); if (!windowStart) windowStart = now; }
    }
    lastFrame = now;
    if (!windowStart || now - windowStart < WINDOW_MS) return;
    if (frames.length >= 20) {
      frames.sort(function (a, b) { return a - b; });
      const median = frames[frames.length >> 1];
      fps = Math.round(1000 / median);
      if (mode === 'auto' && game && now - changedAt > SETTLE_MS) evaluate(median, now);
      updateHint();
    }
    frames = []; windowStart = 0;
  }

  function evaluate(median, now) {
    const i = LEVELS.indexOf(level);
    if (median > SLOW_MS) {
      fastRun = 0;
      if (++slowRun >= SLOW_WINDOWS && i > 0) {
        slowRun = 0;
        if (now - lastUp < BOUNCE_MS) ceiling = LEVELS[i - 1];  // going up didn't work out
        autoLevel = LEVELS[i - 1];
        apply(autoLevel);
        store();
        toast('Graphics turned down to ' + LABEL[autoLevel] + ' so the game runs smoothly. Change it in ⚙️ Settings.');
      }
    } else if (median < FAST_MS) {
      slowRun = 0;
      if (++fastRun >= FAST_WINDOWS && i < LEVELS.indexOf(ceiling)) {
        fastRun = 0;
        lastUp = now;
        autoLevel = LEVELS[i + 1];
        apply(autoLevel);
        store();
      }
    } else {
      slowRun = 0; fastRun = 0;
    }
  }

  // --- Settings menu and messages ---
  let select = null, hint = null;
  function updateHint() {
    if (!hint) return;
    hint.textContent = (mode === 'auto' ? 'Auto: ' + LABEL[level] : LABEL[level]) +
      (fps ? ' · ' + fps + ' fps' : '');
  }
  let toastEl = null, toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom, 0px));' +
        'transform:translateX(-50%);z-index:99998;max-width:min(92vw, 480px);padding:10px 16px;' +
        'border-radius:12px;background:rgba(12,16,28,0.9);color:#fff;font:14px/1.4 sans-serif;' +
        'text-align:center;border:1px solid rgba(255,255,255,0.15);pointer-events:none;' +
        'transition:opacity 0.4s;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 6000);
  }

  function setup(g) {
    game = g;
    select = document.getElementById('graphics-select');
    hint = document.getElementById('graphics-hint');
    if (piMode) {
      // The Pi's own settings rule; hide the choice rather than show one that does nothing
      const row = select && (select.closest('.modal-item') || select.closest('.setting-item'));
      if (row) row.style.display = 'none';
      return;
    }
    if (select) {
      select.innerHTML = '';
      [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].forEach(function (o) {
        const el = document.createElement('option');
        el.value = o[0]; el.textContent = o[1];
        select.appendChild(el);
      });
      select.value = mode;
      select.addEventListener('change', function () { set(select.value); });
    }
    apply(level);
    requestAnimationFrame(tick);
  }

  function state() {
    return { mode: mode, level: level, loadLevel: loadLevel, ceiling: ceiling, fps: fps, pi: piMode };
  }

  return { rendererOptions: rendererOptions, setup: setup, set: set, state: state,
           level: function () { return level; }, _evaluate: evaluate };
})();

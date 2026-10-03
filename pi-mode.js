// Pi mode for the Play Centre's 3D games.
//
// The Raspberry Pi arcade (github.com/bethqzak/rpi-arcade) opens a game as
// "<game>.html?pi=1". Only then does any of this apply; a tablet or computer
// opening the game normally gets exactly what it always did.
//
// A Pi 4's GPU can't push these scenes at 1080 lines with soft shadows and
// antialiasing, and its touchscreen is its only pointer while the browser
// insists a mouse is primary, which hides the games' touch controls. So in
// Pi mode a game:
//   - renders at a modest height (480 lines, or "?pi=600" for another),
//   - turns shadows and antialiasing off,
//   - shows its touch controls (the stylesheet matches html.pi-mode).
window.PiMode = (function () {
  'use strict';
  const param = new URLSearchParams(location.search).get('pi');
  const on = param !== null;
  const wanted = parseInt(param, 10);
  const renderHeight = Math.max(240, Math.min(
    window.innerHeight || 480,
    isFinite(wanted) && wanted >= 240 ? wanted : 480));
  if (on) document.documentElement.classList.add('pi-mode');

  // Options for the THREE.WebGLRenderer: antialiasing off on the Pi.
  function rendererOptions(opts) {
    return on ? Object.assign({}, opts, { antialias: false }) : opts;
  }

  // Call after the renderer's shadow settings: shadows off on the Pi.
  function tune(renderer) {
    if (on) renderer.shadowMap.enabled = false;
  }

  // The pixel ratio that renders at renderHeight on this screen.
  function pixelRatio(normal) {
    return on ? renderHeight / window.innerHeight : normal;
  }

  // For games with a Render Resolution setting: the value to start with.
  // On the Pi the setting is put on "Custom" with renderHeight filled in,
  // so what the settings menu shows is what is happening.
  function startResolution(normal) {
    if (!on) return normal;
    const select = document.getElementById('res-select');
    const custom = document.getElementById('res-custom');
    if (!select || !custom) return normal;
    select.value = 'custom';
    custom.value = renderHeight;
    return 'custom';
  }

  return { on, renderHeight, rendererOptions, tune, pixelRatio, startResolution };
})();

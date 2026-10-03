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
//   - uses simple (Lambert) shading in place of the physically based
//     materials, whose per-pixel cost under several lights is what the
//     Pi's GPU chokes on; the scene looks a little flatter on the Pi only,
//   - shows its touch controls (the stylesheet matches html.pi-mode),
//   - shows the frame rate in a corner, so the Pi can be tuned by numbers.
//
// This file loads after three.js and before the game's own script.
window.PiMode = (function () {
  'use strict';
  const param = new URLSearchParams(location.search).get('pi');
  const on = param !== null;
  const wanted = parseInt(param, 10);
  const renderHeight = Math.max(240, Math.min(
    window.innerHeight || 480,
    isFinite(wanted) && wanted >= 240 ? wanted : 480));
  if (on) document.documentElement.classList.add('pi-mode');

  // Physically based materials become Lambert ones at creation, so every
  // mesh the game makes later (coins, clothes, other players) is covered.
  // Properties Lambert lacks (roughness, metalness...) are dropped; a game
  // that sets them afterwards just sets a harmless unused property.
  if (on && window.THREE && THREE.MeshLambertMaterial) {
    const DROP = ['roughness', 'metalness', 'roughnessMap', 'metalnessMap',
      'normalMap', 'normalScale', 'envMapIntensity', 'clearcoat',
      'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'sheen',
      'flatShading', 'bumpMap', 'bumpScale', 'displacementMap'];
    class PiLambert extends THREE.MeshLambertMaterial {
      constructor(params) {
        const p = Object.assign({}, params);
        for (const k of DROP) delete p[k];
        super(p);
      }
    }
    THREE.MeshStandardMaterial = PiLambert;
    THREE.MeshPhysicalMaterial = PiLambert;
  }

  // Frame rate (and draw calls, once a renderer is known) in a corner.
  let renderer = null;
  if (on) {
    const box = document.createElement('div');
    box.id = 'pi-fps';
    box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;' +
      'padding:2px 7px;border-radius:6px;background:rgba(0,0,0,0.55);' +
      'color:#9f9;font:12px/1.4 monospace;pointer-events:none;';
    // Touch events as the page receives them, to see what the browser does
    // with a finger that is held still: a "touchend" the panel never sent,
    // or a "touchcancel", are two different problems.
    const touches = { start: 0, move: 0, end: 0, cancel: 0 };
    for (const k of Object.keys(touches)) {
      window.addEventListener('touch' + k, () => { touches[k]++; }, { capture: true, passive: true });
    }
    let frames = 0, last = performance.now();
    function tick(now) {
      frames++;
      if (now - last >= 1000) {
        const calls = renderer ? ' ' + renderer.info.render.calls + ' draws' : '';
        box.textContent = Math.round(frames * 1000 / (now - last)) + ' fps' + calls +
          ' | touch s' + touches.start + ' m' + touches.move + ' e' + touches.end + ' c' + touches.cancel;
        frames = 0; last = now;
      }
      requestAnimationFrame(tick);
    }
    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(box);
      requestAnimationFrame(tick);
    });
  }

  // Options for the THREE.WebGLRenderer: antialiasing off on the Pi.
  function rendererOptions(opts) {
    return on ? Object.assign({}, opts, { antialias: false }) : opts;
  }

  // Call after the renderer's shadow settings: shadows off on the Pi.
  function tune(r) {
    if (!on) return;
    r.shadowMap.enabled = false;
    renderer = r;
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

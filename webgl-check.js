// Shared WebGL check for the Andy play-centre games built on three.js.
//
// Without WebGL (no GPU, hardware acceleration turned off, an old or
// locked-down browser) three.js throws while the renderer is being created,
// the rest of the game script never runs, and the start button is left doing
// nothing at all - it just looks broken. Call AndyWebGL.require() before
// creating the renderer to put an explanation on the start screen instead.
window.AndyWebGL = (function () {
  function available() {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl') ||
                canvas.getContext('experimental-webgl'));
    } catch (e) {
      return false;
    }
  }

  // Returns true when WebGL works. Otherwise shows a notice inside the
  // element with id `startScreenId` (or the page body), disables the
  // buttons and inputs on it, and returns false so the caller can stop.
  function require(startScreenId) {
    if (available()) return true;
    const screen = document.getElementById(startScreenId) || document.body;
    const note = document.createElement('div');
    note.className = 'webgl-missing';
    note.setAttribute('role', 'alert');
    note.style.cssText = 'margin:18px auto 0; max-width:520px; padding:14px 18px; ' +
      'border-radius:12px; background:rgba(231,76,60,0.18); border:1px solid #e74c3c; ' +
      'color:#ffd5d0; font-size:15px; line-height:1.45; text-align:center;';
    note.innerHTML = '<b>This game needs 3D graphics (WebGL), which this browser ' +
      'has turned off.</b><br>Turn on hardware acceleration in the browser ' +
      'settings or try another browser, then reload the page.';
    screen.appendChild(note);
    screen.querySelectorAll('button, input').forEach(function (el) {
      el.disabled = true;
      el.style.opacity = '0.45';
    });
    return false;
  }

  return { available: available, require: require };
})();

// Shared progress-saving helper for the Andy play-centre games.
// Each game keeps its own save shape; this provides the bits they share:
// a per-device ID, the auto-save on/off preference, and transfer codes so
// a save can be copy-pasted between devices without any server.
window.AndySave = (function () {
  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  // Stable anonymous ID for this browser/device. Shown in Settings and
  // stamped into transfer codes so you can tell saves apart.
  function deviceId() {
    return safe(function () {
      let id = localStorage.getItem('andyDeviceId');
      if (!id) {
        id = 'ANDY-' + Math.random().toString(36).slice(2, 6).toUpperCase() +
             '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
        localStorage.setItem('andyDeviceId', id);
      }
      return id;
    }, 'ANDY-GUEST');
  }

  // Auto-save preference, per game save key. Defaults to on.
  function isEnabled(saveKey) {
    return safe(function () {
      return localStorage.getItem(saveKey + ':autosave') !== 'off';
    }, true);
  }
  function setEnabled(saveKey, on) {
    safe(function () {
      localStorage.setItem(saveKey + ':autosave', on ? 'on' : 'off');
    });
  }

  // Transfer codes: ANDY1.<gameId>.<base64 JSON>. The payload records which
  // game and device it came from, when, and the save data itself.
  function makeCode(gameId, data) {
    const payload = { g: gameId, v: 1, dev: deviceId(), t: Date.now(), d: data };
    return 'ANDY1.' + gameId + '.' +
      btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }
  function readCode(gameId, code) {
    try {
      const parts = String(code || '').trim().split('.');
      if (parts.length !== 3 || parts[0] !== 'ANDY1' || parts[1] !== gameId) return null;
      const payload = JSON.parse(decodeURIComponent(escape(atob(parts[2]))));
      if (!payload || payload.g !== gameId || typeof payload.d !== 'object' || !payload.d) return null;
      return payload;
    } catch (e) {
      return null;
    }
  }

  // Clipboard copy with a prompt() fallback for older browsers / http.
  function copyText(text, onDone) {
    const fallback = function () {
      window.prompt('Copy your save code:', text);
      if (onDone) onDone(false);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { if (onDone) onDone(true); },
        fallback
      );
    } else {
      fallback();
    }
  }

  // Brief "done!" feedback on a button.
  function flashButton(btn, label) {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = label;
    setTimeout(function () { btn.textContent = old; }, 1400);
  }

  return {
    deviceId: deviceId,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    makeCode: makeCode,
    readCode: readCode,
    copyText: copyText,
    flashButton: flashButton
  };
})();

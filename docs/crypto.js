/* crypto.js — password gate + Web Crypto (PBKDF2 -> AES-256-GCM) decrypt.
 *
 * Must byte-match the Python encrypter (contract):
 *   key    = PBKDF2HMAC(password=passphrase, salt=meta.salt_b64 (16 bytes),
 *                       iterations=meta.iterations (210000), hash=SHA-256, len=32)
 *   cipher = AES-256-GCM(key, iv=12 random bytes, plaintext=UTF-8 JSON), no AAD.
 *   history.enc.json = {"iv_b64": "...", "ciphertext_b64": "<ct+16-byte tag>"}
 *   meta.json        = {"schema_version":1,"salt_b64":"...","iterations":210000,"hash":"SHA-256"}
 *
 * WebCrypto AES-GCM expects the tag appended to the ciphertext, which is exactly
 * what Python's AESGCM.encrypt() returns — no splitting required.
 */
(function () {
  "use strict";

  var LS_PW = "phev_dash_pw";
  var LS_PW_TS = "phev_dash_pw_ts";
  var LS_API_KEY = "phev_dash_api_key";
  var LS_FACEID = "phev_dash_faceid_cred_id"; // presence = Face ID lock is on
  var MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // ~365 days
  var META_URL = "./data/meta.json";
  var DATA_URL = "./data/history.enc.json";

  // ---- DOM refs ----
  var overlay = document.getElementById("lock-overlay");
  var form = document.getElementById("pw-form");
  var input = document.getElementById("pw-input");
  var submitBtn = document.getElementById("pw-submit");
  var errorEl = document.getElementById("pw-error");
  var subEl = document.getElementById("lock-sub");

  var settingsModal = document.getElementById("settings-modal");
  var apiKeyInput = document.getElementById("api-key-input");
  var settingsSave = document.getElementById("settings-save");
  var settingsClose = document.getElementById("settings-close");
  var btnSettings = document.getElementById("btn-settings");
  var btnLogout = document.getElementById("btn-logout");

  var faceidRow = document.getElementById("faceid-row");
  var faceidToggle = document.getElementById("faceid-toggle");
  var faceidGate = document.getElementById("faceid-gate");
  var faceidUnlockBtn = document.getElementById("faceid-unlock-btn");
  var faceidFallbackBtn = document.getElementById("faceid-fallback-btn");

  // ---- Expose API-key getter for app.js ----
  window.PHEV.getApiKey = function () {
    try { return localStorage.getItem(LS_API_KEY) || ""; } catch (e) { return ""; }
  };
  window.PHEV.openSettings = openSettings;

  // ---- base64 helpers ----
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bytesToB64(bytes) {
    var arr = new Uint8Array(bytes);
    var bin = "";
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  // ---- crypto core ----
  async function deriveKey(passphrase, saltBytes, iterations) {
    var enc = new TextEncoder();
    var baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: iterations, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptWith(key, ivBytes, ctBytes) {
    var plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes }, key, ctBytes
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  // ---- fetch helpers ----
  async function fetchJson(url) {
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      var err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Attempt full unlock with a given passphrase. Resolves parsed data or throws.
  async function unlock(passphrase) {
    var meta, payload;
    try {
      meta = await fetchJson(META_URL);
    } catch (e) {
      var m = new Error("meta_missing");
      m.code = "meta_missing";
      throw m;
    }
    try {
      payload = await fetchJson(DATA_URL);
    } catch (e) {
      var d = new Error("data_missing");
      d.code = "data_missing";
      throw d;
    }

    var salt = b64ToBytes(meta.salt_b64);
    var iterations = meta.iterations || 210000;
    var key = await deriveKey(passphrase, salt, iterations);
    var iv = b64ToBytes(payload.iv_b64);
    var ct = b64ToBytes(payload.ciphertext_b64);
    // Throws OperationError on wrong password / tampered data.
    return decryptWith(key, iv, ct);
  }

  function cachePassphrase(pw) {
    try {
      localStorage.setItem(LS_PW, pw);
      localStorage.setItem(LS_PW_TS, String(Date.now()));
    } catch (e) { /* private mode: ignore */ }
  }

  function cachedPassphrase() {
    try {
      var pw = localStorage.getItem(LS_PW);
      var ts = parseInt(localStorage.getItem(LS_PW_TS) || "0", 10);
      if (pw && ts && (Date.now() - ts) < MAX_AGE_MS) return pw;
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- Face ID lock (WebAuthn platform authenticator) ----
  // Client-side only: there's no server here to verify a WebAuthn signature
  // against, so a successfully RESOLVED navigator.credentials.get() call is
  // treated as the gate -- this is a fast speed bump against someone picking
  // up an unlocked phone with the app already installed, not a cryptographic
  // boundary. The actual secrets (passphrase, dashboard key) are unchanged;
  // this only gates whether the UI proceeds to use the cached ones.
  function getFaceIdCredId() {
    try { return localStorage.getItem(LS_FACEID); } catch (e) { return null; }
  }
  function setFaceIdCredId(b64) {
    try {
      if (b64) localStorage.setItem(LS_FACEID, b64);
      else localStorage.removeItem(LS_FACEID);
    } catch (e) { /* private mode: ignore */ }
  }
  function webAuthnSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials);
  }

  async function registerFaceId() {
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "PHEV Dashboard" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: "phev-dashboard",
          displayName: "PHEV Dashboard"
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000
      }
    });
    setFaceIdCredId(bytesToB64(cred.rawId));
  }

  async function initFaceIdSetting() {
    if (!faceidRow || !faceidToggle || !webAuthnSupported()) return;
    if (!window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return;
    var available = false;
    try {
      available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) { return; }
    if (!available) return;
    faceidRow.hidden = false;
    faceidToggle.checked = !!getFaceIdCredId();
  }

  if (faceidToggle) {
    faceidToggle.addEventListener("change", async function () {
      if (faceidToggle.checked) {
        try {
          await registerFaceId();
        } catch (e) {
          faceidToggle.checked = false;
        }
      } else {
        setFaceIdCredId(null);
      }
    });
  }
  initFaceIdSetting();

  function showFaceidGate() {
    if (form) form.hidden = true;
    if (faceidGate) faceidGate.hidden = false;
  }
  function showPassphraseForm() {
    if (faceidGate) faceidGate.hidden = true;
    if (form) form.hidden = false;
  }

  async function tryFaceId() {
    setError("");
    faceidUnlockBtn.disabled = true;
    subEl.textContent = "Waiting for Face ID…";
    try {
      var credId = b64ToBytes(getFaceIdCredId());
      await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: credId, type: "public-key" }],
          userVerification: "required",
          timeout: 60000
        }
      });
      // Resolving at all means the platform authenticator verified the
      // user -- proceed to the normal cached-passphrase unlock.
      await attemptCachedUnlock();
    } catch (e) {
      subEl.textContent = "Face ID lock is on for this app";
      setError("Face ID didn't complete — try again, or use your passphrase.");
    } finally {
      faceidUnlockBtn.disabled = false;
    }
  }

  if (faceidUnlockBtn) faceidUnlockBtn.addEventListener("click", tryFaceId);
  if (faceidFallbackBtn) {
    faceidFallbackBtn.addEventListener("click", function () {
      setError("");
      subEl.textContent = "Enter your dashboard passphrase";
      showPassphraseForm();
      input.focus();
    });
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
  function showOverlay() {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }

  function setError(msg) { errorEl.textContent = msg || ""; }
  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? "Unlocking…" : "Unlock";
  }

  async function onUnlockSuccess(data, passphrase, remember) {
    if (remember) cachePassphrase(passphrase);
    window.PHEV.setData(data);
    hideOverlay();
    // First run: no command key yet -> nudge the settings modal once.
    if (!window.PHEV.getApiKey()) openSettings();
  }

  // ---- form submit (manual entry) ----
  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var pw = input.value;
    if (!pw) { setError("Enter a passphrase."); return; }
    setError("");
    setBusy(true);
    try {
      var data = await unlock(pw);
      await onUnlockSuccess(data, pw, true);
    } catch (e) {
      if (e.code === "meta_missing" || e.code === "data_missing") {
        setError("No data available yet — the logger hasn't published a file. Try again later.");
      } else {
        setError("Wrong passphrase — try again.");
      }
      input.select();
    } finally {
      setBusy(false);
    }
  });

  // ---- settings modal ----
  function openSettings() {
    apiKeyInput.value = window.PHEV.getApiKey();
    settingsModal.classList.add("open");
    settingsModal.setAttribute("aria-hidden", "false");
    apiKeyInput.focus();
  }
  function closeSettings() {
    settingsModal.classList.remove("open");
    settingsModal.setAttribute("aria-hidden", "true");
  }
  btnSettings.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsSave.addEventListener("click", function () {
    try { localStorage.setItem(LS_API_KEY, apiKeyInput.value.trim()); } catch (e) { /* ignore */ }
    closeSettings();
  });
  settingsModal.addEventListener("click", function (e) {
    if (e.target === settingsModal) closeSettings();
  });

  // ---- logout ----
  btnLogout.addEventListener("click", function () {
    try {
      localStorage.removeItem(LS_PW);
      localStorage.removeItem(LS_PW_TS);
      localStorage.removeItem(LS_API_KEY);
      localStorage.removeItem(LS_FACEID);
    } catch (e) { /* ignore */ }
    location.reload();
  });

  // ---- auto-unlock from cache on load ----
  async function attemptCachedUnlock() {
    var pw = cachedPassphrase();
    if (!pw) { showPassphraseForm(); input.focus(); return; }
    subEl.textContent = "Unlocking…";
    try {
      var data = await unlock(pw);
      await onUnlockSuccess(data, pw, true); // refresh timestamp
    } catch (e) {
      // Cached passphrase failed (rotated key) or data not published yet.
      showPassphraseForm();
      subEl.textContent = "Enter your dashboard passphrase";
      if (e.code === "meta_missing" || e.code === "data_missing") {
        setError("No data available yet — try again later.");
      } else {
        // Stale/rotated passphrase — clear it so the user re-enters.
        try { localStorage.removeItem(LS_PW); localStorage.removeItem(LS_PW_TS); } catch (_) {}
        setError("Saved passphrase no longer works — enter it again.");
      }
      input.focus();
    }
  }

  (async function boot() {
    // Face ID is opt-in and only ever gates the FIRST step: if it's on but
    // this device/browser can't do WebAuthn right now (moved browsers,
    // cleared permissions, whatever), fall straight through to the normal
    // passphrase flow rather than stranding the user.
    if (getFaceIdCredId() && webAuthnSupported()) {
      showFaceidGate();
      subEl.textContent = "Face ID lock is on for this app";
      return;
    }
    await attemptCachedUnlock();
  })();
})();

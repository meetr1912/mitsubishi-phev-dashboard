/* shortcuts-setup.js — in-app helper for building iOS Shortcuts "quick
 * actions" that hit the Worker directly, bypassing the dashboard UI
 * entirely. There's no native app here, so a real WidgetKit home-screen
 * widget isn't buildable -- Apple's Shortcuts app (Home Screen icon, or
 * pinned into the built-in Shortcuts widget) is the real substitute, and
 * genuinely faster for a single action than opening this dashboard.
 *
 * Values are pre-filled with THIS browser's saved dashboard key --
 * copy-paste ready, not a template the user has to edit by hand.
 */
(function () {
  "use strict";

  // Must match CONFIG.WORKER_URL in app.js.
  var WORKER_URL = "https://phev-command-relay.phev-command-relay.workers.dev";

  var ACTIONS = [
    { name: "Lock", body: { action: "lock" } },
    { name: "Unlock", body: { action: "unlock" } },
    { name: "Flash lights", body: { action: "lights" } },
    { name: "Horn", body: { action: "horn" } },
    { name: "Locate", body: { action: "locate" } },
    { name: "Start climate", body: { action: "climate", minutes: 10, temperatureC: 22, options: [] } },
    { name: "Stop climate", body: { action: "climate_stop" } }
  ];

  var modal = document.getElementById("shortcuts-modal");
  var openBtn = document.getElementById("btn-shortcuts-setup");
  var closeBtn = document.getElementById("shortcuts-close");
  var urlEl = document.getElementById("sc-url");
  var headerEl = document.getElementById("sc-header");
  var actionsEl = document.getElementById("sc-actions");
  if (!modal || !openBtn || !actionsEl) return;

  async function copyText(text, btn) {
    var original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied!";
    } catch (e) {
      // No Clipboard API (rare on modern iOS Safari, but possible in odd
      // contexts) -- select the adjacent text so the user can still copy
      // manually via the system's own selection menu.
      try {
        var code = btn.previousElementSibling;
        if (code) {
          var range = document.createRange();
          range.selectNodeContents(code);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (_) { /* ignore */ }
      btn.textContent = "Selected";
    }
    setTimeout(function () { btn.textContent = original; }, 1500);
  }

  function build() {
    var key = window.PHEV && window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (urlEl) urlEl.textContent = WORKER_URL + "/command";
    if (headerEl) {
      headerEl.textContent = "X-Dashboard-Key: " + (key || "<set your key in Settings first>");
    }

    actionsEl.innerHTML = "";
    ACTIONS.forEach(function (a) {
      var bodyText = JSON.stringify(a.body);

      var row = document.createElement("div");
      row.className = "shortcut-action";

      var name = document.createElement("div");
      name.className = "shortcut-action-name";
      name.textContent = a.name;

      var copyRow = document.createElement("div");
      copyRow.className = "copy-row";

      var code = document.createElement("code");
      code.textContent = bodyText;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", function () { copyText(bodyText, btn); });

      copyRow.appendChild(code);
      copyRow.appendChild(btn);
      row.appendChild(name);
      row.appendChild(copyRow);
      actionsEl.appendChild(row);
    });
  }

  function openModal() {
    build();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  openBtn.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  // URL/header copy buttons -- static markup, wired once (unlike the
  // per-action ones above, which are rebuilt fresh on every open).
  var staticCopyBtns = modal.querySelectorAll(".btn-copy[data-copy-target]");
  for (var i = 0; i < staticCopyBtns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var targetId = btn.getAttribute("data-copy-target");
        var el = document.getElementById(targetId);
        if (el) copyText(el.textContent, btn);
      });
    })(staticCopyBtns[i]);
  }
})();

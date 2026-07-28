/* pull-refresh.js — custom pull-to-refresh gesture.
 *
 * Standalone (installed-to-home-screen) PWAs don't get Safari's own
 * pull-to-refresh, so this fills the gap. The app scrolls at the window
 * level (no inner scroll container), so the gesture only engages when the
 * window is already scrolled to the very top.
 *
 * Reuses app.js's real refreshNow() via window.PHEV.refreshNow (same
 * spinner/toast behavior as the manual refresh button) instead of
 * duplicating the fetch logic here.
 */
(function () {
  "use strict";

  var INDICATOR_HEIGHT = 56; // must match .pull-indicator's height in styles.css
  var THRESHOLD = 46;        // resisted px needed at release to trigger a refresh
  var RESISTANCE = 0.5;      // finger travels further than the indicator moves

  var indicator = document.getElementById("pull-indicator");
  if (!indicator || !window.PHEV) return;

  var lockOverlay = document.getElementById("lock-overlay");
  var settingsModal = document.getElementById("settings-modal");

  var tracking = false;
  var refreshing = false;
  var startY = 0;
  var shown = 0;

  function atTop() {
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  }

  // Only pull-to-refresh once the dashboard is actually visible -- not
  // behind the lock/Face ID screen, and not while a modal is open.
  function canPull() {
    if (refreshing) return false;
    if (lockOverlay && lockOverlay.getAttribute("aria-hidden") !== "true") return false;
    if (settingsModal && settingsModal.classList.contains("open")) return false;
    return atTop();
  }

  function applyShown(px) {
    shown = Math.max(0, Math.min(px, INDICATOR_HEIGHT));
    indicator.style.transform = "translateY(" + (shown - INDICATOR_HEIGHT) + "px)";
    var icon = indicator.querySelector("svg");
    if (icon) icon.style.transform = "rotate(" + (Math.min(shown / THRESHOLD, 1) * 180) + "deg)";
  }

  function reset() {
    tracking = false;
    shown = 0;
    indicator.classList.remove("dragging");
    indicator.style.transform = "";
    var icon = indicator.querySelector("svg");
    if (icon) icon.style.transform = "";
  }

  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1 || !canPull()) return;
    tracking = true;
    startY = e.touches[0].clientY;
    indicator.classList.add("dragging");
  }, { passive: true });

  document.addEventListener("touchmove", function (e) {
    if (!tracking) return;
    var dy = e.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) { reset(); return; }
    applyShown(dy * RESISTANCE);
    e.preventDefault(); // stop the native rubber-band fighting the gesture
  }, { passive: false });

  function onRelease() {
    if (!tracking) return;
    tracking = false;
    indicator.classList.remove("dragging");
    if (shown >= THRESHOLD && window.PHEV.refreshNow) {
      refreshing = true;
      indicator.style.transform = "translateY(0)"; // hold open while refreshing
      Promise.resolve(window.PHEV.refreshNow(indicator)).then(function () {
        refreshing = false;
        reset();
      });
    } else {
      reset();
    }
  }

  document.addEventListener("touchend", onRelease, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
})();

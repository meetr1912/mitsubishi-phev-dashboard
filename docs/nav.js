/* nav.js — bottom tab-bar section navigation.
 * Plain IIFE, no dependencies. Shows/hides the four .tab-view wrappers via an
 * `is-active` class (nodes are never destroyed) and keeps the tab-bar buttons
 * in sync. On each switch it nudges the size-sensitive widgets that were hidden
 * (Chart.js canvases, the three.js hero) so they measure their now-visible box. */
(function () {
  "use strict";

  var TABS = ["status", "climate", "controls", "history"];
  var bar = document.querySelector(".tab-bar");
  var views = {};
  TABS.forEach(function (t) { views[t] = document.getElementById("tab-" + t); });

  function show(name) {
    if (TABS.indexOf(name) === -1) name = "status";

    TABS.forEach(function (t) {
      if (views[t]) views[t].classList.toggle("is-active", t === name);
    });

    if (bar) {
      Array.prototype.forEach.call(bar.querySelectorAll(".tab-btn"), function (b) {
        var on = b.getAttribute("data-tab") === name;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
    }

    // Fresh tab starts at the top.
    window.scrollTo(0, 0);

    // The newly-visible tab may hold widgets that were sized while display:none.
    // Nudge them after the browser has applied the layout change.
    requestAnimationFrame(function () {
      if (name === "history" && window.PHEV && typeof window.PHEV.resizeCharts === "function") {
        window.PHEV.resizeCharts();
      }
      // three-scene.js (hero) already listens for window resize; charts respond too.
      window.dispatchEvent(new Event("resize"));
    });
  }

  if (bar) {
    bar.addEventListener("click", function (e) {
      var btn = e.target.closest(".tab-btn");
      if (!btn) return;
      show(btn.getAttribute("data-tab"));
    });
  }

  // Default view.
  show("status");
})();

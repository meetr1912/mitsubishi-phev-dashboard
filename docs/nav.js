/* nav.js — three task-focused sections. Nodes stay mounted so a climate
 * selection or schedule draft is never lost while switching sections. */
(function () {
  "use strict";

  var TABS = ["status", "climate", "vehicle"];
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

    // Let any native controls reflow after the new section is visible.
    requestAnimationFrame(function () {
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

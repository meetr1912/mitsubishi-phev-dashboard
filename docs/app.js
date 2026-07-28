/* app.js — stat tiles, door/light status, remote command buttons.
 * Reads decrypted data via window.PHEV.onData(). */
(function () {
  "use strict";

  // ============================================================
  //  CONFIG — EDIT AFTER DEPLOYING THE CLOUDFLARE WORKER
  //  Paste the deployed Worker URL here (no trailing slash).
  //  e.g. 'https://phev-command-relay.yourname.workers.dev'
  // ============================================================
  var CONFIG = {
    WORKER_URL: "https://phev-command-relay.phev-command-relay.workers.dev"
  };

  // ---- small helpers ----
  function $(sel, root) { return (root || document).querySelector(sel); }
  function fieldEl(name) { return document.querySelector('[data-field="' + name + '"]'); }
  function setField(name, value) {
    var el = fieldEl(name);
    if (el) el.textContent = (value === null || value === undefined || value === "") ? "—" : value;
  }
  function kmToMi(km) { return km * 0.621371; }

  function titleize(s) {
    if (!s) return "—";
    return String(s).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function fmtTs(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  // ---- toast ----
  var toastRoot = document.getElementById("toast-root");
  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "toast toast-" + (kind || "info");
    el.textContent = msg;
    toastRoot.appendChild(el);
    // force reflow then show
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { el.remove(); }, 300);
    }, 3200);
  }

  // ---- render header + tiles ----
  function render(data) {
    if (!data) return;
    var v = data.vehicle || {};
    var l = data.latest || {};

    // header
    setText("#veh-nickname", v.nickname || "PHEV");
    var modelBits = [v.year, v.model, v.exterior_color].filter(Boolean).join(" · ");
    setText("#veh-model", modelBits || "—");
    setText("#veh-updated", "Updated " + fmtTs(l.ts || data.generated_at));
    setText("#veh-vin", data.vin ? "VIN " + data.vin : "—");

    // tiles
    setField("battery", (l.battery_pct != null) ? l.battery_pct + "%" : "—");
    var fill = document.getElementById("battery-fill");
    if (fill && l.battery_pct != null) {
      fill.style.width = Math.max(0, Math.min(100, l.battery_pct)) + "%";
      fill.style.background = l.battery_pct <= 15 ? "var(--danger)" : "var(--accent)";
    }
    setField("ev_range", rangeStr(l.ev_range_km));
    setField("gas_range", rangeStr(l.gas_range_km));
    setField("total_range", rangeStr(l.total_range_km));
    setField("odometer", (l.odometer_km != null)
      ? l.odometer_km.toLocaleString() + " km" : "—");
    setField("charging", chargingLabel(l.charging_status));
    setField("plugged", l.plugged_in == null ? "—" : (l.plugged_in ? "Yes" : "No"));
    setField("ttf", ttfStr(l.time_to_full_charge_min, l.charging_status));

    // doors + lights
    var doors = l.doors || {};
    Object.keys(doors).forEach(function (k) {
      paintDoor(k, doors[k]);
    });
    paintLights(l.headlights);
  }

  function rangeStr(km) {
    if (km == null) return "—";
    return km + " km";
  }
  function chargingLabel(status) {
    if (!status) return "—";
    if (status === "not_charging") return "Idle";
    return titleize(status);
  }
  function ttfStr(min, status) {
    if (min == null) return "—";
    if (!min || min <= 0) return (status === "charging") ? "—" : "Full / idle";
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + "h " : "") + m + "m";
  }

  function paintDoor(key, state) {
    var el = document.querySelector('.door[data-door="' + key + '"]');
    if (!el) return;
    var open = (state === "open" || state === true);
    el.classList.toggle("open", open);
    el.classList.toggle("closed", !open);
    var st = el.querySelector(".door-state");
    if (st) st.textContent = open ? "Open" : "Closed";
  }
  function paintLights(state) {
    var el = document.querySelector('.door[data-door="headlights"]');
    if (!el) return;
    var on = (state === "on" || state === true);
    el.classList.toggle("open", on);
    el.classList.toggle("closed", !on);
    var st = el.querySelector(".door-state");
    if (st) st.textContent = on ? "On" : "Off";
  }

  function setText(sel, txt) { var el = $(sel); if (el) el.textContent = txt; }

  // ---- commands ----
  function setBtnLoading(btn, loading) {
    if (loading) {
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.disabled = true;
      btn.classList.add("loading");
      btn.innerHTML = '<span class="spinner"></span> Sending…';
    } else {
      btn.disabled = false;
      btn.classList.remove("loading");
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  async function sendCommand(action, btn) {
    if (CONFIG.WORKER_URL.indexOf("REPLACE-ME") !== -1) {
      toast("Set CONFIG.WORKER_URL in app.js first.", "error");
      return;
    }
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) {
      toast("Set your Dashboard command key in Settings.", "error");
      if (window.PHEV.openSettings) window.PHEV.openSettings();
      return;
    }
    setBtnLoading(btn, true);
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/command", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dashboard-Key": key
        },
        body: JSON.stringify({ action: action })
      });
      var body = {};
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.ok && body.success) {
        toast(body.message || (titleize(action) + " sent."), "success");
      } else {
        toast(body.error || ("Failed (HTTP " + res.status + ")"), "error");
      }
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      setBtnLoading(btn, false);
    }
  }

  document.getElementById("commands").addEventListener("click", function (e) {
    var btn = e.target.closest(".cmd-btn");
    if (!btn || btn.disabled) return;
    var action = btn.dataset.action;
    if (!action || action === "defrost") return; // defrost is honestly disabled
    sendCommand(action, btn);
  });

  // ---- wire up ----
  window.PHEV.onData(render);
})();

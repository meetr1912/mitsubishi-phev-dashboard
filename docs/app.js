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
  var lastData = null;
  function render(data) {
    if (!data) return;
    lastData = data;
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
      fill.style.background = l.battery_pct <= 15
        ? "var(--danger)"
        : "linear-gradient(90deg, var(--ice-dim), var(--ice))";
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

    // tire pressure + active warnings
    renderTires(l.tire_pressure_bar);
    renderWarnings(l.warnings);
  }

  // ---- tire pressure (bar; missing -> "—") ----
  var TIRE_POS = ["front_left", "front_right", "rear_left", "rear_right"];
  function renderTires(tp) {
    tp = tp || {};
    TIRE_POS.forEach(function (key) {
      var el = document.querySelector('[data-tire-field="' + key + '"]');
      if (!el) return;
      var v = tp[key];
      el.textContent = (v === null || v === undefined) ? "—" : v;
    });
  }

  // ---- active warnings (panel hidden unless something is strictly true) ----
  var WARNING_DEFS = [
    { key: "brake", label: "Brake" },
    { key: "engine_oil", label: "Engine oil" },
    { key: "tire_pressure", label: "Tire pressure" },
    { key: "mil", label: "Check engine" },
    { key: "abs", label: "ABS" },
    { key: "airbag", label: "Airbag" }
  ];
  function renderWarnings(warnings) {
    var panel = document.getElementById("warnings-panel");
    var container = document.getElementById("warnings");
    if (!panel || !container) return;
    warnings = warnings || {};
    container.innerHTML = "";
    var active = WARNING_DEFS.filter(function (d) { return warnings[d.key] === true; });
    if (active.length === 0) { panel.hidden = true; return; }
    active.forEach(function (d) {
      var chip = document.createElement("div");
      chip.className = "warning-chip";
      chip.textContent = d.label;
      container.appendChild(chip);
    });
    panel.hidden = false;
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
  // The Worker polls the vehicle's event endpoint before replying, so a call
  // can legitimately take ~45s. Buttons keep their icon and label throughout
  // (no innerHTML swap) and just carry a pending class.
  function setBtnBusy(btn, busy, busyClass) {
    btn.disabled = busy;
    btn.classList.toggle(busyClass, busy);
  }

  function requireKey() {
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) {
      toast("Set your Dashboard command key in Settings.", "error");
      if (window.PHEV.openSettings) window.PHEV.openSettings();
      return null;
    }
    return key;
  }

  async function postCommand(action, minutes) {
    var key = requireKey();
    if (!key) return null;
    var payload = { action: action };
    if (minutes) payload.minutes = minutes;

    var res = await fetch(CONFIG.WORKER_URL + "/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Key": key },
      body: JSON.stringify(payload)
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, body: body };
  }

  function reportCommand(action, result) {
    if (!result) return false;
    var body = result.body || {};
    if (result.ok && body.success) {
      toast(body.message || (titleize(action) + " sent."), body.outcome === "timeout" ? "info" : "success");
      return body.outcome !== "timeout";
    }
    toast(body.error || body.message || ("Failed (HTTP " + result.status + ")"), "error");
    return false;
  }

  async function sendCommand(action, btn) {
    setBtnBusy(btn, true, "loading");
    try {
      reportCommand(action, await postCommand(action));
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      setBtnBusy(btn, false, "loading");
    }
  }

  document.getElementById("commands").addEventListener("click", function (e) {
    var btn = e.target.closest(".cmd-btn");
    if (!btn || btn.disabled) return;
    if (btn.dataset.action) sendCommand(btn.dataset.action, btn);
  });

  // ---- climate & comfort ----
  // Duration is a client-side choice sent as `minutes`; the Worker clamps it to
  // 1..30 regardless, so a tampered value can't leave the car running.
  var selectedMinutes = 10;
  var durationSelect = document.getElementById("duration-select");
  if (durationSelect) {
    durationSelect.addEventListener("click", function (e) {
      var opt = e.target.closest(".duration-opt");
      if (!opt) return;
      selectedMinutes = parseInt(opt.dataset.minutes, 10) || 10;
      Array.prototype.forEach.call(durationSelect.children, function (c) {
        c.classList.toggle("active", c === opt);
      });
    });
  }

  // "Active" is optimistic: the backend has no read-back for seat/wheel heat,
  // so a confirmed command lights the button for its own duration and then
  // clears itself. It reflects what we asked for, not a sensor reading.
  function markActiveFor(btn, minutes) {
    btn.classList.add("active");
    clearTimeout(btn._activeTimer);
    btn._activeTimer = setTimeout(function () {
      btn.classList.remove("active");
    }, minutes * 60 * 1000);
  }

  async function sendHvac(action, btn) {
    var minutes = selectedMinutes;
    setBtnBusy(btn, true, "sending");
    try {
      var result = await postCommand(action, minutes);
      if (reportCommand(action, result)) markActiveFor(btn, minutes);
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      setBtnBusy(btn, false, "sending");
    }
  }

  var climatePanel = document.getElementById("climate-panel");
  if (climatePanel) {
    climatePanel.addEventListener("click", function (e) {
      var btn = e.target.closest(".hvac-action");
      if (!btn || btn.disabled) return;
      sendHvac(btn.dataset.action, btn);
    });
  }

  // ---- manual "refresh now" (live status, on demand only — no auto-polling,
  // to avoid repeatedly waking the vehicle's telematics unit) ----
  async function refreshNow(btn) {
    var key = requireKey();
    if (!key) return;
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/status", {
        method: "GET",
        headers: { "X-Dashboard-Key": key }
      });
      var body = {};
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.ok && body.success && body.latest) {
        var merged = Object.assign({}, lastData || {}, { latest: body.latest });
        window.PHEV.setData(merged); // broadcasts to app.js AND three-scene.js listeners
        toast("Live status refreshed.", "success");
      } else {
        toast(body.error || ("Refresh failed (HTTP " + res.status + ")"), "error");
      }
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
    }
  }

  var refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { refreshNow(refreshBtn); });

  // ---- wire up ----
  window.PHEV.onData(render);
})();

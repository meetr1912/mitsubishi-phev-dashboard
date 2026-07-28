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
        : "linear-gradient(90deg, var(--accent-dim), var(--accent))";
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

    // First paint after unlock renders the cached snapshot; immediately pull one
    // live status so the very first view is current without a manual refresh.
    // Guarded so it fires exactly once (our own merge re-enters render()).
    if (!autoRefreshed) {
      autoRefreshed = true;
      autoRefreshOnUnlock();
      // Independent of the status fetch: widens the temperature stepper to
      // whatever this vehicle actually supports.
      loadTempRange();
      // Prefills the charging-schedule editor with whatever is already
      // configured on the vehicle, so Save doesn't silently overwrite it.
      loadChargingSchedule();
    }
  }

  // ---- tire pressure (bar; missing -> "—") ----
  var TIRE_POS = ["front_left", "front_right", "rear_left", "rear_right"];
  function renderTires(tp) {
    tp = tp || {};
    TIRE_POS.forEach(function (key) {
      var el = document.querySelector('[data-tire-field="' + key + '"]');
      if (!el) return;
      var v = tp[key];
      var num = (typeof v === "number") ? v : parseFloat(v);
      // Fixed 1 decimal (2.2999999 -> "2.3"); non-numeric / missing -> "—".
      el.textContent = (v === null || v === undefined || isNaN(num)) ? "—" : num.toFixed(1);
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

  // Single POST /command sender. Takes a fully-formed payload so both simple
  // commands and the composite climate request go through one code path.
  async function postCommandBody(payload) {
    var key = requireKey();
    if (!key) return null;
    var res = await fetch(CONFIG.WORKER_URL + "/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Key": key },
      body: JSON.stringify(payload)
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, body: body };
  }

  function postCommand(action) {
    return postCommandBody({ action: action });
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

  function flashConfirmed(btn) {
    btn.classList.add("confirmed");
    clearTimeout(btn._confirmTimer);
    btn._confirmTimer = setTimeout(function () {
      btn.classList.remove("confirmed");
    }, 2500);
  }

  async function sendCommand(action, btn) {
    setBtnBusy(btn, true, "loading");
    try {
      var confirmed = reportCommand(action, await postCommand(action));
      if (confirmed) {
        flashConfirmed(btn);
        // Poll said Successful, but that's the vehicle ACK, not necessarily
        // the sensor state yet — pull real status so doors/lights/lock
        // reflect the change instead of staying on whatever was last fetched.
        // Reuses the same quiet (no toast, no error surfacing) refresh used
        // right after unlock.
        autoRefreshOnUnlock();
      }
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
  // Comfort zones (seats, wheel, defrost), duration and temperature are all
  // LOCAL selections — tapping them only changes UI state, no network. The one
  // and only network call is "Start climate", which submits the whole config in
  // a single request:  { action:"climate", minutes, temperatureC, options:[...] }.
  // Unselected options are turned OFF server-side, so cabin state matches the UI.
  // Until Start is pressed (or after any later change) the selection is *pending*
  // (armed, outlined); only a confirmed start reads as *running* (filled + glow).
  var VALID_OPTIONS = ["seat_fl", "seat_fr", "seat_rl", "seat_rr",
                       "steering_heat", "defrost_front", "defrost_rear", "max_defrost"];
  // Read off this vehicle's own posmap via GET /config (2025 DGE, Outlander
  // Electric): 18.0–32.0 °C in 0.5 steps, plus LO and HI endpoints. The range
  // is a property of the car, so /config is also queried at unlock to pick up
  // a different table without a redeploy. Degrees are converted to the wire's
  // position index Worker-side — on this car 22 °C is index 10.
  var TEMP_MIN = 18, TEMP_MAX = 32, TEMP_STEP = 0.5;
  var selectedMinutes = 10;
  var selectedTempC = 22;
  var selectedOptions = {};       // option string -> true
  var climateRunning = false;     // true only after a confirmed Start

  var climatePanel = document.getElementById("climate-panel");
  var climateStartBtn = document.getElementById("climate-start");
  var climateStopBtn = document.getElementById("climate-stop");
  var tempValueEl = document.getElementById("temp-value");

  function comfortButtons() {
    return climatePanel ? climatePanel.querySelectorAll(".comfort-toggle") : [];
  }
  function startLabel(txt) {
    var lbl = climateStartBtn && climateStartBtn.querySelector(".climate-master-label");
    if (lbl) lbl.textContent = txt;
  }
  function renderTemp() {
    if (!tempValueEl) return;
    // Half-steps show a decimal, whole degrees stay clean ("22°C", "22.5°C").
    var txt = (selectedTempC % 1 === 0) ? String(selectedTempC) : selectedTempC.toFixed(1);
    tempValueEl.textContent = txt + "°C";
  }

  // The selectable range belongs to the car, not to this code. /config reports
  // it, so a different vehicle or a firmware change widens the stepper without
  // a redeploy. Silent and best-effort: on any failure the values read off this
  // vehicle's posmap stay in force.
  async function loadTempRange() {
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) return;
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/config", {
        headers: { "X-Dashboard-Key": key }
      });
      if (!res.ok) return;
      var body = await res.json();
      var t = body && body.temperature;
      if (!t || typeof t.minC !== "number" || typeof t.maxC !== "number") return;
      if (t.maxC <= t.minC) return;
      TEMP_MIN = t.minC;
      TEMP_MAX = t.maxC;
      if (typeof t.step === "number" && t.step > 0) TEMP_STEP = t.step;
      if (selectedTempC < TEMP_MIN) selectedTempC = TEMP_MIN;
      if (selectedTempC > TEMP_MAX) selectedTempC = TEMP_MAX;
      renderTemp();
    } catch (e) { /* keep the built-in range */ }
  }

  // A confirmed-running comfort zone stays lit for the chosen duration then
  // clears itself — the backend has no read-back for comfort zones, so this
  // reflects what we asked for, not a sensor reading.
  function markRunningFor(btn, minutes) {
    btn.classList.remove("armed");
    btn.classList.add("running");
    clearTimeout(btn._runTimer);
    btn._runTimer = setTimeout(function () {
      btn.classList.remove("running");
    }, minutes * 60 * 1000);
  }

  // Any config change after a start drops us back to pending: the car is running
  // the OLD config, so nothing should keep claiming the new selection is live.
  function markPending() {
    if (!climateRunning) return;
    climateRunning = false;
    if (climateStartBtn) {
      climateStartBtn.classList.remove("running");
      clearTimeout(climateStartBtn._runTimer);
    }
    if (climateStopBtn) climateStopBtn.hidden = true;
    Array.prototype.forEach.call(comfortButtons(), function (b) {
      clearTimeout(b._runTimer);
      b.classList.remove("running");
      // still-selected zones revert to armed (pending); deselected stay off
      if (selectedOptions[b.dataset.option]) b.classList.add("armed");
    });
    startLabel("Start climate");
  }

  // Stop is a SEPARATE remote operation ("engineOff"), not "re-send climate
  // with everything off" — the car is asked to end the whole session. On
  // success this clears the running state immediately rather than waiting out
  // the original duration timer, since the car has confirmed it is already off.
  async function stopClimate() {
    if (!climateStopBtn || climateStopBtn.disabled) return;
    climateStopBtn.disabled = true;
    climateStopBtn.classList.add("sending");
    try {
      var result = await postCommand("climate_stop");
      if (reportCommand("climate_stop", result)) {
        markPending();
      }
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      climateStopBtn.classList.remove("sending");
      climateStopBtn.disabled = false;
    }
  }

  function toggleOption(btn) {
    var opt = btn.dataset.option;
    if (VALID_OPTIONS.indexOf(opt) === -1) return;
    var on = !selectedOptions[opt];
    if (on) { selectedOptions[opt] = true; } else { delete selectedOptions[opt]; }
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.remove("running");
    btn.classList.toggle("armed", on);
    markPending();
  }

  function selectDuration(opt) {
    selectedMinutes = parseInt(opt.dataset.minutes, 10) || 10;
    Array.prototype.forEach.call(opt.parentNode.children, function (c) {
      c.classList.toggle("active", c === opt);
    });
    markPending();
  }

  // delta is a direction (-1 / +1), not a temperature — one press moves one
  // rung of the car's own grid, which is half a degree here.
  function stepTemp(direction) {
    if (!direction) return;
    var next = selectedTempC + (direction > 0 ? TEMP_STEP : -TEMP_STEP);
    // Float arithmetic on 0.5 steps drifts (22.5 + 0.5 - 0.5 !== 22.5 exactly),
    // so round back onto the grid each time.
    next = Math.round(next / TEMP_STEP) * TEMP_STEP;
    next = Math.round(next * 10) / 10;
    if (next < TEMP_MIN) next = TEMP_MIN;
    if (next > TEMP_MAX) next = TEMP_MAX;
    if (next === selectedTempC) return;
    selectedTempC = next;
    renderTemp();
    markPending();
  }

  // The single submit. Builds the composite payload and sends exactly one
  // request; the button is disabled for the whole ~45s round-trip so it can't
  // be double-submitted.
  async function startClimate() {
    if (!climateStartBtn || climateStartBtn.disabled) return;
    var minutes = selectedMinutes;
    var options = VALID_OPTIONS.filter(function (o) { return !!selectedOptions[o]; });
    var payload = {
      action: "climate", minutes: minutes,
      temperatureC: selectedTempC, options: options
    };

    climateStartBtn.disabled = true;
    climateStartBtn.classList.add("sending");
    startLabel("Starting…");
    try {
      var result = await postCommandBody(payload);
      climateStartBtn.classList.remove("sending");
      if (reportCommand("climate", result)) {
        climateRunning = true;
        climateStartBtn.classList.add("running");
        if (climateStopBtn) climateStopBtn.hidden = false;
        startLabel("Climate running");
        clearTimeout(climateStartBtn._runTimer);
        climateStartBtn._runTimer = setTimeout(function () {
          climateRunning = false;
          climateStartBtn.classList.remove("running");
          startLabel("Start climate");
        }, minutes * 60 * 1000);
        Array.prototype.forEach.call(comfortButtons(), function (b) {
          if (selectedOptions[b.dataset.option]) markRunningFor(b, minutes);
        });
      } else {
        startLabel("Start climate");
      }
    } catch (e) {
      climateStartBtn.classList.remove("sending");
      startLabel("Start climate");
      toast("Network error: " + e.message, "error");
    } finally {
      climateStartBtn.disabled = false;
    }
  }

  // One delegated listener on #climate-panel routes every control.
  if (climatePanel) {
    climatePanel.addEventListener("click", function (e) {
      var toggle = e.target.closest(".comfort-toggle");
      if (toggle) { toggleOption(toggle); return; }
      var dur = e.target.closest(".duration-opt");
      if (dur) { selectDuration(dur); return; }
      var temp = e.target.closest(".temp-step");
      if (temp) { stepTemp(parseInt(temp.dataset.tempStep, 10) || 0); return; }
      var start = e.target.closest(".climate-master");
      if (start) { startClimate(); return; }
      var stop = e.target.closest(".climate-stop");
      if (stop) { stopClimate(); return; }
    });
  }
  renderTemp();

  // ---- live status fetch (shared by manual refresh + one-shot auto refresh) ----
  // GET /status; on a good payload merge just `latest` into the cached data and
  // rebroadcast (updates app.js tiles AND three-scene.js). Returns a small
  // result object — callers decide whether to surface success/failure.
  async function fetchLiveStatus(key) {
    var res = await fetch(CONFIG.WORKER_URL + "/status", {
      method: "GET",
      headers: { "X-Dashboard-Key": key }
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.ok && body.success && body.latest) {
      var merged = Object.assign({}, lastData || {}, { latest: body.latest });
      window.PHEV.setData(merged);
      return { ok: true, body: body };
    }
    return { ok: false, status: res.status, body: body };
  }

  // Manual "refresh now" — an explicit user action, so it is loud: spinner +
  // toasts, and it nudges Settings if no key is set. No auto-polling; every call
  // wakes the vehicle's telematics unit.
  async function refreshNow(btn) {
    var key = requireKey();
    if (!key) return;
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      var r = await fetchLiveStatus(key);
      if (r.ok) toast("Live status refreshed.", "success");
      else toast((r.body && r.body.error) || ("Refresh failed (HTTP " + r.status + ")"), "error");
    } catch (e) {
      toast("Network error: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
    }
  }

  var refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { refreshNow(refreshBtn); });

  // ---- one-shot auto refresh on unlock ----
  // The cached snapshot can be up to an hour stale, so pull one live status right
  // after unlock — the first view is then current with no manual refresh. Quiet
  // path: no key -> stay on cached data silently; any error also fails silent
  // (no toast, no settings modal — those belong to explicit taps only). Fires
  // exactly once per unlock (guarded in render()); no polling, no refetch on tab
  // switch, so the telematics unit is woken at most once.
  var autoRefreshed = false;
  var vehUpdatedEl = document.getElementById("veh-updated");
  var updatingEl = null;
  function showUpdating(on) {
    if (!vehUpdatedEl) return;
    if (on) {
      if (!updatingEl) {
        updatingEl = document.createElement("span");
        updatingEl.className = "veh-updating";
        updatingEl.textContent = "updating…";
      }
      if (updatingEl.parentNode !== vehUpdatedEl) vehUpdatedEl.appendChild(updatingEl);
    } else if (updatingEl && updatingEl.parentNode) {
      updatingEl.parentNode.removeChild(updatingEl);
    }
  }

  async function autoRefreshOnUnlock() {
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) return;                 // no key -> silent, keep cached data
    showUpdating(true);
    try {
      await fetchLiveStatus(key);     // merge happens inside on success
    } catch (e) {
      /* silent — cached data stays on screen */
    } finally {
      showUpdating(false);
    }
  }

  // ---- charging schedule (operation "chargingControl2") ----
  // The vehicle always holds exactly 3 timer slots ("Timer 1/2/3"); an
  // unconfigured slot is saved disabled, not omitted. chargingId is generated
  // by the WORKER (not the vehicle) the first time a slot is saved, so it can
  // only be learned by reading it back — either from a prior load, or from the
  // save response, which echoes exactly what it sent. Losing track of an id
  // would make the next save create a fresh duplicate timer instead of editing
  // the one before it, so every successful save re-populates from the echo.
  var CHARGE_DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var schedulePanel = document.getElementById("charging-schedule-panel");
  var scheduleStatusEl = document.getElementById("schedule-status");
  var scheduleSaveBtn = document.getElementById("schedule-save");
  var timerCards = schedulePanel ? schedulePanel.querySelectorAll(".charge-timer") : [];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function minutesToTimeStr(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    return pad2(Math.floor(mins / 60)) + ":" + pad2(mins % 60);
  }
  function timeStrToMinutes(str) {
    var parts = String(str || "0:0").split(":");
    var h = parseInt(parts[0], 10) || 0;
    var m = parseInt(parts[1], 10) || 0;
    return h * 60 + m;
  }

  function populateTimerCard(card, timer) {
    timer = timer || { id: null, enabled: false, startMinutes: 0, endMinutes: 360, days: [] };
    card.dataset.chargingId = timer.id || "";
    var enable = card.querySelector(".charge-timer-enable");
    if (enable) enable.checked = !!timer.enabled;
    var start = card.querySelector(".charge-timer-start");
    if (start) start.value = minutesToTimeStr(timer.startMinutes || 0);
    var end = card.querySelector(".charge-timer-end");
    if (end) end.value = minutesToTimeStr(timer.endMinutes || 0);
    var days = timer.days || [];
    Array.prototype.forEach.call(card.querySelectorAll(".charge-day-btn"), function (btn) {
      btn.classList.toggle("active", days.indexOf(btn.dataset.day) !== -1);
    });
  }

  function readTimerCard(card) {
    var enable = card.querySelector(".charge-timer-enable");
    var start = card.querySelector(".charge-timer-start");
    var end = card.querySelector(".charge-timer-end");
    var days = [];
    Array.prototype.forEach.call(card.querySelectorAll(".charge-day-btn.active"), function (btn) {
      days.push(btn.dataset.day);
    });
    return {
      id: card.dataset.chargingId || null,
      enabled: !!(enable && enable.checked),
      startMinutes: timeStrToMinutes(start && start.value),
      endMinutes: timeStrToMinutes(end && end.value),
      days: days
    };
  }

  // Best-effort, silent: this backs a background prefill, not a user action.
  // Leaves the default (all disabled, 00:00-06:00) in place on any failure.
  async function loadChargingSchedule() {
    if (!schedulePanel) return;
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) return;
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/settings?operation=chargingControl2", {
        headers: { "X-Dashboard-Key": key }
      });
      if (!res.ok) { if (scheduleStatusEl) scheduleStatusEl.textContent = "Could not load current schedule."; return; }
      var body = await res.json();
      var schedule = (body && body.schedule) || [];
      for (var i = 0; i < timerCards.length; i++) populateTimerCard(timerCards[i], schedule[i]);
      if (scheduleStatusEl) {
        scheduleStatusEl.textContent = schedule.length
          ? "Loaded from vehicle."
          : "No schedule on file yet — configure below and save.";
      }
    } catch (e) {
      if (scheduleStatusEl) scheduleStatusEl.textContent = "Could not load current schedule.";
    }
  }

  async function saveSchedule() {
    if (!scheduleSaveBtn || scheduleSaveBtn.disabled) return;
    var timers = [];
    for (var i = 0; i < timerCards.length; i++) timers.push(readTimerCard(timerCards[i]));

    scheduleSaveBtn.disabled = true;
    scheduleSaveBtn.classList.add("sending");
    if (scheduleStatusEl) scheduleStatusEl.textContent = "Saving…";
    try {
      var result = await postCommandBody({ action: "charging_schedule", timers: timers });
      if (reportCommand("charging_schedule", result)) {
        // Re-populate from the echo so the ids we just learned are used on the
        // NEXT save instead of being treated as new timers again.
        var echoed = (result.body && result.body.timers) || [];
        for (var j = 0; j < timerCards.length; j++) populateTimerCard(timerCards[j], echoed[j]);
        if (scheduleStatusEl) scheduleStatusEl.textContent = "Saved.";
      } else if (scheduleStatusEl) {
        scheduleStatusEl.textContent = "Save failed — see the message above.";
      }
    } catch (e) {
      toast("Network error: " + e.message, "error");
      if (scheduleStatusEl) scheduleStatusEl.textContent = "Save failed.";
    } finally {
      scheduleSaveBtn.classList.remove("sending");
      scheduleSaveBtn.disabled = false;
    }
  }

  if (schedulePanel) {
    schedulePanel.addEventListener("click", function (e) {
      var day = e.target.closest(".charge-day-btn");
      if (day) { day.classList.toggle("active"); return; }
      var save = e.target.closest("#schedule-save");
      if (save) { saveSchedule(); return; }
    });
  }

  // ---- wire up ----
  window.PHEV.onData(render);
})();

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
  // Kept public because it is a deployment URL, not a credential. Other
  // dashboard modules use this instead of duplicating the endpoint string.
  window.PHEV.WORKER_URL = CONFIG.WORKER_URL;

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
  var vehicleState = {};
  var ALL_DOOR_KEYS = ["front_left", "front_right", "rear_left", "rear_right", "hood", "trunk"];
  function render(data) {
    if (!data) return;
    lastData = data;
    var v = data.vehicle || {};
    var l = data.latest || {};

    // Real data exists now -- drop the shimmer placeholders in bulk. Every
    // field below gets written in this same pass, so there's no point
    // tracking removal per-field; a no-op on every render after the first.
    document.querySelectorAll(".skeleton").forEach(function (el) {
      el.classList.remove("skeleton");
    });

    // header
    setText("#veh-nickname", v.nickname || "PHEV");
    var modelBits = [v.year, v.model, v.exterior_color].filter(Boolean).join(" · ");
    setText("#veh-model", modelBits || "—");
    setText("#veh-updated", "Updated " + fmtTs(l.ts || data.generated_at));
    setText("#veh-vin", data.vin ? "VIN " + data.vin : "—");
    renderHomeStatus(l);

    // tiles
    setField("battery", (l.battery_pct != null) ? l.battery_pct + "%" : "—");
    setField("ev_range", rangeStr(l.ev_range_km));
    setField("gas_range", rangeStr(l.gas_range_km));
    setField("total_range", rangeStr(l.total_range_km));
    setField("odometer", (l.odometer_km != null)
      ? l.odometer_km.toLocaleString() + " km" : "—");
    setField("charging", chargingLabel(l.charging_status));
    setField("plugged", l.plugged_in == null ? "—" : (l.plugged_in ? "Yes" : "No"));
    setField("ttf", ttfStr(l.time_to_full_charge_min, l.charging_status));
    setField("battery_health", l.battery_health_pct != null ? l.battery_health_pct + "%" : "—");

    // doors + lights
    var doors = l.doors && typeof l.doors === "object" ? l.doors : {};
    ALL_DOOR_KEYS.forEach(function (k) {
      paintDoor(k, Object.prototype.hasOwnProperty.call(doors, k) ? doors[k] : null);
    });
    paintLights(l.headlights);

    // Reported condition only.
    renderTires(l.tire_pressure_bar);
    renderWarnings(l.warnings);
    renderHealthSummary(l);
    renderLocation(l.location);

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
      // Climate scheduling uses a different Mitsubishi service. It has to be
      // read before the UI becomes writable, because the Worker preserves the
      // vehicle's saved temperature and equipment-specific HVAC settings.
      loadClimateSchedule();
      // Snow Guard is separate Worker-owned state. It never edits the three
      // Mitsubishi climate timers and remains opt-in.
      loadSnowGuard();
    }
  }

  // The home screen uses a short, honest summary. It never infers a locked
  // vehicle from incomplete door telemetry, and it keeps a confirmed climate
  // session distinct from the next sensor report.
  function renderHomeStatus(latest) {
    latest = latest || {};
    var state = document.getElementById("home-state");
    var title = document.getElementById("home-title");
    var detail = document.getElementById("home-detail");
    if (!state || !title || !detail) return;

    var classes = "status-pill";
    var hasReport = Object.keys(latest).length > 0;
    var doors = latest.doors && typeof latest.doors === "object" ? latest.doors : {};
    var openAccess = ALL_DOOR_KEYS.filter(function (key) { return isOn(doors[key]); });
    var knownAccess = ALL_DOOR_KEYS.filter(function (key) { return isKnown(doors[key]); });
    var charging = latest.charging_status === "charging";

    if (!hasReport) {
      state.textContent = "Waiting for report";
      title.textContent = "Vehicle status unavailable";
      detail.textContent = "Unlock the dashboard to see the most recent report.";
    } else if (openAccess.length) {
      state.textContent = "Check vehicle";
      classes += " is-warning";
      title.textContent = openAccess.length + " access point" + (openAccess.length === 1 ? " is" : "s are") + " open";
      detail.textContent = "This is from the latest vehicle report.";
    } else if (charging) {
      state.textContent = "Charging";
      classes += " is-active";
      title.textContent = "Charging in progress";
      detail.textContent = latest.plugged_in ? "The vehicle reports that it is plugged in." : "Charging was reported by the vehicle.";
    } else if (vehicleClimate.running) {
      state.textContent = "Climate running";
      classes += " is-active";
      title.textContent = "Climate was confirmed";
      detail.textContent = "The timer shown in Climate is based on the confirmed request.";
    } else {
      state.textContent = "Report received";
      classes += " is-ready";
      title.textContent = knownAccess.length === ALL_DOOR_KEYS.length ? "All reported access points are closed" : "Vehicle report received";
      detail.textContent = knownAccess.length === ALL_DOOR_KEYS.length ? "Refresh before relying on this status away from the vehicle." : "Some access sensors were not included in this report.";
    }
    state.className = classes;
  }

  // Legacy animation helpers remain inert while the new task-first interface
  // is in place. Vehicle state is now summarized in renderHomeStatus().
  // This visualization only reflects fields from the last vehicle report. It
  // is intentionally separate from command outcome feedback: a remote command
  // can be confirmed by the operation endpoint before the next status report
  // has reached the dashboard.
  var VEHICLE_DOOR_KEYS = ["front_left", "front_right", "rear_left", "rear_right"];
  // These are the complete, app-provided four-door state illustrations. The
  // dashboard only uses one once *all four* sensors have reported: showing a
  // closed-car glyph for partial data would be worse than showing nothing.
  var DOOR_GLYPH_BY_STATE = {
    "": "doors_all_closed_white.png",
    "front_left": "doors_frontleft_open.png",
    "front_right": "doors_frontright_open.png",
    "rear_left": "doors_rearleft_open.png",
    "rear_right": "doors_rearright_open.png",
    "front_left|front_right": "doors_frontleft_frontright_open.png",
    "front_left|rear_left": "doors_frontleft_rearleft_open.png",
    "front_left|rear_right": "doors_frontleft_rearright_open.png",
    "front_right|rear_left": "doors_frontright_rearleft_open.png",
    "front_right|rear_right": "doors_frontright_rearright_open.png",
    "rear_left|rear_right": "doors_rearleft_rearright_open.png",
    "front_left|front_right|rear_left": "doors_frontleft_frontright_rearleft_open.png",
    "front_left|front_right|rear_right": "doors_frontleft_frontright_rearright_open.png",
    "front_left|rear_left|rear_right": "doors_frontleft_rearleft_rearright_open.png",
    "front_right|rear_left|rear_right": "doors_frontright_rearleft_rearright_open.png",
    "front_left|front_right|rear_left|rear_right": "doors_all_open.png"
  };
  var vehicleClimate = { running: false, options: [] };
  var doorGlyphTimer = null;
  var commandVisualTimer = null;
  function isOn(value) { return value === true || value === "on" || value === "open"; }
  function isKnown(value) { return value !== null && value !== undefined && value !== ""; }

  function setVehicleSignal(id, text, state) {
    var signal = document.getElementById(id);
    if (!signal) return;
    var value = signal.querySelector("strong");
    if (value) value.textContent = text;
    signal.className = "vehicle-signal" + (state ? " " + state : "");
  }

  function renderDoorGlyph(doors, allReported) {
    var root = document.getElementById("vehicle-access-glyph");
    var image = document.getElementById("door-state-glyph");
    if (!root || !image) return;
    if (!allReported) {
      root.hidden = true;
      return;
    }
    var open = VEHICLE_DOOR_KEYS.filter(function (key) { return isOn(doors[key]); });
    var asset = DOOR_GLYPH_BY_STATE[open.join("|")];
    if (!asset) { root.hidden = true; return; }
    root.hidden = false;
    var nextSrc = "assets/vehicle/" + asset;
    if (image.getAttribute("src") === nextSrc) return;
    clearTimeout(doorGlyphTimer);
    root.classList.add("is-changing");
    doorGlyphTimer = setTimeout(function () {
      image.setAttribute("src", nextSrc);
      root.classList.remove("is-changing");
    }, 130);
  }

  // This is a command receipt visual, not a sensor reading. It is deliberately
  // transient so a confirmed remote action can feel tangible without claiming
  // that a later vehicle report has already caught up.
  function setVehicleCommandFeedback(action, phase) {
    var hero = document.getElementById("vehicle-hero");
    var label = document.getElementById("vehicle-command-label");
    if (!hero || !label) return;
    var visualActions = ["lock", "unlock", "horn", "lights", "locate"];
    visualActions.forEach(function (name) { hero.classList.remove("command-" + name); });
    clearTimeout(commandVisualTimer);

    if (phase === "sending") {
      label.textContent = titleize(action) + "…";
      label.hidden = false;
      return;
    }
    if (phase === "pending") {
      label.textContent = titleize(action) + " awaiting vehicle";
      label.hidden = false;
      commandVisualTimer = setTimeout(function () { label.hidden = true; }, 3200);
      return;
    }
    if (phase === "failed") {
      label.textContent = titleize(action) + " not confirmed";
      label.hidden = false;
      commandVisualTimer = setTimeout(function () { label.hidden = true; }, 3200);
      return;
    }
    if (phase === "confirmed") {
      if (visualActions.indexOf(action) !== -1) hero.classList.add("command-" + action);
      label.textContent = titleize(action) + " confirmed";
      label.hidden = false;
      commandVisualTimer = setTimeout(function () {
        visualActions.forEach(function (name) { hero.classList.remove("command-" + name); });
        label.hidden = true;
      }, 2800);
    }
  }

  function setVehicleClimateState(running, options) {
    vehicleClimate.running = !!running;
    vehicleClimate.options = Array.isArray(options) ? options.slice() : [];
    var hero = document.getElementById("vehicle-hero");
    if (hero) hero.classList.toggle("is-climate-running", vehicleClimate.running);
    var climateState = document.getElementById("climate-state");
    if (climateState) {
      climateState.className = "status-pill" + (vehicleClimate.running ? " is-active" : "");
      climateState.textContent = vehicleClimate.running ? "Running" : "Off";
    }
    if (lastData && lastData.latest) renderHomeStatus(lastData.latest);
    setVehicleSignal(
      "vehicle-climate-signal",
      vehicleClimate.running ? "Running" : "Off",
      vehicleClimate.running ? "is-charging" : ""
    );
  }

  function renderVehicleVisual(latest) {
    latest = latest || {};
    var hero = document.getElementById("vehicle-hero");
    if (!hero) return;

    var hasReport = Object.keys(latest).length > 0;
    var doors = latest.doors && typeof latest.doors === "object" ? latest.doors : null;
    var doorsReported = !!doors && Object.keys(doors).length > 0;
    var openAccess = doorsReported ? ALL_DOOR_KEYS.filter(function (key) { return isOn(doors[key]); }) : [];
    var openBody = openAccess.filter(function (key) { return key === "hood" || key === "trunk"; });
    var reportedAccessCount = doorsReported ? VEHICLE_DOOR_KEYS.filter(function (key) { return isKnown(doors[key]); }).length : 0;
    var allAccessReported = reportedAccessCount === VEHICLE_DOOR_KEYS.length;
    var accessText = !doorsReported ? "Not reported" : openAccess.length ? openAccess.length + " open" : reportedAccessCount === VEHICLE_DOOR_KEYS.length ? "All closed" : reportedAccessCount + " reported";
    var accessState = !doorsReported ? "" : (openAccess.length ? "is-alert" : "is-reported");
    setVehicleSignal("vehicle-access-signal", accessText, accessState);

    var openDetail = document.getElementById("vehicle-open-detail");
    if (openDetail) {
      openDetail.hidden = openBody.length === 0;
      openDetail.textContent = openBody.map(function (key) { return key === "hood" ? "Hood open" : "Liftgate open"; }).join(" · ");
    }

    document.querySelectorAll("[data-vehicle-door]").forEach(function (door) {
      var key = door.dataset.vehicleDoor;
      var known = doorsReported && isKnown(doors[key]);
      door.classList.toggle("is-open", known && isOn(doors[key]));
      door.classList.toggle("is-unknown", !known);
    });
    renderDoorGlyph(doors || {}, allAccessReported);

    var lightsKnown = isKnown(latest.headlights);
    var lightsOn = lightsKnown && isOn(latest.headlights);
    hero.classList.toggle("lights-on", lightsOn);
    setVehicleSignal("vehicle-lights-signal", !lightsKnown ? "Not reported" : (lightsOn ? "On" : "Off"), lightsKnown ? "is-reported" : "");

    var chargingStatus = latest.charging_status;
    var chargingKnown = isKnown(chargingStatus);
    var isCharging = chargingStatus === "charging";
    var chargeText = !chargingKnown ? "Not reported" : isCharging ? "Charging" : latest.plugged_in ? "Plugged in" : "Idle";
    hero.classList.toggle("is-charging", isCharging);
    setVehicleSignal("vehicle-charge-signal", chargeText, !chargingKnown ? "" : (isCharging ? "is-charging" : "is-reported"));

    var battery = Number(latest.battery_pct);
    var batteryKnown = isKnown(latest.battery_pct) && isFinite(battery);
    var batteryEl = document.getElementById("vehicle-hero-battery");
    var batteryUnitEl = document.getElementById("vehicle-hero-battery-unit");
    if (batteryEl) batteryEl.textContent = batteryKnown ? String(Math.round(battery)) : "—";
    if (batteryUnitEl) batteryUnitEl.hidden = !batteryKnown;

    var liveState = document.getElementById("vehicle-live-state");
    var visualDesc = document.getElementById("vehicle-visual-desc");
    var stateText = "Waiting for report";
    var stateClass = "";
    var description = "Waiting for the most recent vehicle report.";
    if (hasReport) {
      stateText = "Report received";
      stateClass = "is-reported";
      description = "Last vehicle report received.";
      if (openAccess.length) {
        stateText = openAccess.length + " access point" + (openAccess.length === 1 ? "" : "s") + " open";
        stateClass = "is-alert";
        description = "Last vehicle report shows " + stateText + ".";
      } else if (isCharging) {
        stateText = "Charging";
        stateClass = "is-charging";
        description = "Last vehicle report shows the vehicle charging.";
      }
    }
    hero.classList.toggle("has-open-access", openAccess.length > 0);
    hero.classList.toggle("is-climate-running", vehicleClimate.running);
    setVehicleSignal(
      "vehicle-climate-signal",
      vehicleClimate.running ? "Running" : "Off",
      vehicleClimate.running ? "is-charging" : ""
    );
    if (liveState) {
      liveState.className = "vehicle-live-state" + (stateClass ? " " + stateClass : "");
      liveState.textContent = stateText;
    }
    if (visualDesc) visualDesc.textContent = description;
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

  function activeWarningCount(warnings) {
    warnings = warnings || {};
    return WARNING_DEFS.filter(function (d) { return warnings[d.key] === true; }).length;
  }

  // A health result is only affirmative when the vehicle returned its health
  // report. Missing data never becomes a reassuring "all good" message.
  function renderHealthSummary(latest) {
    latest = latest || {};
    var summary = document.getElementById("vehicle-health-summary");
    var battery = document.getElementById("vehicle-health-battery");
    var panel = document.getElementById("vehicle-health-panel");
    if (battery) battery.textContent = latest.battery_health_pct != null ? latest.battery_health_pct + "%" : "—";
    if (!summary) return;
    if (latest.health_reported !== true) {
      summary.textContent = "Health report not available";
      if (panel) panel.classList.remove("has-alert");
      return;
    }
    var count = activeWarningCount(latest.warnings);
    summary.textContent = count ? count + " reported warning" + (count === 1 ? "" : "s") : "No reported warnings";
    if (panel) panel.classList.toggle("has-alert", count > 0);
  }

  function validCoordinate(value, min, max) {
    var n = Number(value);
    return isFinite(n) && n >= min && n <= max;
  }

  // This is the vehicle's own last reported position. It is never requested
  // from a mapping service; the external map is opened only after a user tap.
  function renderLocation(location) {
    var panel = document.getElementById("location-panel");
    var label = document.getElementById("location-coordinates");
    var note = document.getElementById("location-availability");
    var link = document.getElementById("location-open");
    if (!panel || !label || !note || !link) return;
    var lat = location && location.lat;
    var lon = location && location.lon;
    var known = validCoordinate(lat, -90, 90) && validCoordinate(lon, -180, 180);
    var privacyEnabled = vehicleState && vehicleState.privacyModeEnabled === true;
    panel.hidden = !known && !privacyEnabled;
    if (privacyEnabled) {
      label.textContent = "Location sharing paused";
      note.textContent = "Privacy mode is reported on.";
      link.hidden = true;
      return;
    }
    if (!known) return;
    var latitude = Number(lat);
    var longitude = Number(lon);
    label.textContent = latitude.toFixed(5) + ", " + longitude.toFixed(5);
    note.textContent = "Last reported vehicle position";
    link.hidden = false;
    link.href = "https://maps.apple.com/?ll=" + encodeURIComponent(latitude.toFixed(6) + "," + longitude.toFixed(6));
  }

  // ---- driving score (panel hidden unless the account has any score to show) ----
  // [UNVERIFIED] field locations are inferred from decompiled classes on the
  // worker side (see index.ts parseDrivingScore) -- expect "—" until
  // confirmed against a real account with driving history.
  var DRIVING_SCORE_FIELDS = ["ds_overall", "ds_accel", "ds_steer", "ds_brake", "ds_fuel"];
  function renderDrivingScore(score) {
    var panel = document.getElementById("driving-score-panel");
    if (!panel) return;
    score = score || {};
    var values = {
      ds_overall: score.overall_score,
      ds_accel: score.acceleration_score,
      ds_steer: score.steering_score,
      ds_brake: score.braking_score,
      ds_fuel: score.fuel_economy_score
    };
    var any = DRIVING_SCORE_FIELDS.some(function (k) { return values[k] != null; });
    panel.hidden = !any;
    if (!any) return;
    DRIVING_SCORE_FIELDS.forEach(function (k) { setField(k, values[k]); });
  }

  // ---- vehicle flags (live-only: GET /state, not part of the hourly snapshot) ----
  var FLAG_DEFS = [
    { key: "ignitionOn", label: "Ignition" },
    { key: "privacyModeEnabled", label: "Privacy mode" },
    { key: "diagnosticMode", label: "Diagnostic mode" },
    { key: "svla", label: "SVLA" },
    { key: "theftAlarm", label: "Theft alarm active", onlyIfTrue: true },
    { key: "factoryReset", label: "Factory reset detected", onlyIfTrue: true }
  ];
  function renderFlags(flags) {
    var panel = document.getElementById("flags-panel");
    var container = document.getElementById("flags");
    if (!panel || !container) return;
    flags = flags || {};
    vehicleState = flags;
    container.innerHTML = "";
    var shown = 0;
    FLAG_DEFS.forEach(function (def) {
      var val = flags[def.key];
      if (val === null || val === undefined) return; // unknown -- omit rather than guess
      if (def.onlyIfTrue && !val) return;
      shown++;
      var chip = document.createElement("div");
      chip.className = "flag-chip" + (val ? " flag-on" : "") + (def.onlyIfTrue ? " flag-alert" : "");
      chip.textContent = def.onlyIfTrue ? def.label : (def.label + ": " + (val ? "On" : "Off"));
      container.appendChild(chip);
    });
    panel.hidden = shown === 0;
    if (lastData && lastData.latest) renderLocation(lastData.latest.location);

    // Locate requires vehicle location services. When privacy mode is
    // explicitly reported on, keep the control visibly unavailable instead of
    // sending a command the vehicle will reject. Unknown remains available.
    var locateBlocked = flags.privacyModeEnabled === true;
    Array.prototype.forEach.call(document.querySelectorAll('[data-remote-action="locate"]'), function (locateBtn) {
      locateBtn.disabled = locateBlocked;
      locateBtn.classList.toggle("not-available", locateBlocked);
      if (locateBlocked) locateBtn.setAttribute("title", "Unavailable while vehicle privacy mode is on");
      else locateBtn.removeAttribute("title");
    });
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
    var known = isKnown(state);
    var open = known && isOn(state);
    el.classList.toggle("open", open);
    el.classList.toggle("closed", known && !open);
    var st = el.querySelector(".door-state");
    if (st) st.textContent = known ? (open ? "Open" : "Closed") : "—";
  }
  function paintLights(state) {
    var el = document.querySelector('.door[data-door="headlights"]');
    if (!el) return;
    var known = isKnown(state);
    var on = known && isOn(state);
    el.classList.toggle("open", on);
    el.classList.toggle("closed", known && !on);
    var st = el.querySelector(".door-state");
    if (st) st.textContent = known ? (on ? "On" : "Off") : "—";
  }

  function setText(sel, txt) { var el = $(sel); if (el) el.textContent = txt; }

  // ---- commands ----
  // The Worker polls the vehicle's event endpoint before replying, so a call
  // can legitimately take up to ~75s (worst case seen live 2026-07-28: 60s to
  // reach a terminal state) — and "climate" specifically can take up to ~120s,
  // since it first submits and polls an engineOff teardown before the actual
  // remoteAC start (see runClimateStart() in the Worker). Buttons keep their
  // icon and label throughout (no innerHTML swap) and just carry a pending
  // class; there is no client-side fetch timeout, so this is a long wait, not
  // a stuck one.
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

  // “Confirmed” is only used after the remote-operation poll reaches the
  // vehicle's successful terminal state. “Submitted” and “timed out” remain
  // visibly distinct so the dashboard never overclaims that a button worked.
  var commandReceiptEl = document.getElementById("command-receipt");
  function renderCommandReceipt(action, result) {
    if (!commandReceiptEl || !result) return;
    var body = result.body || {};
    var outcome = body.outcome || "";
    var kind = (result.ok && body.success && outcome === "succeeded")
      ? "confirmed"
      : (result.ok && body.success ? "submitted" : "rejected");
    var text = body.message || body.error || (titleize(action) + " could not be confirmed.");
    commandReceiptEl.hidden = false;
    commandReceiptEl.className = "command-receipt " + kind;
    commandReceiptEl.textContent = text;
  }

  function reportCommand(action, result) {
    if (!result) return false;
    var body = result.body || {};
    renderCommandReceipt(action, result);
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
    setVehicleCommandFeedback(action, "sending");
    try {
      var result = await postCommand(action);
      var confirmed = reportCommand(action, result);
      if (confirmed) {
        setVehicleCommandFeedback(action, "confirmed");
        flashConfirmed(btn);
        // Poll said Successful, but that's the vehicle ACK, not necessarily
        // the sensor state yet — pull real status so doors/lights/lock
        // reflect the change instead of staying on whatever was last fetched.
        // Reuses the same quiet (no toast, no error surfacing) refresh used
        // right after unlock.
        autoRefreshOnUnlock();
      } else {
        var body = (result && result.body) || {};
        setVehicleCommandFeedback(action, result && result.ok && body.success ? "pending" : "failed");
      }
    } catch (e) {
      setVehicleCommandFeedback(action, "failed");
      toast("Network error: " + e.message, "error");
    } finally {
      setBtnBusy(btn, false, "loading");
    }
  }

  // Remote controls are always deliberate. A tap describes the operation;
  // only the second, explicit confirmation sends it to the Worker.
  var commandConfirmModal = document.getElementById("command-confirm-modal");
  var commandConfirmKind = document.getElementById("command-confirm-kind");
  var commandConfirmTitle = document.getElementById("command-confirm-title");
  var commandConfirmCopy = document.getElementById("command-confirm-copy");
  var commandConfirmBtn = document.getElementById("command-confirm");
  var commandConfirmCancelBtn = document.getElementById("command-confirm-cancel");
  var pendingConfirmation = null;
  var REMOTE_ACTION_COPY = {
    lock: { kind: "Vehicle security", title: "Lock vehicle?", copy: "This asks the vehicle to lock its doors.", confirm: "Lock vehicle" },
    unlock: { kind: "Vehicle security", title: "Unlock vehicle?", copy: "This can make the vehicle accessible to anyone nearby.", confirm: "Unlock vehicle", destructive: true },
    locate: { kind: "Vehicle location", title: "Find vehicle?", copy: "This asks the vehicle to signal its location. It is unavailable while privacy mode is on.", confirm: "Find vehicle" },
    lights: { kind: "Vehicle signal", title: "Flash lights?", copy: "This can be visible and distracting to people near the vehicle.", confirm: "Flash lights" },
    horn: { kind: "Vehicle signal", title: "Sound horn?", copy: "This can be loud for people near the vehicle.", confirm: "Sound horn", destructive: true },
    charge_start: { kind: "Charging", title: "Start charging?", copy: "The vehicle will attempt to begin charging if it is connected and ready.", confirm: "Start charging" },
    charge_stop: { kind: "Charging", title: "Stop charging?", copy: "This stops an active vehicle charge session.", confirm: "Stop charging", destructive: true }
  };

  function closeConfirmation() {
    if (!commandConfirmModal) return;
    var trigger = pendingConfirmation && pendingConfirmation.trigger;
    pendingConfirmation = null;
    commandConfirmModal.classList.remove("open");
    commandConfirmModal.setAttribute("aria-hidden", "true");
    if (trigger && typeof trigger.focus === "function") trigger.focus();
  }

  function requestConfirmation(config) {
    if (!config || typeof config.execute !== "function") return;
    if (!commandConfirmModal || !commandConfirmBtn || !commandConfirmTitle || !commandConfirmCopy || !commandConfirmKind) {
      config.execute();
      return;
    }
    pendingConfirmation = config;
    commandConfirmKind.textContent = config.kind || "Remote action";
    commandConfirmTitle.textContent = config.title || "Confirm action";
    commandConfirmCopy.textContent = config.copy || "This will send a request to the vehicle.";
    commandConfirmBtn.textContent = config.confirm || "Continue";
    commandConfirmBtn.classList.toggle("is-destructive", !!config.destructive);
    commandConfirmModal.classList.add("open");
    commandConfirmModal.setAttribute("aria-hidden", "false");
    commandConfirmBtn.focus();
  }

  function requestRemoteCommand(action, btn) {
    var copy = REMOTE_ACTION_COPY[action];
    if (!copy) return;
    requestConfirmation({
      kind: copy.kind,
      title: copy.title,
      copy: copy.copy,
      confirm: copy.confirm,
      destructive: copy.destructive,
      trigger: btn,
      execute: function () { sendCommand(action, btn); }
    });
  }

  if (commandConfirmCancelBtn) commandConfirmCancelBtn.addEventListener("click", closeConfirmation);
  if (commandConfirmBtn) {
    commandConfirmBtn.addEventListener("click", function () {
      var pending = pendingConfirmation;
      if (!pending) return;
      closeConfirmation();
      pending.execute();
    });
  }
  if (commandConfirmModal) {
    commandConfirmModal.addEventListener("click", function (e) {
      if (e.target === commandConfirmModal) closeConfirmation();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && pendingConfirmation) closeConfirmation();
  });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-remote-action]");
    if (!btn || btn.disabled) return;
    requestRemoteCommand(btn.dataset.remoteAction, btn);
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
  var climateConfigDirty = false; // selected UI differs from a live session
  // The Worker owns the stop-then-start sequence. Keeping it server-side
  // prevents duplicate engineOff calls when a user changes a running session.

  var climatePanel = document.getElementById("climate-panel");
  var climateStartBtn = document.getElementById("climate-start");
  var climateStopBtn = document.getElementById("climate-stop");
  var tempValueEl = document.getElementById("temp-value");
  var vehicleSupportStatusEl = document.getElementById("vehicle-support-status");
  var vehicleSupportChipsEl = document.getElementById("vehicle-support-chips");
  var serviceDiscoveryEl = document.getElementById("service-discovery");
  var serviceDiscoverySummaryEl = document.getElementById("service-discovery-summary");
  var serviceDiscoveryChipsEl = document.getElementById("service-discovery-chips");

  var CLIMATE_OPTION_LABELS = {
    seat_fl: "Front-left seat",
    seat_fr: "Front-right seat",
    seat_rl: "Rear-left seat",
    seat_rr: "Rear-right seat",
    steering_heat: "Wheel heat",
    defrost_front: "Front defrost",
    defrost_rear: "Rear defrost",
    max_defrost: "Max defrost"
  };

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

  function addSupportChip(root, text, state) {
    if (!root) return;
    var chip = document.createElement("span");
    chip.className = "vehicle-support-chip " + state;
    chip.textContent = text;
    root.appendChild(chip);
  }

  function setOptionAvailability(btn, available) {
    if (!btn) return;
    var option = btn.dataset.option;
    btn.disabled = !available;
    btn.classList.toggle("not-supported", !available);
    if (!available) {
      delete selectedOptions[option];
      btn.setAttribute("aria-pressed", "false");
      btn.classList.remove("armed", "running");
      btn.title = "Not reported by this vehicle";
    } else {
      btn.removeAttribute("title");
    }
  }

  // Use only a positive, vehicle-reported capability response to disable a
  // control. A failed or unfamiliar response leaves the controls available:
  // lack of evidence is not evidence of lack of support.
  function renderVehicleSupport(config) {
    var hvac = config && config.capabilities && config.capabilities.hvac;
    var reported = hvac && hvac.availability === "reported" && Array.isArray(hvac.supported);
    var supported = reported ? new Set(hvac.supported) : null;

    if (reported) {
      Array.prototype.forEach.call(comfortButtons(), function (btn) {
        var option = btn.dataset.option;
        // Mitsubishi carries this as dt.def, not inside remoteAC settings, so
        // it has no per-control availability field to check.
        if (option === "max_defrost") return;
        setOptionAvailability(btn, supported.has(option));
      });

      if (vehicleSupportStatusEl) {
        vehicleSupportStatusEl.textContent = "Vehicle-reported climate support";
      }
      if (vehicleSupportChipsEl) {
        vehicleSupportChipsEl.hidden = false;
        vehicleSupportChipsEl.textContent = "";
        VALID_OPTIONS.forEach(function (option) {
          var state = option === "max_defrost" ? "protocol" : (supported.has(option) ? "supported" : "unsupported");
          var suffix = state === "supported" ? " · reported" : state === "unsupported" ? " · unavailable" : " · separate mode";
          addSupportChip(vehicleSupportChipsEl, CLIMATE_OPTION_LABELS[option] + suffix, state);
        });
      }
    } else if (vehicleSupportStatusEl) {
      vehicleSupportStatusEl.textContent = "Vehicle support was not reported; controls remain available.";
    }

    var services = config && Array.isArray(config.services) ? config.services : [];
    if (serviceDiscoveryEl && serviceDiscoverySummaryEl && serviceDiscoveryChipsEl) {
      serviceDiscoveryChipsEl.textContent = "";
      serviceDiscoveryEl.hidden = services.length === 0;
      if (services.length) {
        serviceDiscoverySummaryEl.textContent = "Vehicle-reported services (" + services.length + ")";
        services.forEach(function (service) {
          addSupportChip(serviceDiscoveryChipsEl, titleize(service), "service");
        });
      }
    }
  }

  // /config describes the vehicle's temperature grid, reported optional HVAC
  // controls, and advertised services. This remains silent/best-effort: a
  // failed read must not block climate or turn unknown support into “off”.
  async function loadTempRange() {
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) return;
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/config", {
        headers: { "X-Dashboard-Key": key }
      });
      if (!res.ok) {
        renderVehicleSupport(null);
        return;
      }
      var body = await res.json();
      if (!body || !body.success) {
        renderVehicleSupport(null);
        return;
      }
      renderVehicleSupport(body);
      var t = body && body.temperature;
      if (!t || typeof t.minC !== "number" || typeof t.maxC !== "number") return;
      if (t.maxC <= t.minC) return;
      TEMP_MIN = t.minC;
      TEMP_MAX = t.maxC;
      if (typeof t.step === "number" && t.step > 0) TEMP_STEP = t.step;
      if (selectedTempC < TEMP_MIN) selectedTempC = TEMP_MIN;
      if (selectedTempC > TEMP_MAX) selectedTempC = TEMP_MAX;
      renderTemp();
    } catch (e) { renderVehicleSupport(null); }
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

  // A config change does not stop the existing climate session. The controls
  // become pending, but Stop stays available and the vehicle visual continues
  // to show the last confirmed session until it ends or is explicitly stopped.
  function markPending() {
    if (!climateRunning) return;
    climateConfigDirty = true;
    if (climateStartBtn) {
      climateStartBtn.classList.add("has-pending");
    }
    Array.prototype.forEach.call(comfortButtons(), function (b) {
      clearTimeout(b._runTimer);
      b.classList.remove("running");
      // still-selected zones revert to armed (pending); deselected stay off
      if (selectedOptions[b.dataset.option]) b.classList.add("armed");
    });
    startLabel("Update climate");
  }

  function clearClimateSession() {
    climateRunning = false;
    climateConfigDirty = false;
    if (climateStartBtn) {
      climateStartBtn.classList.remove("running", "has-pending");
      clearTimeout(climateStartBtn._runTimer);
    }
    if (climateStopBtn) climateStopBtn.hidden = true;
    Array.prototype.forEach.call(comfortButtons(), function (b) {
      clearTimeout(b._runTimer);
      b.classList.remove("running");
      if (selectedOptions[b.dataset.option]) b.classList.add("armed");
    });
    setVehicleClimateState(false);
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
    setVehicleCommandFeedback("climate_stop", "sending");
    try {
      var result = await postCommand("climate_stop");
      if (reportCommand("climate_stop", result)) {
        clearClimateSession();
        setVehicleCommandFeedback("climate_stop", "confirmed");
      } else {
        var body = (result && result.body) || {};
        setVehicleCommandFeedback("climate_stop", result && result.ok && body.success ? "pending" : "failed");
      }
    } catch (e) {
      setVehicleCommandFeedback("climate_stop", "failed");
      toast("Network error: " + e.message, "error");
    } finally {
      climateStopBtn.classList.remove("sending");
      climateStopBtn.disabled = false;
    }
  }

  function requestClimateStop() {
    requestConfirmation({
      kind: "Climate",
      title: "Stop climate?",
      copy: "This ends the current remote climate session.",
      confirm: "Stop climate",
      destructive: true,
      trigger: climateStopBtn,
      execute: stopClimate
    });
  }

  var CLIMATE_PRESETS = {
    cabin_heat: { temperatureC: 24, options: [] },
    clear_windshield: { temperatureC: 28, options: ["max_defrost", "defrost_front"] },
    rear_glass: { temperatureC: 22, options: ["defrost_rear"] }
  };

  // Presets make the vehicle-level modes explicit. They only populate the
  // local selection; Start climate remains the one intentional remote action.
  function applyClimatePreset(name) {
    var preset = CLIMATE_PRESETS[name];
    if (!preset) return;
    selectedTempC = Math.max(TEMP_MIN, Math.min(TEMP_MAX, preset.temperatureC));
    selectedTempC = Math.round(selectedTempC / TEMP_STEP) * TEMP_STEP;
    selectedTempC = Math.round(selectedTempC * 10) / 10;
    selectedOptions = {};
    preset.options.forEach(function (opt) {
      var button = climatePanel && climatePanel.querySelector('[data-option="' + opt + '"]');
      if (!button || !button.disabled) selectedOptions[opt] = true;
    });
    Array.prototype.forEach.call(comfortButtons(), function (btn) {
      var on = !btn.disabled && !!selectedOptions[btn.dataset.option];
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.remove("running");
      btn.classList.toggle("armed", on);
    });
    renderTemp();
    markPending();
  }

  function toggleOption(btn) {
    var opt = btn.dataset.option;
    if (btn.disabled || VALID_OPTIONS.indexOf(opt) === -1) return;
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
  // request; the button is disabled for the whole round-trip (up to ~120s —
  // see the setBtnBusy comment above) so it can't be double-submitted.
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
    startLabel(climateRunning ? "Updating…" : "Starting…");
    setVehicleCommandFeedback("climate", "sending");
    try {
      // runClimateStart() performs engineOff once, then remoteAC, using one
      // authenticated server-side flow. Do not send climate_stop here too.
      var result = await postCommandBody(payload);
      climateStartBtn.classList.remove("sending");
      if (reportCommand("climate", result)) {
        climateRunning = true;
        climateConfigDirty = false;
        climateStartBtn.classList.add("running");
        climateStartBtn.classList.remove("has-pending");
        if (climateStopBtn) climateStopBtn.hidden = false;
        startLabel("Climate running");
        setVehicleClimateState(true, options);
        setVehicleCommandFeedback("climate", "confirmed");
        clearTimeout(climateStartBtn._runTimer);
        climateStartBtn._runTimer = setTimeout(function () {
          clearClimateSession();
        }, minutes * 60 * 1000);
        Array.prototype.forEach.call(comfortButtons(), function (b) {
          if (selectedOptions[b.dataset.option]) markRunningFor(b, minutes);
        });
      } else {
        // The stop (if any) succeeded but the restart didn't -- the car is
        // now actually off, so reflect that instead of leaving stale
        // "running" UI behind.
        clearClimateSession();
        var body = (result && result.body) || {};
        setVehicleCommandFeedback("climate", result && result.ok && body.success ? "pending" : "failed");
      }
    } catch (e) {
      climateStartBtn.classList.remove("sending");
      startLabel(climateRunning ? (climateConfigDirty ? "Update climate" : "Climate running") : "Start climate");
      setVehicleCommandFeedback("climate", "failed");
      toast("Network error: " + e.message, "error");
    } finally {
      climateStartBtn.disabled = false;
    }
  }

  // One delegated listener on #climate-panel routes every control.
  if (climatePanel) {
    climatePanel.addEventListener("click", function (e) {
      var preset = e.target.closest(".climate-preset");
      if (preset) { applyClimatePreset(preset.dataset.preset); return; }
      var toggle = e.target.closest(".comfort-toggle");
      if (toggle) { toggleOption(toggle); return; }
      var dur = e.target.closest(".duration-opt");
      if (dur) { selectDuration(dur); return; }
      var temp = e.target.closest(".temp-step");
      if (temp) { stepTemp(parseInt(temp.dataset.tempStep, 10) || 0); return; }
      var start = e.target.closest(".climate-master");
      if (start) { startClimate(); return; }
      var stop = e.target.closest(".climate-stop");
      if (stop) { requestClimateStop(); return; }
    });
  }
  renderTemp();

  // ---- live status fetch (shared by manual refresh + one-shot auto refresh) ----
  // GET /status; on a good payload merge just `latest` into the cached data and
  // rebroadcast (updates the tiles and the vehicle-status SVG). Returns a small
  // result object — callers decide whether to surface success/failure.
  async function fetchLiveStatus(key) {
    var res = await fetch(CONFIG.WORKER_URL + "/status", {
      method: "GET",
      headers: { "X-Dashboard-Key": key }
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.ok && body.success && body.latest) {
      // /status intentionally returns only live fields. Preserve cached
      // history-derived fields that this endpoint does not own (for example
      // driving score), rather than blanking the dashboard after a refresh.
      var mergedLatest = Object.assign({}, (lastData && lastData.latest) || {}, body.latest);
      var merged = Object.assign({}, lastData || {}, { latest: mergedLatest });
      window.PHEV.setData(merged);
      return { ok: true, body: body };
    }
    return { ok: false, status: res.status, body: body };
  }

  // GET /state; renders straight into the flags panel (no cached-data merge —
  // these flags aren't part of the hourly snapshot, so there's nothing to
  // merge them into). Always best-effort: a failure here should never make an
  // otherwise-successful /status refresh look failed.
  async function fetchVehicleFlags(key) {
    var res = await fetch(CONFIG.WORKER_URL + "/state", {
      method: "GET",
      headers: { "X-Dashboard-Key": key }
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.ok && body.success && body.state) renderFlags(body.state);
    return { ok: res.ok && !!(body && body.success) };
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
      fetchVehicleFlags(key).catch(function () { /* best-effort, not part of the toast below */ });
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

  // Exposed so pull-refresh.js can drive the exact same loud (spinner +
  // toast) refresh from a pull gesture instead of duplicating this logic.
  // refreshNow only touches .disabled/.classList on whatever element it's
  // given, so a plain div works exactly like the real button.
  window.PHEV.refreshNow = refreshNow;

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
      await fetchVehicleFlags(key);   // renders directly; no merge to do
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

  // ---- climate schedule (operation "climateControl") ----
  // Mitsubishi calls the time an endTimeOfDay, but the app's own wording is
  // departure / "ready by": it decides when to start pre-conditioning. Each
  // schedule has exactly three slots. The Worker refuses a write until it has
  // read the actual slots, so a dashboard save cannot invent a temperature or
  // toggle an option the vehicle did not report.
  var climateSchedulePanel = document.getElementById("climate-schedule-panel");
  var climateScheduleStatusEl = document.getElementById("climate-schedule-status");
  var climateScheduleTimersEl = document.getElementById("climate-schedule-timers");
  var climateScheduleSaveBtn = document.getElementById("climate-schedule-save");
  var climateTimerCards = [];
  var climateScheduleLoaded = false;

  function makeClimateTimerCards() {
    if (!climateScheduleTimersEl || climateTimerCards.length) return;
    var labels = ["M", "T", "W", "T", "F", "S", "S"];
    for (var i = 0; i < 3; i++) {
      var card = document.createElement("div");
      card.className = "climate-timer";
      card.dataset.timer = String(i);
      var dayButtons = "";
      for (var d = 0; d < CHARGE_DAY_ORDER.length; d++) {
        dayButtons += '<button type="button" class="climate-day-btn" data-day="' + CHARGE_DAY_ORDER[d] + '">' + labels[d] + "</button>";
      }
      card.innerHTML =
        '<div class="climate-timer-head"><label class="climate-enable">' +
          '<input type="checkbox" class="climate-timer-enable" />' +
          "<span>Timer " + (i + 1) + "</span>" +
        "</label></div>" +
        '<div class="climate-time-row"><label>Ready by ' +
          '<input type="time" class="climate-timer-departure" value="08:00" />' +
        "</label></div>" +
        '<div class="climate-days" role="group" aria-label="Timer ' + (i + 1) + ' days">' + dayButtons + "</div>";
      climateScheduleTimersEl.appendChild(card);
      climateTimerCards.push(card);
    }
  }

  function populateClimateTimerCard(card, timer) {
    timer = timer || { id: null, enabled: false, departureMinutes: 480, days: [] };
    card.dataset.conditioningId = timer.id || "";
    var enable = card.querySelector(".climate-timer-enable");
    if (enable) enable.checked = !!timer.enabled;
    var departure = card.querySelector(".climate-timer-departure");
    if (departure) departure.value = minutesToTimeStr(timer.departureMinutes || 0);
    var days = timer.days || [];
    Array.prototype.forEach.call(card.querySelectorAll(".climate-day-btn"), function (btn) {
      btn.classList.toggle("active", days.indexOf(btn.dataset.day) !== -1);
    });
  }

  function readClimateTimerCard(card) {
    var enable = card.querySelector(".climate-timer-enable");
    var departure = card.querySelector(".climate-timer-departure");
    var days = [];
    Array.prototype.forEach.call(card.querySelectorAll(".climate-day-btn.active"), function (btn) {
      days.push(btn.dataset.day);
    });
    return {
      id: card.dataset.conditioningId || null,
      enabled: !!(enable && enable.checked),
      departureMinutes: timeStrToMinutes(departure && departure.value),
      days: days
    };
  }

  async function loadClimateSchedule() {
    if (!climateSchedulePanel) return;
    makeClimateTimerCards();
    climateScheduleLoaded = false;
    if (climateScheduleSaveBtn) climateScheduleSaveBtn.disabled = true;
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) {
      if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Unlock to load the vehicle schedule.";
      return;
    }
    if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Loading vehicle schedule…";
    try {
      var res = await fetch(CONFIG.WORKER_URL + "/settings?operation=climateControl", {
        headers: { "X-Dashboard-Key": key }
      });
      var body = null;
      try { body = await res.json(); } catch (e) { /* handled below */ }
      var schedule = (body && body.schedule) || [];
      if (!res.ok || !body || !body.success) {
        if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Climate scheduling is not available from this vehicle response.";
        return;
      }
      if (schedule.length < climateTimerCards.length) {
        if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Vehicle did not return all climate timers. Open Climate Schedule once in the Mitsubishi app, then reload.";
        return;
      }
      for (var i = 0; i < climateTimerCards.length; i++) populateClimateTimerCard(climateTimerCards[i], schedule[i]);
      climateScheduleLoaded = true;
      if (climateScheduleSaveBtn) climateScheduleSaveBtn.disabled = false;
      if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Loaded from vehicle. Cabin target and climate options will be preserved.";
    } catch (e) {
      if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Could not load the climate schedule.";
    }
  }

  async function saveClimateSchedule() {
    if (!climateScheduleSaveBtn || climateScheduleSaveBtn.disabled || !climateScheduleLoaded) return;
    var timers = [];
    for (var i = 0; i < climateTimerCards.length; i++) timers.push(readClimateTimerCard(climateTimerCards[i]));
    climateScheduleSaveBtn.disabled = true;
    climateScheduleSaveBtn.classList.add("sending");
    if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Saving to vehicle…";
    try {
      var result = await postCommandBody({ action: "climate_schedule", timers: timers });
      reportCommand("climate_schedule", result);
      var body = result && result.body;
      if (result && result.ok && body && body.success) {
        var echoed = body.timers || [];
        for (var j = 0; j < climateTimerCards.length; j++) populateClimateTimerCard(climateTimerCards[j], echoed[j]);
        if (climateScheduleStatusEl) {
          climateScheduleStatusEl.textContent = body.outcome === "succeeded"
            ? "Saved and confirmed by vehicle."
            : "Schedule submitted. The vehicle did not report a final outcome yet.";
        }
      } else if (climateScheduleStatusEl) {
        climateScheduleStatusEl.textContent = "Save failed — see the message above.";
      }
    } catch (e) {
      toast("Network error: " + e.message, "error");
      if (climateScheduleStatusEl) climateScheduleStatusEl.textContent = "Save failed.";
    } finally {
      climateScheduleSaveBtn.classList.remove("sending");
      climateScheduleSaveBtn.disabled = !climateScheduleLoaded;
    }
  }

  if (climateSchedulePanel) {
    climateSchedulePanel.addEventListener("click", function (e) {
      var day = e.target.closest(".climate-day-btn");
      if (day) { day.classList.toggle("active"); return; }
      var save = e.target.closest("#climate-schedule-save");
      if (save) { saveClimateSchedule(); }
    });
  }

  // ---- Snow Guard --------------------------------------------------------
  // This is intentionally separate from the three Mitsubishi climate timer
  // slots. The Worker persists its settings and decisions, then an internal
  // 15-minute cron may submit a *new* remote climate request when safeguards
  // and meaningful near-term snow agree. "Check conditions" is dry-run only.
  var snowGuardPanel = document.getElementById("snow-guard-panel");
  var snowGuardEnabledEl = document.getElementById("snow-guard-enabled");
  var snowGuardLocationEl = document.getElementById("snow-guard-location");
  var snowGuardMinBatteryEl = document.getElementById("snow-guard-min-battery");
  var snowGuardPluggedEl = document.getElementById("snow-guard-require-plugged");
  var snowGuardStatusEl = document.getElementById("snow-guard-status");
  var snowGuardSummaryEl = document.getElementById("snow-guard-summary");
  var snowGuardSaveBtn = document.getElementById("snow-guard-save");
  var snowGuardCheckBtn = document.getElementById("snow-guard-check");
  var snowGuardHistoryEl = document.getElementById("snow-guard-history");
  var snowGuardHistoryListEl = document.getElementById("snow-guard-history-list");
  var snowGuardState = null;

  async function snowGuardRequest(path, method, payload) {
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) return { ok: false, status: 401, body: { error: "Unlock required" }, transportError: null };
    var controller = window.AbortController ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
    try {
      var res = await fetch(CONFIG.WORKER_URL + path, {
        method: method,
        headers: Object.assign({ "X-Dashboard-Key": key }, payload ? { "Content-Type": "application/json" } : {}),
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller ? controller.signal : undefined
      });
      var body = {};
      try { body = await res.json(); } catch (e) { /* status below remains useful */ }
      return { ok: res.ok, status: res.status, body: body, transportError: null };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: null,
        transportError: e && e.name === "AbortError" ? "timeout" : "network"
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function snowGuardFailureMessage(result) {
    if (!result) return "Snow Guard request could not start.";
    if (result.status === 401) return "Dashboard access expired. Unlock again, then retry.";
    if (result.status === 404) {
      return "Snow Guard is not deployed to the command relay yet. The dashboard is newer than the live Worker; no vehicle action was sent.";
    }
    if (result.status === 502 || result.status === 503) {
      return "Snow Guard is deploying or unavailable on the relay. Retry shortly; no vehicle action was sent.";
    }
    if (result.transportError === "timeout") return "Snow Guard did not respond within 12 seconds. Retry; no vehicle action was sent.";
    if (result.transportError === "network") return "Snow Guard could not reach the command relay. Check your connection, then retry.";
    if (result.body && typeof result.body.error === "string" && result.body.error) {
      return "Snow Guard: " + result.body.error;
    }
    return "Snow Guard request failed. No vehicle action was sent.";
  }

  function showSnowGuardFailure(result) {
    if (!snowGuardStatusEl) return;
    snowGuardStatusEl.className = "snow-guard-status error";
    snowGuardStatusEl.textContent = snowGuardFailureMessage(result);
  }

  function snowGuardKind(code) {
    if (code === "climate_started") return "good";
    if (code === "climate_pending" || code === "light_snow" || code === "remote_climate_reserve") return "caution";
    if (code === "weather_unavailable" || code === "climate_error" || code === "climate_rejected") return "error";
    return "";
  }

  function formatSnowWeather(weather) {
    if (!weather) return "";
    var temp = typeof weather.temperatureC === "number" ? Math.round(weather.temperatureC) + "°C" : "temperature unavailable";
    var snow = typeof weather.nextThreeHoursSnowCm === "number" ? weather.nextThreeHoursSnowCm.toFixed(1) + " cm / 3 h" : "snowfall unavailable";
    var adhesion = weather.adhesionRisk ? " · " + weather.adhesionRisk + " adhesion" : "";
    return temp + " · " + snow + adhesion;
  }

  function renderSnowGuard(body) {
    if (!body) return;
    snowGuardState = body;
    var config = body.config || {};
    var runtime = body.runtime || {};
    if (snowGuardEnabledEl) snowGuardEnabledEl.checked = config.enabled === true;
    if (snowGuardLocationEl && config.location && config.location.label) snowGuardLocationEl.value = config.location.label;
    if (snowGuardMinBatteryEl && config.minBatteryPct != null) snowGuardMinBatteryEl.value = String(config.minBatteryPct);
    if (snowGuardPluggedEl) snowGuardPluggedEl.checked = config.requirePlugged !== false;
    if (snowGuardSummaryEl) {
      snowGuardSummaryEl.textContent = config.enabled ? "On · 15 min" : "Off";
      snowGuardSummaryEl.classList.toggle("active", config.enabled === true);
    }
    var decision = runtime.lastDecision || null;
    if (snowGuardStatusEl) {
      snowGuardStatusEl.className = "snow-guard-status" + (decision ? " " + snowGuardKind(decision.code) : "");
      if (decision) {
        var weather = formatSnowWeather(decision.weather);
        snowGuardStatusEl.textContent = decision.summary + (weather ? " " + weather + "." : "");
      } else {
        snowGuardStatusEl.textContent = config.enabled ? "Ready. Waiting for the next weather check." : "Snow Guard is off.";
      }
    }
    var events = Array.isArray(body.events) ? body.events.slice(0, 6) : [];
    if (snowGuardHistoryEl) snowGuardHistoryEl.hidden = events.length === 0;
    if (snowGuardHistoryListEl) {
      snowGuardHistoryListEl.textContent = "";
      events.forEach(function (event) {
        var item = document.createElement("li");
        var title = document.createElement("strong");
        title.textContent = fmtTs(event.at) + " · " + titleize(event.code || "snow guard");
        var copy = document.createElement("span");
        copy.textContent = (event.summary || "") + (event.weather ? " " + formatSnowWeather(event.weather) + "." : "");
        item.appendChild(title);
        item.appendChild(copy);
        snowGuardHistoryListEl.appendChild(item);
      });
    }
  }

  async function loadSnowGuard() {
    if (!snowGuardPanel) return;
    var key = window.PHEV.getApiKey ? window.PHEV.getApiKey() : "";
    if (!key) {
      if (snowGuardStatusEl) snowGuardStatusEl.textContent = "Unlock to load Snow Guard.";
      return;
    }
    if (snowGuardStatusEl) snowGuardStatusEl.textContent = "Loading Snow Guard…";
    var result = await snowGuardRequest("/snow-guard", "GET");
    if (!result.ok || !result.body || !result.body.success) return showSnowGuardFailure(result);
    renderSnowGuard(result.body);
  }

  async function saveSnowGuard() {
    if (!snowGuardSaveBtn || snowGuardSaveBtn.disabled) return;
    snowGuardSaveBtn.disabled = true;
    snowGuardSaveBtn.classList.add("sending");
    if (snowGuardStatusEl) snowGuardStatusEl.textContent = "Saving Snow Guard…";
    var current = (snowGuardState && snowGuardState.config) || {};
    var config = {
      enabled: !!(snowGuardEnabledEl && snowGuardEnabledEl.checked),
      minBatteryPct: parseInt(snowGuardMinBatteryEl && snowGuardMinBatteryEl.value, 10) || 35,
      requirePlugged: !!(snowGuardPluggedEl && snowGuardPluggedEl.checked),
      location: current.location || { latitude: 44.6488, longitude: -63.5752, label: "Halifax, NS" }
    };
    try {
      var result = await snowGuardRequest("/snow-guard", "PUT", config);
      if (!result.ok || !result.body || !result.body.success) {
        showSnowGuardFailure(result);
        toast("Snow Guard save failed.", "error");
        return;
      }
      renderSnowGuard(result.body);
      toast(config.enabled ? "Snow Guard enabled." : "Snow Guard disabled.", "success");
    } catch (e) {
      showSnowGuardFailure(null);
      toast("Snow Guard save failed.", "error");
    } finally {
      snowGuardSaveBtn.classList.remove("sending");
      snowGuardSaveBtn.disabled = false;
    }
  }

  async function checkSnowGuard() {
    if (!snowGuardCheckBtn || snowGuardCheckBtn.disabled) return;
    snowGuardCheckBtn.disabled = true;
    if (snowGuardStatusEl) snowGuardStatusEl.textContent = "Checking Halifax conditions…";
    try {
      var result = await snowGuardRequest("/snow-guard/check", "POST");
      if (!result.ok || !result.body || !result.body.success) {
        showSnowGuardFailure(result);
        return;
      }
      renderSnowGuard(result.body);
    } catch (e) {
      showSnowGuardFailure(null);
    } finally {
      snowGuardCheckBtn.disabled = false;
    }
  }

  if (snowGuardPanel) {
    snowGuardPanel.addEventListener("click", function (e) {
      if (e.target.closest("#snow-guard-save")) { saveSnowGuard(); return; }
      if (e.target.closest("#snow-guard-check")) { checkSnowGuard(); }
    });
  }

  // ---- wire up ----
  window.PHEV.onData(render);
})();

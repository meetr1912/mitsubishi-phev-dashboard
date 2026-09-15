/* vehicle-intelligence.js — evidence-labelled dashboard insights.
 * Pure derivations from redacted activity records, published history and the
 * latest vehicle report. It never issues a vehicle request or invents energy,
 * fuel, weather, location, or battery-health measurements. */
(function () {
  "use strict";
  function number(value) { return typeof value === "number" && isFinite(value) ? value : null; }
  function date(value) { var result = new Date(value); return isNaN(result.getTime()) ? null : result; }
  function label(value) { return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function stateChanges(data) {
    var rows = Array.isArray(data && data.hourly_history) ? data.hourly_history.slice().sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); }) : [];
    var fields = [{ key: "charging_status", name: "Charging" }, { key: "plugged_in", name: "Plugged in" }, { key: "battery_pct", name: "Battery" }];
    var changes = [];
    fields.forEach(function (field) {
      var previous = null, hasPrevious = false;
      rows.forEach(function (row) {
        if (!row || row[field.key] === null || row[field.key] === undefined) return;
        var current = row[field.key];
        if (hasPrevious && current !== previous) {
          changes.push({ at: row.ts, field: field.name, from: previous, to: current });
        }
        previous = current; hasPrevious = true;
      });
    });
    return changes.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 8);
  }
  function reliability(records) {
    var commands = (Array.isArray(records) ? records : []).filter(function (row) { return row && row.kind === "command"; });
    var completed = commands.filter(function (row) { return row.result && (row.result.outcome === "succeeded" || row.result.success === true); });
    var durations = completed.map(function (row) { return number(row.result.duration_ms); }).filter(function (value) { return value !== null && value > 0; }).sort(function (a, b) { return a - b; });
    var median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    var failed = commands.filter(function (row) { return row.result && (row.result.outcome === "failed" || row.result.outcome === "timeout" || row.result.success === false); });
    return { commands: commands.length, confirmed: completed.length, failed: failed.length, successPct: commands.length ? Math.round((completed.length / commands.length) * 100) : null, medianMs: median, latestFailure: failed.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); })[0] || null };
  }
  function tripBaseline(data) {
    var daily = data && data.rollups && Array.isArray(data.rollups.daily) ? data.rollups.daily.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }) : [];
    var values = daily.map(function (row) { return number(row && row.odometer_km && row.odometer_km.distance_km) || 0; });
    var recent = values.slice(-7), prior = values.slice(-14, -7);
    var sum = function (items) { return items.reduce(function (total, value) { return total + value; }, 0); };
    var currentKm = sum(recent), priorKm = sum(prior);
    return { days: values.length, recentKm: Math.round(currentKm * 10) / 10, priorKm: Math.round(priorKm * 10) / 10, deltaPct: prior.length === 7 && priorKm > 0 ? Math.round(((currentKm - priorKm) / priorKm) * 100) : null };
  }
  function batteryTrend(data) {
    var rows = Array.isArray(data && data.hourly_history) ? data.hourly_history : [];
    var values = rows.map(function (row) { return number(row && row.battery_pct); }).filter(function (value) { return value !== null; });
    if (values.length < 2) return null;
    var change = Math.round((values[values.length - 1] - values[0]) * 10) / 10;
    return { samples: values.length, changePct: change };
  }
  function readiness(data, snow) {
    var latest = data && data.latest || {};
    var config = snow && snow.config || {};
    var reasons = [];
    if (!config.enabled) reasons.push("Snow Guard is off");
    if (config.requirePlugged !== false && latest.plugged_in !== true) reasons.push("vehicle is not reported plugged in");
    if (number(latest.battery_pct) === null) reasons.push("battery level is unavailable");
    else if (number(config.minBatteryPct) !== null && latest.battery_pct < config.minBatteryPct) reasons.push("battery is below its configured minimum");
    if (!config.outsideParkingConfirmed) reasons.push("outdoor parking is not confirmed");
    var decision = snow && snow.runtime && snow.runtime.lastDecision;
    return { ready: reasons.length === 0, reasons: reasons, decision: decision && decision.summary || null };
  }
  function snowEvidence(snow) {
    var runtime = snow && snow.runtime || {}, decision = runtime.lastDecision || {}, calibration = snow && snow.calibration || {};
    var confidence = decision.weather && decision.weather.confidence;
    return { code: decision.code || null, confidence: confidence || null, summary: decision.summary || null, responses: number(calibration.responses), usefulRate: number(calibration.usefulRate), recommendation: calibration.reviewRecommendation || null, model: snow && snow.intelligence || null };
  }
  function departurePlan(data, snow, preference) {
    var plan = preference || {}, latest = data && data.latest || {}, ready = readiness(data, snow), target = typeof plan.time === "string" ? plan.time : null;
    if (!target) return "Set a local departure time. No vehicle command will be sent.";
    var current = new Date(), parts = target.split(":"), departure = new Date(current);
    departure.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
    if (departure.getTime() <= current.getTime()) departure.setDate(departure.getDate() + 1);
    var hours = (departure.getTime() - current.getTime()) / 3600000;
    var goal = plan.goal === "defrost" ? "defrost priority" : "cabin comfort";
    if (!ready.ready) return "For " + target + " " + goal + ": review " + ready.reasons.join(", ") + ". No vehicle action is scheduled.";
    if (number(latest.battery_pct) === null) return "For " + target + ": battery data is unavailable. No vehicle action is scheduled.";
    return "For " + target + " " + goal + ": safety prerequisites are currently met; recheck conditions " + (hours > 1 ? "closer to departure" : "now") + ". No vehicle action is scheduled.";
  }
  function text(id, value) { var element = document.getElementById(id); if (element) element.textContent = value; }
  function render(data, records, snow) {
    var r = reliability(records);
    text("intel-command-rate", r.successPct === null ? "—" : r.successPct + "%");
    text("intel-command-note", r.commands ? r.confirmed + " confirmed of " + r.commands + " logged commands" + (r.medianMs ? " · median " + (r.medianMs / 1000).toFixed(1) + "s" : "") : "No command outcomes recorded yet.");
    text("intel-command-failure", r.latestFailure ? "Latest issue: " + label(r.latestFailure.action) + " · " + (r.latestFailure.result.message || r.latestFailure.result.outcome || "needs review") : "No failed or timed-out commands recorded.");
    var ready = readiness(data, snow);
    text("intel-ready", ready.ready ? "Ready" : "Review");
    text("intel-ready-note", ready.ready ? "Configured safety checks are currently satisfied. Weather still has to qualify." : ready.reasons.join(" · ") + ".");
    var evidence = snowEvidence(snow);
    text("intel-snow-decision", evidence.code ? label(evidence.code) : "—");
    text("intel-snow-note", evidence.summary ? evidence.summary + (evidence.confidence ? " · " + evidence.confidence + " confidence." : "") : "No Snow Guard decision recorded yet.");
    text("intel-snow-outcomes", evidence.responses === null ? "—" : String(evidence.responses));
    var modelNote = evidence.model && evidence.model.message ? " Bayesian advisor: " + evidence.model.message : "";
    text("intel-snow-outcome-note", (evidence.responses === null ? "Rules remain conservative and do not self-adjust." : (evidence.usefulRate === null ? "Outcome feedback is recorded." : Math.round(evidence.usefulRate * 100) + "% useful feedback.") + (evidence.recommendation ? " " + evidence.recommendation : "")) + modelNote);
    var base = tripBaseline(data);
    text("intel-trip-baseline", base.days ? base.recentKm.toFixed(1) + " km" : "—");
    text("intel-trip-note", base.deltaPct === null ? "Need two full 7-day windows before comparison." : Math.abs(base.deltaPct) < 10 ? "Within 10% of the prior 7 days." : (base.deltaPct > 0 ? "+" : "") + base.deltaPct + "% versus the prior 7 days. Distance only; not an efficiency claim.");
    var battery = batteryTrend(data);
    text("intel-battery-trend", battery === null ? "—" : (battery.changePct > 0 ? "+" : "") + battery.changePct + " pts");
    text("intel-battery-note", battery === null ? "Need two reported battery samples." : battery.samples + " reported samples across published history. Charging and driving both affect this; not a health diagnosis.");
    text("intel-weekly-brief", base.days ? "Weekly brief: " + base.recentKm.toFixed(1) + " km logged in the recent 7 days · " + (r.commands ? r.confirmed + "/" + r.commands + " commands confirmed" : "no command outcomes") + " · Snow Guard " + (ready.ready ? "ready" : "requires review") + "." : "Weekly brief appears when enough logged data exists.");
    var preference = null;
    try { preference = JSON.parse(localStorage.getItem("phev-departure-plan") || "null"); } catch (_) { preference = null; }
    text("intel-departure-note", departurePlan(data, snow, preference));
    var changes = stateChanges(data), list = document.getElementById("intel-state-changes");
    if (list) { list.textContent = ""; changes.forEach(function (change) { var item = document.createElement("li"), when = date(change.at); item.textContent = (when ? when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Unknown time") + " · " + change.field + ": " + String(change.from) + " → " + String(change.to); list.appendChild(item); }); if (!changes.length) { var empty = document.createElement("li"); empty.textContent = "No comparable state changes in published history yet."; list.appendChild(empty); } }
  }
  window.PHEV.computeVehicleIntelligence = { reliability: reliability, tripBaseline: tripBaseline, batteryTrend: batteryTrend, stateChanges: stateChanges, readiness: readiness, snowEvidence: snowEvidence, departurePlan: departurePlan };
  var latest = null, records = [], snow = null;
  window.PHEV.onData(function (data) { latest = data; render(latest, records, snow); });
  document.addEventListener("phev:activity", function (event) { records = event.detail && event.detail.records || []; render(latest, records, snow); });
  document.addEventListener("phev:snow-guard", function (event) { snow = event.detail || null; render(latest, records, snow); });
  document.addEventListener("click", function (event) {
    if (!event.target.closest("#intel-save-departure")) return;
    var time = document.getElementById("intel-departure-time"), goal = document.getElementById("intel-cabin-goal");
    try { localStorage.setItem("phev-departure-plan", JSON.stringify({ time: time && time.value || "", goal: goal && goal.value || "comfortable" })); } catch (_) { /* device storage can be disabled */ }
    render(latest, records, snow);
  });
})();

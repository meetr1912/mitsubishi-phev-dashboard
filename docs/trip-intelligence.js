/* trip-intelligence.js — read-only usage intelligence from published history.
 * It never treats battery percentage, range, or odometer deltas as kWh/litres. */
(function () {
  "use strict";
  var ids = { distance: "trip-distance", active: "trip-active-days", charging: "trip-charging-sessions", mix: "trip-ev-share", note: "trip-intelligence-note" };
  function number(value) { return typeof value === "number" && isFinite(value) ? value : null; }
  function set(name, value) { var el = document.getElementById(ids[name]); if (el) el.textContent = value; }
  function latestDays(data, count) {
    var days = data && data.rollups && Array.isArray(data.rollups.daily) ? data.rollups.daily.slice() : [];
    return days.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).slice(-count);
  }
  function computeTripIntelligence(data) {
    var days = latestDays(data, 30);
    var distance = 0, active = 0, charging = 0;
    days.forEach(function (day) {
      var km = number(day && day.odometer_km && day.odometer_km.distance_km) || 0;
      distance += km; if (km > 0) active += 1;
      charging += number(day && day.charging_sessions) || 0;
    });
    var months = data && data.rollups && Array.isArray(data.rollups.monthly) ? data.rollups.monthly : [];
    var latest = months.slice().sort(function (a, b) { return String(a.period).localeCompare(String(b.period)); }).pop() || null;
    var ev = number(latest && latest.ev_distance_km), gas = number(latest && latest.gas_distance_km);
    var mix = ev !== null && gas !== null && ev + gas > 0 ? Math.round((ev / (ev + gas)) * 100) : null;
    return { days: days.length, distanceKm: Math.round(distance * 10) / 10, activeDays: active, chargingSessions: charging, evSharePct: mix, mixSource: mix === null ? null : "mileage tracker" };
  }
  function render(data) {
    var summary = computeTripIntelligence(data);
    set("distance", summary.days ? summary.distanceKm.toFixed(1) + " km" : "—");
    set("active", summary.days ? String(summary.activeDays) : "—");
    set("charging", summary.days ? String(summary.chargingSessions) : "—");
    set("mix", summary.evSharePct === null ? "—" : summary.evSharePct + "% EV");
    var note = document.getElementById(ids.note);
    if (note) note.textContent = summary.days
      ? "Last " + summary.days + " logged days · distance from odometer rollups. EV/gas split is " + (summary.mixSource || "not reported by the mileage tracker") + ". Battery %, range, litres, and kWh are not inferred."
      : "Trip intelligence will appear after the status logger has published daily history.";
  }
  window.PHEV.computeTripIntelligence = computeTripIntelligence;
  window.PHEV.onData(render);
})();

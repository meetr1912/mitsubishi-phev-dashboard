/* charts.js — encrypted dashboard-history charts. Chart.js is optional: a
 * blocked CDN must show an honest message rather than retry forever. */
(function () {
  "use strict";

  var charts = { battery: null, odometer: null, daily: null, monthly: null };
  var pendingData = null;
  var retries = 0;
  var MAX_RETRIES = 20;
  var COLORS = { blue: "#007aff", blueSoft: "rgba(0,122,255,.16)", grid: "rgba(60,60,67,.16)", text: "#6d6d72" };

  function dateLabel(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  }

  function empty(id, show, message) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = !show;
    if (message) el.textContent = message;
  }

  function destroy(name) {
    if (charts[name]) { charts[name].destroy(); charts[name] = null; }
  }

  function options(unit) {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: COLORS.text, maxTicksLimit: 6, autoSkip: true, maxRotation: 0 }, grid: { color: COLORS.grid } },
        y: { title: { display: !!unit, text: unit, color: COLORS.text }, ticks: { color: COLORS.text }, grid: { color: COLORS.grid } }
      }
    };
  }

  function line(name, canvasId, emptyId, history, key, label, unit, fixedRange) {
    var canvas = document.getElementById(canvasId);
    destroy(name);
    var rows = Array.isArray(history) ? history.filter(function (row) { return row && typeof row[key] === "number"; }) : [];
    empty(emptyId, !rows.length);
    if (!canvas || !rows.length) return;
    var config = options(unit);
    if (fixedRange) config.scales.y = Object.assign({}, config.scales.y, fixedRange);
    charts[name] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: rows.map(function (row) { return dateLabel(row.ts); }), datasets: [{ label: label, data: rows.map(function (row) { return row[key]; }), borderColor: COLORS.blue, backgroundColor: COLORS.blueSoft, fill: true, tension: .28, pointRadius: 0, borderWidth: 2 }] },
      options: config
    });
  }

  function bars(name, canvasId, emptyId, rows, labels, values, unit) {
    var canvas = document.getElementById(canvasId);
    destroy(name);
    var series = Array.isArray(rows) ? rows : [];
    empty(emptyId, !series.length);
    if (!canvas || !series.length) return;
    charts[name] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: labels, datasets: [{ label: "Distance (" + unit + ")", data: values, backgroundColor: "rgba(0,122,255,.48)", borderColor: COLORS.blue, borderWidth: 1, borderRadius: 4 }] },
      options: options(unit)
    });
  }

  function render(data) {
    pendingData = data;
    if (typeof window.Chart === "undefined") {
      if (retries++ < MAX_RETRIES) { setTimeout(function () { render(pendingData); }, 150); return; }
      ["empty-battery", "empty-odometer", "empty-daily", "empty-monthly"].forEach(function (id) { empty(id, true, "Chart library unavailable. Your encrypted history is still intact; reload when online."); });
      return;
    }
    var hourly = Array.isArray(data && data.hourly_history) ? data.hourly_history : [];
    line("battery", "chart-battery", "empty-battery", hourly, "battery_pct", "Battery %", "%", { min: 0, max: 100 });
    line("odometer", "chart-odometer", "empty-odometer", hourly, "odometer_km", "Odometer", "km");
    var daily = data && data.rollups && Array.isArray(data.rollups.daily) ? data.rollups.daily : [];
    bars("daily", "chart-daily", "empty-daily", daily, daily.map(function (row) { return row.partial ? "Today" : row.date; }), daily.map(function (row) { return row && row.odometer_km && typeof row.odometer_km.distance_km === "number" ? row.odometer_km.distance_km : null; }), "km");
    var monthly = data && data.rollups && Array.isArray(data.rollups.monthly) ? data.rollups.monthly : (Array.isArray(data && data.monthly_distance) ? data.monthly_distance : []);
    var usesKm = !!(data && data.rollups && Array.isArray(data.rollups.monthly));
    bars("monthly", "chart-monthly", "empty-monthly", monthly, monthly.map(function (row) { return row.period || "—"; }), monthly.map(function (row) { return usesKm ? row.distance_km : row.distance_mi; }), usesKm ? "km" : "mi");
  }

  window.PHEV.resizeCharts = function () { Object.keys(charts).forEach(function (name) { if (charts[name]) charts[name].resize(); }); };
  window.PHEV.onData(render);
})();

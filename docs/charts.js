/* charts.js — Chart.js line + bar charts from decrypted data.
 *  - battery % over hourly_history (line)
 *  - odometer over hourly_history (line)
 *  - monthly_distance over full ownership history (bar)
 * Handles the "no history yet" state and re-renders if data updates. */
(function () {
  "use strict";

  var charts = { battery: null, odometer: null, daily: null, monthly: null };

  var COLORS = {
    accent: "#3ecf8e",
    accent2: "#5b8cff",
    grid: "rgba(148,163,184,0.14)",
    text: "#9aa7b8"
  };

  function ready() { return typeof window.Chart !== "undefined"; }

  function shortTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  }

  function baseOpts(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true }
      },
      scales: {
        x: {
          ticks: { color: COLORS.text, maxTicksLimit: 6, autoSkip: true, maxRotation: 0 },
          grid: { color: COLORS.grid }
        },
        y: {
          title: { display: !!yLabel, text: yLabel, color: COLORS.text },
          ticks: { color: COLORS.text },
          grid: { color: COLORS.grid }
        }
      }
    };
  }

  function toggleEmpty(id, empty) {
    var el = document.getElementById(id);
    if (el) el.hidden = !empty;
  }

  function destroy(name) {
    if (charts[name]) { charts[name].destroy(); charts[name] = null; }
  }

  function renderBattery(hist) {
    var has = hist && hist.length > 0;
    toggleEmpty("empty-battery", !has);
    var canvas = document.getElementById("chart-battery");
    if (!canvas) return;
    destroy("battery");
    if (!has) return;
    var labels = hist.map(function (h) { return shortTime(h.ts); });
    var data = hist.map(function (h) { return h.battery_pct; });
    charts.battery = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Battery %",
          data: data,
          borderColor: COLORS.accent,
          backgroundColor: "rgba(62,207,142,0.15)",
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2
        }]
      },
      options: Object.assign(baseOpts("%"), {
        scales: Object.assign(baseOpts().scales, {
          y: { min: 0, max: 100, ticks: { color: COLORS.text }, grid: { color: COLORS.grid } }
        })
      })
    });
  }

  function renderOdometer(hist) {
    var has = hist && hist.length > 0;
    toggleEmpty("empty-odometer", !has);
    var canvas = document.getElementById("chart-odometer");
    if (!canvas) return;
    destroy("odometer");
    if (!has) return;
    var labels = hist.map(function (h) { return shortTime(h.ts); });
    var data = hist.map(function (h) { return h.odometer_km; });
    charts.odometer = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Odometer (km)",
          data: data,
          borderColor: COLORS.accent2,
          backgroundColor: "rgba(91,140,255,0.12)",
          fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2
        }]
      },
      options: baseOpts("km")
    });
  }

  // Daily distance-driven bar chart from the new daily rollup
  // (rollups.daily[].odometer_km.distance_km). Defensive: missing -> null bar.
  function renderDaily(days) {
    var has = days && days.length > 0;
    toggleEmpty("empty-daily", !has);
    var canvas = document.getElementById("chart-daily");
    if (!canvas) return;
    destroy("daily");
    if (!has) return;
    var labels = days.map(function (d) { return d.date; });
    var data = days.map(function (d) {
      var o = d.odometer_km;
      return (o && typeof o === "object" && o.distance_km != null) ? o.distance_km : null;
    });
    charts.daily = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Distance (km)",
          data: data,
          backgroundColor: "rgba(91,140,255,0.55)",
          borderColor: COLORS.accent2,
          borderWidth: 1, borderRadius: 4
        }]
      },
      options: baseOpts("km")
    });
  }

  // Monthly bar chart. Prefer the compounding schema's rollups.monthly
  // (distance_km); fall back to the legacy monthly_distance (distance_mi).
  function renderMonthly(data) {
    var rollup = data.rollups && Array.isArray(data.rollups.monthly) ? data.rollups.monthly : null;
    var legacy = Array.isArray(data.monthly_distance) ? data.monthly_distance : null;
    var months, valueOf, unit;
    if (rollup && rollup.length > 0) {
      months = rollup;
      valueOf = function (m) { return m.distance_km != null ? m.distance_km : null; };
      unit = "km";
    } else {
      months = legacy || [];
      valueOf = function (m) { return m.distance_mi != null ? m.distance_mi : null; };
      unit = "mi";
    }
    var has = months.length > 0;
    toggleEmpty("empty-monthly", !has);
    var canvas = document.getElementById("chart-monthly");
    if (!canvas) return;
    destroy("monthly");
    if (!has) return;
    var labels = months.map(function (m) { return m.period; });
    var series = months.map(valueOf);
    charts.monthly = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Distance (" + unit + ")",
          data: series,
          backgroundColor: "rgba(62,207,142,0.55)",
          borderColor: COLORS.accent,
          borderWidth: 1, borderRadius: 4
        }]
      },
      options: baseOpts(unit)
    });
  }

  function renderAll(data) {
    if (!ready()) {
      // Chart.js CDN not ready yet — retry shortly.
      setTimeout(function () { renderAll(data); }, 120);
      return;
    }
    if (!data) return;
    renderBattery(data.hourly_history || []);
    renderOdometer(data.hourly_history || []);
    renderDaily((data.rollups && data.rollups.daily) || []);
    renderMonthly(data);
  }

  window.PHEV.onData(renderAll);
})();

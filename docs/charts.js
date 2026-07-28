/* charts.js — Chart.js line + bar charts from decrypted data.
 *  - battery % over hourly_history (line)
 *  - odometer over hourly_history (line)
 *  - monthly_distance over full ownership history (bar)
 * Handles the "no history yet" state and re-renders if data updates. */
(function () {
  "use strict";

  var charts = { battery: null, odometer: null, monthly: null };

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

  function renderMonthly(months) {
    var has = months && months.length > 0;
    toggleEmpty("empty-monthly", !has);
    var canvas = document.getElementById("chart-monthly");
    if (!canvas) return;
    destroy("monthly");
    if (!has) return;
    var labels = months.map(function (m) { return m.period; });
    var data = months.map(function (m) { return m.distance_mi; });
    charts.monthly = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Distance (mi)",
          data: data,
          backgroundColor: "rgba(62,207,142,0.55)",
          borderColor: COLORS.accent,
          borderWidth: 1, borderRadius: 4
        }]
      },
      options: baseOpts("mi")
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
    renderMonthly(data.monthly_distance || []);
  }

  window.PHEV.onData(renderAll);
})();

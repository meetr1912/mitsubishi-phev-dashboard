/* activity.js — private, redacted record of dashboard-to-vehicle activity.
 *
 * The Worker keeps the authoritative records in a Durable Object. This module
 * renders its stable JSON shape without ever asking the browser to retain raw
 * Mitsubishi responses, credentials, VIN, or location information.
 */
(function () {
  "use strict";

  var records = [];
  var vehicleEvents = [];
  var activeFilter = "all";
  var loaded = false;
  var loading = false;

  var statusEl = document.getElementById("activity-status");
  var refreshBtn = document.getElementById("activity-refresh");
  var downloadBtn = document.getElementById("activity-download");
  var logEl = document.getElementById("activity-log");
  var dayChartEl = document.getElementById("activity-day-chart");
  var breakdownEl = document.getElementById("activity-breakdown");
  var totalEl = document.getElementById("activity-total");
  var confirmedEl = document.getElementById("activity-confirmed");
  var attentionEl = document.getElementById("activity-attention");
  var durationEl = document.getElementById("activity-duration");
  var weekTotalEl = document.getElementById("activity-week-total");

  var ACTION_LABELS = {
    lock: "Lock vehicle",
    unlock: "Unlock vehicle",
    lights: "Flash lights",
    horn: "Sound horn",
    locate: "Find vehicle",
    climate: "Start climate",
    climate_stop: "Stop climate",
    charge_start: "Start charging",
    charge_stop: "Stop charging",
    charging_schedule: "Save charging schedule",
    climate_schedule: "Save climate schedule",
    status_refresh: "Refresh live status",
    vehicle_state: "Validate vehicle state",
    settings_read: "Read vehicle settings",
    capability_validation: "Validate capabilities",
    mqtt_validation: "MQTT capability check",
    vehicle_notification: "Vehicle notification"
  };

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("is-error", !!isError);
  }

  function apiKey() {
    return window.PHEV && typeof window.PHEV.getApiKey === "function" ? window.PHEV.getApiKey() : "";
  }

  function workerUrl() {
    return window.PHEV && window.PHEV.WORKER_URL ? window.PHEV.WORKER_URL : "";
  }

  function validDate(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function dateKey(value) {
    var date = validDate(value);
    if (!date) return "unknown";
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  }

  function formatTime(value) {
    var date = validDate(value);
    if (!date) return "Unknown time";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatDay(value) {
    var date = validDate(value);
    return date ? date.toLocaleDateString([], { weekday: "short" }) : "—";
  }

  function titleize(value) {
    return String(value || "Activity")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, function (character) { return character.toUpperCase(); });
  }

  function redactedText(value) {
    if (typeof value !== "string") return null;
    return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, "[redacted-vin]")
      .replace(/\b(?:access[_-]?)?(bearer|token|password|pin|authorization)\b["']?\s*[:=]\s*["']?[^\s,;}"]+/gi, "$1=[redacted]")
      .replace(/\b-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g, "[redacted-location]")
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 180) || null;
  }

  function labelFor(record) {
    if (record && record.title) return String(record.title);
    var action = record && record.action;
    return ACTION_LABELS[action] || titleize(action || "activity");
  }

  function resultFor(record) {
    return (record && record.result) || {};
  }

  function outcomeFor(record) {
    var result = resultFor(record);
    var outcome = String(result.outcome || "").toLowerCase();
    if (outcome === "succeeded" || outcome === "success") return { label: "Confirmed", css: "succeeded" };
    if (outcome === "failed" || outcome === "failure") return { label: "Rejected", css: "failed" };
    if (outcome === "timeout") return { label: "Timed out", css: "timeout" };
    if (result.success === false) return { label: "Failed", css: "failed" };
    if (result.success === true) return { label: "Completed", css: "succeeded" };
    return { label: "Review", css: "review" };
  }

  function needsReview(record) {
    var result = resultFor(record);
    var outcome = String(result.outcome || "").toLowerCase();
    return result.success === false || outcome === "failed" || outcome === "failure" || outcome === "timeout";
  }

  function commandConfirmed(record) {
    return record && record.kind === "command" && String(resultFor(record).outcome || "").toLowerCase() === "succeeded";
  }

  function normaliseVehicleEvents(data) {
    var events = data && Array.isArray(data.events) ? data.events : [];
    return events.map(function (event, index) {
      event = event || {};
      var status = String(event.status || "").toLowerCase();
      var outcome = status === "successful" || status === "success" || status === "completed" ? "succeeded"
        : status === "failed" || status === "failure" ? "failed" : null;
      return {
        id: "vehicle-" + String(event.id || index),
        at: event.ts || "",
        kind: "vehicle",
        route: "notification",
        action: event.operation || event.type || "vehicle_notification",
        title: redactedText(event.title),
        source: "Mitsubishi notification feed",
        request: { source: "vehicle notification" },
        result: {
          success: outcome !== "failed",
          http_status: 200,
          outcome: outcome,
          message: redactedText(event.message),
          remote_status: event.status || null,
          reason_code: event.reason_code || null,
          error_label: null,
          polls: null,
          duration_ms: 0
        }
      };
    });
  }

  function allRecords() {
    var seen = {};
    return records.concat(vehicleEvents).filter(function (record) {
      var key = String(record.id || "") + "|" + String(record.at || "");
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    }).sort(function (a, b) {
      return String(b.at || "").localeCompare(String(a.at || ""));
    });
  }

  function filteredRecords() {
    return allRecords().filter(function (record) {
      if (activeFilter === "command") return record.kind === "command";
      if (activeFilter === "validation") return record.kind === "validation" || record.kind === "status";
      if (activeFilter === "attention") return needsReview(record);
      return true;
    });
  }

  function setMetric(element, value) {
    if (element) element.textContent = value;
  }

  function renderSummary(all) {
    var now = Date.now();
    var last30 = all.filter(function (record) {
      var date = validDate(record.at);
      return date && now - date.getTime() <= 30 * 24 * 60 * 60 * 1000;
    });
    var confirmed = all.filter(commandConfirmed).length;
    var attention = all.filter(needsReview).length;
    var durations = all.map(function (record) { return Number(resultFor(record).duration_ms); })
      .filter(function (duration) { return isFinite(duration) && duration > 0; });
    var average = durations.length ? Math.round(durations.reduce(function (sum, duration) { return sum + duration; }, 0) / durations.length) : 0;
    setMetric(totalEl, String(last30.length));
    setMetric(confirmedEl, String(confirmed));
    setMetric(attentionEl, String(attention));
    setMetric(durationEl, average ? (average >= 1000 ? (average / 1000).toFixed(1) + "s" : average + "ms") : "—");
  }

  function renderDayChart(all) {
    if (!dayChartEl) return;
    dayChartEl.textContent = "";
    var buckets = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var i = 6; i >= 0; i--) {
      var date = new Date(today);
      date.setDate(today.getDate() - i);
      buckets.push({ date: date, key: dateKey(date.toISOString()), count: 0 });
    }
    all.forEach(function (record) {
      var key = dateKey(record.at);
      buckets.forEach(function (bucket) { if (bucket.key === key) bucket.count++; });
    });
    var max = Math.max.apply(null, buckets.map(function (bucket) { return bucket.count; }).concat([1]));
    var total = 0;
    buckets.forEach(function (bucket) {
      total += bucket.count;
      var item = document.createElement("div");
      item.className = "activity-day";
      item.title = bucket.date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) + ": " + bucket.count;
      var barWrap = document.createElement("div");
      barWrap.className = "activity-day-bar-wrap";
      var count = document.createElement("span");
      count.className = "activity-day-count";
      count.textContent = String(bucket.count);
      var bar = document.createElement("span");
      bar.className = "activity-day-bar" + (bucket.count ? "" : " is-empty");
      bar.style.height = Math.max(3, Math.round((bucket.count / max) * 100)) + "%";
      var label = document.createElement("span");
      label.className = "activity-day-label";
      label.textContent = formatDay(bucket.date.toISOString());
      barWrap.appendChild(count);
      barWrap.appendChild(bar);
      item.appendChild(barWrap);
      item.appendChild(label);
      dayChartEl.appendChild(item);
    });
    if (weekTotalEl) weekTotalEl.textContent = total + " request" + (total === 1 ? "" : "s");
  }

  function renderBreakdown(all) {
    if (!breakdownEl) return;
    breakdownEl.textContent = "";
    var counts = {};
    all.forEach(function (record) {
      var label = labelFor(record);
      counts[label] = (counts[label] || 0) + 1;
    });
    var entries = Object.keys(counts).map(function (label) { return { label: label, count: counts[label] }; })
      .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); }).slice(0, 6);
    if (!entries.length) {
      var empty = document.createElement("p");
      empty.className = "activity-log-empty";
      empty.textContent = "No recorded requests yet.";
      breakdownEl.appendChild(empty);
      return;
    }
    var max = entries[0].count;
    entries.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "activity-breakdown-row";
      var label = document.createElement("span");
      label.className = "activity-breakdown-label";
      label.textContent = entry.label;
      var count = document.createElement("span");
      count.className = "activity-breakdown-count";
      count.textContent = entry.count + "×";
      var track = document.createElement("div");
      track.className = "activity-breakdown-track";
      var bar = document.createElement("div");
      bar.className = "activity-breakdown-bar";
      bar.style.width = Math.max(3, Math.round((entry.count / max) * 100)) + "%";
      track.appendChild(bar);
      row.appendChild(label);
      row.appendChild(count);
      row.appendChild(track);
      breakdownEl.appendChild(row);
    });
  }

  function renderLog() {
    if (!logEl) return;
    logEl.textContent = "";
    var filtered = filteredRecords();
    if (!filtered.length) {
      var empty = document.createElement("p");
      empty.className = "activity-log-empty";
      empty.textContent = loaded ? "No activity matches this filter." : "Activity will appear here after the dashboard loads it.";
      logEl.appendChild(empty);
      return;
    }
    filtered.forEach(function (record) {
      var details = document.createElement("details");
      details.className = "activity-entry";
      var summary = document.createElement("summary");
      var copy = document.createElement("span");
      var title = document.createElement("span");
      title.className = "activity-entry-title";
      title.textContent = labelFor(record);
      var meta = document.createElement("span");
      meta.className = "activity-entry-meta";
      var result = resultFor(record);
      meta.textContent = formatTime(record.at) + " · " + (result.duration_ms ? Math.round(result.duration_ms / 100) / 10 + "s" : "vehicle feed");
      copy.appendChild(title);
      copy.appendChild(meta);
      var outcome = outcomeFor(record);
      var badge = document.createElement("span");
      badge.className = "activity-outcome " + outcome.css;
      badge.textContent = outcome.label;
      summary.appendChild(copy);
      summary.appendChild(badge);
      var json = document.createElement("pre");
      json.className = "activity-json";
      json.textContent = JSON.stringify(record, null, 2);
      details.appendChild(summary);
      details.appendChild(json);
      logEl.appendChild(details);
    });
  }

  function render() {
    var all = allRecords();
    renderSummary(all);
    renderDayChart(all);
    renderBreakdown(all);
    renderLog();
    if (downloadBtn) downloadBtn.disabled = !all.length;
  }

  async function loadActivity(force) {
    if (loading || (loaded && !force)) return;
    var key = apiKey();
    var url = workerUrl();
    if (!key || !url) {
      setStatus("Add the dashboard command key in Settings to load the persistent action trail.", false);
      render();
      return;
    }
    loading = true;
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add("loading"); }
    setStatus("Loading recorded activity…", false);
    try {
      var response = await fetch(url + "/activity?limit=1000", {
        headers: { "X-Dashboard-Key": key },
        cache: "no-store"
      });
      var body = null;
      try { body = await response.json(); } catch (error) { /* handled below */ }
      if (!response.ok || !body || !body.success) throw new Error((body && body.error) || "Could not load activity");
      records = Array.isArray(body.records) ? body.records : [];
      loaded = true;
      var retention = body.retention_days || 365;
      var cap = body.max_records || 1000;
      setStatus("Showing " + records.length + " saved request" + (records.length === 1 ? "" : "s") + ". Retained for up to " + retention + " days or " + cap + " requests.", false);
    } catch (error) {
      setStatus("Activity could not be loaded: " + (error && error.message ? error.message : "network error"), true);
    } finally {
      loading = false;
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove("loading"); }
      render();
    }
  }

  function downloadActivity() {
    var payload = { exported_at: new Date().toISOString(), records: allRecords() };
    var blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "outlander-phev-activity-" + dateKey(new Date().toISOString()) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }

  if (refreshBtn) refreshBtn.addEventListener("click", function () { loadActivity(true); });
  if (downloadBtn) downloadBtn.addEventListener("click", downloadActivity);
  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-activity-filter]");
    if (!button) return;
    activeFilter = button.getAttribute("data-activity-filter") || "all";
    Array.prototype.forEach.call(document.querySelectorAll("[data-activity-filter]"), function (filter) {
      filter.classList.toggle("active", filter === button);
    });
    renderLog();
  });
  document.addEventListener("phev:tabchange", function (event) {
    if (event.detail && event.detail.tab === "activity") loadActivity(false);
  });
  window.PHEV.onData(function (data) {
    vehicleEvents = normaliseVehicleEvents(data);
    render();
  });
})();

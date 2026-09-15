import assert from "node:assert/strict";
import test from "node:test";

import { SerialMutationQueue } from "../.test-dist/src/serial-mutation-queue.js";
import { classifyPrecipitationPhase, haversineDistanceKm, radarSamplesAreFreshAndAligned, snowAdhesionRisk, snowWeatherConfidence, summarizeSnowSeverity } from "../.test-dist/src/snow-guard-policy.js";
import { isSnowFeedbackOutcome, screenedReportedBatteryDeltaPct, snowFeedbackPrompt, summariseSnowCalibration } from "../.test-dist/src/snow-guard-calibration.js";
import { snowContext, summariseSnowIntelligence } from "../.test-dist/src/snow-guard-intelligence.js";
import { CORS_ALLOW_METHODS, UPSTREAM_RESPONSE_WITHHELD } from "../.test-dist/src/worker-safety.js";
import { isFreshVhrRefreshEvidence, parseHealthCalibrationTelemetry, telemetryEpochMs, telemetryTimestampIsRecent } from "../.test-dist/src/snow-guard-telemetry.js";
import {
  ECCC_HALIFAX_CITY_PAGE_ID,
  ECCC_HALIFAX_CITY_PAGE_URL,
  ecccCityPageIsFresh,
  parseEcccCityPageDisplay,
  weatherSourceFailureFromHttp,
  weatherSourceFailureFromPayload,
  weatherSourceFailureFromTransport,
  weatherSourceFailureMessage,
} from "../.test-dist/src/snow-guard-weather.js";

test("Snow Guard classifies only meaningful near-term snow as actionable", () => {
  assert.equal(summarizeSnowSeverity(3, 5, 5, 5, 75), "none");
  assert.equal(summarizeSnowSeverity(-1, 0, 0, 0, null), "none");
  assert.equal(summarizeSnowSeverity(-1, 0, 0, 0, 71), "light");
  assert.equal(summarizeSnowSeverity(-1, 0, 0.4, 0.8, null), "light");
  assert.equal(summarizeSnowSeverity(-1, 0, 1.6, 2, null), "moderate");
  assert.equal(summarizeSnowSeverity(-1, 0, 4, 4, null), "heavy");
});

test("Snow Guard reserves stronger defrost for adhesive snow risk", () => {
  assert.equal(snowAdhesionRisk(null, 2, 2, 40), "low");
  assert.equal(snowAdhesionRisk(-1, 0.4, 0.8, 10), "high");
  assert.equal(snowAdhesionRisk(-4, 0.5, 1, 30), "high");
  assert.equal(snowAdhesionRisk(-10, 0.8, 1, 10), "low");
  assert.equal(snowAdhesionRisk(-4, 1, 2, 10), "moderate");
});

test("Snow Guard fails closed when weather evidence is stale, incomplete, or radar is absent", () => {
  const baseline = { dataAgeMinutes: 10, temperatureC: -1, weatherCode: 71, wetBulbC: -1, forecastSamples: 12, radarFresh: true };
  assert.equal(snowWeatherConfidence(baseline), "high");
  assert.equal(snowWeatherConfidence({ ...baseline, radarFresh: false }), "low");
  assert.equal(snowWeatherConfidence({ ...baseline, dataAgeMinutes: 50 }), "low");
  assert.equal(snowWeatherConfidence({ ...baseline, forecastSamples: 4 }), "moderate");
  assert.equal(classifyPrecipitationPhase(66, 0, 1, 1, -1), "freezing");
  assert.equal(classifyPrecipitationPhase(71, 0.2, 0, 1, -1), "snow");
  assert.equal(classifyPrecipitationPhase(null, 0, 0.2, 0.2, 0), "mixed");
});

test("Snow Guard rejects off-target, future, stale, or divergent radar evidence", () => {
  const now = Date.parse("2026-12-01T12:00:00Z");
  const nearby = radarSamplesAreFreshAndAligned(now - 6 * 60_000, now - 6 * 60_000, now);
  assert.deepEqual(nearby, { fresh: true, dataAgeMinutes: 6, olderTimestampMs: now - 6 * 60_000 });
  assert.equal(radarSamplesAreFreshAndAligned(now + 1, now, now).fresh, false);
  assert.equal(radarSamplesAreFreshAndAligned(now - 3 * 60_000, now - 16 * 60_000, now).fresh, false);
  assert.equal(radarSamplesAreFreshAndAligned(now - 1 * 60_000, now - 14 * 60_000, now).fresh, false);
  assert.ok(haversineDistanceKm(44.6488, -63.5752, 44.6501, -63.5655) < 1);
  assert.ok(haversineDistanceKm(44.6488, -63.5752, 44.7099, -63.5794) > 6);
});

test("Snow Guard calibration accepts only bounded, idempotent outcome choices", () => {
  assert.equal(isSnowFeedbackOutcome("clear"), true);
  assert.equal(isSnowFeedbackOutcome("ice"), false);
  const now = Date.parse("2026-12-01T12:00:00Z");
  const cases = [
    { id: "a", actionAt: "2026-12-01T11:00:00Z", eligibleAt: "2026-12-01T11:20:00Z", expiresAt: "2026-12-02T23:00:00Z", minutes: 20, batteryPctAtStart: 80, pluggedInAtStart: false, odometerKmAtStart: 1000, batteryTelemetryAtStart: "2026-12-01T10:59:00Z", batteryPctAfter: 79, pluggedInAfter: false, odometerKmAfter: 1000, batteryTelemetryAt: "2026-12-01T11:21:00Z", batteryMeasuredAt: "2026-12-01T11:21:03Z", batteryDeltaPct: -1, weather: {}, outcome: "clear" },
    { id: "b", actionAt: "2026-12-01T11:30:00Z", eligibleAt: "2026-12-01T11:50:00Z", expiresAt: "2026-12-02T23:30:00Z", minutes: 20, batteryPctAtStart: 80, pluggedInAtStart: true, odometerKmAtStart: 1000, weather: {} },
  ];
  assert.deepEqual(snowFeedbackPrompt(cases, now), { eventId: "b", actionAt: "2026-12-01T11:30:00Z", minutes: 20 });
  assert.deepEqual(summariseSnowCalibration(cases), {
    eligibleActions: 2, responses: 1, clear: 1, partial: 0, noBenefit: 0,
    usefulRate: 1, screenedBatterySamples: 1, meanScreenedBatteryDeltaPct: -1, minimumSample: 10, readyForReview: false,
    reviewRecommendation: "Keep collecting outcomes; Snow Guard will not change its own rules.",
  });
});

test("Snow Guard Bayesian advisor only prefers a duration with comparable evidence", () => {
  const weather = { temperatureC: -2, precipitationPhase: "snow", adhesionRisk: "high" };
  const cases = Array.from({ length: 8 }, (_, index) => ({
    id: String(index), actionAt: "2026-12-01T11:00:00Z", eligibleAt: "2026-12-01T11:20:00Z", expiresAt: "2026-12-02T23:00:00Z",
    minutes: index < 4 ? 20 : 30, batteryPctAtStart: null, pluggedInAtStart: null, odometerKmAtStart: null, weather,
    outcome: index < 4 ? "no_benefit" : "clear",
  }));
  assert.equal(snowContext(cases[0]), "temp_near_freezing|phase_snow|adhesion_high");
  const summary = summariseSnowIntelligence(cases, { weather });
  assert.equal(summary.recommendation, "prefer_30");
  assert.equal(summary.evidence[0].samples, 4);
  assert.equal(summary.evidence[1].samples, 4);
  assert.equal(summariseSnowIntelligence(cases.slice(0, 4), { weather }).recommendation, "collect_more");
});

test("Snow Guard keeps reported battery deltas only for a screened VHR observation", () => {
  const baseline = {
    actionAt: "2026-12-01T11:00:00Z",
    eligibleAt: "2026-12-01T11:20:00Z",
    batteryPctAtStart: 80,
    pluggedInAtStart: false,
    odometerKmAtStart: 1000,
    batteryTelemetryAtStart: "2026-12-01T10:59:00Z",
    batteryPctAfter: 78,
    pluggedInAfter: false,
    odometerKmAfter: 1000,
    batteryTelemetryAt: "2026-12-01T11:21:00Z",
    batteryMeasuredAt: "2026-12-01T11:21:04Z",
  };
  assert.equal(screenedReportedBatteryDeltaPct(baseline), -2);
  assert.equal(screenedReportedBatteryDeltaPct({ ...baseline, pluggedInAfter: true }), null);
  assert.equal(screenedReportedBatteryDeltaPct({ ...baseline, odometerKmAfter: 1001 }), null);
  assert.equal(screenedReportedBatteryDeltaPct({ ...baseline, batteryPctAfter: null }), null);
  assert.equal(screenedReportedBatteryDeltaPct({ ...baseline, batteryTelemetryAt: "2026-12-01T11:19:00Z" }), null);
  assert.equal(screenedReportedBatteryDeltaPct({ ...baseline, batteryTelemetryAt: "2026-12-01T11:36:00Z" }), null);
});

test("Snow Guard uses one co-timestamped VHR, not a generic stale state field", () => {
  const vhr = {
    vhr: [{
      operation: "vehicleStatus",
      ts: 1798764000,
      dt: {
        diagnostic: {
          eventTimestamp: { value: "1798764000" },
          batteryLife: { value: "82" },
          chargePlugConnected: { value: "0" },
          odo: { value: "12345" },
          igst: { value: "0" },
          spd: { value: "0" },
        },
        vehicleStatus: { doorStatus: { doors: [] } },
      },
    }],
  };
  assert.deepEqual(parseHealthCalibrationTelemetry(vhr), {
    reportedAtMs: 1798764000000,
    batteryPct: 82,
    pluggedIn: false,
    odometerKm: 12345,
    ignitionOn: false,
    speedKmh: 0,
    vehicleStatus: { doorStatus: { doors: [] } },
  });
  assert.equal(telemetryEpochMs("1798764000"), 1798764000000);
  assert.equal(telemetryTimestampIsRecent(1798764000000, 1798764000000 + 5 * 60_000), true);
  assert.equal(telemetryTimestampIsRecent(1798764000000, 1798764000000 + 5 * 60_000 + 1), false);
  assert.equal(isFreshVhrRefreshEvidence({
    acknowledgementStatus: "inQueue",
    reportTimestampMs: 1798764000000,
    refreshRequestedAtMs: 1798764001000,
    sampledAtMs: 1798764003000,
  }), true);
  assert.equal(isFreshVhrRefreshEvidence({
    acknowledgementStatus: "messageDelivered",
    reportTimestampMs: 1798764000000,
    refreshRequestedAtMs: 1798764001000,
    sampledAtMs: 1798764003000,
  }), false);
  assert.equal(isFreshVhrRefreshEvidence({
    acknowledgementStatus: "inQueue",
    reportTimestampMs: 1798763900000,
    refreshRequestedAtMs: 1798764001000,
    sampledAtMs: 1798764003000,
  }), false);
  assert.equal(isFreshVhrRefreshEvidence({
    acknowledgementStatus: "inQueue",
    reportTimestampMs: 1798763971000,
    refreshRequestedAtMs: 1798764001000,
    sampledAtMs: 1798764003000,
  }), false);
  assert.equal(parseHealthCalibrationTelemetry({
    vhr: [{
      ...vhr.vhr[0],
      dt: {
        ...vhr.vhr[0].dt,
        diagnostic: { ...vhr.vhr[0].dt.diagnostic, spd: { value: "-1" } },
      },
    }],
  }).speedKmh, null);
  assert.equal(parseHealthCalibrationTelemetry({ vhr: [{ ...vhr.vhr[0], operation: "anotherOperation" }] }).reportedAtMs, null);
  const { eventTimestamp: _eventTimestamp, ...withoutDiagnosticTimestamp } = vhr.vhr[0].dt.diagnostic;
  assert.equal(parseHealthCalibrationTelemetry({
    vhr: [{ ...vhr.vhr[0], dt: { ...vhr.vhr[0].dt, diagnostic: withoutDiagnosticTimestamp } }],
  }).reportedAtMs, 1798764000000);
  assert.equal(parseHealthCalibrationTelemetry({
    vhr: [{
      ...vhr.vhr[0],
      dt: {
        ...vhr.vhr[0].dt,
        diagnostic: { ...vhr.vhr[0].dt.diagnostic, eventTimestamp: { value: "1798765000" } },
      },
    }],
  }).reportedAtMs, null);
});

test("Snow Guard City Page fallback is sanitized display-only evidence", () => {
  const cityPage = {
    type: "Feature",
    properties: {
      identifier: "ns-40",
      lastUpdated: "2026-12-01T12:05:00Z",
      name: { en: "Halifax (Shearwater)" },
      region: { en: "Halifax Metro and Halifax County West" },
      currentConditions: {
        timestamp: { en: "2026-12-01T12:00:00Z" },
        station: { value: { en: "Shearwater Airport" } },
        condition: { en: "Light snow <script>\u0000" },
        temperature: { value: { en: -2.4 } },
        dewpoint: { value: { en: -4.1 } },
        relativeHumidity: { value: { en: 87 } },
        wind: { speed: { value: { en: 18 } }, gust: { value: { en: 34 } } },
      },
      forecastGroup: {
        forecasts: [{
          period: { textForecastName: { en: "Tonight" } },
          textSummary: { en: "Snow at times heavy overnight." },
        }],
      },
    },
  };
  const fallback = parseEcccCityPageDisplay(cityPage);
  assert.equal(ECCC_HALIFAX_CITY_PAGE_ID, "ns-40");
  assert.match(ECCC_HALIFAX_CITY_PAGE_URL, /items\/ns-40\?f=json&lang=en$/);
  assert.deepEqual(fallback, {
    source: "eccc_citypage",
    actionEligible: false,
    location: "Halifax (Shearwater)",
    region: "Halifax Metro and Halifax County West",
    observedAt: "2026-12-01T12:00:00.000Z",
    updatedAt: "2026-12-01T12:05:00.000Z",
    station: "Shearwater Airport",
    condition: "Light snow script",
    temperatureC: -2.4,
    dewPointC: -4.1,
    relativeHumidityPct: 87,
    windSpeedKmh: 18,
    windGustKmh: 34,
    nextPeriod: { name: "Tonight", summary: "Snow at times heavy overnight." },
  });
  assert.equal("snowRateCmH" in fallback, false);
  assert.equal("nextHourSnowCm" in fallback, false);
  assert.equal(ecccCityPageIsFresh(fallback, Date.parse("2026-12-01T12:10:00Z")), true);
  assert.equal(ecccCityPageIsFresh(fallback, Date.parse("2026-12-01T14:10:01Z")), false);
  assert.equal(ecccCityPageIsFresh(fallback, Date.parse("2026-12-01T11:58:00Z")), false);
  assert.equal(parseEcccCityPageDisplay({ ...cityPage, properties: { ...cityPage.properties, identifier: "ns-39" } }), null);
  assert.equal(parseEcccCityPageDisplay({ type: "Feature", properties: { identifier: "ns-40", name: { en: "Halifax" } } }).nextPeriod, null);
});

test("Snow Guard weather source failures preserve only safe diagnostics", () => {
  assert.deepEqual(weatherSourceFailureFromHttp("open_meteo_forecast", 429), {
    source: "open_meteo_forecast", kind: "rate_limited", httpStatus: 429,
  });
  assert.deepEqual(weatherSourceFailureFromHttp("eccc_citypage", 503), {
    source: "eccc_citypage", kind: "upstream_error", httpStatus: 503,
  });
  assert.deepEqual(weatherSourceFailureFromHttp("eccc_radar", 400), {
    source: "eccc_radar", kind: "request_rejected", httpStatus: 400,
  });
  assert.deepEqual(weatherSourceFailureFromTransport("open_meteo_forecast", true), {
    source: "open_meteo_forecast", kind: "timeout", httpStatus: null,
  });
  assert.deepEqual(weatherSourceFailureFromTransport("eccc_radar", false), {
    source: "eccc_radar", kind: "network", httpStatus: null,
  });
  assert.deepEqual(weatherSourceFailureFromPayload("eccc_citypage"), {
    source: "eccc_citypage", kind: "invalid_payload", httpStatus: null,
  });
  assert.equal(weatherSourceFailureMessage(weatherSourceFailureFromHttp("open_meteo_forecast", 429)), "Open-Meteo forecast is rate-limited.");
  assert.doesNotMatch(JSON.stringify(weatherSourceFailureFromTransport("eccc_citypage", false)), /secret|upstream text/i);
});

test("Snow Guard serialises overlapping state mutations", async () => {
  const queue = new SerialMutationQueue();
  const events = [];
  let active = 0;
  let peakActive = 0;
  const operation = (name, delay) => queue.enqueue(async () => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    events.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`end:${name}`);
    active -= 1;
  });

  await Promise.all([operation("first", 15), operation("second", 0), operation("third", 0)]);
  assert.equal(peakActive, 1);
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second", "start:third", "end:third"]);
});

test("browser preflight permits Snow Guard saves and upstream payloads stay withheld", () => {
  assert.match(CORS_ALLOW_METHODS, /(?:^|, )PUT(?:,|$)/);
  assert.equal(UPSTREAM_RESPONSE_WITHHELD, "<upstream response withheld>");
});

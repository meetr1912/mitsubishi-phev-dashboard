import assert from "node:assert/strict";
import test from "node:test";

import { SerialMutationQueue } from "../.test-dist/src/serial-mutation-queue.js";
import { classifyPrecipitationPhase, haversineDistanceKm, radarSamplesAreFreshAndAligned, snowAdhesionRisk, snowWeatherConfidence, summarizeSnowSeverity } from "../.test-dist/src/snow-guard-policy.js";
import { isSnowFeedbackOutcome, snowFeedbackPrompt, summariseSnowCalibration } from "../.test-dist/src/snow-guard-calibration.js";
import { CORS_ALLOW_METHODS, UPSTREAM_RESPONSE_WITHHELD } from "../.test-dist/src/worker-safety.js";

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
    { id: "a", actionAt: "2026-12-01T11:00:00Z", eligibleAt: "2026-12-01T11:20:00Z", expiresAt: "2026-12-02T23:00:00Z", minutes: 20, batteryPctAtStart: 80, pluggedInAtStart: true, weather: {}, outcome: "clear" },
    { id: "b", actionAt: "2026-12-01T11:30:00Z", eligibleAt: "2026-12-01T11:50:00Z", expiresAt: "2026-12-02T23:30:00Z", minutes: 20, batteryPctAtStart: 80, pluggedInAtStart: true, weather: {} },
  ];
  assert.deepEqual(snowFeedbackPrompt(cases, now), { eventId: "b", actionAt: "2026-12-01T11:30:00Z", minutes: 20 });
  assert.deepEqual(summariseSnowCalibration(cases), {
    eligibleActions: 2, responses: 1, clear: 1, partial: 0, noBenefit: 0,
    usefulRate: 1, minimumSample: 10, readyForReview: false,
  });
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

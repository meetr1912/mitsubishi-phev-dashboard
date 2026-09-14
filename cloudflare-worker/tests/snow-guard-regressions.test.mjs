import assert from "node:assert/strict";
import test from "node:test";

import { SerialMutationQueue } from "../.test-dist/src/serial-mutation-queue.js";
import { snowAdhesionRisk, summarizeSnowSeverity } from "../.test-dist/src/snow-guard-policy.js";
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function load() {
  const source = await readFile(new URL("../vehicle-intelligence.js", import.meta.url), "utf8");
  const context = {
    window: { PHEV: { onData() {} } },
    document: { getElementById() { return null; }, addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    Date, Math, Number, String, Array, Object, isFinite,
  };
  vm.runInNewContext(source, context, { filename: "vehicle-intelligence.js" });
  return context.window.PHEV.computeVehicleIntelligence;
}

test("vehicle intelligence keeps reliability, readiness, and distance claims evidence-bound", async () => {
  const compute = await load();
  const reliability = compute.reliability([
    { kind: "command", at: "2026-09-01T00:00:00Z", action: "lock", result: { outcome: "succeeded", success: true, duration_ms: 5000 } },
    { kind: "command", at: "2026-09-02T00:00:00Z", action: "climate", result: { outcome: "timeout", success: false } },
  ]);
  assert.equal(reliability.successPct, 50);
  assert.equal(reliability.medianMs, 5000);
  assert.equal(reliability.latestFailure.action, "climate");
  const ready = compute.readiness({ latest: { plugged_in: true, battery_pct: 60 } }, { config: { enabled: true, requirePlugged: true, minBatteryPct: 35, outsideParkingConfirmed: true } });
  assert.equal(ready.ready, true);
  assert.equal(compute.readiness({ latest: { plugged_in: false, battery_pct: 10 } }, { config: { enabled: true, requirePlugged: true, minBatteryPct: 35 } }).ready, false);
  const baseline = compute.tripBaseline({ rollups: { daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, odometer_km: { distance_km: index < 7 ? 10 : 20 } })) } });
  assert.deepEqual(JSON.parse(JSON.stringify(baseline)), { days: 14, recentKm: 140, priorKm: 70, deltaPct: 100 });
  const snow = compute.snowEvidence({ runtime: { lastDecision: { code: "climate_pending", summary: "Awaiting confirmation", weather: { confidence: "high" } } }, calibration: { responses: 5, usefulRate: .8 } });
  assert.equal(snow.confidence, "high");
  assert.match(compute.departurePlan({ latest: { plugged_in: false, battery_pct: 10 } }, { config: { enabled: true, requirePlugged: true, minBatteryPct: 35 } }, { time: "08:00" }), /not reported plugged in/);
});

test("state changes only compare reported values", async () => {
  const compute = await load();
  const changes = compute.stateChanges({ hourly_history: [
    { ts: "2026-09-01T00:00:00Z", plugged_in: false, battery_pct: 50 },
    { ts: "2026-09-01T01:00:00Z", plugged_in: true, battery_pct: 50 },
    { ts: "2026-09-01T02:00:00Z", plugged_in: true, battery_pct: 55 },
  ] });
  assert.equal(changes.length, 2);
  assert.equal(changes[0].field, "Battery");
});

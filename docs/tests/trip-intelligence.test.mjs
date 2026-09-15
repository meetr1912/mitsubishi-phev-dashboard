import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function load() {
  const source = await readFile(new URL("../trip-intelligence.js", import.meta.url), "utf8");
  const context = { window: { PHEV: { onData() {} } }, document: { getElementById() { return null; } }, Number, Math, isFinite };
  vm.runInNewContext(source, context, { filename: "trip-intelligence.js" });
  return context.window.PHEV.computeTripIntelligence;
}

test("trip intelligence reports only logged distance, observed charging, and explicit EV/gas splits", async () => {
  const compute = await load();
  const summary = compute({ rollups: {
    daily: [
      { date: "2026-01-01", odometer_km: { distance_km: 12.4 }, charging_sessions: 1 },
      { date: "2026-01-02", odometer_km: { distance_km: 0 }, charging_sessions: 0 },
      { date: "2026-01-03", odometer_km: { distance_km: 7.6 }, charging_sessions: 2 },
    ],
    monthly: [{ period: "2026-01", ev_distance_km: 80, gas_distance_km: 20 }],
  }});
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { days: 3, distanceKm: 20, activeDays: 2, chargingSessions: 3, evSharePct: 80, mixSource: "mileage tracker" });
  assert.equal(compute({ rollups: { daily: [], monthly: [{ period: "2026-01", distance_km: 100 }] } }).evSharePct, null);
});

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

test("dashboard keeps activity, trends, and their data loaders wired into the shell", async () => {
  const [html, nav, activity, charts, worker] = await Promise.all([
    text("docs/index.html"), text("docs/nav.js"), text("docs/activity.js"), text("docs/charts.js"), text("cloudflare-worker/src/index.ts"),
  ]);
  for (const tab of ["activity", "history"]) {
    assert.match(html, new RegExp(`id="tab-${tab}"`));
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(nav, new RegExp(`"${tab}"`));
  }
  assert.match(html, /<script src="activity\.js" defer><\/script>/);
  assert.match(html, /<script src="charts\.js" defer><\/script>/);
  assert.match(activity, /\/activity\?limit=1000/);
  assert.match(charts, /hourly_history/);
  assert.match(worker, /url\.pathname === "\/activity"/);
});

test("encrypted vehicle history is published and never part of the service-worker shell cache", async () => {
  const [meta, serviceWorker, encrypted] = await Promise.all([
    text("docs/data/meta.json"), text("docs/sw.js"), stat(new URL("docs/data/history.enc.json", root)),
  ]);
  assert.equal(JSON.parse(meta).schema_version, 1);
  assert.ok(encrypted.size > 1024, "expected a non-empty encrypted vehicle-history payload");
  assert.match(serviceWorker, /url\.pathname\.indexOf\("\/data\/"\) !== -1/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadContract() {
  const source = await readFile(new URL("../data-contract.js", import.meta.url), "utf8");
  const context = { window: { PHEV: {} }, Object, Array, Error };
  vm.runInNewContext(source, context, { filename: "data-contract.js" });
  return context.window.PHEV.validateDataDocument;
}

test("dashboard data contract accepts a populated current report and additive history", async () => {
  const validate = await loadContract();
  const document = {
    vehicle: { nickname: "Outlander" },
    latest: { ts: "2026-09-15T01:00:00Z", battery_pct: 72, plugged_in: false },
    hourly_history: [],
    future_schema_field: { safe: true },
  };
  assert.equal(validate(document), document);
});

test("dashboard data contract rejects empty and malformed decrypted documents", async () => {
  const validate = await loadContract();
  for (const value of [null, [], {}, { latest: null }, { latest: [] }, { latest: {} }, { latest: { battery_pct: 50 }, vehicle: [] }]) {
    assert.throws(() => validate(value), { code: value && value.latest && Object.keys(value.latest).length ? "data_invalid" : /data_(invalid|empty)/ });
  }
  assert.throws(() => validate({ latest: {} }), { code: "data_empty" });
  assert.throws(() => validate({ latest: { battery_pct: 50 }, hourly_history: {} }), { code: "data_invalid" });
});

test("main page and service worker load the data contract before the decryptor", async () => {
  const root = new URL("../", import.meta.url);
  const [page, worker] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("sw.js", root), "utf8"),
  ]);
  assert.ok(page.indexOf('src="data-contract.js"') < page.indexOf('src="crypto.js"'));
  assert.match(worker, /phev-shell-v14/);
  assert.match(worker, /"\.\/data-contract\.js"/);
});

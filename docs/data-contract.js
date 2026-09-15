/* data-contract.js — validation for the decrypted dashboard snapshot.
 *
 * The encrypted file is intentionally opaque to the static host.  Validate its
 * shape immediately after decryption so a bad publish is never mistaken for a
 * bad passphrase or rendered as an empty dashboard.
 */
(function () {
  "use strict";

  window.PHEV = window.PHEV || {};

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
  }

  function dataError(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }

  // Keep this deliberately permissive for older history files: a valid report
  // may contain unknown future fields.  It must still have a current snapshot
  // and at least one meaningful vehicle value, otherwise the UI would only
  // show placeholders and falsely look like a successful unlock.
  function validateDataDocument(data) {
    if (!isRecord(data)) throw dataError("data_invalid");
    if (!isRecord(data.latest)) throw dataError("data_invalid");

    var latest = data.latest;
    var meaningfulFields = [
      "ts", "battery_pct", "ev_range_km", "gas_range_km", "total_range_km",
      "odometer_km", "charging_status", "plugged_in", "doors", "warnings"
    ];
    var hasMeaningfulField = meaningfulFields.some(function (key) {
      return hasOwn(latest, key) && latest[key] !== null && latest[key] !== undefined && latest[key] !== "";
    });
    if (!hasMeaningfulField) throw dataError("data_empty");
    if (hasOwn(data, "vehicle") && !isRecord(data.vehicle)) throw dataError("data_invalid");
    if (hasOwn(data, "hourly_history") && !Array.isArray(data.hourly_history)) throw dataError("data_invalid");
    return data;
  }

  window.PHEV.validateDataDocument = validateDataDocument;
})();

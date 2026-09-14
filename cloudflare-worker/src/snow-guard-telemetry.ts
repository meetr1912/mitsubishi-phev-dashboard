/**
 * Strict, non-recursive parsing for the small subset of Mitsubishi telemetry
 * used to qualify a calibration sample. Generic recursive lookup is useful
 * for dashboard display, but it can accidentally select a historical value
 * (for example svlaLocMap.spd) from a different report.
 */
export type TelemetryJsonValue = string | number | boolean | null | TelemetryJsonValue[] | { [key: string]: TelemetryJsonValue };

type TelemetryRecord = { [key: string]: TelemetryJsonValue };
type JsonPath = readonly (string | number)[];

function asRecord(value: TelemetryJsonValue | undefined): TelemetryRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function directPath(value: TelemetryJsonValue | null, path: JsonPath): TelemetryJsonValue | undefined {
  let current: TelemetryJsonValue | undefined = value ?? undefined;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current) || part < 0 || part >= current.length) return undefined;
      current = current[part];
      continue;
    }
    const record = asRecord(current);
    if (!record || !(part in record)) return undefined;
    current = record[part];
  }
  return current;
}

function scalar(value: TelemetryJsonValue | undefined): TelemetryJsonValue | undefined {
  const record = asRecord(value);
  if (record) {
    for (const key of ["value", "val", "data"]) {
      if (key in record) return record[key];
    }
  }
  return value;
}

function numberValue(value: TelemetryJsonValue | undefined): number | null {
  const raw = scalar(value);
  const parsed = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: TelemetryJsonValue | undefined): boolean | null {
  const raw = scalar(value);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 0 ? false : raw === 1 ? true : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on", "plugged", "pluggedin", "connected", "charging"].includes(text)) return true;
  if (["false", "0", "no", "off", "unplugged", "disconnected", "not_charging", "not charging"].includes(text)) return false;
  return null;
}

/** Parse the epoch-second/millisecond timestamps emitted by the native app. */
export function telemetryEpochMs(value: TelemetryJsonValue | undefined): number | null {
  const epoch = numberValue(value);
  if (epoch === null || epoch < 1_000_000_000) return null;
  // Dates through 2065; deliberately reject timezone-less display strings.
  if (epoch < 3_000_000_000) return Math.round(epoch * 1_000);
  if (epoch < 3_000_000_000_000) return Math.round(epoch);
  return null;
}

/** Accept a timestamp only within the stated past age and small clock skew. */
export function telemetryTimestampIsRecent(
  timestampMs: number | null,
  nowMs: number,
  maximumAgeMs = 5 * 60_000,
  maximumFutureSkewMs = 30_000,
): boolean {
  return timestampMs !== null &&
    Number.isFinite(timestampMs) &&
    timestampMs <= nowMs + maximumFutureSkewMs &&
    timestampMs >= nowMs - maximumAgeMs;
}

/**
 * A VHR refresh acknowledgement is not vehicle evidence on its own. Accept
 * only the app's acknowledged statuses together with a report timestamp that
 * is fresh and correlated to the request that asked for it.
 */
export function isFreshVhrRefreshEvidence(input: {
  acknowledgementStatus: string | null;
  reportTimestampMs: number | null;
  refreshRequestedAtMs: number;
  sampledAtMs: number;
  maximumAgeMs?: number;
  maximumFutureSkewMs?: number;
  maximumPastCorrelationSkewMs?: number;
}): boolean {
  const acknowledgement = input.acknowledgementStatus?.trim().toLowerCase();
  if (acknowledgement !== "successful" && acknowledgement !== "success" && acknowledgement !== "inqueue") return false;
  const futureSkew = input.maximumFutureSkewMs ?? 30_000;
  // VHR envelope timestamps are second-resolution in the native fixtures.
  // This small tolerance is only for that truncation, not a stale cache.
  const pastCorrelationSkew = input.maximumPastCorrelationSkewMs ?? 2_000;
  return input.reportTimestampMs !== null &&
    input.reportTimestampMs >= input.refreshRequestedAtMs - pastCorrelationSkew &&
    telemetryTimestampIsRecent(
      input.reportTimestampMs,
      input.sampledAtMs,
      input.maximumAgeMs ?? 5 * 60_000,
      futureSkew,
    );
}

export interface HealthCalibrationTelemetry {
  reportedAtMs: number | null;
  batteryPct: number | null;
  pluggedIn: boolean | null;
  odometerKm: number | null;
  ignitionOn: boolean | null;
  speedKmh: number | null;
  vehicleStatus: TelemetryJsonValue | null;
}

/**
 * The native health feed puts battery, plug, odometer, ignition and speed in
 * one `vehicleStatus` VHR diagnostic report. Do not fall back to generic
 * recursive fields: they may describe a different report and would invalidate
 * the comparison.
 */
export function parseHealthCalibrationTelemetry(health: TelemetryJsonValue | null): HealthCalibrationTelemetry {
  const vhrRows = directPath(health, ["vhr"]);
  const candidates = Array.isArray(vhrRows) ? vhrRows : [];
  let selected: { diagnostic: TelemetryRecord; reportedAtMs: number; vehicleStatus: TelemetryJsonValue | null } | null = null;
  for (const item of candidates) {
    const report = asRecord(item);
    const dt = asRecord(report?.dt);
    const diagnostic = asRecord(dt?.diagnostic);
    const operation = scalar(report?.operation);
    if (!report || !dt || !diagnostic || typeof operation !== "string" || operation.trim().toLowerCase() !== "vehiclestatus") continue;
    const reportTs = telemetryEpochMs(report.ts);
    const diagnosticTs = telemetryEpochMs(diagnostic.eventTimestamp);
    // VHR envelope `ts` is the canonical report time in native fixture
    // variants. If the optional diagnostic timestamp is present, it must
    // agree, otherwise the report is ambiguous. Never use digsts here.
    if (reportTs === null || (diagnosticTs !== null && Math.abs(reportTs - diagnosticTs) > 60_000)) continue;
    const reportedAtMs = reportTs;
    if (!selected || reportedAtMs > selected.reportedAtMs) {
      selected = { diagnostic, reportedAtMs, vehicleStatus: dt.vehicleStatus ?? null };
    }
  }
  if (!selected) {
    return { reportedAtMs: null, batteryPct: null, pluggedIn: null, odometerKm: null, ignitionOn: null, speedKmh: null, vehicleStatus: null };
  }
  const battery = numberValue(selected.diagnostic.batteryLife);
  const odometer = numberValue(selected.diagnostic.odo ?? selected.diagnostic.odometer);
  const speed = numberValue(selected.diagnostic.spd);
  return {
    reportedAtMs: selected.reportedAtMs,
    batteryPct: battery !== null && battery >= 0 && battery <= 100 ? Math.round(battery) : null,
    pluggedIn: booleanValue(selected.diagnostic.chargePlugConnected),
    odometerKm: odometer !== null && odometer >= 0 ? Math.round(odometer) : null,
    ignitionOn: booleanValue(selected.diagnostic.igst),
    // A negative value is a sentinel/malformed value, never proof that a
    // parked vehicle is stationary. Bound the physical range as well.
    speedKmh: speed !== null && speed >= 0 && speed <= 300 ? speed : null,
    vehicleStatus: selected.vehicleStatus,
  };
}

/**
 * Small, deliberately display-only helpers for Snow Guard weather sources.
 *
 * The City Page service is a useful official fallback when the model forecast
 * is unavailable, but it is a city forecast rather than a 15-minute local
 * nowcast. Nothing in this module may be used to authorise remote climate.
 */

export const ECCC_HALIFAX_CITY_PAGE_ID = "ns-40";
export const ECCC_HALIFAX_CITY_PAGE_URL =
  "https://api.weather.gc.ca/collections/citypageweather-realtime/items/ns-40?f=json&lang=en";
export const ECCC_CITY_PAGE_MAX_AGE_MS = 120 * 60_000;

export type SnowWeatherSource = "open_meteo_forecast" | "eccc_radar" | "eccc_citypage";

/**
 * Safe-to-return failure categories. They intentionally omit raw URLs,
 * upstream bodies, and exception messages.
 */
export type SnowWeatherSourceFailureKind =
  | "timeout"
  | "network"
  | "rate_limited"
  | "upstream_error"
  | "request_rejected"
  | "invalid_payload"
  | "stale";

export interface SnowWeatherSourceFailure {
  source: SnowWeatherSource;
  kind: SnowWeatherSourceFailureKind;
  httpStatus: number | null;
}

export function weatherSourceFailureFromHttp(
  source: SnowWeatherSource,
  status: unknown,
): SnowWeatherSourceFailure {
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
  const kind: SnowWeatherSourceFailureKind = httpStatus === 429
    ? "rate_limited"
    : httpStatus !== null && httpStatus >= 500
      ? "upstream_error"
      : httpStatus !== null && httpStatus >= 400
        ? "request_rejected"
        : "invalid_payload";
  return { source, kind, httpStatus };
}

export function weatherSourceFailureFromTransport(
  source: SnowWeatherSource,
  timedOut: boolean,
): SnowWeatherSourceFailure {
  return { source, kind: timedOut ? "timeout" : "network", httpStatus: null };
}

export function weatherSourceFailureFromPayload(source: SnowWeatherSource): SnowWeatherSourceFailure {
  return { source, kind: "invalid_payload", httpStatus: null };
}

/** A short user-facing sentence that never includes upstream text. */
export function weatherSourceFailureMessage(failure: SnowWeatherSourceFailure): string {
  const source = failure.source === "open_meteo_forecast"
    ? "Open-Meteo forecast"
    : failure.source === "eccc_radar"
      ? "ECCC radar"
      : "ECCC city forecast";
  switch (failure.kind) {
    case "timeout": return `${source} timed out.`;
    case "network": return `${source} could not be reached.`;
    case "rate_limited": return `${source} is rate-limited.`;
    case "upstream_error": return `${source} returned an upstream error.`;
    case "request_rejected": return `${source} rejected this request.`;
    case "invalid_payload": return `${source} returned an invalid response.`;
    case "stale": return `${source} is stale.`;
  }
}

export interface EcccCityPageDisplay {
  source: "eccc_citypage";
  /** A type-level guardrail: this fallback is never action evidence. */
  actionEligible: false;
  location: string;
  region: string | null;
  observedAt: string | null;
  updatedAt: string | null;
  station: string | null;
  condition: string | null;
  temperatureC: number | null;
  dewPointC: number | null;
  relativeHumidityPct: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  nextPeriod: { name: string | null; summary: string | null } | null;
}

/** Both the provider update and the observed condition must be recent. */
export function ecccCityPageIsFresh(
  display: EcccCityPageDisplay,
  nowMs = Date.now(),
  maxAgeMs = ECCC_CITY_PAGE_MAX_AGE_MS,
  futureSkewMs = 30_000,
): boolean {
  const observedAt = display.observedAt ? Date.parse(display.observedAt) : Number.NaN;
  const updatedAt = display.updatedAt ? Date.parse(display.updatedAt) : Number.NaN;
  if (!Number.isFinite(observedAt) || !Number.isFinite(updatedAt)) return false;
  return [nowMs - observedAt, nowMs - updatedAt]
    .every((age) => age >= -futureSkewMs && age <= maxAgeMs);
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function atPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return cleaned || null;
}

function englishText(value: unknown, maxLength: number): string | null {
  const record = asRecord(value);
  return cleanText(record ? record.en : value, maxLength);
}

function englishNumber(value: unknown): number | null {
  const record = asRecord(value);
  const candidate = record ? record.en : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(candidate.trim())) {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boundedEnglishNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = englishNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function isoTimestamp(value: unknown): string | null {
  const text = englishText(value, 64);
  if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null;
  return new Date(timestamp).toISOString();
}

/**
 * Parse the single official City Page item for display after a primary forecast
 * failure. The expected identifier prevents a response for another city being
 * presented as Halifax. Forecast prose is retained only as prose: no snow,
 * precipitation, timing, or action quantities are inferred from it.
 */
export function parseEcccCityPageDisplay(
  raw: unknown,
  expectedIdentifier = ECCC_HALIFAX_CITY_PAGE_ID,
): EcccCityPageDisplay | null {
  const root = asRecord(raw);
  const properties = root ? asRecord(root.properties) : null;
  if (!properties || cleanText(properties.identifier, 32) !== expectedIdentifier) return null;

  const location = englishText(properties.name, 96);
  if (!location) return null;

  const current = asRecord(properties.currentConditions);
  const forecastGroup = asRecord(properties.forecastGroup);
  const forecasts = Array.isArray(forecastGroup?.forecasts) ? forecastGroup.forecasts : [];
  const firstForecast = forecasts.map(asRecord).find((item): item is JsonRecord => item !== null) ?? null;
  const nextPeriodName = firstForecast ? englishText(atPath(firstForecast, ["period", "textForecastName"]), 96) : null;
  const nextPeriodSummary = firstForecast ? englishText(firstForecast.textSummary, 480) : null;

  return {
    source: "eccc_citypage",
    actionEligible: false,
    location,
    region: englishText(properties.region, 160),
    observedAt: isoTimestamp(current?.timestamp),
    updatedAt: isoTimestamp(properties.lastUpdated),
    station: englishText(atPath(current, ["station", "value"]), 120),
    condition: englishText(current?.condition, 240),
    temperatureC: boundedEnglishNumber(atPath(current, ["temperature", "value"]), -100, 80),
    dewPointC: boundedEnglishNumber(atPath(current, ["dewpoint", "value"]), -100, 60),
    relativeHumidityPct: boundedEnglishNumber(atPath(current, ["relativeHumidity", "value"]), 0, 100),
    windSpeedKmh: boundedEnglishNumber(atPath(current, ["wind", "speed", "value"]), 0, 500),
    windGustKmh: boundedEnglishNumber(atPath(current, ["wind", "gust", "value"]), 0, 500),
    nextPeriod: nextPeriodName || nextPeriodSummary ? { name: nextPeriodName, summary: nextPeriodSummary } : null,
  };
}

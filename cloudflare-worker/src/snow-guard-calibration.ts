/**
 * Snow Guard feedback stays deliberately small and deterministic. It records
 * whether a completed automatic climate cycle helped the windshield; it never
 * auto-tunes a vehicle-control threshold from a few subjective reports.
 */
export type SnowFeedbackOutcome = "clear" | "partial" | "no_benefit";

export interface SnowCalibrationWeather {
  temperatureC: number | null;
  wetBulbC: number | null;
  currentSnowCm: number;
  nextHourSnowCm: number;
  nextThreeHoursSnowCm: number;
  precipitationPhase: string;
  adhesionRisk: string;
  confidence: string;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  radarPhase: string;
  radarSnowRateCmH: number | null;
  radarSourceAt: string | null;
  radarDataAgeMinutes: number | null;
  radarFresh: boolean;
}

export interface SnowCalibrationCase {
  id: string;
  actionAt: string;
  eligibleAt: string;
  expiresAt: string;
  minutes: 20 | 30;
  batteryPctAtStart: number | null;
  pluggedInAtStart: boolean | null;
  odometerKmAtStart: number | null;
  /** Timestamp from the co-timestamped Mitsubishi VHR report, not fetch time. */
  batteryTelemetryAtStart?: string;
  batteryPctAfter?: number | null;
  pluggedInAfter?: boolean | null;
  odometerKmAfter?: number | null;
  /** Timestamp from the later co-timestamped Mitsubishi VHR report. */
  batteryTelemetryAt?: string;
  batteryMeasuredAt?: string;
  /** Present only after strict source-time, unplugged, and no-odo-change screening. */
  batteryDeltaPct?: number | null;
  weather: SnowCalibrationWeather;
  outcome?: SnowFeedbackOutcome;
  feedbackAt?: string;
}

export interface SnowFeedbackPrompt {
  eventId: string;
  actionAt: string;
  minutes: 20 | 30;
}

export interface SnowCalibrationSummary {
  eligibleActions: number;
  responses: number;
  clear: number;
  partial: number;
  noBenefit: number;
  usefulRate: number | null;
  /**
   * Strictly screened observations only. They are reported battery changes,
   * not a vehicle energy measurement.
   */
  screenedBatterySamples: number;
  meanScreenedBatteryDeltaPct: number | null;
  minimumSample: number;
  readyForReview: boolean;
  reviewRecommendation: string;
}

export const SNOW_CALIBRATION_MINIMUM_SAMPLE = 10;
const HOUR_MS = 60 * 60_000;

export function isSnowFeedbackOutcome(value: unknown): value is SnowFeedbackOutcome {
  return value === "clear" || value === "partial" || value === "no_benefit";
}

export function snowFeedbackPrompt(cases: readonly SnowCalibrationCase[], now = Date.now()): SnowFeedbackPrompt | null {
  const eligible = cases
    .filter((item) => !item.outcome && Date.parse(item.eligibleAt) <= now && now <= Date.parse(item.expiresAt))
    .sort((a, b) => Date.parse(b.actionAt) - Date.parse(a.actionAt))[0];
  return eligible ? { eventId: eligible.id, actionAt: eligible.actionAt, minutes: eligible.minutes } : null;
}

/**
 * A battery percentage is not an energy meter. This conservative comparison
 * is retained only as a screened reported observation: both co-timestamped
 * reports must be time-valid, unplugged, and show no reported odometer change.
 * A missing or ambiguous value produces no result rather than a guessed delta.
 */
export function screenedReportedBatteryDeltaPct(sample: Pick<SnowCalibrationCase,
  "actionAt" | "batteryPctAtStart" | "pluggedInAtStart" | "odometerKmAtStart" | "batteryTelemetryAtStart" |
  "batteryPctAfter" | "pluggedInAfter" | "odometerKmAfter" | "batteryTelemetryAt" |
  "batteryMeasuredAt" | "eligibleAt"
>): number | null {
  const startBattery = sample.batteryPctAtStart;
  const afterBattery = sample.batteryPctAfter;
  const startOdometer = sample.odometerKmAtStart;
  const afterOdometer = sample.odometerKmAfter;
  const startTelemetryAt = Date.parse(sample.batteryTelemetryAtStart ?? "");
  const afterTelemetryAt = Date.parse(sample.batteryTelemetryAt ?? "");
  const measuredAt = Date.parse(sample.batteryMeasuredAt ?? "");
  const eligibleAt = Date.parse(sample.eligibleAt);
  const actionAt = Date.parse(sample.actionAt);
  if (
    sample.pluggedInAtStart !== false ||
    sample.pluggedInAfter !== false ||
    typeof startBattery !== "number" || !Number.isFinite(startBattery) || startBattery < 0 || startBattery > 100 ||
    typeof afterBattery !== "number" || !Number.isFinite(afterBattery) || afterBattery < 0 || afterBattery > 100 ||
    typeof startOdometer !== "number" || !Number.isFinite(startOdometer) || startOdometer < 0 ||
    typeof afterOdometer !== "number" || !Number.isFinite(afterOdometer) || afterOdometer < 0 ||
    startOdometer !== afterOdometer ||
    !Number.isFinite(startTelemetryAt) ||
    !Number.isFinite(afterTelemetryAt) ||
    !Number.isFinite(measuredAt) ||
    !Number.isFinite(eligibleAt) ||
    !Number.isFinite(actionAt) ||
    startTelemetryAt > actionAt ||
    actionAt - startTelemetryAt > 5 * 60_000 ||
    afterTelemetryAt < eligibleAt ||
    afterTelemetryAt > eligibleAt + 15 * 60_000 ||
    afterTelemetryAt <= startTelemetryAt ||
    measuredAt < afterTelemetryAt
  ) return null;
  return Math.round((afterBattery - startBattery) * 10) / 10;
}

export function summariseSnowCalibration(cases: readonly SnowCalibrationCase[]): SnowCalibrationSummary {
  let clear = 0;
  let partial = 0;
  let noBenefit = 0;
  const screenedBatteryDeltas: number[] = [];
  for (const item of cases) {
    if (item.outcome === "clear") clear += 1;
    if (item.outcome === "partial") partial += 1;
    if (item.outcome === "no_benefit") noBenefit += 1;
    const screenedDelta = screenedReportedBatteryDeltaPct(item);
    if (screenedDelta !== null) screenedBatteryDeltas.push(screenedDelta);
  }
  const responses = clear + partial + noBenefit;
  // A partial result counts as half a useful outcome. This is transparent
  // evidence for review, not an automatic policy adjustment.
  const usefulRate = responses ? Math.round(((clear + partial * 0.5) / responses) * 100) / 100 : null;
  const meanScreenedBatteryDeltaPct = screenedBatteryDeltas.length
    ? Math.round((screenedBatteryDeltas.reduce((total, value) => total + value, 0) / screenedBatteryDeltas.length) * 10) / 10
    : null;
  let reviewRecommendation = "Keep collecting outcomes; Snow Guard will not change its own rules.";
  if (responses >= SNOW_CALIBRATION_MINIMUM_SAMPLE && usefulRate !== null) {
    reviewRecommendation = usefulRate >= 0.8
      ? "Evidence supports the current conservative guardrails."
      : usefulRate <= 0.4
        ? "Evidence is weak; keep automation conservative and review conditions before widening it."
        : "Results are mixed; review conditions manually before changing guardrails.";
  }
  return {
    eligibleActions: cases.length,
    responses,
    clear,
    partial,
    noBenefit,
    usefulRate,
    screenedBatterySamples: screenedBatteryDeltas.length,
    meanScreenedBatteryDeltaPct,
    minimumSample: SNOW_CALIBRATION_MINIMUM_SAMPLE,
    readyForReview: responses >= SNOW_CALIBRATION_MINIMUM_SAMPLE,
    reviewRecommendation,
  };
}

export function newSnowCalibrationCase(input: Omit<SnowCalibrationCase, "id" | "eligibleAt" | "expiresAt"> & { id: string }): SnowCalibrationCase {
  const start = Date.parse(input.actionAt);
  const actionMs = Number.isFinite(start) ? start : Date.now();
  return {
    ...input,
    eligibleAt: new Date(actionMs + input.minutes * 60_000).toISOString(),
    expiresAt: new Date(actionMs + 36 * HOUR_MS).toISOString(),
  };
}

/** Keep only one winter season's bounded, non-sensitive outcome data. */
export function retainSnowCalibrationCases(cases: readonly SnowCalibrationCase[], now = Date.now()): SnowCalibrationCase[] {
  const cutoff = now - 365 * 24 * HOUR_MS;
  return cases
    .filter((item) => {
      const actionAt = Date.parse(item.actionAt);
      return Number.isFinite(actionAt) && actionAt >= cutoff;
    })
    .sort((a, b) => Date.parse(b.actionAt) - Date.parse(a.actionAt))
    .slice(0, 120);
}

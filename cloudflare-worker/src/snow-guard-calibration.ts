/**
 * Snow Guard feedback stays deliberately small and deterministic. It records
 * whether a completed automatic climate cycle helped the windshield; it never
 * auto-tunes a vehicle-control threshold from a few subjective reports.
 */
export type SnowFeedbackOutcome = "clear" | "partial" | "no_benefit";

export interface SnowCalibrationWeather {
  temperatureC: number | null;
  wetBulbC: number | null;
  nextHourSnowCm: number;
  nextThreeHoursSnowCm: number;
  precipitationPhase: string;
  adhesionRisk: string;
  confidence: string;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
}

export interface SnowCalibrationCase {
  id: string;
  actionAt: string;
  eligibleAt: string;
  expiresAt: string;
  minutes: 20 | 30;
  batteryPctAtStart: number | null;
  pluggedInAtStart: boolean | null;
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
  minimumSample: number;
  readyForReview: boolean;
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

export function summariseSnowCalibration(cases: readonly SnowCalibrationCase[]): SnowCalibrationSummary {
  let clear = 0;
  let partial = 0;
  let noBenefit = 0;
  for (const item of cases) {
    if (item.outcome === "clear") clear += 1;
    if (item.outcome === "partial") partial += 1;
    if (item.outcome === "no_benefit") noBenefit += 1;
  }
  const responses = clear + partial + noBenefit;
  // A partial result counts as half a useful outcome. This is transparent
  // evidence for review, not an automatic policy adjustment.
  const usefulRate = responses ? Math.round(((clear + partial * 0.5) / responses) * 100) / 100 : null;
  return {
    eligibleActions: cases.length,
    responses,
    clear,
    partial,
    noBenefit,
    usefulRate,
    minimumSample: SNOW_CALIBRATION_MINIMUM_SAMPLE,
    readyForReview: responses >= SNOW_CALIBRATION_MINIMUM_SAMPLE,
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

/* Evidence-bound Bayesian advisor for Snow Guard.
 *
 * This module deliberately cannot send commands or modify guardrails. It
 * groups completed, user-rated Snow Guard runs by comparable weather context,
 * uses a Beta(1,1) prior, and reports an advisory duration preference only
 * when both 20- and 30-minute runs have enough local evidence. */
import type { SnowCalibrationCase, SnowFeedbackOutcome } from "./snow-guard-calibration";

export type SnowDuration = 20 | 30;
export interface SnowDurationEvidence {
  minutes: SnowDuration;
  samples: number;
  clearEquivalent: number;
  posteriorMean: number | null;
  conservativeLower: number | null;
}
export interface SnowIntelligenceSummary {
  context: string | null;
  totalRatedCases: number;
  evidence: SnowDurationEvidence[];
  recommendation: "collect_more" | "no_preference" | "prefer_20" | "prefer_30";
  message: string;
}

const MIN_COMPARABLE_SAMPLES = 4;
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
const Z_80_ONE_SIDED = 1.282;

function tempBand(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "temp_unknown";
  if (value <= -10) return "temp_very_cold";
  if (value <= -4) return "temp_cold";
  if (value <= 1) return "temp_near_freezing";
  return "temp_mild";
}

export function snowContext(item: Pick<SnowCalibrationCase, "weather">): string {
  const weather = item.weather;
  return [
    tempBand(weather.temperatureC),
    `phase_${weather.precipitationPhase || "unknown"}`,
    `adhesion_${weather.adhesionRisk || "unknown"}`,
  ].join("|");
}

function outcomeWeight(outcome: SnowFeedbackOutcome): number {
  return outcome === "clear" ? 1 : outcome === "partial" ? 0.5 : 0;
}

function evidence(minutes: SnowDuration, cases: readonly SnowCalibrationCase[]): SnowDurationEvidence {
  const rated = cases.filter((item) => item.minutes === minutes && item.outcome);
  const samples = rated.length;
  const clearEquivalent = rated.reduce((sum, item) => sum + outcomeWeight(item.outcome as SnowFeedbackOutcome), 0);
  if (!samples) return { minutes, samples: 0, clearEquivalent: 0, posteriorMean: null, conservativeLower: null };
  const alpha = PRIOR_ALPHA + clearEquivalent;
  const beta = PRIOR_BETA + samples - clearEquivalent;
  const total = alpha + beta;
  const mean = alpha / total;
  // Normal approximation is used only as a conservative ranking signal, never
  // as permission to act. With fewer than four comparable samples it is hidden.
  const deviation = Math.sqrt((alpha * beta) / (total * total * (total + 1)));
  return {
    minutes, samples, clearEquivalent,
    posteriorMean: Math.round(mean * 100) / 100,
    conservativeLower: samples >= MIN_COMPARABLE_SAMPLES ? Math.max(0, Math.round((mean - Z_80_ONE_SIDED * deviation) * 100) / 100) : null,
  };
}

export function summariseSnowIntelligence(cases: readonly SnowCalibrationCase[], currentWeather?: Pick<SnowCalibrationCase, "weather">): SnowIntelligenceSummary {
  const rated = cases.filter((item) => item.outcome);
  const context = currentWeather ? snowContext(currentWeather) : null;
  const comparable = context ? rated.filter((item) => snowContext(item) === context) : [];
  const results = [evidence(20, comparable), evidence(30, comparable)];
  const twenty = results[0], thirty = results[1];
  if (!context) return { context: null, totalRatedCases: rated.length, evidence: results, recommendation: "collect_more", message: "No current weather context is available; duration advice is withheld." };
  if (twenty.samples < MIN_COMPARABLE_SAMPLES || thirty.samples < MIN_COMPARABLE_SAMPLES) {
    return { context, totalRatedCases: rated.length, evidence: results, recommendation: "collect_more", message: `Need ${MIN_COMPARABLE_SAMPLES} rated, comparable runs for both 20 and 30 minutes before advising a duration.` };
  }
  const gap = (thirty.conservativeLower ?? 0) - (twenty.conservativeLower ?? 0);
  if (gap >= 0.1) return { context, totalRatedCases: rated.length, evidence: results, recommendation: "prefer_30", message: "Comparable outcomes support 30 minutes. This is an advisory; existing weather and vehicle safety gates still decide whether any action is allowed." };
  if (gap <= -0.1) return { context, totalRatedCases: rated.length, evidence: results, recommendation: "prefer_20", message: "Comparable outcomes support 20 minutes. This is an advisory; existing weather and vehicle safety gates still decide whether any action is allowed." };
  return { context, totalRatedCases: rated.length, evidence: results, recommendation: "no_preference", message: "Comparable outcomes do not show a reliable duration advantage; retain the conservative rule-based duration." };
}

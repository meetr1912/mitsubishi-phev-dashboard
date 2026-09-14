const SNOW_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);

export type SnowSeverity = "none" | "light" | "moderate" | "heavy";
export type SnowAdhesionRisk = "low" | "moderate" | "high";

export function summarizeSnowSeverity(
  temperatureC: number | null, currentSnowCm: number, nextHourSnowCm: number,
  nextThreeHoursSnowCm: number, weatherCode: number | null,
): SnowSeverity {
  if (temperatureC === null || temperatureC > 2.5) return "none";
  const currentSnowSignal = currentSnowCm >= 0.05 || (weatherCode !== null && SNOW_WEATHER_CODES.has(weatherCode));
  const nearTermSnow = Math.max(currentSnowSignal ? 0.3 : 0, currentSnowCm, nextHourSnowCm, nextThreeHoursSnowCm);
  if (nearTermSnow < 0.3) return "none";
  if (nearTermSnow < 1.5) return "light";
  if (nearTermSnow < 4) return "moderate";
  return "heavy";
}

export function snowAdhesionRisk(
  temperatureC: number | null,
  nextHourSnowCm: number,
  nextThreeHoursSnowCm: number,
  windSpeedKmh: number | null,
): SnowAdhesionRisk {
  if (temperatureC === null || nextThreeHoursSnowCm < 0.3) return "low";
  if (temperatureC >= -2 && temperatureC <= 1.5 && nextHourSnowCm >= 0.4) return "high";
  if (nextHourSnowCm >= 1.5 || (windSpeedKmh !== null && windSpeedKmh >= 30 && nextHourSnowCm >= 0.5)) return "high";
  if (temperatureC <= -8 && nextHourSnowCm < 1) return "low";
  return "moderate";
}

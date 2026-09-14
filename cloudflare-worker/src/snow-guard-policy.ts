const SNOW_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);

export type SnowSeverity = "none" | "light" | "moderate" | "heavy";
export type SnowAdhesionRisk = "low" | "moderate" | "high";
export type SnowPrecipitationPhase = "dry" | "snow" | "mixed" | "rain" | "freezing" | "unknown";
export type SnowWeatherConfidence = "high" | "moderate" | "low";

const FREEZING_PRECIPITATION_CODES = new Set([56, 57, 66, 67]);

/**
 * Weather-code precipitation phase is deliberately conservative. A forecast
 * grid cell cannot prove what is falling on the windshield, so mixed and
 * freezing precipitation are never treated as an automatic snow-melt case.
 */
export function classifyPrecipitationPhase(
  weatherCode: number | null,
  snowfallCm: number | null,
  rainMm: number | null,
  precipitationMm: number | null,
  wetBulbC: number | null,
): SnowPrecipitationPhase {
  if (weatherCode !== null && FREEZING_PRECIPITATION_CODES.has(weatherCode)) return "freezing";
  const snow = (snowfallCm ?? 0) > 0;
  const rain = (rainMm ?? 0) > 0;
  const precipitation = (precipitationMm ?? 0) > 0;
  if (snow && rain) return "mixed";
  if (snow || (weatherCode !== null && SNOW_WEATHER_CODES.has(weatherCode))) return "snow";
  // Precipitation at a near-freezing wet bulb may be mixed/ice even when the
  // model has not classified it explicitly. Do not guess that it is harmless.
  if (precipitation && wetBulbC !== null && wetBulbC <= 0.5) return "mixed";
  if (rain || precipitation) return "rain";
  return weatherCode === null ? "unknown" : "dry";
}

/**
 * Scores data completeness, not forecast accuracy. Only high-confidence
 * weather is permitted to start the vehicle automatically; lower confidence
 * remains useful to show the owner during a manual check.
 */
export function snowWeatherConfidence(input: {
  dataAgeMinutes: number | null;
  temperatureC: number | null;
  weatherCode: number | null;
  wetBulbC: number | null;
  forecastSamples: number;
  radarFresh: boolean;
}): SnowWeatherConfidence {
  if (
    input.dataAgeMinutes === null || input.dataAgeMinutes > 45 ||
    input.temperatureC === null || input.weatherCode === null ||
    input.forecastSamples < 4 || !input.radarFresh
  ) return "low";
  if (input.dataAgeMinutes > 25 || input.wetBulbC === null || input.forecastSamples < 12) return "moderate";
  return "high";
}

/** Radar phase and snow-rate products are independent observations. */
export function radarSamplesAreFreshAndAligned(
  phaseTimestampMs: number | null,
  rateTimestampMs: number | null,
  nowMs = Date.now(),
): { fresh: boolean; dataAgeMinutes: number | null; olderTimestampMs: number | null } {
  if (phaseTimestampMs === null || rateTimestampMs === null) {
    return { fresh: false, dataAgeMinutes: null, olderTimestampMs: null };
  }
  if (phaseTimestampMs > nowMs || rateTimestampMs > nowMs) {
    return { fresh: false, dataAgeMinutes: null, olderTimestampMs: null };
  }
  const phaseAge = Math.round((nowMs - phaseTimestampMs) / 60_000);
  const rateAge = Math.round((nowMs - rateTimestampMs) / 60_000);
  if (phaseAge < 0 || rateAge < 0 || phaseAge > 12 || rateAge > 12 || Math.abs(phaseTimestampMs - rateTimestampMs) > 12 * 60_000) {
    return { fresh: false, dataAgeMinutes: null, olderTimestampMs: null };
  }
  return {
    fresh: true,
    dataAgeMinutes: Math.max(phaseAge, rateAge),
    olderTimestampMs: Math.min(phaseTimestampMs, rateTimestampMs),
  };
}

export function haversineDistanceKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const radians = Math.PI / 180;
  const latA = latitudeA * radians;
  const latB = latitudeB * radians;
  const dLat = (latitudeB - latitudeA) * radians;
  const dLon = (longitudeB - longitudeA) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
  wetBulbC: number | null = null,
): SnowAdhesionRisk {
  if (temperatureC === null || nextThreeHoursSnowCm < 0.3) return "low";
  const bondingTemperature = wetBulbC ?? temperatureC;
  if (bondingTemperature >= -2 && bondingTemperature <= 1.5 && nextHourSnowCm >= 0.4) return "high";
  if (nextHourSnowCm >= 1.5 || (windSpeedKmh !== null && windSpeedKmh >= 30 && nextHourSnowCm >= 0.5)) return "high";
  if (temperatureC <= -8 && nextHourSnowCm < 1) return "low";
  return "moderate";
}

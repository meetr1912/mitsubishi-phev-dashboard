/**
 * phev-command-relay — Cloudflare Worker
 *
 * Relays vehicle remote-commands (lock / unlock / horn / lights / locate) from a
 * phone dashboard to Mitsubishi's Aeris ATSP API.
 *
 * Protocol reverse-engineered from the "My Mitsubishi Connect" Android app.
 * See ../../mitsubishi_na/api.py + const.py for the read-only side of the same
 * auth flow (login/refresh, shared headers, VIN lookup) — that part is validated
 * working. The PIN-verify + remote-operation calls below are ported faithfully
 * from the spec but have NOT been checked against a live response. See README
 * "Known limitations" and the source comments marked [UNVERIFIED].
 *
 * Runtime: Cloudflare Workers (native fetch + Web Crypto SubtleCrypto only,
 * no npm crypto packages). The MQTT discovery path additionally uses the
 * `cloudflare:sockets` raw TCP API — see mqtt.ts.
 */

import { mqttDiscoverOperations } from "./mqtt";

// ---------------------------------------------------------------------------
// Constants (all confirmed from the decompiled app / const.py)
// ---------------------------------------------------------------------------

const BASE_URL = "https://us-m.aerpf.com:15443";
const AMP_API_KEY = "3f5547161b5d4bdbbb2bf8b26c69d1de";
const CLIENT_TRUSTED_SECRET = "ampClientTrustedSecret";

const EP_TOKEN = "/auth/v1/token";
const EP_USER_INFO = "/user/v1/users/email/"; // + encodeURIComponent(email)
const EP_SERVER_NONCE = "/oauth/v3/remoteOperation";
const EP_PIN_TOKEN = "/oauth/v3/remoteOperation/pin";
const EP_PERFORM_RO = "/avi/v3/remoteOperation";
const EP_RO_STATUS = "/avi/v1/remoteOperation/vehicles/{vin}/events/{eventId}";
const EP_PARENTAL_ALERT = "/avi/v1/vehicles/{vin}/parentalAlert";
const EP_VEHICLE_STATE = "/avi/v1/vehicles/{vin}/vehiclestate";
const EP_VEHICLE_HEALTH = "/avi/v1/vehicles/{vin}/vehicleStatus";
const EP_VEHICLE_DETAILS = "/avi/v1/vehicles/{vin}";
const EP_MODEL_CONFIG = "/api/v1/catalog/oem/model/{model}/services/configuration";
/**
 * Wake the telematics unit out of deep sleep BEFORE issuing a remote operation.
 *
 * CONFIRMED live (2026-07-28) as the missing step that made commands actually
 * reach the car: without it PerformRO still returns {eventId, status:"Started"}
 * but the vehicle never receives the message — GetROStatus then answers
 * 400 EventNotFound and nothing physically happens. With it, the same command
 * progresses Started -> MessageDelivered (915) -> Successful (1001) and the
 * hardware responds (verified with `lights` and `remoteAC`).
 *
 * Path from res/raw/environment (vehiclewakeup.path); body from
 * WakeUpSMSPayload + p151h.C7129r.
 */
const EP_VEHICLE_WAKEUP = "/api/v1/services/wakeup/vehicle/{vin}";

/**
 * Read-only settings groups, all served by the single parentalAlert template
 * with a different ?operation= value. Confirmed from res/raw/environment:
 * getchargingcontrol / getchargingcontrolscheduler / getclimateschedules /
 * getclimatecontrol / getcurfews / getgeofences / getspeedalert /
 * getprivacymode all resolve to this same path.
 */
const SETTINGS_OPERATIONS = new Set([
  "remoteAC",
  "climateControl",
  "chargingControl",
  "chargingControl2",
  "curfew",
  "geofence",
  "speedAlert",
  "privacyMode",
]);

/** action (from dashboard) -> Aeris "operation" field. */
const OPERATION_MAP: Record<string, string> = {
  lock: "doorLock",
  unlock: "doorUnlock",
  horn: "horn",
  lights: "lights",
  locate: "locate",
  // Confirmed via BEClimatePresenter.stopClimate() -> EngineOffROUseCase ->
  // performOperation("engineOff", ...). Despite the name, on a PHEV (no
  // combustion remote-start to shut off) this ends the remote climate /
  // pre-conditioning session — it is "remoteAC off", not an engine kill.
  // getEngineOffOptions() returns null for every model except "RX"
  // (VehicleExt.m11021E), so — unlike "climate" — this sends NO dt block at
  // all; falling through OPERATION_MAP with extra left undefined matches that.
  climate_stop: "engineOff",
};

/**
 * Operations that carry a pinToken.
 *
 * Only these two. The worker previously ran the full PIN handshake for EVERY
 * command and attached the resulting token to all of them, on the assumption
 * that any actuation needs one. The validated Python client
 * (mitsubishi_na/const.py RO_REQUIRE_PIN) sends a pinToken for doorUnlock and
 * locate ONLY, and its lock/horn/lights/remoteAC/engineOff calls all reach
 * Successful without one — so the token is not required there.
 *
 * Two things this buys beyond matching the app: every non-PIN command drops two
 * subrequests (GetServerNonce + GetPinToken) off its critical path, and a
 * transient PIN-handshake failure can no longer take down commands that never
 * needed the PIN in the first place.
 *
 * locate is read-only (it reports GPS, actuates nothing) yet still needs the
 * token; lock actuates the car and does not. The split is the server's, not a
 * risk ordering we can infer.
 */
const OPERATIONS_REQUIRING_PIN = new Set(["doorUnlock", "locate"]);

/**
 * Per-operation "dt" data body, mirroring the app's
 * Utility.getDataForVehicleOperation + com/aeris/comms/protocol/mqtt/data/Data*
 * builders. Operations absent here send no dt at all (the app passes an empty
 * config map and PerformRO omits the key when empty).
 *
 * lights was being sent as the bare operation name with no dt, which is why it
 * did not actuate from the dashboard: DataLights supplies {lct:"1", lt:"0"} and
 * the Python client sends exactly that, with the car's lights confirmed
 * physically flashing (mitsubishi_na/const.py RO_DATA).
 *
 * horn, doorLock, doorUnlock, locate and engineOff are confirmed to take no dt
 * — their absence here is deliberate, not an omission. remoteAC's dt is built
 * per-request by buildHvacExtra() from the dashboard's options.
 */
const OPERATION_DATA: Record<string, Record<string, unknown>> = {
  lights: { lct: "1", lt: "0" },
};

/**
 * Cabin-comfort options, all carried inside ONE operation="remoteAC" request
 * over the same REST /avi/v3/remoteOperation endpoint as the simple commands.
 * CONFIRMED working live (2026-07-28): a real request with
 * frontLeftSeatControl/steeringHeaterControl/frontDefrostMode all set to their
 * "on" value returned {"status":"Started"} from the real backend. No MQTT
 * needed — the earlier static-analysis conclusion that hvacSettings was
 * MQTT-only was wrong.
 *
 * on/off values per HVACOption.java: seats use HEATER_ON/HEATER_OFF,
 * defrost + steering wheel use TURN_ON/TURN_OFF.
 *
 * These are deliberately NOT individually addressable actions. remoteAC starts
 * the whole climate system; firing one per seat would mean each press restarts
 * climate and silently drops whatever the previous press had enabled. The
 * dashboard therefore collects the toggles locally and submits them together
 * as a single climate start.
 */
const HVAC_OPTIONS: Record<string, { field: string; onValue: string; offValue: string }> = {
  seat_fl: { field: "frontLeftSeatControl", onValue: "HEATER_ON", offValue: "HEATER_OFF" },
  seat_fr: { field: "frontRightSeatControl", onValue: "HEATER_ON", offValue: "HEATER_OFF" },
  seat_rl: { field: "rearLeftSeatControl", onValue: "HEATER_ON", offValue: "HEATER_OFF" },
  seat_rr: { field: "rearRightSeatControl", onValue: "HEATER_ON", offValue: "HEATER_OFF" },
  steering_heat: { field: "steeringHeaterControl", onValue: "TURN_ON", offValue: "TURN_OFF" },
  defrost_front: { field: "frontDefrostMode", onValue: "TURN_ON", offValue: "TURN_OFF" },
  defrost_rear: { field: "rearDefrostMode", onValue: "TURN_ON", offValue: "TURN_OFF" },
};

/**
 * fanMode has exactly two legal wire values (FanMode.java): "VENT_FEET"
 * (normal airflow) and "DEFROST". "AUTO", which this Worker sent until now,
 * does not exist anywhere in the app.
 *
 * DEFROST is NOT this vehicle's max-defrost signal, despite the name pairing.
 * Decompiled BEClimatePresenter.onStartClicked(temp, isMaxDefrost) — the real
 * handler for the max-defrost toggle — only ever writes fanMode:"DEFROST" /
 * "VENT_FEET" inside the branch gated by VehicleExt.E(vehicle), which checks
 * `model() == "RX"` exactly. Every other DEFROST/VENT_FEET assignment site in
 * the app (RXClimateFragment, RXClimateScheduleListPresenter) is likewise
 * RX-only. Our vehicle is model "DGE" (VehicleExt.C() lists DG/DGE/UT/RX/EX as
 * separate, non-overlapping codes) — for it, `isMaxDefrost` only ever reaches
 * `climateProperty.setIsDefrost(z10)`, i.e. the top-level `def` field; fanMode
 * comes from the HVACSettings model, which nothing outside the RX classes ever
 * sets to DEFROST. So for this vehicle fanMode is unconditionally "VENT_FEET"
 * and max-defrost is carried by `def` alone — matching frontDefrostMode /
 * rearDefrostMode, which stay separate HVACSettings fields regardless.
 */
const MAX_DEFROST_OPTION = "max_defrost";
const FAN_MODE_NORMAL = "VENT_FEET";

/** Every option string the "climate" action will accept. */
const CLIMATE_OPTION_KEYS = new Set([...Object.keys(HVAC_OPTIONS), MAX_DEFROST_OPTION]);

const DEFAULT_HVAC_MINUTES = 10;
const MAX_HVAC_MINUTES = 30;

/**
 * Target cabin temperature.
 *
 * CONFIRMED by reading the decompiled builder directly
 * (com/aeris/comms/protocol/mqtt/data/DataRemoteAC.java:119-139, and
 * Utility.getDataKeyForVehicleOperation():185 which returns the key "dt" for
 * RemoteAC). The real app sends:
 *
 *   { vin, operation:"remoteAC", forced, pinToken,
 *     dt: { pos: 1, def: 0|1, tmp: <posmap index>, hvacSettings: {...} } }
 *
 * Two things follow that we had wrong:
 *
 * 1. hvacSettings is NESTED inside "dt", not a top-level sibling. Our earlier
 *    flat payload still returned {"status":"Started"}, but that is exactly what
 *    a bare climate start returns — a server that ignores an unrecognised
 *    top-level key would look identical. That is the most likely explanation
 *    for never being able to observe the seat heaters actually engaging.
 *
 * 2. Temperature is NOT a field of hvacSettings at all.
 *    ClimateProperty.HVACClimateSettings has exactly eleven members
 *    (checkNumber, fanMode, functionRequest, operationTime, frontDefrostMode,
 *    rearDefrostMode, the four seat controls, steeringHeaterControl) and none
 *    is a temperature. The setpoint rides as the sibling key "tmp", and it is
 *    NOT degrees — it is a 1-based POSITION INDEX into a per-vehicle lookup
 *    table. Sending tmp:22 means "position 22", not 22 °C.
 */

/** Constant in the app's builder (DataRemoteAC:123). */
const HVAC_POS = 1;

/**
 * Fallback "tmp" position when no posmap is available at all (fetch failed or
 * the caller sent no temperature and login/identity lookup for the posmap
 * itself failed). DataRemoteAC.a() ALWAYS calls put("tmp", ...) — there is no
 * app code path that omits it. Confirmed live 2026-07-29: omitting `tmp`
 * entirely (the previous behavior when temperatureC was null) gets the whole
 * climate start rejected by the server with HTTP 400
 * {"errorLabel":"InvalidParameterValue","errorDescription":"Invalid value for
 * dt parameter in request"} — "no temperature specified" is not a state the
 * real protocol supports, so this Worker cannot support it either. Position 16
 * on this account's DGE posmap is 25.0C, matching the app's documented
 * climate_default_temperature.
 */
const DEFAULT_HVAC_TEMP_C = 25;
const FALLBACK_TMP_POS = 16;

/**
 * Celsius -> tmp index, from the vehicle's own posmap.
 *
 * The posmap is a server-supplied array of {pos, cel, fah} on the model
 * configuration endpoint, parsed in RemoteACConfig.java:19-119. It is
 * per-vehicle, so the selectable temperature range is a property of the car,
 * not a constant we can hardcode.
 *
 * Clamping mirrors DataRemoteAC.m3250b: below the table's minimum -> 1, above
 * its maximum -> the table size.
 */
export interface PosMap {
  celToPos: Record<string, number>;
  minC: number;
  maxC: number;
  /** pos of the "LO" endpoint, if the table has one. */
  loPos: number | null;
  /** pos of the "HI" endpoint, if the table has one. */
  hiPos: number | null;
  step: number;
}

/**
 * Snap an arbitrary Celsius value onto the table's own grid.
 *
 * Confirmed shape for this account's 2025 DGE (Outlander Electric): 31 entries,
 * pos 1 = "LO", pos 2..30 = 18.0..32.0 in 0.5 steps, pos 31 = "HI". So 22 °C is
 * pos 10 — the index and the temperature are nowhere near each other.
 */
function celsiusToPos(posmap: PosMap, celsius: number): number {
  if (celsius < posmap.minC) return posmap.loPos ?? 1;
  if (celsius > posmap.maxC) return posmap.hiPos ?? Object.keys(posmap.celToPos).length;
  // Snap to the nearest authored rung so the formatted lookup always hits.
  const snapped = Math.round(celsius / posmap.step) * posmap.step;
  const exact = posmap.celToPos[snapped.toFixed(1)];
  if (exact !== undefined) return exact;
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const [key, pos] of Object.entries(posmap.celToPos)) {
    const delta = Math.abs(parseFloat(key) - celsius);
    if (Number.isFinite(delta) && delta < bestDelta) {
      bestDelta = delta;
      best = pos;
    }
  }
  return best ?? (posmap.loPos ?? 1);
}

/**
 * Outer sanity bounds only. The real selectable range is the vehicle's posmap
 * (18..32 for this car) and is enforced against it once fetched; this pair just
 * stops absurd input before the table is known.
 */
const MIN_HVAC_TEMP_C = 15;
const MAX_HVAC_TEMP_C = 35;
const HVAC_TEMP_STEP = 0.5;

export interface ClimateRequest {
  minutes: number;
  temperatureC: number | null;
  options: string[];
  posmap: PosMap | null;
}

/**
 * Read the currently supported controls before composing a climate request.
 *
 * The v2.90.10 app serializes ON or OFF for every *available* HVAC control,
 * but omits unavailable ones. Sending OFF for every known control was rejected
 * on this DGE, so capability detection is deliberately best-effort: when the
 * settings read is unavailable or unrecognised we keep the old minimal payload.
 */
async function getAvailableHvacOptions(accessToken: string, vin: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(
      `${BASE_URL}${EP_PARENTAL_ALERT.replace("{vin}", encodeURIComponent(vin))}?operation=remoteAC`,
      { headers: sharedHeaders(`Bearer ${accessToken}`) },
    );
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as JsonValue;
    if (raw === null) return null;
    const available = new Set<string>();
    for (const [name, cfg] of Object.entries(HVAC_OPTIONS)) {
      if (findKey(raw, cfg.field) !== undefined) available.add(name);
    }
    return available.size ? available : null;
  } catch {
    return null;
  }
}

/**
 * A safe, dashboard-facing summary of the controls the vehicle actually
 * reports through its remoteAC settings. `unknown` is deliberately distinct
 * from an empty list: an unfamiliar response shape must never cause the UI to
 * hide controls that may still work.
 */
function summarizeHvacCapabilities(available: ReadonlySet<string> | null): {
  availability: "reported" | "unknown";
  supported: string[];
  unavailable: string[];
  separatelyReported: string[];
} {
  if (available === null) {
    return {
      availability: "unknown",
      supported: [],
      unavailable: [],
      // Max defrost is carried by the top-level `dt.def` flag, rather than an
      // hvacSettings field, so remoteAC settings cannot report it separately.
      separatelyReported: [MAX_DEFROST_OPTION],
    };
  }
  const supported = [...available].sort();
  return {
    availability: "reported",
    supported,
    unavailable: Object.keys(HVAC_OPTIONS).filter((name) => !available.has(name)),
    separatelyReported: [MAX_DEFROST_OPTION],
  };
}

/**
 * Build the "dt" payload for a climate start, matching the app's builder.
 *
 * On the verified v2.90.10 client, every available control is explicitly sent
 * as ON or OFF. We mirror that only after discovering availability from the
 * vehicle's remoteAC settings; unknown capability shapes retain the proven
 * minimal payload rather than guessing fields the model might reject.
 */
function buildHvacExtra(
  req: ClimateRequest,
  availableOptions: ReadonlySet<string> | null = null,
): Record<string, unknown> {
  const selected = new Set(req.options);
  const hvacSettings: Record<string, unknown> = {
    fanMode: FAN_MODE_NORMAL,
    operationTime: req.minutes,
    // The app's documented default (HVACSettingConstants.CHECK_NUMBER_DEFAULT).
    checkNumber: 75,
  };
  for (const [name, cfg] of Object.entries(HVAC_OPTIONS)) {
    if (availableOptions?.has(name)) {
      hvacSettings[cfg.field] = selected.has(name) ? cfg.onValue : cfg.offValue;
    } else if (selected.has(name)) {
      hvacSettings[cfg.field] = cfg.onValue;
    }
  }

  const dt: Record<string, unknown> = {
    pos: HVAC_POS,
    // Mirrors ClimateProperty.isDefrost() / BEClimatePresenter.onStartClicked's
    // isMaxDefrost param: the top-level max-defrost flag, independent of
    // fanMode (see the fanMode comment above) and of the heated-glass
    // hvacSettings.front/rearDefrostMode fields.
    def: selected.has(MAX_DEFROST_OPTION) ? 1 : 0,
    hvacSettings,
  };
  // tmp is mandatory (see FALLBACK_TMP_POS) — never omitted, even when the
  // posmap couldn't be fetched.
  dt.tmp = req.posmap && req.temperatureC !== null ? celsiusToPos(req.posmap, req.temperatureC) : FALLBACK_TMP_POS;
  return { dt };
}

// ---------------------------------------------------------------------------
// Env — the four secrets set via `wrangler secret put ...`
// ---------------------------------------------------------------------------

export interface Env {
  MMC_USERNAME: string; // Mitsubishi Connect account email
  MMC_PASSWORD: string; // Mitsubishi Connect account password
  MMC_PIN: string; // 4-digit remote-operation PIN
  DASHBOARD_API_KEY: string; // shared secret the dashboard sends as X-Dashboard-Key
  // Fixed device identity (generate once with `uuidgen` or `openssl rand -hex 16`,
  // set via `wrangler secret put MMC_CLIENT_ID`, never change it). The real app
  // generates this once per install and reuses it forever — a fresh random one
  // per request (what we did before) may be why Mitsubishi's MQTT backend never
  // routes the client-registration response back to us: REST doesn't seem to
  // care about client-id novelty, but MQTT's device-routing plausibly does.
  MMC_CLIENT_ID: string;
  // Durable Object used for the dashboard's private, bounded activity trail.
  // It contains only redacted request/result summaries; never credentials,
  // PIN material, a VIN, location data, or raw Mitsubishi responses.
  ACTION_LOG: DurableObjectNamespace;
  /**
   * Durable, single-vehicle control plane for Snow Guard. It stores only the
   * user's guardrails, decision receipts, and cooldown state — never account
   * credentials or raw Mitsubishi responses.
   */
  SNOW_GUARD: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  // The dashboard is served from GitHub Pages (a different origin), so the
  // browser sends a CORS preflight for the custom X-Dashboard-Key header.
  // Access is still gated by that key, so a wildcard origin is acceptable here.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Key",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Private activity trail
// ---------------------------------------------------------------------------
//
// The dashboard needs an audit trail for remote commands and the validation
// reads that support them, but the Worker must never persist raw upstream
// payloads. Those can contain VINs, GPS, account details, or tokens. The
// records below are deliberately a small, stable JSON contract for the UI.

type ActivityKind = "command" | "validation" | "status";

interface ActivityRecord {
  id: string;
  at: string;
  kind: ActivityKind;
  route: string;
  action: string;
  request: Record<string, unknown>;
  result: {
    success: boolean;
    http_status: number;
    outcome: string | null;
    message: string | null;
    remote_status: string | null;
    reason_code: string | null;
    error_label: string | null;
    polls: number | null;
    duration_ms: number;
  };
}

interface AuditContext {
  id: string;
  at: string;
  startedAt: number;
  kind: ActivityKind;
  route: string;
  action: string;
  request: Record<string, unknown>;
}

const ACTIVITY_STORAGE_KEY = "records";
const ACTIVITY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const ACTIVITY_MAX_RECORDS = 1_000;

function activityId(): string {
  return Array.from(randomBytes(12)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function activityNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
}

function redactedActivityText(value: unknown): string | null {
  const text = activityString(value);
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, "[redacted-vin]")
    .replace(/\b(?:access[_-]?)?(bearer|token|password|pin|authorization)\b["']?\s*[:=]\s*["']?[^\s,;}"]+/gi, "$1=[redacted]")
    .replace(/\b-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g, "[redacted-location]")
    .slice(0, 180);
}

function activityNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : null;
}

function activityDays(value: unknown): string[] {
  const allowed = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  return Array.isArray(value)
    ? value.filter((day): day is string => typeof day === "string" && allowed.has(day)).slice(0, 7)
    : [];
}

function commandActivityRequest(
  action: unknown,
  rawMinutes: unknown,
  rawTemp: unknown,
  rawOptions: unknown,
  rawTimers: unknown,
): Record<string, unknown> {
  const command = activityString(action, "invalid_command").slice(0, 64) || "invalid_command";
  if (command === "climate") {
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter((option): option is string => typeof option === "string" && CLIMATE_OPTION_KEYS.has(option)).slice(0, 8)
      : [];
    return {
      duration_min: activityNumber(rawMinutes, 1, MAX_HVAC_MINUTES) ?? DEFAULT_HVAC_MINUTES,
      target_c: activityNumber(rawTemp, MIN_HVAC_TEMP_C, MAX_HVAC_TEMP_C) ?? DEFAULT_HVAC_TEMP_C,
      options,
    };
  }
  if (command === "charging_schedule" || command === "climate_schedule") {
    const timerLimit = command === "climate_schedule" ? CLIMATE_MAX_TIMERS : CHARGING_MAX_TIMERS;
    const timers = Array.isArray(rawTimers) ? rawTimers.slice(0, timerLimit).flatMap((timer) => {
      if (!isRecord(timer)) return [];
      const summary: Record<string, unknown> = {
        enabled: timer.enabled === true,
        days: activityDays(timer.days),
      };
      if (command === "charging_schedule") {
        summary.start_min = activityNumber(timer.startMinutes, 0, 1439);
        summary.end_min = activityNumber(timer.endMinutes, 0, 1439);
      } else {
        summary.ready_by_min = activityNumber(timer.departureMinutes, 0, 1439);
      }
      return [summary];
    }) : [];
    return { timers };
  }
  return {};
}

function createAuditContext(url: URL): AuditContext {
  let kind: ActivityKind = "validation";
  let action = "validation";
  let request: Record<string, unknown> = {};
  switch (url.pathname) {
    case "/status":
      kind = "status";
      action = "status_refresh";
      break;
    case "/state":
      action = "vehicle_state";
      break;
    case "/settings":
      action = "settings_read";
      request = { operation: activityString(url.searchParams.get("operation") ?? "remoteAC", "remoteAC").slice(0, 64) };
      break;
    case "/config":
      action = "capability_validation";
      break;
    case "/mqtt-discover":
      action = "mqtt_validation";
      break;
    default:
      kind = "command";
      action = "command";
  }
  return { id: activityId(), at: activityNow(), startedAt: Date.now(), kind, route: url.pathname, action, request };
}

function activityResult(body: unknown, status: number, durationMs: number): ActivityRecord["result"] {
  const data = isRecord(body) ? body : {};
  const event = isRecord(data.event) ? data.event : {};
  const success = data.success === true;
  const outcome = typeof data.outcome === "string"
    ? activityString(data.outcome)
    : typeof event.outcome === "string" ? activityString(event.outcome) : null;
  const message = redactedActivityText(data.error ?? data.message);
  return {
    success,
    http_status: status,
    outcome: outcome || null,
    message,
    remote_status: activityString(event.status) || null,
    reason_code: activityString(event.reasonCode) || null,
    error_label: redactedActivityText(event.errorLabel),
    polls: activityNumber(event.polls, 0, 1_000),
    duration_ms: Math.max(0, Math.round(durationMs)),
  };
}

function recordActivity(context: AuditContext, body: unknown, status: number): ActivityRecord {
  return {
    id: context.id,
    at: context.at,
    kind: context.kind,
    route: context.route,
    action: context.action,
    request: context.request,
    result: activityResult(body, status, Date.now() - context.startedAt),
  };
}

/**
 * Snow Guard replies contain its configuration, including a city-level weather
 * location. Convert them to the small, safe receipt used by the activity log
 * before anything crosses the Durable Object boundary.
 */
function snowGuardActivityBody(body: unknown, fallbackSuccess: boolean): Record<string, unknown> {
  const payload = isRecord(body) ? body : {};
  const runtime = isRecord(payload.runtime) ? payload.runtime : {};
  const decision = isRecord(runtime.lastDecision) ? runtime.lastDecision : {};
  return {
    success: typeof payload.success === "boolean" ? payload.success : fallbackSuccess,
    outcome: activityString(decision.code) || null,
    message: redactedActivityText(decision.summary),
  };
}

/** Only scheduled checks that reached the vehicle (or tried to) join the car activity trail. */
function snowGuardReachedVehicle(body: unknown): boolean {
  const payload = isRecord(body) ? body : {};
  const runtime = isRecord(payload.runtime) ? payload.runtime : {};
  const decision = isRecord(runtime.lastDecision) ? runtime.lastDecision : {};
  return new Set([
    "vehicle_moving", "vehicle_open", "not_plugged", "battery_unknown", "battery_low",
    "climate_started", "climate_rejected", "climate_pending", "climate_error",
  ]).has(activityString(decision.code));
}

async function auditSnowGuardTick(env: Env): Promise<void> {
  const audit: AuditContext = {
    id: activityId(), at: activityNow(), startedAt: Date.now(), kind: "validation",
    route: "/snow-guard/tick", action: "snow_guard_check", request: { automated: true },
  };
  const id = env.SNOW_GUARD.idFromName(SNOW_GUARD_DEFAULT_NAME);
  try {
    const response = await env.SNOW_GUARD.get(id).fetch("https://snow-guard/snow-guard/tick", { method: "POST" });
    const body = await response.clone().json().catch(() => null);
    if (!snowGuardReachedVehicle(body)) return;
    await appendActivity(env, recordActivity(audit, snowGuardActivityBody(body, response.ok), response.status));
  } catch (err) {
    // A failed automation attempt belongs in the trail, but it must never make
    // the scheduled event fail or expose a lower-level error string.
    try {
      await appendActivity(env, recordActivity(audit, { success: false, error: "Snow Guard check failed" }, 502));
    } catch (logErr) {
      console.warn("Activity log write failed", (logErr as Error).message);
    }
    console.warn("Snow Guard check failed", (err as Error).message);
  }
}

function pruneActivity(records: ActivityRecord[]): ActivityRecord[] {
  const cutoff = Date.now() - ACTIVITY_RETENTION_MS;
  return records
    .filter((record) => record && typeof record.at === "string" && Date.parse(record.at) >= cutoff)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, ACTIVITY_MAX_RECORDS);
}

/** A single, serialised store prevents concurrent dashboard requests losing a log entry. */
export class ActionLog {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/append" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!isRecord(body) || !isRecord(body.record)) return new Response("Bad activity record", { status: 400 });
      const record = body.record as unknown as ActivityRecord;
      if (!record.id || !record.at || !record.action || !record.result) return new Response("Bad activity record", { status: 400 });
      await this.state.storage.transaction(async (txn) => {
        const current = (await txn.get<ActivityRecord[]>(ACTIVITY_STORAGE_KEY)) ?? [];
        await txn.put(ACTIVITY_STORAGE_KEY, pruneActivity([record, ...current]));
      });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const current = (await this.state.storage.get<ActivityRecord[]>(ACTIVITY_STORAGE_KEY)) ?? [];
      const records = pruneActivity(current);
      if (records.length !== current.length) await this.state.storage.put(ACTIVITY_STORAGE_KEY, records);
      const requested = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(ACTIVITY_MAX_RECORDS, requested)) : 100;
      return new Response(JSON.stringify({ records: records.slice(0, limit), total: records.length }), {
        headers: { "Content-Type": "application/json; charset=UTF-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

async function appendActivity(env: Env, record: ActivityRecord): Promise<void> {
  const stub = env.ACTION_LOG.get(env.ACTION_LOG.idFromName("primary"));
  const response = await stub.fetch("https://activity.internal/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record }),
  });
  if (!response.ok) throw new Error(`Activity log write failed: HTTP ${response.status}`);
}

async function readActivity(env: Env, limit: number): Promise<{ records: ActivityRecord[]; total: number }> {
  const stub = env.ACTION_LOG.get(env.ACTION_LOG.idFromName("primary"));
  const response = await stub.fetch(`https://activity.internal/list?limit=${encodeURIComponent(String(limit))}`);
  if (!response.ok) throw new ApiError(502, "Activity log read failed");
  const payload = await response.json() as { records?: ActivityRecord[]; total?: number };
  return {
    records: Array.isArray(payload.records) ? payload.records : [],
    total: typeof payload.total === "number" ? payload.total : 0,
  };
}

/** Uint8Array -> base64 string. */
function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 string -> Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Constant-time string comparison via ephemeral-key HMAC.
 *
 * Both inputs are HMAC'd under a freshly generated random key, producing
 * fixed-length (32-byte) digests that are then compared byte-by-byte with an
 * OR-accumulator. This leaks neither content nor length through timing, and
 * avoids the short-circuit behaviour of `===`.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
  const ha = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/** Error carrying an HTTP status to surface to the caller. */
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sharedHeaders(authorization: string): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "User-Agent": "Mobile",
    "X-Client-Id": "mobile",
    ampApiKey: AMP_API_KEY,
    Authorization: authorization,
  };
}

// ---------------------------------------------------------------------------
// Aeris ATSP flow
// ---------------------------------------------------------------------------

export interface LoginResult {
  accessToken: string;
  accountDN: string;
  clientId: string;
}

/**
 * Log in with grant_type=password. A fresh login per command invocation is fine
 * for v1 — no token caching / KV. Confirmed against the working read-only client.
 *
 * Also returns accountDN + clientId — both needed for the MQTT client-registration
 * handshake (registration topics are keyed by accountDN; the MQTT CONNECT username
 * must be the same clientId used for this login, per C1847g.java:1148-1149).
 */
async function login(env: Env): Promise<LoginResult> {
  const clientId = env.MMC_CLIENT_ID;
  const basic = "Basic " + bytesToB64(new TextEncoder().encode(`${clientId}:${CLIENT_TRUSTED_SECRET}`));

  const res = await fetch(BASE_URL + EP_TOKEN, {
    method: "POST",
    headers: sharedHeaders(basic),
    body: JSON.stringify({
      grant_type: "password",
      username: env.MMC_USERNAME,
      password: env.MMC_PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new ApiError(502, `Login failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  const data = (await res.json()) as { access_token?: string; accountDN?: string };
  if (!data.access_token) throw new ApiError(502, "Login response missing access_token");
  if (!data.accountDN) throw new ApiError(502, "Login response missing accountDN");
  return { accessToken: data.access_token, accountDN: data.accountDN, clientId };
}

/** Look up the account's first VIN. Confirmed against the working read-only client. */
async function getVin(env: Env, accessToken: string): Promise<string> {
  const url = BASE_URL + EP_USER_INFO + encodeURIComponent(env.MMC_USERNAME);
  const res = await fetch(url, { method: "GET", headers: sharedHeaders(`Bearer ${accessToken}`) });

  if (!res.ok) {
    throw new ApiError(502, `VIN lookup failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  const data = (await res.json()) as { vehicles?: Array<{ vin?: string }> };
  const vin = data.vehicles?.[0]?.vin;
  if (!vin) throw new ApiError(502, "No VIN found on account");
  return vin;
}

/**
 * Compute the PIN hash.
 *
 * hmacKey = clientNonceBytes || 0x3A (':') || serverNonceBytes
 * digest  = HMAC-SHA256(hmacKey, utf8(PIN))            // 32 bytes
 * folded[i] = digest[i] XOR digest[i + 16]  for i in 0..15
 * pinHash = base64(folded)
 *
 * [PARTIALLY VERIFIED] The XOR-fold-of-HMAC algorithm is the same one validated
 * working in the EU sibling client. It has NOT been exercised against this NA
 * (us-m.aerpf.com) endpoint with real nonces.
 */
async function computePinHash(pin: string, clientNonceBytes: Uint8Array, serverNonceBytes: Uint8Array): Promise<string> {
  const colon = new Uint8Array([0x3a]); // ':'
  const hmacKey = new Uint8Array(clientNonceBytes.length + 1 + serverNonceBytes.length);
  hmacKey.set(clientNonceBytes, 0);
  hmacKey.set(colon, clientNonceBytes.length);
  hmacKey.set(serverNonceBytes, clientNonceBytes.length + 1);

  const key = await crypto.subtle.importKey("raw", hmacKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pin)));

  const folded = new Uint8Array(16);
  for (let i = 0; i < 16; i++) folded[i] = digest[i] ^ digest[i + 16];
  return bytesToB64(folded);
}

/**
 * Full PIN-verification handshake, returning the server-issued pinToken.
 *
 * CONFIRMED against decompiled call classes (p283p.C8761b = GetServerNonce,
 * p283p.C8760a = GetPinToken):
 *   Step 1  POST /oauth/v3/remoteOperation       body {vin, clientNonce}
 *           -> {vin, serverNonce}
 *   Step 2  POST /oauth/v3/remoteOperation/pin    body {vin, hash: pinHash}
 *           -> {vin, pinToken}
 * Neither request has an internalVin field — that was our own earlier mistake.
 * The value used downstream in PerformRO is the server's returned pinToken,
 * NOT the locally-computed hash.
 */
async function verifyPin(env: Env, accessToken: string, vin: string): Promise<string> {
  // Matches the proven-working EU reference client (secrets.token_bytes(32)).
  const clientNonceBytes = randomBytes(32);
  const clientNonceB64 = bytesToB64(clientNonceBytes);

  // Step 1: request a server nonce.
  const nonceRes = await fetch(BASE_URL + EP_SERVER_NONCE, {
    method: "POST",
    headers: sharedHeaders(`Bearer ${accessToken}`),
    body: JSON.stringify({ vin, clientNonce: clientNonceB64 }),
  });
  if (!nonceRes.ok) {
    throw new ApiError(502, `Server-nonce request failed: HTTP ${nonceRes.status} ${await safeText(nonceRes)}`);
  }
  const nonceData = (await nonceRes.json()) as { serverNonce?: string };
  if (!nonceData.serverNonce) throw new ApiError(502, "Server-nonce response missing serverNonce");
  const serverNonceBytes = b64ToBytes(nonceData.serverNonce);

  // Step 2: derive the hash and submit it, in exchange for a pinToken.
  const pinHash = await computePinHash(env.MMC_PIN, clientNonceBytes, serverNonceBytes);

  const pinRes = await fetch(BASE_URL + EP_PIN_TOKEN, {
    method: "POST",
    headers: sharedHeaders(`Bearer ${accessToken}`),
    body: JSON.stringify({ vin, hash: pinHash }),
  });
  if (!pinRes.ok) {
    throw new ApiError(502, `PIN verification rejected: HTTP ${pinRes.status} ${await safeText(pinRes)}`);
  }
  const pinData = (await pinRes.json()) as { pinToken?: string };
  if (!pinData.pinToken) throw new ApiError(502, "PIN-token response missing pinToken");
  return pinData.pinToken;
}

/**
 * Perform the mapped remote operation.
 *
 * CONFIRMED against decompiled call class p331s.C9336d (base "PerformRO"
 * class used by simple commands): body is {vin, operation, forced, pinToken},
 * no internalVin. Operation name strings (doorLock, doorUnlock, horn, lights,
 * locate) confirmed from RemoteOperationConstants.OperationName enum.
 */
async function performOperation(
  env: Env,
  accessToken: string,
  vin: string,
  pinToken: string | null,
  operation: string,
  extra?: Record<string, unknown>,
): Promise<unknown> {
  // Per-operation dt body, unless the caller built one itself (remoteAC).
  const data = extra ?? (OPERATION_DATA[operation] ? { dt: OPERATION_DATA[operation] } : undefined);

  // FieldDelegateUA.getValue() (decompiled): "1" for operation "vehicleStatus",
  // "android" for every other operation — and PerformRO always includes this
  // field when the delegate returns non-null, which it always does. This
  // Worker never sends vehicleStatus, so "android" is the correct constant
  // here. Confirmed missing entirely from every request this Worker sent
  // before this fix — untested whether the server actually enforces it, but
  // the validated Python reference client (mitsubishi_na/api.py) always sends
  // it and that is what's been confirmed working end-to-end live.
  const userAgent = operation === "vehicleStatus" ? "1" : "android";

  const res = await fetch(BASE_URL + EP_PERFORM_RO, {
    method: "POST",
    headers: sharedHeaders(`Bearer ${accessToken}`),
    // forced:"true" matches the live app (s/d.java's PerformRO forced flag)
    // and is what we verified working end-to-end (lights, remoteAC) on
    // 2026-07-28. pinToken is spread in only when the operation actually
    // takes one, so the field is absent rather than null for the ops that
    // do not.
    body: JSON.stringify({
      vin,
      operation,
      forced: "true",
      ...(pinToken ? { pinToken } : {}),
      ...data,
      userAgent,
    }),
  });
  if (!res.ok) {
    throw new ApiError(502, `Remote operation failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  // Real response shape: {eventId, vin, operationType, status} — not our
  // Worker's own {success,message} shape, which is applied by the caller.
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Poll a submitted operation to a terminal outcome.
 *
 * GET /avi/v1/remoteOperation/vehicles/{vin}/events/{eventId} — path confirmed
 * from res/raw/environment (getrostatus.path). Response fields confirmed from
 * the GetROStatus call class (p331s.C9333a): eventId, vin, status, reasonCode,
 * operationType, errorLabel.
 *
 * Terminal-state classification, verified against the real app's own
 * VehicleOperationHttp.x() (decompiled from My+Mitsubishi+Connect v2.88.10):
 *   successful | success | inqueue  -> succeeded (all three unconditional —
 *                                      the app's x() finalizes on any of them
 *                                      with no reasonCode or operation check)
 *   failed | failure                -> failed
 *
 * MessageDelivered is NOT unconditionally terminal in the real app either,
 * despite first appearances. x() only treats it as success when y() or z12
 * holds, and both are narrow: y() is true only for a "customize" preset-profile
 * DELETE action, and z12 requires (operation == chargingControl2 ||
 * operation == climateControl) AND reasonCode == "2002" exactly. The two
 * scheduler writes sent by this Worker carry their operation name into
 * pollEvent() so that narrow acknowledgement is recognised; every other
 * operation keeps treating MessageDelivered as "still in flight". This was
 * confirmed live 2026-07-28, where a remoteAC sat at MessageDelivered
 * (reasonCode 915) for 55s and then resolved to
 * {"status":"Failed","errorLabel":"TimeframePassed"}. Classifying it as success
 * here would have made the dashboard claim a command had landed when the car
 * never applied it, which is worse than reporting a timeout.
 *
 * Anything else is still in flight, so keep polling until the deadline.
 *
 * The 45s deadline used before was under-provisioned: that same run needed the
 * full 60s to reach a terminal state, so a real outcome was being discarded as
 * a timeout. 75s covers it with margin.
 */
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 75000;

/**
 * Shorter deadline for a precondition operation whose outcome only gates the
 * next request. Every engineOff observed live went terminal on the first 5s
 * poll, so this never actually waits long; it exists to bound the pathological
 * case rather than to add latency to the common one.
 */
const PRECONDITION_POLL_TIMEOUT_MS = 20000;

interface EventOutcome {
  outcome: "succeeded" | "failed" | "timeout";
  status: string | null;
  reasonCode: string | null;
  errorLabel: string | null;
  polls: number;
}

async function pollEvent(
  accessToken: string,
  vin: string,
  eventId: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
  operation?: string,
): Promise<EventOutcome> {
  const url = BASE_URL + EP_RO_STATUS.replace("{vin}", encodeURIComponent(vin)).replace("{eventId}", encodeURIComponent(eventId));
  const headers = sharedHeaders(`Bearer ${accessToken}`);
  const deadline = Date.now() + timeoutMs;

  let last: EventOutcome = { outcome: "timeout", status: null, reasonCode: null, errorLabel: null, polls: 0 };

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    last.polls++;

    const res = await fetch(url, { headers });
    if (!res.ok) continue;

    const data = (await res.json().catch(() => null)) as {
      status?: string;
      reasonCode?: string;
      errorLabel?: string;
    } | null;
    if (!data?.status) continue;

    last.status = data.status;
    last.reasonCode = data.reasonCode ?? null;
    last.errorLabel = data.errorLabel ?? null;

    const s = data.status.toLowerCase();
    if (s === "successful" || s === "success" || s === "inqueue") {
      return { ...last, outcome: "succeeded" };
    }
    // The Mitsubishi app treats MessageDelivered + 2002 as a terminal
    // acknowledgement for scheduler writes only. It keeps waiting for the
    // normal remote commands, where MessageDelivered merely means the vehicle
    // has not finished applying the request yet.
    if (
      s === "messagedelivered" &&
      (operation === "chargingControl2" || operation === "climateControl") &&
      last.reasonCode === "2002"
    ) {
      return { ...last, outcome: "succeeded" };
    }
    if (s === "failed" || s === "failure") {
      return { ...last, outcome: "failed" };
    }
  }
  return last;
}

/**
 * Wake the TCU, then give it a moment to attach to the network.
 *
 * Best-effort: a failed/duplicate wakeup is NOT fatal (the API answers
 * responseCode "inProgress" / "SMS already initiated" when one is already in
 * flight, which is a normal success path). Matches the validated Python flow
 * (scripts/test_na_remote_command.py WAKE_WAIT_S = 25): a shorter 12s settle
 * was tried here and the command still submitted, but with less margin than
 * the confirmed-working 25s — use the same wait as the proven flow rather than
 * a shortened guess.
 */
const WAKE_SETTLE_MS = 25000;

async function wakeUpVehicle(accessToken: string, vin: string): Promise<void> {
  const url = BASE_URL + EP_VEHICLE_WAKEUP.replace("{vin}", encodeURIComponent(vin));
  try {
    await fetch(url, {
      method: "POST",
      headers: sharedHeaders(`Bearer ${accessToken}`),
      body: JSON.stringify({
        operation: "wakeUp",
        operationType: 1,
        vehicleId: vin,
        timeStamp: String(Date.now()),
        data: {},
      }),
    });
  } catch {
    // Non-fatal: fall through and still attempt the command.
  }
  await new Promise((r) => setTimeout(r, WAKE_SETTLE_MS));
}

/** Full command flow: login -> VIN -> wake -> PIN token -> submit -> poll to outcome. */
async function runCommand(
  env: Env,
  operation: string,
  extra?: Record<string, unknown>,
): Promise<{ eventId: string | null; submitted: unknown; event: EventOutcome | null }> {
  const { accessToken } = await login(env);
  const vin = await getVin(env, accessToken);
  await wakeUpVehicle(accessToken, vin);
  const pinToken = OPERATIONS_REQUIRING_PIN.has(operation)
    ? await verifyPin(env, accessToken, vin)
    : null;
  const submitted = await performOperation(env, accessToken, vin, pinToken, operation, extra);

  const eventId = (submitted as { eventId?: unknown } | null)?.eventId;
  if (typeof eventId !== "string" || !eventId) {
    return { eventId: null, submitted, event: null };
  }
  return { eventId, submitted, event: await pollEvent(accessToken, vin, eventId, POLL_TIMEOUT_MS, operation) };
}

/**
 * Climate start, optionally replacing the running session first.
 *
 * The vehicle allows exactly ONE active remoteAC session. A second remoteAC
 * submitted while the first is still inside its operationTime window is
 * accepted at the API ({"status":"Started"}) and then rejected by the car with
 * {"status":"Failed","reasonCode":"1002","errorLabel":"RO_FAILURE_ALREADY_STARTED"};
 * forced:"true" does NOT override it. Confirmed live 2026-07-28: six climate
 * variants run back-to-back failed on exactly this, and the same six all
 * succeeded once an engineOff was interleaved between them.
 *
 * runCommand() alone therefore only ever worked for the first press — every
 * press for the next 10 minutes was rejected. Interactive starts therefore
 * end any running session before starting the new one. An engineOff with
 * nothing to stop answers RO_FAILURE_ALREADY_STOPPED, which is the expected
 * no-op here and must not fail the start; its outcome is ignored on purpose.
 *
 * Callers that automate from a weather signal pass replaceExisting:false.
 * In that mode a pre-existing session is left alone and the vehicle can reject
 * the new request as already started; that is preferable to stopping a session
 * a person may have started from Mitsubishi's app.
 *
 * Login, VIN lookup and wakeup are shared across both operations rather than
 * paying a second 25s wake settle for the stop. Neither remoteAC nor engineOff
 * takes a pinToken (see OPERATIONS_REQUIRING_PIN).
 */
async function runClimateStart(
  env: Env,
  request: ClimateRequest,
  options: { replaceExisting?: boolean } = {},
): Promise<{ eventId: string | null; submitted: unknown; event: EventOutcome | null }> {
  const { accessToken } = await login(env);
  const vin = await getVin(env, accessToken);
  const extra = buildHvacExtra(request, await getAvailableHvacOptions(accessToken, vin));
  await wakeUpVehicle(accessToken, vin);

  // A person changing climate settings in the dashboard reasonably expects
  // their new selection to replace the current session. An unattended guard
  // must never make that assumption: stopping a session started manually in
  // the Mitsubishi app would be a surprising and potentially unsafe action.
  if (options.replaceExisting !== false) {
    try {
      const stopped = await performOperation(env, accessToken, vin, null, "engineOff");
      const stopEventId = (stopped as { eventId?: unknown } | null)?.eventId;
      if (typeof stopEventId === "string" && stopEventId) {
        await pollEvent(accessToken, vin, stopEventId, PRECONDITION_POLL_TIMEOUT_MS);
      }
    } catch {
      // Best-effort: a teardown that could not even be submitted should not block
      // the start the caller actually asked for.
    }
  }

  const submitted = await performOperation(env, accessToken, vin, null, "remoteAC", extra);
  const eventId = (submitted as { eventId?: unknown } | null)?.eventId;
  if (typeof eventId !== "string" || !eventId) {
    return { eventId: null, submitted, event: null };
  }
  return { eventId, submitted, event: await pollEvent(accessToken, vin, eventId) };
}

/**
 * Start or stop charging RIGHT NOW.
 *
 * This is NOT the same endpoint or builder as the other remote operations.
 * chargingControl / chargingControlStop route through the DGE microservice
 * (C9337e.java dispatches them to C9335c "PerformChargingStartAndStopRO";
 * path from res/raw/environment performchargingstartandstopro.path /
 * getchargingcontroldge.path), not /avi/v3/remoteOperation. That builder never
 * emits "forced" or "pinToken" — this call intentionally skips PIN-verify
 * rather than reusing the remoteAC envelope, since there is no evidence this
 * endpoint accepts (or wants) either field.
 *
 * chargingControlType is the direction (0 = stop, 1 = start) and rides INSIDE
 * "data" alongside eventTimestamp; the "operation" string also changes between
 * the two ("chargingControl" vs "chargingControlStop") — so direction is
 * double-encoded, both in the operation name and in chargingControlType.
 * operationType is a fixed literal 1 for both directions; it does not encode
 * direction despite the name.
 */
const EP_CHARGING_CONTROL_DGE = "/api/v1/services/chargingcontrol/vin/{vin}";

function isoEventTimestamp(): string {
  // The app's format is yyyy-MM-ddTHH:mm:ssZ — no milliseconds.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function performChargingControl(
  accessToken: string,
  vin: string,
  direction: "start" | "stop",
): Promise<unknown> {
  const operation = direction === "start" ? "chargingControl" : "chargingControlStop";
  const chargingControlType = direction === "start" ? 1 : 0;
  const url = BASE_URL + EP_CHARGING_CONTROL_DGE.replace("{vin}", encodeURIComponent(vin));

  const res = await fetch(url, {
    method: "POST",
    headers: sharedHeaders(`Bearer ${accessToken}`),
    // userAgent: same FieldDelegateUA rule as performOperation() — this call
    // never carries operation "vehicleStatus", so always "android". The DGE
    // charging builder (s/c.java, PerformChargingStartAndStopRO) sends this
    // field unconditionally too; it was missing here before this fix.
    body: JSON.stringify({
      vin,
      operation,
      operationType: 1,
      data: { eventTimestamp: isoEventTimestamp(), chargingControlType },
      userAgent: "android",
    }),
  });
  if (!res.ok) {
    throw new ApiError(502, `Charging control failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Full charging start/stop flow.
 *
 * [UNVERIFIED — response shape] The confirmed shape (C9335c.processJson) keys
 * the poll id as "correlationId", not "eventId", and wraps the vehicle fields
 * in "data" (data.vin, data.responseStatus, data.statusTimestamp). This maps
 * correlationId onto the same generic GetROStatus poll used everywhere else,
 * which is untested against an id that originated from this microservice
 * rather than /avi/v3/remoteOperation — it is the documented behaviour, but
 * has not been exercised live.
 */
async function runChargingControl(
  env: Env,
  direction: "start" | "stop",
): Promise<{ eventId: string | null; submitted: unknown; event: EventOutcome | null }> {
  const { accessToken } = await login(env);
  const vin = await getVin(env, accessToken);
  await wakeUpVehicle(accessToken, vin);
  const submitted = await performChargingControl(accessToken, vin, direction);

  const eventId = (submitted as { correlationId?: unknown } | null)?.correlationId;
  if (typeof eventId !== "string" || !eventId) {
    return { eventId: null, submitted, event: null };
  }
  return { eventId, submitted, event: await pollEvent(accessToken, vin, eventId) };
}

/**
 * Recurring weekly charge schedule — operation "chargingControl2"
 * (= RemoteChargingControlScheduler). Unlike chargingControl/chargingControlStop
 * above, this is NOT routed to the DGE microservice: it falls through to the
 * same immediate /avi/v3/remoteOperation "PerformRO" path as remoteAC, with
 * dataKey "data" (Utility.getDataKeyForVehicleOperation's switch map assigns
 * "data" to this operation specifically). It therefore reuses runCommand()
 * (login -> PIN-verify -> submit -> poll) rather than the pin-less
 * runChargingControl() used for immediate start/stop.
 *
 * The app ALWAYS sends exactly three timer slots ("Timer 1/2/3"), even ones
 * the user has not configured — an inactive slot is chargingStatus:0, not an
 * absent array entry. This mirrors that shape rather than a variable-length
 * list, so a write can never accidentally drop an existing timer the caller
 * didn't mean to touch.
 *
 * [UNVERIFIED] Never sent to a live vehicle. In particular chargingAction
 * (0 = fresh save, 1 = edit-existing, per the app's own mapper) is asserted
 * from source but not confirmed against what the server actually requires;
 * this mirrors the app's logic (existing chargingId -> edit, none -> fresh)
 * rather than guessing an alternative.
 */
const CHARGING_MAX_TIMERS = 3;
const CHARGING_DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const CHARGING_DAY_FIELDS: Record<(typeof CHARGING_DAY_ORDER)[number], string> = {
  Mon: "everyMonday", Tue: "everyTuesday", Wed: "everyWednesday", Thu: "everyThursday",
  Fri: "everyFriday", Sat: "everySaturday", Sun: "everySunday",
};

export interface ChargeTimerInput {
  id: string | null; // existing chargingId to edit, or null for a fresh timer
  enabled: boolean;
  startMinutes: number; // minutes since local midnight, 0..1439
  endMinutes: number;
  days: string[]; // subset of CHARGING_DAY_ORDER
}

function randomHexId(): string {
  const bytes = randomBytes(4);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function clampMinutesOfDay(n: number): number {
  return Math.max(0, Math.min(1439, Math.round(n)));
}

function buildChargingScheduleExtra(timers: ChargeTimerInput[]): Record<string, unknown> {
  const chargingDefinition: Record<string, unknown>[] = [];
  for (let i = 0; i < CHARGING_MAX_TIMERS; i++) {
    const t: ChargeTimerInput | undefined = timers[i];
    const dayFlags: Record<string, number> = {};
    for (const day of CHARGING_DAY_ORDER) dayFlags[CHARGING_DAY_FIELDS[day]] = 0;
    if (t) {
      for (const d of t.days) {
        if (Object.prototype.hasOwnProperty.call(CHARGING_DAY_FIELDS, d)) {
          dayFlags[CHARGING_DAY_FIELDS[d as (typeof CHARGING_DAY_ORDER)[number]]] = 1;
        }
      }
    }
    chargingDefinition.push({
      chargingStatus: t?.enabled ? 1 : 0,
      chargingAction: t?.id ? 1 : 0,
      chargingId: t?.id || randomHexId(),
      chargingName: `Timer ${i + 1}`,
      schedule: {
        serviceScheduleType: 1,
        startTimeOfDay: t ? clampMinutesOfDay(t.startMinutes) * 60 : 0,
        endTimeOfDay: t ? clampMinutesOfDay(t.endMinutes) * 60 : 0,
        ...dayFlags,
      },
      hvacSettings: null,
    });
  }
  return { data: { eventTimestamp: isoEventTimestamp(), chargingDefinition } };
}

/**
 * Normalise a chargingControl2 read (or write echo) into the shape the
 * dashboard renders. Read-only, best-effort: an unrecognised shape degrades to
 * an empty timer list rather than throwing, since this backs a GET.
 */
export interface ChargeTimerSummary {
  id: string;
  name: string;
  enabled: boolean;
  startMinutes: number;
  endMinutes: number;
  days: string[];
}

function parseChargingSchedule(raw: JsonValue): ChargeTimerSummary[] {
  const list = findKey(raw, "chargingDefinition");
  if (!Array.isArray(list)) return [];
  const out: ChargeTimerSummary[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const schedule = entry.schedule;
    const sch = schedule !== null && typeof schedule === "object" && !Array.isArray(schedule) ? schedule : {};
    const days = CHARGING_DAY_ORDER.filter((d) => toInt(sch[CHARGING_DAY_FIELDS[d]]) === 1);
    const startSec = toInt(sch.startTimeOfDay, 0) ?? 0;
    const endSec = toInt(sch.endTimeOfDay, 0) ?? 0;
    out.push({
      id: String(scalar(entry.chargingId) ?? ""),
      name: String(scalar(entry.chargingName) ?? ""),
      enabled: toInt(entry.chargingStatus, 0) === 1,
      startMinutes: Math.round(startSec / 60),
      endMinutes: Math.round(endSec / 60),
      days,
    });
  }
  return out;
}

/**
 * Recurring climate pre-conditioning schedule — operation "climateControl"
 * (= RemoteClimateControlScheduler). The APK routes this through the same
 * PerformRO endpoint as chargingControl2, using the top-level `data` key.
 *
 * The scheduler is vehicle-side: it is not a browser alarm and it continues
 * to run after the dashboard and phone close. Mitsubishi models it as exactly
 * three timer slots, each with a ready-by/departure time (endTimeOfDay), not a
 * start/end window. `startTimeOfDay` is deliberately null in the app's own
 * DGE mapper.
 *
 * A schedule also carries frontTemperature and optional hvacSettings. Those
 * values can vary by model and equipment, so this Worker reads the current
 * vehicle definitions first and preserves them byte-for-byte. We only edit
 * enablement, days, and ready-by time. If Mitsubishi does not return all three
 * slots, nothing is sent rather than inventing a temperature or an unsupported
 * HVAC option.
 */
const CLIMATE_MAX_TIMERS = 3;

export interface ClimateTimerInput {
  id: string | null; // echoed for UI state; server-side definitions remain authoritative
  enabled: boolean;
  departureMinutes: number; // ready-by time, minutes since local midnight
  days: string[]; // subset of CHARGING_DAY_ORDER
}

export interface ClimateTimerSummary {
  id: string;
  name: string;
  enabled: boolean;
  departureMinutes: number;
  days: string[];
}

function climateScheduleDefinitions(raw: JsonValue): Array<Record<string, JsonValue>> {
  const list = findKey(raw, "conditioningDefinition");
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Record<string, JsonValue> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

function parseClimateSchedule(raw: JsonValue): ClimateTimerSummary[] {
  const out: ClimateTimerSummary[] = [];
  for (const entry of climateScheduleDefinitions(raw)) {
    const schedule = entry.schedule;
    const sch = schedule !== null && typeof schedule === "object" && !Array.isArray(schedule) ? schedule : {};
    const days = CHARGING_DAY_ORDER.filter((d) => toInt(sch[CHARGING_DAY_FIELDS[d]]) === 1);
    const departureSeconds = toInt(sch.endTimeOfDay, 0) ?? 0;
    out.push({
      id: String(scalar(entry.conditioningId) ?? ""),
      name: String(scalar(entry.conditioningName) ?? ""),
      enabled: toInt(entry.conditioningStatus, 0) === 1,
      departureMinutes: Math.round(departureSeconds / 60),
      days,
    });
  }
  return out;
}

function buildClimateScheduleExtra(
  timers: ClimateTimerInput[],
  existingDefinitions: Array<Record<string, JsonValue>>,
): Record<string, unknown> {
  if (existingDefinitions.length < CLIMATE_MAX_TIMERS) {
    throw new ApiError(
      409,
      "Vehicle did not return all three climate schedule slots. Open Climate Schedule once in My Mitsubishi Connect, then try again; no change was sent.",
    );
  }

  const conditioningDefinition: Record<string, unknown>[] = [];
  for (let i = 0; i < CLIMATE_MAX_TIMERS; i++) {
    const timer = timers[i];
    const current = existingDefinitions[i];
    const currentSchedule = current.schedule;
    const preservedSchedule = currentSchedule !== null && typeof currentSchedule === "object" && !Array.isArray(currentSchedule)
      ? currentSchedule
      : {};
    const dayFlags: Record<string, number> = {};
    for (const day of CHARGING_DAY_ORDER) dayFlags[CHARGING_DAY_FIELDS[day]] = 0;
    for (const day of timer.days) {
      if (Object.prototype.hasOwnProperty.call(CHARGING_DAY_FIELDS, day)) {
        dayFlags[CHARGING_DAY_FIELDS[day as (typeof CHARGING_DAY_ORDER)[number]]] = 1;
      }
    }

    const rawId = scalar(current.conditioningId);
    const id = typeof rawId === "string" && rawId ? rawId : randomHexId();
    const rawName = scalar(current.conditioningName);
    const name = typeof rawName === "string" && rawName ? rawName : `Timer ${i + 1}`;
    const definition: Record<string, unknown> = {
      conditioningStatus: timer.enabled ? 1 : 0,
      conditioningAction: rawId ? 1 : 0,
      conditioningId: id,
      conditioningName: name,
      schedule: {
        ...preservedSchedule,
        serviceScheduleType: 2,
        startTimeOfDay: null,
        endTimeOfDay: clampMinutesOfDay(timer.departureMinutes) * 60,
        ...dayFlags,
      },
    };

    // The app includes these only when the vehicle reports them. Keep their
    // exact existing representation instead of fabricating null/off values.
    if (Object.prototype.hasOwnProperty.call(current, "frontTemperature")) {
      definition.frontTemperature = current.frontTemperature;
    }
    if (Object.prototype.hasOwnProperty.call(current, "hvacSettings")) {
      definition.hvacSettings = current.hvacSettings;
    }
    conditioningDefinition.push(definition);
  }
  return { data: { eventTimestamp: isoEventTimestamp(), conditioningDefinition } };
}

async function fetchClimateScheduleSettings(accessToken: string, vin: string): Promise<JsonValue> {
  const res = await fetch(
    `${BASE_URL}${EP_PARENTAL_ALERT.replace("{vin}", encodeURIComponent(vin))}?operation=climateControl`,
    { headers: sharedHeaders(`Bearer ${accessToken}`) },
  );
  if (!res.ok) {
    throw new ApiError(502, `Climate schedule read failed: HTTP ${res.status} ${await safeText(res)}`);
  }
  const raw = (await res.json().catch(() => null)) as JsonValue;
  if (raw === null) throw new ApiError(502, "Climate schedule read returned no JSON");
  return raw;
}

/**
 * Fetch this vehicle's climate posmap from the model configuration endpoint.
 *
 * Path from res/raw/environment (getmodelconfigurations.path); the response
 * shape is AEModelConfigurationsResponse, whose Config carries
 * `posmap: [{pos:int, cel:string, fah:string}]`. Returns null rather than
 * throwing — a missing posmap must degrade to "no temperature control", never
 * break the climate command itself.
 *
 * [UNVERIFIED] This has not been exercised against a live account. Use the
 * /config route to inspect what actually comes back before trusting `tmp`.
 */
async function fetchPosMap(
  accessToken: string,
  model: string,
  year: string,
  country: string,
): Promise<{ posmap: PosMap | null; raw: unknown }> {
  const url =
    BASE_URL +
    EP_MODEL_CONFIG.replace("{model}", encodeURIComponent(model)) +
    `?country=${encodeURIComponent(country)}&year=${encodeURIComponent(year)}`;

  const res = await fetch(url, { headers: sharedHeaders(`Bearer ${accessToken}`) });
  if (!res.ok) return { posmap: null, raw: `HTTP ${res.status} ${await safeText(res)}` };

  const body = (await res.json().catch(() => null)) as JsonValue;
  if (body === null) return { posmap: null, raw: null };

  const entries = findKey(body, "posmap");
  if (!Array.isArray(entries) || entries.length === 0) return { posmap: null, raw: body };

  const celToPos: Record<string, number> = {};
  let minC = Infinity;
  let maxC = -Infinity;
  let loPos: number | null = null;
  let hiPos: number | null = null;

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pos = toInt(entry.pos);
    if (pos === null) continue;
    const celRaw = String(scalar(entry.cel) ?? "").trim();
    // The table's first and last rungs are the literal endpoints "LO" and "HI"
    // rather than degrees, so they have to be captured separately instead of
    // being dropped as unparseable.
    if (/^lo$/i.test(celRaw)) { loPos = pos; continue; }
    if (/^hi$/i.test(celRaw)) { hiPos = pos; continue; }
    const cel = parseFloat(celRaw);
    if (!Number.isFinite(cel)) continue;
    celToPos[cel.toFixed(1)] = pos;
    if (cel < minC) minC = cel;
    if (cel > maxC) maxC = cel;
  }
  if (!Number.isFinite(minC) || !Number.isFinite(maxC)) return { posmap: null, raw: body };

  // Derive the grid from the table rather than assuming 0.5.
  const sorted = Object.keys(celToPos).map(parseFloat).sort((a, b) => a - b);
  let step = HVAC_TEMP_STEP;
  if (sorted.length > 1) {
    const gap = Math.round((sorted[1] - sorted[0]) * 100) / 100;
    if (gap > 0) step = gap;
  }

  return { posmap: { celToPos, minC, maxC, loPos, hiPos, step }, raw: body };
}

/**
 * Remote services this VIN's model actually supports, from the same model
 * configuration response (each entry is {serviceId, serviceName, displayName}).
 * Useful for hiding controls the car cannot honour.
 */
function extractServices(raw: unknown): string[] {
  const list = findKey(raw as JsonValue, "services");
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const name = scalar(entry.serviceName);
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

/**
 * model / year / country for the posmap lookup.
 *
 * Consults BOTH the account's vehicle-list record and the per-VIN details
 * record, because the model name is not reliably present on either alone —
 * this mirrors build_vehicle() in scripts/cron_log_status.py, which is the
 * version known to resolve the model correctly. Key order matters: modelName
 * is checked before model.
 */
async function fetchVehicleIdentity(
  accessToken: string,
  username: string,
  vin: string,
): Promise<{ model: string; year: string; country: string; candidates: Record<string, unknown> }> {
  const sources: JsonValue[] = [];

  const listRes = await fetch(BASE_URL + EP_USER_INFO + encodeURIComponent(username), {
    headers: sharedHeaders(`Bearer ${accessToken}`),
  });
  if (listRes.ok) {
    const info = (await listRes.json().catch(() => null)) as { vehicles?: JsonValue[] } | null;
    const record = info?.vehicles?.find(
      (v) => v !== null && typeof v === "object" && !Array.isArray(v) && scalar(v.vin) === vin,
    );
    if (record) sources.push(record);
  }

  const detailsRes = await fetch(
    BASE_URL + EP_VEHICLE_DETAILS.replace("{vin}", encodeURIComponent(vin)) +
      "?excludes=tuProfile,salesCodes,saleRecord&includes=category",
    { headers: sharedHeaders(`Bearer ${accessToken}`) },
  );
  if (detailsRes.ok) {
    const details = (await detailsRes.json().catch(() => null)) as JsonValue;
    if (details !== null) sources.push(details);
  }
  if (sources.length === 0) throw new ApiError(502, "Could not read vehicle identity");

  const pick = (keys: string[], fallback = ""): string => {
    for (const src of sources) {
      const v = scalar(firstPresent(src, keys));
      if (v !== null && v !== undefined && v !== "") return String(v);
    }
    return fallback;
  };

  // Surfaced on failure so an unknown response shape can be diagnosed without
  // dumping the whole (PII-bearing) vehicle record.
  const candidates: Record<string, unknown> = {};
  for (const key of ["modelName", "model", "modelDescription", "carlineName", "modelCode",
                     "modelYear", "year", "country", "countryCode", "region"]) {
    const v = scalar(firstPresent(sources[0], [key]));
    const v2 = sources[1] ? scalar(firstPresent(sources[1], [key])) : null;
    if (v !== null || v2 !== null) candidates[key] = v ?? v2;
  }

  return {
    model: pick(["modelName", "model", "modelDescription", "carlineName", "modelCode"]),
    year: pick(["modelYear", "year", "vehicleYear"]),
    country: pick(["country", "countryCode"], "CA"),
    candidates,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

// ---------------------------------------------------------------------------
// Live status (ported from scripts/cron_log_status.py — same field names,
// same defensive-parsing approach, so the frontend renders both identically)
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function findKey(obj: JsonValue, target: string): JsonValue | undefined {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    if (target in obj) return obj[target];
    for (const v of Object.values(obj)) {
      const found = findKey(v, target);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKey(item, target);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function firstPresent(obj: JsonValue, keys: string[]): JsonValue | undefined {
  for (const key of keys) {
    const v = findKey(obj, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Unwrap the common {"value": X} response wrapper. */
function scalar(value: JsonValue | undefined): JsonValue | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const k of ["value", "val", "data"]) {
      if (k in value) return value[k];
    }
  }
  return value;
}

/**
 * Cruising ranges appear in two valid shapes in Mitsubishi responses:
 * a flat list of { range }, or a diagnostic wrapper containing
 * { cruisingRange: [{ range_*: { value } }] }. Keep this deliberately
 * structural rather than model-specific so the dashboard doesn't lose range
 * on the health-report shape used by the companion app.
 */
function extractRange(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item) && "range" in item) {
        return item.range;
      }
    }
  }
  // The native health payload names these wrappers range_1 / range_2 rather
  // than simply range. Look for the named wrapper, then return its scalar
  // value instead of handing a whole diagnostic object to toInt().
  const findNamedRange = (candidate: JsonValue | undefined): JsonValue | undefined => {
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      for (const [key, nested] of Object.entries(candidate)) {
        if (/^range(?:[_-]?\d+)?$/i.test(key)) return nested;
        const found = findNamedRange(nested);
        if (found !== undefined) return found;
      }
    } else if (Array.isArray(candidate)) {
      for (const nested of candidate) {
        const found = findNamedRange(nested);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const nested = findNamedRange(value);
  if (nested !== undefined) return nested;
  return value;
}

function toFloat(value: JsonValue | undefined): number | null {
  const v = scalar(value);
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toInt(value: JsonValue | undefined, def: number | null = null): number | null {
  const f = toFloat(value);
  return f !== null ? Math.round(f) : def;
}

function toBool(value: JsonValue | undefined): boolean | null {
  const v = scalar(value);
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on", "open", "opened", "plugged", "pluggedin", "connected", "charging"].includes(s)) return true;
    if (["false", "0", "no", "off", "closed", "unplugged", "disconnected", "not_charging", "not charging"].includes(s)) return false;
    const numeric = Number(s);
    if (s !== "" && Number.isFinite(numeric)) return numeric !== 0;
  }
  return null;
}

function chargingStatus(value: JsonValue | undefined): string | null {
  const v = scalar(value);
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v ? "charging" : "not_charging";
  const s = String(v ?? "").toLowerCase();
  if (["charging", "in_progress", "inprogress", "active"].some((t) => s.includes(t)) && !s.includes("not")) {
    return "charging";
  }
  if (["not", "idle", "off", "complete", "stopped"].some((t) => s.includes(t))) return "not_charging";
  return null;
}

/**
 * String-boolean used across the vehiclestate response: the literal string
 * "0" means false, anything else present means true. This is NOT the same
 * rule as toBool() above (an allowlist of truthy words) — vehiclestate's
 * convention is specifically "not zero", confirmed for svla / diagnostic /
 * theftAlarm / factoryReset flags.
 *
 * [UNVERIFIED] Read from source (GET /avi/v1/vehicles/{vin}/vehiclestate,
 * confirmed path from res/raw/environment getvehiclemodestatus.path /
 * getvehiclestate.path) but not exercised against a live response — the exact
 * field names below may not match what this account's vehicle returns.
 */
function stateFlag(value: JsonValue | undefined): boolean | null {
  const v = scalar(value);
  if (v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return String(v).trim() !== "0";
}

export interface VehicleStateSummary {
  svla: boolean | null;
  diagnosticMode: boolean | null;
  privacyModeEnabled: boolean | null;
  theftAlarm: boolean | null;
  factoryReset: boolean | null;
  ignitionOn: boolean | null;
}

/**
 * Best-effort read of the safe (non-emergency) flags off vehiclestate.
 * Deliberately returns null per-field rather than throwing when a field is
 * absent — an unrecognised shape should degrade to "unknown", not break the
 * whole read-only summary.
 *
 * privacyMode is INVERTED versus every other flag here: "0" means privacy is
 * ENABLED (locate restricted), "1" means disabled. stateFlag()'s normal
 * "nonzero = true" rule is flipped for this one field only.
 */
function parseVehicleState(raw: JsonValue): VehicleStateSummary {
  const privacyRaw = firstPresent(raw, ["privacy", "privacyMode"]);
  const privacyNonzero = stateFlag(privacyRaw);
  return {
    svla: stateFlag(firstPresent(raw, ["svla"])),
    diagnosticMode: stateFlag(firstPresent(raw, ["diagnostic", "diagnosticMode"])),
    privacyModeEnabled: privacyNonzero === null ? null : !privacyNonzero,
    theftAlarm: stateFlag(firstPresent(raw, ["theftAlarm", "theftalarm"])),
    factoryReset: stateFlag(firstPresent(raw, ["factoryReset"])),
    ignitionOn: stateFlag(firstPresent(raw, ["ignitionState", "ignition"])),
  };
}

const DOOR_ALIASES: Record<string, string> = {
  frontleft: "front_left", doorfrontleft: "front_left", fl: "front_left", driverfront: "front_left", leftfront: "front_left",
  frontright: "front_right", doorfrontright: "front_right", fr: "front_right", passengerfront: "front_right", rightfront: "front_right",
  rearleft: "rear_left", doorrearleft: "rear_left", rl: "rear_left", leftrear: "rear_left", driverrear: "rear_left",
  rearright: "rear_right", doorrearright: "rear_right", rr: "rear_right", rightrear: "rear_right", passengerrear: "rear_right",
  hood: "hood", bonnet: "hood", frunk: "hood",
  doorhood: "hood", trunk: "trunk", doortrunk: "trunk", tailgate: "trunk", boot: "trunk", liftgate: "trunk", hatch: "trunk",
};

function norm(text: JsonValue | undefined): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nestedEntryText(value: JsonValue | undefined): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["displayMessage", "name", "id", "value"]) {
      const nested = value[key];
      if (typeof nested === "string" || typeof nested === "number") return String(nested);
    }
  }
  return "";
}

function entryName(entry: Record<string, JsonValue>): string {
  for (const k of ["location", "position", "doorLocation", "name", "door", "type", "id", "lightLocation", "light"]) {
    const text = nestedEntryText(entry[k]);
    if (text) return text;
  }
  return "";
}

function entryState(entry: Record<string, JsonValue>): JsonValue | undefined {
  for (const k of ["status", "state", "doorStatus", "lightStatus", "open", "on", "value"]) {
    if (!(k in entry)) continue;
    const value = entry[k];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if ("value" in value) return value.value;
      if ("displayMessage" in value) return value.displayMessage;
    }
    return value;
  }
  return undefined;
}

function openClosed(value: JsonValue | undefined): string | null {
  const v = scalar(value);
  if (typeof v === "string" && ["ajar", "open", "opened"].includes(v.trim().toLowerCase())) return "open";
  const open = toBool(v);
  return open === null ? null : open ? "open" : "closed";
}

function parseDoors(state: JsonValue): Record<string, string> {
  const doors: Record<string, string> = {};
  let doorList = firstPresent(state, ["doors"]);
  const doorStatus = findKey(state, "doorStatus");
  if (doorStatus !== undefined && typeof doorStatus === "object" && !Array.isArray(doorStatus)) {
    doorList = findKey(doorStatus, "doors") ?? doorList;
  }
  if (!Array.isArray(doorList)) return doors;
  for (const entry of doorList) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const canonical = DOOR_ALIASES[norm(entryName(entry))];
    const value = openClosed(entryState(entry));
    if (canonical && value !== null) doors[canonical] = value;
  }
  return doors;
}

function parseHeadlights(state: JsonValue): string | null {
  let lights: JsonValue | undefined;
  const lightStatus = findKey(state, "lightStatus");
  if (lightStatus !== undefined && typeof lightStatus === "object" && !Array.isArray(lightStatus)) {
    lights = findKey(lightStatus, "lights");
  }
  if (lights === undefined) lights = findKey(state, "lights");
  if (Array.isArray(lights)) {
    for (const entry of lights) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && norm(entryName(entry)).includes("head")) {
        const on = toBool(entryState(entry));
        if (on !== null) return on ? "on" : "off";
      }
    }
  }
  const flat = firstPresent(state, ["headlightStatus", "headLampStatus", "headlights"]);
  const on = toBool(flat);
  return on === null ? null : on ? "on" : "off";
}

type WarningKey = "brake" | "engine_oil" | "tire_pressure" | "mil" | "abs" | "airbag";

/**
 * Vehicle-health reports contain named diagnostics rather than one universal
 * warning bit. Only a literal `warning: true` is surfaced: an unfamiliar
 * diagnostic stays absent instead of being guessed as a fault.
 */
function parseWarnings(health: JsonValue): Record<WarningKey, boolean> {
  const warnings = {} as Record<WarningKey, boolean>;
  const diagnostic = findKey(health, "diagnostic");
  if (diagnostic === undefined || diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
    return warnings;
  }
  const fields: Array<[WarningKey, string[]]> = [
    ["brake", ["brakeWarn", "breakWarn", "brakeStatus"]],
    ["engine_oil", ["engineOilWarn", "engineOilStatus"]],
    ["tire_pressure", ["tireStatus", "tirePressureStatus"]],
    ["mil", ["milStatus", "milOnStatus"]],
    ["abs", ["absStatus"]],
    ["airbag", ["airbagStatus"]],
  ];
  for (const [key, aliases] of fields) {
    let entry: JsonValue | undefined;
    for (const alias of aliases) {
      if (alias in diagnostic) {
        entry = diagnostic[alias];
        break;
      }
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && "warning" in entry) {
      const warning = toBool(entry.warning);
      if (warning !== null) warnings[key] = warning;
    }
  }
  return warnings;
}

const TIRE_ALIASES: Record<string, string> = {
  tirefrontleft: "front_left", frontleft: "front_left", fl: "front_left",
  tirefrontright: "front_right", frontright: "front_right", fr: "front_right",
  tirerearleft: "rear_left", rearleft: "rear_left", rl: "rear_left",
  tirerearright: "rear_right", rearright: "rear_right", rr: "rear_right",
};

/**
 * The current health feed reports raw pressures in kPa-scale values (for
 * example 240.0). Convert only that unambiguous 100..1000 range to bar. A
 * response in an unknown unit stays absent rather than displaying a false
 * pressure reading.
 */
function parseTirePressureBar(health: JsonValue): Record<string, number> {
  const tireStatus = findKey(health, "tireStatus");
  if (tireStatus === null || typeof tireStatus !== "object" || Array.isArray(tireStatus)) return {};
  const tires = tireStatus.tires;
  if (!Array.isArray(tires)) return {};
  const out: Record<string, number> = {};
  for (const tire of tires) {
    if (tire === null || typeof tire !== "object" || Array.isArray(tire)) continue;
    const position = TIRE_ALIASES[norm(nestedEntryText(tire.position))];
    const rawPressure = toFloat(tire.pressureValue);
    if (!position || rawPressure === null || rawPressure < 100 || rawPressure > 1000) continue;
    out[position] = Math.round((rawPressure / 100) * 10) / 10;
  }
  return out;
}

function parseBatteryHealth(health: JsonValue): number | null {
  const value = toInt(firstPresent(health, ["batteryLife", "batteryHealth"]));
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

/** Same shape as build_latest() in cron_log_status.py — kept field-identical. */
async function fetchLiveStatus(env: Env, accessToken: string, vin: string): Promise<Record<string, JsonValue>> {
  const headers = sharedHeaders(`Bearer ${accessToken}`);
  const [stateRes, healthRes] = await Promise.all([
    fetch(BASE_URL + EP_VEHICLE_STATE.replace("{vin}", vin), { headers }),
    fetch(BASE_URL + EP_VEHICLE_HEALTH.replace("{vin}", vin) + "?count=1", { headers }),
  ]);
  if (!stateRes.ok) throw new ApiError(502, `vehiclestate failed: HTTP ${stateRes.status} ${await safeText(stateRes)}`);

  const state = (await stateRes.json()) as JsonValue;
  const health = stateRes.ok && healthRes.ok ? ((await healthRes.json()) as JsonValue) : null;

  const charging = (findKey(state, "chargingControl") ?? state) as JsonValue;
  const battery = toInt(firstPresent(charging, ["hvBatteryLife", "batteryLife"]));
  const gasRange = toInt(extractRange(firstPresent(charging, ["cruisingRangeFirst"])));
  const evRange = toInt(extractRange(firstPresent(charging, ["cruisingRangeSecond"])));
  let totalRange = toInt(firstPresent(charging, ["cruisingRangeCombined"]));
  if (totalRange === null && (evRange !== null || gasRange !== null)) totalRange = (evRange ?? 0) + (gasRange ?? 0);

  const tirePressureBar = health ? parseTirePressureBar(health) : {};
  const warnings = health ? parseWarnings(health) : {};

  return {
    ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    battery_pct: battery,
    ev_range_km: evRange,
    gas_range_km: gasRange,
    total_range_km: totalRange,
    odometer_km: toInt(firstPresent(health ?? {}, ["odo", "odometer"])),
    charging_status: chargingStatus(firstPresent(charging, ["hvChargingStatus", "chargingStatus"])),
    plugged_in: toBool(firstPresent(charging, ["hvChargingPlugStatus", "chargePlugConnected"])),
    time_to_full_charge_min: toInt(firstPresent(charging, ["hvTimeToFullCharge"])),
    health_reported: health !== null,
    battery_health_pct: health ? parseBatteryHealth(health) : null,
    tire_pressure_bar: tirePressureBar,
    warnings,
    ignition_on: toBool(firstPresent(state, ["ignitionStatus", "ignition", "ignitionState"])),
    speed_kmh: toInt(firstPresent(state, ["speed", "vehicleSpeed", "spd"])),
    location: {
      lat: toFloat(firstPresent(state, ["lat", "latitude"])),
      lon: toFloat(firstPresent(state, ["lon", "lng", "longitude"])),
    },
    doors: parseDoors(state),
    headlights: parseHeadlights(state),
  };
}

// ---------------------------------------------------------------------------
// Snow Guard — weather-aware, non-destructive pre-conditioning
// ---------------------------------------------------------------------------

/**
 * Snow Guard deliberately uses the immediate remoteAC path rather than the
 * three Mitsubishi climate timer slots. Those timers are user-owned weekly
 * schedules; changing them during a storm could overwrite native-app settings.
 *
 * The Durable Object stores only opt-in configuration, cooldowns, and concise
 * action receipts — never account credentials, a PIN, a VIN, or raw payloads.
 */
const SNOW_GUARD_DEFAULT_NAME = "primary";
const SNOW_GUARD_CONFIG_KEY = "config";
const SNOW_GUARD_RUNTIME_KEY = "runtime";
const SNOW_GUARD_EVENTS_KEY = "events";
const SNOW_GUARD_TIMEZONE = "America/Halifax";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const SNOW_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);

type SnowSeverity = "none" | "light" | "moderate" | "heavy";
type SnowDecisionCode =
  | "disabled" | "no_snow" | "light_snow" | "weather_unavailable"
  | "daily_limit" | "cooldown" | "vehicle_moving" | "vehicle_open"
  | "not_plugged" | "battery_unknown" | "battery_low" | "climate_started"
  | "climate_rejected" | "climate_pending" | "climate_error";

interface SnowGuardConfig {
  enabled: boolean;
  location: { latitude: number; longitude: number; label: string };
  minBatteryPct: number;
  requirePlugged: boolean;
  maxRunsPerDay: number;
  cooldownMinutes: number;
}

interface SnowWeather {
  checkedAt: string;
  temperatureC: number | null;
  currentSnowCm: number;
  nextHourSnowCm: number;
  nextThreeHoursSnowCm: number;
  weatherCode: number | null;
  severity: SnowSeverity;
}

interface SnowGuardDecision {
  at: string;
  code: SnowDecisionCode;
  summary: string;
  weather: SnowWeather | null;
}

interface SnowGuardRuntime {
  localDate: string;
  runsToday: number;
  lastAttemptAt: string | null;
  lastRunAt: string | null;
  lastDecision: SnowGuardDecision | null;
}

interface SnowGuardEvent {
  at: string;
  code: SnowDecisionCode;
  summary: string;
  weather: SnowWeather | null;
  action?: { minutes: number; outcome: EventOutcome["outcome"] | "submitted"; errorLabel: string | null };
}

interface SnowGuardSnapshot {
  config: SnowGuardConfig;
  runtime: SnowGuardRuntime;
  events: SnowGuardEvent[];
}

const DEFAULT_SNOW_GUARD_CONFIG: SnowGuardConfig = {
  // Explicit opt-in: deploying this feature must not start remote climate.
  enabled: false,
  location: { latitude: 44.6488, longitude: -63.5752, label: "Halifax, NS" },
  minBatteryPct: 35,
  requirePlugged: true,
  maxRunsPerDay: 2,
  cooldownMinutes: 360,
};

function halifaxDate(date: Date): string {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: SNOW_GUARD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year ?? "0000"}-${values.month ?? "00"}-${values.day ?? "00"}`;
}

function snowGuardDefaultRuntime(now = new Date()): SnowGuardRuntime {
  return { localDate: halifaxDate(now), runsToday: 0, lastAttemptAt: null, lastRunAt: null, lastDecision: null };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, n);
}

function sumValues(value: unknown, start: number, count: number): number {
  if (!Array.isArray(value)) return 0;
  return value.slice(start, start + count).reduce<number>((sum, item) => sum + nonNegativeNumber(item), 0);
}

function firstForecastIndex(times: unknown, currentTime: unknown): number {
  if (!Array.isArray(times) || typeof currentTime !== "string") return 0;
  const index = times.findIndex((time) => typeof time === "string" && time >= currentTime);
  return index < 0 ? 0 : index;
}

function summarizeSnowSeverity(
  temperatureC: number | null, currentSnowCm: number, nextHourSnowCm: number,
  nextThreeHoursSnowCm: number, weatherCode: number | null,
): SnowSeverity {
  // Above this temperature the useful outcome is generally rain/slush, not
  // enough to justify an unattended traction-battery climate cycle.
  if (temperatureC === null || temperatureC > 2.5) return "none";
  const currentSnowSignal = currentSnowCm >= 0.05 || (weatherCode !== null && SNOW_WEATHER_CODES.has(weatherCode));
  const nearTermSnow = Math.max(currentSnowSignal ? 0.3 : 0, currentSnowCm, nextHourSnowCm, nextThreeHoursSnowCm);
  if (nearTermSnow < 0.3) return "none";
  if (nearTermSnow < 1.5) return "light";
  if (nearTermSnow < 4) return "moderate";
  return "heavy";
}

async function fetchSnowWeather(config: SnowGuardConfig): Promise<SnowWeather> {
  const query = new URLSearchParams({
    latitude: String(config.location.latitude), longitude: String(config.location.longitude),
    timezone: SNOW_GUARD_TIMEZONE, current: "temperature_2m,snowfall,weather_code",
    minutely_15: "snowfall", forecast_minutely_15: "12",
  });
  const response = await fetch(`${OPEN_METEO_FORECAST_URL}?${query.toString()}`);
  if (!response.ok) throw new ApiError(502, `Weather lookup failed: HTTP ${response.status}`);
  const raw = (await response.json().catch(() => null)) as {
    current?: { time?: unknown; temperature_2m?: unknown; snowfall?: unknown; weather_code?: unknown };
    minutely_15?: { time?: unknown; snowfall?: unknown };
  } | null;
  if (!raw?.current) throw new ApiError(502, "Weather lookup returned no current conditions");
  const currentSnowCm = nonNegativeNumber(raw.current.snowfall);
  const weatherCode = finiteNumber(raw.current.weather_code);
  const index = firstForecastIndex(raw.minutely_15?.time, raw.current.time);
  const nextHourSnowCm = sumValues(raw.minutely_15?.snowfall, index, 4);
  const nextThreeHoursSnowCm = sumValues(raw.minutely_15?.snowfall, index, 12);
  const temperatureC = finiteNumber(raw.current.temperature_2m);
  return {
    checkedAt: new Date().toISOString(), temperatureC, currentSnowCm, nextHourSnowCm, nextThreeHoursSnowCm, weatherCode,
    severity: summarizeSnowSeverity(temperatureC, currentSnowCm, nextHourSnowCm, nextThreeHoursSnowCm, weatherCode),
  };
}

function normaliseSnowGuardConfig(input: unknown, current = DEFAULT_SNOW_GUARD_CONFIG): SnowGuardConfig {
  const source = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const locationInput = source.location !== null && typeof source.location === "object" && !Array.isArray(source.location)
    ? source.location as Record<string, unknown>
    : {};
  const latitude = finiteNumber(locationInput.latitude);
  const longitude = finiteNumber(locationInput.longitude);
  // A city-level location is sufficient. The vehicle's own location never
  // needs to be sent to a weather service for this use case.
  const location = latitude !== null && longitude !== null && latitude >= 43 && latitude <= 46 && longitude >= -66 && longitude <= -60
    ? {
        latitude,
        longitude,
        label: typeof locationInput.label === "string" && locationInput.label.trim()
          ? locationInput.label.trim().slice(0, 64)
          : current.location.label,
      }
    : current.location;
  const minBatteryPct = finiteNumber(source.minBatteryPct);
  const maxRunsPerDay = finiteNumber(source.maxRunsPerDay);
  const cooldownMinutes = finiteNumber(source.cooldownMinutes);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : current.enabled,
    location,
    minBatteryPct: minBatteryPct === null ? current.minBatteryPct : Math.round(Math.max(20, Math.min(80, minBatteryPct))),
    requirePlugged: typeof source.requirePlugged === "boolean" ? source.requirePlugged : current.requirePlugged,
    maxRunsPerDay: maxRunsPerDay === null ? current.maxRunsPerDay : Math.round(Math.max(1, Math.min(3, maxRunsPerDay))),
    cooldownMinutes: cooldownMinutes === null ? current.cooldownMinutes : Math.round(Math.max(180, Math.min(720, cooldownMinutes))),
  };
}

function snowDecision(code: SnowDecisionCode, summary: string, weather: SnowWeather | null): SnowGuardDecision {
  return { at: new Date().toISOString(), code, summary, weather };
}

function snowWeatherSummary(weather: SnowWeather): string {
  return `${weather.severity} snow risk · ${weather.nextThreeHoursSnowCm.toFixed(1)} cm forecast over 3 h`;
}

function isOpenDoorValue(value: JsonValue | undefined): boolean {
  return value === "open";
}

/**
 * One stateful instance per dashboard. It only receives public requests after
 * the outer Worker has authenticated them; cron calls the bound object directly
 * and is never externally routable.
 */
export class SnowGuard {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async snapshot(): Promise<SnowGuardSnapshot> {
    const [storedConfig, storedRuntime, storedEvents] = await Promise.all([
      this.state.storage.get<SnowGuardConfig>(SNOW_GUARD_CONFIG_KEY),
      this.state.storage.get<SnowGuardRuntime>(SNOW_GUARD_RUNTIME_KEY),
      this.state.storage.get<SnowGuardEvent[]>(SNOW_GUARD_EVENTS_KEY),
    ]);
    const config = normaliseSnowGuardConfig(storedConfig);
    const runtime = storedRuntime ?? snowGuardDefaultRuntime();
    const today = halifaxDate(new Date());
    if (runtime.localDate !== today) {
      runtime.localDate = today;
      runtime.runsToday = 0;
      await this.state.storage.put(SNOW_GUARD_RUNTIME_KEY, runtime);
    }
    return { config, runtime, events: Array.isArray(storedEvents) ? storedEvents : [] };
  }

  private async save(snapshot: SnowGuardSnapshot): Promise<void> {
    await this.state.storage.put({
      [SNOW_GUARD_CONFIG_KEY]: snapshot.config,
      [SNOW_GUARD_RUNTIME_KEY]: snapshot.runtime,
      [SNOW_GUARD_EVENTS_KEY]: snapshot.events,
    });
  }

  private async record(
    snapshot: SnowGuardSnapshot,
    decision: SnowGuardDecision,
    action?: SnowGuardEvent["action"],
  ): Promise<SnowGuardSnapshot> {
    snapshot.runtime.lastDecision = decision;
    snapshot.events = [
      { at: decision.at, code: decision.code, summary: decision.summary, weather: decision.weather, ...(action ? { action } : {}) },
      ...snapshot.events,
    ].slice(0, 40);
    await this.save(snapshot);
    return snapshot;
  }

  private async dryRun(): Promise<SnowGuardSnapshot> {
    const snapshot = await this.snapshot();
    if (!snapshot.config.enabled) {
      snapshot.runtime.lastDecision = snowDecision("disabled", "Snow Guard is off. Enable it to run automatic checks.", null);
      await this.save(snapshot);
      return snapshot;
    }
    try {
      const weather = await fetchSnowWeather(snapshot.config);
      const code: SnowDecisionCode = weather.severity === "none" ? "no_snow" : weather.severity === "light" ? "light_snow" : "climate_pending";
      const summary = code === "climate_pending"
        ? `${snowWeatherSummary(weather)}. The next scheduled check can precondition if vehicle safeguards pass.`
        : code === "light_snow"
          ? `${snowWeatherSummary(weather)}. Below the automatic preconditioning threshold.`
          : "No meaningful near-term snow risk.";
      snapshot.runtime.lastDecision = snowDecision(code, summary, weather);
      await this.save(snapshot);
      return snapshot;
    } catch {
      snapshot.runtime.lastDecision = snowDecision("weather_unavailable", "Weather could not be checked. No vehicle action was sent.", null);
      await this.save(snapshot);
      return snapshot;
    }
  }

  private async tick(): Promise<SnowGuardSnapshot> {
    const snapshot = await this.snapshot();
    if (!snapshot.config.enabled) return snapshot;

    let weather: SnowWeather;
    try {
      weather = await fetchSnowWeather(snapshot.config);
    } catch {
      return this.record(snapshot, snowDecision("weather_unavailable", "Weather could not be checked. No vehicle action was sent.", null));
    }

    if (weather.severity === "none") {
      snapshot.runtime.lastDecision = snowDecision("no_snow", "No meaningful near-term snow risk.", weather);
      await this.save(snapshot);
      return snapshot;
    }
    if (weather.severity === "light") {
      return this.record(snapshot, snowDecision("light_snow", `${snowWeatherSummary(weather)}. Below the automatic preconditioning threshold.`, weather));
    }

    const now = Date.now();
    if (snapshot.runtime.runsToday >= snapshot.config.maxRunsPerDay) {
      return this.record(snapshot, snowDecision("daily_limit", `Daily limit reached (${snapshot.config.maxRunsPerDay} Snow Guard runs).`, weather));
    }
    if (snapshot.runtime.lastAttemptAt) {
      const elapsed = now - Date.parse(snapshot.runtime.lastAttemptAt);
      if (Number.isFinite(elapsed) && elapsed < snapshot.config.cooldownMinutes * 60_000) {
        return this.record(snapshot, snowDecision("cooldown", `Cooldown active; Snow Guard will not repeat within ${snapshot.config.cooldownMinutes / 60} h.`, weather));
      }
    }

    let latest: Record<string, JsonValue>;
    try {
      const { accessToken } = await login(this.env);
      const vin = await getVin(this.env, accessToken);
      latest = await fetchLiveStatus(this.env, accessToken, vin);
    } catch {
      return this.record(snapshot, snowDecision("climate_error", "Vehicle status could not be confirmed. No climate action was sent.", weather));
    }

    const speed = finiteNumber(latest.speed_kmh);
    if (latest.ignition_on === true || (speed !== null && speed > 0)) {
      return this.record(snapshot, snowDecision("vehicle_moving", "Vehicle appears to be in use. No climate action was sent.", weather));
    }
    const doors = latest.doors;
    if (doors !== null && typeof doors === "object" && !Array.isArray(doors) && Object.values(doors).some(isOpenDoorValue)) {
      return this.record(snapshot, snowDecision("vehicle_open", "A vehicle access point is reported open. No climate action was sent.", weather));
    }
    if (snapshot.config.requirePlugged && latest.plugged_in !== true) {
      return this.record(snapshot, snowDecision("not_plugged", "Vehicle is not reported plugged in. No climate action was sent.", weather));
    }
    const batteryPct = finiteNumber(latest.battery_pct);
    if (batteryPct === null) {
      return this.record(snapshot, snowDecision("battery_unknown", "Battery level was not reported. No climate action was sent.", weather));
    }
    if (batteryPct < snapshot.config.minBatteryPct) {
      return this.record(snapshot, snowDecision("battery_low", `Battery is ${Math.round(batteryPct)}%; Snow Guard requires ${snapshot.config.minBatteryPct}% or more.`, weather));
    }

    // Persist the attempt before the remote request. A timeout must not cause
    // another climate start on the next 15-minute tick.
    const nowIso = new Date(now).toISOString();
    snapshot.runtime.lastAttemptAt = nowIso;
    await this.save(snapshot);

    const minutes = weather.severity === "heavy" ? 30 : 20;
    const request: ClimateRequest = {
      minutes,
      temperatureC: 28,
      options: [MAX_DEFROST_OPTION, "defrost_front"],
      posmap: null,
    };
    try {
      // This is the vital behavioural split from an interactive update:
      // automated weather logic never stops a currently running session.
      const result = await runClimateStart(this.env, request, { replaceExisting: false });
      if (result.event?.outcome === "failed") {
        const activeElsewhere = result.event.errorLabel === "RO_FAILURE_ALREADY_STARTED";
        return this.record(
          snapshot,
          snowDecision(
            "climate_rejected",
            activeElsewhere
              ? "Climate is already running, so Snow Guard left it alone."
              : `Vehicle rejected the Snow Guard climate request${result.event.errorLabel ? ` (${result.event.errorLabel})` : ""}.`,
            weather,
          ),
          { minutes, outcome: result.event.outcome, errorLabel: result.event.errorLabel },
        );
      }
      snapshot.runtime.lastRunAt = nowIso;
      snapshot.runtime.runsToday++;
      const outcome = result.event?.outcome ?? "submitted";
      return this.record(
        snapshot,
        snowDecision(
          outcome === "succeeded" ? "climate_started" : "climate_pending",
          outcome === "succeeded"
            ? `Snow Guard started ${minutes}-minute windshield preconditioning.`
            : `Snow Guard submitted ${minutes}-minute windshield preconditioning; vehicle confirmation is pending.`,
          weather,
        ),
        { minutes, outcome, errorLabel: result.event?.errorLabel ?? null },
      );
    } catch {
      return this.record(snapshot, snowDecision("climate_error", "Snow Guard could not submit a climate action. It will not retry until the cooldown ends.", weather));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/snow-guard") {
      return json({ success: true, ...(await this.snapshot()) });
    }
    if (request.method === "PUT" && url.pathname === "/snow-guard") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: "Invalid JSON body" }, 400);
      }
      const snapshot = await this.snapshot();
      snapshot.config = normaliseSnowGuardConfig(body, snapshot.config);
      snapshot.runtime.lastDecision = snowDecision(
        snapshot.config.enabled ? "climate_pending" : "disabled",
        snapshot.config.enabled ? "Snow Guard enabled. It will check Halifax weather every 15 minutes." : "Snow Guard is off.",
        snapshot.runtime.lastDecision?.weather ?? null,
      );
      await this.save(snapshot);
      return json({ success: true, ...snapshot });
    }
    if (request.method === "POST" && url.pathname === "/snow-guard/check") {
      return json({ success: true, ...(await this.dryRun()) });
    }
    if (request.method === "POST" && url.pathname === "/snow-guard/tick") {
      return json({ success: true, ...(await this.tick()) });
    }
    return json({ success: false, error: "Not found" }, 404);
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const isCommand = url.pathname === "/command" && request.method === "POST";
    const isStatus = url.pathname === "/status" && request.method === "GET";
    const isMqttDiscover = url.pathname === "/mqtt-discover" && request.method === "GET";
    const isSettings = url.pathname === "/settings" && request.method === "GET";
    const isConfig = url.pathname === "/config" && request.method === "GET";
    const isState = url.pathname === "/state" && request.method === "GET";
    const isActivity = url.pathname === "/activity" && request.method === "GET";
    const isSnowGuard =
      (url.pathname === "/snow-guard" && (request.method === "GET" || request.method === "PUT")) ||
      (url.pathname === "/snow-guard/check" && request.method === "POST");
    if (!isCommand && !isStatus && !isMqttDiscover && !isSettings && !isConfig && !isState && !isActivity && !isSnowGuard) {
      return json({ success: false, error: "Not found" }, 404);
    }

    // --- Auth gate: constant-time compare of X-Dashboard-Key (before anything else) ---
    const providedKey = request.headers.get("X-Dashboard-Key") ?? "";
    if (!env.DASHBOARD_API_KEY || !(await timingSafeEqual(providedKey, env.DASHBOARD_API_KEY))) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    // Reading the activity trail is intentionally not itself logged; otherwise
    // opening the page would create misleading audit noise forever.
    if (isActivity) {
      const requested = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(ACTIVITY_MAX_RECORDS, requested)) : 100;
      try {
        const activity = await readActivity(env, limit);
        return json({ success: true, ...activity, retention_days: 365, max_records: ACTIVITY_MAX_RECORDS });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: "Activity log is unavailable" }, 502);
      }
    }

    if (isSnowGuard) {
      // The Durable Object is not publicly addressable. This authenticated
      // proxy is deliberately the only browser path to settings and receipts.
      // Its config can contain a city-level location, so log only the concise
      // decision/result summary rather than the raw request or response.
      const audit = createAuditContext(url);
      audit.kind = "validation";
      audit.action = url.pathname === "/snow-guard/check" ? "snow_guard_check" : "snow_guard_settings";
      const id = env.SNOW_GUARD.idFromName(SNOW_GUARD_DEFAULT_NAME);
      const response = await env.SNOW_GUARD.get(id).fetch(request);
      const body = await response.clone().json().catch(() => null);
      ctx.waitUntil(appendActivity(env, recordActivity(audit, snowGuardActivityBody(body, response.ok), response.status)).catch((err) => {
        console.warn("Activity log write failed", (err as Error).message);
      }));
      return response;
    }

    const audit = createAuditContext(url);
    // Shadow the response helper only inside the authenticated, auditable
    // routes. Existing early returns then all get one consistent log record
    // without duplicating logging calls through every command branch.
    const plainJson = json;
    {
      const json = (body: unknown, status = 200): Response => {
        const record = recordActivity(audit, body, status);
        ctx.waitUntil(appendActivity(env, record).catch((err) => {
          // Do not fail a vehicle command merely because its audit sink is
          // temporarily unavailable. No request, response, or secret is logged.
          console.warn("Activity log write failed", (err as Error).message);
        }));
        return plainJson(body, status);
      };
    if (isStatus) {
      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        const latest = await fetchLiveStatus(env, accessToken, vin);
        return json({ success: true, latest });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // Read-only. svla is exposed here because there is no confirmed write path
    // for it anywhere in the decompiled app (no DataSvla builder, no dispatch
    // site) — the dedicated GET /avi/v1/vehicles/{vin}/state/svla endpoint is
    // also declared in res/raw/environment but never wired to anything in the
    // app, so this reads the same flag off vehiclestate instead, which IS live.
    if (isState) {
      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        const res = await fetch(BASE_URL + EP_VEHICLE_STATE.replace("{vin}", encodeURIComponent(vin)), {
          headers: sharedHeaders(`Bearer ${accessToken}`),
        });
        if (!res.ok) {
          return json({ success: false, error: `Vehicle state failed: HTTP ${res.status} ${await safeText(res)}` }, 502);
        }
        const raw = (await res.json()) as JsonValue;
        return json({ success: true, state: parseVehicleState(raw) });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    if (isSettings) {
      const operation = url.searchParams.get("operation") ?? "remoteAC";
      if (!SETTINGS_OPERATIONS.has(operation)) {
        return json({ success: false, error: `Unknown settings operation '${operation}'` }, 400);
      }
      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        const res = await fetch(
          `${BASE_URL}${EP_PARENTAL_ALERT.replace("{vin}", encodeURIComponent(vin))}?operation=${encodeURIComponent(operation)}`,
          { headers: sharedHeaders(`Bearer ${accessToken}`) },
        );
        if (!res.ok) {
          return json({ success: false, error: `Settings read failed: HTTP ${res.status} ${await safeText(res)}` }, 502);
        }
        const settings = (await res.json()) as JsonValue;
        // Normalised alongside the raw payload so the frontend doesn't have to
        // duplicate Mitsubishi's timer schemas in browser JS.
        const schedule = operation === "chargingControl2"
          ? parseChargingSchedule(settings)
          : operation === "climateControl"
            ? parseClimateSchedule(settings)
            : undefined;
        return json({ success: true, operation, settings, schedule });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // Read-only. Surfaces this vehicle's climate posmap so the dashboard can
    // build its temperature selector from the car's real range instead of a
    // hardcoded guess, and so the raw response can be inspected while the
    // posmap parsing is still unverified.
    if (isConfig) {
      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        const identity = await fetchVehicleIdentity(accessToken, env.MMC_USERNAME, vin);
        if (!identity.model) {
          return json({ success: false, error: "Could not resolve vehicle model", identity }, 502);
        }
        // These two reads are independent. The model configuration explains
        // the temperature grid and advertised services; remoteAC settings are
        // the vehicle-specific source of truth for optional HVAC controls.
        const [{ posmap, raw }, availableHvacOptions] = await Promise.all([
          fetchPosMap(accessToken, identity.model, identity.year, identity.country),
          getAvailableHvacOptions(accessToken, vin),
        ]);
        return json({
          success: true,
          identity: { model: identity.model, year: identity.year, country: identity.country },
          temperature: posmap
            ? {
                minC: posmap.minC,
                maxC: posmap.maxC,
                step: posmap.step,
                loPos: posmap.loPos,
                hiPos: posmap.hiPos,
                steps: Object.keys(posmap.celToPos)
                  .map(parseFloat)
                  .sort((a, b) => a - b),
              }
            : null,
          // Do not expose raw Mitsubishi responses to the browser. This is
          // enough for the UI to show what the vehicle reports and gives us a
          // conservative discovery list for future, separately-validated
          // controls.
          capabilities: {
            hvac: summarizeHvacCapabilities(availableHvacOptions),
          },
          services: [...new Set(extractServices(raw))].sort(),
        });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    if (isMqttDiscover) {
      try {
        const { accessToken, accountDN, clientId } = await login(env);
        const vin = await getVin(env, accessToken);
        const discovery = await mqttDiscoverOperations({ accessToken, accountDN, clientId, vin });
        return json({ success: true, ...discovery });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        const clientIdDiag = {
          length: env.MMC_CLIENT_ID?.length ?? 0,
          hasWhitespace: /\s/.test(env.MMC_CLIENT_ID ?? ""),
          matchesUuidShape: /^[0-9a-f-]{20,40}$/i.test(env.MMC_CLIENT_ID ?? ""),
          firstChar: (env.MMC_CLIENT_ID ?? "").slice(0, 1),
          lastChar: (env.MMC_CLIENT_ID ?? "").slice(-1),
        };
        return json(
          { success: false, error: `Unexpected error: ${(err as Error).message}`, clientIdDiag },
          500,
        );
      }
    }

    // --- Parse body ---
    let action: unknown;
    let rawMinutes: unknown;
    let rawTemp: unknown;
    let rawOptions: unknown;
    let rawTimers: unknown;
    try {
      const body = (await request.json()) as {
        action?: unknown;
        minutes?: unknown;
        temperatureC?: unknown;
        options?: unknown;
        timers?: unknown;
      };
      action = body.action;
      rawMinutes = body.minutes;
      rawTemp = body.temperatureC;
      rawOptions = body.options;
      rawTimers = body.timers;
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }
    audit.kind = "command";
    audit.action = activityString(action, "invalid_command").slice(0, 64) || "invalid_command";
    audit.request = commandActivityRequest(action, rawMinutes, rawTemp, rawOptions, rawTimers);
    if (typeof action !== "string" || action.length === 0) {
      return json({ success: false, error: "Missing 'action'" }, 400);
    }

    // --- Charging start/stop uses a different endpoint and a different runner
    // (see runChargingControl) — handled first and returned early, since it
    // does not go through OPERATION_MAP / runCommand at all.
    if (action === "charge_start" || action === "charge_stop") {
      const direction = action === "charge_start" ? "start" : "stop";
      try {
        const { eventId, submitted, event } = await runChargingControl(env, direction);
        if (!event) {
          return json({ success: true, action, message: `'${action}' submitted.`, eventId, raw: submitted });
        }
        const message =
          event.outcome === "succeeded"
            ? `Charging ${direction === "start" ? "started" : "stopped"}, confirmed by vehicle.`
            : event.outcome === "failed"
              ? `'${action}' rejected by vehicle${event.errorLabel ? ` (${event.errorLabel})` : ""}.`
              : `'${action}' sent, but the vehicle did not report back in time.`;
        return json({ success: event.outcome !== "failed", action, outcome: event.outcome, message, eventId, event });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // --- Recurring charge schedule. Uses the standard runCommand() envelope
    // (login -> PIN-verify -> submit -> poll) with operation "chargingControl2",
    // NOT runChargingControl() — this operation shares remoteAC's endpoint and
    // builder, not the DGE microservice used by charge_start/charge_stop.
    if (action === "charging_schedule") {
      const items = Array.isArray(rawTimers) ? rawTimers : [];
      if (items.length > CHARGING_MAX_TIMERS) {
        return json({ success: false, error: `At most ${CHARGING_MAX_TIMERS} timers are supported` }, 400);
      }
      const timers: ChargeTimerInput[] = [];
      for (const raw of items) {
        if (raw === null || typeof raw !== "object") {
          return json({ success: false, error: "Each timer must be an object" }, 400);
        }
        const item = raw as Record<string, unknown>;
        const startMinutes = typeof item.startMinutes === "number" ? item.startMinutes : NaN;
        const endMinutes = typeof item.endMinutes === "number" ? item.endMinutes : NaN;
        if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
          return json({ success: false, error: "Each timer needs numeric startMinutes/endMinutes" }, 400);
        }
        const days = Array.isArray(item.days) ? item.days.filter((d): d is string => typeof d === "string") : [];
        const unknownDay = days.find((d) => !CHARGING_DAY_ORDER.includes(d as (typeof CHARGING_DAY_ORDER)[number]));
        if (unknownDay) {
          return json({ success: false, error: `Unknown day '${unknownDay}'` }, 400);
        }
        timers.push({
          id: typeof item.id === "string" && item.id ? item.id : null,
          enabled: item.enabled === true,
          startMinutes: clampMinutesOfDay(startMinutes),
          endMinutes: clampMinutesOfDay(endMinutes),
          days,
        });
      }

      try {
        const extra = buildChargingScheduleExtra(timers);
        // chargingId is generated HERE, client-side of the vehicle API (by us),
        // not assigned by the server — so it is only knowable by echoing back
        // exactly what was built. Without this the dashboard would send id:null
        // for a "new" timer on every save, creating a fresh timer each time
        // instead of ever editing the one before it.
        const sentTimers = parseChargingSchedule(extra as JsonValue);
        const { eventId, submitted, event } = await runCommand(env, "chargingControl2", extra);
        if (!event) {
          return json({ success: true, action, message: "Charging schedule submitted.", eventId, raw: submitted, timers: sentTimers });
        }
        const message =
          event.outcome === "succeeded"
            ? "Charging schedule saved, confirmed by vehicle."
            : event.outcome === "failed"
              ? `Charging schedule rejected by vehicle${event.errorLabel ? ` (${event.errorLabel})` : ""}.`
              : "Charging schedule sent, but the vehicle did not report back in time.";
        return json({
          success: event.outcome !== "failed", action, outcome: event.outcome, message, eventId, event,
          timers: sentTimers,
        });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // --- Recurring climate schedule. The APK calls this
    // RemoteClimateControlScheduler / operation:"climateControl" and places
    // `conditioningDefinition` under `data`, exactly like the charging
    // scheduler's envelope. Unlike an immediate climate start, this is a
    // vehicle-side timer configuration: we preserve the target temperature and
    // supported HVAC choices reported by the vehicle, then update only the
    // timer's enabled state, weekly days, and ready-by time.
    if (action === "climate_schedule") {
      const items = Array.isArray(rawTimers) ? rawTimers : [];
      if (items.length !== CLIMATE_MAX_TIMERS) {
        return json({ success: false, error: `Exactly ${CLIMATE_MAX_TIMERS} climate timers are required` }, 400);
      }
      const timers: ClimateTimerInput[] = [];
      for (const raw of items) {
        if (raw === null || typeof raw !== "object") {
          return json({ success: false, error: "Each climate timer must be an object" }, 400);
        }
        const item = raw as Record<string, unknown>;
        const departureMinutes = typeof item.departureMinutes === "number" ? item.departureMinutes : NaN;
        if (!Number.isFinite(departureMinutes)) {
          return json({ success: false, error: "Each climate timer needs numeric departureMinutes" }, 400);
        }
        const days = Array.isArray(item.days) ? item.days.filter((d): d is string => typeof d === "string") : [];
        const unknownDay = days.find((d) => !CHARGING_DAY_ORDER.includes(d as (typeof CHARGING_DAY_ORDER)[number]));
        if (unknownDay) {
          return json({ success: false, error: `Unknown day '${unknownDay}'` }, 400);
        }
        timers.push({
          id: typeof item.id === "string" && item.id ? item.id : null,
          enabled: item.enabled === true,
          departureMinutes: clampMinutesOfDay(departureMinutes),
          days,
        });
      }

      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        // Authoritative source for ids, saved temperature, and option fields.
        // This also prevents a stale browser tab from accidentally deleting a
        // setting that was changed in Mitsubishi's own app.
        const currentSchedule = await fetchClimateScheduleSettings(accessToken, vin);
        const extra = buildClimateScheduleExtra(timers, climateScheduleDefinitions(currentSchedule));
        const sentTimers = parseClimateSchedule(extra as JsonValue);
        await wakeUpVehicle(accessToken, vin);
        const submitted = await performOperation(env, accessToken, vin, null, "climateControl", extra);
        const eventId = (submitted as { eventId?: unknown } | null)?.eventId;
        const event = typeof eventId === "string" && eventId
          ? await pollEvent(accessToken, vin, eventId, POLL_TIMEOUT_MS, "climateControl")
          : null;
        if (!event) {
          return json({ success: true, action, message: "Climate schedule submitted.", eventId: eventId ?? null, raw: submitted, timers: sentTimers });
        }
        const message =
          event.outcome === "succeeded"
            ? "Climate schedule saved, confirmed by vehicle."
            : event.outcome === "failed"
              ? `Climate schedule rejected by vehicle${event.errorLabel ? ` (${event.errorLabel})` : ""}.`
              : "Climate schedule sent, but the vehicle did not report back in time.";
        return json({
          success: event.outcome !== "failed", action, outcome: event.outcome, message, eventId, event,
          timers: sentTimers,
        });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // --- "climate" is the single entry point for the whole cabin-comfort
    // system. Seat heat, wheel heat and defrost ride along as `options` on this
    // one request rather than being separately actionable, because remoteAC
    // starts climate as a whole — see the HVAC_OPTIONS comment.
    const isHvac = action === "climate";
    if (!isHvac && CLIMATE_OPTION_KEYS.has(action)) {
      return json(
        {
          success: false,
          error: `'${action}' is not a standalone command — send action "climate" with options:["${action}", ...] instead.`,
        },
        400,
      );
    }

    const operation = isHvac ? "remoteAC" : OPERATION_MAP[action];
    if (!operation) {
      return json({ success: false, error: `Unknown action '${action}'` }, 400);
    }

    const requestedMinutes = typeof rawMinutes === "number" ? rawMinutes : DEFAULT_HVAC_MINUTES;
    const minutes = Math.max(1, Math.min(MAX_HVAC_MINUTES, Math.round(requestedMinutes)));

    let extra: Record<string, unknown> | undefined;
    let climateRequest: ClimateRequest | undefined;
    let optionCount = 0;
    if (isHvac) {
      const options = Array.isArray(rawOptions) ? rawOptions.filter((o): o is string => typeof o === "string") : [];
      const unknownOption = options.find((o) => !CLIMATE_OPTION_KEYS.has(o));
      if (unknownOption) {
        return json({ success: false, error: `Unknown climate option '${unknownOption}'` }, 400);
      }
      const temperatureC =
        typeof rawTemp === "number" && Number.isFinite(rawTemp)
          ? Math.max(MIN_HVAC_TEMP_C, Math.min(MAX_HVAC_TEMP_C, rawTemp))
          : DEFAULT_HVAC_TEMP_C;
      optionCount = options.length;

      // The posmap turns degrees into the "tmp" position index. tmp is
      // mandatory on every climate start (see FALLBACK_TMP_POS), so this is
      // always attempted now, not just when the caller supplied a
      // temperature. Best-effort: if the fetch itself fails, buildHvacExtra
      // falls back to FALLBACK_TMP_POS rather than failing the whole start.
      let posmap: PosMap | null = null;
      try {
        const { accessToken } = await login(env);
        const vin = await getVin(env, accessToken);
        const identity = await fetchVehicleIdentity(accessToken, env.MMC_USERNAME, vin);
        if (identity.model) {
          posmap = (await fetchPosMap(accessToken, identity.model, identity.year, identity.country)).posmap;
        }
      } catch {
        posmap = null;
      }
      climateRequest = { minutes, temperatureC, options, posmap };
    }

    try {
      const { eventId, submitted, event } = isHvac
        ? await runClimateStart(env, climateRequest!)
        : await runCommand(env, operation, extra);

      // No eventId means the backend answered synchronously (some operations do)
      // — treat the accepted submission as the result rather than inventing one.
      if (!event) {
        return json({ success: true, action, message: `'${action}' submitted.`, eventId, raw: submitted });
      }

      const duration = isHvac
        ? ` for ${minutes} min${optionCount ? ` (+${optionCount} comfort option${optionCount === 1 ? "" : "s"})` : ""}`
        : "";

      // Stopping a climate session that is not running answers
      // RO_FAILURE_ALREADY_STOPPED (confirmed live 2026-07-28). The requested
      // end state — climate off — already holds, so surfacing that as a red
      // "rejected by vehicle" toast reports a failure that did not happen. It
      // is a no-op, not an error. Same reasoning as the ALREADY_STARTED case in
      // runClimateStart(), from the other direction.
      const alreadyInEndState =
        event.outcome === "failed" && event.errorLabel === "RO_FAILURE_ALREADY_STOPPED";
      if (alreadyInEndState) {
        return json({
          success: true,
          action,
          outcome: "succeeded",
          message: "Climate was already off.",
          eventId,
          event,
        });
      }

      const message =
        event.outcome === "succeeded"
          ? `'${action}' confirmed by vehicle${duration}.`
          : event.outcome === "failed"
            ? `'${action}' rejected by vehicle${event.errorLabel ? ` (${event.errorLabel})` : ""}.`
            : `'${action}' sent, but the vehicle did not report back in time.`;

      return json({ success: event.outcome !== "failed", action, outcome: event.outcome, message, eventId, event });
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ success: false, error: err.message }, err.status);
      }
      return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
    }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Disabled guards return before their weather request. The helper records
    // only checks that reached the vehicle, avoiding a stream of idle cron noise.
    ctx.waitUntil(auditSnowGuardTick(env));
  },
};

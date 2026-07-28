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
const EP_VEHICLE_STATE = "/avi/v1/vehicles/{vin}/vehiclestate";
const EP_VEHICLE_HEALTH = "/avi/v1/vehicles/{vin}/vehicleStatus";

/** action (from dashboard) -> Aeris "operation" field. */
const OPERATION_MAP: Record<string, string> = {
  lock: "doorLock",
  unlock: "doorUnlock",
  horn: "horn",
  lights: "lights",
  locate: "locate",
};

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
    headers: { "Content-Type": "application/json; charset=UTF-8", ...CORS_HEADERS },
  });
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
  pinToken: string,
  operation: string,
): Promise<unknown> {
  const res = await fetch(BASE_URL + EP_PERFORM_RO, {
    method: "POST",
    headers: sharedHeaders(`Bearer ${accessToken}`),
    body: JSON.stringify({ vin, operation, forced: "false", pinToken }),
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

/** cruisingRangeFirst/Second come back as [{"range":"X"},{"engineType":"Y"}]. */
function extractRange(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item) && "range" in item) {
        return item.range;
      }
    }
    return undefined;
  }
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

function toBool(value: JsonValue | undefined): boolean {
  const v = scalar(value);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    return ["true", "1", "yes", "on", "open", "opened", "plugged", "pluggedin", "connected", "charging"].includes(
      v.trim().toLowerCase(),
    );
  }
  return false;
}

function chargingStatus(value: JsonValue | undefined): string {
  const v = scalar(value);
  if (typeof v === "boolean" || typeof v === "number") return v ? "charging" : "not_charging";
  const s = String(v ?? "").toLowerCase();
  if (["charging", "in_progress", "inprogress", "active"].some((t) => s.includes(t)) && !s.includes("not")) {
    return "charging";
  }
  return "not_charging";
}

const DOOR_ALIASES: Record<string, string> = {
  frontleft: "front_left", fl: "front_left", driverfront: "front_left", leftfront: "front_left",
  frontright: "front_right", fr: "front_right", passengerfront: "front_right", rightfront: "front_right",
  rearleft: "rear_left", rl: "rear_left", leftrear: "rear_left", driverrear: "rear_left",
  rearright: "rear_right", rr: "rear_right", rightrear: "rear_right", passengerrear: "rear_right",
  hood: "hood", bonnet: "hood", frunk: "hood",
  trunk: "trunk", tailgate: "trunk", boot: "trunk", liftgate: "trunk", hatch: "trunk",
};

function norm(text: JsonValue | undefined): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function entryName(entry: Record<string, JsonValue>): string {
  for (const k of ["location", "position", "doorLocation", "name", "door", "type", "id", "lightLocation", "light"]) {
    const v = entry[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function entryState(entry: Record<string, JsonValue>): JsonValue | undefined {
  for (const k of ["status", "state", "doorStatus", "lightStatus", "open", "on", "value"]) {
    if (k in entry) return entry[k];
  }
  return undefined;
}

function openClosed(value: JsonValue | undefined): string {
  const v = scalar(value);
  if (typeof v === "string" && ["ajar", "open", "opened"].includes(v.trim().toLowerCase())) return "open";
  return toBool(v) ? "open" : "closed";
}

function parseDoors(state: JsonValue): Record<string, string> {
  const doors: Record<string, string> = {
    front_left: "closed", front_right: "closed", rear_left: "closed", rear_right: "closed",
    hood: "closed", trunk: "closed",
  };
  let doorList = firstPresent(state, ["doors"]);
  const doorStatus = findKey(state, "doorStatus");
  if (doorStatus !== undefined && typeof doorStatus === "object" && !Array.isArray(doorStatus)) {
    doorList = findKey(doorStatus, "doors") ?? doorList;
  }
  if (!Array.isArray(doorList)) return doors;
  for (const entry of doorList) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const canonical = DOOR_ALIASES[norm(entryName(entry))];
    if (canonical) doors[canonical] = openClosed(entryState(entry));
  }
  return doors;
}

function parseHeadlights(state: JsonValue): string {
  let lights: JsonValue | undefined;
  const lightStatus = findKey(state, "lightStatus");
  if (lightStatus !== undefined && typeof lightStatus === "object" && !Array.isArray(lightStatus)) {
    lights = findKey(lightStatus, "lights");
  }
  if (lights === undefined) lights = findKey(state, "lights");
  if (Array.isArray(lights)) {
    for (const entry of lights) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && norm(entryName(entry)).includes("head")) {
        return toBool(entryState(entry)) ? "on" : "off";
      }
    }
  }
  const flat = firstPresent(state, ["headlightStatus", "headLampStatus", "headlights"]);
  return flat !== undefined ? (toBool(flat) ? "on" : "off") : "off";
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
  const battery = toInt(firstPresent(charging, ["hvBatteryLife"]));
  const gasRange = toInt(extractRange(firstPresent(charging, ["cruisingRangeFirst"])));
  const evRange = toInt(extractRange(firstPresent(charging, ["cruisingRangeSecond"])));
  let totalRange = toInt(firstPresent(charging, ["cruisingRangeCombined"]));
  if (totalRange === null && (evRange !== null || gasRange !== null)) totalRange = (evRange ?? 0) + (gasRange ?? 0);

  return {
    ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    battery_pct: battery ?? 0,
    ev_range_km: evRange ?? 0,
    gas_range_km: gasRange ?? 0,
    total_range_km: totalRange ?? 0,
    odometer_km: toInt(firstPresent(health ?? {}, ["odo", "odometer"])) ?? 0,
    charging_status: chargingStatus(firstPresent(charging, ["hvChargingStatus"])),
    plugged_in: toBool(firstPresent(charging, ["hvChargingPlugStatus"])),
    time_to_full_charge_min: toInt(firstPresent(charging, ["hvTimeToFullCharge"]), 0) ?? 0,
    ignition_on: toBool(firstPresent(state, ["ignitionStatus", "ignition", "ignitionState"])),
    speed_kmh: toInt(firstPresent(state, ["speed", "vehicleSpeed", "spd"]), 0) ?? 0,
    location: {
      lat: toFloat(firstPresent(state, ["lat", "latitude"])),
      lon: toFloat(firstPresent(state, ["lon", "lng", "longitude"])),
    },
    doors: parseDoors(state),
    headlights: parseHeadlights(state),
  };
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const isCommand = url.pathname === "/command" && request.method === "POST";
    const isStatus = url.pathname === "/status" && request.method === "GET";
    const isMqttDiscover = url.pathname === "/mqtt-discover" && request.method === "GET";
    if (!isCommand && !isStatus && !isMqttDiscover) {
      return json({ success: false, error: "Not found" }, 404);
    }

    // --- Auth gate: constant-time compare of X-Dashboard-Key (before anything else) ---
    const providedKey = request.headers.get("X-Dashboard-Key") ?? "";
    if (!env.DASHBOARD_API_KEY || !(await timingSafeEqual(providedKey, env.DASHBOARD_API_KEY))) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

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

    if (isMqttDiscover) {
      try {
        const { accessToken, accountDN, clientId } = await login(env);
        const vin = await getVin(env, accessToken);
        const discovery = await mqttDiscoverOperations({ accessToken, accountDN, clientId, vin });
        return json({ success: true, ...discovery });
      } catch (err) {
        if (err instanceof ApiError) return json({ success: false, error: err.message }, err.status);
        return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
      }
    }

    // --- Parse body ---
    let action: unknown;
    try {
      const body = (await request.json()) as { action?: unknown };
      action = body.action;
    } catch {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }
    if (typeof action !== "string" || action.length === 0) {
      return json({ success: false, error: "Missing 'action'" }, 400);
    }

    // --- Unimplemented (climate family / anything not mapped) -> 501 ---
    const operation = OPERATION_MAP[action];
    if (!operation) {
      return json(
        { success: false, error: "Not implemented yet — requires MQTT command channel (see README)." },
        501,
      );
    }

    // --- Execute the full flow ---
    try {
      const { accessToken } = await login(env);
      const vin = await getVin(env, accessToken);
      const pinToken = await verifyPin(env, accessToken, vin);
      await performOperation(env, accessToken, vin, pinToken, operation);
      return json({ success: true, message: `Command '${action}' sent to vehicle.` });
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ success: false, error: err.message }, err.status);
      }
      return json({ success: false, error: `Unexpected error: ${(err as Error).message}` }, 500);
    }
  },
};

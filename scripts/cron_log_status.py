#!/usr/bin/env python3
"""Hourly vehicle-status logger for the GitHub Pages PHEV dashboard.

Logs into Mitsubishi Connect NA (Aeris ATSP), snapshots the vehicle state /
health / mileage, appends the snapshot to an encrypted rolling history file,
and writes it back so the static dashboard can decrypt + render it client-side.

Run by .github/workflows/log-vehicle-status.yml every hour.

Env vars (all required):
    MMC_USERNAME          Mitsubishi Connect account email
    MMC_PASSWORD          Mitsubishi Connect account password
    DASHBOARD_PASSPHRASE  passphrase for the AES-GCM data file (shared with the
                          browser; NEVER commit this)
Optional:
    MMC_TIMEZONE          IANA tz for the mileage/charging endpoints
                          (default: America/Halifax)

Crypto contract (must stay byte-identical to docs/crypto.js):
    key    = PBKDF2HMAC(password=DASHBOARD_PASSPHRASE, salt=16 random bytes,
                        iterations=210000, hash=SHA-256, length=32)
    cipher = AES-256-GCM(key, iv=12 random bytes, plaintext=UTF-8 JSON), no AAD.
    docs/data/history.enc.json = {"iv_b64": "...", "ciphertext_b64": "<ct+tag>"}
    docs/data/meta.json        = {"schema_version":1,"salt_b64":"...",
                                  "iterations":210000,"hash":"SHA-256"}
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# Allow "python scripts/cron_log_status.py" from the repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from mitsubishi_na.api import MitsubishiNAClient  # noqa: E402

# ---------------------------------------------------------------------------
# Constants (must match docs/crypto.js + docs/data/meta.json)
# ---------------------------------------------------------------------------
DATA_DIR = REPO_ROOT / "docs" / "data"
HISTORY_FILE = DATA_DIR / "history.enc.json"
META_FILE = DATA_DIR / "meta.json"

SCHEMA_VERSION = 1
KDF_ITERATIONS = 210000
KDF_HASH = "SHA-256"
KDF_KEY_LEN = 32          # AES-256
KDF_SALT_LEN = 16
GCM_IV_LEN = 12

HOURLY_LIMIT = 720        # ~30 days of hourly snapshots
CHARGING_LOOKBACK_MONTHS = 6
FIRST_MILEAGE_YEAR = 2024
DEFAULT_TIMEZONE = "America/Halifax"


def _now_iso() -> str:
    """UTC timestamp in the exact '...Z' shape the contract uses."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Encryption helpers
# ---------------------------------------------------------------------------
def derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KDF_KEY_LEN,
        salt=salt,
        iterations=KDF_ITERATIONS,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt(key: bytes, plaintext: bytes) -> dict:
    iv = os.urandom(GCM_IV_LEN)
    # AESGCM.encrypt() appends the 16-byte tag, exactly what WebCrypto expects.
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "iv_b64": base64.b64encode(iv).decode("ascii"),
        "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt(key: bytes, payload: dict) -> bytes:
    iv = base64.b64decode(payload["iv_b64"])
    ciphertext = base64.b64decode(payload["ciphertext_b64"])
    return AESGCM(key).decrypt(iv, ciphertext, None)


def load_or_create_salt() -> bytes:
    """Return the persisted salt, or generate + persist a new one (first run)."""
    if META_FILE.exists():
        meta = json.loads(META_FILE.read_text())
        return base64.b64decode(meta["salt_b64"])
    salt = os.urandom(KDF_SALT_LEN)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    META_FILE.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "salt_b64": base64.b64encode(salt).decode("ascii"),
                "iterations": KDF_ITERATIONS,
                "hash": KDF_HASH,
            },
            indent=2,
        )
        + "\n"
    )
    return salt


# ---------------------------------------------------------------------------
# Generic response-parsing helpers
#
# The live Aeris response shapes are only partially known (see README / the
# reverse-engineering notes). Everything below is defensive: unknown fields
# degrade to sensible defaults instead of throwing, so a single unexpected
# key never breaks the whole run.
# ---------------------------------------------------------------------------
def _scalar(value):
    """Unwrap the common {"value": X, "unit": ...} response wrapper."""
    if isinstance(value, dict):
        for k in ("value", "val", "data"):
            if k in value:
                return value[k]
    return value


def _to_float(value, default=None):
    value = _scalar(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value, default=None):
    f = _to_float(value)
    return int(round(f)) if f is not None else default


def _to_bool(value) -> bool:
    value = _scalar(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in (
            "true", "1", "yes", "on", "open", "opened",
            "plugged", "pluggedin", "connected", "charging",
        )
    return False


def _find_key(obj, target):
    """Depth-first search for the first value stored under `target`."""
    if isinstance(obj, dict):
        if target in obj:
            return obj[target]
        for v in obj.values():
            found = _find_key(v, target)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_key(item, target)
            if found is not None:
                return found
    return None


def _first_present(obj, keys):
    for key in keys:
        v = _find_key(obj, key)
        if v is not None:
            return v
    return None


def _norm(text) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def _charging_status(value) -> str:
    value = _scalar(value)
    if isinstance(value, bool):
        return "charging" if value else "not_charging"
    if isinstance(value, (int, float)):
        return "charging" if value else "not_charging"
    s = str(value or "").lower()
    if any(t in s for t in ("charging", "in_progress", "inprogress", "active")) and "not" not in s:
        return "charging"
    return "not_charging"


def _on_off(value) -> str:
    return "on" if _to_bool(value) else "off"


def _open_closed(value) -> str:
    v = _scalar(value)
    if isinstance(v, str) and v.strip().lower() in ("ajar", "open", "opened"):
        return "open"
    return "open" if _to_bool(v) else "closed"


# door location string -> canonical dashboard key
_DOOR_ALIASES = {
    "frontleft": "front_left", "fl": "front_left", "driverfront": "front_left",
    "leftfront": "front_left", "frontleftdoor": "front_left",
    "frontright": "front_right", "fr": "front_right", "passengerfront": "front_right",
    "rightfront": "front_right", "frontrightdoor": "front_right",
    "rearleft": "rear_left", "rl": "rear_left", "leftrear": "rear_left",
    "driverrear": "rear_left", "rearleftdoor": "rear_left",
    "rearright": "rear_right", "rr": "rear_right", "rightrear": "rear_right",
    "passengerrear": "rear_right", "rearrightdoor": "rear_right",
    "hood": "hood", "bonnet": "hood", "frunk": "hood", "enginehood": "hood",
    "trunk": "trunk", "tailgate": "trunk", "boot": "trunk", "liftgate": "trunk",
    "hatch": "trunk", "rearhatch": "trunk",
}


def _entry_name(entry: dict) -> str:
    for k in ("location", "position", "doorLocation", "name", "door",
              "type", "id", "lightLocation", "light"):
        v = entry.get(k)
        if isinstance(v, str):
            return v
    return ""


def _entry_state(entry: dict):
    for k in ("status", "state", "doorStatus", "lightStatus", "open", "on", "value"):
        if k in entry:
            return entry[k]
    return None


def parse_doors(state: dict) -> dict:
    """Map doorStatus.doors[] onto the six canonical door keys."""
    doors = {
        "front_left": "closed", "front_right": "closed",
        "rear_left": "closed", "rear_right": "closed",
        "hood": "closed", "trunk": "closed",
    }
    door_list = _first_present(state, ["doors"])
    if isinstance(_find_key(state, "doorStatus"), dict):
        door_list = _find_key(_find_key(state, "doorStatus"), "doors") or door_list
    if not isinstance(door_list, list):
        return doors
    for entry in door_list:
        if not isinstance(entry, dict):
            continue
        canonical = _DOOR_ALIASES.get(_norm(_entry_name(entry)))
        if canonical:
            doors[canonical] = _open_closed(_entry_state(entry))
    return doors


def parse_headlights(state: dict) -> str:
    lights = None
    light_status = _find_key(state, "lightStatus")
    if isinstance(light_status, dict):
        lights = _find_key(light_status, "lights")
    if lights is None:
        lights = _find_key(state, "lights")
    if isinstance(lights, list):
        for entry in lights:
            if isinstance(entry, dict) and "head" in _norm(_entry_name(entry)):
                return _on_off(_entry_state(entry))
    # Fallback: a flat headlight field somewhere in the payload.
    flat = _first_present(state, ["headlightStatus", "headLampStatus", "headlights"])
    return _on_off(flat) if flat is not None else "off"


def parse_warnings(health: dict) -> dict:
    """Best-effort VHR warning flags. Only *warning/alert/lamp* style keys are
    consulted so a raw sensor reading can't masquerade as an active warning."""
    diag = _latest_vhr_diagnostic(health)
    return {
        "brake": _to_bool(_first_present(diag, [
            "brakeFluidWarning", "brakeWarning", "brakeWarningLamp", "brakeAlert",
        ])),
        "engine_oil": _to_bool(_first_present(diag, [
            "engineOilWarning", "oilWarning", "engineOilLevelWarning",
            "oilPressureWarning", "oilLevelWarning",
        ])),
        "tire_pressure": _to_bool(_first_present(diag, [
            "tirePressureWarning", "tyrePressureWarning", "tpmsWarning",
            "lowTirePressureWarning", "tpmsAlert",
        ])),
        "mil": _to_bool(_first_present(diag, [
            "malfunctionIndicatorLamp", "milStatus", "mil",
            "checkEngineWarning", "checkEngine",
        ])),
    }


def _latest_vhr_diagnostic(health: dict) -> dict:
    """Return the newest VHR entry's diagnostic block (or {})."""
    if not isinstance(health, dict):
        return {}
    vhr = health.get("vhr")
    if isinstance(vhr, list) and vhr:
        def _ts(e):
            return e.get("ts", "") if isinstance(e, dict) else ""
        newest = max(vhr, key=_ts)
        diag = _find_key(newest, "diagnostic")
        if isinstance(diag, dict):
            return diag
        return newest if isinstance(newest, dict) else {}
    diag = _find_key(health, "diagnostic")
    return diag if isinstance(diag, dict) else health


# ---------------------------------------------------------------------------
# Snapshot builder
# ---------------------------------------------------------------------------
def _extract_range(value):
    """cruisingRangeFirst/Second come back as [{"range": "X"}, {"engineType": "Y"}] —
    pull the numeric range out of whichever list item actually has a "range" key."""
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and "range" in item:
                return item["range"]
        return None
    return value


def build_latest(state: dict, health: dict, ts: str) -> dict:
    charging = _find_key(state, "chargingControl") or state

    battery = _to_int(_first_present(charging, ["hvBatteryLife"]), default=None)
    # Confirmed against a live response: cruisingRangeFirst = gasoline, cruisingRangeSecond = electric.
    gas_range = _to_int(_extract_range(_first_present(charging, ["cruisingRangeFirst"])), default=None)
    ev_range = _to_int(_extract_range(_first_present(charging, ["cruisingRangeSecond"])), default=None)

    # The API reports combined range directly (cruisingRangeCombined) — it is NOT simply
    # ev_range + gas_range (confirmed mismatch: 62 + 442 = 504 != the real 467).
    total_range = _to_int(_first_present(charging, ["cruisingRangeCombined"]), default=None)
    if total_range is None and (ev_range is not None or gas_range is not None):
        total_range = (ev_range or 0) + (gas_range or 0)

    odometer = _to_int(_first_present(state, [
        "odo", "odometer", "odometerValue", "totalMileage", "mileage",
    ]))
    if odometer is None:
        odometer = _to_int(_first_present(_latest_vhr_diagnostic(health), ["odo", "odometer"]))

    return {
        "ts": ts,
        "battery_pct": battery if battery is not None else 0,
        "ev_range_km": ev_range if ev_range is not None else 0,
        "gas_range_km": gas_range if gas_range is not None else 0,
        "total_range_km": total_range if total_range is not None else 0,
        "odometer_km": odometer if odometer is not None else 0,
        "charging_status": _charging_status(_first_present(charging, ["hvChargingStatus"])),
        "plugged_in": _to_bool(_first_present(charging, ["hvChargingPlugStatus"])),
        "time_to_full_charge_min": _to_int(_first_present(charging, ["hvTimeToFullCharge"]), default=0),
        "ignition_on": _to_bool(_first_present(state, [
            "ignitionStatus", "ignition", "ignitionState", "engineStatus",
        ])),
        "speed_kmh": _to_int(_first_present(state, ["speed", "vehicleSpeed", "spd"]), default=0),
        "location": {
            "lat": _to_float(_first_present(state, ["lat", "latitude"])),
            "lon": _to_float(_first_present(state, ["lon", "lng", "longitude"])),
        },
        "doors": parse_doors(state),
        "headlights": parse_headlights(state),
        "warnings": parse_warnings(health),
    }


def compact_snapshot(latest: dict) -> dict:
    """The trimmed shape stored in hourly_history (contract)."""
    return {
        "ts": latest["ts"],
        "battery_pct": latest["battery_pct"],
        "odometer_km": latest["odometer_km"],
        "ev_range_km": latest["ev_range_km"],
        "gas_range_km": latest["gas_range_km"],
        "charging_status": latest["charging_status"],
        "ignition_on": latest["ignition_on"],
    }


def build_vehicle(vehicle: dict, details: dict) -> dict:
    sources = [vehicle or {}, details or {}]

    def pick(keys, default=""):
        for src in sources:
            v = _first_present(src, keys)
            if v not in (None, ""):
                return v
        return default

    return {
        "nickname": pick(["nickname", "vehicleNickname", "nickName"]),
        "model": pick(["modelName", "model", "modelDescription", "carlineName"]),
        "year": str(pick(["modelYear", "year", "vehicleYear"], default="")),
        "exterior_color": pick(["exteriorColor", "extColor", "exteriorColour",
                                "color", "paintColor"]),
    }


# ---------------------------------------------------------------------------
# Mileage (monthly_distance) parsing
# ---------------------------------------------------------------------------
_MONTHLY_LIST_KEYS = (
    "months", "monthly", "monthlyData", "monthlyMileage", "mileage",
    "mileageData", "data", "results", "items", "list", "details", "history",
)


def _find_monthly_list(obj):
    if isinstance(obj, dict):
        for key in _MONTHLY_LIST_KEYS:
            v = obj.get(key)
            if isinstance(v, list) and any(isinstance(x, dict) for x in v):
                return v
        for v in obj.values():
            found = _find_monthly_list(v)
            if found:
                return found
    elif isinstance(obj, list):
        if any(
            isinstance(x, dict)
            and _first_present(x, ["distance", "distanceMi", "miles", "mileage", "month"]) is not None
            for x in obj
        ):
            return obj
        for x in obj:
            found = _find_monthly_list(x)
            if found:
                return found
    return None


def extract_monthly(yearly: dict, year: int) -> list:
    """Best-effort: pull {period, distance_mi, duration_min} rows from a yearly
    mileage response. Exact keys are unverified against a live response."""
    rows = []
    entries = _find_monthly_list(yearly) or []
    for idx, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            continue
        month = _to_int(_first_present(entry, ["month", "monthNumber", "mon", "idx"]))
        if not month or month < 1 or month > 12:
            month = idx  # positional fallback (assumes Jan..Dec ordering)
        distance = _to_float(_first_present(entry, [
            "distanceMi", "distance_mi", "distance", "miles", "mileage",
            "totalDistance", "dist",
        ]))
        duration = _to_int(_first_present(entry, [
            "durationMin", "duration_min", "duration", "minutes", "drivingTime",
            "durationMinutes", "totalTime", "time",
        ]))
        if distance is None and duration is None:
            continue
        rows.append({
            "period": f"{year}-{month:02d}",
            "distance_mi": round(distance, 2) if distance is not None else 0.0,
            "duration_min": duration if duration is not None else 0,
        })
    return rows


def merge_monthly(existing: list, incoming: list) -> list:
    """Dedupe by period, newest write wins, sorted chronologically."""
    by_period = {}
    for row in existing:
        if isinstance(row, dict) and row.get("period"):
            by_period[row["period"]] = row
    for row in incoming:
        by_period[row["period"]] = row
    return [by_period[p] for p in sorted(by_period)]


def _recent_months(count: int):
    """Yield (year, month) for the last `count` months, newest first."""
    cursor = datetime.now(timezone.utc)
    seen = []
    for _ in range(count):
        seen.append((cursor.year, cursor.month))
        # step back one month
        first = cursor.replace(day=1)
        cursor = first - timedelta(days=1)
    return seen


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
async def collect(client: MitsubishiNAClient, timezone_name: str) -> dict:
    if not await client.async_login():
        raise SystemExit("Login failed — check MMC_USERNAME / MMC_PASSWORD.")

    vehicles = await client.async_get_vehicles()
    if not vehicles:
        raise SystemExit("No vehicles registered to this account.")
    vehicle = vehicles[0]
    vin = vehicle["vin"]

    details = await client.async_get_vehicle_details(vin) or {}
    state = await client.async_get_vehicle_state(vin) or {}
    health = await client.async_get_vehicle_health(vin) or {}

    ts = _now_iso()
    latest = build_latest(state, health, ts)

    # Mileage history: every year from 2024 through the current year.
    # The metrics endpoints take {vehicle_id}; VIN works in practice, with the
    # internal vehicleContextFk as a fallback (see scripts/test_na_mileage.py).
    vehicle_context_fk = _find_key(details, "vehicleContextFk")
    current_year = datetime.now(timezone.utc).year
    monthly_rows = []
    for year in range(FIRST_MILEAGE_YEAR, current_year + 1):
        yearly = None
        try:
            yearly = await client.async_get_mileage_yearly(vin, year, timezone_name)
            if not yearly and vehicle_context_fk:
                yearly = await client.async_get_mileage_yearly(
                    str(vehicle_context_fk), year, timezone_name
                )
        except Exception as err:  # noqa: BLE001 - best-effort
            print(f"mileage {year} failed: {err}", file=sys.stderr)
        if yearly:
            monthly_rows.extend(extract_monthly(yearly, year))

    # Charging history for the last 6 months (best-effort; not charted, kept for
    # completeness under an additive key the frontend ignores).
    charging_rows = []
    for year, month in _recent_months(CHARGING_LOOKBACK_MONTHS):
        try:
            hist = await client.async_get_charging_history(vin, year, month, timezone_name)
        except Exception as err:  # noqa: BLE001 - best-effort
            print(f"charging {year}-{month:02d} failed: {err}", file=sys.stderr)
            continue
        if hist:
            charging_rows.append({
                "period": f"{year}-{month:02d}",
                "sessions": _to_int(_first_present(hist, [
                    "sessionCount", "sessions", "count", "numberOfSessions",
                ]), default=None),
                "energy_kwh": _to_float(_first_present(hist, [
                    "totalEnergy", "energyKwh", "energy", "kwh", "totalKwh",
                ])),
            })

    return {
        "vin": vin,
        "vehicle": build_vehicle(vehicle, details),
        "latest": latest,
        "monthly_rows": monthly_rows,
        "charging_rows": charging_rows,
    }


def assemble(prior: dict, collected: dict, generated_at: str) -> dict:
    prior = prior or {}
    hourly = list(prior.get("hourly_history", []))
    hourly.append(compact_snapshot(collected["latest"]))
    hourly = hourly[-HOURLY_LIMIT:]

    monthly = merge_monthly(
        prior.get("monthly_distance", []), collected["monthly_rows"]
    )

    doc = {
        "generated_at": generated_at,
        "vin": collected["vin"],
        "vehicle": collected["vehicle"],
        "latest": collected["latest"],
        "hourly_history": hourly,
        "monthly_distance": monthly,
    }
    # Additive, contract-compatible: the browser decrypter ignores unknown keys.
    if collected["charging_rows"]:
        doc["charging_history"] = collected["charging_rows"]
    return doc


async def main() -> None:
    username = os.environ.get("MMC_USERNAME")
    password = os.environ.get("MMC_PASSWORD")
    passphrase = os.environ.get("DASHBOARD_PASSPHRASE")
    timezone_name = os.environ.get("MMC_TIMEZONE", DEFAULT_TIMEZONE)

    missing = [
        name for name, val in [
            ("MMC_USERNAME", username),
            ("MMC_PASSWORD", password),
            ("DASHBOARD_PASSPHRASE", passphrase),
        ] if not val
    ]
    if missing:
        raise SystemExit(f"Missing required env var(s): {', '.join(missing)}")

    salt = load_or_create_salt()
    key = derive_key(passphrase, salt)

    prior = {}
    if HISTORY_FILE.exists():
        # Deliberately let a decrypt failure raise: a rotated/wrong passphrase
        # must fail loudly rather than silently clobbering good history with a
        # differently-keyed file.
        prior = json.loads(decrypt(key, json.loads(HISTORY_FILE.read_text())).decode("utf-8"))

    client = MitsubishiNAClient(username, password)
    try:
        collected = await collect(client, timezone_name)
    finally:
        await client.async_close()

    doc = assemble(prior, collected, _now_iso())
    plaintext = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(encrypt(key, plaintext), indent=2) + "\n")

    print(
        f"Logged {doc['vin']} @ {doc['generated_at']}: "
        f"battery={doc['latest']['battery_pct']}% "
        f"odo={doc['latest']['odometer_km']} "
        f"hourly={len(doc['hourly_history'])} "
        f"months={len(doc['monthly_distance'])}"
    )


if __name__ == "__main__":
    asyncio.run(main())

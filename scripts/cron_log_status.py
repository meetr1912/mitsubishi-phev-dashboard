#!/usr/bin/env python3
"""Hourly vehicle-status logger for the GitHub Pages PHEV dashboard.

Logs into Mitsubishi Connect NA (Aeris ATSP), snapshots the vehicle state /
health / mileage, appends the snapshot to an encrypted rolling history file,
maintains hourly -> daily -> monthly -> yearly compounding rollups, and writes
everything back so the static dashboard can decrypt + render it client-side.

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

Plaintext document shape (single compounding file — see the storage schema
design). All keys additive vs. the previous schema; the browser decrypter
ignores unknown keys, so crypto.js is unchanged. app.js must be updated by the
frontend agent to render the richer `hourly_history` entries and the new
`rollups` object:
    {
      "generated_at": "...Z",
      "vin": "...",
      "vehicle": {...},
      "latest": {<full hourly snapshot>},
      "hourly_history": [<full snapshot>, ...],   # ~90d, time-pruned
      "rollups": {"daily": [...], "monthly": [...], "yearly": [...]},
      "monthly_distance": [{"period","distance_mi","duration_min",...}, ...],
      "charging_history": [...]                    # optional
    }
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
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

# Retention (per storage schema design). Hourly + daily are time-pruned so a
# missed run never distorts the window; monthly + yearly are kept forever.
HOURLY_RETENTION_DAYS = 90
DAILY_RETENTION_DAYS = 730
CHARGING_LOOKBACK_MONTHS = 6
FIRST_MILEAGE_YEAR = 2024
DEFAULT_TIMEZONE = "America/Halifax"

KM_PER_MILE = 1.609344

# Warning flags carried through every rollup tier.
WARNING_KEYS = ("brake", "engine_oil", "tire_pressure", "mil", "abs", "airbag")
# Tire position index (VHR tireStatus.tires[].position.value) -> canonical key.
_TIRE_POS = {0: "front_left", 1: "front_right", 2: "rear_left", 3: "rear_right"}


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


def _nums(values):
    """Filter an iterable to real (non-bool) numbers."""
    return [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]


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


def _latest_vhr_diagnostic(health: dict) -> dict:
    """Return the newest VHR entry's diagnostic block (or {}).

    Live VHR entries look like {"ts": ..., "dt": {"diagnostic": {...}}} — the
    DFS below reaches `diagnostic` regardless of the exact nesting.
    """
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


def parse_warnings(health: dict) -> dict:
    """Best-effort VHR warning flags. Only *warning/alert/lamp* style keys are
    consulted so a raw sensor reading can't masquerade as an active warning.
    Absent keys default to False."""
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
        "abs": _to_bool(_first_present(diag, [
            "absWarning", "antiLockBrakeWarning", "absWarningLamp", "absAlert",
        ])),
        "airbag": _to_bool(_first_present(diag, [
            "airbagWarning", "srsWarning", "airbagWarningLamp", "srsWarningLamp",
        ])),
    }


def parse_tires(health: dict) -> dict:
    """VHR tireStatus.tires[] -> {front_left, front_right, rear_left, rear_right}
    in bar (kPa / 100, 2dp). Mirrors the EU _parse_vsr precedent (api.py:744)."""
    diag = _latest_vhr_diagnostic(health)
    result = {"front_left": None, "front_right": None, "rear_left": None, "rear_right": None}
    tire_status = _find_key(diag, "tireStatus")
    tires = _find_key(tire_status, "tires") if isinstance(tire_status, dict) else None
    if tires is None:
        tires = _find_key(diag, "tires")
    if not isinstance(tires, list):
        return result
    for tire in tires:
        if not isinstance(tire, dict):
            continue
        pos = _to_int(_first_present(tire, ["position"]))
        kpa = _to_float(_first_present(tire, [
            "pressureValue", "pressure", "pressureKpa", "tirePressure",
        ]))
        key = _TIRE_POS.get(pos)
        if key and kpa is not None:
            result[key] = round(kpa / 100, 2)
    return result


def parse_firmware(health: dict):
    """VHR firmware/software version string, else None."""
    v = _scalar(_first_present(health, [
        "firmwareVersion", "swVersion", "softwareVersion", "fwVersion",
        "moduleFirmwareVersion",
    ]))
    return str(v) if v not in (None, "") else None


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
    """Full hourly snapshot (also stored verbatim in hourly_history)."""
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
        "tire_pressure_bar": parse_tires(health),
        "warnings": parse_warnings(health),
        "firmware_version": parse_firmware(health),
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
# Mileage (monthly_distance) parsing — reliable all-time mileage-tracker source
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
    mileage response, plus optional ev/gas split when the response carries it.
    Exact keys are unverified against a live response."""
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
        # Optional EV/gas split (mileage tracker is described as an EV-vs-gas
        # breakdown; exact field names unverified, so this is captured
        # defensively and simply omitted when absent).
        ev = _to_float(_first_present(entry, [
            "evDistanceMi", "evDistance", "electricDistance", "evMiles", "ev",
        ]))
        gas = _to_float(_first_present(entry, [
            "gasDistanceMi", "gasDistance", "fuelDistance", "iceDistance",
            "gasMiles", "gas",
        ]))
        if distance is None and duration is None:
            continue
        row = {
            "period": f"{year}-{month:02d}",
            "distance_mi": round(distance, 2) if distance is not None else 0.0,
            "duration_min": duration if duration is not None else 0,
        }
        if ev is not None:
            row["ev_distance_mi"] = round(ev, 2)
        if gas is not None:
            row["gas_distance_mi"] = round(gas, 2)
        rows.append(row)
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
# Compounding rollups: hourly -> daily -> monthly -> yearly
#
# Every tier is a pure function of the tier below, keyed by date/period/year and
# applied as an idempotent upsert. A missed run self-heals on the next run; a
# persisted rollup outlives its pruned source (we only recompute a period whose
# lower-tier source is still fully retained, otherwise we keep the frozen value).
# ---------------------------------------------------------------------------
def _empty_warnings() -> dict:
    return {k: False for k in WARNING_KEYS}


def _or_warnings(acc: dict, w) -> None:
    if isinstance(w, dict):
        for k in WARNING_KEYS:
            if w.get(k):
                acc[k] = True


def _date_of(ts: str) -> str:
    """UTC date 'YYYY-MM-DD' from a '...Z' timestamp (already UTC)."""
    return ts[:10]


def compute_daily_rollups(hourly: list) -> list:
    """One rollup per UTC date present in `hourly`. Charging sessions are counted
    as rising edges across the whole time-ordered stream, so an edge at the first
    sample of a day (prior day ended not-charging) is credited to the new day."""
    samples = sorted(
        (s for s in hourly if isinstance(s, dict) and s.get("ts")),
        key=lambda s: s["ts"],
    )

    # Rising charging edges, bucketed by the date of the edge sample.
    edges_by_date: dict[str, int] = {}
    prev_charging = False
    for s in samples:
        cur = s.get("charging_status") == "charging"
        if cur and not prev_charging:
            d = _date_of(s["ts"])
            edges_by_date[d] = edges_by_date.get(d, 0) + 1
        prev_charging = cur

    by_date: dict[str, list] = {}
    for s in samples:
        by_date.setdefault(_date_of(s["ts"]), []).append(s)

    return [
        _daily_rollup(date, by_date[date], edges_by_date.get(date, 0))
        for date in sorted(by_date)
    ]


def _daily_rollup(date: str, samples: list, charging_sessions: int) -> dict:
    batt = _nums(s.get("battery_pct") for s in samples)
    odo_start = next(
        (s.get("odometer_km") for s in samples
         if isinstance(s.get("odometer_km"), (int, float))), None,
    )
    odo_end = next(
        (s.get("odometer_km") for s in reversed(samples)
         if isinstance(s.get("odometer_km"), (int, float))), None,
    )
    distance = max(0, odo_end - odo_start) if (odo_start is not None and odo_end is not None) else 0

    warnings_any = _empty_warnings()
    plugged_any = False
    tire_vals: list = []
    firmware = None
    for s in samples:
        _or_warnings(warnings_any, s.get("warnings"))
        if s.get("plugged_in"):
            plugged_any = True
        tp = s.get("tire_pressure_bar")
        if isinstance(tp, dict):
            tire_vals.extend(_nums(tp.values()))
        fw = s.get("firmware_version")
        if fw:
            firmware = fw

    batt_end = samples[-1].get("battery_pct") if samples else None
    return {
        "date": date,
        "samples": len(samples),
        "battery_pct": {
            "min": min(batt) if batt else None,
            "max": max(batt) if batt else None,
            "end": batt_end,
        },
        "odometer_km": {"start": odo_start, "end": odo_end, "distance_km": distance},
        "charging_sessions": charging_sessions,
        "plugged_in_any": plugged_any,
        "warnings_any": warnings_any,
        "tire_pressure_bar": {
            "min": round(min(tire_vals), 2) if tire_vals else None,
            "max": round(max(tire_vals), 2) if tire_vals else None,
        },
        "firmware_version": firmware,
    }


def compute_monthly_rollups(daily: list, monthly_distance: list) -> list:
    """One rollup per YYYY-MM present in `daily`, reconciled against the
    mileage-tracker (monthly_distance) which wins whenever it has the period."""
    mt = {
        row["period"]: row
        for row in (monthly_distance or [])
        if isinstance(row, dict) and row.get("period")
    }
    by_month: dict[str, list] = {}
    for d in daily:
        by_month.setdefault(d["date"][:7], []).append(d)
    return [
        _monthly_rollup(period, sorted(by_month[period], key=lambda x: x["date"]), mt.get(period))
        for period in sorted(by_month)
    ]


def _monthly_rollup(period: str, days: list, mt_row) -> dict:
    odo_est = sum((d["odometer_km"].get("distance_km") or 0) for d in days)
    odo_end = None
    for d in days:  # days sorted ascending -> last non-null wins
        end = d["odometer_km"].get("end")
        if end is not None:
            odo_end = end
    batt_mins = _nums(d["battery_pct"]["min"] for d in days)
    batt_maxs = _nums(d["battery_pct"]["max"] for d in days)
    charging = sum(d.get("charging_sessions", 0) for d in days)
    warnings_any = _empty_warnings()
    for d in days:
        _or_warnings(warnings_any, d.get("warnings_any"))

    mt_mi = _to_float(mt_row.get("distance_mi")) if isinstance(mt_row, dict) else None
    rollup = {"period": period, "days": len(days)}
    if mt_mi is not None:
        # Mileage tracker wins; odometer delta kept only as an estimate.
        rollup["distance_km"] = round(mt_mi * KM_PER_MILE, 1)
        rollup["distance_source"] = "mileage_tracker"
    else:
        rollup["distance_km"] = odo_est
        rollup["distance_source"] = "odometer_delta"
    rollup["distance_km_odo_est"] = odo_est
    rollup["odometer_km_end"] = odo_end
    rollup["battery_pct"] = {
        "min": min(batt_mins) if batt_mins else None,
        "max": max(batt_maxs) if batt_maxs else None,
    }
    rollup["charging_sessions"] = charging
    rollup["warnings_any"] = warnings_any
    # EV/gas split only from the mileage tracker (never derived from odometer).
    if isinstance(mt_row, dict):
        ev = _to_float(mt_row.get("ev_distance_mi"))
        gas = _to_float(mt_row.get("gas_distance_mi"))
        if ev is not None:
            rollup["ev_distance_km"] = round(ev * KM_PER_MILE, 1)
        if gas is not None:
            rollup["gas_distance_km"] = round(gas * KM_PER_MILE, 1)
    return rollup


def compute_yearly_rollups(monthly: list) -> list:
    by_year: dict[str, list] = {}
    for m in monthly:
        by_year.setdefault(m["period"][:4], []).append(m)
    return [
        _yearly_rollup(int(year), sorted(by_year[year], key=lambda x: x["period"]))
        for year in sorted(by_year)
    ]


def _yearly_rollup(year: int, months: list) -> dict:
    distance = round(sum((m.get("distance_km") or 0) for m in months), 1)
    sources = {m.get("distance_source") for m in months if m.get("distance_source")}
    if len(sources) == 1:
        source = next(iter(sources))
    elif sources:
        source = "mixed"
    else:
        source = "odometer_delta"
    odo_end = None
    for m in months:  # sorted ascending by period
        if m.get("odometer_km_end") is not None:
            odo_end = m["odometer_km_end"]
    charging = sum(m.get("charging_sessions", 0) for m in months)
    batt_mins = _nums(m["battery_pct"]["min"] for m in months)
    batt_maxs = _nums(m["battery_pct"]["max"] for m in months)
    warnings_any = _empty_warnings()
    for m in months:
        _or_warnings(warnings_any, m.get("warnings_any"))
    ev = _nums(m.get("ev_distance_km") for m in months)
    gas = _nums(m.get("gas_distance_km") for m in months)

    rollup = {
        "year": year,
        "distance_km": distance,
        "distance_source": source,
        "odometer_km_end": odo_end,
        "charging_sessions": charging,
        "battery_pct": {
            "min": min(batt_mins) if batt_mins else None,
            "max": max(batt_maxs) if batt_maxs else None,
        },
        "warnings_any": warnings_any,
    }
    if ev:
        rollup["ev_distance_km"] = round(sum(ev), 1)
    if gas:
        rollup["gas_distance_km"] = round(sum(gas), 1)
    return rollup


def update_rollups(prior_rollups: dict, hourly: list, monthly_distance: list,
                   now: datetime) -> dict:
    """Idempotent hourly -> daily -> monthly -> yearly upsert + retention.

    `hourly` must already be time-pruned to HOURLY_RETENTION_DAYS so the
    completeness guards below line up with the actual retained samples.
    """
    prior_rollups = prior_rollups or {}
    today_str = now.strftime("%Y-%m-%d")
    hourly_cutoff = (now - timedelta(days=HOURLY_RETENTION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    daily_cutoff = (now - timedelta(days=DAILY_RETENTION_DAYS)).strftime("%Y-%m-%d")

    daily_by_date = {
        r["date"]: r for r in prior_rollups.get("daily", [])
        if isinstance(r, dict) and r.get("date")
    }
    monthly_by_period = {
        r["period"]: r for r in prior_rollups.get("monthly", [])
        if isinstance(r, dict) and r.get("period")
    }
    yearly_by_year = {
        r["year"]: r for r in prior_rollups.get("yearly", [])
        if isinstance(r, dict) and "year" in r
    }

    # --- Daily: recompute complete (< today) & fully-retained days only. ---
    # Today itself is deliberately never written into daily_by_date (the cache
    # that persists across runs) so a partial day can never get frozen in as
    # if it were final. But surfacing NOTHING for today until midnight UTC
    # meant every chart (daily, and monthly/yearly which are built from daily)
    # stayed empty for a day's worth of every fresh deployment. today_partial
    # is recomputed fresh from `hourly` every run and appended below —
    # never cached, never subject to the freeze/retention logic above.
    today_partial = None
    for r in compute_daily_rollups(hourly):
        d = r["date"]
        if d >= today_str:
            if d == today_str:
                today_partial = dict(r, partial=True)
            continue  # today is still accumulating
        if f"{d}T00:00:00Z" < hourly_cutoff:
            continue  # straddles the hourly-prune boundary -> keep frozen value
        daily_by_date[d] = r
    # Prune daily rollups to their retention window.
    daily_by_date = {d: r for d, r in daily_by_date.items() if d >= daily_cutoff}
    daily_list = [daily_by_date[d] for d in sorted(daily_by_date)]
    if today_partial is not None:
        daily_list.append(today_partial)

    # --- Monthly: recompute months whose daily source is fully retained. ---
    for r in compute_monthly_rollups(daily_list, monthly_distance):
        if f"{r['period']}-01" < daily_cutoff:
            continue  # some days pruned -> keep the last full value
        monthly_by_period[r["period"]] = r
    monthly_list = [monthly_by_period[p] for p in sorted(monthly_by_period)]

    # --- Yearly: recompute from monthly (monthly is kept forever). ---
    for r in compute_yearly_rollups(monthly_list):
        yearly_by_year[r["year"]] = r
    yearly_list = [yearly_by_year[y] for y in sorted(yearly_by_year)]

    return {"daily": daily_list, "monthly": monthly_list, "yearly": yearly_list}


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

    # Event feed. Best-effort: an account without notifications, or a shape we
    # fail to recognise, must not take down the whole hourly log.
    event_rows = []
    try:
        notifications = await client.async_get_notifications(vin)
        if notifications:
            event_rows = parse_events(notifications)
    except Exception as err:  # noqa: BLE001 - best-effort
        print(f"notifications failed: {err}", file=sys.stderr)

    # Current settings groups, so the dashboard can show what the car believes
    # is configured rather than only what we last asked it to do. All read-only.
    settings = {}
    for operation in ("remoteAC", "chargingControl", "climateControl"):
        try:
            got = await client.async_get_parental_alert(vin, operation)
        except Exception as err:  # noqa: BLE001 - best-effort
            print(f"settings {operation} failed: {err}", file=sys.stderr)
            continue
        if got:
            settings[operation] = got

    return {
        "vin": vin,
        "vehicle": build_vehicle(vehicle, details),
        "latest": latest,
        "monthly_rows": monthly_rows,
        "charging_rows": charging_rows,
        "event_rows": event_rows,
        "settings": settings,
    }


# ---------------------------------------------------------------------------
# Event feed
#
# The notification endpoint is the only source of events the backend generated
# on its own (charge start/stop, alerts, curfew and geofence trips, completed
# remote operations). EP_RO_STATUS can only be read back for an eventId you
# already hold, so it cannot tell us about activity this logger did not itself
# initiate -- polling notifications can.
#
# The exact response shape is NOT confirmed against a live account, so parsing
# is deliberately best-effort and every record keeps its untouched `raw`
# payload. If the field mapping below guesses wrong we still lose nothing, and
# the mapping can be corrected later against real stored data.
# ---------------------------------------------------------------------------

EVENT_RETENTION_DAYS = 365
MAX_EVENTS = 500

_EVENT_LIST_KEYS = ("notifications", "events", "items", "results", "content", "data", "list")


def _find_event_list(obj) -> list:
    """First list-of-dicts found under any plausible container key."""
    if isinstance(obj, list):
        return [e for e in obj if isinstance(e, dict)]
    if not isinstance(obj, dict):
        return []
    for key in _EVENT_LIST_KEYS:
        val = obj.get(key)
        if isinstance(val, list) and any(isinstance(e, dict) for e in val):
            return [e for e in val if isinstance(e, dict)]
    # Fall back to a recursive search for the first qualifying list.
    for val in obj.values():
        found = _find_event_list(val)
        if found:
            return found
    return []


def _event_ts(entry: dict) -> str:
    """Best-effort ISO-8601 UTC timestamp for one event."""
    raw = _first_present(entry, [
        "ts", "timestamp", "createdAt", "creationTime", "eventTime",
        "notificationTime", "statusTimestamp", "time", "date",
    ])
    val = _scalar(raw)
    if isinstance(val, (int, float)):
        # Epoch, in seconds or milliseconds depending on magnitude.
        seconds = val / 1000 if val > 1e11 else val
        try:
            return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            return ""
    return str(val) if val is not None else ""


def _event_id(entry: dict, ts: str) -> str:
    """Stable identity for dedup, synthesised when the feed gives no id."""
    explicit = _scalar(_first_present(entry, [
        "id", "eventId", "event_id", "notificationId", "messageId", "uuid",
    ]))
    if explicit not in (None, ""):
        return str(explicit)
    # No id: hash the content so the same event dedups across runs.
    blob = json.dumps(entry, sort_keys=True, default=str)
    return "syn-" + hashlib.sha256((ts + blob).encode("utf-8")).hexdigest()[:16]


def parse_events(raw) -> list:
    """Normalise the notification feed into flat, dedupable event records."""
    rows = []
    for entry in _find_event_list(raw):
        ts = _event_ts(entry)
        rows.append({
            "id": _event_id(entry, ts),
            "ts": ts,
            "type": _scalar(_first_present(entry, [
                "type", "eventType", "notificationType", "category", "serviceType",
            ])),
            "operation": _scalar(_first_present(entry, ["operation", "operationType", "roName"])),
            "status": _scalar(_first_present(entry, ["status", "result", "outcome", "state"])),
            "reason_code": _scalar(_first_present(entry, ["reasonCode", "responseCode", "code"])),
            "title": _scalar(_first_present(entry, ["title", "subject", "heading", "name"])),
            "message": _scalar(_first_present(entry, ["message", "body", "text", "description"])),
            # Kept verbatim: the mapping above is unverified, so this is the
            # ground truth we can re-parse later without re-fetching.
            "raw": entry,
        })
    return rows


def merge_events(existing: list, incoming: list, now: datetime) -> list:
    """Upsert by id, newest first, pruned by age and hard count cap."""
    by_id = {}
    for row in (existing or []):
        if isinstance(row, dict) and row.get("id"):
            by_id[row["id"]] = row
    for row in incoming:
        if row.get("id"):
            # Incoming wins: a pending event may since have reached a terminal
            # status, and that later record is the one worth keeping.
            by_id[row["id"]] = row

    cutoff = (now - timedelta(days=EVENT_RETENTION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = [
        r for r in by_id.values()
        # Keep events with an unparseable ts rather than silently dropping them.
        if not r.get("ts") or r["ts"] >= cutoff
    ]
    rows.sort(key=lambda r: r.get("ts") or "", reverse=True)
    return rows[:MAX_EVENTS]


def assemble(prior: dict, collected: dict, generated_at: str,
             now: datetime | None = None) -> dict:
    prior = prior or {}
    now = now or datetime.now(timezone.utc)

    # Full snapshot is stored verbatim in hourly_history (== latest shape).
    hourly = list(prior.get("hourly_history", []))
    hourly.append(collected["latest"])
    # Time-based pruning tolerates missed/delayed runs (a fixed count would not).
    hourly_cutoff = (now - timedelta(days=HOURLY_RETENTION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    hourly = [
        s for s in hourly
        if isinstance(s, dict) and s.get("ts", "") >= hourly_cutoff
    ]

    monthly_distance = merge_monthly(
        prior.get("monthly_distance", []), collected["monthly_rows"]
    )

    rollups = update_rollups(prior.get("rollups", {}), hourly, monthly_distance, now)

    events = merge_events(prior.get("events", []), collected.get("event_rows", []), now)

    doc = {
        "generated_at": generated_at,
        "vin": collected["vin"],
        "vehicle": collected["vehicle"],
        "latest": collected["latest"],
        "hourly_history": hourly,
        "rollups": rollups,
        "monthly_distance": monthly_distance,
        "events": events,
    }
    # Additive, contract-compatible: the browser decrypter ignores unknown keys.
    if collected["charging_rows"]:
        doc["charging_history"] = collected["charging_rows"]
    if collected.get("settings"):
        doc["settings"] = collected["settings"]
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

    rollups = doc["rollups"]
    print(
        f"Logged {doc['vin']} @ {doc['generated_at']}: "
        f"battery={doc['latest']['battery_pct']}% "
        f"odo={doc['latest']['odometer_km']} "
        f"hourly={len(doc['hourly_history'])} "
        f"daily={len(rollups['daily'])} "
        f"monthly={len(rollups['monthly'])} "
        f"yearly={len(rollups['yearly'])} "
        f"months={len(doc['monthly_distance'])} "
        f"events={len(doc['events'])}"
    )


if __name__ == "__main__":
    asyncio.run(main())

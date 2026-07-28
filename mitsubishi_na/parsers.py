"""Parsers for nested fields inside raw VHR (vehicleStatus) responses.

Field locations here are inferred from decompiled class definitions
(VehicleHealthProperty, VHRItemEnum, DrivingScore) rather than a confirmed
live example — the recursive key search is deliberately shape-tolerant so it
still finds the data if the exact nesting differs from what the app UI code
assumes.
"""
from __future__ import annotations

from typing import Any


def _find_key(data: Any, key: str) -> Any:
    """Recursively search a nested dict/list for the first occurrence of `key`."""
    if isinstance(data, dict):
        if key in data:
            return data[key]
        for value in data.values():
            found = _find_key(value, key)
            if found is not None:
                return found
    elif isinstance(data, list):
        for item in data:
            found = _find_key(item, key)
            if found is not None:
                return found
    return None


def _flatten_score_list(raw: Any) -> dict:
    """Normalize a score field to a flat dict.

    Per the decompiled model this arrives as a List<HashMap> of single-key
    entries (the same pattern already seen for cruisingRangeFirst/Second in
    the real VHR response), but tolerate a plain dict too.
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        flat: dict = {}
        for item in raw:
            if isinstance(item, dict):
                flat.update(item)
        return flat
    return {}


def _score_value(entry: Any) -> Any:
    """Score entries elsewhere in VHR are {"name", "displayMessage", "value", ...}
    dicts — unwrap to the bare value when shaped that way, else pass through.
    """
    if isinstance(entry, dict) and "value" in entry:
        return entry["value"]
    return entry


def parse_driving_score(vhr_response: dict) -> dict:
    """Extract driving-behavior + fuel-economy scores from a VHR response.

    Returns None for any score not present (e.g. accounts with no recent
    driving history may not have this populated).
    """
    driving = _flatten_score_list(_find_key(vhr_response, "drivingScore"))
    fuel_economy_raw = _find_key(vhr_response, "fuelEconomyScore")

    return {
        "overall_score": _score_value(driving.get("overallScore")),
        "acceleration_score": _score_value(driving.get("accelScore")),
        "steering_score": _score_value(driving.get("steerScore")),
        "braking_score": _score_value(driving.get("brakeScore")),
        "fuel_economy_score": _score_value(fuel_economy_raw),
    }

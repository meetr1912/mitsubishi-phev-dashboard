#!/usr/bin/env python3
"""Fetch charging history + cost reports (proxy for EV-vs-gas usage split,
since the mileage-tracker endpoint only reports total distance).

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_charging_history.py
"""
import asyncio
import json
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient

logging.basicConfig(level=logging.WARNING, format="%(name)s: %(message)s")

TIMEZONE = "America/Halifax"


async def main() -> None:
    username = os.environ.get("MMC_USERNAME")
    password = os.environ.get("MMC_PASSWORD")
    if not username or not password:
        print("Set MMC_USERNAME and MMC_PASSWORD env vars first.")
        return

    client = MitsubishiNAClient(username, password)
    try:
        if not await client.async_login():
            print("Login failed.")
            return

        vehicles = await client.async_get_vehicles()
        if not vehicles:
            print("No vehicles found.")
            return
        vin = vehicles[0]["vin"]

        for year, month in [(2025, 11), (2025, 12), (2026, 3), (2026, 4), (2026, 5), (2026, 6), (2026, 7)]:
            hist = await client.async_get_charging_history(vin, year, month, TIMEZONE)
            if hist:
                print(f"\n--- charging history {year}-{month:02d} ---")
                print(json.dumps(hist, indent=2))
            cost = await client.async_get_charging_cost(vin, year, month, TIMEZONE)
            if cost:
                print(f"\n--- charging cost {year}-{month:02d} ---")
                print(json.dumps(cost, indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

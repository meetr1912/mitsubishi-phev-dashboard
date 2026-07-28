#!/usr/bin/env python3
"""Read your current climate schedule list — read-only, safe.

Run this BEFORE we write a test schedule: the write payload has several
fragile-looking field encodings (schedule.startTimeOfDay/endTimeOfDay,
conditioningId, hvacSettings) that we only know from decompiled class
definitions, not a live example. Seeing what your account's schedules
actually look like on the wire lets us clone-and-modify instead of
guessing types blind.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_climate_schedule.py
"""
import asyncio
import json
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient

logging.basicConfig(level=logging.WARNING, format="%(name)s: %(message)s")


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

        print(f"--- current climate schedule, VIN {vin} ---")
        print(json.dumps(await client.async_get_climate_schedule(vin), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""Check whether the VHR endpoint's `count` param returns historical
snapshots (battery/range over time) rather than just the latest reading.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_vhr_history.py
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

        data = await client.async_get_vehicle_health(vin, count=100)
        vhr = (data or {}).get("vhr", [])
        print(f"count=100 returned {len(vhr)} entries")
        if len(vhr) > 1:
            for entry in vhr:
                diag = entry.get("dt", {}).get("diagnostic", {})
                print(
                    entry.get("ts"),
                    "battery=", diag.get("batteryLife", {}).get("value"),
                    "odo=", diag.get("odo", {}).get("value"),
                    "chargingStatus=", diag.get("chargingStatus", {}).get("value"),
                )
        else:
            print("Only one entry — count param doesn't return history.")
            print(json.dumps(data, indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

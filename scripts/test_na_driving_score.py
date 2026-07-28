#!/usr/bin/env python3
"""Show the eco-driving score — free, already inside the VHR response.

Read-only. Prints both the parsed score and the raw VHR (so we can confirm
or fix the field-location guess in mitsubishi_na/parsers.py against your
real data).

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_driving_score.py
"""
import asyncio
import json
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient

logging.basicConfig(level=logging.WARNING, format="%(name)s: %(message)s")


def fmt(label: str, value) -> str:
    shown = "n/a" if value is None else value
    return f"  {label:<20} {shown}"


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

        score = await client.async_get_driving_score(vin)
        print(f"--- driving score, VIN {vin} ---")
        print(fmt("Overall:", score["overall_score"]))
        print(fmt("Acceleration:", score["acceleration_score"]))
        print(fmt("Steering:", score["steering_score"]))
        print(fmt("Braking:", score["braking_score"]))
        print(fmt("Fuel economy:", score["fuel_economy_score"]))

        print("\n--- raw VHR (for verifying the parser's field-location guess) ---")
        print(json.dumps(await client.async_get_vehicle_health(vin), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

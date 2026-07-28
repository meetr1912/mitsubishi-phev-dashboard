#!/usr/bin/env python3
"""Fetch EV-vs-gas mileage reports (full ownership history) for your PHEV.

Tries both VIN and the internal vehicleContextFk as the {vehicle_id} param,
since res/oS's config uses "${vehicleId}" (ambiguous) instead of "${vin}"
like the other endpoints. Prints raw JSON so we can see which one works and
what the real response shape looks like.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_mileage.py
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


async def try_yearly(client, label, vehicle_id, year):
    data = await client.async_get_mileage_yearly(vehicle_id, year, TIMEZONE)
    print(f"\n--- yearly mileage: {label}={vehicle_id} year={year} ---")
    print(json.dumps(data, indent=2))
    return data


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

        details = await client.async_get_vehicle_details(vin)
        vehicle_context_fk = (details or {}).get("vehicleInfo", {}).get("vehicleContextFk")
        print(f"VIN={vin}  vehicleContextFk={vehicle_context_fk}")

        for year in (2024, 2025, 2026):
            got = await try_yearly(client, "vin", vin, year)
            if not got and vehicle_context_fk:
                await try_yearly(client, "vehicleContextFk", str(vehicle_context_fk), year)

        print("\n--- monthly mileage: current year, all months tried with VIN ---")
        for month in range(1, 13):
            data = await client.async_get_mileage_monthly(vin, 2026, month, TIMEZONE)
            if data:
                print(f"\n-- {2026}-{month:02d} --")
                print(json.dumps(data, indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

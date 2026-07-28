#!/usr/bin/env python3
"""End-to-end test of the standalone NA (Aeris ATSP) API client.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_client.py
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
        print(f"Login OK. accountDN={client._token.account_dn}")

        vehicles = await client.async_get_vehicles()
        print(f"\n{len(vehicles)} vehicle(s):")
        print(json.dumps(vehicles, indent=2))

        for v in vehicles:
            vin = v["vin"]
            print(f"\n--- VIN {vin} details ---")
            print(json.dumps(await client.async_get_vehicle_details(vin), indent=2))
            print(f"\n--- VIN {vin} state ---")
            print(json.dumps(await client.async_get_vehicle_state(vin), indent=2))
            print(f"\n--- VIN {vin} health (VHR) ---")
            print(json.dumps(await client.async_get_vehicle_health(vin), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

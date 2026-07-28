#!/usr/bin/env python3
"""Browse the store catalog / promo eligibility for your vehicle.

Read-only — no card, no Stripe key, no purchase. Just viewing what's
purchasable and whether a promo is currently active.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_promos.py
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

        print("--- trial expiry ---")
        print(json.dumps(await client.async_get_trial_expiry(vin), indent=2))

        print("\n--- purchasable packages: SERVICE (promo check on) ---")
        print(json.dumps(await client.async_get_purchasable_packages(vin, "SERVICE"), indent=2))

        print("\n--- purchasable packages: MOBILITY_SERVICE (promo check on) ---")
        print(json.dumps(await client.async_get_purchasable_packages(vin, "MOBILITY_SERVICE"), indent=2))

        print("\n--- active subscriptions ---")
        print(json.dumps(await client.async_get_subscriptions(vin, active_only=True), indent=2))

        print("\n--- all subscriptions (history) ---")
        print(json.dumps(await client.async_get_subscriptions(vin, active_only=False), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""Check service entitlements for driving-score / eco-score gating.

Three sources, in order:
  1. vehicle_details' embedded availableServices (already known - 22 items,
     none obviously "driving score" by name, but printed again for a fresh
     eye)
  2. the dedicated getvehicleservices entitlement endpoint (not yet tried)
  3. the model/region/year configuration catalog (where a model-gated
     feature flag, if any, would live)

Read-only.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_service_entitlements.py
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

        details = await client.async_get_vehicle_details(vin)
        services = (details or {}).get("availableServices", [])
        print(f"--- availableServices ({len(services)}) from vehicle_details ---")
        for s in services:
            print(f"  {s.get('serviceType'):<20} enabled={s.get('serviceEnabled')}  expiry={s.get('expiry')}")
        score_related = [s for s in services if "score" in (s.get("serviceType") or "").lower()
                         or "score" in (s.get("displayName") or "").lower()
                         or "eco" in (s.get("serviceType") or "").lower()
                         or "driv" in (s.get("serviceType") or "").lower()]
        print(f"\n  score/eco/driving-related entries: {score_related or 'none'}")

        print("\n--- dedicated getvehicleservices entitlement endpoint ---")
        print(json.dumps(await client.async_get_vehicle_services(vin), indent=2))

        model = (details or {}).get("vehicleTypeCode") or (details or {}).get("vehicleInfo", {}).get("trimCode")
        year = (details or {}).get("modelYear")
        country = (details or {}).get("country")
        print(f"\n--- model configuration catalog (model={model}, country={country}, year={year}) ---")
        print(json.dumps(await client.async_get_model_configurations(model, country, year), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

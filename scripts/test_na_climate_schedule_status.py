#!/usr/bin/env python3
"""Poll the outcome of the last climate-schedule write by its eventId.

Read-only. Run this to see WHY the last write reverted — vehicle offline,
validation error, or something else — before we draw any conclusion about
the 3-vs-4 schedule slot question.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_climate_schedule_status.py <eventId>
"""
import asyncio
import json
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient
from mitsubishi_na.const import NA_BASE_URL, EP_AMS_CLIMATE_SCHEDULE_STATUS

logging.basicConfig(level=logging.WARNING, format="%(name)s: %(message)s")


async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/test_na_climate_schedule_status.py <eventId>")
        return
    event_id = sys.argv[1]

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

        if not await client._ensure_token():
            print("No valid session.")
            return
        r = await client._http.get(
            f"{NA_BASE_URL}{EP_AMS_CLIMATE_SCHEDULE_STATUS.format(vin=vin)}",
            params={"correlationId": event_id},
            headers=client._shared_headers(bearer=True),
        )
        print(f"--- status for eventId {event_id} ---")
        print(f"HTTP {r.status_code}")
        print(repr(r.text))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

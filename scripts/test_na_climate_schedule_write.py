#!/usr/bin/env python3
"""Write test: fill the 3 real climate-schedule slots + inject a 4th, to see
if the backend accepts more than 3.

Field values (conditioningStatus/conditioningAction, time units) are
best-effort guesses cloned from the live read shape + decompiled class
definitions — not confirmed. This is a genuine experiment: whatever comes
back (accepted / truncated / rejected) tells us the real answer.

Times: Sunday 3:00, 3:30, 4:00 (slots 1-3, real), 4:30 (slot 4, injected).
Time encoding guessed as seconds-since-midnight (10800/12600/14400/16200).

Run locally with your own credentials — never paste your password to Claude.
This WRITES to your real account's climate schedule (config only, no
immediate actuation — it won't turn the AC on right now).

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_climate_schedule_write.py
"""
import asyncio
import json
import logging
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient
from mitsubishi_na.const import NA_BASE_URL, EP_AMS_CLIMATE_SCHEDULE

logging.basicConfig(level=logging.WARNING, format="%(name)s: %(message)s")


def slot(conditioning_id: str, start_seconds: int) -> dict:
    return {
        "conditioningId": conditioning_id,
        "conditioningName": conditioning_id,
        "conditioningAction": "1",
        "conditioningStatus": "1",  # guess: 1 = enabled
        "frontTemperature": " 22.0",
        "pos": 1,
        "schedule": {
            "serviceScheduleType": "1",
            "startTimeOfDay": start_seconds,
            "endTimeOfDay": "0",
            "everyMonday": 0,
            "everyTuesday": 0,
            "everyWednesday": 0,
            "everyThursday": 0,
            "everyFriday": 0,
            "everySaturday": 0,
            "everySunday": 1,
        },
    }


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

        body = {
            "vehicleId": vin,
            "operation": "climateControl",
            "operationType": 1,
            "timestamp": str(int(time.time() * 1000)),
            "data": {
                "conditioningDefinition": [
                    slot("1", 3 * 3600),        # 3:00
                    slot("2", 3 * 3600 + 1800),  # 3:30
                    slot("3", 4 * 3600),        # 4:00
                    slot("4", 4 * 3600 + 1800),  # 4:30 -- the injected 4th
                ],
            },
        }
        print("--- request body ---")
        print(json.dumps(body, indent=2))

        if not await client._ensure_token():
            print("No valid session.")
            return
        r = await client._http.post(
            f"{NA_BASE_URL}{EP_AMS_CLIMATE_SCHEDULE.format(vin=vin)}",
            json=body,
            headers=client._shared_headers(bearer=True),
        )
        print(f"\n--- HTTP {r.status_code} ---")
        print(r.text)

        print("\n--- re-reading schedule after write ---")
        print(json.dumps(await client.async_get_climate_schedule(vin), indent=2))
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

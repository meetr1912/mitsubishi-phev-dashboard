#!/usr/bin/env python3
"""Full remote-command sequence: wakeup -> wait -> PerformRO -> poll status.

The fix over the earlier attempt (per the MQTT/HTTP research): the app is
HTTP-only for commands, but fires a vehicle WAKEUP first to rouse the TCU from
deep sleep — without it the command is silently dropped (EventNotFound). Also
the payload now matches the app: correct `dt` data body, and a pinToken ONLY
for unlock/locate.

PIN (only needed for unlock/locate) is read from MMC_PIN and used solely to
compute a local HMAC — the raw PIN never goes over the wire.

  export MMC_USERNAME=... MMC_PASSWORD=... [MMC_PIN=1234]
  python3 scripts/test_na_remote_command.py [command] [--no-wake]

command (default: lights):
  lights | horn | lock | unlock | locate
  climate_start | climate_stop | charge_start | charge_stop

WARNING: these physically actuate the car. Run only where it's safe for the
car to flash/honk/unlock/run climate.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient
from mitsubishi_na.const import NA_BASE_URL, EP_RO_STATUS

WAKE_WAIT_S = 25
POLL_ATTEMPTS = 12
POLL_DELAY_S = 5

# command -> (client method name, needs pin)
CMDS = {
    "lights": ("async_lights", False),
    "horn": ("async_horn", False),
    "lock": ("async_lock", False),
    "unlock": ("async_unlock", True),
    "locate": ("async_locate", True),
    "climate_start": ("async_climate_start", False),
    "climate_stop": ("async_climate_stop", False),
    "charge_start": ("async_charge_start", False),
    "charge_stop": ("async_charge_stop", False),
}

# Special climate variants exercising the hvacSettings (seats/steering/defrost).
CLIMATE_VARIANTS = {
    "climate_seats": dict(seat_fl=True, seat_fr=True, steering=True),
    "climate_defrost": dict(defrost=True, front_defrost=True, rear_defrost=True),
    "climate_seats_off": dict(seat_fl=False, seat_fr=False, steering=False),
}


async def main() -> None:
    u, p, pin = (os.environ.get(k) for k in ("MMC_USERNAME", "MMC_PASSWORD", "MMC_PIN"))
    if not (u and p):
        print("Set MMC_USERNAME and MMC_PASSWORD (and MMC_PIN for unlock/locate).")
        return

    args = [a for a in sys.argv[1:] if a != "--no-wake"]
    wake = "--no-wake" not in sys.argv
    command = args[0] if args else "lights"
    if command not in CMDS and command not in CLIMATE_VARIANTS:
        print(f"Unknown command {command!r}. Choose from: "
              f"{', '.join(list(CMDS) + list(CLIMATE_VARIANTS))}")
        return
    needs_pin = CMDS.get(command, ("", False))[1]
    if needs_pin and not pin:
        print(f"{command} needs a PIN — set MMC_PIN.")
        return

    client = MitsubishiNAClient(u, p)
    try:
        if not await client.async_login():
            print("Login failed.")
            return
        vin = (await client.async_get_vehicles())[0]["vin"]

        if wake:
            print(f"Waking vehicle {vin} ...")
            wr = await client.async_wakeup(vin)
            print(f"  wakeup response: {json.dumps(wr)}")
            print(f"  waiting {WAKE_WAIT_S}s for the TCU to come online ...")
            await asyncio.sleep(WAKE_WAIT_S)

        if command in CLIMATE_VARIANTS:
            opts = CLIMATE_VARIANTS[command]
            print(f"climate_start with hvacSettings: {opts}")
            resp = await client.async_climate_start(vin, **opts)
        else:
            method = getattr(client, CMDS[command][0])
            resp = await (method(vin, pin) if needs_pin else method(vin))
        print(f"\n--- PerformRO ({command}) ---")
        print(json.dumps(resp, indent=2))

        event_id = (resp or {}).get("eventId")
        if not event_id:
            print("\nNo eventId — command not accepted. (Body/field issue.)")
            return
        print(f"\nAccepted, eventId={event_id}. Polling GetROStatus ...")
        for i in range(POLL_ATTEMPTS):
            await asyncio.sleep(POLL_DELAY_S)
            r = await client._http.get(
                f"{NA_BASE_URL}{EP_RO_STATUS.format(vin=vin, event_id=event_id)}",
                headers=client._shared_headers(bearer=True),
            )
            t = (i + 1) * POLL_DELAY_S
            print(f"  [{t}s] HTTP {r.status_code} {r.text!r}")
            if r.status_code == 200 and r.text.strip():
                try:
                    st = str(r.json().get("status", "")).lower()
                except Exception:
                    st = ""
                if st in ("successful", "success", "completed", "failed", "failure", "inqueue"):
                    print(f"\nFinal status: {st}")
                    break
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

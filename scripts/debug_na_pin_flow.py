#!/usr/bin/env python3
"""Raw-capture the two PIN-handshake POSTs to see exactly why GetPinToken is empty.

Prints HTTP status + raw body for GetServerNonce and GetPinToken, plus the
nonces/hash we computed, so we can tell a bad-hash rejection from a
different-response-shape from a wrong field name.

  export MMC_USERNAME=... MMC_PASSWORD=... MMC_PIN=...
  python3 scripts/debug_na_pin_flow.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mitsubishi_na.api import MitsubishiNAClient
from mitsubishi_na.crypto import generate_client_nonce, compute_pin_hash
from mitsubishi_na.const import NA_BASE_URL, EP_SERVER_NONCE, EP_PIN_TOKEN


async def raw_post(client, path, body):
    r = await client._http.post(
        f"{NA_BASE_URL}{path}", json=body,
        headers=client._shared_headers(bearer=True),
    )
    return r


async def main() -> None:
    u, p, pin = (os.environ.get(k) for k in ("MMC_USERNAME", "MMC_PASSWORD", "MMC_PIN"))
    if not (u and p and pin):
        print("Set MMC_USERNAME, MMC_PASSWORD, MMC_PIN.")
        return

    client = MitsubishiNAClient(u, p)
    try:
        if not await client.async_login():
            print("Login failed.")
            return
        vin = (await client.async_get_vehicles())[0]["vin"]
        await client._ensure_token()

        client_nonce = generate_client_nonce()
        print(f"vin          = {vin}")
        print(f"clientNonce  = {client_nonce}")

        r1 = await raw_post(client, EP_SERVER_NONCE, {"vin": vin, "clientNonce": client_nonce})
        print(f"\n[GetServerNonce] POST {EP_SERVER_NONCE}")
        print(f"  HTTP {r1.status_code}")
        print(f"  body: {r1.text!r}")

        try:
            server_nonce = r1.json().get("serverNonce")
        except Exception:
            server_nonce = None
        print(f"  serverNonce = {server_nonce}")
        if not server_nonce:
            print("No serverNonce — stopping.")
            return

        pin_hash = compute_pin_hash(client_nonce, server_nonce, pin)
        print(f"\ncomputed hash = {pin_hash}")

        # Try a few plausible body shapes so one run tells us the right one.
        for label, body in [
            ("hash", {"vin": vin, "hash": pin_hash}),
            ("pinHash", {"vin": vin, "pinHash": pin_hash}),
            ("hash+clientNonce", {"vin": vin, "hash": pin_hash, "clientNonce": client_nonce}),
        ]:
            r2 = await raw_post(client, EP_PIN_TOKEN, body)
            print(f"\n[GetPinToken / {label}] POST {EP_PIN_TOKEN}")
            print(f"  sent: {body}")
            print(f"  HTTP {r2.status_code}")
            print(f"  body: {r2.text!r}")
            if r2.status_code == 200 and "pinToken" in r2.text:
                print("  >>> THIS SHAPE WORKS")
                break
    finally:
        await client.async_close()


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""Standalone test of the NA (Aeris ATSP) login flow used by the real
"My Mitsubishi Connect" app (covers US + Canada).

Reverse-engineered from My+Mitsubishi+Connect_v2.88.10 (res/oS config +
com.aeris.atsp.service.C1847g / p151h.C7123l).

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_na_login.py
"""
import asyncio
import base64
import os
import uuid

import httpx

NA_PROD_HOST = "us-m.aerpf.com"
NA_PROD_PORT = 15443
NA_PROD_API_KEY = "3f5547161b5d4bdbbb2bf8b26c69d1de"  # decoded from serviceApiKeyByteArrayNaProd
CLIENT_TRUSTED_SECRET = "ampClientTrustedSecret"  # decoded from SECRET byte array
TOKEN_PATH = "/auth/v1/token"


async def main() -> None:
    username = os.environ.get("MMC_USERNAME")
    password = os.environ.get("MMC_PASSWORD")
    if not username or not password:
        print("Set MMC_USERNAME and MMC_PASSWORD env vars first.")
        return

    client_id = str(uuid.uuid4())  # app generates+persists a random UUID per install
    basic = base64.b64encode(f"{client_id}:{CLIENT_TRUSTED_SECRET}".encode()).decode()

    url = f"https://{NA_PROD_HOST}:{NA_PROD_PORT}{TOKEN_PATH}"
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "Mobile",
        "X-Client-Id": "mobile",
        "ampApiKey": NA_PROD_API_KEY,
        "Authorization": f"Basic {basic}",
    }
    body = {
        "grant_type": "password",
        "username": username,
        "password": password,
    }

    async with httpx.AsyncClient(timeout=30.0, verify=True) as client:
        r = await client.post(url, headers=headers, json=body)
        print(f"HTTP {r.status_code}")
        print(r.text)


if __name__ == "__main__":
    asyncio.run(main())

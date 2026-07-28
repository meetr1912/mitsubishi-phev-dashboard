#!/usr/bin/env python3
"""Standalone test of the EU GOA/Kintaro login flow.

Run locally with your own credentials — never paste your password to Claude.

Usage:
    export MMC_USERNAME='you@example.com'
    export MMC_PASSWORD='your-password'
    python3 scripts/test_eu_login.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "custom_components", "mitsubishi_outlander_phev_eu"))

import httpx
from const import EU_AUTH_URL, EU_CLIENT_ID, EU_CLIENT_SECRET


async def main() -> None:
    username = os.environ.get("MMC_USERNAME")
    password = os.environ.get("MMC_PASSWORD")
    if not username or not password:
        print("Set MMC_USERNAME and MMC_PASSWORD env vars first.")
        return

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            EU_AUTH_URL,
            data={
                "grant_type": "password",
                "username": username,
                "password": password,
                "client_id": EU_CLIENT_ID,
                "client_secret": EU_CLIENT_SECRET,
            },
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "okhttp/4.9.0",
            },
        )
        print(f"HTTP {r.status_code}")
        print(r.text)


if __name__ == "__main__":
    asyncio.run(main())

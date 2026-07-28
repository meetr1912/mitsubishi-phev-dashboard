"""Mitsubishi Connect NA (US/Canada) API client — Aeris ATSP backend.

Reverse-engineered from the official "My Mitsubishi Connect" Android app.
See const.py for source references.
"""
from __future__ import annotations

import base64
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import httpx

from .const import (
    NA_BASE_URL,
    NA_PROD_API_KEY,
    CLIENT_TRUSTED_SECRET,
    EP_TOKEN,
    EP_USER_INFO,
    EP_VEHICLE_DETAILS,
    EP_VEHICLE_STATE,
    EP_VEHICLE_HEALTH,
    EP_MILEAGE_MONTHLY,
    EP_MILEAGE_YEARLY,
    EP_CHARGING_HISTORY,
    EP_CHARGING_COST,
)

_LOGGER = logging.getLogger(__name__)

TOKEN_EXPIRY_MARGIN = timedelta(minutes=5)


@dataclass
class TokenState:
    access_token: str = ""
    refresh_token: str = ""
    account_dn: str = ""
    expires_at: datetime = field(default_factory=datetime.now)

    @property
    def is_valid(self) -> bool:
        return bool(self.access_token) and datetime.now() < (self.expires_at - TOKEN_EXPIRY_MARGIN)


class MitsubishiNAClient:
    """API client for the North American (US/Canada) Mitsubishi Connect app."""

    def __init__(self, username: str, password: str) -> None:
        self._username = username
        self._password = password
        self._token = TokenState()
        self._client_id = str(uuid.uuid4())
        self._http = httpx.AsyncClient(timeout=30.0)

    async def async_close(self) -> None:
        await self._http.aclose()

    def _basic_auth_header(self) -> str:
        raw = f"{self._client_id}:{CLIENT_TRUSTED_SECRET}".encode()
        return f"Basic {base64.b64encode(raw).decode()}"

    def _shared_headers(self, *, bearer: bool) -> dict:
        headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": "Mobile",
            "X-Client-Id": "mobile",
            "ampApiKey": NA_PROD_API_KEY,
        }
        headers["Authorization"] = (
            f"Bearer {self._token.access_token}" if bearer and self._token.access_token
            else self._basic_auth_header()
        )
        return headers

    async def _post_token(self, body: dict) -> bool:
        try:
            r = await self._http.post(
                f"{NA_BASE_URL}{EP_TOKEN}",
                json=body,
                headers=self._shared_headers(bearer=False),
            )
        except httpx.RequestError as err:
            _LOGGER.error("Token request failed: %s", err)
            return False
        if r.status_code != 200:
            _LOGGER.error("Token request rejected: %s %s", r.status_code, r.text)
            return False
        data = r.json()
        self._token = TokenState(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            account_dn=data["accountDN"],
            expires_at=datetime.now() + timedelta(seconds=int(data.get("expires_in", 3600))),
        )
        return True

    async def async_login(self) -> bool:
        return await self._post_token({
            "grant_type": "password",
            "username": self._username,
            "password": self._password,
        })

    async def async_refresh_token(self) -> bool:
        if not self._token.refresh_token:
            return await self.async_login()
        if await self._post_token({
            "grant_type": "refresh_token",
            "refresh_token": self._token.refresh_token,
        }):
            return True
        return await self.async_login()

    async def _ensure_token(self) -> bool:
        if self._token.is_valid:
            return True
        return await self.async_refresh_token()

    async def _get(self, path: str, params: dict | None = None) -> dict | None:
        if not await self._ensure_token():
            raise ConnectionError(f"No valid session for {path}")
        try:
            r = await self._http.get(
                f"{NA_BASE_URL}{path}",
                params=params,
                headers=self._shared_headers(bearer=True),
            )
        except httpx.RequestError as err:
            _LOGGER.error("GET %s failed: %s", path, err)
            return None
        if r.status_code != 200:
            _LOGGER.debug("GET %s: HTTP %s %s", path, r.status_code, r.text)
            return None
        return r.json()

    async def async_get_user_info(self) -> dict | None:
        return await self._get(EP_USER_INFO.format(email=self._username))

    async def async_get_vehicles(self) -> list[dict]:
        """Get all vehicles registered to this account.

        /avi/v1/vehicles?accountDN=... 403s at the gateway for unknown reasons;
        the same vehicle list is embedded in the user-info response, which works.
        """
        data = await self.async_get_user_info()
        if not data:
            return []
        return data.get("vehicles", [])

    async def async_get_vehicle_details(self, vin: str) -> dict | None:
        return await self._get(
            EP_VEHICLE_DETAILS.format(vin=vin),
            params={"excludes": "tuProfile,salesCodes,saleRecord", "includes": "category"},
        )

    async def async_get_vehicle_state(self, vin: str) -> dict | None:
        """Odometer / basic vehicle state."""
        return await self._get(EP_VEHICLE_STATE.format(vin=vin))

    async def async_get_vehicle_health(self, vin: str, count: int = 1) -> dict | None:
        """Vehicle Health Report (VHR) — battery, range, tire pressure, warnings, etc."""
        return await self._get(EP_VEHICLE_HEALTH.format(vin=vin), params={"count": count})

    async def async_get_mileage_yearly(self, vehicle_id: str, year: int, timezone: str) -> dict | None:
        """EV vs gas mileage breakdown for a calendar year."""
        return await self._get(
            EP_MILEAGE_YEARLY.format(vehicle_id=vehicle_id),
            params={"year": year, "timezone": timezone},
        )

    async def async_get_mileage_monthly(self, vehicle_id: str, year: int, month: int, timezone: str) -> dict | None:
        """EV vs gas mileage breakdown for a calendar month."""
        return await self._get(
            EP_MILEAGE_MONTHLY.format(vehicle_id=vehicle_id),
            params={"year": year, "month": month, "timezone": timezone},
        )

    async def async_get_charging_history(self, vehicle_id: str, year: int, month: int, timezone: str) -> dict | None:
        return await self._get(
            EP_CHARGING_HISTORY.format(vehicle_id=vehicle_id),
            params={"year": year, "month": month, "timezone": timezone},
        )

    async def async_get_charging_cost(self, vehicle_id: str, year: int, month: int, timezone: str, base_cost: float = 0) -> dict | None:
        return await self._get(
            EP_CHARGING_COST.format(vehicle_id=vehicle_id),
            params={"year": year, "month": month, "timezone": timezone, "baseCost": base_cost},
        )

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

from .parsers import parse_driving_score
from .crypto import generate_client_nonce, compute_pin_hash

from .const import (
    NA_BASE_URL,
    EP_SERVER_NONCE,
    EP_PIN_TOKEN,
    EP_PERFORM_RO,
    EP_VEHICLE_WAKEUP,
    RO_OPERATIONS,
    RO_REQUIRE_PIN,
    RO_DATA,
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
    EP_TRIAL_EXPIRY,
    EP_PURCHASABLE_PACKAGES_SERVICE,
    EP_PURCHASABLE_PACKAGES_MOBILITY,
    EP_VEHICLE_SUBSCRIPTIONS_ACTIVE,
    EP_VEHICLE_SUBSCRIPTIONS_ALL,
    EP_AMS_CLIMATE_SCHEDULE,
    EP_AMS_CLIMATE_SCHEDULE_STATUS,
    EP_NOTIFICATIONS,
    EP_RO_STATUS,
    EP_PARENTAL_ALERT,
    EP_LOCATION,
    EP_SVLA_STATE,
    EP_VEHICLE_SERVICES,
    EP_MODEL_CONFIGURATIONS,
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
        self._pin_tokens: dict[str, str] = {}  # vin -> pinToken, cached per session

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
        if not (200 <= r.status_code < 300):
            _LOGGER.debug("GET %s: HTTP %s %s", path, r.status_code, r.text)
            return None
        if not r.text.strip():
            _LOGGER.debug("GET %s: HTTP 200 with empty body", path)
            return None
        try:
            return r.json()
        except ValueError:
            _LOGGER.error("GET %s: HTTP 200 non-JSON body: %r", path, r.text)
            return None

    async def _post(self, path: str, body: dict) -> dict | None:
        """Authenticated (bearer) POST returning parsed JSON, or None."""
        if not await self._ensure_token():
            raise ConnectionError(f"No valid session for {path}")
        try:
            r = await self._http.post(
                f"{NA_BASE_URL}{path}",
                json=body,
                headers=self._shared_headers(bearer=True),
            )
        except httpx.RequestError as err:
            _LOGGER.error("POST %s failed: %s", path, err)
            return None
        if not (200 <= r.status_code < 300):
            _LOGGER.debug("POST %s: HTTP %s %s", path, r.status_code, r.text)
            return None
        if not r.text.strip():
            return None
        try:
            return r.json()
        except ValueError:
            _LOGGER.error("POST %s: HTTP 200 non-JSON body: %r", path, r.text)
            return None

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

    async def async_get_vehicle_services(self, vin: str) -> dict | None:
        """Dedicated per-vehicle service-entitlement list.

        Distinct from vehicle_details' embedded availableServices — separate
        endpoint, worth checking in case it carries entitlements the details
        payload doesn't (e.g. a driving-score / eco-score service flag).
        """
        return await self._get(
            EP_VEHICLE_SERVICES.format(vin=vin, account_dn=self._token.account_dn)
        )

    async def async_get_model_configurations(self, model: str, country: str, year: str) -> dict | None:
        """Model/region/year service-configuration catalog (posmap, speed/geofence
        bounds, additionalServices) — where a model-gated feature flag would live.
        """
        return await self._get(
            EP_MODEL_CONFIGURATIONS.format(model=model),
            params={"country": country, "year": year},
        )

    async def async_get_vehicle_state(self, vin: str) -> dict | None:
        """Odometer / basic vehicle state."""
        return await self._get(EP_VEHICLE_STATE.format(vin=vin))

    async def async_get_vehicle_health(self, vin: str, count: int = 1) -> dict | None:
        """Vehicle Health Report (VHR) — battery, range, tire pressure, warnings, etc."""
        return await self._get(EP_VEHICLE_HEALTH.format(vin=vin), params={"count": count})

    async def async_get_driving_score(self, vin: str, count: int = 1) -> dict | None:
        """Eco-driving score (overall/accel/steer/brake + fuel economy).

        No dedicated endpoint — this rides inside the same VHR (vehicleStatus)
        response async_get_vehicle_health already fetches, just parsed out.
        """
        vhr = await self.async_get_vehicle_health(vin, count=count)
        if not vhr:
            return None
        return parse_driving_score(vhr)

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

    async def async_get_trial_expiry(self, vin: str) -> dict | None:
        return await self._get(EP_TRIAL_EXPIRY.format(vin=vin))

    async def async_get_climate_schedule(self, vin: str) -> dict | None:
        """Current climate schedule list — read-only, safe to call anytime."""
        return await self._get(EP_AMS_CLIMATE_SCHEDULE.format(vin=vin))

    async def async_get_climate_schedule_status(self, vin: str, correlation_id: str) -> dict | None:
        """Poll the outcome of a PerformAMSClimateControlRO write by its eventId."""
        return await self._get(
            EP_AMS_CLIMATE_SCHEDULE_STATUS.format(vin=vin),
            params={"correlationId": correlation_id},
        )

    async def async_get_purchasable_packages(
        self, vin: str, category: str = "SERVICE", check_promo_eligibility: bool = True,
        hide_regular_for_promo: bool = False,
    ) -> dict | None:
        """Browse the store catalog for this vehicle — read-only, no card needed.

        category: "SERVICE" or "MOBILITY_SERVICE". Response includes
        daysLeftForPromo per bundle when a promo is currently active.
        """
        path = (
            EP_PURCHASABLE_PACKAGES_MOBILITY if category == "MOBILITY_SERVICE"
            else EP_PURCHASABLE_PACKAGES_SERVICE
        )
        return await self._get(
            path.format(vin=vin),
            params={
                "checkPromoEligibility": str(check_promo_eligibility).lower(),
                "hideRegularForPromo": str(hide_regular_for_promo).lower(),
            },
        )

    async def async_get_subscriptions(self, vin: str, active_only: bool = True) -> dict | None:
        path = EP_VEHICLE_SUBSCRIPTIONS_ACTIVE if active_only else EP_VEHICLE_SUBSCRIPTIONS_ALL
        return await self._get(path.format(vin=vin))

    # ------------------------------------------------------------------
    # Event / activity feed
    # ------------------------------------------------------------------

    async def async_get_notifications(self, vin: str) -> dict | None:
        """The vehicle's notification feed — the closest thing to an event stream.

        Unlike EP_RO_STATUS, which can only be read back for an eventId you
        already hold, this returns events the backend generated on its own
        (alerts, charge start/stop, curfew and geofence trips, etc.), so it is
        what lets the hourly logger pick up activity it did not initiate.
        """
        return await self._get(EP_NOTIFICATIONS.format(vin=vin))

    async def async_get_ro_status(self, vin: str, event_id: str) -> dict | None:
        """Outcome of one remote operation, by the eventId PerformRO returned.

        Read-only: polling this does not actuate anything.
        """
        return await self._get(EP_RO_STATUS.format(vin=vin, event_id=event_id))

    # ------------------------------------------------------------------
    # Settings groups (all one endpoint, distinguished by ?operation=)
    # ------------------------------------------------------------------

    async def async_get_parental_alert(self, vin: str, operation: str) -> dict | None:
        """Read one settings group off the shared parentalAlert endpoint.

        Valid operations, per res/raw/environment: remoteAC, climateControl,
        chargingControl, chargingControl2, curfew, geofence, speedAlert,
        privacyMode.
        """
        return await self._get(
            EP_PARENTAL_ALERT.format(vin=vin), params={"operation": operation}
        )

    async def async_get_climate_control(self, vin: str) -> dict | None:
        return await self.async_get_parental_alert(vin, "remoteAC")

    async def async_get_charging_control(self, vin: str) -> dict | None:
        return await self.async_get_parental_alert(vin, "chargingControl")

    # ------------------------------------------------------------------
    # Location / mode
    # ------------------------------------------------------------------

    async def async_get_location(self, vin: str) -> dict | None:
        return await self._get(EP_LOCATION.format(vin=vin))

    async def async_get_svla_state(self, vin: str) -> dict | None:
        """Stolen-Vehicle Locator Assistance state."""
        return await self._get(EP_SVLA_STATE.format(vin=vin))

    # ------------------------------------------------------------------
    # Remote operations (PIN-authorized)
    # ------------------------------------------------------------------

    async def async_verify_pin(self, vin: str, pin: str) -> str | None:
        """Run the nonce -> hash -> pinToken handshake, cache and return the token.

        The pinToken authorizes subsequent PerformRO commands. This is the step
        that was missing when the climate-schedule write reverted.
        """
        client_nonce = generate_client_nonce()
        nonce_resp = await self._post(EP_SERVER_NONCE, {"vin": vin, "clientNonce": client_nonce})
        server_nonce = (nonce_resp or {}).get("serverNonce")
        if not server_nonce:
            _LOGGER.error("GetServerNonce returned no serverNonce: %s", nonce_resp)
            return None

        pin_hash = compute_pin_hash(client_nonce, server_nonce, pin)
        token_resp = await self._post(EP_PIN_TOKEN, {"vin": vin, "hash": pin_hash})
        pin_token = (token_resp or {}).get("pinToken")
        if not pin_token:
            _LOGGER.error("GetPinToken returned no pinToken (wrong PIN?): %s", token_resp)
            return None

        self._pin_tokens[vin] = pin_token
        return pin_token

    async def _ensure_pin_token(self, vin: str, pin: str) -> str | None:
        token = self._pin_tokens.get(vin)
        if token:
            return token
        return await self.async_verify_pin(vin, pin)

    async def async_wakeup(self, vin: str) -> dict | None:
        """Wake the vehicle's TCU out of deep sleep. Call before a command;
        allow ~15-30s before the vehicle is reachable. Returns the response
        (responseStatus == "successful" on success).
        """
        import time
        return await self._post(EP_VEHICLE_WAKEUP.format(vin=vin), {
            "operation": "wakeUp",
            "operationType": 1,
            "vehicleId": vin,
            "timeStamp": str(int(time.time() * 1000)),
            "data": {},
        })

    async def async_perform_ro(
        self, vin: str, operation: str, pin: str | None = None, *,
        forced: bool = True, data: dict | None = None,
    ) -> dict | None:
        """Send a remote operation. `operation` is a raw op string or an
        RO_OPERATIONS key (e.g. "door_lock"). A pinToken is attached ONLY for
        ops in RO_REQUIRE_PIN (doorUnlock, locate). The per-op `dt` data body
        (RO_DATA) is included automatically unless `data` is passed.

        Returns the PerformRO response (includes eventId) or None. Call
        async_wakeup(vin) first if the car may be asleep.
        """
        # operation may be a key ("door_lock") or already-raw ("doorLock")
        op_key = operation
        op = RO_OPERATIONS.get(operation, operation)

        body: dict = {
            "vin": vin,
            "operation": op,
            "forced": "true" if forced else "false",
            "userAgent": "android",
        }

        dt = data if data is not None else RO_DATA.get(op_key) or RO_DATA.get(op)
        if dt:
            body["dt"] = dt

        needs_pin = op_key in RO_REQUIRE_PIN or op in {RO_OPERATIONS[k] for k in RO_REQUIRE_PIN}
        if needs_pin:
            if not pin:
                _LOGGER.error("Operation %s requires a PIN but none was given", op)
                return None
            pin_token = await self._ensure_pin_token(vin, pin)
            if not pin_token:
                return None
            body["pinToken"] = pin_token

        resp = await self._post(EP_PERFORM_RO, body)
        # Stale pinToken is the common transient failure on pin ops — retry once.
        if resp is None and needs_pin and pin:
            self._pin_tokens.pop(vin, None)
            pin_token = await self._ensure_pin_token(vin, pin)
            if pin_token:
                body["pinToken"] = pin_token
                resp = await self._post(EP_PERFORM_RO, body)
        return resp

    # --- Convenience wrappers. pin only needed for unlock/locate. ---

    async def async_lock(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "door_lock")

    async def async_unlock(self, vin: str, pin: str) -> dict | None:
        return await self.async_perform_ro(vin, "door_unlock", pin)

    async def async_horn(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "horn")

    async def async_lights(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "lights")

    async def async_locate(self, vin: str, pin: str) -> dict | None:
        """Car finder — reports GPS position; no physical actuation."""
        return await self.async_perform_ro(vin, "locate", pin)

    async def async_climate_start(
        self, vin: str, *, temp_pos: int = 16, defrost: bool = False,
        seat_fl: bool | None = None, seat_fr: bool | None = None,
        seat_rl: bool | None = None, seat_rr: bool | None = None,
        steering: bool | None = None,
        front_defrost: bool | None = None, rear_defrost: bool | None = None,
    ) -> dict | None:
        """Start remote climate (remoteAC).

        temp_pos: posmap position index (16 = 25C default for this DGE; see the
                  model-config posmap for the full ladder).
        seat_*/steering/front_defrost/rear_defrost: None = omit (leave as-is),
                  True = ON, False = OFF. Seats use HEATER_ON/OFF; steering and
                  defrost use TURN_ON/OFF (per HVACSettingStatus enum names).
        """
        hvac: dict = {
            "fanMode": "DEFROST" if defrost else "VENT_FEET",
            "checkNumber": 75,
            "operationTime": 10,
        }
        seat = lambda b: "HEATER_ON" if b else "HEATER_OFF"
        turn = lambda b: "TURN_ON" if b else "TURN_OFF"
        if seat_fl is not None:
            hvac["frontLeftSeatControl"] = seat(seat_fl)
        if seat_fr is not None:
            hvac["frontRightSeatControl"] = seat(seat_fr)
        if seat_rl is not None:
            hvac["rearLeftSeatControl"] = seat(seat_rl)
        if seat_rr is not None:
            hvac["rearRightSeatControl"] = seat(seat_rr)
        if steering is not None:
            hvac["steeringHeaterControl"] = turn(steering)
        if front_defrost is not None:
            hvac["frontDefrostMode"] = turn(front_defrost)
        if rear_defrost is not None:
            hvac["rearDefrostMode"] = turn(rear_defrost)

        dt = {"pos": 1, "def": 1 if defrost else 0, "tmp": temp_pos, "hvacSettings": hvac}
        return await self.async_perform_ro(vin, "climate_start", data=dt)

    async def async_climate_stop(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "climate_stop")

    async def async_charge_start(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "charging_start")

    async def async_charge_stop(self, vin: str) -> dict | None:
        return await self.async_perform_ro(vin, "charging_stop")

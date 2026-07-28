"""Constants for Mitsubishi Connect NA (US/Canada) — Aeris ATSP backend.

Reverse-engineered from My+Mitsubishi+Connect_v2.88.10 (APKPure build):
- res/oS: bundled Aeris SDK environment/endpoint config
- com/aeris/atsp/service/C1847g.java: env->api-key map, shared headers
- p151h/C7123l.java, p151h/C7124m.java: login / refresh token calls

NA "prod" environment serves both US and Canada accounts.
"""

NA_PROD_HOST = "us-m.aerpf.com"
NA_PROD_PORT = 15443
NA_BASE_URL = f"https://{NA_PROD_HOST}:{NA_PROD_PORT}"

# Decoded from serviceApiKeyByteArrayNaProd byte[] (ASCII-encoded hex string)
NA_PROD_API_KEY = "3f5547161b5d4bdbbb2bf8b26c69d1de"

# Decoded from the SECRET byte[] — static Basic-auth password, not user-specific
CLIENT_TRUSTED_SECRET = "ampClientTrustedSecret"

EP_TOKEN = "/auth/v1/token"
EP_USER_INFO = "/user/v1/users/email/{email}"
EP_VEHICLE_LIST = "/avi/v1/vehicles"
EP_VEHICLE_DETAILS = "/avi/v1/vehicles/{vin}"
EP_VEHICLE_STATE = "/avi/v1/vehicles/{vin}/vehiclestate"
EP_VEHICLE_HEALTH = "/avi/v1/vehicles/{vin}/vehicleStatus"

# Mileage/charging metrics — EV vs gas mileage breakdown, charging sessions, cost.
# res/oS param name is "${vehicleId}" (not "${vin}" like the /avi/* endpoints) —
# unconfirmed whether that means VIN or the internal vehicleContextFk id.
EP_MILEAGE_MONTHLY = "/api/v1/services/metrics/mileage/{vehicle_id}"  # ?year=&month=&timezone=
EP_MILEAGE_YEARLY = "/api/v1/services/metrics/mileage/{vehicle_id}"  # ?year=&timezone=
EP_CHARGING_HISTORY = "/api/v1/services/metrics/charging/{vehicle_id}"  # ?year=&month=&timezone=
EP_CHARGING_COST = "/api/v1/services/metrics/chargingCost/{vehicle_id}"  # ?year=&month=&baseCost=&timezone=

# Found in res/oS but not yet wired into the client — remote commands need the
# PIN-verification flow (getservernonce/getpintoken), which uses the same
# HMAC-SHA256 client/server-nonce hash as the EU integration's _compute_pin_hash.
EP_CHARGING_CONTROL = "/avi/v1/vehicles/{vin}/parentalAlert"  # ?operation=chargingControl
EP_CLIMATE_CONTROL = "/avi/v1/vehicles/{vin}/parentalAlert"  # ?operation=remoteAC
EP_SERVER_NONCE = "/oauth/v3/remoteOperation"
EP_PIN_TOKEN = "/oauth/v3/remoteOperation/pin"
EP_PERFORM_RO = "/avi/v3/remoteOperation"
EP_RO_STATUS = "/avi/v1/remoteOperation/vehicles/{vin}/events/{event_id}"

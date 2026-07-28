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

# Store / promo browsing — read-only, no card or Stripe key needed.
EP_TRIAL_EXPIRY = "/vehicle/v1/vehicles/{vin}/trial/expiry"
EP_PURCHASABLE_PACKAGES_SERVICE = "/vehicle/v1/vehicles/{vin}/getPurchasablePackages"  # categoryFilter=SERVICE
EP_PURCHASABLE_PACKAGES_MOBILITY = "/vehicle/v1/vehicles/{vin}/getPurchasablePackages"  # categoryFilter=MOBILITY_SERVICE
EP_VEHICLE_SUBSCRIPTIONS_ACTIVE = "/vehicle/v2/vehicles/{vin}/subscriptions/active"
EP_VEHICLE_SUBSCRIPTIONS_ALL = "/vehicle/v2/vehicles/{vin}/subscriptions"

# --- Remote Operations (RO) — not yet wired into the client ---
# Full PIN-verify -> command flow, confirmed from decompiled call classes:
#
#   1. GenerateClientNonce (extras/GenerateClientNonce.java): random 16-char
#      string, AES/CBC/PKCS7 self-encrypted with a throwaway random key/iv,
#      base64-encoded -> clientNonce. (Doesn't need to decrypt server-side;
#      it's just a random blob, the encryption is theater.)
#   2. POST EP_SERVER_NONCE {vin, clientNonce}            -> {vin, serverNonce}
#      (p283p/C8761b.java, callName "GetServerNonce")
#   3. GenerateHash(clientNonce, serverNonce, pin) (extras/GenerateHash.java):
#      HMAC-SHA256(key=base64decode(clientNonce)+":"+base64decode(serverNonce),
#      msg=pin) -> XOR first/last 16 bytes of the 32-byte digest -> base64
#      -> hash. IDENTICAL algorithm to the EU integration's _compute_pin_hash.
#   4. POST EP_PIN_TOKEN {vin, hash}                       -> {vin, pinToken}
#      (p283p/C8760a.java, callName "GetPinToken")
#   5. POST EP_PERFORM_RO {vin, operation, forced, pinToken,
#         <operation-specific data key>, userAgent}         -> {eventId, vin,
#         operationType, status}   (p331s/C9336d.java, callName "PerformRO")
#   6. GET EP_RO_STATUS(vin, eventId)                       -> poll for result
#      (result "0" = success; p331s/C9333a.java, callName "GetROStatus")
EP_SERVER_NONCE = "/oauth/v3/remoteOperation"
EP_PIN_TOKEN = "/oauth/v3/remoteOperation/pin"
EP_PERFORM_RO = "/avi/v3/remoteOperation"
EP_RO_STATUS = "/avi/v1/remoteOperation/vehicles/{vin}/events/{event_id}"

# RO_OPERATIONS: the "operation" field value for PerformRO. Source:
# com/aeris/atsp/service/extras/RemoteOperationConstants.java OperationName enum.
# (requirePin flags were lost to decompiler obfuscation-stripping — assume all
# actuation commands need a pinToken; read-only ones like locate/vehicleStatus
# likely don't, matching the EU client's behavior.)
RO_OPERATIONS = {
    "door_lock": "doorLock",
    "door_unlock": "doorUnlock",
    "lights": "lights",
    "horn": "horn",
    "locate": "locate",
    "climate_start": "remoteAC",
    "climate_stop": "engineOff",
    "climate_schedule": "climateControl",
    "charging_start": "chargingControl",
    "charging_stop": "chargingControlStop",
    "charging_schedule": "chargingControl2",
    "vehicle_status_refresh": "vehicleStatus",
    "curfew": "curfew",
    "geofence": "geofence",
    "speed_alert": "speedAlert",
    "privacy_mode": "privacyMode",
    "smart_route": "smartRoute",
    "send_destination": "sendDestination",
    "last_mile_navigation": "lastMileNavigation",
    "charging_history": "chargingHistory",
    "charging_poi": "chargingPoi",
    "door_lock_status": "doorLockUnlockStatus",
    "photo": "remotePhoto",
    "customize": "customize",
    # HVAC sub-options — likely sent as extra data on remoteAC/climateControl
    # rather than standalone top-level operations; exact key strings come from
    # HVACOption enum (not yet decompiled/confirmed).
    "seat_heat_front_left": "frontLeftSeatControl",
    "seat_heat_front_right": "frontRightSeatControl",
    "seat_heat_rear_left": "rearLeftSeatControl",
    "seat_heat_rear_right": "rearRightSeatControl",
    "steering_wheel_heat": "steeringHeaterControl",
    "defrost_front": "frontDefrostMode",
    "defrost_rear": "rearDefrostMode",
}

# --- Vehicle-scoped, generic status/control (query-param dispatched) ---
# All share one endpoint; ?operation= picks the behavior. Distinct from the
# PerformRO write path above — these look like read/status-check variants.
EP_PARENTAL_ALERT = "/avi/v1/vehicles/{vin}/parentalAlert"
# ?operation=chargingControl | chargingControl2 | remoteAC | climateControl
#           | curfew | geofence | speedAlert | privacyMode
EP_CHARGING_CONTROL = EP_PARENTAL_ALERT  # ?operation=chargingControl
EP_CLIMATE_CONTROL = EP_PARENTAL_ALERT  # ?operation=remoteAC

# --- AMS backend scheduler (separate climate-schedule microservice) ---
EP_AMS_CLIMATE_SCHEDULE = "/api/v1/services/climatecontrol/{vin}/schedule"
EP_AMS_CLIMATE_SCHEDULE_STATUS = "/api/v1/services/climatecontrol/{vin}/schedule/status"  # ?correlationId=
EP_DGE_CHARGING_CONTROL = "/api/v1/services/chargingcontrol/vin/{vin}"  # getchargingcontroldge / performchargingstartandstopro

# --- Live vehicle sub-state (avi, VIN-scoped) ---
EP_LOCATION = "/avi/v1/vehicles/{vin}/state/location"  # getlocation
EP_SVLA_STATE = "/avi/v1/vehicles/{vin}/state/svla"  # getsvlastate
EP_VEHICLE_MODE_STATUS = "/avi/v1/vehicles/{vin}/vehiclestate"  # getvehiclemodestatus

# --- Location / navigation ---
EP_VEHICLE_LOCATION = "/api/v1/vehicles/{vehicle_id}/users/{account_dn}/location"  # ?locationType=
EP_SEARCH_LOCATION_HISTORY = "/api/v1/vehicles/{vehicle_id}/users/{account_dn}/location"  # ?locationType=history
EP_SMART_ROUTE = "/api/v1/vehicles/{vehicle_id}/services/smartroute"  # ?history=
EP_SMART_ROUTE_DETAIL = "/api/v1/vehicles/{vehicle_id}/services/smartroute/{schedule_id}"
EP_ROUTE_DETAILS = "/api/v1/services/route/details"
EP_PLACE_ID = "/api/v1/services/place/id"  # ?latitude=&longitude=
EP_PLACE_DETAILS = "/api/v1/services/place/details/{place_id}"  # ?lang=
EP_CHARGING_STATIONS = "/api/v1/services/charging/stations"  # ?latitude=&longitude=&radius=&country=
EP_CHARGING_STATION_DETAIL = "/api/v1/services/charging/details/{poi_id}"
EP_SEND_MEDIA = "/api/v1/vehicles/{vin}/send-media2"

# --- Alerts / curfew settings (parental controls) ---
EP_CURFEW_SETTINGS = "/api/v1/vehicles/{vin}/curfew-settings"

# --- Firmware (FOTA) ---
EP_FOTA_DETAILS = "/ota/ota/v1/{vin}/firmware"  # ?locale=
EP_FOTA_CONSENT = "/ota/ota/v1/{vin}/user/action"
EP_FOTA_STATUS = "/ota/ota/v1/{vin}/status"  # ?locale=

# --- Pairing (device <-> vehicle handshake) ---
EP_PAIRING_CODE = "/vehicle/v1/vehicles/{vin}/pairingCode"  # ?lang=
EP_VERIFY_PAIRING_CODE = "/vehicle/v1/vehicles/{vin}/pairingCode/{pin}"
EP_PAIRING_METADATA = "/v1/metadata/pairing"  # ?make=&model=&year=
EP_PAIRING_ACTION = "/v1/vehicles/{id_type}/{id}/pairing/action"
EP_PAIRING_ACTION_STATUS = "/v1/vehicles/pairing/status"  # ?requestId=
EP_PAIRING_STATUS = "/vehicle/v1/vehicles/{vin}/pairing/status"
EP_VERIFY_VIN = "/vehicle/v1/vehicles/{vin}/verify"

# --- Model service catalog / config ---
EP_MODEL_CONFIGURATIONS = "/api/v1/catalog/oem/model/{model}/services/configuration"  # ?country=&year=
EP_VEHICLE_SERVICES = "/vehicle/v1/vehicles/{vin}/users/{account_dn}/services"
EP_APP_CONFIGURATIONS = "/app/conf"  # ?region=&country=
EP_TERMS_URL = "/applications/v1/content"  # ?lang=&vin=

# --- Factory reset ---
EP_DELETE_VEHICLE = "/vehicle/v1/vehicles/{vin}/users/{account_dn}"  # ?fr=
EP_FACTORY_RESET_INFO = "/vehicle/v1/vehicles/{vin}/users/{account_dn}/factoryreset/info"

# --- Notifications ---
EP_NOTIFIABLE_CHANNELS = "/notification/v1/channels"
EP_NOTIFICATIONS = "/notification/v1/vehicles/{vin}/notifications"
EP_NOTIFIABLE_SERVICES = "/notification/v1/vehicles/{vin}/services"
EP_SEND_DEVICE_TOKEN = "/notification/v1/vehicles/{vin}/notifications/devicetoken"
EP_MARKETING_NOTIFICATION_STATUS = "/user/v1/users/{account_dn}/consent"

# --- Preferences (used to populate registration/settings forms) ---
EP_ALL_STATES = "/preferences/v1/states"  # ?country=&lang=
EP_ALL_COUNTRIES = "/preferences/v1/countries"  # ?region=
EP_ALL_TIMEZONES = "/preferences/v1/timezones"  # ?region=
EP_ALL_LANGUAGES = "/preferences/v1/languages"  # ?region=&country=
EP_USER_PREFERENCES = "/user/v1/users/{account_dn}/preference"
EP_VALIDATE_ADDRESS = "/user/v1/users/address/validate"  # ?lang=

# --- Store / cart / payments (see mitsubishi_na payment research — read-only
# browsing is fine; do NOT build a purchase flow) ---
EP_STORE_PRODUCTS = "/store/v1/products"  # ?lang=
EP_STORE_PRODUCTS_DEFAULT = "/store/v1/products/default"  # ?lang=
EP_STORE_PRODUCTS_DEALER = "/store/v1/products/dealer"
EP_STORE_PRODUCT_SKU = "/store/v1/products/sku"
EP_PRODUCT_PACKAGES = "/product/v2/packages"  # ?category=MOBILITY_SERVICE&lang=
EP_CART_CREATE = "/cart/v1/carts"
EP_CART_DETAILS = "/cart/v1/carts/{cart_id}"
EP_SALES_TAX = "/payments/v1/salesTax"
EP_PURCHASE = "/payments/v1/purchase"
EP_CANCEL_SUBSCRIPTION = "/payments/v1/cancelSubscription"
EP_WALLET_CARDS = "/wallet/v1/card/user/{user_id}"
EP_WALLET_CARD = "/wallet/v1/card/{card_id}"
EP_WALLET_CARD_STRIPE_V2 = "/wallet/v2/card/user/{user_id}"
EP_PUBLISHABLE_KEY = "/wallet/v1/getPublishableKey"  # ?region=&country=

# --- Chamberlain / MyQ (garage door) — separate subscription, own namespace ---
EP_MYQ_GET_CONSUMER = "/chmbln/v1/consumer/{account_dn}/{vin}"
EP_MYQ_CREATE_CONSUMER = "/chmbln/v1/consumer"
EP_MYQ_SAVE_LINK = "/chmbln/v2/consumer"
EP_MYQ_GARAGE_DOORS = "/chmbln/v2/consumer/{account_dn}/garage-doors"  # ?vid=
EP_MYQ_GARAGE_DOOR = "/chmbln/v2/consumer/{account_dn}/garage-doors/{serial}"  # ?vid=
EP_MYQ_GARAGE_DOOR_ACTION = "/chmbln/v2/action/{serial}"
EP_MYQ_UNLINK = "/chmbln/v1/consumer/{account_dn}/{vin}"

# --- DealerFX (service scheduling) ---
EP_DEALER_SERVICES = "/dlrfx/v1/services/{vin}/{type}"  # ?odometer=&dealershipId=
EP_DEALER_TIMESLOTS = "/dlrfx/v1/service_timeslots/{date}"  # ?dealershipId=
EP_DEALER_SERVICE_INTERVALS = "/dlrfx/v1/vehicles/{vin}/service_intervals"  # ?odometer=
EP_DEALER_APPOINTMENT_CREATE = "/dlrfx/v1/service_appointments"
EP_DEALER_APPOINTMENT_UPCOMING = "/dlrfx/v1/vehicles/{vin}/service_appointments"
EP_DEALER_APPOINTMENT_UPDATE = "/dlrfx/v1/service_appointments/{appointment_id}"
EP_DEALERS_LOCATE = "/dlrfx/v1/dealerships/locate"  # ?lat=&lng=&distance=
EP_DEALERS_FAVORITE = "/dlrfx/v1/dealerships/{customer_id}/{vin}"  # ?lat=&lng=

# --- Legacy / marked "not being used" in res/oS, kept for reference only ---
EP_LEGACY_USER_REGISTRATION = "/mts/mts-api/oem/v1/vehicles/user"
EP_LEGACY_VERIFY_PIN = "/mts/mts-api/oem/v1/services/userRegistration"

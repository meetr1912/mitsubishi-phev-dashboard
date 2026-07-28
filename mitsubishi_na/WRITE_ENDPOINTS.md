# Full write-endpoint inventory (POST / PUT / DELETE)

Every `HttpCall` subclass across the decompiled app, grouped by HTTP method, cross-referenced
against `res/oS` for the actual path template. The SDK only has 4 methods total —
`Post, Put, Get, Delete` — there is no PATCH anywhere (`HttpCall.Method` enum,
`com/aeris/comms/protocol/http/HttpCall.java:27-32`).

This is a reference inventory only — nothing here has been called.

## POST

| Call name | Path | Area |
|---|---|---|
| GetToken | `/auth/v1/token` | auth (login) |
| GetUpdatedToken | `/auth/v1/token` | auth (refresh) |
| ForgotPassword | `/auth/v1/mail/password` | auth |
| RegisterUser | `/user/v1/users/register` | account |
| CreateTempUser | `/user/v1/userprofile` | account |
| ValidateAddress | `/user/v1/users/address/validate` | account |
| AddVehicle | `/user/v1/users/{account}/vehicles` | vehicle/pairing |
| CreatePairingCode | `/vehicle/v1/vehicles/{vin}/pairingCode` | vehicle/pairing |
| PostPairingAction | `/v1/vehicles/{idType}/{id}/pairing/action` | vehicle/pairing |
| vehiclewakeup | `/api/v1/services/wakeup/vehicle/{vin}` | vehicle |
| GetServerNonce | `/oauth/v3/remoteOperation` | remote-op (PIN flow) |
| GetPinToken | `/oauth/v3/remoteOperation/pin` | remote-op (PIN flow) |
| PerformRO | `/avi/v3/remoteOperation` | remote-op (lock/unlock/horn/lights/climate/charge/etc) |
| PerformAMSClimateControlRO | `/api/v1/services/climatecontrol/{vin}/schedule` | climate schedule |
| PerformChargingStartAndStopRO | `/api/v1/services/chargingcontrol/vin/{vin}` | charging |
| SendDeviceToken | `/notification/v1/vehicles/{vin}/notifications/devicetoken` | notifications |
| AddNotification | `/notification/v1/vehicles/{vin}/notifications` | notifications |
| CreateCurfewSetting | `/api/v1/vehicles/{vin}/curfew-settings` | parental control |
| CreateOrUpdateProfile (create variant) | `/profile/v1/custom/{vin}/{profile_name}` | customize/presets |
| CreateSmartRoute | `/api/v1/vehicles/{vehicleId}/services/smartroute` | smart route |
| AddDestination | `/api/v1/vehicles/{vehicleId}/users/{accountDn}/location` | destinations |
| SendDestinationToCar | `/api/v1/vehicles/{vehicleId}/services/location` | destinations |
| getwaypointdetail | `/api/v1/services/route/details` | smart route (POST despite the name) |
| SendMedia | `/api/v1/vehicles/{vin}/send-media2` | remote photo |
| AddCreditCardWithStripe | `/wallet/v2/card/user/{userId}` | payments |
| CreateCart | `/cart/v1/carts` | payments |
| Purchase | `/payments/v1/purchase` | payments |
| SendFotaConsent | `/ota/ota/v1/{vin}/user/action` | firmware update |
| CreateConsumer | `/dlrfx/v1/customers` | DealerFX |
| CreateAppointment | `/dlrfx/v1/service_appointments` | DealerFX |
| UpdateFavoriteDealers | `/dlrfx/v1/dealerships/{customerId}/{vin}` | DealerFX (POST despite "Update") |
| GetConsumerVidService | `/chmbln/v1/consumer` | MyQ/Chamberlain (POST despite "Get") |
| SetGarageDoorService | `/chmbln/v2/consumer/{accountDN}/garage-doors/{serial}` | MyQ garage door |
| ChangeGarageDoorStatusService | `/chmbln/v2/action/{serial}` | MyQ garage door (the actual open/close command) |

## PUT

| Call name | Path | Area |
|---|---|---|
| ResetPassword | `/auth/v1/password/{email}` | auth |
| UpdateUserName | `/auth/v1/mail/username` | account |
| UpdateUserProfile | `/user/v1/users/{account}/profile` | account |
| SetUserPreferences | `/user/v1/users/{accountDN}/preference` | account |
| UpdateMarketingNotificationStatus | `/user/v1/users/{accountDN}/consent` | consent (MKTNOTIF / USERDATACONSENT) |
| UpdateNickName | `/vehicle/v1/vehicles/{vin}/users/{accountDN}/nickname` | vehicle |
| UpdateNotification | `/notification/v1/vehicles/{vin}/notifications` | notifications |
| CreateOrUpdateProfile (update variant) | `/profile/v1/custom/{vin}/{profile_name}` | customize/presets |
| UpdateSmartRoute | `/api/v1/vehicles/{vehicleId}/services/smartroute/{scheduleId}` | smart route |
| UpdateCreditCard | `/wallet/v1/card/{cardId}` | payments |
| UpdateCart | `/cart/v1/carts/{cartId}` | payments |
| UpdateAppointment | `/dlrfx/v1/service_appointments/{id}` | DealerFX |
| SaveConsumerLinkService | `/chmbln/v2/consumer` | MyQ/Chamberlain |

## DELETE

| Call name | Path | Area |
|---|---|---|
| DeleteDeviceToken | `/notification/v1/vehicles/{vin}/notifications/devicetoken` | notifications |
| DeleteNotification | `/notification/v1/vehicles/{vin}/notifications/target` | notifications |
| DeleteVehicle | `/vehicle/v1/vehicles/{vin}/users/{accountDN}?fr={fr}` | **cancel account / remove vehicle / factory reset — one endpoint, `fr` flag decides which** |
| UpdatePairingStatus | `/v1/vehicles/pairing/status?requestId={id}` | pairing (DELETE despite "Update") |
| DeleteProfile | `/profile/v1/custom/{vin}/{profile_name}` | customize/presets |
| DeleteSmartRoute | `/api/v1/vehicles/{vehicleId}/services/smartroute/{scheduleId}` | smart route |
| RemoveSmartRoute | `/api/v1/vehicles/{vehicleId}/services/smartroute/{routeId}` | smart route (separate class, different id param name) |
| RemoveDestination | `/api/v1/vehicles/{vehicleId}/users/{accountDn}/location/{locationId}` | destinations |
| DeleteCreditCardWithStripe | `/wallet/v2/card/{cardId}` | payments |
| cancelAppointment | `/dlrfx/v1/service_appointments/{id}` | DealerFX |
| UnlinkAccountService | `/chmbln/v1/consumer/{accountDN}/{vin}` | MyQ/Chamberlain |

## Notable patterns

- **DeleteVehicle is the single most overloaded endpoint** — cancel account, remove a vehicle, and
  factory-reset the telematics unit are all this one DELETE call with different `fr` values (already
  covered in `APP_REVIEW_NOTES.md`).
- **Naming doesn't always match method**: `UpdateFavoriteDealers`/`GetConsumerVidService` are POST,
  `UpdatePairingStatus` is DELETE — call names are historical, not semantically reliable.
- **The write surface concentrated in a few areas**: remote operations (PIN flow + PerformRO),
  smart route planner (full CRUD), notifications (full CRUD), payments/cart/wallet, DealerFX
  appointments, and MyQ garage door — all fully catalogued above.
- Nothing here writes to `getmodelconfigurations` or any vehicle-entitlement/subscription record
  directly except the legitimate `Purchase`/`CancelSubscription` flow — consistent with the earlier
  finding that there's no edit API for model config.

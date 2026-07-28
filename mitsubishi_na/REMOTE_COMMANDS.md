# Remote commands (NA / Aeris) — working recipe

Confirmed working end-to-end on VIN JA4T5VA98SZ609726 (lights flashed, GetROStatus → `Successful`).

## The sequence (what the app does, what we replicate)

1. **Wakeup** — `POST /api/v1/services/wakeup/vehicle/{vin}`
   body `{"operation":"wakeUp","operationType":1,"vehicleId":vin,"timeStamp":"<epoch ms>","data":{}}`.
   Rouses the TCU from deep sleep. **Skipping this was why the first attempt silently failed**
   (car asleep → command dropped → `GetROStatus` 400 EventNotFound). Wait ~15-25s after.
2. **(only unlock/locate)** mint a pinToken: `GetServerNonce` → HMAC hash → `GetPinToken` (201).
3. **PerformRO** — `POST /avi/v3/remoteOperation`
   body `{"vin","operation","forced":"true","userAgent":"android"[, "dt":{...}][, "pinToken"]}`.
   Returns `{eventId, status:"Started"}`.
4. **Poll** `GET /avi/v1/remoteOperation/vehicles/{vin}/events/{eventId}` every 5s until
   `status` ∈ {Successful, failed, inqueue}. Progression seen: `Started → MessageDelivered → Successful`.

Transport is plain HTTPS (`us-m.aerpf.com:15443`). The signed-MQTT path in the SDK is dead code
in this build — not used for commands.

## Per-command payload

| Command | op string | needs PIN | `dt` data body | Status |
|---|---|---|---|---|
| lights | `lights` | no | `{"lct":"1","lt":"0"}` | ✅ confirmed |
| horn | `horn` | no | — (none) | ready |
| lock | `doorLock` | no | — | ready |
| unlock | `doorUnlock` | **yes** | — | ready |
| locate | `locate` | **yes** | — | ready |
| climate_start | `remoteAC` | no | `{"pos":1,"def":0,"tmp":16,"hvacSettings":{...}}` | ✅ confirmed |
| climate_seats | `remoteAC` | no | `{"hvacSettings":{seat/steering fields}}` | ✅ confirmed |
| climate_stop | `engineOff` | no | — | ✅ confirmed |
| charge_start | `chargingControl` | no | `{"chargingControlType":1}` | best-effort |
| charge_stop | `chargingControlStop` | no | `{"chargingControlType":2}` | best-effort |

"best-effort" = payload shape is right but exact int values are unverified; run it and let
`GetROStatus` (now definitive) confirm Successful vs failed.

## Climate `hvacSettings` — full field catalog (inside remoteAC `dt`)

Serialized by Gson → enum values are the enum NAME (no custom string). Only non-null fields
are emitted. Start-branch defaults (BEClimatePresenter): `fanMode:"VENT_FEET", checkNumber:75,
operationTime:10`.

| Field | Values | Meaning |
|---|---|---|
| fanMode | `"VENT_FEET"` / `"DEFROST"` | vent mode |
| checkNumber | `75` | (fixed default) |
| operationTime | `10` | runtime minutes |
| frontLeftSeatControl | `"HEATER_ON"` / `"HEATER_OFF"` | driver seat heat |
| frontRightSeatControl | `"HEATER_ON"` / `"HEATER_OFF"` | passenger seat heat |
| rearLeftSeatControl | `"HEATER_ON"` / `"HEATER_OFF"` | rear-left seat heat |
| rearRightSeatControl | `"HEATER_ON"` / `"HEATER_OFF"` | rear-right seat heat |
| steeringHeaterControl | `"TURN_ON"` / `"TURN_OFF"` | heated steering wheel |
| frontDefrostMode | `"TURN_ON"` / `"TURN_OFF"` | front defrost |
| rearDefrostMode | `"TURN_ON"` / `"TURN_OFF"` | rear defrost |
| functionRequest | `"TURN_ON"` / `"TURN_OFF"` | (present in model; unused in start branch) |

`dt` outer keys: `pos` (always 1), `def` (0/1 defrost), `tmp` (posmap index — NOT a temperature).

### Temperature posmap (DGE / 2025 / CA) — `tmp` index → temp
pos 1 = LO, pos 2 = 18.0 °C, then +0.5 °C per step … pos 16 = 25.0 °C (default), … pos 30 = 32.0 °C,
pos 31 = HI. (Full ladder in the model-config `getmodelconfigurations` response.)

Seat/steering/defrost are exposed via `async_climate_start(..., seat_fl=True, steering=True, ...)`.
✅ confirmed live 2026-07-28 (`climate_seats`: seat_fl+seat_fr+steering → `Successful` in 15s;
`climate_stop`: `engineOff` → `Successful` in 5s).

## Status codes seen in GetROStatus
`Started` → `MessageDelivered` (reasonCode 915) → `Successful` (reasonCode 1001). `failed`/`failure`
would carry a reasonCode identifying the rejection.

## Run

```bash
export MMC_USERNAME=... MMC_PASSWORD=... MMC_PIN=1411   # PIN only for unlock/locate
python3 scripts/test_na_remote_command.py <command>     # default: lights
```

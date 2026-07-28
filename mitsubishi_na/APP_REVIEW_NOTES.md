# My Mitsubishi Connect (NA) — App Review Notes

Findings from a 7-way parallel sweep of the decompiled v2.88.10 APK, beyond what's already
wired into `api.py`/`const.py`. Two sweep areas (`vehicle_config`, `integrations`) failed to
produce structured output and were not retried. Read-only research; no live calls made.

## Privacy / data-handling (most consequential)

- **Crashlytics captures full HTTP/MQTT payloads as crash breadcrumbs.** `CrashlyticsUtility.log()`
  whitelists lines starting with `"http url ="`, `"http payload ="`, `"mqtt payload ="`,
  `"RemoteOperation"`, etc., and forwards them to Firebase Crashlytics. These payloads include VIN,
  GPS position, and remote-command bodies/signatures. Collection is force-enabled at launch, no
  opt-in gate in code.
  (`com/aeris/atsp/service/extras/CrashlyticsUtility.java:17-37`)
- **Crashlytics user ID is set to the live OAuth bearer token, then the email.**
  `AppData` calls `setUserIdentifierCrashlytic()` first with the access token, then with the
  username — ties every crash session to a live credential/email, not an anonymous ID.
  (`extras/AppData.java:291,834`)
- **Account email sent as a plaintext Firebase Analytics event parameter** on login
  success/failure and a "WrongPosmapDetected" event — against Firebase's own PII policy.
  (`sections/getstarted/ConnectingSection.java:322-336`)
- **Salesforce Marketing Cloud keys identity to the raw email** (contact key = username). Bundled
  but dormant: a full AltBeacon Bluetooth-beacon/geofence proximity-messaging module — not enabled
  in this build, but present and could be flipped on server-side without a client update.
- **Device calendar (title + location + start time)** is read for the Smart Route Planner feature
  to suggest destinations from upcoming calendar events.
- Good news: **precise GPS/lat-lng is NOT sent to Firebase Analytics** for any navigation/route
  event — only the action name fires, with a null parameter map.
- TestFairy (session-recording SDK) is bundled but never initialized — dead weight, not currently
  a capture channel.
- Hardcoded Google Maps/Places API keys and a Firebase Realtime DB URL are embedded in the
  manifest/resources (expected for a shipped app, but concrete artifacts if ever needed).

## Hidden debug/QA surface

- **`DevSection`** — a full hidden developer panel: switch backend across 9 environments
  (prod/eu-prod/asean-prod/staging/eu-staging/asean-staging/gcp_pace/dev/env_custom), a "DEV MODE"
  toggle, a language-debug locale picker, an **"SRI" toggle that disables remote-operation payload
  signing** (`C1847g.SECURE_PAYLOAD`), and a custom-environment dialog (arbitrary host/port/API
  key/certs). Not reachable via any in-app navigation in this build — only via the separate debug
  `MainActivity` or a debug build variant.
- **The production app still honors these prefs at every launch** even with no UI path to set
  them — `MainActivity2` reads `mmc_env`/`mmc_env_custom`/`secure-payload` from SharedPreferences
  on startup regardless.
- `res/oS` reveals the **full non-prod host map**: `dev=us-m-dev01.aerjupiter.com`,
  `staging=staging-us-m.aerpf.com`, `gcp_pace=us-m-pace.aerjupiter.com`, plus a **`sim_prod`
  simulator backend** (`/api-gateway/mdb-api/vehicles`) distinct from the real REST surface —
  this is what the separate debug `MainActivity` hardcodes.
- Aeris SDK has a third mode: `enableTestMode()` swaps the entire service singleton for a
  `ServiceShadow` mock implementation.
- A generic dev-mode fixture dispatcher serves canned JSON for any API call by name (asset files:
  `getpintoken`, `performro_*`, `getvehiclehealthdata`, `getservernonce`, etc.) — distinct from the
  known VHR demo-mode system.

## Remote-control capabilities not yet in our client

- **Curfew** = named, recurring time-window alert: `startDate`+`endDate` (or `duration`) +
  day-of-week repeat mask. Status enum values are non-obvious: `Enabled=0, Deleted=1, Disabled=2`.
- **Geofence supports both circular (center+radius) AND arbitrary polygon shapes** — `ShapeType`
  0/1 — though the UI only exposes circular.
- **Speed alert** default is 40 km/h, single threshold (not a band), MPH conversion factor
  hardcoded as `1.6093`. Server returns per-vehicle `minSpd`/`maxSpd` bounds.
- **`privacyMode` is one of four server-defined "service modes"** — Privacy / FactoryReset /
  Diagnostic / SVLA — each a `{mode, services[]}` mapping that suppresses a listed set of
  telematics services. Current mode reflected in DealerFX vehicle state (`privacy`, `svla`,
  `diagnostic`, `factoryReset`, `theftAlarm` fields).
- **`remotePhoto`** is a fire-and-forget `SendMedia` command (`{operation, userId}`) — no camera
  access or image bytes in the client; the vehicle/backend produces the photo asynchronously and
  a push notification (`AMPP-0123-C0`) delivers it.
- **`customize`** = named, saved personalization **preset profiles** — categories of numeric
  config-key/config-value (`cn`/`cv`) pairs, options streamed from the vehicle itself (not
  hardcoded), activated/created/deleted independently.
- **Seat heat is binary on/off only** (no multi-level); steering-wheel heater and front/rear
  defrost are also plain on/off. Climate extras not previously catalogued: `operationTime`
  (default 10 min runtime), `checkNumber` (default 75), fan mode enum, dual-zone L/R temperature.
- Server-provided per-service config bounds object supplies the real UI ranges: `posmap` (a
  discrete temperature ladder mapping position→°C/°F strings — AC temp is stepped, not free-float),
  `minSpd`/`maxSpd`, geofence radius bound, curfew age bound.
- **FOTA (firmware update) consent flow** — fully separate, uncatalogued capability:
  `GetFotaDetails`/`GetFotaStatus`/`SendFotaConsent`, push-notification-initiated, user must
  consent before an update proceeds.
- **Factory reset / vehicle deregistration** — engine-off gated precondition, maps to the
  `FactoryReset` service mode.
- Full alert-recipient model: named contacts + channel (SMS/email/push) subscriptions per alert
  type, separate from the alert payloads themselves.

## EV-specific

- **Charging station finder is Mitsubishi/Aeris's own database** (`/api/v1/services/charging/stations`)
  — not ChargePoint/Electrify America/PlugShare. Per-station: AC/DC connector type, rated kW,
  available/total charger counts, 24hr flag, dealer flag.
- **Charging cost estimator uses a single flat user-entered rate** — no time-of-use/peak/off-peak
  modeling anywhere in the app.
- **Driving score (eco-driving gamification) is free** — overall/accel/steer/brake sub-scores plus
  a fuel-economy score, already embedded in the existing `vehicleStatus` (VHR) response under key
  `drivingScore` — no new endpoint needed to add this as a sensor.
- **Smart Route Planner**: schedules a destination + cabin-preconditioning target temperature for
  a departure time, pulled from the **device calendar**, with eco/fastest/shortest route priority.
  This is the app's actual preconditioning mechanism (cabin only, not battery).
- Can push a destination (including a chosen charging station) directly to the vehicle's nav via
  `/api/v1/vehicles/{id}/services/location`.
- Confirmed absent: V2L/V2H/V2G, time-of-use rates, any third-party charging-network/POI SDK,
  standalone battery preconditioning.

## Account / misc settings

- **"Cancel Account" and "Remove Vehicle" are the same `DeleteVehicle` API call**, differing only
  by a boolean `fr` (factory-reset) flag — cancel-account is primary-user-gated and behaves as a
  full logout only if it's your last vehicle.
- **Consent is exactly two server-side flags**: `MKTNOTIF` (marketing) and `USERDATACONSENT`
  (data-sharing), read/written one at a time via a shared endpoint. A third, separate layer
  gates per-channel (EMAIL/SMS/PUSH) notification opt-in behind a legal-acknowledgement popup.
- **Zendesk is FAQ browsing + an anonymous async ticket form** — native live-chat/messaging UI is
  explicitly disabled (`withContactUsButtonVisible(false)`).
- **CCPA "Do Not Sell" link only shows for US-registered vehicles; the data-sharing consent toggle
  only shows for JP vehicles** — as a Canadian account, you get neither privacy self-service
  surface in the Help section.
- **No emergency-contacts feature in NA at all** (that's EU-only) and **no GDPR/CCPA-style
  data-export (DSAR) flow** anywhere in the app.
- Multi-vehicle handling is a simple persisted "active vehicle" index (garage carousel) — no real
  fleet console; `isFleet` vehicles are just routed around the trial/paywall gating.

## Not retried (agent failures)

`vehicle_config` (unit prefs, driver profiles, key-fob management) and `integrations` (voice
assistants, CarPlay/Android Auto, wearables, roadside-assistance partner) sweeps failed to
produce valid structured output after retries. Can re-run if useful.

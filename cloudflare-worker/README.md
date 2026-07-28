# phev-command-relay

A Cloudflare Worker that relays vehicle remote-commands from the phone dashboard
to Mitsubishi's Aeris ATSP API (`us-m.aerpf.com:15443`).

It exposes a single endpoint, `POST /command`, gated by a shared secret. It logs
into the Mitsubishi Connect account, looks up the VIN, runs the PIN-verification
handshake, and issues the mapped remote operation.

Supported actions: `lock`, `unlock`, `horn`, `lights`, `locate`.

## Deploy

```bash
# 1. Install the Cloudflare CLI (once, globally)
npm install -g wrangler

# 2. Install dev dependencies for this project
npm install

# 3. Authenticate wrangler with your Cloudflare account (opens a browser)
wrangler login

# 4. Set the four secrets (each prompts for the value, nothing is written to disk)
wrangler secret put MMC_USERNAME      # Mitsubishi Connect account email
wrangler secret put MMC_PASSWORD      # Mitsubishi Connect account password
wrangler secret put MMC_PIN           # 4-digit remote-operation PIN
wrangler secret put DASHBOARD_API_KEY # the shared key the dashboard sends as X-Dashboard-Key

# 5. Deploy
wrangler deploy
```

After `wrangler deploy` finishes it prints the deployed URL, e.g.
`https://phev-command-relay.<your-subdomain>.workers.dev`.

**Paste that URL into `docs/app.js`** — set the `CONFIG.WORKER_URL` constant to it
(without a trailing slash). The dashboard POSTs to `CONFIG.WORKER_URL + "/command"`.

## Test with curl

```bash
curl -i -X POST https://phev-command-relay.<your-subdomain>.workers.dev/command \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: <the DASHBOARD_API_KEY value you set>" \
  -d '{"action":"lock"}'
```

Expected responses:

- `200 {"success":true,"message":"Command 'lock' sent to vehicle."}`
- `401 {"success":false,"error":"Unauthorized"}` — wrong/missing `X-Dashboard-Key`
- `400 {"success":false,"error":"Missing 'action'"}` — bad body
- `501 {"success":false,"error":"Not implemented yet — requires MQTT command channel (see README)."}`
  — for any climate-family / unsupported action
- `502 {"success":false,"error":"..."}` — an upstream Aeris call failed

## Known limitations

- **Climate / defrost / seat-heat / steering-wheel-heat are NOT implemented.**
  Actions `defrost`, `seat_heat`, `steering_heat`, `climate` (and any other
  non-mapped action) return **HTTP 501**. They are honestly not stubbed to fake
  success. Two candidate paths were investigated in depth; **neither is safe to
  build yet**, and both are documented below so a future session has a concrete
  starting point rather than "needs MQTT" hand-waving.

  ### Why not the AMS REST scheduler (`POST /api/v1/services/climatecontrol/${vin}/schedule`)

  This endpoint exists and carries `hvacSettings` (seat/steering/defrost/fan
  fields), but decompiled analysis shows it is **schedule-only, not an immediate
  trigger**:
  - It is built by `PerformAMSClimateControlRO` (`p331s/C9334b.java`), created
    only for op `RemoteClimateControlScheduler` (`p331s/C9337e.java:15-16`).
  - The body is a list of up to 3 **weekly recurring timers**. `SchedulePayload`
    (`SchedulePayload.java:8-16`) has only `everyMonday..everySunday`,
    `serviceScheduleType`, and `endTimeOfDay` — a seconds-of-day **departure
    time** the backend pre-conditions the cabin *by*. There is no "run now" field;
    `conditioningAction` is hardcoded `0` (Mapper line 178). The UI action is
    literally `performSaveSchedule` (`ClimateBEScheduleListPresenter.java:366`).
  - A "set `endTimeOfDay ≈ now + 1 min`, today's day-flag = 1" workaround might
    coax near-immediate conditioning, but lead time is a variable backend
    heuristic (temp / SoC / charging) with **no discoverable minimum**, and
    `serviceScheduleType=1` **recurs weekly** (would need a follow-up delete). It
    is unreliable and could silently create a standing daily timer on a real car,
    so it is deliberately not wired.
  - **Still INCONCLUSIVE even for that hack:** whether the REST backend accepts
    the gson enum-name strings (`"HEATER_ON"`, `"DEFROST"`, …) vs ints for
    `hvacSettings`; whether a one-time (non-weekly) `serviceScheduleType` exists;
    whether a near-now departure is honored as instant. Resolving these needs one
    live POST to observe the response.

  ### Why not a hand-rolled MQTT client (immediate `RemoteAC`)

  Immediate climate is MQTT-only. Cloudflare Workers' TCP Socket API
  (`connect()` from `cloudflare:sockets`, TLS to `ssl://us-m.aerpf.com:18883`) is
  **transport-feasible** — a ~200-LOC MQTT 3.1.1 CONNECT + PUBLISH is
  well within reach and needs no config bump. The blocker is the **protocol
  shape**, which is genuinely not knowable from static analysis. Verified against
  `p151h/C7113b.java` (`mo3198b`): the RemoteAC request/response **topics, QoS,
  the `signature` flag (line 173), and the envelope `keyFields` (lines 182-188)
  are all delivered per-operation in the live `clientregistrationresponse`**, not
  in the static `res/oS` config. The commonly-cited topic `/mmc/ro/${vin}/remoteAC`
  is an **inference from a naming convention, not a captured value**. Firing a
  guessed topic/envelope at a real vehicle's heaters and defrost is exactly the
  kind of blind command this project refuses to ship.

  **What is missing — capture these once from a live app session (e.g. mitmproxy
  / an on-device MQTT trace) and the rest is buildable:**
  1. The `clientregistrationresponse` for the account, specifically the RemoteAC
     entry's `request.topic`, `request.qos`, `request.signature`, `request.keyFields`,
     `response.topic`, and `response.qos` (parsed at `C7113b.java:156-206`).
  2. The per-vehicle `sessionKey` from that same response (`C7113b.java:120`) —
     `ckey` is derived from it (3DES/CBC decrypt keyed by MD5(PIN), split on `:`,
     take `[1]`; `MqttProtocol.java:357-397`). Needed only if `signature==1`, in
     which case the payload also needs an HMAC-SHA256 `s` over the `p`-array.
  3. The `fd` envelope constant and the temperature `posmap` (`climate_pos_map_*`)
     config values.
  4. Confirmation of whether the backend executes a hand-built `hvacSettings`
     **immediately** vs. treats it as a schedule.

  What *is* already confirmed (so it is not lost): the inner `dt` payload shape —
  `{"pos":1,"def":0|1,"tmp":<posmap idx>,"hvacSettings":{…}}`
  (`DataRemoteAC.java:117-139`); and the `hvacSettings` field names + gson
  enum-name serialization — `frontLeft/frontRight/rearLeft/rearRightSeatControl`,
  `steeringHeaterControl`, `frontDefrostMode`, `rearDefrostMode`, `fanMode`,
  `functionRequest` (values `HEATER_ON`/`HEATER_OFF`/`TURN_ON`/`TURN_OFF`/`NO_ORDER`,
  `fanMode` ∈ `VENT_FEET`/`DEFROST`), plus int `operationTime`, `checkNumber`
  (`ClimateProperty.java:21-63`). Broker auth is server-auth TLS (not mTLS):
  MQTT username = device `clientId`, password = OAuth `access_token`
  (`MqttProtocol.java:373-451`).

- **The PIN-verify and remote-operation calls are unverified against live data.**
  The read-only side of this auth flow (login, VIN lookup) is validated working
  by the sibling Python client. The remote-operation half is a faithful port of
  the reverse-engineered spec but has **never been exercised against a real
  response**. Specifically unverified:
  - the two-step nonce handshake request/response field names
    (`clientNonce` / `serverNonce`);
  - passing `internalVin` equal to `vin` (unknown whether this platform
    distinguishes them);
  - the perform-operation endpoint path (`/avi/v3/remoteOperation`), its body
    field names, and the `operation` values (`doorLock` / `doorUnlock` / `horn`
    / `lights` / `locate`).
  The PIN-hash algorithm itself (XOR-fold of HMAC-SHA256 over
  `clientNonce || ':' || serverNonce`) is the one validated in the EU sibling
  client. Treat first live runs as a debugging session.

- **Outbound port 15443.** The Aeris host uses a non-standard HTTPS port.
  Cloudflare Workers allow arbitrary outbound ports to non-Cloudflare
  destinations, so this is expected to work, but it has not been confirmed on a
  live deploy.

- **No token caching.** A fresh login runs on every command invocation (fine for
  a low-frequency personal dashboard; no KV/Durable Object storage is used).

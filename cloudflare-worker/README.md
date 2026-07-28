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
  non-mapped action) return **HTTP 501**. Those commands do not go over the same
  HTTPS remote-operation channel — the app drives them over an **MQTT command
  channel**, which is not built here. Cloudflare Workers' TCP Socket API
  (`connect()` from `cloudflare:sockets`) could *theoretically* carry an MQTT
  session, but that path is **unbuilt and unverified**. These are not stubbed to
  fake success — they honestly return 501.

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

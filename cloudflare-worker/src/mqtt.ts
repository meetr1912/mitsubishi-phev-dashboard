/**
 * Minimal hand-rolled MQTT 3.1.1 client for Cloudflare Workers, using the
 * `cloudflare:sockets` TCP API (TLS via secureTransport:"on").
 *
 * Scoped ONLY to the client-registration discovery handshake documented in
 * the decompiled p151h/C7113b.java (MqttCall subclass, methods mo3197a /
 * mo3198b): CONNECT, SUBSCRIBE to the registration-response topic, PUBLISH a
 * registration request, read back exactly one response PUBLISH, then
 * disconnect. This is deliberately NOT a general-purpose MQTT library — no
 * reconnect, no QoS>0 ack handling, no will messages, no persistent session.
 * It does not send anything that could actuate the vehicle.
 *
 * Confirmed from decompiled source (see cloudflare-worker/README.md for the
 * full citation list):
 *   - broker: ssl://us-m.aerpf.com:18883, TLS server-auth only (not mTLS)
 *   - CONNECT username = clientId, password = OAuth access_token
 *   - registration request topic  = /clientregistration/{accountDN}
 *   - registration response topic = /clientregistrationresponse/{accountDN}
 *   - SECURE_PAYLOAD=true -> request body wrapped as {"p":[{"accountDN":...}]}
 *   - response shape (per vehicle): {sessionKey, statusChange, config,
 *     operations:[{name, request:{signature,topic,qos,keyFields},
 *     response:{topic,qos,keyFields}, dataChannel}]}
 */
import { connect } from "cloudflare:sockets";

const PACKET_CONNECT = 1;
const PACKET_CONNACK = 2;
const PACKET_PUBLISH = 3;
const PACKET_SUBSCRIBE = 8;
const PACKET_SUBACK = 9;
const PACKET_PINGRESP = 13;
const PACKET_DISCONNECT = 14;

interface MqttPacket {
  type: number;
  flags: number;
  payload: Uint8Array;
}

function encodeRemainingLength(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return bytes;
}

function encodeUtf8String(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}

function buildPacket(type: number, flags: number, variableHeaderAndPayload: number[]): Uint8Array {
  const remainingLength = encodeRemainingLength(variableHeaderAndPayload.length);
  return new Uint8Array([(type << 4) | flags, ...remainingLength, ...variableHeaderAndPayload]);
}

function buildConnect(opts: { clientId: string; username: string; password: string; keepAlive: number }): Uint8Array {
  const protocolName = encodeUtf8String("MQTT");
  const protocolLevel = 4; // 3.1.1
  // Connect flags: username(0x80) | password(0x40) | cleanSession(0x02)
  const connectFlags = 0x80 | 0x40 | 0x02;
  const keepAliveBytes = [(opts.keepAlive >> 8) & 0xff, opts.keepAlive & 0xff];
  const variableHeader = [...protocolName, protocolLevel, connectFlags, ...keepAliveBytes];
  const payload = [
    ...encodeUtf8String(opts.clientId),
    ...encodeUtf8String(opts.username),
    ...encodeUtf8String(opts.password),
  ];
  return buildPacket(PACKET_CONNECT, 0, [...variableHeader, ...payload]);
}

function buildSubscribe(packetId: number, topic: string, qos: number): Uint8Array {
  const variableHeader = [(packetId >> 8) & 0xff, packetId & 0xff];
  const payload = [...encodeUtf8String(topic), qos];
  return buildPacket(PACKET_SUBSCRIBE, 2, [...variableHeader, ...payload]); // fixed flags = 0x2
}

function buildPublish(topic: string, payloadBytes: Uint8Array, qos = 0): Uint8Array {
  const variableHeader = encodeUtf8String(topic); // QoS0 -> no packet id
  const body = [...variableHeader, ...Array.from(payloadBytes)];
  return buildPacket(PACKET_PUBLISH, qos << 1, body);
}

/** Buffers raw TCP bytes and yields complete MQTT packets (fixed header + payload). */
class MqttReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: number[] = [];

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    if (value && value.length) this.buf.push(...value);
    return true;
  }

  private tryParse(): MqttPacket | null {
    if (this.buf.length < 2) return null;
    const firstByte = this.buf[0];
    const type = (firstByte >> 4) & 0x0f;
    const flags = firstByte & 0x0f;

    let multiplier = 1;
    let value = 0;
    let idx = 1;
    let byte: number;
    do {
      if (idx >= this.buf.length) return null; // need more bytes for remaining-length
      byte = this.buf[idx];
      value += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      idx++;
    } while ((byte & 0x80) !== 0);

    const headerLen = idx;
    const totalLen = headerLen + value;
    if (this.buf.length < totalLen) return null; // incomplete packet, need more bytes

    const payload = new Uint8Array(this.buf.slice(headerLen, totalLen));
    this.buf = this.buf.slice(totalLen);
    return { type, flags, payload };
  }

  async readPacket(timeoutMs: number): Promise<MqttPacket> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.tryParse();
      if (parsed) return parsed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("MQTT read timeout");
      const gotMore = await Promise.race([
        this.fill(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining)),
      ]);
      if (!gotMore) throw new Error("MQTT read timeout");
    }
  }
}

export interface DiscoveredOperation {
  name?: string;
  displayName?: string;
  request?: { signature: boolean; topic?: string; qos?: number; keyFields: string[] };
  response?: { topic?: string; qos?: number; keyFields: string[] };
  dataChannel?: { topic?: string; qos?: number };
}

export interface DiscoveryResult {
  sessionKey: string | null;
  chKeyExpirationSeconds: number | null;
  operations: DiscoveredOperation[];
  raw: unknown;
}

/**
 * Perform the client-registration MQTT handshake and return the decoded
 * per-vehicle operations list (topics/qos/signature/keyFields) + sessionKey.
 * Read-only discovery — does not publish anything that touches the vehicle.
 */
export async function mqttDiscoverOperations(opts: {
  accessToken: string;
  accountDN: string;
  clientId: string;
  vin: string;
}): Promise<DiscoveryResult> {
  let stage = "tcp_connecting";
  const socket = connect(
    { hostname: "us-m.aerpf.com", port: 18883 },
    { secureTransport: "on", allowHalfOpen: false },
  );

  try {
    await socket.opened;
    stage = "tcp_opened";
  } catch (err) {
    throw new Error(`[stage=${stage}] TCP/TLS open failed: ${(err as Error).message}`);
  }

  const writer = socket.writable.getWriter();
  const reader = new MqttReader(socket.readable.getReader());

  try {
    // 1. CONNECT — username=clientId, password=accessToken (C1847g.java:1148-1149).
    stage = "sending_connect";
    await writer.write(
      buildConnect({ clientId: opts.clientId, username: opts.clientId, password: opts.accessToken, keepAlive: 30 }),
    );
    stage = "awaiting_connack";
    const connack = await reader.readPacket(15000);
    if (connack.type !== PACKET_CONNACK) throw new Error(`Expected CONNACK, got packet type ${connack.type}`);
    if (connack.payload[1] !== 0) throw new Error(`MQTT CONNECT rejected — return code ${connack.payload[1]}`);
    stage = "connack_ok";

    // 2. SUBSCRIBE to the response topic before publishing the request.
    const responseTopic = `/clientregistrationresponse/${opts.accountDN}`;
    const requestTopic = `/clientregistration/${opts.accountDN}`;
    stage = "sending_subscribe";
    await writer.write(buildSubscribe(1, responseTopic, 0));
    stage = "awaiting_suback";
    const suback = await reader.readPacket(15000);
    if (suback.type !== PACKET_SUBACK) throw new Error(`Expected SUBACK, got packet type ${suback.type}`);
    stage = "suback_ok";

    // 3. PUBLISH the registration request (SECURE_PAYLOAD=true -> {"p":[...]} envelope).
    stage = "sending_registration_publish";
    const requestBody = JSON.stringify({ p: [{ accountDN: opts.accountDN }] });
    await writer.write(buildPublish(requestTopic, new TextEncoder().encode(requestBody), 0));

    // 4. Wait for the response PUBLISH (ignore stray PINGRESP/etc while waiting).
    stage = "awaiting_registration_response";
    let responsePacket: MqttPacket | null = null;
    for (let attempts = 0; attempts < 8; attempts++) {
      const pkt = await reader.readPacket(20000);
      if (pkt.type === PACKET_PUBLISH) {
        responsePacket = pkt;
        break;
      }
      if (pkt.type === PACKET_PINGRESP) continue;
    }
    if (!responsePacket) throw new Error("No registration response received within timeout");
    stage = "registration_response_received";

    // PUBLISH variable header (QoS0): 2-byte topic length + topic bytes, then payload.
    const topicLen = (responsePacket.payload[0] << 8) | responsePacket.payload[1];
    const bodyBytes = responsePacket.payload.slice(2 + topicLen);
    const bodyText = new TextDecoder().decode(bodyBytes);
    const parsedRaw = JSON.parse(bodyText) as { p?: unknown[] } & Record<string, unknown>;
    const parsed = (Array.isArray(parsedRaw.p) ? parsedRaw.p[0] : parsedRaw) as Record<string, unknown>;

    const vehicles = Array.isArray(parsed?.vehicles) ? (parsed.vehicles as Record<string, unknown>[]) : [];
    const vehicleEntry = vehicles.find(
      (v) => typeof v?.vin === "string" && (v.vin as string).toUpperCase() === opts.vin.toUpperCase(),
    );
    const sessionKey = typeof vehicleEntry?.sessionKey === "string" ? (vehicleEntry.sessionKey as string) : null;
    const chKeyExpirationSeconds =
      typeof vehicleEntry?.chKeyExpiration === "number" ? (vehicleEntry.chKeyExpiration as number) : null;
    const operationsRaw = Array.isArray(vehicleEntry?.operations)
      ? (vehicleEntry!.operations as Record<string, unknown>[])
      : [];

    const operations: DiscoveredOperation[] = operationsRaw.map((op) => {
      const req = op.request as Record<string, unknown> | undefined;
      const res = op.response as Record<string, unknown> | undefined;
      const dc = op.dataChannel as Record<string, unknown> | undefined;
      return {
        name: typeof op.name === "string" ? op.name : undefined,
        displayName: typeof op.displayName === "string" ? op.displayName : undefined,
        request: req
          ? {
              signature: req.signature === 1,
              topic: typeof req.topic === "string" ? req.topic : undefined,
              qos: typeof req.qos === "number" ? req.qos : undefined,
              keyFields: Array.isArray(req.keyFields)
                ? (req.keyFields as Record<string, unknown>[])
                    .map((k) => (typeof k?.field === "string" ? (k.field as string) : ""))
                    .filter(Boolean)
                : [],
            }
          : undefined,
        response: res
          ? {
              topic: typeof res.topic === "string" ? res.topic : undefined,
              qos: typeof res.qos === "number" ? res.qos : undefined,
              keyFields: Array.isArray(res.keyFields)
                ? (res.keyFields as Record<string, unknown>[])
                    .map((k) => (typeof k?.field === "string" ? (k.field as string) : ""))
                    .filter(Boolean)
                : [],
            }
          : undefined,
        dataChannel: dc
          ? { topic: typeof dc.topic === "string" ? dc.topic : undefined, qos: typeof dc.qos === "number" ? dc.qos : undefined }
          : undefined,
      };
    });

    return { sessionKey, chKeyExpirationSeconds, operations, raw: parsed };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(msg.startsWith("[stage=") ? msg : `[stage=${stage}] ${msg}`);
  } finally {
    try {
      await writer.write(buildPacket(PACKET_DISCONNECT, 0, []));
    } catch {
      /* best-effort */
    }
    try {
      writer.releaseLock();
    } catch {
      /* best-effort */
    }
    try {
      await socket.close();
    } catch {
      /* best-effort */
    }
  }
}

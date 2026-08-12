import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";

const MAX_BIDI_APPEND_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_INT64 = (1n << 63n) - 1n;
const BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";

export interface BidiAppendRequestInput {
  payload: Uint8Array;
  requestId: string;
  appendSeqno: bigint;
}

function encodeVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let next = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) next |= 0x80;
    bytes.push(next);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, value: Uint8Array): Uint8Array {
  const tag = encodeVarint(BigInt(fieldNumber << 3 | 2));
  const length = encodeVarint(BigInt(value.byteLength));
  const encoded = new Uint8Array(tag.byteLength + length.byteLength + value.byteLength);
  encoded.set(tag, 0);
  encoded.set(length, tag.byteLength);
  encoded.set(value, tag.byteLength + length.byteLength);
  return encoded;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Encode Cursor's aiserver.v1.BidiAppendRequest.
 *
 * The current Cursor HTTP/1 transport uses the legacy `data` string field,
 * containing lowercase hexadecimal AgentClientMessage bytes. `data_binary`
 * is intentionally not populated because the installed Cursor client selects
 * `data` when using its HTTP/1 SSE transport.
 */
export function encodeBidiAppendRequest(input: BidiAppendRequestInput): Uint8Array {
  const requestId = input.requestId.trim();
  if (requestId.length === 0) throw new Error("Cursor BidiAppend request id must not be empty");
  if (input.appendSeqno < 0n || input.appendSeqno > MAX_INT64) {
    throw new Error("Cursor BidiAppend append sequence must be a non-negative int64");
  }
  if (input.payload.byteLength > MAX_BIDI_APPEND_PAYLOAD_BYTES) {
    throw new Error(`Cursor BidiAppend payload exceeds ${MAX_BIDI_APPEND_PAYLOAD_BYTES} bytes`);
  }

  const payloadHex = Buffer.from(input.payload).toString("hex");
  const data = new TextEncoder().encode(payloadHex);
  const requestIdMessage = encodeLengthDelimited(1, new TextEncoder().encode(requestId));
  const encodedData = encodeLengthDelimited(1, data);
  const encodedRequestId = encodeLengthDelimited(2, requestIdMessage);
  const encodedSequence = concatBytes(Uint8Array.of(0x18), encodeVarint(input.appendSeqno));
  return concatBytes(encodedData, encodedRequestId, encodedSequence);
}

export interface BidiAppendClientOptions {
  baseUrl: string;
  token: string;
  requestId: string;
  clientVersion?: string;
}

export interface BidiAppendClient {
  append(payload: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

function responseBody(response: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    response.on("data", () => {});
    response.on("end", () => finish());
    response.on("error", error => finish(error));
    response.on("close", () => finish(new Error("Cursor BidiAppend response closed before completion")));
    response.resume();
  });
}

/**
 * Send Cursor client messages through the HTTP/1.1 BidiAppend unary endpoint.
 *
 * Appends are serialized because sequence numbers and server-side message
 * order are coupled. An append failure is intentionally not retried: the
 * server may have accepted the request before the client observed the error.
 */
export function createBidiAppendClient(options: BidiAppendClientOptions): BidiAppendClient {
  const requestId = options.requestId.trim();
  if (!requestId) throw new Error("Cursor BidiAppend request id must not be empty");
  const parsed = new URL(options.baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Cursor BidiAppend base URL must use http or https");
  }

  let nextSequence = 0n;
  let closed = false;
  let queueFailure: Error | undefined;
  let tail = Promise.resolve();
  const activeRequests = new Set<ClientRequest>();
  const activeResponses = new Set<IncomingMessage>();

  const send = (payload: Uint8Array, appendSeqno: bigint): Promise<void> => {
    if (closed) return Promise.reject(new Error("Cursor BidiAppend client is closed"));
    const body = Buffer.from(encodeBidiAppendRequest({ payload, requestId, appendSeqno }));
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      method: "POST",
      path: BIDI_APPEND_PATH,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/proto",
        "content-length": body.byteLength,
        "x-ghost-mode": "true",
        "x-cursor-client-version": options.clientVersion ?? "cli-2026.07.08-0c04a8a",
        "x-cursor-client-type": "cli",
      },
    };

    return new Promise<void>((resolve, reject) => {
      const requestFn = parsed.protocol === "https:" ? https.request : http.request;
      const request = requestFn(requestOptions, incoming => {
        activeResponses.add(incoming);
        if (incoming.statusCode !== 200) {
          incoming.resume();
          activeResponses.delete(incoming);
          reject(new Error(`Cursor BidiAppend returned HTTP ${incoming.statusCode ?? 0}`));
          return;
        }
        void responseBody(incoming).then(resolve, reject).finally(() => activeResponses.delete(incoming));
      });
      activeRequests.add(request);
      const cleanup = () => activeRequests.delete(request);
      request.once("error", error => {
        cleanup();
        reject(error);
      });
      request.once("close", cleanup);
      request.end(body);
    });
  };

  return {
    append(payload) {
      if (closed) return Promise.reject(new Error("Cursor BidiAppend client is closed"));
      const appendSeqno = nextSequence++;
      const operation = tail.then(() => {
        if (queueFailure) throw queueFailure;
        return send(payload, appendSeqno);
      }).catch(error => {
        queueFailure = error instanceof Error ? error : new Error(String(error));
        throw queueFailure;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const request of activeRequests) request.destroy();
      for (const response of activeResponses) response.destroy();
    },
  };
}

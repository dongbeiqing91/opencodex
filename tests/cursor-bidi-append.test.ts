import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import { createBidiAppendClient, encodeBidiAppendRequest } from "../src/adapters/cursor/bidi-append";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("Cursor BidiAppend wire encoding", () => {
  test("encodes the hex payload, nested request id, and zero-based sequence number", () => {
    const encoded = encodeBidiAppendRequest({
      payload: new Uint8Array([0x08, 0x01]),
      requestId: "req-123",
      appendSeqno: 0n,
    });

    expect(hex(encoded)).toBe("0a043038303112090a077265712d3132331800");
  });

  test("uses a varint sequence number and lowercase hexadecimal payload", () => {
    const encoded = encodeBidiAppendRequest({
      payload: new Uint8Array([0xab, 0xcd, 0xef]),
      requestId: "sse",
      appendSeqno: 300n,
    });

    expect(hex(encoded)).toBe("0a0661626364656612050a0373736518ac02");
  });

  test("rejects invalid request ids and sequence numbers", () => {
    expect(() => encodeBidiAppendRequest({
      payload: new Uint8Array(),
      requestId: "",
      appendSeqno: 0n,
    })).toThrow("request id");

    expect(() => encodeBidiAppendRequest({
      payload: new Uint8Array(),
      requestId: "req",
      appendSeqno: -1n,
    })).toThrow("append sequence");
  });
});

describe("Cursor BidiAppend client", () => {
  test("serializes concurrent appends over HTTP/1.1 and preserves sequence order", async () => {
    const bodies: Buffer[] = [];
    const paths: string[] = [];
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { releaseFirst = resolve; });
    const server = createServer((request, response) => {
      expect(request.httpVersion).toBe("1.1");
      paths.push(request.url ?? "");
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", async () => {
        bodies.push(Buffer.concat(chunks));
        if (bodies.length === 1) await firstRequest;
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const client = createBidiAppendClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      requestId: "ordered",
    });
    const first = client.append(new Uint8Array([1]));
    const second = client.append(new Uint8Array([2]));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodies).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(paths).toEqual([
      "/aiserver.v1.BidiService/BidiAppend",
      "/aiserver.v1.BidiService/BidiAppend",
    ]);
    expect(bodies.map(body => hex(new Uint8Array(body)))).toEqual([
      hex(encodeBidiAppendRequest({ payload: new Uint8Array([1]), requestId: "ordered", appendSeqno: 0n })),
      hex(encodeBidiAppendRequest({ payload: new Uint8Array([2]), requestId: "ordered", appendSeqno: 1n })),
    ]);
  });

  test("stops queued appends after an ambiguous append failure", async () => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      requests += 1;
      await readBodyForTest(request);
      response.writeHead(500);
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const client = createBidiAppendClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      requestId: "failed",
    });
    const first = client.append(new Uint8Array([1]));
    const second = client.append(new Uint8Array([2]));
    await expect(first).rejects.toThrow("HTTP 500");
    await expect(second).rejects.toThrow("HTTP 500");
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(requests).toBe(1);
  });
});

function readBodyForTest(request: import("node:http").IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    request.on("data", () => {});
    request.on("end", resolve);
    request.on("error", reject);
  });
}

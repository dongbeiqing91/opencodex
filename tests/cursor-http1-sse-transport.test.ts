import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import { createHttp1SseCursorTransport } from "../src/adapters/cursor/http1-sse-transport";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respondEmptyConnectMessage(response: ServerResponse): void {
  const message = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }),
    },
  }));
  const firstFrame = encodeConnectFrame(message);
  for (let offset = 0; offset < firstFrame.byteLength; offset += 1) {
    response.write(firstFrame.subarray(offset, offset + 1));
  }
  response.end(encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true }));
}

function textDeltaFrame(text: string): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
      }),
    },
  })));
}

function turnEndedFrame(): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }),
    },
  })));
}

function endStreamFrame(): Uint8Array {
  return encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true });
}

function createTestTransport(port: number) {
  return createHttp1SseCursorTransport({
    provider: {
      adapter: "cursor",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-token",
      cursorTransport: "http1-sse",
    },
    translatorBudget: createTestTranslatorBudget(),
    firstFrameTimeoutMs: 2_000,
  });
}

async function boundPort(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

describe("Cursor HTTP/1.1 SSE transport", () => {
  test("uses RunSSE plus ordered BidiAppend over HTTP/1.1", async () => {
    const paths: string[] = [];
    const versions: string[] = [];
    const appendBodies: Buffer[] = [];
    let runResponse!: ServerResponse;
    const server = createServer(async (request, response) => {
      paths.push(request.url ?? "");
      versions.push(request.httpVersion);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        await readBody(request);
        runResponse = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (request.url === "/aiserver.v1.BidiService/BidiAppend") {
        appendBodies.push(await readBody(request));
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
        if (appendBodies.length === 1) respondEmptyConnectMessage(runResponse);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const transport = createHttp1SseCursorTransport({
      provider: {
        adapter: "cursor",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-token",
        cursorTransport: "http1-sse",
      },
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });
    const messages = [];
    for await (const message of transport.run({
      modelId: "composer-2.5",
      conversationId: "http1-test",
      system: [],
      messages: [{ role: "user", content: "hello" }],
    })) {
      messages.push(message);
    }
    await transport.close?.();

    expect(messages).toMatchObject([{ type: "done" }]);
    expect(versions).toEqual(["1.1", "1.1"]);
    expect(paths).toEqual([
      "/agent.v1.AgentService/RunSSE",
      "/aiserver.v1.BidiService/BidiAppend",
    ]);
    expect(appendBodies).toHaveLength(1);
    expect(appendBodies[0]?.byteLength).toBeGreaterThan(0);
  });

  test("surfaces a non-success RunSSE response", async () => {
    const server = createServer(async (request, response) => {
      await readBody(request);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        response.writeHead(415, { "content-type": "application/json" });
      } else {
        response.writeHead(200, { "content-type": "application/proto" });
      }
      response.end();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const transport = createHttp1SseCursorTransport({
      provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });

    let failure: Error | undefined;
    try {
      for await (const _message of transport.run({
        modelId: "composer-2.5",
        conversationId: "http1-status",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) {
        // Drain the transport until it fails.
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      await transport.close?.();
    }
    expect(failure?.message).toContain("RunSSE returned HTTP 415");
  });

  test("tolerates an abortive close after the terminal frames", async () => {
    // api2.cursor.sh tears down every HTTP/1.1 RunSSE turn with a connection close that
    // reaches the client as 'aborted'/ECONNRESET AFTER turnEnded and the Connect end-stream
    // frame (simulated here by destroying the socket without the chunked terminating chunk).
    // The completed turn must still surface `done`, never a transport failure.
    const server = createServer(async (request, response) => {
      await readBody(request);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        response.writeHead(200, { "content-type": "application/connect+proto" });
        response.write(Buffer.from(textDeltaFrame("OK")));
        response.write(Buffer.from(turnEndedFrame()));
        // Defer the teardown so the client has consumed every frame before the reset
        // arrives — the production sequence is frames → client processing → RST.
        response.write(Buffer.from(endStreamFrame()), () => {
          setTimeout(() => response.socket.destroy(), 50);
        });
        return;
      }
      if (request.url === "/aiserver.v1.BidiService/BidiAppend") {
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const port = await boundPort(server);
    const transport = createTestTransport(port);

    const messages = [];
    let failure: Error | undefined;
    try {
      for await (const message of transport.run({
        modelId: "composer-2.5",
        conversationId: "http1-abort-after-terminal",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) {
        messages.push(message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      await transport.close?.();
    }

    expect(failure).toBeUndefined();
    expect(messages).toContainEqual({ type: "text", text: "OK" });
    expect(messages).toMatchObject([{ type: "text", text: "OK" }, { type: "done" }]);
  });

  test("still fails when the stream aborts mid-turn", async () => {
    // An abortive close BEFORE turnEnded is a genuine truncation and must surface as a
    // transport failure — the post-terminal tolerance must never swallow it.
    const server = createServer(async (request, response) => {
      await readBody(request);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        response.writeHead(200, { "content-type": "application/connect+proto" });
        response.write(Buffer.from(textDeltaFrame("partial")), () => {
          setTimeout(() => response.socket.destroy(), 50);
        });
        return;
      }
      if (request.url === "/aiserver.v1.BidiService/BidiAppend") {
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const port = await boundPort(server);
    const transport = createTestTransport(port);

    const messages = [];
    let failure: Error | undefined;
    try {
      for await (const message of transport.run({
        modelId: "composer-2.5",
        conversationId: "http1-abort-mid-turn",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) {
        messages.push(message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      await transport.close?.();
    }

    expect(messages).toContainEqual({ type: "text", text: "partial" });
    expect(failure).toBeDefined();
  });

  test("tolerates a reset that races the Connect end-stream after turnEnded", async () => {
    // The production race: turnEnded is received and pushed, then the socket resets BEFORE the
    // Connect end-stream frame arrives. The drain must process turnEnded (pushing `done`) so
    // the reset is classified as post-terminal noise, not a turn failure.
    const server = createServer(async (request, response) => {
      await readBody(request);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        response.writeHead(200, { "content-type": "application/connect+proto" });
        response.write(Buffer.from(textDeltaFrame("OK")));
        response.write(Buffer.from(turnEndedFrame()), () => {
          // Reset immediately after turnEnded is written, before any end-stream frame.
          setTimeout(() => response.socket.destroy(), 20);
        });
        return;
      }
      if (request.url === "/aiserver.v1.BidiService/BidiAppend") {
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const port = await boundPort(server);
    const transport = createTestTransport(port);

    const messages = [];
    let failure: Error | undefined;
    try {
      for await (const message of transport.run({
        modelId: "composer-2.5",
        conversationId: "http1-reset-between-terminal-and-endstream",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) {
        messages.push(message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      await transport.close?.();
    }

    expect(failure).toBeUndefined();
    expect(messages).toContainEqual({ type: "text", text: "OK" });
    expect(messages).toMatchObject([{ type: "text", text: "OK" }, { type: "done" }]);
  });

  test("reports an incomplete Connect frame from the HTTP/1.1 response", async () => {
    const server = createServer(async (request, response) => {
      await readBody(request);
      if (request.url === "/agent.v1.AgentService/RunSSE") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(Buffer.from([0, 0]));
      } else {
        response.writeHead(200, { "content-type": "application/proto" });
        response.end();
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const transport = createHttp1SseCursorTransport({
      provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });

    let failure: Error | undefined;
    try {
      for await (const _message of transport.run({
        modelId: "composer-2.5",
        conversationId: "http1-incomplete",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) {
        // Drain the transport until it fails.
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      await transport.close?.();
    }
    expect((failure as { code?: unknown } | undefined)?.code).toBe("frame_incomplete");
  });
});

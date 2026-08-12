import type { CursorTransport, CursorTransportFactoryInput } from "./transport";
import { createLiveCursorTransport } from "./live-transport";

/**
 * Create the Cursor HTTP/1.1 compatibility transport.
 *
 * The live transport owns the protocol-neutral turn runtime; this factory
 * selects its HTTP/1.1 RunSSE/BidiAppend wire path without changing callers.
 */
export function createHttp1SseCursorTransport(input: CursorTransportFactoryInput): CursorTransport {
  return createLiveCursorTransport({
    ...input,
    provider: { ...input.provider, cursorTransport: "http1-sse" },
  });
}

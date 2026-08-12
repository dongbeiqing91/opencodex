import { describe, expect, test } from "bun:test";
import { createHttp1SseCursorTransport } from "../src/adapters/cursor/http1-sse-transport";
import { getCursorLiveSmokeToken, readCursorLiveSmokeGate } from "../src/adapters/cursor/live-smoke-gate";
import { createTranslatorBudget } from "../src/lib/translator-budget";

const gate = readCursorLiveSmokeGate();
const token = getCursorLiveSmokeToken();

describe("Cursor HTTP/1.1 SSE live smoke", () => {
  test.skipIf(!gate.enabled || !token)("returns the exact sentinel through RunSSE and BidiAppend", async () => {
    const budget = createTranslatorBudget();
    const transport = createHttp1SseCursorTransport({
      provider: {
        adapter: "cursor",
        baseUrl: gate.baseUrl,
        apiKey: token,
        cursorTransport: "http1-sse",
      },
      translatorBudget: budget,
      firstFrameTimeoutMs: 45_000,
    });
    let text = "";
    let sawDone = false;
    try {
      for await (const message of transport.run({
        modelId: "composer-2.5-fast",
        conversationId: `ocx-http1-live-${Date.now()}`,
        system: [
          "Reply with exactly OCX_CURSOR_HTTP1_OK.",
          "Do not inspect files, run commands, use tools, browse, fetch URLs, record the screen, use computer control, or modify anything.",
        ],
        messages: [{ role: "user", content: "Reply with exactly OCX_CURSOR_HTTP1_OK." }],
      })) {
        if (message.type === "text") text += message.text;
        if (message.type === "done") {
          sawDone = true;
          break;
        }
      }
    } finally {
      await transport.close?.();
      budget.dispose();
    }
    expect(text).toBe("OCX_CURSOR_HTTP1_OK");
    expect(sawDone).toBe(true);
  }, 90_000);
});

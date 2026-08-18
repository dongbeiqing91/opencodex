import { describe, expect, test } from "bun:test";
import {
  CURSOR_AUTO_WIRE_MODEL_ID,
  CURSOR_DEFAULT_CONTEXT_WINDOW,
  CURSOR_ROUTER_MODEL_IDS,
  CURSOR_ROUTING_LEVELS,
  CURSOR_STATIC_MODELS,
  cursorCodexToWireModelId,
  filterCursorConfiguredModelsByLiveDiscovery,
  isCursorModelAvailableForAccount,
  cursorLiveEffortLadder,
  cursorLiveReasoningEfforts,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
  cursorWireModelSelection,
  inferCursorContextWindow,
  isCursorExternalWireModel,
  isCursorNativeWireModel,
  normalizeCursorModels,
} from "../src/adapters/cursor/discovery";

describe("Cursor discovery metadata", () => {
  test("static seed includes Cursor's public model families plus the safe auto model", () => {
    const ids = cursorModelIds(CURSOR_STATIC_MODELS);

    expect(ids.length).toBeGreaterThanOrEqual(38);
    expect(ids).toEqual(expect.arrayContaining([...CURSOR_ROUTER_MODEL_IDS]));
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("composer-2.5");
    expect(ids).toContain("composer-2.5-fast");
    expect(ids).toContain("claude-4.6-sonnet");
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).toContain("gemini-3-pro-image-preview");
    expect(ids).toContain("gemini-3.5-flash");
    expect(ids).toContain("gpt-5-codex");
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("kimi-k2.7-code");
    expect(ids).toContain("kimi-k3");
    expect(ids).toContain("claude-opus-4-7-fast");
    // 260709 refresh: stale ids dropped from the static seed (cursor.com docs); gpt-5.5-extra
    // stays — it survives the live GetUsableModels filter (004_live_snapshot.md).
    expect(ids).not.toContain("grok-4.20");
    expect(ids).not.toContain("grok-4.3");
    expect(ids).not.toContain("kimi-k2.5");
    expect(ids).toContain("gpt-5.5-extra");
    expect(ids).toContain("grok-4.6");
    expect(ids).toContain("grok-4.6-fast");
    expect(ids).not.toContain("composer-2");
    // `auto` mirrors the jawcode SOT `default` entry (200k), not the generic fallback window.
    for (const id of CURSOR_ROUTER_MODEL_IDS) {
      expect(cursorModelContextWindows(CURSOR_STATIC_MODELS)[id]).toBe(200_000);
    }
    expect(cursorModelContextWindows(CURSOR_STATIC_MODELS)["composer-2.5-fast"]).toBe(200_000);
  });

  test("auto is not activated by live GetUsableModels wire ids alone", () => {
    expect(isCursorModelAvailableForAccount("gpt-5.4", ["gpt-5.4-high"])).toBe(true);
    expect(isCursorModelAvailableForAccount("claude-fable-5", ["gpt-5.4-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("auto", ["default"])).toBe(false);
    // Sibling model ids must not activate a different base: only effort suffixes count.
    expect(isCursorModelAvailableForAccount("claude-4-sonnet", ["claude-4-sonnet-1m"])).toBe(false);
    expect(isCursorModelAvailableForAccount("gpt-5.5", ["gpt-5.5-extra-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("gpt-5.5-extra", ["gpt-5.5-extra-high"])).toBe(true);

    // Issue #117: Cursor GetUsableModels may return ids with a `cursor-` wire prefix.
    expect(isCursorModelAvailableForAccount("grok-4.5", ["cursor-grok-4.5-high"])).toBe(true);
    // Current Grok Fast wire ids put `-fast` after the effort tier.
    expect(isCursorModelAvailableForAccount("grok-4.5-fast", ["cursor-grok-4.5-low-fast"])).toBe(true);
    expect(isCursorModelAvailableForAccount("grok-4.5-fast", ["cursor-grok-4.5-high-fast"])).toBe(true);
    // Older snapshots used `{base}-fast-{effort}`; keep discovery compatibility.
    expect(isCursorModelAvailableForAccount("grok-4.5-fast", ["cursor-grok-4.5-fast-medium"])).toBe(true);
    expect(isCursorModelAvailableForAccount("grok-4.5-fast", ["cursor-grok-4.5-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("grok-4.5", ["cursor-grok-4.5-high-fast"])).toBe(false);
    expect(isCursorModelAvailableForAccount("grok-4.6", ["cursor-grok-4.6-xhigh"])).toBe(true);
    expect(isCursorModelAvailableForAccount("grok-4.6-fast", ["cursor-grok-4.6-xhigh-fast"])).toBe(true);
    expect(isCursorModelAvailableForAccount("grok-4.6", ["cursor-grok-4.6-xhigh-fast"])).toBe(false);
    expect(isCursorModelAvailableForAccount("gpt-5.4", ["cursor-gpt-5.4-high"])).toBe(true);
    // Prefixed sibling rejection: cursor- prefix must not bypass sibling-model checks.
    expect(isCursorModelAvailableForAccount("gpt-5.5", ["cursor-gpt-5.5-extra-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("claude-4-sonnet", ["cursor-claude-4-sonnet-1m"])).toBe(false);

    const filtered = filterCursorConfiguredModelsByLiveDiscovery(
      [{ id: "gpt-5.4" }, { id: "claude-fable-5" }],
      ["gpt-5.4-high"],
    );
    expect(filtered.map(model => model.id)).toEqual(["gpt-5.4"]);

    const grok = filterCursorConfiguredModelsByLiveDiscovery(
      [{ id: "grok-4.5" }, { id: "grok-4.5-fast" }],
      ["cursor-grok-4.5-high", "cursor-grok-4.5-high-fast"],
    );
    expect(grok.map(model => model.id)).toEqual(["grok-4.5", "grok-4.5-fast"]);

    const grok46 = filterCursorConfiguredModelsByLiveDiscovery(
      [{ id: "grok-4.6" }, { id: "grok-4.6-fast" }],
      ["cursor-grok-4.6-xhigh", "cursor-grok-4.6-xhigh-fast"],
    );
    expect(grok46.map(model => model.id)).toEqual(["grok-4.6", "grok-4.6-fast"]);
  });

  test("live discovery filter always keeps all router levels when GetUsableModels omits them", () => {
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(
      [...CURSOR_ROUTER_MODEL_IDS.map(id => ({ id })), { id: "gpt-5.4" }, { id: "claude-fable-5" }],
      ["gpt-5.4-high"],
    );
    expect(filtered.map(model => model.id)).toEqual([...CURSOR_ROUTER_MODEL_IDS, "gpt-5.4"]);
  });

  test("auto and every explicit routing level map to default on the Cursor wire", () => {
    expect(cursorCodexToWireModelId("auto")).toBe(CURSOR_AUTO_WIRE_MODEL_ID);
    expect(cursorCodexToWireModelId("cursor/auto")).toBe(CURSOR_AUTO_WIRE_MODEL_ID);
    for (const level of CURSOR_ROUTING_LEVELS) {
      expect(cursorWireModelSelection(`auto-${level}`)).toEqual({
        modelId: CURSOR_AUTO_WIRE_MODEL_ID,
        routingLevel: level,
      });
      expect(cursorCodexToWireModelId(`cursor/auto-${level}`)).toBe(CURSOR_AUTO_WIRE_MODEL_ID);
    }
    expect(cursorCodexToWireModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  test("normalization trims, deduplicates, sorts, and fills context windows", () => {
    const models = normalizeCursorModels([
      { id: " gpt-5.5 ", supportsReasoningEffort: true },
      { id: "" },
      { id: "auto" },
      { id: "gpt-5.5", contextWindow: 1 },
      { id: "claude-4.5-sonnet" },
    ]);

    expect(models.map(model => model.id)).toEqual(["auto", "claude-4.5-sonnet", "gpt-5.5"]);
    expect(models.find(model => model.id === "gpt-5.5")?.contextWindow).toBe(272_000);
    expect(models.find(model => model.id === "claude-4.5-sonnet")?.contextWindow).toBe(200_000);
  });

  test("context-window inference uses conservative defaults", () => {
    expect(inferCursorContextWindow("unknown-model")).toBe(CURSOR_DEFAULT_CONTEXT_WINDOW);
    expect(inferCursorContextWindow("claude-4.5-sonnet")).toBe(200_000);
    expect(inferCursorContextWindow("claude-opus-4.8")).toBe(200_000);
    expect(inferCursorContextWindow("gemini-3.5-flash")).toBe(1_000_000);
    expect(inferCursorContextWindow("glm-5.2")).toBe(1_000_000);
    expect(inferCursorContextWindow("grok-4.3")).toBe(256_000);
    expect(inferCursorContextWindow("grok-4.6")).toBe(500_000);
    expect(inferCursorContextWindow("gpt-5.5")).toBe(272_000);
  });

  test("input modalities are cloned per model", () => {
    const modalities = cursorModelInputModalities([{ id: "auto" }]);

    expect(modalities.auto).toEqual(["text", "image"]);
    modalities.auto.push("mutated");
    expect(cursorModelInputModalities([{ id: "auto" }]).auto).toEqual(["text", "image"]);
  });

  test("reasoning efforts are explicit per model", () => {
    const efforts = cursorModelReasoningEfforts([
      { id: "auto", supportsReasoningEffort: false },
      { id: "gpt-5.5", supportsReasoningEffort: true },
      { id: "claude-opus-4-8", supportsReasoningEffort: true },
      { id: "glm-5.2", supportsReasoningEffort: true },
      { id: "grok-4.3", supportsReasoningEffort: true },
      { id: "grok-4.6", supportsReasoningEffort: true },
      { id: "grok-4.6-fast", supportsReasoningEffort: true },
      { id: "unknown-reasoning-model", supportsReasoningEffort: true },
      { id: "composer-2.5", supportsReasoningEffort: false },
    ]);

    expect(efforts.auto).toEqual([]);
    expect(efforts["gpt-5.5"]).toEqual(["low", "medium", "high"]);
    expect(efforts["claude-opus-4-8"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts["glm-5.2"]).toEqual(["high", "max"]);
    expect(efforts["grok-4.3"]).toEqual([]);
    expect(efforts["grok-4.6"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(efforts["grok-4.6-fast"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(efforts["unknown-reasoning-model"]).toEqual([]);
    expect(efforts["composer-2.5"]).toEqual([]);
  });

  test("classifies native vs external Cursor wire models", () => {
    expect(isCursorNativeWireModel("default")).toBe(true);
    expect(isCursorNativeWireModel("auto")).toBe(true);
    expect(isCursorNativeWireModel("composer-2.5")).toBe(true);
    expect(isCursorNativeWireModel("composer-2.5-fast")).toBe(true);
    expect(isCursorExternalWireModel("gpt-5.6-sol")).toBe(true);
    expect(isCursorExternalWireModel("gpt-5.6-sol-xhigh")).toBe(true);
    expect(isCursorExternalWireModel("claude-4.6-sonnet-high")).toBe(true);
    expect(isCursorExternalWireModel("cursor/gpt-5.6-sol")).toBe(true);
  });

  test("cursorLiveEffortLadder derives observed tiers from exact live ids", () => {
    // Normal base model: only observed suffixes appear, in canonical order.
    expect(cursorLiveEffortLadder("glm-5.2", ["glm-5.2-high"])).toEqual(["high"]);
    expect(cursorLiveEffortLadder("glm-5.2", ["glm-5.2-high", "glm-5.2-max"])).toEqual(["high", "max"]);
    // Missing tiers are not surfaced even when the static catalog advertises them.
    expect(cursorLiveEffortLadder("gpt-5.6-terra", ["gpt-5.6-terra-low", "gpt-5.6-terra-high"]))
      .toEqual(["low", "high"]);
    // glm-5.3-max absent from live ids → max is not exposed.
    expect(cursorLiveEffortLadder("glm-5.3", ["glm-5.3-low", "glm-5.3-high"]))
      .toEqual(["low", "high"]);
    // All tiers present.
    expect(cursorLiveEffortLadder("claude-opus-4-8", [
      "claude-opus-4-8-low", "claude-opus-4-8-medium",
      "claude-opus-4-8-high", "claude-opus-4-8-xhigh", "claude-opus-4-8-max",
    ])).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("cursorLiveEffortLadder handles cursor- prefix and Grok Fast forms", () => {
    // cursor- wire prefix is stripped before matching.
    expect(cursorLiveEffortLadder("grok-4.6", ["cursor-grok-4.6-low", "cursor-grok-4.6-xhigh"]))
      .toEqual(["low", "xhigh"]);
    // Current Grok Fast form: {base-without-fast}-{effort}-fast.
    expect(cursorLiveEffortLadder("grok-4.6-fast", ["cursor-grok-4.6-low-fast", "cursor-grok-4.6-xhigh-fast"]))
      .toEqual(["low", "xhigh"]);
    // Legacy Grok Fast form: {base}-fast-{effort}.
    expect(cursorLiveEffortLadder("grok-4.5-fast", ["grok-4.5-fast-medium"]))
      .toEqual(["medium"]);
  });

  test("cursorLiveEffortLadder rejects sibling models", () => {
    // gpt-5.5-extra-high must not activate gpt-5.5's ladder (gpt-5.5 has static tiers).
    expect(cursorLiveEffortLadder("gpt-5.5", ["gpt-5.5-extra-high"])).toEqual([]);
    // claude-4-sonnet-1m must not activate claude-4-sonnet's ladder. claude-4-sonnet is a
    // bare model (no static tiers), so the helper returns undefined — the sibling id is
    // irrelevant.
    expect(cursorLiveEffortLadder("claude-4-sonnet", ["claude-4-sonnet-1m"])).toBeUndefined();
    // gpt-5.6-sol is a tiered model; a different gpt-5.6-* sibling must not activate it.
    expect(cursorLiveEffortLadder("gpt-5.6-sol", ["gpt-5.6-terra-high"])).toEqual([]);
  });

  test("cursorLiveEffortLadder returns undefined for bare-id models and empty for unobserved tiers", () => {
    // Models without static effort tiers (composer, auto) return undefined.
    expect(cursorLiveEffortLadder("composer-2.5", ["composer-2.5"])).toBeUndefined();
    expect(cursorLiveEffortLadder("auto", ["default"])).toBeUndefined();
    // Models with static tiers but no live suffixed variants return an empty ladder.
    expect(cursorLiveEffortLadder("glm-5.2", ["glm-5.2"])).toEqual([]);
    expect(cursorLiveEffortLadder("glm-5.2", [])).toEqual([]);
  });

  test("cursorLiveReasoningEfforts builds a per-model ladder map from live ids", () => {
    const configured = [
      { id: "auto" },
      { id: "composer-2.5" },
      { id: "glm-5.2" },
      { id: "gpt-5.6-terra" },
      { id: "claude-fable-5" },
    ];
    const liveIds = [
      "default",
      "composer-2.5",
      "glm-5.2-high",
      "gpt-5.6-terra-low",
      "gpt-5.6-terra-high",
      // claude-fable-5 absent → filtered out by filterCursorConfiguredModelsByLiveDiscovery,
      // but the map helper still returns an empty ladder for it.
    ];
    const efforts = cursorLiveReasoningEfforts(configured, liveIds);
    expect(efforts.auto).toEqual([]);
    expect(efforts["composer-2.5"]).toEqual([]);
    expect(efforts["glm-5.2"]).toEqual(["high"]);
    expect(efforts["gpt-5.6-terra"]).toEqual(["low", "high"]);
    expect(efforts["claude-fable-5"]).toEqual([]);
  });
});

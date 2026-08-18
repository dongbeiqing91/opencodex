import { create, toBinary } from "@bufbuild/protobuf";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  AgentClientMessageSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionQuery,
  type InteractionResponse,
} from "./gen/agent_pb";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
  mcpArgsFromToolCall,
} from "./protobuf-events";
import {
  handleCursorNativeExec,
  handleCursorNativeKv,
  type CursorBlobRequestScopeToken,
  type CursorNativeExecContext,
} from "./native-exec";
import type { CursorServerMessage } from "./types";
import type { McpArgsPlan } from "./live-transport";

export interface CursorTurnRuntimeContext {
  execContext: CursorNativeExecContext;
  blobRequestScope?: CursorBlobRequestScopeToken;
  writeClientMessage: (payload: Uint8Array) => void | Promise<void>;
  cancelCursorRun: () => void;
  noteClientToolActivity: () => void;
  scheduleClientToolFinalize: (
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
  ) => void;
  planMcpArgsHandling: (
    execMessage: ExecServerMessage,
    state: ReturnType<typeof createCursorProtobufEventState>,
  ) => McpArgsPlan;
  planInteractionQueryReply: (query: InteractionQuery) => {
    response: InteractionResponse;
    replyCase: string;
    planText?: string;
  };
}

function encodeClientMessage(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message));
}

/**
 * Handle one decoded Cursor server message independently of the wire transport.
 *
 * HTTP/2 and HTTP/1.1 both use this path for KV, native execution, interaction
 * replies, tool suspension, usage events, and progress heartbeats.
 */
export async function handleCursorServerMessage(
  message: AgentServerMessage,
  state: ReturnType<typeof createCursorProtobufEventState>,
  push: (message: CursorServerMessage) => void,
  context: CursorTurnRuntimeContext,
): Promise<void> {
  debugProviderDiagnostic("cursor", "frame", describeCursorServerFrame(message));
  if (message.message.case === "kvServerMessage") {
    await context.writeClientMessage(handleCursorNativeKv(message.message.value, context.blobRequestScope));
    return;
  }
  if (message.message.case === "execServerMessage") {
    const execMsg = message.message.value;
    if (execMsg.message.case === "mcpArgs") {
      const plan = context.planMcpArgsHandling(execMsg, state);
      if (plan.handledByResponsesBridge) {
        context.noteClientToolActivity();
        for (const event of plan.events) push(event);
        if (plan.cancelCursorRun) context.cancelCursorRun();
        else if (plan.finalizeWhenDrained) context.scheduleClientToolFinalize(state, push);
        return;
      }
    }
    push({ type: "local_side_effect" });
    const replies = await handleCursorNativeExec(message.message.value, context.execContext);
    for (const reply of replies) await context.writeClientMessage(reply);
    return;
  }
  if (message.message.case === "interactionQuery") {
    const query = message.message.value;
    const plan = context.planInteractionQueryReply(query);
    debugProviderDiagnostic("cursor", "interaction-query", {
      id: query.id,
      queryCase: query.query.case ?? "unknown",
      reply: plan.replyCase,
    });
    await context.writeClientMessage(encodeClientMessage({
      message: { case: "interactionResponse", value: plan.response },
    }));
    if (!state.terminated) {
      if (plan.planText) push({ type: "text", text: plan.planText });
      push({ type: "heartbeat" });
    }
    return;
  }

  const update = message.message.case === "interactionUpdate" ? message.message.value.message : undefined;
  const completesOpenClientTool = update?.case === "toolCallCompleted"
    && state.openToolCalls.has(update.value.callId);
  // Capture the awaiting flag before mapping: a completion-only freeform frame that starts
  // awaiting native args produces no outward event, and the flag transition is the only signal
  // that the frame made progress worth a liveness heartbeat.
  const awaitedNativeArgsBeforeMapping = update?.case === "toolCallCompleted"
    && state.openToolCalls.get(update.value.callId)?.awaitingNativeArgs === true;
  const mapped = mapCursorProtobufServerMessage(message, state);
  const beganAwaitingNativeClientToolArgs = update?.case === "toolCallCompleted"
    && !awaitedNativeArgsBeforeMapping
    && state.openToolCalls.get(update.value.callId)?.awaitingNativeArgs === true;
  if (mapped.length > 0) {
    const clientToolFrame = completesOpenClientTool || isClientToolFrame(message);
    if (clientToolFrame) context.noteClientToolActivity();
    for (const event of mapped) push(event);
    if (
      clientToolFrame
      && state.openToolCalls.size === 0
      && mapped.some(event => event.type === "tool_call_end")
    ) context.scheduleClientToolFinalize(state, push);
    return;
  }
  // Frames that produce no outward Responses event (args buffering, a completion now waiting
  // for native args, tokenDelta, checkpoints) still prove the upstream is alive; without the
  // heartbeat the bridge's stall watchdog can trip upstream_stall_timeout mid-turn.
  if (!state.terminated && (isCursorProgressFrame(message) || beganAwaitingNativeClientToolArgs)) {
    if (isClientToolFrame(message) || beganAwaitingNativeClientToolArgs) context.noteClientToolActivity();
    push({ type: "heartbeat" });
  }
}

function describeCursorServerFrame(message: AgentServerMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { case: message.message.case ?? "unknown" };
  if (message.message.case === "interactionUpdate") {
    const update = message.message.value.message;
    out.update = update.case ?? "unknown";
    if (update.case === "toolCallStarted" || update.case === "partialToolCall" || update.case === "toolCallCompleted") {
      out.toolCase = update.value.toolCall?.tool.case ?? "none";
      out.callId = update.value.callId;
    }
  } else if (message.message.case === "execServerMessage") {
    out.exec = message.message.value.message.case ?? "unknown";
  } else if (message.message.case === "interactionQuery") {
    out.query = message.message.value.query.case ?? "unknown";
    out.id = message.message.value.id;
  } else if (message.message.case === "kvServerMessage") {
    out.kv = message.message.value.message.case ?? "unknown";
  } else if (message.message.case === "conversationCheckpointUpdate") {
    out.usedTokens = message.message.value.tokenDetails?.usedTokens ?? 0;
  }
  return out;
}

function isCursorProgressFrame(message: AgentServerMessage): boolean {
  if (message.message.case === "conversationCheckpointUpdate") return true;
  if (message.message.case !== "interactionUpdate") return false;
  switch (message.message.value.message.case) {
    case "toolCallStarted":
    case "partialToolCall":
    case "toolCallDelta":
    case "tokenDelta":
      return true;
    default:
      return false;
  }
}

export function isClientToolFrame(message: AgentServerMessage): boolean {
  if (message.message.case !== "interactionUpdate") return false;
  const update = message.message.value.message;
  switch (update.case) {
    case "toolCallStarted":
    case "partialToolCall":
    case "toolCallCompleted":
      return mcpArgsFromToolCall(update.value.toolCall) !== undefined;
    default:
      return false;
  }
}

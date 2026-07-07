import { Chat } from "@ai-sdk/vue";
import { broadcastTransition } from "agents/chat";
import type { BroadcastStreamState } from "agents/chat";
import { AgentClient, type AgentClientOptions, type AgentConnectionError } from "agents/client";
import type { ChatOnToolCallCallback, JSONSchema7, Tool, UIMessage } from "ai";
import { onScopeDispose, ref } from "vue";

import { WebSocketChatTransport } from "./web-socket-chat-transport";

interface AgentClientTool<Input = unknown, Output = unknown> {
  description?: Tool["description"];
  parameters?: JSONSchema7;
  inputSchema?: JSONSchema7;
  execute?: (input: Input) => Output | Promise<Output>;
}

interface AgentToolOutput {
  toolCallId: string;
  output?: unknown;
  state?: "output-available" | "output-error";
  errorText?: string;
}

interface AgentToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ClientToolSchema {
  name: string;
  description?: Tool["description"];
  parameters?: JSONSchema7;
}

type StateOf<AgentT> = AgentT extends { readonly state: infer S } ? S : AgentT;

export interface UseAgentChatOptions<
  AgentT = unknown,
  ChatMessage extends UIMessage = UIMessage,
  State = StateOf<AgentT>,
> {
  /** AgentClient connection config — agent name, host, basePath, etc. */
  client: AgentClientOptions<State>;
  initialMessages?: ChatMessage[];
  /** Extra body to include with every request — static object or (sync/async) function. */
  body?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  tools?: Record<string, AgentClientTool>;
  onToolCall?: (options: {
    toolCall: AgentToolCall;
    addToolOutput: (toolOutput: AgentToolOutput) => Promise<void>;
  }) => void | Promise<void>;
  autoContinueAfterToolResult?: boolean;
  /** When true (default), the chat resumes any in-flight stream on socket open. */
  resume?: boolean;
  /**
   * When true, a generic client-side abort (e.g. the AI SDK aborting the request on
   * teardown) cancels the server turn. When false (default), such aborts are
   * local-only — the server turn keeps running and can be resumed. Explicit `stop()`
   * always cancels the server turn regardless. Matches upstream 0.7.0.
   */
  cancelOnClientAbort?: boolean;
  /** Called when the underlying WebSocket opens (initial connect or reconnect). */
  onOpen?: (event: Event) => void;
  /** Called when the underlying WebSocket closes. */
  onClose?: (event: CloseEvent) => void;
  /** Called for connection-level errors. Distinct from `onError`, which fires for chat turn errors. */
  onSocketError?: (event: Event) => void;
  /** Called for chat-turn errors (AI SDK). */
  onError?: (error: Error) => void;
}

interface ProtocolMessage<ChatMessage extends UIMessage = UIMessage> {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  continuation?: boolean;
  recovering?: boolean;
  message?: ChatMessage;
  messages?: ChatMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProtocolMessage<ChatMessage extends UIMessage>(data: string): ProtocolMessage<ChatMessage> | null {
  const parsed: unknown = JSON.parse(data);
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  // We runtime-validate the base UIMessage shape (id/role/parts) and trust the
  // server's typing for any ChatMessage extension fields like custom metadata.
  const message = isUiMessage(parsed.message) ? (parsed.message as ChatMessage) : undefined;
  const messages =
    Array.isArray(parsed.messages) && parsed.messages.every(isUiMessage)
      ? (parsed.messages as ChatMessage[])
      : undefined;

  return {
    type: parsed.type,
    id: typeof parsed.id === "string" ? parsed.id : undefined,
    body: typeof parsed.body === "string" ? parsed.body : undefined,
    done: typeof parsed.done === "boolean" ? parsed.done : undefined,
    error: typeof parsed.error === "boolean" ? parsed.error : undefined,
    replay: typeof parsed.replay === "boolean" ? parsed.replay : undefined,
    replayComplete: typeof parsed.replayComplete === "boolean" ? parsed.replayComplete : undefined,
    continuation: typeof parsed.continuation === "boolean" ? parsed.continuation : undefined,
    recovering: typeof parsed.recovering === "boolean" ? parsed.recovering : undefined,
    message,
    messages,
  };
}

function isUiMessage(value: unknown): value is UIMessage {
  return (
    isRecord(value) && typeof value.id === "string" && typeof value.role === "string" && Array.isArray(value.parts)
  );
}

function getToolCallIds(message: UIMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of message.parts) {
    if ("toolCallId" in part && typeof part.toolCallId === "string") {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function replaceUpdatedMessage<ChatMessage extends UIMessage>(
  messages: ChatMessage[],
  updatedMessage: ChatMessage,
): ChatMessage[] {
  const idIndex = messages.findIndex((message) => message.id === updatedMessage.id);
  if (idIndex >= 0) {
    return messages.map((message) => (message.id === updatedMessage.id ? updatedMessage : message));
  }

  const updatedToolCallIds = getToolCallIds(updatedMessage);
  if (updatedToolCallIds.size === 0) {
    return messages;
  }

  const toolIndex = messages.findIndex((message) =>
    message.parts.some(
      (part) => "toolCallId" in part && typeof part.toolCallId === "string" && updatedToolCallIds.has(part.toolCallId),
    ),
  );

  if (toolIndex < 0) {
    return messages;
  }

  const nextMessages = [...messages];
  const existingMessage = nextMessages[toolIndex];
  if (!existingMessage) {
    return messages;
  }

  nextMessages[toolIndex] = {
    ...updatedMessage,
    id: existingMessage.id,
  };
  return nextMessages;
}

function getApprovalToolCallId(messages: UIMessage[], approvalId: string): string | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        !("toolCallId" in part) ||
        typeof part.toolCallId !== "string" ||
        !("approval" in part) ||
        !isRecord(part.approval)
      ) {
        continue;
      }

      if (part.approval.id === approvalId) {
        return part.toolCallId;
      }
    }
  }

  return null;
}

function getClientToolSchemas(tools: UseAgentChatOptions["tools"]): ClientToolSchema[] | undefined {
  if (!tools) {
    return undefined;
  }

  const schemas = Object.entries(tools)
    .filter(([, tool]) => tool.execute)
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters ?? tool.inputSchema,
    }));

  return schemas.length > 0 ? schemas : undefined;
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preserveActiveStreamMessages<ChatMessage extends UIMessage>(
  currentMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
): ChatMessage[] {
  const tailMessage = currentMessages.at(-1);
  if (!tailMessage || tailMessage.role !== "assistant") {
    return incomingMessages;
  }

  const existingIndex = incomingMessages.findIndex((message) => message.id === tailMessage.id);
  if (existingIndex >= 0) {
    const nextMessages = [...incomingMessages];
    nextMessages[existingIndex] = tailMessage;
    return nextMessages;
  }

  // Broadcast may have remapped the streaming assistant to a server-authoritative
  // id. If the tail's tool call ids overlap with an incoming message, adopt the
  // incoming id while preserving our in-flight content so subsequent continuation
  // chunks merge into the unified message.
  const tailToolCallIds = getToolCallIds(tailMessage);
  if (tailToolCallIds.size > 0) {
    const remappedIndex = incomingMessages.findIndex((message) =>
      message.parts.some(
        (part) => "toolCallId" in part && typeof part.toolCallId === "string" && tailToolCallIds.has(part.toolCallId),
      ),
    );
    if (remappedIndex >= 0) {
      const remapped = incomingMessages[remappedIndex]!;
      const nextMessages = [...incomingMessages];
      nextMessages[remappedIndex] = { ...tailMessage, id: remapped.id };
      return nextMessages;
    }
  }

  return [...incomingMessages, tailMessage];
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function useAgentChat<AgentT = unknown, ChatMessage extends UIMessage = UIMessage, State = StateOf<AgentT>>(
  options: UseAgentChatOptions<AgentT, ChatMessage, State>,
) {
  const autoContinueAfterToolResult = options.autoContinueAfterToolResult ?? true;
  const activeRequestIds = new Set<string>();
  // Resume offers this socket already fallback-ACKed. The server can announce
  // cf_agent_stream_resuming for the same id twice (onConnect + resume-request),
  // and ACKing both replays the chunk buffer twice → duplicated assistant text.
  // ACK each at most once per socket; reset on close/dispose. Matches upstream 0.8.5.
  const fallbackAckedResumeRequestIds = new Set<string>();
  let streamState: BroadcastStreamState = { status: "idle" };
  let isResumingToolContinuation = false;
  // Serialize reconnect resume re-probes (#1837, upstream agents 0.17.2). The AI SDK's
  // Chat.makeRequest shares one mutable activeResponse with no concurrency guard, so a
  // second resumeStream() issued while the first is still in flight (reconnect storm)
  // overwrites+clears it before the first finalizer runs → a crash. Gate on an in-flight
  // flag; a generation counter lets teardown invalidate an orphaned late finalizer.
  let resumeInFlight = false;
  let resumeGeneration = 0;

  /** True while the server is recovering a durable chat turn (distinct from streaming). */
  const isRecovering = ref(false);
  /** Terminal WebSocket connection failure, or null. Mirrors AgentClient.connectionError. */
  const connectionError = ref<AgentConnectionError | null>(null);

  // AgentClient (PartySocket subclass) builds the websocket URL from the caller's
  // config and exposes a typed RPC stub when AgentT is provided. Compose an
  // onConnectionError that mirrors terminal failures into our reactive ref while
  // still forwarding to a caller-supplied handler.
  const socket = new AgentClient<AgentT, State>({
    ...options.client,
    onConnectionError: (error: AgentConnectionError) => {
      connectionError.value = error;
      options.client.onConnectionError?.(error);
    },
  });

  const transport = new WebSocketChatTransport({
    socket,
    activeRequestIds,
    cancelOnClientAbort: options.cancelOnClientAbort ?? false,
    prepareBody: async () => {
      const rawBody = options.body;
      const extraBody = typeof rawBody === "function" ? await rawBody() : (rawBody ?? {});
      const clientTools = getClientToolSchemas(options.tools);
      return clientTools ? { ...extraBody, clientTools } : extraBody;
    },
  });

  const handleToolCall: ChatOnToolCallCallback<ChatMessage> = async ({ toolCall }) => {
    const clientTool = options.tools?.[toolCall.toolName];
    const addClientToolOutput = (toolOutput: AgentToolOutput) => addToolOutputForTool(toolCall.toolName, toolOutput);

    if (options.onToolCall) {
      await options.onToolCall({ toolCall, addToolOutput: addClientToolOutput });
      return;
    }

    if (!clientTool?.execute) {
      return;
    }

    try {
      const output = await clientTool.execute(toolCall.input);
      await addClientToolOutput({ toolCallId: toolCall.toolCallId, output });
    } catch (error) {
      await addClientToolOutput({
        toolCallId: toolCall.toolCallId,
        state: "output-error",
        errorText: getErrorText(error),
      });
    }
  };

  const chat = new Chat<ChatMessage>({
    messages: options.initialMessages,
    transport,
    onToolCall: handleToolCall,
    onError: options.onError,
  });

  function startToolContinuation() {
    if (!autoContinueAfterToolResult || isResumingToolContinuation) {
      return;
    }

    isResumingToolContinuation = true;
    transport.expectToolContinuation();
    void chat.resumeStream().finally(() => {
      isResumingToolContinuation = false;
    });
  }

  async function stop() {
    try {
      // Explicit stop always cancels the server turn (incl. a broadcast/observed one)
      // before chat.stop() tears the local stream down. The generic abort that
      // chat.stop() triggers then runs local-only (default) and won't double-cancel.
      transport.cancelActiveServerTurn();
      await chat.stop();
    } finally {
      transport.abortActiveToolContinuation();
    }
  }

  function clearHistory() {
    void stop();
    isResumingToolContinuation = false;
    isRecovering.value = false;
    streamState = broadcastTransition(streamState, { type: "clear" }).state;
    chat.messages = [];
    socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  }

  async function addToolOutputForTool(toolName: string, toolOutput: AgentToolOutput) {
    const shouldAutoContinue = toolOutput.state === "output-error" ? false : autoContinueAfterToolResult;
    const clientTools = getClientToolSchemas(options.tools);

    socket.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: toolOutput.toolCallId,
        toolName,
        output: "output" in toolOutput ? toolOutput.output : undefined,
        ...(toolOutput.state ? { state: toolOutput.state } : {}),
        ...(toolOutput.errorText !== undefined ? { errorText: toolOutput.errorText } : {}),
        autoContinue: shouldAutoContinue,
        ...(clientTools ? { clientTools } : {}),
      }),
    );

    if (toolOutput.state === "output-error") {
      await chat.addToolOutput({
        tool: toolName,
        toolCallId: toolOutput.toolCallId,
        state: "output-error",
        errorText: toolOutput.errorText ?? "Tool execution failed.",
      });
    } else {
      await chat.addToolOutput({
        tool: toolName,
        toolCallId: toolOutput.toolCallId,
        output: toolOutput.output,
      });
    }

    if (shouldAutoContinue) {
      startToolContinuation();
    }
  }

  async function addToolOutput(...args: Parameters<typeof chat.addToolOutput>) {
    const [toolOutput] = args;
    await addToolOutputForTool(String(toolOutput.tool), toolOutput);
  }

  async function addToolApprovalResponse(...args: Parameters<typeof chat.addToolApprovalResponse>) {
    const [approvalResponse] = args;
    const toolCallId = getApprovalToolCallId(chat.messages, approvalResponse.id);

    // Skip the AI SDK update if there's no matching tool call. The SDK assumes
    // the approval part exists and crashes on lookup otherwise; with no part
    // to update, the response also has no semantic meaning.
    if (!toolCallId) {
      console.warn(`[agents-vue] Could not find tool call for approval "${approvalResponse.id}".`);
      return;
    }

    socket.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: approvalResponse.approved,
        autoContinue: autoContinueAfterToolResult,
      }),
    );

    await chat.addToolApprovalResponse(...args);
    startToolContinuation();
  }

  // Handle incoming WebSocket messages for state synchronization
  socket.addEventListener("message", (event: MessageEvent) => {
    try {
      const data = parseProtocolMessage<ChatMessage>(String(event.data));
      if (!data) {
        return;
      }

      switch (data.type) {
        // Full message list sync (sent on connect, and after every appendMessage / turn).
        case "cf_agent_chat_messages":
          chat.messages =
            chat.status === "streaming" || chat.status === "submitted" || streamState.status !== "idle"
              ? preserveActiveStreamMessages(chat.messages, data.messages ?? [])
              : (data.messages ?? []);
          break;

        // Single message update (e.g. tool result applied)
        case "cf_agent_message_updated":
          if (data.message) {
            chat.messages = replaceUpdatedMessage(chat.messages, data.message);
          }
          break;

        // Clear all messages
        case "cf_agent_chat_clear":
          streamState = broadcastTransition(streamState, { type: "clear" }).state;
          chat.messages = [];
          isRecovering.value = false;
          break;

        // Forward resume handshake to transport
        case "cf_agent_stream_resuming":
          if (
            data.id &&
            !transport.handleStreamResuming({ type: data.type, id: data.id }) &&
            !activeRequestIds.has(data.id) &&
            !fallbackAckedResumeRequestIds.has(data.id)
          ) {
            streamState = broadcastTransition(streamState, {
              type: "resume-fallback",
              streamId: data.id,
              messageId: createMessageId(),
            }).state;
            // ACK this offer at most once per socket (else a duplicate offer replays the
            // chunk buffer twice). Track the observed turn so an explicit stop() can cancel
            // it, and clear the recovery hint now that a recovered turn is streaming live.
            fallbackAckedResumeRequestIds.add(data.id);
            transport.observeServerTurn(data.id);
            isRecovering.value = false;
            socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: data.id }));
          }
          break;
        case "cf_agent_stream_resume_none":
          transport.handleStreamResumeNone();
          break;
        // Pre-stream window (0.9.0): keep the in-flight resume probe waiting.
        case "cf_agent_stream_pending":
          transport.handleStreamPending();
          break;
        // Durable chat-recovery progress hint (0.8.0). Cleared on terminal/stream below.
        case "cf_agent_chat_recovering":
          isRecovering.value = Boolean(data.recovering);
          break;
        case "cf_agent_use_chat_response":
          if (!data.id || activeRequestIds.has(data.id)) {
            return;
          }

          {
            const chunkData = data.body?.trim() ? JSON.parse(data.body) : undefined;
            const result = broadcastTransition(streamState, {
              type: "response",
              streamId: data.id,
              messageId: createMessageId(),
              chunkData,
              done: data.done,
              error: data.error,
              replay: data.replay,
              replayComplete: data.replayComplete,
              continuation: data.continuation,
              currentMessages: data.continuation ? chat.messages : undefined,
            });

            streamState = result.state;
            if (result.messagesUpdate) {
              // broadcastTransition typed messagesUpdate over base UIMessage; we trust
              // wire-tagged ChatMessage fields survive since transitions only touch base parts.
              chat.messages = result.messagesUpdate(chat.messages) as ChatMessage[];
            }

            if (data.done) {
              // A server/observed turn finished: clear the recovery hint and stop tracking it.
              isRecovering.value = false;
              transport.handleServerTurnCompleted(data.id);
            }
          }
          break;
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  // Connection lifecycle: forward each event to the caller before any internal
  // behavior (so the project layer can observe the raw event), then run our own
  // logic (resume an in-progress stream on open, when not disabled).
  socket.addEventListener("open", (event: Event) => {
    // A successful (re)connection clears any prior terminal connection error.
    connectionError.value = null;
    options.onOpen?.(event);
    // Re-probe the stream on open, but never overlap resume calls (#1837): skip if a
    // resume is already in flight, a tool continuation is resuming, or the transport is
    // mid resume-handshake. The gate is cleared by the in-flight resume's own finalizer.
    if (options.resume !== false && !resumeInFlight && !isResumingToolContinuation && !transport.isAwaitingResume()) {
      resumeInFlight = true;
      const myGeneration = resumeGeneration;
      void chat
        .resumeStream()
        .catch(() => {})
        .finally(() => {
          // A teardown between issue and settle bumps the generation; ignore that stale
          // finalizer so it can't reopen the gate on a disposed instance.
          if (resumeGeneration !== myGeneration) {
            return;
          }
          resumeInFlight = false;
        });
    }
  });
  socket.addEventListener("close", (event: Event) => {
    // A new connection legitimately needs a fresh ACK + replay, and any in-progress
    // recovery hint is stale once the socket drops.
    fallbackAckedResumeRequestIds.clear();
    isRecovering.value = false;
    // PartySocket dispatches CloseEvent here; widen narrowly for the callback.
    if (options.onClose && event instanceof CloseEvent) {
      options.onClose(event);
    }
  });
  socket.addEventListener("error", (event: Event) => {
    options.onSocketError?.(event);
  });

  // Cleanup on scope disposal
  onScopeDispose(() => {
    fallbackAckedResumeRequestIds.clear();
    isRecovering.value = false;
    // Force the resume gate open and bump the generation so any orphaned in-flight
    // resume's late finalizer is ignored rather than reopening the gate (#1837).
    resumeGeneration++;
    resumeInFlight = false;
    socket.close();
  });

  return {
    addToolApprovalResponse,
    addToolOutput,
    clearHistory,
    chat,
    socket,
    stop,
    /** Reactive: true while the server is recovering a durable chat turn. */
    isRecovering,
    /** Reactive: terminal WebSocket connection failure, or null. */
    connectionError,
  };
}

/**
 * Vue port of `@cloudflare/ai-chat/react`'s `useAgentChat`, because neither `agents` nor
 * `@cloudflare/ai-chat` ships a Vue client — both expose only `./react`.
 *
 * The transport is upstream's: `WebSocketChatTransport` from `agents/chat/transport`, which the
 * 0.2.x hand-rolled copy replaced. What lives here is the frame dispatcher the transport cannot
 * live without (`agents/src/chat/ws-chat-transport.ts` — "resume coordination is provided by
 * integrations such as useAgentChat"), plus the pieces React's hook keeps in state.
 *
 * What this hook does that the 0.2.x line did not:
 * - the transport comes from `agents/chat/transport`; its option is `agent`, not `socket`
 * - `retryPendingResume()` on socket open, so a handshake lost with the previous socket is
 *   re-sent on the replacement instead of timing out
 * - `setAgent()` exposed, which invalidates the transport's resume generation
 * - `handleStreamResumeNone` takes the probe id, so a stale NONE cannot settle a newer probe
 * - the initial `get-messages` fetch (React does this through `use()`; here it is an async seed)
 * - `connectionState` and `connectionError`, from the socket's own open/close and its terminal
 *   failures (PartySocket does the backing off; these only observe)
 * - a replacement socket re-reads `get-messages` and merges it, because nothing pushes a snapshot
 *   on connect and a turn that finished while this client was away is otherwise never seen
 * - `onStateUpdate` forwarded to the `AgentClient`, which is where React's `useAgent` takes it
 * - the four client-side bugs the Vue port carried, fixed against the React client: client-side
 *   tool calls dispatched off the rendered transcript rather than off the SDK's own callback; the
 *   early-continuation branch, so an announced continuation is observed or launched but never
 *   both; the continuation armed before the tool frame is sent; and an unmatchable streaming tail
 *   dropped rather than appended, with message ids minted without `Math.random`
 *
 * The cross-tab observer upstream's React hook carries is deliberately left out.
 */
import { Chat } from "@ai-sdk/vue";
import { broadcastTransition } from "agents/chat";
import type { BroadcastStreamState } from "agents/chat";
import { WebSocketChatTransport } from "agents/chat/transport";
import { AgentClient, type AgentClientOptions, type AgentConnectionError } from "agents/client";
import {
  getToolName,
  isToolUIPart,
  type ChatStatus,
  type ChatTransport,
  type JSONSchema7,
  type Tool,
  type UIMessage,
} from "ai";
import { onScopeDispose, ref, watch } from "vue";

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
  /**
   * Called with every socket frame, parsed, **before** the chat protocol reads it. Return `true`
   * to consume the frame, which stops the protocol handling below from seeing it at all.
   *
   * This is where an application's own frames belong. The protocol parser narrows a frame to the
   * fields the chat protocol has and drops every other one, so a frame of your own would otherwise
   * arrive with its contents removed.
   */
  onFrame?: (frame: unknown) => boolean | void;
  /**
   * How a transcript read back from the server is merged into the one on screen, used when a
   * replacement socket re-reads `get-messages`.
   *
   * The read is a round trip of its own: it can be issued before a turn is persisted and land
   * after the socket has already delivered the finished answer, so replacing the transcript with
   * it wholesale would erase a reply that is on screen. The default merges by id with the stored
   * copy winning and anything only on screen appended after; pass your own policy to decide
   * differently — which copy of a message is fresher, say.
   */
  mergeMessages?: (onScreen: ChatMessage[], stored: ChatMessage[]) => ChatMessage[];
  /**
   * When true, a send carries only the messages after the last one the server is known to hold, and
   * names that message in the request body as `afterMessageId`. Known to hold means seen arriving
   * from the server — in `initialMessages`, the `get-messages` read, a `cf_agent_chat_messages`
   * broadcast, a `cf_agent_message_updated` frame, or a stream that finished — never a message only
   * this client has.
   *
   * A request that rewrites a message in place carries it too: the assistant message a tool result
   * or an approval updated, or an edited question. A regenerate, and a send before the server is
   * known to hold anything, carry the full list and no `afterMessageId`.
   *
   * Turn it on only against a server that rebuilds the transcript: when the first message sent is
   * one it stores, the stored messages up to and including `afterMessageId`, then the ones sent;
   * otherwise the whole stored transcript, then the ones sent, so a client that missed another's
   * messages does not erase them. `AIChatAgent` on its own takes a request's list for the whole
   * transcript, and would keep only the messages sent.
   */
  sendOnlyNewMessages?: boolean;
  /**
   * Called with the agent's state, on connect and on every change the server broadcasts.
   *
   * The same option the React hook passes to `useAgent`. It is forwarded to `AgentClient`, which
   * owns the `cf_agent_state` frame; the dispatcher below never sees one. `source` is `"server"` for
   * a broadcast and `"client"` for this client's own `setState` — which a server-owned state refuses,
   * so nothing here sends one.
   */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
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
  /** 0.23: which resume probe a STREAM_RESUME_NONE answers. */
  probeId?: string;
  message?: ChatMessage;
  messages?: ChatMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProtocolMessage<ChatMessage extends UIMessage>(parsed: unknown): ProtocolMessage<ChatMessage> | null {
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
    probeId: typeof parsed.probeId === "string" ? parsed.probeId : undefined,
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

  // The tail belongs to no incoming message. Dropping the protection is what upstream does, and
  // keeping it is a literal duplicate: the same turn, once under the id storage gave it and once
  // under the id this client minted while it was streaming.
  return incomingMessages;
}

/**
 * The chat states a tool continuation may not launch during. The AI SDK keeps one mutable active
 * response, so resuming while a request is in flight overwrites it; an errored chat has its
 * continuation abandoned instead of launched.
 */
const CONTINUATION_BLOCKING_STATUSES = new Set<ChatStatus>(["submitted", "streaming", "error"]);

/**
 * The default {@link UseAgentChatOptions.mergeMessages}: match by id, the stored copy wins, and
 * anything only on screen — a question typed while the socket was down — is kept after it.
 */
function mergeById<ChatMessage extends UIMessage>(onScreen: ChatMessage[], stored: ChatMessage[]): ChatMessage[] {
  const storedIds = new Set(stored.map((message) => message.id));

  return [...stored, ...onScreen.filter((message) => !storedIds.has(message.id))];
}

function idsOf(messages: UIMessage[]): string[] {
  return messages.map((message) => message.id);
}

/** The message id a stream's opening `start` chunk carries, when `body` is one. */
function startMessageIdOf(body: string): string | null {
  try {
    const chunk: unknown = JSON.parse(body);
    return isRecord(chunk) && chunk.type === "start" && typeof chunk.messageId === "string" ? chunk.messageId : null;
  } catch {
    return null;
  }
}

type ChatRequest<ChatMessage extends UIMessage> = Parameters<ChatTransport<ChatMessage>["sendMessages"]>[0];

function createMessageId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  /** Whether a continuation has been armed but not yet launched. */
  let pendingToolContinuation = false;
  let continuationLaunchTimer: ReturnType<typeof setTimeout> | null = null;
  /** The turn being watched in place of the continuation this client armed, or `null`. */
  let observedToolContinuationRequestId: string | null = null;
  /** Tool calls already handed to the caller, so a re-render or a re-sync cannot run one twice. */
  const dispatchedToolCallIds = new Set<string>();
  /**
   * The transcript the server is known to hold, as ids in order: the history it sent, or what was
   * on screen through the last message it was seen to hold. What `sendOnlyNewMessages` sends after.
   */
  let heldMessageIds = idsOf(options.initialMessages ?? []);
  /** Each stream's own message id, from its `start` chunk, until the stream's terminal frame. */
  const streamMessageIds = new Map<string, string | null>();
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
  /**
   * Whether the socket is up. PartySocket reconnects with its own backoff, so this only observes:
   * it is set from the socket's open and close events and drives nothing.
   */
  const connectionState = ref<"connected" | "reconnecting">("connected");
  /** Whether this socket is a replacement, and so owes the transcript a read from storage. */
  let resyncPending = false;
  /** Whether a turn this client is only watching is streaming. Gates the dispatch below. */
  const isServerStreaming = ref(false);

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
    onStateUpdate: (state: State, source: "server" | "client") => {
      options.onStateUpdate?.(state, source);
      options.client.onStateUpdate?.(state, source);
    },
  });

  const transport = new WebSocketChatTransport<ChatMessage>({
    agent: socket,
    activeRequestIds,
    cancelOnClientAbort: options.cancelOnClientAbort ?? false,
    prepareBody: async () => {
      const rawBody = options.body;
      const extraBody = typeof rawBody === "function" ? await rawBody() : (rawBody ?? {});
      const clientTools = getClientToolSchemas(options.tools);
      return clientTools ? { ...extraBody, clientTools } : extraBody;
    },
  });

  async function dispatchToolCall(toolCall: AgentToolCall) {
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
  }

  const chat = new Chat<ChatMessage>({
    messages: options.initialMessages,
    transport: options.sendOnlyNewMessages
      ? {
          sendMessages: (request) => transport.sendMessages(onlyNewMessages(request)),
          reconnectToStream: (request) => transport.reconnectToStream(request),
        }
      : transport,
    onError: options.onError,
  });

  /**
   * The request `sendOnlyNewMessages` sends: the messages after those the server holds — from the
   * one the request rewrites in place, when that comes earlier — with the message before them named
   * as `afterMessageId`. A regenerate goes whole, and so does a request with nothing held ahead of
   * what it sends or nothing new to send.
   */
  function onlyNewMessages(request: ChatRequest<ChatMessage>): ChatRequest<ChatMessage> {
    if (request.trigger === "regenerate-message") {
      return request;
    }

    const { messages } = request;
    let held = 0;
    while (held < messages.length && messages[held]?.id === heldMessageIds[held]) {
      held++;
    }

    const rewrittenIndex = messages.findIndex((message) => message.id === request.messageId);
    const start = rewrittenIndex >= 0 ? Math.min(held, rewrittenIndex) : held;
    if (rewrittenIndex >= 0) {
      // The stored copy of the rewritten message no longer matches the one on screen under the same
      // id, and this request may never land. A later stream that ends cleanly holds it again.
      heldMessageIds = heldMessageIds.slice(0, start);
    }

    const afterMessageId = messages[start - 1]?.id;
    if (afterMessageId === undefined || start === messages.length) {
      return request;
    }

    return { ...request, messages: messages.slice(start), body: { ...request.body, afterMessageId } };
  }

  /** The server holds everything on screen through `messageId`, if that message is on screen. */
  function holdThrough(messageId: string) {
    const index = chat.messages.findIndex((message) => message.id === messageId);
    if (index >= 0) {
      heldMessageIds = idsOf(chat.messages.slice(0, index + 1));
    }
  }

  /**
   * A stream's own message is held once the stream ends without an error: `AIChatAgent` holds a
   * turn's terminal frame back until its persist step has run, and turns it into an error when
   * persisting fails. A reply with no parts (a stop straight after `start`) or one a stall recovery
   * discards ends cleanly without being stored, but a server answers an anchor it does not hold by
   * appending, so the next send still lands. A continuation's `start` carries no id, since it
   * extends a message the server already holds.
   */
  function trackStreamMessage(requestId: string, frame: ProtocolMessage<ChatMessage>) {
    if (frame.done || frame.error) {
      const messageId = streamMessageIds.get(requestId);
      streamMessageIds.delete(requestId);
      if (messageId && !frame.error) {
        holdThrough(messageId);
      }
    } else if (!streamMessageIds.has(requestId) && frame.body?.trim()) {
      streamMessageIds.set(requestId, startMessageIdOf(frame.body));
    }
  }

  /**
   * Hands the caller every tool call the transcript is waiting on, whatever painted it.
   *
   * The AI SDK's own `onToolCall` fires only for a stream the SDK is reading, so a call in a turn
   * this client merely observed — a resumed turn, a turn another tab started — would render as a
   * chip and never run. Reading the rendered message instead makes dispatch independent of which
   * path delivered the turn, and the id set is what keeps a re-render from running one twice.
   */
  function dispatchRenderedToolCalls() {
    if (chat.status === "streaming" || chat.status === "submitted" || isServerStreaming.value || isRecovering.value) {
      return;
    }

    const lastMessage = chat.messages.at(-1);
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    for (const part of lastMessage.parts) {
      if (!isToolUIPart(part) || part.state !== "input-available" || dispatchedToolCallIds.has(part.toolCallId)) {
        continue;
      }

      dispatchedToolCallIds.add(part.toolCallId);
      void dispatchToolCall({ toolCallId: part.toolCallId, toolName: getToolName(part), input: part.input });
    }
  }

  /**
   * Arms the continuation. Called **before** the tool frame is sent, never after: the server can
   * announce the continuation before this client's launch runs, and the early branch in the frame
   * dispatcher tells "the turn I was about to start" from "a turn that is not mine" by this flag.
   */
  function armToolContinuation(): boolean {
    if (!autoContinueAfterToolResult || isResumingToolContinuation) {
      return false;
    }

    isResumingToolContinuation = true;
    pendingToolContinuation = true;
    return true;
  }

  /** Launches an armed continuation on the next turn of the event loop, if it still wants one. */
  function scheduleToolContinuationLaunch() {
    if (
      !pendingToolContinuation ||
      continuationLaunchTimer !== null ||
      CONTINUATION_BLOCKING_STATUSES.has(chat.status)
    ) {
      return;
    }

    continuationLaunchTimer = setTimeout(() => {
      continuationLaunchTimer = null;

      if (!pendingToolContinuation || CONTINUATION_BLOCKING_STATUSES.has(chat.status)) {
        return;
      }

      pendingToolContinuation = false;
      transport.expectToolContinuation();
      void chat.resumeStream().finally(() => {
        isResumingToolContinuation = false;
      });
    }, 0);
  }

  /** Forgets an armed continuation, whether it was launched, observed elsewhere, or abandoned. */
  function resetToolContinuation() {
    pendingToolContinuation = false;
    isResumingToolContinuation = false;
    observedToolContinuationRequestId = null;

    if (continuationLaunchTimer !== null) {
      clearTimeout(continuationLaunchTimer);
      continuationLaunchTimer = null;
    }
  }

  watch([() => chat.messages, () => chat.status, isServerStreaming, isRecovering], () => {
    if (chat.status === "error" && pendingToolContinuation) {
      resetToolContinuation();
    } else {
      scheduleToolContinuationLaunch();
    }

    dispatchRenderedToolCalls();
  });

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
    resetToolContinuation();
    isRecovering.value = false;
    isServerStreaming.value = false;
    streamState = broadcastTransition(streamState, { type: "clear" }).state;
    chat.messages = [];
    heldMessageIds = [];
    socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  }

  async function addToolOutputForTool(toolName: string, toolOutput: AgentToolOutput) {
    const shouldAutoContinue = toolOutput.state === "output-error" ? false : autoContinueAfterToolResult;
    const clientTools = getClientToolSchemas(options.tools);
    const continuing = shouldAutoContinue && armToolContinuation();

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

    if (continuing) {
      scheduleToolContinuationLaunch();
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

    const continuing = armToolContinuation();

    socket.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: approvalResponse.approved,
        autoContinue: autoContinueAfterToolResult,
      }),
    );

    await chat.addToolApprovalResponse(...args);

    if (continuing) {
      scheduleToolContinuationLaunch();
    }
  }

  // Handle incoming WebSocket messages for state synchronization
  socket.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw: unknown = JSON.parse(String(event.data));

      if (options.onFrame?.(raw) === true) {
        return;
      }

      const data = parseProtocolMessage<ChatMessage>(raw);
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
          heldMessageIds = idsOf(data.messages ?? []);
          break;

        // Single message update (e.g. tool result applied)
        case "cf_agent_message_updated":
          if (data.message) {
            chat.messages = replaceUpdatedMessage(chat.messages, data.message);
            holdThrough(data.message.id);
          }
          break;

        // Clear all messages
        case "cf_agent_chat_clear":
          streamState = broadcastTransition(streamState, { type: "clear" }).state;
          chat.messages = [];
          heldMessageIds = [];
          isRecovering.value = false;
          isServerStreaming.value = false;
          break;

        // Forward resume handshake to transport
        case "cf_agent_stream_resuming": {
          // The turn this client armed a continuation for, announced before the launch could
          // register its resolver. Observing it and launching anyway delivers the same turn
          // twice, so the launch is abandoned here — one or the other, never both.
          const isEarlyToolContinuation = isResumingToolContinuation && !transport.isAwaitingResume();

          if (
            data.id &&
            !transport.handleStreamResuming({ id: data.id }) &&
            !activeRequestIds.has(data.id) &&
            !fallbackAckedResumeRequestIds.has(data.id)
          ) {
            if (isEarlyToolContinuation) {
              pendingToolContinuation = false;
              observedToolContinuationRequestId = data.id;

              if (continuationLaunchTimer !== null) {
                clearTimeout(continuationLaunchTimer);
                continuationLaunchTimer = null;
              }
            }

            const resumed = broadcastTransition(streamState, {
              type: "resume-fallback",
              streamId: data.id,
              messageId: createMessageId(),
            });
            streamState = resumed.state;
            isServerStreaming.value = resumed.isStreaming;
            // ACK this offer at most once per socket (else a duplicate offer replays the
            // chunk buffer twice). Track the observed turn so an explicit stop() can cancel
            // it, and clear the recovery hint now that a recovered turn is streaming live.
            fallbackAckedResumeRequestIds.add(data.id);
            transport.observeServerTurn(data.id);
            isRecovering.value = false;
            socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: data.id }));
          }
          break;
        }
        // 0.23 carries the probe id, so a NONE answering an older probe cannot settle this one.
        case "cf_agent_stream_resume_none": {
          const settled = transport.handleStreamResumeNone({ probeId: data.probeId });

          // The server has no stream left, so a turn this client was observing in place of its own
          // continuation has ended. Without this the continuation would stay armed for the life of
          // the page whenever the frame that ends it was lost with the previous socket, and every
          // later tool result would decline to continue.
          if (settled && observedToolContinuationRequestId !== null) {
            resetToolContinuation();
          }
          break;
        }
        // Pre-stream window (0.9.0): keep the in-flight resume probe waiting.
        case "cf_agent_stream_pending":
          transport.handleStreamPending();
          break;
        // Durable chat-recovery progress hint (0.8.0). Cleared on terminal/stream below.
        case "cf_agent_chat_recovering":
          isRecovering.value = Boolean(data.recovering);
          break;
        case "cf_agent_use_chat_response":
          if (data.id) {
            trackStreamMessage(data.id, data);
          }

          if (!data.id || activeRequestIds.has(data.id)) {
            return;
          }

          {
            // A turn another tab started is this tab's to stop too, since the state shows it Stop
            // for it. `stop()` cancels only a turn the transport is tracking, and nothing else
            // registers one this tab only watches.
            if (!data.done && !data.error && transport.activeServerTurnId !== data.id) {
              transport.observeServerTurn(data.id);
            }

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
            isServerStreaming.value = result.isStreaming;
            if (result.messagesUpdate) {
              // broadcastTransition typed messagesUpdate over base UIMessage; we trust
              // wire-tagged ChatMessage fields survive since transitions only touch base parts.
              chat.messages = result.messagesUpdate(chat.messages) as ChatMessage[];
            }

            if (data.done || data.error) {
              // A server/observed turn finished: clear the recovery hint and stop tracking it.
              isRecovering.value = false;
              transport.handleServerTurnCompleted(data.id);

              if (observedToolContinuationRequestId === data.id) {
                resetToolContinuation();
              }
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
    connectionState.value = "connected";
    options.onOpen?.(event);
    // `socket.url` is empty until PartySocket has resolved its URL provider, so the seed cannot
    // run at setup; the first open is the earliest point the HTTP twin of the socket URL exists.
    void seedInitialMessages();

    if (resyncPending) {
      resyncPending = false;
      void resyncMessages();
    }
    // 0.23 rebase: PartySocket replaces the underlying WebSocket on reconnect, so a handshake
    // sent on the dead one was never answered. Retransmit it on the new socket rather than
    // starting a second AI SDK resume operation — and if that succeeds, there is nothing left
    // for the fresh-probe branch below to do.
    if (transport.retryPendingResume()) {
      return;
    }
    // Re-probe the stream on open, but never overlap resume calls (#1837): skip if a
    // resume is already in flight, a tool continuation is resuming, or the transport is
    // mid resume-handshake. The gate is cleared by the in-flight resume's own finalizer.
    //
    // A continuation this client handed to the server is the exception: it is "resuming" with
    // nothing of its own in flight, and the probe is the only thing that can find out how the
    // observed turn ended now that the socket carrying it is gone.
    const canReconcileObservedContinuation = observedToolContinuationRequestId !== null;

    if (
      options.resume !== false &&
      !resumeInFlight &&
      (!isResumingToolContinuation || canReconcileObservedContinuation) &&
      !transport.isAwaitingResume()
    ) {
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
    // A stream the socket was carrying is replayed from its `start` on the replacement, or never ends.
    streamMessageIds.clear();
    isRecovering.value = false;
    connectionState.value = "reconnecting";
    resyncPending = true;
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
    resetToolContinuation();
    isRecovering.value = false;
    // Force the resume gate open and bump the generation so any orphaned in-flight
    // resume's late finalizer is ignored rather than reopening the gate (#1837).
    resumeGeneration++;
    resumeInFlight = false;
    socket.close();
  });

  /**
   * 0.23 rebase: point the transport at a different connection. `setAgent` invalidates the
   * transport's resume generation, so a handshake owned by the old socket settles instead of
   * leaking a resolver into the new one.
   */
  function setAgent(next: AgentClient<AgentT, State>) {
    transport.setAgent(next);
  }

  /**
   * 0.23 rebase: the initial transcript fetch the React hook does through `use()`. It is also what
   * a reconnect reads, because nothing pushes a full snapshot on connect — `cf_agent_chat_messages`
   * is broadcast by `persistMessages` and by nothing else, so a client that was away while a turn
   * finished is never told, and would sit on its half-written partial until a reload.
   */
  const initialMessagesLoaded = ref(false);
  let initialMessagesSeedStarted = options.initialMessages !== undefined;
  initialMessagesLoaded.value = initialMessagesSeedStarted;

  async function fetchStoredMessages(): Promise<ChatMessage[] | null> {
    try {
      const target = new URL(socket.url);
      target.protocol = target.protocol === "wss:" ? "https:" : "http:";
      target.searchParams.delete("_pk");
      target.pathname += "/get-messages";
      const response = await fetch(target.toString(), { credentials: "include" });
      if (!response.ok) {
        console.warn(`[agents-vue] get-messages failed: ${response.status} ${response.statusText}`);
        return null;
      }
      const text = await response.text();
      return text.trim() ? (JSON.parse(text) as ChatMessage[]) : null;
    } catch (error) {
      console.warn("[agents-vue] get-messages errored", error);
      return null;
    }
  }

  async function seedInitialMessages() {
    // Once per hook instance: a reconnect takes the resync path below instead.
    if (initialMessagesSeedStarted) {
      return;
    }
    initialMessagesSeedStarted = true;
    try {
      const stored = await fetchStoredMessages();
      if (stored && chat.messages.length === 0) {
        chat.messages = stored;
        heldMessageIds = idsOf(stored);
      }
    } finally {
      initialMessagesLoaded.value = true;
    }
  }

  /** What a reconnect reads, merged rather than taken wholesale. See the `mergeMessages` option. */
  async function resyncMessages() {
    const stored = await fetchStoredMessages();

    if (stored) {
      chat.messages = (options.mergeMessages ?? mergeById)(chat.messages, stored);
      heldMessageIds = idsOf(stored);
    }
  }
  return {
    addToolApprovalResponse,
    addToolOutput,
    clearHistory,
    chat,
    socket,
    setAgent,
    stop,
    /** Reactive: true once the `get-messages` seed has settled (or was skipped). */
    initialMessagesLoaded,
    /** Reactive: true while the server is recovering a durable chat turn. */
    isRecovering,
    /** Reactive: terminal WebSocket connection failure, or null. */
    connectionError,
    /** Reactive: whether the socket is up, for the header's "Reconnecting…". */
    connectionState,
  };
}

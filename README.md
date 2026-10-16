# agents-vue

Vue 3 composable for [Cloudflare Agents](https://github.com/cloudflare/agents) — a port of `@cloudflare/ai-chat/react`'s `useAgentChat` to the Vue Composition API and `@ai-sdk/vue`.

> `agents-vue` is a Vue 3 port of [`@cloudflare/ai-chat`](https://github.com/cloudflare/agents/tree/main/packages/ai-chat)'s `useAgentChat` React hook. The protocol, semantics, and most of the algorithmic structure come directly from the upstream React implementation. This package adapts it to the Vue Composition API and `@ai-sdk/vue`.

## Status

Covers the surface needed for a working chat UI — streaming responses, client-side tools, tool approvals, stream resumption, broadcast handling — at parity with upstream `@cloudflare/ai-chat` 0.12.x on resume/recovery: resume dedupe, `isRecovering`, `cancelOnClientAbort`, pre-stream `cf_agent_stream_pending`, and `connectionError`. Deeper upstream features (the `useAgent` connection hook, the cross-tab observer, `isServerStreaming` / `isStreaming` flags) are on the roadmap.

0.3.0 moves the transport to upstream's own `WebSocketChatTransport` from `agents/chat/transport` and fixes four client-side bugs — see [CHANGELOG](./CHANGELOG.md).

## Install

```bash
pnpm add agents-vue
```

Peer dependencies (must also be installed):

| Peer | Version |
|---|---|
| `vue` | `^3.5.0` |
| `@ai-sdk/vue` | `^4.0.0` |
| `ai` | `^7.0.0` |
| `agents` | `>=0.27.0 <1.0.0` |

## Usage

```vue
<script setup lang="ts">
import { useAgentChat } from "agents-vue";

const { chat, addToolOutput, addToolApprovalResponse, clearHistory, stop } = useAgentChat({
  client: {
    agent: "MyAgent",          // Agent class name
    host: "agent.example.com", // your worker host
    name: "session-id",        // identifies the Durable Object instance
  },
});
</script>

<template>
  <div v-for="message in chat.messages" :key="message.id">
    <strong>{{ message.role }}:</strong>
    <template v-for="(part, i) in message.parts" :key="i">
      <span v-if="part.type === 'text'">{{ part.text }}</span>
    </template>
  </div>

  <button @click="chat.sendMessage({ text: 'hi' })">Send</button>
  <button @click="stop()">Stop</button>
  <button @click="clearHistory()">Clear</button>
</template>
```

`chat` is the underlying [`@ai-sdk/vue` `Chat` instance](https://ai-sdk.dev/) — `chat.messages`, `chat.status`, `chat.sendMessage()` are all reactive and standard. The composable layers WebSocket-aware overrides for `addToolOutput`, `addToolApprovalResponse`, `clearHistory`, and `stop`, plus full-history sync, broadcast merging, and stream resumption.

## SSR

`agents-vue` is **client-only**. The composable opens a WebSocket on construction and will throw in Node / SSR contexts. Wrap call sites in `<ClientOnly>` (Nuxt) or defer with `onMounted`.

```vue
<!-- Nuxt -->
<ClientOnly>
  <ChatComponent />
</ClientOnly>
```

## API

### `useAgentChat<AgentT, ChatMessage, State>(options)`

Returns:

| Field | Type | Description |
|---|---|---|
| `chat` | `Chat<ChatMessage>` | `@ai-sdk/vue` chat instance — reactive `messages`, `status`, `error`, plus `sendMessage`, `regenerate`. |
| `socket` | `AgentClient<AgentT, State>` | Underlying PartySocket. Typed RPC stub when `AgentT` is provided. |
| `addToolOutput` | `function` | Submit a tool result. Sends `cf_agent_tool_result` and triggers continuation if enabled. |
| `addToolApprovalResponse` | `function` | Resolve a human-in-the-loop tool approval. Sends `cf_agent_tool_approval` and triggers continuation. |
| `clearHistory` | `function` | Clear local state and broadcast `cf_agent_chat_clear` to the server. |
| `stop` | `function` | Abort the active stream and any pending tool continuation. Always cancels the server turn (explicit cancel). |
| `isRecovering` | `Ref<boolean>` | Reactive — `true` while the server is recovering a durable chat turn (distinct from streaming, so a UI can show "recovering…"). Driven by `cf_agent_chat_recovering`. |
| `connectionError` | `Ref<AgentConnectionError \| null>` | Reactive — the terminal WebSocket connection failure, or `null`. Cleared on reconnect. |

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `client` | `AgentClientOptions<State>` | — | **Required.** Connection config — `agent`, `host`, `name`, `basePath`. |
| `initialMessages` | `ChatMessage[]` | `[]` | Seed messages on mount. |
| `body` | `object \| () => object \| Promise<object>` | — | Extra request body — static or per-request function. |
| `tools` | `Record<string, AgentClientTool>` | — | Client-side tool definitions. Schemas auto-extracted and sent with each request. |
| `onToolCall` | `({ toolCall, addToolOutput }) => void \| Promise<void>` | — | Custom tool-call handler. Overrides per-tool `execute`. |
| `autoContinueAfterToolResult` | `boolean` | `true` | Server resumes the stream after a tool result. |
| `resume` | `boolean` | `true` | Resume in-flight streams on socket reconnect. |
| `cancelOnClientAbort` | `boolean` | `false` | When `true`, a generic client-side abort cancels the server turn; when `false` (default) such aborts are local-only and the server turn keeps running and can resume. Explicit `stop()` always cancels. |
| `onOpen` | `(event: Event) => void` | — | WebSocket open. |
| `onClose` | `(event: CloseEvent) => void` | — | WebSocket close. |
| `onSocketError` | `(event: Event) => void` | — | Connection-level error. |
| `onError` | `(error: Error) => void` | — | Chat-turn error from the AI SDK. |
| `onStateUpdate` | `(state: State, source: "server" \| "client") => void` | — | The agent's state, on connect and on every change the server broadcasts. |
| `onFrame` | `(frame: unknown) => boolean \| void` | — | Every socket frame, parsed, **before** the chat protocol reads it. Return `true` to consume it. |
| `mergeMessages` | `(onScreen, stored) => ChatMessage[]` | merge by id | How a reconnect's read of the stored transcript joins the one on screen. |
| `sendOnlyNewMessages` | `boolean` | `false` | A send carries only the messages after the last one the server is known to hold, named as `afterMessageId`. The server must rebuild the rest. |

### `onFrame` — your own frames

The chat protocol parser narrows a frame to the fields `cf_agent_*` messages have and drops every
other one, so a frame of your own would arrive with its contents removed. `onFrame` runs first and
sees the frame whole; returning `true` consumes it, and the protocol handling never sees it.

```ts
useAgentChat({
  client: { /* ... */ },
  onFrame: (frame) => {
    if (!isRecord(frame) || frame.type !== "my_app_event") return;
    showBanner(frame);
    return true; // consumed
  },
});
```

### `mergeMessages` — what a reconnect does to the transcript

Nothing pushes a snapshot on connect, so a replacement socket re-reads the stored transcript — and
that read is a round trip of its own: it can be issued before a turn is persisted and land after the
socket has already delivered the finished answer. The default merges by id with the stored copy
winning and anything only on screen kept after it. Pass your own policy to decide differently.

```ts
import type { UIMessage } from "ai";

const textLength = (message: UIMessage) =>
  message.parts.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0);

/** The stored copy can be behind the stream, so the longer of the two wins. */
const fresher = (stored: UIMessage, onScreen: UIMessage | undefined) =>
  onScreen && textLength(onScreen) > textLength(stored) ? onScreen : stored;

useAgentChat({
  client: { /* ... */ },
  mergeMessages: (onScreen, stored) => {
    const live = new Map(onScreen.map((message) => [message.id, message]));
    const storedIds = new Set(stored.map((message) => message.id));

    return [
      ...stored.map((message) => fresher(message, live.get(message.id))),
      // Anything only on screen — a question typed while the socket was down — is kept after.
      ...onScreen.filter((message) => !storedIds.has(message.id)),
    ];
  },
});
```

### `sendOnlyNewMessages` — sending what the server does not have

By default every send carries the whole transcript, so a request grows with the session. With
`sendOnlyNewMessages: true` it carries only the messages after the last one the server is known to
hold — usually just the new question — and names that message as `afterMessageId`, beside
`messages` in the request body. Known to hold means seen arriving from the server: `initialMessages`,
the `get-messages` read, a broadcast, a `cf_agent_message_updated` frame, or a stream that finished
without an error with a part in its reply. A message only this client has never counts. A request
that rewrites a message in place carries it too: an edited question, or the assistant message a
bare `sendMessage()` resubmits after an approval or a tool output. A regenerate, and a send before
the server is known to hold anything, carry the full list and no `afterMessageId`.

A client tool's output is not part of any request: it reaches the server in a `cf_agent_tool_result`
frame, with the option on or off. What changes is the next request. A question typed after a tool
output carries only the question, where the full list re-sent the output along with everything
else; only a request a bare `sendMessage()` makes carries the rewritten assistant message.

**The server's half.** A request with `afterMessageId` holds only part of the transcript, so the
server must rebuild the full list before it persists the request or broadcasts it — `AIChatAgent`
broadcasts a request's list to the other clients as it arrived. When the first message sent is one
it already stores, at index `k`, the request rewrites in place, and the full list is its stored
messages before `k`, then the ones sent. Otherwise the messages sent are new and go after the whole
stored transcript, less any it already stores, so a client that missed messages another client
added does not erase them. The rebuild reads `afterMessageId` only to know the list is partial: its
value, the last message the client saw the server hold, is a hint, and can name a reply the server
never stored. A request without the field carries the full list, as before. `AIChatAgent` does none
of this on its own: it takes a request's list for the whole transcript and deletes the stored
messages missing from it, which is why the option is off by default.

```ts
function rebuild(stored: UIMessage[], sent: UIMessage[], afterMessageId?: string): UIMessage[] {
  if (afterMessageId === undefined) return sent;
  const rewriteAt = stored.findIndex((message) => message.id === sent[0]?.id);
  if (rewriteAt >= 0) return [...stored.slice(0, rewriteAt), ...sent];
  const storedIds = new Set(stored.map((message) => message.id));
  return [...stored, ...sent.filter((message) => !storedIds.has(message.id))];
}
```

### Client-side tools

```ts
useAgentChat({
  client: { /* ... */ },
  tools: {
    weather: {
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      execute: async ({ city }) => ({ temp: 70, conditions: "clear" }),
    },
  },
});
```

Tool schemas are auto-extracted from any tool with an `execute` function and sent to the server with each request. The server invokes the tool by name; `execute` runs client-side; the output flows back via `addToolOutput`.

### Tool approvals (human-in-the-loop)

```ts
const { addToolApprovalResponse } = useAgentChat({ /* ... */ });

// When the model requests approval for a destructive tool:
await addToolApprovalResponse({ id: approvalId, approved: true });
```

The composable matches the approval id against a `tool-approve` part in `chat.messages` and forwards `cf_agent_tool_approval` to the server. If no match exists it warns to the console and bails — no SDK crash.

### `WebSocketChatTransport`

No longer exported from here. Since 0.3.0 the composable wires upstream's own transport, so import
it from `agents` directly if you are building a non-`@ai-sdk/vue` flow over the same `cf_agent_*`
wire protocol:

```ts
import { WebSocketChatTransport } from "agents/chat/transport";

const transport = new WebSocketChatTransport({
  agent,         // an AgentClient
  prepareBody,   // optional
});
```

## Coverage vs upstream

`agents-vue` covers the surface real apps use. Wire protocol is identical to upstream — same `cf_agent_*` message shapes, same resumable streaming, same broadcast transitions, same tool continuation flow.

| Feature | Status |
|---|---|
| `useAgentChat` composable | ✅ |
| `WebSocketChatTransport` (upstream's, from `agents/chat/transport`) | ✅ |
| Streaming responses | ✅ |
| Client-side tools with `execute` | ✅ |
| Tool approvals (HITL) | ✅ |
| `body` option (static / sync / async) | ✅ |
| Stream resumption (resumable streaming) | ✅ |
| Partial-hydration replay rebuild | ✅ |
| Broadcast handling (multi-tab) | ✅ |
| Tool approval continuation merge across broadcasts | ✅ |
| Resume dedupe (fallback-ACK at most once per socket) | ✅ |
| `isRecovering` durable-recovery hint (`cf_agent_chat_recovering`) | ✅ |
| `cancelOnClientAbort` (local-only abort, default) | ✅ |
| Pre-stream `cf_agent_stream_pending` (extended resume probe) | ✅ |
| `connectionError` (terminal WebSocket close) | ✅ |
| Reconnect resume serialization (in-flight gate, `agents` 0.17.2 / #1837) | ✅ |
| `setAgent()`, which invalidates the transport's resume generation | ✅ |
| `connectionState`, from the socket's own open/close | ✅ |
| `onStateUpdate`, forwarded to the `AgentClient` | ✅ |
| Initial `get-messages` seed, and a re-read on a replacement socket | ✅ |
| Client-side tool calls dispatched off the rendered transcript | ✅ |
| Early-continuation branch (observe the announced turn, or launch — never both) | ✅ |
| Continuation armed before the tool frame is sent | ✅ |
| An unmatchable streaming tail dropped rather than appended | ✅ |
| `useAgent` connection hook | 🚧 roadmap |
| Cross-tab observer | 🚧 roadmap |
| `isServerStreaming` / `isStreaming` flags | 🚧 roadmap |

## Contributing

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test       # chromium (vitest-browser-vue)
pnpm typecheck
pnpm lint
pnpm build
```

Releases are driven by [`changelogen`](https://github.com/unjs/changelogen) with conventional commits.

## License

MIT — see [LICENSE](./LICENSE). Includes attribution to the original Cloudflare React implementation in [`@cloudflare/ai-chat`](https://github.com/cloudflare/agents/tree/main/packages/ai-chat).

# agents-vue

Vue 3 composable for [Cloudflare Agents](https://github.com/cloudflare/agents) — a port of `@cloudflare/ai-chat/react`'s `useAgentChat` to the Vue Composition API and `@ai-sdk/vue`.

> `agents-vue` is a Vue 3 port of [`@cloudflare/ai-chat`](https://github.com/cloudflare/agents/tree/main/packages/ai-chat)'s `useAgentChat` React hook. The protocol, semantics, and most of the algorithmic structure come directly from the upstream React implementation. This package adapts it to the Vue Composition API and `@ai-sdk/vue`.

## Status

Covers the surface needed for a working chat UI — streaming responses, client-side tools, tool approvals, stream resumption, broadcast handling — at parity with upstream `@cloudflare/ai-chat` 0.9.x on resume/recovery: resume dedupe, `isRecovering`, `cancelOnClientAbort`, pre-stream `cf_agent_stream_pending`, and `connectionError`. Deeper upstream features (the `useAgent` connection hook, initial-message HTTP cache, `isServerStreaming` / `isStreaming` flags) are on the roadmap.

## Install

```bash
pnpm add agents-vue
```

Peer dependencies (must also be installed):

| Peer | Version |
|---|---|
| `vue` | `^3.3.4` |
| `@ai-sdk/vue` | `^3.0.0` |
| `ai` | `^6.0.0` |
| `agents` | `>=0.17.0 <1.0.0` |

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

Exported for advanced use cases. The composable wires this internally; you only need it directly if you're building a non-`@ai-sdk/vue` flow over the same `cf_agent_*` wire protocol.

```ts
import { WebSocketChatTransport, type WebSocketLike } from "agents-vue";

const transport = new WebSocketChatTransport({
  socket,        // any WebSocketLike
  prepareBody,   // optional
});
```

## Coverage vs upstream

`agents-vue@0.1` covers the surface real apps use. Wire protocol is identical to upstream — same `cf_agent_*` message shapes, same resumable streaming, same broadcast transitions, same tool continuation flow.

| Feature | Status |
|---|---|
| `useAgentChat` composable | ✅ |
| `WebSocketChatTransport` | ✅ |
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
| `useAgent` connection hook | 🚧 roadmap |
| Initial-message HTTP cache | 🚧 roadmap |
| `isServerStreaming` / `isStreaming` flags | 🚧 roadmap |

## Contributing

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test       # 79 tests in chromium (vitest-browser-vue)
pnpm typecheck
pnpm lint
pnpm build
```

Releases are driven by [`changelogen`](https://github.com/unjs/changelogen) with conventional commits.

## License

MIT — see [LICENSE](./LICENSE). Includes attribution to the original Cloudflare React implementation in [`@cloudflare/ai-chat`](https://github.com/cloudflare/agents/tree/main/packages/ai-chat).

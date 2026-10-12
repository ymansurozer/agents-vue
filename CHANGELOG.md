# Changelog


## v0.3.0

Rebased onto AI SDK v7 and `agents` 0.27, with upstream's own transport and the four client-side bugs the Vue port carried fixed against the React client.

### ⚠️ Breaking changes

- Peer dependencies: `ai ^7`, `@ai-sdk/vue ^4`, `agents >=0.27.0 <1`, `vue ^3.5`
- `WebSocketChatTransport` and `WebSocketLike` are no longer exported: the hand-rolled transport is deleted and the composable wires upstream's `WebSocketChatTransport` from `agents/chat/transport`. Import it from `agents` if you were using it directly.

### 🩹 Fixes

- Client-side tool calls are dispatched off the rendered transcript, deduped by tool-call id, rather than off the AI SDK's own callback alone. A call in a turn this client only observed — a resumed turn, a turn another tab started — used to render as a chip and never run.
- An early `cf_agent_stream_resuming` is either fed to the continuation this client armed or observed as the server's own turn, never both. Doing both delivered the same turn twice.
- The continuation is armed before the `cf_agent_tool_result` / `cf_agent_tool_approval` frame is sent, so the common case does not race at all.
- A streaming assistant tail that matches nothing in an incoming sync is dropped rather than appended, which is what put the same turn on screen twice.
- Message ids are minted with `crypto.randomUUID` and otherwise from `crypto.getRandomValues`, never `Math.random`.
- A continuation handed to the server is released when the socket carrying that turn is replaced: the reconnect probe runs for exactly that case, and a `cf_agent_stream_resume_none` settles the continuation it answers. Without it a dropped socket left the page unable to auto-continue after any later tool result.

### 🚀 Enhancements

- `onFrame` option: every socket frame, parsed, before the chat protocol reads it; return `true` to consume it. This is where an application's own frames belong.
- `mergeMessages` option: how a reconnect's read of the stored transcript joins the one on screen. Defaults to merge-by-id with the stored copy winning.
- `onStateUpdate` forwarded to the `AgentClient`, `setAgent()` exposed, `connectionState` derived from the socket's own open/close, `retryPendingResume()` on open, and an async `get-messages` seed with a re-read on a replacement socket.

## v0.2.1

[compare changes](https://github.com/ymansurozer/agents-vue/compare/v0.2.0...v0.2.1)

### 🩹 Fixes

- Serialize reconnect resume re-probes (parity with agents 0.17.2, #1837) ([#1837](https://github.com/ymansurozer/agents-vue/issues/1837))

### ❤️ Contributors

- Ymansurozer <ymansurozer@gmail.com>

## v0.2.0

[compare changes](https://github.com/ymansurozer/agents-vue/compare/v0.1.0...v0.2.0)

Brings the Vue port to parity with `@cloudflare/ai-chat` 0.9.x on resume/recovery.

### 🚀 Enhancements

- Resume dedupe: fallback-ACK a resume offer at most once per socket, preventing duplicated assistant text on a double resume replay (upstream 0.8.5)
- `isRecovering` reactive flag, driven by the `cf_agent_chat_recovering` frame and distinct from streaming (upstream 0.8.0)
- `cancelOnClientAbort` option: generic client aborts are local-only by default; explicit `stop()` always cancels the server turn — including resume-fallback-observed and transport-resumed turns (upstream 0.7.0)
- `cf_agent_stream_pending` handling: extend the resume probe 5s → 60s during the server's pre-stream window (upstream 0.9.0)
- `connectionError` surfaced from the `AgentClient` on terminal WebSocket close (upstream 0.9.0)

### 🏡 Chore

- Bump `agents` to 0.17.0 and raise the peer floor to `>=0.17.0` (first version exporting `connectionError` / `onConnectionError`)

### ❤️ Contributors

- Ymansurozer <ymansurozer@gmail.com>


## v0.1.0


### 🚀 Enhancements

- Initial scaffold ([c717193](https://github.com/ymansurozer/agents-vue/commit/c717193))

### 📖 Documentation

- Write README with usage, API, coverage table ([16461f2](https://github.com/ymansurozer/agents-vue/commit/16461f2))

### ❤️ Contributors

- Ymansurozer <ymansurozer@gmail.com>


# Changelog


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


# agents-vue

Vue 3 composable for [Cloudflare Agents](https://github.com/cloudflare/agents) — a port of `@cloudflare/ai-chat/react`'s `useAgentChat` hook to the Vue Composition API and `@ai-sdk/vue`.

> `agents-vue` is a Vue 3 port of [`@cloudflare/ai-chat`](https://github.com/cloudflare/agents/tree/main/packages/ai-chat)'s `useAgentChat` React hook. The protocol, semantics, and most of the algorithmic structure come directly from the upstream React implementation. This package adapts it to the Vue Composition API and `@ai-sdk/vue`.

## Status

v0.1 — early scaffold. The composable surface (`useAgentChat`, `WebSocketChatTransport`) lands in the first published release.

## Install

```bash
pnpm add agents-vue
```

Peer dependencies:

- `vue ^3.3.4`
- `@ai-sdk/vue ^3.0.0`
- `ai ^6.0.0`
- `agents >=0.11.0 <1.0.0`

## Usage

```ts
// Coming with v0.1.0 — see the changelog.
```

## SSR

`agents-vue` is **client-only**. The composable opens a WebSocket on construction and will throw on Node / SSR contexts. Wrap call sites in `<ClientOnly>` (Nuxt) or defer to `onMounted`.

## License

MIT — see [LICENSE](./LICENSE). Includes attribution to the original Cloudflare React implementation.

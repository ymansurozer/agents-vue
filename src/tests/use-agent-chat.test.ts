import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, h } from "vue";

import { MockSocket, tick } from "./test-utils";

// ── Mock setup ──────────────────────────────────────────────────
//
// `useAgentChat` calls `new AgentClient(...)` from `agents/client`. Replace it
// with a MockSocket subclass and keep a registry of constructed instances so
// individual tests can reach the latest one via `latestClient()`.

const registry = vi.hoisted(() => ({ instances: [] as MockClientLike[] }));

interface MockClientLike extends MockSocket {
  options: unknown;
}

vi.mock("agents/client", async () => {
  const utils = await import("./test-utils");
  return {
    AgentClient: class extends utils.MockSocket {
      options: unknown;
      constructor(options: unknown) {
        super();
        this.options = options;
        registry.instances.push(this);
      }
    },
  };
});

import { useAgentChat, type UseAgentChatOptions } from "../use-agent-chat";
import { WebSocketChatTransport } from "../web-socket-chat-transport";

function latestClient(): MockClientLike {
  const last = registry.instances.at(-1);
  if (!last) throw new Error("No mock AgentClient was constructed");
  return last;
}

interface MountedChat {
  chat: ReturnType<typeof useAgentChat>;
  client: MockClientLike;
  unmount: () => void;
}

function mountChat(options: Partial<UseAgentChatOptions> = {}): MountedChat {
  let captured!: ReturnType<typeof useAgentChat>;
  const screen = render(
    defineComponent({
      setup() {
        captured = useAgentChat({
          client: { agent: "test-agent", host: "localhost:9999", name: "test" },
          ...options,
        });
        return () => h("div");
      },
    }),
  );
  return {
    chat: captured,
    client: latestClient(),
    unmount: () => screen.unmount(),
  };
}

const userMessage = (text: string, id = "u1"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistantMessage = (text: string, id = "a1"): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

beforeEach(() => {
  registry.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── clearHistory ────────────────────────────────────────────────

describe("useAgentChat — clearHistory", () => {
  it("clears local state and sends cf_agent_chat_clear", async () => {
    const { chat, client, unmount } = mountChat({
      initialMessages: [userMessage("hi"), assistantMessage("hello")],
    });

    expect(chat.chat.messages).toHaveLength(2);

    chat.clearHistory();
    await tick();

    expect(chat.chat.messages).toEqual([]);
    expect(client.lastSentOfType("cf_agent_chat_clear")).toBeDefined();
    unmount();
  });
});

// ── autoContinueAfterToolResult ─────────────────────────────────

describe("useAgentChat — autoContinueAfterToolResult", () => {
  // The AI SDK's `addToolOutput` updates an existing tool part. Seed one.
  function seededWithToolCall(toolCallId = "tc-1", toolName = "weather"): UIMessage[] {
    return [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId,
            state: "input-available",
            input: {},
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
  }

  it("defaults to true and sends autoContinue: true with tool results", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: seededWithToolCall() });

    await chat.addToolOutput({ tool: "weather", toolCallId: "tc-1", output: { temp: 70 } });

    const result = client.lastSentOfType<{ autoContinue: boolean; toolName: string; toolCallId: string }>(
      "cf_agent_tool_result",
    );
    expect(result?.autoContinue).toBe(true);
    expect(result?.toolName).toBe("weather");
    expect(result?.toolCallId).toBe("tc-1");
    unmount();
  });

  it("sends autoContinue: false when explicitly disabled", async () => {
    const { chat, client, unmount } = mountChat({
      initialMessages: seededWithToolCall(),
      autoContinueAfterToolResult: false,
    });

    await chat.addToolOutput({ tool: "weather", toolCallId: "tc-1", output: { temp: 70 } });

    const result = client.lastSentOfType<{ autoContinue: boolean }>("cf_agent_tool_result");
    expect(result?.autoContinue).toBe(false);
    unmount();
  });

  it("forces autoContinue: false for output-error regardless of default", async () => {
    const { chat, client, unmount } = mountChat({
      initialMessages: seededWithToolCall(),
      autoContinueAfterToolResult: true,
    });

    await chat.addToolOutput({
      tool: "weather",
      toolCallId: "tc-1",
      state: "output-error",
      errorText: "API down",
    });

    const result = client.lastSentOfType<{ autoContinue: boolean; state?: string; errorText?: string }>(
      "cf_agent_tool_result",
    );
    expect(result?.autoContinue).toBe(false);
    expect(result?.state).toBe("output-error");
    expect(result?.errorText).toBe("API down");
    unmount();
  });
});

// ── addToolApprovalResponse ─────────────────────────────────────

describe("useAgentChat — addToolApprovalResponse", () => {
  it("sends cf_agent_tool_approval with autoContinue from the option default (true)", async () => {
    const approvalId = "ap-1";
    const toolCallId = "tc-approve-1";
    const messages: UIMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-approve",
            toolCallId,
            // approval bag the composable looks at to map approvalId → toolCallId
            approval: { id: approvalId, kind: "approve" },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
    const { chat, client, unmount } = mountChat({ initialMessages: messages });

    await chat.addToolApprovalResponse({ id: approvalId, approved: true });

    const sent = client.lastSentOfType<{ toolCallId: string; approved: boolean; autoContinue: boolean }>(
      "cf_agent_tool_approval",
    );
    expect(sent?.toolCallId).toBe(toolCallId);
    expect(sent?.approved).toBe(true);
    expect(sent?.autoContinue).toBe(true);
    unmount();
  });

  it("sends autoContinue: false when option is disabled", async () => {
    const approvalId = "ap-2";
    const messages: UIMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-approve",
            toolCallId: "tc-approve-2",
            approval: { id: approvalId, kind: "approve" },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
    const { chat, client, unmount } = mountChat({
      initialMessages: messages,
      autoContinueAfterToolResult: false,
    });

    await chat.addToolApprovalResponse({ id: approvalId, approved: true });

    const sent = client.lastSentOfType<{ autoContinue: boolean }>("cf_agent_tool_approval");
    expect(sent?.autoContinue).toBe(false);
    unmount();
  });

  it("warns and skips both the protocol message and the SDK update when no tool call matches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chat, client, unmount } = mountChat();

    // No throw — composable bails before calling the AI SDK.
    await chat.addToolApprovalResponse({ id: "missing-id", approved: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing-id"));
    expect(client.lastSentOfType("cf_agent_tool_approval")).toBeUndefined();
    warn.mockRestore();
    unmount();
  });
});

// ── body option ─────────────────────────────────────────────────

describe("useAgentChat — body option", () => {
  // sendMessage hangs until the response stream closes. We don't emit a
  // response; we just want to verify the outbound request payload. So:
  // (1) kick it off without awaiting, (2) tick a few times for the
  // transport to flush, (3) assert on the captured request, (4) finish
  // with `done: true` so sendMessage resolves before unmount.
  async function flushRequest(client: MockClientLike): Promise<{ id: string; init: { body: string } }> {
    for (let i = 0; i < 5; i++) {
      const req = client.lastSentOfType<{ id: string; init: { body: string } }>("cf_agent_use_chat_request");
      if (req) return req;
      await tick();
    }
    throw new Error("cf_agent_use_chat_request was not sent within 5 ticks");
  }

  it("includes a static object in the outbound request body", async () => {
    const { chat, client, unmount } = mountChat({ body: { tenant: "acme" }, onError: () => {} });

    void chat.chat.sendMessage({ text: "hi" });
    const req = await flushRequest(client);

    const parsed = JSON.parse(req.init.body) as Record<string, unknown>;
    expect(parsed.tenant).toBe("acme");
    unmount();
  });

  it("invokes a sync function body per-request", async () => {
    const fn = vi.fn(() => ({ requestId: "abc" }));
    const { chat, client, unmount } = mountChat({ body: fn, onError: () => {} });

    void chat.chat.sendMessage({ text: "hi" });
    const req = await flushRequest(client);

    expect(fn).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(req.init.body) as Record<string, unknown>;
    expect(parsed.requestId).toBe("abc");
    unmount();
  });

  it("awaits an async function body per-request", async () => {
    const { chat, client, unmount } = mountChat({
      body: async () => ({ token: "deferred" }),
      onError: () => {},
    });

    void chat.chat.sendMessage({ text: "hi" });
    const req = await flushRequest(client);

    const parsed = JSON.parse(req.init.body) as Record<string, unknown>;
    expect(parsed.token).toBe("deferred");
    unmount();
  });

  it("auto-extracts client tool schemas alongside the body", async () => {
    const { chat, client, unmount } = mountChat({
      body: { tenant: "acme" },
      tools: {
        echo: {
          description: "echo",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: (input) => input,
        },
      },
      onError: () => {},
    });

    void chat.chat.sendMessage({ text: "hi" });
    const req = await flushRequest(client);

    const parsed = JSON.parse(req.init.body) as { clientTools?: { name: string }[]; tenant: string };
    expect(parsed.tenant).toBe("acme");
    expect(parsed.clientTools).toEqual([
      {
        name: "echo",
        description: "echo",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);
    unmount();
  });
});

// ── inbound message handling ────────────────────────────────────

describe("useAgentChat — inbound message handling", () => {
  it("cf_agent_chat_messages replaces local state when idle", async () => {
    const { chat, client, unmount } = mountChat();

    const incoming: UIMessage[] = [userMessage("hi", "u1"), assistantMessage("hello", "a1")];
    client.emitMessage({ type: "cf_agent_chat_messages", messages: incoming });

    expect(chat.chat.messages).toEqual(incoming);
    unmount();
  });

  it("cf_agent_message_updated replaces a message by id", async () => {
    const original: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "old" }],
    };
    const { chat, client, unmount } = mountChat({ initialMessages: [original] });

    const updated: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "new" }],
    };
    client.emitMessage({ type: "cf_agent_message_updated", message: updated });

    expect(chat.chat.messages[0]?.parts).toEqual([{ type: "text", text: "new" }]);
    unmount();
  });

  it("cf_agent_message_updated replaces by toolCallId when id does not match", async () => {
    const original: UIMessage = {
      id: "local-1",
      role: "assistant",
      parts: [
        {
          type: "tool-fetch",
          toolCallId: "tc-77",
          state: "input-available",
          input: {},
        } as unknown as UIMessage["parts"][number],
      ],
    };
    const { chat, client, unmount } = mountChat({ initialMessages: [original] });

    const updated: UIMessage = {
      id: "server-1",
      role: "assistant",
      parts: [
        {
          type: "tool-fetch",
          toolCallId: "tc-77",
          state: "output-available",
          input: {},
          output: { ok: true },
        } as unknown as UIMessage["parts"][number],
      ],
    };
    client.emitMessage({ type: "cf_agent_message_updated", message: updated });

    // Existing id is preserved; parts are replaced.
    expect(chat.chat.messages[0]?.id).toBe("local-1");
    expect((chat.chat.messages[0]?.parts[0] as { state: string }).state).toBe("output-available");
    unmount();
  });

  it("cf_agent_chat_clear clears local state", async () => {
    const { chat, client, unmount } = mountChat({
      initialMessages: [userMessage("hi"), assistantMessage("hello")],
    });

    expect(chat.chat.messages).toHaveLength(2);
    client.emitMessage({ type: "cf_agent_chat_clear" });
    expect(chat.chat.messages).toEqual([]);
    unmount();
  });
});

// ── socket lifecycle ────────────────────────────────────────────

describe("useAgentChat — socket lifecycle", () => {
  it("forwards onOpen before triggering resume", async () => {
    const onOpen = vi.fn();
    const { client, unmount } = mountChat({ onOpen });

    client.emit("open", new Event("open"));
    await tick();

    expect(onOpen).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not auto-resume when resume: false", async () => {
    const onOpen = vi.fn();
    const { client, unmount } = mountChat({ onOpen, resume: false });

    client.emit("open", new Event("open"));
    await tick();
    await tick();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeUndefined();
    unmount();
  });

  it("forwards onSocketError for connection errors", async () => {
    const onSocketError = vi.fn();
    const { client, unmount } = mountChat({ onSocketError });

    const event = new Event("error");
    client.emit("error", event);
    expect(onSocketError).toHaveBeenCalledWith(event);
    unmount();
  });

  it("closes the socket on scope dispose", async () => {
    const { client, unmount } = mountChat();
    expect(client.closed).toBe(false);
    unmount();
    await tick();
    expect(client.closed).toBe(true);
  });
});

// ── stop + tool continuation interaction ────────────────────────

describe("useAgentChat — stop / continuation", () => {
  // The AI SDK's `addToolOutput` updates an existing tool part on a message.
  // Without one, it errors. Seed an assistant message with a tool part so
  // the SDK has something to update.
  function seededWithToolCall(toolCallId = "tc-1"): UIMessage[] {
    return [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-echo",
            toolCallId,
            state: "input-available",
            input: { x: 1 },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
  }

  it("addToolOutput auto-continue triggers a stream resume request", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: seededWithToolCall() });

    await chat.addToolOutput({ tool: "echo", toolCallId: "tc-1", output: "hi" });
    // chat.resumeStream is async; flush microtasks
    await tick();
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeDefined();
    unmount();
  });

  it("output-error skips auto-continue (no resume request)", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: seededWithToolCall() });

    await chat.addToolOutput({
      tool: "echo",
      toolCallId: "tc-1",
      state: "output-error",
      errorText: "boom",
    });
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeUndefined();
    unmount();
  });

  it("autoContinueAfterToolResult: false skips auto-continue", async () => {
    const { chat, client, unmount } = mountChat({
      initialMessages: seededWithToolCall(),
      autoContinueAfterToolResult: false,
    });

    await chat.addToolOutput({ tool: "echo", toolCallId: "tc-1", output: "hi" });
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeUndefined();
    unmount();
  });

  it("stop() during an active tool continuation completes without throwing", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: seededWithToolCall() });

    await chat.addToolOutput({ tool: "echo", toolCallId: "tc-1", output: "hi" });
    await tick();
    await tick();
    await tick();
    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeDefined();

    await expect(chat.stop()).resolves.toBeUndefined();
    unmount();
  });
});

// ── tool approval continuation ──────────────────────────────────

describe("useAgentChat — tool approval continuation", () => {
  function seededWithApprovalPart(approvalId: string, toolCallId = "tc-approve"): UIMessage[] {
    return [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-approve",
            toolCallId,
            approval: { id: approvalId, kind: "approve" },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
  }

  it("addToolApprovalResponse triggers a stream resume request after the approval", async () => {
    const approvalId = "ap-1";
    const { chat, client, unmount } = mountChat({
      initialMessages: seededWithApprovalPart(approvalId),
    });

    await chat.addToolApprovalResponse({ id: approvalId, approved: true });
    await tick();
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_tool_approval")).toBeDefined();
    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeDefined();
    unmount();
  });

  it("does not trigger a continuation when the approval id has no matching tool call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chat, client, unmount } = mountChat();

    await chat.addToolApprovalResponse({ id: "missing", approved: true });
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_stream_resume_request")).toBeUndefined();
    warn.mockRestore();
    unmount();
  });
});

// ── stream resume handshake forwarding ──────────────────────────

describe("useAgentChat — stream resume handshake forwarding", () => {
  async function waitForResumeRequest(client: MockClientLike): Promise<void> {
    for (let i = 0; i < 8; i++) {
      if (client.lastSentOfType("cf_agent_stream_resume_request")) return;
      await tick();
    }
    throw new Error("cf_agent_stream_resume_request was not sent within 8 ticks");
  }

  it("cf_agent_stream_resuming with a pending transport resume sends the ack", async () => {
    const { client, unmount } = mountChat({ onError: () => {} });

    // Default `resume: true` → on socket open the chat triggers transport resume.
    client.emit("open", new Event("open"));
    await waitForResumeRequest(client);

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-99" });

    const ack = client.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack");
    expect(ack?.id).toBe("stream-99");
    unmount();
  });

  it("cf_agent_stream_resume_none with a pending transport resume completes without an ack", async () => {
    const { client, unmount } = mountChat({ onError: () => {} });

    client.emit("open", new Event("open"));
    await waitForResumeRequest(client);

    client.emitMessage({ type: "cf_agent_stream_resume_none" });
    await tick();
    await tick();

    expect(client.lastSentOfType("cf_agent_stream_resume_ack")).toBeUndefined();
    unmount();
  });
});

// ── server-initiated stream (broadcast / resume-fallback) ───────

describe("useAgentChat — server-initiated stream", () => {
  function emitTextStream(
    client: MockClientLike,
    streamId: string,
    text: string,
    opts: { partId?: string; done?: boolean } = {},
  ): void {
    const partId = opts.partId ?? "p1";
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: streamId,
      body: JSON.stringify({ type: "text-start", id: partId }),
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: streamId,
      body: JSON.stringify({ type: "text-delta", id: partId, delta: text }),
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: streamId,
      body: JSON.stringify({ type: "text-end", id: partId }),
    });
    if (opts.done !== false) {
      client.emitMessage({ type: "cf_agent_use_chat_response", id: streamId, done: true });
    }
  }

  it("cf_agent_stream_resuming for an unknown id acks via the broadcast path", () => {
    const { client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-99" });

    const ack = client.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack");
    expect(ack?.id).toBe("stream-99");
    unmount();
  });

  it("processes server-broadcast text chunks into chat.messages", () => {
    const { chat, client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-99" });
    emitTextStream(client, "stream-99", "Hi there");

    expect(chat.chat.messages.length).toBeGreaterThanOrEqual(1);
    const last = chat.chat.messages.at(-1);
    expect(last?.role).toBe("assistant");
    unmount();
  });

  it("preserveActiveStreamMessages keeps an active streaming assistant on broadcast", () => {
    const tail = assistantMessage("streaming…", "a-active");
    const { chat, client, unmount } = mountChat({
      initialMessages: [userMessage("hi", "u1"), tail],
    });

    // Put streamState non-idle by announcing a new server stream.
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-99" });

    // Broadcast arrives but doesn't include the active assistant.
    client.emitMessage({
      type: "cf_agent_chat_messages",
      messages: [userMessage("hi", "u1")],
    });

    // The streaming assistant should be preserved at the tail.
    expect(chat.chat.messages.at(-1)?.id).toBe("a-active");
    unmount();
  });

  it("clearHistory mid-broadcast resets active-stream protection", () => {
    const { chat, client, unmount } = mountChat();

    // Enter active broadcast state.
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-99" });

    // clearHistory resets streamState back to idle.
    chat.clearHistory();

    // Subsequent broadcast replaces local state cleanly (no preservation logic).
    client.emitMessage({
      type: "cf_agent_chat_messages",
      messages: [userMessage("after-clear", "u-new")],
    });

    expect(chat.chat.messages).toHaveLength(1);
    expect(chat.chat.messages[0]?.id).toBe("u-new");
    unmount();
  });

  it("done: true on an orphaned server stream does not throw", () => {
    const { client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-orphan" });
    expect(() =>
      client.emitMessage({ type: "cf_agent_use_chat_response", id: "stream-orphan", done: true }),
    ).not.toThrow();
    unmount();
  });

  it("live chunks continue updating chat.messages after replayComplete", () => {
    const { chat, client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "stream-r" });

    // Replay phase
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "stream-r",
      body: JSON.stringify({ type: "text-start", id: "p1" }),
      replay: true,
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "stream-r",
      body: JSON.stringify({ type: "text-delta", id: "p1", delta: "replayed" }),
      replay: true,
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "stream-r",
      replayComplete: true,
    });
    const lengthAfterReplay = chat.chat.messages.length;

    // Live phase: a follow-up delta should still land.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "stream-r",
      body: JSON.stringify({ type: "text-delta", id: "p1", delta: "+live" }),
    });
    client.emitMessage({ type: "cf_agent_use_chat_response", id: "stream-r", done: true });

    expect(chat.chat.messages.length).toBe(lengthAfterReplay);
    expect(chat.chat.messages.at(-1)?.role).toBe("assistant");
    unmount();
  });
});

// ── client-stream interaction ───────────────────────────────────

describe("useAgentChat — client-stream interaction", () => {
  async function waitForChatRequest(client: MockClientLike): Promise<{ id: string }> {
    for (let i = 0; i < 8; i++) {
      const req = client.lastSentOfType<{ id: string }>("cf_agent_use_chat_request");
      if (req) return req;
      await tick();
    }
    throw new Error("cf_agent_use_chat_request was not sent within 8 ticks");
  }

  it("preserveActiveStreamMessages keeps the streaming assistant when a server broadcast arrives mid-stream", async () => {
    const { chat, client, unmount } = mountChat({ onError: () => {} });

    void chat.chat.sendMessage({ text: "hi" });
    const req = await waitForChatRequest(client);

    // Begin streaming an assistant response.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: req.id,
      body: JSON.stringify({ type: "text-start", id: "p1" }),
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: req.id,
      body: JSON.stringify({ type: "text-delta", id: "p1", delta: "streaming" }),
    });
    await tick();

    const lengthBeforeBroadcast = chat.chat.messages.length;

    // Server broadcast arrives mid-stream with only the user message.
    client.emitMessage({
      type: "cf_agent_chat_messages",
      messages: [userMessage("hi", "u1")],
    });

    // The assistant message in flight should not be lost — preserveActiveStreamMessages
    // keeps it appended. Length should be at least what we had before (user + streaming
    // assistant), not collapsed back to just the broadcast.
    expect(chat.chat.messages.length).toBeGreaterThanOrEqual(lengthBeforeBroadcast);
    expect(chat.chat.messages.at(-1)?.role).toBe("assistant");

    unmount();
  });

  it("onToolCall fires when a tool input-available chunk lands on a client stream", async () => {
    const calls: { toolCallId: string; toolName: string }[] = [];
    const { chat, client, unmount } = mountChat({
      onToolCall: ({ toolCall }) => {
        calls.push({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName });
      },
      onError: () => {},
    });

    void chat.chat.sendMessage({ text: "use tool" });
    const req = await waitForChatRequest(client);

    // Emit a tool-input-available chunk through the client stream.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: req.id,
      body: JSON.stringify({
        type: "tool-input-available",
        toolCallId: "tc-fire",
        toolName: "echo",
        input: { x: 1 },
      }),
    });
    // Drain microtasks for Chat to dispatch onToolCall.
    for (let i = 0; i < 8; i++) {
      if (calls.length > 0) break;
      await tick();
    }

    expect(calls).toEqual([{ toolCallId: "tc-fire", toolName: "echo" }]);
    unmount();
  });
});

// ── stream resumption — partial hydration rebuild ───────────────

describe("useAgentChat — stream resumption / partial hydration", () => {
  it("rebuilds a partially hydrated assistant during resume instead of adding a second text part", async () => {
    const initialMessages: UIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "tell me a long story" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Once upon" }] },
    ];
    const { chat, client, unmount } = mountChat({ initialMessages });

    expect(chat.chat.messages).toHaveLength(2);

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "req-partial" });
    // The hydrated assistant must remain visible until a matching replay start arrives.
    expect(chat.chat.messages).toHaveLength(2);

    // Replay phase — a `start` chunk pinning to the existing assistant id, then
    // text-start / text-delta / replayComplete. broadcastTransition should
    // merge into assistant-1, not create a duplicate.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-partial",
      body: JSON.stringify({ type: "start", messageId: "assistant-1" }),
      replay: true,
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-partial",
      body: JSON.stringify({ type: "text-start", id: "t1" }),
      replay: true,
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-partial",
      body: JSON.stringify({ type: "text-delta", id: "t1", delta: "Once upon" }),
      replay: true,
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-partial",
      body: "",
      replay: true,
      replayComplete: true,
    });
    await tick();

    expect(chat.chat.messages).toHaveLength(2);
    const assistant = chat.chat.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const textParts = assistant!.parts.filter((p) => p.type === "text") as { text: string }[];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]!.text).toBe("Once upon");

    // Live delta after replayComplete continues into the same part.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-partial",
      body: JSON.stringify({ type: "text-delta", id: "t1", delta: " a time" }),
    });
    await tick();

    const assistantAfter = chat.chat.messages.find((m) => m.role === "assistant")!;
    const textPartsAfter = assistantAfter.parts.filter((p) => p.type === "text") as { text: string }[];
    expect(textPartsAfter).toHaveLength(1);
    expect(textPartsAfter[0]!.text).toBe("Once upon a time");

    unmount();
  });
});

// ── tool approval continuations (broadcast id remap) ────────────

describe("useAgentChat — tool approval continuations", () => {
  function approvalRespondedMessages(): UIMessage[] {
    return [
      {
        id: "assistant-local",
        role: "assistant",
        parts: [
          {
            type: "tool-dangerousAction",
            toolCallId: "tc-approval-1",
            state: "approval-responded",
            input: { action: "delete" },
            approval: { id: "approval-req-1", approved: true },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];
  }

  it("keeps the existing assistant id for continuation start chunks", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: approvalRespondedMessages() });

    expect(chat.chat.messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    // Continuation start with a *different* messageId. The composable passes
    // `currentMessages` to broadcastTransition for continuation chunks, which
    // should merge into the existing local assistant rather than spawn a new one.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-continuation-start",
      continuation: true,
      body: JSON.stringify({ type: "start", messageId: "assistant-stream" }),
    });
    await tick();

    const assistants = chat.chat.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.id).toBe("assistant-local");

    const toolParts = assistants[0]!.parts.filter(
      (p) => "toolCallId" in p && (p as { toolCallId: string }).toolCallId === "tc-approval-1",
    );
    expect(toolParts).toHaveLength(1);
    unmount();
  });

  it("keeps merging continuations when broadcasts replace assistant ids mid-stream", async () => {
    const { chat, client, unmount } = mountChat({ initialMessages: approvalRespondedMessages() });

    // Continuation start + text-start with one streamId.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-continuation-remap",
      continuation: true,
      body: JSON.stringify({ type: "start", messageId: "assistant-stream" }),
    });
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-continuation-remap",
      continuation: true,
      body: JSON.stringify({ type: "text-start", id: "text-1" }),
    });
    await tick();

    // Server broadcast replaces the assistant id mid-stream.
    client.emitMessage({
      type: "cf_agent_chat_messages",
      messages: [
        {
          id: "assistant-server",
          role: "assistant",
          parts: [
            {
              type: "tool-dangerousAction",
              toolCallId: "tc-approval-1",
              state: "approval-responded",
              input: { action: "delete" },
              approval: { id: "approval-req-1", approved: true },
            } as unknown as UIMessage["parts"][number],
          ],
        },
      ],
    });

    // Continuation delta arrives after the broadcast.
    client.emitMessage({
      type: "cf_agent_use_chat_response",
      id: "req-continuation-remap",
      continuation: true,
      body: JSON.stringify({ type: "text-delta", id: "text-1", delta: "done" }),
    });
    await tick();

    const assistants = chat.chat.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.id).toBe("assistant-server");

    const toolParts = assistants[0]!.parts.filter(
      (p) => "toolCallId" in p && (p as { toolCallId: string }).toolCallId === "tc-approval-1",
    );
    expect(toolParts).toHaveLength(1);

    const textPart = assistants[0]!.parts.find((p) => p.type === "text") as { text?: string } | undefined;
    expect(textPart?.text).toBe("done");
    unmount();
  });
});

// ── resume fallback dedupe (0.8.5) ──────────────────────────────

describe("useAgentChat — resume fallback dedupe", () => {
  it("fallback-acks a repeated resuming offer for the same id at most once per socket", () => {
    const { client, unmount } = mountChat();

    // Server announces the same resume offer twice (onConnect + resume-request handler).
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "dup-1" });
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "dup-1" });

    const acks = client
      .sent<{ type: string; id: string }>()
      .filter((m) => m.type === "cf_agent_stream_resume_ack" && m.id === "dup-1");
    expect(acks).toHaveLength(1);
    unmount();
  });

  it("acks again after the socket closes — a new connection needs a fresh replay", () => {
    const { client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "dup-2" });
    client.emit("close", new CloseEvent("close"));
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "dup-2" });

    const acks = client
      .sent<{ type: string; id: string }>()
      .filter((m) => m.type === "cf_agent_stream_resume_ack" && m.id === "dup-2");
    expect(acks).toHaveLength(2);
    unmount();
  });
});

// ── isRecovering (0.8.0) ────────────────────────────────────────

describe("useAgentChat — isRecovering", () => {
  it("sets isRecovering from cf_agent_chat_recovering and is NOT cleared by a message sync", () => {
    const { chat, client, unmount } = mountChat();
    expect(chat.isRecovering.value).toBe(false);

    client.emitMessage({ type: "cf_agent_chat_recovering", recovering: true });
    expect(chat.isRecovering.value).toBe(true);

    // A connect-time full-message sync must NOT clear the recovery hint — otherwise the
    // 0.9.0 replay-on-connect indicator would vanish the moment messages sync.
    client.emitMessage({ type: "cf_agent_chat_messages", messages: [userMessage("hi")] });
    expect(chat.isRecovering.value).toBe(true);

    client.emitMessage({ type: "cf_agent_chat_recovering", recovering: false });
    expect(chat.isRecovering.value).toBe(false);
    unmount();
  });

  it("clears isRecovering when a recovered turn starts streaming (resume ack)", () => {
    const { chat, client, unmount } = mountChat();
    client.emitMessage({ type: "cf_agent_chat_recovering", recovering: true });
    expect(chat.isRecovering.value).toBe(true);

    client.emitMessage({ type: "cf_agent_stream_resuming", id: "rec-stream" });
    expect(chat.isRecovering.value).toBe(false);
    unmount();
  });

  it("clears isRecovering on chat clear", () => {
    const { chat, client, unmount } = mountChat();
    client.emitMessage({ type: "cf_agent_chat_recovering", recovering: true });
    client.emitMessage({ type: "cf_agent_chat_clear" });
    expect(chat.isRecovering.value).toBe(false);
    unmount();
  });
});

// ── connectionError (0.9.0) ─────────────────────────────────────

describe("useAgentChat — connectionError", () => {
  it("surfaces a terminal connection error and clears it on reconnect", async () => {
    const { chat, client, unmount } = mountChat();
    expect(chat.connectionError.value).toBeNull();

    // AgentClient invokes onConnectionError on a terminal close; the hook composes one
    // into the client options to mirror it into the reactive ref.
    const opts = client.options as { onConnectionError?: (e: unknown) => void };
    const err = new Error("terminal");
    opts.onConnectionError?.(err);
    expect(chat.connectionError.value).toBe(err);

    client.emit("open", new Event("open"));
    await tick();
    expect(chat.connectionError.value).toBeNull();
    unmount();
  });
});

// ── stop cancels the server turn (0.7.0 explicit-cancel semantics) ──

describe("useAgentChat — stop cancels the server turn", () => {
  it("explicit stop() cancels an observed (resume-fallback) server turn", async () => {
    const { chat, client, unmount } = mountChat();

    // A broadcast/fallback resuming makes the turn observable + cancellable.
    client.emitMessage({ type: "cf_agent_stream_resuming", id: "obs-turn" });
    expect(client.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack")?.id).toBe("obs-turn");

    await chat.stop();

    expect(client.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe("obs-turn");
    unmount();
  });
});

// ── stream-pending forwarding (0.9.0) ───────────────────────────

describe("useAgentChat — stream pending forwarding", () => {
  it("forwards cf_agent_stream_pending to the transport", () => {
    const spy = vi.spyOn(WebSocketChatTransport.prototype, "handleStreamPending");
    const { client, unmount } = mountChat();

    client.emitMessage({ type: "cf_agent_stream_pending" });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    unmount();
  });
});

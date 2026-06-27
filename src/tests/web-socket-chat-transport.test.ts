import type { UIMessage, UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebSocketChatTransport } from "../web-socket-chat-transport";
import { drainStream, MockSocket, readUntil, tick } from "./test-utils";

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

const sendMessagesArgs = (messages: UIMessage[], extra: Record<string, unknown> = {}) => ({
  trigger: "submit-message" as const,
  chatId: "chat-1",
  messageId: undefined,
  messages,
  abortSignal: undefined,
  ...extra,
});

describe("WebSocketChatTransport", () => {
  let socket: MockSocket;
  let transport: WebSocketChatTransport;

  beforeEach(() => {
    socket = new MockSocket();
    transport = new WebSocketChatTransport({ socket });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── sendMessages ────────────────────────────────────────────────

  describe("sendMessages", () => {
    it("emits cf_agent_use_chat_request with init.method = POST and a JSON body", async () => {
      await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));

      const req = socket.lastSentOfType<{ id: string; type: string; init: { method: string; body: string } }>(
        "cf_agent_use_chat_request",
      );
      expect(req).toBeDefined();
      expect(req!.init.method).toBe("POST");
      expect(typeof req!.id).toBe("string");
      const parsedBody = JSON.parse(req!.init.body) as {
        messages: UIMessage[];
        trigger: string;
      };
      expect(parsedBody.trigger).toBe("submit-message");
      expect(parsedBody.messages).toHaveLength(1);
      expect(parsedBody.messages[0]!.id).toBe("u1");
    });

    it("ships only the tail message in the body payload", async () => {
      await transport.sendMessages(
        sendMessagesArgs([userMessage("first", "u1"), assistantMessage("..."), userMessage("second", "u2")]),
      );

      const req = socket.lastSentOfType<{ init: { body: string } }>("cf_agent_use_chat_request")!;
      const parsedBody = JSON.parse(req.init.body) as { messages: UIMessage[] };
      expect(parsedBody.messages).toHaveLength(1);
      expect(parsedBody.messages[0]!.id).toBe("u2");
    });

    it("merges prepareBody output and per-request body into the payload", async () => {
      transport = new WebSocketChatTransport({
        socket,
        prepareBody: () => ({ tenant: "acme", clientTools: [{ name: "echo" }] }),
      });

      await transport.sendMessages(sendMessagesArgs([userMessage("hi")], { body: { lang: "en" } }));

      const req = socket.lastSentOfType<{ init: { body: string } }>("cf_agent_use_chat_request")!;
      const parsedBody = JSON.parse(req.init.body) as Record<string, unknown>;
      expect(parsedBody.tenant).toBe("acme");
      expect(parsedBody.clientTools).toEqual([{ name: "echo" }]);
      expect(parsedBody.lang).toBe("en");
    });

    it("enqueues chunks from cf_agent_use_chat_response", async () => {
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const chunk: UIMessageChunk = { type: "text-delta", id: "p1", delta: "hello" };

      const drainPromise = drainStream(stream);
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: req.id, body: JSON.stringify(chunk) });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: req.id, done: true });

      const { chunks, error } = await drainPromise;
      expect(error).toBeUndefined();
      expect(chunks).toEqual([chunk]);
    });

    it("ignores responses with mismatched request id", async () => {
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const chunk: UIMessageChunk = { type: "text-delta", id: "p1", delta: "hello" };

      const drainPromise = drainStream(stream);
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "other", body: JSON.stringify(chunk) });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: req.id, done: true });

      const { chunks } = await drainPromise;
      expect(chunks).toEqual([]);
    });

    it("ignores non-chat-response messages", async () => {
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const drainPromise = drainStream(stream);
      socket.emitMessage({ type: "cf_agent_chat_messages", messages: [] });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: req.id, done: true });

      const { chunks } = await drainPromise;
      expect(chunks).toEqual([]);
    });

    it("errors the stream on error: true", async () => {
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const drainPromise = drainStream(stream);
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: req.id, error: true, body: "boom" });

      const { error } = await drainPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("boom");
    });

    it("errors the stream locally on a generic abort without cancelling the server turn (default)", async () => {
      const ac = new AbortController();
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")], { abortSignal: ac.signal }));

      const drainPromise = drainStream(stream);
      ac.abort();

      const { error } = await drainPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      // Local-only by default (0.7.0): the server turn keeps running, so no cancel frame.
      expect(socket.lastSentOfType("cf_agent_chat_request_cancel")).toBeUndefined();
    });

    it("sends cf_agent_chat_request_cancel on a generic abort when cancelOnClientAbort is true", async () => {
      transport = new WebSocketChatTransport({ socket, cancelOnClientAbort: true });
      const ac = new AbortController();
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")], { abortSignal: ac.signal }));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const drainPromise = drainStream(stream);
      ac.abort();

      const { error } = await drainPromise;
      expect((error as Error).name).toBe("AbortError");
      const cancel = socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel");
      expect(cancel?.id).toBe(req.id);
    });
  });

  // ── server-turn cancellation (explicit vs generic) ──────────────

  describe("cancelActiveServerTurn", () => {
    it("cancels the active locally-initiated turn even with cancelOnClientAbort false (default)", async () => {
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")]));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const drainPromise = drainStream(stream);
      expect(transport.cancelActiveServerTurn()).toBe(true);

      const { error } = await drainPromise;
      expect((error as Error).name).toBe("AbortError");
      const cancel = socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel");
      expect(cancel?.id).toBe(req.id);
    });

    it("cancels a server-observed (broadcast/fallback) turn registered via observeServerTurn", () => {
      transport.observeServerTurn("obs-1");
      expect(transport.cancelActiveServerTurn()).toBe(true);
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe("obs-1");
    });

    it("does nothing after handleServerTurnCompleted clears the observed turn", () => {
      transport.observeServerTurn("obs-1");
      transport.handleServerTurnCompleted("obs-1");
      expect(transport.cancelActiveServerTurn()).toBe(false);
      expect(socket.lastSentOfType("cf_agent_chat_request_cancel")).toBeUndefined();
    });

    it("keeps a sent turn cancellable after a local-only abort (default)", async () => {
      const ac = new AbortController();
      const stream = await transport.sendMessages(sendMessagesArgs([userMessage("hi")], { abortSignal: ac.signal }));
      const req = socket.lastSentOfType<{ id: string }>("cf_agent_use_chat_request")!;

      const drainPromise = drainStream(stream);
      ac.abort(); // local-only: errors the local stream, no cancel frame, turn stays tracked
      await drainPromise;
      expect(socket.lastSentOfType("cf_agent_chat_request_cancel")).toBeUndefined();

      // The still-running server turn can be cancelled explicitly afterward.
      expect(transport.cancelActiveServerTurn()).toBe(true);
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe(req.id);
    });

    it("cancels a transport-resumed turn (page-reload resume)", async () => {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "resumed-1" });
      await promise;

      expect(transport.cancelActiveServerTurn()).toBe(true);
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe("resumed-1");
    });
  });

  // ── cancelOnClientAbort on attached streams (resume / tool continuation) ──

  describe("cancelOnClientAbort on attached streams", () => {
    it("a resumed stream sends a cancel frame on generic cancel when cancelOnClientAbort is true", async () => {
      transport = new WebSocketChatTransport({ socket, cancelOnClientAbort: true });
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "resumed-2" });
      const stream = (await promise)!;

      await stream.cancel();
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe("resumed-2");
    });

    it("a resumed stream does NOT send a cancel frame on generic cancel by default", async () => {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "resumed-3" });
      const stream = (await promise)!;

      await stream.cancel();
      expect(socket.lastSentOfType("cf_agent_chat_request_cancel")).toBeUndefined();
    });

    it("a tool-continuation stream sends a cancel frame on generic cancel when cancelOnClientAbort is true", async () => {
      transport = new WebSocketChatTransport({ socket, cancelOnClientAbort: true });
      transport.expectToolContinuation();
      const stream = (await transport.reconnectToStream({ chatId: "chat-1" }))!;
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "cont-x" });

      await stream.cancel();
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel")?.id).toBe("cont-x");
    });
  });

  // ── stream pending (pre-stream window) ──────────────────────────

  describe("stream pending", () => {
    it("handleStreamPending extends the resume probe past the 5s default", async () => {
      vi.useFakeTimers();
      const promise = transport.reconnectToStream({ chatId: "chat-1" });

      expect(transport.handleStreamPending()).toBe(true);

      // Past the original 5s probe — without the extension this would resolve null.
      vi.advanceTimersByTime(5001);
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "late-1" });

      const stream = await promise;
      expect(stream).not.toBeNull();
      expect(socket.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack")?.id).toBe("late-1");
    });

    it("the extended probe still times out to null at 60s", async () => {
      vi.useFakeTimers();
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      transport.handleStreamPending();

      vi.advanceTimersByTime(60_001);
      expect(await promise).toBeNull();
    });

    it("handleStreamPending returns false when no resume probe is in flight", () => {
      expect(transport.handleStreamPending()).toBe(false);
    });
  });

  // ── reconnectToStream — resume path ─────────────────────────────

  describe("reconnectToStream — resume path", () => {
    it("emits cf_agent_stream_resume_request as the first step", async () => {
      void transport.reconnectToStream({ chatId: "chat-1" });
      await tick();

      expect(socket.lastSentOfType("cf_agent_stream_resume_request")).toBeDefined();
    });

    it("resolves to null when server replies with cf_agent_stream_resume_none", async () => {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();

      transport.handleStreamResumeNone();
      const result = await promise;
      expect(result).toBeNull();
    });

    it("acks and returns a stream when server replies with cf_agent_stream_resuming", async () => {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();

      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "stream-42" });
      const stream = await promise;
      expect(stream).not.toBeNull();

      const ack = socket.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack");
      expect(ack?.id).toBe("stream-42");
    });

    it("times out to null after 5 seconds with no response", async () => {
      vi.useFakeTimers();
      const promise = transport.reconnectToStream({ chatId: "chat-1" });

      vi.advanceTimersByTime(5001);
      const result = await promise;
      expect(result).toBeNull();
    });

    it("the resumed stream enqueues subsequent chunks for the resumed id", async () => {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();
      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "stream-42" });
      const stream = (await promise)!;

      const chunk: UIMessageChunk = { type: "text-delta", id: "p1", delta: "resumed" };

      const drainPromise = drainStream(stream);
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "stream-42", body: JSON.stringify(chunk) });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "other", body: JSON.stringify(chunk) });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "stream-42", done: true });

      const { chunks } = await drainPromise;
      expect(chunks).toEqual([chunk]);
    });
  });

  // ── reconnectToStream — tool continuation path ──────────────────

  describe("reconnectToStream — tool continuation path", () => {
    it("expectToolContinuation routes the next reconnect to a deferred stream", async () => {
      transport.expectToolContinuation();
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      const stream = await promise;
      expect(stream).not.toBeNull();
      // The deferred stream emits its own resume request.
      expect(socket.lastSentOfType("cf_agent_stream_resume_request")).toBeDefined();
    });

    it("the deferred stream completes once continuation done arrives", async () => {
      transport.expectToolContinuation();
      const stream = (await transport.reconnectToStream({ chatId: "chat-1" }))!;

      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "cont-1" });
      const ack = socket.lastSentOfType<{ id: string }>("cf_agent_stream_resume_ack");
      expect(ack?.id).toBe("cont-1");

      const chunk: UIMessageChunk = { type: "text-delta", id: "p1", delta: "continued" };

      const drainPromise = readUntil(stream, (acc) => acc.length >= 1);
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "cont-1", body: JSON.stringify(chunk) });
      socket.emitMessage({ type: "cf_agent_use_chat_response", id: "cont-1", done: true });

      const chunks = await drainPromise;
      expect(chunks).toEqual([chunk]);
    });

    it("abortActiveToolContinuation aborts cleanly before the resume handshake completes", async () => {
      transport.expectToolContinuation();
      const stream = (await transport.reconnectToStream({ chatId: "chat-1" }))!;

      const drainPromise = drainStream(stream);
      const aborted = transport.abortActiveToolContinuation();
      expect(aborted).toBe(true);

      const { error } = await drainPromise;
      expect((error as Error).name).toBe("AbortError");
    });

    it("abortActiveToolContinuation aborts and sends cancel after the resume handshake completes", async () => {
      transport.expectToolContinuation();
      const stream = (await transport.reconnectToStream({ chatId: "chat-1" }))!;

      transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "cont-1" });

      const drainPromise = drainStream(stream);
      transport.abortActiveToolContinuation();

      const { error } = await drainPromise;
      expect((error as Error).name).toBe("AbortError");

      const cancel = socket.lastSentOfType<{ id: string }>("cf_agent_chat_request_cancel");
      expect(cancel?.id).toBe("cont-1");
    });
  });

  // ── handshake helpers ───────────────────────────────────────────

  describe("handshake helpers", () => {
    it("isAwaitingResume is true while a resume promise is pending and false otherwise", async () => {
      expect(transport.isAwaitingResume()).toBe(false);
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      await tick();
      expect(transport.isAwaitingResume()).toBe(true);
      transport.handleStreamResumeNone();
      await promise;
      expect(transport.isAwaitingResume()).toBe(false);
    });

    it("handleStreamResuming returns false when no resume is pending", () => {
      expect(transport.handleStreamResuming({ type: "cf_agent_stream_resuming", id: "x" })).toBe(false);
    });

    it("handleStreamResumeNone returns false when no resume is pending", () => {
      expect(transport.handleStreamResumeNone()).toBe(false);
    });
  });
});

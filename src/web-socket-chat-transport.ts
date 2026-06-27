import type { ChatRequestOptions, ChatTransport, UIMessage, UIMessageChunk } from "ai";

/** Minimal interface a WebSocket must satisfy for the transport. */
export interface WebSocketLike {
  send(data: string): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void, options?: AddEventListenerOptions): void;
}

interface StreamResumingData {
  type: string;
  id: string;
}

export interface WebSocketChatTransportOptions {
  socket: WebSocketLike;
  activeRequestIds?: Set<string>;
  prepareBody?: (options: {
    messages: UIMessage[];
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Whether a generic client-side abort (e.g. the AI SDK aborting the request
   * signal, or the stream being cancelled on teardown) should cancel the
   * *server* turn. Local-only by default — the server turn keeps running and can
   * be resumed/observed. Explicit `stop()` always cancels via
   * `cancelActiveServerTurn()`, regardless of this flag. Matches upstream 0.7.0.
   * @default false
   */
  cancelOnClientAbort?: boolean;
}

function randomRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Resume probe timeout (no pre-stream signal): give up and report "no stream". */
const RESUME_PROBE_TIMEOUT_MS = 5000;
/**
 * Extended probe timeout once the server signals `cf_agent_stream_pending` — the
 * turn is accepted but pre-stream (queueing / MCP setup), so keep waiting instead
 * of resolving "no stream" mid pre-stream window. Matches upstream 0.9.0.
 */
const RESUME_PENDING_TIMEOUT_MS = 60_000;

/**
 * ChatTransport that communicates with a Cloudflare Agent over WebSocket.
 * Mirrors the protocol implemented by `@cloudflare/ai-chat`'s
 * `WebSocketChatTransport`: same `cf_agent_*` message shapes, same resumable
 * streaming handshake, same tool continuation flow. Framework-agnostic — the
 * Vue composable consumes this; another framework binding could too.
 */
export class WebSocketChatTransport implements ChatTransport<UIMessage> {
  private socket: WebSocketLike;
  private prepareBody?: WebSocketChatTransportOptions["prepareBody"];
  private activeRequestIds: Set<string>;

  // Resume handshake state (public so the composable message handler can resolve them)
  _resumeResolver: ((data: StreamResumingData) => void) | null = null;
  _resumeNoneResolver: (() => void) | null = null;

  // Tool continuation state
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;

  // Whether a generic client abort should cancel the server turn (default: local-only).
  private cancelOnClientAbort: boolean;

  // The currently cancellable server turn — either locally initiated (sendMessages)
  // or observed via the broadcast/resume-fallback path. `_cancelAttachedStream` tears
  // down the local stream attached to a locally-initiated turn (null for observed turns).
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => void) | null = null;

  // Pre-stream "pending" extender for the in-flight resume probe (cleared on resolve).
  private _onStreamPending: (() => void) | null = null;

  constructor(options: WebSocketChatTransportOptions) {
    this.socket = options.socket;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds ?? new Set();
    this.cancelOnClientAbort = options.cancelOnClientAbort ?? false;
  }

  /** Mark that the next reconnectToStream() should attach to a server-initiated tool continuation. */
  expectToolContinuation(): void {
    this._expectToolContinuation = true;
  }

  /** Abort the active client-side tool continuation stream. */
  abortActiveToolContinuation(): boolean {
    return this._abortToolContinuation?.() ?? false;
  }

  /** Send a server-turn cancel frame for a request id (best-effort). */
  private sendCancelFrame(id: string): void {
    try {
      this.socket.send(JSON.stringify({ id, type: "cf_agent_chat_request_cancel" }));
    } catch {
      // swallow
    }
  }

  private setActiveServerTurn(id: string, cancelStream: (() => void) | null): void {
    this._activeServerTurnId = id;
    this._cancelAttachedStream = cancelStream;
  }

  private clearActiveServerTurn(id: string): void {
    if (this._activeServerTurnId === id) {
      this._activeServerTurnId = null;
      this._cancelAttachedStream = null;
    }
  }

  /** Register a server-observed (broadcast / resume-fallback) turn as the cancellable one. */
  observeServerTurn(requestId: string): void {
    this.setActiveServerTurn(requestId, null);
  }

  /** Mark a server turn complete so it is no longer the cancellable turn. */
  handleServerTurnCompleted(requestId: string): void {
    this.clearActiveServerTurn(requestId);
  }

  /**
   * Explicitly cancel the active server turn (and any tool continuation). Unlike a
   * generic client abort, this always signals the server. Drives `useAgentChat.stop()`.
   */
  cancelActiveServerTurn(): boolean {
    const id = this._activeServerTurnId;
    let cancelledRequest = false;
    if (id) {
      this.sendCancelFrame(id);
      this._cancelAttachedStream?.();
      this.clearActiveServerTurn(id);
      cancelledRequest = true;
    }
    const cancelledToolContinuation = this.abortActiveToolContinuation();
    return cancelledRequest || cancelledToolContinuation;
  }

  /** Called by the composable on cf_agent_stream_pending — extend the in-flight resume probe. */
  handleStreamPending(): boolean {
    if (!this._onStreamPending) {
      return false;
    }
    this._onStreamPending();
    return true;
  }

  /** True when the transport is waiting for a resume handshake. */
  isAwaitingResume(): boolean {
    return this._resumeResolver !== null || this._resumeNoneResolver !== null;
  }

  /** Called by the composable when it receives cf_agent_stream_resuming. */
  handleStreamResuming(data: StreamResumingData): boolean {
    if (!this._resumeResolver) {
      return false;
    }
    this._resumeResolver(data);
    return true;
  }

  /** Called by the composable when it receives cf_agent_stream_resume_none. */
  handleStreamResumeNone(): boolean {
    if (!this._resumeNoneResolver) {
      return false;
    }
    this._resumeNoneResolver();
    return true;
  }

  async sendMessages(
    options: {
      trigger: "submit-message" | "regenerate-message";
      chatId: string;
      messageId: string | undefined;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = randomRequestId();
    const abortController = new AbortController();
    let completed = false;

    // Merge prepareBody + per-request body
    let extraBody: Record<string, unknown> = {};
    if (this.prepareBody) {
      extraBody = await this.prepareBody({
        messages: options.messages,
        trigger: options.trigger,
        messageId: options.messageId,
      });
    }
    if (options.body) {
      extraBody = { ...extraBody, ...options.body };
    }

    // Server holds the full session in its own storage; only ship the tail message
    const tail = options.messages.at(-1);
    const bodyPayload = JSON.stringify({
      messages: tail ? [tail] : [],
      trigger: options.trigger,
      ...extraBody,
    });

    this.activeRequestIds.add(requestId);
    const socket = this.socket;
    const activeIds = this.activeRequestIds;

    const finish = (action: () => void, keepId = false, clearServerTurn = true): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      try {
        action();
      } catch {
        // swallow
      }
      if (!keepId) {
        activeIds.delete(requestId);
      }
      abortController.abort();
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    let requestSent = false;
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    // Explicit cancellation (via cancelActiveServerTurn) tears the local stream down but
    // keeps the id so late frames for the cancelled turn stay ignored; the cancel frame
    // itself is sent by cancelActiveServerTurn.
    const cancelActiveRequest = (): boolean => {
      if (completed) {
        return false;
      }
      finish(() => streamController.error(abortError), true);
      return true;
    };

    const onAbort = (): void => {
      if (completed) {
        return;
      }
      if (this.cancelOnClientAbort) {
        // Generic abort cancels the server turn only when opted in.
        if (requestSent) {
          this.sendCancelFrame(requestId);
        }
        finish(() => streamController.error(abortError), requestSent);
      } else {
        // Local-only (default): drop our local id so the still-running server turn becomes
        // observable via broadcast, but keep it tracked (once sent) so an explicit stop()
        // can still cancel it.
        finish(() => streamController.error(abortError), false, !requestSent);
      }
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
        const onMessage = (event: MessageEvent): void => {
          try {
            const data = JSON.parse(String(event.data));
            if (data.type !== "cf_agent_use_chat_response") {
              return;
            }
            if (data.id !== requestId) {
              return;
            }
            if (data.error) {
              finish(() => controller.error(new Error(data.body || "Stream error")));
              return;
            }
            if (data.body?.trim()) {
              try {
                const chunk: UIMessageChunk = JSON.parse(data.body);
                controller.enqueue(chunk);
              } catch {
                // swallow
              }
            }
            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // swallow
          }
        };
        socket.addEventListener("message", onMessage, { signal: abortController.signal });
      },
      cancel() {
        onAbort();
      },
    });

    // Register this turn as the cancellable one before wiring abort, so a pre-send abort
    // clears it (clearServerTurn = !requestSent) and a post-send abort keeps it tracked.
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) {
        onAbort();
      }
    }

    if (!completed) {
      socket.send(
        JSON.stringify({
          id: requestId,
          init: { method: "POST", body: bodyPayload },
          type: "cf_agent_use_chat_request",
        }),
      );
      requestSent = true;
    }

    return stream;
  }

  async reconnectToStream(
    _options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    const activeIds = this.activeRequestIds;

    return new Promise((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout>;

      const done = (value: ReadableStream<UIMessageChunk> | null): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this._resumeResolver = null;
        this._resumeNoneResolver = null;
        this._onStreamPending = null;
        clearTimeout(timeout);
        resolve(value);
      };

      this._resumeNoneResolver = () => done(null);
      this._resumeResolver = (data) => {
        const id = data.id;
        activeIds.add(id);
        this.socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id }));
        done(this._createResumeStream(id));
      };
      // Pre-stream window: server accepted a turn but hasn't started streaming yet.
      // Extend the probe so it doesn't resolve "no stream" early.
      this._onStreamPending = () => {
        if (resolved) {
          return;
        }
        clearTimeout(timeout);
        timeout = setTimeout(() => done(null), RESUME_PENDING_TIMEOUT_MS);
      };

      try {
        this.socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
      } catch {
        // swallow
      }

      timeout = setTimeout(() => done(null), RESUME_PROBE_TIMEOUT_MS);
    });
  }

  /**
   * Creates a deferred ReadableStream for client-side tool continuations.
   * Returned immediately so AI SDK status becomes "submitted" right after tool output,
   * then waits for the server to announce continuation via STREAM_RESUMING.
   */
  private _createToolContinuationStream(): ReadableStream<UIMessageChunk> {
    const socket = this.socket;
    const activeIds = this.activeRequestIds;
    const streamAbort = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    let completed = false;
    let requestId: string | null = null;
    let readerController!: ReadableStreamDefaultController<UIMessageChunk>;
    let onResumeRef: ((data: StreamResumingData) => void) | null = null;
    let onResumeNoneRef: (() => void) | null = null;

    const clearHandshakeResolvers = (
      resumeResolver?: ((data: StreamResumingData) => void) | null,
      resumeNoneResolver?: (() => void) | null,
    ): void => {
      if (resumeResolver === undefined && resumeNoneResolver === undefined) {
        this._resumeResolver = null;
        this._resumeNoneResolver = null;
        return;
      }
      if (resumeResolver && this._resumeResolver === resumeResolver) {
        this._resumeResolver = null;
      }
      if (resumeNoneResolver && this._resumeNoneResolver === resumeNoneResolver) {
        this._resumeNoneResolver = null;
      }
    };

    const finish = (
      action: () => void,
      resumeResolver?: ((data: StreamResumingData) => void) | null,
      resumeNoneResolver?: (() => void) | null,
      keepRequestId = false,
    ): void => {
      if (completed) {
        return;
      }
      completed = true;
      this._abortToolContinuation = null;
      this._onStreamPending = null;
      clearHandshakeResolvers(resumeResolver, resumeNoneResolver);
      try {
        action();
      } catch {
        // swallow
      }
      if (requestId && !keepRequestId) {
        activeIds.delete(requestId);
      }
      streamAbort.abort();
    };

    this._abortToolContinuation = (): boolean => {
      if (completed) {
        return false;
      }
      if (requestId === null) {
        finish(() => readerController.error(abortError), onResumeRef, onResumeNoneRef);
        return true;
      }
      try {
        socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: requestId }));
      } catch {
        // swallow
      }
      finish(() => readerController.error(abortError), onResumeRef, onResumeNoneRef, true);
      return true;
    };

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        readerController = controller;

        const onResumeNone = (): void => {
          clearTimeout(timeout);
          finish(() => controller.close(), onResume, onResumeNone);
        };

        const onResume = (data: StreamResumingData): void => {
          if (requestId) {
            return;
          }
          requestId = data.id;
          activeIds.add(requestId);
          clearHandshakeResolvers(onResume, onResumeNone);
          this._onStreamPending = null;
          clearTimeout(timeout);
          socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: requestId }));
        };

        onResumeRef = onResume;
        onResumeNoneRef = onResumeNone;
        let timeout = setTimeout(
          () => finish(() => controller.close(), onResume, onResumeNone),
          RESUME_PROBE_TIMEOUT_MS,
        );
        // Pre-stream window: extend the probe when the server signals pending.
        this._onStreamPending = () => {
          if (completed) {
            return;
          }
          clearTimeout(timeout);
          timeout = setTimeout(
            () => finish(() => controller.close(), onResume, onResumeNone),
            RESUME_PENDING_TIMEOUT_MS,
          );
        };

        this._resumeResolver = onResume;
        this._resumeNoneResolver = onResumeNone;

        const onMessage = (event: MessageEvent): void => {
          try {
            const data = JSON.parse(String(event.data));
            if (data.type !== "cf_agent_use_chat_response" || requestId == null || data.id !== requestId) {
              return;
            }
            if (data.error) {
              finish(() => controller.error(new Error(data.body || "Stream error")), onResume, onResumeNone);
              return;
            }
            if (data.body?.trim()) {
              try {
                const chunk: UIMessageChunk = JSON.parse(data.body);
                controller.enqueue(chunk);
              } catch {
                // swallow
              }
            }
            if (data.done) {
              finish(() => controller.close(), onResume, onResumeNone);
            }
          } catch {
            // swallow
          }
        };
        socket.addEventListener("message", onMessage, { signal: streamAbort.signal });

        try {
          socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
        } catch {
          finish(() => controller.close());
        }
      },
      cancel: () => {
        // Generic cancel: local-only unless cancelOnClientAbort opts into cancelling the
        // server-side continuation turn.
        if (requestId && this.cancelOnClientAbort) {
          this.sendCancelFrame(requestId);
          finish(() => {}, onResumeRef, onResumeNoneRef, true);
        } else {
          finish(() => {}, onResumeRef, onResumeNoneRef);
        }
      },
    });
  }

  /** Creates a ReadableStream that receives resumed stream chunks. */
  private _createResumeStream(requestId: string): ReadableStream<UIMessageChunk> {
    const socket = this.socket;
    const activeIds = this.activeRequestIds;
    const chunkAbort = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const finish = (action: () => void, keepId = false, clearServerTurn = true): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      try {
        action();
      } catch {
        // swallow
      }
      if (!keepId) {
        activeIds.delete(requestId);
      }
      chunkAbort.abort();
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
        const onMessage = (event: MessageEvent): void => {
          try {
            const data = JSON.parse(String(event.data));
            if (data.type !== "cf_agent_use_chat_response") {
              return;
            }
            if (data.id !== requestId) {
              return;
            }
            if (data.error) {
              finish(() => controller.error(new Error(data.body || "Stream error")));
              return;
            }
            if (data.body?.trim()) {
              try {
                const chunk: UIMessageChunk = JSON.parse(data.body);
                controller.enqueue(chunk);
              } catch {
                // swallow
              }
            }
            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // swallow
          }
        };
        socket.addEventListener("message", onMessage, { signal: chunkAbort.signal });
      },
      cancel: () => {
        // Generic cancel: local-only unless cancelOnClientAbort opts into cancelling the
        // server-side resumed turn.
        if (this.cancelOnClientAbort) {
          this.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {}, false, false);
        }
      },
    });

    // The resumed turn is the cancellable one; explicit cancel tears the local stream down
    // and keeps the id (late frames ignored). cancelActiveServerTurn sends the frame.
    this.setActiveServerTurn(requestId, () => {
      if (completed) {
        return false;
      }
      finish(() => streamController.error(abortError), true);
      return true;
    });

    return stream;
  }
}

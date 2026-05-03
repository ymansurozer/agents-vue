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
}

function randomRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

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

  constructor(options: WebSocketChatTransportOptions) {
    this.socket = options.socket;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds ?? new Set();
  }

  /** Mark that the next reconnectToStream() should attach to a server-initiated tool continuation. */
  expectToolContinuation(): void {
    this._expectToolContinuation = true;
  }

  /** Abort the active client-side tool continuation stream. */
  abortActiveToolContinuation(): boolean {
    return this._abortToolContinuation?.() ?? false;
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

    const finish = (action: () => void, keepId = false): void => {
      if (completed) {
        return;
      }
      completed = true;
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

    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const onAbort = (): void => {
      if (completed) {
        return;
      }
      try {
        socket.send(JSON.stringify({ id: requestId, type: "cf_agent_chat_request_cancel" }));
      } catch {
        // swallow
      }
      finish(() => streamController.error(abortError), true);
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

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) {
        onAbort();
      }
    }

    socket.send(
      JSON.stringify({
        id: requestId,
        init: { method: "POST", body: bodyPayload },
        type: "cf_agent_use_chat_request",
      }),
    );

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

      const done = (value: ReadableStream<UIMessageChunk> | null): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this._resumeResolver = null;
        this._resumeNoneResolver = null;
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

      try {
        this.socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
      } catch {
        // swallow
      }

      const timeout = setTimeout(() => done(null), 5000);
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
          clearTimeout(timeout);
          socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: requestId }));
        };

        onResumeRef = onResume;
        onResumeNoneRef = onResumeNone;
        const timeout = setTimeout(() => finish(() => controller.close(), onResume, onResumeNone), 5000);

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
      cancel() {
        finish(() => {});
      },
    });
  }

  /** Creates a ReadableStream that receives resumed stream chunks. */
  private _createResumeStream(requestId: string): ReadableStream<UIMessageChunk> {
    const socket = this.socket;
    const activeIds = this.activeRequestIds;
    const chunkAbort = new AbortController();
    let completed = false;

    const finish = (action: () => void): void => {
      if (completed) {
        return;
      }
      completed = true;
      try {
        action();
      } catch {
        // swallow
      }
      activeIds.delete(requestId);
      chunkAbort.abort();
    };

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
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
      cancel() {
        finish(() => {});
      },
    });
  }
}

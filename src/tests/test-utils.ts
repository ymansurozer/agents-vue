import type { WebSocketLike } from "../web-socket-chat-transport";

// Permissive listener type so MockSocket can satisfy both the transport's
// MessageEvent-only `WebSocketLike` and the composable's open/close/error
// handlers without per-event-type overloads.
type EventHandler = (event: never) => void;

/**
 * In-memory WebSocket stand-in. Records outbound `send` calls and lets tests
 * dispatch inbound messages by calling `emitMessage(...)` etc.
 *
 * Implements the transport's `WebSocketLike` minimum and the broader
 * `addEventListener` shape (open / close / error / message) the composable uses.
 */
export class MockSocket implements WebSocketLike {
  sentMessages: string[] = [];
  closed = false;

  private readonly listeners = new Map<string, Set<EventHandler>>();

  send(data: string): void {
    this.sentMessages.push(data);
  }

  addEventListener(type: string, listener: EventHandler, options?: AddEventListenerOptions): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    if (options?.signal) {
      const onAbort = () => {
        this.listeners.get(type)?.delete(listener);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  close(): void {
    this.closed = true;
  }

  // ── Test helpers ────────────────────────────────────────────────

  /** Dispatch a `message` event with the given payload (object → JSON, string verbatim). */
  emitMessage(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    const event = new MessageEvent("message", { data });
    this.listeners.get("message")?.forEach((l) => (l as (e: MessageEvent) => void)(event));
  }

  /** Dispatch an arbitrary event (open / close / error). */
  emit(type: string, event: Event): void {
    this.listeners.get(type)?.forEach((l) => (l as (e: Event) => void)(event));
  }

  /** Reset to a clean state between tests. */
  reset(): void {
    this.sentMessages.length = 0;
    this.listeners.clear();
    this.closed = false;
  }

  // ── Convenience accessors ───────────────────────────────────────

  /** Parse all sent messages as JSON. */
  sent<T = Record<string, unknown>>(): T[] {
    return this.sentMessages.map((m) => JSON.parse(m) as T);
  }

  /** Find the most recent sent message of a given protocol type. */
  lastSentOfType<T = Record<string, unknown>>(type: string): T | undefined {
    for (let i = this.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(this.sentMessages[i]!) as { type?: string };
        if (parsed.type === type) return parsed as T;
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  /** Number of listeners attached to a given event type (for leak checks). */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** Drain a ReadableStream into an array of chunks. Returns `{ chunks, error }`. */
export async function drainStream<T>(stream: ReadableStream<T>): Promise<{ chunks: T[]; error?: unknown }> {
  const chunks: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return { chunks };
  } catch (error) {
    return { chunks, error };
  } finally {
    reader.releaseLock();
  }
}

/** Read chunks until a predicate is true OR the stream closes/errors. */
export async function readUntil<T>(stream: ReadableStream<T>, predicate: (chunks: T[]) => boolean): Promise<T[]> {
  const chunks: T[] = [];
  const reader = stream.getReader();
  try {
    while (!predicate(chunks)) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  } finally {
    reader.releaseLock();
  }
}

/** Yield a microtask so async resolutions flush. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

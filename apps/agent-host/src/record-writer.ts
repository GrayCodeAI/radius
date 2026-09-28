import type { RawEvent } from "@botiverse/oar";

import type { RecordStore } from "./record-store.ts";

export interface RecordWriterOptions {
  readonly store: RecordStore;
  /** The durable stream name. Must satisfy `RecordStore`'s session-id rules. */
  readonly sessionId: string;
}

/**
 * The bridge between oar's record observer and our durability contract.
 *
 * This is the central engineering problem of phase 0, not a convenience wrapper.
 *
 * oar delivers records through `RawEventObserver = (record: RawEvent) => void` — synchronous,
 * fire-and-forget, with no way to await persistence and no way to signal backpressure. Our
 * contract is the exact opposite: `RecordStore.append()` resolves only once the bytes are
 * fsync'd. Bridging those naively —
 *
 *     session.rawEvents((r) => { void store.append(id, r); });
 *
 * — is precisely the failure this product exists to prevent. Those appends race each other for
 * the same file handle, so `seq` order is not preserved, and a process death drops every append
 * still in flight. It is also a floating promise, which `pnpm lint` fails on by design.
 *
 * So the observer never touches the disk. It enqueues, synchronously and in arrival order, onto
 * a single promise chain. Two invariants follow, and both are load-bearing:
 *
 * 1. **One append is ever in flight.** The chain is serial, so `seq` reaches the file in the
 *    order the runtime emitted it. `RecordStore` rejects a lower `seq` as corruption, so losing
 *    this would turn a silent race into a loud failure — which is the behaviour we want, but only
 *    because the ordering is actually guaranteed upstream of it.
 * 2. **A failure is sticky and loud.** The first append error is remembered and re-thrown by
 *    `drain()`. It is not swallowed, because a swallowed write failure is a lie about what is on
 *    disk — and this is the file the control plane later treats as the source of truth.
 *
 * Callers MUST `await drain()` before the process exits, exactly as they must
 * `RecordStore.close()`. A stream that was never drained has records that were observed but are
 * not durable, and nothing in this class pretends otherwise.
 *
 * **Backpressure is not solved, only measured.** oar's observer is synchronous and offers no
 * channel to slow a producer, so if a runtime emits faster than we fsync, `pending` grows. It is
 * exposed rather than hidden so a supervisor can alarm on it. This belongs in `SAFETY.md` §3 as a
 * non-guarantee: we bound the *loss* on a hard kill, not the *depth* of an in-memory queue.
 */
export class RecordWriter {
  readonly #store: RecordStore;
  readonly #sessionId: string;

  /** Tail of the serial append chain. Never rejects — failures are captured in #failure. */
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #failure: Error | null = null;
  #closed = false;

  constructor(options: RecordWriterOptions) {
    this.#store = options.store;
    this.#sessionId = options.sessionId;
  }

  /**
   * Accept one record. Synchronous, and it throws only on a programming error (enqueueing after
   * close), because the caller is oar's observer and has nowhere to put a failure.
   */
  enqueue(record: RawEvent): void {
    if (this.#closed) {
      throw new Error(
        `RecordWriter for ${this.#sessionId} is closed; a record was observed after close(). ` +
          `Detach the observer before closing the writer — see HostSession.stop().`,
      );
    }
    this.#pending += 1;
    const sessionId = this.#sessionId;
    this.#tail = this.#tail
      .then(async () => {
        await this.#store.append(sessionId, toStored(record, sessionId));
        this.#pending -= 1;
      })
      .catch((error: unknown) => {
        // Keep draining so one bad record cannot wedge the stream and strand everything queued
        // behind it — but remember the first failure. drain() re-throws it.
        this.#pending -= 1;
        this.#failure ??=
          error instanceof Error ? error : new Error(String(error));
      });
  }

  /** Records observed but not yet known-durable. See the backpressure note above. */
  get pending(): number {
    return this.#pending;
  }

  /** The first append failure since construction, or null. */
  get failure(): Error | null {
    return this.#failure;
  }

  /** Refuse further records. Idempotent. `drain()` still works afterwards. */
  close(): void {
    this.#closed = true;
  }

  /**
   * Resolves once every enqueued record is durable. Rejects with the first append failure, if
   * any — a caller that swallows this is claiming a durability it does not have.
   */
  async drain(): Promise<void> {
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
}

/**
 * Projects an oar `RawEvent` onto the store's record shape.
 *
 * Deliberately lossy. `RecordStore` keeps `seq`, `sessionId`, `kind`, `body` and stamps its own
 * `recordedAt`; the rest of oar's envelope (`agentPath`, `spanId`, `receivedAt`) rides inside
 * `body` rather than being promoted to top-level columns, so the on-disk shape does not need a
 * migration every time oar enriches its envelope.
 *
 * `sessionId` is the store's own stream name, taken from the writer — never from the record. The
 * runtime does not get to name a file: that id became a filesystem path, which is exactly the
 * untrusted input `RecordStore` validates before touching the disk.
 */
function toStored(record: RawEvent, sessionId: string) {
  const { seq, kind, body, ...envelope } = record;
  return { seq, sessionId, kind, body: { envelope, native: body } } as const;
}

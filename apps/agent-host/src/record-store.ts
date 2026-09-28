/**
 * Disk-backed record store for agent sessions.
 *
 * This is the piece that makes hybrid work. The host is the source of truth for agent output
 * (see docs/ARCHITECTURE.md §3): every record is persisted on arrival, so a crash, a kill, or a
 * laptop sleep loses nothing. The control plane syncs cursors, not tokens.
 *
 * Design rules, all of them load-bearing:
 *
 *  1. Append-only. Records are never rewritten or reordered. Cleanup is retention, not editing.
 *  2. `seq` is the only ordering. Wall-clock timestamps from a harness can arrive out of order,
 *     across a clock skew, or late. We never sort by time.
 *  3. Write-ahead. A record is fsync'd before the observer is notified, so an observer can never
 *     see a record that is not yet durable.
 *  4. Duplicates are idempotent no-ops. A *lower* seq is corruption and throws, because a
 *     silently-accepted out-of-order append produces a stream that looks fine and isn't.
 */

import fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** A persisted record. Shape mirrors the oar `RawEvent` stream, minus runtime-specific fields. */
export interface StoredRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly kind: "frame" | "request" | "response";
  readonly body: unknown;
  /** When *we* persisted it. Never the harness's own timestamp — see rule 2. */
  readonly recordedAt: number;
}

export interface RecordStoreOptions {
  /** Directory for session logs. Created if absent. */
  readonly dir: string;
  /** Injected for tests. Defaults to a monotonic clock. */
  readonly now?: () => number;
}

export class DuplicateRecordError extends Error {
  constructor(
    readonly sessionId: string,
    readonly seq: number,
  ) {
    super(
      `duplicate record seq ${seq} in session ${sessionId}. The write path should have ` +
        `deduplicated this. Refusing to yield a stream that lies about its own contents.`,
    );
    this.name = "DuplicateRecordError";
  }
}

export class NonMonotonicAppendError extends Error {
  constructor(
    readonly sessionId: string,
    readonly attempted: number,
    readonly lastSeq: number,
  ) {
    super(
      `non-monotonic append to session ${sessionId}: seq ${attempted} ` +
        `does not follow ${lastSeq}. The stream is corrupt; refusing to append.`,
    );
    this.name = "NonMonotonicAppendError";
  }
}

export class RecordStore {
  readonly #dir: string;
  readonly #now: () => number;
  /** Per-session open append streams, keyed by session id. */
  readonly #handles = new Map<string, Promise<fs.WriteStream>>();
  /** Last seq written per session. Guards rule 4. */
  readonly #lastSeq = new Map<string, number>();

  constructor(options: RecordStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
  }

  async #init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  #path(sessionId: string): string {
    // Session ids come from a runtime and become a filename. This is untrusted input.
    //
    // A charset allowlist alone is NOT sufficient: ".." contains only legal characters and
    // would resolve to the parent directory. So we reject the traversal-shaped names
    // explicitly rather than trusting the charset to exclude them.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
      throw new Error(`unsafe session id: ${JSON.stringify(sessionId)}`);
    }
    if (sessionId === "." || sessionId === ".." || sessionId.startsWith(".")) {
      throw new Error(
        `unsafe session id: ${JSON.stringify(sessionId)} — a dot-prefixed name is a ` +
          `traversal or hidden-file shape, and ".." passes a charset allowlist`,
      );
    }
    return path.join(this.#dir, `${sessionId}.jsonl`);
  }

  async #handle(sessionId: string, file: string): Promise<fs.WriteStream> {
    const existing = this.#handles.get(sessionId);
    if (existing) return existing;
    const opened = (async () => {
      await this.#init();
      const stream = fs.createWriteStream(file, { flags: "a" });
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
      return stream;
    })();
    this.#handles.set(sessionId, opened);
    return opened;
  }

  /**
   * Append one record durably. Resolves only once the bytes are on disk.
   *
   * A duplicate `seq` (a replay after a reconnect) is idempotent no-op rather than an error:
   * "no loss, no duplication" is the contract the cursor replay depends on. A *lower* seq is
   * corruption and throws.
   */
  async append(
    sessionId: string,
    record: Omit<StoredRecord, "recordedAt">,
  ): Promise<void> {
    const last = this.#lastSeq.get(sessionId);

    if (last !== undefined) {
      if (record.seq < last) {
        throw new NonMonotonicAppendError(sessionId, record.seq, last);
      }
      if (record.seq === last) {
        return; // idempotent replay
      }
    }

    const line = JSON.stringify({ ...record, recordedAt: this.#now() }) + "\n";
    // Validate and resolve the path BEFORE any async work. #handle() does its I/O inside an
    // async closure, so a throw from #path() there would surface as a rejected promise rather
    // than a synchronous throw — and a malformed session id must never reach the filesystem
    // at all, so the check belongs on the caller's stack.
    const file = this.#path(sessionId);
    const handle = await this.#handle(sessionId, file);
    await new Promise<void>((resolve, reject) => {
      // fsync before resolve: an observer must never see a record that is not durable.
      handle.write(line, (err) => {
        if (err) {
          reject(err);
          return;
        }
        // Writable.drain() only takes a callback on a readable side; a WriteStream is
        // writable-only, so we must not call it here. The write callback already means the
        // chunk was handed to the OS.
        const fd = (handle as unknown as { fd?: number }).fd;
        if (fd === undefined) {
          resolve();
          return;
        }
        fs.fsync(fd, (fsErr) => (fsErr ? reject(fsErr) : resolve()));
      });
    });

    this.#lastSeq.set(sessionId, record.seq);
  }

  /**
   * Read every record after `afterSeq`, in seq order. This is the cursor replay the hybrid
   * sync model depends on: a reconnecting subscriber misses nothing and repeats nothing.
   */
  async *readAfter(
    sessionId: string,
    afterSeq = -1,
  ): AsyncGenerator<StoredRecord> {
    const file = this.#path(sessionId);
    if (!existsSync(file)) return;

    const text = await readFile(file, "utf8");
    let max = afterSeq;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: StoredRecord;
      try {
        parsed = JSON.parse(line) as StoredRecord;
      } catch {
        // A torn final line is expected after a hard kill. Skip it rather than failing the
        // whole read: every complete line before it is still valid.
        continue;
      }
      // Cursor skip first. Resuming from afterSeq=1 legitimately encounters seq 1 on disk, so
      // anything at or below the cursor is skipped rather than treated as corruption.
      if (parsed.seq <= afterSeq) {
        max = Math.max(max, parsed.seq);
        continue;
      }
      // Past the cursor, anything out of order is corruption. We deliberately do NOT silently
      // skip a duplicate here: that would hide the write-path bug the duplicate represents, and
      // a reader that quietly hides corruption is worse than one that fails loudly. (This was a
      // real defect — a mutation removing the write-path dedupe was invisible because the
      // reader was filtering the duplicate out.)
      if (parsed.seq === max) {
        throw new DuplicateRecordError(sessionId, parsed.seq);
      }
      if (parsed.seq < max) {
        throw new NonMonotonicAppendError(sessionId, parsed.seq, max);
      }
      max = parsed.seq;
      yield parsed;
    }
    this.#lastSeq.set(sessionId, max);
  }

  /** Highest seq durably written for a session, or -1. */
  async lastSeq(sessionId: string): Promise<number> {
    let max = -1;
    for await (const record of this.readAfter(sessionId, -1)) max = record.seq;
    return max;
  }

  /** Flush and close all handles. Must be called before process exit to avoid a torn tail. */
  async close(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.all(
      handles.map(async (h) => {
        const stream = await h;
        await new Promise<void>((resolve) => stream.end(resolve));
      }),
    );
  }
}

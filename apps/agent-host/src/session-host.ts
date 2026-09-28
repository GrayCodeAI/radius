import {
  runtimes as defaultRuntimes,
  type AvailableInstallation,
  type Cursor,
  type InstallationSnapshot,
  type Runtime,
  type RuntimeRegistry,
  type Session,
  type Unsubscribe,
} from "@botiverse/oar";

import type { RecordStore } from "./record-store.ts";
import { RecordWriter } from "./record-writer.ts";

/** The requested runtime is not in the registry. */
export class UnknownRuntimeError extends Error {
  constructor(
    readonly runtimeId: string,
    readonly known: readonly string[],
  ) {
    super(
      `unknown runtime "${runtimeId}". Known runtimes: ${known.join(", ") || "(none)"}. ` +
        `This is a configuration error, not a runtime failure — nothing was started.`,
    );
    this.name = "UnknownRuntimeError";
  }
}

/**
 * The runtime is known but cannot run here: no probe at all, not found, or present but
 * unsupported. Deliberately distinct from a *session* failure — nothing was spawned, and a
 * caller's retry policy should differ.
 */
export class RuntimeUnavailableError extends Error {
  constructor(
    readonly runtimeId: string,
    readonly snapshot: InstallationSnapshot | null,
  ) {
    const why =
      snapshot === null
        ? "it exposes no installation probe"
        : snapshot.kind === "not_found"
          ? "it is not installed on this machine"
          : snapshot.kind === "unsupported"
            ? `it is unsupported here: ${snapshot.reason}`
            : `it reported an unusable state: ${snapshot.kind}`;
    super(
      `runtime "${runtimeId}" is unavailable — ${why}. Nothing was started. ` +
        `This is a host configuration problem, not a session failure.`,
    );
    this.name = "RuntimeUnavailableError";
  }
}

export interface StartHostSessionOptions {
  readonly runtimeId: string;
  /** Working directory the runtime operates in. */
  readonly cwd: string;
  readonly store: RecordStore;
  /**
   * Durable stream name, and it is **required on purpose**.
   *
   * oar's `Session.id` is not a safe basis for a filename, and its identity across a `resume` is
   * not something this host should depend on, so the caller — the supervisor — owns the name. It
   * becomes a path, so `RecordStore` validates it before any I/O.
   *
   * **One stream per Session, not per conversation.** oar documents that `resume` "reopens the
   * runtime-native conversation with a fresh stream starting at seq 0". A resumed conversation
   * therefore replays `seq` from zero, and appending that to a file already holding `0..N` is a
   * lower-seq append — which `RecordStore` rejects as corruption. That rejection is correct and
   * intended; the caller's response is a *new* `sessionId` for the new stream, never a
   * relaxation of the store.
   */
  readonly sessionId: string;
  readonly model?: string;
  /** Reopen a runtime-native conversation. Yields a fresh seq-0 stream; see `sessionId`. */
  readonly resume?: string;
  /** Defaults to oar's registry of all five runtimes. Injected by tests. */
  readonly registry?: RuntimeRegistry;
  /**
   * Re-subscribe anchor, for re-attaching an observer within one adapter process. Not a restart
   * mechanism: a new process gets a new stream, and the durable file is the recovery mechanism,
   * not an oar cursor.
   */
  readonly cursor?: Cursor;
}

export interface HostSession {
  readonly session: Session;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly writer: RecordWriter;
  /** Stop observing. Idempotent. Does not dispose the session. */
  detach(): void;
  /**
   * Dispose, drain, detach — in that order, and the order is load-bearing.
   *
   * `dispose()` produces records of its own: the `dispose` request, its response, and the
   * process `exited`. Detaching first would discard exactly the records that say the agent shut
   * down cleanly, which is what an operator most wants on disk after a hard kill.
   */
  stop(): Promise<void>;
}

/**
 * Resolve a runtime, prove it can run here, start a session, and bind its record stream to
 * durable storage.
 *
 * Nothing is started until the installation probe has succeeded, so an unavailable runtime costs
 * a rejected promise rather than a half-initialized process.
 */
export async function startHostSession(
  options: StartHostSessionOptions,
): Promise<HostSession> {
  const registry = options.registry ?? defaultRuntimes;
  const runtime: Runtime | undefined = registry.get(options.runtimeId);
  if (!runtime) {
    throw new UnknownRuntimeError(
      options.runtimeId,
      registry.list().map((r) => r.id),
    );
  }

  // `Runtime.installation` is optional in the contract even though all five shipped runtimes
  // provide one. Absence is treated as unavailability rather than assumed away, because
  // `StartSession` cannot be called without an `AvailableInstallation`.
  if (typeof runtime.installation !== "function") {
    throw new RuntimeUnavailableError(options.runtimeId, null);
  }
  const snapshot = await runtime.installation();
  if (snapshot.kind !== "available") {
    throw new RuntimeUnavailableError(options.runtimeId, snapshot);
  }
  const installation: AvailableInstallation = snapshot;

  const session = await runtime.session(installation, {
    cwd: options.cwd,
    model: options.model,
    resume: options.resume,
  });

  const writer = new RecordWriter({
    store: options.store,
    sessionId: options.sessionId,
  });
  // The observer is synchronous by oar's contract, so this is the only place records enter. It
  // does no I/O — see RecordWriter for why that matters.
  const unsubscribe: Unsubscribe = session.rawEvents(
    (record) => writer.enqueue(record),
    options.cursor,
  );

  let detached = false;
  // A named function rather than `this.detach()`: the object literal's `this` is not reliably
  // the HostSession, and an explicit closure makes the ordering below readable.
  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribe();
  };

  return {
    session,
    runtimeId: options.runtimeId,
    sessionId: options.sessionId,
    writer,
    detach,
    async stop() {
      try {
        await session.dispose();
      } finally {
        // Drain even when dispose throws: the records that did arrive are still ours, and
        // dropping them is the exact failure this package exists to avoid.
        try {
          await writer.drain();
        } finally {
          detach();
          writer.close();
        }
      }
    },
  };
}

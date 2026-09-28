import type { RuntimeRegistry } from "@botiverse/oar";

import type { RecordStore } from "./record-store.ts";
import { startHostSession, type HostSession } from "./session-host.ts";

export type SupervisorState = "idle" | "running" | "stopping";

/** `start()` was called while a session was already running. */
export class AlreadyRunningError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `a session for "${sessionId}" is already running. Two writers on one stream is the ` +
        `split-brain the vendored proofs are about — use restart() to cycle deliberately.`,
    );
    this.name = "AlreadyRunningError";
  }
}

/** `stop()` did not finish inside the budget, so the process may still be resident. */
export class StopTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `stopping "${sessionId}" did not complete within ${timeoutMs}ms. The harness may still be ` +
        `running — this is reported rather than swallowed, because "it probably exited" is not a ` +
        `state we are willing to claim.`,
    );
    this.name = "StopTimeoutError";
  }
}

export interface AgentSupervisorOptions {
  readonly runtimeId: string;
  readonly cwd: string;
  readonly store: RecordStore;
  /** Durable stream name. See `StartHostSessionOptions.sessionId` — one stream per Session. */
  readonly sessionId: string;
  readonly model?: string;
  readonly resume?: string;
  readonly registry?: RuntimeRegistry;
  /**
   * Budget for `stop()`. An unattended host cannot hang forever on a wedged harness, and a
   * silent hang is indistinguishable from a leak. Exceeding it raises `StopTimeoutError`.
   */
  readonly stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/**
 * Owns the lifecycle of exactly one agent session.
 *
 * Small on purpose. The valuable part is not the start/stop plumbing — it is the three
 * properties this class exists to make true, each of which is a way unattended agents go wrong:
 *
 * 1. **Never two writers.** `start()` refuses while running. Two drivers on one stream is the
 *    same split-brain k-carrier's `never_dual_run` is about, one layer up. `restart()` is the
 *    only way to cycle, so the intent is explicit.
 * 2. **Nothing observed is left unpersisted.** `stop()` drains before it returns, even when
 *    `dispose()` throws. The exit records are the ones an operator wants most.
 * 3. **No process residency.** `stop()` does not resolve until the harness is gone — and if it
 *    cannot prove that within the budget, it says so instead of returning quietly.
 *
 * State transitions are one-way and total: idle → running → idle, with `stopping` observable
 * while a stop is in flight. There is no state from which a second session can appear.
 */
export class AgentSupervisor {
  readonly #options: AgentSupervisorOptions;
  #state: SupervisorState = "idle";
  #current: HostSession | null = null;

  constructor(options: AgentSupervisorOptions) {
    this.#options = options;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  /** The live session, or null. Exposed for the caller to prompt/steer; not for lifecycle. */
  get session(): HostSession | null {
    return this.#current;
  }

  get sessionId(): string {
    return this.#options.sessionId;
  }

  async start(): Promise<HostSession> {
    if (this.#state !== "idle") {
      throw new AlreadyRunningError(this.#options.sessionId);
    }
    // A new stream per Session, so a restart gets a fresh name unless the caller is resuming a
    // brand-new stream into the same file. See StartHostSessionOptions.sessionId — reusing a
    // name across a fresh seq-0 stream is a lower-seq append, and RecordStore rejects it loudly.
    const host = await startHostSession({
      runtimeId: this.#options.runtimeId,
      cwd: this.#options.cwd,
      store: this.#options.store,
      sessionId: this.#options.sessionId,
      model: this.#options.model,
      resume: this.#options.resume,
      registry: this.#options.registry,
    });
    this.#current = host;
    this.#state = "running";
    return host;
  }

  /**
   * Stop the session and leave nothing behind. Idempotent.
   *
   * The timeout is a real ceiling, not a formality: a wedged harness must not pin the host
   * forever. It raises rather than resolves quietly, because a supervisor that returns "stopped"
   * while a process is still running is precisely the lie an unattended deployment cannot catch.
   */
  async stop(): Promise<void> {
    const current = this.#current;
    if (!current || this.#state === "stopping") return;
    this.#state = "stopping";

    const budget = this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StopTimeoutError(this.#options.sessionId, budget)),
        budget,
      );
    });

    try {
      await Promise.race([current.stop(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.#current = null;
      this.#state = "idle";
    }
  }

  /** Stop, then start. The only supported way to cycle a session. */
  async restart(): Promise<HostSession> {
    await this.stop();
    return this.start();
  }
}

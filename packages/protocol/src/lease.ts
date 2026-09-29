/**
 * Monotonic time, and the lease manager built on it.
 *
 * oar declines this outright: *"Ownership is the object reference; no in-process lease.
 * Multi-controller arbitration belongs to the application layer."* That sentence is the company —
 * the layer nobody else is building. This is it.
 *
 * ── Why a plain `Date.now()` lease is not good enough ───────────────────────────────────────
 * Because the user controls the clock. A lease enforced against wall time can be extended
 * indefinitely by setting the system clock back — not a theoretical attack, one `date` command
 * away on the machine the agent runs on. D-008 Q4 settles it: **bind leases against monotonic
 * time.** Expiry is computed from `process.hrtime`, which never moves backwards and which the
 * user cannot reach.
 *
 * The subtlety D-008 flags, implemented here: a restart **resets** the monotonic clock, so its
 * reading is meaningless across a restart unless re-anchored against persisted state. That is
 * what `MonotonicClock.restore` and `LeaseManager.restore` exist for, and why a lease whose
 * window elapsed while the process was down is dropped rather than revived.
 *
 * ── The second property: fencing ───────────────────────────────────────────────────────────
 * Expiry alone does not prevent split-brain. A partitioned holder does not notice its lease
 * expired; it keeps writing. So every lease carries an `epoch` that increments on takeover, and
 * **every write is checked against it** (D-012, invariant I5). A stale holder is rejected no
 * matter what it believes about its own lease. This is the difference between "we have leases"
 * and "we cannot split-brain".
 */

/** A monotonic millisecond reading. Never decreases within a process. */
export interface MonotonicSource {
  now(): number;
}

/** `process.hrtime`-backed. Injected in tests so time can be controlled. */
export const hrtimeSource: MonotonicSource = {
  now: () => Number(process.hrtime.bigint() / 1_000_000n),
};

/** What is persisted so a restart can re-anchor the monotonic clock. */
export interface MonotonicAnchor {
  /** Monotonic reading at the moment of anchoring. */
  readonly monotonicAt: number;
  /** Wall clock at the same instant. Recorded for audit, never trusted for expiry. */
  readonly wallAt: number;
}

export interface MonotonicClockOptions {
  readonly source?: MonotonicSource;
  readonly wallNow?: () => number;
  /** State persisted by a previous process, if any. */
  readonly anchor?: MonotonicAnchor;
}

/**
 * A monotonic clock that survives a process restart.
 *
 * Deliberately narrow: call `now()` for every expiry decision, `anchor()` to persist. Never
 * compare `now()` against a `Date.now()` value.
 */
export class MonotonicClock {
  readonly #source: MonotonicSource;
  readonly #wallNow: () => number;
  /** The persisted monotonic value we are measuring from. */
  #anchorMonotonic: number;
  /** This process's source reading at the moment we adopted `#anchorMonotonic`. */
  #sourceAtAnchor: number;

  constructor(options: MonotonicClockOptions = {}) {
    this.#source = options.source ?? hrtimeSource;
    this.#wallNow = options.wallNow ?? Date.now;
    this.#anchorMonotonic = options.anchor?.monotonicAt ?? 0;
    this.#sourceAtAnchor = this.#source.now();
  }

  /**
   * Restore a persisted anchor, so time is continuous across a restart.
   *
   * After a restart the process monotonic clock has reset to ~0. Adopting the anchor means
   * `now()` *starts* at the persisted value and advances from there — so a lease that was live
   * before the bounce is still live, and one whose window elapsed while we were down is not.
   *
   * Note what this does NOT do: it never consults the wall clock. That is the whole point. A
   * user who rewinds `Date.now()` cannot move this reading, and therefore cannot revive a lease.
   */
  restore(anchor: MonotonicAnchor): void {
    this.#anchorMonotonic = anchor.monotonicAt;
    this.#sourceAtAnchor = this.#source.now();
  }

  /** Monotonic milliseconds. Non-decreasing for the lifetime of the clock. */
  now(): number {
    return this.#anchorMonotonic + (this.#source.now() - this.#sourceAtAnchor);
  }

  /** Persist this. Store it; feed it back via `restore` on the next start. */
  anchor(): MonotonicAnchor {
    return { monotonicAt: this.now(), wallAt: this.#wallNow() };
  }
}

export interface Lease {
  readonly resource: string;
  readonly holderId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  /** Fencing token. Increments on every takeover; checked on every write. */
  readonly epoch: number;
}

/** The resource is already leased by a live holder. */
export class LeaseHeldError extends Error {
  constructor(
    readonly resource: string,
    readonly holderId: string,
  ) {
    super(
      `"${resource}" is held by ${holderId}. One controller per resource is the whole point; ` +
        `if you meant to take over, wait for expiry or release it explicitly.`,
    );
    this.name = "LeaseHeldError";
  }
}

/** The presented epoch is not current. A partitioned holder lands here. */
export class StaleEpochError extends Error {
  constructor(
    readonly resource: string,
    readonly presented: number,
    readonly current: number,
  ) {
    super(
      `stale epoch ${presented} for "${resource}" (current is ${current}). This holder was ` +
        `superseded — a takeover happened while it was partitioned. Refusing the write.`,
    );
    this.name = "StaleEpochError";
  }
}

/** The lease has expired on the authority's clock. */
export class LeaseExpiredError extends Error {
  constructor(
    readonly resource: string,
    readonly holderId: string,
  ) {
    super(
      `the lease on "${resource}" held by ${holderId} has expired. Expiry is evaluated on the ` +
        `authority's monotonic clock, never the holder's, so clock skew cannot revive it.`,
    );
    this.name = "LeaseExpiredError";
  }
}

/**
 * Exclusive, epoch-fenced, monotonic leases. One controller per resource.
 *
 * Pure and synchronous by design: the real implementation runs inside a Durable Object, where
 * single-threaded execution *is* the mutual exclusion. Keeping the logic free of I/O means it
 * can be tested exhaustively here rather than trusted inside a platform runtime.
 */
export class LeaseManager {
  readonly #clock: MonotonicClock;
  readonly #ttlMs: number;
  readonly #leases = new Map<string, Lease>();

  constructor(options: LeaseManagerOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /**
   * Claim a resource exclusively, or take over an expired one.
   *
   * On takeover the epoch **increments**. That is the fencing token: any write the previous holder
   * attempts with its old epoch is rejected from that moment on, however confidently it believes
   * it still holds the lease.
   */
  acquire(resource: string, holderId: string): Lease {
    const now = this.#clock.now();
    const existing = this.#leases.get(resource);

    if (existing && existing.expiresAt > now) {
      throw new LeaseHeldError(resource, existing.holderId);
    }

    const lease: Lease = {
      resource,
      holderId,
      acquiredAt: now,
      expiresAt: now + this.#ttlMs,
      epoch: (existing?.epoch ?? 0) + 1,
    };
    this.#leases.set(resource, lease);
    return lease;
  }

  /**
   * The authority's view of a resource. `null` when free or expired — an expired lease is not a
   * lease, and reporting it as one is how a second controller talks itself into thinking it may
   * write.
   */
  current(resource: string): Lease | null {
    const lease = this.#leases.get(resource);
    if (!lease) return null;
    return lease.expiresAt > this.#clock.now() ? lease : null;
  }

  /**
   * Assert a holder may write. Call this on EVERY write — that is the entire point of the epoch.
   *
   * Checks in order: the lease exists, the epoch is current, it has not expired, and the holder
   * is the one who took it. A caller that skips this check is a caller that can split-brain.
   */
  assertWritable(resource: string, holderId: string, epoch: number): Lease {
    const lease = this.#leases.get(resource);
    if (!lease) {
      throw new LeaseExpiredError(resource, holderId);
    }
    if (lease.epoch !== epoch) {
      throw new StaleEpochError(resource, epoch, lease.epoch);
    }
    if (lease.expiresAt <= this.#clock.now()) {
      throw new LeaseExpiredError(resource, holderId);
    }
    if (lease.holderId !== holderId) {
      throw new LeaseHeldError(resource, lease.holderId);
    }
    return lease;
  }

  /** Extend a live lease. Requires a current epoch — a stale holder cannot extend. */
  renew(resource: string, holderId: string, epoch: number): Lease {
    const lease = this.assertWritable(resource, holderId, epoch);
    const extended: Lease = {
      ...lease,
      expiresAt: this.#clock.now() + this.#ttlMs,
    };
    this.#leases.set(resource, extended);
    return extended;
  }

  /** Give the lease up early. A new holder may then take over without waiting for expiry. */
  release(resource: string, holderId: string, epoch: number): void {
    this.assertWritable(resource, holderId, epoch);
    this.#leases.delete(resource);
  }

  /** Snapshot for persistence. */
  entries(): readonly Lease[] {
    return [...this.#leases.values()];
  }

  /**
   * Rehydrate leases persisted by a previous process.
   *
   * Exists because a restart resets the monotonic clock, and a lease that was live must still be
   * live afterwards. Two rules, and the second is the one that matters:
   *
   * 1. The monotonic anchor is restored too, or `now()` resets to ~0 and every live lease looks
   *    centuries old — a restart would expire everything.
   * 2. **A lease whose window already elapsed is dropped, not revived.** D-008 says this in as
   *    many words: "if the persisted state shows the monotonic window has already elapsed, the
   *    lease is expired regardless of the wall clock." Rehydrating it would let a rewound clock
   *    resurrect a dead lease, which is the entire attack Q4 exists to stop.
   */
  restore(leases: readonly Lease[], anchor: MonotonicAnchor): void {
    this.#clock.restore(anchor);
    const now = this.#clock.now();
    for (const lease of leases) {
      if (lease.expiresAt <= now) continue; // elapsed while we were down
      this.#leases.set(lease.resource, lease);
    }
  }
}

export interface LeaseManagerOptions {
  readonly clock: MonotonicClock;
  /** Milliseconds a lease is held. Default 1 hour, per D-008. */
  readonly ttlMs?: number;
}

export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

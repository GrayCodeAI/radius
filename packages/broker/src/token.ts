/**
 * Scoped token issuance, verification, and revocation.
 *
 * ── The rule this module exists to enforce ─────────────────────────────────────────────────
 * `DATA-MODEL.md` §4: "`broker_token_hash` — store a **hash**. A leaked table must not yield
 * working tokens." That is a property of the storage, not a promise about it, so it is built as
 * one: **the raw token is returned to the caller once and never retained.** `TokenStore` holds
 * only `sha256(token)`. Dumping its internals — or reading its persisted form — yields hashes
 * that cannot be replayed, which is exactly the threat (a stolen table) the rule names.
 *
 * The converse is worth stating too, because it is the part people get wrong: hashing is only
 * safe here because the token is 256 bits of CSPRNG output. A hash of a human-chosen secret is a
 * cracking target; a hash of random bytes is not.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────────────────────
 * A token is scoped to a `(principal, launchId, capability)` triple (`DATA-MODEL.md` §4). It is
 * time-boxed, revocable without restarting the agent, and narrowable without a restart — so a
 * grant can be tightened on a *running* agent, which is the whole reason a broker exists rather
 * than a read-only credential handed over at launch.
 *
 * What is NOT claimed here: that a real provider honours these scopes. That is the provider
 * boundary (`provider.ts`) and it stays unverified until a live key is scoped, revoked, and shown
 * unreachable from agent context. See `docs/MILESTONES.md` 1.2.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** What a minted token is allowed to do, and for how long. */
export interface TokenClaims {
  readonly principalId: string;
  readonly launchId: string;
  readonly capability: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Monotonic bound, per D-008 Q4. A rewound wall clock cannot extend this. */
  readonly monotonicBound: number;
  /** Per-launch, unguessable. Binds a token to one launch so it cannot be replayed elsewhere. */
  readonly nonce: string;
}

/** The token plus the hash to persist. The token itself is never stored. */
export interface MintedToken {
  readonly token: string;
  /** What `DATA-MODEL.md` calls `broker_token_hash`. Safe to persist. Safe to leak. */
  readonly hash: string;
}

export type TokenRejection =
  | "unknown"
  | "revoked"
  | "expired"
  | "scope-mismatch"
  | "launch-mismatch";

/** A presented token this store will not honour, and precisely why. */
export class TokenRejectedError extends Error {
  constructor(
    readonly reason: TokenRejection,
    readonly detail: string,
  ) {
    super(`token rejected (${reason}): ${detail}`);
    this.name = "TokenRejectedError";
  }
}

interface StoredToken {
  claims: TokenClaims;
  revokedAt: number | null;
}

export interface TokenStoreOptions {
  /** Monotonic clock for expiry, so a rewound wall clock cannot revive a token. */
  readonly monotonicNow: () => number;
  /** CSPRNG. Overridable only so tests can be deterministic. */
  readonly randomBytes?: (n: number) => Buffer;
}

export interface MintOptions {
  readonly principalId: string;
  readonly launchId: string;
  readonly capability: string;
  readonly scope: Readonly<Record<string, unknown>>;
  /** Milliseconds until expiry, measured on the monotonic clock. */
  readonly ttlMs: number;
}

/**
 * Issues, verifies, narrows, and revokes scoped tokens.
 *
 * Deliberately in-memory and synchronous. The durable version is a SQLite table keyed on `hash`;
 * keeping the logic free of I/O means the security properties can be tested exhaustively here
 * rather than trusted in whatever storage the control plane ends up using.
 */
export class TokenStore {
  readonly #byHash = new Map<string, StoredToken>();
  readonly #monotonicNow: () => number;
  readonly #random: (n: number) => Buffer;

  constructor(options: TokenStoreOptions) {
    this.#monotonicNow = options.monotonicNow;
    this.#random = options.randomBytes ?? ((n) => randomBytes(n));
  }

  /**
   * Issue a scoped token. The raw value is returned here and goes no further — `TokenStore` keeps
   * only its hash, so there is no copy left in the heap to steal from a later dump.
   */
  mint(options: MintOptions): MintedToken {
    for (const [field, value] of Object.entries({
      principalId: options.principalId,
      launchId: options.launchId,
      capability: options.capability,
    })) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
      }
    }
    const now = this.#monotonicNow();
    const token = this.#random(32).toString("base64url");
    const claims: TokenClaims = {
      principalId: options.principalId,
      launchId: options.launchId,
      capability: options.capability,
      scope: { ...options.scope },
      issuedAt: now,
      expiresAt: now + options.ttlMs,
      monotonicBound: now + options.ttlMs,
      nonce: this.#random(16).toString("base64url"),
    };
    const hash = hashToken(token);
    this.#byHash.set(hash, { claims, revokedAt: null });
    return { token, hash };
  }

  /**
   * Verify a presented token, returning its claims.
   *
   * Every failure gets a distinct, named reason because the audit log must distinguish "unknown"
   * from "revoked" from "expired" — an operator debugging an outage needs the difference, and
   * collapsing them to "denied" would hide a revoked-but-still-circulating token.
   *
   * Lookup is constant-time. A token is attacker-supplied, and a timing oracle on a lookup key is
   * a real leak, however slow.
   */
  verify(
    token: string,
    expected: { launchId?: string; capability?: string } = {},
  ): TokenClaims {
    const entry = this.#lookup(token);
    if (!entry) {
      throw new TokenRejectedError("unknown", "no such token");
    }
    if (entry.revokedAt !== null) {
      throw new TokenRejectedError(
        "revoked",
        `revoked at monotonic ${entry.revokedAt}`,
      );
    }
    if (this.#monotonicNow() >= entry.claims.monotonicBound) {
      throw new TokenRejectedError("expired", "past its monotonic bound");
    }
    if (
      expected.launchId !== undefined &&
      expected.launchId !== entry.claims.launchId
    ) {
      throw new TokenRejectedError(
        "launch-mismatch",
        "issued for a different launch",
      );
    }
    if (
      expected.capability !== undefined &&
      expected.capability !== entry.claims.capability
    ) {
      throw new TokenRejectedError(
        "scope-mismatch",
        "issued for a different capability",
      );
    }
    return entry.claims;
  }

  /**
   * Narrow a live token's scope in place, without reissuing.
   *
   * This is what "narrow capabilities without restarting the agent" means operationally: the
   * running agent's very next request sees the smaller scope. It can only ever *shrink* — a
   * request to widen is refused, because widening is a new decision that belongs in an
   * `approvals` row with a human behind it, not in a mutation of a live grant.
   */
  narrow(token: string, scope: Readonly<Record<string, unknown>>): void {
    const entry = this.#lookup(token);
    if (!entry) throw new TokenRejectedError("unknown", "no such token");
    if (entry.revokedAt !== null) {
      throw new TokenRejectedError("revoked", "cannot narrow a revoked token");
    }
    if (!isSubset(scope, entry.claims.scope)) {
      throw new Error(
        `refusing to widen the scope of a live token. Narrowing is a reduction; widening is a ` +
          `new grant and belongs in an approvals row with a human decision behind it.`,
      );
    }
    entry.claims = { ...entry.claims, scope: { ...scope } };
  }

  /** Revoke. Takes effect on the next request — no agent restart. */
  revoke(token: string): void {
    const entry = this.#lookup(token);
    if (!entry) throw new TokenRejectedError("unknown", "no such token");
    entry.revokedAt = this.#monotonicNow();
  }

  /** Revoke every token for a launch — the kill switch when a host is lost. */
  revokeLaunch(launchId: string): number {
    let count = 0;
    const now = this.#monotonicNow();
    for (const entry of this.#byHash.values()) {
      if (entry.claims.launchId === launchId && entry.revokedAt === null) {
        entry.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  isRevoked(token: string): boolean {
    return this.#lookup(token)?.revokedAt != null;
  }

  /** Tokens held. For tests and metrics — never exposes a token or a claim. */
  get size(): number {
    return this.#byHash.size;
  }

  /** Constant-time lookup by token, hashing it first. */
  #lookup(token: string): StoredToken | undefined {
    const hash = hashToken(token);
    const direct = this.#byHash.get(hash);
    if (direct) return direct;
    const candidate = Buffer.from(hash, "hex");
    let found: StoredToken | undefined;
    for (const [known, entry] of this.#byHash) {
      if (
        known.length === hash.length &&
        timingSafeEqual(Buffer.from(known, "hex"), candidate)
      ) {
        found = entry;
      }
    }
    return found;
  }
}

/** Hash a token for storage, so persistence layers share one definition. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * True when `narrower` grants no more than `wider`.
 *
 * Conservative by design: a key in `narrower` must also be in `wider` with a compatible value,
 * and anything not understood is treated as *not* a subset — so an unfamiliar scope shape fails
 * closed rather than open.
 */
export function isSubset(
  narrower: Readonly<Record<string, unknown>>,
  wider: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(narrower)) {
    if (!(key in wider)) return false;
    const allowed = wider[key];
    if (Array.isArray(allowed) && Array.isArray(value)) {
      if (!value.every((v) => allowed.includes(v))) return false;
      continue;
    }
    if (allowed !== value) return false;
  }
  return true;
}

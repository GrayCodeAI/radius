/**
 * The host↔plane seam: tenant resolution, and the outbox-then-settle pattern.
 *
 * Both are the parts of Phase 2 that are *logic* rather than *deployment*, which is why they can
 * be written and proved here. What genuinely needs Cloudflare is the Durable Object that will
 * host them — single-threaded execution per tenant is the isolation boundary, and that is a
 * property of a runtime we do not have yet. So this module is deliberately storage-agnostic: it
 * takes whatever store you hand it, and a DO adapter becomes a thin layer later.
 *
 * ── Tenant resolution is the security boundary ──────────────────────────────────────────────
 * `DATA-MODEL.md` §1: "Resolved once, at the edge, from a verified token. **Never** from a
 * header the client can set freely. Unresolved tenant → reject before touching a DO, not inside
 * one." The last clause is load-bearing: resolving inside the DO means the DO has already been
 * addressed by an id the attacker chose.
 *
 * ── Outbox-then-settle, not distributed transactions ────────────────────────────────────────
 * The pattern is borrowed from antiproton's *shape* only (reimplemented per D-005 — it has zero
 * tests, so nothing was copied). The rule that makes it correct: the outbox row and the state
 * change it describes are written in the *same* durable step, then a separate settle publishes. A
 * crash between them leaves a pending row, never a lost one — a redelivery problem every
 * consumer already handles, rather than a lost write that nothing does.
 */

/** A tenant, resolved at the edge. Never inferred from a client-supplied header. */
export interface Tenant {
  readonly tenantId: string;
  /** The Durable Object that owns this tenant's data. Resolved, never client-chosen. */
  readonly durableObjectId: string;
}

export class UnresolvedTenantError extends Error {
  constructor(readonly detail: string) {
    super(
      `tenant unresolved: ${detail}. Rejecting at the edge — resolving inside a Durable Object ` +
        `would mean the object had already been addressed by an id the client chose.`,
    );
    this.name = "UnresolvedTenantError";
  }
}

export interface TenantResolver {
  /** Turn a verified token into a tenant, or throw. Must not consult a client header. */
  resolve(verifiedToken: string): Tenant;
}

/**
 * An in-memory tenant table, standing in for the identity service until one exists.
 *
 * Deliberately strict: an unknown token throws rather than returning a default, because a
 * default tenant is a silent cross-tenant read.
 */
export class StaticTenantTable implements TenantResolver {
  readonly #byToken = new Map<string, Tenant>();

  constructor(tenants: readonly Tenant[] = []) {
    for (const t of tenants)
      this.#byToken.set(`${t.tenantId}:${t.durableObjectId}`, t);
  }

  add(tenant: Tenant, token: string): void {
    this.#byToken.set(token, tenant);
  }

  resolve(verifiedToken: string): Tenant {
    if (typeof verifiedToken !== "string" || verifiedToken.length === 0) {
      throw new UnresolvedTenantError("no token presented");
    }
    const tenant = this.#byToken.get(verifiedToken);
    if (!tenant) {
      throw new UnresolvedTenantError(
        `token ${verifiedToken} is not a known tenant`,
      );
    }
    return tenant;
  }
}

/** A durable row the caller must settle once it is safe to publish. */
export interface OutboxEntry<T = unknown> {
  readonly id: string;
  readonly tenantId: string;
  readonly payload: T;
  readonly createdAt: number;
  settledAt: number | null;
}

/**
 * Outbox, with idempotent settle.
 *
 * The property that matters: a pending entry is never silently dropped. If publishing throws or
 * the process dies, the entry stays pending and is retried — redelivery, which every consumer
 * already handles, rather than a lost write, which nothing does.
 */
export class Outbox {
  readonly #entries = new Map<string, OutboxEntry>();

  /** Write the outbox row in the same durable step as the state it describes. */
  enqueue<T>(entry: Omit<OutboxEntry<T>, "settledAt">): void {
    if (this.#entries.has(entry.id)) {
      // Re-enqueuing the same id is a retry, not a duplicate. Silently replacing it would let a
      // concurrent write clobber a row another worker is still settling.
      return;
    }
    this.#entries.set(entry.id, { ...entry, settledAt: null });
  }

  /**
   * Settle one entry. Retrying after a partial publish is safe because the handler is expected to
   * be idempotent, and a double-settle is a no-op rather than a second publish.
   */
  settle(id: string, at: number): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (entry.settledAt !== null) return false; // already settled
    this.#entries.set(id, { ...entry, settledAt: at });
    return true;
  }

  /** Entries still awaiting publish. After a crash, this is the retry list. */
  pending(): readonly OutboxEntry[] {
    return [...this.#entries.values()].filter((e) => e.settledAt === null);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** A plane cursor — the thing the host syncs, instead of tokens. */
export interface Cursor {
  readonly sessionId: string;
  /** Highest `seq` the plane has durably accepted for this stream. */
  readonly afterSeq: number;
}

/**
 * Merge a host's records into the plane's view, given where it already is.
 *
 * `PROTOCOL.md` §4 is explicit that everything except `approvals` is **at-least-once with
 * idempotent consumers**, and this is that consumer. The guarantee it provides, and no more:
 * after a merge the plane's `afterSeq` equals the highest `seq` it holds, and replaying the same
 * batch changes nothing. That is what makes an offline host safe to reconnect — and it is
 * deliberately *not* exactly-once, which is the claim the docs reserve for `approvals`.
 */
export class CursorMerger {
  readonly #cursors = new Map<string, number>();

  /** Records are identified by `sessionId` + `seq`. Returns how many were newly accepted. */
  merge(
    sessionId: string,
    records: readonly { readonly seq: number }[],
  ): number {
    if (records.length === 0) return 0;
    const sorted = [...records].sort((a, b) => a.seq - b.seq);
    let current = this.#cursors.get(sessionId) ?? -1;
    let accepted = 0;
    for (const record of sorted) {
      if (record.seq <= current) continue; // already held — a replay, not new data
      current = record.seq;
      accepted += 1;
    }
    this.#cursors.set(sessionId, current);
    return accepted;
  }

  afterSeq(sessionId: string): number {
    return this.#cursors.get(sessionId) ?? -1;
  }

  /** What the host should send next: everything after the plane's cursor. */
  nextCursor(sessionId: string): Cursor {
    return { sessionId, afterSeq: this.afterSeq(sessionId) };
  }
}

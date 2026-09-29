/**
 * Capability decisions, and the audit trail they produce.
 *
 * Two deliberate properties, both of which are the difference between a control and a comment:
 *
 * 1. **Deny by default.** `CapabilityPolicy.decide` returns `denied` for anything not explicitly
 *    granted. There is no "unknown capability → allow" path, and no wildcard that means "all".
 *    A capability this module has never heard of is refused, which is the only safe default for
 *    something whose whole purpose is to bound what a compromised agent can reach.
 *
 * 2. **Every decision is audited, including denials.** Not just grants. A refused capability is
 *    the most interesting thing that can happen — it is what a prompt injection looks like from
 *    the inside — so the audit is written on the deny path too. An audit log that only records
 *    successes is a log that shows you nothing when something goes wrong.
 *
 * The log records the *decision*, never the credential. `AuditEntry` has no field that could hold
 * one, and the secret-shape scan in `test/` asserts it.
 */

import { isSubset } from "./token.ts";

export type Decision = "allowed" | "denied";

export interface CapabilityRequest {
  readonly principalId: string;
  readonly capability: string;
  /** What the agent is actually asking for, e.g. `{ repos: ["api"] }`. */
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface Grant {
  readonly principalId: string;
  readonly capability: string;
  readonly scope: Readonly<Record<string, unknown>>;
  /** A human, always (D-014). An agent approving its own escalation is the thing we forbid. */
  readonly grantedBy: string;
  readonly grantedByKind: "human" | "agent" | "service";
  readonly expiresAt: number;
}

export interface AuditEntry {
  readonly at: number;
  readonly principalId: string;
  readonly capability: string;
  readonly requestedScope: Readonly<Record<string, unknown>>;
  readonly decision: Decision;
  /** Why it was refused, when it was. Null on allow. */
  readonly reason: string | null;
  readonly launchId: string | null;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly reason: string | null;
  readonly audit: AuditEntry;
}

export class ApprovalNotHumanError extends Error {
  constructor(
    readonly grantedBy: string,
    readonly kind: string,
  ) {
    super(
      `refusing a grant decided by a ${kind} (${grantedBy}). D-014: only a human may approve an ` +
        `escalation — an agent able to approve its own is privilege escalation within a tenant.`,
    );
    this.name = "ApprovalNotHumanError";
  }
}

/**
 * Deny-by-default capability policy, with an audit trail.
 *
 * In-memory and synchronous by design, like the lease manager: the logic is the product, and it
 * should be provable without a database. The control plane persists `grants`; this decides.
 */
export class CapabilityPolicy {
  readonly #grants: Grant[] = [];
  readonly #audit: AuditEntry[] = [];

  /**
   * Record a grant. Rejects a non-human decider outright (D-014) — this is a check constraint in
   * the schema, and enforcing it here too means a caller cannot bypass it by skipping the table.
   */
  grant(grant: Grant): void {
    if (grant.grantedByKind !== "human") {
      throw new ApprovalNotHumanError(grant.grantedBy, grant.grantedByKind);
    }
    this.#grants.push(grant);
  }

  revokeAll(principalId: string): number {
    let removed = 0;
    for (let i = this.#grants.length - 1; i >= 0; i--) {
      const g = this.#grants[i];
      if (g?.principalId === principalId) {
        this.#grants.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Decide one request, and audit the outcome either way.
   *
   * Order matters: expiry is checked before scope, so an expired grant reports as expired rather
   * than as a scope problem. An operator reading the audit trail should see the real reason.
   */
  decide(
    request: CapabilityRequest,
    now: number,
    launchId: string | null = null,
  ): DecisionResult {
    const record = (
      decision: Decision,
      reason: string | null,
    ): DecisionResult => {
      const audit: AuditEntry = {
        at: now,
        principalId: request.principalId,
        capability: request.capability,
        requestedScope: { ...request.scope },
        decision,
        reason,
        launchId,
      };
      this.#audit.push(audit);
      return { decision, reason, audit };
    };

    const candidates = this.#grants.filter(
      (g) =>
        g.principalId === request.principalId &&
        g.capability === request.capability,
    );
    if (candidates.length === 0) {
      // Deny by default, and say so plainly — "no such capability" is the common case and an
      // operator needs to see that it is a refusal, not a lookup miss.
      return record(
        "denied",
        "no grant exists for this principal and capability",
      );
    }

    const live = candidates.filter((g) => g.expiresAt > now);
    if (live.length === 0) {
      return record("denied", "every grant for this capability has expired");
    }

    const permitted = live.some((g) => isSubset(request.scope, g.scope));
    if (!permitted) {
      return record("denied", "requested scope exceeds every live grant");
    }
    return record("allowed", null);
  }

  /** The audit trail, oldest first. */
  entries(): readonly AuditEntry[] {
    return this.#audit;
  }

  /** Requests refused since start. The number an operator watches. */
  get denialCount(): number {
    return this.#audit.filter((e) => e.decision === "denied").length;
  }
}

/**
 * The approvals table — the one place Radius claims **exactly-once** delivery.
 *
 * D-013 and `PROTOCOL.md` §4 both say the same thing: `approvals.request_id` carries a unique
 * index, so a replayed decision is an idempotent no-op *by construction*. Everything else on the
 * wire is at-least-once with idempotent consumers, and the docs are emphatic that the difference
 * must not be blurred — "do not put 'exactly-once' in the marketing for anything but approvals".
 *
 * So the mechanism is small and the property is structural: a decision is keyed by a
 * client-supplied `requestId`, and replaying one returns the *original* decision rather than
 * recording a second one. A genuinely conflicting replay — same `requestId`, different content —
 * is refused rather than silently overwritten, because "the human approved X but the replay says
 * Y" is exactly the bug a unique index exists to surface.
 */

export type ApprovalOutcome = "approved" | "denied";

export interface ApprovalRequest {
  /** Client-supplied UUID. The idempotency key, and the entire mechanism behind exactly-once. */
  readonly requestId: string;
  readonly principalId: string;
  readonly capability: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly requestedAt: number;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly outcome: ApprovalOutcome;
  /** MUST be a human. D-014: an agent approving its own escalation is the attack. */
  readonly decidedBy: string;
  readonly decidedByKind: "human" | "agent" | "service";
  readonly decidedAt: number;
  /** Free-text reason. Required on a denial, so a refusal is never anonymous. */
  readonly reason: string | null;
}

export type SubmitResult =
  | { readonly kind: "recorded"; readonly decision: ApprovalDecision }
  | {
      /** Same requestId, same content — a client retry. The original decision is returned. */
      readonly kind: "replayed";
      readonly decision: ApprovalDecision;
    };

/** The same requestId was replayed with different content. Never silently overwrite. */
export class ApprovalConflictError extends Error {
  constructor(readonly requestId: string) {
    super(
      `request "${requestId}" was replayed with different content. A unique index would reject ` +
        `this, and so does this: overwriting would mean an agent could re-approve a decision it ` +
        `was not granted.`,
    );
    this.name = "ApprovalConflictError";
  }
}

/** A non-human tried to decide. D-014. */
export class NonHumanDecisionError extends Error {
  constructor(
    readonly requestId: string,
    readonly kind: string,
  ) {
    super(
      `approval "${requestId}" was decided by a ${kind}. Only a human may approve an escalation — ` +
        `an agent able to approve its own is privilege escalation within a single tenant (D-014).`,
    );
    this.name = "NonHumanDecisionError";
  }
}

/** A denial with no reason. A refusal an operator cannot explain is not a usable refusal. */
export class MissingDenialReasonError extends Error {
  constructor(readonly requestId: string) {
    super(
      `approval "${requestId}" was denied with no reason. A refusal nobody can explain is not a ` +
        `usable refusal — record why.`,
    );
    this.name = "MissingDenialReasonError";
  }
}

function sameRequest(a: ApprovalRequest, b: ApprovalRequest): boolean {
  return (
    a.principalId === b.principalId &&
    a.capability === b.capability &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope)
  );
}

export class ApprovalsStore {
  readonly #byRequestId = new Map<
    string,
    { request: ApprovalRequest; decision: ApprovalDecision }
  >();

  /**
   * Record a decision, or return the original if this is a client retry.
   *
   * This is the exactly-once claim, and it is a property of the data structure rather than of
   * how carefully the caller behaves. Two concurrent retries of the same `requestId` cannot
   * produce two rows, because there is one slot keyed by it.
   */
  submit(request: ApprovalRequest, decision: ApprovalDecision): SubmitResult {
    if (decision.decidedByKind !== "human") {
      throw new NonHumanDecisionError(
        request.requestId,
        decision.decidedByKind,
      );
    }
    if (decision.outcome === "denied" && !decision.reason) {
      throw new MissingDenialReasonError(request.requestId);
    }

    const existing = this.#byRequestId.get(request.requestId);
    if (existing) {
      if (!sameRequest(existing.request, request)) {
        throw new ApprovalConflictError(request.requestId);
      }
      // Same request, same id: a retry. Return what was already decided, unchanged.
      return { kind: "replayed", decision: existing.decision };
    }

    this.#byRequestId.set(request.requestId, { request, decision });
    return { kind: "recorded", decision };
  }

  get(requestId: string): ApprovalDecision | null {
    return this.#byRequestId.get(requestId)?.decision ?? null;
  }

  has(requestId: string): boolean {
    return this.#byRequestId.has(requestId);
  }

  /** Total decisions recorded. A replay must not increase this. */
  get size(): number {
    return this.#byRequestId.size;
  }

  entries(): readonly {
    request: ApprovalRequest;
    decision: ApprovalDecision;
  }[] {
    return [...this.#byRequestId.values()];
  }
}

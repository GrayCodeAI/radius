/**
 * Approvals (D-013) and hard spend caps (the Phase 4 gate).
 *
 * Both are easy to claim and easy to quietly break, so the tests assert the *mechanism* —
 * exactly-once by construction, and `committed + reserved <= cap` — rather than an outcome that
 * happens to imply it.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ApprovalsStore,
  ApprovalConflictError,
  MissingDenialReasonError,
  NonHumanDecisionError,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../src/approvals.ts";
import { BudgetExceededError, CostLedger } from "../src/budget.ts";

const request = (id = "req_1"): ApprovalRequest => ({
  requestId: id,
  principalId: "pr_1",
  capability: "net:egress",
  scope: { hosts: ["api.example.com"] },
  requestedAt: 1000,
});

const decision = (over: Partial<ApprovalDecision> = {}): ApprovalDecision => ({
  requestId: "req_1",
  outcome: "approved",
  decidedBy: "pr_human",
  decidedByKind: "human",
  decidedAt: 1001,
  reason: null,
  ...over,
});

describe("Approvals — exactly-once, by construction (D-013)", () => {
  test("a first decision is recorded", () => {
    const store = new ApprovalsStore();
    assert.equal(store.submit(request(), decision()).kind, "recorded");
    assert.equal(store.size, 1);
  });

  test("a client retry returns the original and does not add a row", () => {
    // This IS the exactly-once claim. Not "we are careful" — there is one slot keyed by
    // requestId, so a retry physically cannot produce a second row.
    const store = new ApprovalsStore();
    const first = store.submit(request(), decision({ decidedAt: 1001 }));
    const second = store.submit(request(), decision({ decidedAt: 9999 }));

    assert.equal(second.kind, "replayed");
    assert.equal(store.size, 1, "a retry must not grow the table");
    assert.equal(
      store.get("req_1")?.decidedAt,
      1001,
      "the original stands unchanged",
    );
    assert.equal(second.decision.decidedAt, first.decision.decidedAt);
  });

  test("many concurrent retries still produce exactly one row", () => {
    const store = new ApprovalsStore();
    for (let i = 0; i < 50; i++)
      store.submit(request(), decision({ decidedAt: 1000 + i }));
    assert.equal(store.size, 1);
  });

  test("a replay with different content is refused, not overwritten", () => {
    // The dangerous case: same requestId, different scope. Overwriting would let an agent
    // re-approve a decision it was never granted.
    const store = new ApprovalsStore();
    store.submit(request(), decision());
    assert.throws(
      () =>
        store.submit(
          { ...request(), scope: { hosts: ["evil.example.com"] } },
          decision(),
        ),
      ApprovalConflictError,
    );
    assert.deepEqual(
      store.get("req_1")?.outcome,
      "approved",
      "the original is intact",
    );
  });

  test("a different capability under the same requestId is a conflict", () => {
    const store = new ApprovalsStore();
    store.submit(request(), decision());
    assert.throws(
      () => store.submit({ ...request(), capability: "fs:write" }, decision()),
      ApprovalConflictError,
    );
  });

  test("an agent cannot decide its own escalation (D-014)", () => {
    const store = new ApprovalsStore();
    assert.throws(
      () =>
        store.submit(
          request(),
          decision({ decidedByKind: "agent", decidedBy: "pr_1" }),
        ),
      NonHumanDecisionError,
    );
    assert.equal(store.size, 0, "a refused decision leaves no row");
  });

  test("a service cannot decide either", () => {
    const store = new ApprovalsStore();
    assert.throws(
      () => store.submit(request(), decision({ decidedByKind: "service" })),
      NonHumanDecisionError,
    );
  });

  test("a denial with no reason is refused", () => {
    // A refusal an operator cannot explain is not a usable refusal.
    const store = new ApprovalsStore();
    assert.throws(
      () =>
        store.submit(request(), decision({ outcome: "denied", reason: null })),
      MissingDenialReasonError,
    );
  });

  test("a denial with a reason is recorded", () => {
    const store = new ApprovalsStore();
    store.submit(
      request(),
      decision({ outcome: "denied", reason: "unexpected egress" }),
    );
    assert.equal(store.get("req_1")?.reason, "unexpected egress");
  });
});

describe("CostLedger — a hard cap under fault injection", () => {
  const ledger = (cap = 100) =>
    new CostLedger({ capMinor: cap, currency: "usd" });

  test("a turn within the cap is allowed and settles", () => {
    const l = ledger(100);
    const r = l.reserve("pr_1", 60, 1);
    l.settle(r.id, 45);
    assert.equal(l.committedFor("pr_1"), 45);
    assert.equal(l.available("pr_1"), 55, "unused headroom returns");
  });

  test("spending past the cap is refused", () => {
    const l = ledger(100);
    const r = l.reserve("pr_1", 100, 1);
    l.settle(r.id, 100);
    assert.throws(() => l.reserve("pr_1", 1, 2), BudgetExceededError);
  });

  test("two concurrent reservations cannot together cross the cap", () => {
    // The race the gate warns about. Checking only `committed` would let both through.
    const l = ledger(100);
    const a = l.reserve("pr_1", 60, 1);
    assert.throws(
      () => l.reserve("pr_1", 60, 2),
      BudgetExceededError,
      "the second reservation sees the first one's headroom",
    );
    l.settle(a.id, 60);
  });

  test("a retry that settles twice is charged once", () => {
    // "A provider that fails after accepting has already billed it" — the failure mode that
    // makes naive caps overshoot. A repeated settlement must not double-charge.
    const l = ledger(100);
    const r = l.reserve("pr_1", 50, 1);
    l.settle(r.id, 40);
    l.settle(r.id, 40);
    assert.equal(
      l.committedFor("pr_1"),
      40,
      "a repeated settlement is a no-op",
    );
  });

  test("a partial result returns the unused headroom", () => {
    const l = ledger(100);
    const r = l.reserve("pr_1", 80, 1);
    l.settle(r.id, 10);
    assert.equal(
      l.available("pr_1"),
      90,
      "70 of reservation went back to the budget",
    );
  });

  test("an actual cost above the reservation is refused, not absorbed", () => {
    // If the real cost exceeds what we reserved, the cap has already been crossed. Saying so is
    // the honest outcome; quietly over-committing is how a "hard cap" becomes a soft one.
    const l = ledger(100);
    const r = l.reserve("pr_1", 10, 1);
    assert.throws(() => l.settle(r.id, 50), BudgetExceededError);
    assert.equal(l.committedFor("pr_1"), 0, "nothing was committed");
  });

  test("a crash between reserve and send does not leak headroom", () => {
    // Without release(), a reservation would sit forever and the agent would stop working with
    // budget still available — the opposite failure, and just as bad.
    const l = ledger(100);
    const a = l.reserve("pr_1", 90, 1);
    assert.equal(l.available("pr_1"), 10);
    l.release(a.id);
    assert.equal(l.available("pr_1"), 100, "the headroom came back");
    assert.equal(l.openReservations, 0);
  });

  test("committed + reserved never exceeds the cap, across a mixed run", () => {
    // The invariant itself, asserted directly rather than inferred from any single outcome.
    const l = ledger(100);
    for (let i = 0; i < 20; i++) {
      const bound = 10 + ((i * 7) % 40);
      try {
        const r = l.reserve("pr_1", bound, i);
        l.settle(r.id, Math.floor(bound / 2));
      } catch {
        /* a refusal is a valid outcome here */
      }
      assert.ok(
        l.committedFor("pr_1") + l.reservedFor("pr_1") <= l.capMinor,
        "committed + reserved must never exceed the cap",
      );
    }
  });

  test("budgets are per principal", () => {
    const l = ledger(100);
    const r = l.reserve("pr_1", 100, 1);
    l.settle(r.id, 100);
    assert.doesNotThrow(
      () => l.reserve("pr_2", 100, 2),
      "pr_2 has its own budget",
    );
  });

  test("a negative or fractional amount is refused", () => {
    const l = ledger(100);
    assert.throws(() => l.reserve("pr_1", -1, 1), /non-negative/);
    assert.throws(() => l.reserve("pr_1", 1.5, 1), /non-negative/);
  });

  test("an unknown reservation cannot be settled or released", () => {
    const l = ledger(100);
    assert.throws(() => l.settle("nope", 1), /no such reservation/);
    assert.throws(() => l.release("nope"), /no such reservation/);
  });
});

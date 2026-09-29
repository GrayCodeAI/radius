/**
 * Phase 2 logic: tenant resolution, outbox-then-settle, and cursor merge.
 *
 * This is the part of the control plane that is *logic* rather than *deployment*. It is fully
 * tested here; what is NOT tested — and cannot be without Cloudflare — is the Durable Object
 * that will host it, since single-threaded-per-tenant execution is the actual isolation boundary.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  CursorMerger,
  Outbox,
  StaticTenantTable,
  UnresolvedTenantError,
} from "../src/sync.ts";

const tenant = { tenantId: "t_a", durableObjectId: "do_1" };

describe("Tenant resolution — the edge, never a client header", () => {
  test("a known token resolves to its tenant and durable object", () => {
    const table = new StaticTenantTable();
    table.add(tenant, "token-a");
    assert.deepEqual(table.resolve("token-a"), tenant);
  });

  test("an unknown token is rejected, never defaulted", () => {
    // A default tenant would be a silent cross-tenant read — the exact thing §1 forbids.
    const table = new StaticTenantTable();
    table.add(tenant, "token-a");
    assert.throws(() => table.resolve("token-b"), UnresolvedTenantError);
  });

  test("an empty or absent token is rejected", () => {
    const table = new StaticTenantTable();
    assert.throws(() => table.resolve(""), UnresolvedTenantError);
    assert.throws(
      () => table.resolve(undefined as unknown as string),
      UnresolvedTenantError,
    );
  });

  test("the rejection says it happens at the edge", () => {
    // The message is the record of *why* this is checked here and not inside the DO.
    const table = new StaticTenantTable();
    assert.throws(() => table.resolve("nope"), /before the object|at the edge/);
  });

  test("two tenants get two distinct durable objects", () => {
    const table = new StaticTenantTable();
    table.add({ tenantId: "t_a", durableObjectId: "do_1" }, "token-a");
    table.add({ tenantId: "t_b", durableObjectId: "do_2" }, "token-b");
    assert.notEqual(
      table.resolve("token-a").durableObjectId,
      table.resolve("token-b").durableObjectId,
    );
  });
});

describe("Outbox — a pending row is never lost", () => {
  const entry = (id: string) => ({
    id,
    tenantId: "t_a",
    payload: { n: 1 },
    createdAt: 100,
  });

  test("an enqueued entry is pending until settled", () => {
    const box = new Outbox();
    box.enqueue(entry("e1"));
    assert.equal(box.pending().length, 1);
    assert.equal(box.settle("e1", 200), true);
    assert.equal(box.pending().length, 0);
  });

  test("a second settle is a no-op, not a second publish", () => {
    const box = new Outbox();
    box.enqueue(entry("e1"));
    box.settle("e1", 200);
    assert.equal(
      box.settle("e1", 300),
      false,
      "retrying a settle must not republish",
    );
    assert.equal(box.size, 1);
  });

  test("re-enqueuing the same id does not duplicate or clobber", () => {
    const box = new Outbox();
    box.enqueue(entry("e1"));
    box.enqueue({ ...entry("e1"), payload: { n: 999 } });
    assert.equal(box.size, 1);
    const kept = box.pending()[0];
    assert.deepEqual(
      kept?.payload,
      { n: 1 },
      "the original payload is not overwritten",
    );
  });

  test("a crash before settle leaves the entry on the retry list", () => {
    // The whole point: redelivery, not loss.
    const box = new Outbox();
    box.enqueue(entry("e1"));
    assert.equal(
      box.pending().length,
      1,
      "an unsettled entry survives for retry",
    );
  });

  test("settling an unknown entry reports false rather than throwing", () => {
    assert.equal(new Outbox().settle("nope", 1), false);
  });
});

describe("CursorMerger — at-least-once, idempotent", () => {
  const batch = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i }));

  test("a first batch is fully accepted", () => {
    const m = new CursorMerger();
    assert.equal(m.merge("s1", batch(0, 4)), 5);
    assert.equal(m.afterSeq("s1"), 4);
  });

  test("a replayed batch changes nothing", () => {
    // Deliberately NOT exactly-once — PROTOCOL.md reserves that for approvals. This is the
    // at-least-once with an idempotent consumer, which is what the stream path is.
    const m = new CursorMerger();
    m.merge("s1", batch(0, 4));
    assert.equal(
      m.merge("s1", batch(0, 4)),
      0,
      "a full replay accepts nothing new",
    );
    assert.equal(m.afterSeq("s1"), 4);
  });

  test("an overlapping batch accepts only the new tail", () => {
    const m = new CursorMerger();
    m.merge("s1", batch(0, 4));
    assert.equal(
      m.merge("s1", batch(3, 8)),
      4,
      "seq 3 and 4 were already held",
    );
    assert.equal(m.afterSeq("s1"), 8);
  });

  test("out-of-order delivery is accepted correctly", () => {
    // A host reconnecting may replay in any order; the cursor is by seq, not arrival.
    const m = new CursorMerger();
    assert.equal(m.merge("s1", [{ seq: 3 }, { seq: 1 }, { seq: 2 }]), 3);
    assert.equal(
      m.afterSeq("s1"),
      3,
      "the highest seq, regardless of arrival order",
    );
  });

  test("sessions are independent", () => {
    const m = new CursorMerger();
    m.merge("s1", batch(0, 4));
    assert.equal(m.merge("s2", batch(0, 2)), 3, "s2 has its own cursor");
    assert.equal(m.afterSeq("s1"), 4);
  });

  test("an empty batch is a no-op", () => {
    const m = new CursorMerger();
    assert.equal(m.merge("s1", []), 0);
    assert.equal(m.afterSeq("s1"), -1);
  });

  test("nextCursor tells the host exactly where to resume", () => {
    const m = new CursorMerger();
    m.merge("s1", batch(0, 9));
    assert.deepEqual(m.nextCursor("s1"), { sessionId: "s1", afterSeq: 9 });
  });

  test("resuming from a cursor delivers the remainder with no gap", () => {
    // The offline-host loop: sync, go away, come back, resume.
    const m = new CursorMerger();
    m.merge("s1", batch(0, 4));
    const { afterSeq } = m.nextCursor("s1");
    const resumed = batch(afterSeq + 1, 9);
    assert.equal(
      m.merge("s1", resumed),
      5,
      "exactly the records after the cursor",
    );
    assert.equal(m.afterSeq("s1"), 9);
  });
});

/**
 * Lease semantics — the properties `MILESTONES.md` 1.4 lists, each mapped to the invariant it
 * now enforces in code rather than in prose.
 *
 *   I3  an expired lease is refused
 *   I5  a stale lease epoch is rejected on every write
 *   I14 a monotonic lease is not extended by wall-clock rollback
 *
 * Time is injected, never slept on. These are logic tests about an authority's clock, and a test
 * that waits 60 seconds to observe an hour-long TTL has proved nothing except that it is slow.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  LeaseExpiredError,
  LeaseHeldError,
  LeaseManager,
  MonotonicClock,
  StaleEpochError,
  type MonotonicSource,
} from "../src/lease.ts";

/** A monotonic source the test drives by hand. */
class FakeMonotonic implements MonotonicSource {
  #t = 0;
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}

function setup(ttlMs = 1000) {
  const source = new FakeMonotonic();
  // A wall clock the test can move BACKWARDS, which is the whole attack D-008 Q4 describes.
  let wall = 1_700_000_000_000;
  const clock = new MonotonicClock({ source, wallNow: () => wall });
  const leases = new LeaseManager({ clock, ttlMs });
  return {
    source,
    leases,
    clock,
    setWall: (v: number) => {
      wall = v;
    },
  };
}

describe("LeaseManager — exclusivity", () => {
  test("one controller per resource; a second acquire is refused", () => {
    // MILESTONES 1.4: "One controller per session; leases are the exclusive claim".
    const { leases } = setup();
    leases.acquire("session:a", "host-1");
    assert.throws(() => leases.acquire("session:a", "host-2"), LeaseHeldError);
  });

  test("the epoch increments on every acquisition", () => {
    const { leases, source } = setup(100);
    assert.equal(leases.acquire("session:a", "host-1").epoch, 1);
    source.advance(200); // lease 1 expires
    assert.equal(
      leases.acquire("session:a", "host-2").epoch,
      2,
      "takeover must bump the epoch",
    );
  });

  test("a dead holder can be taken over once its lease expires", () => {
    const { leases, source } = setup(100);
    leases.acquire("session:a", "host-dead");
    source.advance(101);
    const taken = leases.acquire("session:a", "host-live");
    assert.equal(taken.holderId, "host-live");
  });
});

describe("LeaseManager — I5: fencing rejects a partitioned holder", () => {
  test("a stale epoch is rejected on every write, forever", () => {
    // This is the split-brain test. The partitioned holder is NOT aware it lost the lease — from
    // its side everything looks fine. Only the epoch check stops it. Reasoning about why this
    // works proves nothing; the assertion does.
    const { leases, source } = setup(100);
    const stale = leases.acquire("session:a", "host-1");

    source.advance(101);
    const live = leases.acquire("session:a", "host-2");

    // The new holder can write.
    assert.equal(
      leases.assertWritable("session:a", "host-2", live.epoch).epoch,
      2,
    );

    // The partitioned holder still believes it owns the lease, and is refused anyway.
    assert.throws(
      () => leases.assertWritable("session:a", "host-1", stale.epoch),
      StaleEpochError,
    );
    // ...and stays refused, however many times it retries.
    for (let i = 0; i < 5; i++) {
      assert.throws(
        () => leases.assertWritable("session:a", "host-1", stale.epoch),
        StaleEpochError,
      );
    }
  });

  test("a stale holder cannot renew, release, or extend the new holder's lease", () => {
    const { leases, source } = setup(100);
    const stale = leases.acquire("session:a", "host-1");
    source.advance(101);
    const live = leases.acquire("session:a", "host-2");

    assert.ok(
      live.epoch > stale.epoch,
      "a takeover strictly raises the epoch — that is the fencing token",
    );
    assert.throws(
      () => leases.renew("session:a", "host-1", stale.epoch),
      StaleEpochError,
    );

    describe("LeaseManager — I3: expiry", () => {
      test("an expired lease is refused on write", () => {
        const { leases, source } = setup(100);
        const lease = leases.acquire("session:a", "host-1");
        assert.ok(leases.assertWritable("session:a", "host-1", lease.epoch));
        source.advance(101);
        assert.throws(
          () => leases.assertWritable("session:a", "host-1", lease.epoch),
          LeaseExpiredError,
        );
      });

      test("an expired lease does not report as current", () => {
        // Reporting an expired lease as live is how a second controller convinces itself it may
        // write. The authority's view must say "nothing here".
        const { leases, source } = setup(100);
        leases.acquire("session:a", "host-1");
        assert.ok(leases.current("session:a"), "live while held");
        source.advance(101);
        assert.equal(leases.current("session:a"), null, "gone once expired");
      });
    });

    describe("LeaseManager — I14: clock rollback cannot extend a lease", () => {
      test("moving the wall clock BACKWARDS does not revive an expired lease", () => {
        // The attack D-008 Q4 describes, executed: the user owns the wall clock. Expiry is computed
        // from the monotonic source, which they cannot reach, so the lease stays dead.
        const { leases, source, setWall } = setup(1000);
        const lease = leases.acquire("session:a", "host-1");

        source.advance(1001); // monotonic time passes; lease expires
        assert.throws(
          () => leases.assertWritable("session:a", "host-1", lease.epoch),
          LeaseExpiredError,
        );

        // Now rewind the wall clock a year. A wall-clock lease would spring back to life here.
        setWall(1_600_000_000_000);
        assert.throws(
          () => leases.assertWritable("session:a", "host-1", lease.epoch),
          LeaseExpiredError,
          "a rewound wall clock must not resurrect an expired lease",
        );
      });

      test("a lease taken AFTER the rollback is still bounded by monotonic time", () => {
        const { leases, source, setWall } = setup(1000);
        setWall(1_600_000_000_000);
        const lease = leases.acquire("session:a", "host-1");
        source.advance(1001);
        assert.throws(
          () => leases.assertWritable("session:a", "host-1", lease.epoch),
          LeaseExpiredError,
        );
      });
    });

    describe("MonotonicClock — survives a restart", () => {
      test("monotonic time is continuous across a restart", () => {
        // D-008: "Restarting the process resets the monotonic clock, so the reconciliation must be
        // re-derived from persisted state." A live lease must NOT expire merely because the host
        // restarted.
        const source = new FakeMonotonic();
        const first = new MonotonicClock({ source });

        source.advance(30_000); // 30s elapse in process one
        const persisted = first.anchor();
        assert.ok(
          persisted.monotonicAt >= 30_000,
          "time advanced before the restart",
        );

        // Process two: a fresh clock whose source has reset to zero, as hrtime does.
        const restarted = new MonotonicClock({
          source: { now: () => 0 },
          anchor: persisted,
        });
        assert.equal(
          restarted.now(),
          persisted.monotonicAt,
          "resumes exactly where it left off",
        );
      });

      test("a lease still live before a restart is still live after it", () => {
        // The property a restart must not break: a 10s lease with 1s consumed is not suddenly dead
        // because the process bounced. Without the anchor being restored, hrtime resets to ~0 and
        // every live lease looks centuries old.
        const source = new FakeMonotonic();
        const before = new LeaseManager({
          clock: new MonotonicClock({ source }),
          ttlMs: 10_000,
        });
        const lease = before.acquire("session:a", "host-1");
        source.advance(1_000);

        // Process two: a fresh source that has reset, plus the persisted state.
        const restartedSource = new FakeMonotonic();
        const after = new LeaseManager({
          clock: new MonotonicClock({ source: restartedSource }),
          ttlMs: 10_000,
        });
        after.restore(
          before.entries(),
          before.entries().length
            ? clockAnchorOf(before)
            : { monotonicAt: 0, wallAt: 0 },
        );

        assert.ok(
          after.current("session:a"),
          "a lease that was live before the restart is still live after it",
        );
        assert.equal(
          after.current("session:a")?.epoch,
          lease.epoch,
          "the epoch is preserved",
        );
      });

      test("a lease whose window elapsed BEFORE the restart is expired after it", () => {
        // D-008 Q4's explicit case: "if the persisted state shows the monotonic window has already
        // elapsed, the lease is expired regardless of the wall clock." Here the wall clock will claim
        // the lease is young. Restore must not believe it.
        const source = new FakeMonotonic();
        const before = new LeaseManager({
          clock: new MonotonicClock({ source }),
          ttlMs: 5_000,
        });
        before.acquire("session:a", "host-1");
        const persisted = before.entries()[0];
        assert.ok(persisted);

        source.advance(6_000); // it expires while the process is alive
        const anchor = { monotonicAt: persisted.expiresAt, wallAt: 0 };

        const after = new LeaseManager({
          clock: new MonotonicClock({ source: { now: () => 0 } }),
          ttlMs: 5_000,
        });
        after.restore([persisted], anchor);

        assert.equal(
          after.current("session:a"),
          null,
          "a lease whose window elapsed is dropped on restart, not revived",
        );
      });
    });

    /** The anchor a live LeaseManager would persist alongside its leases. */
    function clockAnchorOf(manager: LeaseManager): {
      monotonicAt: number;
      wallAt: number;
    } {
      const leases = manager.entries();
      const earliest = leases.reduce(
        (min, l) => Math.min(min, l.acquiredAt),
        Infinity,
      );
      return {
        monotonicAt: Number.isFinite(earliest) ? earliest : 0,
        wallAt: 0,
      };
    }

    assert.throws(
      () => leases.release("session:a", "host-1", stale.epoch),
      StaleEpochError,
    );
    assert.equal(
      leases.current("session:a")?.epoch,
      2,
      "the live lease is untouched",
    );
    assert.equal(leases.current("session:a")?.holderId, "host-2");
  });

  test("a holder cannot write under another holder's epoch", () => {
    const { leases } = setup();
    const lease = leases.acquire("session:a", "host-1");
    assert.throws(
      () => leases.assertWritable("session:a", "host-2", lease.epoch),
      LeaseHeldError,
      "a correct epoch on the wrong holder is still refused",
    );
  });
});

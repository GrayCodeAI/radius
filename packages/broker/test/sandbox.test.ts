/**
 * Sandbox policy — deny by default, and never claim isolation that was not measured.
 *
 * The second half is the one that matters. It is easy to write a module that *behaves* safely
 * while its documentation says "sandboxed", and that gap is exactly how an unverified claim
 * becomes a published one. So `unknown` and `unmeasured` are first-class values here, and the
 * tests below pin that they produce refusals rather than assumptions.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  SandboxPolicy,
  claimsIsolation,
  describeIsolation,
  type RuntimeSandboxProfile,
} from "../src/sandbox.ts";

const profile = (
  over: Partial<RuntimeSandboxProfile> = {},
): RuntimeSandboxProfile => ({
  runtimeId: "claude",
  nativeSandbox: "none",
  isolation: "process-isolation",
  detectedTools: [],
  probedAt: 1000,
  ...over,
});

const grant = {
  principalId: "pr_1",
  operation: "net:egress",
  scope: {},
  grantedBy: "pr_human",
  expiresAt: 2000,
};

describe("SandboxPolicy — deny by default", () => {
  test("an unprobed runtime is refused", () => {
    // We do not hand an agent a session in a sandbox we have never looked at.
    const policy = new SandboxPolicy();
    const d = policy.decide("pr_1", "unknown-runtime", "net:egress", 1);
    if (d.kind !== "deny") throw new Error(`expected deny, got ${d.kind}`);
    assert.match(d.reason, /has not been probed/);
  });

  test("a probed runtime with no grant escalates rather than allowing", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    assert.equal(
      policy.decide("pr_1", "claude", "net:egress", 1).kind,
      "escalate",
      "the default is never allow",
    );
  });

  test("an escalation carries the exact request a human would approve", () => {
    // "Escalation writes an approvals row" — the decision has to carry what to write, or the row
    // gets lost in translation and the escalation is invisible.
    const policy = new SandboxPolicy();
    policy.register(profile());
    const d = policy.decide("pr_1", "claude", "fs:write", 1, {
      paths: ["/tmp"],
    });
    assert.equal(d.kind, "escalate");
    // assert.equal above already narrows `d` to the escalate variant, so no guard is needed.
    assert.deepEqual(d.request, {
      principalId: "pr_1",
      capability: "fs:write",
      scope: { paths: ["/tmp"] },
    });
  });

  test("a non-escalatable category is denied outright", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    assert.equal(
      policy.decide("pr_1", "claude", "ptrace:other-process", 1).kind,
      "deny",
      "only listed categories may reach a human",
    );
  });

  test("an explicit grant allows", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    policy.grant(grant);
    assert.equal(
      policy.decide("pr_1", "claude", "net:egress", 1).kind,
      "allow",
    );
  });

  test("an expired grant does not allow", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    policy.grant(grant);
    assert.notEqual(
      policy.decide("pr_1", "claude", "net:egress", 2001).kind,
      "allow",
    );
  });

  test("another principal's grant does not apply", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    policy.grant(grant);
    assert.notEqual(
      policy.decide("pr_2", "claude", "net:egress", 1).kind,
      "allow",
    );
  });

  test("escalations are counted", () => {
    const policy = new SandboxPolicy();
    policy.register(profile());
    policy.decide("pr_1", "claude", "net:egress", 1);
    policy.decide("pr_1", "claude", "fs:write", 2);
    assert.equal(policy.escalationCount(), 2);
  });

  describe("SandboxPolicy — I8: measured, or not claimed", () => {
    test("an unprobed runtime may not claim isolation", () => {
      assert.equal(
        claimsIsolation(profile({ nativeSandbox: "unknown" })),
        false,
      );
    });

    test("unmeasured Radius isolation may not claim isolation", () => {
      // Our own boundary being unverified is just as disqualifying as the runtime's.
      assert.equal(
        claimsIsolation(
          profile({ nativeSandbox: "none", isolation: "unmeasured" }),
        ),
        false,
      );
    });

    test("a runtime with no isolation at all does not claim it", () => {
      assert.equal(
        claimsIsolation(profile({ nativeSandbox: "none", isolation: "none" })),
        false,
      );
    });

    test("a probed runtime with a real boundary does claim it", () => {
      assert.equal(claimsIsolation(profile()), true);
    });

    test("an unprobed runtime is refused at decision time, not only at claim time", () => {
      // The description is for humans; this is the control. An unknown profile must not become an
      // allow merely by not being described anywhere.
      const policy = new SandboxPolicy();
      policy.register(profile({ nativeSandbox: "unknown" }));
      const d = policy.decide("pr_1", "claude", "net:egress", 1);
      if (d.kind !== "deny") throw new Error(`expected deny, got ${d.kind}`);
      assert.match(d.reason, /never measured/);
    });

    test("describeIsolation never uses an adjective that was not earned", () => {
      assert.match(
        describeIsolation(profile({ nativeSandbox: "unknown" })),
        /NOT PROBED/,
        "an unprobed runtime says so plainly",
      );
      assert.match(
        describeIsolation(profile({ isolation: "unmeasured" })),
        /UNMEASURED/,
        "unverified isolation of our own is stated, not hidden",
      );
    });
  });

  describe("SandboxPolicy — profiles do not go stale", () => {
    test("a re-probe replaces the previous profile", () => {
      // ADAPTERS.md: "verify, don't assume — this table will rot". A re-probe must actually take
      // effect, or the stale one is trusted forever.
      const policy = new SandboxPolicy();
      policy.register(profile({ nativeSandbox: "none", probedAt: 1 }));
      policy.register(
        profile({ nativeSandbox: "workspace-write", probedAt: 2 }),
      );
      assert.equal(policy.profile("claude")?.nativeSandbox, "workspace-write");
      assert.equal(policy.profile("claude")?.probedAt, 2);
    });

    test("an unprobed runtime has no profile", () => {
      assert.equal(new SandboxPolicy().profile("nope"), null);
    });
  });
});

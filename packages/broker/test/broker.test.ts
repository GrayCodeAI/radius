/**
 * Broker tests — token lifecycle, deny-by-default policy, and the audit trail.
 *
 * These cover the parts of 1.2 verifiable without live provider credentials. The provider seam
 * (`provider.ts`) is deliberately not exercised; "unscopable providers are refused" is the only
 * honest claim to make about it until a real key is in play.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  TokenStore,
  TokenRejectedError,
  hashToken,
  isSubset,
} from "../src/token.ts";
import { CapabilityPolicy, ApprovalNotHumanError } from "../src/policy.ts";
import {
  assertScopable,
  UnscopableProviderError,
  type ProviderAdapter,
} from "../src/provider.ts";

function store() {
  let t = 0;
  let seed = 0;
  const tokens = new TokenStore({
    monotonicNow: () => t,
    // Deterministic bytes so a hash is reproducible here. Production uses the CSPRNG; "the raw
    // token is never retained" is asserted structurally, not by inspecting these bytes.
    randomBytes: (n) => {
      seed += 1;
      return Buffer.alloc(n, seed);
    },
  });
  return { tokens, advance: (ms: number) => (t += ms) };
}

const mintOpts = {
  principalId: "pr_1",
  launchId: "launch_1",
  capability: "repo:read",
  scope: { repos: ["api", "web"] },
  ttlMs: 1000,
};

const grant = {
  principalId: "pr_1",
  capability: "repo:read",
  scope: { repos: ["api", "web"] },
  grantedBy: "pr_human",
  grantedByKind: "human" as const,
  expiresAt: 1000,
};

function policyWith() {
  const policy = new CapabilityPolicy();
  policy.grant(grant);
  return policy;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /"?(?:api[_-]?key|secret|password|passwd|bearer|authorization)"?\s*[:=]\s*"[^"]{8,}"/i,
];

describe("TokenStore — storage holds no usable secret", () => {
  test("the raw token is never retained; only its hash is", () => {
    // DATA-MODEL.md §4: "store a hash. A leaked table must not yield working tokens." The store
    // offers no way to read a token back, and the only thing it holds is the hash.
    const { tokens } = store();
    const { token, hash } = tokens.mint(mintOpts);
    assert.equal(
      hash,
      hashToken(token),
      "the persisted form is exactly sha256(token)",
    );
    assert.ok(
      !JSON.stringify(tokens).includes(token),
      "the raw token must not appear in a serialized store",
    );
  });

  test("two mints for the same claims produce different tokens", () => {
    const { tokens } = store();
    const a = tokens.mint(mintOpts);
    const b = tokens.mint(mintOpts);
    assert.notEqual(
      a.token,
      b.token,
      "a token is never a function of its claims",
    );
    assert.notEqual(a.hash, b.hash);
  });
});

describe("TokenStore — scope", () => {
  test("a token verifies for its own capability and launch", () => {
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    const claims = tokens.verify(token, {
      launchId: "launch_1",
      capability: "repo:read",
    });
    assert.equal(claims.principalId, "pr_1");
    assert.equal(claims.capability, "repo:read");
  });

  test("a token is refused for a different launch", () => {
    // Binding to one launch is what stops a stolen token being replayed onto another host.
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    assert.throws(
      () => tokens.verify(token, { launchId: "launch_2" }),
      (e: unknown) =>
        e instanceof TokenRejectedError && e.reason === "launch-mismatch",
    );
  });

  test("a token is refused for a capability it was not issued for", () => {
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    assert.throws(
      () => tokens.verify(token, { capability: "net:egress" }),
      (e: unknown) =>
        e instanceof TokenRejectedError && e.reason === "scope-mismatch",
    );
  });

  test("an unknown token is refused", () => {
    const { tokens } = store();
    assert.throws(
      () => tokens.verify("not-a-real-token"),
      (e: unknown) => e instanceof TokenRejectedError && e.reason === "unknown",
    );
  });
});

describe("TokenStore — expiry is monotonic", () => {
  test("a token expires when monotonic time passes its bound", () => {
    const { tokens, advance } = store();
    const { token } = tokens.mint(mintOpts);
    advance(1000);
    assert.throws(
      () => tokens.verify(token),
      (e: unknown) => e instanceof TokenRejectedError && e.reason === "expired",
    );
  });
});

describe("TokenStore — revocation without restart", () => {
  test("revoke takes effect on the next request", () => {
    // "Revocable without agent restart" — DATA-MODEL.md §4. The running agent's next call is
    // refused and nothing about the agent needs to know it happened.
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    tokens.verify(token);
    tokens.revoke(token);
    assert.throws(
      () => tokens.verify(token),
      (e: unknown) => e instanceof TokenRejectedError && e.reason === "revoked",
    );
  });

  test("revokeLaunch kills every token for that launch", () => {
    // The lost-laptop kill switch.
    const { tokens } = store();
    const a = tokens.mint(mintOpts);
    const b = tokens.mint({ ...mintOpts, capability: "net:egress" });
    const other = tokens.mint({ ...mintOpts, launchId: "launch_2" });

    assert.equal(tokens.revokeLaunch("launch_1"), 2);
    for (const t of [a, b]) {
      assert.throws(
        () => tokens.verify(t.token),
        (e: unknown) =>
          e instanceof TokenRejectedError && e.reason === "revoked",
      );
    }
    tokens.verify(other.token, { launchId: "launch_2" }); // untouched
  });
});

describe("TokenStore — narrowing", () => {
  test("a scope can be narrowed on a running token", () => {
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    tokens.narrow(token, { repos: ["api"] });
    assert.deepEqual(tokens.verify(token).scope, { repos: ["api"] });
  });

  test("widening a live token is refused and leaves it untouched", () => {
    // Widening is a new decision, and a new decision needs a human and an approvals row — not a
    // mutation of a live grant.
    const { tokens } = store();
    const { token } = tokens.mint(mintOpts);
    assert.throws(
      () => tokens.narrow(token, { repos: ["api", "web", "secrets"] }),
      /widen/,
    );
    assert.deepEqual(
      tokens.verify(token).scope,
      { repos: ["api", "web"] },
      "a refused widening changes nothing",
    );
  });
});

describe("isSubset — fails closed", () => {
  test("a subset is allowed, a superset is not", () => {
    assert.equal(isSubset({ repos: ["api"] }, { repos: ["api", "web"] }), true);
    assert.equal(
      isSubset({ repos: ["secrets"] }, { repos: ["api", "web"] }),
      false,
    );
  });

  test("a key absent from the wider scope is not a subset", () => {
    assert.equal(isSubset({ unknownKey: 1 }, { repos: [] }), false);
  });

  test("a shape it does not understand is refused, not allowed", () => {
    // Fail closed: an unfamiliar scope must never be waved through.
    assert.equal(
      isSubset({ repos: { nested: true } }, { repos: ["api"] }),
      false,
    );
  });
});

describe("CapabilityPolicy — deny by default", () => {
  test("a capability that was never granted is denied", () => {
    // The primary case. A prompt-injected agent asking for something nobody approved is what
    // this product exists to contain, and "unknown → allow" is the YOLO default oar ships with.
    const r = policyWith().decide(
      { principalId: "pr_1", capability: "net:egress", scope: {} },
      1,
    );
    assert.equal(r.decision, "denied");
    assert.match(r.reason ?? "", /no grant exists/);
  });

  test("a granted scope is allowed", () => {
    const r = policyWith().decide(
      {
        principalId: "pr_1",
        capability: "repo:read",
        scope: { repos: ["api"] },
      },
      1,
    );
    assert.equal(r.decision, "allowed");
    assert.equal(r.reason, null);
  });

  test("a scope beyond the grant is denied", () => {
    const r = policyWith().decide(
      {
        principalId: "pr_1",
        capability: "repo:read",
        scope: { repos: ["secrets"] },
      },
      1,
    );
    assert.equal(r.decision, "denied");
    assert.match(r.reason ?? "", /exceeds/);
  });

  test("an expired grant is denied, and reports expiry rather than scope", () => {
    // An operator reading the audit trail needs the real reason, not a generic refusal.
    const r = policyWith().decide(
      {
        principalId: "pr_1",
        capability: "repo:read",
        scope: { repos: ["api"] },
      },
      1001,
    );
    assert.equal(r.decision, "denied");
    assert.match(r.reason ?? "", /expired/);
  });

  test("another principal's grant does not apply", () => {
    const r = policyWith().decide(
      {
        principalId: "pr_2",
        capability: "repo:read",
        scope: { repos: ["api"] },
      },
      1,
    );
    assert.equal(r.decision, "denied", "a grant is per principal, not global");
  });

  test("revokeAll takes effect immediately", () => {
    const policy = policyWith();
    assert.equal(policy.revokeAll("pr_1"), 1);
    const r = policy.decide(
      {
        principalId: "pr_1",
        capability: "repo:read",
        scope: { repos: ["api"] },
      },
      1,
    );
    assert.equal(r.decision, "denied");
  });
});

describe("CapabilityPolicy — D-014, only a human may approve", () => {
  test("a grant decided by an agent is refused", () => {
    // "An agent able to approve its own escalation is privilege escalation within a single
    // tenant." Enforced here as well as in the schema, so a caller cannot skip the table.
    const policy = new CapabilityPolicy();
    assert.throws(
      () =>
        policy.grant({
          ...grant,
          principalId: "pr_agent",
          grantedBy: "pr_agent",
          grantedByKind: "agent",
        }),
      ApprovalNotHumanError,
    );
  });

  test("a service cannot approve either", () => {
    const policy = new CapabilityPolicy();
    assert.throws(
      () =>
        policy.grant({
          ...grant,
          grantedBy: "svc_ci",
          grantedByKind: "service",
        }),
      ApprovalNotHumanError,
    );
  });
});

describe("CapabilityPolicy — the audit trail", () => {
  test("denials are recorded, not just grants", () => {
    // An audit that only records successes shows you nothing when something goes wrong. A
    // refused capability is the most interesting event there is — it is what an injection looks
    // like from the inside.
    const policy = new CapabilityPolicy();
    policy.decide(
      { principalId: "pr_1", capability: "net:egress", scope: {} },
      5,
      "launch_1",
    );
    assert.equal(policy.entries().length, 1);
    assert.equal(policy.entries()[0]?.decision, "denied");
    assert.equal(policy.denialCount, 1);
    assert.equal(policy.entries()[0]?.launchId, "launch_1");
  });

  test("an entry records principal, capability, scope, decision, time and reason", () => {
    // "Audit every request: principal, capability, decision, timestamp" — MILESTONES 1.2.
    const r = new CapabilityPolicy().decide(
      {
        principalId: "pr_9",
        capability: "repo:read",
        scope: { repos: ["api"] },
      },
      1234,
      "launch_7",
    );
    assert.equal(r.audit.at, 1234);
    assert.equal(r.audit.principalId, "pr_9");
    assert.equal(r.audit.capability, "repo:read");
    assert.deepEqual(r.audit.requestedScope, { repos: ["api"] });
    assert.ok(r.audit.reason);
  });

  test("a serialized audit trail contains no secret-shaped value", () => {
    // The log is the thing most likely to ship to a log aggregator, so it is the thing most
    // likely to leak. It has no credential field; this proves it.
    const policy = new CapabilityPolicy();
    policy.decide(
      {
        principalId: "pr_1",
        capability: "net:egress",
        scope: { host: "example.com" },
      },
      1,
    );
    const wire = JSON.stringify(policy.entries());
    for (const pattern of SECRET_PATTERNS) {
      assert.ok(
        !pattern.test(wire),
        `audit trail must not contain a secret (${pattern})`,
      );
    }
    // Positive control, or a scanner matching nothing would look green.
    assert.ok(
      SECRET_PATTERNS.some((p) => p.test('{"note":"AKIAIOSFODNN7EXAMPLE"}')),
      "the scanner must detect a planted secret, or it is not a check",
    );
  });
});

describe("Provider boundary — refuses what it cannot scope", () => {
  const adapter = (name: string, scoped: boolean): ProviderAdapter => ({
    name,
    supportsScopedCredentials: scoped,
    call: () => Promise.reject(new Error("never called in this test")),
  });

  test("a provider that cannot scope is refused rather than given a raw key", () => {
    // The check that stops the product quietly regressing to YOLO. If a provider cannot scope,
    // the answer is no — handing over a raw key would make every other guarantee a claim.
    assert.throws(
      () => assertScopable(adapter("some-cli", false), "repo:read"),
      UnscopableProviderError,
    );
  });

  test("a provider that declares scoping support passes the gate", () => {
    assert.doesNotThrow(() =>
      assertScopable(adapter("scoped-provider", true), "repo:read"),
    );
  });

  test("the refusal names the provider and the capability", () => {
    assert.throws(
      () => assertScopable(adapter("some-cli", false), "net:egress"),
      /some-cli[\s\S]*net:egress/,
    );
  });
});

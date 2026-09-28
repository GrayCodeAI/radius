/**
 * Principal model and the secret scan.
 *
 * The scan is the part that matters. `DATA-MODEL.md` §4 says enforcement is "invariant I1 (no
 * secret-shaped value in any durable field) plus a test that scans for it. **Not a code-review
 * convention.**" This file is that test. A type without a secret field is a strong claim; a type
 * plus a test that would fail if a secret-shaped string ever appeared is a claim you can rely on.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ProtocolError,
  createPrincipal,
  isRevoked,
  parsePrincipal,
  serializePrincipal,
  type CapabilityGrant,
} from "../src/principal.ts";

const live = () =>
  createPrincipal({
    id: "pr_01",
    kind: "agent",
    centerId: "task_42",
    displayName: "ci-runner",
    now: 1_700_000_000_000,
  });

/**
 * A copy of `value` with one key removed.
 *
 * Built by filtering rather than `delete` on a computed key: deleting a property the key set is
 * derived from is the pattern that lets a fixture drift away from the type it is exercising, and
 * a lint rule rightly refuses it.
 */
function omit(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

describe("Principal — round trip", () => {
  test("survives serialize → parse unchanged", () => {
    const p = live();
    assert.deepEqual(parsePrincipal(JSON.parse(serializePrincipal(p))), p);
  });

  test("all three kinds round-trip", () => {
    for (const kind of ["human", "agent", "service"] as const) {
      const p = createPrincipal({
        id: "pr_x",
        kind,
        centerId: "c",
        displayName: "d",
        now: 1,
      });
      assert.equal(
        parsePrincipal(JSON.parse(serializePrincipal(p))).kind,
        kind,
      );
    }
  });

  test("revocation is soft and round-trips", () => {
    const p = { ...live(), revokedAt: 1_700_000_100_000 };
    assert.equal(
      parsePrincipal(JSON.parse(serializePrincipal(p))).revokedAt,
      p.revokedAt,
    );
    assert.equal(isRevoked(p, 1_700_000_100_000), true);
    assert.equal(
      isRevoked(p, 1_700_000_000_000),
      false,
      "not revoked before the timestamp",
    );
  });
});

describe("Principal — validation", () => {
  test("rejects an unknown kind", () => {
    assert.throws(
      () => parsePrincipal({ ...live(), kind: "root" }),
      ProtocolError,
    );
  });

  test("rejects missing and empty required fields", () => {
    for (const field of ["id", "centerId", "displayName"]) {
      assert.throws(
        () => parsePrincipal(omit(live(), field)),
        ProtocolError,
        `missing ${field}`,
      );
      assert.throws(
        () => parsePrincipal({ ...omit(live(), field), [field]: "" }),
        ProtocolError,
        `empty ${field}`,
      );
    }
  });

  test("rejects a non-finite createdAt", () => {
    assert.throws(
      () => parsePrincipal({ ...live(), createdAt: Number.NaN }),
      ProtocolError,
    );
  });

  test("rejects a non-object", () => {
    for (const bad of [null, "x", 42, []]) {
      assert.throws(() => parsePrincipal(bad), ProtocolError);
    }
  });
});

describe("Principal — the deliberate omission, enforced", () => {
  test("a secret cannot ride in as an unknown field", () => {
    // The closed-shape rule is what stops a permissive parser from accepting
    // `{"id":..., "apiKey":"sk-..."}` — smuggling a credential through a type with no field for it.
    assert.throws(
      () =>
        parsePrincipal({ ...live(), apiKey: "sk-ant-api03-REAL-LOOKING-KEY" }),
      ProtocolError,
    );
    assert.throws(
      () => parsePrincipal({ ...live(), token: "ghp_abc123" }),
      ProtocolError,
    );
  });

  test("a serialized principal never contains a secret-shaped value", () => {
    const p = live();
    const wire = serializePrincipal(p);
    for (const pattern of SECRET_PATTERNS) {
      assert.ok(
        !pattern.test(wire),
        `serialized principal must not contain a secret-shaped value (${pattern})`,
      );
    }
  });

  test("a serialized grant never contains a secret-shaped value", () => {
    // The scope object is attacker-supplied JSON, so it is the realistic leak path. A grant is
    // not a Principal, so the closed-shape rule does not cover it — hence this test.
    const grant: CapabilityGrant = {
      capability: "repo:read",
      scope: { repos: ["a", "b"] },
      grantedBy: "pr_human",
      grantedAt: 1,
      expiresAt: 2,
      monotonicBound: 2,
      approvalId: "ap_1",
    };
    const wire = JSON.stringify(grant);
    for (const pattern of SECRET_PATTERNS) {
      assert.ok(
        !pattern.test(wire),
        `serialized grant must not contain a secret (${pattern})`,
      );
    }
  });

  test("a scope carrying a secret is detected if it ever reaches the wire", () => {
    // A positive control for the scan itself. Without this, a scanner that matched nothing would
    // pass every other test in this file and look like a green suite.
    const leaky = JSON.stringify({
      capability: "repo:read",
      scope: { note: "AKIAIOSFODNN7EXAMPLE" },
    });
    assert.ok(
      SECRET_PATTERNS.some((p) => p.test(leaky)),
      "the scanner must actually detect a planted secret, or it is not a check",
    );
  });
});

/**
 * Shapes worth refusing in any durable structure. Deliberately pattern-based rather than
 * value-based: the goal is to catch an accidental credential, not to adjudicate every string.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/, // Anthropic
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style
  /gh[pousr]_[A-Za-z0-9]{16,}/, // GitHub
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /AIza[0-9A-Za-z_-]{20,}/, // Google
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /"?(?:api[_-]?key|secret|password|passwd|bearer|authorization)"?\s*[:=]\s*"[^"]{8,}"/i,
];

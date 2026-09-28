/**
 * `radius/v1` versioning and compatibility.
 *
 * The tests that matter most are the two that fail in *both* directions — a breaking change
 * shipped as a minor, and a minor shipped as a major. The second is the one a careful team gets
 * wrong, because it feels safe: it only ever inconveniences people, never breaks them. It is
 * also how a "stable API" quietly becomes a moving target.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  PROTOCOL_VERSION,
  BreakingReleaseError,
  ProtocolError,
  UnsupportedVersionError,
  assertCompatible,
  assertVersionBump,
  classifyRelease,
  formatVersion,
  parseVersion,
} from "../src/version.ts";

describe("version parsing", () => {
  test("parses the protocol version and an explicit minor", () => {
    assert.deepEqual(parseVersion(PROTOCOL_VERSION), { major: 1, minor: 0 });
    assert.deepEqual(parseVersion("radius/v2.7"), { major: 2, minor: 7 });
  });

  test("round-trips through format", () => {
    assert.equal(formatVersion(parseVersion("radius/v3.4")), "radius/v3.4");
  });

  test("rejects anything unrecognised rather than guessing", () => {
    for (const bad of [
      "v1",
      "radius/1",
      "radius",
      "latest",
      "",
      "radius/v1.2.3",
    ]) {
      assert.throws(
        () => parseVersion(bad),
        ProtocolError,
        `"${bad}" must be rejected`,
      );
    }
  });
});

describe("compatibility — a host may lag one minor, never a major", () => {
  test("the same version, and a host one minor behind, are compatible", () => {
    assert.doesNotThrow(() => assertCompatible("radius/v1.2", "radius/v1.2"));
    assert.doesNotThrow(() => assertCompatible("radius/v1.2", "radius/v1.1"));
  });

  test("a host AHEAD on the minor is compatible", () => {
    // A newer host talking to an older plane is fine for additive changes.
    assert.doesNotThrow(() => assertCompatible("radius/v1.1", "radius/v1.2"));
  });

  test("a host two minors behind is NOT compatible", () => {
    // "Only one minor" means one. Assuming two is how a compat promise quietly dies.
    assert.throws(
      () => assertCompatible("radius/v1.3", "radius/v1.1"),
      /minors behind/,
    );
  });

  test("a major mismatch is refused in both directions", () => {
    assert.throws(
      () => assertCompatible("radius/v2.0", "radius/v1.9"),
      UnsupportedVersionError,
    );
    assert.throws(
      () => assertCompatible("radius/v1.9", "radius/v2.0"),
      UnsupportedVersionError,
    );
  });

  test("a malformed version is refused, not coerced", () => {
    assert.throws(
      () => assertCompatible("radius/v1.0", "garbage"),
      ProtocolError,
    );
  });
});

describe("change classification", () => {
  test("a new optional field or record kind is a minor", () => {
    assert.equal(
      classifyRelease({ version: "radius/v1.1", newOptionalFields: ["scope"] }),
      "minor",
    );
    assert.equal(
      classifyRelease({ version: "radius/v1.1", newRecordKinds: ["handoff"] }),
      "minor",
    );
  });

  test("a removal, rename, or semantic change is a MAJOR", () => {
    assert.equal(
      classifyRelease({ version: "radius/v2.0", removedOrRenamed: ["scope"] }),
      "major",
    );
    assert.equal(
      classifyRelease({
        version: "radius/v2.0",
        semanticChanges: ["seq now starts at 1"],
      }),
      "major",
    );
  });

  test("a TIGHTENED DEFAULT is a MAJOR, with no field changed at all", () => {
    // The rule that surprises people, and the reason classifyRelease works on semantics rather
    // than shapes. Turning a sandbox on cannot be additive: a host built against v1 defaults must
    // fail loudly, not discover it later.
    assert.equal(
      classifyRelease({
        version: "radius/v2.0",
        tightenedDefaults: ["sandbox on by default"],
      }),
      "major",
    );
  });

  test("an empty release is neither minor nor major", () => {
    assert.equal(classifyRelease({ version: "radius/v1.0" }), "none");
  });
});

describe("version bump enforcement", () => {
  test("a minor additive change passes", () => {
    assert.doesNotThrow(() =>
      assertVersionBump("radius/v1.0", {
        version: "radius/v1.1",
        newOptionalFields: ["scope"],
      }),
    );
  });

  test("a major breaking change passes", () => {
    assert.doesNotThrow(() =>
      assertVersionBump("radius/v1.0", {
        version: "radius/v2.0",
        tightenedDefaults: ["sandbox on"],
      }),
    );
  });

  test("a breaking change shipped as a minor is REFUSED", () => {
    // Direction one. The mistake everyone catches, because their own client breaks.
    assert.throws(
      () =>
        assertVersionBump("radius/v1.0", {
          version: "radius/v1.1",
          semanticChanges: ["cursor semantics changed"],
        }),
      BreakingReleaseError,
    );
  });

  test("a tightened default shipped as a minor is REFUSED", () => {
    assert.throws(
      () =>
        assertVersionBump("radius/v1.0", {
          version: "radius/v1.1",
          tightenedDefaults: ["sandbox on by default"],
        }),
      /breaking/,
    );
  });

  test("an additive change shipped as a MAJOR is REFUSED", () => {
    // Direction two, and the subtler one. It never breaks anyone; it just forces an upgrade for
    // an optional field, until "stable" means nothing.
    assert.throws(
      () =>
        assertVersionBump("radius/v1.0", {
          version: "radius/v2.0",
          newOptionalFields: ["scope"],
        }),
      /MAJOR version/,
    );
  });

  test("a version that goes backwards is refused", () => {
    assert.throws(
      () =>
        assertVersionBump("radius/v2.0", {
          version: "radius/v1.9",
          newOptionalFields: ["x"],
        }),
      /backwards/,
    );
  });

  test("the breaking error names what broke", () => {
    // "This is breaking" is not actionable; naming the field is.
    try {
      assertVersionBump("radius/v1.0", {
        version: "radius/v1.1",
        removedOrRenamed: ["scope"],
        semanticChanges: ["seq base changed"],
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof BreakingReleaseError);
      assert.ok(
        e.reasons.some((r) => r.includes("scope")),
        "names the removed field",
      );
    }
  });
});

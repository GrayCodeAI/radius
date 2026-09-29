/**
 * Per-runtime sandbox policy — deny by default, and honest about what is actually measured.
 *
 * ── The two things this has to get right ────────────────────────────────────────────────────
 *
 * **1. The default is denial.** oar ships YOLO: interactive permission gates disabled, sandboxes
 * off, codex at `danger-full-access`. That is right for a human watching a terminal and wrong for
 * a scheduled credentialed agent nobody is watching — the only situation Radius targets. So
 * every allowance here is an explicit grant, and its absence is a refusal, never a default-allow.
 *
 * **2. We do not claim isolation we have not measured.** `ADAPTERS.md` says "verify, don't
 * assume — this table will rot", and I8 is literally "sandbox strength is measured, or not
 * claimed in docs". So `NativeSandbox` has an `unknown` member, `Isolation` has an `unmeasured`
 * member, and `claimsIsolation()` returns false for both. That is not hedging — it is what stops
 * this module reporting a sandbox for a runtime nobody actually probed, which is precisely how a
 * "we sandboxed it" claim turns into fiction.
 *
 * `unknown` is a legitimate, load-bearing value. A profile that has not been probed must say so,
 * and the policy must then refuse rather than assume the friendly answer.
 */

import type { CapabilityRequest } from "./policy.ts";

/** What the runtime's own sandbox provides. `unknown` means "not detected", not "probably fine". */
export type NativeSandbox =
  | "none"
  | "danger-full-access"
  | "workspace-write"
  | "unknown";

/** What Radius supplies around it. `unmeasured` means our own boundary is unverified. */
export type Isolation = "none" | "process-isolation" | "unmeasured";

export interface RuntimeSandboxProfile {
  readonly runtimeId: string;
  /** Detected by probing, never hardcoded. See `ADAPTERS.md` §"verify, don't assume". */
  readonly nativeSandbox: NativeSandbox;
  readonly isolation: Isolation;
  /** Tools actually observed to be exposed. Empty means none were seen. */
  readonly detectedTools: readonly string[];
  /** When this was probed, so a stale profile is visible rather than silently trusted. */
  readonly probedAt: number;
}

export type SandboxDecision =
  | { readonly kind: "allow"; readonly basis: string }
  | { readonly kind: "deny"; readonly reason: string }
  | {
      readonly kind: "escalate";
      readonly reason: string;
      /** Exactly what a human would be asked to approve. */
      readonly request: CapabilityRequest;
    };

/** An explicit allowance. There is no implicit one. */
export interface SandboxGrant {
  readonly principalId: string;
  /** Operation, e.g. `fs:write`, `net:egress`, `exec`, `tool:bash`. */
  readonly operation: string;
  /** Optional narrowing, e.g. which paths. Empty scope means the whole operation. */
  readonly scope: Readonly<Record<string, unknown>>;
  readonly grantedBy: string;
  readonly expiresAt: number;
}

/**
 * Whether this profile may claim it is sandboxed — I8, enforced rather than asserted.
 *
 * Returns false for an unprobed runtime and for a profile whose own isolation is unverified, so
 * a caller cannot read "sandboxed: true" out of a module that has not earned it.
 */
export function claimsIsolation(profile: RuntimeSandboxProfile): boolean {
  if (
    profile.nativeSandbox === "unknown" ||
    profile.isolation === "unmeasured"
  ) {
    return false;
  }
  return profile.nativeSandbox !== "none" || profile.isolation !== "none";
}

/** One line describing the real posture, with no adjective we have not earned. */
export function describeIsolation(profile: RuntimeSandboxProfile): string {
  if (profile.nativeSandbox === "unknown") {
    return `${profile.runtimeId}: NOT PROBED — isolation is unverified, so none is claimed`;
  }
  const native =
    profile.nativeSandbox === "none"
      ? "no native sandbox"
      : `native ${profile.nativeSandbox}`;
  const ours =
    profile.isolation === "unmeasured"
      ? "Radius isolation UNMEASURED"
      : profile.isolation === "none"
        ? "no Radius isolation"
        : `Radius ${profile.isolation}`;
  return `${profile.runtimeId}: ${native}, ${ours}`;
}

export interface SandboxPolicyOptions {
  /** Categories that may be escalated to a human. Everything else is simply denied. */
  readonly escalatable?: readonly string[];
}

export class SandboxPolicy {
  readonly #profiles = new Map<string, RuntimeSandboxProfile>();
  readonly #grants: SandboxGrant[] = [];
  readonly #escalatable: readonly string[];
  #escalations = 0;

  constructor(options: SandboxPolicyOptions = {}) {
    this.#escalatable = options.escalatable ?? [
      "fs:write",
      "net:egress",
      "exec",
      "tool:bash",
    ];
  }

  /** Record a probed profile. A second probe replaces the first, so profiles do not go stale. */
  register(profile: RuntimeSandboxProfile): void {
    this.#profiles.set(profile.runtimeId, profile);
  }

  profile(runtimeId: string): RuntimeSandboxProfile | null {
    return this.#profiles.get(runtimeId) ?? null;
  }

  grant(grant: SandboxGrant): void {
    this.#grants.push(grant);
  }

  /**
   * Decide one operation.
   *
   * Order is deliberate:
   *   1. An unprobed runtime is refused before anything else. We do not hand an agent a session
   *      in a sandbox we have never looked at.
   *   2. An explicit, unexpired grant allows.
   *   3. An escalatable operation escalates — and the caller MUST write an `approvals` row. The
   *      decision carries the exact request so it cannot be lost in translation.
   *   4. Everything else is denied.
   */
  decide(
    principalId: string,
    runtimeId: string,
    operation: string,
    now: number,
    scope: Readonly<Record<string, unknown>> = {},
  ): SandboxDecision {
    const profile = this.#profiles.get(runtimeId);
    if (!profile) {
      return {
        kind: "deny",
        reason:
          `runtime "${runtimeId}" has not been probed, so its isolation is unknown. Refusing ` +
          `rather than assuming a sandbox we have not seen.`,
      };
    }
    if (profile.nativeSandbox === "unknown") {
      return {
        kind: "deny",
        reason:
          `${describeIsolation(profile)}. Refusing rather than assuming isolation that was ` +
          `never measured.`,
      };
    }

    const granted = this.#grants.some(
      (g) =>
        g.principalId === principalId &&
        g.operation === operation &&
        g.expiresAt > now,
    );
    if (granted) {
      return { kind: "allow", basis: `explicit grant for ${operation}` };
    }

    const request: CapabilityRequest = {
      principalId,
      capability: operation,
      scope,
    };
    if (this.#escalatable.includes(operation)) {
      this.#escalations += 1;
      return {
        kind: "escalate",
        reason:
          `${operation} is not granted and ${describeIsolation(profile)} cannot be relied on to ` +
          `contain it. A human must approve; this must be recorded as an approvals row.`,
        request,
      };
    }
    return {
      kind: "deny",
      reason: `${operation} is not granted and is not an escalatable category.`,
    };
  }

  /** Escalations raised since start — the number an operator watches. */
  escalationCount(): number {
    return this.#escalations;
  }
}

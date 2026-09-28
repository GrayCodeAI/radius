/**
 * The Principal — "the core type. Everything else derives from it." (`MILESTONES.md` 1.1)
 *
 * A principal has a center and a radius: a stable identity, the workspace it belongs to, and the
 * set of capabilities it may exercise. Everything in the protocol is expressed in these terms.
 *
 * ── The deliberate omission, made structural ──────────────────────────────────────────────
 * `DATA-MODEL.md` §2 says, in capitals: "No column in any table holds a raw credential." §4 adds
 * that `broker_token_hash` is a *hash*, and that raw credentials live only inside the broker
 * process, in memory, unreferenced by name in any durable structure.
 *
 * The usual enforcement is a code-review convention, which is a comment. So the omission here
 * is structural instead: **this type has no field that can hold a secret, and there is no way to
 * smuggle one in.** There is no `token`, no `secret`, no `apiKey` — and `parsePrincipal` rejects
 * unknown fields outright, so a secret cannot ride along in an untyped JSON bag.
 *
 * That is still a convention enforced by a compiler rather than by a type system, so it is not
 * taken on trust: `test/secrets.test.ts` serializes real principals and grants and greps the bytes
 * for secret-shaped values, which is the mechanism `DATA-MODEL.md` §4 asks for by name.
 */

/** Who a principal is. D-014: only a human may approve an escalation. */
export type PrincipalKind = "human" | "agent" | "service";

export interface Principal {
  /** Stable identity. */
  readonly id: string;
  readonly kind: PrincipalKind;
  /** The workspace/task this principal belongs to — _the radius_. */
  readonly centerId: string;
  readonly displayName: string;
  readonly createdAt: number;
  /** Soft revocation, for audit (`DATA-MODEL.md` §2). `null` means live. */
  readonly revokedAt: number | null;
}

/**
 * One granted capability. `expiresAt` is **required, never optional**: `DATA-MODEL.md` §2 marks
 * it "**required.** Default lease 1 hour, per D-008", and a capability that cannot expire is
 * exactly the permanent grant `PROTOCOL.md` §6 forbids. Making it required in the type means a
 * permanent grant is unrepresentable rather than merely discouraged.
 */
export interface CapabilityGrant {
  readonly capability: string;
  /** JSON describing which repos/hosts/paths. Empty scope means "nothing granted". */
  readonly scope: Readonly<Record<string, unknown>>;
  /** Every grant traces to a human decision (`DATA-MODEL.md` §2, D-014). */
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
  /** Monotonic window, per D-008 Q4. Wall clock alone can be rolled back. */
  readonly monotonicBound: number;
  readonly approvalId: string;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const KINDS: readonly PrincipalKind[] = ["human", "agent", "service"];

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${field} must be a finite number`);
  }
  return value;
}

/**
 * Parse and validate a principal from untrusted JSON.
 *
 * Unknown fields are **rejected**, not ignored. That is the second half of the structural
 * omission above: a permissive parser would accept `{"id":..., "apiKey":"sk-..."}` and smuggle a
 * credential through a type that has no field for it. Rejecting keeps the wire shape exactly the
 * declared shape.
 */
export function parsePrincipal(input: unknown): Principal {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProtocolError("principal must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const allowed = new Set([
    "id",
    "kind",
    "centerId",
    "displayName",
    "createdAt",
    "revokedAt",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ProtocolError(
        `unknown field "${key}" on principal. Principals are a closed shape: an unrecognised ` +
          `field is either a typo or something that does not belong in a principal at all.`,
      );
    }
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as PrincipalKind)) {
    throw new ProtocolError(`kind must be one of ${KINDS.join(" | ")}`);
  }
  if (raw.revokedAt !== null && raw.revokedAt !== undefined) {
    assertFiniteNumber(raw.revokedAt, "revokedAt");
  }

  return {
    id: assertNonEmptyString(raw.id, "id"),
    kind: kind as PrincipalKind,
    centerId: assertNonEmptyString(raw.centerId, "centerId"),
    displayName: assertNonEmptyString(raw.displayName, "displayName"),
    createdAt: assertFiniteNumber(raw.createdAt, "createdAt"),
    revokedAt: (raw.revokedAt ?? null) as number | null,
  };
}

export function serializePrincipal(principal: Principal): string {
  // Round-trip through the validator so serialization cannot emit a shape parse() would reject.
  return JSON.stringify(parsePrincipal(principal));
}

/** True when the principal has been revoked. Revocation is soft, so this is a fact, not a state. */
export function isRevoked(principal: Principal, now: number): boolean {
  return principal.revokedAt !== null && principal.revokedAt <= now;
}

export interface CreatePrincipalOptions {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly centerId: string;
  readonly displayName: string;
  readonly now: number;
}

/** Construct a live principal. There is no parameter through which a secret could be passed. */
export function createPrincipal(options: CreatePrincipalOptions): Principal {
  return parsePrincipal({
    id: options.id,
    kind: options.kind,
    centerId: options.centerId,
    displayName: options.displayName,
    createdAt: options.now,
    revokedAt: null,
  });
}

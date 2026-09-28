/**
 * `@graycode/protocol` — the stable surface. See `PROTOCOL.md` for the wire contract.
 *
 * Phase 1.1 (Principal) and 1.4 (leases). Deliberately small: these are the two pieces whose
 * logic can be proved exhaustively without a platform runtime, and getting them right is what
 * makes the broker's contract concrete instead of speculative.
 *
 * `export type` is used explicitly for every type, because `verbatimModuleSyntax` is on and a
 * value-style re-export of a type is a compile error rather than a silent runtime no-op.
 */

export type {
  CapabilityGrant,
  CreatePrincipalOptions,
  Principal,
  PrincipalKind,
} from "./principal.ts";
export {
  ProtocolError,
  createPrincipal,
  isRevoked,
  parsePrincipal,
  serializePrincipal,
} from "./principal.ts";

export type {
  Lease,
  LeaseManagerOptions,
  MonotonicAnchor,
  MonotonicClockOptions,
  MonotonicSource,
} from "./lease.ts";
export {
  DEFAULT_LEASE_TTL_MS,
  LeaseExpiredError,
  LeaseHeldError,
  LeaseManager,
  MonotonicClock,
  StaleEpochError,
  hrtimeSource,
} from "./lease.ts";

/**
 * `radius/v1` — the envelope, and the compatibility rules that make a promise you can keep.
 *
 * `ROADMAP.md` calls this "the real moat": once developers build agents against `radius/v1`, the
 * platform gets stickier than any feature set. That only holds if versioning is *enforced* rather
 * than promised, so the rules from `PROTOCOL.md` §8 are implemented here as a checker rather than
 * left as prose.
 *
 * ── The rules, and the one that surprises people ───────────────────────────────────────────
 *   new optional field ............ minor
 *   new record kind ............... minor
 *   removal, rename, semantic ..... MAJOR
 *   **tightening a default ....... MAJOR**
 *
 * That last one is load-bearing and the reason this file exists. Turning a sandbox on by default
 * is a *breaking* change for a host built against v1 defaults, even though no field changed — a
 * host that silently loses its sandbox must fail loudly, not drift. A tool that only diffs field
 * names cannot see that, so `classifyRelease` works on **semantic** facts, not shapes.
 *
 *   "A host may lag the plane by one minor. Never a major." — enforced in `assertCompatible`.
 */

import { ProtocolError } from "./principal.ts";

// Re-exported so a consumer of the version surface catches the malformed-version case without
// also reaching into the principal module. Same as `lease.ts`.
export { ProtocolError };

export const PROTOCOL_VERSION = "radius/v1";
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
}

/** Parse `radius/vN` or `radius/vN.M`. Rejects anything else rather than guessing. */
export function parseVersion(raw: string): ParsedVersion {
  const match = /^radius\/v(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match?.[1]) {
    throw new ProtocolError(
      `unrecognised protocol version "${raw}". Expected ${PROTOCOL_VERSION} or radius/vN.M.`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

export function formatVersion({ major, minor }: ParsedVersion): string {
  return `radius/v${major}.${minor}`;
}

/** The wire envelope. `v` is required — `PROTOCOL.md` §2 says so explicitly. */
export interface Envelope<T = unknown> {
  readonly v: string;
  readonly requestId: string;
  readonly payload: T;
}

export class UnsupportedVersionError extends Error {
  constructor(
    readonly theirs: string,
    readonly ours: string,
  ) {
    super(`unsupported protocol version ${theirs}; this build speaks ${ours}`);
    this.name = "UnsupportedVersionError";
  }
}

/**
 * Can a host at `host` talk to a plane at `plane`?
 *
 * `PROTOCOL.md` §8: "A host may lag the plane by one minor. Never a major." So a newer *minor* on
 * the host is tolerated, a major mismatch is not, and more than one minor of lag is not. Being
 * strict here is the point — a silently-mismatched pair is how a "backwards compatible" API
 * stops being one.
 */
export function assertCompatible(plane: string, host: string): void {
  const p = parseVersion(plane);
  const h = parseVersion(host);
  if (p.major !== h.major) {
    throw new UnsupportedVersionError(host, plane);
  }
  if (p.minor - h.minor > 1) {
    throw new ProtocolError(
      `host is ${p.minor - h.minor} minors behind the plane, and only one minor of lag is ` +
        `supported. Upgrade the host rather than assuming compatibility.`,
    );
  }
}

/** A semantic fact about a release — deliberately not a field-level diff. */
export interface ReleaseNote {
  readonly version: string;
  readonly newOptionalFields?: readonly string[];
  readonly newRecordKinds?: readonly string[];
  readonly removedOrRenamed?: readonly string[];
  readonly semanticChanges?: readonly string[];
  /** A default that got STRICTER, e.g. sandbox on. This is a major, by rule. */
  readonly tightenedDefaults?: readonly string[];
}

export type ChangeClass = "minor" | "major" | "none";

/**
 * Classify one release. Pure, so the policy is tested rather than trusted.
 *
 * The two interesting outputs are the ones that are easy to get wrong: a tightened default is
 * **major** even with nothing added, and an *empty* release is neither minor nor major.
 */
export function classifyRelease(note: ReleaseNote): ChangeClass {
  if (
    (note.removedOrRenamed?.length ?? 0) > 0 ||
    (note.semanticChanges?.length ?? 0) > 0 ||
    (note.tightenedDefaults?.length ?? 0) > 0
  ) {
    return "major";
  }
  if (
    (note.newOptionalFields?.length ?? 0) > 0 ||
    (note.newRecordKinds?.length ?? 0) > 0
  ) {
    return "minor";
  }
  return "none";
}

export class BreakingReleaseError extends Error {
  constructor(
    readonly version: string,
    readonly reasons: readonly string[],
  ) {
    super(
      `release ${version} is breaking: ${reasons.join("; ")}. A tightened default counts as ` +
        `breaking even when no field changed — a host that silently loses its sandbox must fail ` +
        `loudly, not drift. Bump the major version.`,
    );
    this.name = "BreakingReleaseError";
  }
}

/**
 * Assert a release does the right thing with its version number.
 *
 * Fails in both directions, deliberately: a breaking change shipped as a minor, *and* a minor
 * shipped as a major. The second looks harmless and is not — it forces every host to upgrade for
 * an additive change, which is exactly how a "stable API" becomes a moving target.
 */
export function assertVersionBump(previous: string, note: ReleaseNote): void {
  const from = parseVersion(previous);
  const to = parseVersion(note.version);
  const kind = classifyRelease(note);

  if (to.major < from.major) {
    throw new ProtocolError(
      `version went backwards: ${previous} → ${note.version}`,
    );
  }

  if (kind === "major" && to.major === from.major) {
    throw new BreakingReleaseError(
      note.version,
      [
        ...(note.removedOrRenamed ?? []).map((f) => `removed/renamed ${f}`),
        ...(note.semanticChanges ?? []).map((c) => `semantic: ${c}`),
        ...(note.tightenedDefaults ?? []).map((d) => `tightened default: ${d}`),
      ].slice(0, 3),
    );
  }

  if (kind === "minor" && to.major > from.major) {
    throw new ProtocolError(
      `${note.version} is an additive change but bumped the MAJOR version. That forces every ` +
        `host to upgrade for an optional field; it is a minor.`,
    );
  }
}

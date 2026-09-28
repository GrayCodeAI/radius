/**
 * The provider boundary — and an honest statement of what is and is not verified.
 *
 * ── THE UNVERIFIED SEAM ─────────────────────────────────────────────────────────────────────
 * Everything else in this package is tested. This file is not, and it cannot be, without live
 * credentials for Anthropic, OpenAI, Google and xAI plus a real request through each provider's
 * auth path. So it is isolated behind a narrow interface, and the isolation is the point: the
 * parts that are verified (scoping, revocation, expiry, audit, deny-by-default) do not depend on
 * it, and the part that is unverified is small enough to read in one sitting.
 *
 * **`ResolvedCredential` is deliberately opaque.** A `string` holding a raw API key is one
 * careless `JSON.stringify` away from a log line, which is exactly the failure `DATA-MODEL.md` §4
 * and `PROTOCOL.md` §6 forbid. The type has no accessor. The only way to use a credential is to
 * hand it back to the `ProviderAdapter` that issued it, so it never becomes a value the rest of
 * the program can accidentally serialize.
 *
 * What a real implementation must still prove, and has not:
 *   1. A real provider key is scoped to one principal/launch and cannot act beyond that scope.
 *   2. Revoking our token stops the underlying provider call, not just our bookkeeping.
 *   3. The credential is not reachable from agent context, a heap dump, a core file, or an
 *      error message.
 * Points 1 and 2 depend on provider features that do not uniformly exist. Until each is
 * demonstrated with a live key, this project should not claim it works — see `MILESTONES.md` 1.2.
 */

/** A live credential. Opaque on purpose: it has no accessor and no `toString`. */
export interface ResolvedCredential {
  readonly __brand: "ResolvedCredential";
  /** Never serialized. Held only for the duration of one upstream call. */
  readonly _opaque: never;
}

export interface UpstreamRequest {
  readonly provider: string;
  readonly model: string;
  readonly path: string;
  readonly body: string;
  /** The scoped token this request is authorised under, for the provider to record. */
  readonly tokenHash: string;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly body: string;
  readonly requestId: string | null;
}

/**
 * Resolves a real credential and performs one upstream call.
 *
 * The shape is deliberately minimal. A broader interface — one that took arbitrary headers, or
 * exposed a general fetch — would let a caller route a credential somewhere the adapter had not
 * vetted, which is how brokered secrets escape in practice.
 */
export interface ProviderAdapter {
  readonly name: string;
  /**
   * Whether this provider can actually scope a credential. `false` means a raw key would have to
   * be handed over, so the policy layer must refuse rather than pretend the capability exists.
   * A provider that reports `true` without honouring it is the worst case in the system, so this
   * is a claim to be tested per provider, not trusted.
   */
  readonly supportsScopedCredentials: boolean;
  /**
   * Perform one upstream call using a credential this adapter resolved. The credential is
   * returned to the adapter, not handed back to the caller.
   */
  call(
    request: UpstreamRequest,
    credential: ResolvedCredential,
  ): Promise<UpstreamResponse>;
}

/** Thrown when a provider cannot honour the scope it was asked for. */
export class UnscopableProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly capability: string,
  ) {
    super(
      `provider "${provider}" cannot scope a credential for "${capability}". Refusing rather ` +
        `than handing over a raw key: a broker that cannot scope is not a broker, and the whole ` +
        `guarantee would be a claim rather than a control.`,
    );
    this.name = "UnscopableProviderError";
  }
}

/**
 * Gate a capability request on what the provider can actually honour.
 *
 * This is the check that stops the product from quietly regressing to YOLO: if the provider
 * cannot scope, the answer is no. It is deliberately conservative and deliberately strict — a
 * capability the adapter has not declared support for is refused.
 */
export function assertScopable(
  adapter: ProviderAdapter,
  capability: string,
): void {
  if (!adapter.supportsScopedCredentials) {
    throw new UnscopableProviderError(adapter.name, capability);
  }
}

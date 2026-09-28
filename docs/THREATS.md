# Threat model

Adversarial analysis of Radius. `SAFETY.md` states what we _guarantee_; this document asks how
each guarantee breaks.

Written before implementation on purpose. A threat model written after the code tends to
describe the code rather than attack it.

---

## 1. Assets

| #   | Asset                                                                  | If lost                                             |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| A1  | **Credentials** — provider keys, tokens, OAuth refresh, deploy secrets | Full compromise of whatever they access             |
| A2  | **Principal identity** — who said what, who authorized it              | Every audit trail becomes worthless                 |
| A3  | **Code integrity** — what actually ran on the host                     | Every other guarantee is decorative                 |
| A4  | **Audit trail** — the record of decisions                              | No forensics, no accountability, no enterprise sale |
| A5  | **Tenant isolation** — the property we sell                            | One customer reads another's data; company over     |

---

## 2. Adversaries

| Class                       | Capability                                        | Assumption                                             |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| **Malicious agent**         | Runs our harness with granted capabilities        | **Primary case.** Assume it is actively hostile        |
| **Prompt-injected agent**   | Same, plus attacker-controlled content in context | Assume injection. Not an edge case                     |
| **Compromised dependency**  | Runs in our process or on the tool path           | Reduce surface; absolute-path invocation; pin versions |
| **Hostile network**         | Observes the plane connection                     | Never carry a credential across it                     |
| **Curious co-tenant**       | A principal on the same plane                     | Physically isolated, not filtered                      |
| **Malicious host operator** | Owns the machine running the agent host           | CAUTION: **Out of scope** — see §7                     |
| **Supply-chain attacker**   | Controls an npm crate we depend on                | Pin exact; audit `install` scripts                     |

---

## 3. Attack surface

```
        human / CI
             │  ← (T1) forged principal, (T2) replayed approval
             ▼
   ┌──────────────────┐
   │  control plane   │  ← (T3) cross-tenant query, (T4) lease split-brain
   └────────┬─────────┘
            │  ← (T5) credential over the wire, (T6) downgrade attack
            ▼
   ┌──────────────────┐
   │   agent host     │  ← (T7) PATH hijack, (T8) sandbox escape,
   │                  │      (T9) symlink escape, (T10) log exfiltration
   │  ┌────────────┐  │
   │  │  sandbox   │  │  ← (T11) tool allowlist bypass
   │  │ ┌────────┐ │  │
   │  │ │ agent  │ │  │  ← (T12) prompt injection, (T13) queue data loss
   │  │ └────────┘ │  │
   │  └────────────┘  │
   └────────┬─────────┘
            ▼
      harness (claude, codex, …)  ← (T14) malicious harness, (T15) PATH demotion
```

and separately, on the host's disk:

```
   cached scoped token  ← (T16) theft within the lease window
```

---

## 4. Threats

### T1 — Forged principal identity

**Attack:** present another principal's id and act as them.
**Mitigation:** principals resolved from a **verified** broker token, not a client-supplied
header. `broker_token_hash` stored, never the token.
**Failure mode:** accepting an `X-Principal-Id` header. That header is a suggestion.
**Test:** a request with a valid id but a mismatched token is rejected.

CAUTION: Tenant resolution happens **once, at the edge, before touching a DO.** Resolving inside a DO
means the DO has already accepted an unverified claim.

### T2 — Replayed approval

**Attack:** capture an `allow` response, replay it to obtain a fresh grant.
**Mitigation:** every grant is **time-boxed** and bound to `(principal, launchId, capability)`.
Replaying a _decision_ is idempotent (`request_id` unique). Replaying the _grant_ buys only its
remaining lifetime.
**Failure mode:** issuing grants with no expiry — then a captured grant is permanent.
**Test:** a grant from an expired lease is rejected.

### T3 — Cross-tenant data access

**Attack:** any path by which tenant A reads tenant B.
**Mitigation:** one DO per tenant, one SQLite each. Data is **physically absent**, not filtered.
**Failure mode:** a shared table, a cache keyed wrongly, a log line mixing tenants, an analytics
pipeline that ignores the boundary.
**Test:** two tenants on one plane, exhaustive query from A, assert B's rows are unreachable —
including error messages, counts, and timing.

CAUTION: **Isolation is of data, not of inference.** A noisy tenant can be _observed_ to be noisy.
Stated in `SAFETY.md` §3 and it must stay stated.

### T4 — Lease split-brain

**Attack:** two controllers both believe they own a session. Interleaved writes corrupt state
or duplicate side effects.
**Mitigation:** `leases.epoch` as a **fencing token**. The DO rejects writes carrying a stale
epoch, always.
**Failure mode:** lease expiry without a fencing token. A partitioned holder comes back and
still writes. This is a real, common bug — the epoch is not optional.
**Test:** force a partition, let both sides think they hold the lease, assert the stale one is
rejected.

### T5 — Credential crossing the wire

**Attack:** observe or compromise the plane↔host link, capture a credential.
**Mitigation:** **the plane never sends a credential.** It sends permission; the host's broker
resolves the secret locally. Raw credentials exist only in broker memory.
**Failure mode:** "it's encrypted in transit" as the control. Encryption protects a channel; not
sending the secret removes the target.
**Test:** assert no credential-shaped value appears in any plane→host payload.

CAUTION: This is the single most important structural decision in the design. If it inverts — plane
resolves and ships the secret — A1 and the whole broker model collapse.

### T6 — Downgrade attack

**Attack:** a compromised host claims an older protocol version with permissive defaults.
**Mitigation:** a host seeing an unknown `v` **rejects and reports.** Unknown record kinds are
retained, not dropped.
**Failure mode:** best-effort parsing of an unrecognized version. Silent misparse of a
security-relevant record is worse than a failed sync.
**Test:** a v1 host against a v2 plane with a tightened default **fails loudly**.

CAUTION: **Tightening a default is a major version change** (`PROTOCOL.md` §8). A host must never
lose its sandbox by upgrading.

### T7 — PATH hijack

**Attack:** a profile script or attacker drops a binary earlier on `PATH`, so tool calls invoke
the attacker's `git`, `curl`, or `python`.
**Mitigation:** **invoke every injected helper by absolute path.** oar documents this after
probing it: _"codex demotes injected entries on Linux and macOS — `path_helper`/`.zprofile` can
drop them."_
**Failure mode:** passing injected binaries via `env.PATH` and hoping. It is documented not to
work reliably.
**Test:** the invariant checker **fails** if a helper is ever launched by bare name.

CAUTION: This is the most likely _real_ vulnerability in the system, and it is silent. It belongs in
`check:invariants`, not in a code review.

### T8 — Sandbox escape

**Attack:** break out of the runtime's isolation into the host process.
**Mitigation:** tiered (see `SAFETY.md` §5). Tier 1 tool allowlist, tier 2 process/FS
isolation, tier 3 WASM/VM boundary.
CAUTION: **Four of five runtimes have no native sandbox.** We supply it. Until tier 3 is _measured_,
we do not claim sandbox strength beyond the runtime's own.
**Failure mode:** claiming tier-3 protection in docs before it exists. A safety doc that
overclaims is worse than one that says "we do not protect against this."

### T9 — Filesystem escape via path traversal or symlinks

**Attack:** a task scoped to `src/` writes to `~/.ssh/` via `../` or a symlink.
**Mitigation:** resolve paths and **verify the resolved real path** is inside the granted scope.
Check after resolution, not before — a symlink passes a naive prefix check.
**Failure mode:** `startsWith(scope)` on an unresolved path.
**Test:** traversal, symlink, and absolute-path attempts all fail.

### T10 — Secret exfiltration through logs or traces

**Attack:** a secret reaches a log line, a trace span, an error message, a crash report.
**Mitigation:** no secret in any durable field (`DATA-MODEL.md` §4). Scoped, hashed broker
tokens. Structured redaction at the logger, not at each call site.
**Failure mode:** logging a config object "for debugging" when it holds a key. This has
happened to essentially every system that has ever leaked a credential.
**Test:** a suite that seeds a canary secret and asserts it appears in **no** output — logs,
traces, error bodies, crash dumps.

CAUTION: Note the interaction with T5: if a secret is in the broker's memory and the broker logs its
own state, the log becomes the exfiltration path. Redaction must be structural.

### T11 — Tool allowlist bypass

**Attack:** invoke a tool not on the allowlist, or a shell escape through an allowed one.
**Mitigation:** deny-by-default; the broker adjudicates every invocation, not the agent.
**Failure mode:** allowlisting by name when a tool has arbitrary code execution behind it.
**Test:** an unlisted tool is refused; a listed tool cannot reach a denied resource.

### T12 — Prompt injection

**Attack:** attacker-controlled content in a repo, issue, or web page instructs the agent to
exfiltrate secrets or widen its own scope.
**Mitigation:** **assume injection.** Containment, not detection. The broker owns the
principal's system prompt — the agent cannot rewrite it (`ADAPTERS.md` §5.3). Capability scope
is set by grants, not by what the agent believes it was asked to do.
CAUTION: **We do not claim injection resistance** (`SAFETY.md` §3). The mitigation is that a
successfully injected agent is still _bounded_.
**Test:** an injected agent's attempted escalation produces a denied record and an `approvals`
row, not a wider grant.

### T13 — Queue data loss

**Attack:** not an attack — a failure. A host crash eats queued input that a UI showed as safe.
**Mitigation:** `capabilities.queue.durable` read from the runtime, reflected honestly.
CAUTION: Only Codex persists a queue. Claude, Pi, and ACP do not.
**Failure mode:** a UI showing "queued" for a non-durable runtime. **Silent user data loss.**

### T14 — Malicious or compromised harness

**Attack:** the harness itself is hostile — it exfiltrates, or ships a modified binary.
**Mitigation:** pinned versions; verify integrity where feasible; `listModels`/`accountUsage`
are optional and feature-detected, so a hostile adapter's absence is visible.
CAUTION: **Out of scope for protection** (`SAFETY.md` §3). A harness is trusted code we spawn. A
trojaned Claude Code is a different threat class, and pretending otherwise is dishonest.

### T15 — Dependency compromise

**Attack:** a compromised npm crate executes in our process or at install time.
**Mitigation:** `pnpm` overrides; pin exact for oar; `--frozen-lockfile` in CI; review
`install` scripts on new dependencies; `postinstall` runs arbitrary code.
CAUTION: **oar is our largest third-party trust surface** and it is pre-1.0, shipping breaking
changes. That is a real, accepted risk — recorded in `DECISIONS.md` D-003.

### T16 — Cached offline token theft

**New to this document, and it exists only because of a decision we made.** The offline-lease
design ([`decisions/D-008-offline-grant-lease.md`](decisions/D-008-offline-grant-lease.md)) caches
a scoped token on the host so an agent survives a network outage. An online-only design has no
such token, so this attack surface does not exist without that decision — and making the decision
obliges us to record what it introduces.

**Attack:** an attacker with the host — stolen laptop, borrowed machine, a colleague with physical
access — reads the cached token from disk and replays it for the remainder of its lease.

**Mitigation:** the cached artifact is a _scoped_ token, not a credential. It buys one
`(principal, launchId, capability)` triple, never an account. The lease is enforced **by the host**
and bound against **monotonic time**.

**Failure modes, in order of likelihood:**

1. **Caching the raw credential instead of a scoped token.** This is design A, rejected outright.
   A test asserts no credential-shaped value reaches host disk (I1).
2. **Enforcing expiry only on the plane.** A host that cannot reach the plane cannot ask, so an
   offline agent would hold the capability indefinitely. The host enforces expiry locally.
3. **Wall-clock-only expiry.** `Date.now()` moves backwards. Without the monotonic bound, a user
   setting the clock back converts a 1-hour lease into an unlimited one — turning the design back
   into A without touching any code. This is the one that would have slipped through.
4. **Silent expiry.** A denial with no visible event is how a product loses trust unnoticed.

**Test:** invariant I14 — a monotonic lease is not extended by wall-clock rollback, including
across a process restart.

**Explicitly not claimed:** this does not protect against a host compromise _during_ the lease
window. Anyone holding the laptop for that hour holds that one capability. That is the accepted
cost of offline operation and it is stated in `SAFETY.md` §3, not buried here.

### T17 — A second writer to the managed installer's upgrade journal

**New to this document, and it exists only because of a decision we made.** Radius installs and
drives its own copy of k-carrier (D-004, vendored verbatim), so k-carrier is a _managed package_
in its own fleet model — an install whose upgrades are owned by us, not by itself.

**Attack:** the managed copy is also able to self-upgrade. Now two independent drivers journal
into the same two-slot state on a machine nobody is watching. The Lean 4 proofs
(`never_dual_run`, `never_bricked`, `write_ahead`) quantify over a _single_ transition relation;
a second driver is outside the model, so the guarantees we advertise in `README.md` simply do
not apply to it. The outcome is the one we vendored the thing to prevent: a dual-running or
bricked host, reached through the door the proof came through.

**Mitigation:** the managed copy is installed with ownership `ManagedElsewhere` and is never
driven into a transaction by anything but the Radius supervisor. k-carrier enforces this
itself — `k.managed-copy-never-self-upgrades` in `vendor/k-carrier/src/invariants.rs` reports a
violation whenever a `ManagedElsewhere` install is found in any phase other than `Idle`. Radius
is the only writer; the copy is the thing that is upgraded, never the thing that upgrades itself.

**Why this is a real check and not a promise:** the invariant is declared in vendored source
that lives in this repo, so `pnpm check:invariants` asserts it is still present and still guards
on the same condition. Re-vendoring a version that drops or weakens it fails the build rather
than quietly narrowing a guarantee we print on the tin.

---

## 5. Threats we explicitly do not defend

| Not defended                              | Why                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------- |
| **Local attacker on the host**            | Code execution as the user owns the machine. Out of scope           |
| **A hostile harness**                     | Trusted code we spawn                                               |
| **Prompt-injection _resistance_**         | We bound impact, not detect                                         |
| **Inference from side channels**          | Isolation is of data, not of observation                            |
| **The platform operator turning hostile** | Operator access is a different security model (see `OPERATIONS.md`) |
| **Physical attacks**                      | Out of scope                                                        |

---

## 6. Coverage

Invariant IDs are assigned by the invariant, not by threat order, so the numbering stays stable
when a threat is added or removed. `I1` is the credential invariant because it is the one
everything else leans on.

| Invariant | Threat  | Claim                                                                                       | Test                                                 |
| --------- | ------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **I1**    | T5, T10 | no secret-shaped value in any durable field, log, trace, or wire payload                    | canary secret absent from all output and payloads    |
| **I2**    | T1      | a request with a mismatched token is rejected; principal is never read from a client header | mismatched token rejected                            |
| **I3**    | T2      | grants are time-boxed; a replayed decision is idempotent; an expired lease is refused       | expired lease rejected                               |
| **I4**    | T3      | two-tenant exhaustive query                                                                 | two-tenant exhaustive query                          |
| **I5**    | T4      | a stale lease epoch is rejected on every write                                              | partitioned stale epoch rejected                     |
| **I6**    | T6      | an unknown protocol version is rejected, not best-effort parsed                             | unknown `v` rejected                                 |
| **I7**    | T7      | helpers are invoked by absolute path, never by bare name                                    | helper never launched by bare name                   |
| **I8**    | T8      | sandbox strength is measured, or not claimed in docs                                        | measured, or not claimed                             |
| **I9**    | T9      | the resolved real path is inside the granted scope                                          | resolved path must be in scope                       |
| **I10**   | T10     | structured redaction at the logger; canary absent from every output channel                 | canary absent from all output                        |
| **I11**   | T11     | an unlisted tool is refused                                                                 | unlisted tool refused                                |
| **I12**   | T13     | a non-durable queue is surfaced honestly, never as "queued"                                 | non-durable queue surfaced honestly                  |
| **I13**   | T15     | installs are locked; no unreviewed postinstall                                              | `--frozen-lockfile` in CI                            |
| **I14**   | T16     | a monotonic lease is not extended by wall-clock rollback                                    | lease not extended by clock rollback, across restart |
| **I15**   | T17     | a managed copy never self-upgrades; Radius is the only writer to the upgrade journal        | managed copy never self-upgrades                     |

T12 (prompt injection) has no invariant by design. We do not claim injection _resistance_ — the
mitigation is containment, and the test is behavioural: an injected agent's attempted escalation
produces a denied record and an `approvals` row, not a wider grant.

**I1–I14 are specified in `docs/THREATS.md` and verified as a specification by
`pnpm check:invariants`.** They are not yet enforced in code — `packages/broker` does not exist.
A passing check means the specification is complete and cross-consistent, not that the system is
safe. It becomes a behavioural checker in phase 1. A threat with no invariant is a worry, not a
control.

**I15 is different in kind, and the difference is the point.** It is not ours — it is declared
and enforced by the vendored k-carrier (`vendor/k-carrier/src/invariants.rs`), and that source
lives in this repository. So it is checked against the real thing rather than against a
sentence: the script asserts the invariant is still declared and still guards on the same
condition. It is the only entry in the table that is behaviourally verified today, and it is
verified precisely because we chose to vendor rather than depend.

| Kind         | Count | What a pass means                                                                                        |
| ------------ | ----: | -------------------------------------------------------------------------------------------------------- |
| **Spec**     |    14 | I1–I14 are stated consistently across docs. **Not** enforced in code — `packages/broker` does not exist. |
| **Vendored** |     1 | I15 is asserted against real vendored source; a re-vendor that weakens it fails this check.              |

---

## 7. Reporting

`SECURITY.md` — private disclosure, no bounty at launch. A safety product that publishes
vulnerabilities on day one has not applied its own model to itself.

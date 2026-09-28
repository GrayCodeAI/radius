# D-008 — Offline grant lease: the Phase 1 design decision

**Status:** CLOSED 2026-09-28. All three questions answered; the six implementation conditions
below are now requirements, not suggestions.

**Decision:** cached, scoped, expiring tokens. **Default lease 1 hour.** Long leases exist only
as a human-approved, audited grant. Leases are bound against monotonic time, so clock rollback
cannot extend one.

Consequences: design A (cache raw credentials) is permanently out. The blast radius of a stolen
laptop is one capability for one hour, extendable only by a human who chose to.

---

## 1. The problem

An agent host on a laptop loses connectivity constantly. Sleep, a tunnel, a captive portal, a
conference room, a plane. The control plane cannot be reached, so the broker cannot be asked for
anything.

Three designs follow from that, and two of them are unacceptable:

| Design                               | What happens                                   | Verdict                                                                                                                 |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A. Cache raw credentials**         | The agent keeps working fully offline          | Unacceptable. A stolen laptop yields every credential, defeating G1 permanently. The blast radius is unbounded in time. |
| **B. Cut the agent off immediately** | No connectivity, no capability                 | G1 holds trivially and the product is useless. An agent that stops the moment it loses WiFi is not a product.           |
| **C. Cache scoped, expiring tokens** | Works offline until the lease ends, then stops | The candidate. Bounded in time _and_ in scope.                                                                          |

Design A is the one that looks best in a demo and is catastrophic in an incident.

---

## 2. Why C is the only candidate, and why it is still not free

A cached token is narrower than a credential — scoped to a `(principal, launchId, capability)`
triple — but it is still a bearer token. Two properties make it acceptable:

1. **Time-boxed.** It expires. The window is the bound on exposure.
2. **Single-purpose.** It buys one capability, not the account.

**The lease length is the entire trade-off:**

| Lease    | Exposure if laptop stolen | Product impact                            |
| -------- | ------------------------- | ----------------------------------------- |
| 5 min    | Negligible                | Agent dies constantly. Useless overnight. |
| 1 hour   | An hour of one capability | Tolerable                                 |
| 24 hours | A day of one capability   | The laptop is the credential              |
| Never    | The laptop is the account | Design A by another name                  |

---

## 3. The decision, answered

All three questions were put to the accountable owner and answered on 2026-09-28.

**Q1 — What is the default lease? ANSWERED: 1 hour.**

Overridable per principal down to 5 minutes. Never settable above the deployment's own ceiling.
Long enough to survive a coffee break, a flight, or a redeploy; short enough that a stolen
laptop leaks one capability for an hour rather than a day.

**Q2 — Does an explicit long-lease grant exist? ANSWERED: yes, human-approved and audited.**

A long lease is a `capabilities` row with a long `expires_at` and an `approval_id`. It is never
a config default. The distinction is the point: a default nobody chose is a policy, while an
escape hatch someone chose is a decision, and the audit log can say who and why.

**Q3 — What does the UI say at expiry? ANSWERED: a visible, recorded event.**

Not a silent denial, not a "reconnecting…" spinner. A user whose agent stopped because its lease
expired is owed a plain explanation, and the audit log records it. A silent failure here is how a
product loses a user's trust without anyone noticing.

**Q4 — Clock rollback. ANSWERED: bind leases against monotonic time.**

This was the fourth question and it is the one that decides whether the other three hold. A user
with host access who sets the clock back would otherwise turn a 1-hour bound into an unlimited
one — converting design C back into design A without changing any code. The lease must be
measured against a non-reversible source.

Implementation note: `Date.now()` is wall-clock and moves backwards. A lease must be stamped
against `process.hrtime.bigint()` (monotonic since process start) combined with a wall-clock
issue time captured when the grant is received, so the two are reconciled once and then only the
monotonic side is trusted. Restarting the process resets the monotonic clock, so the reconciliation
must be re-derived from persisted state on start — and if the persisted state shows the monotonic
window has already elapsed, the lease is expired regardless of the wall clock.

---

## 4. What has to be true for C to be safe

Now requirements, not preferences. If any is false, C degrades into A. These become the
implementation checklist for `packages/broker`.

- [ ] The cached artifact is a **scoped token**, never a credential. A test asserts a
      credential-shaped value never reaches the host's disk (invariant I1).
- [ ] The token **cannot be widened offline** — no escalation path exists without the plane.
      A cached token buys exactly the capabilities it was issued for.
- [ ] The **expiry is enforced by the host**, not merely by the plane. A host that trusts the
      plane's clock to revoke is trusting a party it cannot reach.
- [ ] **Clock rollback does not extend the lease** (Q4). The lease is bound against monotonic
      time and reconciled with the wall clock exactly once, on receipt.
- [ ] Reaching the expiry is a **visible, audited event** (Q3), distinguishable from a network
      failure in both the logs and the UI.
- [ ] The lease **cannot be refreshed offline**. Refresh requires the plane. Otherwise a long
      offline session silently becomes an unbounded one.

The clock-rollback condition is the one most likely to be skipped, and it is the one that would
have silently converted a 1-hour bound into an unlimited one.

---

## 5. The security argument, stated honestly

**What C gives us:** an agent that survives ordinary network loss, with a credential exposure
bounded by the lease window and scoped to a single capability.

**What C does not give us:** protection against a host compromise. Anyone with the laptop during
the lease window has that one capability. This is not a bug in the design; it is the cost of
offline operation, and it is the thing a user must be told when they enable it.

**What would change the answer:** a deployment that cannot tolerate even an hour of exposure —
regulated data, production credentials — should be configured with a short lease and accept
more interruption. That is a configuration choice per deployment, which is why the default
cannot be one size.

---

## 6. Decision

Adopt C, as answered in §3: **1 hour default**, overridable down to 5 minutes, long leases only
via a human-approved audited grant, host-enforced expiry bound against monotonic time, and a
visible recorded event at expiry.

**The new attack surface.** A cached bearer token does not exist in an online-only design, so
design C introduces a threat the online model does not have. T16 in `docs/THREATS.md` records it,
because adding a capability that widens the threat model obliges us to document the widening.

**One thing this decision does not fix:** the deployment ceiling. A deployment that cannot
tolerate an hour of exposure — regulated data, production credentials — sets a shorter lease and
accepts more interruption. That is per-deployment configuration, which is exactly why the default
cannot be one size.

---

## 7. Follow-through

Propagated to:

| Document                            | Change                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `docs/SAFETY.md` §2 G5, §4          | lease default, long-lease rule, expiry behaviour                 |
| `docs/DATA-MODEL.md` `capabilities` | `expires_at` now carries a stated default, not just a constraint |
| `docs/PROTOCOL.md` §6               | `capability.grant` carries `expires_at` and `monotonic_bound`    |
| `docs/THREATS.md`                   | new threat T16, and invariant I14 for clock rollback             |
| `docs/ROADMAP.md` phase 1           | phase 1 no longer has an open design question                    |
| `docs/DECISIONS.md` D-008           | status closed                                                    |

**Implementation must not begin until T16/I14 exist in the threat model.** A lease that is not
threat-modelled is a lease that will be reviewed by nobody.

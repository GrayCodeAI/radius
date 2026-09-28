# Safety

**This document is the product.** Radius's differentiation is not that agents talk to each
other — everything else does that. It is that they can do so _unattended, on a machine nobody
is watching, holding credentials they cannot escape._

Publishing it and letting it be audited is the whole strategy. If we claim to be the careful
ones, this file is the proof.

---

## 1. Threat model

### Adversaries

| Class                        | Capability                                        | Our posture                                                 |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| **A misbehaving agent**      | Runs our own harness, with granted capabilities   | Contain. This is the primary case.                          |
| **A prompt-injected agent**  | Same, plus attacker-controlled content in context | Contain. Injection is assumed, not exceptional.             |
| **A compromised dependency** | Runs inside our process or on the tool path       | Minimize surface; absolute-path invocation; pinned versions |
| **A hostile network**        | Observes the control plane connection             | Never send a credential over it                             |
| **A curious co-tenant**      | Another principal on the same plane               | Physically isolated, not filtered                           |
| **A local attacker**         | Code execution as the user, on the host           | **Out of scope** — documented as such                       |

### Assets

1. **Credentials** — provider API keys, tokens, OAuth refresh tokens, deploy secrets
2. **Principal identity** — who said what, and who authorized it
3. **Code integrity** — what actually ran on the host
4. **Audit trail** — the record of decisions 1–3

---

## 2. Guarantees

These are the claims. Each needs a named invariant in code and a test that fails if violated.

### G1 — An agent never holds a raw credential

Brokered and scoped. An agent receives a capability token bound to a `(principal, launchId,
capability)` triple. Raw credentials exist only inside the broker, which is the sole holder.

**Structural, not advisory.** Following agent-vault's insight — a guarantee that holds because
of a _design property_ rather than a policy we chose. agent-vault makes it impossible for an
agent to run a sensitive command because an agent has no TTY. Find the same class of
structural argument here: the raw credential is not merely "not passed to the agent", it is
not _addressable_ by anything the agent can name.

### G2 — Sandbox on by default

Every runtime starts sandboxed. Escalation is explicit, audited, and recorded. No opt-out
without a record.

CAUTION: **This inverts our upstream dependency.** `@botiverse/oar` ships sessions with
interactive permission gates disabled and sandboxes off, and documents this as deliberate:
_"In embedded use nobody sits at an approval prompt: a gate is a hang, not safety."_ That is
correct for a human watching a terminal and wrong for our case.

### G3 — Every privilege escalation is recorded

`approvals` is a table, not a UI. A human decision cannot double-apply (idempotent by request
id). The audit log records principal, capability, decision, and time.

### G4 — Tenants are physically isolated

One Durable Object per tenant, one SQLite per DO. Cross-tenant data is absent from the
database, not excluded by a `WHERE` clause. We own this code (see `PLAN.md` §12) precisely
because it is the property we must be able to prove.

### G5 — Capability grants are scoped, time-boxed, and revocable

A grant has an expiry. Narrowing a grant does not require restarting the agent. Revocation
takes effect without a reconnect round-trip.

### G6 — The host cannot brick itself

Upgrades are two-slot, journaled, probe-then-commit, and machine-checked in Lean 4
(`never_dual_run`, `never_bricked`, `write_ahead`) with non-vacuity examples. Vendored
verbatim from k-carrier; we do not fork it.

### G7 — One controller per session

Leases are the exclusive claim. Split brain is impossible by construction and **tested**, not
reasoned about.

---

## 3. Non-guarantees

Stated as plainly as the guarantees, because a safety doc that only lists wins is marketing.

| We do **not** claim                                 | Why                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Protection from a local attacker**                | Anyone with code execution as the user on the host owns the host. Out of scope.                                                                                                                                                |
| **Sandbox strength beyond the runtime's own**       | Claude, Kimi, Grok, and Pi have **no native sandbox**. We provide process/FS isolation; we do not conjure a hypervisor.                                                                                                        |
| **That the agent's output is correct**              | We bound what it can reach, not what it decides.                                                                                                                                                                               |
| **Resistance to a malicious harness**               | A harness is trusted code we spawn. A hostile Claude Code build is a different threat class.                                                                                                                                   |
| **Exactly-once delivery of agent output**           | At-least-once with idempotent consumers. Exactly-once is claimed only on the `approvals` path, where idempotency is by construction.                                                                                           |
| **Prompt-injection resistance**                     | We assume injection. Containment is the mitigation, not detection.                                                                                                                                                             |
| **Protection of a co-tenant's _inferred_ activity** | Isolation is of data, not of inference. A noisy tenant can be _observed_ to be noisy.                                                                                                                                          |
| **Bounded memory under a runaway producer**         | oar's record observer is synchronous and offers no flow-control channel, so a runtime emitting faster than we fsync grows `RecordWriter.pending` without limit. We bound _loss_ on a hard kill; we do not bound _queue depth_. |

---

## 4. Credential broker design

The core mechanism. Every guarantee above leans on it.

### Flow

```
  human / service
        │ authorizes a capability once, explicitly
        ▼
  ┌──────────────┐   holds the raw credential
  │   BROKER     │   sole owner. Not addressable by the agent.
  └──────┬───────┘
         │ issues scoped token bound to (principal, launchId, capability)
         ▼
  ┌──────────────┐
  │ agent host   │  → agent context sees a token, never a key
  │  (loopback)  │
  └──────────────┘
```

### Token properties

- Scoped to a `(principal, launchId, capability)` triple
- **Time-boxed** — expires, so a cached grant cannot outlive its authorization
- Revocable without agent restart
- Unguessable, per-launch nonce
- Loopback only; never crosses the plane

### Design rules

1. **No secret in a log line, ever.** Enforced by a test that greps the output, not by review.
2. **No secret in a trace span.** OTel attributes are agent- and operator-visible.
3. **The broker is the only raw-credential holder.** If a second component needs one, the design
   is wrong.
4. **Denial is a first-class outcome**, recorded like any other decision.

### Offline behavior

**Decided — see [`decisions/D-008-offline-grant-lease.md`](decisions/D-008-offline-grant-lease.md).**

An offline host caches a **scoped, expiring token**, never a credential. Caching a credential
destroys G1 the moment the laptop is stolen; cutting the agent off makes the product useless.

- **Default lease: 1 hour.** Overridable down to 5 minutes. A deployment that cannot tolerate an
  hour of exposure sets a shorter one and accepts more interruption — which is why the default
  is not one size.
- **Long leases exist only as a human-approved, audited grant** — a `capabilities` row with a
  long `expires_at` and an `approval_id`. Never a config default. A default nobody chose is a
  policy; an escape hatch someone chose is a decision the audit log can explain.
- **The host enforces expiry**, not the plane. A host that cannot reach the plane cannot ask.
- **The lease is bound against monotonic time.** `Date.now()` moves backwards, and a user who
  winds the clock back would otherwise turn a 1-hour bound into an unlimited one.
- **Expiry is a visible, recorded event.** Not a silent denial, not a spinner.
- **No offline refresh.** Refresh requires the plane, or a long session silently becomes
  unbounded.

**What this does not protect against:** a host compromise _during_ the lease window. Anyone with
the laptop for that hour has that one capability. That is the cost of offline operation, and it is
why the lease is one hour rather than one day.

---

## 5. Sandbox policy

Per-runtime, capability-detected. See `ADAPTERS.md` for the live matrix.

**Deny by default.** Every allowance is an explicit grant written to `approvals`.

| Runtime | Native sandbox       | Radius default                              |
| ------- | -------------------- | ------------------------------------------- |
| Codex   | `danger-full-access` | `workspace-write`; escalate via `approvals` |
| Claude  | none                 | process/FS isolation + allowlisted tools    |
| Kimi    | none                 | as above                                    |
| Grok    | none                 | as above                                    |
| Pi      | none                 | as above                                    |

CAUTION: **Expect per-runtime divergence to be the main "works on my machine" source.** Four of
five have no native sandbox, and oar documents a related trap: a runtime that launches tools
through a login shell (codex: `zsh -lc`) lets profile scripts rebuild `PATH` — _probed:
codex demotes injected entries on Linux and macOS_. **Invoke injected CLIs by absolute
path.** A downgraded tool path is a security bug, not a config nit.

---

## 6. Audit

Every broker decision and every escalation produces an immutable `audit_log` row:
principal, capability, target, decision, reason, timestamp, `launchId`.

Queryable by agents through the same API as humans — the same "agents and humans are peers"
thesis applies to audit. An agent debugging its own permission failure is a real use case.

**Retention and immutability are open questions.** An append-only log that can be edited by
the thing it audits is not an audit log. Decide whether this needs external anchoring
(a transparency log, periodic hash chain) before phase 3.

---

## 7. Invariant enforcement

Guarantees that are not executable are comments.

- Every guarantee above has a **named invariant** in `packages/broker`
- `pnpm check:invariants` asserts them; **a failure blocks merge**
- Each invariant has a **regression test that fails if it is violated**
- New capabilities require a new invariant before they can be granted

**This is a direct lesson from the dependency survey.** `antiproton` is 15.6k lines with **zero
test files** and excellent ideas. A crash-safety or isolation claim without a test is a
comment, not a claim. We are explicitly not copying that.

---

## 8. Reporting a vulnerability

`SECURITY.md`. Private disclosure, no bounty initially. A safety product that handles
vulnerabilities publicly on day one has not thought about its own model.

# Decisions

Architecture decision records. Each is a real decision with a real alternative that was
rejected, and the reason.

**Superseded decisions are kept, not deleted.** The reasoning is the value; knowing what we
tried and why it lost is what stops the same debate recurring.

---

## D-001 — Name: Radius

**Date:** 2026-09-28 · **Status:** accepted

Chosen over a nautical set (Halyard, Binnacle, Loran) and a comms set (Sigil, Relay, Conduit).

Three meanings, all accurate: bounded reach (an agent's capability scope), the relation between
a principal and its center (the workspace), and RADIUS the AAA protocol (we broker credentials).

Domain `radius.graycodeai.com`. `radius.com` is held at MarkMonitor to 2026-11-07 and is likely
renewed; the subdomain is the permanent answer. `radius.sh`, `radius.run`, `radius.build` free.

Always cited as **Radius by GrayCode AI** — collides with a graphics API, a database feature,
and the RADIUS protocol.

**Alternative rejected:** Sigil — strong identity metaphor and npm-available, but `.com` and
`.app` taken. The comms-naming space is picked over; 13 of 13 obvious names were taken.

---

## D-002 — License: MIT

**Date:** 2026-09-28 · **Status:** accepted

MIT our own code. Stronger than Apache-2.0 for the target buyer: a security scanner recognizes
MIT without a legal review, which is the whole FSL-refugee pitch.

**Accepted cost:** no explicit patent grant. Acceptable at this size; grantable separately later.

**Mechanism:** third-party components stay in `vendor/` with LICENSE + NOTICE intact, because
Apache-2.0 §4 requires retention and MIT has no mechanism for it. Never flatten `vendor/` into
`packages/`.

**Alternative rejected:** dual-license (MIT + commercial). Adds legal complexity for no current
revenue, and weakens the "ship open, sell the service" story.

---

## D-003 — Depend on `@botiverse/oar`, do not fork

**Date:** 2026-09-28 · **Status:** accepted

Apache-2.0, published, `0.6.0` is the highest published version (verified 2026-09-28). Five
harnesses, 58 test files, ~4,950 lines.

Forking would mean re-implementing adapter fixes for Claude/Codex/Grok/Kimi forever. The value
is upstream tracking.

**Pin exact** — pre-1.0, ships breaking changes.

**Alternative rejected:** fork to add a 6th harness. Costs upstream tracking, buys a week.

**Known risk:** pre-1.0 API. Accepted, budgeted for breaks.

---

## D-004 — Vendor `k-carrier`, never fork, never reimplement

**Date:** 2026-09-28 · **Status:** accepted

Apache-2.0. 7,390 lines Rust, 13 test files, and Lean 4 proofs of `never_dual_run`,
`never_bricked`, `write_ahead` with non-vacuity examples.

**The principle:** never reimplement a verified crash-safety protocol from source reading.
Getting it subtly wrong bricks users' machines silently.

**Alternative rejected:** reimplement the two-slot journal. Would be a few hundred lines of
clever code with none of the verification.

Vendored at upstream **0.3.2** (verified 2026-09-28 from `Cargo.toml`).

**Not published to crates.io** — no `k-carrier` crate exists. Consumed as a path dependency,
or as a built binary. Do not assume `cargo add k-carrier` works. Note this is a different
artifact from the `@botiverse/k-carrier` npm package Raft patches at `0.1.8`.

**Measured 2026-09-28, because the choice depends on it** (Rust 1.96, `cargo 1.96`):

| Command                     | Result                                                |
| --------------------------- | ----------------------------------------------------- |
| `cargo build --lib`         | **succeeds**, ~11s                                    |
| `cargo test --lib --no-run` | **succeeds**, ~19s — the lib's own unit tests compile |
| `cargo build --all-targets` | **fails**                                             |

The failure is not ours and not a corruption: `Cargo.toml` declares six `[[bin]]`/`[[example]]`
targets and the whole `examples/` directory was never vendored. **Five of six are absent**
(`native-controller`, `native-service`, `native-swap`, `musl-quarantine-probe`, `native-installer`).

**Consequence for this decision:** a **path dependency works** — the library we would actually
depend on is complete and compiles. A **built binary does not**, because building any binary from
this tree as-is requires the example sources, unless the build is scoped to `--lib`. That is
close to decisive and it is the opposite of the instinct to reach for a shipped binary.

Recorded, not silently tolerated: `pnpm check:notices` now parses the manifest and fails if a
declared target is missing and not listed in `knownAbsentTargets`, so a future re-vendor cannot
quietly drop one. A _new_ missing target fails; only this documented list passes.

---

## D-005 — Reimplement `antiproton`'s patterns, do not vendor

**Date:** 2026-09-28 · **Status:** accepted

Apache-2.0, but 15.6k lines with **zero test files**, three weeks old at time of review.

The valuable parts — per-tenant DO isolation, outbox, leases, approvals-as-data — are
_patterns_, reimplemented against our own schema (~3k lines). Their tables carry
pi-specific concerns (`pi_sessions`, `pi_model_jobs`) that do not apply to us.

**The deciding reason:** per-tenant isolation is the property we sell. Inheriting it from an
untested repo puts our headline security claim on someone else's unverified assumption.

**Alternative rejected:** vendor and wrap. Faster initially, and it would have looked faster.

---

## D-006 — No YOLO by default

**Date:** 2026-09-28 · **Status:** accepted

oar ships sessions with interactive permission gates disabled and sandboxes off, deliberately:
_"In embedded use nobody sits at an approval prompt: a gate is a hang, not safety."_ That is
correct for a human at a terminal and wrong for unattended agents.

We invert: sandbox on, credentials brokered and scoped, escalation recorded in `approvals`.

**This is a deliberate disagreement with our own dependency, recorded on purpose.** Four of five
runtimes have no native sandbox, so we must supply isolation ourselves.

**Alternative rejected:** match oar's default for consistency. Consistent and unsafe.

---

## D-007 — Per-tenant Durable Object, one SQLite each — CAUTION: open

**Date:** 2026-09-28 · **Status:** accepted, with an open dependency

One DO per tenant makes cross-tenant data physically absent rather than filtered. That is
guarantee G4.

**Open:** whether a non-Cloudflare plane is needed for segment 3. If yes, the _property_ must
survive while the mechanism changes. **Do not let DO assumptions spread through the code before
this is settled.**

---

## D-008 — Offline grant lease — CLOSED

**Date:** 2026-09-28 · **Status:** closed
**Full write-up:** [`decisions/D-008-offline-grant-lease.md`](decisions/D-008-offline-grant-lease.md)

An offline host cannot ask the broker for anything, and both obvious answers are wrong: caching
raw credentials destroys G1 the moment the laptop is stolen, and cutting the agent off immediately
makes the product useless.

**Decided:** cache _scoped, expiring_ tokens, never credentials. **Default lease 1 hour**,
overridable down to 5 minutes. Long leases only as a human-approved, audited grant. Expiry
enforced by the host and bound against **monotonic time**. Expiry is a visible, recorded event.
No offline refresh.

**Why the clock-rollback condition is the load-bearing part:** without it, a user setting the
system clock back turns a 1-hour bound into an unlimited one, converting the design back into the
credential-caching model it exists to avoid — with no code change at all.

**Consequence:** the decision introduces a threat that did not previously exist (T16, cached
token theft within the lease window) and one new invariant (I14). Both are recorded.

---

## D-009 — Audit log immutability — CAUTION: open

**Date:** 2026-09-28 · **Status:** accepted in principle, mechanism undecided

`audit_log` is append-only by construction (the DO exposes no mutating operations). But an
append-only log editable by the thing it audits is not an audit log.

**Open:** whether external anchoring is needed — transparency log, periodic hash chain — before
phase 3. Also: retention period and D1 growth.

---

## D-010 — `queue.durable` is read, never assumed

**Date:** 2026-09-28 · **Status:** accepted

oar's `capabilities.queue` is `{ durable: boolean } | null` and is not uniform: Codex persists
across restart; Claude, Pi, and ACP hold input for the current process only.

The orchestrator and the UI must both read it. A queued message on a non-durable runtime is
silent user data loss on crash.

**Alternative rejected:** uniform queue semantics in our API. Would be a lie on 4 of 5 runtimes.

---

## D-011 — Absolute-path invocation for injected helpers

**Date:** 2026-09-28 · **Status:** accepted

oar documents, after probing: _"codex demotes injected entries on Linux and macOS —
`path_helper`/`.zprofile` can drop them."_ Login-shell profile scripts can reorder `PATH`.

Every injected helper is invoked by absolute path. Invariant I7 fails the build if a helper is
ever launched by bare name.

**Why it matters:** a downgraded tool path means an attacker-controlled `git`, `curl`, or
`python` may be invoked by a tool call. This is the most likely real vulnerability in the
system and it fails silently.

---

## D-012 — Lease fencing token

**Date:** 2026-09-28 · **Status:** accepted

`leases.epoch` increments on takeover and is checked on every write; a stale epoch is rejected.

Without it, a partitioned holder returns and still writes. Expiry is evaluated by the DO's
clock, never the holder's, so clock skew cannot manufacture or suppress a lease.

**Alternative rejected:** lease without fencing. Common, and it is split brain.

---

## D-013 — Exactly-once only on `approvals`

**Date:** 2026-09-28 · **Status:** accepted

`approvals.request_id` has a unique index, so a replayed decision is an idempotent no-op by
construction. Every other path is at-least-once with idempotent consumers via `seq` dedupe.

**Why this matters:** a team that believes agent output is exactly-once will build delivery on
that assumption and be wrong. The API docs and the pitch must both say this.

---

## D-014 — `decided_by` must be a human

**Date:** 2026-09-28 · **Status:** accepted

An agent able to approve its own escalation is privilege escalation within a single tenant.
Enforced by a check constraint in the first migration, not by application code.

---

## D-015 — Standalone repo, not a `graycode-platform` workspace package

**Date:** 2026-09-28 · **Status:** accepted

`graycode-platform/AGENTS.md` declares itself the company/platform repo and states _"No other
GrayCode project may depend on this repo."_ Radius is a product, not platform infra.

Node engine is **`>=24.0.0`**, unlike the platform's `>=22.0.0`, because oar requires Node 24.
This is a real divergence, not an oversight.

---

## D-016 — `raft-source` cannot be copied

**Date:** 2026-09-28 · **Status:** accepted, pending a license conversation

FSL-1.1-ALv2. The Competing Use clause forbids shipping software that "offers the same or
substantially similar functionality." Radius is that product.

Converts to Apache-2.0 on **2028-09-24** for `v1.13.0-source.1`, irrevocably.

**A commercial license has been discussed and is being pursued.** Until it exists in writing,
the code does not enter the repo. This does not change the architecture — `oar`, `k-carrier`, and
the reimplemented patterns cover the platform, and phases 0–1 are ours regardless.

---

## D-017 — `opencan` is unusable despite being a perfect fit

**Date:** 2026-09-28 · **Status:** accepted

AGPL-3.0. Strong copyleft — linking it would make the entire project AGPL. It is an iOS client
for the Agent Client Protocol, which is exactly what a Radius mobile app would want.

**Path if we build one:** against `@agentclientprotocol/sdk` (MIT), not `opencan`.

Surfaced late in the audit. This is the kind of thing that would have been discovered after
shipping.

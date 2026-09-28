# Roadmap — phase by phase

Every phase has a **gate**. A gate is an exit criterion you can test, not a feeling that it's
"mostly done." If a gate can't be demonstrated, the next phase doesn't start.

Phase 0 and 1 have full checklists in [`MILESTONES.md`](MILESTONES.md). This document is the
whole sequence and the reasoning between phases.

---

## How the phases are ordered

The ordering principle is **risk-first, not feature-first.** The two riskiest things in this
product are (a) can an agent survive being killed, and (b) can an agent be left running safely.
Both are Phase 0 and 1. Both are invisible to users. Both gate everything user-facing.

That is deliberate and it will feel wrong for the first few weeks, because there is nothing to
show anyone. But the alternative — a beautiful workspace UI sitting on unsandboxed credentialed
agents — is a liability, and you cannot retrofit safety into a running fleet.

**Every later phase is cheaper because of 0 and 1.** Phase 3's exactly-once inbox is only
correct because Phase 2 built the outbox. Phase 4's cost caps only work because Phase 1 issued
scoped, metered capability tokens.

---

## Phase 0 — Local agent host

**Goal:** prove durability. One agent, one machine, no UI.
**Why first:** if the host can't survive a kill, nothing else matters.

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Deliverable** | `apps/agent-host` — supervised process, k-carrier managed, one oar session, stream persisted to disk      |
| **Reuse**       | k-carrier (vendor), `@botiverse/oar` (depend)                                                             |
| **Build**       | supervisor, disk-backed record store, crash harness                                                       |
| **Gate**        | `kill -9` at any point in an upgrade or a session → nothing lost, nothing bricked, no human action needed |

**The key test:** kill the host mid-turn, restart, `afterSeq` reconnect. The stream continues
with no gap and no duplicate. If this works, laptop-sleep and network-loss fall out for free,
because they're the same problem with a slower clock.

**Exit signal:** you would trust it on a laptop you care about.

---

## Phase 1 — Capability broker + sandbox policy

**Goal:** an agent can run unattended on a machine nobody is watching and cannot reach anything
it wasn't granted.
**Why second, and blocking:** this is the entire differentiation. It is also the only part that
is genuinely ours to invent.

|                 |                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deliverable** | `packages/broker` — principals, scoped tokens, per-runtime sandbox policy, lease manager, invariant checker                                                                                                         |
| **Reuse**       | oar's `Session` contract, `AttributionTier`, `capabilities`; antiproton's _patterns_ (leases, outbox, approvals)                                                                                                    |
| **Build**       | Principal model, broker, sandbox policy per runtime, `check:invariants`                                                                                                                                             |
| **Gate**        | A principal cannot obtain a capability it wasn't granted. No credential appears in any agent-visible context, log, or trace. Sandbox on by default. Every escalation recorded. `pnpm check:invariants` green in CI. |

**The design problem that decides the product** — from `SAFETY.md` §4: an offline host cannot
ask the broker for anything, and both obvious answers are wrong. Caching raw credentials
destroys the guarantee the moment the laptop is stolen; cutting the agent off makes the product
useless. The answer is **short-lease scoped tokens**, and the lease default needs an explicit
decision against a stated threat model.

CAUTION: **This is the one genuinely open design question in the whole project.** Do not let it be
settled by whoever writes the first cache. See
[`decisions/D-008-offline-grant-lease.md`](decisions/D-008-offline-grant-lease.md).

**Exit signal:** you would let it run overnight unattended on your own machine.

---

## Phase 2 — Control plane

**Goal:** more than one person, more than one tenant.

|                 |                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Deliverable** | `apps/control-plane` — Cloudflare Worker, per-tenant Durable Object + SQLite, sync endpoints, audit log                        |
| **Reuse**       | antiproton's _patterns_ — reimplemented against our schema, not vendored                                                       |
| **Build**       | tenancy, schema, outbox, cursors, lease arbitration, audit, usage metering                                                     |
| **Gate**        | Two tenants, on the same plane, cannot observe each other's data — and this is demonstrated by a test, not by a `WHERE` clause |

**Why the isolation is structural:** one DO per tenant means cross-tenant data is _physically
absent from the querying database_, not excluded by a predicate. That is why we reimplemented
this instead of vendoring a 3-week-old repo with no tests — it's the property we'd be selling.

**Exit signal:** you could run two customers on it and answer "how do you know they're
isolated?" with a test.

---

## Phase 3 — Workspace

**Goal:** the part users actually touch.

|                 |                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deliverable** | `apps/web` — channels, threads, tasks, agent inbox with exactly-once delivery                                                                                              |
| **Reuse**       | `musik`'s app architecture (read, don't copy — MIT but Raft product code), `hands` admin patterns if we ship apps                                                          |
| **Build**       | the UI, the inbox state machine, attribution rendering                                                                                                                     |
| **Gate**        | An agent offline for six hours receives every message exactly once when it reconnects. `AttributionTier: opaque` runtimes render honestly — no fabricated sub-agent depth. |

**The inbox is the piece that makes agents feel like teammates** and the piece that is
brutal to retrofit. Build it once, correctly. Raft spent 5 files on it; we should not need
that many if the outbox from Phase 2 is right.

CAUTION: **The quiet trap:** `capabilities.queue.durable` is `false` for Claude, Pi, and ACP — only
Codex persists a queue across restart. A UI that shows a queued message as safe will silently
eat it on crash. The orchestrator and the UI must both read the capability.

**Exit signal:** a user would choose this over a terminal and not miss the terminal.

---

## Phase 4 — Fleet orchestration

**Goal:** many agents, bounded cost.

|                 |                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Deliverable** | `packages/orchestrator` — fleet supervision, cost caps, routing, steering                                           |
| **Reuse**       | antiproton's `usage_active` / `usage_held` watermark _pattern_                                                      |
| **Build**       | scheduling, budgets, routing, steering via oar's `steer`                                                            |
| **Gate**        | A hard spend cap cannot be exceeded, including under retry and partial failure. Demonstrated under fault injection. |

**Where value compounds.** Single-agent is a feature. Twenty agents with a guaranteed budget is
a product. This is the phase that makes the cost argument rather than the capability argument.

**Exit signal:** a team would run this instead of a cron job, because the cron job is
unbounded and this isn't.

---

## Phase 5 — Public runtime API

**Goal:** developers build on Radius. This is the real moat.

|                 |                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Deliverable** | `packages/protocol` published as `radius/v1` — stable contract, SDK, docs                                    |
| **Reuse**       | oar's versioning discipline as the model                                                                     |
| **Build**       | the stable surface, compatibility policy, deprecation process                                                |
| **Gate**        | The API is versioned, documented, and you can commit to it for a year without breaking someone's deployment. |

**L1/L2 are defensible; a public protocol is what compounds.** Once developers build agents
against `radius/v1`, the platform gets stickier than any feature set. This is also where the
Apache-2.0/MIT posture pays off most directly — a FSL-licensed product can never offer this.

**Exit signal:** someone builds a Radius agent that we didn't write.

---

## Post-1.0

| Phase                     | Contents                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **6. Ecosystem**          | Plugin SDK, public directory, third-party adapters                                                                   |
| **7. Enterprise**         | Self-hosted support contract, air-gapped deploy, audit export, retention policy                                      |
| **8. Mobile / ACP**       | If wanted — build against `@agentclientprotocol/sdk` (MIT), **not** `opencan` (AGPL)                                 |
| **9. Verification story** | Extend k-carrier's Lean proofs to the broker's own invariants — a real differentiator Raft cannot match on this axis |

---

## Cross-phase work

These don't fit one phase:

| Activity                    | When                     | Why                                                                    |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| **Adapter treadmill**       | continuous, post-Phase 1 | 5 vs Raft's 12 is our weakest number                                   |
| **`docs/SAFETY.md` upkeep** | continuous               | It's the product. Every new capability updates it.                     |
| **`check:invariants`**      | from Phase 1             | Guarantees that aren't executable are comments                         |
| **Migration discipline**    | from Phase 2             | Append-only. Never edit a shipped migration.                           |
| **Blog / spec publication** | from Phase 3             | The FSL window closes 2028-09-24; the safety position is what survives |

---

## The two dates that matter

| Date           | What                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Continuous** | The window where enterprises can't buy an FSL-licensed Raft. Ship the safety position, not the license pitch — the license pitch is dead by 2029.                        |
| **2028-09-24** | `v1.13.0-source.1` converts to Apache-2.0, irrevocably. If Botiverse grants a commercial license sooner, this is moot. Either way: **the product must be ours by then.** |

---

## Sequencing summary

```
0  Host          ─┐
                  ├─ gates everything user-facing
1  Broker+sandbox ┘   ← the differentiator; blocking
2  Control plane     ── multi-tenant
3  Workspace         ── where users live
4  Orchestration     ── value compounds
5  Public API        ── the moat
```

**Phases 0 and 1 are invisible to users and gate everything.** That is the plan, not an
accident. Everything after them is faster because of them.

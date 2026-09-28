# Architecture

Radius in full. Read `PLAN.md` first for the market thesis and dependency calls; this
document is the system design those decisions imply.

---

## 1. The shape of the problem

Three facts constrain everything:

1. **Agents run where the work is** — a developer's laptop, a CI runner, a build box. Not
   in our datacenter.
2. **They run unattended.** Otherwise the product is a terminal multiplexer with a web UI.
3. **They hold credentials.** An agent with a raw key and no sandbox, running while
   nobody watches, is remote code execution we are liable for.

So the architecture is **hybrid by necessity**: a Cloudflare control plane for shared state,
and a local agent host for anything that touches the filesystem or spawns a process. The hard
part is not either half — it is the seam, and making the seam safe.

---

## 2. Layer model

```
┌─ L4 Workspace      channels, threads, tasks, human+agent peers   apps/web
├─ L3 Orchestration  fleet supervision, cost caps, routing          packages/orchestrator
├─ L2 Runtime        durable sessions, sandbox, credential broker   apps/agent-host + packages/broker
└─ L1 Platform       identity, tenancy, storage, observability      apps/control-plane
```

Each layer is independently useful, so L3 can be sold while L4 does not exist. L1 is the moat.

---

## 3. The seam

This is the part that makes hybrid work, and it comes from oar's cursor contract.

**oar gives us a resumable record stream.** Every record the runtime produced is in
`records()`; every record has a monotonic `seq`; a subscriber reconnecting with `afterSeq`
"misses nothing and repeats nothing."

That single property means:

> **The agent host is the source of truth for agent output. The control plane holds state
> and coordination, not the transcript.**

We do **not** stream tokens across the network. The local host persists records to disk on
arrival; the control plane syncs _cursors and state_, and pulls records when needed. A laptop
that sleeps for six hours loses nothing, because the records were never in flight.

**Consequence:** every read path must be honest about being eventually consistent. The UI
must never imply stronger guarantees than the seam provides.

### Sync model

| Direction    | Carries                                          | Guarantee                                               |
| ------------ | ------------------------------------------------ | ------------------------------------------------------- |
| Host → plane | cursor, agent state, task status, usage counters | at-least-once, idempotent by `seq`                      |
| Plane → host | capability grants, task assignment, steering     | ordered per `launchId`                                  |
| Either       | `approvals`                                      | **exactly-once** — a human decision cannot double-apply |

CAUTION: **Exactly-once is achievable only on the approvals path**, because a human decision is
idempotent by construction (a row keyed by request id). Everything else is at-least-once with
idempotent consumers. Do not pretend otherwise in the API surface.

### Offline-first is the default case

A laptop that sleeps mid-turn is not an edge case; it is Tuesday. The design consequences:

- The host must run the full session loop with no plane connectivity
- Capability grants are **cached and time-boxed** — see `SAFETY.md` §4
- The plane must tolerate arbitrarily stale heartbeats without declaring an agent dead
- Reconciliation on reconnect must be a normal, tested path, not a rare branch

---

## 4. L1 — Platform

**Reimplement the per-tenant Durable Object pattern** (see `PLAN.md` §12 — not vendored;
antiproton is 3 weeks old with zero tests).

### Tenancy model

One Durable Object per tenant, each with its own SQLite database. **Cross-tenant data is
physically absent from the querying database**, not filtered by a `WHERE` clause.

This is the isolation property the whole product rests on. It has to be provable, so we own
the code. Reusing antiproton's table _ideas_ is fine; inheriting its _implementation_ would
put our headline security claim on someone else's untested assumption.

### Core tables (our schema, not antiproton's)

| Table            | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `principals`     | humans + agents, identity, center, capability grants |
| `capabilities`   | what each principal may do — the radius              |
| `tasks`          | work items, assigned principal, state                |
| `events`         | control-plane-side activity, monotonic per tenant    |
| `cursors`        | sync position per `(host, session)`                  |
| `leases`         | exclusive session claim                              |
| `outbox`         | dual-write escape hatch                              |
| `approvals`      | human decisions, exactly-once                        |
| `usage_counters` | metering watermarks                                  |
| `audit_log`      | every broker decision, immutable                     |

**Deliberately excluded** from antiproton's schema: `pi_sessions`, `pi_model_jobs` (their
runtime's concerns, not ours), and the `usage_held` burst throttle (our cost model in L3 is
nuanced enough that we'd fork it anyway).

### Patterns to carry over

- **`outbox`** — dual-write is the classic hybrid bug. Outbox-then-settle, or accept that
  plane and host can disagree about what happened.
- **`leases`** — the distributed primitive oar explicitly declines. One controller per session.
- **`approvals` as data** — human-in-the-loop as a table row, not a UI feature. This is what
  makes the safety model auditable.

---

## 5. L2 — Runtime

### Depend on oar, do not fork

`@botiverse/oar` v0.6.0. Five runtimes, ~4,950 lines of adapter code, 58 test files. Forking
buys nothing — the value is upstream tracking harness changes as they land.

CAUTION: **Pin exact.** Botiverse pins oar exactly because oar is pre-1.0 and moves.

### What oar gives us

- `Runtime` contract: `session` required; `installation`, `accountUsage`, `listModels`
  optional and defaulting to a typed `{ kind: "unsupported" }` result
- `AdapterSession`: `prompt` / `steer` / `queue` / `abort` + the record stream
- `AttributionTier`: `none | opaque | attributed | nested` — required for L4 multi-agent UI
- `SessionCapabilities`: `steer: boolean`, `queue: { durable: boolean } | null`
- `SessionOptions`: `cwd`, `model`, `resume`, `env`, `systemPrompt`, `appendSystemPrompt`

### Two traps in oar's contract, both documented upstream

**1. YOLO by default.** oar disables interactive permission gates and sandboxes off. We
invert this. See `SAFETY.md`.

**2. `env` injection is unreliable on local execution.** oar probed it: _"a runtime that runs
tools through a login shell (codex: `zsh/bash -lc`) lets profile scripts reorder or rebuild
PATH (probed: codex demotes injected entries on Linux and macOS `path_helper`/`.zprofile` can
drop them)."_ Their fix: **invoke injected CLIs by absolute path.**

CAUTION: Any capability broker that injects helper binaries via `env` will silently ship the _wrong
binary_. This is a security bug, not a config nit — a downgraded PATH can mean an attacker-
controlled `git` or `curl` on the tool path.

### What we build (oar declines it)

| Component                     | Reference                                        |
| ----------------------------- | ------------------------------------------------ |
| Capability broker             | Raft's `agentCredentialProxy` — design only, FSL |
| Sandbox policy, on by default | inverted from oar's `OAR_CODEX_SANDBOX` opt-in   |
| Lease manager                 | our L1 `leases`                                  |
| Supervisor / lifecycle        | k-carrier                                        |

---

## 6. L2 host lifecycle

```
        ┌──────────┐
        │  Idle    │◄──────────── rolled-back / up-to-date
        └────┬─────┘
             │ stage verified bytes into the experiment slot
        ┌────▼─────┐
        │  Staged  │
        └────┬─────┘
             │ journal handing-over, then stop stable
        ┌────▼──────────┐
        │ HandingOver   │
        └────┬──────────┘
             │ start experiment
        ┌────▼──────────────┐
        │ RunningExperiment │──probe fails──┐
        └────┬──────────────┘              │
             │ probe passes                 │
        ┌────▼─────┐                        │
        │ Readback │                        │
        └────┬─────┘                        │
             │ promote                      │
        ┌────▼──────────┐         ┌─────────▼────┐
        │   Promoted    │         │  RolledBack  │
        └───────────────┘         └──────────────┘
```

This is k-carrier's phase machine, **not a design of ours** — it is vendored and formally
verified in Lean 4. Our job is to not get in its way:

- **The host is managed externally.** The agent never self-upgrades
  (`k.managed-copy-never-self-upgrades`).
- **Evidence is never our own PID.** k-carrier rejects `pid == std::process::id()` for
  exactly this reason; an installer that mistakes itself for a healthy candidate is a bug class
  we inherit for free.
- **Patches layer on top**, never edit the vendored tree.

---

## 7. L3 — Orchestration

The entry point. Smallest layer that is independently valuable.

- **Fleet supervision** — N sessions per host, bounded by leases
- **Cost caps** — antiproton's `usage_active` / `usage_held` watermarks are the starting
  pattern; ours adds per-task and per-principal budgets
- **Routing** — which principal takes which task
- **Steering** — via oar's `steer`, rejected `not_steerable` when nothing is active

CAUTION: **`capabilities.queue.durable` is not uniform.** codex's queue survives a process restart;
claude's and pi's do not. The orchestrator must not present a queued input as durable unless
the capability says so — otherwise a crash silently eats a user's message.

---

## 8. L4 — Workspace

Raft's is closed (354k LOC in its `packages/web`). Built from scratch, scoped hard.

MVP: **channels with human + agent participants, threads, tasks with agent assignment, agent
inbox with exactly-once delivery.**

The inbox is the piece that makes agents feel like teammates, and the piece that is hardest
to retrofit. Shape borrowed from antiproton: an inbox state machine, `maxInboxMessageSeq`,
delivery-debt tracking. Build it right the first time.

`AttributionTier` drives the UI honestly: `opaque` means the harness only shows the root
agent, so **the UI must not fabricate sub-agent attribution** when the tier says it cannot
know.

---

## 9. L5+ — Public runtime API (phase 5)

Developers building on Radius is the durable moat — the L1/L2 stack is defensible, but a
public protocol surface is what compounds. `radius/v1` as a stable, documented contract.

---

## 10. What we deliberately do not build

| Not building                       | Why                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Multi-region control plane         | Unattributed complexity. One region, scale-to-zero.                       |
| A chat UI that tries to be Slack   | We are infrastructure. The workspace is the wedge, not the destination.   |
| Bundled harness support beyond oar | Adapters are a treadmill, not a moat. Prioritize on demand.               |
| Symbolication / crash pipeline     | `hands` already does this excellently under MIT. Depend, don't duplicate. |
| Consumer tier                      | Agents holding team credentials is a liability we cannot support.         |

---

## 11. Failure modes we are designing for

| Failure                                      | Expected behavior                                        |
| -------------------------------------------- | -------------------------------------------------------- |
| Laptop sleeps mid-turn                       | Resumes from cursor. Nothing lost.                       |
| Host process killed                          | k-carrier recovers or rolls back. Never bricks.          |
| Plane unreachable                            | Agent keeps working. Grants are cached and time-boxed.   |
| Clock skew                                   | Leases expire on observation, not on holder's clock.     |
| Split brain on lease                         | Test it. Do not reason about it.                         |
| Harness upgrades and changes its event shape | Adapter contract tests fail loudly.                      |
| Agent asks for more than it has              | `approvals` row, escalation surfaced, decision recorded. |
| PATH downgraded by a profile script          | Absolute-path invocation prevents it.                    |

---

## 12. Related documents

- `PLAN.md` — market thesis, dependency calls, license posture
- `docs/SAFETY.md` — threat model and the broker design
- `docs/ADAPTERS.md` — harness matrix and per-runtime sandbox behavior
- `docs/MILESTONES.md` — phase 0/1 execution plan

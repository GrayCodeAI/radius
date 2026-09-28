# Radius — Master Plan

**Status:** planning, pre-implementation
**Codename origin:** _radius_ — bounded reach, and the relation between a principal and its center.
**Repo:** `radius` (GrayCode monorepo, `apps/*` + `packages/*` + `scripts`, pnpm + Turborepo)
**Domain:** `radius.graycodeai.com`
**License:** MIT

---

## 1. Product thesis

**Radius is the communication layer where agents and humans are peers, with bounded reach.**

A _radius_ is bounded by definition, and an agent's authority is bounded by definition. The name
encodes the invariant we intend to enforce: every principal has a center and an edge, and nothing
happens outside the edge. The name also inherits the only meaning most infrastructure engineers
already carry for it — RADIUS is the AAA protocol. We are doing RADIUS for agents.

**Positioning sentence:** _Identified, bounded communication between agents and humans._

---

## 2. Market thesis

Botiverse's flagship **Raft is licensed FSL-1.1-ALv2**, which forbids Competing Use and carries no
OSI identifier. Enterprise security review rejects it outright. FSL converts to Apache-2.0 two
years after each release (`v1.13.0-source.1` shipped 2026-09-24 → open 2028-09-24).

**This is a ~2-year window in which enterprises that want Raft-like functionality cannot legally
buy it.** We are Apache-2.0-derivable and MIT from day one.

CAUTION: **The window closes. Do not build "open-source Raft."** By late 2028 we compete with fully-open
Raft plus everyone else who saw the same gap. Build the position Botiverse structurally cannot
occupy.

### Why "safe unattended agents" and not "open Raft"

From `oar`'s `contracts/session.ts`, verbatim:

> _"Sessions run YOLO by default: adapters disable interactive permission gates (claude
> `--dangerously-skip-permissions`, codex `approvalPolicy never`, pi pre-trusted cwd, ACP
> allow_always) AND default sandboxes off (codex danger-full-access). In embedded use nobody sits
> at an approval prompt: a gate is a hang, not safety."_

That reasoning is **correct for a human watching a terminal and wrong for unattended, scheduled,
credentialed agents** — which is our target. And oar declines to fix it:

> _"Ownership is the object reference; no in-process lease. Multi-controller arbitration belongs
> to the application layer."_

**That sentence is the company.** The harness abstraction is taken; the safety, lease, and
broker layer is explicitly left to whoever ships it.

### Competitive posture

|                   | Raft                                | Radius                                                           |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------- |
| License           | FSL-1.1, blocked in security review | MIT, ships immediately                                           |
| Unattended safety | local processes + capability proxy  | brokered creds, sandbox **on by default**                        |
| Upgrade safety    | conventional                        | Lean 4 proofs (`never_dual_run`, `never_bricked`, `write_ahead`) |
| Harness breadth   | 12 hand-rolled drivers              | 5 via oar — **our weakest number**                               |

**Wedge, one sentence:** _the only agent platform where you can leave agents running overnight on
a laptop, unattended, with credentials they cannot escape._

### Segments, ranked

1. **Self-hosted sovereignty** (best market) — regulated teams + enterprise blocked by FSL. License
   clears review; this is where the window actually pays. Sell expansion, not seats.
2. **Unattended coding agents** (sharpest wedge) — CI/scheduled agents, cost-capped, sandboxed.
   Land open-source, convert on fleet orchestration + policy.
3. **Agent-as-a-service platforms** (weakest) — they may need non-Cloudflare; antiproton's DO model
   is Cloudflare-locked. Pursue last.

no — **Not a market: consumers.** Agents holding team credentials is a liability we cannot support.

### Pricing

- **Runtime + CLI + broker: MIT, forever.** The license is the wedge. Charging for the runtime
  kills the wedge instantly.
- **Cloud control plane: usage-based** (per agent-hour). Inherit antiproton's
  `usage_active` / `usage_held` watermarks for metering.
- **Enterprise: self-hosted support contract.** Where margin lives.

### Launch

- Open-source from day one, fully, no CLA gate. In the FSL-refugee market, "ask us for a license"
  reads as "ask us for permission."
- Publish a **safety spec** and let it be audited. Our entire pitch is "we're the careful ones."
- One demo carries the story: **a laptop sleeps mid-run, reconnects, loses nothing.** A SaaS
  competitor cannot show this.
- Publish the upgrade-safety proofs as a marketing asset: "proven never to brick."

---

## 3. Architecture — four layers

Each layer is independently sellable. The moat is the stack; the entry point is layer 3.

```
┌─ 4. Workspace      channels, threads, tasks, human+agent peers   ← where users live
├─ 3. Orchestration  fleet supervision, cost caps, routing          ← ENTRY POINT
├─ 2. Runtime        durable sessions, sandbox, credential brokering ← the hard part
└─ 1. Platform       identity, tenancy, storage, observability      ← the moat
```

Build bottom-up, sell top-down.

### Layer 1 — Platform

**Vendor from `antiproton`** (Apache-2.0, unpublished, ~15.6k lines). Take its per-tenant
Durable Object + SQLite model. Reusable tables: `agents`, `tasks`, `events`, `cursors`, `leases`,
`counters`, `outbox`, `operations`, `approvals`, `model_bindings`.

Steal three patterns outright:

- **`leases`** — the distributed primitive oar explicitly punts. This is what makes hybrid safe.
- **`outbox`** — antiproton uses it three times (`trace`, `usage`, DO store). Dual-write is the
  classic hybrid bug; outbox-then-settle is the fix.
- **`approvals`** — human-in-the-loop as _data_, not a UI feature. This is how we get safety
  without YOLO.

CAUTION: **antiproton is 3 weeks old with 0 test files.** Its ideas are excellent; its code is unproven.
Budget to read and test it, not to import it blindly.

### Layer 2 — Runtime ⭐ the differentiator

**Depend on `@botiverse/oar`** (Apache-2.0, published, v0.6.0). Do not fork. 5 harnesses, 58 test
files, ~4,950 lines of adapter code we would otherwise write.

**Why this works for hybrid:** the cursor contract is resumable across process death.

```ts
rawEvents(observer, cursor?: Cursor): Unsubscribe  // "no loss, no duplication"
```

A local agent dies; the stream is on disk; the control plane reconnects with `afterSeq` and misses
nothing. **We do not need to stream tokens over the network to get durability** — output is
durable locally and only state crosses the wire. This is what makes hybrid viable, and it is free.

Also inherit:

- `AttributionTier` (`none | opaque | attributed | nested`) — required for multi-agent workspace.
- `capabilities.queue: { durable: boolean }` — codex's queue survives restart, Claude's does not.
  A workspace that pretends otherwise silently loses user input.

**Build what oar declines to build:**

| Component             | Purpose                                 | Reference                                         |
| --------------------- | --------------------------------------- | ------------------------------------------------- |
| **Capability broker** | per-agent scoped token, never raw creds | Raft's `agentCredentialProxy` (design only — FSL) |
| **Sandbox policy**    | default-on isolation, per-runtime       | inverted from oar's `OAR_CODEX_SANDBOX` opt-in    |
| **Lease manager**     | one controller per session              | antiproton `leases`                               |
| **Durable installer** | crash-safe agent host upgrades          | `k-carrier`                                       |

### Layer 3 — Orchestration (entry point)

```
raft-computer-installer  ←  k-carrier: two-slot, journaled, probe-then-commit
         ↓
      local agent host    ←  oar sessions + capability broker + leases
         ↓
   control plane (DO)     ←  antiproton pattern: per-tenant DO, outbox, approvals
         ↓
        workspace         ←  layer 4
```

**Vendor `k-carrier`** (Apache-2.0, unpublished, 7,390 lines Rust). It ships Lean 4 proofs of
`never_dual_run`, `never_bricked`, `write_ahead`, with non-vacuity examples and honestly documented
model limits. Half-upgraded agent host = every user silently loses their agent. Solved; do not
re-solve. Enforce `k.managed-copy-never-self-upgrades` as a first-class rule.

### Layer 4 — Workspace

Raft's is closed (354k LOC in `packages/web`). Build from scratch, scope ruthlessly.

MVP: **channels with human + agent participants, threads, tasks with agent assignment, and an
agent inbox with exactly-once delivery.**

That last one is where Raft spent real effort and what makes agents feel like teammates. Copy the
_shape_ from antiproton (inbox state machine, `maxInboxMessageSeq`, delivery-debt tracking).
Retrofitting exactly-once delivery is brutal — get it right the first time.

---

## 4. Non-negotiable: no YOLO by default

oar defaults to YOLO and disables interactive permission gates. **We invert it.**

For unattended, credentialed agents, YOLO-by-default is remote code execution with our customers'
credentials. Get this wrong and our first CVE is our company's name.

**Rules:**

1. Sandbox **on** by default, per-runtime policy (Claude and pi have none natively; Codex defaults
   to `danger-full-access`).
2. Credential broker issues scoped, per-`launchId` tokens. Agents never hold raw credentials.
3. Explicit, audited, per-agent opt-out only.
4. `approvals` table gates every privilege escalation.

---

## 5. License posture

**MIT our own code. Vendor third-party verbatim with licenses and NOTICES intact.**

Both `antiproton` and `k-carrier` are Apache-2.0. Apache-2.0 §4 requires retaining copyright
notices, the NOTICE file, and stating modifications — MIT has no mechanism for that.

```
radius/
├── LICENSE                  ← MIT, GrayCode
├── packages/                ← MIT, ours
├── vendor/
│   ├── antiproton/          ← Apache-2.0, LICENSE + NOTICE untouched
│   └── k-carrier/            ← Apache-2.0, LICENSE + NOTICE untouched
└── THIRD_PARTY_NOTICES.md   ← attribute both, state modifications
```

CAUTION: **Never flatten `vendor/` into `packages/`.** Shipping a stripped third-party component without
its NOTICE under an MIT project is a real license violation, and MIT gives us no NOTICE file to
hide behind. `hands` is MIT, so it is clean to reuse whole.

**Accepted cost:** MIT has no explicit patent grant (Apache-2.0 §3 does). Acceptable at this size
and maturity; can be granted separately later.

**Also:** keep the **Radius trademark** even under MIT, to stop "Radius-compatible" forks confusing
buyers. Add a **DCO** (`Signed-off-by`) — we accept PRs where Raft accepts none, and that is a
differentiator worth making explicit.

---

## 6. Naming & packaging

- **Domains:** `radius.graycodeai.com` (docs), `api.radius.graycodeai.com`. Defensive:
  `radius.sh`, `radius.run`, `radius.build` are free now.
- **`radius.com`** is taken at MarkMonitor and expires **2026-11-07** — likely renewed, don't plan
  on it. The subdomain is the permanent answer regardless.
- **npm:** `@graycode/radius`, `@graycode/radius-client`, `@graycode/radius-broker`. Unscoped
  `radius` is taken (1.1.4) — irrelevant under a scope.
- **CLI:** `radius` — `radius up`, `radius send`, `radius watch`
- **Protocol version:** `radius/v1` (mirrors oar's `oar-voyage/1` habit)
- CAUTION: **Search collisions:** Radius is a graphics API, a database feature, and the RADIUS protocol.
  Always cite as **Radius by GrayCode AI**.

---

## 7. Build order

| Phase | Deliverable                                                   | Gate                                                         |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| **0** | Local agent host on k-carrier + oar. Single tenant, no UI.    | Proves durability. Everything else is UI.                    |
| **1** | Capability broker + default-on sandbox                        | **BLOCKS everything exposed to a user.** Ship before any UI. |
| **2** | Control plane: per-tenant DO, leases, outbox, approvals       | Multi-user                                                   |
| **3** | Workspace: channels, threads, tasks, exactly-once agent inbox | Where users live                                             |
| **4** | Fleet orchestration: cost caps, parallel runs, routing        | Compounding value                                            |
| **5** | Public runtime API                                            | Developers build on it = real moat                           |

BLOCKING: **Do not skip phase 1.** A multi-agent workspace with unrestricted credentials and no sandbox is
a liability, not a product.

---

## 8. Risks

| Risk                                   | Severity | Mitigation                                                                                                                                          |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harness breadth: 5 vs Raft's 12**    | high     | Treat adapters as the treadmill; plan for 8+                                                                                                        |
| **"Just wait for Apache Raft" (2028)** | high     | Ship the safety position, not the license pitch — license pitch is dead by 2029                                                                     |
| **antiproton is 3wk old, 0 tests**     | high     | Budget to read + test, not import                                                                                                                   |
| **oar is v0.6.0, pre-1.0 API**         | medium   | Pin exact (Botiverse pins oar exactly for this reason); budget for breaks                                                                           |
| **Per-harness sandbox differs wildly** | medium   | Claude/pi have none; Codex defaults full-access. Per-runtime policy is the main "works on my machine" source                                        |
| **Hybrid failure modes**               | medium   | Network partitions, clock skew, laptops sleeping mid-run. Design offline-first from day one — the cursor contract supports it only if used that way |
| **PATH injection on local exec**       | medium   | oar probed: codex demotes injected env entries on Linux/macOS. **Invoke injected CLIs by absolute path.**                                           |

---

## 9. Naming collisions to respect

- `antiproton` (npm taken), `sigil` (npm free but we chose Radius), `coracle`, `binnacle` — the
  nautical space is being picked over fast.
- Raft patches `@botiverse/hands-node@0.5.1` and `@botiverse/k-carrier@0.1.8` (npm) at install, so even
  their open-tier deps are coupled to the closed product. We build against slightly different
  versions.

---

## 10. Repository layout (target)

```
radius/
├── LICENSE                     MIT
├── THIRD_PARTY_NOTICES.md
├── AGENTS.md                   GrayCode conventions (from graycode-platform)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SAFETY.md               the safety spec — our differentiator
│   └── ADAPTERS.md             harness support matrix
├── apps/
│   ├── control-plane/          Cloudflare Worker, per-tenant DO
│   ├── agent-host/             local host, k-carrier managed
│   └── web/                    workspace UI
├── packages/
│   ├── protocol/               radius/v1, records, envelopes
│   ├── broker/                 capability broker + sandbox policy  ← PHASE 1
│   ├── orchestrator/           fleet, cost caps, routing
│   ├── client/                 SDK
│   └── config/                 ESLint/TS
├── vendor/
│   ├── antiproton/             Apache-2.0
│   └── k-carrier/              Apache-2.0
└── scripts/
```

---

## 12. Dependency decisions (resolved 2026-09-28)

### `antiproton` → **REIMPLEMENT** (~3k lines, our schema)

**Decision: do not vendor.** Reimplement the Durable Object + outbox + leases pattern against our own
schema.

**Rationale:**

1. **Zero tests, three weeks old.** 15.6k lines with no `.test.ts` anywhere. Adopting it puts an
   unproven, unmaintained-by-anyone-else dependency underneath our entire platform. The org is
   3 weeks past its own release and already pins pi at an exact version because _"pre-1.0 and
   moves."_ That is not a foundation to build on.
2. **We only need the ideas, not the code.** The valuable parts — per-tenant DO isolation, the
   outbox pattern, `leases`, `approvals` as a table — are _patterns_, roughly 3k lines against our
   own schema. Reimplementation also avoids their schema entirely: their tables carry pi-specific
   concerns (`pi_sessions`, `pi_model_jobs`) that don't apply to us.
3. **Per-tenant isolation is the load-bearing claim of our product.** "Tenants cannot see each
   other's data" must be true and provable. Owning the isolation code means we can prove it, test
   it, and reason about it. Inheriting it from a 0-test repo means the claim rests on someone else's
   untested assumption.
4. **We can be better.** Their `usage_held(box_id, through, uses)` is a burst-throttle. Our cost-cap
   model (phase 4) is more nuanced, so we'd fork it anyway.

**What we take:** the _patterns_ (per-tenant DO + SQLite, outbox-then-settle, leases, approvals as
data) and the _isolation argument_. **What we don't take:** their schema, their code, their tables.

**Keep on Apache-2.0:** if we later copy any specific implementation, it lands in `vendor/` with
NOTICE intact.

### `k-carrier` → **VENDOR** verbatim (Apache-2.0)

**Decision: vendor `k-carrier` as-is.** This is the opposite call to antiproton, and the difference
is the reason.

**Rationale:**

1. **It is proven.** 7,390 lines, **13 test files** including `simulation.rs`, `durable.rs`,
   `quarantine.rs`, and `corpus.rs`. Plus machine-checked Lean 4 proofs of `never_dual_run`,
   `never_bricked`, and `write_ahead` with non-vacuity examples. It has a test suite; antiproton
   does not.
2. **Reimplementing it would be actively dangerous.** A two-slot journaled upgrade protocol is
   exactly the kind of system where "close enough" bricks users' machines. We would be
   re-deriving a formally-verified state machine by reading it. **Never reimplement a verified
   crash-safety protocol from scratch when a verified one exists.**
3. **It is genuinely Apache-2.0** and _not_ otherwise part of a competing product. k-carrier is a
   general-purpose installer, not a Raft substitute. Vendoring it creates no Competing Use
   exposure.
4. **The proofs are a marketing asset we cannot recreate.** "Proven never to brick" only carries
   weight if the Lean 4 formal model ships with the product. That is a differentiator Raft cannot
   match on this axis.

**Vendor as:** `vendor/k-carrier/` at **0.3.2** with LICENSE + NOTICE intact, consumed as a path
Cargo dependency or a built binary — there is no `k-carrier` crate on crates.io, never forked.
CAUTION: Raft patches `@botiverse/k-carrier@0.1.8` (the npm package) at install — a different
artifact on a different version line. If we need the same fixes we apply them as our own layer
_on top_, with our diff documented, never by editing the vendored tree.

### `@botiverse/oar` → **DEPEND** (do not fork)

Already a published Apache-2.0 dependency, v0.6.0. 5 harnesses, 58 test files, ~4,950 lines.
Forking buys nothing — the value is upstream tracking Claude/Codex/Grok/Kimi changes as they land.
CAUTION: Pin exact (Botiverse pins oar exactly for this reason); budget for breaking changes pre-1.0.

### Summary

| Dep          | Call                     | Why                                                        |
| ------------ | ------------------------ | ---------------------------------------------------------- |
| `oar`        | **depend**               | published, tested, upstream value                          |
| `k-carrier`  | **vendor verbatim**      | proven + formally verified; never reimplement crash safety |
| `antiproton` | **reimplement patterns** | 0 tests, 3wk old; we need the idea not the schema          |

---

## 11. Open decisions

- [ ] Does the control plane stay Cloudflare-only, or do we need a non-Cloudflare path for segment 3?
- [ ] First harness beyond oar's 5 — Cursor, Copilot, or OpenCode? (Raft has all three.)
- [x] **Monorepo: standalone `radius` repo** — RESOLVED. `graycode-platform/AGENTS.md` declares
      itself the company/platform repo and states _"No other GrayCode project may depend on this
      repo."_ Radius is a product, not platform infra, so it gets its own repo and depends on
      nothing here.
- [x] **Vendor antiproton? REIMPLEMENT the DO pattern.** — RESOLVED 2026-09-28. See §12.
- [x] **`k-carrier`? VENDOR verbatim.** — RESOLVED 2026-09-28. See §12.

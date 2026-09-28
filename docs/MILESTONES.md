# Milestones — Phase 0 and Phase 1

Phase 0 proves durability. Phase 1 makes it safe. **Nothing user-facing ships before
Phase 1 passes.** Everything else in the stack is UI over these two.

---

## Phase 0 — Local agent host

**Goal:** one agent, one machine, no UI, survives being killed at any moment.
**Exit criterion:** kill the host at any point in an upgrade or a session; nothing is lost and
nothing is bricked.

### 0.1 — Repo scaffold (done)

`package.json`, `turbo.json`, `pnpm-workspace.yaml`, `AGENTS.md`, `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `vendor/k-carrier/`.

### 0.2 — Vendor k-carrier (done 2026-09-28)

Populated `vendor/k-carrier/` at upstream **0.3.2** with `LICENSE` and `NOTICE` intact.
`pnpm check:notices` passes against the real tree.

There is no `k-carrier` crate on crates.io, so this is a path dependency or a built binary.
This is a _different artifact_ from the `@botiverse/k-carrier` npm package Raft patches at
`0.1.8` — do not conflate the two version lines.

- [x] Populated, `LICENSE` + `NOTICE` unmodified
- [x] `pnpm check:notices` passes against the real tree
- [x] Read `formal/Protocol.lean` — what is proven vs. assumed, recorded in `vendor/k-carrier/README.md`
- [x] Record the `k.managed-copy-never-self-upgrades` invariant in `check-invariants.mjs` (done
      2026-09-28) — as **I15**, and as the first _behavioural_ invariant in the project rather
      than another prose claim. See below.
- [ ] Build against it; decide path dependency vs. built binary (phase 1)

**I15 is not a phrase match.** I1–I14 are ours and merely specified; nothing checks them until
`packages/broker` exists. This one is different: k-carrier _enforces_
`k.managed-copy-never-self-upgrades` in `vendor/k-carrier/src/invariants.rs`, and that source is
in this repository. So `check:invariants` asserts the invariant is still declared and still
guards the same condition — the first place in this project where a claim is checked against
executable code rather than against prose. That is the payoff of D-004: vendoring is what made
the guarantee inspectable.

**It is verified by mutation, not by passing.** Five mutants of the vendored entry were injected
and all five are now caught: renaming the id, weakening the guard `Phase::Idle` →
`Phase::Promoted`, dropping the `ManagedElsewhere` condition, rewording the violation message,
and deleting the entry outright. Two of those five exposed real holes in the first
implementation of the check — a whole-file `includes()` passed on a weakened guard, and then
slicing to the next `id: "` ran to end-of-file and swallowed the `terminal()` helper below the
array. Both are recorded in `check-invariants.mjs` so the next person does not "simplify" the
bounds back into a hole.

Threat: **T17 — a second writer to the managed installer's upgrade journal.** Radius drives its
own copy of k-carrier, so the copy must never also self-upgrade: two drivers on one two-slot
journal is outside the transition relation the Lean proofs quantify over, and the outcome is the
dual-run or bricked host we vendored the thing to prevent.

**The formal and engineering guarantees are not the same set.** The model proves three
theorems; its header states plainly that it does not resolve the filesystem window inside
`promote` (below one effect step, covered in code by the durable promote intent plus idempotent
replay), and that the host contract is _assumed_ — `stop()` returning means the process is gone,
`start()` starts only the requested slot, the probe answers for one live incarnation.

Also worth knowing before we design the update channel: k-carrier's own NOTICE records that
**signature verification is not implemented** — it verifies integrity by sha256 and size only.

### 0.3 — Agent host skeleton (`apps/agent-host`) — partial, 2026-09-28

**Done:** the durability core. `apps/agent-host/src/record-store.ts` + 13 tests.

- [x] Append-only JSONL store, one file per session
- [x] fsync before `append()` resolves — a record is durable before any observer sees it
- [x] `seq` is the only ordering; wall-clock timestamps never sort the stream
- [x] Cursor replay: `readAfter(afterSeq)` resumes with no gaps and no duplication
- [x] Duplicate `seq` append is an idempotent no-op; a _lower_ `seq` is rejected as corruption
- [x] Torn final line after a hard kill does not lose the records before it
- [x] Session id validated against path traversal **before** any I/O
- [x] Typechecks clean; tests pass; `check:invariants` and `check:notices` pass

**Two defects this milestone found, both worth recording:**

1. **A charset allowlist does not stop `..`.** `..`, `.`, and any dot-prefixed name consist
   entirely of legal filename characters, so `/^[A-Za-z0-9._-]{1,128}$/` accepts them and
   `..` resolves to the parent directory. Validation now rejects dot-prefixed names explicitly.
2. **The reader was hiding a write-path bug.** `readAfter` filtered `seq <= max`, which silently
   skipped duplicates on disk. A mutation that removed the write-path dedupe was _invisible_,
   because the reader cleaned up after the writer. The reader now throws
   `DuplicateRecordError` — a reader that quietly hides corruption is worse than one that fails.

Both were caught by **mutation testing**, not by the tests passing. Five mutants were injected
(remove fsync, remove dedupe, remove traversal check, break cursor, break torn-line tolerance)
and all five now fail the suite. A passing suite that survives mutation proves nothing.

**Not yet done / newly done:**

- [x] oar session binding — `RuntimeRegistry` → `installation` probe → the adapter's
      `StartSession` (2026-09-28). `src/record-writer.ts` + `src/session-host.ts`, 17 tests.
- [x] Supervisor lifecycle: start/stop/restart, `agentNoProcessResidency` equivalent
      (2026-09-28). `src/supervisor.ts`, 7 tests.
- [ ] k-carrier integration (path dependency vs. built binary — D-004; **feasibility now
      measured**, see `DECISIONS.md` D-004. A path dependency builds clean; a bare
      `cargo build` does not, because 5 of 6 declared targets are not vendored)
- [x] `kill -9` mid-turn acceptance test end to end through a real oar session (2026-09-28)

**The e2e gate ran against a real Claude session and passed.** `RADIUS_E2E=1` on a machine with
`claude` on PATH: 10 records durable after a real SIGKILL, contiguous from `seq 0`, covering all
three oar record kinds, and replayed identically by a fresh store. The prompt, the `accepted`
response, `system/init`, the model's `assistant` frame and a terminal `result/success` all
survived. The store stamped them with _our_ stream name, not oar's native session id — the
untrusted-name property holding in real conditions, not just in a unit test.

**And the limit of that result, stated rather than buried.** The run reports which case it hit,
and on this machine the turn _completed_ before the kill — even at a 9s delay. So this proves
**records survive a hard kill**; it does **not** yet prove a kill _during streaming_ is safe.
That case is timing-dependent and not deterministically covered. `RADIUS_E2E_KILL_MS` exists to
aim at it (a cold harness, or a prompt long enough to still be generating), and until someone
captures a run reporting `turn was STILL IN FLIGHT at the kill`, the mid-generation case is
unproven.

**Supervisor, and the property that matters.** `AgentSupervisor` is deliberately small; the value
is in three properties it makes true, each a way unattended agents go wrong: never two writers on
one stream (`start()` refuses while running — split-brain, one layer up from `never_dual_run`);
nothing observed left unpersisted (`stop()` drains even when `dispose()` throws); and no process
residency. The last is tested for real, not mocked: the test spawns an actual OS process, records
its pid, stops the session, then polls until that pid is gone. A mock asserting "dispose was
called" would pass while the process lived on, which is the bug that property exists to catch.
A wedged harness raises `StopTimeoutError` rather than hanging an unattended host forever.

**The session binding's central problem is a type mismatch, not plumbing.** oar delivers records
through `RawEventObserver = (record: RawEvent) => void` — synchronous, no await, no backpressure
channel. `RecordStore.append()` is asynchronous and fsyncs before it resolves. The obvious bridge
(`session.rawEvents((r) => { void store.append(id, r); })`) is precisely the lost-write hazard
this product exists to prevent: those appends race for one file handle, so `seq` order is not
preserved, and a kill drops everything in flight. It is also a floating promise, which
`pnpm lint` fails on by design.

`RecordWriter` closes that with a serial promise chain: the observer enqueues synchronously and in
order, one append is ever in flight, and `drain()` is the only thing that means "durable". Append
failures are sticky and re-thrown rather than swallowed — a swallowed write failure is a lie about
what is on disk, and this is the file the control plane later treats as source of truth.

**Correction to this milestone's own plan.** It said "`startSession`". There is no such callable.
`StartSession` is a _type_ each runtime supplies:

```ts
type StartSession = (
  installation: AvailableInstallation,
  options: SessionOptions,
) => Promise<Session>;
```

It is read off a `Runtime`, not imported. The other two named pieces are real: `RuntimeRegistry`
and the `installation` probe — all five shipped runtimes provide one, though the type marks it
optional, so absence is handled as unavailability rather than assumed.

**Mutation-verified — and it caught a weak test of ours.** Four mutants injected, all now caught:
concurrent appends, `detach()` before `dispose()`, a swallowed sticky failure, and letting the
record's `sessionId` name the file. The fourth initially **passed**. The file path comes from
`append()`'s own argument, so that test was asserting less than its name claimed, and a writer
could have written records stamped `../escape` into a correctly-named file. It now asserts that
the on-disk `sessionId` agrees with the stream name.

**What this does NOT prove.** These tests bind a _fake_ Session. They prove our side of the
contract, not oar's, and no real harness has been started. End-to-end — a real session killed
mid-turn — is the outstanding item above, and it needs a CLI actually installed.

**Environment note:** oar declares `engines.node >=24.0.0`, so this repo is pinned to Node 24
and CI installs it. Any local development on Node 22 will fail to install the dependency.

### 0.4 — Stream durability harness

Follow antiproton's crash-matrix idea: interrupt at every point (before-journal,
after-journal, after-action) and assert the invariant holds.

- [ ] Fuzz the kill point across the upgrade state machine
- [ ] Assert `never_dual_run` and `never_bricked` behaviourally, not just by trusting the proofs
- [ ] Test laptop sleep/wake and network loss as first-class cases

CAUTION: **Do not skip offline.** The cursor contract supports offline-first, but only if we use it
that way. A laptop that sleeps mid-run is the normal case, not the edge case.

---

## Phase 1 — Capability broker + sandbox policy

**Goal:** an agent can be left running overnight on a machine nobody is watching, and it
**cannot** reach anything it was not granted.
**Exit criterion:** every credential is scoped and brokered; every privilege escalation is
recorded; sandbox is on unless explicitly, auditably waived.

**This is the only part of Radius that is genuinely ours to invent.** Everything else is
assembled from Apache-2.0 and MIT code. The entire positioning rests on this phase.

### 1.1 — Principal model

The core type. Everything else derives from it.

```
Principal
├── id                  stable identity
├── kind                human | agent | service
├── center              the workspace/task it belongs to
├── capabilities[]      what it may do — the radius
├── brokerToken         scoped, revocable, never a raw credential
└── createdAt / revokedAt
```

- [x] Define in `packages/protocol` (2026-09-28) — `src/principal.ts`, 12 tests
- [x] **Deliberate omission:** no field holds a raw secret. Made structural, not conventional
- [x] Serialize/deserialize round-trip tests
- [ ] `decided_by` enforcement wired to a real `approvals` table (phase 2 — needs the DO)

**The omission is structural, which is the only reason to believe it.** `DATA-MODEL.md` §2 says
in capitals that no column may hold a raw credential, and §4 asks for "a test that scans for it.
Not a code-review convention." So: `Principal` has no `token`/`secret`/`apiKey` field;
`parsePrincipal` **rejects unknown fields**, so a secret cannot ride in through an untyped JSON
bag; and the tests grep serialized principals _and_ grants for nine secret shapes — Anthropic,
OpenAI, GitHub, AWS, Slack, Google, PEM private keys, JWTs, and `api_key=`-style assignments.

The scanner carries a **positive control** that plants a real-looking AWS key and requires
detection. Without it, a scanner matching nothing would pass every other test in the file and
look convincingly green.

**Also decided here, and worth writing down:** `CapabilityGrant.expiresAt` is a _required_ field
in the type. `DATA-MODEL.md` §2 marks it "**required.** Default lease 1 hour, per D-008" — so a
permanent grant is now unrepresentable rather than merely discouraged, which is what
`PROTOCOL.md` §6 actually asks for.

### 1.2 — Credential broker

Modeled on Raft's `agentCredentialProxy` (design only — FSL, do not copy code).

A loopback HTTP proxy. An agent is launched with a _scoped_ token; its model and tool
traffic is brokered. The raw credential never enters agent context or memory.

- [ ] Issue/revoke scoped tokens per `launchId`
- [ ] Narrow `capabilities` without restarting the agent
- [ ] Audit every request: principal, capability, decision, timestamp
- [ ] Loopback only, per-launch nonce, unguessable
- [ ] **No secret in any log line, ever** — add a test that greps for it

**NOT STARTED, deliberately.** The proxy, revocation and audit are all buildable today, but real
credential scoping is not: it needs live provider keys for Anthropic/OpenAI/Google/xAI. A broker
that looks finished while credentials escape would be the single worst thing this project could
ship — it makes the pitch true-looking and false, which is the failure mode everything else here
exists to prevent. The contract is now concrete (`CapabilityGrant` in `packages/protocol`), which
is what makes building it safe rather than speculative. It should not be called done until a real
key has been scoped, revoked, and shown unreachable from agent context.

CAUTION: **The one hard invariant, from agent-vault:** a value that must not leak must be
_structurally_ unreachable, not merely "we chose not to log it." agent-vault enforces this
with an 8-line TTY check — an agent has no TTY, so it _cannot_ run the sensitive command.
Find the equivalent structural guarantee here.

### 1.3 — Sandbox policy, on by default

oar defaults sandboxes **off** and documents opting in via `OAR_CODEX_SANDBOX`. We invert.

| Runtime | Native sandbox       | Our default                                      |
| ------- | -------------------- | ------------------------------------------------ |
| Codex   | `danger-full-access` | `workspace-write`, escalate only via `approvals` |
| Claude  | none                 | process/FS isolation, allowlisted tools          |
| Kimi    | none                 | as above                                         |
| Grok    | none                 | as above                                         |
| Pi      | none                 | as above                                         |

- [ ] Per-runtime policy; capability-detected, not hardcoded guesses
- [ ] Deny-by-default. Every allowance is an explicit grant.
- [ ] Escalation writes an `approvals` row
- [ ] Surfaced in the UI when it happens

CAUTION: **Expect this to be the main "works on my machine" source.** Four of five runtimes have no
native sandbox; per-runtime behavior differs. Budget for it and write the matrix down
(`docs/ADAPTERS.md`).

### 1.4 — Lease manager

The primitive oar explicitly declines: _"Ownership is the object reference; no in-process
lease. Multi-controller arbitration belongs to the application layer."_

- [x] One controller per session; leases are the exclusive claim (2026-09-28)
- [x] Clock-skew tolerance (leases expire on observation, not on the holder's clock)
- [x] A new controller can take over a dead one
- [x] Split-brain is impossible — **tested, not reasoned about**
- [x] Wall-clock rollback cannot extend a lease (D-008 Q4)

`packages/protocol/src/lease.ts`, 13 tests. This is the highest-leverage item in Phase 1,
because it is what turns three _prose_ invariants into enforced code:

| Invariant | Now enforced by                                   | Was            |
| --------- | ------------------------------------------------- | -------------- |
| **I3**    | `assertWritable` refuses an expired lease         | specified only |
| **I5**    | a stale epoch is rejected on every write          | specified only |
| **I14**   | a rewound `Date.now()` cannot revive a dead lease | specified only |

`check:invariants` now reports the split honestly — `11 specified only, 3 enforced in code,
1 verified against vendored source` — instead of implying the whole table was prose.

**Expiry is computed from `process.hrtime`, never `Date.now()`.** The user owns the wall clock;
a lease enforced against it can be extended by one `date` command. The wall clock is recorded in
the anchor for audit and never consulted for expiry.

**The restart case is the subtle one, and D-008 calls it out by name.** A restart _resets_ the
monotonic clock, so its reading is meaningless across a restart. `LeaseManager.restore` adopts a
persisted anchor — and **drops** any lease whose window already elapsed while the process was
down. Reviving it would let a rewound clock resurrect a dead lease, which is the entire attack
the monotonic design exists to stop.

**Split-brain is tested, not argued.** The test acquires a lease, lets it expire, takes it over,
then has the _original holder_ — which has no idea it lost anything — attempt five writes. All
five are refused on the epoch. The same test proves a stale holder cannot renew, release, or
extend the new holder's lease. A mutation removing the epoch check, dropping the expiry check,
switching expiry to `Date.now()`, or freezing the epoch counter each fail the suite.

### 1.5 — Invariant checker

Make the safety claims executable, not aspirational.

- [ ] `scripts/check-invariants.mjs` asserts the sandbox/broker invariants
- [ ] Runs in CI; **a failure blocks merge**
- [ ] Every invariant is a _named_ claim in code, not a convention
- [ ] Include a regression test per invariant that would fail if it were violated

### 1.6 — Safety spec

Our differentiator, so it gets written properly.

- [ ] `docs/SAFETY.md` — threat model, guarantees, non-guarantees
- [ ] State what we do **not** protect against as plainly as what we do
- [ ] Publish it. Let it be audited. "We're the careful ones" is the whole pitch.

---

## Exit criteria

**Phase 0 done when:** the host is killed at arbitrary points — during upgrade, mid-turn,
offline — and loses nothing, bricks nothing, and recovers without human action.

**Phase 1 done when:** a principal cannot obtain any capability it was not granted; no
credential appears in any agent-visible context, log, or trace; sandbox is on by default;
every escalation is recorded; and `pnpm check:invariants` enforces all of it in CI.

BLOCKING: **Do not start Phase 2 (control plane), 3 (workspace), or any UI until Phase 1 passes.**
An agent communication platform that leaks credentials or runs unsandboxed is a liability,
not a product.

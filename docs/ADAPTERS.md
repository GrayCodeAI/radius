# Adapter matrix

Per-runtime capability and sandbox behavior. **Verify, don't assume** — this table will rot,
and a stale row here is a security bug.

Status: **planning**. No adapter work has started; the matrix is derived from reading oar and
its documentation, and every row needs empirical confirmation during Phase 1.

---

## 1. Support

Raft's daemon hand-rolls 12 drivers. oar ships 5. **We depend on oar's 5 and add more as
demand appears** — adapters are a treadmill, not a moat, and forking oar to add a sixth would
cost us upstream tracking.

| Runtime     | oar id   | Native sandbox                 | Auth surface           | Attribution tier |
| ----------- | -------- | ------------------------------ | ---------------------- | ---------------- |
| Claude Code | `claude` | none                           | subscription / API key | see §4           |
| Codex       | `codex`  | `danger-full-access` (default) | ChatGPT / API          | see §4           |
| Grok Build  | `grok`   | none                           | x.ai account           | see §4           |
| Kimi Code   | `kimi`   | none                           | Moonshot account       | see §4           |
| Pi          | `pi`     | none                           | varies                 | see §4           |

**Raft additionally drives** Cursor, Copilot, Gemini, OpenCode, kimi-sdk, and a deprecated
`antigravity`. Those are the candidates for post-v1 adapters, ordered by demand.

---

## 2. Sandbox reality

**Four of five runtimes have no native sandbox.** This is the single most important fact in
this document, and it is why Radius supplies isolation itself.

| Runtime | Native sandbox       | Radius default                           | Escalation path |
| ------- | -------------------- | ---------------------------------------- | --------------- |
| Codex   | `danger-full-access` | `workspace-write`                        | `approvals` row |
| Claude  | none                 | process/FS isolation + allowlisted tools | `approvals` row |
| Kimi    | none                 | process/FS isolation + allowlisted tools | `approvals` row |
| Grok    | none                 | process/FS isolation + allowlisted tools | `approvals` row |
| Pi      | none                 | process/FS isolation + allowlisted tools | `approvals` row |

oar provides `OAR_CODEX_SANDBOX` as an **opt-in** for Codex. We invert: sandbox is the
default, and waiving it is a recorded, audited decision.

CAUTION: **oar documents the rationale for its own default, and it is reasonable:**
_"In embedded use nobody sits at an approval prompt: a gate is a hang, not safety."_ Correct
for a human at a terminal. Wrong for unattended agents. We are the counter-case, so we take
the opposite position — and should document that we disagree with our own dependency, on the
record.

## 2. MEASURED, not assumed — re-run with `pnpm probe:runtimes`

Probed 2026-09-28 against the installed CLIs. This is a **measurement**, not a recollection, and
it is re-runnable so the table cannot silently rot.

| Runtime | Version               | Documents a sandbox | Permission-bypass flag       | Self-updates        |
| ------- | --------------------- | ------------------- | ---------------------------- | ------------------- |
| claude  | 2.1.283 (Claude Code) | no                  | **yes**                      | **yes** (`update`)  |
| codex   | codex-cli 0.157.1     | **yes** (`-s`)      | —                            | **yes** (`update`)  |
| grok    | grok 1.0.25           | no                  | **yes** (`--always-approve`) | **yes** (`update`)  |
| kimi    | 0.26.0                | no                  | **yes** (`--yolo`)           | **yes** (`upgrade`) |
| pi      | 0.85.1                | no                  | —                            | —                   |

**Two things this measurement settles that the prose above only asserted.**

**1. "Sessions run YOLO by default" is now a verified fact, not a quote.** Four of five CLIs
expose a permission-bypass flag, and oar passes it (`claude --dangerously-skip-permissions`,
`grok --always-approve`, `kimi --yolo`). The premise this whole product is built on is
checkable, and it checks out. Only Codex has a documented sandbox at all.

**2. FOUR OF FIVE RUNTIMES SELF-UPDATE — and that generalises I15.**

`k.managed-copy-never-self-upgrades` was recorded for k-carrier: a copy we install and manage
must never also upgrade itself, or there are two writers on one component. That reasoning is not
specific to k-carrier. If Radius ever installs and manages a copy of any of the four CLIs above —
exactly the k-carrier pattern — their built-in `update`/`upgrade` is **the same second writer**.

So the invariant's scope is wider than one vendored component: **every managed binary on the
host must be upgradeable only by the supervisor.** Recorded in `THREATS.md` as I15, with the
vendor check asserting k-carrier's copy; this probe is how we notice the condition appearing in a
new place.

**A documented flag is not a working sandbox.** This measures what each CLI _claims_ to support.
The isolation any of them actually enforces is still unmeasured, and `SAFETY.md` §3 says so.

---

## 3. Capabilities oar exposes

From `Runtime`, only `session` is required. The rest are optional and **default to a typed
`{ kind: "unsupported", code: "transport_unavailable" }`** rather than throwing. That means
feature-detection is the correct pattern — never assume availability.

| Capability     | Type                                | Notes                                        |
| -------------- | ----------------------------------- | -------------------------------------------- |
| `session`      | **required**                        | _"a runtime without sessions is not usable"_ |
| `installation` | optional                            | probe for installed binaries                 |
| `accountUsage` | optional                            | quota / rate-limit introspection             |
| `listModels`   | optional                            | model catalog                                |
| `skills`       | optional, from `RuntimeInventories` | defaults to `unsupported`                    |
| `mcpServers`   | optional, from `RuntimeInventories` | defaults to `unsupported`                    |
| `tools`        | optional, from `RuntimeInventories` | defaults to `unsupported`                    |

CAUTION: **Feature-detect, always.** A capability that returns `unsupported` is a normal runtime
state, not an error path. Radius must degrade visibly, not silently.

### Session capabilities

| Field         | Type                           | Consequence for us                     |
| ------------- | ------------------------------ | -------------------------------------- |
| `steer`       | `boolean`                      | mid-turn injection available?          |
| `queue`       | `{ durable: boolean } \| null` | **`null` = cannot even hold input**    |
| `attribution` | `AttributionTier`              | what the UI may claim about sub-agents |

CAUTION: **`queue.durable` is not uniform.** Per oar: codex's queue is runtime-persisted; claude,
pi, and ACP hold input for the current process only. **A crash silently eats queued input
unless the capability says `durable`.** The orchestrator and the UI must both read this and
must not present a queued message as safe.

---

## 4. Attribution

`AttributionTier` is declared by the adapter and **required to match what the runtime
actually exposes** — oar calls this an adapter red line.

| Tier         | Meaning                                               | UI rule                                 |
| ------------ | ----------------------------------------------------- | --------------------------------------- |
| `none`       | no sub-agents                                         | show one agent                          |
| `opaque`     | sub-agents exist, interface shows only the root       | **must not imply visibility into them** |
| `attributed` | child records self-attribute via `agentPath`          | show paths                              |
| `nested`     | children are sessions of their own, linked in a graph | full graph view                         |

CAUTION: **The L4 failure mode is fabricating attribution.** On an `opaque` runtime, a UI that
renders plausible-looking sub-agent rows is lying to the user about what it can see. Render
the tier, don't fake the depth.

---

## 5. Known adapter hazards

### 5.1 PATH injection is unreliable on local exec

oar's `SessionOptions.env` carries this caveat verbatim:

> _"A runtime that runs tools through a login shell (codex: `zsh/bash -lc`) lets profile
> scripts reorder or rebuild PATH (**probed: codex demotes injected entries on Linux and macOS** > `path_helper`/`.zprofile` can drop them). Injected CLIs should be invoked by ABSOLUTE path."_

**This is a security issue, not a config nit.** A downgraded tool path means an
attacker-controlled `git`, `curl`, or `python` may be invoked by a tool call. **Radius must
invoke every injected helper by absolute path**, and the invariant checker should fail if a
helper is ever launched by bare name.

### 5.2 YOLO defaults

Every adapter in oar disables interactive permission gates. See `SAFETY.md` §2 G2 — we invert
this, per-runtime, and it means the broker must be able to _enforce_ a restriction on a
runtime that was written to assume none exists.

### 5.3 System prompt injection

`SessionOptions` exposes `systemPrompt` (replace) and `appendSystemPrompt` (append), both
documented as surviving runtime compaction and _pinned per vendor_. A long-running agent's
prompt is a target: **the broker owns the principal's system prompt, and the agent cannot
rewrite it.**

### 5.4 Node SEA

`oar/sea-trial/` and the `pi-coding-agent` patch (Raft issue #6112) both concern Node
Single-Executable Applications: pi's jiti extension loader uses `createRequire(SEA path)` and
fails with no on-disk `node_modules`. If we ship the host as a SEA binary, we inherit this
class of bug. CAUTION: **Decide early whether the host is a SEA binary** — it constrains the
installer and the adapter surface.

### 5.5 Upstream is pre-1.0 and moves

Botiverse pins oar **exactly** because it is pre-1.0 and ships breaking changes through a
private release process. **Pin exact; do not use ranges.** Verified 2026-09-28: published
versions run `0.0.1` → `0.6.0`, and `0.6.0` is the latest. (The `0.84.x` number floating around
in Botiverse docs belongs to `@earendil-works/pi-coding-agent`, oar's dependency — not to oar.)

---

## 6. Adding an adapter

Checklist, in order. An adapter is not done until the last item passes.

1. `installation` probe — locate the binary without invoking a shell
2. `session` — prompt / steer / queue / abort
3. Declare `SessionCapabilities`, **including the true `queue.durable` value**
4. Declare `AttributionTier` matching reality
5. **Sandbox policy** — what isolation does this runtime actually honor? If none, record that
6. **Absolute-path invocation** for every injected helper
7. System prompt ownership — broker-supplied, agent cannot overwrite
8. Event normalization — harness shapes drift; pin what we depend on
9. Contract test — **fails loudly** if upstream changes shape
10. Document in this table, including the hazards you hit

CAUTION: **Rule 6 is not optional.** It is the only defense against §5.1, and the failure is silent
and security-relevant.

---

## 7. Coverage roadmap

| Priority  | Target                                  | Rationale                             |
| --------- | --------------------------------------- | ------------------------------------- |
| v1        | oar's 5 (Claude, Codex, Grok, Kimi, Pi) | already proven, upstream-tracked      |
| v1.1      | Cursor, OpenCode                        | Raft has both; strong demand signal   |
| v1.2      | Copilot, Gemini                         | Raft has both                         |
| later     | OpenCode, kimi-sdk, antigravity         | Raft's remaining drivers              |
| **never** | a runtime we have to fork to support    | costs upstream tracking, buys nothing |

**The honest gap:** Raft drives 12, we drive 5. This is our weakest number and the most likely
reason a user chooses them. Treat it as a treadmill, not a moat — and say so in positioning
rather than pretending breadth is a feature.

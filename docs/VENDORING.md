# Vendoring & OSS reuse audit

**Read this before copying any third-party code into Radius.** One dependency cannot be
copied, and copying it would be the defining legal error of the project.

---

## BLOCKING: 1. `botiverse/raft-source` — CANNOT COPY

**License: FSL-1.1-ALv2.** Not OSI. Not open source. `NOASSERTION` in GitHub's own database,
which is why enterprise security review rejects it outright.

From the LICENSE, the Competing Use clause forbids making the software available in a
commercial product that:

1. substitutes for the Software;
2. substitutes for any other product or service Botiverse offers using it; or
3. **offers the same or substantially similar functionality as the Software.**

Radius is a Raft-like product. Clause 3 is written precisely for this. Copying Raft's code
into Radius is a license violation, and RCE-grade reputation damage if discovered.

**FSL's design intent is to let you read the product and forbid copying it.** We read it. That
is the permitted use. Everything in §2–4 below is how we build a legitimate equivalent.

### The door that is open

> _"We hereby irrevocably grant you an additional license to use the Software under the Apache
> License, Version 2.0 that is effective on the second anniversary of the date we make the
> Software available."_

| Release            | Available  | Converts to Apache-2.0 |
| ------------------ | ---------- | ---------------------- |
| `v1.13.0-source.1` | 2026-09-24 | **2028-09-24**         |

Irrevocable. The code we are looking at today becomes genuinely reusable in ~2 years.

**Action:** calendar reminder for 2028-09-24. Until then, Radius builds on the Apache-2.0 and
MIT tier only.

### What we legitimately took from Raft

Not code — **architecture**, which is not copyrightable:

| Observation                                                                      | What we take                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| Per-launch `activeCapabilities` on a loopback credential proxy                   | the capability broker design (`SAFETY.md` §4) |
| `agentId` + `launchId` scoping                                                   | our Principal model                           |
| Per-vendor credential homes (`claudeProviderIsolation`, `codexHome`, `grokHome`) | per-runtime auth isolation                    |
| 9-file agent migration system                                                    | L4 agent portability is worth designing for   |
| `AttributionTier` honesty about sub-agent visibility                             | we adopted oar's equivalent directly          |
| Failure-mode test naming (`spawnFailureClassification`)                          | our phase-0 crash harness                     |

---

## 2. Vendor verbatim — permitted, recommended

### `botiverse/k-carrier` — Apache-2.0

- **License:** Apache-2.0, own `LICENSE` + `NOTICE`
- **13 test files** + Lean 4 proofs of `never_dual_run`, `never_bricked`, `write_ahead`
- **Never reimplement a verified crash-safety protocol.** Vendor it. Never fork it.

#### What vendoring buys that depending would not

Because the source is in the tree rather than behind a version range, the guarantees can be
_checked_, not just cited. `pnpm check:invariants` asserts that
`k.managed-copy-never-self-upgrades` is still declared in `vendor/k-carrier/src/invariants.rs` and
still guards on the same condition (recorded as **I15**, threat **T17**). It is currently the only
behavioural invariant in Radius — every other one is specified but unenforced, because
`packages/broker` does not exist yet.

The practical effect: re-vendoring a version that drops or weakens that invariant **fails the
build** rather than quietly narrowing a guarantee we publish. A dependency could not give us that.
The check is mutation-verified against five ways of breaking the entry; the reasoning and the two
implementation traps it found are recorded in `check-invariants.mjs`.

Note what this does _not_ cover: `k-carrier`'s own `NOTICE` records that **signature verification
is not implemented** — an update channel authenticated by hash and size, not by signature. Vendoring
makes that legible. It does not make it safe.

### `botiverse/agentic-inbox` — Apache-2.0

Self-hosted AI email on Cloudflare Workers. **MIT-compatible, so usable directly.**

CAUTION: **Copy only if we build email.** Not in the plan. Note it as a possible integration for
notifications; do not vendor speculatively.

### `botiverse/agent-git-service` — Apache-2.0

Self-hosted GitHub-compatible API (REST v3, GraphQL v4, OAuth device flow, Git Smart HTTP),
Go, ~16MB. Interesting for private-source agent workflows.

CAUTION: **Copy only if we build git hosting.** It is a large product on its own. Not in the plan.

### `botiverse/jetbrains-markdown` — Apache-2.0

JetBrains' multiplatform Markdown processor (JVM/JS/Native), 20MB. Available on Maven
Central already.

CAUTION: **Just take the Maven artifact.** Vendoring a 20MB fork of a published library is
gratuitous. Relevant to `mermaid-native`-style needs, not to Radius v1.

### `botiverse/kimi-agent-rs` — Apache-2.0

Rust JSON-RPC agent server, wire-compatible with Kimi Code CLI. Relevant only if we support
Kimi natively; oar already does.

CAUTION: **Skip for v1.** oar covers Kimi. Adding a second Kimi implementation is maintenance with
no user-visible gain.

---

## CAUTION: 3. Depend on — do not vendor

### `@botiverse/oar` — Apache-2.0, v0.6.0 — **PRIMARY DEPENDENCY**

5 harnesses, 58 test files, ~4,950 lines. Published on npm.

**Do not fork.** The value is upstream tracking Claude/Codex/Grok/Kimi changes as they land.
Forking means we re-implement adapter fixes forever.

Pin exact. oar is pre-1.0 and ships breaking changes. Verified 2026-09-28: published versions
run `0.0.1` → `0.6.0`; `0.6.0` is latest. **The `0.84.x` figure in some Botiverse docs belongs
to `@earendil-works/pi-coding-agent`, oar's dependency — not to oar.**

### `@botiverse/cc-switch` — MIT, 0.1.1

napi-rs bindings for provider/MCP/Skills config. Useful if Radius needs to configure harness
provider settings. **Optional.** Add when there's a concrete need.

---

## BLOCKING: 4. Do not copy — legally or reputationally

### `botiverse/chatgpt2api-peng` — MIT, but reverse-engineering ToS violation

Reverse-engineered ChatGPT web API, with **account-pool management** (`号池`) and import from
CPA/sub2api pools. MIT-licensed, so legally vendorable — **and a terrible idea.**

Carries an extensive Chinese disclaimer explicitly banning commercial use, and violating
OpenAI's terms. Shipping it under the Radius name would associate us with credential-pool
abuse tooling. **It is also unrelated to the rest of the org** — created and last pushed the
same day, a one-shot vendor, no relationship to Raft or any other repo.

**Verdict: MIT license, zero tolerance.** Never vendor, never reference, never depend.

### Multica, KuiklyUI, KuiklyBase-components — `NOASSERTION`

No OSI identifier. Cannot determine permissible use from the license alone. **Do not copy.**

`multica` is 117MB and a full managed-agents platform; Kuikly is Tencent's UI framework at
82MB and 235MB. All are forks of others' work anyway, and all are irrelevant to Radius.

### `hermes-agent` — MIT, 53k forks, 335MB

Nous Research's agent. MIT, so vendorable in principle. **Do not** — vendoring a competitor's
entire agent platform is not a dependency decision, it's a rewrite. Use oar.

### Forks generally

13 of Botiverse's 35 repos are forks. Several carry huge fork counts with 1 star
(`hermes-agent` 53k, `chatgpt2api-peng` 1.7k, `multica` 6.7k) — these are upstream's counts.
**We only fork for supply-chain pinning, never for convenience.**

---

## 5. Third-party OSS outside Botiverse

Reuse these freely (all permissive, all dependency-installable):

| Component            | License    | Use                                                         |
| -------------------- | ---------- | ----------------------------------------------------------- |
| `@cloudflare/agents` | Apache-2.0 | DO-backed agent primitives                                  |
| `hono`               | MIT        | HTTP router — Hands uses it, proven at scale on Workers     |
| `zod`                | MIT        | Schema validation at every trust boundary                   |
| `jose`               | MIT        | JWT for broker tokens                                       |
| `turborepo`          | MIT        | Build orchestration (matches `graycode-platform`)           |
| `pnpm`               | MIT        | Package manager (mandated by GrayCode convention)           |
| `vitest`             | MIT        | Test runner                                                 |
| `playwright`         | Apache-2.0 | E2E + visual testing                                        |
| `wasmtime`           | Apache-2.0 | **Only relevant if we add a WASM sandbox tier** — see below |

CAUTION: **Never vendor these.** They are on npm or crates.io. Vendoring a dependency you could
`pnpm add` just creates an update burden and a license-review problem for no gain.

### The one exception worth evaluating: a WASM sandbox tier

`quickjs-emscripten` is what `antiproton` uses — a WASM JS interpreter inside the host process.
It is lightweight and in-process, but it is **not a security boundary against a determined
attacker**, because a WASM engine escaping into the host is a real class of bug.

Our four sandbox-less runtimes (Claude, Kimi, Grok, Pi) need _something_ stronger. Three
tiers, in increasing order of strength and cost:

| Tier                    | Mechanism                                | Isolates from        | Cost     |
| ----------------------- | ---------------------------------------- | -------------------- | -------- |
| 1. Tool allowlist       | capability-scoped tool invocation        | sloppy agents        | ~0       |
| 2. Process/FS isolation | seccomp, namespaces, restricted cwd      | filesystem + network | low      |
| 3. WASM/VM sandbox      | `wasmtime` or QuickJS as a full boundary | the host process     | med–high |

**Recommendation:** tier 1 + tier 2 for v1, with the broker structured so tier 3 is a
pluggable executor rather than a rewrite. This mirrors `antiproton`'s own split — QuickJS by
default, Cloudflare Dynamic Workers when _"QuickJS cannot do — npm packages, a filesystem,
minutes of compute."_

CAUTION: **Do not claim tier 3 protection before it is measured.** `SAFETY.md` §3 states we do not
claim sandbox strength beyond the runtime's own. That line is only honest while tier 3 is
unimplemented — revisit it the moment we add a real boundary.

### The rule

Vendor only what (a) is a fork we cannot install from a registry, (b) has modifications we must
not lose, and (c) we will not track upstream anyway. That is exactly **k-carrier**. Everything
else is a dependency.

---

## 6. Vendor directory policy

```
vendor/
└── k-carrier/          Apache-2.0, LICENSE + NOTICE intact, pinned, never edited
```

**Rules:**

1. Never flatten `vendor/` into `packages/` — Apache-2.0 §4 requires NOTICE retention, MIT has
   no mechanism for it.
2. Never edit the vendored tree. Need a change? Layer a diff on top, document it in
   `THIRD_PARTY_NOTICES.md`.
3. `pnpm check:notices` verifies integrity and fails the build on drift.
4. Every vendored component has a README stating: license, upstream, version, why vendored,
   and the rules.

---

## 7. Summary

| Repo                 | License          | Verdict                                                  |
| -------------------- | ---------------- | -------------------------------------------------------- |
| `raft-source`        | **FSL-1.1-ALv2** | BLOCKING: **cannot copy — Apache-2.0 on 2028-09-24**     |
| `k-carrier`          | Apache-2.0       | **vendor verbatim**                                      |
| `antiproton`         | Apache-2.0       | conditional: **reimplement patterns** (0 tests, 3wk old) |
| `oar`                | Apache-2.0       | depend: **depend — do not fork**, pin exact              |
| `cc-switch`          | MIT              | depend: optional dependency                              |
| `agentic-inbox`      | Apache-2.0       | conditional: maybe, if we build email                    |
| `agent-git-service`  | Apache-2.0       | conditional: maybe, if we build git hosting              |
| `jetbrains-markdown` | Apache-2.0       | depend: use the Maven artifact                           |
| `kimi-agent-rs`      | Apache-2.0       | no — skip — oar covers Kimi                              |
| `hermes-agent`       | MIT              | no — don't — it's a competing platform                   |
| `chatgpt2api-peng`   | MIT              | BLOCKING: **never** — reverse-engineering ToS            |
| `multica`, `Kuikly*` | `NOASSERTION`    | BLOCKING: no OSI license — do not copy                   |

---

## 8. Non-Botiverse OSS worth knowing

Checked licenses, so the options are on the table if we need them. **All installable — none
are vendored.**

| Project              | License    | Relevance                                           |
| -------------------- | ---------- | --------------------------------------------------- |
| `wasmtime`           | Apache-2.0 | WASM sandbox tier (see §5)                          |
| `astral-sh/uv`       | Apache-2.0 | Python env pinning, if we ever shell out to tooling |
| `sharkdp/bat`        | Apache-2.0 | Nice-to-have for agent-run CLI output               |
| `junegunn/fzf`       | MIT        | Fuzzy selection in the workspace UI                 |
| `zellij-org/zellij`  | MIT        | Terminal multiplexer — plausible `agent-host` TUI   |
| `BurntSushi/ripgrep` | Unlicense  | Public domain; search                               |

CAUTION: **The CLI/TUI cluster is a real temptation and mostly a distraction.** A beautiful terminal
UI for managing an agent fleet is a week of work that gets zero adoption and does not
differentiate us. The wedge is unattended safety, not developer ergonomics. Defer.

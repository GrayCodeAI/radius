# vendor/k-carrier

Vendored component. **Apache-2.0, owned by Botiverse. Not ours to modify.**

| | |
|---|---|
| **Upstream** | https://github.com/botiverse/k-carrier |
| **Version** | **0.3.2** (from `Cargo.toml`; verified 2026-09-28) |
| **License** | Apache-2.0 — `LICENSE` and `NOTICE` are in this directory, unmodified |
| **Vendored** | 2026-09-28, from `main` at commit `HEAD` of a shallow clone |
| **Purpose** | Crash-safe two-slot installer for the local agent host |

## Why vendored

Its two-slot journaled upgrade protocol is machine-checked in Lean 4 — `never_dual_run`,
`never_bricked`, `write_ahead` — with non-vacuity examples, and backed by 13 test files
including `simulation.rs`, `durable.rs`, and `quarantine.rs`.

**We do not reimplement it.** A journaled crash-safety protocol re-derived by reading source is
how users' machines get silently bricked. See `PLAN.md` §12 and `DECISIONS.md` D-004.

## Rules

1. **Never edit any file in this directory.** Not the source, not the tests, not the Lean model.
2. **Never fork it.**
3. If we need behavior it lacks, **layer a diff on top** as a separate crate and document it in
   `THIRD_PARTY_NOTICES.md`.
4. `pnpm check:notices` enforces that `LICENSE` and `NOTICE` remain present.

## Not a package

There is **no `k-carrier` crate on crates.io** (verified 2026-09-28). This is a path dependency
or a built binary we invoke — `cargo add k-carrier` will not work.

## Read this before trusting it

`formal/Protocol.lean` documents its own limits in its header. The model proves three theorems
over a state machine, and the header states plainly what it does **not** cover:

- It does not resolve the filesystem window inside `promote` (the rename-over case), which is
  below one effect step. In the real code that window is covered by the durable promote intent
  plus idempotent replay.
- It assumes a host contract: `stop()` returning means the process is gone; `start()` starts
  only the requested slot; the probe answers for one live incarnation.

**So the formal guarantees and the engineering guarantees are not the same set.** Know which is
which before you rely on either. Reproduce with:

```sh
elan run leanprover/lean4:v4.34.0 lean formal/Protocol.lean
```

## Also note

`NOTICE` records that k-carrier's design was informed by studying rustup's self-update,
Datadog's fleet installer, and Tailscale's distsign — **concepts only, no code copied** — and
states that signature verification is **not** implemented; it verifies artifact integrity by
sha256 and size only. That matters for us: an update channel is authenticated by hash, not by
signature.

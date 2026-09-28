# Third-Party Notices

Radius is MIT-licensed. Vendored components under `vendor/` retain their own
licenses, which govern those components. This file attributes each.

**Never flatten `vendor/` into `packages/`.** Apache-2.0 §4 requires retaining
copyright notices, the NOTICE file, and stating modifications. MIT provides no
mechanism for that, so the separation is load-bearing.

## Runtime dependencies (installed via package manager)

| Component              | Version           | License    | Use                                                   |
| ---------------------- | ----------------- | ---------- | ----------------------------------------------------- |
| `@botiverse/oar`       | 0.6.0 (pin exact) | Apache-2.0 | Harness abstraction — 5 agent runtimes behind one API |
| `@botiverse/cc-switch` | 0.1.1             | MIT        | Provider/MCP/Skills config management (optional)      |

## Vendored components

### `vendor/k-carrier/`

- **License:** Apache-2.0 — its `LICENSE` and `NOTICE` remain in-tree, untouched
- **Upstream:** https://github.com/botiverse/k-carrier
- **Version:** **0.3.2** (verified 2026-09-28, from upstream `Cargo.toml`)
- **Use:** Two-slot journaled installer for the local agent host. Upgrades are
  crash-safe by construction; the protocol is formally verified in Lean 4
  (`never_dual_run`, `never_bricked`, `write_ahead`).
- **Distribution:** there is no `k-carrier` crate on crates.io (verified 2026-09-28).
  It is a path dependency or a built binary. Note this is a _different_ artifact from
  the `@botiverse/k-carrier` npm package that Raft patches at `0.1.8`.

CAUTION: **Do not fork or patch the vendored tree.** If we need behavior it lacks,
layer our diff on top as a separate crate and document it here.

## Patterns reimplemented (no code copied)

The per-tenant Durable Object isolation, outbox, and lease patterns were
reimplemented against our own schema. See `PLAN.md` §12 for the reasoning. No
`antiproton` source was copied; it is Apache-2.0 and remains available upstream
if we ever need to reference an implementation.

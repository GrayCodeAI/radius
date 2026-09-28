---
description: Radius — build, test, and contribution conventions.
globs: "*.ts,*.tsx,*.js,*.json,*.yaml,*.yml"
alwaysApply: false
---

# Radius Conventions

Agent communication platform where humans and agents are peers with **bounded reach**.

## What Radius is

Four layers, built bottom-up, sold top-down:

| Layer                                 | Package                                   | Status             |
| ------------------------------------- | ----------------------------------------- | ------------------ |
| Platform (identity, tenancy, storage) | `apps/control-plane`, `packages/protocol` | planned            |
| Runtime (sessions, sandbox, broker)   | `packages/broker`, `apps/agent-host`      | **phase 1 — next** |
| Orchestration (fleet, cost caps)      | `packages/orchestrator`                   | planned            |
| Workspace (channels, tasks)           | `apps/web`                                | planned            |

See `PLAN.md` for the full decision record. **Read it before designing anything** — the market
thesis, license posture, and dependency calls are settled there, not open questions.

## Non-negotiables

1. **No YOLO by default.** `@botiverse/oar` ships sessions with interactive permission gates
   disabled and sandboxes off. We invert this: sandbox **on**, credentials brokered and scoped.
   An agent never holds a raw credential. If you are tempted to add an opt-out, it must be
   per-agent, audited, and recorded in the `approvals` table. _Get this wrong and our first CVE is
   our name._
2. **Migrations are append-only.** Never rename, delete, or edit an existing
   `apps/*/migrations/*.sql`.
3. **`wrangler.jsonc` is strict JSON** (no comments, no trailing commas) — the deploy tooling parses it.
4. **`vendor/` is never flattened into `packages/`.** Apache-2.0 components keep their LICENSE and
   NOTICE intact. See `THIRD_PARTY_NOTICES.md`.
5. **Never reimplement crash-safety.** `k-carrier` is vendored verbatim and formally verified in
   Lean 4. Do not fork it, do not patch the vendored tree, do not "improve" it. If we need
   behavior it lacks, layer our diff on top and document it.

## Development workflow

Feature branch from `main` first — `feat/`, `fix/`, or `chore/`. Never commit to `main`. Open a PR,
get CI green, then merge. This repo **accepts PRs** (Raft accepts none); a lightweight DCO
(`Signed-off-by`) is required — see `CONTRIBUTING.md`.

## Build & Test

- **pnpm**, never npm or yarn
- Install: `pnpm install --frozen-lockfile`
- `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint`
- `pnpm check:invariants` — asserts the safety invariants hold; **must pass before merge**
- `pnpm check:notices` — verifies `vendor/` license integrity
- `pnpm check:proofs` — re-runs k-carrier's Lean 4 proofs against the vendored source
- Format: `pnpm prettier --check "**/*.{ts,tsx,js,json}"`

### The Lean proofs are a claim until you run them

`pnpm check:proofs` re-verifies `never_dual_run`, `never_bricked` and `write_ahead` at the
toolchain pinned in `vendor/k-carrier/lean-toolchain` (currently `leanprover/lean4:v4.34.0`,
verified green 2026-09-28). It is **not** in CI: pulling a Lean toolchain is a large download for
a check over a file we are forbidden to edit, and the answer can only change across a re-vendor.

Run it before and after a re-vendor. If elan is absent it skips with an explicit note rather than
passing quietly — a check that silently did not run is worse than no check. It also asserts the
three theorem names are still present, so a silent rename fails loudly rather than quietly
narrowing a guarantee we print in the README.

### Lint is type-aware, and that is deliberate

`pnpm lint` is `eslint .` with `typescript-eslint`'s **strict type-checked** preset — it loads
real type information, not just syntax. It is slower than the untyped preset on purpose.

The reasoning is specific to this repo: our product claim is that a record is durable before
`append()` resolves. A dropped promise in this codebase is not a style violation, it is a
silently lost write. `no-floating-promises`, `await-thenable`, `require-await` and
`no-misused-promises` are the rules that catch it, and none of them work without types. Do not
"optimize" the preset back to the untyped one without re-arguing that.

Two rules are tuned rather than silenced, both in `eslint.config.mjs` with the reasoning
inline: `restrict-template-expressions` allows numbers (`seq 41` is the point of the message),
and `no-confusing-void-expression` ignores arrow shorthand (`() => resolve()` is idiomatic in
a promise executor). The block-bodied case is still reported.

`node:test`'s `test()`/`describe()`/hooks return promises the runner owns, so
`no-floating-promises` is told about them — **scoped to test files only**. The identical mistake
in `src/` remains a hard error.

`vendor/` is in the ESLint ignore list. It is vendored verbatim and a `lint --fix` must never
touch it (non-negotiable 4).

### Pre-commit

A husky `pre-commit` hook runs `lint-staged`, so ESLint and Prettier run over staged files on
every commit. It cannot replace CI — CI is the gate — but it catches a violation before it
reaches the branch. `pnpm lint:fix` applies fixes across the whole repo.

## Testing expectations

Every new module ships with tests in the same change. `antiproton` is 15.6k lines with zero test
files and three weeks old — that is the failure mode we are explicitly not copying. A
crash-safety or isolation claim without a test is a comment, not a claim.

## Naming

Always cite as **Radius by GrayCode AI** in docs and issues — "Radius" alone collides with a
graphics API, a database feature, and the RADIUS protocol. Protocol versions are `radius/v1`,
mirroring oar's `oar-voyage/1` habit.

## Ecosystem boundaries

- Radius is a **product** repo. It is not a `graycode-platform` dependency, and
  `graycode-platform` is not a Radius dependency.
- `rho`, `flux`, and the other GrayCode projects must build, test, and run fully without this repo.
- For graycode-eco-wide agent guidelines, see
  [rho/AGENTS.md](https://github.com/GrayCodeAI/rho/blob/main/AGENTS.md).

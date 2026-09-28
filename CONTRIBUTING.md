# Contributing

Radius accepts pull requests. This is a deliberate difference from comparable products — we
will not ship a source-available codebase and then ask for contributions under a license that
forbids competing use.

## Workflow

1. Branch from `main`: `feat/`, `fix/`, or `chore/`.
2. Open a PR. CI must be green.
3. Sign off your commits (`git commit -s`) — see DCO below.
4. Merge.

`pnpm check:invariants` is a required check. A failure blocks merge. See `AGENTS.md`.

CI runs typecheck, lint, format, test, `check:invariants` and `check:notices`. A husky
`pre-commit` hook runs the same lint and format rules over staged files, so most failures are
caught before they reach the branch — but CI is the gate, not the hook.

## DCO

All commits require a `Signed-off-by` line:

```
git commit -s -m "message"
```

This is the lightweight Developer Certificate of Origin, not a CLA. It asserts you have the
right to contribute the code and agrees to the project license. There is no separate
contributor agreement to sign.

## Getting set up

```sh
corepack enable
pnpm install
pnpm build && pnpm test
```

Node 24 or newer is required — oar declares `node >=24.0.0`, and this repo is pinned to match.
(Other GrayCode repos use Node 22; the divergence is deliberate and recorded in
`docs/DECISIONS.md` D-015.)

## What we expect

**Tests, in the same change as the feature.** A crash-safety or isolation claim without a test
is a comment, not a claim. This is a direct lesson from our own survey: the project we chose
_not_ to vendor is 15,600 lines with zero test files.

**Invariants before features.** Any new capability needs a named invariant and a regression
test before it can be granted. `docs/THREATS.md` §6 maps threats to invariants; add to it.

**State the non-guarantee.** If your change cannot be made safe, say so in `docs/SAFETY.md` §3
rather than shipping it silently — and add it to the `NON_GUARANTEES` list in
`scripts/check-invariants.mjs` so it cannot be quietly deleted later. That list is a guard, not
decoration: each entry fails the build if the corresponding row disappears.

## What we will reject

- A feature that widens a principal's reach without an invariant and an audit record
- A default that weakens safety without a major version bump
- New third-party dependencies without a license check
- Anything that makes a raw credential reachable from agent context

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Be direct and technically honest. Critique code, not people. Disagreement is expected — most of
our design decisions are recorded with the alternative that lost and why.

## License

Contributions are accepted under the MIT license. See [LICENSE](LICENSE). Vendored components
keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

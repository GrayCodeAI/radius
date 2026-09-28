# Radius

**Identified, bounded communication between agents and humans.**

Radius is an agent communication platform where humans and agents are peers — with
_bounded reach_. Every principal has a center and an edge, and nothing happens
outside the edge.

The name is the invariant: a radius is bounded by definition, and so is an
agent's authority. It also carries the one meaning most infrastructure
engineers already have for it — RADIUS is the AAA protocol. We are doing RADIUS
for agents.

**Status:** pre-implementation. See [PLAN.md](PLAN.md) for the decision record.

## The position

Unattended agents are the problem nobody has solved safely. Every agent platform
inherits YOLO by default: interactive permission gates disabled, sandboxes off.
That is correct when a human is watching a terminal, and remote code execution
when nobody is.

Radius runs agents unattended **on by default**:

- Sandboxed, per-runtime, opt-out only and audited
- Credentials brokered and scoped per agent launch — never a raw key in context
- Every privilege escalation gated by an approval record
- Upgrades that are _provably_ unable to brick the host (Lean 4 verified)

## Layer model

```
┌─ Workspace      channels, threads, tasks, human+agent peers
├─ Orchestration  fleet supervision, cost caps, routing          ← entry point
├─ Runtime        durable sessions, sandbox, credential brokering
└─ Platform       identity, tenancy, storage, observability      ← the moat
```

Each layer is independently useful. Built bottom-up, sold top-down.

## Upstream

| Dependency                                            | Relationship                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`@botiverse/oar`](https://github.com/botiverse/oar)  | Harness abstraction for Claude Code, Codex, Grok, Kimi, Pi. Apache-2.0, depended on directly. |
| [`k-carrier`](https://github.com/botiverse/k-carrier) | Crash-safe installer, vendored verbatim. Apache-2.0, formally verified.                       |

Radius is **not** affiliated with GrayCode AI's other work and does not depend on
`graycode-platform`.

## License

MIT — see [LICENSE](LICENSE). Vendored components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

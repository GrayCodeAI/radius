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

Radius is a **GrayCode AI** product: repository `GrayCodeAI/radius`, cite as
"Radius by GrayCode AI" because the name collides with the RADIUS networking
protocol. See `GrayCodeAI/graycode-eco/ecosystem.yaml` for the canonical
inventory of sibling products.

Radius has **no compile-time dependency on any sibling product**, and in
particular does not depend on `graycode-platform`. It communicates over versioned
contracts only.

### Relationship to Trail

Radius and Trail are adjacent layers, not competing products. This was
previously documented the other way around; the correction is recorded in
`graycode-eco/adr/0004`.

- **Radius** owns identified, bounded communication: messages, leases, approval
  gates, capability-scoped credentials, and budgets.
- **Trail** owns work items: situations, desired outcomes, requests,
  commitments, evidence references, and acceptance.

A change that adds a state to a work item belongs in Trail. A change that adds a
message, a lease, or an approval gate belongs in Radius. Neither needs the
other's data model to make that change.

## License

MIT — see [LICENSE](LICENSE). Vendored components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

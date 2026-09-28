# Protocol — `radius/v1`

The wire contract. Stable surface for agents, hosts, and the control plane.

CAUTION: **Modeled on oar's discipline, not its format.** oar splits records by obligation into
`frame` (the runtime's words), `request` (expects an outcome), and `response` (points at a
request), all on one channel with one monotonic `seq`. That distinction is worth stealing
because it makes a record's provenance machine-checkable. We adopt the shape, not the bytes.

---

## 1. Principles

1. **Everything is a record on a stream.** Messages, state changes, escalations, decisions. One
   ordering model, not five ad-hoc ones.
2. **Every record knows whose it is.** `actor_id` is mandatory, never optional.
3. **Readable from any position.** `afterSeq` replay, no gaps, no duplicates.
4. **Silence is not a claim.** An absent record means we did not observe it. Never infer.
5. **Exactly-once only where it is structurally true.** The `approvals` path, and nowhere else.

---

## 2. Envelope

```jsonc
{
  "v": "radius/v1", // protocol version, required
  "seq": 1042, // monotonic per stream, allocated by the issuer
  "id": "01HQ...", // unique record id
  "ts": 1759000000000, // issuer clock — ADVISORY, never ordering
  "actor": { "id": "pr_...", "kind": "agent" },
  "center": "ch_...", // the workspace/task this belongs to
  "kind": "request", // frame | request | response
  "in_reply_to": "rec_...", // required when kind = response
  "body": {},
}
```

CAUTION: **`ts` is advisory and must never be used for ordering.** A skewed or delayed host emits
records out of wall-clock order; `seq` is the only reliable sequence. This is the same reason
`recorded_at` and the record's own timestamp are distinct columns in `DATA-MODEL.md`.

CAUTION: **`v` is required on every record, not just in a handshake.** Version skew is a per-record
property; a long-lived host may straddle a version boundary.

---

## 3. Record kinds

### `frame` — the runtime's own words

Model output, tool results, progress. Not addressed to anyone. _Everything the runtime said is
in the stream._

### `request` — an action expecting an outcome

A prompt, a steering input, an escalation. Carries `capability` when it is a privileged action.

```jsonc
{
  "kind": "request",
  "body": {
    "op": "tool.invoke",
    "capability": "repo:write",
    "args": { "path": "src/", "op": "write" },
  },
}
```

### `response` — points at a request

```jsonc
{
  "kind": "response",
  "in_reply_to": "rec_...",
  "body": {
    "outcome": { "type": "allow" }, // allow | deny | escalate | fail
  },
}
```

**Why the three-way split matters:** a consumer can enumerate what was _asked_ and what was
_granted_ without parsing model output. The audit log is reconstructable from the record stream
alone. That property is worth more than the bytes saved by a flatter schema.

---

## 4. Delivery semantics

CAUTION: **This is the section most likely to be misread, so it is stated bluntly.**

| Path                      | Guarantee                               | Why                                                                              |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| **`approvals` decisions** | **exactly-once**                        | `request_id` has a unique index; a replay is an idempotent no-op by construction |
| everything else           | **at-least-once**, idempotent consumers | `seq` dedupe; no distributed transaction across the seam                         |
| `seq` allocation          | exactly-once **per issuer**             | The DO (plane) or the adapter (host) allocates; never a client                   |

**Do not put "exactly-once" in the marketing or the API docs for anything but `approvals`.**
A team that believes their agent's output is exactly-once will build delivery on top of that
assumption and be wrong.

### Offline

An offline host accumulates records locally and syncs by `cursor` on reconnect. **No record is
dropped and none is duplicated** — guaranteed by `seq` and the `afterSeq` contract, not by
transactional delivery.

**Consequence for UIs:** anything shown before sync is provisional. The workspace must not
imply stronger consistency than the seam provides (`ARCHITECTURE.md` §3).

---

## 5. Operations

| Op                          | Direction          | Notes                                                                          |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `prompt`                    | human/plane → host | one turn. CAUTION: ≤1 active; oar rejects `busy`                               |
| `steer`                     | plane → host       | mid-turn. Rejected `not_steerable` when nothing is active                      |
| `queue`                     | plane → host       | CAUTION: **not uniformly durable** — see §6                                    |
| `abort`                     | plane → host       | accepted means _delivered_; the outcome is the runtime's own turn-ended record |
| `capability.request`        | host → plane       | produces an `approvals` row                                                    |
| `capability.grant`          | plane → host       | time-boxed, per §4                                                             |
| `sync`                      | bidirectional      | cursor-based, replay-then-live                                                 |
| `lease.acquire` / `release` | host ↔ plane      | epoch-fenced (`DATA-MODEL.md` §2)                                              |

### `abort` is a delivery receipt, not a result

CAUTION: `accepted` means the interrupt was **delivered**, not that the turn stopped. The real outcome
arrives as the runtime's own `turn_ended` frame. A UI that shows "aborted" on `accepted` is
reporting a request, not a fact — exactly the kind of overclaim `SAFETY.md` §3 forbids.

---

## 6. Capability protocol

```
host                                   plane
 │  capability.request {principal, capability, scope, task}
 │ ────────────────────────────────────►│
 │                                     │ insert approvals(request_id = client UUID)
 │                                     │   decided_by MUST be human
 │  (human decides in UI or via CLI)   │
 │                                     │
 │ ◄────────────────────────────────────  capability.grant {capability, scope, expires_at}
 │
 │  broker resolves credential, never returns it to the agent
```

**Rules:**

- `request_id` is a **client-supplied UUID** and is the idempotency key. This is the entire
  mechanism behind the exactly-once claim.
- `decided_by.kind` must be `human`. An agent cannot approve its own escalation.
- Every grant carries `expires_at` **and** `monotonic_bound`. No permanent grants
  (`SAFETY.md` G5).
- `expires_at` alone is not sufficient. A grant also carries a `monotonic_bound`: the host
  reconciles the wall clock with a monotonic source once, on receipt, and thereafter trusts only
  the monotonic side. A host that enforced expiry against `Date.now()` alone would let a user
  extend an expired lease by setting the system clock back (D-008, T16).
- The plane never sends a credential to the host. It sends _permission_; the host's broker
  resolves the secret locally.

CAUTION: **The last point is the whole design.** If the plane can send a credential, the plane is a
credential exfiltration target, and G1 is gone.

---

## 7. Queue durability

`capabilities.queue` is `{ durable: boolean } | null` in oar, and it is **not uniform**:

| Runtime         | `queue.durable`             |
| --------------- | --------------------------- |
| Codex           | `true` (runtime-persisted)  |
| Claude, Pi, ACP | `false` (this process only) |

CAUTION: **A queued message is not a safe message** unless the capability says `durable`. A host
crash silently eats non-durable queued input, and a UI that presented it as "queued" would be
lying. Both the orchestrator and the UI must read the capability and reflect it.

---

## 8. Versioning

Semver on the protocol string, `radius/vN`.

| Change                                      | Version                                                      |
| ------------------------------------------- | ------------------------------------------------------------ |
| New optional field                          | minor                                                        |
| New record kind                             | minor                                                        |
| **Any removal, rename, or semantic change** | **major**                                                    |
| Tightening a default (e.g. sandbox on)      | **major** — a silent security downgrade is a breaking change |

CAUTION: **Defaults are part of the contract.** Turning sandbox on by default is a _major_ change for
a host built against v1 defaults, even though no field changed. A host that silently loses its
sandbox must fail loudly, not drift.

### Compatibility

- A host may lag the plane by one minor. Never a major.
- A host that sees an unknown `v` **rejects and reports**, rather than best-effort parsing.
  Silent misparse of a security-relevant record is worse than a failed sync.
- Unknown record kinds are retained and ignored, not dropped — dropping loses audit history.

---

## 9. What is deliberately not in `radius/v1`

| Absent                                  | Why                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Streaming tokens to the UI              | The host is the source of truth; the plane syncs state. See `ARCHITECTURE.md` §3 |
| Cross-tenant operations                 | Structurally impossible (one DO per tenant)                                      |
| A generic permission blob               | Capabilities are rows, auditable per item                                        |
| Batch/transactional multi-record writes | Breaks the single-`seq` model; the outbox exists for this                        |
| A "trust me" field                      | If a field asserts trust rather than carrying evidence, the broker is wrong      |

# Data model

L1 control plane (per-tenant Durable Object + SQLite), plus the L2 local store that makes
hybrid work.

CAUTION: **Reimplemented, not vendored.** These patterns come from `antiproton` (Apache-2.0), which is
3 weeks old with **zero test files**. We own the isolation code because it is the property we
sell — see `PLAN.md` §12.

---

## 1. Tenancy

**One Durable Object per tenant. One SQLite database per DO.**

Cross-tenant data is _physically absent from the querying database_, not excluded by a `WHERE`
clause. This is guarantee G4 in `SAFETY.md` and it is the reason for the reimplementation.

```
Worker
├── tenant A → DO(tenantA) → SQLite   { principals, tasks, ... }
└── tenant B → DO(tenantB) → SQLite   { principals, tasks, ... }
```

CAUTION: **Consequence for engineers:** a DO cannot query across tenants by construction. If a feature
needs cross-tenant data, it needs a deliberate second path (an aggregate DO, a materialized
projection) — not a `WHERE tenant_id != ?`. Cross-tenant access is a design error, not a query.

### Tenant resolution

Resolved once, at the edge, from a verified token. **Never** from a header the client can set
freely. Unresolved tenant → reject before touching a DO, not inside one.

---

## 2. Tables

### `principals`

| Column                      | Type    | Notes                                           |
| --------------------------- | ------- | ----------------------------------------------- |
| `id`                        | text PK | stable identity                                 |
| `tenant_id`                 | text    | implied by the DO, not a filterable column      |
| `kind`                      | text    | `human` \| `agent` \| `service`                 |
| `center_id`                 | text    | the workspace/task it belongs to — _the radius_ |
| `display_name`              | text    |                                                 |
| `broker_token_hash`         | text    | **hash only.** See §4                           |
| `created_at` / `revoked_at` | int     | revocation is soft, for audit                   |
| `last_seen_at`              | int     | advisory; never used for liveness decisions     |

BLOCKING: **No column in any table holds a raw credential.** If a migration needs one, the design is
wrong. This is invariant I1 (`SAFETY.md` G1).

### `capabilities`

| Column         | Type                 | Notes                                                                                                 |
| -------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`           | text PK              |                                                                                                       |
| `principal_id` | text FK              |                                                                                                       |
| `capability`   | text                 | e.g. `repo:read`, `model:invoke`, `net:egress`                                                        |
| `scope`        | text                 | JSON: which repos, which hosts, which paths                                                           |
| `granted_by`   | text FK → principals | a human, always                                                                                       |
| `granted_at`   | int                  |                                                                                                       |
| `expires_at`   | int                  | **required.** Default lease **1 hour**, per D-008. Long leases require a human-approved `approval_id` |
| `revoked_at`   | int                  |                                                                                                       |
| `approval_id`  | text FK → approvals  | every grant traces to a decision                                                                      |

**Uniqueness:** `(principal_id, capability, scope_hash)` — re-granting an active capability is
an idempotent no-op, not a new row.

CAUTION: `expires_at` is **NOT NULL** in practice. A grant that never expires is a permanent
credential with extra steps. The only "never expires" case is a short-lived admin grant, which
still expires.

### `tasks`

| Column                        | Type                 | Notes                                                            |
| ----------------------------- | -------------------- | ---------------------------------------------------------------- |
| `id`                          | text PK              |                                                                  |
| `center_id`                   | text                 | channel/thread it lives in                                       |
| `title`, `body`               | text                 |                                                                  |
| `assignee_id`                 | text FK → principals | null = unassigned                                                |
| `state`                       | text                 | `open \| claimed \| in_progress \| blocked \| done \| cancelled` |
| `required_capabilities`       | text                 | JSON — **the task declares its own radius**                      |
| `budget_tokens` / `budget_ms` | int                  | consumed by phase 4 caps                                         |
| `created_at` / `updated_at`   | int                  |                                                                  |
| `version`                     | int                  | optimistic concurrency                                           |

**Optimistic concurrency** on `version` — two agents claiming one task must not both succeed.

### `events`

Control-plane-side activity. Monotonic per tenant.

| Column       | Type | Notes                                             |
| ------------ | ---- | ------------------------------------------------- |
| `seq`        | int  | **PRIMARY KEY, monotonic** — the cursor anchor    |
| `kind`       | text | `task.created`, `message.posted`, `agent.woke`, … |
| `actor_id`   | text | the principal responsible                         |
| `center_id`  | text |                                                   |
| `payload`    | text | JSON                                              |
| `created_at` | int  |                                                   |

CAUTION: **`seq` is allocated by the DO**, not by a client timestamp. This is what makes
`afterSeq` cursors work — see `PROTOCOL.md`.

### `cursors`

Sync position per `(host_id, session_id)`.

| Column                  | Type | Notes                                     |
| ----------------------- | ---- | ----------------------------------------- |
| `host_id`, `session_id` | text | composite PK                              |
| `last_plane_seq`        | int  | what the host has consumed from the plane |
| `last_host_seq`         | int  | what the plane has consumed from the host |
| `lease_id`              | text | which controller currently owns it        |
| `updated_at`            | int  |                                           |

### `leases`

The distributed primitive oar explicitly declines. **One controller per session** (G7).

| Column                       | Type    | Notes                                      |
| ---------------------------- | ------- | ------------------------------------------ |
| `id`                         | text PK |                                            |
| `resource`                   | text    | e.g. `session:<uuid>`                      |
| `holder_id`                  | text    | host or controller                         |
| `acquired_at` / `expires_at` | int     |                                            |
| `epoch`                      | int     | **fencing token** — increments on takeover |

CAUTION: **`epoch` is not optional.** Without a fencing token, a partitioned old holder can still
write. The epoch is checked on every write; a stale epoch is rejected. This is the standard
lease-fencing pattern and it is the difference between "we have leases" and "we cannot
split-brain."

CAUTION: **Expiry is evaluated by the DO's clock, never the holder's.** Clock skew must not
manufacture or suppress a lease.

### `outbox`

Dual-write escape hatch. Plane state and events are written in one DO transaction; the
outbox row is what a worker delivers.

| Column         | Type    | Notes          |
| -------------- | ------- | -------------- |
| `id`           | text PK |                |
| `topic`        | text    |                |
| `payload`      | text    | JSON           |
| `created_at`   | int     |                |
| `delivered_at` | int     | null = pending |
| `attempts`     | int     |                |

**Rule:** never write to a system outside the DO and to the DO in separate steps. Write the
outbox row in the same transaction; deliver from the row.

### `approvals`

Human decisions. **Exactly-once** — the only path where we claim it.

| Column         | Type                 | Notes                                                       |
| -------------- | -------------------- | ----------------------------------------------------------- |
| `id`           | text PK              | **client-supplied UUID** — this is what makes it idempotent |
| `request_id`   | text                 | the escalation being decided; **unique index**              |
| `principal_id` | text                 | who is asking                                               |
| `capability`   | text                 | what they want                                              |
| `decision`     | text                 | `approved \| denied \| expired`                             |
| `decided_by`   | text FK → principals | **must be `human`**                                         |
| `decided_at`   | int                  |                                                             |
| `expires_at`   | int                  | decisions expire too                                        |

**Unique index on `request_id`** — a replayed decision is an idempotent no-op, not a second
row. This is the structural reason exactly-once is achievable here and nowhere else.

CAUTION: **A check constraint (or DO-level validation) must enforce `decided_by.kind = 'human'`.**
An agent must never be able to approve its own escalation. That is a single-tenant privilege
escalation if it slips.

### `usage_counters`

| Column                          | Type    | Notes                        |
| ------------------------------- | ------- | ---------------------------- |
| `key`                           | text PK | principal + window + bucket  |
| `window_start`                  | int     |                              |
| `tokens` / `ms` / `cost_micros` | int     | monotonic, never decremented |
| `updated_at`                    | int     |                              |

**Monotonic only.** Refunds are separate rows, never negative writes. A counter that can go
down cannot be used to enforce a budget.

### `audit_log`

| Column                                 | Type    | Notes                   |
| -------------------------------------- | ------- | ----------------------- |
| `id`                                   | text PK |                         |
| `principal_id`, `capability`, `target` | text    | the decision            |
| `decision`                             | text    | allow / deny / escalate |
| `reason`                               | text    |                         |
| `host_id`, `launch_id`                 | text    |                         |
| `created_at`                           | int     |                         |

**Append-only.** No `UPDATE`, no `DELETE` — enforce with a DO that never exposes mutating
operations, and a test that asserts the absence.

CAUTION: **Open question:** an append-only log editable by the thing it audits is not an audit log.
Needs external anchoring (transparency log, periodic hash chain) before phase 3. Tracked in
`DECISIONS.md` as D-009.

---

## 3. L2 local store (agent host)

The host is the source of truth for agent output (`ARCHITECTURE.md` §3).

### `sessions`

| Column              | Type    | Notes                                                                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                | text PK | oar session id — runtime-native identity                                                                           |
| `runtime`           | text    | `claude` \| `codex` \| `grok` \| `kimi` \| `pi`                                                                    |
| `cwd`               | text    | **absolute.** Never relative — see `ADAPTERS.md` §5.1                                                              |
| `capabilities_json` | text    | cached, time-boxed grants                                                                                          |
| `grants_expire_at`  | int     | offline lease boundary. **Monotonic-bound**, per D-008 — a wall-clock-only value can be extended by clock rollback |
| `attribution_tier`  | text    | from oar; drives honest UI                                                                                         |
| `queue_durable`     | int     | **from oar's capability.** Not assumed                                                                             |
| `state`             | text    | `starting \| running \| stopped \| degraded`                                                                       |

### `records`

oar's stream, persisted. **Append-only, never rewritten.**

| Column        | Type | Notes                                                |
| ------------- | ---- | ---------------------------------------------------- |
| `seq`         | int  | **monotonic per session, allocated by the adapter**  |
| `session_id`  | text |                                                      |
| `kind`        | text | `frame`, `request`, or `response`                    |
| `body`        | text | JSON                                                 |
| `recorded_at` | int  | when _we_ persisted it, not when the harness said it |

CAUTION: **Do not dedupe on write, and do not reorder.** The stream is the ground truth about what the
runtime did. Cleanup is a retention policy, not an edit.

**`recorded_at` vs the record's own timestamp is a real distinction.** A clock-skewed or
delayed harness can emit records out of wall-clock order. `seq` is the only reliable ordering.

---

## 4. Secrets

BLOCKING: **Never stored, never logged, never returned.**

- `broker_token_hash` — store a **hash**. A leaked table must not yield working tokens.
- Raw credentials exist only inside the broker process, in memory, and are unreferenced by name
  in any durable structure.
- Tokens are per-`(principal, launchId, capability)`, unguessable, time-boxed, revocable
  without agent restart.

**Enforcement:** invariant I1 (no secret-shaped value in any durable field) plus a test that
scans for it. Not a code-review convention.

---

## 5. Migration discipline

Inherited from `graycode-platform` and binding here:

- **Append-only.** Never rename, delete, or edit a shipped migration.
- `wrangler.jsonc` is **strict JSON** — no comments, no trailing commas. The deploy tooling
  parses it.
- Newest migration number wins. Old migrations stay forever; a shipped schema is history.

CAUTION: **Because D1 has no cheap `ALTER`**, plan for expand/contract: add nullable → backfill →
switch reads → drop. A migration that assumes a table is empty will bite in production.

---

## 6. What is deliberately absent

| Not modeled                  | Why                                                            |
| ---------------------------- | -------------------------------------------------------------- |
| Cross-tenant tables          | Structurally impossible. See §1.                               |
| A `credentials` table        | Would violate G1.                                              |
| Mutable `events`             | Append-only is the audit property.                             |
| A general `permissions` blob | Capabilities are rows. A JSON blob cannot be audited per-item. |
| Soft-delete on `audit_log`   | Would defeat the guarantee.                                    |

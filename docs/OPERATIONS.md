# Operational plan

How Radius runs. Written at planning stage, so this states intended posture and flags what is
still undecided rather than describing an imaginary running system.

---

## 1. Deployment topology

| Component            | Where                     | Scale                           |
| -------------------- | ------------------------- | ------------------------------- |
| `apps/control-plane` | Cloudflare Workers        | scale-to-zero; DO per tenant    |
| `apps/agent-host`    | User or CI machine        | one process, supervised locally |
| `apps/web`           | Workers static assets     | edge-cached                     |
| `packages/broker`    | In the agent host process | local, no network dependency    |

The plane is the only shared state. The host is the only thing that touches a filesystem or
spawns a harness.

### Cloudflare dependencies and their consequences

- **Durable Objects** — required for per-tenant isolation. This is the load-bearing binding.
  Losing it loses G4.
- **D1** — used only for plane-level metadata. **Not** for tenant data; that lives in DO SQLite.
- **R2** — artifacts, audit export, symbol uploads. Optional.
- **Queues** — outbox delivery. Optional; a DO poller is sufficient at low volume.

### Non-Cloudflare path

**Undecided.** Segment 3 (agent-as-a-service) may need a non-Cloudflare control plane. If that
matters, the tenancy model must not assume DO — the per-tenant-isolation _property_ has to
survive even if the mechanism changes.

Recorded as D-007 in `DECISIONS.md`. Do not let DO assumptions spread through the code before
this is settled.

---

## 2. Configuration

| Layer               | Source                              | Notes                                                     |
| ------------------- | ----------------------------------- | --------------------------------------------------------- |
| Plane secrets       | Cloudflare secrets                  | **Never** in the repo. No Cloudflare credential in GitHub |
| Broker tokens       | Issued per launch, never configured |                                                           |
| Harness credentials | Broker-held, resolved locally       | Never in env, never in config files                       |
| Runtime selection   | Config, allowlisted                 | A config value cannot select an arbitrary binary          |

**Harness credentials are the sensitive one.** They must not appear in:

- a process environment a user can read
- a log line
- a trace span
- a crash report
- a `wrangler.jsonc` (strict JSON, parsed by the deploy tooling — it is a config surface)

Enforced by invariant I10 (canary secret absent from all output), not by review.

---

## 3. Migrations

Inherited from `graycode-platform` and binding here:

- **Append-only.** Never rename, delete, or edit a shipped migration.
- `wrangler.jsonc` is **strict JSON** — no comments, no trailing commas. The deploy tooling
  parses it.
- D1 has no cheap `ALTER`: plan **expand/contract** — add nullable, backfill, switch reads,
  drop. A migration assuming a table is empty will fail in production.

Schema changes to DO SQLite need a version marker and a forward path. There is no downgrade;
plan accordingly.

---

## 4. Observability

| Signal           | Where                     | Notes                                |
| ---------------- | ------------------------- | ------------------------------------ |
| Broker decisions | `audit_log` (append-only) | Every allow/deny/escalate            |
| Record stream    | Host-local, then synced   | Source of truth for agent output     |
| Plane metrics    | Workers analytics         | Request counts, DO latency, sync lag |
| Usage counters   | `usage_counters`          | Monotonic, for cost caps             |
| Sync lag         | Derived                   | Cursor age per host                  |

### What is deliberately not instrumented

- **Model output content.** Traces carry structure, not prompts or responses. A trace system
  that stores prompts is a credential exfiltration target when prompts contain secrets.
- **Harness stderr** — forwarded for diagnosis, but redacted. Invariant I10 covers this.

### Log levels

| Level   | Contains                                                                            |
| ------- | ----------------------------------------------------------------------------------- |
| `error` | Failure + principal id + capability id. **Never** a secret or a credential path     |
| `warn`  | Denied capability, lease contention, degraded state                                 |
| `info`  | Lifecycle: session start/stop, sync, grant issue/revoke                             |
| `debug` | Structure only. **Off by default** — debug logs are where secrets historically leak |

---

## 5. Failure modes

| Failure                                              | Expected behavior                                 | Detection              |
| ---------------------------------------------------- | ------------------------------------------------- | ---------------------- |
| Host process killed                                  | k-carrier recovers or rolls back                  | Host heartbeat gap     |
| Laptop sleeps mid-turn                               | Resumes from cursor                               | Sync lag spike on wake |
| Plane unreachable                                    | Agent continues; grants cached to lease expiry    | Sync lag               |
| Grant lease expires                                  | Capability revoked; next use denies               | `capabilities.expired` |
| Cloudflare DO restart                                | DO recovers from SQLite; no state loss            | Worker errors          |
| D1 unavailable                                       | Metadata ops degrade; DO tenant data unaffected   | Worker errors          |
| R2 unavailable                                       | Artifact features fail; core messaging unaffected | Worker errors          |
| Harness upgrades, event shape changes                | Adapter contract test fails loudly                | CI                     |
| Registry expiry (unrelated; Radius uses a subdomain) | n/a                                               | n/a                    |

**The grant-lease expiry row is the one to reason about carefully.** It is a _designed_
degradation, not an outage: after the lease, a legitimately-working agent loses its capability
because it cannot prove it still should have it. That is the correct trade — fail closed — but
it must be visible in the UI, not silent.

---

## 6. Upgrade path

### The agent host

Managed by k-carrier: two slots, journaled, probe-then-commit, formally verified. We do not
reimplement or fork it.

- Patches layer **on top** as a separate crate. The vendored tree is never edited.
- `k.managed-copy-never-self-upgrades` is a first-class rule: the host is managed externally, so
  the agent never tries to self-upgrade into an unverified state.
- Never fork it (`PLAN.md` §12). Its license is Apache-2.0; ours is MIT.

### The plane

Normal Workers deploy. DO schema changes follow expand/contract. No downgrade path — decide
forward.

### Protocol

See `PROTOCOL.md` §8. A host may lag the plane by one minor, never a major. Tightening a
default (e.g. sandbox on) is a **major** change.

---

## 7. Cost model

| Cost             | Driver          | Lever                                           |
| ---------------- | --------------- | ----------------------------------------------- |
| Workers requests | Sync frequency  | Cursor batch size                               |
| DO duration      | Tenant activity | Scale-to-zero is per-tenant automatically       |
| D1 rows          | Event retention | Retention policy (undecided)                    |
| R2               | Artifacts       | Lifecycle rules                                 |
| Agent tokens     | Model usage     | `budget_tokens` / `budget_ms` per task, phase 4 |

**Usage counters are monotonic.** A counter that can decrease cannot enforce a budget, so
refunds are separate rows.

CAUTION: **Cost is a real Phase 4 risk, not a Phase 2 one.** Per-tenant DO isolation means idle tenants
cost nothing but active ones cost per-isolated-DO. A tenant with many DO shards can be
surprisingly expensive. Model this before pricing anything.

---

## 8. Security operations

- **Disclosure:** private, per `SECURITY.md`. No bounty at launch.
- **Secrets:** never in the repo, never in CI logs, never in traces.
- **Access to the plane:** operator access is a different security model from agent access. An
  operator can read tenant data by design; that is the point of self-hosting. Documented in
  `SAFETY.md` §3 as a non-guarantee.
- **Supply chain:** pin exact, `--frozen-lockfile`, review `postinstall` scripts on new deps.

---

## 9. Open questions

Tracked as decisions in `DECISIONS.md` where they change the design:

| Question                               | Blocks                              |
| -------------------------------------- | ----------------------------------- |
| Non-Cloudflare plane path?             | D-007 — DO assumptions spreading    |
| Event and audit retention              | D-009 — audit anchoring, D1 growth  |
| Grant lease default (offline)          | Phase 1 — the core safety trade-off |
| Self-hosted vs hosted support boundary | Phase 7                             |

---

## 10. What this document does not cover

Written at planning stage. Not yet addressed, deliberately:

- Runbooks per alert (needs real failure data)
- On-call rotation (needs a team)
- Backup/restore for DO SQLite (needs a real DO volume to size)
- Load testing (needs an implementation)

Inventing these now would be fiction. They get written against reality in phases 2–4.

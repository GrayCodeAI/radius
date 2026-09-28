# Security Policy

## Reporting a vulnerability

Report privately to **security@graycodeai.com**. Please do not open a public issue.

Include: what an attacker gains, reproduction steps, and affected version. We will acknowledge
within 3 business days and aim to give a remediation timeline within 10.

## Scope

In scope: the broker, the sandbox policy, tenant isolation, lease arbitration, the agent host
supervisor, and any credential-handling path.

Out of scope by design — see `SAFETY.md` §3 for the full list:

- A local attacker with code execution as the user on the host
- A compromised or trojaned harness
- The platform operator acting maliciously against their own tenants
- Denial of service by the platform operator

## What we consider a critical finding

- A raw credential reaching agent-visible context, a log, a trace, or a crash report
- Any path by which a principal obtains a capability it was not granted
- Cross-tenant data access
- An agent approving its own escalation
- Sandbox default effectively disabled without an audit record

## Bounties

**No bounty program at launch.** A safety product publishing vulnerabilities on day one has not
applied its own model to itself. Revisit once there is a public user base.

## Our commitments

- Model output content is not logged or traced. Traces carry structure only.
- Credentials never cross the plane-to-host link. The plane sends permission, not secrets.
- Every broker decision produces an immutable audit record.
- `docs/SAFETY.md` states what we do _not_ protect against, and we will not remove those
  statements to make the product look better.

# Complete OSS inventory

**All 35 `botiverse` repos, classified for Radius.** Read this before copying anything.
Sorted by license, because the license is the decision.

Verdicts used below: **vendor** (copy into `vendor/`), **depend** (install from a registry),
**conditional** (only if a specific feature is built), **no**, **blocked** (legally unusable).

---

## BLOCKING: Cannot be used — 4 repos

| Repo                                                       | License          | Why not                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`raft-source`**                                          | **FSL-1.1-ALv2** | **Competing Use clause forbids shipping a Raft-like product built on it.** Not OSI. Apache-2.0 on **2028-09-24**.                                                         |
| **`opencan`**                                              | **AGPL-3.0**     | **Strong copyleft.** Copying into an MIT product would require our entire project to be AGPL — viral. Non-negotiable.                                                     |
| **`chatgpt2api-peng`**                                     | MIT              | _Legally_ vendorable. **Reverse-engineered ChatGPT web APIs + account-pool management (`号池`)**, violates OpenAI ToS, own README bans commercial use. Reputation poison. |
| **`multica`**, **`KuiklyUI`**, **`KuiklyBase-components`** | **NOASSERTION**  | No OSI identifier. Permissible use **cannot be determined**. Treat as proprietary.                                                                                        |

CAUTION: **`opencan` was the one most likely to be missed** — it's an iOS client for the Agent Client
Protocol, which sounds perfect for a Radius mobile app. But AGPL-3.0 is viral: linking it makes
our whole project AGPL. If we ever want an ACP mobile client, we build one from the
`@agentclientprotocol/sdk` spec (MIT), not from `opencan`.

---

## Use — Apache-2.0 (12 repos)

All genuinely reusable. Sorted by relevance to Radius.

### Primary dependency

| Repo      | Verdict                  | Note                                                                                                                 |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **`oar`** | **depend** — do not fork | 5 harnesses, 58 tests, v0.6.0. Pin exact (`0.6.0`) — the highest published version. Forking loses upstream tracking. |

### Vendor verbatim

| Repo                          | Verdict         | Note                                                                                                                                                                  |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`k-carrier`**               | **vendor**      | 13 tests + Lean 4 proofs. **Never reimplement crash safety.** Never edit the vendored tree.                                                                           |
| **`raft-computer-installer`** | **read only**   | Implements k-carrier's contract for a _specific_ product. **A Raft-branded installer is a Competing Use risk** even though the license permits copying. Pattern only. |
| **`antiproton`**              | **reimplement** | 15.6k lines, **0 tests**, 3 weeks old. Take the ideas (per-tenant DO, outbox, leases, approvals), not the code.                                                       |

### Conditional

| Repo                     | Verdict                               | Note                                                                                                                                    |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **`agent-vault`**        | **read only**                         | Apache-2.0 so legal. **Dead 7 months** (v0.4.0, 439 stars). Its _idea_ is in our `SAFETY.md` G1. Reimplement the 8-line TTY principle.  |
| **`mermaid-native`**     | **no** — unrelated to agents          | Diagram rendering. Nothing to do with agents.                                                                                           |
| **`jetbrains-markdown`** | **depend** — use the Maven artifact   | Published on Maven Central. Don't vendor a 20MB fork.                                                                                   |
| **`oar-coxswain`**       | **no**                                | Electron cockpit for dogfooding oar. It's a dev tool, not a product.                                                                    |
| **`agentic-inbox`**      | conditional — if we build email       | Solid, Apache-2.0, Cloudflare-native. Not in v1 plan.                                                                                   |
| **`agentic-inbox-1`**    | **no**                                | **Verbatim duplicate of the above.** Same 29 deps, no docs, no tests, push date _predates_ its own creation. Delete candidate upstream. |
| **`agent-git-service`**  | conditional — if we build git hosting | Go, 16MB, GitHub-compatible API. A whole product on its own. Not v1.                                                                    |
| **`kimi-agent-rs`**      | **skip**                              | oar already covers Kimi. A second Kimi implementation is pure maintenance cost.                                                         |

---

## Use — MIT (9 repos)

Legally free. Mostly Raft product code we don't need.

| Repo                             | Verdict                                  | Note                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`hands`**                      | conditional — **depend** if we ship apps | Excellent — 77 migrations, BuildId fail-closed symbolication, minidump, retrace. Better than writing our own. Raft _product_ code, but MIT and no Competing Use concern since it's a release tool, not a workspace. |
| **`hands-examples`**             | conditional — if we use Hands            | CI examples. No license file (GitHub reports NONE) — **verify the MIT grant explicitly.**                                                                                                                           |
| **`cc-switch-napi`**             | optional **depend**                      | MIT, published as `@botiverse/cc-switch`. Provider/MCP/Skills config. Add when there's a need.                                                                                                                      |
| **`cc-switch-cli`**              | **no**                                   | 47MB Rust TUI. A dev tool.                                                                                                                                                                                          |
| **`musik`**                      | **read only** — best reference app       | MIT. Best example of a complete Raft app: Login, Agent Login, action manifest, D1 migrations, rate limits, audit. **Steal the shape of the L4 app architecture.**                                                   |
| **`raft-gmail`**                 | conditional — if we build email          | MIT. Deliberately read/draft-only, no send. Good scoping precedent.                                                                                                                                                 |
| **`raft-artifact-share-action`** | conditional — if we use Hands            | OIDC-based CI publishing. No license file — **verify.**                                                                                                                                                             |
| **`hermes-agent`**               | **no**                                   | MIT, but it's a **competing agent platform** (335MB). Depending on a competitor's runtime is a rewrite, not a dependency.                                                                                           |
| `chatgpt2api-peng`               | BLOCKING: **never**                      | See above.                                                                                                                                                                                                          |

---

## CAUTION: No license file — 10 repos

`raft-docs`, `desktop-beta`, `kimi-code-sdk`, `rao`, `create-raft-app`, `pi-coding-agent`,
`raft-external-agents`, `hands-examples`, `agent-screen-recorder`, `raft-survey-sample`.

**No license = all rights reserved.** Copying is legally _more_ restricted, not less.

| Repo                                           | Verdict     | Note                                                                                                                                                                            |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kimi-code-sdk`                                | **no**      | 81MB mirror of `MoonshotAI/kimi-code`. **Use the npm package or the upstream repo directly** — it exists precisely so consumers can avoid this mirror.                          |
| `pi-coding-agent`                              | **no**      | Mirror of `@earendil-works/pi-coding-agent`. **Depend on the upstream npm package.** The mirror exists for one SEA fix (Raft #6112) — if we need it, apply it as our own layer. |
| `rao`                                          | **no**      | Desktop workspace on oar. **Read it** — it's a working oar consumer and shows the session contract in use. But no license = don't copy.                                         |
| `create-raft-app`                              | **no**      | Scaffold templates. No license.                                                                                                                                                 |
| `raft-external-agents`                         | **no**      | Claude Code channel plugin. No license.                                                                                                                                         |
| `raft-docs`                                    | **no**      | VitePress docs site. We write our own.                                                                                                                                          |
| `desktop-beta`                                 | **no**      | Zero files — a README and release links.                                                                                                                                        |
| `raft-survey-sample`                           | **no**      | 90KB sample. No license.                                                                                                                                                        |
| `agent-screen-recorder`                        | **no**      | 32KB. No license.                                                                                                                                                               |
| `hands-examples`, `raft-artifact-share-action` | conditional | MIT in practice via parent repos, but **verify the grant in writing before use.**                                                                                               |

---

## Third-party OSS (non-Botiverse)

All installable, none vendored.

| Project                                              | License                | Use                                                                                   |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `@botiverse/oar`                                     | Apache-2.0             | **Primary harness abstraction**                                                       |
| `hono`, `zod`, `jose`, `turborepo`, `pnpm`, `vitest` | MIT                    | Standard stack; `graycode-platform` already mandates pnpm + turbo                     |
| `@cloudflare/agents`                                 | Apache-2.0             | DO-backed agent primitives                                                            |
| `playwright`                                         | Apache-2.0             | E2E + visual testing                                                                  |
| `wasmtime`                                           | Apache-2.0             | **WASM sandbox tier** — see `SAFETY.md` §5                                            |
| `quickjs-emscripten`                                 | MIT                    | In-process sandbox (antiproton's choice)                                              |
| `@agentclientprotocol/sdk`                           | MIT                    | ACP spec SDK — **the clean path if we want a mobile ACP client instead of `opencan`** |
| `fzf`, `zellij`                                      | MIT                    | UI niceties. CAUTION: Distraction — see below.                                        |
| `uv`                                                 | Apache-2.0             | Python pinning, if we shell out                                                       |
| `bat`, `ripgrep`                                     | Apache-2.0 / Unlicense | CLI polish                                                                            |

CAUTION: **The TUI cluster is a trap.** A beautiful terminal UI for agent fleets is a week of work,
zero adoption, and no differentiation. The wedge is unattended safety, not developer
ergonomics. Defer.

---

## Decision summary

```
COPY NOW          k-carrier (vendor) · oar (depend) · cc-switch-napi (optional)
COPY PATTERNS     antiproton · agent-vault · musik · raft-computer-installer
COPY IF BUILT     hands · agentic-inbox · agent-git-service · raft-gmail
NEVER             raft-source (FSL) · opencan (AGPL) · chatgpt2api-peng (ToS)
                  multica / Kuikly* (NOASSERTION) · anything with no LICENSE file
```

**The pattern to notice:** Botiverse's _product_ (Raft) is closed. Its _substrate_ is open.
Building on the substrate is legitimate, is most of the engineering, and is where our
differentiation lives anyway. Antiproton + oar + k-carrier ≈ the platform layer Raft sits on,
without touching Raft.

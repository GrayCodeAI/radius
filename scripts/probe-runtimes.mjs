#!/usr/bin/env node
/**
 * Probe the installed agent CLIs and emit a *measured* capability matrix.
 *
 * `ADAPTERS.md` opens with "verify, don't assume — this table will rot". This script is the
 * verification, so the table is a measurement rather than a recollection. It is not in CI: it
 * depends on which CLIs happen to be installed, so a missing runtime is reported, not failed.
 *
 * Why it matters more than a version list. Two claims this project rests on are checkable here:
 *
 *   1. **"Sessions run YOLO by default."** That is the premise of the entire product. It is
 *      checkable: if each CLI exposes a permission-bypass flag, and oar passes it, then the
 *      premise is a fact rather than a quotation from a contract file.
 *   2. **The managed-copy invariant (I15) is not specific to k-carrier.** Four of the five
 *      runtimes ship their own `update`/`upgrade` subcommand. If Radius ever installs and
 *      manages a copy of one of them — exactly the k-carrier pattern — that self-update is a
 *      second writer on a component the host believes it owns. `k.managed-copy-never-self-upgrades`
 *      therefore generalises from our installer to every managed binary, and this probe is how
 *      we notice when a new one appears.
 *
 * Run: pnpm probe:runtimes          (human-readable)
 *      pnpm probe:runtimes -- --json (machine-readable, for the matrix check)
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const AS_JSON = process.argv.includes("--json");

/** The five runtimes oar ships adapters for (`@botiverse/oar` index.d.ts). */
const RUNTIMES = ["claude", "codex", "grok", "kimi", "pi"];

/**
 * Patterns are matched against `--help` output. They are deliberately conservative: a match
 * means the CLI *documents* the capability, not that we have verified its enforcement. The
 * `documented` prefix in the field names is the honesty — a flag existing is not a sandbox
 * working, and `docs/SAFETY.md` §3 is where that distinction is recorded.
 */
const PROBES = {
  version: /^\s*(\d+\.\d+\.\d+)/m,
  nativeSandbox:
    /\b(--sandbox|-s, --sandbox|sandbox mode|workspace-write|danger-full-access)\b/i,
  permissionBypass:
    /(--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--always-approve|--yolo\b|always-approve)/i,
  sandboxNetworkNote: /no internet access/i,
  selfUpdate: /^\s+(update|upgrade)\b/m,
  workspaceDir: /(--add-dir|workspace directory|working directory)/i,
  toolAllowlist:
    /(--allowedTools|--disallowedTools|permission (allow|deny) rule|--tools\b)/i,
};

function probe(runtime) {
  let help = "";
  let installed = true;
  let version = null;
  try {
    help = execFileSync(runtime, ["--help"], {
      encoding: "utf8",
      timeout: 25_000,
    });
  } catch {
    installed = false;
  }

  if (installed) {
    try {
      version = execFileSync(runtime, ["--version"], {
        encoding: "utf8",
        timeout: 25_000,
      })
        .toString()
        .trim();
    } catch {
      version = null;
    }
  }

  const flags = Object.fromEntries(
    Object.entries(PROBES)
      .filter(([k]) => k !== "version" && k !== "selfUpdate")
      .map(([k, re]) => [k, installed && re.test(help)]),
  );

  return {
    runtime,
    installed,
    version,
    // Documented, not enforced. Nothing here proves a sandbox works.
    ...flags,
    selfUpdates: installed && PROBES.selfUpdate.test(help),
    updateCommand: help.match(/^\s+(update|upgrade)\b/m)?.[1] ?? null,
  };
}

const results = RUNTIMES.map(probe);

if (AS_JSON) {
  writeFileSync(
    join(ROOT, "docs/runtimes.probe.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(`wrote docs/runtimes.probe.json (${results.length} runtimes)`);
  process.exit(0);
}

const yesNo = (b) => (b === null ? "n/a" : b ? "YES" : "-");
const pad = (s, n) => String(s ?? "-").padEnd(n);

console.log(
  `\nRuntime capability probe — ${new Date().toISOString().slice(0, 10)}\n`,
);
console.log(
  `  ${pad("runtime", 8)}${pad("version", 26)}${pad("sandbox?", 10)}${pad("perm-bypass", 12)}self-update`,
);
console.log(`  ${"-".repeat(74)}`);
for (const r of results) {
  console.log(
    `  ${pad(r.runtime, 8)}${pad(r.version, 26)}${pad(yesNo(r.nativeSandbox), 10)}` +
      `${pad(yesNo(r.permissionBypass), 12)}${yesNo(r.selfUpdates)}${
        r.selfUpdates ? ` (${r.updateCommand})` : ""
      }`,
  );
}

const missing = results.filter((r) => !r.installed);
if (missing.length > 0) {
  console.log(
    `\n  not installed: ${missing.map((m) => m.runtime).join(", ")} — reported, not failed`,
  );
}

const selfUpdating = results.filter((r) => r.selfUpdates);
console.log(
  `\n  ${selfUpdating.length} of ${results.length} runtimes ship a self-update path. If Radius ` +
    `ever manages a copy of one, that is a SECOND WRITER on a component the host believes it ` +
    `owns — the same shape as k.managed-copy-never-self-upgrades (I15), which therefore ` +
    `generalises beyond k-carrier.`,
);
console.log(
  `\n  A documented flag is not a working sandbox. This measures what each CLI CLAIMS to support;\n` +
    `  the isolation it actually enforces is still unmeasured — see SAFETY.md §3.\n`,
);

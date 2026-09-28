#!/usr/bin/env node
/**
 * Re-runs k-carrier's Lean 4 proofs against the vendored source.
 *
 * Why this exists: the claim "machine-checked in Lean 4" is load-bearing for this project. We
 * print it in the README, and D-004 is justified by it. A claim that can only be checked by
 * trusting the sentence is not a check, so it gets a command.
 *
 * The toolchain comes from `vendor/k-carrier/lean-toolchain` — one source of truth, no version
 * duplicated here. It is the same file k-carrier pins, so this cannot drift from upstream.
 *
 * It is NOT in CI, deliberately. Pulling a Lean toolchain is a large download on every run for a
 * check that depends on a vendored file we are forbidden to edit. Run it before a re-vendor, and
 * after one, because that is the only moment the answer can change.
 *
 * Skips (exit 0) when elan is absent, with an explicit note — silently passing a check that
 * never ran is the failure mode this repo keeps punishing.
 *
 * Run: pnpm check:proofs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CRATE = join(ROOT, "vendor/k-carrier");
const MODEL = join(CRATE, "formal/Protocol.lean");
const PIN = join(CRATE, "lean-toolchain");

/** The theorems we cite in the README, PLAN.md and D-004. If one is renamed, that is a finding. */
const CITED = ["never_dual_run", "never_bricked", "write_ahead"];

if (!existsSync(MODEL) || !existsSync(PIN)) {
  console.error(
    "check:proofs FAILED — vendor/k-carrier/formal is missing. See D-004.",
  );
  process.exit(1);
}

const toolchain = readFileSync(PIN, "utf8").trim();
const source = readFileSync(MODEL, "utf8");
const problems = [];

for (const theorem of CITED) {
  // `theorem <name>` specifically: the toolchain note in the model says proofs are declared with
  // `theorem`, not `lemma`, so matching the keyword too keeps this honest rather than loose.
  if (!new RegExp(`theorem\\s+${theorem}\\b`).test(source)) {
    problems.push(
      `formal/Protocol.lean no longer proves \`${theorem}\` — a guarantee we publish is gone`,
    );
  }
}

if (problems.length > 0) {
  console.error("check:proofs FAILED\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

const hasElan =
  spawnSync("elan", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasElan) {
  console.log("check:proofs SKIPPED — elan is not installed");
  console.error(
    `  ${CITED.length} cited theorems are present in the model, but they were NOT re-checked.`,
  );
  console.error(`  Install elan and re-run: https://leanprover.github.io/elan`);
  console.error("");
  process.exit(0);
}

console.log(`check:proofs — verifying ${CITED.join(", ")} at ${toolchain}`);
const run = spawnSync(
  "elan",
  ["run", toolchain, "lean", "formal/Protocol.lean"],
  {
    cwd: CRATE,
    encoding: "utf8",
  },
);
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();

if (run.status !== 0) {
  console.error("check:proofs FAILED — the model did not verify\n");
  console.error(out || "(lean produced no output)");
  console.error("");
  process.exit(1);
}
if (out.length > 0) {
  // Lean is silent on success. Any output here is a warning we refuse to ignore, because a
  // file full of "declaration uses 'sorry'" still exits 0 and would be a silent disaster.
  console.error("check:proofs FAILED — lean exited 0 but reported problems\n");
  console.error(out);
  console.error("");
  process.exit(1);
}

console.log(
  `check:proofs OK — ${CITED.length} theorems verified at ${toolchain}`,
);
console.error("");

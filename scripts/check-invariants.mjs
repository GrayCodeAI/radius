#!/usr/bin/env node
/**
 * Asserts the safety invariants in docs/THREATS.md §6 (I1–I13).
 *
 * This is a structural placeholder, deliberately honest about it. At planning stage the
 * invariants are *specified* but not implemented, so this script verifies the specification
 * is complete and internally consistent — it cannot verify behavior that does not exist yet.
 *
 * It will become a real behavioral checker in phase 1, when packages/broker implements the
 * guards. Until then it must NOT be read as "the invariants hold" — only as
 * "the invariants are specified and mapped to a threat".
 *
 * One exception, deliberately: `ADOPTED_VENDOR_INVARIANTS` below are enforced by the vendored
 * k-carrier, whose source is vendored into this repository. Those are checked against real
 * code, not against prose, because we chose to vendor rather than depend and that choice makes
 * them inspectable. They are the only behavioural guarantees in this file today.
 *
 * Run: pnpm check:invariants   (required check; blocks merge)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const THREATS = join(ROOT, "docs/THREATS.md");
const SAFETY = join(ROOT, "docs/SAFETY.md");
const PROTOCOL = join(ROOT, "docs/PROTOCOL.md");
const DATA_MODEL = join(ROOT, "docs/DATA-MODEL.md");

/** Every doc we own. Table integrity is checked across all of them. */
const DOCS = [
  "PLAN.md",
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/ARCHITECTURE.md",
  "docs/SAFETY.md",
  "docs/PROTOCOL.md",
  "docs/DATA-MODEL.md",
  "docs/THREATS.md",
  "docs/ADAPTERS.md",
  "docs/OPERATIONS.md",
  "docs/DECISIONS.md",
  "docs/ROADMAP.md",
  "docs/MILESTONES.md",
  "docs/VENDORING.md",
  "docs/INVENTORY.md",
].map((f) => join(ROOT, f));

/** invariant id -> { threats, required claim phrase, required test phrase } */
const INVARIANTS = [
  [
    "I1",
    ["T5", "T10"],
    "no secret-shaped value in any durable field",
    "canary secret absent",
  ],
  ["I2", ["T1"], "mismatched token is rejected", "mismatched token rejected"],
  ["I3", ["T2"], "expired lease is refused", "expired lease rejected"],
  ["I4", ["T3"], "two-tenant exhaustive query", "two-tenant exhaustive query"],
  [
    "I5",
    ["T4"],
    "stale lease epoch is rejected",
    "partitioned stale epoch rejected",
  ],
  [
    "I6",
    ["T6"],
    "unknown protocol version is rejected",
    "unknown `v` rejected",
  ],
  [
    "I7",
    ["T7"],
    "absolute path, never by bare name",
    "helper never launched by bare name",
  ],
  [
    "I8",
    ["T8"],
    "measured, or not claimed in docs",
    "measured, or not claimed",
  ],
  [
    "I9",
    ["T9"],
    "resolved real path is inside the granted scope",
    "resolved path must be in scope",
  ],
  ["I10", ["T10"], "redaction at the logger", "canary absent from all output"],
  ["I11", ["T11"], "an unlisted tool is refused", "unlisted tool refused"],
  [
    "I12",
    ["T13"],
    'surfaced honestly, never as "queued"',
    "non-durable queue surfaced honestly",
  ],
  ["I13", ["T15"], "installs are locked", "`--frozen-lockfile` in CI"],
  [
    "I14",
    ["T16"],
    "monotonic time",
    "lease not extended by clock rollback, across restart",
  ],
  [
    "I15",
    ["T17"],
    "a managed copy never self-upgrades",
    "managed copy never self-upgrades",
  ],
];

/**
 * Invariants that are enforced by a *vendored* component rather than specified by us.
 *
 * This is a different kind of claim from everything in INVARIANTS above. Those are ours, and a
 * pass only says the prose is self-consistent — nothing checks them, because `packages/broker`
 * does not exist yet. The entries below are enforced in code we have vendored into this
 * repository, so the real thing can be inspected offline and asserted on.
 *
 * That is not a technicality; it is the payoff of vendoring over depending. D-004 chose to bring
 * k-carrier's source into the tree so its crash-safety could be read, trusted, and *checked*.
 * So we check it: if a future re-vendor drops an invariant, renames it, or quietly weakens the
 * condition it guards, this fails loudly instead of letting a narrowed guarantee keep shipping
 * under the same name.
 *
 * `guards` are literal fragments of the vendored source, not descriptions. They restate the
 * claim as code so that a semantic change upstream cannot pass as a cosmetic one.
 */
const ADOPTED_VENDOR_INVARIANTS = [
  {
    id: "k.managed-copy-never-self-upgrades",
    file: "vendor/k-carrier/src/invariants.rs",
    guards: [
      "ManagedElsewhere",
      "Phase::Idle",
      "externally managed installation entered a transaction",
    ],
  },
];

/** Invariant ids above that are satisfied by the vendored check rather than by prose. */
const VENDORED_INVARIANT_IDS = new Set(["I15"]);

const problems = [];
const notes = [];

function read(path) {
  if (!existsSync(path)) {
    problems.push(
      `${path.replace(ROOT, "")} is missing — cannot verify the spec`,
    );
    return "";
  }
  return readFileSync(path, "utf8");
}

const threatsDoc = read(THREATS);
const safety = read(SAFETY);
// PROTOCOL and DATA_MODEL are deliberately NOT read here. They are read inside the CLAIMS loop
// below, which both checks them and reports them, so an eager read would only duplicate the
// "file is missing" problem if either were ever removed.

// 1. Every invariant must exist, name its threats, state its claim, and name its test.
for (const [invariant, threats, claim, test] of INVARIANTS) {
  if (!threats.some((t) => threatsDoc.includes(t))) {
    problems.push(
      `THREATS.md does not reference the threats for ${invariant} (${threats.join(", ")})`,
    );
  }
  if (!threatsDoc.includes(claim)) {
    problems.push(
      `THREATS.md §6 is missing the ${invariant} claim: "${claim}"`,
    );
  }
  if (!threatsDoc.includes(test)) {
    problems.push(`THREATS.md §6 is missing the ${invariant} test: "${test}"`);
  }
}

// 1b. The threats we said are covered must actually appear in the body of the document.
for (const t of [
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "T8",
  "T9",
  "T10",
  "T11",
  "T12",
  "T13",
  "T15",
  "T16",
  "T17",
]) {
  if (!threatsDoc.includes(`### ${t} `)) {
    problems.push(
      `THREATS.md has no section for ${t}, but the coverage table references it`,
    );
  }
}

// 2. Cross-document consistency on the load-bearing claims. These are the claims we would
//    be most embarrassed to contradict in public.
const CLAIMS = [
  {
    file: SAFETY,
    name: "SAFETY.md",
    must: [
      ["G1", "never holds a raw credential"],
      ["G2", "default"],
      ["G4", "physically"],
      ["G5", "revoc"],
    ],
  },
  {
    file: PROTOCOL,
    name: "PROTOCOL.md",
    must: [
      ["exactly-once", "approvals"],
      ["durable", "queue"],
      ["major", "default"],
    ],
  },
  {
    file: DATA_MODEL,
    name: "DATA-MODEL.md",
    must: [
      ["epoch", "fencing"],
      ["request_id", "idempoten"],
      ["decided_by", "human"],
    ],
  },
];

for (const { file, name, must } of CLAIMS) {
  const text = read(file);
  for (const [a, b] of must) {
    if (!new RegExp(a, "i").test(text) || !new RegExp(b, "i").test(text)) {
      problems.push(
        `${name} no longer states the "${a}" / "${b}" claim — was it dropped?`,
      );
    }
  }
}

// 3. The non-guarantees must survive. A safety doc that only lists wins is marketing.
const NON_GUARANTEES = [
  "Local attacker",
  "malicious harness",
  "injection",
  "exactly-once",
  // Added with RecordWriter (phase 0). CONTRIBUTING requires an unsolved problem to be stated
  // here "rather than shipping it silently", and a non-guarantee nobody checks is a
  // non-guarantee that quietly disappears. oar's observer has no backpressure channel, so
  // this one is load-bearing for the unattended-overnight claim, not decoration.
  "runaway producer",
];
for (const ng of NON_GUARANTEES) {
  if (!new RegExp(ng, "i").test(safety)) {
    problems.push(`SAFETY.md §3 no longer states the non-guarantee "${ng}"`);
  }
}

/**
 * Extracts a single `Invariant { ... }` entry from vendored Rust source, by its id.
 *
 * This function exists because mutation testing caught the obvious implementation twice, and
 * both failures are worth recording — they are the reason the bounds are what they are:
 *
 *   1. Checking `invariants.rs` as one flat string is not sufficient. `Phase::Idle` also appears
 *      inside *other* invariants, so weakening this entry's guard from `Phase::Idle` to
 *      `Phase::Promoted` left the token present and a file-wide `includes()` passed happily,
 *      while the guarantee had been quietly narrowed.
 *   2. Slicing to the next `id: "` alone is not sufficient either, because this invariant is the
 *      last entry in the array — so the slice ran to end of file and swallowed the unrelated
 *      `terminal()` helper below it, which also mentions `Phase::Idle`.
 *
 * So the slice ends at whichever comes first: the next invariant, or the end of the
 * `BUILT_IN_INVARIANTS` array. A claim about one entry is checked inside that entry only.
 */
function extractInvariantBlock(src, id) {
  const start = src.indexOf(`id: "${id}"`);
  if (start === -1) {
    return null;
  }
  const nextId = src.indexOf('id: "', start + 1);
  const arrayEnd = src.indexOf("];", start + 1);
  const bounds = [nextId, arrayEnd].filter((i) => i !== -1);
  return src.slice(start, bounds.length > 0 ? Math.min(...bounds) : undefined);
}

// 4. Adopted vendor invariants. Everything above compares prose to prose. This is the one place
//    we can compare a claim to executable code, because the code is in this repository.
//
//    Read this as: "we vendored it, therefore we can check it". If the vendor tree is ever
//    replaced and the invariant is gone, renamed, or no longer guards the same condition, that
//    is a changed guarantee and must be a loud failure rather than a silent downgrade.
for (const inv of ADOPTED_VENDOR_INVARIANTS) {
  const src = read(join(ROOT, inv.file));
  if (!src) {
    // read() has already recorded the missing-file problem.
    continue;
  }
  const block = extractInvariantBlock(src, inv.id);
  if (block === null) {
    problems.push(
      `vendored invariant ${inv.id} is no longer declared in ${inv.file}. Either the component ` +
        `was re-vendored at a different version, or the invariant was dropped. Re-derive our ` +
        `claim before accepting this — do not just delete the entry.`,
    );
    continue;
  }
  for (const guard of inv.guards) {
    if (!block.includes(guard)) {
      problems.push(
        `${inv.file} — the entry for ${inv.id} no longer contains "${guard}". The condition it ` +
          `guards has changed, so the claim recorded in THREATS.md §6 is no longer verified.`,
      );
    }
  }
}

// 5. Honest note about implementation status. The two kinds must not be conflated: saying
//    "nothing is enforced" would be false now, and saying "everything is enforced" would be
//    worse. Report the split.
const brokerSrc = join(ROOT, "packages/broker/src");
let radiusEnforced = false;
if (existsSync(brokerSrc)) {
  radiusEnforced = readdirSync(brokerSrc).some((f) => f.endsWith(".ts"));
}
const specCount = INVARIANTS.filter(
  ([id]) => !VENDORED_INVARIANT_IDS.has(id),
).length;
if (!radiusEnforced) {
  notes.push(
    `${specCount} of ${INVARIANTS.length} invariants (I1–I${specCount}) are SPECIFIED only — ` +
      `packages/broker does not exist.\n` +
      `        They are not enforced in code. Do not read a pass as a guarantee.\n` +
      `        ${ADOPTED_VENDOR_INVARIANTS.length} (${[...VENDORED_INVARIANT_IDS].join(", ")}) ` +
      `IS checked against real vendored source.`,
  );
}

// 6. Guard against the script itself becoming a rubber stamp. If the guard list is empty,
//    the check is meaningless and should fail loudly rather than pass.
if (INVARIANTS.length === 0) {
  problems.push(
    "INVARIANTS list is empty — the checker has no guard and would pass vacuously",
  );
}
// Same for the vendored half: an empty adoption list would silently stop checking anything.
if (ADOPTED_VENDOR_INVARIANTS.length === 0) {
  problems.push(
    "ADOPTED_VENDOR_INVARIANTS is empty — the vendored-source check would pass vacuously",
  );
}

// 7. Markdown table integrity. An escaped pipe (\|) inside a cell is a literal pipe and does
//    not add a column; a real mismatch means a row was mangled, which is how the emoji-removal
//    pass silently merged rows in DATA-MODEL.md.
for (const doc of [THREATS, SAFETY, PROTOCOL, DATA_MODEL, ...DOCS]) {
  if (!existsSync(doc)) continue;
  const lines = readFileSync(doc, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("|") || i + 1 >= lines.length) continue;
    if (!/^\|[\s\-:|]+\|$/.test(lines[i + 1])) continue;
    const expected = countColumns(lines[i]);
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
      const got = countColumns(lines[j]);
      if (got !== expected) {
        problems.push(
          `${doc.replace(ROOT, "")}:${j + 1} table row has ${got} columns, expected ${expected} — ` +
            `a row was likely merged or split`,
        );
      }
    }
  }
}

/** Counts table columns, ignoring escaped pipes (\|) which are literal cell content. */
function countColumns(line) {
  return (line.replace(/\\\|/g, "\u0000").match(/\|/g) ?? []).length;
}

if (problems.length > 0) {
  console.error("check:invariants FAILED\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

// The summary distinguishes the two kinds, because collapsing them into a single count is how a
// reader ends up believing 15 things are enforced when 1 is.
console.log(
  `check:invariants OK — ${INVARIANTS.length} invariants mapped ` +
    `(${specCount} specified, ${ADOPTED_VENDOR_INVARIANTS.length} verified against vendored source)`,
);
for (const n of notes) console.error(`\n  note: ${n}`);
console.error("");

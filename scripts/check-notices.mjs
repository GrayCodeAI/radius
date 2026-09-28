#!/usr/bin/env node
/**
 * Verifies vendored third-party license integrity.
 *
 * A vendored component's LICENSE and NOTICE must exist and be unmodified.
 * Apache-2.0 §4 requires retention; our MIT project has no NOTICE of its own to hide behind,
 * so this is the mechanism that keeps the obligation visible.
 *
 * Run: pnpm check:notices   (part of CI; blocks merge)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.NC_ROOT ?? new URL("..", import.meta.url).pathname;
const VENDOR = join(ROOT, "vendor");
const NOTICES = join(ROOT, "THIRD_PARTY_NOTICES.md");

/** Every vendored component, with the files it must retain. */
const REQUIRED = {
  "k-carrier": {
    license: "LICENSE",
    notice: "NOTICE",
    // Files we must not have edited.
    immutable: ["LICENSE", "NOTICE", "formal/Protocol.lean"],
    /**
     * Target source files the manifest declares that are deliberately NOT vendored.
     *
     * Found 2026-09-28 by building the tree: `Cargo.toml` declares six `[[bin]]`/`[[example]]`
     * targets, and the whole `examples/` directory is absent. So `cargo build` fails even
     * though `cargo build --lib` succeeds in ~11s. The library — the thing we actually depend
     * on — is complete; the harness examples were trimmed.
     *
     * These are recorded rather than silently tolerated, because "the vendored tree does not
     * match its own manifest" is exactly the defect a future re-vendor would reintroduce
     * without anyone noticing. A *new* missing target fails this check; only this list passes.
     */
    knownAbsentTargets: [
      {
        path: "examples/native-controller.rs",
        reason: "example harness, not needed to depend on the lib",
      },
      { path: "examples/native-service.rs", reason: "example harness" },
      { path: "examples/native-swap.rs", reason: "example harness" },
      { path: "examples/musl-quarantine-probe.rs", reason: "example harness" },
      { path: "examples/native-installer.rs", reason: "example harness" },
    ],
  },
};

/**
 * Parses `[[bin]]` / `[[example]]` target paths out of a Cargo manifest.
 * Small and deliberately literal: it reads `path = "..."` under those two tables and nothing
 * else. Cargo's full grammar is not our problem; the question is only "does the vendored tree
 * contain the sources its own manifest points at".
 */
function declaredTargetPaths(manifest) {
  const paths = [];
  const table = /\[\[(bin|example)\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g;
  let match;
  while ((match = table.exec(manifest)) !== null) {
    const path = /path\s*=\s*"([^"]+)"/.exec(match[2]);
    if (path) paths.push(path[1]);
  }
  return paths;
}

const problems = [];
const pending = [];
/** Declared Cargo targets deliberately not vendored. Reported, never silently tolerated. */
const absent = [];

// 1. The notices file must exist and mention every vendored component.
if (!existsSync(NOTICES)) {
  problems.push(
    "THIRD_PARTY_NOTICES.md is missing — third-party attribution is an obligation",
  );
} else {
  const text = readFileSync(NOTICES, "utf8");
  for (const name of Object.keys(REQUIRED)) {
    if (!text.includes(name)) {
      problems.push(`THIRD_PARTY_NOTICES.md does not attribute "${name}"`);
    }
  }
}

// 2. The vendor directory must exist.
if (!existsSync(VENDOR)) {
  problems.push("vendor/ directory is missing");
} else {
  const present = readdirSync(VENDOR).filter((e) =>
    statSync(join(VENDOR, e)).isDirectory(),
  );

  for (const [name, spec] of Object.entries(REQUIRED)) {
    const dir = join(VENDOR, name);
    // "Declared but not populated" = a directory containing only our own README, which is
    // the pre-milestone-0.2 state. Once any upstream file lands, the full license check applies.
    const entries = readdirSync(dir);
    const populated = entries.some((f) => f !== "README.md");
    if (!populated) {
      pending.push(name);
      continue;
    }

    for (const key of ["license", "notice"]) {
      const file = join(dir, spec[key]);
      if (!existsSync(file)) {
        problems.push(
          `vendor/${name} is populated but ${spec[key]} is missing. ` +
            `Apache-2.0 §4 requires it, and an MIT project has no NOTICE of its own to hide behind.`,
        );
      }
    }

    // 3. Nothing vendored may be edited. We cannot diff against upstream offline, so we
    //    check for the marker that a patch was applied in place rather than layered on top.
    for (const file of spec.immutable ?? []) {
      const p = join(dir, file);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      if (text.includes("GRAYCODE-PATCHED")) {
        problems.push(
          `vendor/${name}/${file} is marked as patched in place. ` +
            `Never edit the vendored tree — layer the diff on top and document it.`,
        );
      }
    }

    // 4. The tree must match its own manifest. Found 2026-09-28 by actually building it:
    //    k-carrier's Cargo.toml declares six targets and the whole examples/ directory was
    //    never vendored, so `cargo build` fails while `cargo build --lib` succeeds. Nothing
    //    in the license check could see that, and D-004's answer depends on it.
    const manifest = join(dir, "Cargo.toml");
    if (existsSync(manifest)) {
      const allowed = new Map(
        (spec.knownAbsentTargets ?? []).map((t) => [t.path, t.reason]),
      );
      for (const target of declaredTargetPaths(
        readFileSync(manifest, "utf8"),
      )) {
        if (existsSync(join(dir, target))) continue;
        if (allowed.has(target)) {
          absent.push({
            component: name,
            path: target,
            reason: allowed.get(target),
          });
          continue;
        }
        problems.push(
          `vendor/${name}/${target} is declared in Cargo.toml but absent from the tree, and it ` +
            `is not recorded in knownAbsentTargets. Either vendor it, or record why not — a ` +
            `re-vendor that silently drops a target should fail the build.`,
        );
      }
    }
  }

  for (const name of present) {
    if (!(name in REQUIRED)) {
      problems.push(
        `vendor/${name} is not in THIRD_PARTY_NOTICES.md or the REQUIRED table — ` +
          `an undeclared vendored component is a license-review problem`,
      );
    }
  }
}

// 4. Our own license must be present and MIT.
const ourLicense = join(ROOT, "LICENSE");
if (!existsSync(ourLicense)) {
  problems.push("LICENSE is missing");
} else if (!/MIT License/i.test(readFileSync(ourLicense, "utf8"))) {
  problems.push(
    "LICENSE does not appear to be MIT — this project is MIT (D-002)",
  );
}

if (problems.length > 0) {
  console.error("check:notices FAILED\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  "check:notices OK — vendored licenses intact, attributions complete",
);
for (const n of pending) {
  console.error(
    `  pending  vendor/${n} is declared but not populated yet (milestone 0.2).`,
  );
  console.error(
    `           Its LICENSE/NOTICE check applies as soon as it lands.`,
  );
}
if (absent.length > 0) {
  console.error(
    `  note     ${absent.length} Cargo target(s) declared in a manifest are deliberately not\n` +
      `           vendored. The LIBRARY is complete, so a path dependency builds — but a bare\n` +
      `           \`cargo build\` of this tree will NOT. Recorded in knownAbsentTargets.`,
  );
  for (const a of absent) {
    console.error(
      `             - vendor/${a.component}/${a.path} — ${a.reason}`,
    );
  }
}
console.error("");

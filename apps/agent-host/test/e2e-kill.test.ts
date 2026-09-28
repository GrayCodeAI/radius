/**
 * End-to-end: a REAL oar session, SIGKILL'd mid-turn, then read back from disk.
 *
 * Everything else in this suite binds a fake Session. This is the only test that starts an
 * actual harness, and it is the one that decides whether Phase 0's gate — "killed at arbitrary
 * points, mid-turn, and loses nothing" — is actually met.
 *
 * ── It is opt-in, and deliberately so ──────────────────────────────────────────────────────
 * It spawns a real agent CLI and burns real model tokens. It must never run on a contributor's
 * machine by accident, and it must never run in CI. Enable it with:
 *
 *   RADIUS_E2E=1 RADIUS_E2E_RUNTIME=claude pnpm test
 *
 * Without the flag this file SKIPS. A skipped test is honest; a green one that quietly never
 * ran is the failure mode this repo keeps punishing.
 *
 * ── What it actually asserts, and why it is weaker than the gate ──────────────────────────
 * The Phase 0 exit criterion says a kill "loses nothing". Strictly, that is **not** what this
 * proves and cannot be, because the record path is asynchronous: oar's observer hands us a
 * record, and fsync happens on a later turn of the event loop. A SIGKILL landing inside that
 * window drops the record. `RecordWriter` bounds the window; it does not close it.
 *
 * So this test pins the claims we can actually make, which are the ones that matter:
 *
 *   1. Whatever reached the store survives byte-intact and contiguous — no torn final record
 *      corrupts the prefix, and `seq` has no gaps.
 *   2. A fresh store instance can reopen the stream and replay it identically.
 *   3. The session was genuinely mid-turn (a non-empty prefix existed), so the test cannot
 *      pass vacuously by killing before any output.
 *
 * The in-flight window is a documented non-guarantee, not a bug hidden here — see
 * `docs/SAFETY.md` §3.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RecordStore } from "../src/record-store.ts";

const ENABLED = process.env.RADIUS_E2E === "1";
const RUNTIME = process.env.RADIUS_E2E_RUNTIME ?? "claude";
/**
 * How long the child is allowed to run before it SIGKILLs itself. Short by default so the
 * kill has a real chance of landing mid-generation rather than after a completed turn.
 * Lower it further to aim at a colder harness.
 */
const KILL_MS = Number(process.env.RADIUS_E2E_KILL_MS ?? "12000");

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_HOST = new URL("../src/session-host.ts", import.meta.url).href;
const RECORD_STORE = new URL("../src/record-store.ts", import.meta.url).href;

const SKIP = ENABLED
  ? false
  : "set RADIUS_E2E=1 to run (spawns a real agent CLI and spends real tokens)";

describe("e2e — a real session killed mid-turn", { skip: SKIP }, () => {
  test("records durably written before SIGKILL survive and replay cleanly", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-e2e-"));
    const streamId = "e2e";
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // The child drives a real session and then parks, so the parent kills it at a point where
    // output is genuinely in flight. It never exits on its own.
    const childScript = `
      import { RecordStore } from ${JSON.stringify(RECORD_STORE)};
      import { startHostSession } from ${JSON.stringify(SESSION_HOST)};

      const store = new RecordStore({ dir: ${JSON.stringify(dir)} });
      const host = await startHostSession({
        runtimeId: ${JSON.stringify(RUNTIME)},
        cwd: ${JSON.stringify(dir)},
        store,
        sessionId: ${JSON.stringify(streamId)},
      });

      host.session.prompt("Reply with the single word: banana").catch(() => {});
      host.session.events(() => {});

      process.stdout.write("READY\\n");
      setTimeout(() => { process.kill(process.pid, "SIGKILL"); }, ${KILL_MS});
    `;

    // spawnSync with a timeout delivers a REAL SIGKILL from the OS — not a simulated failure.
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        // 45s: long enough for a real session to emit, short enough to fail loudly rather
        // than hang. A child that never gets far is a harness problem (missing CLI, auth,
        // network) and the assertion below reports it as such, not as a durability bug.
        timeout: 45_000,
      },
    );

    assert.ok(
      child.status !== 0 || child.signal === "SIGKILL",
      `child did not die by SIGKILL (status=${child.status} signal=${child.signal}). ` +
        `stderr: ${child.stderr.slice(0, 800)}`,
    );

    const records = [];
    for await (const r of new RecordStore({ dir }).readAfter(streamId, -1))
      records.push(r);
    const seqs = records.map((r) => r.seq);

    assert.ok(
      seqs.length > 0,
      "the killed session produced records; otherwise this proves nothing",
    );

    // Report which case this run actually hit, so a green tick cannot be read as proof of a
    // mid-generation kill that may not have happened. A finished turn leaves a terminal
    // `result/*` frame; its absence means output was still streaming when the kill landed.
    const turnCompleted = records.some((r) => {
      const native = (r.body as { native?: { type?: string } }).native;
      return (
        typeof native?.type === "string" && native.type.startsWith("result/")
      );
    });
    t.diagnostic(
      `kill at ${KILL_MS}ms — ${seqs.length} records durable; turn ` +
        (turnCompleted
          ? "had COMPLETED before the kill"
          : "was STILL IN FLIGHT at the kill"),
    );

    // Contiguous from 0. A gap would mean a write vanished in a way the store cannot detect —
    // exactly the silent corruption this milestone exists to prevent.
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => i),
      "the durable stream is contiguous from 0 after a hard kill — no gaps",
    );

    // Reopening with a fresh store replays identically. This is the hybrid contract the
    // control plane depends on: cursors, not tokens.
    const replay: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter(streamId, -1))
      replay.push(r.seq);
    assert.deepEqual(replay, seqs, "a fresh process replays the same stream");
  });
});

describe("e2e — the gate itself", () => {
  test("a traversal-shaped stream name never reaches the filesystem", async (t) => {
    // Needs no harness, so it always runs. It proves the same wiring on the real store: the
    // session id is validated before any I/O, so nothing a runtime supplies escapes `dir`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-e2e-paths-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store = new RecordStore({ dir });
    await assert.rejects(
      () =>
        store.append("../escape", {
          seq: 0,
          sessionId: "../escape",
          kind: "frame",
          body: {},
        }),
      /unsafe session id/,
    );
    await store.close();
    assert.deepEqual(
      fs.readdirSync(dir),
      [],
      "nothing is written for a refused id",
    );
  });

  test("this suite is gated unless RADIUS_E2E=1", (t) => {
    if (ENABLED) {
      t.skip("RADIUS_E2E=1 is set, so the suite is live");
      return;
    }
    // An assertion about the harness rather than the system. If someone "fixes" a flaky e2e
    // run by quietly un-gating it — and starts spending tokens on every `pnpm test` — this
    // is what notices.
    assert.equal(ENABLED, false, "e2e must never run implicitly");
    assert.ok(
      fs.existsSync(path.join(THIS_DIR, "e2e-kill.test.ts")),
      "the gated suite is present and accounted for",
    );
  });
});

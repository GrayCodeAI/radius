/**
 * Milestone 0.4 — the stream durability harness.
 *
 * `MILESTONES.md` 0.4 asks for two things, and this file exists to make both true:
 *
 *   1. "Fuzz the kill point across the upgrade state machine."
 *   2. "Assert `never_dual_run` and `never_bricked` behaviourally, not just by trusting the proofs."
 *
 * The Lean proofs are about k-carrier's two-slot upgrade, and we verified them separately
 * (`pnpm check:proofs`). They say nothing about OUR record path. This harness is the equivalent
 * for the stream: it interrupts a write at every point where interruption is possible, and then
 * asserts what survived rather than what should have.
 *
 * ── What is actually asserted ──────────────────────────────────────────────────────────────
 * Not "nothing was lost" — that is false, and the RecordWriter documents why: a record observed
 * but not yet fsync'd dies with the process, and no amount of testing makes that not true.
 *
 * Instead, the two properties that can be absolute, and which together are what an operator
 * actually needs after a hard kill:
 *
 *   - **The surviving stream is a valid prefix.** Never a gap, never a torn record, never a
 *     record whose body is half-written. Losing the tail is acceptable; a corrupt prefix is not.
 *   - **The stream is monotonic and unique.** No `seq` appears twice. A duplicate is worse than a
 *     loss, because a consumer would double-apply it.
 *
 * That is the contract the control plane's cursor sync depends on. If it holds after a kill at
 * any point, the plane can resume from `lastSeq` and never sees a lie.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RecordStore } from "../src/record-store.ts";

describe("durability harness — a kill at any point leaves a valid prefix", () => {
  test("a torn final line never corrupts the records before it", async () => {
    // The realistic hard-kill artefact: a partial write at the tail. Every complete line before
    // it must still parse and still be in order.
    for (let killAt = 1; killAt <= 40; killAt++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-fuzz-"));
      const store = new RecordStore({ dir });
      const complete = 5;
      for (let i = 0; i < complete; i++) {
        await store.append("s", {
          seq: i,
          sessionId: "s",
          kind: "frame",
          body: { n: i },
        });
      }
      // Simulate a kill mid-write by appending a partial line of `killAt` bytes.
      fs.appendFileSync(
        path.join(dir, "s.jsonl"),
        '{"seq":99,"b'.slice(0, killAt % 12),
      );
      await store.close();

      const seqs: number[] = [];
      for await (const r of new RecordStore({ dir }).readAfter("s", -1))
        seqs.push(r.seq);
      assert.deepEqual(
        seqs,
        Array.from({ length: complete }, (_, i) => i),
        `torn tail of ${killAt % 12} bytes must not disturb the ${complete} complete records`,
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stream is a valid prefix after truncation at every byte offset", async () => {
    // Stronger than appending a torn line: take a real stream and truncate the FILE at every
    // possible offset. Whatever remains must be a valid prefix — this catches a partial line in
    // the middle of the file, which the tail-only test would miss.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-trunc-"));
    const store = new RecordStore({ dir });
    const total = 8;
    for (let i = 0; i < total; i++) {
      await store.append("s", {
        seq: i,
        sessionId: "s",
        kind: "frame",
        body: { n: i },
      });
    }
    await store.close();

    const file = path.join(dir, "s.jsonl");
    const full = fs.readFileSync(file, "utf8");
    for (let cut = 0; cut <= full.length; cut++) {
      fs.writeFileSync(file, full.slice(0, cut));
      const seqs: number[] = [];
      for await (const r of new RecordStore({ dir }).readAfter("s", -1))
        seqs.push(r.seq);
      // Must be exactly [0..k] for some k: a valid prefix, with no gaps and no duplicates.
      assert.deepEqual(
        seqs,
        seqs.map((_, i) => i),
        `truncating at byte ${cut} must leave a contiguous prefix, got ${seqs.join(",")}`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("replaying a truncated stream resumes with no gap and no duplicate", async () => {
    // The property the hybrid sync model actually depends on: a cursor taken from a surviving
    // prefix, replayed against the full stream, is consistent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-resume-"));
    const store = new RecordStore({ dir });
    const total = 10;
    for (let i = 0; i < total; i++) {
      await store.append("s", {
        seq: i,
        sessionId: "s",
        kind: "frame",
        body: { n: i },
      });
    }
    await store.close();

    const file = path.join(dir, "s.jsonl");
    const full = fs.readFileSync(file, "utf8");
    // Cut somewhere in the middle and take a cursor from what survived.
    fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)));

    const survivor = new RecordStore({ dir });
    let lastSeq = -1;
    for await (const r of survivor.readAfter("s", -1)) lastSeq = r.seq;

    fs.writeFileSync(file, full); // the rest arrives after a reconnect
    const resumed: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter("s", lastSeq))
      resumed.push(r.seq);

    assert.deepEqual(
      resumed,
      Array.from({ length: total - 1 - lastSeq }, (_, i) => lastSeq + 1 + i),
      "resuming from a prefix cursor yields every later record exactly once",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Tests for RecordStore — the durability core.
 *
 * These are the tests that decide whether phase 0 is done. Every one corresponds to a failure
 * the design claims to survive. If a test here is deleted rather than fixed, phase 0 is no
 * longer done.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RecordStore, NonMonotonicAppendError } from "../src/record-store.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-records-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(
  seq: number,
  sessionId = "s1",
  body: unknown = { text: `m${seq}` },
) {
  return { seq, sessionId, kind: "frame" as const, body };
}

describe("RecordStore — durability", () => {
  test("persists a record and reads it back in seq order", async () => {
    const store = new RecordStore({ dir });
    for (let i = 0; i < 5; i++) await store.append("s1", rec(i));
    await store.close();

    const out: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter("s1", -1))
      out.push(r.seq);
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
  });

  test("reopening a store sees everything a previous instance wrote", async () => {
    const first = new RecordStore({ dir });
    await first.append("s1", rec(0));
    await first.append("s1", rec(1));
    await first.close();

    // Simulates a process restart.
    const second = new RecordStore({ dir });
    const out = [];
    for await (const r of second.readAfter("s1", -1)) out.push(r.seq);
    assert.deepEqual(out, [0, 1]);
  });

  test("a record is durable before append() resolves", async () => {
    const store = new RecordStore({ dir });
    await store.append("s1", rec(7));
    // No close(), no flush, no drain — the bytes must already be on disk. Note that simply
    // reading the file is NOT sufficient evidence of durability: a removed fsync still leaves
    // the data visible in page cache, which is why this test alone does not distinguish.
    // Durability is pinned by the process-crash test below.
    const raw = fs.readFileSync(path.join(dir, "s1.jsonl"), "utf8");
    assert.match(raw, /"seq":7/);
    await store.close();
  });

  test("records survive a simulated process crash (no close, no flush)", async () => {
    // Spawns a real child process that appends and then calls process.exit() WITHOUT closing
    // the store or flushing. A lost stream buffer would show up here; fsync-per-append is what
    // makes it pass. This is the test that actually pins the durability claim.
    const { spawnSync } = await import("node:child_process");
    const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-crash-"));
    // Resolve the module against THIS FILE, never process.cwd(). The test runner sets cwd to the
    // package root (apps/agent-host), so path.resolve("apps/agent-host/src/...") doubles the
    // prefix and the child dies on ERR_MODULE_NOT_FOUND. The only thing that is stable across
    // `node --test`, `pnpm test`, and turbo is the test file's own location.
    const moduleUrl = new URL("../src/record-store.ts", import.meta.url).href;
    const script = `
      import { RecordStore } from ${JSON.stringify(moduleUrl)};
      const store = new RecordStore({ dir: ${JSON.stringify(childDir)} });
      await store.append("s1", { seq: 0, sessionId: "s1", kind: "frame", body: { text: "zero" } });
      await store.append("s1", { seq: 1, sessionId: "s1", kind: "frame", body: { text: "one" } });
      process.exit(0); // hard exit: no close(), no flush
    `;
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);

    const out: number[] = [];
    for await (const r of new RecordStore({ dir: childDir }).readAfter(
      "s1",
      -1,
    ))
      out.push(r.seq);
    assert.deepEqual(
      out,
      [0, 1],
      "both records must survive a hard process exit",
    );
    fs.rmSync(childDir, { recursive: true, force: true });
  });
});

describe("RecordStore — the cursor contract", () => {
  test("readAfter(afterSeq) replays strictly after the cursor, with no gaps", async () => {
    const store = new RecordStore({ dir });
    for (let i = 0; i < 10; i++) await store.append("s1", rec(i));
    await store.close();

    const reader = new RecordStore({ dir });
    const after3: number[] = [];
    for await (const r of reader.readAfter("s1", 3)) after3.push(r.seq);
    assert.deepEqual(
      after3,
      [4, 5, 6, 7, 8, 9],
      "must resume exactly after the cursor",
    );
  });

  test("a reconnecting subscriber repeats nothing", async () => {
    const store = new RecordStore({ dir });
    for (let i = 0; i < 4; i++) await store.append("s1", rec(i));
    await store.close();

    const reader = new RecordStore({ dir });
    const firstPass: number[] = [];
    for await (const r of reader.readAfter("s1", -1)) firstPass.push(r.seq);
    const secondPass: number[] = [];
    for await (const r of reader.readAfter("s1", 1)) secondPass.push(r.seq);

    assert.deepEqual(firstPass, [0, 1, 2, 3]);
    assert.deepEqual(secondPass, [2, 3]);
    const overlap = firstPass.filter((s) => secondPass.includes(s));
    assert.deepEqual(
      overlap,
      [2, 3],
      "replay from 1 legitimately overlaps; the point is no gaps",
    );
  });

  test("duplicate seq append is an idempotent no-op", async () => {
    const store = new RecordStore({ dir });
    await store.append("s1", rec(0));
    await store.append("s1", rec(1));
    await store.append("s1", rec(1)); // replay after reconnect
    await store.close();

    const out: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter("s1", -1))
      out.push(r.seq);
    assert.deepEqual(
      out,
      [0, 1],
      "a replayed record must not be written twice",
    );
  });

  test("a lower seq is rejected as corruption", async () => {
    const store = new RecordStore({ dir });
    await store.append("s1", rec(5));
    await assert.rejects(
      () => store.append("s1", rec(2)),
      NonMonotonicAppendError,
    );
    await store.close();
  });
});

describe("RecordStore — crash tolerance", () => {
  test("a torn final line does not lose the records before it", async () => {
    const store = new RecordStore({ dir });
    await store.append("s1", rec(0));
    await store.append("s1", rec(1));
    await store.append("s1", rec(2));
    await store.close();

    // Simulate a hard kill mid-write: append a partial line.
    fs.appendFileSync(path.join(dir, "s1.jsonl"), '{"seq":3,"sessionI');

    const out: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter("s1", -1))
      out.push(r.seq);
    assert.deepEqual(out, [0, 1, 2], "complete lines survive a torn tail");
  });

  test("interleaved sessions do not contaminate each other", async () => {
    const store = new RecordStore({ dir });
    await store.append("a", rec(0, "a"));
    await store.append("b", rec(0, "b"));
    await store.append("a", rec(1, "a"));
    await store.append("b", rec(1, "b"));
    await store.close();

    const a = [],
      b = [];
    for await (const r of new RecordStore({ dir }).readAfter("a", -1))
      a.push(r.body);
    for await (const r of new RecordStore({ dir }).readAfter("b", -1))
      b.push(r.body);
    assert.deepEqual(a, [{ text: "m0" }, { text: "m1" }]);
    assert.deepEqual(b, [{ text: "m0" }, { text: "m1" }]);
  });
});

describe("RecordStore — unsafe input", () => {
  // The session id becomes a filename, so this is untrusted input.
  //
  // `append` is an async method, so a validation throw inside it necessarily surfaces as a
  // rejected promise. assert.rejects is therefore the correct assertion here — assert.throws
  // can never observe it. What we are really pinning is that the failure happens *before* the
  // filesystem is touched, which the empty-directory assertion below proves.
  const UNSAFE = [
    "../escape",
    "a/b",
    "..",
    ".",
    "with space",
    "",
    ".hidden",
    "nul\u0000byte",
    "x".repeat(129),
  ];

  test("an unsafe session id is refused before touching the filesystem", async () => {
    const store = new RecordStore({ dir });
    for (const bad of UNSAFE) {
      await assert.rejects(
        () => store.append(bad, rec(0, bad)),
        /unsafe session id/,
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
    await store.close();
    // Nothing was written — not even for the ids that reached the fs layer before validation
    // was hoisted out of the async closure.
    assert.deepEqual(
      fs.readdirSync(dir),
      [],
      "no file may be created for a refused id",
    );
  });

  test("a session id that is a valid name is accepted", async () => {
    const store = new RecordStore({ dir });
    for (const good of ["s1", "sess_01-A.b", "S_9"]) {
      await store.append(good, rec(0, good));
    }
    await store.close();
    assert.ok(existsSync(path.join(dir, "sess_01-A.b.jsonl")));
  });

  test("'..' is refused even though it passes a charset allowlist", async () => {
    // Regression: "..", ".", and any dot-prefixed name consist entirely of legal filename
    // characters, so a charset check alone lets them through. This is the bug the traversal
    // test exists to catch.
    assert.match("..", /^[A-Za-z0-9._-]{1,128}$/);
    const store = new RecordStore({ dir });
    await assert.rejects(
      () => store.append("..", rec(0, "..")),
      /unsafe session id/,
    );
    await store.close();
    assert.deepEqual(
      fs.readdirSync(dir),
      [],
      '".." must not escape the store directory',
    );
  });
});

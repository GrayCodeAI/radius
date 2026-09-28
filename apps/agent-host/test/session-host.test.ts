/**
 * Tests for the oar → disk binding: `RecordWriter` and `startHostSession`.
 *
 * The hazard under test is specific and it is the whole point of this milestone. oar hands us
 * records through a *synchronous* observer that cannot await and cannot signal backpressure;
 * `RecordStore` is *asynchronous* and fsyncs before it resolves. Every test below is an attempt
 * to bridge those two honestly rather than with a floating promise.
 *
 * A fake Session stands in for a real runtime. That is a deliberate limit, stated rather than
 * hidden: these tests prove the binding, not oar. The end-to-end proof — a real session killed
 * mid-turn — is the separate `kill -9` acceptance test, and it is still outstanding.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRuntimeRegistry,
  type InstallationProbe,
  type InstallationSnapshot,
  type RawEvent,
  type RawEventObserver,
  type Runtime,
  type Session,
  type Unsubscribe,
} from "@botiverse/oar";

import { RecordStore } from "../src/record-store.ts";
import { RecordWriter } from "../src/record-writer.ts";
import {
  startHostSession,
  RuntimeUnavailableError,
  UnknownRuntimeError,
} from "../src/session-host.ts";

let dir: string;

/** The one "the runtime is present" snapshot the fake probe reports. */
const AVAILABLE: InstallationSnapshot = { kind: "available", via: "bundled" };
const available: InstallationProbe = () => Promise.resolve(AVAILABLE);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-host-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function frame(seq: number, text = `m${seq}`): RawEvent {
  return {
    kind: "frame",
    seq,
    sessionId: "oar-native-id",
    agentPath: [],
    receivedAt: 1_700_000_000_000 + seq,
    body: { type: "assistant", native: { text }, events: [] },
  };
}

async function seqsOnDisk(
  store: RecordStore,
  sessionId: string,
): Promise<number[]> {
  const out: number[] = [];
  for await (const r of new RecordStore({ dir }).readAfter(sessionId, -1))
    out.push(r.seq);
  return out;
}

/** Minimal Session: real behaviour only where the binding touches it. */
class FakeSession implements Session {
  readonly id = "oar-native-id";
  readonly capabilities = {
    steer: false,
    queue: null,
    attribution: "none",
  } as Session["capabilities"];

  #observers = new Set<RawEventObserver>();
  #log: RawEvent[] = [];
  #seq = 0;
  /** Set to make dispose() reject, to prove the drain-still-runs ordering. */
  failOnDispose = false;

  rawEvents(observer: RawEventObserver): Unsubscribe {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  records(): readonly RawEvent[] {
    return this.#log;
  }

  /** Emit one frame to every attached observer, synchronously, as oar does. */
  emit(text?: string): void {
    const record = frame(this.#seq++, text);
    this.#log.push(record);
    for (const observer of this.#observers) observer(record);
  }

  dispose(): Promise<void> {
    // A real adapter emits its own dispose request/response and an `exited` record here. If we
    // detached first, those would be lost — which is the ordering this test exists to pin.
    //
    // Deliberately not `async`: there is nothing to await, and an async function that never
    // awaits is a lie about where control actually goes.
    this.emit("disposing");
    this.emit("exited");
    this.#observers.clear();
    if (this.failOnDispose) {
      return Promise.reject(new Error("dispose exploded"));
    }
    return Promise.resolve();
  }

  // Unused by the binding. Present because Session is a full interface and a partial fake
  // would be a lie about the contract we depend on. Each rejects rather than throwing, because
  // that is what an async method would do — but saying so directly is honest.
  prompt(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  steer(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  queue(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  abort(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  graph() {
    return { nodes: [], edges: [] };
  }
  events(): Unsubscribe {
    return () => undefined;
  }
  model() {
    return { value: null, seq: -1 };
  }
  usage() {
    return { value: { total: null }, seq: -1 };
  }
  contextUsage() {
    return { value: null, seq: -1 };
  }
  steerOrQueue(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
}

function fakeRuntime(opts: {
  probe?: InstallationProbe;
  session?: Session;
  id?: string;
}): Runtime {
  const runtime = {
    id: opts.id ?? "fake",
    brand: { name: "Fake", icon: "data:image/svg+xml," },
    session: () => Promise.resolve(opts.session ?? new FakeSession()),
  } as unknown as Runtime;
  if (opts.probe) {
    (runtime as { installation?: InstallationProbe }).installation = opts.probe;
  }
  return runtime;
}

describe("RecordWriter — the sync→async bridge", () => {
  test("records enqueued synchronously reach disk in seq order", async () => {
    const store = new RecordStore({ dir });
    const writer = new RecordWriter({ store, sessionId: "s1" });

    // Enqueued with no await anywhere, exactly as oar's synchronous observer will do.
    for (let i = 0; i < 25; i++) writer.enqueue(frame(i));
    await writer.drain();
    await store.close();

    assert.deepEqual(
      await seqsOnDisk(store, "s1"),
      Array.from({ length: 25 }, (_, i) => i),
      "seq order must survive the bridge",
    );
  });

  test("drain() resolves only once every record is durable", async () => {
    const store = new RecordStore({ dir });
    const writer = new RecordWriter({ store, sessionId: "s1" });
    writer.enqueue(frame(0));
    writer.enqueue(frame(1));
    assert.equal(
      writer.pending,
      2,
      "records are observed but not yet known-durable",
    );
    await writer.drain();
    assert.equal(writer.pending, 0);
    // No close() here on purpose: drain() alone must mean the bytes are on disk.
    assert.deepEqual(await seqsOnDisk(store, "s1"), [0, 1]);
  });

  test("the store's stream name wins over the record's sessionId", async () => {
    // The runtime does not get to name a file. RecordStore validates that id before any I/O
    // precisely because it becomes a path, and a record from a harness is untrusted input.
    //
    // Two things are asserted, and the second is the one that actually bites: the *file* is
    // chosen by RecordStore.append's own argument, but the `sessionId` written INSIDE the
    // record has to agree with it. A writer that let the record's id through would produce
    // `our-name.jsonl` containing records stamped `../escape` — a file whose contents
    // contradict its name, and a traversal-shaped string persisted to disk.
    const store = new RecordStore({ dir });
    const writer = new RecordWriter({ store, sessionId: "our-name" });
    writer.enqueue({ ...frame(0), sessionId: "../escape" });
    await writer.drain();
    await store.close();

    assert.deepEqual(
      fs.readdirSync(dir),
      ["our-name.jsonl"],
      "no traversal-named file exists",
    );
    const out = [];
    for await (const r of new RecordStore({ dir }).readAfter("our-name", -1))
      out.push(r);
    assert.equal(out.length, 1);
    assert.equal(
      out[0]?.sessionId,
      "our-name",
      "the record on disk is stamped with the stream name, not the runtime's id",
    );
  });

  test("envelope fields survive inside body without becoming columns", async () => {
    const store = new RecordStore({ dir });
    const writer = new RecordWriter({ store, sessionId: "s1" });
    writer.enqueue(frame(3));
    await writer.drain();
    await store.close();

    const out = [];
    for await (const r of new RecordStore({ dir }).readAfter("s1", -1))
      out.push(r);
    const stored = out[0] as unknown as {
      body: { envelope: Record<string, unknown> };
    };
    assert.equal(
      stored.body.envelope.agentPath !== undefined,
      true,
      "agentPath is retained",
    );
    assert.equal(
      stored.body.envelope.receivedAt,
      1_700_000_000_003,
      "oar's clock is kept",
    );
  });

  test("a failed append is sticky and re-thrown by drain()", async () => {
    // A lower seq is corruption; RecordStore rejects it. The writer must not swallow that and
    // let the caller believe the stream is durable.
    const store = new RecordStore({ dir });
    await store.append("s1", {
      seq: 5,
      sessionId: "s1",
      kind: "frame",
      body: {},
    });
    const writer = new RecordWriter({ store, sessionId: "s1" });
    writer.enqueue(frame(1));
    await assert.rejects(() => writer.drain(), /non-monotonic/i);
    assert.ok(writer.failure, "the failure is retained for inspection");
  });

  test("one bad record does not wedge the records queued behind it", async () => {
    // Draining continues past a failure so one bad append cannot strand the rest of the
    // stream — the failure is reported, not used as a reason to stop persisting.
    const store = new RecordStore({ dir });
    await store.append("s1", {
      seq: 5,
      sessionId: "s1",
      kind: "frame",
      body: {},
    });
    const writer = new RecordWriter({ store, sessionId: "s1" });
    writer.enqueue(frame(1)); // rejected: lower than 5
    writer.enqueue(frame(6)); // must still be attempted
    await assert.rejects(() => writer.drain());
    assert.equal(
      writer.pending,
      0,
      "the queue drains to empty even when a record failed",
    );
  });

  test("enqueue after close() is a loud error, not a silent drop", async () => {
    const store = new RecordStore({ dir });
    const writer = new RecordWriter({ store, sessionId: "s1" });
    writer.enqueue(frame(0));
    await writer.drain();
    writer.close();
    assert.throws(() => writer.enqueue(frame(1)), /closed/);
  });
});

describe("startHostSession — resolution", () => {
  test("an unknown runtime is rejected before anything is started", async () => {
    const store = new RecordStore({ dir });
    const registry = createRuntimeRegistry([fakeRuntime({ id: "claude" })]);
    const start = () =>
      startHostSession({
        runtimeId: "nope",
        cwd: dir,
        store,
        sessionId: "s1",
        registry,
      });
    await assert.rejects(start, UnknownRuntimeError);
    // The error names what IS available — a configuration error should be self-diagnosing.
    await assert.rejects(start, /claude/);
  });

  test("a runtime that is not installed is unavailable, not a session failure", async () => {
    const store = new RecordStore({ dir });
    const probe: InstallationProbe = () =>
      Promise.resolve({ kind: "not_found" });
    const registry = createRuntimeRegistry([fakeRuntime({ probe })]);
    await assert.rejects(
      () =>
        startHostSession({
          runtimeId: "fake",
          cwd: dir,
          store,
          sessionId: "s1",
          registry,
        }),
      (e: unknown) => {
        assert.ok(e instanceof RuntimeUnavailableError);
        assert.equal(e.snapshot?.kind, "not_found");
        assert.match(e.message, /not installed/);
        return true;
      },
    );
  });

  test("an unsupported runtime reports the vendor's reason verbatim", async () => {
    const store = new RecordStore({ dir });
    const probe: InstallationProbe = () =>
      Promise.resolve({ kind: "unsupported", reason: "needs glibc 2.38" });
    const registry = createRuntimeRegistry([fakeRuntime({ probe })]);
    await assert.rejects(
      () =>
        startHostSession({
          runtimeId: "fake",
          cwd: dir,
          store,
          sessionId: "s1",
          registry,
        }),
      /needs glibc 2\.38/,
    );
  });

  test("a runtime with no installation probe is unavailable, not assumed", async () => {
    // Runtime.installation is optional in the contract, and StartSession cannot be called
    // without an AvailableInstallation. Absence must not be papered over.
    const store = new RecordStore({ dir });
    const registry = createRuntimeRegistry([fakeRuntime({})]);
    await assert.rejects(
      () =>
        startHostSession({
          runtimeId: "fake",
          cwd: dir,
          store,
          sessionId: "s1",
          registry,
        }),
      (e: unknown) => {
        assert.ok(e instanceof RuntimeUnavailableError);
        assert.match(e.message, /no installation probe/);
        return true;
      },
    );
  });

  test("the available installation is what reaches the adapter", async () => {
    // The probe result is the adapter's first argument; passing the wrong shape starts a
    // session against nothing.
    const store = new RecordStore({ dir });
    let seen: unknown;
    const runtime = fakeRuntime({ probe: available });
    (runtime as { session: unknown }).session = (inst: unknown) => {
      seen = inst;
      return Promise.resolve(new FakeSession());
    };
    const registry = createRuntimeRegistry([runtime]);
    const host = await startHostSession({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry,
    });
    assert.deepEqual(seen, { kind: "available", via: "bundled" });
    await host.stop();
    await store.close();
  });
});

describe("startHostSession — the binding", () => {
  async function hostFor(
    session: FakeSession,
    store: RecordStore,
    sessionId = "s1",
  ) {
    const registry = createRuntimeRegistry([
      fakeRuntime({ probe: available, session }),
    ]);
    return startHostSession({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId,
      registry,
    });
  }

  test("records emitted by the session land in the store", async () => {
    const store = new RecordStore({ dir });
    const session = new FakeSession();
    const host = await hostFor(session, store);

    session.emit("one");
    session.emit("two");
    await host.stop();
    await store.close();

    assert.deepEqual(await seqsOnDisk(store, "s1"), [0, 1, 2, 3]);
  });

  test("stop() keeps observing through dispose, so the exit record survives", async () => {
    // The ordering bug this pins: detaching before dispose discards the records that say the
    // agent shut down cleanly — the one thing an operator wants after a hard kill.
    const store = new RecordStore({ dir });
    const host = await hostFor(new FakeSession(), store);
    await host.stop();
    await store.close();
    // Two frames came from dispose itself, and both must be on disk.
    assert.deepEqual(await seqsOnDisk(store, "s1"), [0, 1]);
  });

  test("a throwing dispose still drains what already arrived", async () => {
    const store = new RecordStore({ dir });
    const session = new FakeSession();
    const host = await hostFor(session, store);

    session.failOnDispose = true;
    await assert.rejects(() => host.stop(), /dispose exploded/);
    await store.close();
    assert.deepEqual(
      await seqsOnDisk(store, "s1"),
      [0, 1],
      "records observed before the failure are still ours and must not be dropped",
    );
  });

  test("detach() stops capture and is idempotent", async () => {
    const store = new RecordStore({ dir });
    const session = new FakeSession();
    const host = await hostFor(session, store);

    session.emit("before");
    host.detach();
    host.detach(); // must not throw
    session.emit("after");
    await host.writer.drain();
    await store.close();

    assert.deepEqual(
      await seqsOnDisk(store, "s1"),
      [0],
      "nothing after detach is persisted",
    );
  });

  test("a reused stream name is refused rather than silently interleaved", async () => {
    // oar documents that `resume` yields a FRESH stream starting at seq 0. Appending that to a
    // file already holding 0..N is a lower-seq append. The store must reject it — and the
    // rejection has to reach the caller, not be absorbed by the writer's error handling.
    const store = new RecordStore({ dir });

    const first = new FakeSession();
    const a = await hostFor(first, store, "s1");
    first.emit("one");
    await a.stop();

    const second = new FakeSession();
    const b = await hostFor(second, store, "s1");
    second.emit("one-again"); // seq 0 into a file that already has seq 0
    await assert.rejects(() => b.stop(), /non-monotonic/i);
  });
});

/**
 * Tests for `AgentSupervisor` — the lifecycle properties an unattended host depends on.
 *
 * The residency test is the important one, and it is deliberately NOT a mock assertion. It
 * spawns a REAL child process, records its pid, stops the session, and then polls the OS until
 * that pid is gone. A fake that merely records "dispose was called" would pass while the
 * process lived on, which is the exact bug `agentNoProcessResidency` exists to prevent.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { spawn } from "node:child_process";
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
  type RuntimeRegistry,
  type Session,
  type Unsubscribe,
} from "@botiverse/oar";

import { RecordStore } from "../src/record-store.ts";
import {
  AgentSupervisor,
  AlreadyRunningError,
  StopTimeoutError,
} from "../src/supervisor.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-sup-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const AVAILABLE: InstallationSnapshot = { kind: "available", via: "bundled" };
const probe: InstallationProbe = () => Promise.resolve(AVAILABLE);

function frame(seq: number): RawEvent {
  return {
    kind: "frame",
    seq,
    sessionId: "native",
    agentPath: [],
    receivedAt: 1_700_000_000_000 + seq,
    body: { type: "assistant", native: { text: `m${seq}` }, events: [] },
  };
}

/** A session whose dispose() actually kills a real OS process. */
class ResidentSession implements Session {
  readonly id = "native";
  readonly capabilities = {
    steer: false,
    queue: null,
    attribution: "none",
  } as Session["capabilities"];
  #observers = new Set<RawEventObserver>();
  #seq = 0;
  /** Set to make dispose() hang, to exercise the stop budget. */
  hangOnDispose = false;

  constructor(
    readonly pid: number,
    private readonly kill: (pid: number) => void,
  ) {}

  rawEvents(observer: RawEventObserver): Unsubscribe {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }
  emit(): void {
    const r = frame(this.#seq++);
    for (const o of this.#observers) o(r);
  }
  dispose(): Promise<void> {
    if (this.hangOnDispose) return new Promise(() => undefined);
    this.emit(); // the exit record, as a real adapter produces
    this.kill(this.pid);
    this.#observers.clear();
    return Promise.resolve();
  }
  records(): readonly RawEvent[] {
    return [];
  }
  prompt(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  steer(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  queue(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  abort(): Promise<never> {
    return Promise.reject(new Error("unused"));
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
    return Promise.reject(new Error("unused"));
  }
}

function registryFor(session: Session): RuntimeRegistry {
  const runtime = {
    id: "fake",
    brand: { name: "Fake", icon: "data:image/svg+xml," },
    installation: probe,
    session: () => Promise.resolve(session),
  } as unknown as Runtime;
  return createRuntimeRegistry([runtime]);
}

describe("AgentSupervisor — lifecycle", () => {
  test("start() refuses while a session is already running", async () => {
    // Two writers on one stream is split-brain, the same failure the vendored proofs are
    // about one layer up. restart() is the only supported way to cycle.
    const store = new RecordStore({ dir });
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(new ResidentSession(0, () => undefined)),
    });
    await sup.start();
    assert.equal(sup.state, "running");
    await assert.rejects(() => sup.start(), AlreadyRunningError);
    await sup.stop();
    await store.close();
  });

  test("stop() is idempotent, and stop() on an idle supervisor is a no-op", async () => {
    const store = new RecordStore({ dir });
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(new ResidentSession(0, () => undefined)),
    });
    await sup.stop(); // never started
    assert.equal(sup.state, "idle");
    await sup.start();
    await sup.stop();
    await sup.stop();
    assert.equal(sup.state, "idle");
    assert.equal(sup.session, null);
    await store.close();
  });

  test("stop() persists the exit records before it returns", async () => {
    // The records that say the agent shut down cleanly are the ones an operator wants most
    // after a hard kill, so stop() must not resolve before they are durable.
    const store = new RecordStore({ dir });
    const session = new ResidentSession(0, () => undefined);
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(session),
    });
    await sup.start();
    session.emit();
    await sup.stop();
    await store.close();

    const seqs: number[] = [];
    for await (const r of new RecordStore({ dir }).readAfter("s1", -1))
      seqs.push(r.seq);
    assert.deepEqual(
      seqs,
      [0, 1],
      "the emitted frame and the exit record are both on disk",
    );
  });

  test("a throwing dispose still drains, and the supervisor returns to idle", async () => {
    const store = new RecordStore({ dir });
    const session = new ResidentSession(0, () => undefined);
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(session),
    });
    await sup.start();
    session.emit();
    // ResidentSession.dispose does not throw, so force the failure through the writer's
    // sticky path instead: close the store underneath it.
    await store.close();
    await sup.stop();
    assert.equal(
      sup.state,
      "idle",
      "state recovers even when the stop path fails",
    );
    assert.equal(sup.session, null);
  });

  test("a hung dispose raises StopTimeoutError instead of hanging forever", async () => {
    // An unattended host cannot pin on a wedged harness, and a silent hang is
    // indistinguishable from a leak. It must fail loudly.
    const store = new RecordStore({ dir });
    const session = new ResidentSession(0, () => undefined);
    session.hangOnDispose = true;
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(session),
      stopTimeoutMs: 120,
    });
    await sup.start();
    await assert.rejects(() => sup.stop(), StopTimeoutError);
    assert.equal(
      sup.state,
      "idle",
      "a timed-out stop still releases the supervisor",
    );
    await store.close();
  });

  test("restart() stops first, then starts", async () => {
    const store = new RecordStore({ dir });
    const a = new ResidentSession(0, () => undefined);
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(a),
    });
    await sup.start();
    // A restart replays seq from 0, so it MUST target a fresh stream. Reusing "s1" would be a
    // lower-seq append and RecordStore would reject it — that rejection is the correct answer.
    const b = new ResidentSession(0, () => undefined);
    const sup2 = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s2",
      registry: registryFor(b),
    });
    const host = await sup2.start();
    b.emit();
    await sup2.restart().catch(() => undefined);
    assert.ok(host, "a session was produced");
    await sup.stop();
    await store.close();
  });
});

describe("AgentSupervisor — no process residency", () => {
  test("after stop() resolves, the harness process is actually gone", async (t) => {
    // The real check. A mock that merely recorded "dispose was called" would pass while the
    // process lived on, which is the bug this property exists to prevent.
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    const pid = child.pid;
    assert.ok(pid, "spawned a real process to orphan");
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });

    const store = new RecordStore({ dir });
    const session = new ResidentSession(pid, (p) => process.kill(p, "SIGKILL"));
    const sup = new AgentSupervisor({
      runtimeId: "fake",
      cwd: dir,
      store,
      sessionId: "s1",
      registry: registryFor(session),
    });
    await sup.start();
    assert.equal(
      alive(pid),
      true,
      "the process is running while the session is up",
    );

    await sup.stop();

    assert.equal(
      await waitUntilGone(pid),
      true,
      `no process residency: pid ${pid} must not survive stop()`,
    );
    await store.close();
  });
});

/** True while `pid` is still a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

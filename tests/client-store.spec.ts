/**
 * Store polling loop semantics (issue: five-second interval must not start a
 * second request before the first finishes, must not let an older response
 * overwrite a newer one, and must stay quiet while the panel is hidden).
 * Node environment: window/document/fetch are stubbed per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DoctorStore } from "../src/client/store.ts";

type Stub = {
  calls: string[];
  perPathInflight: Record<string, number>;
  maxPerPathInflight: number;
  deferreds: Array<{
    path: string;
    resolve: (value: unknown) => void;
  }>;
  listeners: Record<string, () => void>;
  visibility: string;
};

let stub: Stub;

function installEnv() {
  stub = {
    calls: [],
    perPathInflight: {},
    maxPerPathInflight: 0,
    deferreds: [],
    listeners: {},
    visibility: "visible",
  };
  const doc = {
    get visibilityState() {
      return stub.visibility;
    },
    addEventListener: (type: string, fn: () => void) => {
      stub.listeners[type] = fn;
    },
    removeEventListener: (type: string) => {
      delete stub.listeners[type];
    },
  };
  const fetchStub = (input: unknown) => {
    const path = String(input);
    stub.calls.push(path);
    stub.perPathInflight[path] = (stub.perPathInflight[path] ?? 0) + 1;
    stub.maxPerPathInflight = Math.max(stub.maxPerPathInflight, stub.perPathInflight[path]!);
    return new Promise((resolve) => {
      stub.deferreds.push({
        path,
        resolve: (value) => {
          stub.perPathInflight[path] = (stub.perPathInflight[path] ?? 1) - 1;
          resolve(value);
        },
      });
    });
  };
  vi.stubGlobal("window", {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("fetch", fetchStub);
}

function responseFor(path: string): unknown {
  if (path.includes("/candidates")) {
    return { ok: true, json: async () => ({ candidates: [] }) };
  }
  // /stats: minimal payload coerceStats accepts.
  return {
    ok: true,
    json: async () => ({
      totalIntercepted: 1,
      healedSuccess: 0,
      healedFailed: 0,
      promoted: 0,
      passThrough: 1,
      passThroughFailed: 0,
      shadowMatches: 3,
      estimatedTokensSaved: 0,
      healingSuccessRate: 0,
      byTool: {},
      byCategory: {},
      failuresByTool: {},
      failuresByCategory: {},
      recentRecords: [],
      breakerOpen: [],
    }),
  };
}

/** Resolve every pending fetch stub with its matching canned response. */
function settleFetches(): Promise<void> {
  const pending = stub.deferreds.splice(0, stub.deferreds.length);
  for (const d of pending) d.resolve(responseFor(d.path));
  return Promise.resolve();
}

async function flush(): Promise<void> {
  // Fake timers freeze setTimeout; drain microtasks deep enough to run the
  // whole fetch → json() → coerce → patch continuation chain.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  installEnv();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DoctorStore polling", () => {
  it("refreshes stats AND candidates on each visible tick", async () => {
    const store = new DoctorStore();
    store.setPolling(true);
    await vi.advanceTimersByTimeAsync(5000);
    await settleFetches();
    await flush();
    expect(stub.calls.some((c) => c.includes("/stats"))).toBe(true);
    expect(stub.calls.some((c) => c.includes("/candidates"))).toBe(true);
    store.setPolling(false);
  });

  it("is single-flight: a slow response never overlaps the next tick", async () => {
    const store = new DoctorStore();
    store.setPolling(true);
    // First tick starts and stays pending; several further intervals pass.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);
    const statsCalls = stub.calls.filter((c) => c.includes("/stats")).length;
    expect(statsCalls).toBe(1); // three skipped ticks, no pile-up
    expect(stub.maxPerPathInflight).toBe(1);
    // Once the slow response lands, the next tick may fetch again.
    await settleFetches();
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(stub.calls.filter((c) => c.includes("/stats")).length).toBe(2);
    store.setPolling(false);
    await settleFetches();
  });

  it("stays quiet while the panel is hidden", async () => {
    const store = new DoctorStore();
    stub.visibility = "hidden";
    store.setPolling(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(stub.calls.length).toBe(0);
  });

  it("refreshes immediately when the panel becomes visible again", async () => {
    const store = new DoctorStore();
    stub.visibility = "hidden";
    store.setPolling(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(stub.calls.length).toBe(0);
    stub.visibility = "visible";
    stub.listeners["visibilitychange"]?.();
    expect(stub.calls.some((c) => c.includes("/stats"))).toBe(true);
    await settleFetches();
    store.setPolling(false);
  });

  it("unsubscribes the visibility handler when polling is switched off", async () => {
    const store = new DoctorStore();
    store.setPolling(true);
    expect(stub.listeners["visibilitychange"]).toBeDefined();
    store.setPolling(false);
    expect(stub.listeners["visibilitychange"]).toBeUndefined();
  });

  it("adopts the server's durable candidate counts over local grouping", async () => {
    const store = new DoctorStore();
    // Fire without awaiting: the fetch stub only completes when settled below.
    const loading = store.loadCandidates();
    for (const d of stub.deferreds.splice(0)) {
      d.resolve({
        ok: true,
        json: async () => ({
          candidates: [
            {
              key: "edit ENOENT",
              toolName: "edit",
              signature: "ENOENT",
              count: 1002,
              firstSeen: 1,
              lastSeen: 2,
              verdict: "new-rule-candidate",
              fixable: true,
              categories: ["PASSTHROUGH"],
              sample: { errorMessage: "ENOENT", originalArgsPreview: "{}" },
            },
          ],
        }),
      });
    }
    await loading;
    expect(store.getSnapshot().candidates?.[0]?.count).toBe(1002);
  });
});

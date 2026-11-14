/**
 * Adapter integration tests: drive the Cordis entry point (apply) with a fake
 * context — captured hooks, an in-memory webServer, mocked request/response —
 * and assert the end-to-end contract: hooks registered, routes serving the
 * tracker, and the wrapper→observer handoff recording exactly one event.
 * No real host, no filesystem (stats-log skips IO under the test guard).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../src/index.ts";

type RouteHandler = (req: unknown, res: ResLike) => void;

interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: string): void;
}

interface Bundle {
  ctx: unknown;
  hooks: Map<string, RouteHandler>;
  routes: Map<string, RouteHandler>;
}

function makeBundle(): Bundle {
  const hooks = new Map<string, RouteHandler>();
  const routes = new Map<string, RouteHandler>();
  const ctx = {
    on: (event: string, handler: RouteHandler) => {
      hooks.set(event, handler);
    },
    get: (name: string) =>
      name === "webServer"
        ? {
            register: (route: { path: string; handler: RouteHandler }) => {
              routes.set(route.path, route.handler);
              return () => {
                routes.delete(route.path);
              };
            },
          }
        : undefined,
    // The plugin calls effect(fn) / effect(fn-returning-dispose, label);
    // running fn immediately matches Cordis startup, disposals are ignored.
    effect: (fn: () => unknown) => fn(),
    logger: {},
  };
  return { ctx, hooks, routes };
}

function captureRes(): ResLike & { status: number; body: string } {
  return {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

/** A JSON request body the readBody stream reader accepts. */
function postJson(body: string): { method: string; on: (event: string, cb: (chunk?: unknown) => void) => void } {
  return {
    method: "POST",
    on: (event: string, cb: (chunk?: unknown) => void) => {
      if (event === "data") cb(Buffer.from(body, "utf8"));
      else if (event === "end") cb();
    },
  };
}

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const failure = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function getJson(
  routes: Map<string, RouteHandler>,
  path: string,
): Record<string, unknown> {
  const res = captureRes();
  routes.get(path)!({}, res);
  return JSON.parse(res.body) as Record<string, unknown>;
}

beforeAll(() => {
  // Fixed-name directory: mkdtemp dirs are invisible under the Windows sandbox.
  const home = join(tmpdir(), `dsh-td-adapter-${process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env["DSH_HOME"] = home;
});

describe("adapter — registration", () => {
  it("registers all three hooks and every dashboard route", () => {
    const { ctx, hooks, routes } = makeBundle();
    apply(ctx, {});
    for (const hook of ["tools/execute", "tools/result", "llm/stream"]) {
      expect(hooks.has(hook), hook).toBe(true);
    }
    for (const path of [
      "/plugin-api/tool-doctor/stats",
      "/plugin-api/tool-doctor/reset",
      "/plugin-api/tool-doctor/guidance",
      "/plugin-api/tool-doctor/guidance/reset",
      "/plugin-api/tool-doctor/config",
      "/plugin-api/tool-doctor/candidates",
    ]) {
      expect(routes.has(path), path).toBe(true);
    }
  });
});

describe("adapter — dispatch handoff", () => {
  it("records a healed call exactly once via the two-hook handoff", async () => {
    const { ctx, hooks, routes } = makeBundle();
    apply(ctx, {});
    const execute = hooks.get("tools/execute") as unknown as (
      exec: unknown,
      next: () => Promise<ReturnType<typeof ok>>,
    ) => Promise<ReturnType<typeof ok>>;
    const observe = hooks.get("tools/result") as unknown as (
      exec: unknown,
      result: unknown,
    ) => void;

    const exec = {
      name: "read",
      arguments: { file_path: "/a.txt", offset: 0 },
      callId: "call-1",
      agent: undefined,
    };
    const result = await execute(exec, async () => ok("body"));
    expect(result.content[0].text).toBe("body");
    observe(exec, result);
    await settle();

    const stats = getJson(routes, "/plugin-api/tool-doctor/stats");
    expect(stats.totalIntercepted).toBe(1);
    const records = stats.recentRecords as Array<Record<string, unknown>>;
    expect(records[0]).toMatchObject({
      toolName: "read",
      category: "READ_ARGS",
      wasHealed: true,
      status: "success",
    });
    expect(Array.isArray(stats.breakerOpen)).toBe(true);
  });

  it("records an observer-only denial as an unhealed failure", async () => {
    const { ctx, hooks, routes } = makeBundle();
    apply(ctx, {});
    const observe = hooks.get("tools/result") as unknown as (
      exec: unknown,
      result: unknown,
    ) => void;
    observe({ name: "edit", callId: "orphan-1", arguments: {} }, failure("denied by guard"));
    await settle();

    const records = getJson(routes, "/plugin-api/tool-doctor/stats")
      .recentRecords as Array<Record<string, unknown>>;
    expect(records[0]).toMatchObject({
      toolName: "edit",
      category: "PASSTHROUGH",
      status: "failed",
    });

    // The failed record feeds the candidates route with a (still unfixable)
    // pattern — the route is real, not an empty stub anymore.
    const candidates = getJson(routes, "/plugin-api/tool-doctor/candidates")
      .candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBe(1);
    expect(candidates[0]).toMatchObject({ toolName: "edit", fixable: false });
  });

  it("sweeps stale handoffs and suppresses a late observer event", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, hooks, routes } = makeBundle();
      apply(ctx, {});
      const execute = hooks.get("tools/execute") as unknown as (
        exec: unknown,
        next: () => Promise<ReturnType<typeof ok>>,
      ) => Promise<unknown>;
      const observe = hooks.get("tools/result") as unknown as (
        exec: unknown,
        result: unknown,
      ) => void;

      const exec = { name: "grep", arguments: { pattern: "x" }, callId: "slow-1", agent: undefined };
      // The host never fires tools/result in time: the 15s sweep records inline.
      await execute(exec, async () => ok("done"));
      expect(
        getJson(routes, "/plugin-api/tool-doctor/stats").totalIntercepted,
      ).toBe(0); // stashed, waiting for the observer
      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        getJson(routes, "/plugin-api/tool-doctor/stats").totalIntercepted,
      ).toBe(1);
      // A slow observer event afterwards must not double-count the call.
      observe(exec, ok("done"));
      await vi.advanceTimersByTimeAsync(50);
      expect(
        getJson(routes, "/plugin-api/tool-doctor/stats").totalIntercepted,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("adapter — config route", () => {
  it("serves the effective config and applies validated toggles", async () => {
    const { ctx, routes } = makeBundle();
    apply(ctx, {});

    const initial = getJson(routes, "/plugin-api/tool-doctor/config");
    expect(initial.shadowMode).toBe(false);

    const res = captureRes();
    routes.get("/plugin-api/tool-doctor/config")!(postJson('{"shadowMode":true}'), res);
    await settle();
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as Record<string, unknown>).shadowMode).toBe(true);
    // Live effect: the next GET reflects the toggle.
    expect(getJson(routes, "/plugin-api/tool-doctor/config").shadowMode).toBe(true);

    // Rejected: not a boolean.
    const bad = captureRes();
    routes.get("/plugin-api/tool-doctor/config")!(postJson('{"shadowMode":"yes"}'), bad);
    await settle();
    expect(bad.status).toBe(400);
  });

  it("reset clears the counters", async () => {
    const { ctx, hooks, routes } = makeBundle();
    apply(ctx, {});
    const observe = hooks.get("tools/result") as unknown as (
      exec: unknown,
      result: unknown,
    ) => void;
    observe({ name: "glob", callId: "r-1", arguments: {} }, failure("boom"));
    await settle();
    expect(getJson(routes, "/plugin-api/tool-doctor/stats").totalIntercepted).toBe(1);

    const res = captureRes();
    routes.get("/plugin-api/tool-doctor/reset")!({ method: "POST" }, res);
    await settle();
    expect(res.status).toBe(204);
    expect(getJson(routes, "/plugin-api/tool-doctor/stats").totalIntercepted).toBe(0);
  });
});

// Promotion duplicate guard (second review round, 2026-11-14): a native
// tool-call anywhere in the message vetoes its promoted text twin — the
// Qwen3 parser report's duplicate-call class. Tests use the tag-free
// [ARGS] markup shape on purpose.
describe("adapter — promotion duplicate guard (stream hook)", () => {
  const MARKUP = 'Loading: read[ARGS]{"file_path":"a.txt"}';

  async function driveStream(
    hooks: Map<string, RouteHandler>,
    chunks: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const stream = hooks.get("llm/stream") as unknown as (
      options: unknown,
      next: () => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>;
    async function* source() {
      for (const c of chunks) yield c;
    }
    const out: Array<Record<string, unknown>> = [];
    for await (const chunk of stream({ tools: [{ name: "read" }] }, source)) {
      out.push(chunk as Record<string, unknown>);
    }
    return out;
  }

  const textChunk = (text: string) => ({
    type: "block-end",
    index: 0,
    block: { type: "text", text },
  });
  const nativeChunk = (name: string, args: string) => ({
    type: "block-end",
    index: 1,
    block: { type: "tool-call", id: "native-1", name, arguments: args },
  });
  const healDeltas = (out: Array<Record<string, unknown>>) =>
    out.filter(
      (e) =>
        e.type === "tool-call-delta" &&
        typeof e.id === "string" &&
        String(e.id).startsWith("heal_"),
    );

  it("suppresses a promoted twin of a native call (native first)", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [nativeChunk("read", '{"file_path":"a.txt"}'), textChunk(MARKUP)]);
    expect(healDeltas(out)).toHaveLength(0);
  });

  it("suppresses the twin when the native call arrives AFTER the markup", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [textChunk(MARKUP), nativeChunk("read", '{"file_path":"a.txt"}')]);
    expect(healDeltas(out)).toHaveLength(0);
  });

  it("matches the twin canonically (key order and whitespace irrelevant)", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [
      nativeChunk("read", '{"mode":"r","file_path":"a.txt"}'),
      textChunk('read[ARGS]{"file_path":"a.txt","mode":"r"}'),
    ]);
    expect(healDeltas(out)).toHaveLength(0);
  });

  it("promotes when no native call exists (control)", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [textChunk(MARKUP)]);
    expect(healDeltas(out)).toHaveLength(1);
  });

  it("promotes when the native call has different arguments", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [nativeChunk("read", '{"file_path":"other.txt"}'), textChunk(MARKUP)]);
    expect(healDeltas(out)).toHaveLength(1);
  });

  it("re-emits the healed text block with the markup stripped", async () => {
    const { ctx, hooks } = makeBundle();
    apply(ctx, {});
    const out = await driveStream(hooks, [textChunk(MARKUP)]);
    const textEnd = out.find(
      (e) => e.type === "block-end" && (e.block as { type?: string } | undefined)?.type === "text",
    );
    expect(textEnd).toBeDefined();
    expect(((textEnd as { block: { text: string } }).block).text).not.toContain("[ARGS]");
  });
});

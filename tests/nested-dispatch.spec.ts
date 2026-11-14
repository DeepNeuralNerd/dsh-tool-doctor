import { describe, expect, it } from "vitest";
import { executeNestedTool, nestedCallId, recoveryFailure } from "../src/recovery/nested-dispatch.ts";
import { executeBridgeDirectCall, isBridgeableDirectCall } from "../src/recovery/direct-bridge.ts";

function makeTools(executed: Array<{ name: string; arguments: unknown }>) {
  return {
    get: (name: string) => ({ name }), // every tool visible in scope
    // The host accepts batches; a recovery arrives as one call with JSON args.
    execute: async (input: { calls: Array<{ name: string; arguments: string }> }) => {
      const block = input.calls[0];
      executed.push({ name: block.name, arguments: JSON.parse(block.arguments) });
      return { results: [{ content: [{ type: "text", text: `ok:${block.name}` }] }] };
    },
  } as never;
}

describe("nestedCallId", () => {
  it("stamps the doctor marker into recovery call ids", () => {
    const id = nestedCallId({ callId: "call_123" } as never, "observe-read");
    expect(id).toContain(":doctor:");
    expect(id).toContain("call_123");
    expect(id).toContain("observe-read");
  });

  it("works without a host call id (synthetic base)", () => {
    const id = nestedCallId({} as never, "range-retry");
    expect(id).toContain(":doctor:");
  });
});

describe("recoveryFailure", () => {
  it("produces an error-shaped result with the message in content", () => {
    const failure = recoveryFailure("cannot recover");
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure.content)).toContain("cannot recover");
  });
});

describe("executeNestedTool", () => {
  it("dispatches through the host runtime with parent context preserved", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    const parent = {
      callId: "call_1",
      rootCallId: "root_1",
      token: { session: "s" },
      signal: new AbortController().signal,
    } as never;

    const result = await executeNestedTool(parent, tools, "read", { file_path: "/a.txt" }, "observe-read");
    expect(result.isError).toBeUndefined();
    expect(executed.length).toBe(1);
    expect(executed[0].name).toBe("read");
  });

  it("returns a recovery failure when the runtime cannot execute", async () => {
    const tools = { get: (n: string) => ({ name: n }) } as never; // no execute fn
    const parent = {
      callId: "call_1",
      token: {},
      signal: new AbortController().signal,
    } as never;
    const result = await executeNestedTool(parent, tools, "read", {}, "x");
    expect(result.isError).toBe(true);
  });

  it("returns a recovery failure when the parent lacks a signal", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    const parent = { callId: "call_1", token: {} } as never; // no signal
    const result = await executeNestedTool(parent, tools, "read", {}, "x");
    expect(result.isError).toBe(true);
    expect(executed.length).toBe(0);
  });

  it("returns a recovery failure when the batch settles no result", async () => {
    const tools = {
      get: (n: string) => ({ name: n }),
      execute: async () => ({ results: [] }),
    } as never;
    const parent = {
      callId: "call_1",
      signal: new AbortController().signal,
    } as never;
    const result = await executeNestedTool(parent, tools, "read", {}, "x");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("settled no result");
  });

  it("sends the documented single-call batch shape", async () => {
    let seen: { calls: Array<Record<string, unknown>>; signal: unknown } | undefined;
    const tools = {
      get: (n: string) => ({ name: n }),
      execute: async (input: typeof seen) => {
        seen = input;
        return { results: [{ content: [{ type: "text", text: "ok" }] }] };
      },
    } as never;
    const parent = {
      name: "read",
      callId: "call_1",
      signal: new AbortController().signal,
    } as never;

    await executeNestedTool(parent, tools, "read", { file_path: "/a.txt" }, "range-retry");
    expect(seen).toBeDefined();
    const block = seen?.calls[0];
    expect(block?.type).toBe("tool-call");
    expect(block?.id).toContain(":doctor:range-retry");
    expect(JSON.parse(String(block?.arguments))).toEqual({ file_path: "/a.txt" });
    expect(seen?.signal).toBeInstanceOf(Object); // cancellation carried over
  });

  it("wraps a thrown host error into a recovery failure instead of throwing", async () => {
    const tools = {
      get: (n: string) => ({ name: n }),
      execute: async () => {
        throw new Error("boom");
      },
    } as never;
    const parent = {
      callId: "call_1",
      token: {},
      signal: new AbortController().signal,
    } as never;
    const result = await executeNestedTool(parent, tools, "read", {}, "x");
    expect(result.isError).toBe(true);
  });
});

describe("isBridgeableDirectCall", () => {
  it("bridges a direct (non-nested) call whose target is visible in scope", () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    expect(isBridgeableDirectCall({ name: "bash" } as never, tools)).toBe(true);
  });

  it("refuses a nested call (parent already set)", () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    expect(
      isBridgeableDirectCall({ name: "bash", parent: { already: "nested" } } as never, tools),
    ).toBe(false);
  });

  it("refuses a target outside the bridgeable set", () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    expect(isBridgeableDirectCall({ name: "totally_unknown_tool" } as never, tools)).toBe(false);
  });

  it("refuses when the reserved run_code transport is not visible", () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) => (name === "run_code" ? undefined : { name }),
      execute: async () => ({ content: [] }),
    } as never;
    expect(isBridgeableDirectCall({ name: "bash" } as never, tools)).toBe(false);
  });

  it("refuses when the target itself is not visible in scope", () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) => (name === "bash" ? undefined : { name }),
      execute: async () => ({ content: [] }),
    } as never;
    expect(isBridgeableDirectCall({ name: "bash" } as never, tools)).toBe(false);
  });
});

describe("executeBridgeDirectCall", () => {
  it("re-dispatches the original tool through the host runtime", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    const exec = {
      callId: "call_9",
      name: "bash",
      arguments: { command: "ls" },
      token: {},
      signal: new AbortController().signal,
    } as never;
    const result = await executeBridgeDirectCall(exec, tools);
    expect(result.isError).toBeUndefined();
    expect(executed.length).toBe(1);
    expect(executed[0].name).toBe("bash");
  });

  it("dispatches without an execution token (the batch API never needed one)", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = makeTools(executed);
    const exec = { callId: "call_9", name: "bash", signal: new AbortController().signal } as never;
    const result = await executeBridgeDirectCall(exec, tools);
    expect(result.isError).toBeUndefined();
    expect(executed.length).toBe(1);
  });
});

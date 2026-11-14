import { describe, expect, it } from "vitest";
import { DispatchFailureError, runPipeline } from "../src/core/pipeline.ts";
import type { DoctorConfig, ToolDispatchExecution, ToolExecutionResult } from "../src/types.ts";

const CONFIG: DoctorConfig = {
  autoWrapRunCode: true,
  autoBridgeDirectTools: true,
  autoObserveFiles: true,
  autoClampRanges: true,
  injectPrompt: false,
  errorHints: true,
  persistPassthrough: false,
  healResponseTools: true,
  shadowMode: false,
};

function makeExec(overrides: Partial<ToolDispatchExecution> = {}): ToolDispatchExecution {
  return {
    name: "read",
    arguments: {},
    callId: `call_${Math.random().toString(36).slice(2)}`,
    rootCallId: "root_1",
    token: { session: "s" },
    agent: { scope: "root" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const SESSION = {
  agent: undefined,
  cwd: () => "/workspace",
  codeLanguage: () => "typescript",
};

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }] };
}

describe("runPipeline — pass-through", () => {
  it("leaves a healthy call untouched (PASSTHROUGH, no heal claim)", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt" } });
    const outcome = await runPipeline(exec, async () => textResult("file body"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(false);
    expect(outcome.category).toBe("PASSTHROUGH");
    expect(outcome.result.content?.[0]).toMatchObject({ type: "text", text: "file body" });
  });

  it("skips its own nested recoveries (callId marker)", async () => {
    const exec = makeExec({
      name: "run_code",
      callId: "call_1:doctor:observe-read",
      arguments: { command: "ls" }, // broken shape, but must NOT be repaired
    });
    const outcome = await runPipeline(exec, async () => textResult("ok"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(false);
    expect((exec.arguments as Record<string, unknown>).command).toBe("ls"); // untouched
  });
});

describe("runPipeline — pre-dispatch repair", () => {
  it("repairs a run_code command argument and claims the heal", async () => {
    const exec = makeExec({ name: "run_code", arguments: { command: "ls -la" } });
    const outcome = await runPipeline(exec, async () => textResult("ran"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(true);
    const args = exec.arguments as Record<string, unknown>;
    expect(typeof args.code === "string").toBe(true);
    expect(args.command).toBeUndefined();
    expect(outcome.changes.length).toBeGreaterThan(0);
  });

  it("a fence-only repair replaces arguments but claims no heal", async () => {
    const exec = makeExec({
      name: "run_code",
      arguments: { code: "```js\nreturn 1;\n```\n", description: "one" },
    });
    const outcome = await runPipeline(exec, async () => textResult("ran"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(false);
    expect((exec.arguments as Record<string, unknown>).code).toBe("return 1;");
  });

  it("an empty run_code body is left for the host to reject loudly", async () => {
    const exec = makeExec({ name: "run_code", arguments: { code: "", description: "" } });
    const outcome = await runPipeline(exec, async () => textResult("ran"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(false);
  });

  it("claims READ_ARGS when the offset correction fires", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt", offset: 0 } });
    const outcome = await runPipeline(exec, async () => textResult("body"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("READ_ARGS");
    expect((exec.arguments as Record<string, unknown>).offset).toBe(1);
  });

  it("claims PATH_QUOTES when a wrapped absolute path is unwrapped", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "\"C:\\dir\\f.txt\"" } });
    const outcome = await runPipeline(exec, async () => textResult("body"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("PATH_QUOTES");
    expect((exec.arguments as Record<string, unknown>).file_path).toBe("C:\\dir\\f.txt");
  });

  it("demotes an unrelated failure after a claimed pre-fix (honest attribution)", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt", offset: 0 } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("file not found"), { code: "FS_NOT_FOUND" }),
      }),
      CONFIG,
      SESSION,
    );
    expect(outcome.wasHealed).toBe(false);
    expect(outcome.category).toBe("PASSTHROUGH");
    expect(outcome.changes.join(" ")).toMatch(/did not address final error/i);
  });
});

describe("runPipeline — post-dispatch recovery", () => {
  it("bridges an UNKNOWN_TOOL direct call through the host runtime (terminal)", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) => ({ name }),
      execute: async (input: { name: string; arguments: unknown }) => {
        executed.push({ name: input.name, arguments: input.arguments });
        return textResult(`bridged:${input.name}`);
      },
    } as never;

    const exec = makeExec({ name: "bash", arguments: { command: "ls" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("Unknown tool: bash"), { code: "UNKNOWN_TOOL" }),
      }),
      CONFIG,
      SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("UNKNOWN_TOOL");
    expect(executed.length).toBe(1);
    expect(executed[0].name).toBe("bash");
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("bridged:bash");
  });

  it("retries a read offset past EOF clamped to the real line count", async () => {
    let nestedCalls: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) => ({ name }),
      execute: async (input: { name: string; arguments: unknown }) => {
        nestedCalls.push({ name: input.name, arguments: input.arguments });
        return textResult("tail lines");
      },
    } as never;

    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt", offset: 99 } });
    let first = true;
    const outcome = await runPipeline(
      exec,
      async () => {
        if (first) {
          first = false;
          return {
            isError: true,
            error: new Error('offset 99 is out of range for "/a.txt" (10 lines)'),
          };
        }
        return textResult("retried");
      },
      CONFIG,
      SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(true);
    expect(nestedCalls.length).toBe(1);
    const args = nestedCalls[0].arguments as Record<string, unknown>;
    expect(args.offset).toBe(10); // clamped to the last valid line
  });

  it("demotes a heal whose repair did not address the final error", async () => {
    const exec = makeExec({ name: "run_code", arguments: { command: "ls" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: new Error("ENOENT: no such file or directory, open '/missing.txt'"),
      }),
      CONFIG,
      SESSION,
    );
    // The command→code repair did not cause nor fix the ENOENT.
    expect(outcome.wasHealed).toBe(false);
    expect(outcome.category).toBe("PASSTHROUGH");
    expect(outcome.changes.join("; ")).toContain("counted as unrecovered");
  });

  it("appends a collapsed-call hint to an unbridgeable UNKNOWN_TOOL error", async () => {
    const exec = makeExec({ name: "bash", arguments: { command: "ls" } });
    // No tools runtime → nothing bridgeable.
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("Unknown tool: bash (only `run_code` is callable directly)"), {
          code: "UNKNOWN_TOOL",
        }),
      }),
      CONFIG,
      SESSION,
    );
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("[tool-doctor hint]");
    expect(text).toContain("run_code");
  });

  it("appends a syntax hint to an unrepaired run_code parse failure", async () => {
    // A literal newline inside a double-quoted string resists every mechanical
    // repair, so the pre-stage claims no heal and the hint path owns the error.
    const exec = makeExec({ name: "run_code", arguments: { code: 'const x = "a\nb";', description: "d" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("Unexpected token '<eof>'"), { code: "CODE_RUN_FAILED" }),
      }),
      CONFIG,
      SESSION,
    );
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("[tool-doctor hint]");
  });

  it("does not append hints when errorHints is off", async () => {
    const exec = makeExec({ name: "bash", arguments: { command: "ls" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("Unknown tool: bash (only `run_code` is callable directly)"), {
          code: "UNKNOWN_TOOL",
        }),
      }),
      { ...CONFIG, errorHints: false },
      SESSION,
    );
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).not.toContain("[tool-doctor hint]");
  });
});

describe("runPipeline — shadow mode", () => {
  const SHADOW = { ...CONFIG, shadowMode: true };

  it("claims the repair but dispatches the original arguments", async () => {
    const original = { command: "ls -la" };
    const exec = makeExec({ name: "run_code", arguments: { ...original } });
    const outcome = await runPipeline(exec, async () => textResult("ran"), SHADOW, SESSION);
    // The measurement claim stands; the host never sees the repair.
    expect(outcome.wasHealed).toBe(true);
    expect(exec.arguments).toEqual(original);
    expect(outcome.changes.join(" ")).toMatch(/shadow mode/i);
  });

  it("claims READ_ARGS yet leaves the offset untouched", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt", offset: 0 } });
    const outcome = await runPipeline(exec, async () => textResult("body"), SHADOW, SESSION);
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("READ_ARGS");
    expect((exec.arguments as Record<string, unknown>).offset).toBe(0);
  });

  it("runs no post-dispatch recovery and appends no hint", async () => {
    const nested: unknown[] = [];
    const tools = {
      get: (name: string) => ({ name }),
      execute: async (input: unknown) => {
        nested.push(input);
        return textResult("bridged");
      },
    } as never;
    const exec = makeExec({ name: "bash", arguments: { command: "ls" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        content: [{ type: "text", text: "Unknown tool: bash (only `run_code` is callable directly)" }],
      }),
      SHADOW,
      SESSION,
      { tools },
    );
    expect(nested.length).toBe(0); // the bridge never fires in shadow mode
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toBe("Unknown tool: bash (only `run_code` is callable directly)");
    expect(text).not.toContain("[tool-doctor hint]"); // original error, byte-for-byte
  });
});

describe("runPipeline — thrown dispatches", () => {
  it("re-throws the original value after recording context (protocol plane)", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt" } });
    const boom = new Error("structural failure");
    await expect(
      runPipeline(exec, async () => Promise.reject(boom), CONFIG, SESSION),
    ).rejects.toBeInstanceOf(DispatchFailureError);

    try {
      await runPipeline(exec, async () => Promise.reject(boom), CONFIG, SESSION);
    } catch (error) {
      expect(error).toBeInstanceOf(DispatchFailureError);
      const failure = error as DispatchFailureError;
      expect(failure.cause).toBe(boom); // original value preserved for re-throw
      expect(failure.outcome.result.isError).toBe(true);
    }
  });

  it("bridges a thrown UNKNOWN_TOOL before re-throwing", async () => {
    const executed: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) => ({ name }),
      execute: async (input: { name: string; arguments: unknown }) => {
        executed.push({ name: input.name, arguments: input.arguments });
        return textResult(`bridged:${input.name}`);
      },
    } as never;

    const exec = makeExec({ name: "bash", arguments: { command: "ls" } });
    const outcome = await runPipeline(
      exec,
      async () => {
        throw Object.assign(new Error("Unknown tool: bash"), { code: "UNKNOWN_TOOL" });
      },
      CONFIG,
      SESSION,
      { tools },
    );
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("UNKNOWN_TOOL");
    expect(executed.length).toBe(1);
  });
});

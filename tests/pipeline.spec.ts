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
  autoSchemaArgs: true,
  autoFuzzyEdit: true,
  autoNormalizePaths: true,
  autoKindFixes: true,
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

// A Windows-world session: absolute Windows paths keep their backslashes, so
// the quote stage (not the path-separator stage) owns the repair.
const WINDOWS_SESSION = {
  agent: undefined,
  cwd: () => "C:\\work",
  codeLanguage: () => "typescript",
};

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Fake ToolsService.execute: the host accepts BATCHES only, so a nested
 * recovery arrives as a single-call batch with model-shaped (JSON-string)
 * arguments and must settle through `results`.
 */
function batchTools(
  reply: (name: string, args: Record<string, unknown>) => ToolExecutionResult,
  capture?: Array<{ name: string; arguments: unknown }>,
): never {
  return {
    get: (name: string) => ({ name }),
    execute: async (input: { calls: Array<{ id: string; name: string; arguments: string }> }) => {
      const block = input.calls[0];
      const args = JSON.parse(block.arguments) as Record<string, unknown>;
      capture?.push({ name: block.name, arguments: args });
      // Host BatchSettlement: each settled entry is a {callId, result} pair.
      return { results: [{ callId: block.id, result: reply(block.name, args) }] };
    },
  } as never;
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
    const outcome = await runPipeline(exec, async () => textResult("body"), CONFIG, WINDOWS_SESSION);
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
    const tools = batchTools((name) => textResult(`bridged:${name}`), executed);

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
    const tools = batchTools(() => textResult("tail lines"), nestedCalls);

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
    expect(outcome.shadow).toBe(true); // the tracker must count a match, not a heal
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
    const nested: Array<{ name: string; arguments: unknown }> = [];
    const tools = batchTools(() => textResult("bridged"), nested);
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
    const tools = batchTools((name) => textResult(`bridged:${name}`), executed);

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

describe("runPipeline — whitespace-tolerant edit retry (rule 4, EDIT_WHITESPACE)", () => {
  it("retries a not-found edit with the line-ending-equivalent anchor and settles", async () => {
    const nested: Array<{ name: string; arguments: unknown }> = [];
    const tools = batchTools(() => textResult("patched"), nested);

    const exec = makeExec({
      name: "edit",
      arguments: { file_path: "/a.txt", old_string: "alpha\nbeta", new_string: "x" },
    });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("old_string not found in file"), {
          code: "FS_EDIT_NOT_FOUND",
        }),
      }),
      CONFIG,
      SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("EDIT_WHITESPACE");
    const editRetries = nested.filter((call) => call.name === "edit");
    expect(editRetries).toHaveLength(1); // terminal success: no anchor-refresh read
    const retryArgs = editRetries[0].arguments as Record<string, unknown>;
    expect(retryArgs.old_string).toBe("alpha\r\nbeta"); // host's spelling adopted
    expect(outcome.result.content?.[0]).toMatchObject({ text: "patched" });
  });

  it("keeps the original not-found error authoritative when every variant fails", async () => {
    const nested: Array<{ name: string; arguments: unknown }> = [];
    const tools = batchTools(
      () => ({
        isError: true,
        error: Object.assign(new Error("old_string not found in file"), {
          code: "FS_EDIT_NOT_FOUND",
        }),
      }),
      nested,
    );

    const exec = makeExec({
      name: "edit",
      arguments: { file_path: "/a.txt", old_string: "alpha\nbeta", new_string: "x" },
    });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: Object.assign(new Error("original anchor miss"), {
          code: "FS_EDIT_NOT_FOUND",
        }),
      }),
      CONFIG,
      SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(false);
    expect(nested.filter((call) => call.name === "edit")).toHaveLength(1); // one variant, tried once
    expect(outcome.result.error).toMatchObject({ message: "original anchor miss" });
  });
});

describe("runPipeline — payload-shape and path-family rules (9 / 3)", () => {
  it("unwraps a JSON-string arguments payload (ARGS_UNWRAP)", async () => {
    const exec = makeExec({
      name: "read",
      arguments: '{"file_path": "/a.txt"}',
    });
    const outcome = await runPipeline(exec, async () => textResult("body"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("ARGS_UNWRAP");
    expect(exec.arguments).toEqual({ file_path: "/a.txt" });
  });

  it("normalizes backslash paths on a POSIX host (PATH_SEPARATORS)", async () => {
    const exec = makeExec({
      name: "read",
      arguments: { file_path: "/home/user\\docs\\a.txt" },
    });
    const outcome = await runPipeline(exec, async () => textResult("body"), CONFIG, SESSION);
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("PATH_SEPARATORS");
    expect((exec.arguments as Record<string, unknown>).file_path).toBe("/home/user/docs/a.txt");
  });
});

describe("runPipeline — routing & kind rules (2 / 10) and the truncation hint", () => {
  it("retries an unknown tool under its uniquely-matching registered name (TOOL_NAME)", async () => {
    const nested: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      // Name drift means NO exact registered name — the bridge must pass.
      get: () => undefined,
      schemas: () => [{ name: "run_code" }, { name: "mcp__shell__bash" }, { name: "read" }],
      execute: async (input: { calls: Array<{ name: string; arguments: string }> }) => {
        const block = input.calls[0];
        nested.push({ name: block.name, arguments: JSON.parse(block.arguments) });
        return { results: [{ callId: "doctor", result: textResult(`ran:${block.name}`) }] };
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
    expect(outcome.category).toBe("TOOL_NAME");
    expect(nested).toEqual([{ name: "mcp__shell__bash", arguments: { command: "ls" } }]);
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("ran:mcp__shell__bash");
  });

  it("leaves the error standing when the registered plane holds two candidates", async () => {
    const nested: Array<{ name: string }> = [];
    const tools = {
      get: () => undefined,
      schemas: () => [{ name: "mcp__a__bash" }, { name: "mcp__b__bash" }],
      execute: async (input: { calls: Array<{ name: string }> }) => {
        nested.push({ name: input.calls[0].name });
        return { results: [{ callId: "doctor", result: textResult("unreachable") }] };
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

    expect(outcome.wasHealed).toBe(false);
    expect(nested).toHaveLength(0); // ambiguity is never guessed
    expect(outcome.result.error).toMatchObject({ message: "Unknown tool: bash" });
  });

  it("adopts a REAL failure from the canonical dispatch over the stale UNKNOWN_TOOL", async () => {
    const tools = {
      get: () => undefined,
      schemas: () => [{ name: "mcp__shell__bash" }],
      execute: async () => ({
        results: [
          {
            callId: "doctor",
            result: {
              isError: true,
              error: new Error("command failed: ls: /nope: No such file or directory"),
            },
          },
        ],
      }),
    } as never;

    const exec = makeExec({ name: "bash", arguments: { command: "ls /nope" } });
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

    // The call the model MEANT ran and failed — its error is authoritative
    // (same settle semantics as the bridge), not the false "Unknown tool".
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("TOOL_NAME");
    expect(outcome.result.error).toMatchObject({
      message: "command failed: ls: /nope: No such file or directory",
    });
  });

  it("keeps the original error when the canonical name is unknown AGAIN", async () => {
    const tools = {
      get: () => undefined,
      schemas: () => [{ name: "mcp__shell__bash" }], // enumeration is stale
      execute: async () => ({
        results: [
          {
            callId: "doctor",
            result: {
              isError: true,
              error: Object.assign(new Error("Unknown tool: mcp__shell__bash"), {
                code: "UNKNOWN_TOOL",
              }),
            },
          },
        ],
      }),
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

    expect(outcome.wasHealed).toBe(false);
    expect(outcome.result.error).toMatchObject({ message: "Unknown tool: bash" });
  });

  it("lists a directory the file reader hit, via the plane's listing tool (KIND_CORRECTION)", async () => {
    const nested: Array<{ name: string; arguments: unknown }> = [];
    const tools = {
      get: (name: string) =>
        name === "list_directory"
          ? {
              name,
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            }
          : undefined,
      schemas: () => [{ name: "read" }, { name: "list_directory" }],
      execute: async (input: { calls: Array<{ name: string; arguments: string }> }) => {
        const block = input.calls[0];
        nested.push({ name: block.name, arguments: JSON.parse(block.arguments) });
        return {
          results: [{ callId: "doctor", result: textResult("file1.txt\nfile2.txt") }],
        };
      },
    } as never;

    const exec = makeExec({ name: "read", arguments: { file_path: "C:\\proj\\src" } });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        // Verbatim host message for a directory read.
        error: new Error('cannot read "C:\\proj\\src": not a regular file'),
      }),
      CONFIG,
      WINDOWS_SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("KIND_CORRECTION");
    expect(nested).toEqual([{ name: "list_directory", arguments: { path: "C:\\proj\\src" } }]);
  });

  it("stays silent when the plane offers no listing tool", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/proj/src" } });
    const tools = {
      get: () => undefined,
      schemas: () => [{ name: "read" }, { name: "write" }],
      execute: async () => ({ results: [{ callId: "doctor", result: textResult("unreachable") }] }),
    } as never;

    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: new Error('cannot read "/proj/src": not a regular file'),
      }),
      CONFIG,
      SESSION,
      { tools },
    );

    expect(outcome.wasHealed).toBe(false);
    expect(outcome.category).toBe("PASSTHROUGH");
    expect(outcome.result.error).toMatchObject({ message: 'cannot read "/proj/src": not a regular file' });
  });

  it("appends the truncation hint when raw arguments cut off mid-string", async () => {
    const exec = makeExec({
      name: "write",
      // Cut inside the string value: every repair stage honestly fails.
      arguments: '{"file_path": "/a.txt", "content": "console.log(1)',
    });
    const outcome = await runPipeline(
      exec,
      async () => ({
        isError: true,
        error: new Error('invalid arguments for "write": expected an object'),
      }),
      CONFIG,
      SESSION,
    );

    expect(outcome.wasHealed).toBe(false);
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("end mid-value");
    expect(text).toContain("Nothing was repaired.");
  });

  it("keeps the truncation hint off when the arguments are a healthy object", async () => {
    const exec = makeExec({ name: "read", arguments: { file_path: "/a.txt" } });
    const outcome = await runPipeline(
      exec,
      async () => ({ isError: true, error: new Error("ENOENT: no such file or directory") }),
      CONFIG,
      SESSION,
    );
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).not.toContain("mid-value");
  });
});

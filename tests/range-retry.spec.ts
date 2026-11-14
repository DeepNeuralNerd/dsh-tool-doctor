/**
 * Stage 10 (range-retry): the two error shapes it can clamp, the retry
 * argument it sends, and the do-no-harm rule — a failed retry must keep the
 * original error, never the second-layer one.
 */
import { describe, expect, it } from "vitest";
import { rangeRetryStage, lineCountFromRangeError, argMaxFromError } from "../src/stages/range-retry.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import type { StageEnv } from "../src/core/stage.ts";
import type {
  DoctorConfig,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolRuntime,
} from "../src/types.ts";

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

function makeEnv(tools?: ToolRuntime): StageEnv {
  return {
    config: { ...CONFIG },
    agent: undefined,
    tools,
    cwd: () => "/workspace",
    codeLanguage: () => "typescript",
  };
}

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }] };
}

function failResult(message: string): ToolExecutionResult {
  return { isError: true, content: [{ type: "text", text: message }], error: new Error(message) };
}

/** Capturing nested dispatcher; `reply` decides what each nested call returns. */
function captureTools(
  reply: (name: string, args: Record<string, unknown>) => ToolExecutionResult,
): { tools: ToolRuntime; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = {
    get: (name: string) => ({ name }),
    execute: async (input: { name: string; arguments: unknown }) => {
      const args = (input.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: input.name, args });
      return reply(input.name, args);
    },
  } as unknown as ToolRuntime;
  return { tools, calls };
}

describe("range-retry — error-shape parsing", () => {
  it("reads the real line count from the EOF shape", () => {
    expect(lineCountFromRangeError(failResult('offset 500 is out of range for "/a.txt" (42 lines)'))).toBe(42);
  });

  it("reads the window ceiling from the view_range shape", () => {
    expect(lineCountFromRangeError(failResult("view_range must be within [1, 120]"))).toBe(120);
  });

  it("reads the schema maximum and names the capped argument", () => {
    expect(argMaxFromError(failResult("invalid arguments: limit must be less than or equal to 2000"))).toEqual({
      arg: "limit",
      max: 2000,
    });
    expect(argMaxFromError(failResult("invalid arguments: offset must be at most 7"))).toEqual({
      arg: "offset",
      max: 7,
    });
  });

  it("returns undefined for errors that name no bound", () => {
    const result = failResult("old_string was not found");
    expect(lineCountFromRangeError(result)).toBeUndefined();
    expect(argMaxFromError(result)).toBeUndefined();
  });
});

describe("range-retry — inspect gating", () => {
  it("matches the read EOF shape with a numeric offset", () => {
    const exec = makeExec({ arguments: { file_path: "/a.txt", offset: 999999 } });
    const payload = rangeRetryStage.inspect(
      exec,
      failResult('offset 999999 is out of range for "/a.txt" (57 lines)'),
      makeEnv({} as ToolRuntime),
    ) as { kind: string; lineCount: number };
    expect(payload.kind).toBe("lines");
    expect(payload.lineCount).toBe(57);
  });

  it("needs the tools runtime to attempt a retry", () => {
    const exec = makeExec({ arguments: { file_path: "/a.txt", offset: 999999 } });
    expect(
      rangeRetryStage.inspect(exec, failResult('offset 999999 is out of range for "/a.txt" (57 lines)'), makeEnv(undefined)),
    ).toBeUndefined();
  });

  it("matches the schema-max shape only when the argument really exceeds the cap", () => {
    const env = makeEnv({} as ToolRuntime);
    const failure = failResult("invalid arguments: limit must be less than or equal to 2000");
    const over = rangeRetryStage.inspect(makeExec({ arguments: { file_path: "/a.json", limit: 999999 } }), failure, env) as {
      kind: string;
      argMax: { arg: string; max: number };
    };
    expect(over.kind).toBe("argmax");
    expect(over.argMax).toEqual({ arg: "limit", max: 2000 });

    // Within the cap the rejection cannot be about this argument's value.
    expect(rangeRetryStage.inspect(makeExec({ arguments: { limit: 100 } }), failure, env)).toBeUndefined();
    // Missing argument: nothing to clamp.
    expect(rangeRetryStage.inspect(makeExec({ arguments: {} }), failure, env)).toBeUndefined();
  });

  it("passes successes through", () => {
    expect(
      rangeRetryStage.inspect(makeExec({ arguments: { offset: 9 } }), textResult("fine"), makeEnv({} as ToolRuntime)),
    ).toBeUndefined();
  });
});

describe("range-retry — recover", () => {
  it("re-dispatches the read with the offset clamped to the last valid line", async () => {
    const original = failResult('offset 999999 is out of range for "/a.txt" (57 lines)');
    const exec = makeExec({ arguments: { file_path: "/a.txt", offset: 999999 } });
    const { tools, calls } = captureTools(() => textResult("tail content"));
    const outcome = (await rangeRetryStage.recover(
      exec,
      makeEnv(tools),
      { kind: "lines", lineCount: 57, original },
    ))!;
    expect(calls.length).toBe(1);
    expect(calls[0].args.offset).toBe(57);
    expect(outcome.result?.isError).not.toBe(true);
    expect(outcome.changeLabel).toContain("57");
  });

  it("re-dispatches a capped argument at the stated maximum", async () => {
    const original = failResult("invalid arguments: limit must be less than or equal to 2000");
    const exec = makeExec({ arguments: { file_path: "/a.json", limit: 999999 } });
    const { tools, calls } = captureTools(() => textResult("first 2000 lines"));
    const outcome = (await rangeRetryStage.recover(
      exec,
      makeEnv(tools),
      { kind: "argmax", argMax: { arg: "limit", max: 2000 }, original },
    ))!;
    expect(calls[0].args.limit).toBe(2000);
    expect(outcome.result?.isError).not.toBe(true);
    expect(outcome.changeLabel).toContain("limit");
    expect(outcome.changeLabel).toContain("2000");
  });

  it("keeps the original error when the retry still fails (do-no-harm)", async () => {
    const original = failResult('offset 999999 is out of range for "/a.txt" (57 lines)');
    const exec = makeExec({ arguments: { file_path: "/a.txt", offset: 999999 } });
    const transport = failResult("Nested recovery of 'read' through 'read' failed: channel broke");
    const { tools } = captureTools(() => transport);
    const outcome = (await rangeRetryStage.recover(
      exec,
      makeEnv(tools),
      { kind: "lines", lineCount: 57, original },
    ))!;
    // The model keeps the error that states the bound it can act on.
    expect(outcome.result).toBe(original);
    expect(outcome.changeLabel).toContain("retry still failed");
    expect(outcome.changeLabel).toContain("channel broke");
    expect(outcome.changeLabel).toContain("original error kept");
  });

  it("does nothing when the clamp changes no value", async () => {
    const original = failResult('offset 5 is out of range for "/a.txt" (57 lines)');
    const exec = makeExec({ arguments: { file_path: "/a.txt", offset: 5 } });
    const { tools, calls } = captureTools(() => textResult("never"));
    const outcome = await rangeRetryStage.recover(exec, makeEnv(tools), {
      kind: "lines",
      lineCount: 57,
      original,
    });
    expect(outcome).toBeUndefined();
    expect(calls.length).toBe(0);
  });
});

describe("range-retry — through the pipeline (live shape end-to-end)", () => {
  it("clamps a schema-capped limit and adopts the successful retry", async () => {
    const nested = captureTools(() => textResult("2000 lines of content"));
    const exec = makeExec({ arguments: { file_path: "/a.json", limit: 999999 } });
    let first = true;
    const outcome = await runPipeline(
      exec,
      async () => {
        if (first) {
          first = false;
          return failResult("invalid arguments: limit must be less than or equal to 2000");
        }
        return textResult("unreachable");
      },
      { ...CONFIG },
      { agent: undefined, cwd: () => "/workspace", codeLanguage: () => "typescript" },
      { tools: nested.tools },
    );
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("RANGE_CLAMP");
    expect(nested.calls.length).toBe(1);
    expect(nested.calls[0].args.limit).toBe(2000);
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("2000 lines of content");
  });

  it("keeps the original error when the clamped retry fails", async () => {
    const nested = captureTools(() => failResult("second-layer failure"));
    const exec = makeExec({ arguments: { file_path: "/a.json", limit: 999999 } });
    const outcome = await runPipeline(
      exec,
      async () => failResult("invalid arguments: limit must be less than or equal to 2000"),
      { ...CONFIG },
      { agent: undefined, cwd: () => "/workspace", codeLanguage: () => "typescript" },
      { tools: nested.tools },
    );
    const text = (outcome.result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("limit must be less than or equal to 2000");
    expect(text).not.toContain("second-layer");
    // The repair was attempted and failed — counted honestly as healedFailed.
    expect(outcome.wasHealed).toBe(true);
    expect(outcome.category).toBe("RANGE_CLAMP");
  });
});

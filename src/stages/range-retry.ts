/**
 * Stage 10 — range clamp retry (RANGE_CLAMP).
 *
 * When the host rejects a range call and names the valid bound in its error,
 * re-run it clamped through the nested dispatcher:
 *   - `str_replace_editor` view_range errors name the valid window
 *     (`view_range must be within [1, N]`) → clamp both ends to N.
 *   - `read` offset past EOF names the line count
 *     (`offset 500 is out of range for "…" (42 lines)`) → clamp the offset to
 *     the last valid line.
 *   - schema-maximum rejections name the argument and its ceiling
 *     (`limit must be less than or equal to 2000`) → clamp that argument to it.
 * The pre-dispatch editor-range stage cannot know the file length; this stage
 * owns the ceiling half of RANGE_CLAMP. One retry per original call: nested
 * dispatches carry the :doctor: marker and never re-enter this stage.
 *
 * Do-no-harm: a retry that STILL fails never replaces the original error.
 * The original message states the bound the model can act on; a second-layer
 * or transport error would only obscure it. The record stays honest either
 * way — the pipeline counts the owned RANGE_CLAMP outcome as repaired-but-
 * failed, and the change label says what the retry reported.
 *
 * @module dsh-tool-doctor/stages/range-retry
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution, ToolExecutionResult } from "../types.ts";
import { objectValue } from "../core/util.ts";
import { errorText, resultErrorText } from "../core/result.ts";
import { normalizeEditorArguments } from "../repair/range-clamper.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";

/** The real line count the host reported in a range rejection, when present. */
export function lineCountFromRangeError(result: ToolExecutionResult): number | undefined {
  const text = errorText(result.error) ?? "";
  // str_replace_editor: `view_range must be within [1, N]` (or similar).
  const windowMatch = /view_range[^\n]*\[\s*1\s*,\s*(\d+)\s*\]/i.exec(text);
  if (windowMatch?.[1]) return Number(windowMatch[1]);
  // read: `offset N is out of range for "…" (M lines)`.
  const eofMatch = /is out of range[^\n]*\((\d+) lines?\)/iu.exec(text);
  if (eofMatch?.[1]) return Number(eofMatch[1]);
  return undefined;
}

/** A numeric argument the host capped, named in its rejection with the maximum. */
export interface ArgMax {
  /** The argument name as it appears in the tool's arguments. */
  arg: string;
  /** The inclusive maximum the host stated. */
  max: number;
}

/**
 * `invalid arguments: limit must be less than or equal to 2000` — the schema
 * boundary shape. The host names the offending argument and its ceiling, so
 * the clamped value is exact, not guessed.
 */
export function argMaxFromError(result: ToolExecutionResult): ArgMax | undefined {
  const text = resultErrorText(result) ?? errorText(result.error) ?? "";
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s+must be (?:less than or equal to|at most)\s+(\d+)/iu.exec(
    text,
  );
  if (!match?.[1] || !match[2]) return undefined;
  const max = Number(match[2]);
  if (!Number.isFinite(max)) return undefined;
  return { arg: match[1], max };
}

/** What the stage matched; carries the original result for the do-no-harm return. */
type RangePayload =
  | { kind: "lines"; lineCount: number; original: ToolExecutionResult }
  | { kind: "argmax"; argMax: ArgMax; original: ToolExecutionResult };

export const rangeRetryStage: PostStage = {
  phase: "post",
  id: "range-retry",
  label: "Range clamp retry (RANGE_CLAMP)",
  ruleNumber: 3,
  enabledBy: "autoClampRanges",
  category: "RANGE_CLAMP",
  inspect(exec, result, env) {
    if (!env.config.autoClampRanges || !env.tools) return undefined;
    if (result.isError !== true) return undefined;

    const lineCount = lineCountFromRangeError(result);
    if (lineCount !== undefined) {
      // Only the two line-count shapes this stage can clamp are worth a retry.
      if (exec.name === "read") {
        const args = objectValue(exec.arguments);
        if (!args || typeof args["offset"] !== "number") return undefined;
      } else if (exec.name !== "str_replace_editor") {
        return undefined;
      }
      return { kind: "lines", lineCount, original: result } satisfies RangePayload;
    }

    // Schema-maximum shape: the named argument must currently exceed the cap,
    // or the rejection was not caused by our argument value.
    const argMax = argMaxFromError(result);
    if (argMax === undefined) return undefined;
    const args = objectValue(exec.arguments);
    const value = args?.[argMax.arg];
    if (typeof value !== "number" || value <= argMax.max) return undefined;
    return { kind: "argmax", argMax, original: result } satisfies RangePayload;
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload?: unknown,
  ): Promise<RecoveryOutcome | undefined> {
    const tools = env.tools!;
    const plan = payload as RangePayload;
    const { original } = plan;

    let clamped: Record<string, unknown>;
    let toolName: string;
    let changeLabel: string;
    if (plan.kind === "lines" && exec.name === "read") {
      // Clamp the offset to the last valid line and re-dispatch.
      const args = objectValue(exec.arguments)!;
      clamped = { ...args };
      clamped["offset"] = Math.min(Number(args["offset"]), plan.lineCount);
      if (clamped["offset"] === args["offset"]) return undefined; // nothing to fix
      toolName = "read";
      changeLabel = `Clamped read offset past EOF to the last valid line (${plan.lineCount} lines)`;
    } else if (plan.kind === "lines") {
      // str_replace_editor: re-normalize with the real ceiling.
      const normalized = normalizeEditorArguments(
        exec.name,
        exec.arguments,
        env.cwd() ?? process.cwd(),
        plan.lineCount,
        true,
      );
      if (JSON.stringify(normalized) === JSON.stringify(exec.arguments)) return undefined;
      clamped = normalized as Record<string, unknown>;
      toolName = "str_replace_editor";
      changeLabel = `Corrected view_range to real file line count (${plan.lineCount} lines)`;
    } else {
      // Schema maximum: clamp the named argument to the stated cap.
      const args = objectValue(exec.arguments)!;
      clamped = { ...args };
      clamped[plan.argMax.arg] = Math.min(Number(args[plan.argMax.arg]), plan.argMax.max);
      toolName = exec.name;
      changeLabel = `Clamped ${plan.argMax.arg} to its maximum (${plan.argMax.max})`;
    }

    const retried = await executeNestedTool(exec, tools, toolName, clamped, "range-retry");
    if (retried.isError === true) {
      // Do-no-harm: the retry bought nothing; the model keeps the original,
      // actionable error instead of a second-layer failure.
      return {
        result: original,
        args: clamped,
        changeLabel: `${changeLabel}; retry still failed (${
          resultErrorText(retried) ?? "unknown error"
        }) — original error kept`,
      };
    }
    return { result: retried, args: clamped, changeLabel };
  },
};

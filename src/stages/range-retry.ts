/**
 * Stage 10 — range clamp retry (RANGE_CLAMP).
 *
 * When the host rejects a range call and reports the real file length in the
 * error, re-run it clamped through the nested dispatcher:
 *   - `str_replace_editor` view_range errors name the valid window
 *     (`view_range must be within [1, N]`) → clamp both ends to N.
 *   - `read` offset past EOF names the line count
 *     (`offset 500 is out of range for "…" (42 lines)`) → clamp the offset to
 *     the last valid line.
 * The pre-dispatch editor-range stage cannot know the file length; this stage
 * owns the ceiling half of RANGE_CLAMP. One retry per original call: nested
 * dispatches carry the :doctor: marker and never re-enter this stage.
 *
 * @module dsh-tool-doctor/stages/range-retry
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution, ToolExecutionResult } from "../types.ts";
import { objectValue } from "../core/util.ts";
import { errorText, resultHasCode } from "../core/result.ts";
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

export const rangeRetryStage: PostStage = {
  phase: "post",
  id: "range-retry",
  label: "Range clamp retry (RANGE_CLAMP)",
  ruleNumber: 3,
  category: "RANGE_CLAMP",
  inspect(exec, result, env) {
    if (!env.config.autoClampRanges || !env.tools) return undefined;
    if (result.isError !== true) return undefined;
    const lineCount = lineCountFromRangeError(result);
    if (lineCount === undefined) return undefined;
    // Only the two shapes this stage can clamp are worth a retry.
    if (exec.name === "read") {
      const args = objectValue(exec.arguments);
      if (!args || typeof args["offset"] !== "number") return undefined;
    } else if (exec.name !== "str_replace_editor") {
      return undefined;
    }
    return lineCount; // payload: number
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload?: unknown,
  ): Promise<RecoveryOutcome | undefined> {
    const tools = env.tools!;
    const lineCount = payload as number;

    if (exec.name === "read") {
      // Clamp the offset to the last valid line and re-dispatch.
      const args = objectValue(exec.arguments)!;
      const clamped: Record<string, unknown> = { ...args };
      clamped["offset"] = Math.min(Number(args["offset"]), lineCount);
      if (clamped["offset"] === args["offset"]) return undefined; // nothing to fix
      const retried = await executeNestedTool(exec, tools, "read", clamped, "range-retry");
      return {
        result: retried,
        args: clamped,
        changeLabel: `Clamped read offset past EOF to the last valid line (${lineCount} lines)`,
      };
    }

    // str_replace_editor: re-normalize with the real ceiling.
    const normalized = normalizeEditorArguments(
      exec.name,
      exec.arguments,
      env.cwd() ?? process.cwd(),
      lineCount,
      true,
    );
    if (JSON.stringify(normalized) === JSON.stringify(exec.arguments)) return undefined;
    const retried = await executeNestedTool(
      exec,
      tools,
      "str_replace_editor",
      normalized,
      "range-retry",
    );
    return {
      result: retried,
      args: normalized,
      changeLabel: `Corrected view_range to real file line count (${lineCount} lines)`,
    };
  },
};

/**
 * Stage 8 — retry after file observation (FS_OBSERVED).
 *
 * Guarded mutations (edit / write / str_replace_editor str_replace|insert)
 * must have read their target first; the host enforces this with
 * FS_NOT_OBSERVED, and re-validates freshness with FS_STALE_VERSION. Both are
 * state-sync failures, not argument errors: one nested read of the target
 * updates the observation, then the SAME mutation runs again through the host
 * dispatcher. The failure triggers the work — normal edits pay no extra call —
 * and the retry is bounded to exactly one read + one re-dispatch per original
 * call (nested dispatches carry the :doctor: marker and never re-enter this
 * stage).
 *
 * @module dsh-tool-doctor/stages/observe-retry
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution, ToolExecutionResult } from "../types.ts";
import { editPath, isObservationMutation } from "../core/util.ts";
import { resultHasCode } from "../core/result.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";

export const observeRetryStage: PostStage = {
  phase: "post",
  id: "observe-retry",
  label: "Retry after file observation (FS_OBSERVED)",
  ruleNumber: 4,
  enabledBy: "autoObserveFiles",
  category: "FS_OBSERVED",
  roundTrips: 2,
  inspect(exec, result, env) {
    if (!env.config.autoObserveFiles || !env.tools) return undefined;
    const stale = resultHasCode(result, "FS_STALE_VERSION");
    if (!stale && !resultHasCode(result, "FS_NOT_OBSERVED")) return undefined;
    // Only guarded mutations can be observed-and-retried this way.
    if (!isObservationMutation(exec.name, exec.arguments)) return undefined;
    if (editPath(exec.arguments) === undefined) return undefined;
    return stale; // payload: whether this is a stale-version retry
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload?: unknown,
  ): Promise<RecoveryOutcome | undefined> {
    const tools = env.tools!;
    const path = editPath(exec.arguments)!;

    // One read of the target updates the host's observation state. Best-effort
    // by construction: if it fails, the retry below still runs and either
    // succeeds (observation came from elsewhere) or fails with an honest error.
    await executeNestedTool(exec, tools, "read", { file_path: path }, "observe-read");

    const retried = await executeNestedTool(
      exec,
      tools,
      exec.name,
      exec.arguments ?? {},
      "observe-retry",
    );
    return {
      result: retried,
      preview: `Read ${path} then retry`,
      changeLabel: payload
        ? "Re-read latest version then retried mutation"
        : "Read target file then retried mutation",
    };
  },
};

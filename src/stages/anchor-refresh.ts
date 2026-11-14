/**
 * Stage 9 — anchor-failure observation refresh (FS_OBSERVED, side-effect only).
 *
 * FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT mean the model's old_string no longer
 * matches the file. Blindly re-running the same edit cannot help, but a
 * best-effort nested read still updates the observed version so the model's
 * next retry is not additionally blocked by an observation failure. The
 * original error stays authoritative: this stage never replaces the result and
 * never claims a heal — it records its label for diagnostics only.
 *
 * @module dsh-tool-doctor/stages/anchor-refresh
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution } from "../types.ts";
import { editPath } from "../core/util.ts";
import { resultHasCode } from "../core/result.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";

export const anchorRefreshStage: PostStage = {
  phase: "post",
  id: "anchor-refresh",
  label: "Anchor-failure observation refresh (FS_OBSERVED)",
  ruleNumber: 4,
  category: "FS_OBSERVED",
  claimsHeal: false,
  inspect(exec, result, env) {
    if (!env.config.autoObserveFiles || !env.tools) return undefined;
    if (result.isError !== true) return undefined;
    if (
      !resultHasCode(result, "FS_EDIT_NOT_FOUND") &&
      !resultHasCode(result, "FS_AMBIGUOUS_EDIT")
    ) {
      return undefined;
    }
    // Only edits carry an anchor to refresh.
    if (exec.name !== "edit" && exec.name !== "str_replace_editor") return undefined;
    if (editPath(exec.arguments) === undefined) return undefined;
    return true;
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
  ): Promise<RecoveryOutcome | undefined> {
    const path = editPath(exec.arguments)!;
    // Best-effort (internally caught by the nested dispatcher): the original
    // error stays authoritative either way.
    await executeNestedTool(
      exec,
      env.tools!,
      "read",
      { file_path: path },
      "anchor-read",
    );
    return {
      changeLabel: "Pre-read to refresh file observation state for next retry",
    };
  },
};

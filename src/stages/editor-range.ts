/**
 * Stage 2 — editor range & session path (RANGE_CLAMP).
 *
 * Pre-dispatch structural fix for `edit` / `str_replace_editor`: relative-path
 * resolution (str_replace_editor alone rejects relatives outright) and a
 * structurally valid `view_range` (1-based floor, end >= start). The ceiling
 * clamp against the real file length is impossible pre-dispatch — that half
 * lives in the range-retry post-stage, which runs after the host reports the
 * line count.
 *
 * @module dsh-tool-doctor/stages/editor-range
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { normalizeEditorArguments } from "../repair/range-clamper.ts";

export const editorRangeStage: PreStage = {
  phase: "pre",
  id: "editor-range",
  label: "Editor range & session path (RANGE_CLAMP)",
  ruleNumber: 3,
  category: "RANGE_CLAMP",
  roundTrips: 1,
  matchesError: (code, text) =>
    /absolute path|view_range|view range|number of lines|out of/i.test(text ?? "") ||
    code === "FS_NOT_FOUND",
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoClampRanges) return undefined;
    if (toolName !== "edit" && toolName !== "str_replace_editor") return undefined;
    const normalized = normalizeEditorArguments(
      toolName,
      args,
      env.cwd() ?? process.cwd(),
      undefined,
      toolName === "str_replace_editor",
    );
    if (JSON.stringify(normalized) === JSON.stringify(args)) return undefined;
    return {
      args: normalized,
      changes: ["Normalized editor path/range"],
      category: "RANGE_CLAMP",
    };
  },
};

/**
 * Stage 3 — read argument correction (READ_ARGS).
 *
 * Off-by-one index fix for the read/glob/grep family: `offset: 0` → `1`,
 * `limit: 0` → `1`. The host rejects zero-based indices; the model emits them
 * constantly. Pure pre-dispatch clamp — no I/O, no retry needed when it fires.
 *
 * @module dsh-tool-doctor/stages/read-args
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { normalizeReadArguments } from "../repair/range-clamper.ts";

export const readArgsStage: PreStage = {
  phase: "pre",
  id: "read-args",
  label: "Read argument correction (READ_ARGS)",
  ruleNumber: 1,
  enabledBy: "autoClampRanges",
  category: "READ_ARGS",
  roundTrips: 1,
  matchesError: (code, text) =>
    code === "INVALID_ARGS" || /offset|start|limit/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoClampRanges) return undefined;
    const normalized = normalizeReadArguments(toolName, args);
    if (normalized === undefined) return undefined;
    return {
      args: normalized,
      changes: ["Fixed offset/start argument (0→1 base correction)"],
      category: "READ_ARGS",
    };
  },
};

/**
 * Stage 14 — whitespace-tolerant edit retry (EDIT_WHITESPACE). Rule 4.
 *
 * When an edit fails because `old_string` was not found, the anchor may still
 * exist in the file under a whitespace-equivalent spelling (CRLF vs LF, tabs
 * vs spaces, trailing whitespace). This post-stage regenerates the anchor's variants
 * (repair/whitespace-anchor) and retries the ORIGINAL edit through the host
 * dispatcher once per variant, stopping at the first success. The host is the
 * match authority: a variant that matches ambiguously is rejected by the host,
 * so the original not-found error stays authoritative on every failure.
 * Runs before anchor-refresh so a successful retry skips the refresh entirely.
 *
 * @module dsh-tool-doctor/stages/anchor-whitespace
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution, ToolExecutionResult } from "../types.ts";
import { editPath } from "../core/util.ts";
import { errorCode, resultErrorText } from "../core/result.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";
import { editAnchorVariants } from "../repair/whitespace-anchor.ts";

/** The anchor parameter names by tool. */
const ANCHOR_KEYS = ["old_string", "old_str"] as const;

interface WhitespacePayload {
  args: Record<string, unknown>;
  anchorKey: (typeof ANCHOR_KEYS)[number];
  variants: string[];
}

function isNotFoundFailure(result: ToolExecutionResult): boolean {
  if (result.isError !== true) return false;
  if (errorCode(result.error) === "FS_EDIT_NOT_FOUND") return true;
  // Hosts without stable codes: an explicit not-found message on an edit.
  const text = resultErrorText(result) ?? "";
  return /old_string|string to (?:replace|search)|no match|not found/i.test(text) &&
    !/multiple|ambiguous|appears \d+ times/i.test(text);
}

export const anchorWhitespaceStage: PostStage = {
  phase: "post",
  id: "anchor-whitespace",
  label: "Whitespace-tolerant edit retry (EDIT_WHITESPACE)",
  ruleNumber: 4,
  enabledBy: "autoFuzzyEdit",
  category: "EDIT_WHITESPACE",
  roundTrips: 2,
  matchesError: (code, text) =>
    code === "FS_EDIT_NOT_FOUND" ||
    /old_string|string to replace|no match/i.test(text ?? ""),
  inspect(exec, result, env): WhitespacePayload | undefined {
    if (!env.config.autoFuzzyEdit || !env.tools) return undefined;
    if (exec.name !== "edit" && exec.name !== "str_replace_editor") return undefined;
    if (!isNotFoundFailure(result)) return undefined;
    if (editPath(exec.arguments) === undefined) return undefined;
    const args = exec.arguments as Record<string, unknown>;
    const anchorKey = ANCHOR_KEYS.find((key) => typeof args[key] === "string");
    if (anchorKey === undefined) return undefined;
    const variants = editAnchorVariants(String(args[anchorKey]));
    if (variants.length === 0) return undefined;
    return { args, anchorKey, variants };
  },
  async recover(exec, env, payload): Promise<RecoveryOutcome | undefined> {
    const { args, anchorKey, variants } = payload as WhitespacePayload;
    for (const [index, variant] of variants.entries()) {
      const retryArgs = { ...args, [anchorKey]: variant };
      const result = await executeNestedTool(
        exec,
        env.tools!,
        exec.name,
        retryArgs,
        `whitespace-retry-${index}`,
      );
      if (result.isError !== true) {
        return {
          result,
          args: retryArgs,
          changeLabel: "Retried edit with whitespace-equivalent anchor (line-ending/indent/trailing-space flip)",
        };
      }
    }
    return undefined; // every variant failed; the original error stays authoritative
  },
  terminal: true,
};

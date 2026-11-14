/**
 * Stage 7 — UNKNOWN_TOOL safe recovery (UNKNOWN_TOOL). Terminal.
 *
 * A host that exposes Code-Mode collapse through the waterfall may return
 * UNKNOWN_TOOL for a direct call whose tool is registered in scope but hidden
 * from the extensible plane. This is a protocol-plane fix (routing), not an
 * argument repair: the model's call was fine. The stage re-dispatches through
 * the public runtime dispatcher as a nested call, preserving agent scope,
 * session ownership and cancellation. Terminal: it settles immediately with
 * its own bookkeeping — no honest-attribution pass or hint append after a
 * successful bridge (the real result is authoritative).
 *
 * A collapsed call rejected in createExecution never reaches a plugin; that
 * remains a host limitation, not something this stage papers over.
 *
 * @module dsh-tool-doctor/stages/bridge
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution } from "../types.ts";
import { resultHasCode } from "../core/result.ts";
import { executeBridgeDirectCall, isBridgeableDirectCall } from "../recovery/direct-bridge.ts";

export const bridgeStage: PostStage = {
  phase: "post",
  id: "bridge",
  label: "Unknown-tool safe recovery (UNKNOWN_TOOL)",
  ruleNumber: 2,
  enabledBy: "autoBridgeDirectTools",
  category: "UNKNOWN_TOOL",
  roundTrips: 1,
  matchesError: (_code, text) =>
    /unknown tool|tool .*not (?:found|registered)/i.test(text ?? ""),
  terminal: true,
  inspect(exec, result, env) {
    if (!env.config.autoBridgeDirectTools || !env.tools) return undefined;
    if (!resultHasCode(result, "UNKNOWN_TOOL")) return undefined;
    if (!isBridgeableDirectCall(exec, env.tools)) return undefined;
    return true;
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
  ): Promise<RecoveryOutcome | undefined> {
    const result = await executeBridgeDirectCall(exec, env.tools!);
    return {
      result,
      preview: `Nested dispatch: ${exec.name}`,
      changeLabel: `Recovered ${exec.name} via host nested dispatch, preserving agent, session and cancellation context`,
    };
  },
};

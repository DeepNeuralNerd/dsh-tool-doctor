/**
 * Stage — tool-name canonicalization (TOOL_NAME). Rule 2 family, terminal.
 *
 * Runs AFTER the bridge: it only ever sees an UNKNOWN_TOOL the bridge could
 * not resolve via exact registered-name lookup. Those residuals include a
 * fixable subclass — NAME drift: lost case or a dropped/added MCP-style
 * namespace segment ("bash" vs "mcp__shell__bash"). Using the host's tool
 * enumeration, the stage adopts a correction ONLY when exactly one
 * registered name matches (repair/tool-name); ambiguity stays loud. On a
 * unique match the model's ORIGINAL arguments are re-dispatched under the
 * canonical name through the host runtime — scope, session and cancellation
 * preserved. Hosts without the enumeration API make this stage inert.
 *
 * @module dsh-tool-doctor/stages/tool-name
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution } from "../types.ts";
import { resultHasCode } from "../core/result.ts";
import { visibleToolNames } from "../core/tool-names.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";
import { canonicalToolName } from "../repair/tool-name.ts";

export const toolNameStage: PostStage = {
  phase: "post",
  id: "tool-name",
  label: "Tool-name canonicalization (TOOL_NAME)",
  ruleNumber: 2,
  enabledBy: "autoBridgeDirectTools",
  category: "TOOL_NAME",
  roundTrips: 1,
  matchesError: (_code, text) =>
    /unknown tool|tool .*not (?:found|registered)/i.test(text ?? ""),
  terminal: true,
  inspect(exec, result, env) {
    if (!env.config.autoBridgeDirectTools) return undefined;
    if (!resultHasCode(result, "UNKNOWN_TOOL")) return undefined;
    const names = visibleToolNames(env.tools, exec);
    if (names === undefined) return undefined;
    const canonical = canonicalToolName(exec.name, names);
    return canonical === undefined ? undefined : { canonical };
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload,
  ): Promise<RecoveryOutcome | undefined> {
    const { canonical } = payload as { canonical: string };
    const result = await executeNestedTool(
      exec,
      env.tools!,
      canonical,
      exec.arguments ?? {},
      `tool-name-${canonical}`,
    );
    if (result.isError === true) return undefined; // the original error stands
    return {
      result,
      preview: `Dispatched as ${canonical}`,
      changeLabel: `Retried "${exec.name}" under its registered name "${canonical}"`,
    };
  },
};

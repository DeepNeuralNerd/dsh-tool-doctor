/**
 * UNKNOWN_TOOL bridge: safe recovery for a direct tool call that reached the
 * extensible dispatch pipeline but was rejected as unknown by the host.
 *
 * This is a protocol-plane fix (routing), not an argument repair: the model's
 * call was fine, the deployment's collapse of Code-Mode tools hid it from the
 * waterfall. The bridge re-dispatches through the public runtime dispatcher so
 * the real result/context contract stays intact. A collapsed call rejected in
 * createExecution never reaches a plugin — that remains a host limitation, not
 * something this stage can or should paper over.
 *
 * @module dsh-tool-doctor/recovery/direct-bridge
 */

import { executeNestedTool, recoveryFailure } from "./nested-dispatch.ts";
import type { ToolDispatchExecution, ToolExecutionResult, ToolRuntime } from "../types.ts";

/**
 * Standard capabilities that may be bridged when a host exposes them to the
 * nested dispatcher. Observed in production UNKNOWN_TOOL results; membership
 * alone is never sufficient — scope visibility is checked at call time.
 */
const BRIDGEABLE_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "grep",
  "edit",
  "glob",
  "str_replace_editor",
  "job_output",
  "job_kill",
  "web_fetch",
  "web_search",
  "todo_write",
  "skill",
  "ask_user_question",
]);

/**
 * Whether the host can recover this call through a nested standard dispatch.
 * Called only after an UNKNOWN_TOOL result — probing before dispatch would
 * replace valid native calls in hosts that expose both planes.
 *
 * @param exec - Failed direct call and its scope metadata.
 * @param tools - Tool runtime registry.
 */
export function isBridgeableDirectCall(
  exec: Pick<ToolDispatchExecution, "name" | "agent" | "parent">,
  tools: ToolRuntime,
): boolean {
  if (exec.parent !== undefined || !BRIDGEABLE_TOOLS.has(exec.name)) return false;
  if (typeof tools.execute !== "function") return false;

  // The reserved transport is the only reliable plugin-visible indication that
  // this deployment supports Code-Mode recovery. The target itself must also be
  // visible in the same agent scope: an absent target cannot be made callable
  // by fabricating a code snippet.
  return (
    tools.get("run_code", exec.agent) !== undefined &&
    tools.get(exec.name, exec.agent) !== undefined
  );
}

/**
 * Re-dispatch the original call as a nested execution through the host API.
 *
 * @param exec - Direct call the surrounding pipeline could not resolve.
 * @param tools - Tool runtime service.
 * @returns The host-created canonical result, including contexts and terminal state.
 */
export async function executeBridgeDirectCall(
  exec: ToolDispatchExecution,
  tools: ToolRuntime,
): Promise<ToolExecutionResult> {
  if (typeof tools.execute !== "function") {
    return recoveryFailure(
      `Cannot recover '${exec.name}': the host tools.execute() dispatcher is unavailable.`,
    );
  }
  if (exec.signal === undefined) {
    return recoveryFailure(
      `Cannot recover '${exec.name}': the original cancellation signal is unavailable.`,
    );
  }
  if (exec.token === undefined) {
    return recoveryFailure(
      `Cannot recover '${exec.name}': the original execution token is unavailable.`,
    );
  }
  return executeNestedTool(exec, tools, exec.name, exec.arguments ?? {}, `bridge-${exec.name}`);
}

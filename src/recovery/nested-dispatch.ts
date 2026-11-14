/**
 * Nested dispatch through the host's complete execution pipeline.
 *
 * Every recovery in this plugin re-enters `tools.execute()` as a child call
 * instead of invoking tool definitions directly: that preserves result
 * materialization, policy stages, agent scope, session ownership, cancellation
 * and terminal-result handling. Child call ids carry the `:doctor:` marker so
 * the pipeline can recognize its own recoveries and never double-count or
 * self-retry them.
 *
 * @module dsh-tool-doctor/recovery/nested-dispatch
 */

import type {
  ToolDispatchExecution,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolRuntime,
} from "../types.ts";

/** Build a deterministic child call id without reusing the failed root id. */
export function nestedCallId(exec: ToolDispatchExecution, suffix: string): string {
  return `${exec.callId ?? `tool-doctor-${Date.now()}`}:doctor:${suffix}`;
}

/** Create a canonical failure for an unavailable or failed recovery path. */
export function recoveryFailure(text: string, cause?: unknown): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    ...(cause instanceof Error ? { error: cause } : {}),
  };
}

/**
 * Invoke one child through the host's complete execution pipeline.
 *
 * @param parent - The intercepted execution whose scope and cancellation must be retained.
 * @param tools - Host tool runtime (must expose `execute`).
 * @param name - Child tool name.
 * @param args - Child tool arguments.
 * @param suffix - Stable diagnostic suffix for the child call id.
 * @returns The host-created canonical result, or an explicit recovery error.
 */
export async function executeNestedTool(
  parent: ToolDispatchExecution,
  tools: ToolRuntime,
  name: string,
  args: unknown,
  suffix: string,
): Promise<ToolExecutionResult> {
  if (typeof tools.execute !== "function") {
    return recoveryFailure(
      `Cannot recover '${parent.name}': the host tools.execute() dispatcher is unavailable.`,
    );
  }
  if (parent.signal === undefined) {
    return recoveryFailure(
      `Cannot recover '${parent.name}': the original cancellation signal is unavailable.`,
    );
  }
  if (parent.token === undefined) {
    return recoveryFailure(
      `Cannot recover '${parent.name}': the original execution token is unavailable.`,
    );
  }

  const baseCallId = parent.callId ?? `tool-doctor-${Date.now()}`;
  const input: ToolExecutionInput = {
    callId: nestedCallId(parent, suffix),
    rootCallId: parent.rootCallId ?? baseCallId,
    name,
    arguments: args,
    agent: parent.agent,
    parent: parent.token,
    signal: parent.signal,
  };

  try {
    return await tools.execute(input);
  } catch (error: unknown) {
    return recoveryFailure(
      `Nested recovery of '${parent.name}' through '${name}' failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

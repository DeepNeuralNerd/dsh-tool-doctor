/**
 * Nested dispatch through the host's complete execution pipeline.
 *
 * Every recovery in this plugin re-enters `tools.execute()` as a child call
 * instead of invoking tool definitions directly: that preserves result
 * materialization, policy stages, agent scope, session ownership, cancellation
 * and terminal-result handling. The host service exposes exactly one execute,
 * and it takes a BATCH (verified against the installed ToolsService
 * declarations); the documented way to run one child is a single-call batch
 * whose block carries model-shaped, JSON-stringified arguments. The settled
 * batch hands back one result per call, in order — that first result IS the
 * recovery's outcome. Child call ids carry the `:doctor:` marker so the
 * pipeline can recognize its own recoveries and never double-count or
 * self-retry them. The batch input intentionally omits `log`: recoveries are
 * doctor mechanics and must not write transcript entries.
 *
 * @module dsh-tool-doctor/recovery/nested-dispatch
 */

import type {
  ToolBatchInput,
  ToolDispatchExecution,
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
 * Invoke one child through the host's complete execution pipeline, as a
 * single-call batch.
 *
 * @param parent - The intercepted execution whose scope and cancellation must be retained.
 * @param tools - Host tool runtime (must expose `execute`).
 * @param name - Child tool name.
 * @param args - Child tool arguments (serialized into the batch block).
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

  // The batch block carries model-shaped arguments: a JSON string the host
  // parses itself. Unserializable arguments are a doctor-side failure, never
  // a silently mangled child call.
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    return recoveryFailure(
      `Cannot recover '${parent.name}': its arguments cannot be serialized into a batch call.`,
    );
  }

  const input: ToolBatchInput = {
    calls: [{ type: "tool-call", id: nestedCallId(parent, suffix), name, arguments: serialized }],
    signal: parent.signal,
    ...(parent.agent === undefined ? {} : { agent: parent.agent }),
    // Without the step's admitted set, conditional registrations — MCP tools
    // among them — are invisible to the recovery dispatch itself.
    ...(parent.toolSet === undefined ? {} : { toolSet: parent.toolSet }),
  };

  try {
    const batch = await tools.execute(input);
    const settled = batch?.results?.[0];
    if (settled === undefined) {
      return recoveryFailure(
        `Nested recovery of '${parent.name}' through '${name}' settled no result.`,
      );
    }
    // Adoption is only complete with the child's batch-level payload: the
    // host delivers deferred contexts and turn-conclusion next to `results`,
    // not inside a settled result.
    const contexts = Array.isArray(batch.additionalContexts) ? batch.additionalContexts : [];
    const concluded = batch.concluded === true && settled.isError !== true;
    if (contexts.length === 0 && !concluded) return settled;
    return {
      ...settled,
      ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
      ...(concluded ? { concludesTurn: true } : {}),
    };
  } catch (error: unknown) {
    return recoveryFailure(
      `Nested recovery of '${parent.name}' through '${name}' failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/**
 * Enumeration bridge to the host tool plane.
 *
 * The plugin's own `ToolRuntime` view is deliberately narrow; the current
 * host service also offers `schemas(scope?, toolSet?)` (verified against the
 * installed ToolsService catalog). Stages that must REASON about which tools
 * exist — not just probe one name — go through this one guarded call site:
 * hosts without the method, or answering in an unexpected shape, yield
 * undefined and the calling stage stays silent instead of guessing.
 *
 * @module dsh-tool-doctor/core/tool-names
 */

import type { ToolDispatchExecution, ToolRuntime } from "../types.ts";

/**
 * Names of the tools callable in the execution's agent scope, or undefined
 * when the plane cannot be enumerated. Never throws.
 */
export function visibleToolNames(
  tools: ToolRuntime | undefined,
  exec: Pick<ToolDispatchExecution, "agent">,
): readonly string[] | undefined {
  if (tools === undefined || typeof tools.schemas !== "function") return undefined;
  try {
    const schemas = tools.schemas(exec.agent);
    if (!Array.isArray(schemas)) return undefined;
    const names: string[] = [];
    for (const schema of schemas) {
      if (schema !== null && typeof schema === "object" && typeof schema.name === "string") {
        names.push(schema.name);
      }
    }
    return names;
  } catch {
    return undefined; // a defensive enumeration must never break the waterfall
  }
}

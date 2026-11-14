/**
 * Pure argument/context helpers shared across stages and the pipeline.
 * Leaf module: imports only host boundary types, so it can be used anywhere
 * without a cycle.
 *
 * @module dsh-tool-doctor/core/util
 */

import type { ToolDispatchExecution } from "../types.ts";

/** A plain object (not null, not an array) as a string-keyed record. */
export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The session working directory the host exposes on the agent token. */
export function sessionCwd(agent: unknown): string | undefined {
  if (typeof agent !== "object" || agent === null) return undefined;
  const session = (agent as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return undefined;
  const header = (session as { header?: unknown }).header;
  if (typeof header !== "object" || header === null) return undefined;
  const cwd = (header as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

/** The target file path of a mutation, under either accepted parameter name. */
export function editPath(args: unknown): string | undefined {
  const object = objectValue(args);
  if (!object) return undefined;
  const path = object["file_path"] ?? object["path"];
  return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

/** Whether a tool call is a guarded mutation the host requires reading for. */
export function isObservationMutation(name: string, args: unknown): boolean {
  if (name === "edit" || name === "write") return true;
  if (name !== "str_replace_editor") return false;
  const object = objectValue(args);
  return (
    object?.["command"] === "str_replace" || object?.["command"] === "insert"
  );
}

/** A call id minted by this plugin for its own nested recovery dispatches. */
export function isSelfNestedExec(exec: ToolDispatchExecution): boolean {
  return (
    typeof exec.callId === "string" && exec.callId.includes(":doctor:")
  );
}

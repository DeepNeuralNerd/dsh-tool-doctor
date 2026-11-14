/**
 * Pure inspection of settled execution results and their error payloads.
 * One implementation for "what does this result say", shared by stages, the
 * pipeline and the observer so error-code matching never drifts between them.
 *
 * @module dsh-tool-doctor/core/result
 */

import type { DispatchStatus, HostError, ToolExecutionResult } from "../types.ts";

/** The stable error code a host attaches to a failure, when it does. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; info?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  return typeof candidate.info?.code === "string"
    ? candidate.info.code
    : undefined;
}

/** The human-readable message of a thrown or attached error, when present. */
export function errorText(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return typeof error === "string" ? error : undefined;
}

/** Whether a settled result failed with the given host error code. */
export function resultHasCode(
  result: ToolExecutionResult,
  code: string,
): boolean {
  return result.isError === true && errorCode(result.error) === code;
}

/** Whether a thrown value carries the given host error code (or names it). */
export function thrownHasCode(error: unknown, code: string): boolean {
  return errorCode(error) === code || errorText(error)?.includes(code) === true;
}

/** The failure message of an errored result; undefined for successes. */
export function resultErrorText(
  result: ToolExecutionResult,
): string | undefined {
  return result.isError === true ? errorText(result.error) : undefined;
}

/** Record status for one settled call from the pipeline's point of view. */
export function dispatchStatus(
  result: ToolExecutionResult,
  wasHealed: boolean,
): DispatchStatus {
  if (result.isError) return "failed";
  return wasHealed ? "success" : "passthrough";
}

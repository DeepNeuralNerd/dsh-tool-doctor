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

/**
 * Whether a value survives the host's durable tool-result projection.
 *
 * The host snapshots every settled result through a lossless-JSON walker that
 * accepts only JSON primitives (finite numbers, no `-0`), plain objects and
 * prototype-clean arrays, and rejects class instances (`Error`, `Date`),
 * functions, explicit `undefined` members, cycles and non-index array keys.
 * A result that trips that gate is replaced wholesale by a serialization
 * `TypeError`, swallowing whatever the call actually said — so the doctor
 * checks its outgoing results with the same rules ({@link projectForHost}).
 */
export function isPlainJsonValue(value: unknown, seen?: Set<unknown>): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object") return false; // undefined, function, symbol, bigint
  const ancestors = seen ?? new Set<unknown>();
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Object.keys(value).length !== value.length) return false; // extra own keys
    for (const item of value) if (!isPlainJsonValue(item, ancestors)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return false; // class instance
  for (const key of Object.keys(value)) {
    if (!isPlainJsonValue((value as Record<string, unknown>)[key], ancestors)) return false;
  }
  return true;
}

/**
 * Hand the host a result its durable projection will accept.
 *
 * Returns the result unchanged when nothing would be rejected. Otherwise the
 * model-visible `content` is preserved (fallback-rendered as text only when
 * itself unprojectable — a text line still beats the serialization `TypeError`
 * that would replace the whole result), and the diagnostic fields the host
 * snapshots (`error`, `meta`, `additionalContexts`) are dropped when they carry
 * values JSON cannot round-trip. The doctor's own records are stashed before
 * this boundary, so dropping a live `Error` here loses nothing to the log.
 */
export function projectForHost(result: ToolExecutionResult): ToolExecutionResult {
  const errorPlain = result.error === undefined || isPlainJsonValue(result.error);
  const metaPlain = result.meta === undefined || isPlainJsonValue(result.meta);
  const contextsPlain =
    result.additionalContexts === undefined || isPlainJsonValue(result.additionalContexts);
  const contentPlain = result.content === undefined || isPlainJsonValue(result.content);
  if (errorPlain && metaPlain && contextsPlain && contentPlain) return result;

  const projected: ToolExecutionResult = {
    ...(result.concludesTurn === true ? { concludesTurn: true } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
  if (contentPlain && result.content !== undefined) {
    projected.content = result.content;
  } else {
    const text = resultErrorText(result) ?? errorText(result.error);
    projected.content = [{ type: "text", text: text ?? "tool result" }];
  }
  if (!errorPlain) {
    // Keep the failure legible without the live object: text already travels
    // in `content`; the plain `{code, message}` identity survives when present.
    const info = errorCode(result.error);
    const message = errorText(result.error);
    if (info !== undefined || message !== undefined) {
      projected.error = { ...(info !== undefined ? { code: info } : {}), message: message ?? "" };
    }
  } else if (result.error !== undefined) {
    projected.error = result.error;
  }
  if (metaPlain && result.meta !== undefined) projected.meta = result.meta;
  if (contextsPlain && result.additionalContexts !== undefined) {
    projected.additionalContexts = result.additionalContexts;
  }
  return projected;
}

/** Record status for one settled call from the pipeline's point of view. */
export function dispatchStatus(
  result: ToolExecutionResult,
  wasHealed: boolean,
): DispatchStatus {
  if (result.isError) return "failed";
  return wasHealed ? "success" : "passthrough";
}

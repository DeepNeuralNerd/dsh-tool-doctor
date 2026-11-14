/**
 * The healing pipeline — the plugin's engine.
 *
 * One function per dispatch: pre-dispatch argument repair (PRE_STAGES in
 * registry order), host delegation, post-dispatch recovery (POST_STAGES with
 * a per-category circuit breaker on retries), honest attribution demotion,
 * error hints, and the recordable healing context for the adapter to persist.
 *
 * The engine is host-agnostic by construction: it receives typed shapes only
 * ({@link ToolDispatchExecution}, {@link ToolRuntime}) plus lazy thunks for
 * session facts (cwd, code language) so healthy calls pay zero lookup cost.
 * All Cordis wiring — hooks, routes, prompt registration, observer fallback —
 * lives in the adapter (`src/index.ts`).
 *
 * @module dsh-tool-doctor/core/pipeline
 */

import type {
  DoctorConfig,
  HealCategory,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolRuntime,
} from "../types.ts";
import type { HostError } from "../types.ts";
import { isSelfNestedExec } from "./util.ts";
import {
  dispatchStatus,
  errorCode,
  errorText,
  resultErrorText,
  resultHasCode,
  thrownHasCode,
} from "./result.ts";
import { compactPreview } from "./preview.ts";
import type { CircuitBreaker } from "./breaker.ts";
import { CATEGORY_META, POST_STAGES, PRE_STAGES } from "../stages/index.ts";
import type { StageEnv } from "./stage.ts";

// ── Public shapes ────────────────────────────────────────────────────────────

/** Session facts the stages may need, resolved lazily per dispatch. */
export interface PipelineSession {
  /** The owning agent (opaque; scope for tool lookups and the token meter). */
  readonly agent: unknown;
  /** Session working directory; undefined when the host does not expose one. */
  cwd(): string | undefined;
  /** Code-runtime language ("typescript" / "python"); undefined = historical TS behavior. */
  codeLanguage(): string | undefined;
}

/** What the adapter hands back for every dispatch, healed or not. */
export interface PipelineOutcome {
  /** The final result the model receives (possibly recovered or hint-annotated). */
  readonly result: ToolExecutionResult;
  /** True when a stage claimed ownership of a repair on this call. */
  readonly wasHealed: boolean;
  /** Category that owns the heal, or PASSTHROUGH for untouched calls. */
  readonly category: HealCategory;
  /** Bounded preview of the original arguments ("" when not diagnostic). */
  readonly originalArgsPreview: string;
  /** Bounded preview of the repaired/retried arguments, when they changed. */
  readonly normalizedArgsPreview?: string;
  /** Semicolon-joined change labels for the record's normalization summary. */
  readonly changes: string[];
}

/** Adapter-provided services the engine may use (all optional). */
export interface PipelineServices {
  /** Host tool runtime, resolved once per dispatch at the pipeline edge. */
  tools?: ToolRuntime;
  /** Per-category retry breaker; absent on minimal compositions. */
  breaker?: CircuitBreaker;
}

/**
 * A dispatch that failed structurally (the host threw instead of settling an
 * error result). Carries the original thrown value for re-throw plus the
 * healing context so the adapter can record it before propagating. Protocol
 * plane: the throw must reach the host unchanged in kind — only its cause is
 * preserved, never converted into a settled result.
 */
export class DispatchFailureError extends Error {
  /** The original thrown value, re-thrown by the adapter after recording. */
  readonly cause: unknown;
  /** Healing context for this failed dispatch (status "failed"). */
  readonly outcome: PipelineOutcome;

  constructor(cause: unknown, outcome: PipelineOutcome) {
    super(errorText(cause) ?? String(cause));
    this.name = "DispatchFailureError";
    this.cause = cause;
    this.outcome = outcome;
  }
}

// ── Error hints ──────────────────────────────────────────────────────────────

/** Hint appended to a PTC-collapsed direct call the plugin cannot dispatch. */
function collapsedCallHint(toolName: string): string {
  return (
    `[tool-doctor hint] Direct '${toolName}' calls are hidden in Code-Mode; ` +
    `reissue it inside run_code instead: ` +
    `run_code({ code: "const r = await tools.${toolName}(<args>); return r;", ` +
    `description: "<what this call does>" }).`
  );
}

/** Hint appended to a run_code body that parses badly and resists repair. */
const SYNTAX_HINT =
  "[tool-doctor hint] The run_code program failed to parse before running. " +
  "Usual causes: unescaped backticks inside template literals, Python pasted as JS " +
  "(`def`/`print`/`'''`), or a truncated tail. Keep the program short; write long " +
  "shell/python bodies to a file and run that file instead.";

/** Whether the final error plausibly belongs to the attempted heal class. */
function healMatchesError(
  category: HealCategory,
  code: string | undefined,
  message: string | undefined,
): boolean {
  const matches = CATEGORY_META[category]?.matchesError;
  return matches ? matches(code, message) : false;
}

/**
 * Return a copy of the result with the hint appended to its first text block.
 * The host may freeze results, so the original object is never mutated.
 */
function appendResultHint(
  result: ToolExecutionResult,
  hint: string,
): ToolExecutionResult {
  const content = Array.isArray(result.content) ? [...result.content] : [];
  const index = content.findIndex(
    (block) => typeof block === "object" && block !== null && block.type === "text",
  );
  if (index >= 0) {
    const block = content[index] as { type: string; text?: string };
    content[index] = { ...block, text: `${block.text ?? ""}\n${hint}` };
  } else {
    content.push({ type: "text", text: hint });
  }
  return { ...result, content };
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/**
 * Run one dispatch through the full healing chain.
 *
 * @param exec - The host's execution object; pre-stages replace its arguments in place.
 * @param next - Delegate to the downstream execution pipeline.
 * @param config - Resolved plugin configuration (all flags concrete).
 * @param session - Lazy session facts (agent, cwd, code language).
 * @param services - Optional host runtime and retry breaker.
 * @returns The final result plus the recordable healing context.
 * @throws DispatchFailureError When the downstream dispatch threw; carries the original value (re-throw it after recording) and the healing context.
 */
export async function runPipeline(
  exec: ToolDispatchExecution,
  next: () => Promise<ToolExecutionResult>,
  config: DoctorConfig,
  session: PipelineSession,
  services: PipelineServices = {},
): Promise<PipelineOutcome> {
  // The plugin's own nested recoveries re-enter this waterfall. They carry
  // already-normalized arguments, so observing them would double-count one
  // user-facing call as several interceptions.
  if (isSelfNestedExec(exec)) {
    return {
      result: await next(),
      wasHealed: false,
      category: "PASSTHROUGH",
      originalArgsPreview: "",
      changes: [],
    };
  }

  // Original arguments are captured by reference; serialization is lazy so
  // healthy pass-through calls (the common case) pay zero stringify cost.
  const originalArgs = exec.arguments;
  let rawArgsStr: string | undefined;
  const getRawArgsStr = (): string =>
    (rawArgsStr ??= JSON.stringify(originalArgs ?? {}) ?? "{}");

  // Pre-dispatch stages run in registry order against the current arguments;
  // when several fire on one call, changes accumulate and the last fired stage
  // owns the category. A repair without an owning stage (fence-only) replaces
  // the arguments but claims no heal.
  const env: StageEnv = {
    config,
    agent: session.agent,
    tools: services.tools,
    cwd: () => session.cwd(),
    codeLanguage: () => session.codeLanguage(),
  };

  let wasHealed = false;
  let category: HealCategory = "PASSTHROUGH";
  let normalizedPreview: string | undefined;
  const changes: string[] = [];

  for (const stage of PRE_STAGES) {
    const outcome = stage.run(exec.name, exec.arguments, env);
    if (outcome === undefined) continue;
    exec.arguments = outcome.args;
    normalizedPreview = compactPreview(JSON.stringify(outcome.args));
    changes.push(...outcome.changes);
    if (outcome.category !== undefined && outcome.category !== "PASSTHROUGH") {
      wasHealed = true;
      category = outcome.category;
    }
  }

  const getOriginalPreview = (needed: boolean): string =>
    needed ? compactPreview(getRawArgsStr()) : "";

  try {
    let result = await next();

    // Post-dispatch recovery stages in registry order. Each stage's retry is
    // guarded by the per-category circuit breaker: a category that keeps
    // failing its recoveries stops being retried for the window, so one bad
    // file cannot burn round-trips forever. Success closes immediately.
    let settledEarly = false;
    for (const stage of POST_STAGES) {
      const breakerKey = stage.category ?? stage.id;
      if (services.breaker !== undefined && !services.breaker.allow(breakerKey)) {
        continue; // open circuit: skip this category's recovery for the window
      }
      const payload = stage.inspect(exec, result, env);
      if (payload === undefined) continue;
      const recovered = await stage.recover(exec, env, payload);
      if (recovered === undefined) {
        services.breaker?.recordFailure(breakerKey);
        continue;
      }
      // The recovery ran: judge it by the result it produced.
      if (recovered.result !== undefined && recovered.result.isError === true) {
        services.breaker?.recordFailure(breakerKey);
      } else {
        services.breaker?.recordSuccess(breakerKey);
      }
      if (stage.claimsHeal !== false) {
        wasHealed = true;
        category = stage.category ?? "PASSTHROUGH";
      }
      normalizedPreview =
        recovered.preview ??
        (recovered.args !== undefined
          ? compactPreview(JSON.stringify(recovered.args))
          : normalizedPreview);
      changes.push(recovered.changeLabel);
      if (recovered.result !== undefined) result = recovered.result;
      if (stage.terminal) {
        settledEarly = true;
        break;
      }
    }

    if (!settledEarly) {
      // A pre-dispatch normalization that did not address the final error is
      // not a failed heal: attribute it honestly as an unrelated failure so
      // the healing rate measures real efficacy. Retries (FS_OBSERVED and
      // RANGE_CLAMP range retries) always own their outcome; UNKNOWN_TOOL
      // bridging settles before this block (settledEarly).
      if (
        result.isError === true &&
        wasHealed &&
        category !== "PASSTHROUGH" &&
        category !== "FS_OBSERVED" &&
        category !== "RANGE_CLAMP" &&
        !healMatchesError(
          category,
          errorCode(result.isError ? result.error : undefined),
          resultErrorText(result),
        )
      ) {
        changes.push(
          `Heal attempt did not address final error (${(resultErrorText(result) ?? "unknown error").slice(0, 60)}); counted as unrecovered`,
        );
        wasHealed = false;
        category = "PASSTHROUGH";
      }

      // Unrecoverable errors still benefit from one appended hint: the model
      // receives actionable guidance in the same round-trip instead of failing
      // blindly again. The original error text is always preserved.
      if (config.errorHints && result.isError === true) {
        const failureText = resultErrorText(result) ?? "";
        if (
          resultHasCode(result, "UNKNOWN_TOOL") &&
          failureText.includes("only `run_code` is callable directly")
        ) {
          result = appendResultHint(result, collapsedCallHint(exec.name));
        } else if (
          exec.name === "run_code" &&
          session.codeLanguage() !== "python" &&
          category !== "RUN_CODE_SYNTAX" &&
          // The syntax-failure pattern lives with the RUN_CODE_SYNTAX metadata —
          // one source of truth for what a parse failure looks like.
          (CATEGORY_META["RUN_CODE_SYNTAX"].matchesError?.(
            errorCode(result.isError ? result.error : undefined),
            failureText,
          ) ?? false)
        ) {
          result = appendResultHint(result, SYNTAX_HINT);
        }
      }
    }

    return {
      result,
      wasHealed,
      category,
      originalArgsPreview: getOriginalPreview(
        wasHealed || result.isError === true || config.persistPassthrough,
      ),
      normalizedArgsPreview: normalizedPreview,
      changes,
    };
  } catch (error: unknown) {
    // Normalize the thrown value to a host error shape for inspection.
    const hostError: HostError =
      error instanceof Error ||
      (typeof error === "object" && error !== null && "message" in error)
        ? (error as HostError)
        : { message: String(error) };

    // If a legacy host throws UNKNOWN_TOOL after entering the waterfall,
    // attempt the same safe nested-dispatch recovery.
    const tools = services.tools;
    if (
      config.autoBridgeDirectTools &&
      tools !== undefined &&
      thrownHasCode(error, "UNKNOWN_TOOL")
    ) {
      // Reuse the bridge stage's own gate + mechanics for the thrown shape.
      const bridgeStage = POST_STAGES.find((s) => s.id === "bridge");
      if (bridgeStage !== undefined) {
        const payload = bridgeStage.inspect(
          exec,
          { isError: true, error: hostError },
          env,
        );
        if (payload !== undefined) {
          const recovered = await bridgeStage.recover(exec, env, payload);
          if (recovered?.result !== undefined) {
            return {
              result: recovered.result,
              wasHealed: true,
              category: "UNKNOWN_TOOL",
              originalArgsPreview: getOriginalPreview(true),
              normalizedArgsPreview: `Nested dispatch: ${exec.name}`,
              changes: [recovered.changeLabel],
            };
          }
        }
      }
    }

    // The thrown value is the authoritative failure; surface it unchanged.
    throw new DispatchFailureError(error, {
      result: { isError: true, error: hostError },
      wasHealed,
      category,
      originalArgsPreview: getOriginalPreview(true),
      normalizedArgsPreview: normalizedPreview,
      changes: [...changes, `Dispatch threw: ${errorText(error) ?? String(error)}`],
    });
  }
}

/** Re-exports for adapters that build records from pipeline outcomes. */
export { dispatchStatus, resultErrorText, errorCode, errorText };

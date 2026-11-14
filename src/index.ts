/**
 * dsh-tool-doctor — auto-healing, argument normalization, and safe nested tool
 * recovery for DeepSeek Harness.
 *
 * This file is the Cordis adapter: it resolves configuration, owns the tracker
 * and durable log, registers hooks/routes/prompt contributions, and hands each
 * dispatch to the host-agnostic engine in `core/pipeline.ts`. No healing logic
 * lives here — stages live in `stages/`, mechanics in `repair/` + `recovery/`,
 * services in `support/`.
 *
 * @module dsh-tool-doctor
 */

import { CircuitBreaker } from "./core/breaker.ts";
import { compactPreview } from "./core/preview.ts";
import {
  DispatchFailureError,
  runPipeline,
  type PipelineOutcome,
} from "./core/pipeline.ts";
import { dispatchStatus, errorText, resultErrorText } from "./core/result.ts";
import { objectValue, sessionCwd } from "./core/util.ts";
import { CATEGORY_META } from "./stages/index.ts";
import { buildErrorCandidates } from "./support/error-signatures.ts";
import {
  loadOverrides,
  saveOverrides,
  validateTogglePatch,
} from "./support/config-overrides.ts";
import {
  appendEvent,
  clearLog,
  flushStatsLog,
  persistSnapshot,
  restoreFromLog,
  statsLogPath,
} from "./support/stats-log.ts";
import {
  isDiagnosticRecord,
  ToolNormalizerTracker,
  type NormalizerAggregate,
  type NormalizerRecord,
} from "./support/tracker.ts";
import {
  DEFAULT_GUIDANCE_TEXT,
  getGuidanceText,
  registerPromptGuidance,
  refreshTopErrors,
  resetGuidanceText,
  setGuidanceText,
} from "./support/prompt.ts";
import {
  healTextBlock,
  hasHealSignal,
  healGate,
  parseToolCallsFromText,
  stripToolCallMarkup,
} from "./support/tool-healing.ts";
import type {
  DoctorConfig,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolRuntime,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

// ── Public package surface ───────────────────────────────────────────────────
// Consumers import types and mechanics from the package root; these re-exports
// are the API, not incidental barrels.

export * from "./types.ts";
export type { NormalizerRecord, NormalizerStats, NormalizerAggregate } from "./support/tracker.ts";
export { isDiagnosticRecord } from "./support/tracker.ts";
export { STAGES, PRE_STAGES, POST_STAGES, CATEGORY_META, CATEGORY_LABELS } from "./stages/index.ts";
export type { HealStage, PreStage, PostStage, StageEnv, StageOutcome, RecoveryOutcome } from "./core/stage.ts";
export * from "./repair/run-code.ts";
export * from "./repair/run-code-syntax.ts";
export * from "./repair/range-clamper.ts";
export * from "./repair/path-arg-quotes.ts";
export * from "./repair/mnemon-result-schema.ts";
export * from "./repair/source-path-scope.ts";
export { executeBridgeDirectCall, isBridgeableDirectCall } from "./recovery/direct-bridge.ts";
export { executeNestedTool, nestedCallId } from "./recovery/nested-dispatch.ts";
export { DEFAULT_GUIDANCE_TEXT, getGuidanceText, setGuidanceText, resetGuidanceText } from "./support/prompt.ts";
export { healTextBlock, hasHealSignal, healGate, parseToolCallsFromText, stripToolCallMarkup, type HealedTextBlock, type ParsedToolCall } from "./support/tool-healing.ts";

/** Cordis plugin identifier. */
export const name = "tool-doctor";

/** Injected services required from the Cordis context. */
export const inject = ["tools", "llm"];

// ── Host service readers (lazy, optional across compositions) ───────────────

/** Shape of the optional session token-meter service read at dispatch time. */
interface SessionTokenMeter {
  measure(
    session: unknown,
    requestHeader?: unknown,
  ): { totalTokens?: number } | undefined;
}

/** Resolve the host tool runtime lazily (absent on minimal hosts). */
function getToolRuntime(ctx: HostContext): ToolRuntime | undefined {
  const tools = ctx.get("tools");
  if (typeof tools !== "object" || tools === null) return undefined;
  const candidate = tools as Partial<ToolRuntime>;
  return typeof candidate["get"] === "function" ? (candidate as ToolRuntime) : undefined;
}

/** The minimal host surface the adapter needs, typed at this boundary. */
interface HostContext {
  get(name: string): unknown;
  on(event: string, handler: (...args: never[]) => unknown): void;
  effect(fn: () => void | (() => void), label?: string): void;
  logger?: { info?(msg: string): void; warn?(msg: string): void; debug?(msg: string): void };
}

/**
 * Language reported by the mounted code runtime, when one is present. The
 * `run_code` body repairs are TypeScript-specific (they parse with
 * `AsyncFunction` and splice JS object syntax), so Python programs must skip
 * them: a triple-quoted Python string is valid Python, not a body to rewrite,
 * and a JS-style `description:` splice would break Python dicts. Unknown or
 * absent means the historical TypeScript behavior.
 */
function readCodeRuntimeLanguage(ctx: HostContext): string | undefined {
  const runtime = ctx.get("codeRuntime");
  const language = (runtime as { language?: unknown } | null)?.language;
  // Normalized at the source so every consumer's language gate (exact or
  // prefix) sees one canonical casing.
  return typeof language === "string" ? language.toLowerCase() : undefined;
}

/** Number of extra model round-trips a successful heal removes (the table lives with each category's metadata in the stage registry). */
function avoidedRoundTrips(category: NormalizerRecord["category"]): number {
  return CATEGORY_META[category]?.roundTrips ?? 0;
}

/**
 * Resolve the token-meter service lazily. It is optional across compositions
 * (compaction-oriented ones mount it), so the metric must degrade instead of
 * failing plugin load.
 */
function readTokenMeter(ctx: HostContext): SessionTokenMeter | undefined {
  const meter = ctx.get("tokenMeter");
  return meter !== undefined && typeof (meter as Partial<SessionTokenMeter>)?.measure === "function"
    ? (meter as SessionTokenMeter)
    : undefined;
}

/**
 * Measured input tokens a healed call avoids: the owning session's one-request
 * context pressure times the skipped round-trips. Returns 0 when the meter or
 * the owning session is unavailable, so an unmetered composition reports no
 * savings rather than a fabricated constant.
 */
function measureTokensSaved(
  meter: SessionTokenMeter | undefined,
  agent: unknown,
  roundTrips: number,
): number {
  if (roundTrips <= 0 || meter === undefined) return 0;
  const session = objectValue(agent)?.["session"];
  if (session === undefined) return 0;
  try {
    const total = meter.measure(session)?.totalTokens;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) return 0;
    return total * roundTrips;
  } catch {
    // Measurement is diagnostic only; never disturb the executing call.
    return 0;
  }
}

// ── Observer handoff (wrapper → tools/result) ───────────────────────────────

/**
 * Healing context stashed by the wrapper for the `tools/result` observer.
 * Result-derived fields (status, error text, measured savings) are computed at
 * observe time from the frozen final outcome, so a later `tools/post-execute`
 * policy cannot skew them. The wrapper-observed outcome travels alongside only
 * for the no-`tools/result` fallback, which has nothing better to report.
 *
 * Every field is persisted verbatim into the JSONL detail log, so it must stay
 * JSON-serializable. The live agent is a reference the token meter needs, not
 * diagnostic data: it rides on {@link StashedHeal} and never enters a record.
 */
interface PendingHeal {
  id: string;
  time: number;
  toolName: string;
  category: NormalizerRecord["category"];
  wasHealed: boolean;
  originalArgsPreview: string;
  normalizedArgsPreview?: string;
  normalizationSummary?: string;
}

interface StashedOutcome {
  status: "success" | "failed" | "passthrough";
  errorMessage?: string;
  tokensSaved: number;
}

/** One stashed handoff: healing context, the outcome to report, and the agent the meter measures. */
interface StashedHeal {
  pending: PendingHeal;
  outcome: StashedOutcome;
  agent: unknown;
}

// ── Plugin entry point ───────────────────────────────────────────────────────

/**
 * Apply the tool doctor plugin.
 * @param ctx - Cordis Context.
 * @param userConfig - Plugin configuration from the composition (deployment default).
 */
export function apply(ctxRaw: unknown, userConfig: Partial<DoctorConfig> = {}): void {
  const ctx = ctxRaw as HostContext;

  // Resolve config: defaults under the composition config under the durable
  // panel overrides. Panel toggles win over the deployment file at startup.
  const config: DoctorConfig = { ...DEFAULT_CONFIG, ...userConfig };
  Object.assign(config, loadOverrides());

  /** Apply a validated toggle patch to the live config and persist it. */
  const applyTogglePatch = (patch: Partial<DoctorConfig>): void => {
    Object.assign(config, patch);
    if ("persistPassthrough" in patch) {
      tracker.setPersistPassthrough(config.persistPassthrough);
    }
    saveOverrides(patch);
  };

  const tracker = new ToolNormalizerTracker();
  tracker.setPersistPassthrough(config.persistPassthrough);
  const breaker = new CircuitBreaker();
  const restoreReady = restoreFromLog(tracker)
    .catch((error: unknown) => {
      ctx.logger?.warn?.(
        `[tool-doctor] history restore failed: ${errorText(error) ?? String(error)}`,
      );
    })
    .then(() => {
      persistSnapshot(tracker.getAggregate());
    });

  /** Record one real event, append it to the durable log, and log a line. */
  const recordEvent = (record: NormalizerRecord): void => {
    tracker.record(record);
    appendEvent(record, tracker.getAggregate(), {
      persistPassthrough: config.persistPassthrough,
    });
    // Successful untouched calls dominate traffic; they are counters only, so
    // they skip the debug line. Every failure and every heal still logs.
    if (isDiagnosticRecord(record) || config.persistPassthrough) {
      ctx.logger?.debug?.(
        `[tool-doctor] ${record.toolName} category=${record.category} healed=${record.wasHealed} status=${record.status}`,
      );
    }
  };

  // ── Observer handoff state ────────────────────────────────────────────────
  /** Bounded handoff from wrapper to observer, keyed by call id. */
  const pendingHeals = new Map<string, StashedHeal>();
  const MAX_PENDING_HEALS = 1000;
  /** Call ids already recorded inline by the no-`tools/result` fallback. */
  const inlineRecorded = new Set<string>();
  const MAX_INLINE_RECORDED = 2000;
  /** True once the `tools/result` observer has fired on a supporting host. */
  let resultHookConfirmed = false;
  /** True once the fallback concluded the host never emits `tools/result`. */
  let resultFallback = false;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;

  function stopFallbackTimer(): void {
    if (fallbackTimer !== undefined) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
  }

  /**
   * Build the recordable event from healing context and one observed final
   * result. Status, error text, and measured savings always describe the
   * outcome the model actually received.
   */
  function buildRecord(
    pending: PendingHeal,
    result: ToolExecutionResult,
    agent: unknown,
  ): NormalizerRecord {
    const ok = !result.isError;
    return {
      ...pending,
      status: dispatchStatus(result, pending.wasHealed),
      errorMessage: resultErrorText(result),
      tokensSaved:
        pending.wasHealed && ok
          ? measureTokensSaved(readTokenMeter(ctx), agent, avoidedRoundTrips(pending.category))
          : 0,
    };
  }

  function stashPending(
    callId: string | undefined,
    pending: PendingHeal,
    outcome: StashedOutcome,
    agent: unknown,
  ): void {
    if (callId === undefined || resultFallback) {
      // Without an identity the observer cannot correlate; record inline.
      recordInline(callId, pending, outcome);
      return;
    }
    if (pendingHeals.size >= MAX_PENDING_HEALS && !resultHookConfirmed) {
      sweepUnobservedHeals();
      if (resultFallback) {
        recordInline(callId, pending, outcome);
        return;
      }
    }
    if (pendingHeals.size >= MAX_PENDING_HEALS) {
      const oldest = pendingHeals.keys().next();
      if (!oldest.done) pendingHeals.delete(oldest.value);
    }
    pendingHeals.set(callId, { pending, outcome, agent });
    // Lazily watch for hosts that predate `tools/result`: the interval only
    // exists while an unconfirmed handoff is outstanding.
    if (!resultHookConfirmed && fallbackTimer === undefined) {
      fallbackTimer = setInterval(sweepUnobservedHeals, 15000);
      fallbackTimer.unref?.();
    }
  }

  /** Record one stashed heal inline (fallback or uncorrelatable identity). */
  function recordInline(
    callId: string | undefined,
    pending: PendingHeal,
    outcome: StashedOutcome,
  ): void {
    if (callId !== undefined) {
      if (inlineRecorded.size >= MAX_INLINE_RECORDED) {
        const oldest = inlineRecorded.values().next();
        if (!oldest.done) inlineRecorded.delete(oldest.value);
      }
      inlineRecorded.add(callId);
    }
    recordEvent({ ...pending, ...outcome });
  }

  /**
   * Fallback sweep for hosts that predate `tools/result`: record whatever the
   * observer never consumed with the wrapper-observed outcomes, then record
   * inline from then on. Stops its own interval once the observer confirms or
   * the backlog drains.
   */
  function sweepUnobservedHeals(): void {
    if (resultHookConfirmed) {
      stopFallbackTimer();
      return;
    }
    if (pendingHeals.size === 0) return;
    resultFallback = true;
    // Keep each call's id while recording inline so a late `tools/result`
    // event (a slow host) meets the inlineRecorded suppression instead of
    // recording the same call a second time.
    const backlog = [...pendingHeals.entries()];
    pendingHeals.clear();
    stopFallbackTimer();
    for (const [callId, { pending, outcome }] of backlog) {
      recordInline(callId, pending, outcome);
    }
  }

  ctx.logger?.info?.(
    `[tool-doctor] active — intercepting tools/execute; history log: ${statsLogPath()}`,
  );
  // Snapshot top-errors once at session start for KV-cache-stable prompt section.
  restoreReady.then(() => {
    refreshTopErrors(tracker);
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  let routesStopped = false;
  ctx.effect(
    () => () => {
      routesStopped = true;
      stopFallbackTimer();
      void flushStatsLog();
    },
    "tool-doctor: runtime teardown",
  );

  // ── Dashboard HTTP feed ───────────────────────────────────────────────────
  let registerAttempts = 0;
  let routeTimer: ReturnType<typeof setTimeout> | undefined;
  const tryRegisterStatsRoute = (): void => {
    if (routesStopped) return;
    const webServer = ctx.get("webServer");
    if (!webServer || typeof (webServer as { register?: unknown })?.register !== "function") {
      if (registerAttempts++ < 60) {
        routeTimer = setTimeout(tryRegisterStatsRoute, 1000);
        routeTimer.unref?.();
      } else {
        ctx.logger?.warn?.(
          "[tool-doctor] no webserver appeared within 60s; stats feed disabled",
        );
      }
      return;
    }
    const server = webServer as {
      register(route: {
        kind: "exact";
        path: string;
        handler: (req: unknown, res: ResponseLike) => void;
      }): (() => void) | undefined;
    };
    ctx.effect(() => {
      const disposeStats = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/stats",
        handler: (_req, res) => {
          // breakerOpen: categories whose retry circuit is currently open, so
          // the panel can show "retries paused" instead of silent inactivity.
          json(res, 200, { ...tracker.getSnapshot(), breakerOpen: breaker.openCategories() });
        },
      });
      const disposeReset = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/reset",
        handler: (req, res) => {
          if ((req as { method?: string }).method !== "POST") {
            res.writeHead(405, { allow: "POST" });
            res.end();
            return;
          }
          tracker.reset();
          void clearLog().then(() => {
            res.writeHead(204, {});
            res.end();
          });
        },
      });
      const disposeGuidance = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/guidance",
        handler: (req, res) => {
          if ((req as { method?: string }).method === "PUT") {
            readBody(req).then((body) => {
              try {
                const parsed = JSON.parse(body) as { text?: string };
                const prev = setGuidanceText(parsed.text ?? "");
                json(res, 200, { previous: prev, current: getGuidanceText() });
              } catch (e: unknown) {
                res.writeHead(400, { "content-type": "text/plain" });
                res.end(String(e));
              }
            }).catch((e: unknown) => respondReadError(res, e));
            return;
          }
          json(res, 200, { text: getGuidanceText(), defaultText: DEFAULT_GUIDANCE_TEXT });
        },
      });
      const disposeGuidanceReset = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/guidance/reset",
        handler: (req, res) => {
          if ((req as { method?: string }).method !== "POST") {
            res.writeHead(405, { allow: "POST" });
            res.end();
            return;
          }
          resetGuidanceText();
          json(res, 200, { text: getGuidanceText() });
        },
      });
      const disposeConfig = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/config",
        handler: (req, res) => {
          if ((req as { method?: string }).method !== "POST") {
            json(res, 200, config);
            return;
          }
          readBody(req).then((body) => {
            let result: ReturnType<typeof validateTogglePatch>;
            try {
              result = validateTogglePatch(JSON.parse(body));
            } catch (error: unknown) {
              result = { ok: false, error: `invalid JSON body: ${errorText(error) ?? String(error)}` };
            }
            if (!result.ok) {
              json(res, 400, { error: result.error });
              return;
            }
            try {
              applyTogglePatch(result.patch);
            } catch (error: unknown) {
              json(res, 500, {
                error: `config persisted in memory only; file save failed: ${errorText(error) ?? String(error)}`,
              });
              return;
            }
            json(res, 200, config);
          }).catch((e: unknown) => respondReadError(res, e));
        },
      });
      const disposeCandidates = server.register({
        kind: "exact",
        path: "/plugin-api/tool-doctor/candidates",
        handler: (_req, res) => {
          // Same grouping the client applies to the stats snapshot, resolved
          // against the live config so coverage gaps name the exact toggle.
          json(res, 200, {
            candidates: buildErrorCandidates(
              tracker.getSnapshot().recentRecords,
              60,
              config,
            ),
          });
        },
      });
      return () => {
        disposeCandidates?.();
        disposeConfig?.();
        disposeGuidanceReset?.();
        disposeGuidance?.();
        disposeReset?.();
        disposeStats?.();
      };
    }, "tool-doctor: stats http routes");
    ctx.logger?.info?.("[tool-doctor] stats feed at GET /plugin-api/tool-doctor/stats");
  };
  tryRegisterStatsRoute();

  // Register dynamic prompt guidelines safely. The injectPrompt toggle is
  // evaluated on every prompt build, so the dashboard can switch it live.
  registerPromptGuidance(ctx, () => config.injectPrompt);

  const getTools = (): ToolRuntime | undefined => getToolRuntime(ctx);
  const getMeter = (): SessionTokenMeter | undefined => readTokenMeter(ctx);

  // ── Dispatch interception (the engine does the work) ─────────────────────
  ctx.on(
    "tools/execute",
    async (
      exec: ToolDispatchExecution,
      next: () => Promise<ToolExecutionResult>,
    ): Promise<ToolExecutionResult> => {
      await restoreReady;

      const startTime = Date.now();
      const eventId = `norm_${startTime}_${Math.random().toString(36).slice(2, 8)}`;
      const tools = getTools();
      const meter = getMeter();
      const savedTokens = (healed: boolean, ok: boolean, category: NormalizerRecord["category"]): number =>
        healed && ok ? measureTokensSaved(meter, exec.agent, avoidedRoundTrips(category)) : 0;

      /** Snapshot the pipeline outcome into observer-handoff shape. */
      const toPending = (outcome: PipelineOutcome, previewNeeded: boolean): PendingHeal => ({
        id: eventId,
        time: startTime,
        toolName: exec.name,
        category: outcome.category,
        wasHealed: outcome.wasHealed,
        originalArgsPreview: previewNeeded ? outcome.originalArgsPreview : "",
        normalizedArgsPreview: outcome.normalizedArgsPreview,
        normalizationSummary:
          outcome.changes.length > 0 ? outcome.changes.join("; ") : undefined,
      });

      let outcome: PipelineOutcome;
      try {
        outcome = await runPipeline(
          exec,
          next,
          config,
          {
            agent: exec.agent,
            cwd: () => sessionCwd(exec.agent),
            codeLanguage: () => readCodeRuntimeLanguage(ctx),
          },
          { tools, breaker },
        );
      } catch (error: unknown) {
        if (!(error instanceof DispatchFailureError)) throw error;
        outcome = error.outcome;
        stashPending(
          exec.callId,
          toPending(outcome, true),
          {
            status: "failed",
            errorMessage: resultErrorText(outcome.result) ?? errorText(error.cause) ?? String(error.cause),
            tokensSaved: 0,
          },
          exec.agent,
        );
        throw error.cause; // protocol plane: the original value propagates unchanged
      }

      stashPending(
        exec.callId,
        toPending(outcome, true),
        {
          status: dispatchStatus(outcome.result, outcome.wasHealed),
          errorMessage: resultErrorText(outcome.result),
          tokensSaved: savedTokens(outcome.wasHealed, !outcome.result.isError, outcome.category),
        },
        exec.agent,
      );
      return outcome.result;
    },
  );

  // Observe the frozen final outcome off the dispatch hot path. This covers
  // every settled call — including pre-execute/guard denials the `execute`
  // wrapper never sees — while the wrapper keeps owning normalization and
  // healing. The host contains observer failures; this one still never throws
  // so it cannot spam the host warning log.
  ctx.on(
    "tools/result",
    (
      exec: Pick<ToolDispatchExecution, "name" | "callId" | "arguments">,
      result: ToolExecutionResult,
    ): undefined => {
      try {
        if (typeof exec.callId === "string" && exec.callId.includes(":doctor:")) {
          return undefined;
        }
        // Synchronous correlation: the event firing at all proves host support,
        // so confirm before any async recording below. Only the tracker/file
        // writes defer behind history restore.
        resultHookConfirmed = true;
        const callId = exec.callId;
        const stashed = typeof callId === "string" ? pendingHeals.get(callId) : undefined;
        if (stashed !== undefined && typeof callId === "string") {
          pendingHeals.delete(callId);
        }
        const alreadyInline =
          stashed === undefined && typeof callId === "string" && inlineRecorded.delete(callId);
        if (pendingHeals.size === 0) stopFallbackTimer();
        void restoreReady.then(() => {
          try {
            if (stashed !== undefined) {
              recordEvent(buildRecord(stashed.pending, result, stashed.agent));
              return;
            }
            if (alreadyInline) return;
            // A settled call the wrapper never saw: a pre-execute or guard denial.
            const failed = result.isError === true;
            let originalArgsPreview = "";
            if (failed || config.persistPassthrough) {
              try {
                originalArgsPreview = compactPreview(
                  JSON.stringify((exec as { arguments?: unknown }).arguments ?? {}) ?? "{}",
                );
              } catch {
                // Preview is diagnostic; an unserializable snapshot stays empty.
              }
            }
            recordEvent({
              id: `norm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              time: Date.now(),
              toolName: exec.name,
              category: "PASSTHROUGH",
              wasHealed: false,
              originalArgsPreview,
              status: failed ? "failed" : "passthrough",
              errorMessage: resultErrorText(result),
            });
          } catch {
            // Recording is diagnostic only; never disturb the settled call.
          }
        });
      } catch {
        // Recording is diagnostic only; never disturb the settled call.
      }
      return undefined;
    },
  );

  // ── Response-side tool-call healing (Unsloth Studio port) ────────────────
  // When a model emits its tool calls as prose / XML inside a streamed text
  // block, parse them into structured tool-call blocks so the agent loop
  // dispatches them. We transform at block-end of text blocks, where the
  // complete block text is available — no chunk-boundary XML splitting.
  // Healthy streams (no markup) pass through byte-for-byte. Registered
  // unconditionally: the healResponseTools toggle is checked per stream so the
  // dashboard can switch it live without a restart.
  ctx.on(
    "llm/stream",
    (
      options:
        | { tools?: Array<unknown>; response_format?: unknown; tool_choice?: unknown }
        | undefined,
      next: () => AsyncIterable<unknown>,
    ): AsyncIterable<unknown> => {
      if (!config.healResponseTools) return next();
      const allowed = healGate(options);
      if (allowed === null) return next();

      return (async function* (): AsyncGenerator<unknown> {
        // Fresh indices start high so healed blocks never collide with the
        // upstream adapter's (small-int) block indices and land right after
        // the healed text block — the semantically correct position.
        let nextHealIndex = 1 << 30;
        // Per-stream unique id prefix: promoted ids stay unique across every
        // text block of this message and can never collide with native
        // tool-call ids (which use their own namespace).
        const idPrefix = `heal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        // Per-stream sequence: promoted ids stay unique across every text
        // block of this message (each block's parse starts its counter at 0).
        let healSeq = 0;
        for await (const chunk of next()) {
          const c = chunk as {
            type?: string;
            index?: number;
            block?: { type?: string; text?: string };
          };
          if (c?.type === "block-end" && c.block?.type === "text" && typeof c.block.text === "string") {
            const blockText = c.block.text;
            const healed = healTextBlock(blockText, allowed, idPrefix, healSeq);
            if (healed) {
              healSeq += healed.calls.length;
              // Re-emit the text block with the markup stripped. block-end
              // .block is authoritative, so this overrides the streamed text.
              yield {
                type: "block-end",
                index: c.index,
                block: { type: "text", text: healed.text },
              };
              // Append healed tool-call blocks on fresh, non-colliding indices.
              for (const call of healed.calls) {
                const idx = nextHealIndex++;
                yield { type: "block-start", index: idx, blockType: "tool-call" };
                yield {
                  type: "tool-call-delta",
                  index: idx,
                  id: call.id,
                  name: call.name,
                  argumentsDelta: call.arguments,
                };
                yield {
                  type: "block-end",
                  index: idx,
                  block: { type: "tool-call", id: call.id, name: call.name, arguments: call.arguments },
                };
              }
              // Same startup gate the dispatch and observer record paths use:
              // a promotion that lands while history restore is in flight
              // must not be overwritten by restore's aggregate replacement.
              void restoreReady.then(() => {
                for (const call of healed.calls) {
                  try {
                    const spanText = blockText.slice(call.span[0], call.span[1]) || call.name;
                    recordEvent({
                      id: `norm_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                      time: Date.now(),
                      toolName: call.name,
                      category: "RESPONSE_TOOL_HEAL",
                      wasHealed: true,
                      originalArgsPreview: compactPreview(spanText),
                      normalizedArgsPreview: compactPreview(call.arguments),
                      // Promotion is not an execution outcome yet; count it in its
                      // own bucket so healed-success stays a dispatch metric.
                      status: "promoted",
                    });
                  } catch {
                    // Recording is diagnostic only; never disturb the stream.
                  }
                }
              });
              continue;
            }
          }
          yield chunk;
        }
      })();
    },
  );
}

// ── Small HTTP helpers (typed at this boundary) ─────────────────────────────

interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function json(res: ResponseLike, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Dashboard payloads are small JSON; anything larger is rejected, not buffered. */
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

class BodySizeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodySizeError";
  }
}

/** Read a request body to completion (dashboard POST/PUT payloads). */
function readBody(req: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = req as {
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    if (typeof stream.on !== "function") {
      resolve("");
      return;
    }
    // Count incoming BYTES, not characters: multibyte UTF-8 must not slip past
    // the cap, and chunks are concatenated before decoding so a code point split
    // across chunk boundaries decodes correctly.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    stream.on("data", (chunk: unknown) => {
      if (settled) return; // over the cap: discard, let the caller respond 413
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(String(chunk));
      bytes += buf.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        // Reject without destroying the socket: the caller writes the 413 first,
        // and res.end() closes a connection whose request was never fully
        // consumed — so the client still receives the intended response.
        settle(() => reject(new BodySizeError()));
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () =>
      settle(() => resolve(Buffer.concat(chunks).toString("utf8"))),
    );
    stream.on("error", (err: unknown) =>
      settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

/** Respond to a readBody failure with the right status instead of hanging. */
function respondReadError(res: ResponseLike, e: unknown): void {
  if (e instanceof BodySizeError) json(res, 413, { error: e.message });
  else json(res, 500, { error: `failed to read request body: ${errorText(e) ?? String(e)}` });
}

/** Exported for tests: the byte-bounded body reader and its error type. */
export { readBody, BodySizeError };

export default { name, inject, apply };

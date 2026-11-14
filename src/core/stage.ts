/**
 * The healing-stage contract — the plugin's single extension point.
 *
 * A stage is one self-contained repair capability: its gate, its mechanic,
 * and its metadata (label, rule number, error attribution) live together in
 * one file. Adding a stage means writing that file and appending it to
 * STAGES; the pipeline, tracker, panel labels and candidate mapping all derive
 * from the registry, so nothing else changes.
 *
 * Design doctrine (see docs/ARCHITECTURE.md):
 *  - Repair only what is unambiguous; a healthy call must pass through as a
 *    no-op — never rewrite good arguments to fix broken ones.
 *  - Classify before retrying: post-stages declare which failure class they
 *    own and never blind-retry side-effecting mutations (read first, then run).
 *  - Report exactly what changed; the record's summary is the audit trail.
 *
 * @module dsh-tool-doctor/core/stage
 */

import type {
  HealCategory,
  DoctorConfig,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolRuntime,
} from "../types.ts";

/**
 * Per-dispatch context built once at the pipeline edge. Host lookups that cost
 * anything (session cwd walk, code-runtime language probe) are lazy thunks so
 * healthy pass-through calls pay zero for them; stages pull only what they use.
 */
export interface StageEnv {
  /** Resolved plugin configuration (all flags concrete). */
  readonly config: DoctorConfig;
  /** Session/agent owner, opaque to the core. */
  readonly agent: unknown;
  /** Host tool runtime when the host exposes one; undefined on minimal hosts. */
  readonly tools: ToolRuntime | undefined;
  /** Session working directory — lazy because it walks host objects. */
  readonly cwd: () => string | undefined;
  /** Language of the mounted code runtime ("python" disables TS body repairs). Lazy. */
  readonly codeLanguage: () => string | undefined;
}

/** The outcome of one stage firing. */
export interface StageOutcome {
  /** Corrected arguments to dispatch with (pre) or that a retry used (post). */
  args?: Record<string, unknown>;
  /** Bounded human-readable change labels for the record summary. */
  changes: string[];
  /**
   * Category this invocation reports. Absent when the stage applied a change
   * without claiming a heal (e.g. semantically-equivalent fence stripping).
   */
  category?: HealCategory;
}

/** A post-dispatch recovery's outcome. */
export interface RecoveryOutcome {
  /** Replacement result; absent = keep the current one (side-effect-only stages). */
  result?: ToolExecutionResult;
  /** Corrected arguments the retry ran with, when different from the original. */
  args?: Record<string, unknown>;
  /** Explicit normalized-args preview override for the record. */
  preview?: string;
  changeLabel: string;
}

/**
 * Pre-dispatch stage: inspects raw model arguments before execution and
 * returns a repaired copy when — and only when — corruption is unambiguous.
 * Must not mutate its input or perform I/O.
 */
export interface PreStage {
  readonly phase: "pre";
  /** Stable identifier (also the registry key for diagnostics). */
  readonly id: string;
  /** Panel label — single source of truth, shared with the dashboard client. */
  readonly label: string;
  /** Healing-rule number used by error-candidate mapping. */
  readonly ruleNumber: number;
  /**
   * The static category this stage owns (feeds CATEGORY_META derivation).
   * Multi-stage stages that report their owning sub-category per invocation
   * omit it and declare their categories explicitly in the registry.
   */
  readonly category?: HealCategory;
  /** Model round-trips a successful heal removes (token-meter input). Default 1. */
  readonly roundTrips?: number;
  /** Honest attribution: does the final error plausibly belong to this class? */
  matchesError?(code: string | undefined, text: string | undefined): boolean;
  /** Run the repair. Returns undefined for healthy calls (the common case). */
  run(toolName: string, args: unknown, env: StageEnv): StageOutcome | undefined;
}

/**
 * Post-dispatch stage: inspects a settled result and, when it matches an owned
 * failure class, re-enters the host dispatcher with a corrected or observed
 * call. Mechanics live in src/recovery; this descriptor carries gate + match.
 */
export interface PostStage {
  readonly phase: "post";
  readonly id: string;
  readonly label: string;
  readonly ruleNumber: number;
  /** Static category this stage owns (feeds CATEGORY_META derivation). */
  readonly category?: HealCategory;
  /** Model round-trips a successful recovery removes (token-meter input). Default 1. */
  readonly roundTrips?: number;
  /** Honest attribution: does the final error plausibly belong to this class? */
  readonly matchesError?: (code: string | undefined, text: string | undefined) => boolean;
  /** Gate + match: the payload for recover(), or undefined to skip. */
  inspect(
    exec: ToolDispatchExecution,
    result: ToolExecutionResult,
    env: StageEnv,
  ): unknown | undefined;
  /** Run the nested recovery against the host dispatcher. */
  recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload?: unknown,
  ): Promise<RecoveryOutcome | undefined>;
  /** Settle immediately after a successful recovery (skips attribution + hints). */
  readonly terminal?: boolean;
  /** Side-effect-only stage: records the label without claiming a heal. Default false. */
  readonly claimsHeal?: boolean;
}

/** Any healing stage, discriminated by phase. */
export type HealStage = PreStage | PostStage;

export function isPreStage(stage: HealStage): stage is PreStage {
  return stage.phase === "pre";
}

export function isPostStage(stage: HealStage): stage is PostStage {
  return stage.phase === "post";
}

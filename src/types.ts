/**
 * Host boundary contracts for dsh-tool-doctor.
 *
 * Everything the plugin receives from the DeepSeek Harness host crosses this
 * file: dispatch executions, execution results, and the tool runtime used for
 * schema lookups and nested recovery dispatches. The core engine only ever
 * sees these typed shapes — raw host objects never travel further inward.
 *
 * @module dsh-tool-doctor/types
 */

// ── Dispatch contracts ───────────────────────────────────────────────────────

/**
 * One tool call as the host hands it to a `tools/execute` waterfall stage.
 * Fields are optional where older hosts omit them; stages must degrade
 * gracefully instead of assuming presence.
 */
export interface ToolDispatchExecution {
  /** Tool name exactly as the model emitted it. */
  readonly name: string;
  /** Raw arguments object (or, in pathological cases, a raw string). Mutable by design: pre-stages replace it with repaired copies. */
  arguments: unknown;
  /** Host-assigned call identity; absent on some legacy hosts. */
  readonly callId?: string;
  /** Root of the dispatch tree for nested calls. */
  readonly rootCallId?: string;
  /** Opaque runtime token marking this call as a nested dispatch. */
  readonly token?: unknown;
  /** Session/agent owner used by scoped tools and filesystem policy. Opaque to the plugin. */
  readonly agent?: unknown;
  /** Present when the host is already executing a nested call. */
  readonly parent?: unknown;
  /** Cancellation signal for the in-flight dispatch, when the host provides one. */
  readonly signal?: AbortSignal;
}

/** A content block inside an execution result. */
export interface ResultContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** The error payload a host attaches to a failed result, in either known shape. */
export type HostError =
  | Error
  | { message: string; code?: string; info?: { code?: string } };

/**
 * A settled tool execution result. `isError` plus an actionable `error` is the
 * host's "tool execution error" plane (model can self-correct); structural
 * problems surface as thrown values instead.
 */
export interface ToolExecutionResult {
  content?: ResultContentBlock[];
  isError?: boolean;
  value?: unknown;
  meta?: unknown;
  additionalContexts?: unknown[];
  concludesTurn?: true;
  error?: HostError;
}

// ── Runtime contracts ────────────────────────────────────────────────────────

/** Input accepted by the host runtime for a nested dispatch. */
export interface ToolExecutionInput {
  callId: string;
  rootCallId?: string;
  name: string;
  arguments: unknown;
  agent?: unknown;
  parent?: unknown;
  signal: AbortSignal;
}

/**
 * The host tool runtime, resolved once per dispatch at the pipeline edge.
 * `get` is required (schema lookups); `execute` enables nested recovery
 * dispatches and may be absent on minimal hosts — every consumer must check.
 */
export interface ToolRuntime {
  /** Look up a tool definition in scope; undefined when unregistered there. */
  get(name: string, scope?: unknown): unknown;
  /** Re-enter the host's complete execution pipeline with a child call. */
  execute?(execution: ToolExecutionInput): Promise<ToolExecutionResult>;
  /**
   * Enumerate the tool schemas callable in `scope` — the host ToolsService
   * method (`schemas(scope?, toolSet?): ToolSchema[]`, verified against the
   * installed API catalog). Declared optional: plugins must probe for it and
   * degrade honestly when a host exposes less than the current one does.
   */
  schemas?(scope?: unknown, toolSet?: unknown): readonly { readonly name: string }[];
}

// ── Plugin configuration ─────────────────────────────────────────────────────

/**
 * Resolved plugin configuration — every flag concrete, no optionals. The
 * adapter layer merges defaults over the cordis patch config and the durable
 * DSH_HOME override file before anything else sees this shape. Fields are
 * mutable by design: panel toggles apply validated patches to the live object
 * at runtime (no restart).
 */
export interface DoctorConfig {
  /** Repair `run_code` argument schema mismatches (command→code, missing description, fences). */
  autoWrapRunCode: boolean;
  /** Re-dispatch UNKNOWN_TOOL results as nested host calls when the target is registered in scope. */
  autoBridgeDirectTools: boolean;
  /** On guarded-mutation observation failures, read the target once and retry through the host dispatcher. */
  autoObserveFiles: boolean;
  /** Clamp out-of-bounds range arguments (editor view_range, read offset past EOF). */
  autoClampRanges: boolean;
  /** Inject concise prompt guidance into the model's system context. */
  injectPrompt: boolean;
  /** Append actionable recovery hints to otherwise-unrecovered error results. */
  errorHints: boolean;
  /** Persist successful untouched calls in the detailed JSONL trace (aggregates are unaffected). */
  persistPassthrough: boolean;
  /** Promote tool-call markup found in streamed text into structured tool blocks. */
  healResponseTools: boolean;
  /** Repair structurally shaped arguments: replayed JSON strings, wrapper nesting, string↔primitive/enum drift. */
  autoSchemaArgs: boolean;
  /** Retry old_string-not-found edits once with line-ending/indentation-equivalent variants. */
  autoFuzzyEdit: boolean;
  /** Normalize path separators and ~ prefixes in path arguments to the host-expected form. */
  autoNormalizePaths: boolean;
  /** Re-dispatch a directory read (and other kind mistakes) to the right-shaped live tool. */
  autoKindFixes: boolean;
  /**
   * Shadow mode: evaluate every pre-dispatch repair and record what it WOULD
   * fix, but dispatch the original arguments and run no post-dispatch retries
   * or hints — measure a rule's coverage without changing behavior.
   */
  shadowMode: boolean;
}

/** Default configuration: every repair and diagnostic on, quiet pass-through off. */
export const DEFAULT_CONFIG: DoctorConfig = {
  autoWrapRunCode: true,
  autoBridgeDirectTools: true,
  autoObserveFiles: true,
  autoClampRanges: true,
  injectPrompt: true,
  errorHints: true,
  persistPassthrough: false,
  healResponseTools: true,
  autoSchemaArgs: true,
  autoFuzzyEdit: true,
  autoNormalizePaths: true,
  autoKindFixes: true,
  shadowMode: false,
};

/** The flags a dashboard toggle patch may flip (all of them). */
export type ConfigFlag = keyof DoctorConfig;

// ── Healing taxonomy ─────────────────────────────────────────────────────────

/**
 * What a dispatch outcome means for the record. Derived from one const array:
 * persistence validation and panel labels both read this, so a new category
 * cannot be recorded yet dropped on log replay.
 */
export const HEAL_CATEGORIES = [
  "INVALID_ARGS",
  "UNKNOWN_TOOL",
  "RANGE_CLAMP",
  "PATH_SCOPE",
  "CODE_WRAP",
  "RUN_CODE_DESC",
  "RUN_CODE_SYNTAX",
  "INNER_DESC",
  "FS_OBSERVED",
  "READ_ARGS",
  "PATH_QUOTES",
  "MNEMON_RESULT",
  "PASSTHROUGH",
  "RESPONSE_TOOL_HEAL",
  "ARGS_UNWRAP",
  "ARGS_TYPE",
  "PATH_SEPARATORS",
  "EDIT_WHITESPACE",
  "TOOL_NAME",
  "KIND_CORRECTION",
] as const;

/** One recordable healing category. */
export type HealCategory = (typeof HEAL_CATEGORIES)[number];

/** Settled outcome of one dispatch from the pipeline's point of view. */
export type DispatchStatus = "success" | "failed" | "passthrough";

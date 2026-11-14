/**
 * The healing-stage registry — the plugin's single source of truth.
 *
 * Adding a stage means writing its self-contained file (gate + mechanic +
 * metadata) and appending it to STAGES in execution order: pre-stages first,
 * then post-stages. Everything else derives from this array:
 *   - PRE_STAGES / POST_STAGES — the two pipeline loops (type-narrowed).
 *   - CATEGORY_META — panel labels, rule numbers, round-trip metering and
 *     honest-attribution predicates for every recordable category. Stages
 *     with a static category contribute their own entries (first declaration
 *     wins); multi-stage categories are declared explicitly below so a new
 *     tracker category is visible here as a missing key.
 *   - CATEGORY_LABELS — the dashboard client's label source of truth.
 *
 * @module dsh-tool-doctor/stages
 */

import type { HealStage, PostStage, PreStage } from "../core/stage.ts";
import { isPostStage, isPreStage } from "../core/stage.ts";
import type { ConfigFlag, HealCategory } from "../types.ts";

import { runCodeStage } from "./run-code.ts";
import { editorRangeStage } from "./editor-range.ts";
import { readArgsStage } from "./read-args.ts";
import { pathScopeStage } from "./path-scope.ts";
import { pathQuotesStage } from "./path-quotes.ts";
import { mnemonResultStage } from "./mnemon-result.ts";
import { argUnwrapStage } from "./arg-unwrap.ts";
import { typeCoercionStage } from "./type-coercion.ts";
import { pathNormalizerStage } from "./path-normalizer.ts";
import { bridgeStage } from "./bridge.ts";
import { toolNameStage } from "./tool-name.ts";
import { kindFixStage } from "./kind-fix.ts";
import { observeRetryStage } from "./observe-retry.ts";
import { anchorWhitespaceStage } from "./anchor-whitespace.ts";
import { anchorRefreshStage } from "./anchor-refresh.ts";
import { rangeRetryStage } from "./range-retry.ts";

/** All stages in execution order: pre-dispatch first, then post-dispatch. */
export const STAGES: readonly HealStage[] = [
  // ── Pre-dispatch (argument repair before the host sees the call) ──────────
  // Payload-shape repairs first: later stages assume `arguments` is a real
  // object holding the tool's own keys with plausibly-typed values.
  argUnwrapStage,
  typeCoercionStage,
  runCodeStage,
  editorRangeStage,
  readArgsStage,
  pathNormalizerStage,
  pathScopeStage,
  pathQuotesStage,
  mnemonResultStage,
  // ── Post-dispatch (recovery after a settled failure) ──────────────────────
  // Whitespace retry precedes anchor-refresh: a successful retry settles the
  // dispatch, so the observation refresh only ever runs for real anchor misses.
  bridgeStage,
  // Name canonicalization follows the bridge: it only ever sees an
  // UNKNOWN_TOOL the bridge's exact registered-name lookup could not resolve.
  toolNameStage,
  // Kind correction precedes the retry family: a directory read is a wrong
  // door, not a flaky call — re-dispatch by intent, never blind-retry.
  kindFixStage,
  observeRetryStage,
  anchorWhitespaceStage,
  anchorRefreshStage,
  rangeRetryStage,
];

/** Pre-dispatch stages in execution order. */
export const PRE_STAGES: readonly PreStage[] = STAGES.filter(isPreStage);

/** Post-dispatch recovery stages in execution order. */
export const POST_STAGES: readonly PostStage[] = STAGES.filter(isPostStage);

// ── Category metadata derivation ─────────────────────────────────────────────

/** Metadata for one recordable category, derived from its owning stage(s). */
export interface CategoryMeta {
  /** Panel label — the client's single source of truth. */
  readonly label: string;
  /** Healing-rule number used by error-candidate mapping (absent for non-rules). */
  readonly ruleNumber?: number;
  /** Config flag whose toggle gates this category's repairs (fix-proposal input). */
  readonly enabledBy?: ConfigFlag;
  /** Model round-trips a successful heal removes (token-meter input). Default 1. */
  readonly roundTrips?: number;
  /** Honest attribution: does the final error plausibly belong to this class? */
  readonly matchesError?: (code: string | undefined, text: string | undefined) => boolean;
}

/**
 * Categories owned by multi-stage stages that report their sub-category per
 * invocation — declared explicitly so they are visible as missing keys if the
 * tracker union ever grows.
 */
const RUN_CODE_SUBCATEGORIES: Record<string, CategoryMeta> = {
  INVALID_ARGS: {
    label: "Missing/misplaced args (INVALID_ARGS)",
    ruleNumber: 1,
    enabledBy: "autoWrapRunCode",
    roundTrips: 1,
    matchesError: (code, text) =>
      code === "INVALID_ARGS" || /offset|start|limit/i.test(text ?? ""),
  },
  CODE_WRAP: {
    label: "Code fence cleanup (CODE_WRAP)",
    ruleNumber: 1,
    enabledBy: "autoWrapRunCode",
    roundTrips: 1,
    matchesError: (code, text) =>
      code === "INVALID_ARGS" || /offset|start|limit/i.test(text ?? ""),
  },
  RUN_CODE_DESC: {
    label: "run_code description fill (RUN_CODE_DESC)",
    ruleNumber: 1,
    enabledBy: "autoWrapRunCode",
    roundTrips: 1,
    matchesError: (code, text) =>
      code === "INVALID_ARGS" || /offset|start|limit/i.test(text ?? ""),
  },
  RUN_CODE_SYNTAX: {
    label: "run_code syntax healing (RUN_CODE_SYNTAX)",
    ruleNumber: 1,
    enabledBy: "autoWrapRunCode",
    roundTrips: 1,
    // A syntax-like message only attributes honestly when the host actually
    // failed to run the program; a semantic failure is an unrelated error.
    matchesError: (code, text) =>
      code === "CODE_RUN_FAILED" &&
      /Unexpected token|Expected ','|Expected ';'|Unterminated|lexing error|<eof>|string literal|Expression expected|Expected ident/i.test(
        text ?? "",
      ),
  },
  INNER_DESC: {
    label: "Inner-call description fill (INNER_DESC)",
    ruleNumber: 1,
    enabledBy: "autoWrapRunCode",
    roundTrips: 1,
    matchesError: (code, text) =>
      code === "INVALID_ARGS" || /required property|invalid arguments|description/i.test(text ?? ""),
  },
};

/** Categories with no owning stage at all. */
const NON_STAGE_META: Record<string, CategoryMeta> = {
  PASSTHROUGH: { label: "Normal passthrough (PASSTHROUGH)" },
  RESPONSE_TOOL_HEAL: {
    label: "In-text tool-call promotion (RESPONSE_TOOL_HEAL)",
    ruleNumber: 7,
    enabledBy: "healResponseTools",
  },
};

/**
 * Metadata for every recordable category. Stages with a static category
 * contribute their own entries in declaration order (first wins); the rest are
 * declared explicitly above.
 */
export const CATEGORY_META = (() => {
  const meta: Record<string, CategoryMeta> = {};
  for (const stage of STAGES) {
    if (stage.category === undefined || meta[stage.category] !== undefined) continue;
    meta[stage.category] = {
      label: stage.label,
      ruleNumber: stage.ruleNumber,
      roundTrips: stage.roundTrips ?? 1,
      ...(stage.enabledBy ? { enabledBy: stage.enabledBy } : {}),
      ...(stage.matchesError ? { matchesError: stage.matchesError } : {}),
    };
  }
  return { ...meta, ...RUN_CODE_SUBCATEGORIES, ...NON_STAGE_META } as Record<
    HealCategory,
    CategoryMeta
  >;
})();

/**
 * Config flag whose toggle gates the repairs recorded under each category.
 * Derived like the labels; PASSTHROUGH (no rule) is deliberately absent.
 * The fix-proposal flow reads this to offer "turn the owning rule on".
 */
export const CATEGORY_TO_FLAG: Partial<Record<HealCategory, ConfigFlag>> =
  Object.fromEntries(
    (Object.keys(CATEGORY_META) as HealCategory[])
      .map((category) => [category, CATEGORY_META[category].enabledBy])
      .filter((entry): entry is [HealCategory, ConfigFlag] => entry[1] !== undefined),
  );

/** Panel labels for every category — the client's single source of truth. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  (Object.keys(CATEGORY_META) as HealCategory[]).map((category) => [
    category,
    CATEGORY_META[category].label,
  ]),
);

/**
 * Client-local mirrors of the server's rule taxonomy and candidate logic.
 *
 * The browser bundle must stay self-contained, so these tables and pure
 * helpers duplicate the server originals (src/stages/index.ts and
 * src/support/error-signatures.ts). The duplication is guarded, not
 * hoped-for: tests/client-mirror.spec.ts imports BOTH sides and fails
 * `npm run check` whenever they disagree — adding a rule server-side
 * without updating this file is now a build break, not a silent UI drift.
 * The table types (Record over HealCategory/ConfigFlag) additionally make
 * missing entries a compile-time error.
 *
 * Only TYPES may be imported from server modules (erased at build time);
 * no runtime server import belongs in this file.
 *
 * @module dsh-tool-doctor/client/mirror
 */

import type { ConfigFlag, HealCategory } from "../types.ts";
import type { CandidateVerdict, ProposedFix } from "../support/error-signatures.ts";
import type { NormalizerKey } from "./locales.ts";

export type { CandidateVerdict, ProposedFix };

/** Panel labels for the recordable categories — mirrors CATEGORY_LABELS (stages/index). */
export const CATEGORY_LABELS: Readonly<Record<HealCategory, string>> = {
  INVALID_ARGS: "Missing/misplaced args",
  UNKNOWN_TOOL: "Unknown-tool safe recovery",
  RANGE_CLAMP: "Editor range & session path",
  PATH_SCOPE: "Workspace path scope",
  CODE_WRAP: "Code fence cleanup",
  RUN_CODE_DESC: "run_code description fill",
  RUN_CODE_SYNTAX: "run_code syntax healing",
  INNER_DESC: "Inner-call description fill",
  FS_OBSERVED: "Retry after file observation",
  READ_ARGS: "Read argument correction",
  PATH_QUOTES: "Quoted path unwrap",
  MNEMON_RESULT: "mnemon result schema repair",
  PASSTHROUGH: "Normal passthrough",
  RESPONSE_TOOL_HEAL: "In-text tool-call promotion",
  ARGS_UNWRAP: "Double-encoded / wrapped arguments unwrap",
  ARGS_TYPE: "Schema-aware type coercion",
  PATH_SEPARATORS: "Path separator & tilde normalization",
  EDIT_WHITESPACE: "Whitespace-tolerant edit retry",
  TOOL_NAME: "Tool-name canonicalization",
  KIND_CORRECTION: "Directory-read kind correction",
};

/** Recordable categories in registry order — mirrors HEAL_CATEGORIES. */
export const CATEGORY_ORDER: readonly HealCategory[] = [
  "INVALID_ARGS", "UNKNOWN_TOOL", "RANGE_CLAMP", "PATH_SCOPE", "CODE_WRAP",
  "RUN_CODE_DESC", "RUN_CODE_SYNTAX", "INNER_DESC", "FS_OBSERVED", "READ_ARGS",
  "PATH_QUOTES", "MNEMON_RESULT", "PASSTHROUGH", "RESPONSE_TOOL_HEAL",
  "ARGS_UNWRAP", "ARGS_TYPE", "PATH_SEPARATORS", "EDIT_WHITESPACE",
  "TOOL_NAME", "KIND_CORRECTION",
];

/**
 * Healing-rule number each category belongs to — mirrors CATEGORY_TO_RULE
 * (PASSTHROUGH has none). KEY ORDER MATTERS: RULE_FLAGS derives each rule's
 * flag list in this order, and the fix-proposal flow names the FIRST flag —
 * so the order follows the server's registry (CATEGORY_META) order exactly.
 */
export const CATEGORY_TO_RULE: Readonly<Partial<Record<HealCategory, number>>> = {
  ARGS_UNWRAP: 9, ARGS_TYPE: 9, RANGE_CLAMP: 3, READ_ARGS: 1,
  PATH_SEPARATORS: 3, PATH_SCOPE: 3, PATH_QUOTES: 3, MNEMON_RESULT: 1,
  UNKNOWN_TOOL: 2, TOOL_NAME: 2, KIND_CORRECTION: 10, FS_OBSERVED: 4,
  EDIT_WHITESPACE: 4, INVALID_ARGS: 1, CODE_WRAP: 1, RUN_CODE_DESC: 1,
  RUN_CODE_SYNTAX: 1, INNER_DESC: 1, RESPONSE_TOOL_HEAL: 7,
};

/** Error-text hints toward an existing rule for failures no rule processed — mirrors TEXT_RULE_HINTS. */
export const TEXT_RULE_HINTS: ReadonlyArray<{ rule: number; test: RegExp }> = [
  { rule: 1, test: /\brun_code\b|run[- ]code\s+(?:code|description)/i },
  { rule: 2, test: /unknown tool|tool .*not (?:found|registered)/i },
  { rule: 3, test: /view_range|line (?:range|count)|out[- ]of[- ]range/i },
  { rule: 4, test: /FS_NOT_OBSERVED|FS_STALE_VERSION|not (?:been )?observed|string to replace|old_string/i },
  { rule: 7, test: /<tool_call|<function=|\[TOOL_CALLS\]/i },
  { rule: 9, test: /expected (?:a |an )?(?:number|boolean|array|object)|arguments (?:must|should) be|not (?:valid|parseable) JSON/i },
  { rule: 10, test: /not a regular file|is a directory|EISDIR|ENOTDIR|illegal operation on a directory/i },
];

/** Config flag that gates each category's repairs — mirrors CATEGORY_TO_FLAG. */
export const CATEGORY_TO_FLAG: Readonly<Partial<Record<HealCategory, ConfigFlag>>> = {
  INVALID_ARGS: "autoWrapRunCode", CODE_WRAP: "autoWrapRunCode",
  RUN_CODE_DESC: "autoWrapRunCode", RUN_CODE_SYNTAX: "autoWrapRunCode",
  INNER_DESC: "autoWrapRunCode", UNKNOWN_TOOL: "autoBridgeDirectTools",
  RANGE_CLAMP: "autoClampRanges", PATH_SCOPE: "autoClampRanges",
  READ_ARGS: "autoClampRanges", PATH_QUOTES: "autoClampRanges",
  MNEMON_RESULT: "autoClampRanges", FS_OBSERVED: "autoObserveFiles",
  RESPONSE_TOOL_HEAL: "healResponseTools",
  ARGS_UNWRAP: "autoSchemaArgs", ARGS_TYPE: "autoSchemaArgs",
  PATH_SEPARATORS: "autoNormalizePaths", EDIT_WHITESPACE: "autoFuzzyEdit",
  TOOL_NAME: "autoBridgeDirectTools", KIND_CORRECTION: "autoKindFixes",
};

/** Flags carrying each rule's repairs, registry order — mirrors RULE_FLAGS. */
export const RULE_FLAGS: ReadonlyMap<number, readonly ConfigFlag[]> = (() => {
  const map = new Map<number, ConfigFlag[]>();
  for (const [category, rule] of Object.entries(CATEGORY_TO_RULE)) {
    const flag = CATEGORY_TO_FLAG[category as HealCategory];
    if (flag === undefined) continue;
    const list = map.get(rule) ?? [];
    if (!list.includes(flag)) list.push(flag);
    map.set(rule, list);
  }
  return map;
})();

/** Fix-proposal eligibility — mirrors FIX_PROPOSE_MIN_* (error-signatures). */
export const FIX_PROPOSE_MIN_COUNT = 3;
export const FIX_PROPOSE_MIN_SPAN_MS = 10 * 60 * 1000;

/** Enough recurrences over enough elapsed time to justify offering a fix. */
export function fixEligible(count: number, firstSeen: number, lastSeen: number): boolean {
  return count >= FIX_PROPOSE_MIN_COUNT && lastSeen - firstSeen >= FIX_PROPOSE_MIN_SPAN_MS;
}

/** Mirror of proposeFix(): name the toggle that resolves a gap when one is off. */
export function proposeFix(
  verdict: CandidateVerdict,
  ruleHint: number | undefined,
  // The dashboard may hold a not-yet-loaded config as null; undefined and
  // null mean the same thing here: config unknown, name no flag.
  config: Record<string, boolean> | null | undefined,
): ProposedFix {
  if (verdict === "attempted-failed") return { kind: "refine-rule", rule: ruleHint };
  if (verdict === "possible-existing" && ruleHint !== undefined) {
    const flags = RULE_FLAGS.get(ruleHint) ?? [];
    const off = config === null || config === undefined
      ? undefined
      : flags.find((f) => config[f] === false);
    if (off !== undefined) return { kind: "enable-flag", flag: off, rule: ruleHint };
    return flags[0] !== undefined
      ? { kind: "gate-gap", rule: ruleHint, flag: flags[0] }
      : { kind: "gate-gap", rule: ruleHint };
  }
  if (verdict === "new-rule-candidate") return { kind: "new-rule" };
  return ruleHint !== undefined ? { kind: "gate-gap", rule: ruleHint } : { kind: "gate-gap" };
}

/** Longest signature kept — mirrors SIGNATURE_MAX. */
export const SIGNATURE_MAX = 180;

/**
 * Mirror of normalizeErrorSignature(): collapse the volatile parts of an
 * error message into stable placeholders, so one recurring mistake yields one
 * signature regardless of the paths, ids, or numbers in the failing call.
 */
export function normalizeErrorSignature(errorMessage: string): string {
  let text = (errorMessage || "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return "(no error message)";
  // Quoted / backticked payloads first: the quoting is the stable part.
  text = text.replace(/"[^"]*"/g, "<str>");
  text = text.replace(/'[^']*'/g, "<str>");
  text = text.replace(/`[^`]*`/g, "<str>");
  // Windows paths first, then unix-ish paths with two or more segments.
  text = text.replace(/[A-Za-z]:[\\/][^\s,;"']+/g, "<path>");
  text = text.replace(/(?:[\\/][\w.~-]+){2,}/g, "<path>");
  // UUIDs before bare numbers (a UUID contains digits between its dashes).
  text = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>",
  );
  text = text.replace(/\b[0-9a-f]{12,}\b/gi, "<id>");
  text = text.replace(/\b\d+(?:\.\d+)*\b/g, "<n>");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > SIGNATURE_MAX) {
    text = `${text.slice(0, SIGNATURE_MAX - 1)}…`;
  }
  return text;
}

/** Mirror of hintRule(): the rule number whose territory the text hints at. */
export function hintRule(errorMessage: string): number | undefined {
  for (const { rule, test } of TEXT_RULE_HINTS) {
    if (test.test(errorMessage)) return rule;
  }
  return undefined;
}

/**
 * Dashboard rule cards, one per config toggle, panel order. The server does
 * not carry this table, so the mirror test guards it differently: the flag
 * set must equal the config keys exactly (every toggle has exactly one card),
 * and the stage registry's owning flags must all appear here.
 */
export const RULES: ReadonlyArray<{
  flag: ConfigFlag;
  titleKey: NormalizerKey;
  descKey: NormalizerKey;
}> = [
  { flag: "autoWrapRunCode", titleKey: "rule1Title", descKey: "rule1Desc" },
  { flag: "autoBridgeDirectTools", titleKey: "rule2Title", descKey: "rule2Desc" },
  { flag: "autoClampRanges", titleKey: "rule3Title", descKey: "rule3Desc" },
  { flag: "autoObserveFiles", titleKey: "rule4Title", descKey: "rule4Desc" },
  { flag: "injectPrompt", titleKey: "rule5Title", descKey: "rule5Desc" },
  { flag: "errorHints", titleKey: "rule6Title", descKey: "rule6Desc" },
  { flag: "healResponseTools", titleKey: "rule7Title", descKey: "rule7Desc" },
  { flag: "persistPassthrough", titleKey: "rule8Title", descKey: "rule8Desc" },
  { flag: "autoSchemaArgs", titleKey: "ruleSchemaTitle", descKey: "ruleSchemaDesc" },
  { flag: "autoNormalizePaths", titleKey: "rulePathsTitle", descKey: "rulePathsDesc" },
  { flag: "autoFuzzyEdit", titleKey: "ruleFuzzyTitle", descKey: "ruleFuzzyDesc" },
  { flag: "autoKindFixes", titleKey: "ruleKindTitle", descKey: "ruleKindDesc" },
  { flag: "shadowMode", titleKey: "ruleShadowTitle", descKey: "ruleShadowDesc" },
];
